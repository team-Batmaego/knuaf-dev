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
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fingerprintLeaf, sameFingerprint, type LeafFingerprint } from './scan'
import { isInside } from './scope'
import { mergeRules } from './rules'
import { normalizeRuleText } from './instructions'

/** 루트 규칙 파일의 상대 경로(§11.8). 쪽지·복구가 다루는 잎은 이것 하나뿐이다. */
const CLAUDE_MD_REL = 'CLAUDE.md'

/** 격리 복사 청크(64KB) — 큰 파일도 한 번에 통째로 읽지 않는다. */
const COPY_CHUNK = 64 * 1024

/** 규칙 표 한 줄(파일에는 id를 적지 않는다 — 학생이 보는 파일을 깨끗하게) */
export interface RuleEntry {
  id: string
  /** 학생이 보낸 원문(앞뒤 공백·줄바꿈 변형 전) */
  message: string
  timestamp: number
  /** 파일 구획에 적히는 글자 */
  normalized: string
  /** 그 규칙을 만든 메시지 id(화면 연결용, §16.5.4) */
  messageId?: string
  /** 출처 — `file` = 학생이 파일에 직접 쓴 규칙(§16.5.4 ⓒ). 비어 있으면 앱이 더한 규칙 */
  origin?: string
}

/**
 * 앱이 더한 규칙 하나의 원문·시각(§16.5.4). 쪽지에 적어 두었다가 저장 성공 뒤 표로 옮긴다 —
 * 파일에는 id·시각을 적지 않으므로(§11.8) 이 값이 사라지면 원문·시각을 되찾을 길이 없다.
 * `rules.ts`의 `UpdateResult.rule`과 같은 모양이되 `timestamp`가 반드시 있다.
 */
export interface PendingRule {
  /** `ruleId(normalized)` — 파일 글자 해시 */
  id: string
  /** 학생이 보낸 원문(앞뒤 공백·줄바꿈 변형 전) */
  message: string
  messageId?: string
  timestamp: number
}

/**
 * 앱이 규칙을 쓰는 도중이라는 쪽지(§11.8 '앱이 쓰는 순서' 4~8). 죽으면 이걸 보고 복구한다.
 * 표식(HMAC)은 이전 지문·새 지문·동작·시각·폴더 해시(·규칙 원문)를 덮는다 — 손으로 만든 쪽지는 복구 근거가 못 된다.
 */
export interface PendingAppWrite {
  action: 'add' | 'remove'
  /** 이전 파일 내용 sha256(없던 파일이면 null) */
  previousHash: string | null
  /** 새 파일 내용 sha256 */
  nextHash: string
  at: number
  /** 더하기 때 적어 둔 규칙 원문·시각(§16.5.4 ⓑ). 없으면 파일 글자에서 만든다(ⓒ) */
  rule?: PendingRule
  /** 이 폴더 열쇠로 계산한 표식 */
  integrity?: string
}

/**
 * 보류(H) 잎 하나(§16.5.1). 되돌리기가 끝나지 않아 **보관본에 올리지 않은** 잎이다.
 * 보관본 항목(`leaves[rel]`)은 이전 지문 F 그대로 두고, 디스크는 F가 아니다.
 */
export interface HeldLeaf {
  /** 보류에 들어갈 때 본 디스크 지문(파일이 없었으면 null) */
  hash: string | null
  /** 처음 보류가 된 시각 */
  since: number
  /** 되돌리기 시도 횟수(1 = 첫 실패) */
  tries: number
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
  /** 보류 잎(§16.5.2 ⑦·⑧). 없는 옛 상태 파일은 `{}`로 읽는다 */
  held: Record<string, HeldLeaf>
  /** 무결성 표식(HMAC hex). 열쇠를 못 쓰면 `''` */
  integrity: string
}

export const STATE_VERSION = 1

/** HMAC 열쇠. Electron `safeStorage`에서 꺼낸 값을 이 모듈은 모른다. */
export type GuardKey = Buffer | null

export type IntegrityState = 'ok' | 'missing' | 'mismatch' | 'no-key'

