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
 */

import { adoptLeaves, cleanupEmptyClaudeDirs, quarantineLeaf, removeLeaf, restoreLeaf, type GuardState } from './store'
import { diffLeaves, scanRoot, type ScanResult } from './scan'
import type { LeafFingerprint } from './scan'

/** 되돌림 한 건 */
export interface RevertEntry {
  rel: string
  /** 격리에 남긴 자리(없으면 null — 지운 새 잎 등) */
  quarantinePath: string | null
  reason: 'untrusted' | 'claude-md' | 'crashed-query'
  /** 보관본에 있던 잎을 되살렸는가(false = 새로 생긴 잎을 지웠다) */
  restoredFromStore: boolean
}

export interface T0Result {
  /** 질의를 시작해도 되는가(1층이 보증이라 실패해도 true) */
  proceed: boolean
  /** 이전 질의가 T2 없이 끝났다(강제 종료) */
  crashedQuery: boolean
  /** 학생 변경으로 받아들인 상대 경로들 */
  accepted: string[]
  /** 되돌린 상대 경로들(강제 종료 복구) */
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

function copyState(state: GuardState): GuardState {
  return { ...state, leaves: { ...state.leaves }, rules: state.rules.map((rule) => ({ ...rule })) }
}

/** 카드에 보인 보호 경로 판정. 루트 CLAUDE.md는 언제나 false여야 한다(§10-9). */
export type TrustedPaths = (rel: string) => boolean

const CLAUDE_MD_NOTE = '도우미가 CLAUDE.md를 바꾸려 해서 되돌렸어요. 규칙은 메시지 옆 [규칙으로 기억]으로 저장할 수 있어요.'
const crashedNote = '지난번 질의가 끝나기 전에 앱이 꺼져서, 그때 바뀐 설정 파일을 되돌렸어요.'

function noteReverted(rel: string): string {
  return `도우미가 일하는 동안 설정 파일(${rel})이 허락 없이 바뀌어서 원래대로 되돌렸어요. 바뀐 내용은 따로 보관했어요.`
}

function noteAccepted(rel: string): string {
  return rel === 'CLAUDE.md' ? 'CLAUDE.md가 바뀌어 있어요. 새 내용을 도우미가 따라요.' : `설정 파일(${rel})이(가) 바뀌어 있어요. 그대로 두었어요.`
}

/** 허락 없이 바뀐 잎 하나를 되돌린다. 지금 내용은 격리에 남긴다. */
function revertLeaf(
  rootReal: string,
  userData: string,
  folderHash: string,
  rel: string,
  before: LeafFingerprint | undefined,
  reason: RevertEntry['reason'],
  now: number
): RevertEntry {
  const quarantinePath = quarantineLeaf(rootReal, rel, now)
  let restoredFromStore = false
  if (before) restoredFromStore = restoreLeaf(rootReal, userData, folderHash, rel, before)
  else removeLeaf(rootReal, rel)
  return { rel, quarantinePath, reason, restoredFromStore }
}

/**
 * T0. `scan`은 지금 폴더 상태, `state`는 지난 T2가 남긴 상태다.
 * 돌려준 `state`는 **저장해야** 다음 T2가 같은 기준을 쓴다.
 */
export function evaluateT0(opts: {
  rootReal: string
  userData: string
  folderHash: string
  state: GuardState
  scan: ScanResult
  userDataForScan?: string
  now?: number
}): T0Result {
  const { rootReal, userData, folderHash, state, scan } = opts
  const now = opts.now ?? Date.now()
  const previous = new Map(Object.entries(state.leaves))
  const crashedQuery = state.queryOpen
  const changed = diffLeaves(previous, scan.leaves)
  const next = copyState(state)
  const notes: string[] = []
  const accepted: string[] = []
  const reverted: RevertEntry[] = []

  if (crashedQuery) {
    for (const rel of changed) {
      reverted.push(revertLeaf(rootReal, userData, folderHash, rel, previous.get(rel), 'crashed-query', now))
      notes.push(rel === 'CLAUDE.md' ? CLAUDE_MD_NOTE : noteReverted(rel))
    }
    // 되돌린 **뒤**의 폴더를 다시 스캔해 보관본을 맞춘다 — 되돌리지 못한 잎은 지금 것을 받아들인다.
    const after = scanRoot({ root: rootReal, userData: opts.userDataForScan ?? userData })
    next.leaves = adoptLeaves(rootReal, userData, folderHash, after.leaves).leaves
    notes.push(crashedNote)
  } else if (changed.length > 0) {
    for (const rel of changed) {
      accepted.push(rel)
      notes.push(noteAccepted(rel))
    }
    const adopted = adoptLeaves(rootReal, userData, folderHash, scan.leaves)
    next.leaves = adopted.leaves
    if (adopted.failed.length > 0) notes.push('설정 파일 일부를 보관하지 못했어요. 다음에 다시 시도할게요.')
  }

  // 넣는 판은 **보관본 잎**의 해시다 — 다음 질의는 디스크가 아니라 이 내용을 넣는다(§11.6-3).
  next.injected = next.leaves['CLAUDE.md']?.hash ?? null
  next.queryOpen = true
  return {
    proceed: true,
    crashedQuery,
    accepted,
    reverted,
    notes,
    claudeMdChanged: changed.includes('CLAUDE.md'),
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
  now?: number
}): T2Result {
  const { rootReal, userData, folderHash, state, scan } = opts
  const now = opts.now ?? Date.now()
  const trusted = opts.trusted ?? (() => false)
  const previous = new Map(Object.entries(state.leaves))
  const changed = diffLeaves(previous, scan.leaves)
  const next = copyState(state)
  const kept: string[] = []
  const reverted: RevertEntry[] = []
  const notes: string[] = []
  const keptLeaves = new Map(previous)

  for (const rel of changed) {
    const isRootClaudeMd = rel === 'CLAUDE.md'
    if (!isRootClaudeMd && trusted(rel)) {
      kept.push(rel)
      const fingerprint = scan.leaves.get(rel)
      if (fingerprint) keptLeaves.set(rel, fingerprint)
      else keptLeaves.delete(rel)
      continue
    }
    reverted.push(revertLeaf(rootReal, userData, folderHash, rel, previous.get(rel), isRootClaudeMd ? 'claude-md' : 'untrusted', now))
    notes.push(isRootClaudeMd ? CLAUDE_MD_NOTE : noteReverted(rel))
  }

  if (changed.length > 0) next.leaves = adoptLeaves(rootReal, userData, folderHash, keptLeaves).leaves
  next.injected = next.leaves['CLAUDE.md']?.hash ?? null
  next.queryOpen = false

  const cleaned = cleanupEmptyClaudeDirs(rootReal)
  return { kept, reverted, cleaned, notes, claudeMdChanged: changed.includes('CLAUDE.md'), state: next }
}
