import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { DEFAULT_WINDOW } from '../src/shared/window'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

// 화면 캡처가 쓰는 자리. 기본값은 `test-results` 아래다 — git 에 안 들어가는 자리라 시험 실행이
// 추적되는 파일을 덮어쓰지 않는다. 안내서 사진(`docs/images` 의 14장, 이 시험이 쓰는 몫)을 갱신할
// 때만 `KNUAF_SHOT_DIR=../docs/images` 로 명시해 돌린다(루트 README 「개발」 절의 명령).
const OUT = process.env.KNUAF_SHOT_DIR ?? resolve(__dirname, '..', 'test-results', 'ui-shots')
// [file name, destination, surface: sheet, expanded list, or null for the unobstructed workspace]
const SCREENS: [string, string, 'checkup' | 'settings' | 'materials' | 'files' | null][] = [
  ['02-checkup', '점검', 'checkup'],
  ['02b-chat', '내 논문', null], // unobstructed workspace
  ['07-materials', '자료', 'materials'],
  ['04-artifacts', '결과물', 'files'],
  ['08-settings', '설정', 'settings'],
]


/**
 * 캡처 동안만 움직임을 끄고 **최종 상태**로 찍는다(QA3-WIN-R02).
 *
 * `dialog[open].sheet` 의 여는 움직임(`materialize`)은 `opacity: 0` 에서 시작하고 막
 * (`::backdrop`)도 `backdrop-in` 으로 0 에서 시작한다(`styles/motion.css:17-18`). 실측하면 시트를
 * 연 직후 계산된 투명도가 **0.03 · 막 0.07** 이다. 숨김 실행 창은 화면 프레임이 뜸하게 만들어져,
 * 캡처가 그 초기 프레임에 걸리면 **시트도 막도 안 보이는** 사진이 남는다 — 윈도우 CI 의
 * `08-settings.png` 가 시트를 닫은 장면(`02b-chat.png`)과 **바이트까지 같은**(27,980 바이트) 파일로
 * 남은 것이 그 증거다. Playwright 의 `toBeVisible` 은 투명도를 보지 않으므로 단언은 통과했다.
 *
 * 사진이 담는 것은 정지한 화면이므로, 캡처 동안 움직임을 끄고 끝 상태(투명도 1)로 찍는다.
 * 제품 CSS 는 건드리지 않는다 — 이 시험의 문서용 사진에만 적용된다.
 */
const FREEZE = `*, *::before, *::after { animation: none !important; transition: none !important; }
dialog[open].sheet { opacity: 1 !important; transform: none !important; filter: none !important; }
dialog[open].sheet::backdrop { opacity: 1 !important; }`

/**
 * 이 장면의 시트가 **사진에 실제로 그려질 상태**인지 확인한다.
 *
 * `toBeVisible` 만으로는 부족하다(위 FREEZE 주석: 투명도 0 도 "보임"이다) — 계산된 투명도
 * (시트와 막)와 상자 크기를 함께 본다. 앱이 시트를 못 여는 경우는 `toBeVisible` 이 잡고,
 * "열렸는데 사진에는 없다"(투명하거나 0 크기)는 이 검사가 잡는다 — 조용히 잘못된 그림을 남기지 않는다.
 */
async function assertSheetPainted(page: Page, screen: string): Promise<void> {
  const el = page.locator(`[data-screen="${screen}"]`)
  await expect(el, `${screen} 시트가 열리지 않았다`).toBeVisible({ timeout: 30_000 })
  const state = (): Promise<{ paint: string; w: number; h: number }> => el.evaluate((n) => {
    const box = n.getBoundingClientRect()
    // 막은 dialog 에만 있다(SheetOver 는 논문 칸을 덮는 div 다).
    const back = n.tagName === 'DIALOG' ? getComputedStyle(n, '::backdrop').opacity : '1'
    return { paint: `${getComputedStyle(n).opacity}|${back}`, w: Math.round(box.width), h: Math.round(box.height) }
  })
  await expect.poll(async () => (await state()).paint, {
    message: `${screen} 시트가 사진에 그려지지 않는다 — 투명하거나 막이 없다`,
    timeout: 15_000
  }).toBe('1|1')
  const { w, h } = await state()
  expect(w, `${screen} 시트가 가로로 비어 있다`).toBeGreaterThan(200)
  expect(h, `${screen} 시트가 세로로 비어 있다`).toBeGreaterThan(200)
  await page.waitForTimeout(600) // 그려진 뒤 색·레이아웃이 안정될 때까지(내용이 늦게 차는 화면)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme})`, async () => {
    // deps.ensure (venv + pip install) can take minutes on a cold project.
    test.setTimeout(300_000)
    mkdirSync(OUT, { recursive: true })   // 기본은 app/test-results/ui-shots(추적 안 됨)
    const root = synthProject()
    // Pre-stage the docx input so '논문 파일(워드) 만들기' skips paper.generate and goes straight to docx.build.
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build', '검토전_본문.md'), '# Ⅰ. 머리말\n\n농장A의 재배 면적은 600평이다.\n', 'utf-8')
    const { electronApp, page } = await launch({ colorScheme: scheme, env: fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' }) })
    await page.setViewportSize(DEFAULT_WINDOW)
    // documentation shots use the solid sidebar (vibrancy is not captured by the web layer)
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    // 사진은 **정지한 화면**을 담는다 — 움직임은 캡처 동안만 끄고 최종 상태로 찍는다(아래 FREEZE).
    await page.addStyleTag({ content: FREEZE })
    const suffix = scheme === 'dark' ? '-dark' : ''
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/01-home${suffix}.png` })
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    await navTo(page, '점검')
    await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
    for (const [file, nav, screen] of SCREENS) {
      await navTo(page, nav)
      if (screen === 'materials' || screen === 'files') {
        await expect(page.locator('.paper-head .popover'), `${screen} 목록이 열리지 않았다`).toBeVisible({ timeout: 30_000 })
        await page.waitForTimeout(600)
      } else if (screen) {
        await assertSheetPainted(page, screen)
      } else {
        // No sheet or overlay should remain in the unobstructed workspace capture.
        await expect(page.locator('dialog[open], .sheetover'), '시트가 닫히지 않았다').toHaveCount(0, { timeout: 30_000 })
        await page.waitForTimeout(600)
      }
      await page.screenshot({ path: `${OUT}/${file}${suffix}.png` })
    }

    // 파일 팝오버에서 DOCX 실행 후 같은 줄의 완료 상태를 캡처한다.
    await navTo(page, '결과물')
    const pop = page.locator('.paper-head .popover')
    const docxRow = pop.locator('[data-make="docx"]')
    await docxRow.getByRole('button').click()
    await expect(docxRow.locator('.make-fb')).toContainText('DOCX를 만들었어요', { timeout: 120_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/04b-artifacts-made${suffix}.png` })
    await electronApp.close()
  })
}
