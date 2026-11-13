/**
 * codexToolLock.ts — Codex 쪽 1층 잠금(설계 §4.1-C)의 한 자리.
 *
 * 두 쓰임이 같은 규칙을 쓴다(설계 "공용 장치 자리"):
 *   - `app-thread` — 앱 안 대화. 끌 이름을 모아 **스레드 `config`** 로 넘기고, 스레드를 연 뒤
 *     런타임 상태(`mcpServerStatus/list`·`app/list`·`instructionSources`)로 대조한다.
 *   - `terminal` — 터미널 스크립트. 스레드가 없으므로 **`-c`** 로 넘기되, 끌 수 있다고 확인된
 *     것만 지목하고 하나라도 못 끄면 **실행을 거부**한다(스크립트도 만들지 않는다).
 *
 * 원칙
 *   - 학생 `~/.codex/config.toml` 은 읽기만 한다(쓰지 않는다).
 *   - 열거는 `config/read`(layers 포함)·`plugin/installed` 둘뿐이고, 둘 다 MCP 를 기동하지 않는다.
 *   - 목록 읽기는 '커서 없는 응답이 끝' 규칙을 따른다. 형식 이상·상한 도달은 빈 목록이 아니라 실패다.
 *   - 앱 스레드 `mcp_servers` 에는 `config/read` 의 유효 키만 넣는다 — 플러그인이 딸고 오는 이름을
 *     넣으면 기동이 `invalid transport` 로 죽는다(실측 ⓙ).
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, sep } from 'node:path'
import { MCP_SERVER_NAME, type KordocMcpSpec } from './kordocMcp'

/** 목록 한 번에 받는 장 수 상한. 상한에 닿았는데 커서가 남으면 실패다(설계 '목록 읽기 규칙'). */
export const LIST_PAGE_CAP = 50

/** 앱이 스레드 `config` 로 넘기는 잠금 값(설계 §4.1-C 2번). 키 순서는 지문이 고정한다. */
export interface LockConfig {
  features: { apps: false }
  mcp_servers: Record<string, { enabled: false }>
  plugins: Record<string, { enabled: false }>
  project_doc_max_bytes: 0
}

export type ToolLockForm = 'app-thread' | 'terminal'

/** 앱이 이 연결에 `-c` 로 주입한 서버(N-01). 안 붙였으면 빈 배열. */
export interface InjectedServer {
  name: string
  spec?: KordocMcpSpec
}

/** 잠금이 쓰는 최소 RPC 표면 — 시험이 가짜 연결을 넣는다. */
export interface LockRpc {
  request: (method: string, params?: unknown) => Promise<unknown>
}

export interface ToolLockRequest {
  /** 논문 폴더(판정 기준). `instructionSources` 대조에도 쓴다. */
  root: string
  form: ToolLockForm
  injected: InjectedServer[]
  /** 열거·대조용 연결. 앱 스레드는 실제 app-server, 터미널은 앱 연결(없으면 호출자가 띄운다). */
  rpc: LockRpc
  /** 앱 스레드 결과 대조 입력 — `thread/start`·`resume` 응답. */
  check?: { threadId: string; instructionSources: unknown }
  /** `instructionSources` 의 전역 예외 판정에 쓰는 CODEX_HOME(모르면 undefined). */
  codexHome?: string
  /** 결과 대조의 반복 읽기. 기본 0.8초 간격 5회(설계 §10-22 ⓐ·ⓑ). 시험은 `sleep` 만 바꾼다. */
  retry?: { sleep?: (ms: number) => Promise<void>; polls?: number }
}

/** 결과 대조 기본값 — 목록이 늦게 차는 서버를 기다리는 시간(설계 §10-22 ⓐ). */
export const RESULT_POLL_MS = 800
export const RESULT_POLLS = 5

export type ToolLockRefusal =
  | 'enumeration-failed'
  | 'list-shape'
  | 'page-cap'
  | 'uncancellable'
  | 'result-check'
  | 'no-thread'

export interface TerminalRefusalDetail {
  /** 남은 이름(도구 이름 또는 플러그인 id) */
  name: string
  /** 사유 줄에 괄호로 들어가는 말 */
  reason: string
  /** ②의 방법 한 줄 */
  method: string
}

