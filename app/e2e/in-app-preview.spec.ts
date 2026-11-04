import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, navTo, openProject, python, repo, seedChat, shellCalls, spyShell, synthProject } from './helpers'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/4xoAAAAASUVORK5CYII='

function makeDocx(path: string, variant = 'normal'): void {
  mkdirSync(dirname(path), { recursive: true })
  const script = `${path}.gen.py`
  writeFileSync(script, `
import base64, sys, zipfile
from io import BytesIO
from docx import Document

p = sys.argv[1]
variant = sys.argv[2]
doc = Document()
if variant == 'style-escape':
    doc.styles['Normal'].font.name = 'x;}</style><a id=inj href=https://preview.invalid/x>INJECTED</a><script>window.__preview_style_escape=1</script><style>.y{'
elif variant == 'css-escape':
    doc.styles['Normal'].font.name = r'x;}body{background-image:\\75rl(https://preview.invalid/cssesc.png)}.y{'
paragraph = doc.add_paragraph()
paragraph.add_run("한글 문서 견본")
paragraph.add_run().add_picture(BytesIO(base64.b64decode('${PNG}')))
table = doc.add_table(rows=1, cols=2)
table.cell(0, 0).merge(table.cell(0, 1)).text = "병합 표 셀"
doc.save(p)

with zipfile.ZipFile(p, 'r') as source:
    files = {name: source.read(name) for name in source.namelist()}
document = files['word/document.xml'].decode('utf-8')
document = document.replace('<w:sectPr', '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:hyperlink r:id="rLink"><w:r><w:t>외부 링크 텍스트</w:t></w:r></w:hyperlink></w:p><w:p><m:oMath><m:r><m:t>수식 견본</m:t></m:r></m:oMath></w:p><w:altChunk r:id="rChunk"/><w:sectPr', 1)
files['word/document.xml'] = document.encode('utf-8')
rels = files['word/_rels/document.xml.rels'].decode('utf-8')
rels = rels.replace('</Relationships>', '<Relationship Id="rFoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://preview.invalid/link" TargetMode="External"/><Relationship Id="rChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk.html"/></Relationships>')
files['word/_rels/document.xml.rels'] = rels.encode('utf-8')
types = files['[Content_Types].xml'].decode('utf-8')
types = types.replace('</Types>', '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>')
if variant == 'font-comment':
    R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
    payload = '--><a id="cmt-a" href="https://preview.invalid/font">FONT_LINK</a><img id="cmt-img" src="https://preview.invalid/font.png"><!--'
    escaped = payload.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
    files['word/_rels/document.xml.rels'] = files['word/_rels/document.xml.rels'].replace(b'</Relationships>', f'<Relationship Id="rFont" Type="{R}/fontTable" Target="fontTable.xml"/></Relationships>'.encode())
    types = types.replace('</Types>', '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>')
    files['word/fontTable.xml'] = f'<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="{R}"><w:font w:name="{escaped}"><w:embedRegular r:id="rF1" w:fontKey="{{00112233-4455-6677-8899-AABBCCDDEEFF}}"/></w:font></w:fonts>'.encode()
    files['word/_rels/fontTable.xml.rels'] = f'<Relationships xmlns="{PKG}"><Relationship Id="rF1" Type="{R}/font" Target="fonts/f1.odttf"/></Relationships>'.encode()
    files['word/fonts/f1.odttf'] = bytes(range(256)) * 4
files['[Content_Types].xml'] = types.encode('utf-8')
files['word/footnotes.xml'] = '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="-1" w:type="separator"><w:p/></w:footnote><w:footnote w:id="0" w:type="continuationSeparator"><w:p/></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>각주 견본 텍스트</w:t></w:r></w:p></w:footnote></w:footnotes>'.encode('utf-8')
files['word/afchunk.html'] = b'<script>window.__preview_altchunk=1</script><img src="https://preview.invalid/altchunk.png"/>'
if variant == 'bomb':
    files['customXml/blob.bin'] = b'A' * (50 * 1024 * 1024 + 1)
with zipfile.ZipFile(p, 'w', compression=zipfile.ZIP_DEFLATED) as result:
    for name, data in files.items(): result.writestr(name, data)
`)
  const result = spawnSync(python, [script, path, variant], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stdout + result.stderr)
}

function watchDocxFrameRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith('data:')) return
    if (request.frame().parentFrame() === page.mainFrame()) requests.push(request.url())
  })
  return requests
}

test('DOCX preview renders inert Korean text, merged table, footnote and image', async () => {
  const root = synthProject()
  const file = join(root, 'build', '가짜-문서.docx')
  makeDocx(file)
  seedChat(root, '견본 파일 [가짜-문서.docx](build/가짜-문서.docx)')
  const { electronApp, page } = await launch()
  const externalRequests = watchDocxFrameRequests(page)
  try {
    await openProject(page, root)
    await page.evaluate(() => {
      const activeWindow = window as Window & { __previewActiveCreates?: number }
      activeWindow.__previewActiveCreates = 0
      const createElement = Document.prototype.createElement
      Document.prototype.createElement = function (tagName: string, options?: ElementCreationOptions): HTMLElement {
        if (this === document && /^(script|img|object|embed)$/i.test(tagName)) activeWindow.__previewActiveCreates!++
        return createElement.call(this, tagName, options)
      }
    })
    await page.getByRole('button', { name: '가짜-문서.docx' }).click()
    await expect(page.getByRole('heading', { name: '가짜-문서.docx' })).toBeVisible()
    const frame = page.frameLocator('iframe[title="DOCX 미리보기"]')
    await expect(frame.getByText('한글 문서 견본')).toBeVisible({ timeout: 30_000 })
    await expect(frame.getByText('병합 표 셀')).toBeVisible()
    await expect(frame.getByText('각주 견본 텍스트')).toBeVisible()
    await expect(page.getByText('앱 안에서 못 보여 주는 그림·수식이 있어요. 정확한 모양은 "원래 앱으로 열기"로 보세요.')).toBeVisible()
    await expect(page.locator('iframe[title="DOCX 미리보기"]')).toHaveAttribute('sandbox', '')
    await expect(frame.locator('script, a[href], iframe, object, embed')).toHaveCount(0)
    await expect(frame.locator('img[src^="data:image/"]')).toHaveCount(1)
    const srcdoc = await page.locator('iframe[title="DOCX 미리보기"]').getAttribute('srcdoc')
    expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`)
    expect(await page.evaluate(() => (window as Window & { __previewActiveCreates?: number }).__previewActiveCreates)).toBe(0)
    expect(externalRequests).toEqual([])
  } finally {
    await electronApp.close()
  }
})

test('DOCX font names stay inert and CSS escapes remain blocked by CSP', async () => {
  const root = synthProject()
  const fixtures = [
    ['style-escape.docx', 'style-escape'],
    ['font-comment.docx', 'font-comment'],
    ['css-escape.docx', 'css-escape']
  ] as const
  for (const [name, variant] of fixtures) makeDocx(join(root, 'build', name), variant)
  seedChat(root, fixtures.map(([name]) => `[${name}](build/${name})`).join(' '))
  const { electronApp, page } = await launch()
  const nonDataRequests = watchDocxFrameRequests(page)
  const cspViolations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text())
  })
  await page.context().route(/^https?:/, (route) => route.abort())
  try {
    await openProject(page, root)
    for (const [name, variant] of fixtures) {
      await page.getByRole('button', { name, exact: true }).click()
      const preview = page.locator('dialog[data-screen="preview"]')
      await expect(preview.getByRole('heading', { name })).toBeVisible()
      const frame = page.frameLocator('iframe[title="DOCX 미리보기"]')
      await expect(frame.getByText('한글 문서 견본')).toBeVisible({ timeout: 30_000 })
      await expect(frame.locator('script, a[href], #inj, #cmt-a, #cmt-img, iframe, object, embed')).toHaveCount(0)
      const srcdoc = await preview.locator('iframe[title="DOCX 미리보기"]').getAttribute('srcdoc')
      expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`)
      if (variant === 'style-escape') expect(srcdoc).toContain('\\3c /style')
      if (variant === 'font-comment') expect(srcdoc).toContain('\\3c a id=')
      if (variant === 'css-escape') {
        const image = await frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundImage)
        expect(image).toContain('https://preview.invalid/cssesc.png')
      }
      const scriptRan = await frame.locator('body').evaluate((body) =>
        (body.ownerDocument.defaultView as (Window & { __preview_style_escape?: boolean }) | null)?.__preview_style_escape
      )
      expect(scriptRan).toBeUndefined()
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
    }
    const cssEscapeUrl = 'https://preview.invalid/cssesc.png'
    expect(nonDataRequests.filter((url) => url !== cssEscapeUrl)).toEqual([])
    if (nonDataRequests.includes(cssEscapeUrl)) {
      expect(cspViolations.some((message) => message.includes(cssEscapeUrl))).toBe(true)
    }
  } finally {
    await electronApp.close()
  }
})

