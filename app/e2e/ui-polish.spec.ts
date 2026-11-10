import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown } from '../src/renderer/src/components/ChatMarkdown'
import { launch, navTo, openProject, settleWorkspace, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

function saveChat(root: string, state: 'idle' | 'running', text = '기록된 답변'): void {
  const dir = join(root, '.knuaf-gui')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chat-codex.json'), JSON.stringify({
    root, provider: 'codex', state,
    messages: [{ id: 'ui-polish', role: 'assistant', text, at: new Date().toISOString() }]
  }), 'utf-8')
}

async function pushChatState(electronApp: import('@playwright/test').ElectronApplication, root: string, state: 'idle' | 'running'): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send('chat:snapshot', snapshot)
  }, { root, provider: 'codex', state, messages: [{ id: 'ui-polish', role: 'assistant', text: '작성 중', at: new Date().toISOString() }] })
}

test('UI-P01: 제출 거절은 다음 할 일과 남은 조건 수를 먼저 보이고 진단은 접는다', async ({}, testInfo) => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 30_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일/ }).click()
    const block = page.locator('[data-make="submission_candidate"]')
    await block.getByRole('button', { name: '만들기' }).click()
    const feedback = block.locator('.make-fb.warning')
    await expect(feedback.locator('details.disclosure')).toBeVisible({ timeout: 30_000 })
    await expect(feedback).toContainText('먼저 할 일:')
    await expect(feedback).toContainText(/그 밖에 조건 \d+개 더/)
    const details = feedback.locator('details.disclosure')
    await expect(details).not.toHaveAttribute('open', '')
    await expect(block.getByRole('button', { name: '고급 도구에서 직접 실행' })).toBeVisible()
    await expect(block.getByRole('button', { name: '도우미에게 알리기' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('P01-after-collapsed.png') })
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open', '')
    await expect(details).toContainText('자세한 진단 보기')
    await page.screenshot({ path: testInfo.outputPath('P01-after-expanded.png') })
  } finally { await electronApp.close() }
})

test('UI-P02: 초안은 남고 실제 실행 중 표시만 대화 실행에 따라 바뀐다', async ({}, testInfo) => {
  const root = synthProject()
  const projectRoot = root
  saveChat(projectRoot, 'idle')
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root)
    await settleWorkspace(page)
    await page.waitForFunction(() => !document.querySelector('.workspace')?.classList.contains('entering'))
    const heading = page.locator('#sec-sec-01 h2')
    await expect(heading).toContainText('초안', { timeout: 30_000 })
    await expect(page.locator('.paper-live')).toHaveCount(0)
    await pushChatState(electronApp, projectRoot, 'running')
    await expect(page.locator('.paper-live')).toHaveText(/도우미가 작업 중/)
    await page.screenshot({ path: testInfo.outputPath('P02-after-running.png') })
    await pushChatState(electronApp, projectRoot, 'idle')
    await expect(page.locator('.paper-live')).toHaveCount(0)
    await expect(heading).toContainText('초안')
  } finally { await electronApp.close() }
})

test('UI-P03: 프로젝트 내부 절대경로 링크를 짧게 보여 주고 전체 경로를 title에 둔다', async ({}, testInfo) => {
  const root = synthProject()
  const projectRoot = root
  const inside = join(projectRoot, 'sections', 'I (머리말 초안).md')
  const outside = join(projectRoot, '..', 'outside', '초안 (외부).md')
  saveChat(projectRoot, 'idle', `내부 파일 [머리말 초안](<${inside}>)과 외부 파일 [외부 문서](<${outside}>)입니다.`)
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    const message = page.locator('.chat-msg.assistant .prose').first()
    const internal = message.getByRole('button', { name: '머리말 초안' })
    await expect(internal).toBeVisible({ timeout: 30_000 })
    await expect(internal).toHaveAttribute('title', inside)
    await expect(message).not.toContainText(inside)
    await expect(message.getByRole('button', { name: '외부 문서' })).toHaveCount(0)
    await expect(message).toContainText(outside)
    const stored = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf-8')) as { messages: { text: string }[] }
    expect(stored.messages[0].text).toContain(inside)
    await page.screenshot({ path: testInfo.outputPath('P03-after.png') })
  } finally { await electronApp.close() }
})

/**
 * Windows 경로를 윈도우 호스트 없이 실제 부품으로 그려 본다. 링크 해석은 화면과 같은
 * `ChatMarkdown` 한 곳에 있으므로(예전 `Chat.tsx` 의 `withLinks` 는 지웠다) 여기서 그 부품을
 * 그대로 부른다. `relativeProjectPath` 가 `window.knuaf.platform` 을 읽으므로 그 값만 스텁한다.
 */
function renderChat(text: string, root: string, platform = 'win32'): string {
  const key = 'window'
  const had = Object.prototype.hasOwnProperty.call(globalThis, key)
  const prev = (globalThis as Record<string, unknown>)[key]
  ;(globalThis as Record<string, unknown>)[key] = { knuaf: { platform } }
  try {
    return renderToStaticMarkup(createElement(ChatMarkdown, { text, root, messageId: 'a1', onFile: () => {} }))
  } finally {
    if (had) (globalThis as Record<string, unknown>)[key] = prev
    else delete (globalThis as Record<string, unknown>)[key]
  }
}

/** 그려진 파일 단추 하나를 꺼낸다. 단추가 없으면 null. */
function linkButton(html: string): { attrs: string; label: string; full: string } | null {
  const found = /<button class="lk"([^>]*)>([^<]*)<\/button>/.exec(html)
  return found ? { attrs: found[1], label: found[2], full: found[0] } : null
}

