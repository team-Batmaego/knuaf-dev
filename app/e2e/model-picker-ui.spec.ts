import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expectConnected, launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'
import type { ChatSnapshot } from '../src/shared/chat'

const option = (model: string, name: string, hidden = false) => ({
  id: model, model, displayName: name, hidden, description: `${name} 모델 설명`,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }]
})
const lowModels = [option('gpt-terra', 'Terra'), option('gpt-luna', 'Luna'), option('gpt-hidden-sol', 'Sol', true)]
const highModels = [option('gpt-sol', 'Sol'), option('gpt-astra', 'Astra'), option('gpt-terra', 'Terra'), option('gpt-luna', 'Luna')]

async function scene(models = highModels, colorScheme: 'light' | 'dark' = 'light', extra: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODELS: JSON.stringify(models), FAKE_CODEX_REPLY: replyFile(dir, '작업을 마쳤어요.'), ...extra })
  writeFakeClaude(bin)
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' }, ...settings })
  const app = await launch({ env, userData, colorScheme })
  return { ...app, dir, userData }
}

test('폴더를 고르기 전 주 모델과 추론 단계를 고르고 첫 전송에 적용한다', async () => {
  const dir = scratch()
  const log = join(dir, 'turns.jsonl')
  const { electronApp, page } = await scene(highModels, 'light', { FAKE_CODEX_TURN_LOG: log })
  const root = synthProject({ withContent: false })
  try {
    await expectConnected(page)
    const chip = page.getByTitle('이 논문의 도우미')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await expect(popup.getByRole('switch', { name: /Team/ })).toBeDisabled()
    await popup.locator('[data-submenu="true"]').first().click()
    await popup.getByRole('button', { name: 'Sol', exact: true }).click()
    await popup.getByRole('button', { name: 'high', exact: true }).click()
    await expect(chip).toContainText('Sol · high')
    await page.keyboard.press('Escape')
    await openProject(page, root)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('첫 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => existsSync(log) ? readFileSync(log, 'utf8').trim() : '').toBe(JSON.stringify({ model: 'gpt-sol', effort: 'high' }))
  } finally { await electronApp.close() }
})

for (const tier of ['low', 'high'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${tier} 계정 · ${theme}: 모델과 추천 배치가 1440·1024 창 안에 맞는다`, async ({}, info) => {
      const { electronApp, page } = await scene(tier === 'low' ? lowModels : highModels, theme)
      const root = synthProject()
      seedChat(root, [{ id: 'a0', role: 'assistant', text: 'Ⅰ. 머리말을 저장했어요.', at: new Date().toISOString() }])
      try {
        await openProject(page, root)
        const chip = page.getByTitle('이 논문의 도우미')
        await expectConnected(page)
        for (const width of [1440, 1024]) {
          await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 900 }), width)
          await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
          await chip.click()
          const popup = page.locator('.composer-model-host .popover')
          await popup.locator('[data-submenu="true"]').first().click()
          await expect(popup.getByRole('button', { name: 'Terra', exact: true })).toBeVisible()
          await expect(popup.getByRole('button', { name: 'Luna', exact: true })).toBeVisible()
          if (tier === 'low') await expect(popup.getByRole('button', { name: 'Sol', exact: true })).toHaveCount(0)
          else await expect(popup.getByRole('button', { name: 'Sol', exact: true })).toBeVisible()
          await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveCount(0)
          await expect(popup.getByRole('button', { name: '모델 목록 새로고침', exact: true })).toHaveCount(0)
          await popup.getByRole('button', { name: '주 모델', exact: true }).click()
          await popup.getByRole('button', { name: '추천 배치', exact: true }).click()
          await expect(popup.getByRole('button', { name: /ChatGPT 낮은 플랜만/ })).toContainText('주 모델')
          await expect(popup.getByRole('button', { name: /ChatGPT 높은 플랜만/ })).toContainText('검토')
          const bounds = await popup.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.y).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900)
          const footer = popup.getByRole('button', { name: /둘 다 낮은 플랜/ })
          await footer.scrollIntoViewIfNeeded()
          await expect(footer).toBeVisible()
          const captureDir = process.env.KNUAF_CHIP_CAPTURE_DIR
          if (captureDir) mkdirSync(captureDir, { recursive: true })
          await page.screenshot({ path: captureDir ? join(captureDir, `chip-${tier}-${theme}-${width}.png`) : info.outputPath(`chip-${width}.png`) })
          await page.keyboard.press('Escape')
          await expect(popup).toHaveCount(0)
          await expect(chip).toBeFocused()
        }
      } finally { await electronApp.close() }
    })
  }
}

test('폴더 없이 모델·깊이를 고르고 다음 메시지부터 같은 대화에서 바꾼다', async () => {
  const dir = scratch()
  const log = join(dir, 'turns.jsonl')
  const { electronApp, page } = await scene(highModels, 'light', {
    FAKE_CODEX_TURN_LOG: log,
    // app-server 재기동 뒤에도 같은 대화의 모델·깊이는 남는다(실제 서버 계약).
    FAKE_CODEX_THREAD_STATE: join(dir, 'thread.json')
  })
  const root = synthProject({ withContent: false })
  const chatFile = join(root, '.knuaf-gui', 'chat-codex.json')
  const snapshot = () => JSON.parse(readFileSync(chatFile, 'utf8')) as ChatSnapshot
  const turns = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const waitForTurn = async (text: string, count: number) => {
    // 답변 표시·요청 도착은 턴 완료가 아니다. 해당 메시지의 정상 종료와 저장을 기다린다.
    await expect.poll(() => {
      const chat = snapshot()
      const users = chat.messages.filter((message) => message.role === 'user')
      return { state: chat.state, count: users.length, text: users.at(-1)?.text, delivery: users.at(-1)?.delivery }
    }).toEqual({ state: 'idle', count, text, delivery: 'sent' })
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeVisible()
  }
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expectConnected(page)
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.locator('[data-submenu="true"]').first().click()
    await popup.getByRole('button', { name: 'Sol', exact: true }).click()
    await expect(popup.getByRole('button', { name: 'Sol', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await popup.getByRole('button', { name: 'high', exact: true }).click()
    await expect(chip).toContainText('Sol · high')
    await page.keyboard.press('Escape')
    // 폴더 선택으로 모델 설정이 바뀌지 않는다. 이후 실제 IPC 전송값을 확인한다.
    await openProject(page, root)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('전체 설계를 해 주세요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('작업을 마쳤어요.', { exact: true })).toBeVisible()
    await waitForTurn('전체 설계를 해 주세요', 1)
    expect(turns()).toEqual([{ model: 'gpt-sol', effort: 'high' }])
    const first = snapshot()
    await chip.click()
    await popup.locator('[data-submenu="true"]').first().click()
    await popup.getByRole('button', { name: 'Terra', exact: true }).click()
    await expect(chip).toContainText('Terra')
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('이어서 써 주세요')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await waitForTurn('이어서 써 주세요', 2)
    expect(turns()).toEqual([{ model: 'gpt-sol', effort: 'high' }, { model: 'gpt-terra', effort: 'high' }])
    await chip.click()
    await popup.locator('[data-submenu="true"]').first().click()
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const last = snapshot()
    expect(last.sessionId).toBe(first.sessionId)
    expect(last.sessionId).toBeTruthy()
  } finally { await electronApp.close() }
})

test('다른 공급자 모델은 주 모델 목록에 나오지 않는다 (DQA-01)', async () => {
  const mixed = [
    ...highModels,
    option('anthropic/claude-sonnet-4', 'Claude Sonnet 4'),
    // 실측: Terra 추천이 다른 공급자 id에 붙던 장면. 본래 목록에는 없는 그 모델을 거른다.
    option('commandcode-auth/gpt-5.6-terra', 'Terra')
  ]
  const { electronApp, page } = await scene(mixed)
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expectConnected(page)
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.locator('[data-submenu="true"]').first().click()
    const rows = popup.locator('.pop-row[aria-pressed]')
    await expect(rows).toHaveCount(4)
    await expect(rows.filter({ hasText: 'Claude Sonnet 4' })).toHaveCount(0)
    await expect(rows.filter({ hasText: 'Terra' })).toHaveCount(1)
  } finally { await electronApp.close() }
})

test('여러 세대 모델을 주 모델 목록에서 각각 고를 수 있다', async () => {
  const names = ['GPT-6-Astra', 'GPT-6-Luna', 'GPT-6.1-Sol', 'GPT-5.5', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-6-Sol', 'GPT-6.1 Terra']
  const { electronApp, page } = await scene(names.map((name) => option(name, name)))
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expectConnected(page)
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.locator('[data-submenu="true"]').first().click()
    await expect(popup.locator('.pop-row[aria-pressed]')).toHaveCount(names.length)
    for (const name of names) await expect(popup.getByRole('button', { name, exact: true })).toBeVisible()
  } finally { await electronApp.close() }
})


test('빈 목록에서 계정을 바꿔도 안 고름 줄을 표시하지 않는다 (U1)', async () => {
  const { electronApp, page } = await scene([])
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expectConnected(page)
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.locator('[data-submenu="true"]').first().click()
    await expect(popup.locator('.pop-row[aria-pressed]')).toHaveCount(0)
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveCount(0)
    await popup.getByRole('button', { name: '주 모델', exact: true }).click()
    await popup.getByRole('button', { name: 'AI 회사·로그인', exact: true }).click()
    await popup.getByRole('button', { name: 'Claude로 바꾸기' }).click()
    await expectConnected(page, 'claude')
    await chip.click()
    await popup.locator('[data-submenu="true"]').first().click()
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveCount(0)
  } finally { await electronApp.close() }
})

test('목록 오류는 재조회로 복구하고 실패 중에도 계정 기본 선택과 초안을 지킨다', async () => {
  const { electronApp, page } = await scene(highModels, 'light', { FAKE_CODEX_MODELS_FAIL_TIMES: '1' })
  try {
    const draft = page.getByRole('textbox', { name: '답변을 입력하세요' })
    await draft.fill('쓰던 문장은 남겨 주세요')
    const chip = page.getByTitle('이 논문의 도우미')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await expect(popup.getByRole('alert')).toContainText('모델 목록을 불러오지 못했어요.')
    await expect(popup.getByRole('button', { name: /안 고름/ })).toHaveCount(0)
    await popup.getByRole('button', { name: '모델 목록 새로고침', exact: true }).click()
    await expect(popup.getByRole('button', { name: '모델 목록 새로고침', exact: true })).toHaveCount(0)
    await popup.locator('[data-submenu="true"]').first().click()
    await expect(popup.locator('.pop-row[aria-pressed]')).toHaveCount(4)
    await expect(popup.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(draft).toHaveValue('쓰던 문장은 남겨 주세요')
  } finally { await electronApp.close() }
})

test('긴 모델 목록은 제목줄 아래에서 시작하고 처음과 끝에 모두 닿는다', async ({}, info) => {
  const models = Array.from({ length: 24 }, (_, i) => option(`gpt-example-${i}`, `모델 ${i + 1}`))
  const { electronApp, page } = await scene(models)
  const root = synthProject()
  seedChat(root, [{ id: 'a0', role: 'assistant', text: '이전 대화', at: new Date().toISOString() }])
  try {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 750 }))
    await openProject(page, root)
    await page.getByTitle('이 논문의 도우미').click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.locator('[data-submenu="true"]').first().click()
    const rows = popup.locator('.pop-row[aria-pressed]')
    await expect(rows).toHaveCount(24)
    await rows.first().scrollIntoViewIfNeeded()
    await expect(rows.first()).toBeVisible()
    const captureDir = process.env.KNUAF_CHIP_CAPTURE_DIR
    if (captureDir) mkdirSync(captureDir, { recursive: true })
    await page.screenshot({ path: captureDir ? join(captureDir, 'long-models.png') : info.outputPath('long-models.png') })
    const [header, panel] = await Promise.all([
      page.locator('.titlebar').boundingBox(), popup.boundingBox()
    ])
    expect(header && panel).toBeTruthy()
    expect(panel!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
    await rows.last().scrollIntoViewIfNeeded()
    await expect(rows.last()).toBeVisible()
  } finally { await electronApp.close() }
})
