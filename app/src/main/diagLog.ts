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
 */
const path = process.env.KNUAF_APP_LOG || ''

/** 진단 로그가 켜져 있는가 — 비싼 문자열 조립을 건너뛸 때 쓴다. */
export const diagEnabled = path !== ''

export function diag(message: string): void {
  if (!path) return
  try { appendFileSync(path, `${Date.now()} ${message}\n`) } catch { /* 진단이 앱 동작을 깨지 않는다 */ }
}
