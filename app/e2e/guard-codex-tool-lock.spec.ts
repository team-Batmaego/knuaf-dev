/**
 * §10-20·§10-22 — Codex 1층 잠금(`codexToolLock`)의 산출·분류·거부·결과 대조.
 *
 * 가짜 app-server 연결(`rpc.request`)만 쓴다 — 프로세스·모델 추론·학생 설정 없음.
 * 설계 §4.1-C: 앱 스레드는 **스레드 `config`**, 터미널은 **`-c`**, 둘 다 '끌 수 있다고
 * 확인된 것'만 지목하고 하나라도 못 끄면 **닫는다**.
 */
import { test, expect, afterAll } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexToolLock, appThreadLockPlan, appThreadLockVerify, lockFingerprint, emptyLockConfig, terminalRefusalCopy,
  TERMINAL_REFUSAL_HEAD, TERMINAL_ENUM_FAILED_COPY, APP_THREAD_RESULT_REFUSAL_COPY, KORDOC_COLLISION_NOTE, LIST_PAGE_CAP,
  type LockConfig, type ToolLockOutcome
} from '../src/main/chat/codexToolLock'
import { MCP_SERVER_NAME } from '../src/main/chat/kordocMcp'

// ── 가짜 연결 ─────────────────────────────────────────────────────────────────

type Handler = (params: Record<string, unknown>, round: number) => unknown
interface Fake {
  calls: { method: string; params: Record<string, unknown> }[]
  methods: () => string[]
  rpc: { request: (method: string, params?: unknown) => Promise<unknown> }
}

/** `round` 는 **그 메서드의** 몇 번째 호출인가(0부터). 반복 읽기 시험의 핵심이다. */
function fakeRpc(handlers: Record<string, Handler> = {}): Fake {
  const rounds = new Map<string, number>()
  const calls: Fake['calls'] = []
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    rpc: {
      request: async (method, params) => {
        const p = (params ?? {}) as Record<string, unknown>
        calls.push({ method, params: p })
        const round = rounds.get(method) ?? 0
        rounds.set(method, round + 1)
        const h = handlers[method]
        if (!h) return { data: [], nextCursor: null }
        const value = h(p, round)
        if (value instanceof Error) throw value
        return value
      }
    }
  }
}

type Layer = 'user' | 'project' | 'system'

/** `config/read {includeLayers:true}` 응답 — 유효 설정 + 층별 표. */
function configRead(opts: {
  servers?: Record<string, unknown>
  plugins?: Record<string, unknown>
  layers?: Partial<Record<Layer, Record<string, unknown>>>
}) {
  const layers = (['user', 'project', 'system'] as Layer[])
    .filter((kind) => opts.layers?.[kind])
    .map((kind) => ({ name: { type: kind }, config: { mcp_servers: opts.layers?.[kind] } }))
  return { config: { mcp_servers: opts.servers ?? {}, plugins: opts.plugins ?? {} }, layers }
}

/** `plugin/installed` 은 `{data:[…]}` 한 장. */
const installed = (ids: string[]) => ({ data: ids, nextCursor: null })
/** `mcpServerStatus/list` 한 장. */
const status = (rows: unknown[]) => ({ data: rows, nextCursor: null })
const disabled = (name: string) => ({ name, runtimeStatus: 'disabled' })
const connected = (name: string) => ({ name, runtimeStatus: 'connected' })

const noSleep = async (): Promise<void> => {}

function appThread(f: Fake, extra: Partial<Parameters<typeof codexToolLock>[0]> = {}) {
  return codexToolLock({
    root: '/tmp/kd-lock-root',
    form: 'app-thread',
    injected: [],
    rpc: f.rpc,
    check: { threadId: 't-1', instructionSources: [] },
    retry: { sleep: noSleep },
    ...extra
  })
}

function terminal(f: Fake, extra: Partial<Parameters<typeof codexToolLock>[0]> = {}) {
  return codexToolLock({
    root: '/tmp/kd-lock-root',
    form: 'terminal',
    injected: [],
    rpc: f.rpc,
    ...extra
  })
}

function expectOk(o: ToolLockOutcome): Extract<ToolLockOutcome, { ok: true }> {
  if (!o.ok) throw new Error(`잠금이 실패했어요: ${o.reason} — ${o.studentCopy}`)
  return o
}