/**
 * 앱 스레드 잠금의 **계획** — 열거로 정해진 `config` 와 그 지문.
 *
 * 설계 §4.1-C 1번은 열거가 `thread/start` **앞**에 끝나고 그 결과가 그 호출에 실려야 한다고
 * 정한다. 그래서 산출을 둘로 가른다: `codexToolLockPlan`(열거 → 계획) → 호출자가 스레드를
 * 열고 → `verifyAppThread`(결과 대조). `codexToolLock` 은 둘을 이어 붙인 한 번짜리 진입점이다.
 */
export interface AppThreadPlan {
  form: 'app-thread'
  config: LockConfig
  fingerprint: string
  lockedNames: string[]
  lockedPlugins: string[]
  kordocAttached: boolean
  /** 학생 층에 같은 이름이 있어 kordoc 을 껐을 때의 알림 문구(없으면 null) */
  kordocCollision: string | null
}

export interface AppThreadLock extends AppThreadPlan {
  ok: true
}

export interface TerminalLock {
  ok: true
  form: 'terminal'
  args: string[]
  fingerprint: string
  lockedNames: string[]
  lockedPlugins: string[]
}

export interface LockFailure {
  ok: false
  reason: ToolLockRefusal
  /** 남은(끄지 못한) 이름 — 열거 실패면 빈 배열 */
  remaining: string[]
  /** 학생에게 그대로 보여 줄 글(사유·방법 줄 포함) */
  studentCopy: string
}

export type ToolLockOutcome = AppThreadLock | TerminalLock | LockFailure

// ── 학생에게 보이는 글(설계 §4.1-C '거부할 때 학생이 보는 글') ─────────────────

export const TERMINAL_REFUSAL_HEAD = '**터미널 도우미(Codex)를 열지 않았어요.**'
/** 앱 스레드 설정 열거·결과 대조 실패 — 설계 §4.1-C 4번의 한 문단. */
export const APP_THREAD_RESULT_REFUSAL_COPY = 'Codex 설정의 외부 도구를 끄지 못했어요'
export const TERMINAL_ENUM_FAILED_COPY =
  'Codex 설정을 읽지 못해 터미널 도우미를 열지 않았어요. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 앱 안 대화창을 써 주세요.'

const methodProject = (name: string) =>
  `논문 폴더의 \`.codex/config.toml\`에서 ${name} 항목을 지우거나 \`enabled = false\`로 바꾸기`
const methodUser = (name: string) =>
  `Codex 설정 파일(\`~/.codex/config.toml\`, 공용이면 관리자 설정)에서 ${name} 항목을 지우거나 \`enabled = false\`로 바꾸기`
const methodPlugin = (name: string) => `Codex에서 ${name} 플러그인을 끄기`

/** 터미널 거부 글 한 벌. 사유·방법은 도구마다 다르고 나머지는 설계 문구 그대로다. */
export function terminalRefusalCopy(details: TerminalRefusalDetail[]): string {
  const named = details.map((d) => `**${d.name}**(${d.reason})`).join(', ')
  const methods = details.map((d) => `· ${d.method}`).join('\n')
  return [
    TERMINAL_REFUSAL_HEAD,
    `이 컴퓨터의 Codex 설정에 앱이 끌 수 없는 외부 도구가 켜져 있어요: ${named}`,
    '그대로 열면 그 도구가 앱의 확인 없이 논문 폴더에서 움직일 수 있어서 막았어요.',
    '**이렇게 하면 돼요**',
    '① 앱 안 대화창의 Codex 도우미는 그대로 쓸 수 있어요.',
    '② 터미널이 꼭 필요하면 아래 방법으로 그 도구를 끈 뒤 단추를 다시 눌러 주세요. 직접 설정한 적이 없다면 Codex를 설치해 준 사람에게 이 화면을 보여 주세요.',
    methods
  ].join('\n')
}

// ── 지문 ──────────────────────────────────────────────────────────────────────

/**
 * 잠금 지문 — "이 호출이 실은 잠금 `config`" 를 한 값으로. 이름 집합·Apps·프로젝트 문서 상한만
 * 넣는다(순서 무관, 값은 전부 고정). 같은 잠금이면 언제나 같은 지문이다.
 */
