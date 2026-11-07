import { expect, test } from '@playwright/test'
import { launch } from './helpers'

const SPLASH = '.splash[role="status"][aria-label="창업논문 도우미 여는 중이에요"]'

test('the shipped startup splash remains visible for at least 5.3 seconds and then yields the app', async () => {
  const { electronApp, page } = await launch({ splash: 'keep' })
  try {
    const splash = page.locator(SPLASH)
    await expect(splash).toBeVisible()
    await expect(page.locator('.titlebar')).toBeVisible()
    const mountedAt = await splash.evaluate(() => performance.now())
    await expect(splash).toHaveCount(0, { timeout: 10_000 })
    const detachedAt = await page.evaluate(() => performance.now())
    expect(detachedAt - mountedAt).toBeGreaterThanOrEqual(5_250)
    await expect(page.locator('.chat-pane')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
