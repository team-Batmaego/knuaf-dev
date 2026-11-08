import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 정본 거절 기록 — 도우미가 실행한 셸 명령의 출력에서 `gg.py apply` 의 거절 결과를 찾아
 * 한 줄(JSONL)씩 남긴다. 윈도우 시험주행 W-08: 첫 장 등록이 형식 검증으로 거절됐다가 재시도로
 * 등록됐는데, **왜** 거절됐는지 원문이 어디에도 남지 않아 원인을 볼 수 없었다.
 *
 * 남기는 것은 **기계가 만든 고정 낱말**뿐이다. 명령줄 원문·인자 값·절대경로·원고 본문은
 * 형식 검증을 통과하지 못하면 고정 표시(`<redacted>`)로 바뀌거나 아예 빠진다.
 * 길이 제한은 개인정보 제거가 아니므로, 값마다 허용 모양을 따로 본다(검토 R3 1회째 차단 1·2).
 */

/** `gg.py` 가 받는 옵션 이름 — 값은 절대 남기지 않고 **이름만** 요약에 쓴다. */
const GG_OPTIONS: Record<string, true> = {
  '--out': true, '--change': true, '--expected-revision': true, '--scope': true, '--kind': true,
  '--field': true, '--input': true, '--body': true, '--pdf': true, '--xlsx': true,
  '--observer': true, '--name': true, '--companion': true, '--request-id': true,
  '--probe': true, '--offline-confirmed': true, '--apply': true, '--resume': true,
  '--crop': true, '--region': true, '--major': true, '--rda-kind': true, '--year': true,
  '--form': true, '--unit': true, '--use-scope': true, '--allow-web': true, '--audit-key': true,
  '--packs-dir': true, '--catalog': true, '--target-current': true, '--root': true,
  '--registry': true, '--key-catalog': true, '--policy': true, '--requested-use': true,
  '--external-root': true, '--selection': true, '--source-hash': true, '--source': true,
  '--reviewed': true
}
/** 정본 등록 거절의 유일한 서명 — 셋이 **정확히** 같을 때만 기록한다(중요 1). */
const REJECT_OPERATION = 'apply'
const REJECT_TARGET = 'canonical'
const REJECT_STATE = 'not_committed'
/** 셸 한 토막 안의 `gg.py apply` 호출. 출처가 없으면 출력 모양만으로 기록하지 않는다. */
const GG_APPLY = /\bgg\.py["']?\s+apply\b/
/** 실행이 아니라 **글자로만** gg.py 를 언급하는 토막(에코·검색·조회)의 첫 낱말. */
const ECHOING = /^\s*(?:echo|printf|cat|grep|egrep|rg|sed|awk|head|tail|jq|git|ls|strings|wc|file|diff)\b/
/** 옵션 이름만 뽑는다 — 값(`=` 뒤·공백 뒤)은 낱말 경계에서 잘린다. */
const OPTION_NAME = /(?:^|\s)(--[a-z][a-z0-9-]{0,39})(?=\s|=|$)/g
/** 기계 코드·사유 — 소문자·숫자·밑줄만. 그 밖의 글자(한글·공백·경로)는 원문일 수 있다. */
const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/
/** 필드 이름 — 같은 모양. `_diag_safe` 가 내보내는 `_DIAG_FIELDS` 가 전부 여기 들어간다. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/
/** 요청 ID — 앱이 만드는 값은 `chat:...` 모양이다. 그 밖의 자유 문자열은 가린다. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/
/** 시각 — ISO 8601(ms·Z). 그 밖의 값은 지금 시각으로 채운다. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** 논문 폴더 안의 상대경로 — 절대경로·드라이브·UNC·백슬래시·`..` 는 통과하지 못하고 400자까지. */
const RELATIVE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!^[A-Za-z]:)[^\u0000-\u001f]{1,400}$/
/** 형식이 안 맞는 값을 원문 대신 남기는 고정 표시. */
const REDACTED = '<redacted>'
/** 로그 한 파일의 상한. 넘으면 `.1` 로 한 번만 물러난다(무한 증가 금지). */
const MAX_LOG_BYTES = 1024 * 1024
/** 한 번에 훑는 출력 폭. 앞·뒤 두 창만 본다 — 명령 하나가 수십 MB 를 뱉어도 CPU 를 잡지 않게. */
const MAX_SCAN_CHARS = 200_000
/** JSON 파싱에 쓰는 창 하나의 조각 길이 합계 상한 — 겹친 중첩 폭주 출력에서도 선형 비용을 지킨다. */
const MAX_PARSE_CHARS = 2_000_000
/** 명령 요약에 남기는 옵션 이름 개수 상한 — 로그 한 줄이 커지지 않게. */
const MAX_OPTIONS = 8

