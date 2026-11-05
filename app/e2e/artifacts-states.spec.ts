/**
 * Files popover states: a missing chat attachment, a genuine empty list, and a list-read failure
 * must not be mistaken for the same state.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openProject, seedChat, shellCalls, spyShell, synthProject } from './helpers'

const MISSING_LINK = '첨부했어요. [첨부재현.txt](첨부재현.txt)'

/** Open the Files list from a missing chat link. */
async function openFilesFromChat(page: Page): Promise<void> {
  const link = page.getByRole('button', { name: '첨부재현.txt' })
  await expect(link).toBeVisible({ timeout: 30_000 })
  await link.click()
  await expect(page.locator('.paper-head .popover')).toBeVisible({ timeout: 30_000 })
}

test('없는 첨부는 파일 목록에 안내하고 폴더 열기 동작을 제공한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-noproj-'))
  seedChat(root, MISSING_LINK)
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await openFilesFromChat(page)
    const pop = page.locator('.paper-head .popover')

    const notice = pop.getByRole('status').filter({ hasText: '첨부재현.txt' })
    await expect(notice).toContainText('"첨부재현.txt"을 찾지 못했어요.')
    await expect(notice).toContainText('아래는 이 논문에서 만든 다른 파일이에요.')
    const makeRows = pop.locator('.pop-make-block')
    await expect(makeRows).toHaveCount(4)
    for (const row of await makeRows.all()) await expect(row.getByRole('button')).toBeDisabled()
    const reveal = pop.getByRole('button', { name: '폴더에서 보기', exact: true })
    await expect(reveal).toBeVisible()
    await reveal.click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(root)}`])
  } finally {
    await electronApp.close()
  }
})

test('정본은 있지만 만든 파일이 없으면 파일 목록의 빈 상태로 말한다', async () => {
  const root = synthProject({ withContent: false })
  mkdirSync(join(root, 'build'), { recursive: true })
  seedChat(root, MISSING_LINK)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await openFilesFromChat(page)
    const pop = page.locator('.paper-head .popover')
    await expect(pop.getByText('아직 만든 파일이 없어요.', { exact: true })).toBeVisible()
    await expect(pop.getByRole('alert')).toHaveCount(0)
    await expect(pop.getByRole('button', { name: '폴더에서 보기', exact: true })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('결과 파일을 원래 앱으로 열지 못하면 같은 자리에서 안내하고 폴더 보기를 제공한다', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '메모.md'), '# 메모\n', 'utf-8')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    await page.locator('.paper-head .popover').getByRole('button', { name: /메모\.md/ }).click()
    await spyShell(electronApp, log, { openFailure: 'no application associated' })
    await page.getByRole('button', { name: '원래 앱으로 열기' }).click()
    await expect(page.getByText('파일을 열지 못해 폴더에서 보여 줬어요.')).toBeVisible()
    await expect(page.getByRole('button', { name: '폴더에서 보기' }).first()).toBeVisible()
    await expect.poll(() => shellCalls(log)).toEqual([
      `open\t${realpathSync(join(root, 'build', '메모.md'))}`,
      `reveal\t${realpathSync(join(root, 'build', '메모.md'))}`
    ])
  } finally {
    await electronApp.close()
  }
})

test('열지 않는 형식은 실행하지 않고 "폴더에서 보기"를 안내한다 (ATTACH-R1-07 2차)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '메모.md'), '# 메모\n', 'utf-8')
  writeFileSync(join(root, 'build', 'payload.EXE'), 'MZ\n', 'utf-8')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    await page.locator('.paper-head .popover').getByRole('button', { name: /메모\.md/ }).click()
    await spyShell(electronApp, log)

    // 목록이 뜬 뒤 실제 경로를 실행 형식으로 바꾼다 — 메인은 realpath 로 판정한다.
    unlinkSync(join(root, 'build', '메모.md'))
    symlinkSync(join(root, 'build', 'payload.EXE'), join(root, 'build', '메모.md'))

    await page.getByRole('button', { name: '원래 앱으로 열기' }).click()
    await expect(page.getByText('이 파일은 앱에서 열지 않아요. "폴더에서 보기"를 눌러 주세요.')).toBeVisible()
    // 수행하지 않은 동작을 했다고 안내하지 않는다 — 실제 shell 호출은 0회다.
    expect(await shellCalls(log), '표시했다고 안내했지만 실제 표시는 없었다').toEqual([])

    await page.getByRole('button', { name: '폴더에서 보기' }).first().click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, 'build', 'payload.EXE'))}`])
  } finally {
    await electronApp.close()
  }
})

test('파일 목록 읽기 실패는 알림과 다시 시도를 제공한다', async () => {
  const root = synthProject({ withContent: false })
  mkdirSync(join(root, 'build'), { recursive: true })
  seedChat(root, MISSING_LINK)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await openFilesFromChat(page)
    const pop = page.locator('.paper-head .popover')
    await expect(pop.getByText('아직 만든 파일이 없어요.', { exact: true })).toBeVisible()

    // 팝오버를 닫고 정본을 치운다 — 목록 요청이 실패하는 상태(실기기 재현과 같은 조건).
    await page.keyboard.press('Escape')
    await expect(pop).toHaveCount(0)
    renameSync(join(root, 'project.json'), join(root, 'project.json.bak'))

    await openFilesFromChat(page)
    await expect(pop.getByRole('alert')).toBeVisible()
    await expect(pop.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible()
    await expect(pop.getByRole('button', { name: '폴더에서 보기', exact: true })).toBeVisible()
    await expect(pop.getByText('아직 만든 파일이 없어요.', { exact: true })).toHaveCount(0)
    // 원문 오류는 목록 안에서 노출하지 않는다.
    await expect(pop.getByRole('alert')).not.toContainText('project.json')
  } finally {
    await electronApp.close()
  }
})