function expectFail(o: ToolLockOutcome, reason?: string) {
  if (o.ok) throw new Error('잠금이 통과했어요 — 거부여야 합니다')
  if (reason) expect(o.reason).toBe(reason)
  return o
}

// ── §10-20 앱 스레드 config ───────────────────────────────────────────────────

test('§10-20 앱 스레드 config: Apps·MCP·플러그인·프로젝트 문서 상한이 모두 실린다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({
      servers: { alpha: { command: 'a' }, beta: { url: 'https://b' } },
      plugins: { plug1: { enabled: true } }
    }),
    'plugin/installed': () => installed(['plug2']),
    'mcpServerStatus/list': () => status([disabled('alpha'), disabled('beta')]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f))
  expect(out.form).toBe('app-thread')
  if (out.form !== 'app-thread') return
  expect(out.config).toEqual({
    features: { apps: false },
    mcp_servers: { alpha: { enabled: false }, beta: { enabled: false } },
    plugins: { plug1: { enabled: false }, plug2: { enabled: false } },
    project_doc_max_bytes: 0
  })
  expect(out.lockedNames.sort()).toEqual(['alpha', 'beta'])
  expect(out.lockedPlugins.sort()).toEqual(['plug1', 'plug2'])
})

test('§10-20 플러그인이 딸고 오는 MCP 이름은 mcp_servers 에 넣지 않는다(invalid transport)', async () => {
  // 유효 `mcp_servers` 에는 없고 플러그인 쪽에만 있는 이름 — 넣으면 기동이 죽는다(실측 ⓙ).
  const f = fakeRpc({
    'config/read': () => configRead({ servers: {}, plugins: { 'p@mkt': { enabled: true } } }),
    'plugin/installed': () => installed(['p@mkt']),
    'mcpServerStatus/list': () => status([]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config.mcp_servers).toEqual({})
  expect(out.config.plugins).toEqual({ 'p@mkt': { enabled: false } })
})

test('§10-20 이름이 하나도 없으면 mcp_servers 는 빈 객체다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({}),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config).toEqual(emptyLockConfig())
  expect(out.config.mcp_servers).toEqual({})
  expect(out.fingerprint).toBe(lockFingerprint(emptyLockConfig()))
})

test('§10-20 지문은 이름 순서에 무관하고 플러그인이 늘면 바뀐다', () => {
  const a: LockConfig = { features: { apps: false }, mcp_servers: { x: { enabled: false }, y: { enabled: false } }, plugins: {}, project_doc_max_bytes: 0 }
  const b: LockConfig = { features: { apps: false }, mcp_servers: { y: { enabled: false }, x: { enabled: false } }, plugins: {}, project_doc_max_bytes: 0 }
  expect(lockFingerprint(a)).toBe(lockFingerprint(b))
  const c: LockConfig = { ...a, plugins: { p: { enabled: false } } }
  expect(lockFingerprint(c)).not.toBe(lockFingerprint(a))
})

test('§4.1-D 앱이 붙인 kordoc 은 끄지 않고, 학생 층에 같은 이름이 없으면 충돌도 아니다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' }, other: { command: 'o' } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([{ name: 'kordoc', runtimeStatus: 'connected' }, disabled('other')]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f, { injected: [{ name: MCP_SERVER_NAME }] }))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config.mcp_servers).toEqual({ other: { enabled: false } })
  expect(out.kordocAttached).toBe(true)
  expect(out.kordocCollision).toBeNull()
})

test('§4.1-D 학생 층에 같은 이름의 kordoc 이 있으면 끄고 알린다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' } }, layers: { user: { kordoc: { command: 'student' } } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([disabled('kordoc')]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f, { injected: [{ name: MCP_SERVER_NAME }] }))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config.mcp_servers).toEqual({ kordoc: { enabled: false } })
  expect(out.kordocAttached).toBe(false)
  expect(out.kordocCollision).toBe(KORDOC_COLLISION_NOTE)
})

test('§4.1-D 앱이 kordoc 을 붙이지 않은 연결에서는 kordoc 도 보통 이름과 같이 분류한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' } }, layers: { user: { kordoc: { command: 'student' } } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([disabled('kordoc')]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config.mcp_servers).toEqual({ kordoc: { enabled: false } })
  expect(out.kordocAttached).toBe(false)
})

