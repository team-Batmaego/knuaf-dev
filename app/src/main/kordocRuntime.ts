/**
 * kordoc 덩어리 — Electron 다리 (설계 r3 §4·§5, 묶음 B2a).
 *
 * 여기서만 Electron·OS 를 만진다(`app.isPackaged`·`net.fetch`·`process.execPath`·`statfs`).
 * 판정·순서·잠금·정리 같은 규칙은 전부 `kordocRuntimeCore.ts` 에 있고, 시험은 그 파일을
 * 임시 폴더와 가짜 다리로 직접 돌린다(`e2e/kordoc-runtime.spec.ts`).
 *
 * r3 — 검증 기록 파일 대신 **이번 실행의 기억**(`ledger`)을 쓴다: 앱을 켤 때마다 폴더당 한 번
 * 돌려 보기(`generate`)를 하고, 그 통과만 "쓸 수 있음"으로 친다. 실패는 폴더에 `.retired` 로 남는다.
 *
 * 보안 계약(§13 검토 항목): 실행 때 서버가 주는 해시를 믿지 않는다. 명세는 앱에 실린 파일 하나이고,
 * 받는 주소도 명세의 `release`+`file` 로만 조립한다. 개발용 덮어쓰기(`KNUAF_KORDOC_SPEC`·
 * `KNUAF_KORDOC_BASE_URL`)는 `app.isPackaged` 면 **읽지 않는다**.
 */
import { app, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { KordocRuntime } from './chat/kordocMcp'
import { codeOf, diag } from './diagLog'
import {
  SHIM_NAME,
  insideDir,
  SMOKE_TIMEOUT_MS,
  cleanupKordocAt,
  createRetryGate,
  createVerifyLedger,
  installKordoc,
  listArchiveEntries,
  makeKordocSelector,
  readSpecState,
  readyKordocDir,
  usableKordocDir,
  type InstallDeps,
  type KordocSpec,
  type KordocStatus,
  type KordocTarget,
  type Progress,
  type SpecState,
  type VerifyLedger
} from './kordocRuntimeCore'
import { downloadToFile } from './runtimeDownload'
import { extract, runtimeRoot, targetTriple } from './runtime'

const APP_ROOT = resolve(__dirname, '..', '..')
const RELEASE_BASE = 'https://github.com/team-Batmaego/knuaf-dev/releases/download'
/** 다시 시도 간격 — 같은 앱 실행 안에서 10분에 한 번(§4.7). */
const RETRY_MS = 10 * 60 * 1000
const START_DELAY_MS = 5_000

const HOST_OWNER = 'knuaf-dev.app'
const HOST_FILE_NAME = 'kordoc-host.json'

/**
 * 이 모듈은 **Electron 밖에서도** 로드된다 — `ipc.ts` 를 VM 로더로 올리는 Node 시험
 * (`preparation-main`·`app-store-broker`)이 그 경로다. 거기서 `require('electron')` 는
 * 실행 파일 **경로 문자열**이라 `app` 이 없다. `app.isPackaged` 를 그냥 읽으면 TypeError 이므로
 * 모든 `app.isPackaged` 판정은 이 함수를 지난다.
 */
function isPackaged(): boolean {
  return app?.isPackaged === true
}

function kordocHostPath(): string {
  const override = !isPackaged() ? process.env.KNUAF_KORDOC_HOST_FILE : undefined
  if (override) return resolve(override)
  return join(resolve(process.env.XDG_CACHE_HOME || join(homedir(), '.cache')), 'ginseng-goat', HOST_FILE_NAME)
}

function hostFolder(path: string, create: boolean): string | null {
  const folder = dirname(path)
  if (create) {
    try { mkdirSync(folder, { recursive: true, mode: 0o700 }) } catch { return null }
  }
  try {
    const stat = lstatSync(folder)
    return stat.isDirectory() && !stat.isSymbolicLink() ? folder : null
  } catch { return null }
}

function readHostOwner(path: string): { owner: string | null; stat: Stats } | null {
  let pathStat: Stats
  try {
    pathStat = lstatSync(path)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null
  } catch { return null }
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch { return null }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) return null
    const value: unknown = JSON.parse(readFileSync(fd, { encoding: 'utf8' }))
    if (!value || typeof value !== 'object' || !('owner' in value) || typeof value.owner !== 'string') return null
    return { owner: value.owner, stat }
  } catch { return null }
  finally { closeSync(fd) }
}

