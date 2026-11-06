/**
 * GUI 감사 GUI-07: 결과물을 다시 만들 때 화면은 학생을 없는 조작으로 보내면 안 된다.
 *
 * v0.3.x 원본은 같은 개정·같은 내용의 export를 receipt로 중복 제거해 **새 파일을 만들지 않고
 * 기존 경로를 `status: existing`으로 돌려준다.** 그래서 두 조건을 따로 잠근다:
 * ① 같은 개정 2회차는 멱등 성공이고, 안내가 없는 "새 버전 경로" 버튼 대신 실제로 있는
 *    결과물 **목록**을 가리킨다.
 * ② receipt 없이 목적지 자리에 무언가 남아 있으면 원본이 거절한다
 *    (`gg_core.py` `export_destination_conflict`). 원본 조건은 `dest_dir.exists() or
 *    requested.exists()`라 **파일 존재를 보장하지 않는다** — 빈 폴더만 있어도 난다. 그래서
 *    안내는 파일·목록 존재를 단정하지 않고, 보장되는 사실(그 자리에 이미 무언가가 있어
 *    그대로 두었고 새로 만들지 않았다)과 실제로 있는 곳(결과물 화면)만 말한다.
 */
import { expect, test, type Locator } from '@playwright/test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { MENUS } from '../src/renderer/src/copy-menus'

const FORBIDDEN = ['새 버전 경로', '새 경로를 쓰세요']

/**
 * `export_destination_conflict` 안내의 공통 계약. 원본은 폴더만 있어도 거절하므로
 * 파일·목록이 있다고 단정하면 안 되고, 화면에 없는 조작을 가리켜도 안 된다(GUI-07).
 */
async function expectConflictGuidance(fb: Locator): Promise<string> {
  const text = await fb.innerText()
  for (const label of FORBIDDEN) expect(text, `없는 조작을 가리킨다: ${label}`).not.toContain(label)
  for (const claim of ['목록에 이미', '아래 목록에', '그 파일은']) {
    expect(text, `파일·목록 존재를 단정한다: ${claim}`).not.toContain(claim)
  }
  // 보장되는 사실만 말한다.
  expect(text).toContain('같은 자리에 이미 무언가')
  expect(text).toContain('새로 만들지 않았어요')
  expect(text).toContain('그대로 두었어요')
  // 실제로 있는 곳만 가리킨다.
  expect(text).toContain('결과물 화면')
  return text
}

test('같은 개정의 검토본을 다시 만들면 이미 있는 파일을 목록에서 열라고 한다 (GUI-07)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '결과물')
    const pop = page.locator('.paper-head .popover')
    const reviewRow = pop.locator('[data-make="review"]')
    await reviewRow.getByRole('button', { name: '만들기', exact: true }).click()
    await expect(reviewRow).toContainText('검토본을 만들었어요', { timeout: 60_000 })

    // 같은 개정·같은 내용에서 한 번 더 — 원본은 receipt로 중복 제거해 existing을 돌려준다.
    await reviewRow.getByRole('button', { name: '만들기', exact: true }).click()
    // 화면에는 독립검토 미실행 고지도 있다 — 기존 파일 안내만 집는다.
    const fb = reviewRow.locator('.make-fb').filter({ hasText: '이미 만든 파일이에요' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })

    const text = await fb.innerText()
    // 화면에 없는 조작을 시키지 않는다.
    expect(text, '없는 "새 버전 경로" 버튼을 누르라고 한다').not.toContain('새 버전 경로')
    for (const label of FORBIDDEN) expect(text).not.toContain(label)
    // 실제로 일어난 일을 말하고, 실제로 있는 곳을 가리켜야 한다.
    expect(text, '같은 내용이라 새로 만들지 않았다는 사실을 말해야 한다').toContain('새로 만들지 않았어요')
    expect(text, '안내가 가리키는 목록에 그 파일이 있어야 한다').toContain('목록')
    await expect(pop.getByRole('button', { name: /검토용\.md/ })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('목적지에 receipt 없는 파일이 있으면 원본이 거절하고 안내는 존재를 단정하지 않는다 (GUI-07)', async () => {
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
    const pop = page.locator('.paper-head .popover')
    const reviewRow = pop.locator('[data-make="review"]')
    // 이 경우 파일은 실제로 목록에 있다 — 그래도 안내는 그 존재를 단정하지 않는다.
    await expect(pop.getByRole('button', { name: /검토용\.md/ })).toBeVisible()
    await reviewRow.getByRole('button').click()
    const fb = reviewRow.locator('.make-fb').filter({ hasText: '같은 자리에 이미 무언가' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })
    await expectConflictGuidance(fb)
    // 거절은 보존이다 — 미리 둔 파일을 건드리지 않는다.
    expect(readFileSync(pre, 'utf8')).toBe('# 이미 있는 파일\n')
  } finally {
    await electronApp.close()
  }
})

test('목적지에 빈 폴더만 있어도 존재를 단정하지 않고 폴더를 보존한다 (GUI-07)', async () => {
  const root = synthProject()
  // 반례: `dest_dir.exists()`만으로 같은 오류가 난다. 파일이 없으므로 목록도 비어 있다.
  const revision = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).revision as number
  const dest = join(root, 'build', String(revision), 'review')
  mkdirSync(dest, { recursive: true })

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '결과물')
    const pop = page.locator('.paper-head .popover')
    const list = pop.locator('.pop-scroll')
    const reviewRow = pop.locator('[data-make="review"]')
    await expect(list.getByText(MENUS.noFiles, { exact: true })).toBeVisible()
    await reviewRow.getByRole('button').click()
    const fb = reviewRow.locator('.make-fb').filter({ hasText: '같은 자리에 이미 무언가' }).first()
    await expect(fb).toBeVisible({ timeout: 60_000 })
    await expectConflictGuidance(fb)
    // 안내와 화면이 모순되지 않는다 — 여전히 목록은 비어 있다.
    await expect(list.getByText(MENUS.noFiles, { exact: true })).toBeVisible()
    // 거절은 보존이다 — 빈 폴더가 그대로 있고 새 파일도 없다.
    expect(readdirSync(dest)).toEqual([])
  } finally {
    await electronApp.close()
  }
})