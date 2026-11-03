/**
 * GUI 감사 GUI-07: 결과물을 다시 만들 때 화면은 학생을 없는 조작으로 보내면 안 된다.
 *
 * v0.3.x 원본은 같은 개정·같은 내용의 export를 receipt로 중복 제거해 **새 파일을 만들지 않고
 * 기존 경로를 `status: existing`으로 돌려준다.** 그래서 두 조건을 따로 잠근다:
 * ① 같은 개정 2회차는 멱등 성공이고, 안내가 없는 "새 버전 경로" 버튼 대신 실제로 있는
 *    결과물 **목록**을 가리킨다.
 * ② receipt 없이 목적지 자리에 파일이 남아 있으면 원본이 실제로 거절한다
 *    (`gg_core.py` `export_destination_conflict`: "소유권 미확인 산출물 충돌: 기존 경로를 보존함").
 *    그때도 안내는 덮어쓰지 않았다는 사실과 **목록**을 말한다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'

test('같은 개정의 검토본을 다시 만들면 이미 있는 파일을 목록에서 열라고 한다 (GUI-07)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '결과물')
    const sheet = page.locator('[data-screen="artifacts"]')
    await page.click('.make-row:has-text("검토본 만들기") button')
    // 같은 문구가 결과물 시트와 종이 머리 아래 만들기 한 줄 두 곳에 뜬다 — 시트로 좁힌다.
    await expect(sheet).toContainText('검토본을 만들었어요', { timeout: 60_000 })

    // 같은 개정·같은 내용에서 한 번 더 — 원본은 receipt로 중복 제거해 existing을 돌려준다.
    await page.click('.make-row:has-text("검토본 만들기") button')
    const fb = sheet.locator('.feedback').filter({ hasText: '이미 만든 파일이에요' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })

    const text = await fb.innerText()
    // 화면에 없는 조작을 시키지 않는다.
    expect(text, '없는 "새 버전 경로" 버튼을 누르라고 한다').not.toContain('새 버전 경로')
    for (const label of ['새 버전 경로', '새 경로를 쓰세요']) expect(text).not.toContain(label)
    // 실제로 일어난 일을 말하고, 실제로 있는 곳을 가리켜야 한다.
    expect(text, '같은 내용이라 새로 만들지 않았다는 사실을 말해야 한다').toContain('새로 만들지 않았어요')
    expect(text, '안내가 가리키는 목록에 그 파일이 있어야 한다').toContain('목록')
    await expect(sheet).toContainText('검토용.md')
  } finally {
    await electronApp.close()
  }
})

test('목적지에 receipt 없는 파일이 있으면 원본이 거절하고 안내는 목록을 가리킨다 (GUI-07)', async () => {
  const root = synthProject()
  // 원본 export의 목적지: build/<개정>/review/검토용.md. receipt 없이 파일만 미리 둔다.
  const revision = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).revision as number
  const dest = join(root, 'build', String(revision), 'review')
  const pre = join(dest, '검토용.md')
  mkdirSync(dest, { recursive: true })
  writeFileSync(pre, '# 이미 있는 파일\n', 'utf8')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '결과물')
    const sheet = page.locator('[data-screen="artifacts"]')
    // 그 파일은 목록에 보인다 — 안내가 "목록에서 열라"고 해도 맞는 말이다.
    await expect(sheet).toContainText('검토용.md', { timeout: 30_000 })
    await page.click('.make-row:has-text("검토본 만들기") button')
    const fb = sheet.locator('.feedback').filter({ hasText: '덮어쓰지' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })

    const text = await fb.innerText()
    expect(text, '없는 "새 버전 경로" 버튼을 누르라고 한다').not.toContain('새 버전 경로')
    for (const label of ['새 버전 경로', '새 경로를 쓰세요']) expect(text).not.toContain(label)
    expect(text, '실제로 일어난 일을 말해야 한다').toContain('덮어쓰지 않았어요')
    expect(text, '실제로 있는 곳을 가리켜야 한다').toContain('목록')
    // 거절은 보존이다 — 미리 둔 파일을 건드리지 않는다.
    expect(readFileSync(pre, 'utf8')).toBe('# 이미 있는 파일\n')
  } finally {
    await electronApp.close()
  }
})