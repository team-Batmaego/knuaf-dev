/**
 * 종료 정리에 **마감**을 둔다.
 *
 * `before-quit` 은 지금까지 정리 약속(`sidecar.stop()`·`chat.close()`)이 저절로 끝나기를
 * 기다렸다. 그 약속들 중 하나라도 끝나지 않으면 Electron main 은 영영 종료되지 않고,
 * 창을 닫은 학생은 앱이 안 꺼지는 것을 본다(윈도우 e2e: `electronApp.close()` 44초 미완료).
 *
 * 여기서는 무엇이 안 끝났는지 이름으로 남기고 마감 시각에 돌아온다 — 조용히 버리지 않는다.
 * 부른 쪽(index.ts)이 남은 이름을 로그로 적고 `app.exit()` 로 넘어간다.
 */
export interface ShutdownTask {
  /** 로그에 남길 짧은 이름 — `sidecar.stop`·`chat.close` 처럼 어느 정리가 남았는지. */
  name: string
  promise: Promise<unknown>
}

export interface ShutdownOutcome {
  /** 마감 안에 끝난 정리 이름. */
  done: string[]
  /** 마감까지 끝나지 않은 정리 이름 — 부른 쪽이 기록하고 강제 종료로 넘어간다. */
  pending: string[]
  /** 정리 약속이 거절한 이름과 이유(정리 실패는 종료를 막지 않는다). */
  failed: { name: string; reason: unknown }[]
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
 * 모든 정리를 걸고 `deadlineMs` 까지 기다린다. **던지지 않는다** — 거절은 `failed` 로 돌려준다.
 * 마감이 지나면 끝나지 않은 것을 기다리지 않고 `pending` 으로 알린다(그 약속들은 살아 있지만
 * 더는 종료를 붙잡지 못한다 — 부른 쪽이 곧 프로세스를 끝낸다).
 */
export async function shutdownWithin(tasks: readonly ShutdownTask[], deadlineMs: number): Promise<ShutdownOutcome> {
  const outcome: ShutdownOutcome = { done: [], pending: [], failed: [] }
  const settled = tasks.map((task) => task.promise.then(
    () => { outcome.done.push(task.name) },
    (reason: unknown) => { outcome.failed.push({ name: task.name, reason }) }
  ))
  const all = Promise.all(settled)
  const expired = Promise.withResolvers<'deadline'>()
  const timer = setTimeout(() => expired.resolve('deadline'), Math.max(0, deadlineMs))
  try {
    if (await Promise.race([all.then(() => 'done' as const), expired.promise]) === 'deadline') {
      outcome.pending = tasks
        .filter((task) => !outcome.done.includes(task.name) && !outcome.failed.some((f) => f.name === task.name))
        .map((task) => task.name)
    }
  } finally {
    clearTimeout(timer)
  }
  return outcome
}
