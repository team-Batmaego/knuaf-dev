/**
 * 채팅 파일 링크는 미리보기 시트를 연다. 연결 프로그램·폴더 열기는 시트 안의 명시 단추에서만
 * 요청된다. 메인 shell 호출 기록으로 인앱 우선 동작을 확인한다(실제 앱은 띄우지 않는다).
 */
import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { launch, openProject, seedChat, shellCalls, spyShell, synthProject } from './helpers'

const callLog = (): string => join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

/** 존재하는 txt 파일을 만들고 그 상대경로를 돌려준다. */
function plantFile(root: string, rel: string, body = 'ATTACH_REPRO_20261103\n'): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf-8')
  return rel
}

test('파일 단추: 폴더 안 문서는 먼저 미리보기 시트에서 연다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/검토전_본문.md', '# 본문 미리보기\n')
  seedChat(root, `검토본을 만들었어요. [검토전_본문.md](${rel}) 에서 볼 수 있어요.`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await page.getByRole('button', { name: '검토전_본문.md' }).click()
    await expect(page.getByRole('heading', { name: '검토전_본문.md' })).toBeVisible()
    await expect(page.getByText('# 본문 미리보기')).toBeVisible()
    expect(shellCalls(log)).toEqual([])
    await page.getByRole('button', { name: '원래 앱으로 열기' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`open\t${realpathSync(join(root, rel))}`])
  } finally {
    await electronApp.close()
  }
})

