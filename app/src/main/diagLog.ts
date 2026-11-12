import { appendFileSync } from 'node:fs'

/**
 * 진단용 **파일** 로그 — `KNUAF_APP_LOG` 가 지정됐을 때만, 그것도 줄마다 즉시 쓴다.
 *
 * 왜 stderr 로 충분하지 않은가: 윈도우 CI(PR #102)에서 `electronApp.close()` 가 안 돌아왔을 때,
 * Playwright 가 모아 둔 stderr 는 시험이 finally 에 닿지 못해 **통째로 사라졌다** — 마지막으로 남은
 * 관측이 `Test timeout of 90000ms exceeded` 한 줄이었다. 지금 어디까지 갔는지는 디스크에 남아야 한다.
 *
 * 왜 `appendFileSync` 인가: 버퍼링하면 정작 멈춘 뒤의 줄이 사라진다. main 스레드를 막는 위험은
 * 감수한다 — 이 로그는 진단이 켜졌을 때만, 그리고 각 줄이 수십 바이트다.
 *
 * 미지정이면 **완전 무동작**이다(동작 불변). 쓰기 실패도 삼킨다 — 진단이 앱을 깨면 안 된다.
 *
 * **비밀값·경로는 쓰기 전에 지운다**(검토 RT3 중요). 이 파일은 Playwright 산출물로 CI 에 올라가고,
 * 거기 담기는 stderr 에는 모델 키·`Authorization` 헤더·논문 폴더 절대 경로가 섞일 수 있었다.
 * 그래서 진단은 **허용된 필드만** 남긴다: 단계 이름, ms, 개수, pid, 대기 중인 이름, 회수 결과,
 * 오류 코드(`EPERM`)·`error.name`. 값처럼 보이는 것(토큰·경로·base64)은 `scrub` 이 지운다.
 */

/** 환경 변수는 호출 시점에 읽는다 — 시험이 `KNUAF_APP_LOG` 를 켠 뒤 같은 프로세스에서 부를 수 있다. */
const logPath = (): string => process.env.KNUAF_APP_LOG || ''

/** 진단 로그가 켜져 있는가 — 비싼 문자열 조립·구독을 건너뛸 때 쓴다. */
export function diagEnabled(): boolean { return logPath() !== '' }

/**
 * 한 줄 상한. 넘으면 자른다 — 긴 스택·직렬화된 본문이 파일을 통째로 밀어내지 않게.
 * (잘린 사실은 남긴다. 조용히 자르면 "원래 그게 전부"로 읽힌다.)
 */
const MAX_LINE = 400

/**
 * 지울 것 — **값**만 지우고 진단에 필요한 모양(이름·숫자·코드)은 남긴다.
 * 순서가 중요하다: 헤더/토큰 → 경로 → 긴 덩어리.
 */
const SCRUBS: readonly (readonly [RegExp, string])[] = [
  // 인증 헤더·자격증명. `code=` 는 오류 코드라 건드리지 않는다.
  [/\b(proxy-)?authorization\b\s*[:=]\s*[^\s,;]+/gi, 'authorization=<값>'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <값>'],
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

/** 오류는 코드/이름만 남긴다 — `error.message` 에는 경로·토큰·본문이 들어올 수 있다. */
export function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code) return code
  const name = (error as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name ? name : typeof error === 'string' ? 'string' : 'unknown'
}

export function diag(message: string): void {
  const path = logPath()
  if (!path) return
  try { appendFileSync(path, `${Date.now()} ${scrub(message)}\n`) } catch { /* 진단이 앱 동작을 깨지 않는다 */ }
}
