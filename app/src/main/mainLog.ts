import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { constants } from 'node:os'
import type { App, Event as ElectronEvent, RenderProcessGoneDetails, WebContents } from 'electron'
import { appendScrubbed, codeOf, logFile, setDefaultLogFile } from './diagLog'

/**
 * 출시판 파일 로그의 배선 - 설치된 앱은 콘솔이 없어서 `console.error` 55곳과 `diag()` 53곳이
 * 전부 증발했다(inv-logs/RESULT.md). G0 에서 "위임이 왜 거절됐는지"를 남은 기록으로 밝히지 못한
 * 것이 이 구멍이다. 여기서 세 갈래를 **같은 파일**로 모은다:
 *
 *  1. `diag()` - 경로 기본값을 `app.getPath('logs')/main.log` 로 정한다(환경변수는 덮어쓰기용).
 *  2. `console.error`·`console.warn` - 원래 함수는 **그대로 호출**하고 사본만 파일에 남긴다.
 *     콘솔 출력을 죽이면 개발 실행·e2e 의 기존 관측이 사라진다.
 *  3. 프로세스 예외·렌더러 크래시 - `uncaughtExceptionMonitor`(감시 전용, **동작 불변**)와
 *     `web-contents-created` 뒤의 `render-process-gone`.
 *
 * `process.on('uncaughtException')` 은 **달지 않는다**: 그 리스너가 있으면 Node 가 프로세스를
 * 종료하지 않고 넘어가 종료 코드·동작이 바뀐다. 감시만 하는 훅이 `uncaughtExceptionMonitor` 다.
 * `unhandledRejection` 도 달지 않는다 - 리스너의 유무가 기본 처리(경고 후 종료)를 바꾼다.
 *
 * **무엇을 남기는가(검토 roh-1 중요1·중요3).** 콘솔 인수를 `util.format`·`inspect`·`String` 으로
 * 문자열화하지 않는다. 문자열화하면 ① 원고 본문·공백 있는 경로·파일 이름·식별값이 그대로 파일에
 * 남고 ② 사용자 정의 직렬화가 두 번 돌아 원래 성공하던 호출이 실패할 수 있다. 대신 **검증된
 * 필드만** 고른다: 허용 필드의 숫자·불리언, 명시한 앱 열거값·단계·태그, OS 오류 코드.
 * 자유문·파일명·계정값은 모양만으로 판정하지 않는다. 알 수 없는 값은 저장하지 않는다.
 *
 * 모든 기록은 `diagLog.appendScrubbed` 한 곳을 지난다(`scrub` + 1MB 회전).
 */

export interface MainLogHandle {
  /** 지금 기록되는 파일(절대 경로). 진단이 꺼졌으면 빈 문자열. */
  readonly file: string
  /** 감시 중인 WebContents 수. 파괴(`destroyed`)·`dispose()` 에서 줄어야 한다(참조 누수 감시). */
  readonly renderers: number
  /** 건 콘솔 패치·리스너를 되돌린다. 프로세스 수명 동안 유지하는 것이 정상이지만, 시험이 누수를 본다. */
  dispose(): void
}

/** `console` 메서드의 최소 모양 - 원래 구현을 그대로 부르기만 한다. */
type ConsoleMethod = (...args: unknown[]) => void

/**
 * 값까지 보는 필드 화이트리스트 - 이름이 없으면 값이 기계 토큰 모양이어도 **버린다**.
 * 넣지 않는 것: `root`·`path`·`file`·`name`·`id`·`rootJobId`·`jobId`·`session`·`account`·
 * `token`·`message`·`existingRoot` 등 경로·식별값·자유문이 들어오는 자리(검토 roh-1 재현 1~3).
 *
 * 소문자 식별값도 기계 값처럼 보인다. 열거값·태그·단계는 명시한 앱 어휘만 받는다.
 * `error` 는 자유문 대신 OS 오류 코드·표준 Error 이름만 받는다.
 */
type FieldKind = 'enum' | 'code' | 'number' | 'bool'

const SAFE_FIELDS: Record<string, FieldKind> = {
  type: 'enum',
  kind: 'enum',
  stage: 'enum',
  phase: 'enum',
  step: 'enum',
  state: 'enum',
  status: 'enum',
  outcome: 'enum',
  result: 'enum',
  reason: 'enum',
  provider: 'enum',
  lane: 'enum',
  action: 'enum',
  mode: 'enum',
  code: 'code',
  error: 'code',
  count: 'number',
  n: 'number',
  total: 'number',
  pending: 'number',
  ms: 'number',
  elapsedMs: 'number',
  deadlineMs: 'number',
  pid: 'number',
  port: 'number',
  attempt: 'number',
  retry: 'number',
  size: 'number',
  index: 'number',
  exit: 'number',
  ok: 'bool'
}

