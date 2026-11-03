/**
 * E3 Codex 몫 — `-c` 인자 스냅샷 + 기동 뒤 검증(§3.3-1~4)의 실패 입력 11가지.
 *
 * 실기 Codex app-server는 M1에서 돌리지 않는다(연결 단계 몫). 여기서는 설계 표의 모킹 입력을
 * 전부 "끈다"로 닫고, 정상 1건만 통과시킨다 — 검증 함수가 관대해지면 그 자체가 구멍이다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CODEX_STARTUP_TIMEOUT_SEC, CODEX_TOOL_TIMEOUT_SEC, READ_TOOLS, codexMcpArgs, codexMcpEnv,
  advertisedReadTools, type KordocMcpSpec
} from '../src/main/chat/kordocMcp'
import { McpSafetyError, ROOT_DENIAL_TEXT, verifyCodexKordoc } from '../src/main/chat/kordocMcpVerify'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-verify-')))
const root = join(base, '논문폴더')
mkdirSync(root)
test.afterAll(() => rmSync(base, { recursive: true, force: true }))

const spec: KordocMcpSpec = {
  command: '/opt/homebrew/bin/node',
  args: ['/Users/nara/work/kordoc/dist/mcp.js'],
  env: { KORDOC_ROOT: root, KORDOC_OFFLINE: '1', ELECTRON_RUN_AS_NODE: '1' },
  version: '4.17.1'
}

// ── 모킹 도구 ────────────────────────────────────────────────────────────────

/** 가짜 시계 — 검증 함수는 실제로 잠들지 않는다. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    elapsed: () => t,
    /** 응답 도중 시간이 흐른 경우 — 검토 R1-02 의 지연 응답 재현. */
    advance: (ms: number) => { t += ms }
  }
}

type Call = { method: string; params: Record<string, unknown> }

/** 4.17.1 서버가 실제로 내는 응답 모양(실측: serverInfo{name,version}, runtimeStatus). */
function server(over: Record<string, unknown> = {}) {
  const advertised = advertisedReadTools(spec.version) ?? READ_TOOLS
  return {
    runtimeStatus: 'connected',
    tools: Object.fromEntries(advertised.map((t) => [t, { name: t }])),
    serverInfo: { name: 'kordoc', version: spec.version },
    ...over
  }
}

/** 탐침 응답: 폴더 자체는 확장자 오류, 그 밖은 KORDOC_ROOT 오류(실측 문장). */
function probeReply(filePath: string): unknown {
  const real = realpathSync(root)
  if (filePath === real) {
    return { content: [{ type: 'text', text: '오류: 지원하지 않는 확장자입니다:  (허용: .hwp, .hwpx)' }], isError: true }
  }
  return { content: [{ type: 'text', text: `오류: ${ROOT_DENIAL_TEXT}: ${filePath}` }], isError: true }
}

function rpc(handler: (call: Call, round: number) => unknown) {
  const calls: Call[] = []
  let round = 0
  return {
    calls,
    request: async (method: string, params?: unknown) => {
      const call = { method, params: (params ?? {}) as Record<string, unknown> }
      calls.push(call)
      if (method === 'mcpServerStatus/list') return handler(call, round++)
      return handler(call, -1)
    }
  }
}

const opts = (over: Partial<Parameters<typeof verifyCodexKordoc>[1]> = {}) => ({
  threadId: 'th-1', root, spec, startupTimeoutMs: 20_000, pollMs: 1000, ...clock(), ...over
})

async function expectSafety(run: Promise<unknown>, reason: string) {
  const error = await run.then(() => null, (e: unknown) => e)
  expect(error, `실패해야 하는데 통과했어요: ${reason}`).toBeInstanceOf(McpSafetyError)
  expect((error as McpSafetyError).reason).toBe(reason)
}

// ── E3: 인자 스냅샷 ──────────────────────────────────────────────────────────