test('§10-20 앱 스레드 잠금은 목록 RPC(skills/list·hooks/list)를 판정에 쓰지 않는다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([disabled('a')]),
    'app/list': () => status([]),
    // 목록 RPC 가 '켜짐'으로 답해도 판정에 쓰지 않는다(⑥ 실측 — 통과 근거로도 거부 근거로도 아님).
    'skills/list': () => ({ data: [{ skills: [{ path: '/x', enabled: true }] }] }),
    'hooks/list': () => ({ data: [{ trusted: true }] })
  })
  expectOk(await appThread(f))
  expect(f.methods()).not.toContain('skills/list')
  expect(f.methods()).not.toContain('hooks/list')
})

// ── §4.1-C 1번: 열거는 스레드 앞, 대조는 스레드 뒤 ───────────────────────────

test('§4.1-C 1번 계획 단계는 스레드가 없어도 끝나고 스레드 목록 RPC 를 부르지 않는다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } }, plugins: { p: {} } }),
    'plugin/installed': () => installed([])
  })
  const planned = await appThreadLockPlan({
    root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc
  })
  if (!planned.ok) throw new Error(`계획이 실패했어요: ${planned.reason}`)
  expect(f.methods()).toEqual(['config/read', 'plugin/installed'])
  expect(planned.plan.config).toEqual({
    features: { apps: false },
    mcp_servers: { a: { enabled: false } },
    plugins: { p: { enabled: false } },
    project_doc_max_bytes: 0
  })
  expect(planned.plan.fingerprint).toBe(lockFingerprint(planned.plan.config))
  expect(planned.plan.lockedNames).toEqual(['a'])
  expect(planned.plan.lockedPlugins).toEqual(['p'])
})

test('§4.1-C 1번 대조 단계는 열거를 다시 하지 않고 계획의 지문을 그대로 쓴다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([disabled('a')]),
    'app/list': () => status([])
  })
  const planned = await appThreadLockPlan({ root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc })
  if (!planned.ok) throw new Error('계획이 실패했어요')
  const before = f.calls.filter((c) => c.method === 'config/read' || c.method === 'plugin/installed').length
  const verified = await appThreadLockVerify({
    root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc,
    check: { threadId: 't-9', instructionSources: [] }, retry: { sleep: noSleep }
  }, planned.plan)
  expect(verified.ok).toBe(true)
  expect(f.calls.filter((c) => c.method === 'config/read' || c.method === 'plugin/installed')).toHaveLength(before)
  expect(f.calls.find((c) => c.method === 'mcpServerStatus/list')?.params.threadId).toBe('t-9')
})

test('§4.1-C 1번 계획이 거부면 스레드 RPC 를 하나도 보내지 않는다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: null }),
    'plugin/installed': () => installed([])
  })
  const planned = await appThreadLockPlan({ root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc })
  if (planned.ok) throw new Error('계획이 통과했어요 — 거부여야 합니다')
  expect(planned.reason).toBe('list-shape')
  expect(f.methods()).not.toContain('mcpServerStatus/list')
  expect(f.methods()).not.toContain('app/list')
})

test('§4.1-C 4번 대조 거부는 한 문단 글로 돌아온다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([connected('a')]),
    'app/list': () => status([])
  })
  const planned = await appThreadLockPlan({ root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc })
  if (!planned.ok) throw new Error('계획이 실패했어요')
  const verified = await appThreadLockVerify({
    root: '/tmp/kd-lock-root', form: 'app-thread', injected: [], rpc: f.rpc,
    check: { threadId: 't-9', instructionSources: [] }, retry: { sleep: noSleep }
  }, planned.plan)
  if (verified.ok) throw new Error('대조가 통과했어요 — 거부여야 합니다')
  expect(verified.reason).toBe('result-check')
  expect(verified.studentCopy).toBe(APP_THREAD_RESULT_REFUSAL_COPY)
})

// ── §10-20 터미널: -c 와 거부 ─────────────────────────────────────────────────

test('§10-20 터미널: 사용자 층에 command 가 있는 이름만 -c 로 끈다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({
      servers: { keep: { command: 'k' }, off: { enabled: false } },
      layers: { user: { keep: { command: 'k' } }, project: { off: { command: 'p' } } }
    }),
    'plugin/installed': () => installed([])
  })
  const out = expectOk(await terminal(f))
  if (out.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(out.args).toEqual(['-c', 'mcp_servers.keep.enabled=false', '-c', 'project_doc_max_bytes=0', '-c', 'features.apps=false'])
  expect(out.lockedNames).toEqual(['keep'])
})