export function lockFingerprint(config: LockConfig): string {
  const serialized = JSON.stringify({
    apps: config.features.apps,
    mcp: Object.keys(config.mcp_servers).sort(),
    plugins: Object.keys(config.plugins).sort(),
    project_doc_max_bytes: config.project_doc_max_bytes
  })
  return createHash('sha256').update(serialized).digest('hex')
}

/** 잠금 값 정규형 — 지문·장부·시험이 같은 모양을 본다. 이름 0개면 `{}`(설계 ⓙ). */
export function emptyLockConfig(): LockConfig {
  return { features: { apps: false }, mcp_servers: {}, plugins: {}, project_doc_max_bytes: 0 }
}

// ── 목록 읽기 ─────────────────────────────────────────────────────────────────

type ReadReason = 'enumeration-failed' | 'list-shape' | 'page-cap'
type ReadResult<T> = { ok: true; items: T[] } | { ok: false; reason: ReadReason }
type Pick<T> = (res: unknown) => { list: T[]; cursor: unknown } | undefined

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 커서 있는 목록을 끝까지 읽는다. `pick` 이 목록 칸과 다음 커서를 꺼낸다 —
 * 목록 칸이 배열이 아니면 **빈 목록이 아니라 실패**다(설계 '목록 읽기 규칙').
 */
async function readPages<T>(rpc: LockRpc, method: string, params: Record<string, unknown>, pick: Pick<T>): Promise<ReadResult<T>> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < LIST_PAGE_CAP; page++) {
    let res: unknown
    try {
      res = await rpc.request(method, { ...params, ...(cursor ? { cursor } : {}) })
    } catch {
      return { ok: false, reason: 'enumeration-failed' }
    }
    const got = pick(res)
    if (!got) return { ok: false, reason: 'list-shape' }
    items.push(...got.list)
    const next = got.cursor
    if (next === undefined || next === null || next === '') return { ok: true, items }
    if (typeof next !== 'string') return { ok: false, reason: 'list-shape' }
    cursor = next
  }
  return { ok: false, reason: 'page-cap' }
}

/** `{data: T[]}` 또는 지정한 다른 칸 이름을 목록으로 읽는다. */
function listAt(res: unknown, key: string): { list: unknown[]; cursor: unknown } | undefined {
  const rec = asRecord(res)
  if (!rec) return undefined
  const list = rec[key]
  if (!Array.isArray(list)) return undefined
  return { list, cursor: rec.nextCursor }
}

type LayerKind = 'user' | 'project' | 'system'

interface Enumeration {
  /** 유효 설정(병합)의 MCP 서버 이름 → 값 */
  servers: Record<string, unknown>
  /** 유효 설정의 플러그인 id → 값 */
  plugins: Record<string, unknown>
  /** 층마다 그 층 자신의 표에 적힌 이름 → 값 */
  layers: Record<LayerKind, Record<string, unknown>>
  /** `plugin/installed` 가 알려 준 설치 id */
  installed: string[]
}

function layerKindOf(name: unknown): LayerKind | undefined {
  const type = asRecord(name)?.type
  return type === 'user' || type === 'project' || type === 'system' ? type : undefined
}

/** 표 칸 읽기 — 키가 없으면 빈 표, 있는데 표가 아니면 거부(I-01). */
function tableAt(rec: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!(key in rec)) return {}
  const value = asRecord(rec[key])
  return value ?? undefined
}

