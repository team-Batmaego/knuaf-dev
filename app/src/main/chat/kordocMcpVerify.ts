/**
 * Codex 쪽 **기동 뒤 안전 검증**(설계 §3.3-1~4). Codex app-server에는 MCP 도구 호출을 승인 카드로
 * 멈출 통로가 없다 — 그래서 "검증 못 하면 안 연다"가 이 단계의 유일한 백스톱이다.
 *
 * `request`는 `JsonRpcProcess.request(method, params)`와 같은 모양이다(`app/src/main/chat/transport.ts:52`).
 * 시험은 응답을 모킹하고 시계를 주입한다 — 이 모듈은 스스로 잠들지 않는다.
 *
 * 검토 R1(M1-R1-01·02) 이후 두 규칙이 코드에 박혀 있다.
 * 1. **탐침 판독은 허용 목록이다.** 도구 결과(`content[].text` + `isError`)만 증거로 쓰고,
 *    `_meta` 같은 다른 필드 문자열은 보지 않는다. "root 거절 문구 없음"은 경계 통과의 증거가 아니다 —
 *    실제 `safePath`는 realpath 실패 시 경계 검사 **전에** "파일을 찾을 수 없습니다"를 낸다.
 * 2. **시간 상한은 함수 하나의 deadline 이다.** 목록 RPC 대기·페이지 수집·탐침 호출 전부 남은 시간으로
 *    경쟁시키고, connected 응답을 받아도 상한을 먼저 검사한다. 반복 cursor 도 실패다.
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
  /** 기본 `startup_timeout_sec`(20초). 이 함수 **전체**의 상한이다(목록 RPC·페이지·탐침 포함). */
  startupTimeoutMs?: number
  /** 기본 1초 — 설계 §3.3-2. */
  pollMs?: number
}

/** 서버 상태가 "이미 실패"인 값들. connected가 올 때까지 기다릴 이유가 없다. */
const TERMINAL_STATUS = new Set(['failed', 'cancelled', 'disabled', 'authenticationRequired'])

/**
 * kordoc이 실제로 내는 울타리 오류 문장(**4.17.1·4.24.39의 `assertWithinRoot` 실측**):
 * `허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다: <realPath>`
 */
export const ROOT_DENIAL_TEXT = '허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다'

/**
 * 오류 **종류** 판정은 문장 시작부의 고정 형식으로만 한다(검토 FIXCHECK1 잔여 지적).
 *
 * kordoc 도구 결과 형식은 `오류: <종류 문장>: <경로…>`(실측)이다. 경로가 문장 뒤에 붙으므로
 * 부분 문자열 포함(`includes`)으로 종류를 고르면, **경로에 그 문구가 들어간 "파일 없음" 응답**이
 * 확장자 오류로 오인된다 — 그게 바로 다른 root 서버를 통과시키던 구멍이다.
 * 그래서 `^`(필요하면 `오류: ` 접두)로 시작부를 고정하고, 여러 텍스트 항목은 **전부 같은 종류**여야 한다.
 */
/** `safePath` 실측: `지원하지 않는 확장자입니다: <ext> (허용: …)` — 경계 검사 **뒤**에만 나온다. */
export const EXTENSION_ERROR_TEXT = '지원하지 않는 확장자입니다'
export const EXTENSION_ERROR_PATTERN = /^(?:오류:\s*)?지원하지 않는 확장자입니다:/

/** `assertWithinRoot` 실측: `허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다: <realPath>`. */
export const ROOT_DENIAL_PATTERN = /^(?:오류:\s*)?허용된 작업 디렉토리\(KORDOC_ROOT\) 밖의 경로입니다:/

const DEFAULT_SLEEP = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export interface ToolResult {
  isError: boolean
  /** `content[].text` 항목들. 판정은 항목별 시작부로만 한다(경로 속 문구에 속지 않게). */
  items: string[]
  /** 항목을 `\n` 으로 이어 붙인 진단용 문자열. 판정에 쓰지 않는다. */
  text: string
}

/**
 * MCP `CallToolResult`에서 **도구 결과만** 판독한다.
 *
 * 증거로 쓰는 필드는 `content`(배열, `type === 'text'` 항목의 `text`)와 `isError`(불리언) 뿐이다.
 * 그 밖의 모양(`content`가 배열이 아님, `isError`가 불리언이 아님, `_meta`만 있는 응답 등)은
 * `null` — 판독할 수 없으면 통과가 아니라 실패다.
 */
