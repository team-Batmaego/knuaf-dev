/**
 * 앱 데이터 의존성 환경(S-01 설계 3판 §3.2). 논문 폴더의 `.venv` 는 보지 않는다 — 폴더에 쓸 수 있는
 * 사람이 앱 권한으로 코드를 돌릴 수 없게, 의존성 환경은 앱만 쓰는 자리에 둔다.
 *
 * 신뢰 조건은 하나: `<환경>/knuaf-ready.json` 이 있고 그 안 `key` 가 지금 키와 같으며 실행 파일이 있다.
 * 이 표식은 main 만, 준비(설치·진단)가 끝난 **뒤에** 쓴다(I-01). 내용 해시·지문은 두지 않는다 —
 * 공격자가 못 쓰는 자리라서다.
 *
 * Electron 을 모른다: 뿌리 경로는 호출자(`python.ts`)가 넘긴다. 그래서 노드 시험이 그대로 부를 수 있다.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'

export const READY_FILE = 'knuaf-ready.json'

/** 키를 이루는 스킬 쪽 데이터 파일(실행하지 않고 읽기만 한다). */
const MANIFEST_FILES = ['requirements-runtime.txt', 'runtime-deps.json']

function realOr(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/**
 * 키 = sha256(의존성 목록 두 파일 + 기반 python 실제 경로 + 플랫폼·아키텍처) 앞 16자.
 * 목록이나 기반 python 이 바뀌면 새 환경이 된다(옛 환경은 다른 키라 신뢰되지 않는다).
 */
export function depsKey(scriptsDir: string, basePython: string, platform = process.platform, arch = process.arch): string {
  const hash = createHash('sha256')
  for (const name of MANIFEST_FILES) {
    hash.update(name + '\0')
    try { hash.update(readFileSync(join(scriptsDir, name))) } catch { hash.update('missing') }
    hash.update('\0')
  }
  hash.update(realOr(basePython) + '\0' + platform + '\0' + arch)
  return hash.digest('hex').slice(0, 16)
}

const KEY_SHAPE = /^[0-9a-f]{16}$/

/** 키 모양(16자리 16진수)만 환경 폴더가 된다 — "없음" 경로(`_none`)나 임의 이름은 만들거나 지우지 않는다. */
export function envDir(root: string, key: string): string {
  if (!KEY_SHAPE.test(key)) throw new Error('not a deps env key: ' + key)
  return join(root, key)
}

export function envPython(dir: string, platform = process.platform): string | null {
  const candidates = platform === 'win32'
    ? [join(dir, 'Scripts', 'python.exe')]
    : [join(dir, 'bin', 'python3'), join(dir, 'bin', 'python')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** 신뢰된 환경 폴더, 없으면 빈 문자열. */
export function trustedEnv(root: string, key: string): string {
  if (!KEY_SHAPE.test(key)) return ''
  const dir = envDir(root, key)
  try {
    const ready = JSON.parse(readFileSync(join(dir, READY_FILE), 'utf-8')) as { key?: unknown }
    if (ready.key !== key) return ''
  } catch { return '' }
  return envPython(dir) ? dir : ''
}

function inside(root: string, path: string): boolean {
  const rel = relative(realOr(root), realOr(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 준비가 끝난 환경에 표식을 원자적으로 쓴다. 실행 파일이 없으면 신뢰하지 않는다. */
export function markReady(root: string, key: string, meta: Record<string, unknown> = {}): string {
  const dir = envDir(root, key)
  if (!inside(root, dir)) throw new Error('deps env outside app data: ' + dir)
  const python = envPython(dir)
  if (!python) throw new Error('deps env has no interpreter: ' + dir)
  const tmp = join(dir, READY_FILE + '.tmp-' + process.pid)
  writeFileSync(tmp, JSON.stringify({ key, python, at: new Date().toISOString(), ...meta }, null, 2))
  renameSync(tmp, join(dir, READY_FILE))
  return dir
}

/**
 * 표식 없는 환경 폴더 = 앱이 만들다 만 잔해(앱 데이터 안, 학생 자료 아님) → 지운다.
 * 표식 있는 환경은 건드리지 않는다. 앱 데이터 뿌리 밖이면 아무것도 하지 않는다.
 */
export function discardUnmarked(root: string, key: string): boolean {
  if (!KEY_SHAPE.test(key)) return false
  const dir = envDir(root, key)
  if (!existsSync(dir) || !inside(root, dir)) return false
  if (existsSync(join(dir, READY_FILE))) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 오래된 키 환경 정리(§3.2): `root` 아래 키 모양 폴더 중 지금 키와, 표식 있는 것 가운데 가장 최근 것 1개(직전)만
 * 남기고 지운다. 표식 없는 잔해도 지운다(지금 키는 준비 중일 수 있어 표식이 없어도 남긴다).
 * 키 모양이 아닌 이름·링크·파일은 건드리지 않는다 — 앱 데이터 안에서도 앱이 만든 것만 지운다.
 * 지운 폴더 목록을 돌려준다. 실패는 그 폴더만 건너뛴다(다음 시작 때 다시 본다).
 */
export async function pruneEnvs(root: string, keepKey: string): Promise<string[]> {
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  const others: { dir: string; readyAt: number | null }[] = []
  for (const name of names) {
    if (name === keepKey || !KEY_SHAPE.test(name)) continue
    const dir = envDir(root, name)
    try { if (!lstatSync(dir).isDirectory() || !inside(root, dir)) continue } catch { continue }
    let readyAt: number | null = null
    try { readyAt = statSync(join(dir, READY_FILE)).mtimeMs } catch { /* 표식 없음 */ }
    others.push({ dir, readyAt })
  }
  const previous = others.filter((o) => o.readyAt !== null).sort((a, b) => (b.readyAt ?? 0) - (a.readyAt ?? 0))[0]
  const removed: string[] = []
  for (const o of others) {
    if (o === previous) continue
    try { await rm(o.dir, { recursive: true, force: true }); removed.push(o.dir) } catch { /* 다음 시작 때 */ }
  }
  return removed
}

/** 이번 작업 전의 표식 원문(없으면 null). 실패·취소 때 이것으로 되돌린다(I-03). */
export function readMark(root: string, key: string): string | null {
  if (!KEY_SHAPE.test(key)) return null
  try { return readFileSync(join(envDir(root, key), READY_FILE), 'utf-8') } catch { return null }
}

/**
 * 표식을 `before` 로 되돌린다: 이전에 있었으면 그 원문 그대로(이전 정상 환경은 계속 신뢰), 없었으면 표식을 지운다
 * (그러면 표식 없는 잔해가 되어 `discardUnmarked` 가 치울 수 있다). 앱 데이터 뿌리 안 키 폴더에서만 한다.
 */
export function restoreMark(root: string, key: string, before: string | null): void {
  if (!KEY_SHAPE.test(key)) return
  const dir = envDir(root, key)
  if (!inside(root, dir)) return
  const file = join(dir, READY_FILE)
  if (before === null) { rmSync(file, { force: true }); return }
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, before)
  renameSync(tmp, file)
}

/** 신뢰 철회(I-04): 표식만 지운다 — 환경 폴더는 다음 준비 때 `discardUnmarked` 가 치운다. 사용자 파일은 안 건드린다. */
export function revokeTrust(root: string, key: string): boolean {
  if (!KEY_SHAPE.test(key)) return false
  const dir = envDir(root, key)
  if (!inside(root, dir) || !existsSync(join(dir, READY_FILE))) return false
  rmSync(join(dir, READY_FILE), { force: true })
  return true
}

// ---- 공유 환경 전환 잠금(설계 §3.2 `deps/.lock`, 검토 r1 I-01 · r2 I-01) --------------------------------------
export const LOCK_FILE = '.lock'
const heldHere = new Set<string>()
const STALE_MS = 10 * 60_000 // 소유자를 알 수 없는(깨진·쓰는 중) 잠금이 이만큼 낡으면 잔해
const CLAIM_UNKNOWN_OWNER_MS = 10_000 // 소유자 pid 를 읽을 수 없는 청구 파일이 이보다 낡으면 잔해(소유자가 보이면 나이를 보지 않는다)

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function statAge(path: string): number {
  try { return Date.now() - statSync(path).mtimeMs } catch { return Infinity }
}

function readRaw(path: string): string | null {
  try { return readFileSync(path, 'utf-8') } catch { return null }
}

/** 잠금 원문이 낡은 것(소유 프로세스가 없음)인가. 같은 프로세스의 것은 이 모듈이 쥐고 있지 않을 때만 낡은 것. */
function staleBody(path: string, raw: string): boolean {
  try {
    const held = JSON.parse(raw) as { pid?: unknown }
    if (typeof held.pid !== 'number') return statAge(path) > STALE_MS
    return held.pid === process.pid ? !heldHere.has(path) : !pidAlive(held.pid)
  } catch { return statAge(path) > STALE_MS }
}

/**
 * 낡은 잠금 회수 — **죽은 잠금 한 개체마다 청구 파일 하나**(검토 r3·Roh).
 *
 * 앞선 판은 공용 보호 파일을 "확인 → 삭제"로 치웠는데, 확인과 삭제가 별도 연산이라 확인한 뒤 멈춘 쪽이 재개하면서 남이
 * 새로 잡은 보호를 지울 수 있었다(다시 읽어도 못 막는다). 여기서는 지우는 일 자체를 없앤다: 청구 파일 이름이 **그 죽은
 * 잠금의 원문 해시**에 묶여 있어(`.lock.claim.<해시>.<k>`) `wx` 로 만들 수 있는 쪽은 그 개체당 한 번에 하나뿐이다
 * (원자적 소유 이전). 청구자가 아니면 아무것도 지우지 않는다.
 * - 청구자가 살아 있으면(오래 멈췄어도) 기다린다 — 나이만으로 빼앗지 않는다. 청구자가 죽었으면 다음 번호(k+1)를
 *   `wx` 로 잡는다(이전 청구 파일은 지우지 않으므로 지우기 경쟁이 없다).
 * - 청구자가 `.lock` 을 지우는 순간 `.lock` 은 그 원문이 아니다. 죽은 원문은 다시 나타나지 않으므로(토큰이 매번 새것),
 *   늦게 깨어난 옛 청구자의 "같은 원문이면 지운다"는 새 잠금을 건드릴 수 없다(원문이 다르다).
 * 끝나면 그 원문의 청구 파일들을 치운다(남아도 해가 없다 — 해시가 다른 새 잠금과 무관).
 */
async function reclaimStale(path: string, seen: string, hook?: () => void | Promise<void>): Promise<boolean> {
  const key = createHash('sha256').update(seen).digest('hex').slice(0, 16)
  const prefix = `${path}.claim.${key}.`
  const mine = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex') })
  let claim: string | null = null
  for (let k = 0; k < 64 && claim === null; k++) {
    const candidate = prefix + k
    try {
      writeFileSync(candidate, mine, { flag: 'wx' })
      claim = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!claimantGone(candidate)) return false // 살아 있는 청구자가 하고 있다 — 기다린다
    }
  }
  if (claim === null) return false
  try {
    if (readRaw(path) !== seen) return false // 그 죽은 잠금은 이미 사라졌다(다른 청구자가 끝냈다)
    await hook?.() // 시험용: 확인을 마치고 삭제 직전에 멈춘다
    if (readRaw(path) !== seen) return false // 멈춘 사이 바뀌었으면(옛 청구자가 늦게 깬 경우 포함) 새 잠금은 건드리지 않는다
    rmSync(path, { force: true })
    return true
  } finally {
    try {
      const dir = dirname(path), base = basename(prefix)
      for (const name of readdirSync(dir)) if (name.startsWith(base)) rmSync(join(dir, name), { force: true })
    } catch { /* 청구 파일 잔해는 해롭지 않다 */ }
  }
}

/** 청구 파일의 주인이 없어졌나: 소유 PID 가 죽었으면 참, 살아 있으면 거짓, 소유자를 읽을 수 없는 파일은 오래됐을 때만 참. */
function claimantGone(file: string): boolean {
  try {
    const pid = (JSON.parse(readRaw(file) ?? '') as { pid?: unknown }).pid
    if (typeof pid === 'number') return pid !== process.pid && !pidAlive(pid)
  } catch { /* 쓰는 중이거나 깨진 파일 */ }
  return statAge(file) > CLAIM_UNKNOWN_OWNER_MS
}

/**
 * 공유 환경(`deps/<키>`)을 건드리는 준비 한 건이 쥐는 잠금. 폴더(root)별 flight 는 합쳐도 설치 대상은 PC 하나라서,
 * 잔해 정리~설치~검증~표식~재시작~실패 정리가 끝날 때까지 다른 준비가 같은 환경을 지우거나 덮지 못하게 한다.
 * 같은 프로세스(폴더 전환)와 다른 프로세스(앱 둘) 모두 `wx` 파일로 막는다. 잠금 원문에는 소유 토큰이 있고,
 * 해제는 **원문이 내 토큰일 때만** 지운다(회수당한 뒤의 해제가 상대의 현재 잠금을 지우지 않는다).
 * 기다리는 동안 `isCancelled()` 가 참이면 null — 호출자가 취소·방문 변경으로 닫는다. 반환 함수가 잠금을 돌려준다.
 * `onStaleJudged` 는 "낡았다고 판단한 직후" 순서를 제어하는 시험용 고리다.
 */
export async function acquireEnvLock(root: string, opts: { isCancelled?: () => boolean; pollMs?: number; onStaleJudged?: () => void | Promise<void>; onReclaimHeld?: () => void | Promise<void> } = {}): Promise<(() => void) | null> {
  mkdirSync(root, { recursive: true })
  const path = join(root, LOCK_FILE), poll = opts.pollMs ?? 100
  const body = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), at: new Date().toISOString() })
  for (;;) {
    if (opts.isCancelled?.()) return null
    if (!heldHere.has(path)) {
      try {
        writeFileSync(path, body, { flag: 'wx' })
        heldHere.add(path)
        return () => {
          heldHere.delete(path)
          if (readRaw(path) === body) rmSync(path, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const seen = readRaw(path)
        if (seen === null) continue // 그사이 풀렸다
        if (staleBody(path, seen)) {
          await opts.onStaleJudged?.()
          if (await reclaimStale(path, seen, opts.onReclaimHeld)) continue
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, poll))
  }
}