test('§10-20 터미널: 신뢰 폴더만 정의한 이름은 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { folder: { command: 'f' } }, layers: { project: { folder: { command: 'f' } } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectFail(await terminal(f), 'uncancellable')
  expect(out.studentCopy).toContain('이 논문 폴더의 Codex 설정에 적힌 도구')
  expect(out.studentCopy).toContain('**folder**')
  expect(out.remaining).toEqual(['folder'])
})

test('§10-20 터미널: 사용자 층 url 전송형(command 없음)은 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { web: { url: 'https://x' } }, layers: { user: { web: { url: 'https://x' } } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectFail(await terminal(f), 'uncancellable')
  expect(out.studentCopy).toContain('인터넷 주소로 연결되는 도구')
})

test('§10-20 터미널: 시스템 층만 정의한 이름은 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { sys: { command: 's' } }, layers: { system: { sys: { command: 's' } } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectFail(await terminal(f), 'uncancellable')
  expect(out.studentCopy).toContain('컴퓨터 공용 설정의 도구')
})

test('§10-20 터미널: 이름에 점(.)이 든 플러그인 id 는 거부한다', async () => {
  // 점이 든 id 는 맨키로 적을 수 없다 — 따옴표 키는 새 키만 만들고 조용히 안 꺼진다(2차 ③).
  const f = fakeRpc({
    'config/read': () => configRead({ plugins: { 'com.example.plugin': { enabled: true } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectFail(await terminal(f), 'uncancellable')
  expect(out.studentCopy).toContain('이름에 점(.)이 든 플러그인')
  expect(out.studentCopy).toContain('· Codex에서 com.example.plugin 플러그인을 끄기')
})

test('§10-20 터미널: 유효값이 켜져 있으면 층의 원시 enabled=false 로 생략하지 않는다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({
      servers: { x: { command: 'x', enabled: true } },
      layers: { user: { x: { command: 'x', enabled: false } }, project: { x: { command: 'x' } } }
    }),
    'plugin/installed': () => installed([])
  })
  const out = expectOk(await terminal(f))
  if (out.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(out.args).toContain('mcp_servers.x.enabled=false')
})

test('§10-20 터미널: 유효값이 이미 꺼진 이름은 거부 사유가 아니다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { x: { command: 'x', enabled: false } }, layers: { user: { x: { command: 'x' } } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectOk(await terminal(f))
  if (out.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(out.args).toEqual(['-c', 'project_doc_max_bytes=0', '-c', 'features.apps=false'])
})

test('§10-20 터미널: 설치 목록에만 있는 플러그인도 -c 로 끈다(맨키)', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({}),
    'plugin/installed': () => installed(['remote-plugin'])
  })
  const out = expectOk(await terminal(f))
  if (out.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(out.args).toEqual(['-c', 'plugins.remote-plugin.enabled=false', '-c', 'project_doc_max_bytes=0', '-c', 'features.apps=false'])
  // 따옴표 키는 새 키만 만들고 조용히 안 꺼진다(2차 ③).
  expect(out.args.join(' ')).not.toContain('"')
})

test('§10-20 터미널: 열거 실패는 도구 이름 없이 그 글만 보여 준다', async () => {
  const f = fakeRpc({ 'config/read': () => new Error('boom') })
  const out = expectFail(await terminal(f), 'enumeration-failed')
  expect(out.studentCopy).toBe(TERMINAL_ENUM_FAILED_COPY)
  expect(out.remaining).toEqual([])
})

test('§10-20 터미널: plugin/installed 오류도 거부다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { x: { command: 'x' } }, layers: { user: { x: { command: 'x' } } } }),
    'plugin/installed': () => ({ error: { code: -32603, message: 'no' } })
  })
  expectFail(await terminal(f))
  expect(f.methods()).not.toContain('thread/start')
})

test('§10-20 거부 글: 설계 문구 그대로이고 "직접 설정한"이다', () => {
  const copy = terminalRefusalCopy([{ name: 'x', reason: '이 논문 폴더의 Codex 설정에 적힌 도구', method: '논문 폴더의 `.codex/config.toml`에서 x 항목을 지우거나 `enabled = false`로 바꾸기' }])
  const lines = copy.split('\n')
  expect(lines[0]).toBe(TERMINAL_REFUSAL_HEAD)
  expect(copy).toContain('이 컴퓨터의 Codex 설정에 앱이 끌 수 없는 외부 도구가 켜져 있어요: **x**(이 논문 폴더의 Codex 설정에 적힌 도구)')
  expect(copy).toContain('그대로 열면 그 도구가 앱의 확인 없이 논문 폴더에서 움직일 수 있어서 막았어요.')
  expect(copy).toContain('**이렇게 하면 돼요**')
  expect(copy).toContain('① 앱 안 대화창의 Codex 도우미는 그대로 쓸 수 있어요.')
  expect(copy).toContain('직접 설정한 적이 없다면')
  expect(copy).not.toContain('직접 설치한')
})

