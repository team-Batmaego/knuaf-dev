/**
 * guard/store.ts — 보관본(상태 파일 하나·blobs·전송 장부·쪽지)과 원자 쓰기
 *
 * 자리: `<userData>/guard/<sha256(realRoot)>/`
 *   - `state.json`  잎 지문·넣는 판(`injected`)·규칙 표·질의 열림 표식·무결성(HMAC)
 *   - `blobs/<sha256>` 파일 내용/링크 문자열 — 크기 제한 없음
 *   - `sent.jsonl`  전송 장부(덧붙이기만) — 줄마다 무결성
 *   - `pending.json` 앱이 규칙을 쓰는 중이라는 쪽지(§11.8 '앱이 쓰는 순서' 4~8)
 *
 * 상태는 **한 파일을 임시 파일 → 이름 바꾸기 한 번**으로 통째 교체한다(§11.8-7).
 * 그래서 저장 성공 시점이 한 번뿐이고, 강제 종료 복구도 한 표로 닫힌다.
 *
 * 링크는 따라가지 않는다 — 링크는 "가리키는 문자열"이 항목이다(§4.3, §10-7).
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fingerprintLeaf, type LeafFingerprint } from './scan'
import { isInside } from './scope'

/** 규칙 표 한 줄(파일에는 id를 적지 않는다 — 학생이 보는 파일을 깨끗하게) */
export interface RuleEntry {
  id: string
  /** 학생이 보낸 원문(앞뒤 공백·줄바꿈 변형 전) */
  message: string
  timestamp: number
  /** 파일 구획에 적히는 글자 */
  normalized: string
}

/** 앱이 규칙을 쓰는 도중이라는 쪽지 */
export interface PendingAppWrite {
  action: 'add' | 'remove'
  /** 이전 CLAUDE.md 내용 blob 해시(없던 파일이면 null) */
  previousHash: string | null
  /** 새 CLAUDE.md 내용 blob 해시 */
  nextHash: string
  at: number
}

/** 앱이 규칙을 쓰는 도중이라는 쪽지(§11.8 '앱이 쓰는 순서' 4~8). 죽으면 이걸 보고 복구한다. */
export interface PendingAppWrite {
  action: 'add' | 'remove'
  /** 이전 파일 내용 sha256(없던 파일이면 null) */
  previousHash: string | null
  /** 새 파일 내용 sha256 */
  nextHash: string
  at: number
}

/** 상태 파일 전체 모양 */
export interface GuardState {
  version: number
  /** 루트 기준 상대 경로 → 지문 */
  leaves: Record<string, LeafFingerprint>
  /** 지시문에 넣는 판 blob 해시(null = 넣지 않음) */
  injected: string | null
  rules: RuleEntry[]
  queryOpen: boolean
  /** 무결성 표식(HMAC hex). 열쇠를 못 쓰면 `''` */
  integrity: string
}

export const STATE_VERSION = 1

/** HMAC 열쇠. Electron `safeStorage`에서 꺼낸 값을 이 모듈은 모른다. */
export type GuardKey = Buffer | null

export type IntegrityState = 'ok' | 'missing' | 'mismatch' | 'no-key'

export function defaultState(): GuardState {
  return { version: STATE_VERSION, leaves: {}, injected: null, rules: [], queryOpen: false, integrity: '' }
}

export function guardDir(userData: string, folderHash: string): string {
  return join(userData, 'guard', folderHash)
}

export function statePath(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'state.json')
}

export function pendingPath(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'pending.json')
}

export function blobsDir(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'blobs')
}

export function sentPath(userData: string, folderHash: string): string {
  return join(guardDir(userData, folderHash), 'sent.jsonl')
}

/** 격리 자리(논문 폴더 안). 격리 폴더는 스캔에서 빠지므로 새 보호 항목을 만들지 않는다. */
export function quarantineDir(rootReal: string, timestamp: number): string {
  return join(rootReal, '.knuaf-gui', 'quarantine', String(timestamp))
}

