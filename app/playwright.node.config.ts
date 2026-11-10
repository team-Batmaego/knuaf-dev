import { defineConfig } from '@playwright/test'
import { cleanupTmpdir, isolateTmpdir } from './e2e/tmp-run'

// 이 실행이 만든 임시 폴더는 실행 전용 뿌리 아래로 모이고 종료에 지운다(`e2e/tmp-run.ts`).
isolateTmpdir()
process.once('exit', cleanupTmpdir)

// Explicit allowlist: these specs use Node VM/IPC doubles, never Electron/browser fixtures.
// Do not inherit playwright.config.ts or add mixed GUI/store specs such as model-chip.spec.ts.
export default defineConfig({
  testDir: 'e2e',
  testMatch: ['preparation-main.spec.ts', 'preparation-state.spec.ts', 'artifact-refresh-store.spec.ts', 'chat-markdown.spec.ts', 'notice-bubble.spec.ts'],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/node',
  globalTeardown: './e2e/tmp-run.ts'
})
