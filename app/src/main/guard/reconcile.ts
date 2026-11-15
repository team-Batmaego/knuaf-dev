/**
 * guard/reconcile.ts — T0(질의 시작 전) / T2(질의 끝) 맞추기
 *
 * 두 시점뿐이다(§4.3). 자리는 `service.ts` 전송 경로(Claude·Codex 공통, 폴더 잠금 안).
 *
 * T0 — 지난 T2 뒤로 바뀐 잎은 **학생이 고친 것**으로 보고 받아들인다(알림만).
 *      단, `queryOpen` 표식이 남아 있으면 앱이 강제 종료된 것이므로 그 변경은
 *      **질의 안 변경**으로 보고 T2처럼 되돌린다(§10-8 다).
 * T2 — 그 질의 동안 바뀐 잎 중 카드로 허락된 경로만 남기고 나머지는 되돌린다.
 *      **루트 `CLAUDE.md`는 허락됐어도 되돌린다**(§11.8 — 규칙은 [규칙으로 기억] 단추로만).
 *
 * 되돌리기는 **잎 단위**다. 폴더를 통째로 옮기지 않는다. 지금 내용은 격리에 남긴다.
 *
 * **상태표(§16.5).** 한 번의 호출 안이 아니라 **호출이 끝난 뒤 무엇을 믿는지**가 남아야 한다.
 * 잎 하나의 상태는 상태 파일에 남는 둘뿐이다 — S(신뢰: `leaves[rel]` = F, `held`에 없음)와
 * H(보류: `held[rel]`, 보관본 항목은 이전 F 그대로). 보류 잎은 조건·`queryOpen`·카드 허락·
 * 수용 집합과 **무관하게** 되돌리기만 다시 시도한다(⑦) — 디스크가 F와 같아지면 풀린다(⑧).
 * 그래서 ⑥(또는 ③·⑨) 되돌리기가 실패한 잎은 다음 T0가 "학생 변경"으로 받아들이지 않는다(C3).
 *
 * 불변식: `injected`가 null이 아니다 ⇔ `CLAUDE.md`가 S이고 디스크가 F이며 그 blob이 있다.
 * 디스크가 F와 다른 동안(수용 blob 쓰기 실패 포함)에는 넣는 판을 비운다 — 디스크와 다른
 * 글을 "학생 규칙"이라며 넣지 않는다(§16.5.1).
 */

import {
  adoptLeaves,
  cleanupEmptyClaudeDirs,
  decodeStrict,
  getBlob,
  hasBlob,
  revertLeafToStore,
  retryHeldLeaf,
  type AcceptedLeaf,
  type GuardState,
  type HeldLeaf,
  type IntegrityState,
  type RuleEntry
} from './store'
import { mergeRules } from './rules'
import { diffLeaves, fingerprintLeaf, sameFingerprint, type ScanResult } from './scan'
import type { LeafFingerprint } from './scan'
import { join, sep } from 'node:path'

/** 되돌림 한 건 */
export interface RevertEntry {
  rel: string
  /** 격리에 남긴 자리(없으면 null — 지운 새 잎 등) */
  quarantinePath: string | null
  reason: 'untrusted' | 'claude-md' | 'crashed-query'
  /** 보관본에 있던 잎을 되살렸는가(false = 새로 생긴 잎을 지웠거나 되돌리지 못했다) */
  restoredFromStore: boolean
  /** 디스크가 지금 보관본과 같은가. false면 이 잎은 보류(H)가 된다(§16.5.2 ⑦) */
  reverted: boolean
}

export interface T0Result {
  /** 질의를 시작해도 되는가(1층이 보증이라 실패해도 true) */
  proceed: boolean
  /** 이전 질의가 T2 없이 끝났다(강제 종료) */
  crashedQuery: boolean
  /** 학생 변경으로 받아들인 상대 경로들 */
  accepted: string[]
  /** 되돌린 상대 경로들(강제 종료 복구·보류 재시도) */
  reverted: RevertEntry[]
  notes: string[]
  /** 루트 CLAUDE.md 내용이 바뀌었는가(넣는 판 갱신은 instructions가 한다) */
  claudeMdChanged: boolean
  /** 저장할 새 상태(호출자가 saveState) */
  state: GuardState
}

