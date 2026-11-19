// U1 화면 확인 — 실제 Electron 창에서 칩이 모델·깊이를 그리는지 본다.
// 가짜 CLI만 띄운다(실제 AI 호출 0회). 이 시험은 **화면에 보이는 것**을 고정한다:
//  - Claude 로 대화할 때 칩을 열면 이 계정의 모델 목록과 그 모델의 깊이 단계가 뜬다.
//  - 모델마다 깊이 목록이 다르다(Opus: low~max, Sonnet: low~high) — 줄이지 않는다.
//  - ultra 를 고르면 자동 분담 안내 한 줄이 칩 안에 뜬다.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, writeCliShim } from './fixtures/fake-codex'

const MODELS = [
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '가장 깊은 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '일상 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
]

/** 가짜 CLI 자리와 첫 화면 상태(온보딩 끝, 고른 AI 고정). */
function scene(mode: 'claude-chat' | 'codex-chat', extra: { SETTINGS?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kd-u1-ui-'))
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  writeCliShim(dir, 'claude',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
    `"${process.execPath}" "${fixture}" %*`)
  const userData = join(dir, 'userdata')
  mkdirSync(userData, { recursive: true })
  const settings: Record<string, unknown> = {
    show_intro: false, onboarded_at: new Date().toISOString(),
    first_project_permission_asked_at: new Date().toISOString(),
    helper_mode: mode, provider_choice: { provider: mode === 'claude-chat' ? 'claude' : 'codex', at: '' }
  }
  if (extra.SETTINGS) Object.assign(settings, JSON.parse(extra.SETTINGS) as Record<string, unknown>)
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  return { dir, userData, root: synthProject({ withContent: false }) }
}

test('U1 화면: Claude 칩에서 모델과 생각 깊이를 고를 수 있다', async () => {
  const s = scene('claude-chat')
  const { electronApp, page } = await launch({
    userData: s.userData,
    env: fakeCodexEnv(s.dir, { W1_MODELS: JSON.stringify(MODELS), W1_QUERY_LOG: join(s.dir, 'query.jsonl') })
  })
  try {
    await openProject(page, s.root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toBeEnabled()

    await chip.click()
    const dialog = page.getByRole('dialog', { name: '이 논문의 도우미' })
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-submenu="true"]').first().click()
    await expect(dialog.getByText('Claude', { exact: true })).toBeVisible()

    // 모델마다 지원하는 추론 단계가 다르다.
    await dialog.getByRole('button', { name: 'Opus', exact: true }).click()
    const depth = dialog.getByRole('group', { name: '추론 단계' })
    await expect(depth.getByRole('button')).toHaveText(['low', 'medium', 'high', 'xhigh', 'max'])
    await dialog.getByRole('button', { name: 'Sonnet', exact: true }).click()
    await expect(depth.getByRole('button')).toHaveText(['low', 'medium', 'high'])
    await expect(chip).toContainText('Sonnet')
  } finally {
    await electronApp.close()
  }
})

test('U1 화면: ultra·무거운 모델을 골라도 한도 안내 줄은 뜨지 않는다', async () => {
  const s = scene('codex-chat', {
    SETTINGS: JSON.stringify({ chat_models: { codex: { model: 'gpt-6-sol', effort: 'ultra' } } })
  })
  const models = [{
    id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((e) => ({ reasoningEffort: e }))
  }]
  const { electronApp, page } = await launch({
    userData: s.userData,
    env: fakeCodexEnv(s.dir, { FAKE_CODEX_MODELS: JSON.stringify(models) })
  })
  try {
    await openProject(page, s.root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()
    const dialog = page.getByRole('dialog', { name: '이 논문의 도우미' })
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-submenu="true"]').first().click()
    await expect(dialog.getByRole('group', { name: '추론 단계' }).getByRole('button', { name: 'ultra', exact: true })).toBeVisible()
    // 한도 안내 줄은 뺐다(형님 11-13) — 울트라를 골라도 '한도' 문장이 뜨지 않는다.
    await expect(dialog.getByText(/한도/)).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