test('§4.1-C N-01 ⓐ 앱만 넣은 이름은 터미널 대상에서 빼고 정상 실행한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' }, mine: { command: 'm' } }, layers: { user: { mine: { command: 'm' } } } }),
    'plugin/installed': () => installed([])
  })
  const out = expectOk(await terminal(f, { injected: [{ name: MCP_SERVER_NAME }] }))
  if (out.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(out.args.join(' ')).not.toContain('mcp_servers.kordoc')
  expect(out.args).toContain('mcp_servers.mine.enabled=false')
})

test('§4.1-C N-01 ⓑ 학생 층에도 같은 이름이 있으면 다시 분류한다', async () => {
  const withCommand = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' } }, layers: { user: { kordoc: { command: 'student' } } } }),
    'plugin/installed': () => installed([])
  })
  const ok = expectOk(await terminal(withCommand, { injected: [{ name: MCP_SERVER_NAME }] }))
  if (ok.form !== 'terminal') throw new Error('터미널이 아니에요')
  expect(ok.args).toContain('mcp_servers.kordoc.enabled=false')

  const folderOnly = fakeRpc({
    'config/read': () => configRead({ servers: { kordoc: { command: 'node' } }, layers: { project: { kordoc: { command: 'student' } } } }),
    'plugin/installed': () => installed([])
  })
  const refused = expectFail(await terminal(folderOnly, { injected: [{ name: MCP_SERVER_NAME }] }), 'uncancellable')
  expect(refused.studentCopy).toContain('kordoc')
})

test('§10-20 학생 ~/.codex/config.toml 은 읽기만 한다(전후 바이트 동일)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kd-lock-home-'))
  try {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const file = join(home, '.codex', 'config.toml')
    writeFileSync(file, '[mcp_servers.x]\ncommand = "x"\n', 'utf-8')
    const before = readFileSync(file)
    const f = fakeRpc({
      'config/read': () => configRead({ servers: { x: { command: 'x' } }, layers: { user: { x: { command: 'x' } } } }),
      'plugin/installed': () => installed([])
    })
    expectOk(await terminal(f, { codexHome: home }))
    expect(readFileSync(file).equals(before)).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── §10-22 ⓐ–ⓔ·ⓕ·ⓕ′·ⓕ″ 결과 대조 ────────────────────────────────────────────

/** 상태 목록만 노브로 바꾸고 나머지는 '모두 끈 상태'로 고정한 연결. */
function resultRpc(statuses: Handler, extra: Record<string, Handler> = {}): Fake {
  return fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } }, layers: { user: { a: { command: 'a' } } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': statuses,
    'app/list': () => status([]),
    ...extra
  })
}

test('§10-22 ⓐ 6페이지째에만 connected 가 있으면 거부한다', async () => {
  const f = resultRpc((_p, round) => round < 5
    ? { data: [disabled('a')], nextCursor: `c${round + 1}` }
    : { data: [disabled('a'), connected('ghost')], nextCursor: null })
  expectFail(await appThread(f), 'result-check')
})

test('§10-22 ⓑ 페이지 상한에 닿았는데 커서가 남으면 거부한다', async () => {
  const f = resultRpc((_p, round) => ({ data: [disabled('a')], nextCursor: `c${round + 1}` }))
  const out = expectFail(await appThread(f), 'page-cap')
  expect(f.calls.filter((c) => c.method === 'mcpServerStatus/list')).toHaveLength(LIST_PAGE_CAP)
  expect(out.studentCopy).not.toBe('')
})

test('§10-22 ⓒ data 가 null 이면 빈 목록이 아니라 거부다', async () => {
  const f = resultRpc(() => ({ data: null, nextCursor: null }))
  expectFail(await appThread(f), 'list-shape')
})

