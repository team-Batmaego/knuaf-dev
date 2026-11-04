import { expect, test } from '@playwright/test'
import { launch, navTo } from './helpers'

test('an unavailable newer app does not look installable and explains why', async () => {
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin' } })
  try {
    await navTo(page, '설정')
    const section = page.getByRole('region', { name: '업데이트' })
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app-update:status', {
        phase: 'unavailable', current: '0.5.1', latest: null, page: null,
        message: '새 앱 0.6.0은 아직 이 컴퓨터용으로 준비 중이에요. 지금 앱은 그대로 쓸 수 있어요.'
      })
    })
    await expect(section.locator('p.caption', { hasText: '앱 판' })).toContainText('새 앱 0.6.0은 아직 이 컴퓨터용으로 준비 중이에요')
    await expect(page.locator('.titlebar').getByRole('button', { name: '업데이트', exact: true })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
