import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'vite'
import { app, closeSheet, launch, navTo, openPreset, openProject, plantStaleLock, python, scripts, synthProject } from './helpers'
import type { Envelope, LockInfo } from '../src/shared/types'
import type { useProject as ProjectStore } from '../src/renderer/src/store/project'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

type RpcHandler = (...args: unknown[]) => Promise<unknown>
type LockProbe = { held: boolean; lockHeld: boolean; armLock: boolean; snapshot: LockInfo; release: () => void; releaseLock: () => void }
type MakeProbe = { built: boolean; held: boolean; release: () => void }
type ProbeHost = typeof globalThis & { __ci4: LockProbe; __ci4Make: MakeProbe }

type DiagnosisCalls = { lock: string[]; doctor: string[] }
type DiagnosisHost = typeof globalThis & { __diagnosisCalls: DiagnosisCalls; __doctorReplies: string[]; __releasePeek: () => void }
type ProjectProbe = { readonly root: string; readonly revision: number }

test('문제 해결이 보일 때만 잠금과 전체 진단을 조회한다', async () => {
  const root = synthProject()
  const other = synthProject()
  const env = fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const { electronApp, page } = await launch({ env })
  try {
    await electronApp.evaluate(({ ipcMain }, nextRoot) => {
      // Match the existing in-process RPC interception without changing Electron's types.
      const ipc: typeof ipcMain & { readonly _invokeHandlers?: ReadonlyMap<string, RpcHandler> } = ipcMain
      const real = ipc._invokeHandlers?.get('rpc')
      const peek = ipc._invokeHandlers?.get('project:peek')
      if (!real || !peek) throw new Error('project IPC handlers not found')
      const calls: DiagnosisCalls = { lock: [], doctor: [] }
      const gate = Promise.withResolvers<void>()
      const doctorReplies: string[] = []
      Object.assign(globalThis, { __diagnosisCalls: calls, __doctorReplies: doctorReplies, __releasePeek: gate.resolve })
      // open() publishes the new root before this reply closes the settings dialog.
      ipcMain.removeHandler('project:peek')
      ipcMain.handle('project:peek', async (...args: unknown[]) => {
        if (args[1] === nextRoot) await gate.promise
        return peek(...args)
      })
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        const params = args[2]
        if (typeof params === 'object' && params !== null && 'root' in params && typeof params.root === 'string') {
          if (args[1] === 'lock.info') calls.lock.push(params.root)
          if (args[1] === 'doctor.all') calls.doctor.push(params.root)
        }
        const reply = await real(...args)
        if (args[1] === 'doctor.all' && typeof params === 'object' && params !== null && 'root' in params && typeof params.root === 'string') {
          doctorReplies.push(params.root)
        }
        return reply
      })
    }, other)
    const calls = () => electronApp.evaluate(() => (globalThis as DiagnosisHost).__diagnosisCalls)
    const expectCalls = (roots: readonly string[]) => expect.poll(calls).toEqual({ lock: roots, doctor: roots })
    const expectDoctorReplies = (roots: readonly string[]) => expect.poll(() =>
      electronApp.evaluate(() => (globalThis as DiagnosisHost).__doctorReplies)).toEqual(roots)
    const settleDiagnosis = async () => {
      // Cross the committed render/effect boundary and then drain earlier sends from this renderer.
      await page.evaluate(async () => {
        const frame = Promise.withResolvers<void>()
        requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()))
        await frame.promise
        await window.knuaf.getSettings()
      })
    }
    const waitRevision = async (revision: number) => {
      await expect.poll(() => page.evaluate(() => {
        const host: Window & { readonly __knuafProjectProbe?: ProjectProbe } = window
        return host.__knuafProjectProbe
      })).toEqual({ root, revision })
      await settleDiagnosis()
    }
    const advanceRevision = async (revision: number) => {
      const change = join(root, `change-diagnosis-${revision}.json`)
      writeFileSync(change, JSON.stringify({ request_id: `e2e:diagnosis:${revision}`, ops: [] }))
      const saved = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(revision - 1)], { encoding: 'utf8' })
      expect(saved.status, saved.stdout + saved.stderr).toBe(0)
      await waitRevision(revision)
    }

    // Don't use projectPrepared here: it explicitly opens Troubleshoot.
    await openProject(page, root, undefined, { preparation: 'pending' })
    await waitRevision(2)
    const settings = page.locator('dialog[data-screen="settings"]')
    await expect(settings).not.toBeVisible()
    expect(await calls(), '폴더를 연 뒤 숨은 진단이 시작됐다').toEqual({ lock: [], doctor: [] })

    await navTo(page, '설정')
    const folderTab = settings.getByRole('button', { name: '폴더', exact: true })
    const troubleTab = settings.getByRole('button', { name: '문제 해결', exact: true })
    const lockHead = settings.locator('details[data-preset="fix:lock"] .card-head')
    await folderTab.click()
    await settleDiagnosis()
    expect(await calls(), '다른 설정 탭에서 진단이 시작됐다').toEqual({ lock: [], doctor: [] })
    await troubleTab.click()
    await expectCalls([root])
    await expect(lockHead).toContainText('잠금 구조 확인됨')
    await expectDoctorReplies([root])

    await folderTab.click()
    await expect(folderTab).toHaveAttribute('aria-current', 'page')
    await advanceRevision(3)
    expect(await calls(), '다른 탭으로 옮긴 뒤 개정 갱신이 진단을 시작했다').toEqual({ lock: [root], doctor: [root] })
    // The new aggregate must reach the UI, not just repeat the request for this root.
    const orphan = '.gg-import-diagnosis-after-tab-switch'
    mkdirSync(join(root, orphan))

    await troubleTab.click()
    await expectCalls([root, root])
    await expect(lockHead).toContainText('잠금 구조 확인됨')
    await openPreset(page, 'fix:orphans')
    await expect(settings.locator('details[data-preset="fix:orphans"]')).toContainText(orphan)
    await expectDoctorReplies([root, root])
    await settleDiagnosis()
    expect(await calls()).toEqual({ lock: [root, root], doctor: [root, root] })

    await advanceRevision(4)
    await expectCalls([root, root, root])
    await expect(lockHead).toContainText('잠금 구조 확인됨')
    await expectDoctorReplies([root, root, root])

    await closeSheet(page)
    await expect(settings).not.toBeVisible()
    await advanceRevision(5)
    expect(await calls(), '설정을 닫은 뒤 개정 갱신이 진단을 다시 시작했다').toEqual({ lock: [root, root, root], doctor: [root, root, root] })

    // Reopening retains the selected tab. Then switch projects through the real menu subscription.
    await navTo(page, '설정')
    await expect(troubleTab).toHaveAttribute('aria-current', 'page')
    await expectCalls([root, root, root, root])
    try {
      await electronApp.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('menu', { type: 'open-recent', root: target })
      }, other)
      await expectCalls([root, root, root, root, other])
      await expect(settings).toBeVisible()
      await expect(lockHead).toContainText('잠금 구조 확인됨')
    } finally {
      await electronApp.evaluate(() => (globalThis as DiagnosisHost).__releasePeek())
    }
    await expect(settings).not.toBeVisible()
  } finally { await electronApp.close() }
})

