export class UpdateSuspendedError extends Error {
  readonly code = 'update_suspended'
  constructor() { super('업데이트를 준비하고 있어요. 잠시 기다려 주세요.') }
}
/** Every asynchronous agent entry (including probes, not only turns) owns a lease. */
export class AgentActivity {
  private paused = false
  private count = 0
  private idle = new Set<() => void>()
  private listeners = new Set<() => void>()
  get suspended(): boolean { return this.paused }
  /**
   * `suspend()` 는 정지 사실을 **동기로** 알린다 — 조회 중인 연결이 자기 자식을 바로 끊을 수
   * 있게 하려는 것이다(인계가 30초 기다리다 실패하는 대신). 알림이 던져도 정지는 유지한다.
   */
  suspend(): void {
    if (this.paused) throw new UpdateSuspendedError()
    this.paused = true
    for (const listener of this.listeners) { try { listener() } catch { /* 정지는 유지한다 */ } }
  }
  /** 정지 알림 구독. 돌려준 함수로 해제한다(닫는 쪽이 스스로 뺀다). */
  onSuspend(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  resume(): void { this.paused = false }
  ensureActive(): void { if (this.paused) throw new UpdateSuspendedError() }
  enter(): () => void {
    this.ensureActive()
    ++this.count
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.count === 0) for (const done of this.idle) done()
    }
  }
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.enter()
    try { return await work() } finally { release() }
  }
  async drain(timeout = 30_000): Promise<void> {
    if (!this.paused) throw new Error('인계 일시 정지 없이 작업을 비울 수 없어요.')
    if (!this.count) return
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const done = (): void => { clearTimeout(timer); this.idle.delete(done); resolve() }
    const timer = setTimeout(() => { this.idle.delete(done); reject(new Error('작업이 끝난 뒤 다시 눌러 주세요.')) }, Math.max(0, timeout))
    this.idle.add(done)
    return promise
  }
}
export const agentActivity = new AgentActivity()
