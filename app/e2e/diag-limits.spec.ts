/**
 * 진단 상한 회귀 시험(검토 I-01·I-02·roh290b). Node 단위 — Electron 창 없이.
 *
 * 고정하는 계약:
 *  - 기동 표식은 **단계당 3줄·창당 40줄**을 넘지 않는다(반복 이벤트가 main 스레드에서 동기 쓰기를
 *    무한히 돌리지 않는다).
 *  - 기동 구간은 한 번만 닫히고, 닫힌 뒤에는 어떤 표식도 남지 않는다(구독을 떼는 것과 같은 효과).
 *  - 구간을 닫는 자리는 **창 닫힘과 시간 상한** 둘뿐이다 — 첫 `ready-to-show`·`did-finish-load`
 *    는 값만 남긴다. 그 둘은 제목줄이 떴다는 신호가 아니라서, 그때 닫으면 제목줄 대기 구간의
 *    renderer-gone·unresponsive·콘솔 오류를 놓친다(roh290b 새 결함).
 *  - 시간 상한은 제목줄 대기까지 덮는 **60초**다.
 *  - `settings:get` 진단은 첫 3회만 남긴다.
 */
import { expect, test } from '@playwright/test'
import {
  createCallGate,
  createStartupDiag,
  SETTINGS_GET_DIAG_CALLS,
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
  // 구간을 닫는 자리는 창 닫힘과 시간 상한 둘뿐이다 — 첫 표시·첫 load 완료는 값만 남긴다
  // (`index.ts` 의 `onReadyToShow`·`onLoadFinished` 는 `close` 를 부르지 않는다).
  expect(diag.close('window-closed')).toBe(true)
  expect(diag.closed()).toBe('window-closed')
  // 두 번째 닫기는 false — 먼저 온 쪽(창 닫힘/시간 상한)이 이유를 정한다.
  expect(diag.close('deadline')).toBe(false)
  expect(diag.closed()).toBe('window-closed')
  expect(diag.allow('startup:renderer-console')).toBe(false)
  expect(diag.count()).toBe(1)
})

test('settings:get 진단은 첫 몇 번만 남긴다', () => {
  const gate = createCallGate(SETTINGS_GET_DIAG_CALLS)
  const calls = Array.from({ length: SETTINGS_GET_DIAG_CALLS + 5 }, () => gate())
  expect(calls.filter(Boolean)).toHaveLength(SETTINGS_GET_DIAG_CALLS)
})

test('상한 값 자체를 고정한다 — 늘리려면 검토를 다시 받아야 한다', () => {
  expect(STARTUP_DIAG_LIMITS).toEqual({ perStage: 3, total: 40 })
  // 60초: 제목줄 대기(helpers.ts `waitForSelector('.titlebar')`)까지 덮어야 한다.
  expect(STARTUP_WINDOW_MS).toBe(60_000)
  expect(SETTINGS_GET_DIAG_CALLS).toBe(3)
})
