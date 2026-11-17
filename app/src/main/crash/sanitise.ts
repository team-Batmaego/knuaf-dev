/**
 * 오류 자동 보고 — 걸러내기·큐 I/O (DESIGN §2-2·2-3·2-4·2-6).
 *
 * 이 파일에는 **electron 을 import 하지 않는다**. 수집기가 실제로 하는 일(정규화·검증·상한·
 * 디스크 쓰기)이 전부 여기 있어서, Electron 없이 Node 만으로 시험할 수 있다
 * (`e2e/crash-sanitise.spec.ts`). 경로·앱 판 같은 실행 환경 값은 호출자가 넘긴다.
 *
 * 원칙은 하나다 — **아는 진단 식별자만 통과시키고 모르는 값은 고정 분류로 낮춘다**.
 * 형식(정규식) 검사는 파일 이름·학번·비밀값을 그대로 통과시켰다(C-01). 그래서 이름·코드·파일은
 * 고정 목록과 **문자열이 정확히 같을 때만** 살린다. 이 목록들은 Worker
 * (`knuaf-report-worker/src/index.js`)의 같은 목록과 값이 같아야 한다.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** JS·Node 내장 이름 12종 + 이 앱이 만드는 고정 낱말 3종. */
export const ERROR_NAMES: readonly string[] = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'AssertionError',
  'SystemError',
  // 이 앱이 만드는 고정 낱말 — Electron 이 준 값을 그대로 쓰지 않는다.
  'NonErrorRejection',
  'RendererGone',
  'ChildProcessGone'
]

/** errno 31종 — Node 가 파일·소켓에서 내는 실제 이름. */
export const ERROR_ERRNO: readonly string[] = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'EISDIR',
  'ENOTDIR',
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'EIO',
  'ENOMEM',
  'EINVAL',
  'EPIPE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRINUSE',
  'ENOBUFS',
  'EROFS',
  'EBUSY',
  'ELOOP',
  'ENAMETOOLONG',
  'EFBIG',
  'EDQUOT',
  'EXDEV',
  'ESRCH',
  'ECHILD',
  'EAGAIN',
  'ECANCELED'
]

/** Node v24.22.2 natives 전수(319개)에서 이 앱이 만날 수 있는 것만 남긴 38종. */
export const ERROR_ERR: readonly string[] = [
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_OUT_OF_RANGE',
  'ERR_INVALID_URL',
  'ERR_INVALID_URL_SCHEME',
  'ERR_MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_IPC_CHANNEL_CLOSED',
  'ERR_IPC_DISCONNECTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_INVALID_PROTOCOL',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_ASSERTION',
  'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_FS_FILE_TOO_LARGE',
  'ERR_FS_EISDIR',
  'ERR_UNHANDLED_ERROR',
  'ERR_BUFFER_OUT_OF_BOUNDS',
  'ERR_BUFFER_TOO_LARGE',
  'ERR_ENCODING_INVALID_ENCODED_DATA',
  'ERR_MISSING_ARGS',
  'ERR_UNESCAPED_CHARACTERS',
  'ERR_INVALID_THIS',
  'ERR_METHOD_NOT_IMPLEMENTED',
  'ERR_DIR_CLOSED',
  'ERR_FS_CP_EINVAL',
  'ERR_INVALID_STATE',
  'ERR_INVALID_RETURN_VALUE',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_IMPORT_ATTRIBUTE_MISSING'
]

/** `render-process-gone`·`child-process-gone` 의 `d.reason`. */
export const CRASH_REASONS: readonly string[] = ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']

/** `error.code` 가 될 수 있는 전부 — 목록에 정확히 없으면 `null`. */
export const ERROR_CODES: readonly string[] = [...ERROR_ERRNO, ...ERROR_ERR, ...CRASH_REASONS]

/** 앱 묶음 산출물 — 이 이름과 정확히 같을 때만 `where.file` 이 된다. */
export const BUNDLE_FILES: readonly string[] = ['out/main/index.js', 'out/preload/index.js']

