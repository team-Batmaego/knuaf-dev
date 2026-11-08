import { defineConfig } from '@playwright/test'
import { cleanupTmpdir, isolateTmpdir } from './e2e/tmp-run'

// 이 실행이 만든 임시 폴더는 `$TMPDIR` 이 아니라 이 실행 전용 뿌리 아래로 모인다 — 종료에 뿌리째
// 지운다(`e2e/tmp-run.ts`). 스펙마다 teardown 을 달지 않아도 누락이 생기지 않는다.
isolateTmpdir()
process.once('exit', cleanupTmpdir)

/**
 * `live-*.spec.ts` drive a real, logged-in Claude/Codex CLI and spend real
 * subscription usage, so they are opt-in: `KNUAF_LIVE=1 pnpm test:e2e`.
 * Without the flag they are ignored entirely — CI must be able to run
 * `pnpm test:e2e` without a login, a network, or a 45-minute budget.
 */
const live = process.env.KNUAF_LIVE === '1'

/**
 * `window-shots.spec.ts` 는 실제 창을 맨 앞으로 올려 화면을 찍는 안내서 사진 생성기라,
 * 창을 화면에 띄우지 않는 기본 실행과 양립하지 않는다. `KNUAF_WINDOW_SHOTS=1` 일 때만 돈다
 * (`KNUAF_LIVE` 와 같은 방식의 선택 실행).
 */
const windowShots = process.env.KNUAF_WINDOW_SHOTS === '1'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  // 가끔만 깨지는 실패는 다음 통과 실행이 test-results 를 지워 버려서 원인을 못 본다.
  // retries 를 올리면 실패가 초록에 묻히므로 올리지 않고, 대신 흔적만 남긴다.
  // (materials.spec 이 전체 실행에서 8번 중 2번 깨졌는데 기록이 남지 않아 못 팠다.)
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  testIgnore: [...(live ? [] : ['**/live-*.spec.ts']), ...(windowShots ? [] : ['**/window-shots.spec.ts'])],
  // 시험이 하나라도 실패해도 돈다 — 지우는 것은 임시 작업 폴더뿐이고 실패 증거는 test-results 에 남는다.
  globalTeardown: './e2e/tmp-run.ts'
})