/** 열거 — 두 호출 모두 MCP 를 기동하지 않는다(설계 §4.1-C 1번). 실패는 이유와 함께 돌려준다. */
async function enumerate(req: ToolLockRequest): Promise<{ ok: true; value: Enumeration } | { ok: false; reason: ReadReason }> {
  let read: unknown
  try {
    // `includeLayers` 로 층별 표를 함께 받는다 — 판정 변수는 사용자 층 자신의 `command` 다.
    read = await req.rpc.request('config/read', { cwd: req.root, includeLayers: true })
  } catch {
    return { ok: false, reason: 'enumeration-failed' }
  }
  const merged = asRecord(asRecord(read)?.config)
  if (!merged) return { ok: false, reason: 'list-shape' }
  // **없는 것과 모양이 깨진 것은 다르다**(I-01). `null`·배열은 "그 칸을 읽지 못했다"이지
  // "잠글 것이 없다"가 아니다 — 빈 표로 삼키면 잠금 없이 스레드를 연다.
  const servers = tableAt(merged, 'mcp_servers')
  const plugins = tableAt(merged, 'plugins')
  if (!servers || !plugins) return { ok: false, reason: 'list-shape' }
  const layers: Record<LayerKind, Record<string, unknown>> = { user: {}, project: {}, system: {} }
  const rawLayers = asRecord(read)?.layers
  if (rawLayers !== undefined) {
    if (!Array.isArray(rawLayers)) return { ok: false, reason: 'list-shape' }
    for (const entry of rawLayers) {
      const kind = layerKindOf(asRecord(entry)?.name)
      if (!kind) continue
      const table = asRecord(asRecord(asRecord(entry)?.config)?.mcp_servers)
      if (table) layers[kind] = { ...layers[kind], ...table }
    }
  }

  const installed = await readPages<unknown>(req.rpc, 'plugin/installed', {}, (res) => listAt(res, 'data'))
  if (!installed.ok) return { ok: false, reason: installed.reason }
  const ids: string[] = []
  for (const item of installed.items) {
    if (typeof item === 'string' && item) { ids.push(item); continue }
    const rec = asRecord(item)
    const id = typeof rec?.id === 'string' ? rec.id : typeof rec?.pluginId === 'string' ? rec.pluginId : ''
    // 설치 행이 문자열도 표도 아니거나 id 가 없으면(`null`·`{}`) 건너뛰지 않고 닫는다(I-01).
    // 건너뛰면 그 플러그인의 이름을 모른 채 잠금 목록을 만든다 — 모르는 것은 통과가 아니다.
    if (!rec || !id) return { ok: false, reason: 'list-shape' }
    ids.push(id)
  }
  return { ok: true, value: { servers, plugins, layers, installed: ids } }
}

/** 그 이름이 학생 층 어디엔가 있는가(N-01). 앱 주입 이름을 학생 서버로 오인하지 않기 위한 판정. */
function inAnyStudentLayer(enumeration: Enumeration, name: string): boolean {
  return (['user', 'project', 'system'] as LayerKind[]).some((kind) => Object.prototype.hasOwnProperty.call(enumeration.layers[kind], name))
}

/** 유효값이 이미 꺼져 있는가 — 이미 꺼진 이름은 거부 사유가 아니다(설계 ⓙ 대조군). */
function mergedDisabled(enumeration: Enumeration, name: string): boolean {
  return asRecord(enumeration.servers[name])?.enabled === false
}

// ── 터미널: 끌 수 있는 것만 -c, 아니면 거부 ───────────────────────────────────