/**
 * 설치판의 렌더러 청크 이름 — **실행 중에 자기 산출물 목록을 읽어 채운다**(C-01).
 * 정규식 추측은 임의 이름을 통과시켰다(학번·논문 제목형 파일명 반례). 목록이 비어 있으면
 * 렌더러 청크는 하나도 통과하지 못하고 `BUNDLE_FILES` 만 남는다 — 조용한 실패 쪽이 안전하다.
 */
let bundleAssets: ReadonlySet<string> = new Set()

/** 시작 때 한 번 — `out/renderer/assets` 의 실제 파일 이름만 받는다(`crash/index.ts`). */
export function setBundleAssets(files: readonly string[]): void {
  const out = new Set<string>()
  for (const name of files) {
    // 우리 디렉터리 목록에서 온 값이지만 경계는 여기서도 지킨다 — 경로 구분자·상위 참조 금지.
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name) || name.length > 128) continue
    out.add(`out/renderer/assets/${name}`)
  }
  bundleAssets = out
}

const SOURCES: readonly string[] = ['main', 'renderer', 'child']
const ORIGINS: readonly string[] = ['uncaughtException', 'unhandledRejection', 'Utility']
const PLATFORMS: readonly string[] = ['darwin', 'win32', 'linux']
const ARCHES: readonly string[] = ['arm64', 'x64', 'ia32']
const VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,3}(-[A-Za-z0-9.]{1,16})?$/
const RELEASE_RE = /^[A-Za-z0-9._-]{1,64}$/
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_LINE = 1_000_000

/** 큐 항목 하나의 UTF-8 직렬화 상한. 필드 상한을 다 채운 레코드가 실측 658 bytes 였다(R-01). */
export const MAX_ITEM_BYTES = 1024
/** `queue.json` 파일 상한 — 넘으면 읽지 않는다(손상·외부 조작 방어). */
export const MAX_QUEUE_BYTES = 4096
/** 큐 길이 상한. */
export const MAX_QUEUE_ITEMS = 3
/** 하루 전송 상한(학생 1명, 전 종류 합산). */
export const DAILY_MAX = 3
/** `state.keys` 길이 상한 — 넘으면 오래된 키부터 버린다. */
export const MAX_KEYS = 20
/** 재시도 상한 — 넘으면 항목을 버린다. */
export const MAX_ATTEMPT = 3
/** 큐 항목 수명(일) — 넘으면 읽을 때 버린다(DESIGN §2-6 "30일 뒤 폐기"). */
export const MAX_AGE_DAYS = 30
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export type CrashSource = 'main' | 'renderer' | 'child'
export type CrashOrigin = 'uncaughtException' | 'unhandledRejection' | 'Utility'

export interface CrashRecord {
  schema: 1
  kind: 'crash'
  app: { version: string }
  os: { platform: string; release: string | null; arch: string }
  source: CrashSource
  error: { name: string; code: string | null; origin?: CrashOrigin }
  where: { file: string; line: number } | null
  at: string
}

export interface QueueItem { rec: CrashRecord; attempt: number; first_seen: string }
export interface CrashState { schema: 1; day: string; sent: number; keys: string[] }

/** 중첩 필드를 꺼낸다 — 배열·null·원시값은 빈 객체로 본다. 읽기 지점이 10곳이라 한 곳에 둔다. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * 수집기·전송기 실패를 밖으로 내보내지 않는다(I-02). catch 안의 로그까지 try 로 감싸고
 * 그 catch 는 빈 블록이다 — 로그를 잃는 손실(진단 1줄)이 프로세스 종료 코드가 바뀌는
 * 손실(원래 진단 전체)보다 항상 작다. 일반 경로에는 이 예외를 적용하지 않는다.
 */
export function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    try { console.error('[crash] collector failed') } catch { /* 무조건 삼킨다 */ }
  }
}

/** 전송·부팅 경로의 catch 용 로그 — 이 한 줄도 절대 던지지 않는다. */
export function logQuietly(message: string): void {
  try { console.error(message) } catch { /* 무조건 삼킨다 */ }
}

/** 고정 목록에 정확히 있을 때만 그 이름, 아니면 `'Other'`(이벤트는 살린다). */
export function coerceName(raw: unknown): string {
  return typeof raw === 'string' && ERROR_NAMES.includes(raw) ? raw : 'Other'
}

