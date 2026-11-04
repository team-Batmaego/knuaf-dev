import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, navTo, openProject, python, repo, synthProject } from './helpers'

const OUT = resolve(__dirname, 'artifacts')

/** Create an xlsx with 12 uncalculated formulas and a 210-row second sheet. */
function makeXlsx(path: string): void {
  const script = join(path + '.gen.py')
  writeFileSync(script, `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "재무"
ws["A1"] = "항목"
ws["B1"] = 1
for i in range(2, 14):
    ws.cell(row=i, column=1, value="항%d" % i)
    ws.cell(row=i, column=2, value="=B%d+1" % (i - 1))
ws2 = wb.create_sheet("긴 시트")
for r in range(1, 211):
    ws2.cell(row=r, column=1, value=r)
wb.save(${JSON.stringify(path)})
`, 'utf-8')
  const r = spawnSync(python, [script], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

test('결과물 화면: 목록, xlsx 표, pdf 페이지, docx 안내', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  makeXlsx(join(root, 'build', '재무.xlsx'))
  copyFileSync(join(repo, 'docs', '학생용-사용안내.pdf'), join(root, 'build', '안내.pdf'))
  writeFileSync(join(root, 'build', '빈.docx'), '')
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  await navTo(page, '결과물')
  await page.waitForSelector('[data-screen="artifacts"]', { timeout: 30_000 })

  // all three files are listed with kind badges
  for (const n of ['재무.xlsx', '안내.pdf', '빈.docx']) {
    await expect(page.locator('.artifact-list .item', { hasText: n })).toBeVisible()
  }

  // pdf renders on canvas with a page counter
  await page.click('.artifact-list .item:has-text("안내.pdf")')
  await page.waitForSelector('.preview-canvas canvas', { timeout: 30_000 })
  await expect(page.getByText(/\d+\/\d+ 페이지/)).toBeVisible()

  // xlsx renders as a table; the long sheet is truncated and formulas are flagged
  await page.click('.artifact-list .item:has-text("재무.xlsx")')
  await page.waitForSelector('table.preview-table', { timeout: 30_000 })
  await expect(page.locator('text=실제 Excel 재계산이 아직 안 됐어요')).toBeVisible()
  await page.click('button[role="tab"]:has-text("긴 시트")')
  await expect(page.getByText(/파일이 길어서 앞부분만 보여 줘요/)).toBeVisible()

  // Empty DOCX stays empty; the shared toolbar offers explicit external open/reveal.
  await page.click('.artifact-list .item:has-text("빈.docx")')
  await expect(page.getByText('비어 있는 파일이에요')).toBeVisible()
  await expect(page.getByRole('button', { name: '원래 앱으로 열기' })).toBeVisible()

  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, 'artifacts.png') })
  await electronApp.close()
})