export function readToolResult(value: unknown): ToolResult | null {
  const rec = asRecord(value)
  if (!rec) return null
  if (!Array.isArray(rec.content)) return null
  if (rec.isError !== undefined && typeof rec.isError !== 'boolean') return null
  const items = rec.content.flatMap((item) => {
    const c = asRecord(item)
    return c && c.type === 'text' && typeof c.text === 'string' ? [c.text] : []
  })
  return { isError: rec.isError === true, items, text: items.join('\n') }
}

/**
 * 도구 결과가 **그 종류의 고정 시작부**로 시작하는 오류인가.
 *
 * 텍스트 항목이 하나 이상 있어야 하고, **모든 항목이 같은 종류**여야 한다 — 여러 항목이 서로 다른
 * 종류를 말하면 종류를 확정할 수 없으므로 거짓(닫힘)이다. `includes`가 아니라 `test`(앵커 포함)만 쓴다.
 */
export function resultIsKind(result: ToolResult, pattern: RegExp): boolean {
  return result.items.length > 0 && result.items.every((t) => pattern.test(t.trim()))
}

/**
 * 하나의 deadline 아래에서 모든 RPC를 부른다. 남은 시간으로 경쟁시키므로 응답하지 않는 RPC도
 * 상한에서 실패로 닫힌다(transport 자체의 45초 타임아웃은 이 계약을 대신하지 못한다).
 */
interface BudgetedRequests {
  /** 남은 ms. 0 이하면 상한 초과. */
  left: () => number
  expired: () => boolean
  request: (method: string, params: unknown, reason: string) => Promise<unknown>
}

function budgeted(request: JsonRpcLike, now: () => number, timeoutMs: number): BudgetedRequests {
  const deadline = now() + timeoutMs
  const left = (): number => deadline - now()
  return {
    left,
    expired: (): boolean => left() <= 0,
    async request(method: string, params: unknown, reason: string): Promise<unknown> {
      const ms = left()
      if (ms <= 0) throw new McpSafetyError('kordoc MCP 검증 시간이 초과됐어요', 'startup-timeout')
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new McpSafetyError('kordoc MCP 응답이 제한 시간을 넘겼어요', 'startup-timeout')), ms)
      try {
        return await Promise.race([request.request(method, params), timeout.promise])
      } catch (e) {
        if (e instanceof McpSafetyError) throw e
        throw new McpSafetyError(`kordoc MCP 응답을 받지 못했어요: ${(e as Error)?.message ?? String(e)}`, reason)
      } finally {
        clearTimeout(timer)
      }
    }
  }
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

/** 페이지 수 상한 — cursor 가 계속 새 값으로 늘어나는 서버에서도 끝난다. */
const MAX_PAGES = 100

/**
 * 1·2단계: `mcpServerStatus/list`를 `nextCursor` 끝까지 모아 **서버 항목이 정확히 하나**이고
 * `runtimeStatus === 'connected'`가 될 때까지 1초 간격으로 재조회한다.
 *
 * 상한 검사는 **응답을 받은 직후·사용 전**에 한다 — 늦게 온 connected 는 통과가 아니다.
 */
