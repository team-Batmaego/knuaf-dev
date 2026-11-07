import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'
import type { LockInfo } from '../src/shared/types'

type RpcHandler = (...args: unknown[]) => Promise<unknown>
type LockProbe = { held: boolean; lockHeld: boolean; armLock: boolean; snapshot: LockInfo; release: () => void; releaseLock: () => void }
type MakeProbe = { built: boolean; held: boolean; release: () => void }
type ProbeHost = typeof globalThis & { __ci4: LockProbe; __ci4Make: MakeProbe }

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
