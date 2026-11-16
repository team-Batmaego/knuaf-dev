/**
 * update/recheck.ts — 켜 둔 채 쓰는 학생에게 새 앱 판을 알린다 (v0.6.8 A1-3)
 *
 * 지금까지 앱은 켤 때 한 번(그리고 설정의 '지금 확인')만 새 판을 확인했다 — 앱을 끄지 않고
 * 계속 열어 두는 학생은 새 판이 나온 것을 몰랐다. 이 파일은 그 확인을 일정 간격으로 반복하는
 * 타이머만 맡는다. 상태 기계·설치 경로는 `appService.ts` 그대로다.
 *
 * 타이머는 `unref` 한다(`figures/heartbeat.ts` 와 같은 이유) — 돌고 있는 주기 확인 때문에
 * 앱 종료가 늦어지면 안 된다.
 */

/** 몇 시간마다 다시 확인할지. 채널 문서는 수 KB 라 하루 ~48회 요청은 부담이 없다. */
export const RECHECK_INTERVAL_MS = 30 * 60 * 1000

export interface RecheckTimer {
  /** 주기 확인을 멈춘다. 여러 번 불러도 안전하다. */
  stop(): void
  /** 이 타이머가 프로세스 종료를 붙잡고 있나 — 시험이 `unref` 를 확인할 때 쓴다. */
  held(): boolean
}

/**
 * `task` 를 `intervalMs` 마다 부른다. 첫 박자는 간격 뒤에 온다 — 켤 때 확인이 이미 한 번 돌기
 * 때문이다. `task` 의 거절은 삼킨다: 주기 확인의 실패는 다음 박자에 다시 시도할 뿐이고,
 * 학생 화면의 오류 표시는 `AppUpdates` 가 정한다.
 */
export function startRecheck(intervalMs: number, task: () => Promise<unknown>): RecheckTimer {
  let stopped = false
  const timer = setInterval(() => {
    if (!stopped) void task().catch(() => { /* 다음 박자에 다시 */ })
  }, intervalMs)
  timer.unref?.()
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
    held: () => timer.hasRef()
  }
}