export interface T2Result {
  /** 카드 허락으로 남긴 상대 경로들 */
  kept: string[]
  reverted: RevertEntry[]
  cleaned: string[]
  notes: string[]
  claudeMdChanged: boolean
  state: GuardState
}

const CLAUDE_MD = 'CLAUDE.md'

/** 카드에 보인 보호 경로 판정. 루트 CLAUDE.md는 언제나 false여야 한다(§10-9). */
export type TrustedPaths = (rel: string) => boolean

const CLAUDE_MD_NOTE = '도우미가 CLAUDE.md를 바꾸려 해서 되돌렸어요. 규칙은 메시지 옆 [규칙으로 기억]으로 저장할 수 있어요.'
const crashedNote = '지난번 질의가 끝나기 전에 앱이 꺼져서, 그때 바뀐 설정 파일을 되돌렸어요.'
const acceptFailedNote = '설정 파일 일부를 보관하지 못했어요. 다음에 다시 시도할게요.'

function noteReverted(rel: string): string {
  return `도우미가 일하는 동안 설정 파일(${rel})이 허락 없이 바뀌어서 원래대로 되돌렸어요. 바뀐 내용은 따로 보관했어요.`
}

function noteRevertFailed(rel: string): string {
  return `설정 파일(${rel})을 되돌리지 못했어요.`
}

/** 보류(H) 잎 알림 — 앱 실행마다 한 번(§16.5.5 7). */
function noteHeld(rel: string): string {
  return `설정 파일(${rel})을 아직 정리하지 못했어요. 정리될 때까지 도우미에게 넣지 않아요`
}

function noteAccepted(rel: string): string {
  return rel === CLAUDE_MD ? 'CLAUDE.md가 바뀌어 있어요. 새 내용을 도우미가 따라요.' : `설정 파일(${rel})이(가) 바뀌어 있어요. 그대로 두었어요.`
}

/** 이번 앱 실행에서 이미 알린 보류 잎. 상태 파일이 아니라 화면 알림 중복만 막는다. */
const heldNotified = new Set<string>()

function noteHeldOnce(folderHash: string, rel: string, since: number, notes: string[]): void {
  const key = `${folderHash}/${rel}@${since}`
  if (heldNotified.has(key)) return
  heldNotified.add(key)
  notes.push(noteHeld(rel))
}

function copyState(state: GuardState): GuardState {
  return {
    ...state,
    leaves: { ...state.leaves },
    rules: state.rules.map((rule) => ({ ...rule })),
    held: { ...state.held }
  }
}

function absOf(rootReal: string, rel: string): string {
  return join(rootReal, rel.split('/').join(sep))
}

/**
 * 허락 없이 바뀐 잎 하나를 되돌린다(§16.5.2). 지금 내용은 격리에 남긴다.
 * 돌려준 `reverted`는 **되돌린 뒤 실제로 보관본과 같아졌는지**다 — 같아지지 못한 잎은
 * 보관본에 올리면 안 되고(§4.3 '실패하면'), 보류(H)로 간다(§16.5.2 ③⑥⑨ 실패).
 */
function revert(
  rootReal: string,
  userData: string,
  folderHash: string,
  rel: string,
  before: LeafFingerprint | undefined,
  reason: RevertEntry['reason'],
  now: number
): RevertEntry {
  const outcome = revertLeafToStore(rootReal, userData, folderHash, rel, before, now)
  return {
    rel,
    quarantinePath: outcome.quarantinePath,
    reason,
    restoredFromStore: outcome.restoredFromStore,
    reverted: outcome.reverted
  }
}

/** 보류(H)로 보낸다 — 보관본 항목은 이전 F 그대로 두고, 디스크 지문만 적어 둔다. */
function holdLeaf(state: GuardState, rel: string, disk: LeafFingerprint | undefined, now: number): void {
  state.held[rel] = { hash: disk?.hash ?? null, since: now, tries: 1 }
}

