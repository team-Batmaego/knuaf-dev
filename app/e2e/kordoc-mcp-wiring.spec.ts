/**
 * M1 배선 몫 — `ChatService.send()` 가 폴더의 kordoc 런타임을 **연결에 넘기는** 자리(설계 §3.2).
 *
 * 여기서 고정하는 것은 네 가지다.
 * 1. 넘기는 시점 = `send()` 뿐. `status()`·`login()` 은 런타임을 확인하지도, 넘기지도 않는다.
 * 2. 성공한 사양은 폴더당 1회 확인·1회 전달. 실패는 캐시하지 않아 **다음 `send()` 가 다시 시도**한다.
 * 3. 실패는 전송을 막지 않는다 — `null` 을 넘기고 대화는 그대로 간다. 안내 줄은 폴더당 1회.
 * 4. `setMcpSpec` 이 없는 옛 공급자·런타임 공급자가 없는 앱은 지금까지와 똑같이 돈다.
 *
 * 실행 사양의 형식(env 울타리·진입점)은 `kordoc-mcp-policy.spec.ts` 가, 폴더별 수명은
 * `kordoc-mcp-registry.spec.ts`·`kordoc-mcp-lifecycle.spec.ts` 가 이미 덮는다 — 여기서 다시 고정하지 않는다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { attachFailureNote } from '../src/main/chat/kordocMcpRegistry'
import type { KordocMcpSpec, KordocRuntime } from '../src/main/chat/kordocMcp'
import type { AgentConnection } from '../src/main/chat/contracts'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-wiring-')))
test.afterAll(() => rmSync(base, { recursive: true, force: true }))

/** 실제 kordoc 배포 모양 — `cli.js` 옆에 `mcp.js`. */
function runtimeFixture(): KordocRuntime {
  const dir = join(base, 'kordoc')
  mkdirSync(dir, { recursive: true })
  const cliJs = join(dir, 'cli.js')
  writeFileSync(cliJs, '// synthetic fixture')
  writeFileSync(join(dir, 'mcp.js'), '// synthetic fixture')
  return { node: '/synthetic/node', cliJs, version: '4.17.1' }
}

interface Recorder {
  connection: AgentConnection
  specs: (KordocMcpSpec | null)[]
}

/** `setMcpSpec` 이 부른 값을 순서대로 남기는 가짜 연결. `attach:false` 면 옛 공급자 모양. */
function recorder(opts: { attach?: boolean; reject?: boolean } = {}): Recorder {
  const specs: (KordocMcpSpec | null)[] = []
  const connection: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: 'fake' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {}
  }
  if (opts.attach !== false) {
    connection.setMcpSpec = async (spec) => {
      specs.push(spec)
      // 실제 공급자는 기동 검증에 실패하면 던진다(M2). 사양이 null 이 되는 것까지가 이 몫이다.
      if (opts.reject && spec) throw new Error('공급자가 사양을 받지 못했어요')
    }
  }
  return { connection, specs }
}