function planTerminal(req: ToolLockRequest, enumeration: Enumeration): { ok: true; args: string[]; lockedNames: string[]; lockedPlugins: string[] } | { ok: false; details: TerminalRefusalDetail[] } {
  const args: string[] = []
  const lockedNames: string[] = []
  const lockedPlugins: string[] = []
  const details: TerminalRefusalDetail[] = []
  const injectedNames = new Set(req.injected.map((i) => i.name))

  for (const name of Object.keys(enumeration.servers)) {
    const injected = injectedNames.has(name)
    if (injected && !inAnyStudentLayer(enumeration, name)) continue // 앱만 넣은 이름 — 터미널엔 없다
    // 앱이 주입한 이름이 학생 층에도 있으면 유효값이 앱 값으로 덮여 있다 → 켜져 있다고 본다.
    if (!injected && mergedDisabled(enumeration, name)) continue
    const userCommand = asRecord(enumeration.layers.user[name])?.command
    if (typeof userCommand === 'string' && userCommand.trim() !== '') {
      args.push('-c', `mcp_servers.${name}.enabled=false`)
      lockedNames.push(name)
      continue
    }
    // 사용자 층 자신의 표에 command 가 없다 → -c 로는 못 끈다(설계 §4.1-C 터미널 표).
    if (Object.prototype.hasOwnProperty.call(enumeration.layers.project, name)) {
      details.push({ name, reason: '이 논문 폴더의 Codex 설정에 적힌 도구', method: methodProject(name) })
    } else if (Object.prototype.hasOwnProperty.call(enumeration.layers.system, name)) {
      details.push({ name, reason: '컴퓨터 공용 설정의 도구', method: methodUser(name) })
    } else {
      details.push({ name, reason: '인터넷 주소로 연결되는 도구', method: methodUser(name) })
    }
  }

  for (const id of new Set<string>([...Object.keys(enumeration.plugins), ...enumeration.installed])) {
    if (!id) continue
    if (asRecord(enumeration.plugins[id])?.enabled === false) continue
    if (id.includes('.')) {
      details.push({ name: id, reason: '이름에 점(.)이 든 플러그인', method: methodPlugin(id) })
      continue
    }
    args.push('-c', `plugins.${id}.enabled=false`)
    lockedPlugins.push(id)
  }

  // 프로젝트 문서 상한은 스칼라라 `-c` 가 안전하다(설계 §4.1-E — 신뢰 폴더 값보다 이긴다).
  args.push('-c', 'project_doc_max_bytes=0')
  // Apps 는 항상 끈다 — 효과는 실측 ②, 키 수용은 세 판 모두 확인(I-03).
  args.push('-c', 'features.apps=false')

  if (details.length) return { ok: false, details }
  return { ok: true, args, lockedNames, lockedPlugins }
}

// ── 앱 스레드: config 산출 ────────────────────────────────────────────────────

export const KORDOC_COLLISION_NOTE = '학생 설정에 같은 이름의 kordoc 서버가 있어 한글 문서 도구를 끄고 진행해요'

interface AppPlan {
  config: LockConfig
  lockedNames: string[]
  lockedPlugins: string[]
  kordocAttached: boolean
  kordocCollision: string | null
}

function planAppThread(req: ToolLockRequest, enumeration: Enumeration): AppPlan {
  const config = emptyLockConfig()
  const lockedNames: string[] = []
  const lockedPlugins: string[] = []
  const injected = new Set(req.injected.map((i) => i.name))
  let kordocAttached = false
  let kordocCollision: string | null = null

  for (const name of Object.keys(enumeration.servers)) {
    if (injected.has(name)) {
      // 앱이 붙이는 kordoc 은 그대로 둔다(§4.1-D). 같은 이름이 학생 층에도 있으면 충돌이다.
      if (inAnyStudentLayer(enumeration, name)) {
        config.mcp_servers[name] = { enabled: false }
        lockedNames.push(name)
        if (name === MCP_SERVER_NAME) kordocCollision = KORDOC_COLLISION_NOTE
        continue
      }
      if (name === MCP_SERVER_NAME) kordocAttached = true
      continue
    }
    config.mcp_servers[name] = { enabled: false }
    lockedNames.push(name)
  }

  for (const id of new Set<string>([...Object.keys(enumeration.plugins), ...enumeration.installed])) {
    if (!id) continue
    config.plugins[id] = { enabled: false }
    lockedPlugins.push(id)
  }

  return { config, lockedNames, lockedPlugins, kordocAttached, kordocCollision }
}

// ── 결과 대조 ─────────────────────────────────────────────────────────────────

export const INSTRUCTION_SOURCE_REASONS = ['instructionSources-missing', 'instructionSources-path'] as const

