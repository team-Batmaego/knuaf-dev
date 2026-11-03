import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './helpers'
import { fakeCodexEnv, scratch, userDataWith } from './fixtures/fake-codex'

async function openFromMenu(electronApp: ElectronApplication, root: string): Promise<void> {
  await electronApp.evaluate(({ dialog, BrowserWindow }, selected) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected], bookmarks: [] })) as typeof dialog.showOpenDialog
    BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-folder' })
  }, root)
}

test('ALWAYS_OTHER_FOLDER: first-run always approval is global across different roots', async () => {
  const dir = scratch()
  const first = join(dir, 'first-paper')
  const other = join(dir, 'other-paper')
  const decisions = join(dir, 'decisions.jsonl')
  mkdirSync(first)
  mkdirSync(other)
  const userData = userDataWith(dir, {
    permission_mode: 'ask',
    trusted_roots: [realpathSync(first).normalize('NFC')],
    helper_mode: 'codex-chat',
    provider_choice: { provider: 'codex', at: '' }
  })
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_ASK: '1', FAKE_CODEX_DECISION_LOG: decisions })
  const { electronApp, page } = await launch({ userData, env, permissionPrompt: true })
  try {
    await openFromMenu(electronApp, first)
    const gate = page.locator('dialog[data-screen="first-project-gate"]')
    await expect(gate).toBeVisible()
    await gate.getByRole('button', { name: '항상 허용' }).click()
    await expect(page.locator('.chat-pane')).toBeVisible({ timeout: 30000 })
    const settings = await page.evaluate(() => window.knuaf.getSettings())
    expect(settings.permission_mode).toBe('trust')
    expect(settings.trusted_roots).toEqual([realpathSync(first).normalize('NFC')])

    await openFromMenu(electronApp, other)
    await expect.poll(async () => (await page.evaluate(() => window.knuaf.getSettings())).recent[0]?.root).toBe(other)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('다른 논문에서 명령 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => existsSync(decisions) ? readFileSync(decisions, 'utf8') : '').toContain('"decision":"accept"')
    await expect(page.locator('.askcard')).toHaveCount(0)
  } finally { await electronApp.close() }
})

test('ASK_EXISTING_TRUST: first-run ask clears a legacy trusted root and shows the real approval card', async () => {
  const dir = scratch()
  const root = join(dir, 'already-trusted-paper')
  const decisions = join(dir, 'decisions.jsonl')
  mkdirSync(root)
  const userData = userDataWith(dir, {
    permission_mode: 'ask',
    trusted_roots: [realpathSync(root).normalize('NFC')],
    helper_mode: 'codex-chat',
    provider_choice: { provider: 'codex', at: '' }
  })
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_ASK: '1', FAKE_CODEX_DECISION_LOG: decisions })
  const { electronApp, page } = await launch({ userData, env, permissionPrompt: true })
  try {
    await openFromMenu(electronApp, root)
    const gate = page.locator('dialog[data-screen="first-project-gate"]')
    await expect(gate).toBeVisible()
    await gate.getByRole('button', { name: '매번 묻기' }).click()
    await expect(page.locator('.chat-pane')).toBeVisible({ timeout: 30000 })
    const settings = await page.evaluate(() => window.knuaf.getSettings())
    expect(settings.permission_mode).toBe('ask')
    expect(settings.trusted_roots).toEqual([])

    await expect(page.getByRole('button', { name: '새로 시작하기' })).toBeVisible()
    await page.getByRole('button', { name: '새로 시작하기' }).click()
    await expect(page.locator('.askcard')).toBeVisible({ timeout: 30000 })
    expect(existsSync(decisions) ? readFileSync(decisions, 'utf8') : '').toBe('')
  } finally { await electronApp.close() }
})
