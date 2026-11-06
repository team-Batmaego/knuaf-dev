/**
 * 검토 P3-R1 처분 시험 — 새 만들기 진입점의 고지·진행·결과(P3-R1-01), 프로젝트 기준 경로
 * (P3-R1-02), 파일별 검토본 기준(P3-R1-03), 늦게 생긴 입력 조건(P3-R1-05), 점검 시트의
 * 현재성(P3-R1-06).
 *
 * 전부 숨김 실행이다(`launch()` 가 `KNUAF_E2E_HIDDEN=1` 을 켠다).
 */
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, markSectionReady, navTo, openPreset, openProject, projectPrepared, python, rewriteSection, scripts, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { ARTIFACTS, OUTPUT_COPY } from '../src/renderer/src/copy'

/** `shell:open` 이 받은 값을 메모리에만 적어 둔다(문서 앱을 실제로 열지 않는다). */
async function captureOpenPath(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    type G = { __openedPath?: string }
    ipcMain.removeHandler('shell:open')
    ipcMain.handle('shell:open', (_e: unknown, p: string) => { (globalThis as G).__openedPath = p; return '' })
  })
}

async function openedPath(electronApp: ElectronApplication): Promise<string | undefined> {
  return electronApp.evaluate(() => (globalThis as { __openedPath?: string }).__openedPath)
}

/** 앱의 "새로고침" 메뉴 동작을 그대로 보낸다(네이티브 메뉴는 클릭할 수 없다). */
async function triggerRefresh(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('menu', { type: 'refresh' }) })
}

/** `build/<N>/review/검토용.md` 를 CLI 로 만든다. */
function exportReview(root: string): void {
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'export', root, '--kind', 'review', '--major', 'specialty_crops'], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

test('팝오버의 만들기 고지·결과가 그 줄 아래에 남는다 (P3-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()   // 독립검토 기록 없음 → 고지 대상
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    const reviewRow = pop.locator('.pop-make:has(b:text-is("검토본 만들기"))')
    await reviewRow.getByRole('button').click()

    // 시도 전후 모두 고지가 그 줄 아래에 있다.
    const fb = pop.locator('[data-make="review"] .make-fb')
    await expect(fb.first(), '다른 사람 검토 고지가 만들기 줄에 없다').toContainText('다른 사람 검토', { timeout: 10_000 })
    // 결과도 같은 자리에서 이어진다(경로 + 폴더에서 보기).
    await expect(pop).toContainText('검토본을 만들었어요', { timeout: 60_000 })
    await expect(pop.getByRole('button', { name: '폴더에서 보기' }).first()).toBeVisible()

    // 제출용 후보 — 관문이 막혀 있으면 그 이유가 같은 자리에 보인다.
    const submitRow = pop.locator('.pop-make:has(b:text-is("제출용 후보 만들기"))')
    await submitRow.getByRole('button').click()
    await expect(pop).toContainText('제출용 후보', { timeout: 30_000 })
    await expect(pop.locator('.make-fb.warning').last()).toBeVisible({ timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('팝오버를 닫아도 결과가 종이 머리 아래 한 줄로 이어진다 (P3-R1-01)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    await pop.locator('.pop-make:has(b:text-is("검토본 만들기"))').getByRole('button').click()
    await expect(pop).toContainText('검토본을 만들었어요', { timeout: 60_000 })

    // 팝오버를 닫으면 종이 머리 아래 한 줄로 같은 결과가 남는다.
    await page.keyboard.press('Escape')
    await expect(page.locator('.paperpane .popover')).toHaveCount(0)
    await expect(page.locator('.paper-fb')).toContainText('검토본을 만들었어요')

    // Reopening the Files list shows the same run result; no separate results screen remains.
    await navTo(page, '결과물')
    await expect(pop.locator('[data-make="review"]')).toContainText('검토본을 만들었어요')
  } finally {
    await electronApp.close()
  }
})

test('점검에서 파일을 열 때 프로젝트 기준 경로를 넘긴다 (P3-R1-02)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'probe.docx'), 'dummy')
  const { electronApp, page } = await launch()
  try {
    await captureOpenPath(electronApp)
    await openProject(page, root)
    await navTo(page, '점검')
    const sheet = page.locator('[data-screen="checkup"]')
    await expect(sheet).toContainText('probe.docx', { timeout: 30_000 })
    await sheet.locator('.file').filter({ hasText: 'probe.docx' }).getByRole('button').last().click()
    await expect.poll(() => openedPath(electronApp)).toBe(join(root, 'build', 'probe.docx'))
  } finally {
    await electronApp.close()
  }
})

