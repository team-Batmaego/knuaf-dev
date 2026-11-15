/**
 * kordoc 덩어리 — 명세·설치·고르기·정리 (설계 r3 §3.2·§4·§5, 묶음 B2a).
 *
 * **Electron 을 import 하지 않는다.** 경로·시계·내려받기·압축 풀기·돌려 보기·여유 공간을
 * 모두 인자로 받는다. Electron 판(`kordocRuntime.ts`)이 그 다리를 놓고,
 * `e2e/kordoc-runtime.spec.ts` 는 임시 폴더와 가짜 다리로 같은 소스를 그대로 돌린다(§10).
 *
 * 계약(§4.5 r3) — "쓸 수 있는 설치"는 **한 가지 판정**이다. 고르기·설치의 조기 반환·정리가
 * 같은 함수(`structuralOk`)를 쓴다. 따로 짜면 도장만 남은 설치를 아무도 고치지 못한다(KC-02).
 *
 * r3는 **검증 기록 파일을 없앴다.** 앱 실행마다 폴더당 한 번 돌려 보기(`generate`)를 하고 그 통과를
 * 메모리 표시(`VerifyLedger`)로만 들고 다니며, 실패는 폴더에 `.retired`(시각·이유)로 남겨
 * **이후 아무 프로세스도 고르지 않게** 한다(R2-01).
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { KORDOC_INSTALL_DIR_RE, STAMP, stampState } from './runtimeStore'
import type { Stamp } from './runtimeStore'

/** shim 파일 — 설치 폴더 안. 내용은 정확히 한 줄(§4.2-7). argv 를 만지면 윈도에서 깨진다(실측 1). */
export const SHIM_NAME = 'electron-node-shim.cjs'
export const SHIM_CONTENT = 'process.defaultApp = true;\n'
/**
 * "이 폴더는 쓰지 않는다" 표식(§4.5 r3). 꼼꼼한 확인 실패 폴더에 찍는다.
 * 찍힌 폴더는 고르지 않고, 24시간 지나 쓸 수 있는 설치가 따로 있으면 정리가 지운다(§4.4).
 */
export const RETIRED = '.retired'
const LOCK = '.lock'
const TEMP_PREFIX = '.download-'
const RETIRED_MS = 24 * 60 * 60 * 1000
/** 잠금 맥박(§4.6). 쥔 쪽이 이 간격으로 수정 시각을 갱신한다. */
export const LOCK_BEAT_MS = 30_000
/** 맥박이 이만큼 멎으면 주인이 멈춘 것으로 보고 넘겨받는다 — 살아서 일하는 주인의 잠금은 안 뺏는다. */
const LOCK_STALE_MS = 5 * 60 * 1000
const MAX_ENTRIES = 20000
const WIN_PATH_LIMIT = 259
export const SMOKE_TIMEOUT_MS = 30_000

export type KordocFailure = { code: string; message: string }

function fail(code: string, message: string): KordocFailure {
  return { code, message }
}

export interface KordocTarget {
  /** 릴리스에 올린 tgz 파일 이름 — 받는 주소의 마지막 칸이다. */
  file: string
  sha256: string
  /** 받은 바이트. */
  size: number
  /** 풀린 뒤 바이트. 여유 공간 판정에 쓴다(§4.2-3). */
  unpackedSize: number
}

export interface KordocSpec {
  release: string
  version: string
  cli: string
  cliSha256: string
  /** `cli` 와 같은 폴더의 `mcp.js` 해시 — MCP 가 실제로 띄우는 파일이다(§3.2 r3 · R2-03). */
  mcpSha256: string
  targets: Record<string, KordocTarget>
}

/** 준비 화면·점검 화면이 보는 값(§5.1). */
export interface KordocStatus {
  supported: boolean
  installed: boolean
  sizeBytes: number | null
}

/** §5.2 의 세 갈래. `unsupported` 와 `invalid` 를 뭉치면 명세가 깨졌을 때 옛 길이 조용히 열린다(KC-06). */
export type SpecState =
  | { kind: 'ok'; spec: KordocSpec; targetKey: string; target: KordocTarget }
  | { kind: 'unsupported'; spec: KordocSpec; targetKey: string | null }
  | { kind: 'invalid'; reason: string }

const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SEGMENT_RE = /^[A-Za-z0-9@._-]+$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.tgz$/
const HASH_RE = /^[0-9a-f]{64}$/

/** `/` 로 나눈 조각 — `..`·`.`·빈 조각이 없고, 맨 앞이 `/` 가 아니어야 한다(§3.2 표). */
export function isRelativeInside(value: string): boolean {
  if (!value || value.startsWith('/')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT_RE.test(part))
}