function service(connection: AgentConnection, over: { ensureKordoc?: (root: string) => Promise<KordocRuntime | null> } = {}) {
  return new ChatService({
    skillSource: () => source,
    userData: mkdtempSync(join(tmpdir(), 'kordoc-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: () => connection,
    ...over
  })
}

async function settled(svc: ChatService, root: string) {
  for (let i = 0; i < 200; i++) {
    const s = svc.snapshot(root, 'codex')
    if (s.state !== 'running' && s.state !== 'permission') return s
    await new Promise((r) => setTimeout(r, 10))
  }
  return svc.snapshot(root, 'codex')
}

const freshRoot = (name: string) => { const root = join(base, name); mkdirSync(root); return root }

test('M1: 첫 send 가 사양을 1회 넘기고, 둘째 send 는 확인도 전달도 다시 하지 않는다', async () => {
  const root = freshRoot('성공')
  const runtime = runtimeFixture()
  const calls: string[] = []
  const rec = recorder()
  const svc = service(rec.connection, { ensureKordoc: async (r) => { calls.push(r); return runtime } })

  await svc.send(root, 'codex', '자료를 읽어 주세요', 'req-1')
  await settled(svc, root)
  expect(calls, '첫 전송에서 폴더 1회 확인').toEqual([root])
  expect(rec.specs).toHaveLength(1)
  expect(rec.specs[0]).toEqual({
    command: runtime.node,
    args: [join(base, 'kordoc', 'mcp.js')],
    // 울타리는 realpath 로 그린다 — 폴더 밖 접근은 서버가 먼저 거절한다.
    env: { KORDOC_ROOT: realpathSync(root), KORDOC_OFFLINE: '1' },
    version: '4.17.1'
  })

  await svc.send(root, 'codex', '표도 읽어 주세요', 'req-2')
  await settled(svc, root)
  expect(calls, '성공한 사양은 폴더당 캐시').toHaveLength(1)
  expect(rec.specs, '같은 사양을 다시 넘기면 공급자가 재기동한다').toHaveLength(1)
  await svc.close()
})

test('M1: 확인 실패는 전송을 막지 않는다 — null 1회 + 안내 1회, 다음 send 가 다시 시도한다', async () => {
  const root = freshRoot('실패')
  let runtime: KordocRuntime | null = null
  let calls = 0
  const rec = recorder()
  const svc = service(rec.connection, { ensureKordoc: async () => { calls++; return runtime } })

  await svc.send(root, 'codex', '질문', 'req-1')
  let s = await settled(svc, root)
  expect(s.state, 'MCP 를 못 붙여도 대화는 끝까지 간다').toBe('idle')
  expect(s.messages.filter((m) => m.role === 'system').map((m) => m.text)).toEqual([attachFailureNote('no-runtime')])
  expect(rec.specs, '붙일 수 없다는 사실은 한 번만 알린다').toEqual([null])

  runtime = runtimeFixture()
  await svc.send(root, 'codex', '다시 질문', 'req-2')
  s = await settled(svc, root)
  expect(calls, '실패는 캐시하지 않는다').toBe(2)
  expect(rec.specs).toHaveLength(2)
  expect(rec.specs[1]).not.toBeNull()
  expect(s.messages.filter((m) => m.role === 'system'), '안내는 폴더당 1회').toHaveLength(1)
  await svc.close()
})

test('M1: ensure 가 던져도 대화는 가고, 이유 없는 일반 안내 한 줄만 남는다', async () => {
  const root = freshRoot('예외')
  const rec = recorder()
  const svc = service(rec.connection, { ensureKordoc: async () => { throw new Error('kordoc.ensure 실패') } })

  await svc.send(root, 'codex', '질문', 'req-1')
  const s = await settled(svc, root)
  expect(s.state).toBe('idle')
  expect(s.messages.filter((m) => m.role === 'system').map((m) => m.text)).toEqual([attachFailureNote(null)])
  expect(rec.specs).toEqual([null])
  await svc.close()
})

test('M1: status·login 은 런타임을 확인하지도 넘기지도 않는다 (§3.2 "언제")', async () => {
  const root = freshRoot('상태')
  let calls = 0
  const rec = recorder()
  const svc = service(rec.connection, { ensureKordoc: async () => { calls++; return runtimeFixture() } })

  expect((await svc.status(root, 'codex')).connected).toBe(true)
  await svc.login(root, 'codex')
  expect(calls, '온보딩·상태 확인은 kordoc 설치를 일으키지 않는다').toBe(0)
  expect(rec.specs).toEqual([])
  await svc.close()
})

test('M1: setMcpSpec 이 없는 옛 공급자·런타임 공급자가 없는 앱은 종전과 같다', async () => {
  const noHook = freshRoot('옛공급자')
  let calls = 0
  const old = service(recorder({ attach: false }).connection, { ensureKordoc: async () => { calls++; return runtimeFixture() } })
  await old.send(noHook, 'codex', '질문', 'req-1')
  expect((await settled(old, noHook)).state).toBe('idle')
  expect(calls, '받을 곳이 없으면 확인도 하지 않는다').toBe(0)
  await old.close()

  const noProvider = freshRoot('옛앱')
  const rec = recorder()
  const bare = service(rec.connection)
  await bare.send(noProvider, 'codex', '질문', 'req-1')
  expect((await settled(bare, noProvider)).state).toBe('idle')
  expect(rec.specs, '런타임 공급자가 없으면 미부착으로 단정하지 않는다').toEqual([])
  await bare.close()
})

test('M1: 공급자가 사양을 거절하면 MCP 없이 같은 전송을 계속한다', async () => {
  const root = freshRoot('거절')
  const rec = recorder({ reject: true })
  const svc = service(rec.connection, { ensureKordoc: async () => runtimeFixture() })

  await svc.send(root, 'codex', '질문', 'req-1')
  const s = await settled(svc, root)
  expect(s.state, '사양을 못 받아도 전송은 살아 있다').toBe('idle')
  expect(rec.specs, '거절 뒤에는 null 로 내려간다').toHaveLength(2)
  expect(rec.specs[0]).not.toBeNull()
  expect(rec.specs[1]).toBeNull()
  await svc.close()
})

test('M1: 연결을 버린 뒤(stop) 새 연결에 사양을 다시 넘긴다 — 확인은 캐시를 쓴다', async () => {
  const root = freshRoot('재연결')
  let calls = 0
  const first = recorder()
  const second = recorder()
  const made = [first, second]
  const svc = new ChatService({
    skillSource: () => source,
    userData: mkdtempSync(join(tmpdir(), 'kordoc-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: () => made.shift()!.connection,
    ensureKordoc: async () => { calls++; return runtimeFixture() }
  })

  await svc.send(root, 'codex', '질문', 'req-1')
  await settled(svc, root)
  await svc.stop(root, 'codex')
  await svc.send(root, 'codex', '이어서', 'req-2')
  await settled(svc, root)
  expect(calls, '성공한 사양은 폴더 메모리에 남는다').toBe(1)
  expect(first.specs, '옛 연결은 한 번만 받는다').toHaveLength(1)
  expect(second.specs, '새 연결은 자기 몫을 받는다').toHaveLength(1)
  await svc.close()
})