/** ⑦ — 보류 잎은 되돌리기만 다시 시도한다. 성공하면 풀고, 실패하면 시도 횟수만 올린다. */
function retryHeldInto(opts: {
  rootReal: string
  userData: string
  folderHash: string
  rel: string
  stored: LeafFingerprint | undefined
  disk: LeafFingerprint | undefined
  now: number
  notes: string[]
  state: GuardState
  heldEntry: HeldLeaf
}): { released: boolean; entry: RevertEntry | null } {
  const { rootReal, userData, folderHash, rel, stored, disk, now, notes, state, heldEntry } = opts
  // ⑧ — 디스크가 이미 F와 같다(학생이 손으로 맞췄거나, F가 "없음"인데 지워져 있다).
  // 되돌림 자체는 ⑬(앱 저장)과 같은 함수가 한다 — `null` = ⑧.
  const outcome = retryHeldLeaf(rootReal, userData, folderHash, rel, stored, disk, now)
  if (outcome === null) {
    delete state.held[rel]
    return { released: true, entry: null }
  }
  const entry: RevertEntry = {
    rel,
    quarantinePath: outcome.quarantinePath,
    reason: rel === CLAUDE_MD ? 'claude-md' : 'untrusted',
    restoredFromStore: outcome.restoredFromStore,
    reverted: outcome.reverted
  }
  if (entry.reverted) {
    delete state.held[rel]
    notes.push(rel === CLAUDE_MD ? CLAUDE_MD_NOTE : noteReverted(rel))
    return { released: false, entry }
  }
  state.held[rel] = { hash: disk?.hash ?? null, since: heldEntry.since, tries: heldEntry.tries + 1 }
  noteHeldOnce(folderHash, rel, heldEntry.since, notes)
  return { released: false, entry }
}

/**
 * 루트 CLAUDE.md를 수용했을 때의 규칙 표(§16.5.4). `injected`가 바뀌는 모든 자리에서
 * 표도 같은 상태에 다시 만든다 — 파일과 표가 다른 시점 것을 가리키지 않게(I2).
 * blob 글자를 UTF-8로 못 읽으면 표를 건드리지 않는다(되돌림과 같은 "이전 표 유지").
 */
function rebuiltRules(
  state: GuardState,
  userData: string,
  folderHash: string,
  now: number
): RuleEntry[] | null {
  const leaf = state.leaves[CLAUDE_MD]
  if (!leaf) return null
  const blob = getBlob(userData, folderHash, leaf.hash)
  if (!blob) return null
  const text = decodeStrict(blob)
  if (text === null) return null
  return mergeRules(text, state.rules, undefined, now)
}

/**
 * 넣는 판 — "디스크가 지금 보관본과 같고 그 blob이 있을 때"만 F다(§16.5.1 불변식).
 * 수용 blob 쓰기가 실패했거나 되돌리지 못한 잎은 null이다(디스크와 다른 글을 넣지 않는다).
 */
function injectedFor(rootReal: string, userData: string, folderHash: string, state: GuardState): string | null {
  if (state.held[CLAUDE_MD]) return null
  const stored = state.leaves[CLAUDE_MD]
  if (!stored) return null
  const disk = fingerprintLeaf(absOf(rootReal, CLAUDE_MD)) ?? undefined
  if (!sameFingerprint(stored, disk)) return null
  return hasBlob(userData, folderHash, stored.hash) ? stored.hash : null
}

/** 처리 순서 — 바뀐 잎 먼저, 보류 잎은 그 뒤(이미 바뀐 목록에 있으면 한 번만). */
function orderedLeaves(state: GuardState, changed: readonly string[]): string[] {
  const keys = changed.slice()
  for (const rel of Object.keys(state.held)) if (!keys.includes(rel)) keys.push(rel)
  return keys
}

