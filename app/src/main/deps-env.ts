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
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

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

export function envDir(root: string, key: string): string {
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
  const dir = envDir(root, key)
  if (!existsSync(dir) || !inside(root, dir)) return false
  if (existsSync(join(dir, READY_FILE))) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

const KEY_NAME = /^[0-9a-f]{16}$/

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
    if (name === keepKey || !KEY_NAME.test(name)) continue
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
