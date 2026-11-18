import { expect, test } from '@playwright/test'
import { launch } from './helpers'

test('support stays in the app and the update card follows app availability and width', async () => {
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin' } })
  try {
    await electronApp.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 900)
      shell.openExternal = async () => { (globalThis as typeof globalThis & { supportExternal?: boolean }).supportExternal = true }
    })
    const sidebar = page.locator('.project-sidebar')
    const support = sidebar.getByRole('button', { name: '개발자 응원하기' })
    await expect(support).toBeVisible()
    await support.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '개발자 응원하기' })
    await expect(dialog).toContainText('알고 계셨나요?')
    await expect(dialog).toContainText('논문 도우미, 외주로 맡기면 꽤 비싸요.')
    await expect(dialog).toContainText('도움이 됐다면 소정의 응원 부탁드려요.')
    await expect(dialog).toContainText('토스')
    await expect(dialog).toContainText('카카오페이')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(support).toBeFocused()
    await support.click()
    await dialog.getByRole('button', { name: '닫기' }).click()
    await expect(dialog).not.toBeVisible()
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { supportExternal?: boolean }).supportExternal)).toBeUndefined()

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app-update:status', {
      phase: 'available', current: '0.6.0', latest: '99.0.0', page: null
    }))
    const card = sidebar.locator('.sidebar-update-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('새 판이 준비됐어요')
    await card.getByRole('button', { name: '업데이트' }).click()
    await expect(page.getByRole('dialog', { name: '새 앱 99.0.0이 나왔어요' })).toBeVisible()
    await page.getByRole('button', { name: '나중에' }).click()
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 900))
    await page.getByRole('button', { name: '프로젝트 목록', exact: true }).click()
    await expect(support).toBeVisible()
    await expect(card).toBeHidden()
    await support.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
  } finally { await electronApp.close() }
})