test('문제 해결 딥링크는 닫힌 설정을 열고 지정한 펼침을 표시한다', async () => {
  // No shipped button currently supplies a fix:* focus. Load the real renderer modules
  // to enter through the same openSettings action as failure-feedback links, not a manual tab click.
  const server = await createServer({ configFile: false, root: join(app, 'src/renderer'),
    esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [dirname(app)] } },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    plugins: [{ name: 'diagnosis-entry', configureServer(vite) {
      vite.middlewares.use('/diagnosis-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/src/main.tsx"></script>')
      })
    } }] })
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('renderer test server not listening')
    const root = synthProject()
    const env = fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in', ELECTRON_RENDERER_URL: new URL('diagnosis-test', url).href })
    const { electronApp, page } = await launch({ env })
    try {
      await openProject(page, root, undefined, { preparation: 'pending' })
      const settings = page.locator('dialog[data-screen="settings"]')
      await expect(settings).not.toBeVisible()
      await page.evaluate(async () => {
        // Resolve in the Electron renderer, not in Playwright's Node process.
        const path = '/src/store/project.ts'
        const { useProject }: { useProject: typeof ProjectStore } = await import(path)
        useProject.getState().openSettings('fix:lock')
      })
      await expect(settings).toBeVisible()
      await expect(settings.getByRole('button', { name: '문제 해결', exact: true })).toHaveAttribute('aria-current', 'page')
      const lock = settings.locator('details[data-preset="fix:lock"][open]')
      await expect(lock.getByRole('button', { name: '점유 상태 확인' })).toBeVisible()
      await expect(lock.locator('.card-head')).toContainText('잠금 구조 확인됨')
    } finally { await electronApp.close() }
  } finally { await server.close() }
})

