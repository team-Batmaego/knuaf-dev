/**
 * figures/heartbeat.ts — 앱이 살아 있음을 저장소 시간으로 알린다 (R4-1, 계약 §2)
 *
 * 도우미는 `figure-channel.json`의 `updatedAt`을 보고 15초 넘게 낡았으면 기다리지 않고 즉시 실패한다.
 * 그래서 이 파일은 **요청을 받을 수 있는 동안에만** 5초마다 갱신된다. 앱이 죽으면 갱신이 멈추고,
 * 남은 파일은 스스로 낡는다 — 별도 정리 코드가 필요 없다.
 *
 * v0.7 담당(relay)에는 `KNUAF_FIGURE_HOME`을 주지 않으므로 이 파일이 있어도 통로가 생기지 않는다.
 */

import { writeJson } from './storage'

export interface HeartbeatState {
  v: 1
  pid: number
  updatedAt: number
}

export const HEARTBEAT_INTERVAL_MS = 5_000

export interface Heartbeat {
  beat(): Promise<void>
  stop(): Promise<void>
}

/**
 * `path`에 지금 시각을 한 번 쓰고, `intervalMs`마다 반복한다. `stop()`은 타이머를 지우고
 * 마지막 흔적을 남기지 않는다(파일은 남지만 갱신이 멈춰 곧 낡는다).
 */
export function startHeartbeat(
  path: string,
  options: { intervalMs?: number; now?: () => number; pid?: number } = {}
): Heartbeat {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const beat = async (): Promise<void> => {
    if (stopped) return
    await writeJson(path, { v: 1, pid, updatedAt: now() } satisfies HeartbeatState)
  }

  /**
   * 첫 박자도 거절을 밖으로 내보내지 않는다(I-03). 저장소 자리를 쓸 수 없으면(예: `figure-channel.json`
   * 이름이 디렉터리) 이 쓰기가 거절되는데, `void` 만 붙이면 아무도 받지 않아 **비처리 거절**이 되고
   * 그림 하나 때문에 앱이 종료된다. 실패는 아래 반복 박자와 같은 규칙으로 삼킨다.
   */
  void beat().catch(() => {
    /* 첫 쓰기 실패는 다음 박자와 같다 — 그림만 꺼지고 앱은 뜬다. */
  })
  timer = setInterval(() => {
    void beat().catch(() => {
      /* 쓰기 실패는 다음 박자에 다시 시도한다 — 하트비트 때문에 앱을 멈추지 않는다. */
    })
  }, intervalMs)
  // 이 타이머가 앱 종료를 붙잡지 않게 한다.
  timer.unref?.()

  return {
    beat,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      timer = undefined
    }
  }
}