/** `instructionSources` 통과 조건(§4.1-E). `[]` 는 통과. */
export function checkInstructionSources(
  raw: unknown,
  root: string,
  codexHome: string | undefined
): { ok: true } | { ok: false; reason: (typeof INSTRUCTION_SOURCE_REASONS)[number]; detail: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'instructionSources-missing', detail: 'instructionSources 가 배열이 아니에요' }
  const real = (p: string): string | undefined => {
    try { return realpathSync(p) } catch { return undefined }
  }
  const rootReal = real(root) ?? root
  const insideOrAbove = (target: string) =>
    target === rootReal || target.startsWith(rootReal + sep) || rootReal.startsWith(target + sep)
  // 전역 예외 — CODEX_HOME 바로 아래 `AGENTS.md`/`AGENTS.override.md` 만. CODEX_HOME 이 링크이거나
  // 논문 폴더 안/위면 예외 자체를 쓰지 않는다.
  const homeReal = codexHome ? real(codexHome) : undefined
  const homeUsable = !!codexHome && !!homeReal && homeReal === codexHome && !insideOrAbove(homeReal)

  for (const item of raw) {
    if (typeof item !== 'string' || !item) {
      return { ok: false, reason: 'instructionSources-missing', detail: 'instructionSources 항목이 문자열이 아니에요' }
    }
    const itemReal = real(item)
    if (!itemReal) return { ok: false, reason: 'instructionSources-path', detail: `경로를 풀지 못했어요: ${item}` }
    // 상대 경로는 어느 폴더 기준인지 알 수 없다 — 풀리더라도 받지 않는다(시험 §10-22 ⓗ′).
    if (!isAbsolute(itemReal)) return { ok: false, reason: 'instructionSources-path', detail: `절대 경로가 아니에요: ${item}` }
    // 폴더 안·위는 전역 예외가 있어도 거부한다(설계 ⓗ″).
    if (insideOrAbove(itemReal)) return { ok: false, reason: 'instructionSources-path', detail: `논문 폴더 안/위 지시문: ${itemReal}` }
    if (homeUsable && dirname(itemReal) === homeReal && (basename(itemReal) === 'AGENTS.md' || basename(itemReal) === 'AGENTS.override.md')) continue
    return { ok: false, reason: 'instructionSources-path', detail: `허용되지 않은 지시문: ${itemReal}` }
  }
  return { ok: true }
}

/** 기대 행 집합(E) — `config/read` 의 유효 `mcp_servers` 키 + 앱이 붙인 kordoc. 플러그인은 안 들어간다. */
function expectedRows(plan: AppPlan): string[] {
  const names = Object.keys(plan.config.mcp_servers)
  if (plan.kordocAttached && !names.includes(MCP_SERVER_NAME)) names.push(MCP_SERVER_NAME)
  return names
}

/** 상태 목록 한 장면 — 이름 → 그 행(`disabled` 여부를 여기서 가른다). */
interface StatusPage {
  rows: Map<string, Record<string, unknown>>
  /** 기대 밖이면서 `disabled` 가 아닌 이름 */
  live: string[]
  /** 기대 안인데 `disabled` 가 아닌 이름 */
  liveExpected: string[]
}

/** 상태 목록 한 번 읽기. 실패는 이유 그대로 돌려준다(빈 목록으로 흐르지 않는다). */
async function readStatusPage(req: ToolLockRequest, threadId: string, expected: string[], kordocAttached: boolean): Promise<{ ok: true; page: StatusPage } | { ok: false; reason: ToolLockRefusal }> {
  const statuses = await readPages<unknown>(req.rpc, 'mcpServerStatus/list',
    { threadId, detail: 'toolsAndAuthOnly' },
    (res) => listAt(res, 'data') ?? listAt(res, 'servers'))
  if (!statuses.ok) return { ok: false, reason: statuses.reason }
  const rows = new Map<string, Record<string, unknown>>()
  for (const row of statuses.items) {
    const rec = asRecord(row)
    const name = typeof rec?.name === 'string' ? rec.name : typeof rec?.serverName === 'string' ? rec.serverName : ''
    // 이름 없는 행은 판정할 수 없다 — 빈 목록으로 흐르지 않는다.
    if (!rec || !name) return { ok: false, reason: 'result-check' }
    // 같은 이름이 두 번 나오면 살아 있는 쪽이 이긴다.
    const prev = rows.get(name)
    if (prev && prev.runtimeStatus !== 'disabled') continue
    rows.set(name, rec)
  }
  const live: string[] = []
  const liveExpected: string[] = []
  for (const [name, rec] of rows) {
    if (rec.runtimeStatus === 'disabled') continue
    // 앱이 붙인 kordoc 은 §3.3 이 따로 본다(설계 §4.1-D).
    if (name === MCP_SERVER_NAME && kordocAttached) continue
    if (expected.includes(name)) liveExpected.push(name)
    else live.push(name)
  }
  return { ok: true, page: { rows, live, liveExpected } }
}

