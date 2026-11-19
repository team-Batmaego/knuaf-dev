/**
 * v0-6-8 A4 — 빈 목차 표시의 **지금 동작**을 잠근다.
 *
 * 표시 방식(A/B/C)은 책임자 결정 대기 중이다. 그래서 여기서 고정하는 것은 어느 안이 되든
 * 같아야 하는 두 상태뿐이다:
 *  1) 정본은 있는데 장이 0개 — 종이 칸을 열지 않고(한 칸) 제목줄이 그 이유를 한 줄로 말한다.
 *  2) 본문 없는 장 여러 개가 등록됨 — 넓은 창에서 종이 칸이 열리고, 장마다 빈 자리 한 줄이
 *     서며, 차례 단추를 누르면 그 장들이 **등록 순서대로** 나온다.
 *
 * 앱은 장이 하나라도 등록되면 종이 칸을 연다(`components/useLayout.ts` `hasPaneOf` — 본문
 * 유무가 아니라 등록 여부). 그 판정과 아래 문구를 화면에서 한 번씩 밟는다.
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, python, scripts, setWindowWidth, synthProject } from './helpers'

/**
 * 본문 없는 장을 등록한다 — 파일은 있고 DRAFT 칸이 비어 있다.
 *
 * `draft()`(gg_core)는 마커 사이 글자를 본문으로 읽으므로 빈 마커는 본문 `''` 이고,
 * `apply` 가 그 지문으로 `draft_hash` 를 적는다. 상태는 `empty`(스키마가 허용하는 셋 중 하나)다.
 */
function registerEmptySections(root: string, titles: string[], expected = 0): void {
  mkdirSync(join(root, 'sections'), { recursive: true })
  const ops = titles.map((title, i) => {
    const id = `sec-0${i + 1}`
    writeFileSync(
      join(root, 'sections', `${i + 1}.md`),
      `# ${title}\n\n## DRAFT\n<!-- gg:draft:start -->\n<!-- gg:draft:end -->\n## OPEN\n`,
      'utf-8'
    )
    return { collection: 'sections', value: { id, title, order: i + 1, path: `sections/${i + 1}.md`, status: 'empty' } }
  })
  const change = join(root, 'change-empty-sections.json')
  writeFileSync(change, JSON.stringify({ request_id: 'e2e:empty-toc:sections', ops }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

test('정본만 있고 장이 없으면 한 칸이고 제목줄이 이유를 말한다', async () => {
  // `withContent: false` = gg.py init 만 한 폴더. 정본은 있고 등록된 장은 0개다.
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)

    // 빈 종이로 옆 칸을 채우지 않는다 — 한 칸이다.
    await expect(page.locator('.workspace')).toHaveClass(/solo/)
    await expect(page.locator('.workspace.split')).toHaveCount(0)
    await expect(page.locator('.paperpane')).toHaveCount(0)
    await expect(page.locator('.paper-empty')).toHaveCount(0)
    await expect(page.locator('.chat-pane')).toBeVisible()

    // 제목줄이 왜 옆 칸이 비었는지 한 줄로 말한다(paperLater).
    await expect(page.locator('.titlebar')).toContainText('내 논문 · 첫 장을 쓰면 옆에 열려요')
  } finally {
    await electronApp.close()
  }
})

test('본문 없는 장 여러 개는 넓은 창에서 종이 칸을 열고 차례에 순서대로 나온다', async () => {
  const titles = ['Ⅰ. 머리말', 'Ⅱ. 농장 현황', 'Ⅲ. 사업 계획']
  const root = synthProject({ withContent: false })
  registerEmptySections(root, titles)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    // "넓은 창"을 분명히 만든다(경계 1,140 이상).
    await setWindowWidth(electronApp, 1300)

    await expect(page.locator('.workspace.split')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.chat-pane')).toBeVisible()

    // 장마다 제목과 빈 자리 한 줄 — 장식용 빈 종이가 아니라 "등록됐지만 아직 안 쓴 장"이다.
    const empties = page.locator('.paperpane .sheet .paper-empty')
    await expect(empties).toHaveCount(titles.length, { timeout: 30_000 })
    await expect(page.locator('.paperpane .sheet h2')).toHaveCount(titles.length, { timeout: 30_000 })
    for (let i = 0; i < titles.length; i++) {
      await expect(empties.nth(i)).toContainText(titles[i])
      await expect(empties.nth(i).locator('.ln')).toHaveText('아직 쓴 글이 없어요')
    }

    // 차례 단추 — 누르면 팝오버가 열리고 등록된 장이 순서대로 보인다.
    await page.locator('.paper-head .chap').click()
    const pop = page.locator('.paper-head .popover')
    await expect(pop).toBeVisible()
    const rows = pop.locator('.pop-row')
    await expect(rows).toHaveCount(titles.length)
    for (let i = 0; i < titles.length; i++) await expect(rows.nth(i)).toContainText(titles[i])

    // Esc 로 닫힌다.
    await page.keyboard.press('Escape')
    await expect(pop).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