export function evaluateT0(opts: {
  rootReal: string
  userData: string
  folderHash: string
  state: GuardState
  scan: ScanResult
  /**
   * 복구 ④가 "학생 변경"으로 받아들인 잎과 그때의 디스크 지문(`recoverPending().accepted`).
   * 지문이 **지금 디스크와 같을 때만** ④다 — 다르면 그 뒤에 또 바뀐 것이므로 ③(되돌림)이다.
   * 강제 종료 갈래에서도 이 잎만은 되돌리지 않고 그대로 보관본에 올린다(§16.5.3).
   */
  accepted?: readonly AcceptedLeaf[]
  /** `loadState().integrity` — `ok`가 아니면 ⑪(전이 없음, 아무것도 쓰지 않는다) */
  integrity?: IntegrityState
  now?: number
}): T0Result {
  const { rootReal, userData, folderHash, state, scan } = opts
  const now = opts.now ?? Date.now()
  // ⑪ — 열쇠 없음·무결성 불일치: 잎을 건드리지도, 보관본에 올리지도 않는다(§16.5.2 ⑪).
  // 넣기·[규칙으로 기억]을 끄는 판단은 호출자 몫이지만, 전이는 여기서 멈춘다.
  if (opts.integrity !== undefined && opts.integrity !== 'ok') {
    return {
      proceed: true,
      crashedQuery: state.queryOpen,
      accepted: [],
      reverted: [],
      notes: [],
      claudeMdChanged: false,
      state: copyState(state)
    }
  }
  const previous = new Map(Object.entries(state.leaves))
  const crashedQuery = state.queryOpen
  const changed = diffLeaves(previous, scan.leaves)
  const next = copyState(state)
  const notes: string[] = []
  const accepted: string[] = []
  const reverted: RevertEntry[] = []
  const acceptedSet = new Map<string, string>()
  for (const entry of opts.accepted ?? []) acceptedSet.set(entry.rel, entry.hash)
  const processed = new Set<string>()
  /** 보관본에 새로 올릴 잎(수용) */
  const toAdopt = new Map<string, LeafFingerprint>()
  /** 수용한 삭제 */
  const deleted: string[] = []

  for (const rel of orderedLeaves(state, changed)) {
    const stored = previous.get(rel)
    const disk = scan.leaves.get(rel)
    const heldEntry = state.held[rel]
    if (heldEntry) {
      // ⑦·⑧ — 어떤 조건에서도 수용하지 않는다.
      processed.add(rel)
      const result = retryHeldInto({ rootReal, userData, folderHash, rel, stored, disk, now, notes, state: next, heldEntry })
      if (result.entry) reverted.push(result.entry)
      continue
    }
    if (processed.has(rel)) continue
    processed.add(rel)
    // ① — 디스크 = F(또는 둘 다 없음).
    if (sameFingerprint(stored, disk)) continue

    // ②(질의 밖 변경) / ④(복구 수용 집합, **지문까지 같을 때**) / ⑨(항목 없음 → F="없음").
    // 지문이 함께 오지 않은 수용은 없다 — 수용 뒤 디스크가 또 바뀌었으면 ③(되돌림)이다(I1).
    const acceptedHash = acceptedSet.get(rel)
    const acceptedHere = crashedQuery
      && acceptedHash !== undefined
      && disk !== undefined
      && acceptedHash === disk.hash
    const accept = crashedQuery ? acceptedHere : true
    if (accept) {
      accepted.push(rel)
      notes.push(noteAccepted(rel))
      if (disk) toAdopt.set(rel, disk)
      else deleted.push(rel)
      continue
    }

    // ③ — 강제 종료 갈래의 되돌림. 실패하면 H(보류).
    const entry = revert(rootReal, userData, folderHash, rel, stored, 'crashed-query', now)
    reverted.push(entry)
    if (entry.reverted) {
      notes.push(rel === CLAUDE_MD ? CLAUDE_MD_NOTE : noteReverted(rel))
    } else {
      holdLeaf(next, rel, disk, now)
      notes.push(noteRevertFailed(rel))
    }
  }

  if (toAdopt.size > 0) {
    const adopted = adoptLeaves(rootReal, userData, folderHash, toAdopt)
    for (const [rel, fingerprint] of Object.entries(adopted.leaves)) next.leaves[rel] = fingerprint
    if (adopted.leaves[CLAUDE_MD]) {
      // ②·④·⑫ — CLAUDE.md를 수용하면 규칙 표도 같은 상태에서 새 blob으로 다시 만든다(I2).
      const rules = rebuiltRules(next, userData, folderHash, now)
      if (rules) next.rules = rules
    }
    for (const _rel of adopted.failed) notes.push(acceptFailedNote)
  }
  for (const rel of deleted) {
    delete next.leaves[rel]
    // ⑩ — 삭제를 수용하면 그 파일의 규칙 표도 빈 표다.
    if (rel === CLAUDE_MD) next.rules = []
  }

  if (crashedQuery) {
    const stillHeld = Object.keys(next.held).length > 0
    notes.push(stillHeld ? crashedNote + ' 일부는 되돌리지 못했어요.' : crashedNote)
  }

  next.injected = injectedFor(rootReal, userData, folderHash, next)
  next.queryOpen = true
  return {
    proceed: true,
    crashedQuery,
    accepted,
    reverted,
    notes,
    claudeMdChanged: changed.includes(CLAUDE_MD),
    state: next
  }
}

