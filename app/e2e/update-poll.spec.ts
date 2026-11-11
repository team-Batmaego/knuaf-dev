import { expect, test } from '@playwright/test'
import { startPoll, stopPoll, useConnect } from '../src/renderer/src/store/connect'
import { UPDATE_RECOVERY_COPY } from '../src/shared/copy'

test('suspended probes obey stop, restart and the three-minute deadline', async () => {
  const original = { setInterval, clearInterval, setTimeout, clearTimeout, window: (globalThis as { window?: unknown }).window }
  const originalState = useConnect.getState()
  let now = 0, next = 0, calls = 0
  const timers = new Map<number, { at: number; delay: number; repeat: boolean; fn: () => void }>()
  const schedule = (fn: () => void, delay: number, repeat: boolean) => {
    const id = ++next; timers.set(id, { at: now + delay, delay, repeat, fn }); return id
  }
  globalThis.setInterval = ((fn: () => void, delay: number) => schedule(fn, delay, true)) as unknown as typeof setInterval
  globalThis.setTimeout = ((fn: () => void, delay: number) => schedule(fn, delay, false)) as unknown as typeof setTimeout
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as unknown as typeof clearInterval
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  ;(globalThis as { window?: unknown }).window = { knuaf: { connect: { status: async () => {
    calls++; return { error: { code: 'update_suspended', message: UPDATE_RECOVERY_COPY } }
  } } } }
  const advance = async (ms: number) => {
    const end = now + ms
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due; now = timer.at
      if (timer.repeat) timer.at += timer.delay; else timers.delete(id)
      timer.fn()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    }
    now = end
  }
  const tick = async () => { await useConnect.getState().refresh('codex'); return false }
  try {
    useConnect.setState({ loggingIn: { codex: true, claude: false } })
    startPoll('codex', tick)
    await advance(6000)
    expect(calls).toBe(2)
    expect(useConnect.getState().codex).toMatchObject({ state: 'unknown', detail: UPDATE_RECOVERY_COPY })
    expect(useConnect.getState().loggingIn.codex).toBe(false)
    stopPoll('codex')
    await advance(5000)
    expect(calls).toBe(2); expect(timers.size).toBe(0)
    startPoll('codex', tick)
    await advance(3000)
    expect(calls).toBe(3)
    startPoll('codex', tick)
    await advance(6000)
    expect(calls).toBe(5)
    await advance(174000)
    expect(calls).toBe(63)
    expect(timers.size).toBe(0)
    const stoppedAt = calls
    await advance(5000)
    expect(calls).toBe(stoppedAt)
    // A replaced poll must not overlap an already in-flight request.
    let release: (done: boolean) => void = () => {}
    let overlap = 0
    startPoll('codex', () => new Promise<boolean>(resolve => { release = resolve }))
    await advance(3000)
    startPoll('codex', async () => { overlap++; return false })
    await advance(6000)
    expect(overlap).toBe(0)
    release(false)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await advance(3000)
    expect(overlap).toBe(1)
    // A stuck in-flight tick must not prevent the independent deadline from clearing timers.
    startPoll('codex', () => new Promise<boolean>(() => {}))
    await advance(180000)
    expect(timers.size).toBe(0)
  } finally {
    stopPoll()
    useConnect.setState(originalState)
    globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval
    globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout
    ;(globalThis as { window?: unknown }).window = original.window
  }
})

