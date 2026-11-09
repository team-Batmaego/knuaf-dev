/**
 * 채팅 파일 링크는 미리보기 시트를 연다. 연결 프로그램·폴더 열기는 시트 안의 명시 단추에서만
 * 요청된다. 메인 shell 호출 기록으로 인앱 우선 동작을 확인한다(실제 앱은 띄우지 않는다).
 */
import { expect, test } from '@playwright/test'
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
 * 실행 권한이 된다. 프로젝트 안 상대경로가 아닌 것은 원문 그대로 둔다 — 감추지도,
 * 누를 수 있게 만들지도 않는다.
 */
test('폴더 밖·주소를 가리키는 링크는 누를 수 있게 만들지 않는다 (GUI-12)', async () => {
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
    for (const label of ['받으세요', '열쇠', '위로'])
      await expect(page.getByRole('button', { name: label }), `${label} 가 눌러진다`).toHaveCount(0)
    // 감추지는 않는다 — 학생이 무엇이 적혔는지 볼 수 있어야 한다.
    await expect(msg).toContainText('example.invalid')
  } finally {
    await electronApp.close()
  }
})