/**
 * T2. `trusted`는 그 질의에서 카드로 허락한 보호 경로. 루트 `CLAUDE.md`는 무시된다.
 */
export function evaluateT2(opts: {
  rootReal: string
  userData: string
  folderHash: string
  state: GuardState
  scan: ScanResult
  trusted?: TrustedPaths
  /** `loadState().integrity` — `ok`가 아니면 ⑪(전이 없음, 아무것도 쓰지 않는다) */
  integrity?: IntegrityState
  now?: number
}): T2Result {
  const { rootReal, userData, folderHash, state, scan } = opts
  const now = opts.now ?? Date.now()
  const trusted = opts.trusted ?? (() => false)
  // ⑪ — 열쇠 없음·무결성 불일치: 되돌리지도, 남기지도 않는다(§16.5.2 ⑪).
  if (opts.integrity !== undefined && opts.integrity !== 'ok') {
    return { kept: [], reverted: [], cleaned: [], notes: [], claudeMdChanged: false, state: copyState(state) }
  }
  const previous = new Map(Object.entries(state.leaves))
  const changed = diffLeaves(previous, scan.leaves)
  const next = copyState(state)
  const kept: string[] = []
  const reverted: RevertEntry[] = []
  const notes: string[] = []
  /** 보관본에 새로 올릴 잎(카드로 허락된 것만) */
  const toAdopt = new Map<string, LeafFingerprint>()
  const processed = new Set<string>()

  for (const rel of orderedLeaves(state, changed)) {
    const stored = previous.get(rel)
    const disk = scan.leaves.get(rel)
    const heldEntry = state.held[rel]
    if (heldEntry) {
      processed.add(rel)
      const result = retryHeldInto({ rootReal, userData, folderHash, rel, stored, disk, now, notes, state: next, heldEntry })
      if (result.entry) reverted.push(result.entry)
      continue
    }
    if (processed.has(rel)) continue
    processed.add(rel)
    if (sameFingerprint(stored, disk)) continue

    const isRootClaudeMd = rel === CLAUDE_MD
    // ⑤ — 카드로 허락된 경로(루트 CLAUDE.md 제외)만 남긴다.
    if (!isRootClaudeMd && trusted(rel)) {
      kept.push(rel)
      if (disk) toAdopt.set(rel, disk)
      else delete next.leaves[rel]
      continue
    }

    // ⑥ — 허락 안 됨 또는 루트 CLAUDE.md. 실패하면 H(보류).
    const entry = revert(rootReal, userData, folderHash, rel, stored, isRootClaudeMd ? 'claude-md' : 'untrusted', now)
    reverted.push(entry)
    if (entry.reverted) {
      notes.push(isRootClaudeMd ? CLAUDE_MD_NOTE : noteReverted(rel))
    } else {
      holdLeaf(next, rel, disk, now)
      notes.push(noteRevertFailed(rel))
    }
  }

  if (toAdopt.size > 0) {
    const adopted = adoptLeaves(rootReal, userData, folderHash, toAdopt)
    for (const [rel, fingerprint] of Object.entries(adopted.leaves)) next.leaves[rel] = fingerprint
    for (const rel of adopted.failed) {
      // 보관하지 못한 잎은 이전 기준을 유지한다(지금 내용을 새 기준으로 삼지 않는다).
      if (!previous.has(rel)) delete next.leaves[rel]
      notes.push(acceptFailedNote)
    }
  }

  next.injected = injectedFor(rootReal, userData, folderHash, next)
  next.queryOpen = false

  const cleaned = cleanupEmptyClaudeDirs(rootReal)
  return { kept, reverted, cleaned, notes, claudeMdChanged: changed.includes(CLAUDE_MD), state: next }
}