test('조건부 불변: 잠금 15초 안에서는 겹치지 않고, 지나면 버린 요청 위에 새로 묻는다', async () => {
  // 책임자 결정(2026-11-11): 요청을 취소할 수 없으므로 '겹침 0'과 '영영 잠기지 않음'은 무조건
  // 함께 성립하지 않는다. 계약:
  //   ① 잠금 안(첫 tick + 15초)에서는 새 조회가 시작되지 않는다.
  //   ② 15초가 지나면 그 요청을 **버렸다**고 보고 다음 간격에 새 조회를 1회 허용한다.
  //   ③ 버린 요청의 **늦은 결과는 감시가 쓰지 않는다**(완료라고 감시를 끝내지 않는다).
  //   ④ 감시의 180초 마감이 버린 요청 수의 상한이다 — 마감 뒤 타이머 0.
  const original = { setInterval, clearInterval, setTimeout, clearTimeout, window: (globalThis as { window?: unknown }).window }
  const originalState = useConnect.getState()
  let now = 0, next = 0
  const timers = new Map<number, { at: number; delay: number; repeat: boolean; fn: () => void }>()
  const schedule = (fn: () => void, delay: number, repeat: boolean) => {
    const id = ++next; timers.set(id, { at: now + delay, delay, repeat, fn }); return id
  }
  globalThis.setInterval = ((fn: () => void, delay: number) => schedule(fn, delay, true)) as unknown as typeof setInterval
  globalThis.setTimeout = ((fn: () => void, delay: number) => schedule(fn, delay, false)) as unknown as typeof setTimeout
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as unknown as typeof clearInterval
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  ;(globalThis as { window?: unknown }).window = { knuaf: { connect: { status: async () => ({ result: { installed: true, connected: false, version: null, detail: '', probe: 'ok' } }) } } }
  const advance = async (ms: number) => {
    const end = now + ms
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due; now = timer.at
      if (timer.repeat) timer.at += timer.delay; else timers.delete(id)
      timer.fn()
      for (let i = 0; i < 12; i++) await Promise.resolve()
    }
    now = end
  }
  // tick 호출 시각과 resolver — 시험이 "늦은 완료"를 직접 만들 수 있다.
  const started: number[] = []
  const resolvers: ((done: boolean) => void)[] = []
  const tick = (): Promise<boolean> => new Promise<boolean>((resolve) => { started.push(now); resolvers.push(resolve) })
  try {
    // ① 첫 tick(3초)이 매달린 동안, 3초 간격이 계속 지나도 새 조회가 없다.
    startPoll('codex', tick)
    await advance(12_000)
    expect(started, '15초 안에 겹쳐 시작했다').toEqual([3_000])
    // ② 15초 시점에도 아직 잠김(만료는 18초), 만료 뒤 첫 간격(21초)에 한 번 시작한다.
    await advance(3_000)                        // → 15초
    expect(started.length, '만료 전에 시작했다').toBe(1)
    await advance(6_000)                        // → 21초
    expect(started.length, '만료 뒤에도 새 조회가 없다(영영 잠김)').toBe(2)

    // ③ 버린 요청(3초 tick)의 늦은 완료(true)는 감시를 쓰지 않는다 — 끝나면 새 tick 이 영영 없다.
    resolvers[0](true)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(timers.size, '버린 요청의 완료가 감시를 끝냈다').toBeGreaterThan(0)

    // ④ 그 증거: 21초 tick 도 15초(36초)에 만료되고 다음 간격(39초)에 새 tick 이 시작된다.
    await advance(18_000)                       // → 39초
    expect(started.length, '버린 요청의 완료가 감시를 끝내 새 조회가 멈췄다').toBe(3)

    // ⑤ 180초 마감 뒤 타이머 0(버린 요청 수의 상한이 마감이라는 계약).
    for (const resolve of resolvers) resolve(false)
    await advance(200_000)
    expect(timers.size, '180초 마감 뒤 타이머가 남았다').toBe(0)

    // ⑥ **교체된 감시**도 잠금 안에서는 겹치지 않고, 만료 뒤에만 한 번 새로 묻는다
    //    (잠금 표가 감시 세대 밖에 있는 이유가 이 문장이다).
    startPoll('codex', tick)
    await advance(3_000)                        // 이 감시의 첫 tick 이 매달린다(잠금 유지)
    const held = started.length
    startPoll('codex', tick)                    // 잠금이 살아 있는 채로 교체
    await advance(12_000)                       // → 첫 tick + 12초: 아직 잠금 안
    expect(started.length, '교체된 감시가 잠금 안에서 겹쳐 조회했다').toBe(held)
    await advance(6_000)                        // → 첫 tick + 18초: 만료 뒤 첫 간격
    expect(started.length, '교체된 감시가 만료 뒤에도 새로 묻지 않는다(영영 잠김)').toBe(held + 1)
  } finally {
    stopPoll()
    useConnect.setState(originalState)
    globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval
    globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout
    ;(globalThis as { window?: unknown }).window = original.window
  }
})
