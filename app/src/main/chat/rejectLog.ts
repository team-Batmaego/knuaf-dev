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
 *
 * 2회째 검토(차단 2·중요 1) 뒤로는 **모양이 맞는 개인정보**도 통과하지 못한다 — 경로는 파일명
 * 원문 대신 폴더 종류·확장자만 남기고, 요청 ID 는 앱이 만드는 UUID 만 인정한다. 출처 확인은
 * 문자열 포함이 아니라 셸 낱말 해석으로 한다(`env`·`sudo`·`sh -c` 앞머리를 벗긴 **프로그램**
 * 이 `gg.py` 이고 다음 낱말이 `apply` 일 때만 실행으로 센다).
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
/** 옵션 이름만 뽑는다 — 값(`=` 뒤·공백 뒤)은 낱말 경계에서 잘린다. */
const OPTION_NAME = /(?:^|\s)(--[a-z][a-z0-9-]{0,39})(?=\s|=|$)/g
/** 기계 코드·사유 — 소문자·숫자·밑줄만. 그 밖의 글자(한글·공백·경로)는 원문일 수 있다. */
const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/
/** 필드 이름 — 같은 모양. `_diag_safe` 가 내보내는 `_DIAG_FIELDS` 가 전부 여기 들어간다. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/
/** 요청 ID — 앱이 만드는 값은 `crypto.randomUUID()` 의 RFC 4122 UUID 뿐이다(차단 2). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** 시각 — ISO 8601(ms·Z). 그 밖의 값은 지금 시각으로 채운다. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/**
 * 논문 폴더 안의 상대경로 — 절대경로·드라이브·UNC·백슬래시·`..` 는 통과하지 못하고 400자까지.
 * 통과한 경로에서도 **폴더 종류와 확장자만** 남긴다(아래 `pathType`).
 */
const RELATIVE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!^[A-Za-z]:)[^\u0000-\u001f]{1,400}$/
/**
 * 진단 경로의 첫 폴더로 인정하는 **프로젝트 폴더 종류** — `gg_core.COLLECTIONS` 와 스킬이 쓰는
 * 작업 폴더 이름만. 목록 밖 첫 낱말은 학생이 지은 폴더 이름일 수 있으므로 쓰지 않는다.
 */
const PATH_FOLDERS: Record<string, true> = {
  sections: true, sources: true, outputs: true, receipts: true, facts: true,
  migration: true, references: true, build: true, staging: true, inputs: true, companions: true
}
/** 경로 끝에 남기는 확장자 — 목록 밖 확장자는 `.other`. */
const PATH_EXTENSIONS: Record<string, true> = {
  '.md': true, '.json': true, '.xlsx': true, '.pdf': true, '.csv': true
}
/** 형식이 안 맞는 값을 원문 대신 남기는 고정 표시. */
const REDACTED = '<redacted>'
/**
 * `gg.py` 가 `blocked` 봉투로 내보내는 **고정 사유** — `gg.py` 의 정적 `ValueError` 문자열 전부
 * (AST 추출, 2026-11-09). 자유 문자열 사유는 형식 검증을 통과할 수 없으므로 여기 없으면 버린다.
 * 보간된 사유(`'%s 경로 필요' % label`)는 경로가 섞일 수 있어 넣지 않는다.
 */