/** 반복 읽기 기본 간격 — 시험이 `sleep` 을 갈아 끼운다. */
async function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * 앱 스레드 결과 대조: MCP 는 전부 `disabled`(kordoc 예외), Apps 는 비어 있음, 지시문은 §4.1-E.
 *
 * 목록은 늦게 찬다. 기대 이름이 있으면 **이름마다 행이 나올 때까지 0.8초 × 5회** 다시 읽고,
 * 기대가 비었으면 **두 번 연속 빈 목록**이어야 통과한다(설계 §10-22 ⓕ′·I-01). 살아 있는 행은
 * 기다리지 않고 그 자리에서 닫는다.
 */
async function checkAppThreadResult(req: ToolLockRequest, plan: AppPlan): Promise<{ ok: true } | { ok: false; reason: ToolLockRefusal; detail: string; remaining: string[] }> {
  const check = req.check
  if (!check || typeof check.threadId !== 'string' || !check.threadId) return { ok: false, reason: 'no-thread', detail: 'threadId 없이 대조할 수 없어요', remaining: [] }

  const expected = expectedRows(plan)
  const polls = Math.max(1, req.retry?.polls ?? RESULT_POLLS)
  const gap = RESULT_POLL_MS
  const sleep = req.retry?.sleep ?? defaultSleep

  const read = async (): Promise<{ ok: false; reason: ToolLockRefusal; detail: string; remaining: string[] } | { ok: true; page: StatusPage }> => {
    const got = await readStatusPage(req, check.threadId, expected, plan.kordocAttached)
    if (!got.ok) return { ok: false, reason: got.reason, detail: 'MCP 상태 목록을 읽지 못했어요', remaining: [] }
    // 기대 밖 살아 있는 행은 기다릴 것 없이 닫는다(설계 ⓒ). 기대 안 살아 있는 행도 같다(ⓕ).
    if (got.page.live.length) return { ok: false, reason: 'result-check', detail: `꺼지지 않은 MCP 서버: ${got.page.live.join(', ')}`, remaining: [] }
    if (got.page.liveExpected.length) return { ok: false, reason: 'result-check', detail: `꺼지지 않은 MCP 서버: ${got.page.liveExpected.join(', ')}`, remaining: [...got.page.liveExpected] }
    return { ok: true, page: got.page }
  }

  if (!expected.length) {
    // 기대가 없다 — 첫 장이 비어 있으면 한 번 더 읽어 두 번 연속 빈 목록을 확인한다.
    for (let i = 0; i < 2; i++) {
      const got = await read()
      if (!got.ok) return got
      if (got.page.rows.size) break
      if (i === 0) await sleep(gap)
    }
    // 행이 하나라도 나왔으면 그 행들로 판정이 끝났다(전부 `disabled` — 살아 있으면 위에서 닫혔다).
    return finish(req, check.threadId)
  }

  let missing: string[] = [...expected]
  for (let i = 0; i < polls; i++) {
    const got = await read()
    if (!got.ok) return got
    missing = expected.filter((name) => !got.page.rows.has(name))
    if (!missing.length) return finish(req, check.threadId)
    if (i < polls - 1) await sleep(gap)
  }
  return { ok: false, reason: 'result-check', detail: `상태 목록에 없는 MCP 서버: ${missing.join(', ')}`, remaining: missing }
}

/** MCP 대조를 통과한 뒤의 나머지 두 갈래(Apps·지시문). */
async function finish(req: ToolLockRequest, threadId: string): Promise<{ ok: true } | { ok: false; reason: ToolLockRefusal; detail: string; remaining: string[] }> {
  const apps = await readPages<unknown>(req.rpc, 'app/list', { threadId }, (res) => listAt(res, 'data') ?? listAt(res, 'apps'))
  if (!apps.ok) return { ok: false, reason: apps.reason, detail: `앱 목록을 읽지 못했어요 (${apps.reason})`, remaining: [] }
  if (apps.items.length) return { ok: false, reason: 'result-check', detail: 'Apps 가 꺼지지 않았어요', remaining: [] }

  const sources = checkInstructionSources(req.check?.instructionSources, req.root, req.codexHome)
  if (!sources.ok) return { ok: false, reason: 'result-check', detail: sources.detail, remaining: [] }
  return { ok: true }
}