export interface RejectionRecord {
  at: string
  provider: string
  /** 실행된 작업 요약 — `gg.py apply --change --expected-revision` 처럼 이름만. 인자 값은 없다. */
  command: string
  exitCode: number | null
  operation?: string
  target?: string
  commit_state?: string
  reason: string
  request_id?: string
  revision?: number
  /** `_diag_safe` 결과 — code/field/missing/index/path 만, 값도 형식 검증을 통과한 것만. */
  detail?: Record<string, unknown>
}

export interface RejectionInput {
  provider: string
  command: unknown
  output: unknown
  exitCode: unknown
  at?: string
}

/**
 * 텍스트의 한 창에서 균형 잡힌 JSON 객체를 모은다. 출력에는 셸 에코·경고·진행 문구가 섞여
 * 있으므로 중괄호 짝을 세어 맞는 조각만 JSON 으로 읽는다. **한 번만 훑는다** — `{` 마다 끝까지
 * 다시 보는 이차 비용이 없어 선형이다.
 *
 * 따옴표는 JSON 문자열 안에서만 유효하다. JSON 문자열에는 실제 줄바꿈이 올 수 없으므로,
 * 인용 중에 줄바꿈을 만나면 그 따옴표는 짝을 잃은 것이다 — 인용 상태와 그때까지 쌓인
 * 중괄호를 버리고 다음 줄부터 다시 센다. 그러지 않으면 경고 한 줄의 따옴표가 뒤따르는
 * 진짜 거절 JSON 을 통째로 삼킨다(중요 2).
 */
function scanWindow(text: string, begin: number, end: number, out: Record<string, unknown>[], budget: { left: number }): void {
  const stack: number[] = []
  let quoted = false
  let escaped = false
  for (let i = begin; i < end && budget.left > 0; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\n') { quoted = false; escaped = false; stack.length = 0 } // 짝 잃은 따옴표 — 뒤를 삼키지 않게 복구
      else if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    // 200 겹을 넘는 중첩은 결과 객체가 아니다 — 쌓아 두지 않고 새로 센다(뒤의 진짜 결과를 놓치지 않게).
    else if (c === '{') { if (stack.length >= 200) stack.length = 0; stack.push(i) }
    else if (c === '}' && stack.length) {
      const start = stack.pop() as number
      budget.left -= i - start + 1
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1))
        if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>)
      } catch { /* 이 조각은 JSON 이 아니다 — 다른 조각을 계속 본다 */ }
    }
  }
}