type ToolPreparationProbe = {
  clientId: string | null
  cancelled: string[]
  diagnosis: string[]
  doctorDone: number
  finish: () => void
}
type ToolPreparationHost = typeof globalThis & { __toolPreparation: ToolPreparationProbe }

for (const surface of ['설정 닫기', '다른 탭'] as const) {
  test(`도구 준비 중 ${surface}: 진행과 취소를 잃지 않고 숨은 완료는 재진단하지 않는다`, async () => {
    const root = synthProject()
    const env = fakeCodexEnv(join(scratch(), 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
    const { electronApp, page } = await launch({ env })
    try {
      await openProject(page, root)
      await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
        const ipc: typeof ipcMain & { readonly _invokeHandlers?: ReadonlyMap<string, RpcHandler> } = ipcMain
        const real = ipc._invokeHandlers?.get('rpc')
        const cancel = ipc._invokeHandlers?.get('rpc:cancel')
        if (!real || !cancel) throw new Error('project RPC handlers not found')
        const probe: ToolPreparationProbe = { clientId: null, cancelled: [], diagnosis: [], doctorDone: 0, finish: () => {} }
        Object.assign(globalThis, { __toolPreparation: probe })
        ipcMain.removeHandler('rpc')
        ipcMain.handle('rpc', async (...args: unknown[]) => {
          const [, method, , clientId] = args
          if (method === 'kordoc.ensure' && typeof clientId === 'string') {
            const release = Promise.withResolvers<void>()
            probe.clientId = clientId
            probe.finish = release.resolve
            BrowserWindow.getAllWindows()[0]?.webContents.send('rpc:event', {
              clientId, event: 'log', data: { stream: 'stdout', line: '문서 읽기 도구 확인 중' }
            })
            await release.promise
            if (probe.cancelled.includes(clientId)) return { error: { code: 'cancelled', message: '취소됨' } }
            return { result: { ok: true, exit: 0, data: null, path: null, status: null, block_reason: null,
              stdout: '', stderr: '', argv: [], python: 'fixture', duration_ms: 1 } satisfies Envelope }
          }
          if (method === 'lock.info' || method === 'doctor.all') probe.diagnosis.push(method)
          const reply = await real(...args)
          if (method === 'doctor.all') probe.doctorDone++
          return reply
        })
        ipcMain.removeHandler('rpc:cancel')
        ipcMain.handle('rpc:cancel', (...args: unknown[]) => {
          const id = args[1]
          if (typeof id !== 'string') return cancel(...args)
          probe.cancelled.push(id)
          if (probe.clientId !== id) return cancel(...args)
          probe.finish()
          return true
        })
      })
      const readProbe = () => electronApp.evaluate(() => {
        const { clientId, cancelled, diagnosis, doctorDone } = (globalThis as ToolPreparationHost).__toolPreparation
        return { clientId, cancelled, diagnosis, doctorDone }
      })
      const settings = page.locator('dialog[data-screen="settings"]')
      const tool = settings.locator('details[data-preset="fix:kordoc"]')
      const prep = tool.getByRole('button', { name: '도구 준비', exact: true })
      const stop = tool.getByRole('button', { name: '취소', exact: true })
      const leave = async () => {
        if (surface === '설정 닫기') await closeSheet(page)
        else await settings.getByRole('button', { name: '폴더', exact: true }).click()
        await expect(tool).not.toBeVisible()
      }

      await navTo(page, '설정')
      await openPreset(page, 'fix:kordoc')
      await expect.poll(async () => (await readProbe()).doctorDone).toBe(1)
      await prep.click()
      await expect(tool).toContainText('문서 읽기 도구 확인 중')
      const first = (await readProbe()).clientId
      await leave()
      if (surface === '설정 닫기') await navTo(page, '설정')
      await openPreset(page, 'fix:kordoc')
      await expect(tool.getByRole('status').filter({ hasText: '실행 중' })).toContainText('문서 읽기 도구 확인 중')
      await expect(stop).toBeVisible()
      await stop.click()
      await expect.poll(async () => (await readProbe()).cancelled).toEqual([first])
      const waiting = page.locator('.chat-zone .zline.wait')
      await expect(waiting).toHaveCount(0)

      await prep.click()
      await expect(tool).toContainText('문서 읽기 도구 확인 중')
      await leave()
      const before = (await readProbe()).diagnosis
      await expect(waiting).toBeVisible()
      await electronApp.evaluate(() => (globalThis as ToolPreparationHost).__toolPreparation.finish())
      await expect(waiting).toHaveCount(0)
      await page.evaluate(async () => {
        const frame = Promise.withResolvers<void>()
        requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()))
        await frame.promise
        await window.knuaf.getSettings()
      })
      expect((await readProbe()).diagnosis, '숨겨진 도구 준비가 끝난 뒤 새 진단이 시작됐다').toEqual(before)
    } finally { await electronApp.close() }
  })
}