test('E3: codexMcpArgs — `-c` 6쌍·JSON.stringify·학생 폴더 경로는 명령줄에 없음', () => {
  const args = codexMcpArgs(spec)
  expect(args).toEqual([
    '-c', 'mcp_servers.kordoc.command="/opt/homebrew/bin/node"',
    '-c', 'mcp_servers.kordoc.args=["/Users/nara/work/kordoc/dist/mcp.js"]',
    '-c', 'mcp_servers.kordoc.env_vars=["KORDOC_ROOT","KORDOC_OFFLINE","ELECTRON_RUN_AS_NODE"]',
    '-c', `mcp_servers.kordoc.enabled_tools=${JSON.stringify([...READ_TOOLS])}`,
    '-c', 'mcp_servers.kordoc.startup_timeout_sec=20',
    '-c', 'mcp_servers.kordoc.tool_timeout_sec=120'
  ])
  expect(CODEX_STARTUP_TIMEOUT_SEC).toBe(20)
  expect(CODEX_TOOL_TIMEOUT_SEC).toBe(120)
  // 논문 폴더 경로(KORDOC_ROOT 값)는 argv 에 없어야 한다 — env_vars 는 이름만 넘긴다.
  expect(args.join(' ')).not.toContain(root)
  // enabled_tools 는 읽기 10개 정확히.
  expect(JSON.parse(args[7].slice('mcp_servers.kordoc.enabled_tools='.length))).toEqual([...READ_TOOLS])
  // env 는 app-server 프로세스 env 로 합쳐진다.
  expect(codexMcpEnv(spec)).toEqual({ KORDOC_ROOT: root, KORDOC_OFFLINE: '1', ELECTRON_RUN_AS_NODE: '1' })
})

test('E3: 한글·공백 경로는 JSON 문자열 하나로 보존된다', () => {
  const odd: KordocMcpSpec = {
    ...spec,
    command: '/Users/김철수/Library/Application Support/knuaf/node',
    args: ['/Users/김철수/Library/Application Support/kordoc/dist/mcp.js']
  }
  const args = codexMcpArgs(odd)
  expect(args[1]).toBe(`mcp_servers.kordoc.command=${JSON.stringify(odd.command)}`)
  expect(args[3]).toBe(`mcp_servers.kordoc.args=${JSON.stringify(odd.args)}`)
  expect(JSON.parse(args[3].slice('mcp_servers.kordoc.args='.length))).toEqual(odd.args)
})

// ── E3: 정상 1건 ────────────────────────────────────────────────────────────

test('E3: 정상 서버 1건만 통과 — 목록 조회와 탐침이 같은 threadId', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    if (call.method === 'mcpServer/tool/call') return probeReply((call.params.arguments as { file_path: string }).file_path)
    throw new Error(`예상 밖 메서드: ${call.method}`)
  })
  await verifyCodexKordoc(m, opts())

  const list = m.calls.filter((c) => c.method === 'mcpServerStatus/list')
  expect(list.length).toBe(1)
  expect(list[0].params).toMatchObject({ serverName: 'kordoc', threadId: 'th-1', detail: 'full' })
  const probes = m.calls.filter((c) => c.method === 'mcpServer/tool/call')
  expect(probes).toHaveLength(2)
  for (const p of probes) expect(p.params).toMatchObject({ server: 'kordoc', threadId: 'th-1', tool: 'detect_format' })
  expect((probes[0].params.arguments as { file_path: string }).file_path).toBe(realpathSync(root))
  expect((probes[1].params.arguments as { file_path: string }).file_path).toBe(dirname(realpathSync(root)))
})

// ── E3: 실패 입력 11가지(설계 §5 E3 칸) ─────────────────────────────────────