/** 키 순서를 고정한 JSON — 같은 상태는 언제나 같은 글자, 따라서 같은 표식. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
}

function hmac(key: GuardKey, text: string): string {
  if (!key) return ''
  return createHmac('sha256', key).update(text).digest('hex')
}

/** 상태의 표식. `integrity`를 뺀 나머지 전체를 덮는다. */
export function computeIntegrity(state: Omit<GuardState, 'integrity'>, key: GuardKey): string {
  const { integrity: _ignored, ...rest } = state as GuardState
  return hmac(key, canonical(rest))
}

export interface LoadedState {
  state: GuardState
  integrity: IntegrityState
}

/** 상태 파일 로드. 표식이 안 맞아도 상태는 돌려준다 — 부르는 쪽이 기능을 끈다. */
export function loadState(userData: string, folderHash: string, key: GuardKey): LoadedState {
  const path = statePath(userData, folderHash)
  if (!existsSync(path)) return { state: defaultState(), integrity: 'missing' }
  let parsed: Partial<GuardState>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GuardState>
  } catch {
    return { state: defaultState(), integrity: 'mismatch' }
  }
  const state: GuardState = {
    version: typeof parsed.version === 'number' ? parsed.version : STATE_VERSION,
    leaves: parsed.leaves && typeof parsed.leaves === 'object' ? parsed.leaves : {},
    injected: typeof parsed.injected === 'string' ? parsed.injected : null,
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    queryOpen: Boolean(parsed.queryOpen),
    integrity: typeof parsed.integrity === 'string' ? parsed.integrity : ''
  }
  if (!key) return { state, integrity: 'no-key' }
  const expected = computeIntegrity(state, key)
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(state.integrity, 'utf-8')
  const ok = a.length === b.length && timingSafeEqual(a, b)
  return { state, integrity: ok ? 'ok' : 'mismatch' }
}

/** 상태 저장(임시 파일 → 이름 바꾸기). 성공해야 true. */
export function saveState(userData: string, folderHash: string, state: Omit<GuardState, 'integrity'>, key: GuardKey): boolean {
  const dir = guardDir(userData, folderHash)
  const full: GuardState = { ...state, integrity: computeIntegrity(state, key) }
  const payload = JSON.stringify(full, null, 2)
  const target = statePath(userData, folderHash)
  try {
    mkdirSync(dir, { recursive: true })
    return atomicWrite(target, payload)
  } catch {
    return false
  }
}

/** 임시 파일 → 이름 바꾸기. `renameWithRetry`는 윈도우에서 잠깐 열린 파일을 넘긴다. */
export function atomicWrite(target: string, data: string | Buffer): boolean {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, data)
    renameWithRetry(tmp, target)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

/** 윈도우에서 다른 프로그램이 잠깐 잡고 있어도 몇 번 다시 시도한다. */
export function renameWithRetry(from: string, to: string, attempts = 5): void {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break
      const until = Date.now() + 20
      while (Date.now() < until) { /* 짧은 대기 */ }
    }
  }
  throw last
}

/** blob 저장(내용 주소). 같은 내용은 한 번만 쓴다. */
export function putBlob(userData: string, folderHash: string, content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
  const hash = createHash('sha256').update(buf).digest('hex')
  const path = join(blobsDir(userData, folderHash), hash)
  if (!existsSync(path)) {
    mkdirSync(blobsDir(userData, folderHash), { recursive: true })
    if (!atomicWrite(path, buf)) throw new Error(`blob을 쓰지 못했습니다: ${hash}`)
  }
  return hash
}

export function getBlob(userData: string, folderHash: string, hash: string): Buffer | null {
  if (!hash) return null
  try {
    return readFileSync(join(blobsDir(userData, folderHash), hash))
  } catch {
    return null
  }
}

export function hasBlob(userData: string, folderHash: string, hash: string): boolean {
  return existsSync(join(blobsDir(userData, folderHash), hash))
}