async function waitForConnected(
  call: BudgetedRequests,
  opts: VerifyOptions
): Promise<Record<string, unknown>> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? DEFAULT_SLEEP
  const pollMs = opts.pollMs ?? 1000
  const timeout = opts.startupTimeoutMs ?? 20_000
  const maxRounds = Math.ceil(timeout / Math.max(pollMs, 1)) + 2
  for (let round = 0; round < maxRounds; round++) {
    if (call.expired()) throw new McpSafetyError('kordoc MCP 서버가 제한 시간 안에 연결되지 않았어요', 'startup-timeout')
    const servers: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = await call.request('mcpServerStatus/list', {
        serverName: MCP_SERVER_NAME,
        threadId: opts.threadId,
        detail: 'full',
        ...(cursor ? { cursor } : {})
      }, 'status-list')
      if (call.expired()) throw new McpSafetyError('kordoc MCP 서버가 제한 시간 안에 연결되지 않았어요', 'startup-timeout')
      const parsed = statusPages(page)
      servers.push(...parsed.servers)
      cursor = parsed.cursor
      if (cursor) {
        if (seen.has(cursor)) throw new McpSafetyError('kordoc MCP 상태 목록의 cursor가 반복돼요', 'pagination-loop')
        seen.add(cursor)
        if (seen.size > MAX_PAGES) throw new McpSafetyError('kordoc MCP 상태 목록 페이지가 너무 많아요', 'pagination-loop')
      }
    } while (cursor)

    if (servers.length > 1) throw new McpSafetyError('kordoc MCP 서버가 둘 이상이라 우리 서버를 확인할 수 없어요', 'ambiguous-server')
    const server = asRecord(servers[0])
    if (server) {
      const status = server.runtimeStatus
      if (typeof status !== 'string') throw new McpSafetyError('kordoc MCP 서버 상태를 읽지 못했어요', 'status-missing')
      if (TERMINAL_STATUS.has(status)) throw new McpSafetyError(`kordoc MCP 서버가 ${status} 상태예요`, `status-${status}`)
      if (status === 'connected') {
        // connected 를 받았어도 상한을 먼저 본다 — 늦게 온 통과는 통과가 아니다.
        if (call.expired()) throw new McpSafetyError('kordoc MCP 서버가 제한 시간 안에 연결되지 않았어요', 'startup-timeout')
        return server
      }
    }
    if (call.expired()) break
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
 * 서버의 `safePath` 순서는 `realpath → assertWithinRoot → 확장자 검사`(4.17.1 실측)이므로,
 * **경계 검사 뒤에만 나오는 결과**만 통과시킬 수 있다:
 * - A: `file_path = realpath(root)` → 성공(내용 있음)이거나 **확장자 오류**여야 한다.
 *   "파일을 찾을 수 없습니다"·권한·통신·불명·빈 내용은 경계 통과를 증명하지 못한다(검토 R1-01).
 * - B: `file_path = dirname(realpath(root))` → **도구 결과 텍스트 안의** root 거절 오류여야 한다.
 *
 * A∧B ⇒ 적용 root == 논문 폴더. 학생 `config.toml`의 같은 이름 서버가 다른 root를 줬거나
 * `env_vars`가 안 먹었으면 여기서 깨진다. 판독은 `readToolResult`만 쓴다(`_meta` 등은 증거가 아니다).
 *
 * 이 탐침이 증명하지 않는 것: `KORDOC_OFFLINE`(서버 stderr는 Codex가 쥐고 있어 앱이 못 읽는다).
 */
async function probe(
  call: BudgetedRequests,
  threadId: string,
  filePath: string
): Promise<ToolResult> {
  const result = await call.request('mcpServer/tool/call', {
    server: MCP_SERVER_NAME,
    threadId,
    tool: 'detect_format',
    arguments: { file_path: filePath }
  }, 'probe-call')
  const judged = readToolResult(result)
  if (!judged) throw new McpSafetyError('kordoc 탐침 응답의 도구 결과를 읽지 못했어요', 'probe-unreadable')
  return judged
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
  const call = budgeted(request, opts.now ?? Date.now, opts.startupTimeoutMs ?? 20_000)
  const server = await waitForConnected(call, opts)
  checkTools(server, opts.spec)

  const a = await probe(call, opts.threadId, rootReal)
  if (call.expired()) throw new McpSafetyError('kordoc MCP 검증 시간이 초과됐어요', 'startup-timeout')
  if (!a.text.trim()) throw new McpSafetyError('탐침 A 응답이 비어 있어 적용된 root를 확인하지 못했어요', 'probe-a-empty')
  if (a.isError) {
    if (resultIsKind(a, ROOT_DENIAL_PATTERN)) {
      throw new McpSafetyError('kordoc의 작업 폴더가 논문 폴더보다 하위로 잡혔어요', 'probe-a-denied')
    }
    // 경계 검사를 통과한 뒤에만 나올 수 있는 오류는 확장자 오류뿐이다 — 문장 시작부로만 판정한다.
    if (!resultIsKind(a, EXTENSION_ERROR_PATTERN)) {
      throw new McpSafetyError('탐침 A가 경계 검사를 지났다는 것을 증명하지 못했어요', 'probe-a-unproven')
    }
  }

  const b = await probe(call, opts.threadId, dirname(rootReal))
  if (call.expired()) throw new McpSafetyError('kordoc MCP 검증 시간이 초과됐어요', 'startup-timeout')
  if (!b.isError) throw new McpSafetyError('kordoc의 작업 폴더가 논문 폴더보다 위로 잡혔어요', 'probe-b-allowed')
  if (!resultIsKind(b, ROOT_DENIAL_PATTERN)) {
    throw new McpSafetyError('탐침 B가 root 거절 오류를 돌려주지 않았어요', 'probe-b-unproven')
  }
}