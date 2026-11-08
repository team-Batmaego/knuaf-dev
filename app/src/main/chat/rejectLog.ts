import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 정본 거절 기록 — 도우미가 실행한 셸 명령의 출력에서 `gg.py apply` 류의 거절 결과를 찾아
 * 한 줄(JSONL)씩 남긴다. 윈도우 시험주행 W-08: 첫 장 등록이 형식 검증으로 거절됐다가 재시도로
 * 등록됐는데, **왜** 거절됐는지 원문이 어디에도 남지 않아 원인을 볼 수 없었다.
 *
 * 남기는 것은 사유·코드·필드 이름 수준이다. 스킬은 공개 경계(`_diag_safe`)에서 원문 텍스트를
 * 이미 버리고 `code`/`field`/`missing`/`index`/`path` 만 내보내므로, 여기서도 그 키만 통과시킨다.
 * 학생 원고 본문·명령 출력 전문은 저장하지 않는다.
 */

/** 스킬이 공개 경계에서 허용하는 진단 키 — 그 밖의 값은 원문일 수 있으므로 버린다. */
const DIAG_KEYS = ['code', 'field', 'missing', 'index', 'path'] as const
/** 로그 한 파일의 상한. 넘으면 `.1` 로 한 번만 물러난다(무한 증가 금지). */
const MAX_LOG_BYTES = 1024 * 1024
/** 출력 전체를 훑지 않는다 — 명령 하나가 수십 MB 를 뱉어도 CPU 를 잡지 않게. */
const MAX_SCAN_CHARS = 200_000
/** JSON 파싱에 쓰는 조각 길이 합계 상한 — 겹친 중첩 폭주 출력에서도 선형 비용을 지킨다. */
const MAX_PARSE_CHARS = 2_000_000

export interface RejectionRecord {
  at: string
  provider: string
  /** 실행된 명령줄(잘라서). 본문이 아니라 "무엇을 하다 거절됐는가"의 단서다. */
  command: string
  exitCode: number | null
  operation?: string
  target?: string
  commit_state?: string
  reason: string
  request_id?: string
  revision?: number
  /** `_diag_safe` 결과 — code/field/missing/index/path 만. */
  detail?: Record<string, unknown>
}

export interface RejectionInput {
  provider: string
  command: unknown
  output: unknown
  exitCode: unknown
  at?: string
}

