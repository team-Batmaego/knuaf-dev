import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function preview(withPackages: boolean): PreviewPayload {
  const result = spawnSync(python, ['-X', 'utf8', ...(withPackages ? [] : ['-S']), '-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from knuaf_sidecar.methods_core import _xlsx_preview
print(json.dumps(_xlsx_preview(Path(sys.argv[2])), ensure_ascii=False))
`, join(app, 'sidecar'), workbook], { encoding: 'utf8' })
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
