/**
 * Codex 쪽 **기동 뒤 안전 검증**(설계 §3.3-1~4). Codex app-server에는 MCP 도구 호출을 승인 카드로
 * 멈출 통로가 없다 — 그래서 "검증 못 하면 안 연다"가 이 단계의 유일한 백스톱이다.
 *
 * `request`는 `JsonRpcProcess.request(method, params)`와 같은 모양이다(`app/src/main/chat/transport.ts:52`).
 * 시험은 응답을 모킹하고 시계를 주입한다 — 이 모듈은 스스로 잠들지 않는다.
 *
 * 응답 모양은 판마다 다를 수 있으므로 경계에서 `unknown`으로 받아 좁힌다. 좁히지 못하면 **실패**다
 * (검증 못 한 것을 통과로 바꾸지 않는다).
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { MCP_SERVER_NAME, READ_TOOLS, advertisedReadTools, type KordocMcpSpec } from './kordocMcp'

/** 검증에 실패한 이유. 연결 단계는 이것을 받아 MCP를 끄고 새 연결 객체로 다시 시도한다. */
export class McpSafetyError extends Error {
  constructor(message: string, readonly reason: string = 'mcp-verify') {
    super(message)
    this.name = 'McpSafetyError'
  }
}

export interface JsonRpcLike {
  request(method: string, params?: unknown): Promise<unknown>
}

export interface VerifyOptions {
  /** `thread/start`가 준 그 스레드. 목록 조회와 탐침 호출이 **같은 threadId**여야 한다. */
  threadId: string
  /** 논문 폴더(학생이 고른 그 폴더). */
  root: string
  spec: KordocMcpSpec
  /** 기본 1초. */
  sleep?: (ms: number) => Promise<void>
  /** 기본 `Date.now`. */
  now?: () => number
  /** 기본 `startup_timeout_sec`(20초). */
  startupTimeoutMs?: number
  /** 기본 1초 — 설계 §3.3-2. */
  pollMs?: number
}

/** 서버 상태가 "이미 실패"인 값들. connected가 올 때까지 기다릴 이유가 없다. */
const TERMINAL_STATUS = new Set(['failed', 'cancelled', 'disabled', 'authenticationRequired'])

const DEFAULT_SLEEP = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * kordoc이 실제로 내는 울타리 오류 문장(**4.17.1·4.24.39의 `assertWithinRoot` 실측**):
 * `허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다: <realPath>`
 * 판이 바뀌어도 유지되는 기술 표식(`KORDOC_ROOT`)과 문장 일부를 함께 본다.
 */
export const ROOT_DENIAL_TEXT = '허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 응답 어디에 있든 문자열만 모은다 — `mcpServer/tool/call` 응답 모양은 판마다 다를 수 있다. */
export function responseStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || value === undefined) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) {
    for (const v of value) responseStrings(v, out, depth + 1)
    return out
  }
  const rec = asRecord(value)
  if (rec) {
    for (const v of Object.values(rec)) responseStrings(v, out, depth + 1)
  }
  return out
}

function toolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools.flatMap((t) => {
      if (typeof t === 'string') return [t]
      const name = asRecord(t)?.name
      return typeof name === 'string' && name ? [name] : []
    })
  }
  const map = asRecord(tools)
  return map ? Object.keys(map) : []
}

/** 목록 응답의 서버 배열 — `data`/`servers`/배열 자체 어느 쪽이든 받는다(스키마 판차 흡수). */
function statusPages(result: unknown): { servers: unknown[]; cursor: string | null } {
  const rec = asRecord(result)
  const servers = Array.isArray(result) ? result
    : Array.isArray(rec?.data) ? rec.data
    : Array.isArray(rec?.servers) ? rec.servers
    : []
  const cursor = typeof rec?.nextCursor === 'string' && rec.nextCursor ? rec.nextCursor : null
  return { servers, cursor }
}

/**
 * 1·2단계: `mcpServerStatus/list`를 `nextCursor` 끝까지 모아 **서버 항목이 정확히 하나**이고
 * `runtimeStatus === 'connected'`가 될 때까지 1초 간격으로 재조회한다.
 */
async function waitForConnected(request: JsonRpcLike, opts: VerifyOptions): Promise<Record<string, unknown>> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? DEFAULT_SLEEP
  const timeout = opts.startupTimeoutMs ?? 20_000
  const pollMs = opts.pollMs ?? 1000
  const deadline = now() + timeout
  const maxRounds = Math.ceil(timeout / Math.max(pollMs, 1)) + 2
  for (let round = 0; round < maxRounds; round++) {
    const servers: unknown[] = []
    let cursor: string | null = null
    do {
      let page: unknown
      try {
        page = await request.request('mcpServerStatus/list', {
          serverName: MCP_SERVER_NAME,
          threadId: opts.threadId,
          detail: 'full',
          ...(cursor ? { cursor } : {})
        })
      } catch (e) {
        // 옛 판에 이 메서드가 없거나 조회가 거절되면 검증할 수 없다 → 열지 않는다.
        throw new McpSafetyError(`kordoc MCP 상태를 조회하지 못했어요: ${(e as Error)?.message ?? String(e)}`, 'status-list')
      }
      const parsed = statusPages(page)
      servers.push(...parsed.servers)
      cursor = parsed.cursor
    } while (cursor)

    if (servers.length > 1) throw new McpSafetyError('kordoc MCP 서버가 둘 이상이라 우리 서버를 확인할 수 없어요', 'ambiguous-server')
    const server = asRecord(servers[0])
    if (server) {
      const status = server.runtimeStatus
      if (typeof status !== 'string') throw new McpSafetyError('kordoc MCP 서버 상태를 읽지 못했어요', 'status-missing')
      if (TERMINAL_STATUS.has(status)) throw new McpSafetyError(`kordoc MCP 서버가 ${status} 상태예요`, `status-${status}`)
      if (status === 'connected') return server
    }
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  throw new McpSafetyError('kordoc MCP 서버가 제한 시간 안에 연결되지 않았어요', 'startup-timeout')
}