/** 알려진 앱 어휘만 저장한다. 새 이벤트의 진단 값은 이 목록에도 등록한다. */
const ENUM_VALUE = /^(?:collect|collect-disabled|collect-skip|store|delivery-reconcile|deliver-drive|thesis-baseline|job-result|actual-model|stop-pending|student-continue-after-limit|conversation-continue-after-limit|lanes-ipc|lanes-snapshot|no-declaration|duplicate-id|no-plan|limit|rejected|queued|running|completed|stopped|interrupted|violation|error|allowed|invalid|superseded|base-version|not-found|already-handled|done|pending|review-main|malformed|cross-provider|not-subscribed|model-unverified|model-not-listed|effort-not-supported|claude-api-key|codex-not-chatgpt|claude|codex|free|main|research|writing|review|crashed|oom|killed|launch-failed|integrity-failure|abnormal-exit|clean-exit)$/

/** 標準 오류 이름과 감시 origin. OS 오류 코드는 constants.errno 에서 별도로 판정한다. */
const CODE_VALUE = /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|TimeoutError|AbortError|unknown|string|uncaughtException|unhandledRejection)$/
const TAG_WORD = /^(?:\[knuaf\]|\[shutdown\]|\[transport\]|\[sidecar\])$/
const LABEL_WORD = /^(?:safeWrite:fail|safeWrite:retry|sidecar:warn|boot-check:fail|update:failed)$/

/** 글에서 온 숫자 값(`pid=1234`) - 정수·소수만. */
const NUMBER_TEXT = /^\d{1,12}(?:\.\d{1,6})?$/

/** 글에서 온 불리언 값(`failed=true`). */
const BOOL_TEXT = /^(?:true|false)$/

/** 한 줄에 남길 필드 수 상한. 넘으면 버린다 - 긴 JSON 이 줄을 다 먹지 않게. */
const MAX_FIELDS = 12

/** `JSON.parse` 를 시도하는 문자열 상한. 넘으면 파싱하지 않고 토큰 훑기로 내려간다(비용 상한). */
const MAX_JSON_CHARS = 4096

/** 문자열 하나에서 훑는 글자 수 상한. */
const MAX_SCAN_CHARS = 1024

/** 값이 필드 종류에 맞을 때만 문자열로 돌려준다. 맞지 않으면 빈 문자열(버린다). */
function machineValue(kind: FieldKind, value: unknown): string {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    case 'bool':
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : ''
    case 'enum':
      return typeof value === 'string' && ENUM_VALUE.test(value) ? value : ''
    case 'code':
      return typeof value === 'string' && (CODE_VALUE.test(value) || Object.hasOwn(constants.errno, value)) ? value : ''
  }
}

