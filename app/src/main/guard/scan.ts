/**
 * guard/scan.ts — lstat 기반 잎 스캔 + 보호 대상 경로 수집
 *
 * 폴더 전체를 재귀 스캔해 보호 대상 파일·링크(leaf) 목록을 반환한다.
 * - .claude/ 아래 파일·심볼릭 링크만 대상으로 함
 * - 루트 `CLAUDE.md`와 앱 스킬 자리 아래는 제외(서비스 레벨에서 처리)
 * - 심볼릭 링크는 `lstat`으로 끊어 확인(대상 내용은 보호하지 않음)
 * - 안전성: 빈 폴더·권한 오류는 조용히 건너뜀
 */

import { readdirSync, lstatSync, readFileSync, readlinkSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isProtectedPath, isSkillHostPath } from './scope'

/** 스캔 옵션 */
export interface ScanOptions {
  /** 루트 폴더 (예: <userData>/논문 작업) */
  root: string
  /** 보호 대상을 포함할지 */
  includeProtected?: boolean
  /** 앱 스킬 자리를 보호 대상에서 제외할지 */
  excludeSkillHost?: boolean
}

/** 스캔 결과: 잎(파일·링크) 목록 + 무결성 해시 */
export interface ScanResult {
  /** 보호 대상 leaf(파일·링크) 경로相対 root */
  leaves: string[]
  /** 각 leaf에 대한 sha256 해시(바이트 기준) */
  leafHashes: Map<string, string>
  /** 보관본용 폴더 해시 */
  folderHash: string
  /** 변경 감지용 현재 질의 열린 표식 */
  queryOpen: boolean
  /** 스캔된 실제 폴더 경로 */
  realRoot: string
}

/** 폴더 전체 스캔 */
export function scanRoot(opts: ScanOptions): ScanResult {
  const root = opts.root
  const excludeSkillHost = opts.excludeSkillHost !== false

  // 실제 폴더 경로(absolute, normalized)
  const realRoot = resolve(root)
  const folderHashHex = createHash('sha256').update(realRoot).digest('hex')

  // lstat 기반 잎 스캔
  const leaves: string[] = []
  const leafHashes = new Map<string, string>()

  try {
    scanDirRecursive(realRoot, '', leaves, leafHashes, excludeSkillHost, realRoot)
  } catch {
    // 스캔 실패해도 결과는 부분적 반환
  }

  // queryOpen 표식: 실제 파일 시스템에서 확인하되,
  // 여기서는 기본 false(보관본에 질의가 열려 있지 않음 기본값)으로 둔다.
  // 실제 T0·T2 판단은 service.ts에서 담당.
  const queryOpen = false

  return {
    leaves,
    leafHashes,
    folderHash: folderHashHex,
    queryOpen,
    realRoot,
  }
}

/** 디렉토리 재귀 스캔 */
function scanDirRecursive(
  dir: string,
  relFromRoot: string,
  leaves: string[],
  leafHashes: Map<string, string>,
  excludeSkillHost: boolean,
  rootReal: string
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch {
    return // 권한 오류 등: 조용히 건너뜀
  }

  for (const entry of entries) {
    const name = String(entry.name)
    const fullPath = join(dir, name)
    const relPath = relFromRoot ? join(relFromRoot, name) : name

    // 앱 스킬 자리 제외
    if (excludeSkillHost && isSkillHostPath(fullPath)) continue

    let isDir = false
    let isLink = false
    try {
      if (entry.isSymbolicLink()) {
        isLink = true
      } else if (entry.isDirectory()) {
        isDir = true
      }
    } catch {
      continue
    }

    // 심볼릭 링크: 링크 자체를 leaf로 기록(대상은 따라가지 않음)
    if (isLink) {
      if (isProtectedPath(fullPath, rootReal)) {
        leaves.push(relPath)
        try {
          const target = readlinkSync(fullPath)
          leafHashes.set(relPath, createHash('sha256').update('link:' + target).digest('hex'))
        } catch {
          leafHashes.set(relPath, '')
        }
      }
      continue
    }

    if (isDir) {
      // .claude/ 폴더는 내용만 스캔하고 폴더 자체는 leaf가 아님
      if (name === '.claude') {
        scanClaudeDir(fullPath, relPath, leaves, leafHashes, excludeSkillHost, rootReal)
        continue
      }
      // 그 외 디렉토리 재귀
      scanDirRecursive(fullPath, relPath, leaves, leafHashes, excludeSkillHost, rootReal)
      continue
    }

    // 파일(일반)
    if (entry.isFile()) {
      if (isProtectedPath(fullPath, rootReal)) {
        leaves.push(relPath)
        try {
          const buf = readFileSync(fullPath)
          leafHashes.set(relPath, createHash('sha256').update(buf).digest('hex'))
        } catch {
          leafHashes.set(relPath, '')
        }
      }
    }
  }
}

/** .claude/ 폴더 내부 스캔 (보호 파일/링크만 수집) */
function scanClaudeDir(
  claudeDir: string,
  relFromRoot: string,
  leaves: string[],
  leafHashes: Map<string, string>,
  excludeSkillHost: boolean,
  rootReal: string
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(claudeDir, { withFileTypes: true }) as Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    const name = String(entry.name)
    const fullPath = join(claudeDir, name)
    const relPath = join(relFromRoot, name)

    if (excludeSkillHost && isSkillHostPath(fullPath)) continue

    let isLink = false
    let isFile = false
    let isDir = false
    try {
      isLink = entry.isSymbolicLink()
      isFile = entry.isFile()
      isDir = entry.isDirectory()
    } catch {
      continue
    }

    if (isLink) {
      if (isProtectedPath(fullPath, rootReal)) {
        leaves.push(relPath)
        try {
          const target = readlinkSync(fullPath)
          leafHashes.set(relPath, createHash('sha256').update('link:' + target).digest('hex'))
        } catch {
          leafHashes.set(relPath, '')
        }
      }
      continue
    }

    if (isFile) {
      if (isProtectedPath(fullPath, rootReal)) {
        leaves.push(relPath)
        try {
          const buf = readFileSync(fullPath)
          leafHashes.set(relPath, createHash('sha256').update(buf).digest('hex'))
        } catch {
          leafHashes.set(relPath, '')
        }
      }
      continue
    }

    // .claude 하위 디렉토리도 재귀적으로 보호 대상 파일을 찾을 수 있으나,
    // 보호 규칙상 .claude 조각이 있으면 보호이므로 하위 파일들도 보호 대상
    if (isDir) {
      scanClaudeDir(fullPath, relPath, leaves, leafHashes, excludeSkillHost, rootReal)
    }
  }
}