/**
 * 3단계: 도구 목록·서버 신원 확인. 하나라도 어긋나면 연다 ≠ 안전이므로 실패다.
 * 기대 집합 = `READ_TOOLS ∩ (그 판이 광고하는 도구)` — 표에 없는 판은 부분집합 조건만 쓴다.
 */
function checkTools(server: Record<string, unknown>, spec: KordocMcpSpec): void {
  if (server.toolsError !== null && server.toolsError !== undefined) {
    throw new McpSafetyError('kordoc MCP 도구 목록을 받지 못했어요', 'tools-error')
  }
  const names = toolNames(server.tools)
  if (!names.length) throw new McpSafetyError('kordoc MCP 도구 목록이 비어 있어요', 'tools-empty')
  const allowed = new Set<string>(READ_TOOLS)
  for (const name of names) {
    if (!allowed.has(name)) throw new McpSafetyError(`읽기 허용 목록에 없는 도구가 열려 있어요: ${name}`, 'tool-not-allowed')
  }
  const advertised = advertisedReadTools(spec.version)
  if (advertised) {
    const expected = advertised.filter((t) => allowed.has(t)).slice().sort()
    const actual = [...new Set(names)].sort()
    if (expected.length !== actual.length || expected.some((t, i) => t !== actual[i])) {
      throw new McpSafetyError(`kordoc ${spec.version}가 광고해야 할 읽기 도구와 목록이 달라요`, 'tools-mismatch')
    }
  }
  const info = asRecord(server.serverInfo) ?? {}
  if (info.name !== MCP_SERVER_NAME) throw new McpSafetyError(`kordoc MCP가 아니라 다른 서버가 붙었어요: ${String(info.name)}`, 'server-name')
  if (info.version !== spec.version) {
    throw new McpSafetyError(`우리가 띄운 kordoc 판(${spec.version})과 서버 판(${String(info.version)})이 달라요`, 'server-version')
  }
}

/**
 * 4단계: 실호출 탐침 2개. 파일을 쓰지 않고 `detect_format`만 부른다.
 *
 * 서버의 `safePath` 순서는 `realpath → assertWithinRoot → 확장자 검사`(4.17.1 실측)이므로
 * 오류 종류로 적용된 root를 읽을 수 있다.
 * - A: `file_path = realpath(root)` → **KORDOC_ROOT 오류가 아니어야** 한다(적용 root가 폴더의 조상이거나 같다).
 * - B: `file_path = dirname(realpath(root))` → **KORDOC_ROOT 오류여야** 한다(적용 root가 부모의 조상이 아니다).
 * A∧B ⇒ 적용 root == 논문 폴더. 학생 `config.toml`의 같은 이름 서버가 다른 root를 줬거나
 * `env_vars`가 안 먹었으면 여기서 깨진다.
 *
 * 이 탐침이 증명하지 않는 것: `KORDOC_OFFLINE`(서버 stderr는 Codex가 쥐고 있어 앱이 못 읽는다).
 */
async function probe(request: JsonRpcLike, threadId: string, filePath: string): Promise<string> {
  let result: unknown
  try {
    result = await request.request('mcpServer/tool/call', {
      server: MCP_SERVER_NAME,
      threadId,
      tool: 'detect_format',
      arguments: { file_path: filePath }
    })
  } catch (e) {
    throw new McpSafetyError(`kordoc 탐침 호출이 실패했어요: ${(e as Error)?.message ?? String(e)}`, 'probe-call')
  }
  return responseStrings(result).join('\n')
}

/**
 * §3.3 기동 뒤 검증 전체. 통과하면 `void`, 하나라도 못 채우면 `McpSafetyError`.
 * 호출자는 이 오류를 받으면 그 연결 객체를 버리고 MCP 없는 새 연결로 같은 턴을 다시 돌린다.
 */
export async function verifyCodexKordoc(request: JsonRpcLike, opts: VerifyOptions): Promise<void> {
  if (typeof opts.threadId !== 'string' || !opts.threadId) {
    throw new McpSafetyError('threadId 없이는 kordoc MCP를 검증할 수 없어요', 'no-thread')
  }
  let rootReal: string
  try { rootReal = realpathSync(opts.root) } catch {
    throw new McpSafetyError('논문 폴더 경로를 확인하지 못해 kordoc MCP를 검증할 수 없어요', 'bad-root')
  }
  const server = await waitForConnected(request, opts)
  checkTools(server, opts.spec)

  const a = await probe(request, opts.threadId, rootReal)
  if (!a.trim()) throw new McpSafetyError('탐침 A 응답이 비어 있어 적용된 root를 확인하지 못했어요', 'probe-a-empty')
  if (a.includes(ROOT_DENIAL_TEXT)) {
    throw new McpSafetyError('kordoc의 작업 폴더가 논문 폴더보다 하위로 잡혔어요', 'probe-a-denied')
  }

  const b = await probe(request, opts.threadId, dirname(rootReal))
  if (!b.includes(ROOT_DENIAL_TEXT)) {
    throw new McpSafetyError('kordoc의 작업 폴더가 논문 폴더보다 위로 잡혔어요', 'probe-b-allowed')
  }
}