test('잠금 관찰·probe·정리는 전체 점검 응답을 기다리지 않는다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    plantStaleLock(root)
    mkdirSync(join(root, '.gg-import-ci4-observation'))
    const before = readFileSync(join(root, 'project.json'))
    const guard = readFileSync(join(root, '.gg-lock', 'guard'))
    const owner = JSON.parse(readFileSync(join(root, '.gg-lock', 'owner.json'), 'utf8'))
    await electronApp.evaluate(async ({ ipcMain }, folder) => {
      // Electron's private handler registry is the existing in-process test seam.
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, RpcHandler> }
      const real = ipc._invokeHandlers.get('rpc')!
      const gate = Promise.withResolvers<void>()
      const lockGate = Promise.withResolvers<void>()
      // Real lock state, captured before cleanup; dependency imports are not this UI race's subject.
      const observed = await real({}, 'lock.info', { root: folder }) as { result?: LockInfo; error?: unknown }
      if (observed.error || !observed.result) throw new Error('real lock snapshot failed')
      const state: LockProbe = { held: false, lockHeld: false, armLock: false, snapshot: observed.result, release: gate.resolve, releaseLock: lockGate.resolve }
      ;(globalThis as ProbeHost).__ci4 = state
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        if (args[1] === 'doctor.all') {
          state.held = true
          await gate.promise
          // Every generation, including the post-cleanup one, delivers the old owner.
          return { result: { lock: state.snapshot, gg: { orphan_files: ['.gg-import-ci4-observation'] }, snapshots: [] } }
        }
        const reply = await real(...args)
        if (args[1] === 'lock.info' && state.armLock) { state.lockHeld = true; await lockGate.promise }
        return reply
      })
    }, root)
    expect(await electronApp.evaluate(() => (globalThis as ProbeHost).__ci4.snapshot.owner)).toEqual(owner)
    await navTo(page, '설정')
    await openPreset(page, 'fix:lock')
    await electronApp.evaluate(() => { (globalThis as ProbeHost).__ci4.armLock = true })
    await page.getByRole('button', { name: '다시 진단', exact: true }).click()
    await expect.poll(() => electronApp.evaluate(() => (globalThis as ProbeHost).__ci4.held)).toBe(true)
    const lock = page.locator('details[data-preset="fix:lock"]')
    await expect.poll(() => electronApp.evaluate(() => (globalThis as ProbeHost).__ci4.lockHeld)).toBe(true)
    await expect(lock.locator('[role="status"][aria-busy="true"]')).toBeVisible()
    await expect(page.getByRole('button', { name: '다시 진단', exact: true })).toBeDisabled()
    const capture = process.env.KNUAF_DIAG_CAPTURE_DIR
    if (capture) {
      await lock.scrollIntoViewIfNeeded()
      mkdirSync(capture, { recursive: true })
      await page.screenshot({ path: join(capture, 'lock-loading.png') })
    }
    await electronApp.evaluate(() => (globalThis as ProbeHost).__ci4.releaseLock())
    await expect(lock.locator('time')).toBeVisible()
    await expect(lock).toContainText('마지막 점유 기록')
    await expect(lock.getByRole('button', { name: '소유 기록 정리', exact: true })).toBeDisabled()
    await lock.getByRole('button', { name: '점유 상태 확인', exact: true }).click()
    await expect(lock.getByRole('button', { name: '소유 기록 정리', exact: true })).toBeEnabled()
    if (capture) {
      mkdirSync(capture, { recursive: true })
      await lock.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(capture, 'lock-held.png') })
    }
    // Cleanup must also finish while aggregate replies remain held.
    await lock.getByRole('button', { name: '소유 기록 정리', exact: true }).click()
    await page.locator('dialog[open]').last().getByRole('button', { name: '소유 기록 정리', exact: true }).click()
    await expect(page.getByText('소유 기록을 정리했어요.', { exact: true })).toBeVisible()
    await expect(lock.locator('time')).toBeVisible()
    expect(existsSync(join(root, '.gg-lock', 'owner.json'))).toBe(false)
    expect(readFileSync(join(root, 'project.json'))).toEqual(before)
    expect(readFileSync(join(root, '.gg-lock', 'guard'))).toEqual(guard)
    // Release controlled late aggregates only after real independent cleanup succeeds.
    // The real pre-cleanup snapshot above makes the stale-owner ordering deterministic.
    await electronApp.evaluate(() => (globalThis as ProbeHost).__ci4.release())
    await openPreset(page, 'fix:orphans')
    await expect(page.locator('details[data-preset="fix:orphans"]')).toContainText('.gg-import-ci4-observation')
    // Late aggregates contain old owner records; only independent lock replies own this UI.
    await expect(lock).not.toContainText('마지막 점유 기록')
    await expect(lock.getByRole('button', { name: '소유 기록 정리', exact: true })).toBeDisabled()
  } finally { await electronApp.close() }
})