const BLOCKED_REASONS: Record<string, true> = {
  '--change와 --expected-revision 필요': true,
  '--crop과 --region 필요': true,
  '--expected-revision 필요': true,
  '--external-root 필요 (byte_source.kind=scanned_external)': true,
  '--field 필요': true,
  '--input 관측 JSON과 --observer 필요': true,
  '--input 논문 입력 JSON 필요': true,
  '--input 제안 JSON과 --expected-revision 필요': true,
  '--input 제안 입력 JSON 필요': true,
  '--input 채택 JSON과 --expected-revision 필요': true,
  '--key-catalog 경로 필요': true,
  '--kind는 draft·review·submission_candidate 중 하나': true,
  '--major와 정본의 전공 바인딩이 다름': true,
  '--out 새 폴더 필요': true,
  '--packs-dir is not a source-scan operand': true,
  '--pdf R0와 --xlsx R1 원본 경로 필요': true,
  '--policy 경로 필요': true,
  '--registry 경로 필요': true,
  '--request-id 필요': true,
  '--requested-use JSON 필요': true,
  '--root 외부 루트 필요': true,
  '--scope 절 ID 필요': true,
  '--selection JSON 필요': true,
  '--source 출처 ID 필요': true,
  '--source-hash 필요': true,
  '--xlsx 재계산 완료 통합문서 경로 필요': true,
  'companion_files는 목록이어야 함': true,
  insect_input_invalid_or_unreadable: true,
  insect_internal_error: true,
  insect_project_unreadable: true,
  '관측 기록은 객체여야 함': true,
  '채택 JSON은 {output, companion_files?} 형식이어야 함': true
}
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
 * `gg.py` 의 **호출 거절** 봉투인가 — `{"status":"blocked","reason":<고정 사유>}` (exit 2).
 * 예: `gg.py apply .` 에 `--change` 가 없을 때. 사유가 `gg.py` 의 정적 `ValueError` 문자열
 * 목록에 **정확히** 있을 때만 인정한다 — 자유 문자열·보간 사유는 경로나 원고를 실을 수 있다.
 */
function blockedOf(output: string): Record<string, unknown> | undefined {
  const results = jsonObjects(output).filter((value) =>
    value.status === 'blocked' &&
    typeof value.reason === 'string' &&
    BLOCKED_REASONS[value.reason])
  return results[results.length - 1]
}

/** 셸 낱말 하나에서 경로를 떼고 프로그램 이름만 — `/`·`\` 둘 다 본다. */
function baseName(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  return cut >= 0 ? token.slice(cut + 1) : token
}

/** `sh -c '…'` 의 셸 이름 — 페이로드를 벗겨 그 안의 프로그램을 본다. */
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true }

/**
 * 셸 앞머리에 붙는 실행기 — 뒤에 오는 **프로그램**이 무엇인지 정한다. `flags` 는 값을 하나 더
 * 먹는 옵션, `operands` 는 프로그램 앞에 오는 위치 인자 수(예: `timeout 30`), `assignments` 는
 * `env LANG=C` 처럼 변수 대입을 먼저 먹는지다.
 */
const WRAPPERS: Record<string, { flags?: Record<string, true>; operands?: number; assignments?: boolean }> = {
  env: { flags: { '-u': true, '-C': true, '--unset': true, '--chdir': true, '-S': true }, assignments: true },
  sudo: { flags: { '-u': true, '-g': true, '-p': true, '-C': true, '-D': true, '-R': true, '-T': true } },
  command: {},
  nohup: {},
  time: { flags: { '-o': true, '-f': true } },
  exec: { flags: { '-a': true } },
  xargs: { flags: { '-I': true, '-n': true, '-P': true, '-L': true, '-s': true, '-d': true, '-E': true, '-a': true } },
  timeout: { flags: { '-s': true, '-k': true, '--signal': true, '--kill-after': true }, operands: 1 },
  stdbuf: { flags: { '-i': true, '-o': true, '-e': true } },
  nice: { flags: { '-n': true, '--adjustment': true } }
}

/**
 * 셸 명령을 **인용을 지킨 토막**으로 나눈다. 토막 경계는 인용 밖의 `;`·`&`·`|`·줄바꿈·괄호이고,
 * 인용 안의 같은 글자는 값의 일부다(`sh -c 'a; b'` 는 한 토막). `#` 뒤는 주석으로 버린다 —
 * 주석에 적힌 `gg.py apply` 를 실행으로 세지 않게.
 */
