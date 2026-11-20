/**
 * 진단 상한 회귀 시험(검토 I-01·I-02). Node 단위 — Electron 창 없이.
 *
 * 고정하는 계약:
 *  - 기동 표식은 **단계당 3줄·창당 40줄**을 넘지 않는다(반복 이벤트가 main 스레드에서 동기 쓰기를
 *    무한히 돌리지 않는다).
 *  - 기동 구간은 한 번만 닫히고, 닫힌 뒤에는 어떤 표식도 남지 않는다(구독을 떼는 것과 같은 효과).
 *  - `settings:get` 진단은 첫 3회만 남긴다.
 *  - 실패 경로 첨부 대기는 **절대 던지지 않고**, 상한을 넘기면 `'timeout'` 으로 돌아온다 — 그래서
 *    원래 오류가 그대로 재던져진다(I-02).
 */
import { expect, test } from '@playwright/test'
import {
  ATTACH_WAIT_MS,
  createCallGate,
  createStartupDiag,
  SETTINGS_GET_DIAG_CALLS,
  settleWithin,
  STARTUP_DIAG_LIMITS,
  STARTUP_WINDOW_MS
} from '../src/main/diagLimits'

test('기동 표식은 단계당 상한에서 멈춘다 — 반복 이벤트가 동기 쓰기를 무한히 돌리지 않는다', () => {
  const diag = createStartupDiag()
  const allowed = Array.from({ length: 20 }, () => diag.allow('startup:renderer-console')).filter(Boolean)
  expect(allowed).toHaveLength(STARTUP_DIAG_LIMITS.perStage)
  // 다른 단계는 자기 몫을 따로 갖는다(단계별 상한이지 전체 상한이 아니다).
  expect(diag.allow('startup:load-start')).toBe(true)
})

test('기동 표식은 창당 총 상한도 함께 지킨다 — 단계를 바꿔 가며 반복해도 넘지 않는다', () => {
  const diag = createStartupDiag({ perStage: 100, total: 7 })
  let written = 0
  for (let i = 0; i < 50; i++) if (diag.allow(`stage-${i}`)) written += 1
  expect(written).toBe(7)
  expect(diag.count()).toBe(7)
})

test('기동 구간은 한 번만 닫히고, 닫힌 뒤에는 표식이 남지 않는다', () => {
  const diag = createStartupDiag()
  expect(diag.allow('startup:load-start')).toBe(true)
  expect(diag.close('did-finish-load')).toBe(true)
  expect(diag.closed()).toBe('did-finish-load')
  // 두 번째 닫기는 false — 먼저 온 쪽(load 완료/첫 표시/마감)이 이유를 정한다.
  expect(diag.close('ready-to-show')).toBe(false)
  expect(diag.closed()).toBe('did-finish-load')
  expect(diag.allow('startup:renderer-console')).toBe(false)
  expect(diag.count()).toBe(1)
})

test('settings:get 진단은 첫 몇 번만 남긴다', () => {
  const gate = createCallGate(SETTINGS_GET_DIAG_CALLS)
  const calls = Array.from({ length: SETTINGS_GET_DIAG_CALLS + 5 }, () => gate())
  expect(calls.filter(Boolean)).toHaveLength(SETTINGS_GET_DIAG_CALLS)
})

test('첨부 대기는 제한 시간 안에 끝나면 끝난 상태를 알려 준다', async () => {
  const started = Date.now()
  await expect(settleWithin(Promise.resolve('done'), ATTACH_WAIT_MS)).resolves.toBe('fulfilled')
  await expect(settleWithin(Promise.reject(new Error('attach failed')), ATTACH_WAIT_MS)).resolves.toBe('rejected')
  expect(Date.now() - started).toBeLessThan(ATTACH_WAIT_MS)
})

test('첨부가 상한을 넘기면 시간 초과로 돌아오고, 원래 오류는 그대로 재던져진다', async () => {
  const hang = new Promise<never>(() => {}) // 끝나지 않는 첨부
  const started = Date.now()
  await expect(settleWithin(hang, 60)).resolves.toBe('timeout')
  const waited = Date.now() - started
  expect(waited).toBeGreaterThanOrEqual(50)
  expect(waited).toBeLessThan(2_000)

  // 실패 경로 본문과 같은 모양 — 첨부가 늦어도 원래 기동 오류가 그대로 올라온다.
  const launchError = new Error('titlebar never appeared')
  const rethrow = async (): Promise<void> => {
    try {
      throw launchError
    } catch (error) {
      await settleWithin(hang, 30)
      throw error
    }
  }
  await expect(rethrow()).rejects.toThrow('titlebar never appeared')
})

test('상한 값 자체를 고정한다 — 늘리려면 검토를 다시 받아야 한다', () => {
  expect(STARTUP_DIAG_LIMITS).toEqual({ perStage: 3, total: 40 })
  expect(STARTUP_WINDOW_MS).toBe(20_000)
  expect(SETTINGS_GET_DIAG_CALLS).toBe(3)
  expect(ATTACH_WAIT_MS).toBe(3_000)
})
