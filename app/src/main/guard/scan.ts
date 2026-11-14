/**
 * guard/scan.ts — lstat 잎 스캔 + 잎 지문
 *
 * 폴더를 재귀 스캔해 **잎(파일·링크)만** 모은다. 폴더는 항목이 아니다(§4.3).
 * - `.claude` 조각 아래의 파일·링크와 `CLAUDE.md`·`CLAUDE.local.md`가 대상(`scope.ts`)
 * - 링크는 따라가지 않는다 — 링크 자체(가리키는 문자열)가 항목이다
 * - `.knuaf-gui/`(격리·앱 작업 폴더)와 앱 보관본·앱 스킬 자리는 건너뛴다
 * - 권한 오류·깨진 링크는 조용히 건너뛴다(스캔이 질의를 막지 않는다)
 *
 * 지문(§10-8 라):
 * - 파일: 내용 sha256 + 실행 권한 비트(윈도우는 비트가 뜻이 없어 넣지 않는다)
 * - 링크: 가리키는 문자열 sha256 — **대상 파일 내용은 보호하지 않는다**(§8-3)
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { folderHash, isProtectedPath, isSkillHostPath, realRoot } from './scope'

export type LeafKind = 'file' | 'link'

export interface LeafFingerprint {
  kind: LeafKind
  /** 파일 내용 sha256 / 링크 대상 문자열 sha256 */
  hash: string
  /** 실행 권한 비트(윈도우·링크는 false) */
  executable: boolean
  /** 링크 대상 문자열(링크만) */
  linkTarget?: string
}

export interface ScanOptions {
  root: string
  /** 앱 스킬 자리를 보호 대상에서 제외할지(기본 true) */
  excludeSkillHost?: boolean
  /** `userData`를 주면 그 아래 보관본·스킬 자리를 정확히 판정한다 */
  userData?: string
}

export interface ScanResult {
  /** 루트 기준 상대 경로(`/` 구분) → 지문. 잎만 들어 있다. */
  leaves: Map<string, LeafFingerprint>
  /** 보관본 키 */
  folderHash: string
  /** 실제(realpath) 루트 */
  realRoot: string
}

/** 실행 권한 비트가 있는가. 윈도우는 비교 대상이 아니다. */
function hasExecBit(st: Stats): boolean {
  if (process.platform === 'win32') return false
  return (st.mode & 0o111) !== 0
}

/** 잎 하나의 지문. 잎이 아니거나 읽을 수 없으면 null. */
export function fingerprintLeaf(absPath: string): LeafFingerprint | null {
  let st: Stats
  try {
    st = lstatSync(absPath)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) {
    let target: string
    try {
      target = readlinkSync(absPath)
    } catch {
      return null
    }
    return { kind: 'link', hash: createHash('sha256').update('link:' + target).digest('hex'), executable: false, linkTarget: target }
  }
  if (!st.isFile()) return null
  let buf: Buffer
  try {
    buf = readFileSync(absPath)
  } catch {
    return null
  }
  return { kind: 'file', hash: createHash('sha256').update(buf).digest('hex'), executable: hasExecBit(st) }
}

/** 지문이 같은가. 윈도우에서 속성(권한 비트·시각)만 다른 것은 차이가 아니다(§10-8 라). */
export function sameFingerprint(a: LeafFingerprint | undefined, b: LeafFingerprint | undefined): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.hash !== b.hash) return false
  if (a.kind === 'link') return a.linkTarget === b.linkTarget
  if (process.platform === 'win32') return true
  return a.executable === b.executable
}

/** 전송이 끝난 뒤 잎 상태가 그대로면 `false`. 링크 대상 파일의 내용은 보지 않는다. */
export function leavesEqual(a: Map<string, LeafFingerprint>, b: Map<string, LeafFingerprint>): boolean {
  if (a.size !== b.size) return false
  for (const [rel, fingerprint] of a) {
    if (!sameFingerprint(fingerprint, b.get(rel))) return false
  }
  return true
}

/** 바뀐 잎의 상대 경로. 추가·삭제·변경 전부. */
export function diffLeaves(before: Map<string, LeafFingerprint>, after: Map<string, LeafFingerprint>): string[] {
  const changed: string[] = []
  for (const [rel, fingerprint] of before) {
    if (!sameFingerprint(fingerprint, after.get(rel))) changed.push(rel)
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changed.push(rel)
  }
  return changed
}

function skipDir(name: string, absPath: string, excludeSkillHost: boolean, userData: string | undefined): boolean {
  // 앱 작업 폴더(격리 포함)는 보호 대상이 아니다 — 격리 폴더가 새 보호 항목을 만들지 않는다(§10-12)
  if (name === '.knuaf-gui') return true
  if (userData) {
    const guard = join(userData, 'guard')
    if (absPath === guard || absPath.startsWith(guard + '/')) return true
  }
  if (excludeSkillHost && isSkillHostPath(absPath, userData)) return true
  return false
}

/** 폴더 전체 스캔. */
export function scanRoot(opts: ScanOptions): ScanResult {
  const root = realRoot(opts.root)
  const excludeSkillHost = opts.excludeSkillHost !== false
  const leaves = new Map<string, LeafFingerprint>()
  walk(root, '', leaves, excludeSkillHost, opts.userData, root)
  return { leaves, folderHash: folderHash(root), realRoot: root }
}

function walk(
  dir: string,
  relDir: string,
  leaves: Map<string, LeafFingerprint>,
  excludeSkillHost: boolean,
  userData: string | undefined,
  root: string
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    const name = String(entry.name)
    const abs = join(dir, name)
    const rel = relDir ? `${relDir}/${name}` : name
    const isLink = entry.isSymbolicLink()

    if (!isLink && entry.isDirectory()) {
      if (skipDir(name, abs, excludeSkillHost, userData)) continue
      walk(abs, rel, leaves, excludeSkillHost, userData, root)
      continue
    }

    if (!isLink && !entry.isFile()) continue
    if (!isProtectedPath(abs, root)) continue
    if (excludeSkillHost && isSkillHostPath(abs, userData)) continue

    const fingerprint = fingerprintLeaf(abs)
    if (fingerprint) leaves.set(rel, fingerprint)
  }
}
