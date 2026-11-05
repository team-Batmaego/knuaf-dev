import { defineConfig } from '@playwright/test'

// Explicit allowlist: these specs use Node VM/IPC doubles, never Electron/browser fixtures.
// Do not inherit playwright.config.ts or add mixed GUI/store specs such as model-chip.spec.ts.
export default defineConfig({
  testDir: 'e2e',
  testMatch: ['preparation-main.spec.ts', 'preparation-state.spec.ts'],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/node'
})