/** 잎 지문이 가리키는 원본 내용. 파일은 내용, 링크는 `link:<대상>` — blob 키와 해시가 같다. */
export function leafContent(rootReal: string, rel: string, fingerprint: LeafFingerprint): Buffer | null {
  const abs = join(rootReal, rel.split('/').join(sep))
  if (!isInside(rootReal, abs) || abs === rootReal) return null
  try {
    if (fingerprint.kind === 'link') return Buffer.from('link:' + readlinkSync(abs), 'utf-8')
    return readFileSync(abs)
  } catch {
    return null
  }
}

export interface AdoptResult {
  leaves: Record<string, LeafFingerprint>
  /** blob을 만들지 못한 잎 */
  failed: string[]
}

/** 지문들을 보관본에 올린다(원본 내용을 blob으로). 이 뒤부터 되돌릴 수 있다. */
export function adoptLeaves(
  rootReal: string,
  userData: string,
  folderHash: string,
  leaves: Map<string, LeafFingerprint>
): AdoptResult {
  const stored: Record<string, LeafFingerprint> = {}
  const failed: string[] = []
  for (const [rel, fingerprint] of leaves) {
    const content = leafContent(rootReal, rel, fingerprint)
    if (!content) { failed.push(rel); continue }
    try {
      const hash = putBlob(userData, folderHash, content)
      stored[rel] = { ...fingerprint, hash }
    } catch {
      failed.push(rel)
    }
  }
  return { leaves: stored, failed }
}

/** 잎 하나를 보관본 내용으로 되돌린다. 파일이면 원자 쓰기, 링크면 다시 건다. */
export function restoreLeaf(
  rootReal: string,
  userData: string,
  folderHash: string,
  rel: string,
  fingerprint: LeafFingerprint
): boolean {
  const abs = join(rootReal, rel.split('/').join(sep))
  if (!isInside(rootReal, abs) || abs === rootReal) return false
  const blob = getBlob(userData, folderHash, fingerprint.hash)
  if (!blob) return false
  try {
    mkdirSync(dirname(abs), { recursive: true })
    removeIfPresent(abs)
    if (fingerprint.kind === 'link') {
      const text = blob.toString('utf-8')
      symlinkSync(text.startsWith('link:') ? text.slice(5) : text, abs)
      return true
    }
    if (!atomicWrite(abs, blob)) return false
    if (process.platform !== 'win32') chmodSync(abs, fingerprint.executable ? 0o755 : 0o644)
    return true
  } catch {
    return false
  }
}

/** 보관본에 없던 잎(= 도우미가 새로 만든 것)을 지운다. */
export function removeLeaf(rootReal: string, rel: string): boolean {
  const abs = join(rootReal, rel.split('/').join(sep))
  if (!isInside(rootReal, abs) || abs === rootReal) return false
  return removeIfPresent(abs)
}

function removeIfPresent(abs: string): boolean {
  try {
    const st = lstatSync(abs)
    if (st.isDirectory() && !st.isSymbolicLink()) return false
    unlinkSync(abs)
    return true
  } catch {
    return false
  }
}

/** 지금 파일을 격리로 옮긴다. 같은 볼륨이면 rename, 아니면 복사·확인·삭제. */
export function quarantineLeaf(rootReal: string, rel: string, timestamp: number): string | null {
  const abs = join(rootReal, rel.split('/').join(sep))
  if (!isInside(rootReal, abs) || abs === rootReal) return null
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return null
  }
  if (st.isDirectory() && !st.isSymbolicLink()) return null

  const base = quarantineDir(rootReal, timestamp)
  const blobs = join(base, 'blobs')
  try {
    mkdirSync(blobs, { recursive: true })
    const content = st.isSymbolicLink() ? Buffer.from('link:' + readlinkSync(abs), 'utf-8') : readFileSync(abs)
    const hash = createHash('sha256').update(content).digest('hex')
    const stored = join(blobs, hash)
    if (!existsSync(stored)) writeFileSync(stored, content)
    const indexPath = join(base, 'index.json')
    let index: Array<{ originalPath: string; blobHash: string; kind: string; linkTarget?: string }> = []
    if (existsSync(indexPath)) {
      try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch { index = [] }
    }
    index.push({
      originalPath: rel,
      blobHash: hash,
      kind: st.isSymbolicLink() ? 'link' : 'file',
      ...(st.isSymbolicLink() ? { linkTarget: readlinkSync(abs) } : {})
    })
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    unlinkSync(abs)
    return stored
  } catch {
    return null
  }
}