test('DOCX 결과는 갱신이 끝난 뒤 진행 표시와 함께가 아닌 단일 상태로 게시한다', async () => {
  const root = synthProject()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', '검토전_본문.md'), '# 머리말\n\n농장A 본문이다.\n')
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await electronApp.evaluate(({ ipcMain }) => {
      // Electron's private handler registry is the existing in-process test seam.
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, RpcHandler> }
      const real = ipc._invokeHandlers.get('rpc')!
      const gate = Promise.withResolvers<void>()
      const state = { built: false, held: false, release: gate.resolve }
      ;(globalThis as ProbeHost).__ci4Make = state
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        const reply = await real(...args)
        if (args[1] === 'docx.build') state.built = true
        if (args[1] === 'project.status' && state.built) { state.held = true; await gate.promise }
        return reply
      })
    })
    await navTo(page, '결과물')
    const row = page.locator('.paper-head .popover [data-make="docx"]')
    await row.getByRole('button').click()
    await expect.poll(() => electronApp.evaluate(() => (globalThis as ProbeHost).__ci4Make.held)).toBe(true)
    await expect(row.locator('.make-fb.running')).toBeVisible()
    await expect(row.locator('.make-fb.completion')).toHaveCount(0)
    await expect(row.locator('.pop-make > button')).toBeDisabled()
    const capture = process.env.KNUAF_DIAG_CAPTURE_DIR
    if (capture) {
      mkdirSync(capture, { recursive: true })
      await page.screenshot({ path: join(capture, 'docx-held.png') })
    }
    await electronApp.evaluate(() => (globalThis as ProbeHost).__ci4Make.release())
    await expect(row.locator('.make-fb')).toHaveCount(1)
    await expect(row.locator('.make-fb')).toContainText('DOCX를 만들었어요')
    await expect(row.locator('.make-fb.running')).toHaveCount(0)
    await expect(row.locator('.pop-make > button')).toBeEnabled()
  } finally { await electronApp.close() }
})
