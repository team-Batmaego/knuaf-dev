/**
 * guard/store.ts — 상태 파일(state.json), 보관본(blobs), quarantine, 전송 장부, 무결성
 *
 * 보관본 디렉토리: <userData>/guard/<sha256(realRoot)>/
 *   - state.json: { leaves, leafHashes, injected, rules, queryOpen, integrity }
 *   - blobs/<sha256>: 내용 저장소 (크기 제한 없음)
 *   - sent.jsonl: 전송 장부 (덧붙이기)
 *
 * 격리: .knuaf-gui/quarantine/<timestamp>/ 내 blobs/<sha256> + index.json
 * 상태 파일은 임시 파일 → rename 한 번으로 통째 교체 (원자성).
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

/** 규칙 항목 */
export interface RuleEntry {
  id: string
  /** 학생 메시지 원문(raw, 변형 전 저장용 참조) */
  message: string
  timestamp: number
  /** 정규화된 버전(앞뒤 공백·빈줄 trim + 줄바꿈 \n 통일) */
  normalized: string
}

/** 상태 파일 전체 모양 */
export interface GuardState {
  leaves: string[]
  /** leaf별 내용 해시(sha256 hex 또는 link:<target> 해시). 비교용 */
  leafHashes: Record<string, string>
  /** 넣는 판 blob sha256 (null = 없음) */
  injected: string | null
  rules: RuleEntry[]
  queryOpen: boolean
  integrity: string
}

/** 기본 상태 생성 */
export function defaultState(): GuardState {
  return {
    leaves: [],
    leafHashes: {},
    injected: null,
    rules: [],
    queryOpen: false,
    integrity: ''
  }
}

/** 보관본 디렉토리 경로: <userData>/guard/<folderHash>/ */
export function guardDir(userData: string, folderHash: string): string {
  return join(userData, 'guard', folderHash)
}

export function statePath(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'state.json')
}

export function blobsDir(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'blobs')
}

export function sentPath(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'sent.jsonl')
}