test('파일 단추: 열지 않는 형식은 열지 않고 폴더에서 보여 준다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/설치파일.exe', 'MZ not really\n')
  seedChat(root, `첨부했어요. [설치파일.exe](${rel})`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await page.getByRole('button', { name: '설치파일.exe' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, rel))}`])
  } finally {
    await electronApp.close()
  }
})

test('파일 단추: 원래 앱 열기 실패 시 폴더에서 보여 주고 쉬운 말로 알린다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/검토전_본문.md', '# 본문\n')
  seedChat(root, `검토본을 만들었어요. [검토전_본문.md](${rel})`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log, { openFailure: 'no application associated' })
    await page.getByRole('button', { name: '검토전_본문.md' }).click()
    await expect(page.getByText('# 본문')).toBeVisible()
    await page.getByRole('button', { name: '원래 앱으로 열기' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([
      `open\t${realpathSync(join(root, rel))}`,
      `reveal\t${realpathSync(join(root, rel))}`
    ])
    await expect(page.getByText('파일을 열지 못해 폴더에서 보여 줬어요.')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('도우미 답변의 파일 링크가 마크다운 원문으로 보이지 않는다 (GUI-12)', async () => {
  const root = synthProject()
  // 파일을 만들지 않는다 — missing link notice opens the expanded Files list.
  seedChat(root, '검토본을 만들었어요. [검토전_본문.md](build/검토전_본문.md) 에서 볼 수 있어요.')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })

    expect(await msg.innerText(), '마크다운 원문이 그대로 보인다').not.toContain('](')
    const link = page.getByRole('button', { name: '검토전_본문.md' })
    await expect(link, '파일 이름이 누를 수 있는 것이 아니다').toBeVisible()
    await link.click()
    const pop = page.locator('.paper-head .popover')
    await expect(pop).toBeVisible({ timeout: 30_000 })
    const notice = pop.getByRole('status')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('"검토전_본문.md"을 찾지 못했어요.')
    await expect(notice).toContainText('아래는 이 논문에서 만든 다른 파일이에요.')
  } finally {
    await electronApp.close()
  }
})

/**
 * 안전 쪽 절반. 도우미가 쓴 링크를 무엇이든 누를 수 있게 만들면 답변 텍스트가 곧
 * 실행 권한이 된다. 프로젝트 안 상대경로는 파일 단추이고, `http(s)` 만 밖으로 여는 단추가
 * 된다(v0.6.4 ⑤ — 검사·열기는 main 이 다시 한다). 그 밖은 원문 그대로 둔다 —
 * 감추지도, 누를 수 있게 만들지도 않는다.
 */
test('http(s) 만 밖으로 여는 단추가 되고, 폴더 밖·상위 경로는 누를 수 없다 (GUI-12)', async () => {
  const root = synthProject()
  const text = [
    '[받으세요](https://example.invalid/x.exe)',
    '[열쇠](/Users/other/.ssh/id_rsa)',
    '[위로](../../다른폴더/x.md)'
  ].join(' 그리고 ')
  seedChat(root, text)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: '받으세요' }), 'http 주소는 누를 수 있다').toBeVisible()
    for (const label of ['열쇠', '위로'])
      await expect(page.getByRole('button', { name: label }), `${label} 가 눌러진다`).toHaveCount(0)
    // 감추지는 않는다 — 학생이 무엇이 적혔는지 볼 수 있어야 한다.
    await expect(msg).toContainText('example.invalid')
  } finally {
    await electronApp.close()
  }
})

/** `shell.openExternal` 을 기록만 하는 가짜로 바꾼다 — 시험이 실제 브라우저를 열면 안 된다. */
async function spyOpenExternal(electronApp: ElectronApplication, log: string, fail = false): Promise<void> {
  await electronApp.evaluate(({ shell }, o: { path: string; fail: boolean }) => {
    const fs = process.getBuiltinModule('node:fs')
    shell.openExternal = async (url: string) => {
      fs.appendFileSync(o.path, `open-external\t${url}\n`)
      if (o.fail) throw new Error('no browser')
    }
  }, { path: log, fail })
}

test('http(s) 단추: 누르면 기본 브라우저로 넘기고, 앱이 열지 않는 주소는 넘기지 않는다', async () => {
  const root = synthProject()
  seedChat(root, [
    '[후계농 공고](https://agro.seoul.go.kr/archives/55168) 와',
    '[받으세요](https://example.invalid/x.exe) 를 보세요.',
    '안 되는 주소: [a](javascript:alert(1)) [b](file:///etc/passwd)'
  ].join(' '))
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await spyOpenExternal(electronApp, log)
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await expect(page.locator('.chat-md-link'), 'http 주소 둘만 단추다').toHaveCount(2)

    const link = page.getByRole('button', { name: '후계농 공고' })
    await expect(link).toBeVisible({ timeout: 30_000 })
    // 키보드로도 열린다(native button — Enter).
    await link.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => shellCalls(log)).toEqual(['open-external\thttps://agro.seoul.go.kr/archives/55168'])
    await expect(page.locator('.chat-md-link-fail'), '열렸으므로 실패 안내는 없다').toHaveCount(0)

    // 열기 실패는 조용히 삼키지 않는다 — 문단 아래 한 줄로 알린다.
    await spyOpenExternal(electronApp, log, true)
    await page.getByRole('button', { name: '받으세요' }).click()
    await expect(page.locator('.chat-md-link-fail')).toBeVisible()
    await expect(page.locator('.chat-md-link-fail')).toContainText('주소를 열지 못했어요')
    // 문장 사이에 끼지 않는다 — 안내는 문단 **밖**, 그 문단 바로 뒤 한 줄이다(형님 2026-11-11).
    await expect(page.locator('p .chat-md-link-fail'), '안내가 문장 안에 끼지 않는다').toHaveCount(0)
    expect(await page.locator('.chat-md-link-fail').evaluate((el) => el.previousElementSibling?.tagName))
      .toBe('P')

    // 앱이 열지 않는 형태(javascript:·file:)는 단추가 아니다.
    await expect(page.getByRole('button', { name: 'javascript:alert(1)' })).toHaveCount(0)
    await expect(page.locator('.chat-md-link')).toHaveCount(2)
  } finally {
    await electronApp.close()
  }
})