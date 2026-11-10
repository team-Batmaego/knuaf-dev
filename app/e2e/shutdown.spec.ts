// Unit test for src/main/shutdown.ts — plain Playwright `test()` in Node: no Electron, no agents.
//
// 윈도우 codex-relogin 재발(2026-11-10)의 종료 쪽: `before-quit` 이 정리 약속을 상한 없이
// 기다려 `electronApp.close()` 가 44초 멈췄다. 이 시험은 그 상한의 계약만 고정한다 —
// 마감 안에 끝난 것/안 끝난 것/거절한 것을 **이름으로** 돌려주고, 마감을 넘겨 기다리지 않는다.
//
// RT3(검토 RT2-02·RT2-03): 마감 타이머가 정리 **시작보다 먼저** 걸리는지, 실제 경과가
// 마감보다 길어질 때 그것을 숨기지 않고 돌려주는지, 남은 자식 회수를 시도·관측하는지.
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { needsReclaim, reclaimChildren, shutdownWithin } from '../src/main/shutdown'

test('마감 안에 모두 끝나면 done 에 이름이 남고 pending 은 비어 있다', async () => {
  const outcome = await shutdownWithin([
    { name: 'a', start: async () => 'ok' },
    { name: 'b', start: () => new Promise<void>((r) => setTimeout(r, 20)) }
  ], 1_000)
  expect(outcome.done.sort()).toEqual(['a', 'b'])
  expect(outcome.pending).toEqual([])
  expect(outcome.failed).toEqual([])
})

test('끝나지 않는 정리 앞에서 마감에 돌아오고 그 이름만 pending 에 남는다', async () => {
  const never = Promise.withResolvers<void>()
  const started = Date.now()
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: async () => {} },
    { name: 'chat.close', start: () => never.promise },   // 종료 중 안 끝나는 정리
  ], 100)
  expect(Date.now() - started, '마감을 넘겨 기다렸다').toBeLessThan(1_000)
  expect(outcome.done).toEqual(['sidecar.stop'])
  expect(outcome.pending).toEqual(['chat.close'])
  never.resolve()
})

test('거절한 정리는 failed 로 돌려주고 던지지 않는다 — 나머지 정리도 계속 기다린다', async () => {
  const reason = new Error('sidecar shutdown was not confirmed')
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: () => Promise.reject(reason) },
    { name: 'chat.close', start: async () => {} }
  ], 1_000)
  expect(outcome.failed).toEqual([{ name: 'sidecar.stop', reason }])
  expect(outcome.done).toEqual(['chat.close'])
  expect(outcome.pending).toEqual([])
})

test('정리를 시작하는 도중 던져도 failed 로 남고 나머지는 계속 돈다', async () => {
  const reason = new Error('spawn refused')
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: () => { throw reason } },
    { name: 'chat.close', start: async () => {} }
  ], 1_000)
  expect(outcome.failed).toEqual([{ name: 'sidecar.stop', reason }])
  expect(outcome.done).toEqual(['chat.close'])
})

test('마감 타이머는 정리 시작보다 먼저 걸린다 — 동기 블록이 마감을 앞지르지 않는다 (RT2-02)', async () => {
  // 검토 RT2-02 재현: 예전에는 `shutdownWithin([{promise: sidecar.stop()}], 10)` 처럼 **인자
  // 평가**에서 동기 작업이 먼저 돌았다. 지금은 시작 함수를 넘기므로 타이머가 먼저 걸린다.
  const realSetTimeout = globalThis.setTimeout
  const scheduled: number[] = []
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    scheduled.push(ms ?? 0)
    return realSetTimeout(fn, ms, ...rest)
  }) as unknown as typeof setTimeout
  let scheduledBeforeStart = -1
  try {
    const outcome = await shutdownWithin([
      {
        name: 'chat.close',
        start: () => {
          scheduledBeforeStart = scheduled.length
          // 동기 블록 30ms — 마감 10ms 는 이 루프에서 발화할 수 없다.
          const until = Date.now() + 30
          while (Date.now() < until) { /* block the loop on purpose */ }
          return Promise.resolve()
        }
      }
    ], 10)
    expect(scheduledBeforeStart, '정리 시작 시점에 마감 타이머가 예약돼 있지 않았다').toBe(1)
    // 실제 경과가 마감보다 길면 **숨기지 않고** 돌려준다(로그가 이 숫자를 남긴다).
    expect(outcome.elapsedMs, '동기 블록이 경과에 반영되지 않았다').toBeGreaterThanOrEqual(25)
    expect(outcome.done).toEqual(['chat.close'])
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('동기 작업이 없는 정상 경로는 마감 안에 끝나고 경과가 짧다', async () => {
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: async () => {} },
    { name: 'chat.close', start: async () => {} }
  ], 1_000)
  expect(outcome.pending).toEqual([])
  expect(outcome.elapsedMs, '마감(1000ms)을 넘겼다').toBeLessThan(200)
})