/** 낱말 양끝의 인용·괄호·마침표를 벗긴다(`(...)`, `code=EPERM,`). `[knuaf]` 는 벗기기 전에 판정한다. */
function stripWrapping(token: string): string {
  return token.replace(/^[("'`]+/, '').replace(/[)"'`,.;]+$/, '')
}

/**
 * JSON 객체 문자열이면 **허용 필드만** 뽑는다. 객체가 아니거나 파싱이 안 되면 `null`
 * (호출자가 토큰 훑기로 내려간다).
 */
function fieldsFromJson(text: string): string[] | null {
  if (text.length > MAX_JSON_CHARS || text.charAt(0) !== '{') return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const out: string[] = []
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const kind = SAFE_FIELDS[key]
    if (!kind) continue
    const value = machineValue(kind, raw)
    if (value) out.push(`${key}=${value}`)
  }
  return out
}

/** 자유문 한 줄에서 기계 모양 낱말만 줍는다 - 문장·경로·파일 이름·식별값은 여기서 걸러진다. */
function fieldsFromText(text: string): string[] {
  const out: string[] = []
  for (const raw of text.slice(0, MAX_SCAN_CHARS).split(/\s+/)) {
    if (!raw) continue
    if (TAG_WORD.test(raw)) { out.push(raw); continue }
    const token = stripWrapping(raw)
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq > 0) {
      const key = token.slice(0, eq)
      const kind = SAFE_FIELDS[key]
      // 글에서 온 값은 **문자열만** 온다(`pid=1234`, `failed=true`) - 종류별로 모양을 다시 본다.
      const value = token.slice(eq + 1)
      const fits = kind === 'code' ? Boolean(machineValue('code', value))
        : kind === 'enum' ? ENUM_VALUE.test(value)
        : kind === 'number' ? NUMBER_TEXT.test(value)
        : kind === 'bool' ? BOOL_TEXT.test(value)
        : false
      if (fits) out.push(token)
      continue
    }
    if (LABEL_WORD.test(token)) out.push(token)
  }
  return out
}

/**
 * 콘솔 인수에서 **검증된 필드만** 골라 한 줄 분량의 문자열로 만든다. 내보내는 이유: 시험이
 * 경계(재현 1~3)를 파일 없이 직접 잠근다.
 *
 * 인수를 **읽기만** 한다 - `format`·`inspect`·`String`·`JSON.stringify` 를 부르지 않는다.
 * 그래서 원고 본문이 문자열화되지 않고, 사용자 정의 직렬화가 두 번 돌지 않는다(중요3).
 * `Error` 는 `code`/`name` 만 쓴다 - `message`·`stack` 에는 경로·토큰·본문이 들어올 수 있다.
 */
export function consoleFields(args: readonly unknown[]): string {
  const out: string[] = []
  const add = (values: readonly string[] | null): void => {
    if (!values) return
    for (const value of values) { if (out.length < MAX_FIELDS) out.push(value) }
  }
  for (const arg of args) {
    // 값 하나가 실패해도(던지는 getter·프록시) 나머지 줄과 원래 콘솔 호출은 그대로다.
    try {
      if (typeof arg === 'string') add(fieldsFromJson(arg) ?? fieldsFromText(arg))
      else if (arg instanceof Error) {
        const code = machineValue('code', codeOf(arg))
        if (code) add([`code=${code}`])
      }
      // 그 밖의 객체·숫자·함수는 **읽지 않는다** - 직렬화 부작용도, 값 누출도 없다.
    } catch { /* 이 인수만 건너뛴다 */ }
  }
  return out.join(' ')
}

/**
 * 로그 폴더를 정하고(없으면 만든다) `diag` 의 기본 경로를 그 안으로 옮긴 뒤 감시를 건다.
 *
 * 기동 때 한 번 부른다(`index.ts`). `app.getPath('logs')` 는 electron 기본값이
 * 맥 `~/Library/Logs/<앱 이름>`, 윈도우 `%APPDATA%\<앱 이름>\logs` 다 - `setAppLogsPath` 를
 * 부르지 않아도 된다(부르면 오히려 경로를 새로 정하는 셈이다).
 */
export function installMainLog(app: App): MainLogHandle {
  /**
   * e2e 는 `KNUAF_USER_DATA` 로 userData 를 임시 폴더에 격리한다. 로그도 같은 격리 안에 둬야
   * 병렬 샤드가 개발자의 실제 로그 폴더에서 섞이지 않고, 임시 폴더가 지워질 때 함께 사라진다.
   * 설치판·개발 실행에는 이 변수가 없으므로 electron 기본값(`app.getPath('logs')`)을 쓴다.
   *
   * 격리 경로는 `setAppLogsPath` 로 electron 에도 알린다 - '로그 폴더 열기'(ipc.ts)가
   * `app.getPath('logs')` 를 열기 때문이다. 그 호출이 실패해도 파일 위치는 아래에서 정한
   * 경로 그대로 쓴다(경로를 못 바꾸면 폴더 열기가 기본 자리를 열 수 있다 - 그 경우만 어긋난다).
   */
  const userData = (): string => {
    try { return app.getPath('userData') } catch { return '' }
  }
  const isolated = process.env.KNUAF_USER_DATA ? join(userData() || '.', 'logs') : ''
  let dir = isolated
  if (isolated) {
    try { app.setAppLogsPath(isolated) } catch {
      // 아주 이른 실패를 대비한 두 번째 통로 - setPath 는 폴더가 이미 있어야 한다.
      try { mkdirSync(isolated, { recursive: true }); app.setPath('logs', isolated) } catch { /* 파일 위치는 isolated 그대로 */ }
    }
  } else {
    try { dir = app.getPath('logs') } catch { dir = userData() ? join(userData(), 'logs') : '' }
  }
  if (dir) {
    // '로그 폴더 열기'(ipc.ts)가 만들던 폴더를 이제 기동이 만든다 - 열었을 때 비어 있지 않게.
    try { mkdirSync(dir, { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
    setDefaultLogFile(join(dir, 'main.log'))
  }

  // 원래 함수를 기억해 둔다 - 패치가 겹쳐도(중복 설치) 원본을 부르고, dispose 가 정확히 되돌린다.
  const before: Record<'error' | 'warn', ConsoleMethod> = { error: console.error, warn: console.warn }
  const patch = (tag: string, original: ConsoleMethod): ConsoleMethod =>
    (...args: unknown[]): void => {
      // 사본 조립·쓰기가 실패해도 원래 호출은 **한 번** 그대로 간다(중요3).
      try {
        const target = logFile()
        if (target) {
          const fields = consoleFields(args)
          appendScrubbed(target, `${Date.now()} [${tag}]${fields ? ` ${fields}` : ''}`)
        }
      } catch { /* 로그 사본이 원래 호출을 막지 않는다 */ }
      original.apply(console, args)
    }
  const patched = { error: patch('console.error', before.error), warn: patch('console.warn', before.warn) }
  console.error = patched.error
  console.warn = patched.warn

  /**
   * 감시 전용 훅. `origin` 은 `uncaughtException`·`unhandledRejection` 이고, 오류는 **이름·코드만**
   * 남긴다 - `message`·`stack` 에는 경로·토큰·원고 본문이 들어올 수 있다.
   *
   * 훅 **전체**가 예외 경계 안에 있다: 여기서 던지면 Node 가 원래 오류 대신 이 오류를 찍고
   * 종료 코드를 바꾼다(검토 roh-1 중요2, 자식 프로세스 실측 exit 1 → 7).
   */
  const onUncaught = (error: unknown, origin: unknown): void => {
    try {
      const target = logFile()
      if (!target) return
      const where = machineValue('code', origin) || 'unknown'
      const code = machineValue('code', codeOf(error)) || 'unknown'
      appendScrubbed(target, `${Date.now()} [uncaught] origin=${where} code=${code}`)
    } catch { /* 감시 훅은 원래 오류·종료 코드를 바꾸지 않는다 */ }
  }
  // 진단이 꺼져 있으면(경로를 못 얻음) 리스너를 달지 않는다 - 쓸 곳이 없는데 전역 상태만 늘린다.
  if (logFile()) process.on('uncaughtExceptionMonitor', onUncaught)

  /**
   * 렌더러가 죽은 이유. `clean-exit` 은 그냥 창이 닫힌 것이라 남기지 않는다.
   *
   * 파괴된 창을 Map 이 계속 붙들면 창을 반복해서 만드는 경로(figures/reencode-window.ts)에서
   * 참조가 쌓인다 - `destroyed` 에서 스스로 지운다(검토 roh-1 권고4). 리스너도 함께 뗀다.
   */
  const goneListeners = new Map<WebContents, () => void>()
  const onGone = (_e: ElectronEvent, details: RenderProcessGoneDetails): void => {
    try {
      const reason = machineValue('enum', details?.reason)
      if (!reason || reason === 'clean-exit') return
      const target = logFile()
      if (!target) return
      const exit = Number.isFinite(details.exitCode) ? String(details.exitCode) : '-'
      appendScrubbed(target, `${Date.now()} [renderer-gone] reason=${reason} exit=${exit}`)
    } catch { /* 크래시 기록이 앱을 깨지 않는다 */ }
  }
  const onWebContentsCreated = (_event: ElectronEvent, contents: WebContents): void => {
    const listener = onGone as (event: ElectronEvent, details: RenderProcessGoneDetails) => void
    const cleanup = (): void => {
      goneListeners.delete(contents)
      try { contents.removeListener('render-process-gone', listener) } catch { /* 이미 파괴됨 */ }
    }
    goneListeners.set(contents, cleanup)
    try {
      contents.on('render-process-gone', listener)
      contents.once('destroyed', cleanup)
    } catch { /* 이미 파괴된 contents - 감시하지 않는다 */ }
  }
  if (logFile()) app.on('web-contents-created', onWebContentsCreated)

  return {
    get file() { return logFile() },
    get renderers() { return goneListeners.size },
    dispose() {
      process.removeListener('uncaughtExceptionMonitor', onUncaught)
      app.removeListener('web-contents-created', onWebContentsCreated)
      for (const cleanup of [...goneListeners.values()]) {
        try { cleanup() } catch { /* 되돌리기가 예외로 끝나면 나머지 정리가 멈춘다 */ }
      }
      goneListeners.clear()
      // 다른 코드가 그 사이 console 을 다시 감쌌다면 남의 패치를 벗기지 않는다.
      if (console.error === patched.error) console.error = before.error
      if (console.warn === patched.warn) console.warn = before.warn
    }
  }
}
