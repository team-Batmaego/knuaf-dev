/**
 * 종료 정리에 **마감**을 둔다.
 *
 * `before-quit` 은 지금까지 정리 약속(`sidecar.stop()`·`chat.close()`)이 저절로 끝나기를
 * 기다렸다. 그 약속들 중 하나라도 끝나지 않으면 Electron main 은 영영 종료되지 않고,
 * 창을 닫은 학생은 앱이 안 꺼지는 것을 본다(윈도우 e2e: `electronApp.close()` 44초 미완료).
 *
 * 두 가지를 지킨다(검토 RT2-02):
 * 1. **마감 타이머를 정리 시작보다 먼저** 건다. 그래서 부르는 쪽은 이미 시작된 약속이 아니라
 *    "시작하는 함수"를 넘긴다 — 인자 평가(그 안의 동기 작업)가 타이머보다 앞서지 않는다.
 * 2. **경과 시간을 재서 돌려준다.** 타이머는 이벤트 루프가 돌아야 발화하므로, 같은 루프를
 *    막는 동기 호출이 있으면 실제 경과는 마감보다 길다. 그 사실을 숫자로 남긴다 —
 *    "마감이 지켜졌다"고 코드만 보고 말하지 않게.
 */
export interface ShutdownTask {
  /** 로그에 남길 짧은 이름 — `sidecar.stop`·`chat.close` 처럼 어느 정리가 남았는지. */
  name: string
  /** 정리를 **시작하는** 함수. 마감 타이머가 걸린 뒤에 불린다. */
  start: () => Promise<unknown>
}

export interface ShutdownOutcome {
  /** 마감 안에 끝난 정리 이름. */
  done: string[]
  /** 마감까지 끝나지 않은 정리 이름 — 부른 쪽이 기록하고 강제 종료로 넘어간다. */
  pending: string[]
  /** 정리 약속이 거절한 이름과 이유(정리 실패는 종료를 막지 않는다). */
  failed: { name: string; reason: unknown }[]
  /** 정리 시작부터 이 함수가 돌아오기까지의 실제 시간(ms). 마감보다 크면 동기 블록이 있었다. */
  elapsedMs: number
}

/**
 * 남은 핸들 1줄 — 마감에 걸렸을 때 **무엇이 main을 붙잡는지** 다음 재발 때 바로 보이게 한다.
 * Electron/Node 의 비공개 API(`process._getActiveHandles`)라 없으면 빈 문자열이다(진단 실패가
 * 종료를 막지 않는다). 자식 프로세스는 pid 만 적고 인자는 적지 않는다(경로·토큰 노출 방지).
 */
export function openHandles(): string {
  const read = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles
  if (typeof read !== 'function') return ''
  let handles: unknown[]
  try { handles = read.call(process) } catch { return '' }
  const seen = new Map<string, number>()
  for (const handle of handles) {
    const ctor = (handle as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'unknown'
    const pid = (handle as { pid?: unknown } | null)?.pid
    const name = typeof pid === 'number' ? `${ctor}(pid=${pid})` : ctor
    seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return [...seen].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ')
}

/**
 * 모든 정리를 시작하고 `deadlineMs` 까지 기다린다. **던지지 않는다** — 거절은 `failed` 로 돌려준다.
 * 마감이 지나면 끝나지 않은 것을 기다리지 않고 `pending` 으로 알린다.
 */
export async function shutdownWithin(tasks: readonly ShutdownTask[], deadlineMs: number): Promise<ShutdownOutcome> {
  const outcome: ShutdownOutcome = { done: [], pending: [], failed: [], elapsedMs: 0 }
  const startedAt = Date.now()
  const expired = Promise.withResolvers<'deadline'>()
  // 타이머가 먼저다 — 아래 `start()` 안의 동기 작업이 마감을 앞지르지 않게.
  const timer = setTimeout(() => expired.resolve('deadline'), Math.max(0, deadlineMs))
  const settled = tasks.map((task) => {
    let started: Promise<unknown>
    try { started = task.start() } catch (error) { started = Promise.reject(error) }
    return started.then(
      () => { outcome.done.push(task.name) },
      (reason: unknown) => { outcome.failed.push({ name: task.name, reason }) }
    )
  })
  try {
    if (await Promise.race([Promise.all(settled).then(() => 'done' as const), expired.promise]) === 'deadline') {
      outcome.pending = tasks
        .filter((task) => !outcome.done.includes(task.name) && !outcome.failed.some((f) => f.name === task.name))
        .map((task) => task.name)
    }
  } finally {
    clearTimeout(timer)
    outcome.elapsedMs = Date.now() - startedAt
  }
  return outcome
}