test('preview:read rejects oversized DOCX and preflights XLSX before the sidecar', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  makeDocx(join(root, 'build', '압축-폭탄.docx'), 'bomb')
  writeFileSync(join(root, 'build', '손상.xlsx'), 'not a ZIP archive')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    const results = await page.evaluate(async () => ({
      docx: await window.knuaf.previewRead('build/압축-폭탄.docx'),
      xlsx: await window.knuaf.previewRead('build/손상.xlsx')
    }))
    expect(results.docx).toMatchObject({ result: { kind: 'preview_error', ext: '.docx', reason: 'too_large' } })
    expect(results.xlsx).toMatchObject({ result: { kind: 'preview_error', ext: '.xlsx', reason: 'format' } })
  } finally {
    await electronApp.close()
  }
})

test('preview IPC uses the current project and refuses the legacy renderer artifact RPC', async () => {
  const rootA = synthProject()
  const rootB = synthProject()
  mkdirSync(join(rootA, 'build'), { recursive: true })
  writeFileSync(join(rootA, 'build', 'inside.txt'), '현재 논문')
  mkdirSync(join(rootB, 'build'), { recursive: true })
  writeFileSync(join(rootB, 'build', 'outside.txt'), '다른 논문 비밀')
  writeFileSync(join(rootA, 'build', 'rows.csv'), '이름,값\n사과,3')
  writeFileSync(join(rootA, 'build', 'pixel.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(rootA, 'build', 'legacy.hwp'), '수동으로 열 문서')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, rootA)
    const results = await page.evaluate(async ({ rootB }) => {
      const inside = await window.knuaf.previewRead('build/inside.txt')
      const csv = await window.knuaf.previewRead('build/rows.csv')
      const image = await window.knuaf.previewRead('build/pixel.png')
      const legacyFormat = await window.knuaf.previewRead('build/legacy.hwp')
      const outside = await window.knuaf.previewRead(rootB + '/build/outside.txt')
      const legacy = await window.knuaf.call('artifact.preview', { root: rootB, path: 'build/outside.txt' })
      return { inside, csv, image, legacyFormat, outside, legacy }
    }, { rootB })
    expect(results.inside).toMatchObject({ result: { kind: 'text', text: '현재 논문' } })
    expect(results.csv).toMatchObject({ result: { kind: 'text', text: '이름,값\n사과,3' } })
    expect(results.image).toMatchObject({ result: { kind: 'image', name: 'pixel.png', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) } })
    expect(results.legacyFormat).toMatchObject({ result: { kind: 'unsupported' } })
    expect(results.outside).toMatchObject({ error: { code: 'outside_project' } })
    expect(results.legacy).toMatchObject({ error: { code: 'invalid_method' } })
    expect(JSON.stringify(results)).not.toContain('다른 논문 비밀')
  } finally {
    await electronApp.close()
  }
})

test('file existence IPC reports current files and rejects a project-root escape', async () => {
  const root = synthProject()
  const outsideName = `${basename(root)}-outside.json`
  writeFileSync(join(dirname(root), outsideName), '{}')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    const before = await page.evaluate(async ({ root, outsideName }) => ({
      missing: await window.knuaf.fileExists(root, 'paper-input.json'),
      outside: await window.knuaf.fileExists(root, `../${outsideName}`)
    }), { root, outsideName })
    expect(before).toEqual({ missing: { result: false }, outside: { result: false } })

    writeFileSync(join(root, 'paper-input.json'), JSON.stringify({ title: '시험 논문' }))
    const after = await page.evaluate((projectRoot) => window.knuaf.fileExists(projectRoot, 'paper-input.json'), root)
    expect(after).toEqual({ result: true })
  } finally {
    await electronApp.close()
  }
})