/** 로그 한 줄의 모든 문자열 필드가 같은 규칙으로 잘리도록 한 곳에 둔다. */
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max)}…`

/**
 * 텍스트에 섞인 JSON 객체를 모두 찾는다. 출력에는 셸 에코·경고·진행 문구가 섞여 있으므로
 * 중괄호 짝을 세어 균형이 맞는 조각만 JSON 으로 읽는다. **한 번만 훑는다** — `{` 마다 끝까지
 * 다시 보는 이차 비용이 없어 수 MB 출력에도 선형이다. 파싱은 조각 길이 합계로 상한을 두어
 * 겹겹이 중첩된 폭주 출력에서도 CPU 를 잡지 않는다.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const begin = text.length > MAX_SCAN_CHARS ? text.length - MAX_SCAN_CHARS : 0
  const stack: number[] = []
  let quoted = false
  let escaped = false
  let budget = MAX_PARSE_CHARS
  for (let i = begin; i < text.length && budget > 0; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '\n') quoted = false   // JSON 문자열에는 실제 줄바꿈이 올 수 없다 — 짝 잃은 따옴표가 뒤를 삼키지 않게
    // 200 겹을 넘는 중첩은 결과 객체가 아니다 — 쌓아 두지 않고 새로 센다(뒤의 진짜 결과를 놓치지 않게).
    else if (c === '{') { if (stack.length >= 200) stack.length = 0; stack.push(i) }
    else if (c === '}' && stack.length) {
      const start = stack.pop() as number
      budget -= i - start + 1
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1))
        if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>)
      } catch { /* 이 조각은 JSON 이 아니다 — 다른 조각을 계속 본다 */ }
    }
  }
  return out
}

/**
 * `gg.py` 의 공개 결과인가. 정상 OperationError 결과는 `operation`·`target`·`commit_state` 를
 * 모두 들고 오고(그 셋이 gg 코어 결과의 서명이다), 스킬을 부르지 않은 명령의 출력에 우연히
 * 같은 모양이 나올 일은 없다. `blocked` 봉투(exit 2)는 모양이 흔하므로 **gg.py 를 부른 명령**일
 * 때만 인정한다 — 남의 CLI 가 같은 문구를 찍어 로그를 채우지 않게.
 *
 * 커밋된 결과(`committed`·`committed_cleanup_pending`)는 거절이 아니다 — 거절 사유 기록이
 * 목적이므로 여기서 뺀다(청소만 남은 성공을 실패로 오해하지 않게).
 */
function rejectionOf(output: string, callsGg: boolean): Record<string, unknown> | undefined {
  const results = jsonObjects(output).filter((value) =>
    (typeof value.commit_state === 'string' && typeof value.operation === 'string' && typeof value.target === 'string' &&
      !String(value.commit_state).startsWith('committed')) ||
    (callsGg && value.status === 'blocked' && typeof value.reason === 'string'))
  return results[results.length - 1]
}

/** 진단 객체에서 허용 키만 남긴다. 문자열 `detail`(원문일 수 있음)은 버린다. */
function diagOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const key of DIAG_KEYS) {
    const v = source[key]
    if (key === 'index') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) safe.index = v
    } else if (key === 'missing') {
      if (Array.isArray(v)) {
        const names = v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 50)
        if (names.length) safe.missing = names
      }
    } else if (typeof v === 'string' && v !== '') {
      safe[key] = clip(v, 200)
    }
  }
  return Object.keys(safe).length ? safe : undefined
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? clip(value, max) : undefined
}

/**
 * 명령 결과에서 거절 기록을 만든다. 거절이 아니면 `null`.
 *
 * 종료코드 0 은 성공이므로 기록하지 않는다. 그 밖에는 출력에 `gg.py` 의 거절 결과 객체가
 * 있어야 한다 — 그 객체가 곧 판정 근거이고, 명령 이름은 `blocked` 봉투를 가릴 때만 쓴다.
 */
export function applyRejection(input: RejectionInput): RejectionRecord | null {
  const command = typeof input.command === 'string' ? input.command : ''
  const output = typeof input.output === 'string' ? input.output : ''
  const exitCode = typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null
  if (exitCode === 0) return null
  const callsGg = /(^|[\s/\\"'])gg\.py\b/.test(command)
  const found = rejectionOf(output, callsGg)
  if (!found) return null
  const record: RejectionRecord = {
    at: input.at ?? new Date().toISOString(),
    provider: input.provider,
    command: clip(command, 300),
    exitCode,
    reason: text(found.reason, 200) ?? 'unknown'
  }
  const operation = text(found.operation, 60)
  const target = text(found.target, 60)
  const commitState = text(found.commit_state, 60)
  const requestId = text(found.request_id, 200)
  const revision = typeof found.revision === 'number' && Number.isInteger(found.revision) ? found.revision : undefined
  const detail = diagOf(found.detail)
  if (operation) record.operation = operation
  if (target) record.target = target
  if (commitState) record.commit_state = commitState
  if (requestId) record.request_id = requestId
  if (revision !== undefined) record.revision = revision
  if (detail) record.detail = detail
  return record
}

/**
 * 한 줄 덧붙인다. **던지지 않는다** — 진단 로그를 못 썼다고 도우미의 턴이 실패하면 안 된다.
 * 상한을 넘은 파일은 `.1` 로 한 번 물러나고 새 파일에 이어 쓴다.
 */
export function recordRejection(file: string, record: RejectionRecord): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch { /* 아직 없다 — 그대로 새로 쓴다 */ }
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8')
    return true
  } catch {
    return false
  }
}
