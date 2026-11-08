import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import type { PreviewPayload } from '../src/shared/types'
import { app, python, repo } from './helpers'

// Headless Chromium only: exercise the real Preview with real sidecar payloads,
// replacing Electron's transport, not the workbook reader or renderer.
let server: ViteDevServer
let fixture: string
let url: string
let workbook: string

function preview(withPackages: boolean, file = workbook): PreviewPayload {
  const result = spawnSync(python, ['-X', 'utf8', ...(withPackages ? [] : ['-S']), '-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from knuaf_sidecar.methods_core import _xlsx_preview
print(json.dumps(_xlsx_preview(Path(sys.argv[2])), ensure_ascii=False))
`, join(app, 'sidecar'), file], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout + result.stderr)
  return { ...JSON.parse(result.stdout), name: '재무.xlsx' }
}

test.beforeAll(async () => {
  fixture = mkdtempSync(join(app, '.xlsx-preview-'))
  workbook = join(fixture, '재무.xlsx')
  const generated = spawnSync(python, ['-c', `
import sys
from openpyxl import Workbook
wb = Workbook()
wb.active.append(['항목', '값'])
wb.active.append(['매출', 42])
wb.save(sys.argv[1])
`, workbook], { encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(generated.stdout + generated.stderr)
  writeFileSync(join(fixture, 'index.html'), '<html lang="ko"><meta charset="utf-8"><div id="root"></div><script type="module" src="/mount.tsx"></script></html>')
  writeFileSync(join(fixture, 'mount.tsx'), `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Preview } from '../src/renderer/src/components/Preview'
import '../src/renderer/src/styles.css'
createRoot(document.getElementById('root')!).render(createElement(Preview, { root: '/project', target: '/project/재무.xlsx', items: [] }))
`)
  server = await createServer({
    configFile: false, root: fixture, esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]
})

test.afterAll(async () => {
  await server?.close()
  if (fixture) rmSync(fixture, { recursive: true, force: true })
})

for (const platform of ['darwin', 'win32']) {
  test(`missing openpyxl shows a reason and external-open guidance (${platform})`, async ({ page }) => {
    const payload = preview(false)
    expect(payload.kind).toBe('unavailable')
    await page.addInitScript(({ payload, platform }) => {
      Object.assign(window, { knuaf: { platform, previewRead: async () => ({ result: payload }) } })
    }, { payload, platform })
    await page.goto(url)
    const feedback = page.getByRole('status')
    await expect(feedback).toBeVisible()
    await expect(feedback).toContainText((payload as Extract<PreviewPayload, { kind: 'unavailable' }>).reason)
    await expect(feedback).toContainText('원래 앱으로 열기')
    await expect(page.locator('table')).toHaveCount(0)
  })
}

test('available reader renders workbook cell values', async ({ page }) => {
  const payload = preview(true)
  expect(payload.kind).toBe('xlsx')
  await page.addInitScript(payload => {
    Object.assign(window, { knuaf: { platform: 'darwin', previewRead: async () => ({ result: payload }) } })
  }, payload)
  await page.goto(url)
  await expect(page.getByRole('cell', { name: '매출', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
})

test('a workbook with no tabular sheets shows an empty state', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { knuaf: {
      platform: 'darwin',
      previewRead: async () => ({ result: { kind: 'xlsx', name: '차트.xlsx', sheets: [], formulas: 0 } })
    } })
  })
  await page.goto(url)
  await expect(page.getByRole('status')).toContainText('비어 있는 파일')
})

/**
 * W-12 실기기 결함 — 시트 탭이 좁은 창에서 한 글자씩 세로로 꺾였다. 긴 한글 이름 여러 장을
 * 900×600 창에 띄워 ① 탭 글자가 한 줄인지 ② 넘치면 탭 줄이 가로로 스크롤되는지를 실제 DOM
 * 상자로 확인하고, 책임자 확인용 캡처를 남긴다.
 */
test('long sheet names stay on one line and the tab row scrolls horizontally at 900x600', async ({ page }) => {
  const multi = join(fixture, '재무-다중시트.xlsx')
  const generated = spawnSync(python, ['-c', `
import sys
from openpyxl import Workbook
wb = Workbook()
wb.active.title = '매출·비용 요약(2026년 상반기)'
wb.active.append(['항목', '값'])
wb.active.append(['매출', 42])
second = wb.create_sheet('재고 및 생산 계획 상세')
second.append(['품목', '수량'])
second.append(['사과', 7])
third = wb.create_sheet('현금흐름 추정')
third.append(['월', '금액'])
third.append(['1월', 3])
fourth = wb.create_sheet('시설 자금 투자 계획(2026~2027)')
fourth.append(['항목', '금액'])
fourth.append(['비닐하우스', 1200])
fifth = wb.create_sheet('손익분기점 분석')
fifth.append(['구분', '값'])
fifth.append(['BEP', 88])
sixth = wb.create_sheet('인건비·운영비 상세 내역')
sixth.append(['구분', '금액'])
sixth.append(['인건비', 55])
seventh = wb.create_sheet('대출 상환 계획(원리금 균등)')
seventh.append(['회차', '금액'])
seventh.append(['1회', 9])
wb.save(sys.argv[1])
`, multi], { encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(generated.stdout + generated.stderr)
  const payload = preview(true, multi)
  expect(payload.kind).toBe('xlsx')

  await page.setViewportSize({ width: 900, height: 600 })
  await page.addInitScript(payload => {
    Object.assign(window, { knuaf: { platform: 'darwin', previewRead: async () => ({ result: payload }) } })
  }, payload)
  await page.goto(url)

  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveCount(7)
  await expect(tabs.first()).toHaveText('매출·비용 요약(2026년 상반기)')
  for (const tab of await tabs.all()) {
    const box = await tab.evaluate((el) => {
      const style = getComputedStyle(el)
      const lineHeight = parseFloat(style.lineHeight)
      return { lines: el.getClientRects().length, height: el.clientHeight, lineHeight, whiteSpace: style.whiteSpace }
    })
    expect(box.whiteSpace).toBe('nowrap')
    expect(box.lines).toBe(1)
    expect(box.height).toBeLessThan(box.lineHeight * 2)
  }

  const strip = page.locator('.sheet-tabs')
  await expect(strip).toHaveCSS('overflow-x', 'auto')
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  await tabs.nth(1).click()
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('cell', { name: '사과', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '매출', exact: true })).toHaveCount(0)

  // 캡처는 저장소 밖(작업 폴더)에 남긴다 — 제품 저장소에는 넣지 않는다(책임자 지시).
  const out = process.env.KNUAF_W10_W12_SHOTS
  if (out) {
    mkdirSync(out, { recursive: true })
    await page.screenshot({ path: join(out, 'xlsx-sheet-tabs-900x600.png') })
  }
})