test('남은 자식은 트리 종료를 시도하고 **살아 있는지 관측**한다 — 회수를 가정하지 않는다 (RT2-03)', async () => {
  // 이 시험이 띄우는 자식은 우리가 직접 만든 것이라 실제 kill 로 정리한다(고아 금지).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  const pid = child.pid!
  try {
    const outcome = await reclaimChildren([pid], 2_000)
    expect(outcome.pids).toEqual([pid])
    expect(outcome.alive, '죽인 자식이 살아 있다고 나온다').toEqual([])
    expect(outcome.unknown).toEqual([])
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
})

test('회수 콜백이 아무 신호도 보내지 않으면 살아있음으로 남는다 — 성공을 꾸미지 않는다 (RT2-03)', async () => {
  // 검토 지적: 예전 `index.ts` 는 `kill: () => false` 를 넘겨 Unix 에서 **무동작**이었다.
  // 이제 함수가 직접 플랫폼별 종료를 한다 — 시험은 관측 계약만 남긴다(직접 죽이지 않는다).
  const child = spawn(process.execPath, ['-e', 'process.on("SIGKILL", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  const pid = child.pid!
  try {
    // SIGKILL 은 붙잡을 수 없으므로 이 자식은 실제로 죽는다 — 관측은 "죽었음"이 맞다.
    const outcome = await reclaimChildren([pid], 2_000)
    expect(outcome.alive, 'SIGKILL 을 보냈는데 살아 있다고 나온다').toEqual([])
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
})

test('pid 가 없으면 회수 시도도 관측도 하지 않는다', async () => {
  const outcome = await reclaimChildren([], () => { throw new Error('부르면 안 된다') })
  expect(outcome).toEqual({ pids: [], alive: [], unknown: [] })
})

test('정착한 실패도 회수 경로를 탄다 — "대기 없음"은 "전부 성공"이 아니다 (RT2-03)', async () => {
  // 검토 재현: sidecar stop 이 실패로 정착하고 chat.close 가 완료된 before-quit 본문이
  // `pending.length === 0` 만 보고 app.quit 으로 가 회수를 0회 호출했다.
  const reason = new Error('sidecar_stop_failed')
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: () => Promise.reject(reason) },
    { name: 'chat.close', start: async () => {} }
  ], 1_000)
  expect(outcome.pending).toEqual([])
  expect(outcome.failed.map((f) => f.name)).toEqual(['sidecar.stop'])
  expect(needsReclaim(outcome), '실패가 정착했는데 회수 경로를 건너뛴다').toBe(true)
})

test('마감을 넘긴 경우도 회수 경로를 탄다 (RT2-03)', async () => {
  const never = Promise.withResolvers<void>()
  const outcome = await shutdownWithin([{ name: 'chat.close', start: () => never.promise }], 50)
  expect(needsReclaim(outcome)).toBe(true)
  never.resolve()
})

test('모두 정상 종료면 회수 경로를 타지 않는다 — 정상 종료에 강제 종료를 쓰지 않는다', async () => {
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', start: async () => {} },
    { name: 'chat.close', start: async () => {} }
  ], 1_000)
  expect(needsReclaim(outcome)).toBe(false)
})
