import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
/**
 * 진단용 **파일** 로그 - 줄마다 즉시 쓴다.
 *
 * 경로는 두 가지로 정해진다. `KNUAF_APP_LOG` 가 있으면 그 파일(시험·임시 진단), 없으면 main 이
 * 기동 때 지정한 기본 경로(`setDefaultLogFile` - 설치판은 `app.getPath('logs')/main.log`)다.
 * **출시판에서도 켜져 있다**: 설치된 앱에는 콘솔이 없어 `console.error` 가 증발하고, 그래서
 * G0 조사에서 "위임이 왜 거절됐는지"를 남은 기록으로 밝히지 못했다(inv-logs/RESULT.md).
 *
 * 왜 `appendFileSync` 인가: 버퍼링하면 정작 멈춘 뒤의 줄이 사라진다. main 스레드를 막는 위험은
 * 감수한다 - 각 줄이 수백 바이트이고 기록 빈도가 낮다.
 *
 * 파일은 1MB 에서 한 번 물러난다(`main.log` → `main.log.1`, 이전 세대는 지운다). 무한히 자라면
 * 학생 디스크를 먹고, `%APPDATA%` 는 로밍 대상이라 동기화 부담도 된다. 회전 방식은
 * `chat/rejectLog.ts` 의 검증된 패턴을 그대로 쓴다(윈도우에서 `.1` 을 먼저 지워야 두 번째
 * 회전이 잠금으로 실패하지 않는다).
 *
 * 쓰기 실패도 삼킨다 - 진단이 앱을 깨면 안 된다.
 *
 * **비밀값·경로는 쓰기 전에 지운다**(검토 RT3 중요). 이 파일은 Playwright 산출물로 CI 에 올라가고,
 * 거기 담기는 stderr 에는 모델 키·`Authorization` 헤더·논문 폴더 절대 경로가 섞일 수 있었다.
 * 그래서 진단은 **허용된 필드만** 남긴다: 단계 이름, ms, 개수, pid, 대기 중인 이름, 회수 결과,
 * 오류 코드(`EPERM`)·`error.name`. 값처럼 보이는 것(토큰·경로·base64)은 `scrub` 이 지운다.
 */
/** 환경 변수는 호출 시점에 읽는다 - 시험이 `KNUAF_APP_LOG` 를 켠 뒤 같은 프로세스에서 부를 수 있다. */
const logPath = (): string => process.env.KNUAF_APP_LOG || ''

/**
 * 환경 변수가 없을 때 쓸 기본 경로. main 이 기동 때 한 번 지정한다(`mainLog.ts`).
 *
 * 왜 여기(모듈 변수)인가: `diagLog.ts` 는 electron 을 import 하지 않는다 - `app.getPath('logs')`
 * 를 부르려면 electron 이 필요한데, 이 모듈은 시험(e2e/diag.ts)이 Node 에서 그대로 import 한다.
 * 경로를 아는 쪽(mainLog)이 넣어 주고, 이 모듈은 문자열만 다룬다.
 */
let defaultLogFile = ''

/** 기본 경로를 정한다. 설치판 기동 때 `join(app.getPath('logs'), 'main.log')` 가 들어온다. */
export function setDefaultLogFile(file: string): void { defaultLogFile = file }

/** 지금 기록될 파일. 비어 있으면 진단이 꺼진 것이다. */
export function logFile(): string { return logPath() || defaultLogFile }

/** 진단 로그가 켜져 있는가 - 비싼 문자열 조립·구독을 건너뛸 때 쓴다. */
export function diagEnabled(): boolean { return logFile() !== '' }

/**
 * 한 줄 상한. 넘으면 자른다 - 긴 스택·직렬화된 본문이 파일을 통째로 밀어내지 않게.
 * (잘린 사실은 남긴다. 조용히 자르면 "원래 그게 전부"로 읽힌다.)
 */
const MAX_LINE = 400

/** 회전 상한. 넘으면 `.1` 로 물러나고 새 파일로 시작한다. */
const MAX_FILE_BYTES = 1024 * 1024

