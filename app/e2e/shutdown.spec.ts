// Unit test for src/main/shutdown.ts — plain Playwright `test()` in Node: no Electron, no agents.
//
// 윈도우 codex-relogin 재발(2026-11-10)의 종료 쪽: `before-quit` 이 정리 약속을 상한 없이
// 기다려 `electronApp.close()` 가 44초 멈췄다. 이 시험은 그 상한의 계약만 고정한다 —
// 마감 안에 끝난 것/안 끝난 것/거절한 것을 **이름으로** 돌려주고, 마감을 넘겨 기다리지 않는다.
import { expect, test } from '@playwright/test'
import { shutdownWithin } from '../src/main/shutdown'

test('마감 안에 모두 끝나면 done 에 이름이 남고 pending 은 비어 있다', async () => {
  const outcome = await shutdownWithin([
    { name: 'a', promise: Promise.resolve('ok') },
    { name: 'b', promise: new Promise((r) => setTimeout(r, 20)) }
  ], 1_000)
  expect(outcome.done.sort()).toEqual(['a', 'b'])
  expect(outcome.pending).toEqual([])
  expect(outcome.failed).toEqual([])
})

test('끝나지 않는 정리 앞에서 마감에 돌아오고 그 이름만 pending 에 남는다', async () => {
  const never = Promise.withResolvers<void>()
  const started = Date.now()
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', promise: Promise.resolve() },
    { name: 'chat.close', promise: never.promise },   // 종료 중 안 끝나는 정리
  ], 100)
  expect(Date.now() - started, '마감을 넘겨 기다렸다').toBeLessThan(1_000)
  expect(outcome.done).toEqual(['sidecar.stop'])
  expect(outcome.pending).toEqual(['chat.close'])
  never.resolve()
})

test('거절한 정리는 failed 로 돌려주고 던지지 않는다 — 나머지 정리도 계속 기다린다', async () => {
  const reason = new Error('sidecar shutdown was not confirmed')
  const outcome = await shutdownWithin([
    { name: 'sidecar.stop', promise: Promise.reject(reason) },
    { name: 'chat.close', promise: Promise.resolve() }
  ], 1_000)
  expect(outcome.failed).toEqual([{ name: 'sidecar.stop', reason }])
  expect(outcome.done).toEqual(['chat.close'])
  expect(outcome.pending).toEqual([])
})