// ── 공개 진입점 ───────────────────────────────────────────────────────────────

function lockFailure(reason: ToolLockRefusal, studentCopy: string, remaining: string[] = []): LockFailure {
  return { ok: false, reason, remaining, studentCopy }
}

/**
 * 앱 스레드 잠금 1단계 — **열거와 계획**. `thread/start`/`thread/resume` **앞에** 부른다
 * (설계 §4.1-C 1번: 열거가 끝난 뒤 그 결과가 그 호출에 실린다). 돌려준 `plan.config` 를
 * 그대로 스레드 `config` 로 싣고, 응답을 받은 뒤 `appThreadLockVerify` 로 대조한다.
 */
export async function appThreadLockPlan(req: ToolLockRequest): Promise<{ ok: true; plan: AppThreadPlan } | LockFailure> {
  const enumerated = await enumerate(req)
  if (!enumerated.ok) return lockFailure(enumerated.reason, APP_THREAD_RESULT_REFUSAL_COPY)
  const plan = planAppThread(req, enumerated.value)
  return { ok: true, plan: { form: 'app-thread', ...plan, fingerprint: lockFingerprint(plan.config) } }
}

/** 앱 스레드 잠금 2단계 — 결과 대조(§4.1-C 4번·§4.1-D·§4.1-E). 통과하지 못하면 턴을 열지 않는다. */
export async function appThreadLockVerify(req: ToolLockRequest, plan: AppThreadPlan): Promise<{ ok: true } | LockFailure> {
  const verified = await checkAppThreadResult(req, plan)
  if (verified.ok) return { ok: true }
  // 결과 대조 실패는 "끄지 못했다"로 알린다. 목록을 못 읽은 갈래는 설정을 못 읽은 것이다.
  const copy = verified.reason === 'result-check' ? APP_THREAD_RESULT_REFUSAL_COPY : TERMINAL_ENUM_FAILED_COPY
  return lockFailure(verified.reason, copy, verified.remaining)
}

/** 한 번짜리 진입점 — 열거 → (앱이면) 스레드 → 대조를 한 호출로. 터미널은 스레드가 없다. */
export async function codexToolLock(req: ToolLockRequest): Promise<ToolLockOutcome> {
  const enumerated = await enumerate(req)
  if (!enumerated.ok) {
    const copy = req.form === 'terminal' ? TERMINAL_ENUM_FAILED_COPY : APP_THREAD_RESULT_REFUSAL_COPY
    return lockFailure(enumerated.reason, copy)
  }

  if (req.form === 'terminal') {
    const planned = planTerminal(req, enumerated.value)
    if (!planned.ok) return lockFailure('uncancellable', terminalRefusalCopy(planned.details), planned.details.map((d) => d.name))
    const fingerprint = lockFingerprint({
      features: { apps: false },
      mcp_servers: Object.fromEntries(planned.lockedNames.map((n) => [n, { enabled: false as const }])),
      plugins: Object.fromEntries(planned.lockedPlugins.map((n) => [n, { enabled: false as const }])),
      project_doc_max_bytes: 0
    })
    return { ok: true, form: 'terminal', args: planned.args, fingerprint, lockedNames: planned.lockedNames, lockedPlugins: planned.lockedPlugins }
  }

  const planBody = planAppThread(req, enumerated.value)
  const plan: AppThreadPlan = { form: 'app-thread', ...planBody, fingerprint: lockFingerprint(planBody.config) }
  const verified = await checkAppThreadResult(req, plan)
  if (!verified.ok) {
    // 결과 대조 실패는 "끄지 못했다"로 알린다(§4.1-C 4번). 열거를 못 한 쪽은 설정을 못 읽은 것이다.
    const copy = verified.reason === 'result-check' ? APP_THREAD_RESULT_REFUSAL_COPY : TERMINAL_ENUM_FAILED_COPY
    return lockFailure(verified.reason, copy, verified.remaining)
  }
  return { ok: true, ...plan }
}