export function defaultState(): GuardState {
  return { version: STATE_VERSION, leaves: {}, injected: null, rules: [], queryOpen: false, held: {}, integrity: '' }
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

/**
 * 상태 파일의 `held`를 읽는다(§16.5.5 1). 없는 옛 파일은 `{}`다.
 * 모양이 어긋난 항목은 버린다 — 보류는 **되돌리기를 다시 시도한다**는 뜻일 뿐이라,
 * 믿을 수 없는 항목을 살려 두면 다음 맞추기가 엉뚱한 잎을 되돌린다.
 */
function readHeld(raw: unknown): Record<string, HeldLeaf> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const held: Record<string, HeldLeaf> = {}
  for (const [rel, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Partial<HeldLeaf>
    if (entry.hash !== null && typeof entry.hash !== 'string') continue
    if (typeof entry.since !== 'number' || typeof entry.tries !== 'number') continue
    held[rel] = { hash: entry.hash, since: entry.since, tries: entry.tries }
  }
  return held
}

/**
 * 상태 파일 로드. 표식이 안 맞아도 상태는 돌려준다 — 부르는 쪽이 기능을 끈다.
 * **열쇠가 없으면 파일 유무보다 먼저 `no-key`** — 첫 실행(파일 없음)도 꺼짐이 기본이다(§4.3).
 */
export function loadState(userData: string, folderHash: string, key: GuardKey): LoadedState {
  if (!key) return { state: defaultState(), integrity: 'no-key' }
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
    held: readHeld(parsed.held),
    integrity: typeof parsed.integrity === 'string' ? parsed.integrity : ''
  }
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

/** 내용의 sha256 — blob 이름·지문과 같은 함수. */
function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * blob 저장(내용 주소). 같은 내용은 한 번만 쓴다.
 * 이미 있는 파일은 **내용을 대조**한다 — 이름과 내용이 다르면 변조이므로 옳은 내용으로 다시 쓴다(§4.3 ②).
 */
export function putBlob(userData: string, folderHash: string, content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
  const hash = sha256(buf)
  const path = join(blobsDir(userData, folderHash), hash)
  let existing: Buffer | null = null
  try {
    existing = readFileSync(path)
  } catch { /* 없는 편이 정상 */ }
  if (!existing || sha256(existing) !== hash) {
    mkdirSync(blobsDir(userData, folderHash), { recursive: true })
    if (!atomicWrite(path, buf)) throw new Error(`blob을 쓰지 못했습니다: ${hash}`)
  }
  return hash
}

/** blob 읽기. **읽을 때마다 내용의 sha256이 이름과 같은지 확인**한다 — 다르면 읽지 않은 것으로 친다. */
export function getBlob(userData: string, folderHash: string, hash: string): Buffer | null {
  if (!hash) return null
  let bytes: Buffer
  try {
    bytes = readFileSync(join(blobsDir(userData, folderHash), hash))
  } catch {
    return null
  }
  return sha256(bytes) === hash ? bytes : null
}

export function hasBlob(userData: string, folderHash: string, hash: string): boolean {
  return getBlob(userData, folderHash, hash) !== null
}

/**
 * 잎 지문이 가리키는 원본 내용. 파일은 내용, 링크는 `link:<대상>` — blob 키와 해시가 같다.
 * 지문과 다른 내용이면 null이다(보관본에 올릴 때도 대조한다).
 */
export function leafContent(rootReal: string, rel: string, fingerprint: LeafFingerprint): Buffer | null {
  const abs = join(rootReal, rel.split('/').join(sep))
  if (!isInside(rootReal, abs) || abs === rootReal) return null
  try {
    if (fingerprint.kind === 'link') {
      const bytes = Buffer.from('link:' + readlinkSync(abs), 'utf-8')
      return sha256(bytes) === fingerprint.hash ? bytes : null
    }
    const bytes = readFileSync(abs)
    return sha256(bytes) === fingerprint.hash ? bytes : null
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

export interface RevertOutcome {
  /** 격리에 남긴 자리(없으면 null) */
  quarantinePath: string | null
  /** 보관본에 있던 잎을 되살렸는가(false = 새로 생긴 잎을 지웠거나 되돌리지 못했다) */
  restoredFromStore: boolean
  /** 되돌린 뒤 실제로 F와 같아졌는가 — false면 그 잎은 보류(H)다(§16.5.2 ③⑥⑨) */
  reverted: boolean
}

/**
 * 잎 하나를 보관본 기준 F로 되돌린다(§16.5.2 '되돌림'). 지금 내용은 격리에 남긴다.
 * **되돌린 뒤 다시 지문을 떠서 F와 같은지 확인**한다 — 확인 없이 성공으로 보지 않는다.
 * `before`가 없으면 F = "없음"이므로 지운다.
 *
 * T2·T0·앱 쓰기(⑦)가 같은 함수를 쓴다 — 되돌림이 한 길이어야 "끝났는가" 판정도 하나다.
 */
export function revertLeafToStore(
  rootReal: string,
  userData: string,
  folderHash: string,
  rel: string,
  before: LeafFingerprint | undefined,
  timestamp: number
): RevertOutcome {
  const quarantinePath = quarantineLeaf(rootReal, rel, timestamp)
  let restoredFromStore = false
  if (before) restoredFromStore = restoreLeaf(rootReal, userData, folderHash, rel, before)
  else removeLeaf(rootReal, rel)
  const abs = join(rootReal, rel.split('/').join(sep))
  const after = fingerprintLeaf(abs) ?? undefined
  // F가 "없음"이면 성공은 "지금도 잎이 아님"이다 — 지웠는지 여부가 아니라 결과를 본다.
  const reverted = before ? sameFingerprint(before, after) : after === undefined
  return { quarantinePath, restoredFromStore, reverted }
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

/** 청크 단위 해시 — 큰 파일에서도 본체가 멈추지 않게(정제 3.6). */
function streamHash(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(COPY_CHUNK)
    for (;;) {
      const read = readSync(fd, buf, 0, COPY_CHUNK, null)
      if (read <= 0) break
      hash.update(buf.subarray(0, read))
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 청크 단위 복사(원본은 그대로) + 해시. 실패면 null. */
function streamCopyAndHash(from: string, to: string): string | null {
  let inFd: number | null = null
  let outFd: number | null = null
  try {
    inFd = openSync(from, 'r')
    outFd = openSync(to, 'w')
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(COPY_CHUNK)
    for (;;) {
      const read = readSync(inFd, buf, 0, COPY_CHUNK, null)
      if (read <= 0) break
      hash.update(buf.subarray(0, read))
      let written = 0
      while (written < read) written += writeSync(outFd, buf, written, read - written)
    }
    closeSync(outFd)
    outFd = null
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (inFd !== null) { try { closeSync(inFd) } catch { /* ignore */ } }
    if (outFd !== null) { try { closeSync(outFd) } catch { /* ignore */ } }
  }
}

/**
 * 지금 파일을 격리로 옮긴다(§4.3 '격리').
 * **같은 볼륨이면 이름 바꾸기가 먼저다** — 읽지도 쓰지도 않고 옮긴다. 안 될 때만
 * 청크 복사 → 지문 확인 → 원본 삭제(큰 파일에서 본체가 멈추지 않게, 정제 3.6).
 * 확인 전에는 원본을 절대 지우지 않는다.
 *
 * `move`는 이름 바꾸기 하나만 갈아 끼우는 자리다 — 볼륨을 넘는 경우(EXDEV)를 시험에서
 * 실제로 돌리기 위한 것이고, 기본값은 윈도우 재시도를 붙인 `renameWithRetry`다.
 */
export function quarantineLeaf(
  rootReal: string,
  rel: string,
  timestamp: number,
  move: (from: string, to: string) => void = renameWithRetry
): string | null {
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
  const incoming = join(blobs, `.incoming-${process.pid}-${randomBytes(6).toString('hex')}`)
  let stored: string | null = null
  let hash: string | null = null
  let linkTarget: string | undefined

  try {
    mkdirSync(blobs, { recursive: true })
    if (st.isSymbolicLink()) {
      // 링크는 "가리키는 문자열"이 항목이다 — 따라가지 않는다.
      linkTarget = readlinkSync(abs)
      const content = Buffer.from('link:' + linkTarget, 'utf-8')
      hash = createHash('sha256').update(content).digest('hex')
      stored = join(blobs, hash)
      if (!existsSync(stored)) writeFileSync(stored, content)
      unlinkSync(abs)
    } else {
      // ① 같은 볼륨 — 이름 바꾸기부터. 읽지 않는다.
      let moved = false
      try {
        move(abs, incoming)
        moved = true
      } catch { /* 볼륨이 다르거나 잠김 — 아래 복사 길로 */ }
      if (moved) {
        hash = streamHash(incoming)
        if (hash) {
          stored = join(blobs, hash)
          if (!existsSync(stored)) renameWithRetry(incoming, stored)
          else unlinkSync(incoming)
        } else {
          // 해시를 못 읽으면 원래 자리로 돌려놓고 포기한다.
          try { renameWithRetry(incoming, abs) } catch { /* ignore */ }
          return null
        }
      } else {
        // ② 다른 볼륨·잠김 — 복사 → 확인 → 삭제.
        const copied = streamCopyAndHash(abs, incoming)
        if (!copied || streamHash(incoming) !== copied) {
          try { unlinkSync(incoming) } catch { /* ignore */ }
          return null
        }
        hash = copied
        stored = join(blobs, hash)
        if (!existsSync(stored)) renameWithRetry(incoming, stored)
        else unlinkSync(incoming)
        unlinkSync(abs)
      }
    }

    const indexPath = join(base, 'index.json')
    let index: Array<{ originalPath: string; blobHash: string; kind: string; linkTarget?: string }> = []
    if (existsSync(indexPath)) {
      try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch { index = [] }
    }
    index.push({
      originalPath: rel,
      blobHash: hash,
      kind: linkTarget !== undefined ? 'link' : 'file',
      ...(linkTarget !== undefined ? { linkTarget } : {})
    })
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    return stored
  } catch {
    try { if (existsSync(incoming)) unlinkSync(incoming) } catch { /* ignore */ }
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

/** 장부 읽기 + 줄마다 표식 확인. **열쇠가 없으면 파일 유무보다 먼저 끈다.** */
export function readSentLog(userData: string, folderHash: string, key: GuardKey): SentLedger {
  if (!key) return { entries: [], integrityOk: false }
  const target = sentPath(userData, folderHash)
  if (!existsSync(target)) return { entries: [], integrityOk: true }
  let text: string
  try {
    text = readFileSync(target, 'utf-8')
  } catch {
    return { entries: [], integrityOk: false }
  }
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

function pendingCanonical(note: Omit<PendingAppWrite, 'integrity'>, folderHash: string): string {
  return canonical({
    action: note.action,
    previousHash: note.previousHash,
    nextHash: note.nextHash,
    at: note.at,
    folder: folderHash,
    // 규칙 원문·시각도 표식 범위 안이다(§16.5.4) — 손으로 고친 쪽지가 원문을 바꾸지 못한다.
    ...(note.rule ? { rule: note.rule } : {})
  })
}

/**
 * 쪽지를 쓴다. 표식은 이 폴더 열쇠로 계산한다 — 열쇠가 없으면 쓰지 않는다(false).
 * 쪽지는 복구의 유일한 근거라 **실패를 부르는 쪽이 반드시 확인해야 한다**(§11.8 4번).
 */
export function writePending(
  userData: string,
  folderHash: string,
  note: PendingAppWrite,
  key: GuardKey
): boolean {
  if (!key) return false
  const { integrity: _i, ...rest } = note
  const full: PendingAppWrite = { ...rest, integrity: hmac(key, pendingCanonical(rest, folderHash)) }
  return atomicWrite(pendingPath(userData, folderHash), JSON.stringify(full, null, 2))
}

/** 쪽지의 규칙 항목 모양(§16.5.4). 표식이 맞아도 모양이 어긋나면 복구 근거로 쓰지 않는다. */
function isPendingRule(value: unknown): value is PendingRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rule = value as Partial<PendingRule>
  if (typeof rule.id !== 'string' || typeof rule.message !== 'string') return false
  if (typeof rule.timestamp !== 'number') return false
  return rule.messageId === undefined || typeof rule.messageId === 'string'
}

/** 쪽지를 읽는다. 표식이 없거나 안 맞으면 **지우고** null — 그 쪽지로는 아무것도 하지 않는다. */
export function readPending(userData: string, folderHash: string, key: GuardKey): PendingAppWrite | null {
  const path = pendingPath(userData, folderHash)
  if (!existsSync(path)) return null
  const reject = (): null => {
    clearPending(userData, folderHash)
    return null
  }
  if (!key) return reject()
  let parsed: PendingAppWrite
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as PendingAppWrite
  } catch {
    return reject()
  }
  if (typeof parsed.nextHash !== 'string' || typeof parsed.integrity !== 'string') return reject()
  if (parsed.rule !== undefined && !isPendingRule(parsed.rule)) return reject()
  const { integrity: tag, ...rest } = parsed
  const expected = hmac(key, pendingCanonical(rest, folderHash))
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(tag, 'utf-8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject()
  return rest
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
  /** 더하기 성공 시 그 규칙의 원문·시각(§16.5.4 ⓑ). 없으면 파일 글자에서 만든다(ⓒ) */
  rule?: PendingRule
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
 * 엄격한 UTF-8 해석. 치환 문자로 바꾸지 않고 실패하면 null(§11.3-10·§11.8 3번).
 * 잘못된 바이트를 살려서 저장하면 학생 파일이 조용히 망가진다.
 */
export function decodeStrict(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * `addRuleToContent`가 돌려준 규칙 항목 → 쪽지에 적을 모양(§16.5.4 ⓑ).
 * 더하기가 아니거나 실패면 없다. `timestamp`가 비면 이 교체의 시각을 쓴다 — 시각 0은 없다.
 */
function pendingRuleFrom(rule: PendingRule | undefined, now: number): PendingRule | undefined {
  if (!rule) return undefined
  return {
    id: rule.id,
    message: rule.message,
    ...(rule.messageId === undefined ? {} : { messageId: rule.messageId }),
    timestamp: typeof rule.timestamp === 'number' ? rule.timestamp : now
  }
}

/** 쪽지 항목 → 규칙 표 한 줄. 정규 글자는 표의 다른 줄과 같은 규칙으로 만든다. */
function entryFromRule(rule: PendingRule, now: number): RuleEntry {
  return {
    id: rule.id,
    message: rule.message,
    timestamp: typeof rule.timestamp === 'number' ? rule.timestamp : now,
    normalized: normalizeRuleText(rule.message),
    ...(rule.messageId === undefined ? {} : { messageId: rule.messageId })
  }
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

  // 열쇠가 없으면 아무것도 쓰지 않는다 — 표식 없는 보관본은 믿을 수 없다(§4.3 기본값 끔).
  if (!key) return { ...base, message: '지금은 규칙을 저장할 수 없어요. 앱을 다시 열어 주세요.' }

  const disk = readClaudeMd(rootReal)
  if (disk.state === 'link') {
    return { ...base, message: 'CLAUDE.md가 링크라서 규칙을 저장할 수 없어요. 보통 파일로 바꿔 주세요.' }
  }
  const diskBytes = disk.state === 'file' ? disk.content : null
  const diskHash = diskBytes ? hashContent(diskBytes) : null

  // 2번 — 보관본이 기준이다. 없음(null)이면 "파일 없음"이 기준이고, 있어야 할 blob이
  // 없거나 지문이 안 맞으면 디스크로 대신하지 않고 실패한다(§16 차단 1·2).
  let baseline: string
  let baselineHash: string | null
  if (state.injected === null) {
    baseline = ''
    baselineHash = null
  } else {
    const storedBlob = getBlob(userData, folderHash, state.injected)
    if (!storedBlob) {
      return { ...base, message: '지금은 저장하지 못했어요. 보관본이 손상돼 있어요.' }
    }
    const decoded = decodeStrict(storedBlob)
    if (decoded === null) {
      return { ...base, message: '지금은 저장하지 못했어요. CLAUDE.md가 올바른 UTF-8이 아니에요.' }
    }
    baseline = decoded
    baselineHash = state.injected
  }

  let cleanedDisk = false
  let acceptedStudentChange = false

  if (diskHash !== baselineHash) {
    if (state.queryOpen) {
      // 도우미가 건드린 것으로 보고 먼저 정리한다(격리 → 보관본 복원).
      quarantineLeaf(rootReal, 'CLAUDE.md', now)
      if (baselineHash === null) {
        try { unlinkSync(join(rootReal, 'CLAUDE.md')) } catch { /* ignore */ }
      } else {
        writeClaudeMd(rootReal, baseline)
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
      if (diskBytes === null) {
        baseline = ''
      } else {
        const decoded = decodeStrict(diskBytes)
        if (decoded === null) {
          return { ...base, message: '지금은 저장하지 못했어요. CLAUDE.md가 올바른 UTF-8이 아니에요.' }
        }
        baseline = decoded
      }
      acceptedStudentChange = true
      notes.push('CLAUDE.md가 바뀌어 있어요. 그대로 두고 새 규칙을 더했어요.')
    }
  }

  const mutation = opts.mutate(baseline)
  if (!mutation.success) {
    return { ...base, message: mutation.message, errors: mutation.errors, cleanedDisk, acceptedStudentChange }
  }

  const nextText = mutation.newContent
  const nextBytes = Buffer.from(nextText, 'utf-8')
  const nextHash = hashContent(nextBytes)

  // 4번 — 쓰는 중 쪽지(이전 지문·새 지문·**더한 규칙의 원문·시각**·표식).
  // **못 쓰면 여기서 멈춘다** — 쪽지가 없으면 강제 종료 때 복구할 근거가 없어 파일을 바꿔서는
  // 안 된다(§11.8 4번). 원문·시각이 보존되는 자리는 저장 성공 전에는 이 쪽지뿐이다(§16.5.4).
  const draft = pendingRuleFrom(mutation.rule, now)
  const wrote = writePending(
    userData,
    folderHash,
    { action: opts.action, previousHash: baselineHash, nextHash, at: now, ...(draft ? { rule: draft } : {}) },
    key
  )
  if (!wrote) {
    return { ...base, message: '규칙을 저장하지 못했어요.', errors: ['쓰는 중 표시를 남기지 못했습니다.'], cleanedDisk, acceptedStudentChange }
  }

  // 5번 — 새 내용을 blob으로 쓰고 확인한다.
  try {
    putBlob(userData, folderHash, nextBytes)
  } catch {
    clearPending(userData, folderHash)
    return { ...base, message: '규칙을 저장하지 못했어요.', errors: ['보관본에 쓰지 못했습니다.'], cleanedDisk, acceptedStudentChange }
  }

  // 6번 — 파일 교체
  if (!writeClaudeMd(rootReal, nextText)) {
    clearPending(userData, folderHash)
    return { ...base, message: '규칙을 저장하지 못했어요. 파일이 다른 프로그램에 열려 있는지 확인해 주세요.', errors: ['CLAUDE.md를 쓰지 못했습니다.'], cleanedDisk, acceptedStudentChange }
  }

  // 7번 — 상태 파일 하나 교체(잎 목록·`injected`·**규칙 표**가 함께). 여기가 저장 성공 시점이다.
  const leaves = { ...state.leaves }
  const leaf = leafFor(rootReal)
  if (leaf) leaves['CLAUDE.md'] = leaf
  else delete leaves['CLAUDE.md']
  const nextState: GuardState = {
    ...state,
    leaves,
    injected: nextHash,
    rules: mergeRules(nextText, state.rules, draft ? entryFromRule(draft, now) : undefined, now),
    held: { ...state.held },
    integrity: ''
  }
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
  /**
   * 복구 ④가 "학생 변경"으로 받아들인 잎(§16.5.3). 바로 이어지는 T0가 `queryOpen`을 이유로
   * 되돌리지 않게 넘긴다. **`queryOpen`은 이 상태에서 바꾸지 않는다** — 내리면 같은 질의에서
   * 바뀐 다른 보호 파일까지 다음 T0가 학생 변경으로 받아들인다(2회째 I1).
   */
  acceptedLeaves: string[]
  /** 그 수용 집합의 지문(§16.5.3) — 디스크 지문이 여기 값과 같을 때만 ④다. 다르면 ③(되돌림). */
  acceptedHashes: Record<string, string>
}

/**
 * '도중에 죽었을 때' 복구 표 네 갈래(§11.8). 다음 실행·다음 T0에서 부른다.
 * 디스크를 덮어쓰지 않는 갈래에서는 **절대 쓰지 않는다**.
 * 어느 갈래도 `queryOpen`을 건드리지 않는다(§16.5.1).
 */
export function recoverPending(opts: {
  rootReal: string
  userData: string
  folderHash: string
  key: GuardKey
  state: GuardState
  now?: number
}): RecoveryOutcome {
  const { rootReal, userData, folderHash, key, state } = opts
  const now = opts.now ?? Date.now()
  const idle: RecoveryOutcome = { hadPending: false, success: false, message: '', state, acceptedLeaves: [], acceptedHashes: {} }
  // 표식 없는 쪽지로는 아무것도 하지 않는다(readPending이 지운다).
  const pending = readPending(userData, folderHash, key)
  if (!pending) return idle

  const disk = readClaudeMd(rootReal)
  const diskHash = disk.state === 'file' ? hashContent(disk.content) : null

  // ① 상태 파일이 이미 새 지문 — 성공, 쪽지만 지운다.
  if (state.injected === pending.nextHash) {
    clearPending(userData, folderHash)
    return { ...idle, hadPending: true, success: true, message: '규칙을 저장했어요.' }
  }

  // ③ 디스크가 이전 지문 — 저장되지 않은 것으로 닫는다.
  const finishFailed = (message: string): RecoveryOutcome => {
    clearPending(userData, folderHash)
    return { ...idle, hadPending: true, success: false, message }
  }

  // ② 디스크가 새 지문 — 7번을 마저 한다. **새 blob의 글자 지문까지** 확인하고, 없거나
  // 지문이 안 맞으면 디스크 내용으로 다시 만든다(§16.5.5 4). 디스크가 곧 그 내용이므로
  // blob을 다시 쓰는 것은 디스크를 믿는다는 뜻이 아니라 **이름과 내용을 맞춘다**는 뜻이다.
  if (pending.nextHash && diskHash === pending.nextHash) {
    if (!hasBlob(userData, folderHash, pending.nextHash)) {
      if (disk.state !== 'file') return finishFailed('규칙을 저장하지 못했어요.')
      try {
        putBlob(userData, folderHash, disk.content)
      } catch {
        return finishFailed('규칙을 저장하지 못했어요.')
      }
      if (!hasBlob(userData, folderHash, pending.nextHash)) return finishFailed('규칙을 저장하지 못했어요.')
    }
    return finishCommitted({ rootReal, userData, folderHash, key, state, pending, now, idle })
  }

  // ③ 디스크가 이전 지문 — 저장되지 않은 것으로 닫는다.
  if (diskHash === pending.previousHash) return finishFailed('규칙을 저장하지 못했어요.')

  // ④ 둘 다 아님(죽은 뒤 학생이 직접 고침) — 덮어쓰지 않고 학생 변경으로 받아들인다.
  // 집합은 **루트 CLAUDE.md 하나뿐**이다(쪽지가 생기는 파일이 그것뿐, §16.5.3).
  // `queryOpen`은 그대로 둔다 — 이 질의의 다른 잎은 T0에서 ③(되돌림)을 탄다.
  clearPending(userData, folderHash)
  return {
    hadPending: true,
    success: false,
    message: '규칙을 저장하지 못했어요. 다시 눌러 주세요.',
    state,
    acceptedLeaves: diskHash ? [CLAUDE_MD_REL] : [],
    acceptedHashes: diskHash ? { [CLAUDE_MD_REL]: diskHash } : {}
  }
}

/** 복구 ②의 7번 — 잎·`injected`·규칙 표를 **한 상태 교체**로 쓴다(§11.8 7번, §16.5.4). */
function finishCommitted(opts: {
  rootReal: string
  userData: string
  folderHash: string
  key: GuardKey
  state: GuardState
  pending: PendingAppWrite
  now: number
  idle: RecoveryOutcome
}): RecoveryOutcome {
  const { rootReal, userData, folderHash, key, state, pending, now, idle } = opts
  const leaves = { ...state.leaves }
  const leaf = leafFor(rootReal)
  if (leaf) leaves[CLAUDE_MD_REL] = leaf
  else delete leaves[CLAUDE_MD_REL]
  const blob = getBlob(userData, folderHash, pending.nextHash)
  const text = blob ? decodeStrict(blob) : null
  const nextState: GuardState = {
    ...state,
    leaves,
    injected: pending.nextHash,
    rules: text === null ? state.rules : mergeRules(text, state.rules, pending.rule ? entryFromRule(pending.rule, now) : undefined, now),
    held: { ...state.held },
    integrity: ''
  }
  const { integrity: _drop, ...withoutIntegrity } = nextState
  const saved = saveState(userData, folderHash, withoutIntegrity, key)
  if (!saved) {
    // 상태 저장 실패 — 쪽지는 남긴다(다음 실행이 다시 시도한다, §11.8 4·7번).
    return { ...idle, hadPending: true, success: false, message: '규칙을 저장하지 못했어요.' }
  }
  clearPending(userData, folderHash)
  return {
    ...idle,
    hadPending: true,
    success: true,
    message: '규칙을 저장했어요.',
    state: loadState(userData, folderHash, key).state
  }
}