test('검토본 줄은 각자 자기 기록 기준으로 말한다 (P3-R1-03)', async () => {
  const root = synthProject()
  exportReview(root)                                       // build/1/review/검토용.md
  rewriteSection(root, { body: '고친 본문이다.', expected: 1 })   // revision 2
  exportReview(root)                                       // build/2/review/검토용.md
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    // 두 줄이 서로 다른 기준을 말한다 — 최신 N 을 둘 다에 붙이면 여기서 걸린다.
    await expect(pop).toContainText('2번째 기록 기준')
    await expect(pop).toContainText('1번째 기록 기준')
  } finally {
    await electronApp.close()
  }
})

test('나중에 생긴 표지 입력을 새로고침이 알아챈다 (P3-R1-05)', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    const docxRow = pop.locator('.pop-make:has(b:text-is("논문 파일(워드) 만들기"))')
    await expect(docxRow.getByRole('button'), '표지 입력도 본문도 없으면 잠겨 있는 것이 맞다').toBeDisabled()

    // 도우미가 표지 입력을 준비했다 — 기록은 그대로이므로 새로고침이 그것을 봐야 한다.
    writeFileSync(join(root, 'paper-input.json'), JSON.stringify({ title: '시험 논문' }), 'utf-8')
    await triggerRefresh(electronApp)
    await expect(docxRow.getByRole('button'), '새로고침 뒤에도 입력을 못 본다').toBeEnabled({ timeout: 20_000 })

  } finally {
    await electronApp.close()
  }
})

test('점검 시트도 파일 팝오버와 같은 현재성을 말한다 (P3-R1-06)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'known.docx'), 'dummy')
  // 정본에 등록 산출물을 **직접** 심는다(검토자 재현과 같은 방식). gg apply 는 출력 계보
  // 검증(입력 버전·대상 일치)을 걸어서, 손으로 만든 항목은 거기서 거부된다.
  const projPath = join(root, 'project.json')
  const proj = JSON.parse(readFileSync(projPath, 'utf-8')) as { outputs?: Record<string, unknown> }
  proj.outputs = { ...(proj.outputs ?? {}), 'probe-docx': { id: 'probe-docx', path: 'build/known.docx', format: 'docx', revision: 1, stale: true } }
  writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf-8')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await navTo(page, '점검')
    const sheet = page.locator('[data-screen="checkup"]')
    // 팝오버와 같은 판정 — 등록된 파일은 stale 이면 그렇게 말한다('모름'이 아니다).
    await expect(sheet.locator('.file').filter({ hasText: 'known.docx' })).toContainText('고친 내용이 빠져 있어요', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('파일 현재성 문구는 근거 없는 파일에만 "모름"을 남긴다 (P3-R1-06)', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'unknown.docx'), 'dummy')
  expect(existsSync(join(root, 'build', 'unknown.docx'))).toBe(true)
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    await expect(page.locator('.paper-head .popover .pop-row').filter({ hasText: 'unknown.docx' })).toContainText('앱이 몰라요')
  } finally {
    await electronApp.close()
  }
})

