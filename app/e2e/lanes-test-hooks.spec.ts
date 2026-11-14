/**
 * 검토 I-01 — 시험 주입 통로가 **제품 실행에서 꺼져 있는가**를 실제 앱 표면에서 잰다.
 *
 * `store/lanes.ts` 의 세 리스너(`knuaf:lanes-test`·`-test-archive`·`-seam-test`)는 preload 가
 * `KNUAF_E2E_TEST_HOOKS=1` 을 보고 내보낸 `window.knuaf.testHooks` 가 `true` 일 때만 걸린다.
 * 이 스펙은 그 신호를 **실제 환경값으로 끄고**(`KNUAF_E2E_TEST_HOOKS: '0'`) 사건을 쏘아,
 * 진짜 renderer 안 스크립트가 화면 상태를 덮지 못함을 확인한다(`lanes-store.spec.ts` 의 음성 시험은
 * store 단위이고, 이 스펙은 preload → store 배선까지 포함한 표면이다).
 *
 * 같은 파일에서 신호를 켠 실행도 함께 재서, 음성 시험이 "아무것도 안 그려서 통과"가 아님을 보인다.
 * 실제 AI·실제 로그인은 부르지 않는다(가짜 codex, `fakeCodexEnv`).
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launch, openProject } from './helpers'
import { fakeCodexEnv, questionProject, scratch, seedChat, userDataWith } from './fixtures/fake-codex'
import { at, MESSAGES, progressLine, snapshot } from './fixtures/lanes'

/** 주입하려는 줄의 id — 이 줄이 화면에 뜨면 통로가 열린 것이다. */
const LINE_ID = 'line-injected-probe'

/**
 * 묶음 전체를 주입한다. `seq` 를 아주 크게 두는 이유: 고침 전 코드에서 이 통로는 `apply()` 의 순서
 * 검사를 건너뛰었으므로 큰 `seq` 하나로 뒤따르는 실제 묶음까지 막을 수 있었다(I-01 본문).
 */
async function injectProbe(page: Page, root: string): Promise<void> {
  const value = snapshot(root, 999_999, {
    lines: [progressLine(LINE_ID, 'job-injected', 'research', '주입된 줄', 1, 0,
      { company: 'codex', model: 'astra', effort: null })],
    stopButton: 'chat-and-lanes'
  })
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('knuaf:lanes-test', { detail }))
    window.dispatchEvent(new CustomEvent('knuaf:lanes-test-archive', { detail: { summary: { archiveId: 'a1' }, messages: [] } }))
    window.dispatchEvent(new CustomEvent('knuaf:lanes-seam-test', { detail: null }))
  }, value)
}

async function withApp(testHooks: '0' | '1', run: (page: Page, root: string) => Promise<void>): Promise<void> {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, MESSAGES)
  const { electronApp, page } = await launch({
    colorScheme: 'light',
    env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in', KNUAF_E2E_TEST_HOOKS: testHooks }),
    userData: userDataWith(dir, { permission_mode: 'trust' })
  })
  try {
    await openProject(page, root)
    await page.locator('.chat-msg').first().waitFor({ timeout: 30_000 })
    await run(page, root)
  } finally {
    await electronApp.close()
  }
}

test('제품 조건(시험 신호 off)에서는 세 시험 사건이 화면을 바꾸지 않는다', async () => {
  test.setTimeout(180_000)
  await withApp('0', async (page, root) => {
    // 신호가 실제로 꺼져 있는가 — 이 단언이 없으면 "리스너는 걸렸는데 무시"도 통과한다.
    expect(await page.evaluate(() => window.knuaf.testHooks)).toBe(false)

    await injectProbe(page, root)
    await page.waitForTimeout(800)

    await expect(page.locator(`#${LINE_ID}`)).toHaveCount(0)
    // 낭독 칸(`#lane-say`)도 비어 있다 — 주입 묶음의 낭독 사건이 화면에 닿지 않았다.
    await expect(page.locator('#lane-say')).toHaveText('')
  })
})

test('시험 신호 on 에서는 같은 주입이 실제로 화면에 닿는다', async () => {
  test.setTimeout(180_000)
  await withApp('1', async (page, root) => {
    expect(await page.evaluate(() => window.knuaf.testHooks)).toBe(true)

    await injectProbe(page, root)
    // 주입 묶음의 폴더가 지금 열어 둔 폴더와 같아야 화면에 그려진다(store 의 root 검사, I-01 (b)).
    await expect(page.locator(`#${LINE_ID}`)).toBeVisible({ timeout: 15_000 })
  })
})
