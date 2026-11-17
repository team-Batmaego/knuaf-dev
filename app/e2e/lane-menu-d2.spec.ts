import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, openProject, setWindowBounds } from './helpers'
import { fakeCodexEnv, questionProject, scratch, seedChat, userDataWith } from './fixtures/fake-codex'
import { MESSAGES, inject, shoot, snapshot } from './fixtures/lanes'

test('D2 모델 메뉴: 꺼짐, 추천, 켜짐, 역할과 추론, 예약', async () => {
  test.setTimeout(180_000)
  const dir = scratch()
  const root = questionProject()
  seedChat(root, MESSAGES)
  const models = [
    { id: 'gpt-sol', model: 'gpt-sol', displayName: 'GPT-6.1 Sol', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { id: 'gpt-astra', model: 'gpt-astra', displayName: 'GPT-6 Astra', description: '', hidden: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }
  ]
  const { electronApp, page } = await launch({
    colorScheme: 'light',
    env: fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_MODELS: JSON.stringify(models) }),
    userData: userDataWith(dir, { permission_mode: 'trust', helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  })
  try {
    await setWindowBounds(electronApp, 1180, 800)
    await openProject(page, root)
    await page.locator('.chat-msg').first().waitFor()
    const off = snapshot(root, 50, { version: 1, settings: { mode: 'off', recommendedRowId: 'codex-high', source: { kind: 'none' }, rows: [], differsFromRecommendation: false, temporary: [], recommendedDesign: null, nextDesignCompany: null, pendingDesign: null, consents: [] } })
    await page.evaluate((value) => {
      const lanes = {
        setPlacement: async (...args: unknown[]) => { Reflect.set(window, '__placementArgs', args); return { result: { outcome: 'applied', version: 2 } } },
        snapshot: async () => ({ result: value }), onSnapshot: () => () => undefined,
        laneModels: async () => ({ result: [{ company: 'codex', models: [
          { model: 'gpt-sol', name: 'GPT-6.1 Sol', efforts: ['low'] },
          { model: 'gpt-astra', name: 'GPT-6 Astra', efforts: ['low', 'high'] }
        ] }] })
      }
      window.dispatchEvent(new CustomEvent('knuaf:lanes-seam-test', { detail: { lanes, jobs: {} } }))
    }, off)
    await inject(page, off)
    const chip = page.getByTitle('이 논문의 도우미')
    await chip.click()
    const menu = page.locator('.composer-model-host .popover')
    await expect(menu.getByRole('switch', { name: /Team/ })).toHaveAttribute('aria-checked', 'false')
    await expect(chip).toContainText('GPT-6.1 Sol · high · Team off')
    await expect(menu.getByRole('button', { name: /GPT-6.1 Sol · high/ })).toBeVisible()
    await menu.getByRole('switch', { name: /Team/ }).click()
    await expect.poll(() => page.evaluate(() => { const args: unknown = Reflect.get(window, '__placementArgs'); return Array.isArray(args) ? args[3] : null })).toEqual({ kind: 'recommended', rowId: 'codex-high' })
    await expect.poll(() => page.evaluate(() => { const args: unknown = Reflect.get(window, '__placementArgs'); return Array.isArray(args) ? args[1] : null })).toBe(1)
    await shoot(page, 'd2-off')
    await menu.getByRole('button', { name: /추천 배치/ }).click()
    await expect(menu.getByRole('button', { name: /ChatGPT 낮은 플랜만/ })).toBeVisible()
    await shoot(page, 'd2-recommendations')
    await menu.getByRole('button', { name: '추천 배치', exact: true }).click()
    const rows = ['research', 'writing', 'repeat', 'review'].map((lane) => ({ lane, entry: { company: 'codex', model: 'gpt-astra', effort: 'high', how: 'relay' }, note: null, recommendedModel: null }))
    const on = snapshot(root, 51, { version: 2, settings: { mode: 'on', source: { kind: 'recommended', rowId: 'codex-high' }, rows, differsFromRecommendation: false, temporary: [], recommendedDesign: null, nextDesignCompany: null, pendingDesign: null, consents: [] } })
    await inject(page, on)
    await expect(menu.getByRole('switch', { name: /Team/ })).toHaveAttribute('aria-checked', 'true')
    await shoot(page, 'd2-on')
    await menu.getByRole('button', { name: /자료 찾기/ }).click()
    await expect(menu.getByText('추론', { exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'high', exact: true })).toBeVisible()
    await shoot(page, 'd2-role-effort')
    await menu.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click()
    await expect.poll(() => page.evaluate(() => { const args: unknown = Reflect.get(window, '__placementArgs'); if (!Array.isArray(args) || !args[2] || typeof args[2] !== 'object') return null; return Reflect.get(args[2], 'research') })).toMatchObject({ model: 'gpt-sol', effort: 'low', how: 'relay' })
    await menu.getByRole('button', { name: 'low', exact: true }).click()
    await expect.poll(() => page.evaluate(() => { const args: unknown = Reflect.get(window, '__placementArgs'); return Array.isArray(args) ? args[3] : null })).toEqual({ kind: 'mine' })
    await expect.poll(() => page.evaluate(() => { const args: unknown = Reflect.get(window, '__placementArgs'); if (!Array.isArray(args) || !args[2] || typeof args[2] !== 'object') return null; return Reflect.get(args[2], 'research') })).toMatchObject({ model: 'gpt-astra', effort: 'low', how: 'relay' })
    await menu.getByRole('button', { name: '자료 찾기', exact: true }).click()
    await inject(page, snapshot(root, 52, { version: 2, settings: { ...(on.settings as object), nextDesignCompany: 'claude', pendingDesign: { company: 'claude', model: 'opus', effort: 'high' } } }))
    await expect(menu).toContainText('다음 새 대화부터 Claude opus · high')
    await shoot(page, 'd2-reserved')
  } finally {
    await electronApp.close()
  }
})
