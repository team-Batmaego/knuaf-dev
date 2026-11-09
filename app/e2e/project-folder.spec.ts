import { PROJECT_FOLDER, projectFolderCreationError } from '../src/renderer/src/copy'
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeProjectWritable } from '../src/main/project-write'
import { launch } from './helpers'
import { fakeCodexEnv, replyFile, scratch, userDataWith } from './fixtures/fake-codex'

test('첫 메시지 뒤 자동 폴더를 만들되 같은 이름의 기존 폴더는 보존한다', async () => {
  const dir = scratch()
  const existing = join(dir, 'knuaf-dev', '딸기 논문')
  mkdirSync(existing, { recursive: true })
  writeFileSync(join(existing, '원본.txt'), '보존')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '질문입니다') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await electronApp.evaluate(({ app, shell }, docs) => {
      app.setPath('documents', docs)
      shell.openPath = async (path) => { Object.assign(globalThis, { folderOpened: path }); return '' }
    }, dir)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 농장 창업 계획')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await page.getByRole('textbox', { name: '논문 이름' }).fill('딸기 논문')
    await expect(page.getByText('문서 / knuaf-dev / 딸기 논문')).toBeVisible()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByText('질문입니다')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    const created = join(dir, 'knuaf-dev', '딸기 논문 (2)')
    expect(existsSync(created)).toBe(true)
    expect(readFileSync(join(existing, '원본.txt'), 'utf8')).toBe('보존')
    await page.getByRole('button', { name: process.platform === 'darwin' ? 'Finder에서 열기' : '파일 탐색기에서 열기' }).click()
    // 메인은 경로 검사를 통과한 **실제 경로**(심링크 해소)로 연다. macOS 의 /var → /private/var
    // 처럼 같은 폴더를 가리키는 다른 표기가 올 수 있으므로, 폴더 동일성으로 비교한다.
    await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, 'folderOpened'))).toBe(realpathSync(created))
  } finally { await electronApp.close() }
})
test('첫 논문 폴더에서 항상 허용을 고르면 모든 폴더의 전역 trust가 저장된다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '권한 선택 완료') })
  const { electronApp, page } = await launch({ env, permissionPrompt: true })
  try {
    await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('첫 논문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    const gate = page.locator('dialog[data-screen="first-project-gate"]')
    await expect(gate).toBeVisible()
    await expect(gate).not.toContainText(/Word|Excel|자동화/)
    await gate.getByRole('button', { name: '항상 허용' }).click()
    const settings = await page.evaluate(() => window.knuaf.getSettings())
    expect(settings.permission_mode).toBe('trust')
    expect(settings.trusted_roots ?? []).toEqual([])
    expect(settings.first_project_permission_asked_at).toBeTruthy()
  } finally { await electronApp.close() }
})
test('쓰기 시험은 충돌 파일을 보존하고 성공한 임시 파일만 지운다', async () => {
  const dir = scratch()
  const root = join(dir, 'probe-target')
  mkdirSync(root)
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
  const collision = join(root, '.knuaf-write-test-collision')
  writeFileSync(collision, bytes)
  await expect(probeProjectWritable(root, () => 'collision')).rejects.toMatchObject({ code: 'EEXIST' })
  expect(readFileSync(collision)).toEqual(bytes)
  await probeProjectWritable(root, () => 'created-by-this-probe')
  expect(existsSync(join(root, '.knuaf-write-test-created-by-this-probe'))).toBe(false)
})
test('Windows first-open write failure explains the current action and lets the student retry elsewhere', async () => {
  const dir = scratch()
  const notFolder = join(dir, 'not-a-folder')
  const otherRoot = join(dir, 'writable-folder')
  writeFileSync(notFolder, 'leave unchanged')
  mkdirSync(otherRoot)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin')), permissionPrompt: true })
  const originalPlatform = await electronApp.evaluate(() => process.platform)
  try {
    await electronApp.evaluate(({ dialog }, paths) => {
      let next = 0
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[next++]], bookmarks: [] })) as typeof dialog.showOpenDialog
    }, [notFolder, otherRoot])
    await electronApp.evaluate(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }))
    await page.waitForSelector('.project-sidebar', { state: 'visible', timeout: 30_000 })
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-folder' }))
    const gate = page.locator('dialog[data-screen="first-project-gate"]')
    await expect(gate).toContainText('지금 하려던 일')
    await expect(gate).toContainText('해결하려면')
    expect(readFileSync(notFolder, 'utf8')).toBe('leave unchanged')
    await electronApp.evaluate((_, platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true }), originalPlatform)
    await gate.getByRole('button', { name: '내 폴더 고르기' }).click()
    await expect(page.getByText('모든 논문 폴더에서 허락 방식을 골라 주세요.')).toBeVisible()
    await page.getByRole('button', { name: '매번 묻기' }).click()
    await expect(page.locator('.chat-pane')).toBeVisible({ timeout: 30000 })
  } finally {
    await electronApp.evaluate((_, platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true }), originalPlatform)
    await electronApp.close()
  }
})