/** HMAC/무결성 표식 계산 (단순 sha256 해시 — 실제 HMAC 키는 safeStorage 연동 시 추가) */
export function computeIntegrity(state: Omit<GuardState, 'integrity'>): string {
  const parts = [
    [...state.leaves].sort().join('|'),
    JSON.stringify(Object.keys(state.leafHashes || {}).sort().map(k => [k, state.leafHashes[k]])),
    state.injected ?? '',
    [...state.rules].sort((a, b) => a.id.localeCompare(b.id)).map(r => `${r.id}:${r.normalized}`).join('|'),
    String(state.queryOpen)
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** 상태 파일 로드 */
export function loadState(userData: string, folderHash: string): GuardState {
  const path = statePath(userData, folderHash)
  if (!existsSync(path)) return defaultState()
  try {
    const content = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(content) as Partial<GuardState>
    return {
      leaves: Array.isArray(parsed.leaves) ? parsed.leaves : [],
      leafHashes: parsed.leafHashes && typeof parsed.leafHashes === 'object' ? parsed.leafHashes : {},
      injected: typeof parsed.injected === 'string' ? parsed.injected : null,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      queryOpen: Boolean(parsed.queryOpen),
      integrity: typeof parsed.integrity === 'string' ? parsed.integrity : ''
    }
  } catch {
    return defaultState()
  }
}

/** 상태 파일 저장(원자적 교체: 임시 파일 → rename) */
export function saveState(userData: string, folderHash: string, state: Omit<GuardState, 'integrity'>): boolean {
  const dir = guardDir(userData, folderHash)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const full: GuardState = { ...state, integrity: computeIntegrity(state) }
    const tmp = statePath(userData, folderHash) + '.tmp'
    const final = statePath(userData, folderHash)
    writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8')
    renameSync(tmp, final)
    return true
  } catch {
    try {
      const tmp = statePath(userData, folderHash) + '.tmp'
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch { /* ignore */ }
    return false
  }
}

/** blob 저장 (sha256 키) */
export function putBlob(userData: string, folderHash: string, content: Buffer | string): string {
  const dir = blobsDir(userData, folderHash)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
  const hash = createHash('sha256').update(buf).digest('hex')
  const path = join(dir, hash)
  if (!existsSync(path)) {
    writeFileSync(path, buf)
  }
  return hash
}

/** blob 읽기 */
export function getBlob(userData: string, folderHash: string, hash: string): Buffer | null {
  const path = join(blobsDir(userData, folderHash), hash)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/** 격리(quarantine): 보호 대상을 .knuaf-gui/quarantine/<timestamp>/로 이동/복사 */
export function quarantineFile(
  rootReal: string,
  relativePath: string,
  timestamp: number
): string | null {
  const qBase = join(rootReal, '.knuaf-gui', 'quarantine', String(timestamp))
  const qBlobs = join(qBase, 'blobs')
  const fullPath = resolve(rootReal, relativePath)
  if (!existsSync(fullPath)) return null

  try {
    if (!existsSync(qBlobs)) mkdirSync(qBlobs, { recursive: true })
    const ls = lstatSync(fullPath)
    let blobHash = ''
    let kind: 'file' | 'link' = 'file'
    let linkTarget = ''

    if (ls.isSymbolicLink()) {
      kind = 'link'
      linkTarget = readlinkSync(fullPath)
      blobHash = createHash('sha256').update('link:' + linkTarget).digest('hex')
      writeFileSync(join(qBlobs, blobHash), linkTarget, 'utf-8')
    } else if (ls.isFile()) {
      const buf = readFileSync(fullPath)
      blobHash = createHash('sha256').update(buf).digest('hex')
      writeFileSync(join(qBlobs, blobHash), buf)
    } else {
      return null
    }

    // index.json 업데이트
    const indexPath = join(qBase, 'index.json')
    let index: Array<{ originalPath: string; blobHash: string; kind: string; linkTarget?: string }> = []
    if (existsSync(indexPath)) {
      try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch { index = [] }
    }
    index.push({ originalPath: relativePath, blobHash, kind, ...(linkTarget ? { linkTarget } : {}) })
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

    // 원본 삭제 (격리 완료)
    try { rmSync(fullPath, { force: true }) } catch { /* ignore */ }
    return join(qBlobs, blobHash)
  } catch {
    return null
  }
}

/** 빈 .claude 하위 폴더 정리 */
export function cleanupEmptyClaudeDirs(rootReal: string): string[] {
  const cleaned: string[] = []
  const claudeDir = join(rootReal, '.claude')
  if (!existsSync(claudeDir)) return cleaned

  const tryClean = (dir: string): boolean => {
    let entries: string[]
    try {
      entries = readdirSync(dir) as string[]
    } catch {
      return false
    }
    // 하위 디렉토리 먼저 정리
    for (const name of [...entries]) {
      const child = join(dir, name)
      try {
        const st = lstatSync(child)
        if (st.isDirectory() && !st.isSymbolicLink()) {
          if (tryClean(child)) {
            try { entries = readdirSync(dir) as string[] } catch { /* */ }
          }
        }
      } catch { /* ignore */ }
    }
    // 비어있으면 삭제 (루트 .claude 자체는 삭제하지 않음)
    try {
      entries = readdirSync(dir) as string[]
    } catch {
      return false
    }
    if (entries.length === 0 && dir !== claudeDir) {
      try {
        rmSync(dir, { recursive: false })
        cleaned.push(dir)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  // .claude 하위만 정리
  try {
    const top = readdirSync(claudeDir, { withFileTypes: true })
    for (const e of top) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        tryClean(join(claudeDir, String(e.name)))
      }
    }
  } catch { /* ignore */ }

  return cleaned
}

/** 전송 장부에 한 줄 추가 */
export function appendSentLog(
  userData: string,
  folderHash: string,
  entry: { id: string; folder: string; provider: 'claude' | 'codex'; convId: string; text: string; timestamp?: number }
): boolean {
  const p = sentPath(userData, folderHash)
  try {
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const ts = entry.timestamp ?? Date.now()
    const line = JSON.stringify({ ...entry, timestamp: ts }) + '\n'
    appendFileSync(p, line, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 전송 장부 읽기 */
export function readSentLog(userData: string, folderHash: string): Array<{ id: string; folder: string; provider: string; convId: string; text: string; timestamp: number }> {
  const p = sentPath(userData, folderHash)
  if (!existsSync(p)) return []
  try {
    const content = readFileSync(p, 'utf-8')
    return content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean) as Array<{ id: string; folder: string; provider: string; convId: string; text: string; timestamp: number }>
  } catch {
    return []
  }
}

/** rules에서 특정 id 찾기 */
export function findRule(rules: RuleEntry[], id: string): RuleEntry | null {
  return rules.find(r => r.id === id) ?? null
}

/** rules에서 id 삭제 */
export function removeRule(rules: RuleEntry[], id: string): RuleEntry[] {
  return rules.filter(r => r.id !== id)
}