/**
 * 텍스트에 섞인 JSON 객체를 모두 찾는다. 출력이 길면 **앞 창과 뒤 창**을 본다 — 거절 결과 뒤에
 * 20만 자가 넘는 경고가 붙어도 앞쪽 결과를 놓치지 않고(권고 1), 끝쪽의 최신 결과도 본다.
 * 창 밖은 보지 않으므로 비용은 출력 길이에 대해 여전히 상한이 있다.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (text.length <= MAX_SCAN_CHARS * 2) {
    scanWindow(text, 0, text.length, out, { left: MAX_PARSE_CHARS })
    return out
  }
  const lineEnd = text.indexOf('\n', MAX_SCAN_CHARS)
  // 줄바꿈이 없어 창이 잘릴 자리가 없으면 상한(2×)까지 본다 — 거절 JSON 이 창 경계에 걸려 잘리지 않게.
  const headEnd = lineEnd < 0 ? Math.min(text.length, MAX_SCAN_CHARS * 2) : lineEnd + 1
  // 창마다 예산을 따로 준다 — 앞 창이 예산을 다 써도 뒤 창의 최신 결과를 놓치지 않게.
  scanWindow(text, 0, headEnd, out, { left: MAX_PARSE_CHARS })
  scanWindow(text, text.length - MAX_SCAN_CHARS, text.length, out, { left: MAX_PARSE_CHARS })
  return out
}

/**
 * 정본 등록 거절 결과인가. `operation`·`target`·`commit_state` 셋이 **정확히** apply·canonical·
 * not_committed 인 객체만 인정한다. `committed`·`committed_cleanup_pending`(성공)과
 * `indeterminate`(커밋 여부 불명 — 거절이 아님)는 서명이 달라 걸리지 않는다.
 *
 * 출력만으로는 출처를 알 수 없으므로 이 함수는 호출자가 `gg.py apply` 실행을 확인한 뒤에만 쓴다.
 * 그래도 한 명령 안에서 앞선 출력을 인용한 경우까지는 가릴 수 없다 — 남는 한계는 RESULT 에 적었다.
 */
function rejectionOf(output: string): Record<string, unknown> | undefined {
  const results = jsonObjects(output).filter((value) =>
    value.operation === REJECT_OPERATION &&
    value.target === REJECT_TARGET &&
    value.commit_state === REJECT_STATE)
  return results[results.length - 1]
}

/**
 * 이 명령이 `gg.py apply` 를 실제로 실행했는가. 셸 구분자로 토막을 낸 뒤, 글자로만 언급하는
 * 토막(`echo`·`grep`·`cat` …)은 실행으로 세지 않는다. 명령 하나를 완전히 해석하지는 않는다 —
 * 인용 안의 우연한 문자열까지 가려내는 것은 이 로그의 몫이 아니고, 그 한계는 RESULT 에 적었다.
 */
function ggApplySegment(command: string): string | undefined {
  for (const segment of command.split(/[;&|\n]+/)) {
    if (GG_APPLY.test(segment) && !ECHOING.test(segment)) return segment
  }
  return undefined
}

/** 형식이 맞는 문자열만 남기고, 있지만 형식이 틀린 값은 고정 표시로 바꾼다. */
function checked(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return pattern.test(value) ? value : REDACTED
}

/**
 * 진단 객체에서 허용 키만, **값도 형식 검증을 통과한 것만** 남긴다. 키 화이트리스트는 값의
 * 안전을 보장하지 않으므로(검토 R3 차단 2) `code`·`field`·`missing` 은 기계 코드 모양,
 * `path` 는 폴더 안 상대경로 모양일 때만 원문을 쓴다. 문자열 `detail`(원문일 수 있음)은 버린다.
 */
function diagOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const key of ['code', 'field'] as const) {
    const kept = checked(source[key], key === 'code' ? MACHINE_CODE : FIELD_NAME)
    if (kept) safe[key] = kept
  }
  if ('missing' in source) {
    const raw = source.missing
    if (Array.isArray(raw)) {
      // 자리마다 하나씩 남긴다 — 개수·순서가 진단 정보이고, 원문만 고정 표시로 바뀐다.
      const names = raw.slice(0, 50).map((item) => checked(item, FIELD_NAME) ?? REDACTED)
      if (names.length) safe.missing = names
    } else safe.missing = [REDACTED]
  }
  if ('index' in source) {
    const index = source.index
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) safe.index = index
  }
  if ('path' in source) {
    // 값은 폴더 안 상대경로만 — 절대경로·드라이브 문자·`..`·백슬래시는 원문을 쓰지 않는다.
    const path = checked(source.path, RELATIVE_PATH)
    if (path) safe.path = path
  }
  return Object.keys(safe).length ? safe : undefined
}