test('Windows write-failure recovery sends the queued first request exactly once to the replacement folder', async () => {
  const dir = scratch()
  const failedRoot = join(dir, 'A')
  const replacementRoot = join(dir, 'B')
  const inputLog = join(dir, 'turn-inputs.jsonl')
  const firstRequest = '반드시 전달할 첫 요청입니다'
  writeFileSync(failedRoot, 'not a folder')
  mkdirSync(replacementRoot)
  const env = fakeCodexEnv(join(dir, 'bin'), {
    FAKE_CODEX_MODE: 'logged-in',
    FAKE_CODEX_REPLY: replyFile(dir, 'B에서 받았어요'),
    FAKE_CODEX_TURN_INPUT_LOG: inputLog
  })
  const { electronApp, page } = await launch({ env, permissionPrompt: true })
  const originalPlatform = await electronApp.evaluate(() => process.platform)
  try {
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill(firstRequest)
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await electronApp.evaluate(({ dialog }, roots) => {
      let next = 0
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [roots[next++]], bookmarks: [] })) as typeof dialog.showOpenDialog
    }, [failedRoot, replacementRoot])
    await electronApp.evaluate(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }))
    await page.getByRole('button', { name: /내 폴더 고르기/ }).click()

    const gate = page.locator('dialog[data-screen="first-project-gate"]')
    await expect(gate).toContainText('임시 파일')
    await expect(page.locator('.chat-msg.user')).toHaveCount(0)
    await gate.getByRole('button', { name: '내 폴더 고르기' }).click()
    await expect(gate).toContainText('모든 논문 폴더에서 허락 방식을 골라 주세요.')
    await electronApp.evaluate((_, platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true }), originalPlatform)
    await gate.getByRole('button', { name: '매번 묻기' }).click()

    await expect(page.getByText('B에서 받았어요')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toHaveText(firstRequest)
    await expect.poll(() => existsSync(inputLog) ? readFileSync(inputLog, 'utf8').trim().split('\n').filter(Boolean).length : 0).toBe(1)
    const [{ text }] = readFileSync(inputLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { text: string })
    expect(text).toContain(firstRequest)
    expect(text).toContain(`작업 폴더: ${replacementRoot}`)
    expect(text).not.toContain(`작업 폴더: ${failedRoot}`)
  } finally {
    await electronApp.evaluate((_, platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true }), originalPlatform)
    await electronApp.close()
  }
})
for (const route of ['sidebar add', 'sidebar recent', 'titlebar create', 'titlebar other', 'titlebar recent', 'app menu open', 'app menu recent'] as const) {
  test(`first-folder gate covers the ${route} open route`, async () => {
    const dir = scratch()
    const root = join(dir, 'first-folder')
    mkdirSync(root)
    const userData = route.endsWith('recent') ? userDataWith(dir, { recent: [{ root, opened_at: new Date().toISOString() }] }) : undefined
    const { electronApp, page } = await launch({ userData, env: fakeCodexEnv(join(dir, 'bin')), permissionPrompt: true })
    try {
      await electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected], bookmarks: [] })) as typeof dialog.showOpenDialog
      }, root)
      await page.waitForSelector('.project-sidebar', { state: 'visible', timeout: 30_000 })
      if (route === 'sidebar add') await page.getByRole('button', { name: '+ 논문 추가' }).click()
      else if (route === 'sidebar recent') await page.locator('.project-sidebar button[title]').first().click()
      else if (route === 'titlebar create' || route === 'titlebar other') {
        await page.getByTitle('다른 논문 열기').click()
        const menu = page.locator('.titlebar .popover')
        await expect(menu).toBeVisible()
        await menu.getByRole('button', { name: route === 'titlebar create' ? '새 폴더 만들기' : '다른 폴더 열기…', exact: true }).click()
      } else if (route === 'titlebar recent') {
        await page.getByTitle('다른 논문 열기').click()
        await page.locator('.titlebar .popover').getByRole('button', { name: 'first-folder' }).click()
      } else if (route === 'app menu open') {
        await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-folder' }))
      } else {
        await electronApp.evaluate(({ BrowserWindow }, selected) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-recent', root: selected }), root)
      }
      const gate = page.locator('dialog[data-screen="first-project-gate"]')
      await expect(gate).toBeVisible()
      await gate.getByRole('button', { name: '매번 묻기' }).click()
      await expect(page.locator('.chat-pane')).toBeVisible({ timeout: 30000 })
      const settings = await page.evaluate(() => window.knuaf.getSettings())
      expect(settings.permission_mode).toBe('ask')
      expect(settings.first_project_permission_asked_at).toBeTruthy()
    } finally { await electronApp.close() }
  })
}

