import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'

for (const failure of ['refresh', '401', '401-with-secret-marker', 'network', 'external401', 'external-unauthorized', 'refresh-network', 'bare401', 'rate'] as const) {
  test(`ChatGPT ${failure}: 인증 실패만 로그인 필요로 바뀌고 실제 재로그인 완료까지 유지한다`, async ({}, info) => {
    const dir = scratch(), bin = join(dir, 'bin'), complete = join(dir, 'login-complete')
    const env = fakeCodexEnv(bin, { FAKE_CODEX_TURN_FAILURE: failure, FAKE_CODEX_LOGIN_COMPLETE: complete, FAKE_CODEX_REPLY: replyFile(dir, '재로그인 뒤 이어진 답변') })
    writeFakeClaude(bin)
    const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
    const { electronApp, page } = await launch({ env, userData })
    const root = synthProject()
    seedChat(root, [{ id: 'previous', role: 'assistant', text: '이전 대화', at: new Date().toISOString() }])
    try {
      await openProject(page, root)
      const chip = page.getByTitle('이 논문의 도우미')
      await expect(chip).toContainText('연결됨')
      await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('전송할 내용')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(page.getByText('보냈는지 확인하지 못했어요')).toBeVisible()
      if (failure !== 'refresh' && failure !== '401' && failure !== '401-with-secret-marker') {
        await expect(chip).toContainText('연결됨')
        if (failure === 'refresh-network') await expect(page.getByText('네트워크 연결을 확인해 주세요.')).toBeVisible()
        if (failure === 'external-unauthorized' || failure === 'bare401') {
          await expect(page.getByText('요청 인증을 확인하지 못했어요.')).toBeVisible()
          await expect(page.getByText('내 논문 화면에서 ChatGPT 로그인을 다시 한 뒤 보내 주세요.')).toHaveCount(0)
        }
        return
      }
      await expect(chip).toContainText('로그인 필요')
      if (failure === '401-with-secret-marker') {
        const saved = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8'))
        expect(saved.error).not.toContain('SYNTHETIC-SENSITIVE-MARKER')
        await expect(page.getByText('SYNTHETIC-SENSITIVE-MARKER')).toHaveCount(0)
      }
      await chip.click()
      const popup = page.locator('.composer-model-host .popover')
      await expect(popup.locator('[data-provider="codex"]')).toContainText('로그인이 필요해요')
      await expect(popup.locator('[data-provider="claude"]')).toContainText('연결됐어요')
      const capture = process.env.KNUAF_CHIP_CAPTURE_DIR
      if (capture) mkdirSync(capture, { recursive: true })
      await page.screenshot({ path: capture ? join(capture, 'login-needed.png') : info.outputPath('login-needed.png') })
      await popup.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
      await expect(popup.locator('[data-provider="codex"]')).toContainText('브라우저에서 로그인')
      await expect(chip).toContainText('로그인 중')
      // 가짜 서버의 account/read는 계속 연결됨을 돌려준다. 완료 알림 전에는 복구되면 안 된다.
      await page.waitForTimeout(3500)
      await expect(chip).toContainText('로그인 중')
      expect(existsSync(complete)).toBe(false)
      writeFileSync(complete, 'fake login completed')
      await expect(chip).toContainText('연결됨', { timeout: 10000 })
      await page.keyboard.press('Escape')
      await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('다시 로그인한 뒤 이어서')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(page.getByText('재로그인 뒤 이어진 답변')).toBeVisible()
      const saved = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8'))
      expect(saved.messages.some((m: { id: string }) => m.id === 'previous')).toBe(true)
    } finally { await electronApp.close() }
  })
}

