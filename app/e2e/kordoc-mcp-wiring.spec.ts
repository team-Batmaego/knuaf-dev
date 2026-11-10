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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
  runs: number
}

/**
 * `setMcpSpec` 이 부른 값을 순서대로 남기는 가짜 연결. `attach:false` 면 옛 공급자 모양.
 *
 * `rejectSpec`·`rejectNull` 은 서로 독립이다 — 실제 공급자는 사양을 받아들였다가 기동 검증에서
 * 던질 수 있고(M2), 해제 통로도 따로 실패할 수 있다. 두 실패가 겹칠 때 앱이 그 연결로 턴을
 * 열지 않는지가 M1-02 의 몫이다.
 */
function recorder(opts: { attach?: boolean; rejectSpec?: boolean; rejectNull?: boolean } = {}): Recorder {
  const specs: (KordocMcpSpec | null)[] = []
  const connection: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: 'fake' }),
    login: async () => {},
    run: async () => { rec.runs++ },
    respond: () => {},
    stop: async () => {}
  }
  if (opts.attach !== false) {
    connection.setMcpSpec = async (spec) => {
      specs.push(spec)
      // 실제 공급자는 기동 검증에 실패하면 던진다(M2). 사양이 null 이 되는 것까지가 이 몫이다.
      if (spec && opts.rejectSpec) throw new Error('공급자가 사양을 받지 못했어요')
      if (!spec && opts.rejectNull) throw new Error('공급자가 해제도 받지 못했어요')
    }
  }
  const rec: Recorder = { connection, specs, runs: 0 }
  return rec
}

function service(
  connection: AgentConnection,
  over: { ensureKordoc?: (root: string) => Promise<KordocRuntime | null>; connectionFactory?: () => AgentConnection } = {}
) {
  const { connectionFactory, ...rest } = over
  return new ChatService({
    skillSource: () => source,
    userData: mkdtempSync(join(tmpdir(), 'kordoc-ud-')),
    emit: () => {},
    openExternal: async () => {},
    connectionFactory: connectionFactory ?? (() => connection),
    ...rest
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
  const rec = recorder({ rejectSpec: true })
  const svc = service(rec.connection, { ensureKordoc: async () => runtimeFixture() })

  await svc.send(root, 'codex', '질문', 'req-1')
  const s = await settled(svc, root)
  expect(s.state, '사양을 못 받아도 전송은 살아 있다').toBe('idle')
  expect(rec.specs, '거절 뒤에는 null 로 내려간다').toHaveLength(2)
  expect(rec.specs[0]).not.toBeNull()
  expect(rec.specs[1]).toBeNull()
  await svc.close()
})

test('M1-01: 같은 입력 경로가 다른 실제 폴더를 가리키면 옛 사양을 유지한 채 실행하지 않는다', async () => {
  const a = freshRoot('링크A')
  const b = freshRoot('링크B')
  const link = join(base, '현재폴더')
  symlinkSync(a, link, 'dir')
  let runtime: KordocRuntime | null = null
  const rec = recorder()
  const svc = service(rec.connection, { ensureKordoc: async () => (runtime ??= runtimeFixture()) })

  await svc.send(link, 'codex', 'A 폴더 질문', 'req-1')
  expect((await settled(svc, link)).state).toBe('idle')
  expect(rec.specs.map((spec) => spec?.env.KORDOC_ROOT)).toEqual([realpathSync(a)])

  // 링크 대상이 B 로 바뀌었다 — 앱이 쥔 입력 경로 문자열은 그대로다(연결 재사용 조건).
  unlinkSync(link)
  symlinkSync(b, link, 'dir')
  await svc.send(link, 'codex', 'B 폴더 질문', 'req-2')
  expect((await settled(svc, link)).state).toBe('idle')

  const roots = rec.specs.map((spec) => spec?.env.KORDOC_ROOT ?? null)
  expect(roots.at(-1), '둘째 턴은 B 의 울타리로 돈다').toBe(realpathSync(b))
  expect(roots, 'B 로 넘어가기 전에 A 사양을 먼저 뗀다').toEqual([realpathSync(a), null, realpathSync(b)])
  expect(rec.runs, '두 턴 모두 실행된다').toBe(2)
  await svc.close()
})

test('M1-02: 부착·해제가 모두 실패한 연결로는 턴을 열지 않는다 — 안전한 새 연결로 한 번 다시 연다', async () => {
  const root = freshRoot('이중실패')
  const broken = recorder({ rejectSpec: true, rejectNull: true })
  const safe = recorder()
  const made = [broken, safe]
  const svc = service(broken.connection, {
    ensureKordoc: async () => runtimeFixture(),
    connectionFactory: () => (made.shift() ?? safe).connection
  })

  await svc.send(root, 'codex', '질문', 'req-1')
  const s = await settled(svc, root)
  expect(s.state, '안전한 연결이 있으면 턴은 간다').toBe('idle')
  expect(broken.runs, '부분 구성이 남은 연결에는 run() 을 보내지 않는다').toBe(0)
  expect(safe.runs, '새 연결이 그 턴을 받는다').toBe(1)
  expect(safe.specs, '새 연결은 자기 몫의 사양을 받는다').toHaveLength(1)
  await svc.close()
})

test('M1-02: 새 연결도 안전하지 않으면 삼키지 않고 전송을 막고 알린다', async () => {
  const root = freshRoot('이중실패봉쇄')
  const broken = recorder({ rejectSpec: true, rejectNull: true })
  const svc = service(broken.connection, {
    ensureKordoc: async () => runtimeFixture(),
    connectionFactory: () => broken.connection
  })

  await expect(svc.send(root, 'codex', '질문', 'req-1')).rejects.toThrow(/한글 문서 읽기 도구를 붙이지 못했어요/)
  expect(broken.runs, '안전을 확인하지 못한 연결로는 실행하지 않는다').toBe(0)
  const s = svc.snapshot(root, 'codex')
  expect(s.state, '막힌 턴은 실행 중으로 남지 않는다').not.toBe('running')
  expect(s.messages.some((m) => m.role === 'user'), '보내지 못한 말은 대화에 남기지 않는다').toBe(false)
  await svc.close()
})

test('M1-03: 공급자가 부착을 거절해도 폴더당 안내는 1줄이다', async () => {
  const root = freshRoot('거절안내')
  const rec = recorder({ rejectSpec: true })
  const svc = service(rec.connection, { ensureKordoc: async () => runtimeFixture() })

  await svc.send(root, 'codex', '질문', 'req-1')
  expect((await settled(svc, root)).state).toBe('idle')
  await svc.send(root, 'codex', '다시 질문', 'req-2')
  const s = await settled(svc, root)
  expect(s.state).toBe('idle')
  expect(rec.specs.filter((spec) => spec !== null), '재시도는 유지한다').toHaveLength(2)
  expect(s.messages.filter((m) => m.role === 'system').map((m) => m.text), '두 번 거절돼도 안내는 1줄')
    .toEqual([attachFailureNote('provider')])
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