test('폴더 이름의 경로 구분자는 작업 폴더 밖으로 나가지 않는다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
    const result = await page.evaluate(() => window.knuaf.createProjectFolder('../../밖으로'))
    if ('error' in result) throw new Error(result.error.message)
    expect(result.result.root).toBe(join(dir, 'knuaf-dev', '.. .. 밖으로'))
    expect(existsSync(result.result.root)).toBe(true)
    const long = await page.evaluate(() => window.knuaf.createProjectFolder('가'.repeat(100)))
    if ('error' in long) throw new Error(long.error.message)
    expect(existsSync(long.result.root)).toBe(true)
    expect(Buffer.byteLength(long.result.root.split(/[\\/]/).pop()!.normalize('NFD'))).toBeLessThanOrEqual(200)
  } finally { await electronApp.close() }
})

test('폴더 이름 충돌은 권한 차단 안내로 오분류하지 않고 첫 메시지를 보존한다', async () => {
  expect(projectFolderCreationError('win32', 'EEXIST: file already exists')).toBe(PROJECT_FOLDER.createFailed)
  expect(projectFolderCreationError('win32', 'ENOTDIR: not a directory')).toBe(PROJECT_FOLDER.createFailed)
  expect(projectFolderCreationError('win32', 'EPERM: operation not permitted')).toBe(PROJECT_FOLDER.windowsCreateFailed)
  expect(projectFolderCreationError('darwin', 'EACCES: permission denied')).toBe(`${PROJECT_FOLDER.macFolderDenied} ${PROJECT_FOLDER.macFolderRecovery}`)
  const dir = scratch()
  writeFileSync(join(dir, 'knuaf-dev'), '폴더가 아닌 파일')
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await electronApp.evaluate(({ app }, docs) => app.setPath('documents', docs), dir)
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 창업')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByRole('alert')).toContainText('폴더를 만들지 못했어요')
    await expect(page.getByRole('alert')).not.toContainText('폴더 보호 기능')
    await expect(page.getByText('딸기 창업', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /내 폴더 고르기/ })).toBeEnabled()
  } finally { await electronApp.close() }
})

test('카드가 떠 있을 때 메뉴로 연 폴더에도 첫 메시지를 전달한다', async () => {
  const dir = scratch()
  const root = join(dir, '기존 논문')
  mkdirSync(root)
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '메뉴로 연 답변') })
  const { electronApp, page } = await launch({ onboarded: false, env })
  try {
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('기존 논문 이어 쓰기')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await electronApp.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'open-recent', root: path }), root)
    await expect(page.getByText('메뉴로 연 답변')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText('기존 논문 이어 쓰기')
    await expect.poll(async () => (await page.evaluate(() => window.knuaf.getSettings())).provider_choice?.provider).toBe('codex')
  } finally { await electronApp.close() }
})

test('새 논문 시작을 누르면 폴더 카드와 이전 메시지가 지워진다', async () => {
  const dir = scratch()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('이전 논문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
    await page.getByRole('button', { name: '새 논문 시작' }).click()
    await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '답변을 입력하세요' })).toHaveValue('')
  } finally { await electronApp.close() }
})

test('돌아가 고친 메시지만 기존 생성 폴더로 보낸다 (C1-01)', async () => {
  const dir = scratch()
  const root = join(dir, 'knuaf-dev', '재시도')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '수정 답변') })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ app, ipcMain, dialog }, args) => {
      app.setPath('documents', args.docs)
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('project:open')!
      let first = true
      handlers.set('project:open', (...args) => {
        if (first) { first = false; return { error: { code: 'internal', message: 'C1 controlled open failure' } } }
        return original(...args)
      })
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [args.root] })) as typeof dialog.showOpenDialog
    }, { docs: dir, root })
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('폐기할 첫 메시지')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('textbox', { name: '논문 이름' }).fill('재시도')
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.locator('.zline')).toBeVisible()
    await expect(page.getByRole('button', { name: '돌아가기' })).toBeEnabled()
    expect(existsSync(root)).toBe(true)
    await page.getByRole('button', { name: '돌아가기' }).click()
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('실제로 보낼 수정 메시지')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('실제로 보낼 수정 메시지', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '+ 논문 추가' }).click()
    await expect(page.getByText('수정 답변')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText('실제로 보낼 수정 메시지')
    await expect(page.getByText('폐기할 첫 메시지', { exact: true })).toHaveCount(0)
    const saved = join(root, '.knuaf-gui', 'chat-codex.json')
    await expect.poll(() => existsSync(saved) ? readFileSync(saved, 'utf8') : '').toContain('실제로 보낼 수정 메시지')
    expect(readFileSync(saved, 'utf8')).not.toContain('폐기할 첫 메시지')
  } finally { await electronApp.close() }
})