test('연결된 두 회사에서 다시 로그인을 시작하고 취소할 수 있다', async ({}, info) => {
  const dir = scratch(), bin = join(dir, 'bin'), complete = join(dir, 'login-complete')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_LOGIN_COMPLETE: complete })
  writeFakeClaude(bin)
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat' }) })
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    const codex = popup.locator('[data-provider="codex"]'), claude = popup.locator('[data-provider="claude"]')
    await expect(codex.getByRole('button', { name: 'ChatGPT 다시 로그인' })).toBeVisible()
    await expect(claude.getByRole('button', { name: 'Claude 다시 로그인' })).toBeVisible()
    await expect(claude.getByRole('button', { name: 'Claude로 바꾸기' })).toBeVisible()
    const capture = process.env.KNUAF_CHIP_CAPTURE_DIR
    if (capture) mkdirSync(capture, { recursive: true })
    await page.screenshot({ path: capture ? join(capture, 'connected-relogin.png') : info.outputPath('connected-relogin.png') })
    await codex.getByRole('button', { name: 'ChatGPT 다시 로그인' }).click()
    await expect(codex).toContainText('브라우저에서 로그인')
    await codex.getByRole('button', { name: '취소' }).click()
    await expect(codex).toContainText('연결됐어요')
  } finally { await electronApp.close() }
})

test('로그인 응답 직후 도착한 완료 알림도 새 시도의 id에 맞춰 처리한다', async () => {
  const dir = scratch(), bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_LOGIN_EARLY: '1' })
  writeFakeClaude(bin)
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat' }) })
  try {
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await chip.click()
    await page.getByRole('button', { name: 'ChatGPT 다시 로그인' }).click()
    await expect(chip).toContainText('연결됨', { timeout: 10000 })
  } finally { await electronApp.close() }
})

for (const order of ['failure-first', 'login-first'] as const) test(`작업 중 재로그인과 이전 턴 실패 순서: ${order}`, async () => {
  const dir = scratch(), bin = join(dir, 'bin'), complete = join(dir, 'login-complete'), release = join(dir, 'turn-failure')
  const turns = join(dir, 'turn-input.jsonl')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_TURN_FAILURE: 'refresh', FAKE_CODEX_TURN_RELEASE: release, FAKE_CODEX_LOGIN_COMPLETE: complete, FAKE_CODEX_TURN_INPUT_LOG: turns, FAKE_CODEX_REPLY: replyFile(dir, '완료 후 응답') })
  writeFakeClaude(bin)
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat' }) })
  const root = synthProject()
  seedChat(root, [{ id: 'previous', role: 'assistant', text: '이전 대화', at: new Date().toISOString() }])
  try {
    await openProject(page, root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('기다리는 이전 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByRole('button', { name: '중단', exact: true })).toBeVisible()
    await chip.click()
    const popup = page.locator('.composer-model-host .popover')
    await popup.getByRole('button', { name: 'ChatGPT 다시 로그인' }).click()
    await expect(chip).toContainText('로그인 중')
    if (order === 'login-first') {
      // 서버가 그 턴을 **받은 뒤**에 로그인을 끝낸다. 가짜 서버는 `turn/start` 를 처리하는 순간의
      // 로그인 상태로 실패 여부를 정하므로, 그 전에 완료 파일을 쓰면 턴이 실패조차 하지 않는다
      // (지킴이 열거가 턴 시작을 늦추면서 실제로 그 순서가 뒤집혔다 — 시험이 검증하려던 경쟁이 사라진다).
      await expect.poll(() => existsSync(turns) ? readFileSync(turns, 'utf8') : '').toContain('기다리는 이전 요청')
      writeFileSync(complete, 'complete fake login')
      await expect(chip).toContainText('연결됨', { timeout: 10000 })
    }
    writeFileSync(release, 'release fake turn')
    await expect(page.getByText('보냈는지 확인하지 못했어요')).toBeVisible()
    if (order === 'failure-first') {
      await expect(chip).toContainText('로그인 중')
      writeFileSync(complete, 'complete fake login')
    }
    await expect(chip).toContainText('연결됨', { timeout: 10000 })
    await page.keyboard.press('Escape')
    const saved = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf8'))
    expect(saved.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1)
    expect(saved.messages.find((m: { role: string }) => m.role === 'user').delivery).toBe('uncertain')
    expect(saved.messages.some((m: { id: string }) => m.id === 'previous')).toBe(true)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('복구 후 새 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('완료 후 응답')).toBeVisible()
  } finally { await electronApp.close() }
})