/** 고정 목록에 정확히 있을 때만 그 값, 아니면 `null`. 형식 검사는 쓰지 않는다(C-01). */
export function coerceCode(raw: unknown): string | null {
  return typeof raw === 'string' && ERROR_CODES.includes(raw) ? raw : null
}

/** 허용 목록에 있는 파일 이름만. `out/` 로 시작해도 목록 밖이면 버린다. */
function coerceFile(raw: unknown): string | null {
  return typeof raw === 'string' && (BUNDLE_FILES.includes(raw) || bundleAssets.has(raw)) ? raw : null
}

/**
 * 스택 프레임의 경로에서 앱 묶음 기준 상대 이름을 얻는다. 통과 경로는 하나뿐이다 —
 * **정규화한 실제 앱 루트(`app.getAppPath()`)로 정확히 시작**할 때 그 뒤 상대 이름.
 *
 * 설치판은 앱이 asar 안에 있어 루트 자체가 `…/app.asar` 로 끝난다 — 그때도 "경로 어딘가에
 * `app.asar/` 가 있다"가 아니라 "이 루트로 시작한다"로 판정한다. 부분문자열 신뢰는
 * `/Users/student/notapp.asar/…` 를 통과시켰다(C-01).
 *
 * `/Users/김대욱/out/main/index.js` 는 통과하지 **못한다** — 경로 조각만 보고 `out/` 뒤를
 * 잘라 쓰면 사용자 경로가 앱 산출물로 위장한다(C-01 · §2-3 마지막 행).
 */
function relativeToApp(path: string, appRoot: string): string | null {
  // `file://` 를 먼저 벗긴다 — 아래 `\/{2,}` 접기가 `file:///` 을 `file:/` 로 만들어
  // 스킴 판정이 영영 참이 되지 않는다(ESM 스택 실측, §2-3 정규화 예 3행).
  let p = path
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length)
    try { p = decodeURIComponent(p) } catch { /* 인코딩이 깨졌으면 원문 그대로 */ }
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const root = appRoot.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  // 루트로 시작하지 않으면 방법이 둘뿐이다 — 이미 앱 루트 기준 상대 경로(`out/main/index.js`)거나
  // 버리는 경로. 절대 경로·드라이브 경로·스킴 경로는 상대일 수 없으므로 여기서 끊는다.
  if (root && p.startsWith(root + '/')) p = p.slice(root.length)
  else if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('node:')) return null
  else p = '/' + p
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/') || null
}

/** 한 프레임(`at f (/…/out/main/index.js:21741:19)`) → `{file, line}` 또는 `null`. */
export function normaliseFrame(frame: string, appRoot: string): { file: string; line: number } | null {
  if (!frame) return null
  const text = frame.trim().replace(/^at\s+/, '')
  const open = text.lastIndexOf('(')
  const target = open >= 0 && text.endsWith(')') ? text.slice(open + 1, -1) : text
  const m = /^(.*):(\d+):(\d+)$/.exec(target)
  if (!m) return null
  const line = Number(m[2])
  if (!Number.isInteger(line) || line < 1 || line > MAX_LINE) return null
  const file = coerceFile(relativeToApp(m[1], appRoot))
  return file ? { file, line } : null
}

/**
 * 스택 전문에서 앱 묶음 프레임 **첫** 것만. 맨 첫 줄에 기대지 않는다 — Node 내부 프레임이
 * 앞에 오는 경우가 실측됐다(§2-1).
 */
export function findWhere(stack: unknown, appRoot: string): { file: string; line: number } | null {
  if (typeof stack !== 'string' || !stack) return null
  for (const frame of stack.split('\n')) {
    const hit = normaliseFrame(frame, appRoot)
    if (hit) return hit
  }
  return null
}

/** 기기 로컬 날짜 — 상한 리셋 기준(`YYYY-MM-DD`). */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 레코드 한 벌의 스칼라 규칙 — 훅이 만든 값(buildRecord)과 디스크에서 읽은 값(reviveRecord)이
 * **같은 규칙**을 타야 한다. 경계마다 규칙을 복제하면 한쪽만 조여지는 구멍이 생긴다.
 */