/** 명세 JSON 한 덩이를 확인해 `KordocSpec` 으로. 어긋나면 던진다 — 호출자가 `invalid` 로 닫는다. */
export function parseKordocSpec(raw: unknown): KordocSpec {
  if (!raw || typeof raw !== 'object') throw new Error('명세가 객체가 아님')
  const { release, version, cli, cliSha256, mcpSha256, targets } = raw as Record<string, unknown>
  if (typeof release !== 'string' || !RELEASE_RE.test(release)) throw new Error('release 꼴이 틀림')
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('version 꼴이 틀림')
  if (typeof cli !== 'string' || !cli.endsWith('.js') || !isRelativeInside(cli)) throw new Error('cli 꼴이 틀림')
  if (typeof cliSha256 !== 'string' || !HASH_RE.test(cliSha256)) throw new Error('cliSha256 꼴이 틀림')
  if (typeof mcpSha256 !== 'string' || !HASH_RE.test(mcpSha256)) throw new Error('mcpSha256 꼴이 틀림')
  if (!targets || typeof targets !== 'object') throw new Error('targets 가 객체가 아님')
  if (Array.isArray(targets)) throw new Error('targets 가 객체가 아님')
  const checked: Record<string, KordocTarget> = {}
  for (const [key, value] of Object.entries(targets)) {
    if (!['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(key)) throw new Error(`알 수 없는 대상 ${key}`)
    if (!value || typeof value !== 'object') throw new Error(`대상 ${key} 가 객체가 아님`)
    const { file, sha256, size, unpackedSize } = value as Record<string, unknown>
    if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error(`대상 ${key} 의 file 꼴이 틀림`)
    if (typeof sha256 !== 'string' || !HASH_RE.test(sha256)) throw new Error(`대상 ${key} 의 sha256 꼴이 틀림`)
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new Error(`대상 ${key} 의 size 가 틀림`)
    if (typeof unpackedSize !== 'number' || !Number.isInteger(unpackedSize) || unpackedSize <= 0) throw new Error(`대상 ${key} 의 unpackedSize 가 틀림`)
    checked[key] = { file, sha256, size, unpackedSize }
  }
  return { release, version, cli, cliSha256, mcpSha256, targets: checked }
}

/**
 * 명세 파일 하나를 읽어 이 PC 의 형편을 판정한다.
 * `targets` 가 비었거나 이 PC 의 대상이 없는 것은 오류가 아니라 "대상 없음"(§3.2).
 */
export function readSpecState(path: string, targetKey: string | null): SpecState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    return { kind: 'invalid', reason: `명세를 읽지 못함: ${String(error)}` }
  }
  let spec: KordocSpec
  try {
    spec = parseKordocSpec(raw)
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) }
  }
  const target = targetKey ? spec.targets[targetKey] : undefined
  if (!targetKey || !target) return { kind: 'unsupported', spec, targetKey }
  return { kind: 'ok', spec, targetKey, target }
}

/** 설치 폴더 이름 — `k-<sha256 앞 12자>-<ms>`(§4.1). 판·대상은 도장이 이미 갖고 있다. */
export function installDirName(sha256: string, ms: number): string {
  return `k-${sha256.slice(0, 12)}-${ms}`
}

/** 실제 경로가 `dir` 안인가 — 심볼릭 링크로 빠져나간 자리를 막는다(§4.2-6). */
export function insideDir(dir: string, path: string): boolean {
  let dirReal: string
  let pathReal: string
  try {
    dirReal = realpathSync(dir)
    pathReal = realpathSync(path)
  } catch {
    return false
  }
  const prefix = dirReal.endsWith(sep) ? dirReal : dirReal + sep
  return pathReal === dirReal || pathReal.startsWith(prefix)
}

