import { expect, test } from '@playwright/test'
import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { closeApp, trackLaunch, type ForceKiller } from './electron-lifecycle'

function recorder() {
  const stages: string[] = []
  return { stages, mark: (stage: string) => { stages.push(stage) } }
}

test('close timeout invokes bounded recovery and finishes the close log', async () => {
  const proc = Object.assign(new ChildProcess(), { pid: 4242 })
  const log = recorder()
  const forceKill: ForceKiller = async child => {
    expect(child).toBe(proc)
    return { ok: true }
  }
  await closeApp({ close: () => Promise.withResolvers<void>().promise, process: () => proc }, log, { graceMs: 25, forceKill })
  expect(log.stages).toEqual(['close:start', 'close:force pid=4242', 'close:end'])
})

test('close succeeds without killing an already empty owned process group', async () => {
  const marker = `--knuaf-e2e-launch-id=${randomUUID()}`
  const tracked = trackLaunch(marker)
  const proc = spawn(process.execPath, ['-e', '', '--', marker], { detached: process.platform !== 'win32' })
  try { await once(proc, 'close') }
  finally { tracked.stop() }
  const log = recorder()
  await closeApp({ close: async () => {}, process: () => proc }, log)
  expect(log.stages).toEqual(['close:start', 'close:end'])
})

test('close 거절로 Electron이 남으면 강제 회수 실패를 드러낸다', async () => {
  const proc = Object.assign(new ChildProcess(), { pid: 4242 })
  const log = recorder()
  const forceKill: ForceKiller = async () => ({ ok: false, detail: 'owned process remains' })
  await expect(closeApp({ close: async () => { throw new Error('Close refused') }, process: () => proc }, log, { forceKill }))
    .rejects.toThrow('owned process remains')
  expect(log.stages).toEqual(['close:start', 'close:rejected', 'close:force pid=4242', 'close:force-failed owned process remains', 'close:end'])
})

test('close cannot report recovery when no owned PID was obtained', async () => {
  const proc = new ChildProcess()
  await expect(closeApp({ close: () => Promise.withResolvers<void>().promise, process: () => proc }, recorder(), { graceMs: 25 }))
    .rejects.toThrow('no owned PID')
})

test('a dead launcher cannot hide a descendant that still holds its output', async ({}, info) => {
  const pidFile = info.outputPath('descendant.pid')
  const marker = `--knuaf-e2e-launch-id=${randomUUID()}`
  const script = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    // Windows libuv kills non-detached children when this launcher exits.
    // On POSIX the descendant must stay in the launcher's process group.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', process.argv[2]], {
      detached: process.platform === 'win32', stdio: ['ignore', 1, 2],
    });
    child.once('spawn', () => { writeFileSync(process.argv[1], String(child.pid)); process.exit(0); });
  `
  const tracked = trackLaunch(marker)
  const proc = spawn(process.execPath, ['-e', script, pidFile, marker], { detached: process.platform !== 'win32' })
  try {
    const [code] = await once(proc, 'exit')
    expect(code).toBe(0)
  } finally { tracked.stop() }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(process.kill(pid, 0), 'fixture descendant must outlive its launcher').toBe(true)
    expect(proc.stdout.destroyed || proc.stdout.readableEnded).toBe(false)
    await closeApp({ close: async () => {}, process: () => proc }, recorder(), { graceMs: 25 })
    expect(proc.stdout.destroyed || proc.stdout.readableEnded).toBe(true)
    expect(() => process.kill(pid, 0), 'pipe-holding child survived a successful close').toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally {
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
    }
  }
})

test('closed pipes do not prove that a silent descendant exited', async ({}, info) => {
  const pidFile = info.outputPath('silent.pid')
  const marker = `--knuaf-e2e-launch-id=${randomUUID()}`
  const script = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    // Keep the silent orphan alive on Windows, without changing its ancestry or giving it the marker.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: process.platform === 'win32', stdio: 'ignore',
    });
    child.once('spawn', () => { writeFileSync(process.argv[1], String(child.pid)); process.exit(0); });
  `
  const tracked = trackLaunch(marker)
  const proc = spawn(process.execPath, ['-e', script, pidFile, marker], { detached: process.platform !== 'win32' })
  try {
    const [code] = await once(proc, 'close')
    expect(code).toBe(0)
  } finally { tracked.stop() }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
  try {
    expect(proc.stdout.destroyed || proc.stdout.readableEnded).toBe(true)
    expect(process.kill(pid, 0), 'silent fixture descendant must outlive its launcher').toBe(true)
    const close = closeApp({ close: async () => {}, process: () => proc }, recorder())
    if (process.platform === 'win32') {
      await expect(close).rejects.toThrow('tree recovery unverified (4)')
      expect(process.kill(pid, 0), 'unidentified child must not be killed by recovery').toBe(true)
    } else {
      await close
      expect(() => process.kill(pid, 0), 'silent child survived a successful close').toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  } finally {
    try { process.kill(pid, 'SIGKILL') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
  }
})