function splitSegments(command: string): { raw: string; tokens: string[] }[] {
  const out: { raw: string; tokens: string[] }[] = []
  let tokens: string[] = []
  let token = ''
  let started = false
  let begin = 0
  let quote: '"' | "'" | undefined
  const flushToken = (): void => {
    if (started) { tokens.push(token); token = ''; started = false }
  }
  const flushSegment = (end: number): void => {
    flushToken()
    if (tokens.length) out.push({ raw: command.slice(begin, end), tokens })
    tokens = []
    begin = end + 1
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) token += command[++i]
      else token += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue }
    if (c === '\\') {
      if (i + 1 < command.length) {
        const next = command[i + 1]
        if (next === '\n') { i++; continue } // 줄 이음
        token += next; started = true; i++; continue
      }
      token += c; started = true; continue
    }
    if (c === '#' && !started) {
      const lineEnd = command.indexOf('\n', i)
      if (lineEnd < 0) break
      i = lineEnd - 1
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      flushSegment(i)
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { flushToken(); continue }
    token += c; started = true
  }
  flushToken()
  if (tokens.length) out.push({ raw: command.slice(begin), tokens })
  return out
}

/**
 * 토막에서 **실제로 실행되는 프로그램**의 낱말 위치를 찾는다. 앞머리 실행기(`env`·`sudo`·`time`…)와
 * 변수 대입, `sh -c '…'` 페이로드를 벗긴 뒤 첫 낱말이 프로그램이다. 해석할 수 없으면 `undefined`
 * — 모르는 모양은 실행으로 세지 않는다(놓치는 쪽이 새는 쪽보다 낫다).
 */
function resolveProgram(tokens: string[], depth = 0): string[] | undefined {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i++; continue }
    if (token === '!') { i++; continue }
    const name = baseName(token)
    if (SHELLS[name]) {
      // `-c`(또는 `-lc` 처럼 c 가 든 묶음)만 페이로드를 준다 — 스크립트 파일·대화형 셸은 알 수 없다.
      const at = tokens.findIndex((x, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(x))
      if (at < 0) return undefined
      const payload = tokens[at + 1]
      if (payload === undefined || depth >= 3) return undefined
      const inner = splitSegments(payload)[0]
      return inner ? resolveProgram(inner.tokens, depth + 1) : undefined
    }
    if (name === 'python' || /^python[0-9.]+$/.test(name) || name === 'py') {
      // `-c`(코드 문자열)·`-m`(모듈)은 실행 파일이 보이지 않는다.
      if (tokens.slice(i + 1).some((x) => /^-[A-Za-z]*[cm][A-Za-z]*$/.test(x))) return undefined
      let j = i + 1
      while (j < tokens.length && tokens[j].startsWith('-')) {
        j += /^-([XWQ])$/.test(tokens[j]) ? 2 : 1
      }
      if (j >= tokens.length || baseName(tokens[j]) !== 'gg.py') return undefined
      return tokens.slice(j)
    }
    if (name === 'node' || name === 'bun' || name === 'deno') return undefined // `-e` 코드 문자열
    const wrapper = WRAPPERS[name]
    if (wrapper) {
      // `command -v` 는 실행이 아니라 위치 조회다.
      if (name === 'command' && tokens.slice(i + 1).some((x) => x === '-v' || x === '-V')) return undefined
      i++
      while (i < tokens.length) {
        const next = tokens[i]
        if (wrapper.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) { i++; continue }
        if (next === '--') { i++; break }
        if (next.startsWith('-') && next !== '-') {
          i += wrapper.flags?.[next] ? 2 : 1
          continue
        }
        break
      }
      if (wrapper.operands) i += wrapper.operands
      continue
    }
    return tokens.slice(i)
  }
  return undefined
}

/**
 * 이 명령이 `gg.py apply` 를 실제로 실행했는가. 인용을 지켜 토막을 낸 뒤, **프로그램 낱말**이
 * `gg.py` 이고 바로 다음이 `apply` 인 토막만 실행으로 센다. `env LANG=C grep 'gg.py apply' past.log`
 * 처럼 글자로만 언급하는 명령은 프로그램이 `grep` 이므로 걸리지 않는다(검토 R3 2회째 중요 1).
 */
function ggApplySegment(command: string): string | undefined {
  for (const segment of splitSegments(command)) {
    const program = resolveProgram(segment.tokens)
    if (!program || baseName(program[0]) !== 'gg.py' || program[1] !== 'apply') continue
    // `--help`/`-h` 는 실행이 아니라 사용법 출력이다.
    if (program.slice(2).some((token) => token === '--help' || token === '-h')) continue
    return segment.raw
  }
  return undefined
}

