import { ChildProcess, execFile } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import type { ElectronApplication, TestInfo } from '@playwright/test'
import { taskkillPath } from '../src/main/win'

const FORCE_MS = 5_000
const REPORT_MS = 1_000
const STARTUP_MS = 60_000
const GRACE_MS = 20_000
const startChannel = channel('child_process') // Node 22: emitted before the ChildProcess `spawn` event.
const playwrightRequire = createRequire(require.resolve('playwright/package.json'))
const clock: { monotonicTime(): number } = playwrightRequire('playwright-core/lib/coreBundle').iso
const launchIds = new WeakMap<ChildProcess, { readonly marker: string; readonly startedAt: number }>()

class ElectronDeadlineError extends Error {
  readonly name = 'ElectronDeadlineError'
  constructor(readonly stage: string) { super(`Electron deadline exceeded: ${stage}`) }
}

class ElectronReclaimError extends Error {
  readonly name = 'ElectronReclaimError'
  constructor(readonly detail: string) { super(`close:force-failed ${detail}`) }
}

type Deadline = { readonly at: number; readonly capMs?: number }
const timeLeft = (deadline: Deadline): number => Math.floor(deadline.at - clock.monotonicTime())
const after = (ms: number): Deadline => ({ at: clock.monotonicTime() + ms })

function testDeadline(info: TestInfo): number {
  // Playwright 1.63 has no public remaining-time API. Use the active slot and its clock, not
  // info.timeout (the full slot length). Fail closed if an upgrade removes this bridge.
  if (!('_deadline' in info) || typeof info._deadline !== 'function') throw new ElectronDeadlineError('missing Playwright test deadline')
  const snapshot: unknown = info._deadline()
  if (!snapshot || typeof snapshot !== 'object' || !('deadline' in snapshot) || typeof snapshot.deadline !== 'number' || !Number.isFinite(snapshot.deadline)) {
    throw new ElectronDeadlineError('invalid Playwright test deadline')
  }
  return snapshot.deadline
}

export function launchBudget(info: TestInfo) {
  const slot = testDeadline(info) - REPORT_MS
  const startup = { at: Math.min(clock.monotonicTime() + STARTUP_MS, slot - 2 * FORCE_MS) }
  const cleanup = { at: Math.min(slot, startup.at + 2 * FORCE_MS) }
  return { startup, cleanup }
}

export async function within<T>(deadline: Deadline, stage: string, run: (ms: number) => Promise<T>): Promise<T> {
  const ms = Math.min(timeLeft(deadline), deadline.capMs ?? Infinity)
  if (ms <= 0) throw new ElectronDeadlineError(stage)
  const abort = new AbortController()
  const expiry = delay(ms, undefined, { signal: abort.signal }).then(() => { throw new ElectronDeadlineError(stage) })
  try { return await Promise.race([Promise.resolve().then(() => run(ms)), expiry]) }
  finally { abort.abort() }
}

interface LaunchObservation {
  readonly spawned: Promise<ChildProcess>
  stop(): void
}

export function trackLaunch(marker: string): LaunchObservation {
  const observed = Promise.withResolvers<ChildProcess>()
  const startedAt = Date.now()
  const pending = new Map<ChildProcess, () => void>()
  const subscribe = (message: unknown): void => {
    if (!message || typeof message !== 'object' || !('process' in message) || !(message.process instanceof ChildProcess)) return
    const candidate = message.process
    const spawned = (): void => {
      pending.delete(candidate)
      // On Windows Playwright passes a single shell command; marker is an ASCII random token.
      if (candidate.spawnargs.some(arg => arg === marker || arg.includes(`"${marker}"`))) {
        launchIds.set(candidate, { marker, startedAt })
        observed.resolve(candidate)
      }
    }
    pending.set(candidate, spawned)
    candidate.once('spawn', spawned)
  }
  startChannel.subscribe(subscribe)
  return {
    spawned: observed.promise,
    stop: () => {
      startChannel.unsubscribe(subscribe)
      for (const [candidate, listener] of pending) candidate.off('spawn', listener)
    }
  }
}

// Only ChildProcess handles belonging to this worker reach recovery.
type Log = { readonly mark: (stage: string) => void }
type KillOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string }
export type ForceKiller = (proc: ChildProcess, deadline: Deadline) => Promise<KillOutcome>