function assemble(raw: Record<string, unknown>, now: Date): CrashRecord | null {
  const source = raw.source
  if (typeof source !== 'string' || !SOURCES.includes(source)) return null
  const origin = field(raw.error, 'origin')
  const whereFile = coerceFile(field(raw.where, 'file'))
  const whereLine = Number(field(raw.where, 'line'))
  const where = whereFile && Number.isInteger(whereLine) && whereLine >= 1 && whereLine <= MAX_LINE
    ? { file: whereFile, line: whereLine }
    : null
  const version = field(raw.app, 'version')
  const platform = field(raw.os, 'platform')
  const arch = field(raw.os, 'arch')
  const release = field(raw.os, 'release')
  const at = raw.at
  const code = coerceCode(field(raw.error, 'code'))
  const rec: CrashRecord = {
    schema: 1,
    kind: 'crash',
    app: { version: typeof version === 'string' && VERSION_RE.test(version) ? version : '0.0.0' },
    os: {
      platform: typeof platform === 'string' && PLATFORMS.includes(platform) ? platform : 'other',
      release: typeof release === 'string' && RELEASE_RE.test(release) ? release : null,
      arch: typeof arch === 'string' && ARCHES.includes(arch) ? arch : 'other'
    },
    source: source as CrashSource,
    error: { name: coerceName(field(raw.error, 'name')), code },
    where,
    at: typeof at === 'string' && AT_RE.test(at) ? at : now.toISOString()
  }
  if (typeof origin === 'string' && ORIGINS.includes(origin)) rec.error.origin = origin as CrashOrigin
  return rec
}

export interface RecordInput {
  source: unknown
  name: unknown
  code: unknown
  origin?: unknown
  stack?: unknown
}

export interface RecordContext {
  appRoot: string
  version: string
  platform: string
  release: string
  arch: string
  now: Date
}

/**
 * 잡은 값을 보내는 스키마(§2-2)로 정규화한다. 원문 메시지·경로·인자는 들어가지 않는다.
 * `source` 가 목록 밖이면 `null` — 이벤트 자체를 만들지 않는다(§2-3).
 */
export function buildRecord(input: RecordInput, ctx: RecordContext): CrashRecord | null {
  return assemble({
    source: input.source,
    app: { version: ctx.version },
    os: { platform: ctx.platform, release: ctx.release, arch: ctx.arch },
    error: { name: input.name, code: input.code, origin: input.origin },
    where: findWhere(input.stack, ctx.appRoot),
    at: ctx.now.toISOString()
  }, ctx.now)
}

/** 디스크에서 읽은 레코드 — 같은 규칙으로 다시 낮춘다(변조·판 올림 방어). */
export function reviveRecord(raw: unknown, now: Date): CrashRecord | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? assemble(raw as Record<string, unknown>, now)
    : null
}

/** 같은 날 같은 오류를 한 번만 — 큐에 넣을 때 기록한다(전송 시점이 아니다). */
export function dedupeKey(rec: CrashRecord): string {
  return [rec.source, rec.error.name, rec.error.code ?? '-', rec.where?.file ?? '-', rec.where?.line ?? '-', rec.app.version].join('|')
}

/** 항목 하나의 UTF-8 직렬화 바이트 — `attempt`·`first_seen` 포함(R-01). */
export function itemBytes(item: QueueItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8')
}

/** 날짜가 바뀌었으면 그 자리에서 리셋한 상태를 돌려준다(§2-6). */
export function rollState(state: CrashState, now: Date): CrashState {
  const day = localDay(now)
  return state.day === day ? state : { schema: 1, day, sent: 0, keys: [] }
}

/** `userData/crash` 아래 경로 셋. */
export function crashPaths(userData: string): { dir: string; queue: string; state: string } {
  const dir = join(userData, 'crash')
  return { dir, queue: join(dir, 'queue.json'), state: join(dir, 'state.json') }
}

function readJson(path: string, maxBytes: number): unknown {
  try {
    if (statSync(path).size > maxBytes) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 임시 파일 → `renameSync` 원자 교체. 중간에 죽어도 반쯤 쓴 JSON 이 남지 않는다. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, path)
  } catch {
    try { unlinkSync(tmp) } catch { /* 임시 파일이 없었을 수도 있다 */ }
    throw new Error('crash write failed')
  }
}