test('file popover and checkup actions open the shared preview sheet', async () => {
  const root = synthProject()
  makeDocx(join(root, 'build', '가짜-점검.docx'))
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('button', { name: /파일 \d+/ }).click()
    await page.getByRole('button', { name: /가짜-점검\.docx/ }).click()
    await expect(page.getByRole('heading', { name: '가짜-점검.docx' })).toBeVisible()
    await expect(page.frameLocator('iframe[title="DOCX 미리보기"]').getByText('한글 문서 견본')).toBeVisible()
    await page.keyboard.press('Escape')
    await navTo(page, '점검')
    await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
    const fileAction = page.locator('button:has-text("미리보기")').first()
    await expect(fileAction).toBeVisible()
    await fileAction.click()
    await expect(page.getByRole('heading', { name: '가짜-점검.docx' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
test('absolute result-card paths preview the generated workbook from Artifacts and Checkup', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    const artifacts = page.locator('[data-screen="artifacts"]')
    await artifacts.locator('.make-row', { hasText: '재무 엑셀 만들기' }).getByRole('button', { name: '만들기' }).click()
    const result = artifacts.locator('.result-ok')
    await expect(result).toBeVisible({ timeout: 30_000 })
    const path = await result.locator('.result-path code').innerText()
    expect(existsSync(path)).toBeTruthy()
    for (const destination of ['결과물', '점검']) {
      if (destination === '점검') await navTo(page, destination)
      const card = page.locator(`[data-screen="${destination === '결과물' ? 'artifacts' : 'checkup'}"] .result-ok`)
      await expect(card).toBeVisible()
      expect(await card.locator('.result-path code').innerText()).toBe(path)
      await card.getByRole('button', { name: '열기' }).click()
      const preview = page.locator('dialog[data-screen="preview"]')
      await expect(preview).toBeVisible()
      await expect(preview.getByRole('heading', { name: '검토전_재무.xlsx' })).toBeVisible()
      await expect(preview.locator('table.preview-table')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
    }
  } finally {
    await electronApp.close()
  }
})

test('long-file preview notice uses the compact local badge shape', async ({}, testInfo) => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '긴.csv'), '열,값\n' + '사과,3\n'.repeat(40_000))
  seedChat(root, '[긴.csv](build/긴.csv)')
  const { electronApp, page } = await launch({ reducedMotion: 'reduce' })
  try {
    await openProject(page, root)
    await page.getByRole('button', { name: '긴.csv', exact: true }).click()
    const preview = page.locator('dialog[data-screen="preview"]')
    await expect(preview.getByText(/파일이 길어서 앞부분만 보여 줘요/)).toBeVisible()
    const badge = preview.locator('.preview-truncation-badge .badge')
    await expect(badge).toBeVisible()
    expect(await badge.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('5px')
    await page.screenshot({ path: testInfo.outputPath('long-preview.png') })
  } finally {
    await electronApp.close()
  }
})

test('DOCX preview finds listed and source-folder sibling PDFs without exposing Word conversion', async () => {
  const root = synthProject()
  const listedDocx = join(root, 'build', '목록.docx')
  const sourceDocx = join(root, 'sources', '출처.docx')
  makeDocx(listedDocx)
  makeDocx(sourceDocx)
  copyFileSync(join(repo, 'docs', '학생용-사용안내.pdf'), join(root, 'build', '목록.pdf'))
  copyFileSync(join(repo, 'docs', '학생용-사용안내.pdf'), join(root, 'sources', '출처.pdf'))
  seedChat(root, '[목록.docx](build/목록.docx) [출처.docx](sources/출처.docx)')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    for (const name of ['목록.docx', '출처.docx']) {
      await page.getByRole('button', { name, exact: true }).click()
      const preview = page.locator('dialog[data-screen="preview"]')
      await expect(page.frameLocator('iframe[title="DOCX 미리보기"]').getByText('한글 문서 견본')).toBeVisible()
      await expect(preview.getByRole('button', { name: 'PDF로 보기', exact: true })).toBeVisible()
      await expect(preview.getByRole('button', { name: 'Word로 PDF 만들기', exact: true })).toHaveCount(0)
      await preview.getByRole('button', { name: 'PDF로 보기', exact: true }).click()
      await expect(preview.locator('.preview-canvas canvas')).toBeVisible()
      await expect(preview.getByText(name === '목록.docx' ? '목록.pdf' : '출처.pdf')).toBeVisible()
      await preview.getByRole('button', { name: '문서 보기', exact: true }).click()
      await expect(page.frameLocator('iframe[title="DOCX 미리보기"]').getByText('한글 문서 견본')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
    }
  } finally {
    await electronApp.close()
  }
})

test('preview read failures stay with the requested file; missing and outside paths retain their routes', async () => {
  const root = synthProject()
  const outside = join(dirname(root), `${basename(root)}-outside.txt`)
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '손상.xlsx'), 'invalid spreadsheet')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(root, 'build', '밖.txt'))
  seedChat(root, '[손상.xlsx](build/손상.xlsx) [없음.txt](build/없음.txt) [밖.txt](build/밖.txt)')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.getByRole('button', { name: '손상.xlsx', exact: true }).click()
    const preview = page.locator('dialog[data-screen="preview"]')
    await expect(preview).toBeVisible()
    await expect(preview.getByText('미리보기를 불러오지 못했어요.', { exact: true })).toBeVisible()
    await expect(preview.getByRole('button', { name: '원래 앱으로 열기', exact: true })).toBeVisible()
    await expect(preview.getByText('불러오는 중…', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '없음.txt', exact: true }).click()
    const artifacts = page.locator('[data-screen="artifacts"]')
    await expect(artifacts.getByText('"없음.txt"을 찾지 못했어요.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '밖.txt', exact: true }).click()
    await expect(page.locator('[data-screen="artifacts"]').getByText('이 논문 폴더 밖의 파일은 열 수 없어요.', { exact: true })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('preview open errors and notices do not carry to another file or project', async () => {
  const rootA = synthProject()
  const rootB = synthProject()
  mkdirSync(join(rootA, 'build'), { recursive: true })
  mkdirSync(join(rootB, 'build'), { recursive: true })
  writeFileSync(join(rootA, 'build', 'A.txt'), 'A 내용')
  writeFileSync(join(rootA, 'build', 'B.txt'), 'B 내용')
  writeFileSync(join(rootB, 'build', 'B.txt'), 'B 내용')
  seedChat(rootA, '[A.txt](build/A.txt) [B.txt](build/B.txt) [없음.xlsx](build/없음.xlsx)')
  seedChat(rootB, '[B.txt](build/B.txt)')
  const log = join(rootA, 'shell.log')
  const { electronApp, page } = await launch()
  try {
    await spyShell(electronApp, log, { openFailure: 'fake failure' })
    await openProject(page, rootA)
    await page.getByRole('button', { name: 'A.txt', exact: true }).click()
    await page.getByRole('button', { name: '원래 앱으로 열기', exact: true }).click()
    await expect(page.getByText(/파일을 열지 못해/)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'B.txt', exact: true }).click()
    const preview = page.locator('dialog[data-screen="preview"]')
    await expect(preview.getByText('B 내용', { exact: true })).toBeVisible()
    await expect(preview.getByText(/파일을 열지 못해/)).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '없음.xlsx', exact: true }).click()
    await expect(page.locator('[data-screen="artifacts"]').getByText('"없음.xlsx"을 찾지 못했어요.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await openProject(page, rootB)
    await navTo(page, '결과물')
    await expect(page.getByText('"없음.xlsx"을 찾지 못했어요.', { exact: true })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('late external-open failure does not attach to a reopened preview of the same file', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'A.txt'), 'A 내용')
  seedChat(root, '[A.txt](build/A.txt)')
  const log = join(root, 'shell.log')
  const { electronApp, page } = await launch()
  try {
    await spyShell(electronApp, log, { openFailure: 'fake failure' })
    await openProject(page, root)
    await electronApp.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const original = handlers.get('shell:open')
      if (!original) throw new Error('shell:open handler is missing')
      const gate = Promise.withResolvers<void>()
      const state = { entered: false, release: () => gate.resolve() }
      ;(globalThis as typeof globalThis & { __heldShellOpen?: typeof state }).__heldShellOpen = state
      handlers.set('shell:open', async (...args) => {
        const reply = await original(...args)
        state.entered = true
        await gate.promise
        return reply
      })
    })

    const trigger = page.getByRole('button', { name: 'A.txt', exact: true })
    const preview = page.locator('dialog[data-screen="preview"]')
    await trigger.click()
    await expect(preview.getByText('A 내용', { exact: true })).toBeVisible()
    await preview.getByRole('button', { name: '원래 앱으로 열기', exact: true }).click()
    await expect.poll(() => electronApp.evaluate(() =>
      (globalThis as typeof globalThis & { __heldShellOpen?: { entered: boolean } }).__heldShellOpen?.entered
    )).toBe(true)

    await preview.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await trigger.click()
    await expect(preview.getByText('A 내용', { exact: true })).toBeVisible()
    await expect(preview.getByText(/파일을 열지 못해/)).toHaveCount(0)

    await electronApp.evaluate(() =>
      (globalThis as typeof globalThis & { __heldShellOpen?: { release: () => void } }).__heldShellOpen?.release()
    )
    // Drain renderer IPC and paint work without using a wall-clock delay.
    await page.evaluate(async () => {
      await window.knuaf.getSettings()
      await window.knuaf.getSettings()
      const frames = Promise.withResolvers<void>()
      requestAnimationFrame(() => requestAnimationFrame(() => frames.resolve()))
      await frames.promise
    })
    await expect(preview.getByText(/파일을 열지 못해/)).toHaveCount(0)
    const target = realpathSync(join(root, 'build', 'A.txt'))
    expect(shellCalls(log)).toEqual([`open\t${target}`, `reveal\t${target}`])
  } finally {
    await electronApp.evaluate(() =>
      (globalThis as typeof globalThis & { __heldShellOpen?: { release: () => void } }).__heldShellOpen?.release()
    )
    await electronApp.close()
  }
})


test('empty and undecodable images explain why no image is shown', async ({}, testInfo) => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '빈.png'), '')
  writeFileSync(join(root, 'build', '손상.png'), 'not an image')
  seedChat(root, '[빈.png](build/빈.png) [손상.png](build/손상.png)')
  const { electronApp, page } = await launch({ reducedMotion: 'reduce' })
  try {
    await openProject(page, root)
    await page.getByRole('button', { name: '빈.png', exact: true }).click()
    const preview = page.locator('dialog[data-screen="preview"]')
    await expect(preview.getByText('비어 있는 파일이에요', { exact: true })).toBeVisible()
    await expect(preview.locator('img')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '손상.png', exact: true }).click()
    await expect(preview.getByText('이미지를 표시하지 못했어요', { exact: true })).toBeVisible()
    await expect(preview.locator('img')).toHaveCount(0)
    await expect(preview.getByRole('button', { name: '원래 앱으로 열기', exact: true })).toBeVisible()
    await preview.evaluate(async (dialog) => { await Promise.allSettled(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)) })
    await page.screenshot({ path: testInfo.outputPath('broken-image-preview.png') })
  } finally {
    await electronApp.close()
  }
})