/** `cli.js` 옆의 `mcp.js` — 규칙집·registry 와 같은 약속(`dirname(cliJs)/mcp.js`). */
export function mcpSibling(cli: string): string {
  return cli.replace(/[^/]+$/, 'mcp.js')
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 이번 실행의 "꼼꼼한 확인" 기억(§4.5 r3). 디스크에 안 남긴다 — 앱 실행마다 새로 만든다.
 * `passed`: 통과한 폴더 / `failed`: 실패했지만 `.retired` 를 못 써서 메모리에만 남긴 폴더 /
 * `inflight`: 지금 도는 확인(같은 폴더를 두 번 돌리지 않고 합류한다).
 */
export interface VerifyLedger {
  passed: Set<string>
  failed: Set<string>
  inflight: Map<string, Promise<boolean>>
}

export function createVerifyLedger(): VerifyLedger {
  return { passed: new Set(), failed: new Set(), inflight: new Map() }
}

/**
 * 가벼운 확인의 뼈대(§4.5 1·2·3) — 도장이 지금 명세와 같고, `.retired` 가 없고,
 * `cli.js`·`mcp.js`·shim 이 폴더 안에 있는가. 전송마다 도는 부분이라 파일 읽기 몇 번뿐이다.
 */
export function structuralOk(dir: string, spec: KordocSpec, targetKey: string, target: KordocTarget): boolean {
  const state = stampState(dir)
  if (state.kind !== 'ok') return false
  const { stamp } = state
  if (stamp.version !== spec.version || stamp.release !== spec.release || stamp.target !== targetKey || stamp.sha256 !== target.sha256) return false
  if (existsSync(join(dir, RETIRED))) return false
  const cli = join(dir, spec.cli)
  const mcp = join(dir, mcpSibling(spec.cli))
  const shim = join(dir, SHIM_NAME)
  if (!existsSync(cli) || !existsSync(mcp) || !existsSync(shim)) return false
  return insideDir(dir, cli) && insideDir(dir, mcp) && insideDir(dir, shim)
}

/** 가벼운 확인 전체 — `structuralOk` + "이번 실행에서 꼼꼼한 확인을 통과했다"(메모리, §4.5). */
export function usableDir(dir: string, spec: KordocSpec, targetKey: string, target: KordocTarget, ledger: VerifyLedger): string | null {
  if (ledger.failed.has(dir)) return null
  if (!ledger.passed.has(dir)) return null
  return structuralOk(dir, spec, targetKey, target) ? dir : null
}

/** 이 PC·이 명세에서 가장 최근에 쓸 수 있는 설치. 설치의 조기 반환도 이 함수를 쓴다(§4.2-2). */
export function usableKordocDir(root: string, spec: KordocSpec, targetKey: string, target: KordocTarget, ledger: VerifyLedger): string | null {
  for (const dir of installCandidates(root)) {
    if (usableDir(dir, spec, targetKey, target, ledger)) return dir
  }
  return null
}

/** 최신 폴더부터 확인하되, 깨진 최신 폴더가 온전한 이전 설치를 가리지 않는다. */
function installCandidates(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => ({ name, match: KORDOC_INSTALL_DIR_RE.exec(name) }))
      .filter((entry) => entry.match !== null)
      .sort((a, b) => Number(b.match![1]) - Number(a.match![1]))
      .map(({ name }) => join(root, name))
  } catch {
    return []
  }
}

/** `.retired` 에 적는 값 — 읽는 쪽(정리)은 시각만 쓰지만, 이유를 남겨 두면 현장 진단이 쉽다. */
interface RetiredRecord { at: number; reason: string }