test('§10-22 ⓒ data 가 배열이 아니어도 거부한다', async () => {
  const f = resultRpc(() => ({ data: { a: 1 }, nextCursor: null }))
  expectFail(await appThread(f), 'list-shape')
})

test('§10-22 ⓓ plugin/installed 오류면 thread/start 를 보내지 않는다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' } }, layers: { user: { a: { command: 'a' } } } }),
    'plugin/installed': () => new Error('down')
  })
  expectFail(await appThread(f))
  expect(f.methods()).not.toContain('thread/start')
  expect(f.methods()).not.toContain('thread/resume')
})

test('§10-22 ⓔ config/read 형식 이상(null config)이면 거부한다', async () => {
  const f = fakeRpc({ 'config/read': () => ({ config: null }), 'plugin/installed': () => installed([]) })
  expectFail(await appThread(f), 'list-shape')
})

// ── I-01: '없는 것'과 '모양이 깨진 것'을 가른다 ────────────────────────────────
//
// 종전 열거는 `asRecord(x) ?? {}` 로 읽어 **null·배열·문자열을 빈 표로 삼켰다**. 서버가
// `mcp_servers: null` 이라고 답한 것은 "학생 설정에 MCP 가 없다"가 아니라 "그 칸을 읽지
// 못했다"는 뜻이다 — 빈 표로 읽으면 잠글 것이 없다고 믿고 그대로 스레드를 연다. 키가 아예
// 없는 응답(구버전 서버)만 빈 표로 읽는다.

test('I-01 mcp_servers 가 null 이면 빈 표가 아니라 거부다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: { mcp_servers: null, plugins: {} }, layers: [] }),
    'plugin/installed': () => installed([])
  })
  expectFail(await appThread(f), 'list-shape')
  expect(f.methods()).not.toContain('thread/start')
  expect(f.methods()).not.toContain('thread/resume')
})

test('I-01 plugins 가 배열이면 거부다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: { mcp_servers: {}, plugins: [{ id: 'p' }] }, layers: [] }),
    'plugin/installed': () => installed([])
  })
  expectFail(await appThread(f), 'list-shape')
})

test('I-01 plugin/installed 행이 null·빈 객체면 건너뛰지 않고 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: { mcp_servers: {}, plugins: {} }, layers: [] }),
    'plugin/installed': () => ({ data: [null, {}], nextCursor: null })
  })
  expectFail(await appThread(f), 'list-shape')
})

test('I-01 앱 스레드 경로에서도 plugins 가 null 이면 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: { mcp_servers: {}, plugins: null }, layers: [] }),
    'plugin/installed': () => installed([])
  })
  expectFail(await appThread(f), 'list-shape')
  expect(f.methods()).not.toContain('thread/start')
})

test('I-01 앱 스레드 경로에서 설치 행이 모양을 갖추지 못하면 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: {}, plugins: {} }),
    'plugin/installed': () => ({ data: [{}], nextCursor: null })
  })
  expectFail(await appThread(f), 'list-shape')
})

test('I-01 대조군: 키가 없는 병합 설정과 문자열 설치 id 는 종전대로 통과한다', async () => {
  const f = fakeRpc({
    'config/read': () => ({ config: {}, layers: [] }),
    'plugin/installed': () => installed(['p1'])
  })
  const out = expectOk(await appThread(f))
  expect(out.form).toBe('app-thread')
  if (out.form !== 'app-thread') return
  expect(out.config.mcp_servers).toEqual({})
  expect(out.config.plugins).toEqual({ p1: { enabled: false } })
})

test('I-01 대조군: 문자열 설치 id 목록은 그대로 읽는다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: {}, plugins: {} }),
    'plugin/installed': () => installed(['p1', 'p2'])
  })
  expectOk(await appThread(f))
  expect(f.methods()).toContain('plugin/installed')
})

test('§10-22 ⓕ mcp_servers 이름이 있는데 5회 재시도 뒤에도 data:[] 면 거부한다', async () => {
  const f = resultRpc(() => status([]))
  const out = expectFail(await appThread(f), 'result-check')
  expect(f.calls.filter((c) => c.method === 'mcpServerStatus/list').length).toBeGreaterThan(1)
  expect(out.remaining).toContain('a')
})

test('§10-22 ⓕ 이름이 행에는 있는데 disabled 가 아니면 즉시 거부한다', async () => {
  const f = resultRpc(() => status([connected('a')]))
  expectFail(await appThread(f), 'result-check')
  // 살아 있는 값은 재시도 없이 닫는다.
  expect(f.calls.filter((c) => c.method === 'mcpServerStatus/list')).toHaveLength(1)
})