/**
 * 명령줄에서 **작업 이름과 옵션 이름만** 남긴다. 인자 값·인용한 셸 리터럴·경로는 옮기지
 * 않는다. 옵션 이름도 `gg.py` 가 실제로 받는 고정 목록에 있는 것만 쓴다 — 호출자가 심은
 * 낱말이 로그로 새지 않게.
 */
function commandSummary(command: string): string {
  const segment = ggApplySegment(command) ?? ''
  const start = segment.search(GG_APPLY)
  const tail = start >= 0 ? segment.slice(start) : ''
  const names: string[] = []
  for (const match of tail.matchAll(OPTION_NAME)) {
    if (GG_OPTIONS[match[1]] && !names.includes(match[1])) names.push(match[1])
    if (names.length >= MAX_OPTIONS) break
  }
  return ['gg.py apply', ...names].join(' ')
}

/**
 * 명령 결과에서 거절 기록을 만든다. 거절이 아니면 `null`.
 *
 * 판정은 둘을 함께 본다: ①명령이 `gg.py apply` 를 실제로 불렀다(출처) ②출력에 apply·canonical·
 * not_committed 서명의 결과가 있다. 셸의 최종 종료코드는 증거로 쓰지 않는다 — `gg.py apply ... || true`
 * 는 거절 뒤에도 0 으로 끝나고, 반대로 등록에 성공한 뒤 다른 명령이 실패해 0 이 아닌 코드를
 * 남길 수 있다(중요 3).
 */
export function applyRejection(input: RejectionInput): RejectionRecord | null {
  const command = typeof input.command === 'string' ? input.command : ''
  const output = typeof input.output === 'string' ? input.output : ''
  const exitCode = typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null
  if (!ggApplySegment(command)) return null
  const found = rejectionOf(output)
  if (!found) return null
  const at = checked(input.at, ISO_TIME)
  const record: RejectionRecord = {
    at: at && at !== REDACTED ? at : new Date().toISOString(),
    provider: checked(input.provider, FIELD_NAME) ?? REDACTED,
    command: commandSummary(command),
    exitCode,
    operation: REJECT_OPERATION,
    target: REJECT_TARGET,
    commit_state: REJECT_STATE,
    reason: checked(found.reason, MACHINE_CODE) ?? REDACTED
  }
  const requestId = checked(found.request_id, REQUEST_ID)
  const revision = typeof found.revision === 'number' && Number.isInteger(found.revision) && found.revision >= 0
    ? found.revision : undefined
  const detail = diagOf(found.detail)
  if (requestId) record.request_id = requestId
  if (revision !== undefined) record.revision = revision
  if (detail) record.detail = detail
  return record
}

/**
 * 한 줄 덧붙인다. **던지지 않는다** — 진단 로그를 못 썼다고 도우미의 턴이 실패하면 안 된다.
 *
 * 상한은 쓰기 직전에 `현재 크기 + 추가 바이트`로 본다. 넘으면 `.1` 로 한 번 물러나고 새 파일에
 * 쓴다. `statSync` 의 `ENOENT` 만 "아직 없다"로 읽고, 그 밖의 오류나 회전 실패는 기록을
 * 건너뛰고 `false` 를 돌려준다 — 회전이 실패하는 동안 파일이 무한히 커지지 않게(중요 4).
 */
export function recordRejection(file: string, record: RejectionRecord): boolean {
  try {
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line, 'utf-8')
    if (bytes > MAX_LOG_BYTES) return false
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    if (size + bytes > MAX_LOG_BYTES) {
      try {
        // 이전 세대를 지워 자리를 비운다 — 남겨 두면 윈도우에서 두 번째 회전부터 계속 실패해
        // 기록이 영영 멈춘다. 지우지 못하면(디렉터리·잠금) 쓰지 않고 물러난다.
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      } catch {
        return false
      }
    }
    appendFileSync(file, line, 'utf-8')
    return true
  } catch {
    return false
  }
}