function sameFile(path: string, expected: Stats): boolean {
  try {
    const current = lstatSync(path)
    return current.isFile() && !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino
  } catch { return false }
}

function hostFileExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function sameFolder(path: string, expected: Stats): boolean {
  try {
    const current = lstatSync(path)
    return current.isDirectory() && !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino
  } catch { return false }
}

function deleteHostPath(path: string, beforeDelete: () => void): void {
  beforeDelete()
  rmSync(path)
}

function removeKordocHostFile(beforeFinalCheck: () => void = () => {}): void {
  if (!isPackaged()) return
  const path = kordocHostPath()
  const folder = hostFolder(path, false)
  if (!folder) return
  let folderStat: Stats
  try { folderStat = lstatSync(folder) } catch { return }
  const opened = readHostOwner(path)
  if (!opened || opened.owner !== HOST_OWNER || !sameFile(path, opened.stat) || !sameFolder(folder, folderStat)) return
  try {
    deleteHostPath(path, () => {
      beforeFinalCheck()
      if (!sameFolder(folder, folderStat) || !sameFile(path, opened.stat)) throw new Error('안내 파일 대상이 바뀜')
    })
  } catch { /* 다시 시작할 때 재시도 */ }
}

function writeKordocHostFile(dir: string, spec: KordocSpec, target: KordocTarget): boolean {
  if (!isPackaged()) return false
  const path = kordocHostPath()
  const folder = hostFolder(path, true)
  if (!folder) return false
  let folderStat: Stats
  try { folderStat = lstatSync(folder) } catch { return false }
  const existing = readHostOwner(path)
  if (existsSync(path) && (!existing || existing.owner !== HOST_OWNER || !sameFile(path, existing.stat))) return false
  const installDir = resolve(dir)
  const executable = resolve(process.execPath)
  const shim = join(installDir, SHIM_NAME)
  const cli = resolve(installDir, spec.cli)
  const exeStat = statSync(executable)
  if (!exeStat.isFile() || !statSync(shim).isFile() || !statSync(cli).isFile() || !insideDir(installDir, shim) || !insideDir(installDir, cli)) {
    throw new Error('kordoc 안내 파일의 실행 파일이 보통 파일이 아니거나 설치 폴더 밖')
  }
  const writtenAt = Math.floor(Date.now() / 1000)
  const data = {
    schema: 1,
    owner: HOST_OWNER,
    kordoc_version: spec.version,
    install_dir: installDir,
    release: spec.release,
    payload_sha256: target.sha256,
    command: [executable, '-r', shim, cli],
    files: [executable, shim, cli],
    exe_stat: { size: exeStat.size, mtime: Math.floor(exeStat.mtimeMs / 1000) },
    env: { ELECTRON_RUN_AS_NODE: '1' },
    app_version: app.getVersion(),
    written_at: writtenAt
  }
  const temporary = join(folder, `.${HOST_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (!sameFolder(folder, folderStat)) return false
    const current = readHostOwner(path)
    if (existing) {
      if (!current || current.owner !== HOST_OWNER || !sameFile(path, existing.stat)) return false
      renameSync(temporary, path)
    } else {
      if (hostFileExists(path)) return false
      linkSync(temporary, path)
    }
    return true
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* rename/link consumed it or cleanup can retry */ }
  }
}

/**
 * 지금 쓸 수 있는 설치에 맞춰 안내 파일을 다시 쓴다. **던지지 않는다** — 시작 작업·설치 실패
 * 처리(.catch)·선택기에서 모두 불리므로 여기서 던지면 그대로 unhandled rejection 이 된다.
 * Electron 밖(Node 시험)에는 쓸 안내 파일 자체가 없으니 아무 일도 하지 않는다.
 */
function refreshHostFileForUsableRuntime(): boolean {
  if (!isPackaged()) return false
  try {
    const state = kordocSpecState()
    if (state.kind !== 'ok') {
      removeKordocHostFile()
      return false
    }
    const dir = usableKordocDir(kordocRoot(), state.spec, state.targetKey, state.target, ledger)
    if (!dir) {
      removeKordocHostFile()
      return false
    }
    return writeKordocHostFile(dir, state.spec, state.target)
  } catch {
    try { removeKordocHostFile() } catch { /* 지우기도 실패하면 다음 시작 때 재시도 */ }
    return false
  }
}

/** 이번 실행의 꼼꼼한 확인 기억(§4.5 r3). 앱 실행마다 새로 — 디스크에 안 남긴다. */
const ledger: VerifyLedger = createVerifyLedger()
/** 실패 뒤 재시도 간격(§4.7). 다음 앱 실행은 새 게이트라 바로 시도한다. */
const retry = createRetryGate(RETRY_MS)

/** 설치 뿌리 — 파이썬 런타임 폴더와 형제라 파이썬 정리가 건드리지 않는다(§4.1). */
export function kordocRoot(): string {
  return join(dirname(runtimeRoot()), 'kordoc')
}

function specPath(): string {
  const override = !isPackaged() ? process.env.KNUAF_KORDOC_SPEC : undefined
  return override ? resolve(override) : join(APP_ROOT, 'kordoc-runtime.json')
}

/** 명세 상태 — 파일을 읽지 못해도 던지지 않는다(§5.2 세 갈래). */
export function kordocSpecState(): SpecState {
  return readSpecState(specPath(), targetTriple())
}

/** 관리 런타임 — `chat/kordocMcp.ts` 의 `KordocRuntime` 에 `nodeArgs` 를 더한 모양(B-1). */
type ManagedKordoc = KordocRuntime & { nodeArgs: string[] }

function runtimeFrom(dir: string, spec: KordocSpec): ManagedKordoc {
  return {
    node: process.execPath,
    nodeArgs: ['-r', join(dir, SHIM_NAME)],
    cliJs: join(dir, spec.cli),
    version: spec.version,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/**
 * 게시된 덩어리로 kordoc 을 돌리는 사양. 동기 — 전송마다 불린다(§5.1).
 * **이번 실행에서 꼼꼼한 확인을 통과한 폴더만** 내놓는다(§4.5 가벼운 확인).
 */
export function managedKordoc(): ManagedKordoc | null {
  const state = kordocSpecState()
  if (state.kind !== 'ok') return null
  const dir = usableKordocDir(kordocRoot(), state.spec, state.targetKey, state.target, ledger)
  return dir ? runtimeFrom(dir, state.spec) : null
}

/** 준비 화면·점검 화면이 보는 값(§5.1). IPC 는 후속 묶음(§8.3). */
export function kordocStatus(): KordocStatus {
  const state = kordocSpecState()
  if (state.kind !== 'ok') return { supported: false, installed: false, sizeBytes: null }
  return {
    supported: true,
    installed: usableKordocDir(kordocRoot(), state.spec, state.targetKey, state.target, ledger) !== null,
    sizeBytes: state.target.unpackedSize
  }
}

/** 남은 공간 — `statfs` 는 Electron(Chromium)에서만 있다. 없으면 판정을 건너뛴다(0). */
function freeBytes(path: string): number {
  try {
    const st = statfsSync(path)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return 0
  }
}

/** pid 가 살아 있는가 — 윈도·맥 모두 `process.kill(pid, 0)` 이 같은 뜻이다. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 돌려 보기(§4.3) — `--version` 은 shim 이 없어도 통과한다(윈도 실측 1). 그래서 `generate` 로
 * 실제 한 파일을 만들어 본다. 인자는 배열 그대로 넘긴다(`shell: false`).
 */
function smoke(execPath: string, dir: string, cli: string, signal?: AbortSignal): Promise<void> {
  let box: string
  try { box = mkdtempSync(join(dir, '.s-')) } catch (error) { return Promise.reject(error) }
  const input = join(box, 'in.md')
  const output = join(box, 'out.hwpx')
  const { promise, resolve: done, reject } = Promise.withResolvers<void>()
  let child: ChildProcess | null = null
  let settled = false
  let stopped: Error | null = null
  const finish = (error: Error | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    // 자식이 끝난 뒤에만 지운다 — 윈도는 열린 파일이 든 폴더를 못 지운다(§4.2).
    try { rmSync(box, { recursive: true, force: true }) } catch { /* 다음 시작 정리 */ }
    if (error) reject(error)
    else done()
  }
  const stop = (error: Error): void => {
    if (settled || stopped) return
    stopped = error
    // kill 요청은 종료가 아니다. close 뒤에만 정리하고 설치 호출을 풀어 준다.
    try { child?.kill('SIGKILL') } catch { /* close 에서 실패 처리 */ }
  }
  const cancel = (): void => stop(new Error('kordoc 확인 실행 취소'))
  const timer = setTimeout(() => stop(new Error('kordoc 확인 실행 시간 초과')), SMOKE_TIMEOUT_MS)
  try {
    // mkdtemp로 만든 이 검증의 폴더만 쓰고 정리한다(다른 프로세스와 공유하지 않음).
    writeFileSync(input, '# 확인\n\n한 줄.\n', 'utf-8')
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)))
    return promise
  }
  try {
    child = spawn(execPath, ['-r', join(dir, SHIM_NAME), cli, 'generate', input, '-o', output], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KORDOC_OFFLINE: '1' }
    })
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)))
    return promise
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', (error) => { stopped ??= error })
  child.on('close', (code) => {
    if (stopped) return finish(stopped)
    if (code !== 0) return finish(new Error(`kordoc 확인 실행 exit ${code}: ${stderr.slice(-300)}`))
    try {
      if (!existsSync(output) || statSync(output).size === 0) return finish(new Error('kordoc 확인 실행이 빈 파일이거나 파일을 만들지 않음'))
    } catch (error) {
      return finish(error instanceof Error ? error : new Error(String(error)))
    }
    finish(null)
  })
  return promise
}

/** 설치가 필요로 하는 다리(§4.2). 주소는 명세의 `release`+`file` 로만 조립한다. */
function installDeps(state: Extract<SpecState, { kind: 'ok' }>, signal: AbortSignal, onEvent?: (event: Progress) => void): InstallDeps {
  const base = !isPackaged() && process.env.KNUAF_KORDOC_BASE_URL
    ? process.env.KNUAF_KORDOC_BASE_URL.replace(/\/+$/, '')
    : RELEASE_BASE
  return {
    root: kordocRoot(),
    spec: state.spec,
    targetKey: state.targetKey,
    target: state.target,
    execPath: process.execPath,
    ledger,
    url: `${base}/${state.spec.release}/${state.target.file}`,
    now: () => Date.now(),
    platform: process.platform,
    pidAlive,
    freeBytes,
    download: (url, dest, expected, progress, abort) =>
      downloadToFile(url, dest, expected, progress, abort, { fetch: net.fetch }),
    extract: (archive, dest) => extract(archive, dest, 0),
    listEntries: listArchiveEntries,
    smoke,
    signal,
    onEvent
  }
}

let installing: Promise<string> | null = null
let controller: AbortController | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let startWorkDone = false

/** 진행 중 설치 취소. 다음 설치 요청은 새로 시작한다. */
export function cancelKordocInstall(): boolean {
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * 꼼꼼한 확인(§4.5 r3) — 앱 실행당·폴더당 1건, 도는 중이면 합류한다.
 * `ensureKordoc` 이 확인 전에 설치를 넘기지 않도록 여기서 **기다린다**.
 */
export async function verifyKordoc(): Promise<boolean> {
  const state = kordocSpecState()
  if (state.kind !== 'ok') return false
  const dir = await readyKordocDir({
    root: kordocRoot(),
    spec: state.spec,
    targetKey: state.targetKey,
    target: state.target,
    execPath: process.execPath,
    ledger,
    now: () => Date.now(),
    smoke
  })
  return dir !== null
}

/**
 * 설치(§4.2). 진행 중 재요청은 같은 약속에 합류한다. 쓸 수 있는 설치가 이미 있으면 받지 않는다.
 * `runtime_locked` 는 오류가 아니라 "이번엔 안 함"이다 — 부르는 쪽이 건너뛴다.
 */
export function installKordocRuntime(onEvent?: (event: Progress) => void): Promise<string> {
  if (installing) return installing
  const state = kordocSpecState()
  if (state.kind !== 'ok') {
    removeKordocHostFile()
    return Promise.reject({
      code: 'runtime_spec_invalid',
      message: state.kind === 'invalid' ? state.reason : '이 PC 의 대상이 없음'
    })
  }
  const abort = new AbortController()
  controller = abort
  const promise = installKordoc(installDeps(state, abort.signal, onEvent)).then((dir) => {
    try {
      if (!writeKordocHostFile(dir, state.spec, state.target)) removeKordocHostFile()
    } catch (error) {
      diag(`kordoc 안내 파일 쓰기 실패 code=${codeOf(error)}`)
      removeKordocHostFile()
    }
    return dir
  }).catch((error: unknown) => {
    if (!refreshHostFileForUsableRuntime()) removeKordocHostFile()
    throw error
  })
  installing = promise
  return promise.finally(() => {
    installing = null
    controller = null
  })
}

/** 설치를 **기다리지 않고** 띄운다 — 첫 메시지가 내려받기 동안 멈추지 않게(§5.2). */
function kickInstall(): void {
  if (installing) return
  if (!retry.mayStart(Date.now())) return
  void installKordocRuntime().then(
    () => {
      retry.succeeded()
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    },
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'unknown'
      retry.failed(Date.now())
      if (code === 'runtime_locked') return
      diag(`kordoc 설치 실패: ${code}`)
      scheduleRetry()
    }
  )
}

function scheduleRetry(): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    kickInstall()
  }, RETRY_MS)
  retryTimer.unref?.()
}

/**
 * 앱 시작 작업(§2·§4.7) — ①꼼꼼한 확인(실행당 1회) ②설치(온라인일 때) ③정리.
 * ③은 이미 설치돼 있어도 **매 시작에** 다시 시도한다(§4.4, KC-12).
 */
export function startKordocWork(delayMs = START_DELAY_MS): void {
  // Electron 밖(ipc.ts 를 올리는 Node 시험)에서는 앱도, 쓸 안내 파일도 없다 — 타이머조차 걸지 않는다.
  if (typeof app?.isPackaged !== 'boolean') return
  if (startWorkDone) return
  startWorkDone = true
  const timer = setTimeout(() => {
    void (async () => {
      const state = kordocSpecState()
      if (state.kind !== 'ok') {
        if (state.kind === 'invalid') diag(`kordoc 명세 오류: ${state.reason}`)
        removeKordocHostFile()
        return
      }
      const root = kordocRoot()
      // ① 꼼꼼한 확인 — 돌려 보기 포함. 실패하면 그 폴더에 `.retired` 가 찍힌다.
      const dir = await readyKordocDir({
        root,
        spec: state.spec,
        targetKey: state.targetKey,
        target: state.target,
        execPath: process.execPath,
        ledger,
        now: () => Date.now(),
        smoke
      })
      if (dir) {
        try {
          if (!writeKordocHostFile(dir, state.spec, state.target)) refreshHostFileForUsableRuntime()
        } catch (error) {
          diag(`kordoc 안내 파일 쓰기 실패 code=${codeOf(error)}`)
          refreshHostFileForUsableRuntime()
        }
      } else removeKordocHostFile()
      if (!dir && ledger.failed.size > 0) diag('kordoc 설치 확인 실패 — 쓰지 않는 폴더로 표시하고 다시 받는다')
      // ③ 정리 — 설치 여부와 무관하게 매 시작(§4.4).
      cleanupKordocAt({
        root,
        spec: state.spec,
        targetKey: state.targetKey,
        target: state.target,
        isDev: !isPackaged(),
        ledger,
        now: () => Date.now(),
        pidAlive
      })
      // ② 설치 — 온라인일 때만(§4.7).
      if (!dir && typeof net?.isOnline === 'function' && net.isOnline()) kickInstall()
    })().catch((error: unknown) => {
      diag(`kordoc 시작 작업 실패 code=${codeOf(error)}`)
      if (!refreshHostFileForUsableRuntime()) removeKordocHostFile()
    })
  }, delayMs)
  timer.unref?.()
}

/**
 * `ipc.ts` 의 `ensureKordoc` 감싸개(§5.2). 반환 꼴(`KordocRuntime | null`)은 그대로라
 * `service.ts` 를 건드리지 않는다(§8.2).
 */
export function withManagedKordoc(
  legacy: (root: string) => Promise<KordocRuntime | null>
): (root: string) => Promise<KordocRuntime | null> {
  // 시작 작업의 시작점은 `index.ts` 가 아니라 여기다(§4.7) — ipc.ts 는 감싸기만 하고
  // 채널·시작 호출을 더하지 않는다(§5.3). 앱이 뜨고 몇 초 뒤 첫 확인·정리·설치가 돈다.
  startKordocWork()
  return makeKordocSelector({
    specState: kordocSpecState,
    resolveManaged: async () => {
      try {
        await verifyKordoc()
        const managed = managedKordoc()
        if (managed) {
          const state = kordocSpecState()
          if (state.kind === 'ok') {
            try {
              if (!writeKordocHostFile(dirname(managed.nodeArgs[1]), state.spec, state.target)) refreshHostFileForUsableRuntime()
            } catch (error) {
              diag(`kordoc 안내 파일 쓰기 실패 code=${codeOf(error)}`)
              refreshHostFileForUsableRuntime()
            }
          }
        } else if (!refreshHostFileForUsableRuntime()) removeKordocHostFile()
        return managed
      } catch (error) {
        if (!refreshHostFileForUsableRuntime()) removeKordocHostFile()
        throw error
      }
    },
    startInstall: kickInstall,
    reportInvalid: (reason) => diag(`kordoc 명세 오류: ${reason}`)
  }, legacy)
}
