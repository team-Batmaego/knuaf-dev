import { defineConfig } from '@playwright/test'
import { cleanupTmpdir, isolateTmpdir } from './e2e/tmp-run'

// 이 실행이 만든 임시 폴더는 실행 전용 뿌리 아래로 모이고 종료에 지운다(`e2e/tmp-run.ts`).
isolateTmpdir()
process.once('exit', cleanupTmpdir)

// Explicit allowlist: these specs use Node VM/IPC doubles, never Electron/browser fixtures.
// Do not inherit playwright.config.ts or add mixed GUI/store specs such as model-chip.spec.ts.
export default defineConfig({
  testDir: 'e2e',
  // v0.6.4: 진행 파일·링크 열기 시험(배포 갈래) + 가드 시험(배포 갈래) + 표·사진·배치 시험(main) + 뷰어 편집 시험(이 갈래)을 함께 둔다.
  testMatch: [
    'preparation-main.spec.ts',
    'preparation-state.spec.ts',
    'artifact-refresh-store.spec.ts',
    'chat-markdown.spec.ts',
    'paper-images.spec.ts',
    'layout.spec.ts',
    'edits-store.spec.ts',
    'recheck.spec.ts',
    'progress-list.spec.ts',
    'progress-file.spec.ts',
    'link-open.spec.ts',
    'guard-scope.spec.ts',
    'guard-key.spec.ts',
    'guard-scan-store.spec.ts',
    'guard-reconcile.spec.ts',
    'guard-instructions.spec.ts',
    'guard-rules.spec.ts',
    'guard-roh-stage1.spec.ts',
    'guard-roh-stage2.spec.ts',
    'guard-codex-tool-lock.spec.ts',
    'guard-codex-thread-lock.spec.ts',
    'guard-codex-connection.spec.ts',
    'guard-claude-skill-host.spec.ts',
    'notice-bubble.spec.ts'
  ],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/node',
  globalTeardown: './e2e/tmp-run.ts'
})