/**
 * `project.export` 의 IPC 응답을 잠시 보류한다 — "만드는 중" 창을 결정적으로 만든다.
 *
 * 전에는 사이드카를 `SIGSTOP`/`SIGCONT` 으로 멈췄는데 그것은 POSIX 전용이라 윈도우에서는
 * `test.skip(win32)` 이었다. 이제는 앱의 `ipcMain 'rpc'` 핸들러를 감싸 첫 `project.export`
 * 만 풀어 줄 때까지 붙잡는다 — 신호도 사이드카 PID 도 필요 없고 두 플랫폼에서 같은 방식으로
 * 돈다. 렌더러의 `window.knuaf` 는 preload 가 동결해 시험에서 못 건드리므로 가로채는 자리는
 * main 이다(`electronApp.evaluate`).
 */
async function holdExport(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    // Electron 은 invoke 핸들러를 이 사설 맵에 둔다 — 원본을 꺼내 감싸는 공개 대안이 없다.
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
    const real = map.get('rpc')
    if (!real) throw new Error('rpc 핸들러를 찾지 못했다')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held = false
    ipcMain.removeHandler('rpc')
    ipcMain.handle('rpc', async (...args: unknown[]) => {
      if (!held && args[1] === 'project.export') { held = true; await gate }
      return real(...args)
    })
    ;(globalThis as { __releaseExport?: () => void }).__releaseExport = release
  })
}

async function releaseExport(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => { (globalThis as { __releaseExport?: () => void }).__releaseExport?.() })
}


test('만드는 중에도 시도 시점 고지가 두 자리에 보인다 (반례 ①)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    // "지금"이 3단계(검토본)여야 종이 머리에 권하는 단추가 선다 — 장을 다 쓴 상태로 올린다.
    markSectionReady(root)
    await expect(page.locator('.titlebar .tbtn.now')).toContainText('검토본', { timeout: 20_000 })
    await projectPrepared(page) // 정본 개정 뒤 문제 해결의 자동 재진단도 끝나야 한다.

    // export 응답을 보류한다 — 그 동안이 "시도 중"이다.
    await holdExport(electronApp)
    await expect(page.locator('.paper-head').getByRole('button', { name: '검토본 만들기' })).toBeVisible()
    await page.locator('.paper-head').getByRole('button', { name: '검토본 만들기' }).click()

    // 종이 머리 아래: 고지가 **보이고**, 그 아래에 만드는 중 줄이 있다.
    const strip = page.locator('.paper-fb')
    await expect(strip.locator('.make-fb.warning')).toBeVisible({ timeout: 15_000 })
    await expect(strip.locator('.make-fb.warning')).toContainText('다른 사람 검토')
    await expect(strip.locator('.make-fb.running')).toContainText('만드는 중')

    // 같은 실행의 팝오버 줄에도 고지가 보인다.
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    const fb = pop.locator('[data-make="review"] .make-fb')
    await expect(fb.filter({ hasText: '다른 사람 검토' })).toBeVisible()
    await expect(fb.filter({ hasText: '만드는 중' })).toBeVisible()

    // 응답을 풀면 같은 자리들이 결과로 바뀐다(시도 시점과 결과 시점이 구별된다).
    await releaseExport(electronApp)
    await expect(pop).toContainText('검토본을 만들었어요', { timeout: 60_000 })
  } finally {
    try { await releaseExport(electronApp) } catch { /* 이미 풀렸다 */ }
    await electronApp.close()
  }
})

test('DOCX 실패 이유가 두 자리에 보인다 (반례 ②)', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  markSectionReady(root)                    // 장을 다 씀 → 3단계
  exportReview(root)                        // 검토본이 있으면 4단계라 종이 머리에 DOCX 단추가 선다
  // 준비 실패가 아닌 실제 paper.generate 실패: 존재하지만 파싱할 수 없는 표지 입력.
  writeFileSync(join(root, 'paper-input.json'), '{', 'utf8')
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    const head = page.locator('.paper-head').getByRole('button', { name: /논문 파일/ })
    await expect(head).toBeVisible({ timeout: 20_000 })
    await head.click()

    const strip = page.locator('.paper-fb')
    await expect(strip.locator('.make-fb.error'), '종이 머리 아래에 실패 이유가 없다').toBeVisible({ timeout: 90_000 })
    await expect(strip.locator('.make-fb.error')).toContainText('만들기가 끝나지 않았어요')

    await page.locator('.paper-head button.lnk:has-text("파일")').click()
    await expect(page.locator('.paper-head .popover [data-make="docx"] .make-fb.error')).toContainText('만들기가 끝나지 않았어요')
  } finally {
    await electronApp.close()
  }
})