function expectLink(text: string, root: string, platform: string, label: string, title: string | undefined, suffix: string): void {
  const html = renderChat(text, root, platform)
  const button = linkButton(html)
  expect(button, html).not.toBeNull()
  expect(button!.label).toBe(label)
  expect(/title="([^"]*)"/.exec(button!.attrs)?.[1]).toBe(title)
  expect(button!.attrs).toContain('data-focus-key="chat-link:a1:')
  // 단추 바깥의 글(문장·구두점)은 잘리지 않고 그대로 남는다.
  expect(html.replace(button!.full, '')).toBe(`<div class="chat-md"><p>${suffix}</p></div>`)
}

test('UI-P03 B1-01: 경계가 불확실한 Windows 괄호 경로 네 건은 전부 원문 보존한다', () => {
  const root = String.raw`C:\Thesis`
  const targets = [
    String.raw`C:\Thesis\(draft)\..\..\outside\a.md`,
    String.raw`C:\Thesis\(draft).md`,
    String.raw`C:/Thesis/draft\)/../../../outside/a.md`,
    String.raw`C:/Thesis/report\).md`
  ]
  for (const target of targets) {
    const markdown = `[문서](${target})`
    const html = renderChat(markdown, root)
    expect(linkButton(html), target).toBeNull()
    expect(html, target).toContain(markdown)
  }
})

test('UI-P03 B1-01: 정상 Windows 링크는 파일명으로 줄이고 뒤의 문장·구두점을 남긴다', () => {
  const root = String.raw`C:\Thesis`
  for (const [target, suffix] of [
    ['C:/Thesis/build/a.md', '입니다.'],
    [String.raw`C:\Thesis\build\a.md`, '.'],
    ['C:/Thesis/build/a.md', ''],
    [String.raw`C:\Thesis\build\a.md`, ' 입니다.']
  ]) {
    expectLink(`[${target}](${target})${suffix}`, root, 'win32', 'a.md', target, suffix)
  }
})

test('UI-P03 B1-01: 명시적 괄호 경로·macOS·상대경로·외부 링크 계약을 유지한다', () => {
  expectLink(
    String.raw`[C:\Thesis\(draft).md](<C:\Thesis\(draft).md>)입니다.`,
    String.raw`C:\Thesis`, 'win32', '(draft).md', String.raw`C:\Thesis\(draft).md`, '입니다.'
  )
  expectLink(
    '[/Users/student/Thesis/draft (1).md](/Users/student/Thesis/draft (1).md).',
    '/Users/student/Thesis', 'darwin', 'draft (1).md', '/Users/student/Thesis/draft (1).md', '.'
  )
  expectLink('[초안](build/draft (1).md).', '/Users/student/Thesis', 'darwin', '초안', undefined, '.')
  expectLink('[build/a.md](build/a.md).', String.raw`C:\Thesis`, 'win32', 'build/a.md', undefined, '.')

  // 폴더 밖·형제 폴더·상위 경로는 단추가 되지 않고 원문이 그대로 남는다.
  for (const text of [
    '[외부](C:/Thesis/build/../../outside/a.md)입니다.',
    '[형제](C:/Thesis-other/a.md).',
    '[상위](../outside/a.md).'
  ]) {
    const html = renderChat(text, String.raw`C:\Thesis`)
    expect(linkButton(html), text).toBeNull()
    expect(html, text).toContain(text)
  }
  // 주소는 누를 수 없지만 주소 글자 자체는 지우지 않는다(GUI-12) — 예전 `withLinks` 는 원문을
  // 그대로 뒀고, 부품은 여기에 "무엇을 눌렀어야 하는지"를 보여 주는 주소를 더한다.
  const web = renderChat('[웹](https://example.invalid/a.md).', String.raw`C:\Thesis`)
  expect(linkButton(web)).toBeNull()
  expect(web).toContain('웹')
  expect(web).toContain('example.invalid/a.md')
})


test('UI-P04: 앱 정보에 빌드 날짜·커밋이 보이고 두 값을 함께 복사한다', async ({}, testInfo) => {
  const { electronApp, page } = await launch()
  try {
    await navTo(page, '설정')
    await page.locator('dialog[open] nav').getByRole('button', { name: '앱 정보', exact: true }).click()
    const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '앱 정보' }) })
    const line = card.locator('.app-build-info')
    await expect(line).toContainText(/빌드 \d{4}-\d{2}-\d{2} · 커밋 (?:[0-9a-f]{8}|unknown)/i)
    await page.evaluate(() => {
      Object.defineProperty(window, '__copiedBuildInfo', { value: '', writable: true, configurable: true })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => { (window as unknown as { __copiedBuildInfo: string }).__copiedBuildInfo = value }
      } })
    })
    const info = await page.evaluate(() => window.knuaf.appInfo())
    const copy = card.getByRole('button', { name: '빌드 정보 복사' })
    await copy.click()
    await expect(card.getByRole('button', { name: '빌드 정보 복사' })).toHaveText('복사했어요')
    const copied = await page.evaluate(() => (window as unknown as { __copiedBuildInfo: string }).__copiedBuildInfo)
    expect(copied).toBe(`${info.buildDate} ${info.buildCommit}`)
    await page.screenshot({ path: testInfo.outputPath('P04-after.png') })
  } finally { await electronApp.close() }
})