/** `.claude` 조각 아래의 **빈** 폴더만 지운다. `.claude` 자신은 남긴다. */
export function cleanupEmptyClaudeDirs(rootReal: string): string[] {
  const cleaned: string[] = []
  const claudeDir = join(rootReal, '.claude')
  const clean = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const child = join(dir, name)
      try {
        if (lstatSync(child).isDirectory()) clean(child)
      } catch { /* ignore */ }
    }
    if (dir === claudeDir) return
    try {
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir)
        cleaned.push(dir)
      }
    } catch { /* ignore */ }
  }
  clean(claudeDir)
  return cleaned
}

/** 전송 장부 한 줄. 표식은 줄 전체를 덮는다 — 손으로 고친 줄은 읽을 때 걸린다. */
export interface SentEntry {
  id: string
  folder: string
  provider: 'claude' | 'codex'
  convId: string
  /** 학생이 보낸 글자 그대로 */
  text: string
  timestamp: number
  hmac?: string
}

function sentCanonical(entry: Omit<SentEntry, 'hmac'>): string {
  return canonical({ id: entry.id, folder: entry.folder, provider: entry.provider, convId: entry.convId, text: entry.text, timestamp: entry.timestamp })
}

export function appendSentLog(
  userData: string,
  folderHash: string,
  entry: Omit<SentEntry, 'timestamp' | 'hmac'> & { timestamp?: number },
  key: GuardKey
): boolean {
  const target = sentPath(userData, folderHash)
  try {
    mkdirSync(dirname(target), { recursive: true })
    const full: Omit<SentEntry, 'hmac'> = { ...entry, timestamp: entry.timestamp ?? Date.now() }
    const line = JSON.stringify({ ...full, hmac: hmac(key, sentCanonical(full)) })
    appendFileSync(target, line + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

export interface SentLedger {
  entries: SentEntry[]
  integrityOk: boolean
}

/** 장부 읽기 + 줄마다 표식 확인. 한 줄이라도 안 맞으면 `integrityOk=false`(기능 끔). */
export function readSentLog(userData: string, folderHash: string, key: GuardKey): SentLedger {
  const target = sentPath(userData, folderHash)
  if (!existsSync(target)) return { entries: [], integrityOk: true }
  let text: string
  try {
    text = readFileSync(target, 'utf-8')
  } catch {
    return { entries: [], integrityOk: false }
  }
  if (!key) return { entries: [], integrityOk: false }
  const entries: SentEntry[] = []
  let integrityOk = true
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: SentEntry
    try {
      parsed = JSON.parse(line) as SentEntry
    } catch {
      integrityOk = false
      continue
    }
    const { hmac: tag = '', ...rest } = parsed
    const expected = hmac(key, sentCanonical(rest))
    const a = Buffer.from(expected, 'utf-8')
    const b = Buffer.from(tag, 'utf-8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) { integrityOk = false; continue }
    entries.push(rest)
  }
  return { entries, integrityOk }
}

/** 전송 장부에서 학생 메시지 하나 — 단추의 유일한 출처(§11.8 '메시지 출처'). */
export function findSentEntry(userData: string, folderHash: string, id: string, key: GuardKey): SentEntry | null {
  const ledger = readSentLog(userData, folderHash, key)
  if (!ledger.integrityOk) return null
  return ledger.entries.find((entry) => entry.id === id) ?? null
}

/** 넣기·저장을 켤 수 있는가. 열쇠를 못 쓰거나 표식이 틀리면 끈다(§11.8 '보관본 지키기'). */
export function injectionsEnabled(integrity: IntegrityState, ledger: SentLedger['integrityOk']): boolean {
  return integrity !== 'no-key' && integrity !== 'mismatch' && ledger
}

// ── 루트 CLAUDE.md 읽기·쓰기 ───────────────────────────────────────────────

export type ClaudeMdRead =
  | { state: 'missing' }
  | { state: 'link'; target: string }
  | { state: 'file'; content: Buffer }

export function readClaudeMd(rootReal: string): ClaudeMdRead {
  const abs = join(rootReal, 'CLAUDE.md')
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return { state: 'missing' }
  }
  if (st.isSymbolicLink()) {
    try {
      return { state: 'link', target: readlinkSync(abs) }
    } catch {
      return { state: 'link', target: '' }
    }
  }
  if (!st.isFile()) return { state: 'missing' }
  try {
    return { state: 'file', content: readFileSync(abs) }
  } catch {
    return { state: 'missing' }
  }
}

/**
 * 주입 재료 — 보관본의 **보통 파일**일 때만 돌려준다(§11.6-5).
 * 링크·폴더·없음이면 null이다. 링크는 대상 문자열을 보관본에 담으므로 그대로 넣으면
 * `link:/어딘가`라는 가짜 내용이 지시문에 들어간다.
 */
export function injectedClaudeMd(state: GuardState, userData: string, folderHash: string): Buffer | null {
  if (state.leaves['CLAUDE.md']?.kind !== 'file') return null
  return state.injected ? getBlob(userData, folderHash, state.injected) : null
}

/** 루트 CLAUDE.md를 원자 교체한다. 실행 권한 비트는 지금 파일 것을 따른다. */
export function writeClaudeMd(rootReal: string, content: string): boolean {
  const abs = join(rootReal, 'CLAUDE.md')
  let mode: number | null = null
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return false
    if (st.isFile()) mode = st.mode & 0o777
  } catch { /* 없는 파일이면 새로 만든다 */ }
  if (!atomicWrite(abs, content)) return false
  if (mode !== null && process.platform !== 'win32') {
    try { chmodSync(abs, mode) } catch { /* ignore */ }
  }
  return true
}

// ── 앱이 쓰는 도중 쪽지 ────────────────────────────────────────────────────

export function writePending(userData: string, folderHash: string, note: PendingAppWrite): boolean {
  return atomicWrite(pendingPath(userData, folderHash), JSON.stringify(note, null, 2))
}

export function readPending(userData: string, folderHash: string): PendingAppWrite | null {
  const path = pendingPath(userData, folderHash)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PendingAppWrite
    if (typeof parsed.nextHash !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function clearPending(userData: string, folderHash: string): void {
  try { unlinkSync(pendingPath(userData, folderHash)) } catch { /* 없는 편이 정상 */ }
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')).digest('hex')
}

// ── 앱이 규칙을 쓰는 순서 (§11.8 '앱이 쓰는 순서' 1~8) ─────────────────────

export interface RuleMutation {
  success: boolean
  newContent: string
  message: string
  sectionCreated: boolean
  errors: string[]
}

export interface RuleWriteOutcome {
  success: boolean
  message: string
  errors: string[]
  /** 저장했을 때의 새 파일 전문 */
  newContent: string
  /** 저장했을 때의 새 상태(호출자가 화면·다음 질의에 쓴다) */
  state: GuardState
  /** 디스크가 보관본과 달라 되돌린 뒤 저장했는가 */
  cleanedDisk: boolean
  /** 질의 밖 학생 변경을 먼저 받아들였는가 */
  acceptedStudentChange: boolean
  notes: string[]
}

function leafFor(rootReal: string): LeafFingerprint | null {
  return fingerprintLeaf(join(rootReal, 'CLAUDE.md'))
}

/**
 * 앱이 구획을 고치는 유일한 길. **디스크의 현재 파일을 재료로 쓰지 않는다** —
 * 보관본(blob)의 내용에 학생이 고른 변경 하나만 적용한다(§11.8).
 *
 * 부르는 쪽이 `withGuardLock`을 이미 잡았어야 한다. 제한(중복·개수·32KB·구획 모양)은
 * `mutate`가 다시 확인한다(1번).
 */
export function applyRuleChange(opts: {
  rootReal: string
  userData: string
  folderHash: string
  key: GuardKey
  state: GuardState
  action: 'add' | 'remove'
  mutate: (baseline: string) => RuleMutation
  /** 넣는 판을 읽는 쪽이 ALREADY 쓸 것인가 — 여기서는 상태만 갱신한다 */
  now?: number
}): RuleWriteOutcome {
  const { rootReal, userData, folderHash, key, state } = opts
  const now = opts.now ?? Date.now()
  const notes: string[] = []
  const base: RuleWriteOutcome = {
    success: false,
    message: '',
    errors: [],
    newContent: '',
    state,
    cleanedDisk: false,
    acceptedStudentChange: false,
    notes
  }

  const disk = readClaudeMd(rootReal)
  if (disk.state === 'link') {
    return { ...base, message: 'CLAUDE.md가 링크라서 규칙을 저장할 수 없어요. 보통 파일로 바꿔 주세요.' }
  }
  const diskText = disk.state === 'file' ? disk.content.toString('utf-8') : ''
  const diskHash = disk.state === 'file' ? hashContent(disk.content) : null
  const storedBlob = state.injected ? getBlob(userData, folderHash, state.injected) : null
  let baseline = storedBlob ? storedBlob.toString('utf-8') : diskText
  const baselineHash = storedBlob ? state.injected : diskHash
  let cleanedDisk = false
  let acceptedStudentChange = false

  // 2번 — 디스크와 보관본 대조
  if (diskHash !== baselineHash) {
    if (state.queryOpen) {
      // 도우미가 건드린 것으로 보고 먼저 정리한다(격리 → 보관본 복원).
      quarantineLeaf(rootReal, 'CLAUDE.md', now)
      if (storedBlob) writeClaudeMd(rootReal, baseline)
      else {
        try { unlinkSync(join(rootReal, 'CLAUDE.md')) } catch { /* ignore */ }
      }
      cleanedDisk = true
      notes.push('도우미가 고친 CLAUDE.md를 되돌린 뒤 저장했어요.')
      const again = readClaudeMd(rootReal)
      const againHash = again.state === 'file' ? hashContent(again.content) : null
      if (againHash !== baselineHash) {
        return { ...base, cleanedDisk, message: '지금은 저장하지 못했어요. 도우미가 끝난 뒤 다시 눌러 주세요' }
      }
    } else {
      // 질의 밖 학생 변경 — 받아들인 뒤 그 내용에 변경을 얹는다.
      baseline = diskText
      acceptedStudentChange = true
      notes.push('CLAUDE.md가 바뀌어 있어요. 그대로 두고 새 규칙을 더했어요.')
    }
  }

  const mutation = opts.mutate(baseline)
  if (!mutation.success) {
    return { ...base, message: mutation.message, errors: mutation.errors, cleanedDisk, acceptedStudentChange }
  }

  const nextText = mutation.newContent
  // 4번 — 쓰는 중 쪽지(이전 지문·새 지문). 지문은 내용에서 바로 나오므로 blob보다 먼저 적을 수 있다.
  const nextHash = createHash('sha256').update(Buffer.from(nextText, 'utf-8')).digest('hex')
  writePending(userData, folderHash, {
    action: opts.action,
    previousHash: baselineHash,
    nextHash,
    at: now
  })

  // 5번 — 새 내용을 blob으로 쓰고 확인한다.
  try {
    putBlob(userData, folderHash, nextText)
  } catch {
    clearPending(userData, folderHash)
    return { ...base, message: '규칙을 저장하지 못했어요.', errors: ['보관본에 쓰지 못했습니다.'], cleanedDisk, acceptedStudentChange }
  }

  // 6번 — 파일 교체
  if (!writeClaudeMd(rootReal, nextText)) {
    clearPending(userData, folderHash)
    return { ...base, message: '규칙을 저장하지 못했어요. 파일이 다른 프로그램에 열려 있는지 확인해 주세요.', errors: ['CLAUDE.md를 쓰지 못했습니다.'], cleanedDisk, acceptedStudentChange }
  }

  // 7번 — 상태 파일 하나 교체. 여기가 저장 성공 시점이다.
  const leaves = { ...state.leaves }
  const leaf = leafFor(rootReal)
  if (leaf) leaves['CLAUDE.md'] = leaf
  else delete leaves['CLAUDE.md']
  const nextState: GuardState = { ...state, leaves, injected: nextHash, integrity: '' }
  const { integrity: _drop, ...withoutIntegrity } = nextState
  const saved = saveState(userData, folderHash, withoutIntegrity, key)
  if (!saved) {
    // 쪽지를 남긴다 — 다음 실행의 복구 ②가 7번을 마저 한다(디스크는 이미 새 내용이다).
    return { ...base, message: '규칙을 저장하지 못했어요.', errors: ['보관본을 쓰지 못했습니다.'], cleanedDisk, acceptedStudentChange, newContent: nextText }
  }
  // 8번 — 쪽지를 지운다.
  clearPending(userData, folderHash)
  const loaded = loadState(userData, folderHash, key).state
  return {
    success: true,
    message: mutation.message,
    errors: [],
    newContent: nextText,
    state: loaded,
    cleanedDisk,
    acceptedStudentChange,
    notes
  }
}

export interface RecoveryOutcome {
  /** 쪽지가 있었는가 */
  hadPending: boolean
  success: boolean
  message: string
  state: GuardState
}

/**
 * '도중에 죽었을 때' 복구 표 네 갈래(§11.8). 다음 실행·다음 T0에서 부른다.
 * 디스크를 덮어쓰지 않는 갈래에서는 **절대 쓰지 않는다**.
 */
export function recoverPending(opts: {
  rootReal: string
  userData: string
  folderHash: string
  key: GuardKey
  state: GuardState
}): RecoveryOutcome {
  const { rootReal, userData, folderHash, key, state } = opts
  const pending = readPending(userData, folderHash)
  if (!pending) return { hadPending: false, success: false, message: '', state }

  const disk = readClaudeMd(rootReal)
  const diskHash = disk.state === 'file' ? hashContent(disk.content) : null
  const finish = (nextState: GuardState, success: boolean, message: string): RecoveryOutcome => {
    clearPending(userData, folderHash)
    return { hadPending: true, success, message, state: nextState }
  }

  // ① 상태 파일이 이미 새 지문 — 성공, 쪽지만 지운다.
  if (state.injected === pending.nextHash) return finish(state, true, '규칙을 저장했어요.')

  // ② 디스크가 새 지문 — 7번을 마저 한다.
  if (diskHash === pending.nextHash) {
    const leaves = { ...state.leaves }
    const leaf = leafFor(rootReal)
    if (leaf) leaves['CLAUDE.md'] = leaf
    const nextState: GuardState = { ...state, leaves, injected: pending.nextHash, integrity: '' }
    const { integrity: _drop, ...withoutIntegrity } = nextState
    const saved = saveState(userData, folderHash, withoutIntegrity, key)
    return finish(saved ? loadState(userData, folderHash, key).state : state, saved, saved ? '규칙을 저장했어요.' : '규칙을 저장하지 못했어요.')
  }

  // ③ 디스크가 이전 지문 — 저장되지 않은 것으로 닫는다.
  if (diskHash === pending.previousHash) return finish(state, false, '규칙을 저장하지 못했어요.')

  // ④ 둘 다 아님(죽은 뒤 학생이 직접 고침) — 덮어쓰지 않는다.
  return finish(state, false, '규칙을 저장하지 못했어요. 다시 눌러 주세요.')
}