const ended = (proc: ChildProcess): boolean => proc.exitCode !== null || proc.signalCode !== null
const pipesOpen = (proc: ChildProcess): boolean => [proc.stdout, proc.stderr].some(pipe => pipe && !pipe.destroyed && !pipe.readableEnded)

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

// PID creation times prevent reuse from supplying false ancestry. An orphan born since
// launch could be ours; report uncertainty rather than killing it or claiming an empty tree.
const windowsTree = String.raw`
$ErrorActionPreference = 'Stop'
$root = [uint32]ROOT_PID
$worker = [uint32]WORKER_PID
$marker = 'LAUNCH_MARKER'
$since = [DateTimeOffset]::FromUnixTimeMilliseconds(LAUNCH_STARTED).LocalDateTime
$known = @{}
$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine)
$rootProcess = $all | Where-Object ProcessId -eq $root
$seeds = @()
if ($rootProcess -and (ROOT_EXITED -or $rootProcess.ParentProcessId -ne $worker -or !$rootProcess.CommandLine -or !$rootProcess.CommandLine.Contains($marker))) { exit 3 }
if ($rootProcess) { $seeds += $rootProcess }
# When the wrapper is gone, identify Electron itself by both ancestry and the unique marker.
if (!$rootProcess) {
  $seeds += @($all | Where-Object { $_.ParentProcessId -eq $root -and $_.CommandLine -and $_.CommandLine.Contains($marker) })
}
$parents = @()
foreach ($seed in $seeds) {
  $known[$seed.ProcessId] = $seed.CreationDate
  $parents += $seed.ProcessId
}
while ($parents.Count -gt 0) {
  $next = @()
  foreach ($p in $all) {
    if ($parents -contains $p.ParentProcessId -and !$known.ContainsKey($p.ProcessId) -and $p.CreationDate -ge $known[$p.ParentProcessId]) {
      $known[$p.ProcessId] = $p.CreationDate
      $next += $p.ProcessId
    }
  }
  $parents = $next
}
if (FORCE_TREE) {
  foreach ($seed in $seeds) {
    $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($seed.ProcessId)"
    if ($current -and $current.CreationDate -eq $seed.CreationDate) {
      & 'TASKKILL_PATH' /PID $seed.ProcessId /T /F | Out-Null
    }
  }
  $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine)
}
$parentsByPid = @{}
foreach ($p in $all) { $parentsByPid[$p.ProcessId] = $p.CreationDate }
foreach ($p in $all) {
  $parentBorn = $parentsByPid[$p.ParentProcessId]
  if (($known.ContainsKey($p.ProcessId) -and $known[$p.ProcessId] -eq $p.CreationDate) -or
      ($known.ContainsKey($p.ParentProcessId) -and $p.CreationDate -ge $known[$p.ParentProcessId]) -or
      ($p.CommandLine -and $p.CommandLine.Contains($marker))) { exit 5 }
  if ($p.CreationDate -ge $since -and $p.ParentProcessId -ne 0 -and
      (!$parentBorn -or $parentBorn -gt $p.CreationDate)) { exit 4 }
}
`

async function verifyWindowsTree(proc: ChildProcess, deadline: Deadline, forceTree: boolean): Promise<void> {
  const identity = launchIds.get(proc)
  const ms = timeLeft(deadline)
  if (!identity || !proc.pid || ms <= 0) throw new ElectronReclaimError('tree recovery unverified (missing identity or budget)')
  const executable = taskkillPath()
  const powershell = join(executable, '..', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = windowsTree.replace('ROOT_PID', String(proc.pid)).replace('WORKER_PID', String(process.pid))
    .replace('ROOT_EXITED', ended(proc) ? '$true' : '$false').replace('LAUNCH_MARKER', identity.marker)
    .replace('LAUNCH_STARTED', String(identity.startedAt)).replace('FORCE_TREE', forceTree ? '$true' : '$false')
    .replace('TASKKILL_PATH', () => executable.replaceAll("'", "''"))
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: ms, killSignal: 'SIGKILL' }, error => error ? reject(error) : resolve())
  await promise
}