test('DOCX 성공 결과가 두 자리에 보인다 (반례 ③)', async () => {
  test.setTimeout(300_000)   // deps.ensure 는 프로젝트 .venv 를 만든다(다른 spec 과 같은 비용)
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '검토전_본문.md'), '# Ⅰ. 머리말\n\n농장A의 재배 면적은 600평이다.\n', 'utf-8')
  markSectionReady(root)
  exportReview(root)
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await expect(page.locator('.paperpane')).toBeVisible({ timeout: 20_000 })
    const head = page.locator('.paper-head').getByRole('button', { name: /논문 파일/ })
    await expect(head).toBeVisible({ timeout: 20_000 })
    await head.click()

    const strip = page.locator('.paper-fb')
    await expect(strip.locator('.make-fb.completion'), '종이 머리 아래에 결과가 없다').toBeVisible({ timeout: 120_000 })
    await expect(strip.locator('.make-fb.completion')).toContainText('DOCX를 만들었어요')
    await expect(strip.getByRole('button', { name: '폴더에서 보기' })).toBeVisible()

    // 파일 팝오버 단추는 이름이 '파일 N'으로 **끝나는** 것으로 집는다(앞에 '다시 만들어야 할' 점 이름이 붙을 수 있다). 결과 줄은 만들기가 끝난 즉시 뜨고
    // 권하는 단추는 뒤이은 refresh()(project.status) 뒤에 바뀐다 — 그 사이에는 '논문 파일 만들기'가
    // 남아 있어 `/파일/` 이 두 단추를 잡았다(윈도우 CI run 40407100458, 사이드카가 느린 때만).
    await page.locator('.paper-head').getByRole('button', { name: /파일 \d+$/ }).click()
    const pop = page.locator('.paper-head .popover')
    await expect(pop.locator('[data-make="docx"] .make-fb.completion')).toContainText('DOCX를 만들었어요')
    await expect(pop.locator('[data-make="docx"] .make-fb.completion').getByRole('button', { name: '폴더에서 보기' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

type PreflightProbe = {
  held: boolean
  release: () => void
  outputs: string[]
  cancelResults: unknown[]
  lookupReply?: unknown
}
type PreflightHost = typeof globalThis & { __preflightProbe: PreflightProbe }

/** Delay a real lookup reply after main has removed its inflight entry. */
async function holdMajorReply(app: ElectronApplication, ordinal: number): Promise<void> {
  await app.evaluate(({ ipcMain }, at) => {
    // Electron does not publicly type the handler registry used by this existing test seam.
    const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    const real = ipc._invokeHandlers.get('rpc')
    const cancel = ipc._invokeHandlers.get('rpc:cancel')
    if (!real || !cancel) throw new Error('missing real RPC handlers')
    const gate = Promise.withResolvers<void>()
    const probe: PreflightProbe = { held: false, release: gate.resolve, outputs: [], cancelResults: [] }
    // The probe belongs only to this isolated Electron test process.
    const host = globalThis as PreflightHost
    host.__preflightProbe = probe
    let lookups = 0
    ipcMain.removeHandler('rpc')
    ipcMain.handle('rpc', async (...args: unknown[]) => {
      if (args[1] === 'excel.create') probe.outputs.push('excel.create')
      const reply = await real(...args)
      if (args[1] === 'project.major' && ++lookups === at) {
        probe.lookupReply = reply
        probe.held = true
        await gate.promise
      }
      return reply
    })
    ipcMain.removeHandler('rpc:cancel')
    ipcMain.handle('rpc:cancel', async (...args: unknown[]) => {
      const result = await cancel(...args)
      probe.cancelResults.push(result)
      return result
    })
  }, ordinal)
}

async function preflightProbe(app: ElectronApplication) {
  return app.evaluate(() => {
    // Installed by holdMajorReply in this process.
    const host = globalThis as PreflightHost
    const { held, outputs, cancelResults, lookupReply } = host.__preflightProbe
    return { held, outputs, cancelResults, lookupReply }
  })
}

async function releaseMajorReply(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    // Installed by holdMajorReply in this process.
    const host = globalThis as PreflightHost
    host.__preflightProbe.release()
  })
}

for (const surface of ['make', 'advanced', 'lookup-error'] as const) {
  test(`R1-02: 실제 ${surface} 조회 뒤 취소·오류가 출력을 남기지 않고 busy를 끝낸다`, async () => {
    test.skip(!existsSync(join(scripts, 'gg_major_contract.py')), 'current major contract required')
    const dir = scratch()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', HOME: home, USERPROFILE: home })
    const root = synthProject({ withContent: surface !== 'lookup-error' })
    const out = surface === 'make' ? 'build/검토전_재무.xlsx' : 'build/cancelled.xlsx'
    const { electronApp, page } = await launch({ env })
    let probeInstalled = false
    try {
      await openProject(page, root)
      if (surface === 'make') {
        await navTo(page, '결과물')
      } else {
        await navTo(page, '설정')
        await openPreset(page, 'tools:excel')
        await page.locator('#xl_source').fill(join(scripts, '..', 'assets', 'templates', 'finance-template.xlsx'))
        await page.locator('#xl_blank').fill(out)
      }
      const create = surface === 'make'
        ? page.locator('.paper-head .popover [data-make="xlsx"]').getByRole('button', { name: '만들기', exact: true })
        : page.getByRole('button', { name: '사본 만들기', exact: true })
      const choose = page.locator('.paper-head .popover').getByRole('button', { name: OUTPUT_COPY.chooseX01, exact: true })
      if (surface === 'make') {
        await create.click()
        await expect(choose).toBeVisible()
      }
      // useMake also does an explicit template-choice lookup before its runner starts.
      await holdMajorReply(electronApp, surface === 'make' ? 2 : 1)
      probeInstalled = true
      if (surface === 'make') await choose.click()
      else await create.click()
      await expect.poll(async () => (await preflightProbe(electronApp)).held).toBe(true)
      await expect(create).toBeDisabled()
      if (surface === 'lookup-error') {
        expect((await preflightProbe(electronApp)).lookupReply).toMatchObject({ error: { code: 'major_required' } })
        await releaseMajorReply(electronApp)
      } else {
        const progress = surface === 'make' ? page.locator('.make-fb.running[aria-busy="true"]') : page.locator('.progress[aria-busy="true"]')
        await progress.getByRole('button', { name: '취소', exact: true }).click()
        // The UI must finish without waiting for the held read reply.
        await expect(create).toBeEnabled()
        expect((await preflightProbe(electronApp)).cancelResults).toEqual([false])
        await releaseMajorReply(electronApp)
      }
      await expect(create).toBeEnabled()
      await expect(page.locator('.progress[aria-busy="true"], .make-fb.running[aria-busy="true"]')).toHaveCount(0)
      // A real read round trip drains the late reply before checking for a resurrected write.
      await page.evaluate(async (rootPath) => window.knuaf.call('project.load', { root: rootPath }), root)
      expect((await preflightProbe(electronApp)).outputs).toEqual([])
      expect(existsSync(join(root, out))).toBe(false)
      await page.screenshot({ path: test.info().outputPath(`${surface}-settled.png`) })
      if (surface !== 'lookup-error') {
        await create.click()
        if (surface === 'make') await choose.click()
        await expect.poll(() => existsSync(join(root, out))).toBe(true)
        await expect(page.locator('.progress[aria-busy="true"], .make-fb.running[aria-busy="true"]')).toHaveCount(0)
        expect((await preflightProbe(electronApp)).outputs).toEqual(['excel.create'])
      }
    } finally {
      try { if (probeInstalled) await releaseMajorReply(electronApp) } finally { await electronApp.close() }
    }
  })
}
