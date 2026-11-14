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

/** 첫 박자의 결과. 실패는 거절이 아니라 값으로 돌려준다(비처리 거절을 만들지 않는다). */
export type FirstBeat = { ok: true } | { ok: false; error: unknown }

export interface Heartbeat {
  beat(): Promise<void>
  /** 첫 박자의 결과 — 성공이든 실패든, `stop()` 이든 한 번 정착한다. */
  first: Promise<FirstBeat>
  stop(): Promise<void>
}

/**
 * `path`에 지금 시각을 한 번 쓰고, `intervalMs`마다 반복한다. `stop()`은 타이머를 지우고
 * 마지막 흔적을 남기지 않는다(파일은 남지만 갱신이 멈춰 곧 낡는다).
 *
 * **첫 박자가 실패하면 스스로 멈춘다**(I-03). 생존 신호를 한 번도 남기지 못한 통로는 도우미가 15초 뒤
 * "낡음"으로 읽으므로, 계속 재시도해 봐야 그 사이 요청만 실패한다. 실패는 `first` 로 알린다 —
 * 호출자(그림 통로)는 그것을 보고 감시자·턴 고리까지 끈다. 첫 박자가 **성공한 뒤**의 실패는 종전대로
 * 다음 박자에 다시 시도한다.
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
  /** 첫 박자가 성공했는가 — 성공 뒤의 실패는 통로를 끄지 않는다(일시적 쓰기 실패). */
  let firstWon = false
  /** 첫 박자가 이미 정착했는가 — 아직 도는 중이면 타이머는 판단하지 않는다(그 박자가 스스로 보고한다). */
  let firstDone = false
  const firstResult = Promise.withResolvers<FirstBeat>()

  const beat = async (): Promise<void> => {
    if (stopped) return
    await writeJson(path, { v: 1, pid, updatedAt: now() } satisfies HeartbeatState)
  }

  /** 타이머를 지우고 첫 박자를 실패로 정착시킨다. `beat()` 가 더는 쓰지 않게 `stopped` 를 세운다. */
  const giveUp = (error: unknown): void => {
    stopped = true
    clearInterval(timer)
    timer = undefined
    firstResult.resolve({ ok: false, error })
  }

  // 첫 박자의 **거절을 받는 곳**이 여기다 — 안 받으면 비처리 거절이 되고, 그림 하나 때문에 앱이 종료된다.
  void beat().then(
    () => {
      firstWon = true
      firstDone = true
      firstResult.resolve({ ok: true })
    },
    (error: unknown) => {
      firstDone = true
      giveUp(error)
    }
  )

  timer = setInterval(() => {
    void beat().catch((error: unknown) => {
      // 첫 박자가 아직 도는 중이면 판단하지 않는다 — 그 박자가 자기 결과를 보고한다.
      // 성공 뒤의 실패만 재시도한다.
      if (!firstDone || firstWon || stopped) return
      giveUp(error)
    })
  }, intervalMs)
  // 이 타이머가 앱 종료를 붙잡지 않게 한다.
  timer.unref?.()

  return {
    beat,
    first: firstResult.promise,
    async stop() {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
        timer = undefined
      }
      // 이미 멈춘 뒤여도 약속이 매달리지 않게 한다 — 멈춘 하트비트는 "첫 박자 없음"으로 본다.
      firstResult.resolve({ ok: false, error: new Error('heartbeat stopped') })
    }
  }
}