function retire(dir: string, reason: string, now: number): boolean {
  const record: RetiredRecord = { at: now, reason }
  try {
    writeFileSync(join(dir, RETIRED), JSON.stringify(record), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** `.retired` 시각. r2 형식(숫자 하나)도 읽는다 — 옛 폴더가 남아 있을 수 있다. */
function readRetired(dir: string): number | null {
  let text: string
  try {
    text = readFileSync(join(dir, RETIRED), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const { at } = parsed as Record<string, unknown>
      if (typeof at === 'number' && Number.isFinite(at)) return at
    }
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  } catch {
    // 숫자 하나짜리 옛 형식이 아닌 깨진 값 — "찍힘"으로만 본다.
  }
  return 0
}

export interface VerifyDeps {
  dir: string
  spec: KordocSpec
  targetKey: string
  target: KordocTarget
  /** 앱 실행 파일 — 돌려 보기의 `node` 자리(§4.3). */
  execPath: string
  ledger: VerifyLedger
  now: () => number
  smoke: (execPath: string, dir: string, cli: string) => Promise<void>
}

/**
 * 꼼꼼한 확인(§4.5 r3) — 앱 실행마다·폴더당 **한 번**, 도는 중이면 합류한다.
 * 1 도장 대조 2 `.retired` 없음 3 세 파일·폴더 안 4 cli·mcp 해시·shim 내용 5 **돌려 보기(항상)**.
 * 실패하면 그 폴더에 `.retired`(시각·이유)를 쓴다 — 못 쓰면 메모리에 실패로 남긴다.
 */
export function verifyKordocDir(deps: VerifyDeps): Promise<boolean> {
  const { dir, ledger } = deps
  if (ledger.failed.has(dir)) return Promise.resolve(false)
  if (ledger.passed.has(dir)) return Promise.resolve(true)
  const running = ledger.inflight.get(dir)
  if (running) return running
  const promise = (async (): Promise<boolean> => {
    const reason = await checkThoroughly(deps).catch((error: unknown) => `확인 중 오류: ${String(error)}`)
    if (reason === null) {
      ledger.passed.add(dir)
      ledger.failed.delete(dir)
      return true
    }
    if (!retire(dir, reason, deps.now())) ledger.failed.add(dir)
    return false
  })()
  ledger.inflight.set(dir, promise)
  void promise.finally(() => ledger.inflight.delete(dir))
  return promise
}

/** 통과면 `null`, 실패면 이유. §4.5 1~5 를 차례로 본다. */
async function checkThoroughly(deps: VerifyDeps): Promise<string | null> {
  const { dir, spec, targetKey, target, ledger } = deps
  const state = stampState(dir)
  if (state.kind !== 'ok') return '도장을 읽지 못함'
  const { stamp } = state
  if (stamp.version !== spec.version || stamp.release !== spec.release || stamp.target !== targetKey || stamp.sha256 !== target.sha256) {
    return '도장이 명세와 다름'
  }
  if (existsSync(join(dir, RETIRED))) return '이미 쓰지 않는 폴더'
  const cli = join(dir, spec.cli)
  const mcp = join(dir, mcpSibling(spec.cli))
  const shim = join(dir, SHIM_NAME)
  if (!existsSync(cli) || !existsSync(mcp) || !existsSync(shim)) return '필수 파일이 없음'
  if (!insideDir(dir, cli) || !insideDir(dir, mcp) || !insideDir(dir, shim)) return '파일이 설치 폴더 밖을 가리킴'
  try {
    if (sha256File(cli) !== spec.cliSha256) return 'cli.js 해시가 다름'
    if (sha256File(mcp) !== spec.mcpSha256) return 'mcp.js 해시가 다름'
    if (readFileSync(shim, 'utf-8') !== SHIM_CONTENT) return 'shim 내용이 다름'
  } catch {
    return '파일을 읽지 못함'
  }
  try {
    await deps.smoke(deps.execPath, dir, cli)
  } catch (error) {
    return `돌려 보기 실패: ${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

/**
 * `ensureKordoc` 이 쓰는 "지금 쓸 수 있는 설치"(§5.2 첫 갈래). 꼼꼼한 확인이 이번 실행에서
 * 아직 안 돌았으면 **여기서 돌리고 기다린다** — 확인 안 된 폴더를 넘기지 않는다.
 */
export async function readyKordocDir(deps: Omit<VerifyDeps, 'dir'> & { root: string }): Promise<string | null> {
  for (const dir of installCandidates(deps.root)) {
    const state = stampState(dir)
    if (state.kind !== 'ok') continue
    const stamp = state.stamp
    if (stamp.version !== deps.spec.version || stamp.release !== deps.spec.release || stamp.target !== deps.targetKey || stamp.sha256 !== deps.target.sha256) continue
    if (existsSync(join(dir, RETIRED)) || deps.ledger.failed.has(dir)) continue
    // 이번 실행 중 파일이 사라졌으면 통과 기억을 지우고 다시 확인한다(§4.5).
    if (!structuralOk(dir, deps.spec, deps.targetKey, deps.target)) deps.ledger.passed.delete(dir)
    const ok = await verifyKordocDir({ ...deps, dir })
    if (ok && usableDir(dir, deps.spec, deps.targetKey, deps.target, deps.ledger)) return dir
  }
  return null
}

/**
 * 받은 tgz 의 **목록만** 보고 풀어도 되는지 판정한다(§4.2-4). 한 글자도 풀지 않은 상태에서 거절한다.
 * `verbose` 는 `tar -tvzf` 줄들 — 첫 글자가 종류다(`-` 파일, `d` 폴더).
 */
export function checkArchive(names: string[], verbose: string[], platform: NodeJS.Platform, dirAbs: string): void {
  if (names.length === 0) throw fail('runtime_archive_rejected', '덩어리가 비었음')
  if (names.length > MAX_ENTRIES) throw fail('runtime_archive_rejected', `항목이 너무 많음: ${names.length}`)
  if (verbose.length !== names.length) throw fail('runtime_archive_rejected', '목록 두 벌의 길이가 다름')
  for (const line of verbose) {
    const kind = line.trim().charAt(0)
    if (kind !== '-' && kind !== 'd') throw fail('runtime_archive_rejected', `허용하지 않는 항목 종류: ${kind || '빈 줄'}`)
  }
  let longest = 0
  for (const name of names) {
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) {
      throw fail('runtime_archive_rejected', `절대 경로나 역슬래시: ${name}`)
    }
    if (name.split('/').includes('..')) throw fail('runtime_archive_rejected', `상위로 나가는 경로: ${name}`)
    if (name.length > longest) longest = name.length
  }
  if (platform === 'win32' && dirAbs.length + 1 + longest > WIN_PATH_LIMIT) {
    throw fail('runtime_path_too_long', `윈도 경로 한도 초과: ${dirAbs.length + 1 + longest}`)
  }
}

/** tar 실행 파일 — `runtime.ts` 의 `tarPath` 와 같은 자리(윈도는 System32, 그 밖은 `/usr/bin`). */
export function tarPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === 'win32') {
    const p = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(p) ? p : null
  }
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : null
}

/** `tar -tzf`(이름) + `tar -tvzf`(종류) 로 목록만 읽는다. 풀지 않는다. */
export async function listArchiveEntries(archive: string): Promise<{ names: string[]; verbose: string[] }> {
  const tar = tarPath()
  if (!tar) throw fail('runtime_tar_missing', 'tar 실행 파일을 찾지 못함')
  const run = (flag: string): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const p = spawn(tar, [flag, archive], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => { out += String(c) })
    p.stderr.on('data', (c) => { err += String(c) })
    p.on('error', (e) => reject(fail('runtime_extract_failed', String(e))))
    // `exit` 를 기다린다 — 자식이 끝난 뒤에만 폴더를 지우거나 풀 수 있다(§4.2).
    p.on('exit', (code) => code === 0 ? resolve(out) : reject(fail('runtime_archive_rejected', `tar ${flag} exit ${code}: ${err.slice(-400)}`)))
    return promise
  }
  const [plain, verbose] = await Promise.all([run('-tzf'), run('-tvzf')])
  const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)
  return { names: lines(plain), verbose: lines(verbose) }
}

export interface Lock { path: string; token: string }

/**
 * 넘겨받아도 되는 잠금인가(§4.6 r3) — 적힌 pid 가 죽었거나, 맥박(파일 수정 시각)이 5분 넘게 멎었다.
 * 시간만으로는 안 뺏는다: 살아서 일하는 주인의 잠금은 몇 시간이 지나도 그대로 둔다.
 */
export function isLockStale(text: string, now: number, pidAlive: (pid: number) => boolean, beatAt: number | null): boolean {
  let parsed: unknown
  const incompleteIsStale = beatAt !== null && now - beatAt > LOCK_STALE_MS
  try {
    parsed = JSON.parse(text)
  } catch {
    return incompleteIsStale
  }
  if (!parsed || typeof parsed !== 'object') return incompleteIsStale
  const { pid, token } = parsed as Record<string, unknown>
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof token !== 'string' || !token) return incompleteIsStale
  if (!pidAlive(pid)) return true
  return incompleteIsStale
}

function readLock(path: string): { token: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const { token } = parsed as Record<string, unknown>
    return typeof token === 'string' ? { token } : null
  } catch {
    return null
  }
}

/** 내 잠금이 아직 내 것인가 — 도장 직전·놓을 때 확인한다(§4.6). */
export function lockHeld(lock: Lock): boolean {
  return readLock(lock.path)?.token === lock.token
}

interface LockSnapshot { text: string; dev: number; ino: number; beatAt: number }

/** 같은 열린 파일에서 소유자와 지문을 읽는다. 경로가 도중 교체돼도 서로 다른 세대를 섞지 않는다. */
function lockSnapshot(path: string): LockSnapshot | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const text = readFileSync(fd, 'utf8')
    const stat = fstatSync(fd)
    return { text, dev: stat.dev, ino: stat.ino, beatAt: stat.mtimeMs }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 같은 잠금 세대의 회수·해제를 직렬화한다. claim도 완성한 JSON을 배타 게시한다. */
function detachLock(path: string, observed: LockSnapshot, mayDetach: (current: LockSnapshot) => boolean): boolean {
  const claimBase = `${path}-claim-${observed.dev}-${observed.ino}`
  let claim = claimBase
  const pending = `${claimBase}-${randomUUID()}`
  const claimBody = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: randomUUID() })
  let owned = false
  try {
    writeFileSync(pending, claimBody, { flag: 'wx' })
    // 죽은 claim은 다음 배타 슬롯으로 넘긴다. 옛 슬롯을 지우면 늦은 회수자가 새 claim을
    // rename할 수 있으므로 증거를 남긴다. 모든 경쟁자는 같은 다음 슬롯에서 경합한다.
    for (let generation = 0; ; generation++) {
      claim = `${claimBase}-${generation}`
      try { linkSync(pending, claim); owned = true; break } catch { /* 소유자 확인 */ }
      const abandoned = lockSnapshot(claim)
      if (!abandoned) return false
      let owner: { pid?: number; startedAt?: number }
      try { owner = JSON.parse(abandoned.text) } catch { return false }
      if (!owner || !Number.isInteger(owner.pid) || owner.pid! <= 0 || typeof owner.startedAt !== 'number' || Date.now() - owner.startedAt <= 10 * 60 * 1000) return false
      try { process.kill(owner.pid!, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
      }
    }
    const current = lockSnapshot(path)
    if (!current || current.dev !== observed.dev || current.ino !== observed.ino || current.text !== observed.text || !mayDetach(current)) return false
    const detached = `${path}-retired-${randomUUID()}`
    renameSync(path, detached)
    const moved = lockSnapshot(detached)
    if (!moved || moved.dev !== observed.dev || moved.ino !== observed.ino || moved.text !== observed.text) {
      try { linkSync(detached, path) } catch { /* 새 소유자를 덮지 않는다 */ }
      return false
    }
    try { rmSync(detached) } catch { /* 격리된 옛 세대 */ }
    return true
  } catch {
    return false
  } finally {
    if (owned) {
      try { if (readFileSync(claim, 'utf8') === claimBody) rmSync(claim) } catch { /* 다음에 죽은 claim 회수 */ }
    }
    try { rmSync(pending, { force: true }) } catch { /* 개인 임시 파일 */ }
  }
}

/** 완성한 소유자 JSON을 hard link로 배타 게시한다. .lock에 빈 JSON 생성창이 없다. */
export function acquireLock(root: string, now: number, pidAlive: (pid: number) => boolean): Lock | null {
  const path = join(root, LOCK)
  const token = randomUUID()
  const pending = `${path}-pending-${token}`
  try {
    writeFileSync(pending, JSON.stringify({ token, pid: process.pid, startedAt: now }), { encoding: 'utf-8', flag: 'wx' })
    try {
      linkSync(pending, path)
      return { path, token }
    } catch { /* 이미 있으면 관찰한 그 세대만 회수한다 */ }
    const observed = lockSnapshot(path)
    if (!observed || !isLockStale(observed.text, now, pidAlive, observed.beatAt)) return null
    if (!detachLock(path, observed, (current) => isLockStale(current.text, now, pidAlive, current.beatAt))) return null
    try {
      linkSync(pending, path)
      return { path, token }
    } catch { return null }
  } catch {
    return null
  } finally {
    try { rmSync(pending, { force: true }) } catch { /* 미게시 개인 임시 파일 */ }
  }
}

/** 잠금 맥박 — 30초마다 수정 시각을 갱신한다(§4.6). 돌려주는 함수를 부르면 멈춘다. */
export function startLockBeat(lock: Lock, beatMs = LOCK_BEAT_MS): () => void {
  const timer = setInterval(() => {
    if (!lockHeld(lock)) return
    try {
      const now = new Date()
      utimesSync(lock.path, now, now)
    } catch { /* 다음 맥박에 다시 */ }
  }, beatMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** 놓을 때 — `token` 이 내 것일 때만 지운다. 아니면(누가 넘겨받았다) 손대지 않는다(§4.6). */
export function releaseLock(lock: Lock | null): void {
  if (!lock) return
  const observed = lockSnapshot(lock.path)
  if (!observed || readLock(lock.path)?.token !== lock.token) return
  detachLock(lock.path, observed, () => readLock(lock.path)?.token === lock.token)
}

export interface CleanupDeps {
  root: string
  spec: KordocSpec
  targetKey: string
  target: KordocTarget
  /** 개발 빌드(`!app.isPackaged`) — 도장 있는 폴더는 지우지도 `.retired` 를 찍지도 않는다(§4.4 r3). */
  isDev: boolean
  ledger: VerifyLedger
  now: () => number
  pidAlive: (pid: number) => boolean
}

/**
 * 옛 판 정리 — 설치와 **따로** 도는 시작 작업의 ③(§2·§4.4). 잠금을 쥐었을 때만 돈다.
 * 도장이 확실히 없는 폴더·임시 파일만 바로 지우고, 명세와 안 맞는 도장 폴더는 `.retired` 를 찍어
 * **24시간 묵인 뒤** 쓸 수 있는 설치가 따로 있을 때만 지운다(떠 있던 MCP 자식·규칙집 작업 몫).
 *
 * `runtimeStore.cleanupRuntimeAt` 을 안 쓰는 이유: 파이썬 계약은 "도장 있으면 절대 안 지움"이고
 * kordoc 은 "명세와 안 맞으면 24시간 뒤 지움"이라 규칙이 다르다(§4.4, KC-03).
 */
export function cleanupKordocAt(deps: CleanupDeps): void {
  const lock = acquireLock(deps.root, deps.now(), deps.pidAlive)
  if (!lock) return
  const stopBeat = startLockBeat(lock)
  try {
    let names: string[]
    try { names = readdirSync(deps.root) } catch { return }
    const hasUsable = usableKordocDir(deps.root, deps.spec, deps.targetKey, deps.target, deps.ledger) !== null
    for (const name of names) {
      if (name === LOCK) continue
      const path = join(deps.root, name)
      if (name.startsWith(TEMP_PREFIX)) {
        try { rmSync(path, { recursive: true, force: true }) } catch { /* 다음 시작에 다시 */ }
        continue
      }
      if (!KORDOC_INSTALL_DIR_RE.test(name)) continue
      const state = stampState(path)
      if (state.kind === 'absent') {
        try { rmSync(path, { recursive: true, force: true }) } catch { /* 다음 시작에 다시 */ }
        continue
      }
      if (state.kind !== 'ok') continue
      // 개발 빌드는 도장 있는 폴더에 손대지 않는다(§4.4 r3).
      if (deps.isDev) continue
      if (structuralOk(path, deps.spec, deps.targetKey, deps.target)) {
        // 아직 쓸 수 있는(또는 확인 전인) 폴더 — 안 지운다. 확인 전에 `.retired` 를 찍지도 않는다.
        continue
      }
      const retiredAt = readRetired(path)
      if (retiredAt === null) {
        retire(path, '명세와 안 맞거나 필수 파일이 빠짐', deps.now())
        continue
      }
      if (deps.now() - retiredAt < RETIRED_MS || !hasUsable) continue
      try { rmSync(path, { recursive: true, force: true }) } catch { /* 열려 있으면 다음 시작에 */ }
    }
  } finally {
    stopBeat()
    releaseLock(lock)
  }
}

/**
 * "실패 뒤 같은 앱 실행 안에서는 `retryMs` 에 한 번" 판정(§4.7). 시계를 인자로 받는 이유는 시험이다.
 * 성공하면 곧바로 다시 열린다 — 다음 판이 나오면 기다리지 않고 받는다.
 */
export interface RetryGate {
  mayStart: (now: number) => boolean
  failed: (now: number) => void
  succeeded: () => void
}

export function createRetryGate(retryMs: number): RetryGate {
  let lastFailure = 0
  return {
    mayStart: (now) => lastFailure === 0 || now - lastFailure >= retryMs,
    failed: (now) => { lastFailure = now },
    succeeded: () => { lastFailure = 0 }
  }
}

export interface Progress { phase: string; received?: number; total?: number }

/** 내려받기·압축 풀기·돌려 보기·여유 공간 — Electron 판이 다리를 놓는다. */
export interface InstallDeps {
  root: string
  spec: KordocSpec
  targetKey: string
  target: KordocTarget
  /** 앱 실행 파일 — 돌려 보기의 `node` 자리(§4.3). */
  execPath: string
  ledger: VerifyLedger
  /** 받는 주소(§3.1). 개발 판만 덮어쓸 수 있다 — 주소는 명세의 값으로만 조립한다. */
  url: string
  now: () => number
  platform: NodeJS.Platform
  pidAlive: (pid: number) => boolean
  freeBytes: (path: string) => number
  download: (url: string, dest: string, expected: { sha256: string; size: number }, onEvent: (p: Progress) => void, signal: AbortSignal) => Promise<void>
  extract: (archive: string, dest: string, strip: number) => Promise<void>
  listEntries: (archive: string) => Promise<{ names: string[]; verbose: string[] }>
  /** 앱 실행 파일로 `cli.js generate` 를 돌려 본다(§4.3). 자식이 끝난 뒤에 풀린다. */
  smoke: (execPath: string, dir: string, cli: string, signal?: AbortSignal) => Promise<void>
  signal: AbortSignal
  onEvent?: (event: Progress) => void
}

/** 도장 = 같은 폴더 안 `rename` 한 번(원자, §4.2-9). */
function writeStamp(dir: string, stamp: Stamp): void {
  const tmp = `${join(dir, STAMP)}.tmp`
  writeFileSync(tmp, JSON.stringify(stamp), 'utf-8')
  renameSync(tmp, join(dir, STAMP))
}

/**
 * 설치·게시(§4.2). **게시 전** 실패는 새 폴더를 지우고, **게시 후**(안내 파일·정리) 실패는
 * 설치를 남긴다 — 안내 파일은 한글 파일 산출용이라 MCP 게시를 뒤집을 수 없다(KC-01).
 *
 * 이미 쓸 수 있는 설치가 있으면 받지 않고 그 폴더를 돌려준다. 다른 쪽이 잠금을 쥐고 있으면
 * `runtime_locked` 로 끝난다(부르는 쪽은 이번 턴을 건너뛴다).
 *
 * 취소는 단계 사이에서만 확인한다 — 돌려 보기·tar 자식이 끝난 뒤에 폴더를 지운다(§4.2).
 */
export async function installKordoc(deps: InstallDeps): Promise<string> {
  const { root, spec, targetKey, target, ledger } = deps
  mkdirSync(root, { recursive: true })
  const lock = acquireLock(root, deps.now(), deps.pidAlive)
  if (!lock) throw fail('runtime_locked', '다른 쪽이 설치 중')
  const stopBeat = startLockBeat(lock)
  const temp = join(root, `${TEMP_PREFIX}${deps.now()}.tar.gz`)
  let fresh: string | null = null
  try {
    // §4.2-2 — 고르기와 **같은 판정**. 꼼꼼한 확인이 안 돌았으면 여기서 돌린다.
    const existing = await readyKordocDir({
      root,
      spec,
      targetKey,
      target,
      execPath: deps.execPath,
      ledger,
      now: deps.now,
      smoke: deps.smoke
    })
    if (existing) return existing
    if (deps.signal.aborted) throw fail('runtime_cancelled', '사용자가 취소함')

    const need = Math.ceil((target.size + target.unpackedSize) * 1.2)
    if (deps.freeBytes(root) < need) throw fail('runtime_no_space', `남은 공간 부족: ${need} 필요`)

    deps.onEvent?.({ phase: '내려받는 중', received: 0, total: target.size })
    await deps.download(deps.url, temp, { sha256: target.sha256, size: target.size }, (p) => deps.onEvent?.(p), deps.signal)
    if (deps.signal.aborted) throw fail('runtime_cancelled', '사용자가 취소함')

    const { names, verbose } = await deps.listEntries(temp)
    if (deps.signal.aborted) throw fail('runtime_cancelled', '사용자가 취소함')
    const dir = join(root, installDirName(target.sha256, deps.now()))
    checkArchive(names, verbose, deps.platform, dir)

    deps.onEvent?.({ phase: '푸는 중' })
    mkdirSync(dir, { recursive: true })
    fresh = dir
    await deps.extract(temp, dir, 0)
    if (deps.signal.aborted) throw fail('runtime_cancelled', '사용자가 취소함')

    const cli = join(dir, spec.cli)
    const mcp = join(dir, mcpSibling(spec.cli))
    if (!existsSync(cli)) throw fail('runtime_archive_rejected', 'cli.js 가 없음')
    if (!existsSync(mcp)) throw fail('runtime_archive_rejected', 'mcp.js 가 없음')
    if (!insideDir(dir, cli) || !insideDir(dir, mcp)) throw fail('runtime_archive_rejected', 'cli.js·mcp.js 가 설치 폴더 밖')
    if (sha256File(cli) !== spec.cliSha256) throw fail('runtime_archive_rejected', 'cli.js 해시가 명세와 다름')
    if (sha256File(mcp) !== spec.mcpSha256) throw fail('runtime_archive_rejected', 'mcp.js 해시가 명세와 다름')

    writeFileSync(join(dir, SHIM_NAME), SHIM_CONTENT, 'utf-8')

    deps.onEvent?.({ phase: '확인하는 중' })
    await deps.smoke(deps.execPath, dir, cli, deps.signal)
    if (deps.signal.aborted) throw fail('runtime_cancelled', '사용자가 취소함')

    // 도장 직전에 잠금이 아직 내 것인지 한 번 더(§4.6). 아니면 게시하지 않고 접는다.
    if (!lockHeld(lock)) throw fail('runtime_locked', '잠금을 다른 쪽이 넘겨받음')
    writeStamp(dir, { version: spec.version, release: spec.release, target: targetKey, sha256: target.sha256 })
    // 방금 통과한 돌려 보기를 이번 실행의 꼼꼼한 확인 통과로 센다(§4.2-9).
    ledger.passed.add(dir)
    ledger.failed.delete(dir)
    fresh = null
    return dir
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* 임시 파일 정리는 게시 성공을 뒤집지 않는다 */ }
    if (fresh) {
      // 게시 전 실패 — 아무도 못 본 폴더다(자식 프로세스는 각 다리가 끝난 뒤 돌아왔다).
      try { rmSync(fresh, { recursive: true, force: true }) } catch { /* 미완성 폴더는 다음 시작의 정리가 지운다 */ }
    }
    stopBeat()
    releaseLock(lock)
  }
}

/**
 * `ensureKordoc` 감싸개의 **순수 판정**(§5.2 네 갈래). Electron 을 모르므로 시험이 가짜 `legacy`·가짜 설치로 돈다.
 * 1 쓸 수 있는 설치가 있으면 그 값(꼼꼼한 확인이 안 돌았으면 **기다렸다가**) 2 명세 정상·대상 있는데
 * 아직 없으면 설치를 띄우고 `null` 3 대상 없음 → `legacy` 4 명세 오류 → `null` 이고 **옛 길을 열지 않는다**(KC-06).
 */
export interface SelectionDeps<T extends KordocRuntimeLike> {
  specState: () => SpecState
  /**
   * 지금 쓸 수 있는 설치. r3: 꼼꼼한 확인이 안 돌았으면 이 안에서 돌려 **기다린다**(§5.2).
   * 확인 전에는 값을 내지 않는다.
   */
  resolveManaged: () => Promise<T | null>
  /** 설치는 기다리지 않는다 — 첫 메시지가 멈추지 않게(§5.2). */
  startInstall: () => void
  /** 명세 오류를 앱 로그에 실행당 1회 남긴다. */
  reportInvalid?: (reason: string) => void
}

/** `chat/kordocMcp.ts` 의 `KordocRuntime` 과 같은 모양 — core 는 그 파일을 import 하지 않는다. */
export interface KordocRuntimeLike {
  node: string
  nodeArgs?: string[]
  cliJs: string
  version: string
  extraEnv?: Record<string, string>
}

export function makeKordocSelector<T extends KordocRuntimeLike>(
  deps: SelectionDeps<T>,
  legacy: (root: string) => Promise<T | null>
): (root: string) => Promise<T | null> {
  let reported = false
  return async (root: string) => {
    const state = deps.specState()
    if (state.kind === 'invalid') {
      if (!reported) {
        reported = true
        deps.reportInvalid?.(state.reason)
      }
      return null
    }
    if (state.kind === 'unsupported') return legacy(root)
    const managed = await deps.resolveManaged()
    if (managed) return managed
    deps.startInstall()
    return null
  }
}