const reclaim: ForceKiller = async (proc, deadline) => {
  const pid = proc.pid
  const ms = timeLeft(deadline)
  if (!pid) return { ok: false, detail: 'no owned PID' }
  if (ms <= 0) return { ok: false, detail: 'no recovery budget' }
  try {
    if (process.platform === 'win32') {
      await verifyWindowsTree(proc, deadline, true)
    } else if (groupAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL') }
      catch (error) { if (groupAlive(pid)) throw error }
      while (groupAlive(pid) && timeLeft(deadline) > 0) await delay(20)
      if (groupAlive(pid)) return { ok: false, detail: 'owned process group remains' }
    }
    // The direct child can exit while a descendant still holds stdio. Both must be gone.
    while ((!ended(proc) || pipesOpen(proc)) && timeLeft(deadline) > 0) await delay(20)
    return ended(proc) && !pipesOpen(proc) ? { ok: true } : { ok: false, detail: 'owned process or launch pipes remain' }
  } catch (error) {
    const code = error instanceof Error && 'code' in error && (typeof error.code === 'number' || typeof error.code === 'string') ? error.code : 'unknown'
    return { ok: false, detail: `tree recovery unverified (${code})` }
  }
}

async function force(proc: ChildProcess, log: Log, deadline: Deadline, forceKill: ForceKiller): Promise<void> {
  log.mark(`close:force pid=${proc.pid ?? '없음'}`)
  try {
    const outcome = await within(deadline, 'force recovery', () => forceKill(proc, deadline))
    if (!outcome.ok) throw new ElectronReclaimError(outcome.detail)
  } catch (error) {
    log.mark(error instanceof ElectronReclaimError ? error.message : 'close:force-failed recovery did not complete')
    throw error
  }
}

export async function reclaimFailedLaunch(
  tracked: LaunchObservation,
  settled: Promise<void>,
  recovery: { readonly log: Log; readonly deadline: Deadline }
): Promise<void> {
  const { log, deadline } = recovery
  // Give Node's queued spawn event a turn even if the launch rejects synchronously after spawn.
  const claimed = Promise.race([tracked.spawned, settled.then(async () => { await nextTurn(); return undefined })])
  try {
    const child = await within({ at: deadline.at - FORCE_MS }, 'observe late spawn', () => claimed)
    if (child) await force(child, log, { at: Math.min(deadline.at, after(FORCE_MS).at) }, reclaim)
    tracked.stop()
  } catch (error) {
    if (!(error instanceof ElectronDeadlineError && error.stage === 'observe late spawn')) {
      // The native launch may still reject asynchronously after a failed force attempt.
      void settled.then(() => tracked.stop())
      throw error
    }
    // Keep ownership alive without holding the failed test open. A late spawn still has one
    // bounded recovery attempt; a launch that settles without spawning releases the listener.
    log.mark('launch:cleanup-unverified pending native launch')
    void claimed.then(async child => {
      try {
        if (child) await force(child, log, after(FORCE_MS), reclaim)
        tracked.stop()
      } catch {
        log.mark('launch:late-cleanup-unverified')
        void settled.then(() => tracked.stop())
      }
    })
  }
}

/** A settled Playwright close is only the direct-child and pipe boundary. */
export async function closeApp(
  app: Pick<ElectronApplication, 'close' | 'process'>,
  log: Log,
  opts: { readonly graceMs?: number; readonly deadline?: Deadline; readonly forceKill?: ForceKiller } = {}
): Promise<void> {
  const grace = opts.graceMs ?? GRACE_MS
  const deadline = opts.deadline ?? after(grace + FORCE_MS)
  const graceful = { at: Math.min(after(grace).at, deadline.at - FORCE_MS) }
  const proc = app.process()
  log.mark('close:start')
  try {
    try {
      await within(graceful, 'graceful close', () => app.close())
    } catch (error) {
      if (!(error instanceof ElectronDeadlineError)) log.mark('close:rejected')
    }
    if (ended(proc) && !pipesOpen(proc) && proc.pid) {
      try {
        if (process.platform === 'win32') {
          await verifyWindowsTree(proc, { at: Math.min(graceful.at, after(FORCE_MS).at) }, false)
          return
        }
        if (!groupAlive(proc.pid)) return
      } catch {
        log.mark('close:tree-unverified')
      }
    }
    await force(proc, log, { at: Math.min(deadline.at, after(FORCE_MS).at) }, opts.forceKill ?? reclaim)
  } finally { log.mark('close:end') }
}