test('§10-22 ⓕ 이름이 5회 모두 행에 없으면 거부한다(빈 목록 통과 금지)', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ servers: { a: { command: 'a' }, b: { command: 'b' } }, layers: { user: { a: { command: 'a' }, b: { command: 'b' } } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([disabled('a')]),
    'app/list': () => status([])
  })
  const out = expectFail(await appThread(f), 'result-check')
  expect(out.remaining).toEqual(['b'])
})

test('§10-22 ⓕ′ mcp_servers 가 비고 플러그인만 껐으면 data:[] 연속 2회는 통과다(I-01)', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ plugins: { p: { enabled: true } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': () => status([]),
    'app/list': () => status([])
  })
  const out = expectOk(await appThread(f))
  if (out.form !== 'app-thread') throw new Error('앱 스레드가 아니에요')
  expect(out.config.mcp_servers).toEqual({})
  expect(f.calls.filter((c) => c.method === 'mcpServerStatus/list').length).toBeGreaterThanOrEqual(2)
})

test('§10-22 ⓕ″ 같은 조건에서 둘째 읽기에 connected 행이 나오면 거부한다', async () => {
  const f = fakeRpc({
    'config/read': () => configRead({ plugins: { p: { enabled: true } } }),
    'plugin/installed': () => installed([]),
    'mcpServerStatus/list': (_p, round) => (round === 0 ? status([]) : status([connected('late')])),
    'app/list': () => status([])
  })
  expectFail(await appThread(f), 'result-check')
})

test('§10-22 app/list 가 비어 있지 않으면 거부한다', async () => {
  const f = resultRpc(() => status([disabled('a')]), { 'app/list': () => status([{ id: 'app-1' }]) })
  expectFail(await appThread(f), 'result-check')
})

test('§10-22 kordoc 을 붙이지 않은 스레드에 kordoc 행이 나오면 거부한다', async () => {
  const f = resultRpc(() => status([disabled('a'), connected(MCP_SERVER_NAME)]))
  expectFail(await appThread(f), 'result-check')
})

test('§10-22 응답 threadId 가 없으면 대조할 수 없으므로 거부한다', async () => {
  const f = resultRpc(() => status([disabled('a')]))
  const out = expectFail(await appThread(f, { check: { threadId: '', instructionSources: [] } }), 'no-thread')
  expect(out.remaining).toEqual([])
})

test('§10-22 대조는 응답의 threadId 로 상태를 읽는다(요청 id 가 아니라)', async () => {
  const f = resultRpc(() => status([disabled('a')]))
  expectOk(await appThread(f, { check: { threadId: 'response-id', instructionSources: [] } }))
  const call = f.calls.find((c) => c.method === 'mcpServerStatus/list')
  expect(call?.params.threadId).toBe('response-id')
  expect(call?.params.detail).toBe('toolsAndAuthOnly')
})

test('§10-22 config/read 는 층을 포함해 논문 폴더 기준으로 읽는다', async () => {
  const f = resultRpc(() => status([disabled('a')]))
  expectOk(await appThread(f))
  const call = f.calls.find((c) => c.method === 'config/read')
  expect(call?.params).toMatchObject({ cwd: '/tmp/kd-lock-root', includeLayers: true })
})

// ── §10-22 ⓗ·ⓗ′·ⓗ″ 지시문(`instructionSources`) — POSIX 벌 ────────────────────

const rootDir = (tag: string) => realpathSync(mkdtempSync(join(tmpdir(), `kd-instr-${tag}-`)))
const scratch: string[] = []
function dir(tag: string): string {
  const p = rootDir(tag)
  scratch.push(p)
  return p
}
afterAll(() => { for (const p of scratch) rmSync(p, { recursive: true, force: true }) })

/** 통과하는 기준 장면 — MCP·Apps 모두 꺼져 있고 지시문만 갈아 끼운다. */
function sourcesRpc(): Fake {
  return resultRpc(() => status([disabled('a')]))
}