/** 요청 ID — 앱이 만든 RFC 4122 UUID 만 통과한다. 그 밖의 값은 필드 자체를 뺀다(차단 2). */
function requestIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined
}

/** 형식이 맞는 문자열만 남기고, 있지만 형식이 틀린 값은 고정 표시로 바꾼다. */
function checked(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return pattern.test(value) ? value : REDACTED
}

/**
 * 진단 경로를 **비식별 요약**으로 바꾼다. 상대경로 모양을 통과한 값에서도 파일 이름·중간 폴더는
 * 학생 개인정보일 수 있으므로(검토 R3 2회째 차단 2), 아는 폴더 종류이면 그 이름과 확장자만 남기고
 * 나머지는 `…` 로 지운다 — `sections/홍길동_900101-1234567.md` → `sections/….md`.
 * 모양이 틀린 값은 `<redacted>`, 모르는 확장자는 `.other`.
 */
function pathType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (!RELATIVE_PATH.test(value)) return REDACTED
  const parts = value.split('/')
  const name = parts[parts.length - 1]
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  const folder = parts.length > 1 ? parts[0].toLowerCase() : ''
  return `${PATH_FOLDERS[folder] ? folder : 'other'}/…${PATH_EXTENSIONS[ext] ? ext : '.other'}`
}

/**
 * 진단 객체에서 허용 키만, **값도 형식 검증을 통과한 것만** 남긴다. 키 화이트리스트는 값의
 * 안전을 보장하지 않으므로(검토 R3 차단 2) `code`·`field`·`missing` 은 기계 코드 모양,
 * `path` 는 상대경로 모양을 통과한 뒤 폴더 종류·확장자만 남긴다. 문자열 `detail`(원문일 수
 * 있음)은 버린다.
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
    const path = pathType(source.path)
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
 * 판정은 둘을 함께 본다: ①명령이 `gg.py apply` 를 **실제로** 불렀다(출처) ②출력에 거절 결과가
 * 있다. 거절 결과는 둘 중 하나다 — apply·canonical·not_committed 서명의 결과, 또는 `gg.py` 의
 * 고정 사유를 가진 `blocked` 봉투(호출 인자 누락 등). 셸의 최종 종료코드는 증거로 쓰지 않는다 —
 * `gg.py apply ... || true` 는 거절 뒤에도 0 으로 끝나고, 반대로 등록에 성공한 뒤 다른 명령이
 * 실패해 0 이 아닌 코드를 남길 수 있다(중요 3).
 */
export function applyRejection(input: RejectionInput): RejectionRecord | null {
  const command = typeof input.command === 'string' ? input.command : ''
  const output = typeof input.output === 'string' ? input.output : ''
  const exitCode = typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null
  if (!ggApplySegment(command)) return null
  const found = rejectionOf(output)
  const blocked = found ? undefined : blockedOf(output)
  if (!found && !blocked) return null
  const at = checked(input.at, ISO_TIME)
  const record: RejectionRecord = {
    at: at && at !== REDACTED ? at : new Date().toISOString(),
    provider: checked(input.provider, FIELD_NAME) ?? REDACTED,
    command: commandSummary(command),
    exitCode,
    reason: found ? checked(found.reason, MACHINE_CODE) ?? REDACTED : String(blocked?.reason)
  }
  if (found) {
    // `blocked` 봉투에는 이 셋이 없다 — 없는 값을 지어내지 않는다.
    record.operation = REJECT_OPERATION
    record.target = REJECT_TARGET
    record.commit_state = REJECT_STATE
    const requestId = requestIdOf(found.request_id)
    const revision = typeof found.revision === 'number' && Number.isInteger(found.revision) && found.revision >= 0
      ? found.revision : undefined
    const detail = diagOf(found.detail)
    if (requestId) record.request_id = requestId
    if (revision !== undefined) record.revision = revision
    if (detail) record.detail = detail
  }
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