test('E3-1: tools:{} + starting — 연결 전 도구 목록은 통과가 아니다', async () => {
  const c = clock()
  const m = rpc(() => ({ data: [server({ runtimeStatus: 'starting', tools: {} })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts({ ...c })), 'startup-timeout')
})

test('E3-2: failed + toolsError — 실패 상태는 기다리지 않는다', async () => {
  const m = rpc(() => ({ data: [server({ runtimeStatus: 'failed', toolsError: 'spawn ENOENT', tools: {} })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts()), 'status-failed')
})

test('E3-3: 서버가 둘 — 우리 서버를 특정할 수 없으니 끈다', async () => {
  const m = rpc(() => ({ data: [server(), server({ serverInfo: { name: 'kordoc', version: '4.24.39' } })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts()), 'ambiguous-server')
})

test('E3-4: serverInfo.version 불일치 — 학생 config.toml 의 같은 이름 서버를 걸러낸다', async () => {
  const m = rpc(() => ({ data: [server({ serverInfo: { name: 'kordoc', version: '4.16.0' } })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts()), 'server-version')
})

test('E3-5: 읽기 밖 도구가 열려 있으면 끈다', async () => {
  const advertised = advertisedReadTools(spec.version) ?? READ_TOOLS
  const tools = Object.fromEntries([...advertised, 'generate_document'].map((t) => [t, { name: t }]))
  const m = rpc(() => ({ data: [server({ tools })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts()), 'tool-not-allowed')
  // 이름은 읽기지만 그 판이 광고하지 않는 도구가 섞여도 같다(기대 집합 불일치).
  const extra = Object.fromEntries([...READ_TOOLS].map((t) => [t, { name: t }]))
  const m2 = rpc(() => ({ data: [server({ tools: extra })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m2, opts()), 'tools-mismatch')
})

test('E3-6: nextCursor 두 쪽 — 빈 쪽을 건너뛰고 모으고, 같은 서버가 두 번이면 끈다', async () => {
  let page = 0
  const m = rpc((call) => {
    if (call.method === 'mcpServer/tool/call') return probeReply((call.params.arguments as { file_path: string }).file_path)
    return page++ === 0 ? { data: [], nextCursor: 'c1' } : { data: [server()], nextCursor: null }
  })
  await verifyCodexKordoc(m, opts())
  expect(m.calls[1].params.cursor).toBe('c1')
  expect(m.calls[1].params.serverName).toBe('kordoc')

  let page2 = 0
  const m2 = rpc(() => (page2++ === 0 ? { data: [server()], nextCursor: 'c1' } : { data: [server()], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m2, opts()), 'ambiguous-server')
})

test('E3-7: 메서드 없음(옛 판) — 조회 실패는 검증 실패', async () => {
  const m = rpc(() => { throw new Error('Method not found: mcpServerStatus/list') })
  await expectSafety(verifyCodexKordoc(m, opts()), 'status-list')
})

test('E3-8: startup_timeout_sec 초과 — 시계 상한을 넘기면 끈다', async () => {
  const c = clock()
  const m = rpc(() => ({ data: [server({ runtimeStatus: 'starting' })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts({ ...c, startupTimeoutMs: 5000 })), 'startup-timeout')
  expect(c.elapsed()).toBeGreaterThanOrEqual(5000)
  expect(c.elapsed()).toBeLessThanOrEqual(6000)
})

test('E3-9: 탐침 A가 KORDOC_ROOT 오류 — 적용된 root 가 폴더보다 하위로 잡혔다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    const filePath = (call.params.arguments as { file_path: string }).file_path
    return { content: [{ type: 'text', text: `오류: ${ROOT_DENIAL_TEXT}: ${filePath}` }], isError: true }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-a-denied')
})

test('E3-10: 탐침 B가 통과 — root 가 상위(학생 config.toml env)로 잡혔다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    return { content: [{ type: 'text', text: 'ok' }] }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-b-allowed')
})

test('E3-11: threadId 없음 — 요청을 한 번도 보내지 않고 끈다', async () => {
  const m = rpc(() => ({ data: [server()], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(m, opts({ threadId: '' })), 'no-thread')
  expect(m.calls).toHaveLength(0)
})

test('E3: 탐침 A 응답이 비면 통과가 아니다(검증 못 한 것을 허용으로 바꾸지 않는다)', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    return { content: [] }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-a-empty')
})

test('E3: 도구 목록이 비었거나 serverInfo.name 이 다르면 끈다', async () => {
  const empty = rpc(() => ({ data: [server({ tools: {} })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(empty, opts()), 'tools-empty')

  const other = rpc(() => ({ data: [server({ serverInfo: { name: 'other', version: spec.version } })], nextCursor: null }))
  await expectSafety(verifyCodexKordoc(other, opts()), 'server-name')
})

// ── 검토 R1 반례(M1-R1-01·02) — 고치기 전 구현에서는 통과했다 ─────────────────

test('R1-02: 늦게 온 connected — 상한을 넘겼으면 통과가 아니다', async () => {
  const c = clock()
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') {
      c.advance(21_000)
      return { data: [server()], nextCursor: null }
    }
    return probeReply((call.params.arguments as { file_path: string }).file_path)
  })
  await expectSafety(verifyCodexKordoc(m, opts({ ...c })), 'startup-timeout')
  // 상한을 넘긴 응답은 탐침으로도 쓰지 않는다.
  expect(m.calls.filter((x) => x.method === 'mcpServer/tool/call')).toHaveLength(0)
})

test('R1-02: 페이지 수집이 상한을 넘기면 끝낸다', async () => {
  const c = clock()
  let pages = 0
  const m = rpc((call) => {
    if (call.method !== 'mcpServerStatus/list') return probeReply((call.params.arguments as { file_path: string }).file_path)
    pages++
    c.advance(10_000)
    return pages < 6 ? { data: [], nextCursor: 'same-cursor' } : { data: [server()], nextCursor: null }
  })
  await expectSafety(verifyCodexKordoc(m, opts({ ...c })), 'startup-timeout')
  expect(pages).toBe(2)
})

test('R1-02: 반복 cursor 는 시간이 남아 있어도 끝낸다', async () => {
  const m = rpc((call) => (call.method === 'mcpServerStatus/list' ? { data: [], nextCursor: 'loop' } : probeReply((call.params.arguments as { file_path: string }).file_path)))
  await expectSafety(verifyCodexKordoc(m, opts()), 'pagination-loop')
  expect(m.calls.filter((x) => x.method === 'mcpServerStatus/list')).toHaveLength(2)
})

test('R1-02: 응답하지 않는 RPC 도 남은 시간에 실패로 닫는다', async () => {
  const m = { request: () => new Promise<unknown>(() => {}) }
  await expectSafety(verifyCodexKordoc(m, opts({ startupTimeoutMs: 60, pollMs: 10 })), 'startup-timeout')
})

test('R1-01: 탐침 A가 "파일을 찾을 수 없습니다"면 경계 통과를 증명하지 못한다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    return { content: [{ type: 'text', text: `오류: 파일을 찾을 수 없습니다: ${(call.params.arguments as { file_path: string }).file_path}` }], isError: true }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-a-unproven')
})

test('R1-01: 내용 없는 A({content:[], status:"failed"})는 통과가 아니다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    return { content: [], status: 'failed' }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-a-empty')
})

test('R1-01: B의 _meta 에만 root 문구가 있어도 성공 응답은 통과가 아니다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    if ((call.params.arguments as { file_path: string }).file_path === realpathSync(root)) {
      return { content: [{ type: 'text', text: '오류: 지원하지 않는 확장자입니다:  (허용: .hwpx)' }], isError: true }
    }
    return { content: [{ type: 'text', text: 'ok' }], isError: false, _meta: { message: ROOT_DENIAL_TEXT } }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-b-allowed')
})

test('R1-01: 도구 결과를 읽을 수 없는 응답(content 가 배열이 아님)은 닫는다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    return { content: '오류: 지원하지 않는 확장자입니다', _meta: { message: ROOT_DENIAL_TEXT } }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-unreadable')
  const m2 = rpc((call) => (call.method === 'mcpServerStatus/list' ? { data: [server()], nextCursor: null } : { _meta: { text: ROOT_DENIAL_TEXT } }))
  await expectSafety(verifyCodexKordoc(m2, opts()), 'probe-unreadable')
})

test('R1-01: B가 root 문구 없는 오류(없는 파일 등)면 증명 실패', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    if ((call.params.arguments as { file_path: string }).file_path === realpathSync(root)) {
      return { content: [{ type: 'text', text: '오류: 지원하지 않는 확장자입니다:  (허용: .hwpx)' }], isError: true }
    }
    return { content: [{ type: 'text', text: '오류: 파일을 찾을 수 없습니다: /x' }], isError: true }
  })
  await expectSafety(verifyCodexKordoc(m, opts()), 'probe-b-unproven')
})

test('R1-01: 설계대로 A의 성공(내용 있음)은 통과 — 확장자 오류와 함께 허용 목록이다', async () => {
  const m = rpc((call) => {
    if (call.method === 'mcpServerStatus/list') return { data: [server()], nextCursor: null }
    if ((call.params.arguments as { file_path: string }).file_path === realpathSync(root)) {
      return { content: [{ type: 'text', text: 'hwpx' }], isError: false }
    }
    return { content: [{ type: 'text', text: `오류: ${ROOT_DENIAL_TEXT}: /x` }], isError: true }
  })
  await verifyCodexKordoc(m, opts())
})