/**
 * 지울 것 - **값**만 지우고 진단에 필요한 모양(이름·숫자·코드)은 남긴다.
 * 순서가 중요하다: 헤더/토큰 → 경로 → 긴 덩어리.
 */
const SCRUBS: readonly (readonly [RegExp, string])[] = [
  /**
   * 인증 헤더·자격증명. `code=` 는 오류 코드라 건드리지 않는다.
   *
   * **스킴과 값을 한 규칙에서 함께 먹는다**(검토 hangfix-fix2 중요). 예전에는 이 규칙이
   * `[^\s,;]+` 로 첫 토큰만 먹어 `authorization: Bearer MARKERtoken0123456789` 가
   * `authorization=<값> MARKERtoken0123456789` 가 됐다 - 스킴(`Bearer`)만 지워지고 값이 남았고,
   * 32자 미만이면 마지막 덩어리 규칙도 통과했다. 스킴 규칙과 Bearer 규칙을 따로 두는 한
   * **순서**에 기대게 되므로, 스킴은 여기서 선택적으로 함께 삼킨다(스킴은 글자·하이픈만이고
   * 뒤에 공백이 와야 하므로 `token=abc` 같은 값은 스킴으로 오인하지 않는다).
   */
  [/\b(proxy-)?authorization\b\s*[:=]\s*(?:[A-Za-z][A-Za-z-]*\s+)?[^\s,;]+/gi, 'authorization=<값>'],
  // 헤더 없이 홀로 찍힌 `Bearer …`. 길이 하한을 두지 않는다 - 짧은 토큰도 자격증명이다.
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <값>'],
  [/\b(token|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?id|cookie)\b\s*[:=]\s*[^\s,;]+/gi, '$1=<값>'],
  // 절대 경로: 사용자 이름·논문 폴더가 CI 산출물로 새지 않게. 윈도우(`C:\…`, `\\server\…`) 먼저.
  [/(?:[A-Za-z]:\\|\\\\)[^\s"',;]+/g, '<경로>'],
  [/(?<![\w./-])\/(?:Users|home|tmp|var|private|root|mnt|opt|Volumes)\/[^\s"',;]+/g, '<경로>'],
  // base64·JWT·hex 덩어리(키·해시)
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, '<값>']
]

/** 값처럼 보이는 것을 지운다. 내보내는 이유: stderr 수집(`e2e/diag.ts`)도 같은 규칙을 써야 한다. */
export function scrub(text: string): string {
  let out = text
  for (const [pattern, replacement] of SCRUBS) out = out.replace(pattern, replacement)
  if (out.length > MAX_LINE) out = `${out.slice(0, MAX_LINE)}…(+${out.length - MAX_LINE}자)`
  return out
}

/** 오류는 코드/이름만 남긴다 - `error.message` 에는 경로·토큰·본문이 들어올 수 있다. */
export function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code) return code
  const name = (error as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name ? name : typeof error === 'string' ? 'string' : 'unknown'
}

/**
 * 파일에 한 줄 쓴다 - **모든 기록 경로가 지나가는 유일한 문**. 들어온 글은 여기서 `scrub` 을 거치고,
 * 쓰기 전에 크기를 보고 넘치면 회전한다. 던지지 않는다.
 */
export function appendScrubbed(file: string, text: string): void {
  const line = scrub(text)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const bytes = Buffer.byteLength(line, 'utf-8')
    let size = 0
    try {
      size = statSync(file).size
    } catch (error) {
      // 없는 파일이면 새로 만든다. 그 밖의 오류(권한·디렉터리)면 쓰지 않고 물러난다.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    if (size + bytes > MAX_FILE_BYTES) {
      try {
        // 이전 세대를 지워 자리를 비운다 - 남겨 두면 윈도우에서 두 번째 회전부터 계속 실패해
        // 기록이 영영 멈춘다. 지우지 못하면(디렉터리·잠금) 쓰지 않고 물러난다.
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      } catch {
        return
      }
    }
    appendFileSync(file, `${line}\n`, 'utf-8')
  } catch { /* 진단이 앱 동작을 깨지 않는다 */ }
}

export function diag(message: string): void {
  const path = logFile()
  if (!path) return
  appendScrubbed(path, `${Date.now()} ${message}`)
}