test('§10-22 ⓗ 폴더 AGENTS.md 가 지시문에 들어 있으면 턴을 열지 않는다', async () => {
  const root = dir('folder')
  writeFileSync(join(root, 'AGENTS.md'), '# 폴더 지침\n')
  // `project_doc_max_bytes=0` 이 빠진 대조군이 이 모양을 낸다(⑧ 실측).
  expectFail(await appThread(sourcesRpc(), {
    root, check: { threadId: 't-1', instructionSources: [join(root, 'AGENTS.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ 폴더 지시문이 없으면 턴이 열린다', async () => {
  const root = dir('clean')
  const ok = expectOk(await appThread(sourcesRpc(), { root, check: { threadId: 't-1', instructionSources: [] } }))
  expect(ok.form).toBe('app-thread')
})

test('§10-22 ⓗ 전역 AGENTS.md 하나만 든 응답은 거부하지 않는다(I-02 전역 예외)', async () => {
  const root = dir('global-root')
  const home = dir('global-home')
  writeFileSync(join(home, 'AGENTS.md'), '# 전역\n')
  expectOk(await appThread(sourcesRpc(), {
    root, codexHome: home, check: { threadId: 't-1', instructionSources: [join(home, 'AGENTS.md')] }
  }))
})

test('§10-22 ⓗ′ 칸이 없거나 배열이 아니면 거부한다', async () => {
  const root = dir('shape')
  for (const bad of [undefined, null, 'x', {}]) {
    expectFail(await appThread(sourcesRpc(), { root, check: { threadId: 't-1', instructionSources: bad } }), 'result-check')
  }
})

test('§10-22 ⓗ′ 문자열이 아닌 원소·상대 경로는 거부한다', async () => {
  const root = dir('elem')
  expectFail(await appThread(sourcesRpc(), { root, check: { threadId: 't-1', instructionSources: [42] } }), 'result-check')
  expectFail(await appThread(sourcesRpc(), { root, check: { threadId: 't-1', instructionSources: ['AGENTS.md'] } }), 'result-check')
})

test('§10-22 ⓗ′ 논문 폴더 위쪽 폴더의 AGENTS.md 도 거부한다', async () => {
  const outer = dir('above')
  const root = join(outer, 'paper')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(outer, 'AGENTS.md'), '# 위 폴더\n')
  expectFail(await appThread(sourcesRpc(), {
    root, check: { threadId: 't-1', instructionSources: [join(outer, 'AGENTS.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ′ 풀리지 않는 경로는 거부한다', async () => {
  const root = dir('unresolvable')
  expectFail(await appThread(sourcesRpc(), {
    root, check: { threadId: 't-1', instructionSources: [join(root, '없는파일.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ″ CODEX_HOME 이 논문 폴더 안이면 전역 예외를 쓰지 않는다', async () => {
  const root = dir('home-inside')
  const home = join(root, 'codex-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'AGENTS.md'), '# 전역인 척\n')
  expectFail(await appThread(sourcesRpc(), {
    root, codexHome: home, check: { threadId: 't-1', instructionSources: [join(home, 'AGENTS.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ″ CODEX_HOME 이 논문 폴더 위쪽이어도 전역 예외를 쓰지 않는다', async () => {
  const outer = dir('home-above')
  const root = join(outer, 'paper')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(outer, 'AGENTS.md'), '# 위\n')
  expectFail(await appThread(sourcesRpc(), {
    root, codexHome: outer, check: { threadId: 't-1', instructionSources: [join(outer, 'AGENTS.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ″ 전역 AGENTS.md 가 논문 폴더 파일을 가리키는 링크면 거부한다', async () => {
  const root = dir('link-root')
  const home = dir('link-home')
  writeFileSync(join(root, 'AGENTS.md'), '# 폴더\n')
  symlinkSync(join(root, 'AGENTS.md'), join(home, 'AGENTS.md'))
  expectFail(await appThread(sourcesRpc(), {
    root, codexHome: home, check: { threadId: 't-1', instructionSources: [join(home, 'AGENTS.md')] }
  }), 'result-check')
})

test('§10-22 ⓗ″ CODEX_HOME 이 링크면 전역 예외를 쓰지 않는다', async () => {
  const real = dir('real-home')
  const link = join(dir('link-home-parent'), 'codex-home')
  writeFileSync(join(real, 'AGENTS.md'), '# 전역\n')
  symlinkSync(real, link)
  const root = dir('link-home-root')
  // 링크를 푼 실제 경로가 입력과 다르므로 예외 근거가 성립하지 않는다.
  expectFail(await appThread(sourcesRpc(), {
    root, codexHome: link, check: { threadId: 't-1', instructionSources: [join(link, 'AGENTS.md')] }
  }), 'result-check')
})