test('폴더 열기 실패 후 재시도는 만든 폴더를 다시 사용한다 (C1-01)', async () => {
  const dir = scratch()
  const root = join(dir, 'knuaf-dev', '재시도')
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '재시도 답변') })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ app, ipcMain }, docs) => {
      app.setPath('documents', docs)
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('project:open')!
      let first = true
      handlers.set('project:open', (...args) => {
        if (first) { first = false; return { error: { code: 'internal', message: 'C1 controlled open failure' } } }
        return original(...args)
      })
    }, dir)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('재시도할 메시지')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('textbox', { name: '논문 이름' }).fill('재시도')
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.locator('.zline')).toBeVisible()
    await expect(page.getByRole('button', { name: /앱이 만들어 둘게요/ })).toBeEnabled()
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByText('재시도 답변')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText('재시도할 메시지')
    expect(existsSync(root)).toBe(true)
    expect(existsSync(`${root} (2)`)).toBe(false)
  } finally { await electronApp.close() }
})

test('새 논문 시작 뒤 늦은 폴더 생성 응답은 새 제출을 바꾸지 않는다 (C1-02)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '새 논문 답변') })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ app, ipcMain }, docs) => {
      app.setPath('documents', docs)
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('project:create-folder')!
      const entered = Promise.withResolvers<void>()
      Object.assign(globalThis, { c1Entered: entered.promise })
      let first = true
      handlers.set('project:create-folder', async (...args) => {
        const result = await original(...args)
        if (first) {
          first = false
          const held = Promise.withResolvers<void>()
          Object.assign(globalThis, { c1Release: held.resolve })
          entered.resolve()
          await held.promise
        }
        return result
      })
    }, dir)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('취소한 이전 논문 메시지')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await page.getByRole('textbox', { name: '논문 이름' }).fill('이전 논문')
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await electronApp.evaluate(async () => { await Reflect.get(globalThis, 'c1Entered') })
    await page.getByRole('button', { name: '새 논문 시작' }).click()
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('새 논문에 보낼 메시지')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('새 논문에 보낼 메시지', { exact: true })).toBeVisible()
    await electronApp.evaluate(() => { Reflect.get(globalThis, 'c1Release')() })
    await page.getByRole('textbox', { name: '논문 이름' }).fill('이전 논문')
    await page.getByRole('button', { name: /앱이 만들어 둘게요/ }).click()
    await expect(page.getByText('새 논문 답변')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.chat-msg.user')).toHaveCount(1)
    await expect(page.locator('.chat-msg.user')).toContainText('새 논문에 보낼 메시지')
    await expect(page.getByText('취소한 이전 논문 메시지', { exact: true })).toHaveCount(0)
    expect(existsSync(join(dir, 'knuaf-dev', '이전 논문 (2)'))).toBe(true)
    await expect(page.locator('.titlebar .tbtn.title')).toContainText('이전 논문 (2)')
    const saved = join(dir, 'knuaf-dev', '이전 논문 (2)', '.knuaf-gui', 'chat-codex.json')
    await expect.poll(() => existsSync(saved) ? readFileSync(saved, 'utf8') : '').toContain('새 논문에 보낼 메시지')
    expect(readFileSync(saved, 'utf8')).not.toContain('취소한 이전 논문 메시지')
  } finally { await electronApp.close() }
})

test('폴더 선택 카드는 기본·1180·1024 창에서 표시된다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const shots = join(process.cwd(), 'test-results', 'folder-shots')
  mkdirSync(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    const { electronApp, page } = await launch({ colorScheme, env })
    try {
      await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('딸기 농장 창업 계획')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      for (const width of [1440, 1180, 1024]) {
        await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 800 }), width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
        await expect(page.getByText('논문 파일을 어디에 둘까요?')).toBeVisible()
        await page.screenshot({ path: join(shots, `${width}-${colorScheme}.png`) })
      }
    } finally { await electronApp.close() }
  }
})
