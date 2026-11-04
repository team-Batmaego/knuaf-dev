/**
 * 결과물 화면의 **빈 화면 세 가지**를 구분하는지 잠근다(실기기 재현 2026-11-03).
 *
 * 예전에는 ① 논문 기록(정본)이 없는 폴더 ② 목록 읽기 실패 ③ 진짜 빈 목록이 모두 같은
 * 공백으로 보였고, 만들기 네 단추는 이유 없이 회색이었다. 학생은 파일이 저장되지 않았다고
 * 읽었다. 이제 ①·②는 사실 문구와 폴더 열기 단추를, ③은 기존 빈 목록 안내를 보여 준다.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, navTo, openProject, seedChat, shellCalls, spyShell, synthProject } from './helpers'

const MISSING_LINK = '첨부했어요. [첨부재현.txt](첨부재현.txt)'

/** 대화의 파일 단추를 눌러 결과물 시트를 연다 — 없는 파일이므로 결과물로 간다. */
async function openArtifactsFromChat(page: Page): Promise<void> {
  const link = page.getByRole('button', { name: '첨부재현.txt' })
  await expect(link).toBeVisible({ timeout: 30_000 })
  await link.click()
  await expect(page.getByRole('heading', { name: '결과물' })).toBeVisible({ timeout: 30_000 })
}

test('결과물: 논문 기록이 없으면 이유·폴더 열기 단추·만들기 비활성 이유를 보여 준다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-noproj-'))
  seedChat(root, MISSING_LINK)
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await openArtifactsFromChat(page)

    await expect(page.getByText('아직 논문 준비가 끝나지 않았어요')).toBeVisible()
    // 본문은 지금 할 일 하나(단추 이름 그대로)만 말한다.
    await expect(page.getByText('"논문 폴더 열기"를 눌러 이 폴더를 확인해 보세요.')).toBeVisible()
    // 만들기 네 줄이 모두 꺼진 이유를 한 줄로 말한다(예전에는 이유 없이 회색이었다).
    await expect(page.locator('[data-st="make-blocked"]')).toContainText('논문 준비가 끝나면 만들기가 켜져요')
    // 꺼진 단추를 누르라고 시키지 않는다 — 같은 상태에서 가능한 조작은 폴더 단추 하나뿐이다
    // (검토 ATTACH-R1-08).
    await expect(page.getByText('검토본 만들기를 먼저', { exact: false })).toHaveCount(0)
    for (const caption of await page.locator('.make-row .caption').all()) await expect(caption).toHaveText('')
    const makeButtons = page.locator('.make-row button')
    await expect(makeButtons).toHaveCount(4)
    for (const b of await makeButtons.all()) await expect(b).toBeDisabled()

    await page.getByRole('button', { name: '논문 폴더 열기' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`open\t${realpathSync(root)}`])
  } finally {
    await electronApp.close()
  }
})

test('결과물: 정본은 있지만 만든 파일이 없으면 진짜 빈 목록으로 말한다', async () => {
  const root = synthProject({ withContent: false })
  mkdirSync(join(root, 'build'), { recursive: true })
  seedChat(root, MISSING_LINK)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await openArtifactsFromChat(page)
    await expect(page.getByText('아직 결과물이 없어요')).toBeVisible()
    await expect(page.getByText('아직 논문 준비가 끝나지 않았어요')).toHaveCount(0)
    await expect(page.getByText('파일 목록을 열지 못했어요')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('결과물: 원래 앱으로 열기가 실패하면 같은 자리에서 안내하고 폴더에서 보기를 준다', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '메모.md'), '# 메모\n', 'utf-8')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    await page.locator('.artifact-list .item', { hasText: '메모.md' }).click()
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

test('열지 않는 형식은 표시하지 않고 "폴더에서 보기"를 안내한다 (ATTACH-R1-07 2차)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '메모.md'), '# 메모\n', 'utf-8')
  writeFileSync(join(root, 'build', 'payload.EXE'), 'MZ\n', 'utf-8')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    await page.locator('.artifact-list .item', { hasText: '메모.md' }).click()
    await spyShell(electronApp, log)

    // 목록이 뜬 뒤 실제 경로를 실행 형식으로 바꾼다 — 메인은 realpath 로 판정한다.
    unlinkSync(join(root, 'build', '메모.md'))
    symlinkSync(join(root, 'build', 'payload.EXE'), join(root, 'build', '메모.md'))

    await page.getByRole('button', { name: '원래 앱으로 열기' }).click()
    await expect(page.getByText('이 파일은 앱에서 열지 않아요. "폴더에서 보기"를 눌러 주세요.')).toBeVisible()
    // 수행하지 않은 동작을 했다고 말하지 않는다 — 실제 shell 호출은 0회다.
    expect(await shellCalls(log), '표시했다고 안내했지만 실제 표시는 없었다').toEqual([])

    // 안내한 단추를 누르면 그때 실제로 보여 준다.
    await page.getByRole('button', { name: '폴더에서 보기' }).first().click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, 'build', 'payload.EXE'))}`])
  } finally {
    await electronApp.close()
  }
})

test('결과물: 목록 읽기가 실패하면 공백 대신 이유와 다시 시도를 보여 준다', async () => {
  const root = synthProject({ withContent: false })
  mkdirSync(join(root, 'build'), { recursive: true })
  seedChat(root, MISSING_LINK)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await openArtifactsFromChat(page)
    await expect(page.getByText('아직 결과물이 없어요')).toBeVisible()

    // 시트를 닫고 정본을 치운다 — 목록 요청이 실패하는 상태(실기기 재현과 같은 조건).
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-screen="artifacts"]')).toHaveCount(0)
    renameSync(join(root, 'project.json'), join(root, 'project.json.bak'))

    await openArtifactsFromChat(page)
    await expect(page.getByText('파일 목록을 열지 못했어요')).toBeVisible()
    await expect(page.getByText('"다시 시도"를 눌러 주세요. 잠깐 문제가 생겼어요.')).toBeVisible()
    await expect(page.getByText('아직 결과물이 없어요')).toHaveCount(0)
    const sheet = page.locator('[data-screen="artifacts"]')
    await expect(sheet.getByRole('button', { name: '다시 시도' })).toBeVisible()
    await expect(sheet.getByRole('button', { name: '논문 폴더 열기' })).toBeVisible()
    // 원문 오류는 "자세히" 안에 있다 — 화면 본문에 JSON·영문 id 를 내밀지 않는다.
    await expect(sheet.getByText('project.json', { exact: false })).toBeHidden()
  } finally {
    await electronApp.close()
  }
})