/** `first_seen` 이 유효한 날짜면 그 값, 아니면 레코드 시각 — 둘 다 만료 판정을 탄다. */
function seenAt(firstSeen: unknown, rec: CrashRecord): number {
  for (const raw of [firstSeen, rec.at]) {
    if (typeof raw !== 'string' || !AT_RE.test(raw)) continue
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return Number.NaN
}

/** 큐 읽기 — 손상·상한 초과·모양 위반·만료(30일) 항목은 버리고 남은 것만 돌려준다. */
export function readQueue(userData: string, now: Date = new Date()): QueueItem[] {
  const raw = readJson(crashPaths(userData).queue, MAX_QUEUE_BYTES)
  const items = field(raw, 'items')
  if (!Array.isArray(items)) return []
  const out: QueueItem[] = []
  for (const item of items) {
    const rec = reviveRecord(field(item, 'rec'), now)
    if (!rec) continue
    const attempt = Number(field(item, 'attempt'))
    const firstSeen = field(item, 'first_seen')
    const at = seenAt(firstSeen, rec)
    // 만료 판정이 불가능한 값은 버린다 — 시계가 못 믿을 값이면 30일 계약도 못 지킨다.
    if (!Number.isFinite(at) || now.getTime() - at > MAX_AGE_MS) continue
    const next: QueueItem = {
      rec,
      attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
      first_seen: typeof firstSeen === 'string' && AT_RE.test(firstSeen) ? firstSeen : rec.at
    }
    if (itemBytes(next) > MAX_ITEM_BYTES) continue
    out.push(next)
    if (out.length === MAX_QUEUE_ITEMS) break
  }
  return out
}

export function writeQueue(userData: string, items: readonly QueueItem[]): void {
  const { dir, queue } = crashPaths(userData)
  try { mkdirSync(dir, { recursive: true }) } catch { throw new Error('crash mkdir failed') }
  writeJson(queue, { schema: 1, items })
}

/** 큐 비우기 — `off` 로 답한 즉시, 그리고 전송이 끝난 항목마다. */
export function clearQueue(userData: string): void {
  writeQueue(userData, [])
}

export function readState(userData: string, now: Date = new Date()): CrashState {
  const raw = readJson(crashPaths(userData).state, MAX_QUEUE_BYTES)
  const sent = Number(field(raw, 'sent'))
  const keys = field(raw, 'keys')
  const stored: CrashState = {
    schema: 1,
    day: typeof field(raw, 'day') === 'string' ? field(raw, 'day') as string : '',
    sent: Number.isInteger(sent) && sent >= 0 ? sent : 0,
    keys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string').slice(-MAX_KEYS) : []
  }
  return rollState(stored, now)
}

export function writeState(userData: string, state: CrashState): void {
  const { dir } = crashPaths(userData)
  try { mkdirSync(dir, { recursive: true }) } catch { throw new Error('crash mkdir failed') }
  writeJson(crashPaths(userData).state, state)
}

/**
 * 오류 1건을 큐에 넣는다(§2-4 흐름). dedupe 키는 **여기서** 기록하고, 큐는 3건에서 멈춘다.
 * 같은 키가 이미 오늘 나갔거나 큐에 있으면 아무것도 쓰지 않는다.
 */
export function enqueue(userData: string, rec: CrashRecord, now: Date): void {
  const key = dedupeKey(rec)
  const state = readState(userData, now)
  if (state.keys.includes(key)) return
  const items = readQueue(userData, now)
  if (items.some((item) => dedupeKey(item.rec) === key)) return
  const next: QueueItem = { rec, attempt: 0, first_seen: rec.at }
  if (itemBytes(next) > MAX_ITEM_BYTES) {
    logQuietly('[crash] dropped: item too large')
    return
  }
  if (items.length >= MAX_QUEUE_ITEMS) return
  writeQueue(userData, [...items, next])
  writeState(userData, { ...state, keys: [...state.keys, key].slice(-MAX_KEYS) })
}