test('preview close restores its trigger and Files count fallback without closing Checkup', async () => {
  const root = synthProject()
  makeDocx(join(root, 'build', '초점.docx'))
  seedChat(root, '[초점.docx](build/초점.docx)')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    const chatTrigger = page.getByRole('button', { name: '초점.docx', exact: true })
    await chatTrigger.click()
    const preview = page.locator('dialog[data-screen="preview"]')
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(chatTrigger).toBeFocused()

    const filesTrigger = page.getByRole('button', { name: /파일 \d+/ })
    await filesTrigger.click()
    await page.locator('.popover').getByRole('button', { name: /초점\.docx/ }).click()
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(filesTrigger).toBeFocused()

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800))
    const chatTab = page.getByRole('tab', { name: '대화', exact: true })
    await expect(chatTab).toBeVisible()
    await chatTab.click()
    await navTo(page, '점검')
    const checkup = page.locator('[data-screen="checkup"]')
    await expect(checkup).toBeVisible()
    const checkTrigger = checkup.getByRole('button', { name: '미리보기', exact: true }).first()
    await checkTrigger.focus()
    await checkTrigger.press('Enter')
    await expect(preview).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(checkup).toBeVisible()
    await expect(checkTrigger).toBeFocused()

    await checkTrigger.click()
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(checkup).toBeVisible()
    await expect(checkTrigger).toBeFocused()
  } finally {
    await electronApp.close()
  }
})
