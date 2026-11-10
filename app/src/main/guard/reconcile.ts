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
  /** 디스크가 지금 보관본과 같은가. false면 이 잎은 보관본에 올리지 않는다(§4.3 '실패하면') */
  reverted: boolean
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

/**
 * 허락 없이 바뀐 잎 하나를 되돌린다. 지금 내용은 격리에 남긴다.
 * 돌려준 `reverted`는 **되돌린 뒤 실제로 보관본과 같아졌는지**다 — 같아지지 못한 잎은
 * 보관본에 올리면 안 되고(§4.3 '실패하면'), 루트 `CLAUDE.md`면 넣는 판을 비운다.
 */
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
  const abs = join(rootReal, rel.split('/').join(sep))
  const after = fingerprintLeaf(abs) ?? undefined
  const reverted = before ? sameFingerprint(before, after) : after === undefined
  return { rel, quarantinePath, reason, restoredFromStore, reverted }
}

/**
 * 강제 종료 갈래의 다음 보관본. 바뀐 잎은 새 지문으로 갈아 끼우고(되돌리지 못한 잎은 이전
 * 지문 그대로 — §4.3 '실패하면'), 나머지 잎은 이전 보관본 것을 그대로 둔다.
 */
function mergeCrashed(
  previous: Map<string, LeafFingerprint>,
  changed: readonly string[],
  adopted: Record<string, LeafFingerprint>,
  holdBack: ReadonlySet<string>
): Record<string, LeafFingerprint> {
  const leaves: Record<string, LeafFingerprint> = Object.fromEntries(previous)
  for (const rel of changed) delete leaves[rel]
  for (const [rel, fingerprint] of Object.entries(adopted)) leaves[rel] = fingerprint
  for (const rel of holdBack) {
    const before = previous.get(rel)
    if (before) leaves[rel] = before
    else delete leaves[rel]
  }
  return leaves
}

/** 루트 CLAUDE.md를 되돌리지 못하면 넣는 판은 비운다 — 디스크가 보관본과 같아질 때까지(§4.3). */
function injectedFor(leaves: Record<string, LeafFingerprint>, holdBack: ReadonlySet<string>): string | null {
  if (holdBack.has('CLAUDE.md')) return null
  return leaves['CLAUDE.md']?.hash ?? null
}
export function evaluateT0(opts: {
  rootReal: string
  userData: string
  folderHash: string
  state: GuardState
  scan: ScanResult
  /**
   * 복구 ④가 "학생 변경"으로 받아들인 잎(`recoverPending().acceptedLeaves`). 강제 종료
   * 갈래에서도 이 잎은 되돌리지 않고 그대로 보관본에 올린다(§16 중요 1).
   */
  acceptedLeaves?: readonly string[]
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
  const acceptedSet = new Set(opts.acceptedLeaves ?? [])
  const holdBack = new Set<string>()

  if (crashedQuery) {
    for (const rel of changed) {
      if (acceptedSet.has(rel)) {
        accepted.push(rel)
        notes.push(noteAccepted(rel))
        continue
      }
      const entry = revertLeaf(rootReal, userData, folderHash, rel, previous.get(rel), 'crashed-query', now)
      reverted.push(entry)
      if (entry.reverted) {
        notes.push(rel === 'CLAUDE.md' ? CLAUDE_MD_NOTE : noteReverted(rel))
      } else {
        holdBack.add(rel)
        notes.push(`설정 파일(${rel})을 되돌리지 못했어요.`)
      }
    }
    // 되돌린 잎만 새 기준이 된다 — 되돌리지 못한 잎은 이전 지문을 그대로 둔다(§4.3 '실패하면').
    // 지문은 **되돌린 뒤 디스크**에서 다시 뜬다: 스캔 값은 되돌리기 전 내용이라 보관본에 올릴 수 없다.
    const target = new Map<string, LeafFingerprint>()
    for (const rel of changed) {
      if (holdBack.has(rel)) continue
      const fingerprint = fingerprintLeaf(join(rootReal, rel.split('/').join(sep)))
      if (fingerprint) target.set(rel, fingerprint)
    }
    const adopted = adoptLeaves(rootReal, userData, folderHash, target)
    next.leaves = mergeCrashed(previous, changed, adopted.leaves, holdBack)
    if (holdBack.size === 0) notes.push(crashedNote)
    else notes.push(crashedNote + ' 일부는 되돌리지 못했어요.')
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
  next.injected = injectedFor(next.leaves, holdBack)
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
  /** 보관본에 새로 올릴 잎(카드로 허락된 것만) */
  const toAdopt = new Map<string, LeafFingerprint>()
  /** 되돌리지 못한 잎 — 보관본 항목을 이전 것 그대로 둔다 */
  const holdBack = new Set<string>()
  /** 잎 목록의 출발점은 **이전 보관본**이다 — 되돌린 잎은 그대로 맞고, 실패한 잎은 안 바뀐다 */
  const finalLeaves = new Map(previous)

  for (const rel of changed) {
    const isRootClaudeMd = rel === 'CLAUDE.md'
    if (!isRootClaudeMd && trusted(rel)) {
      kept.push(rel)
      const fingerprint = scan.leaves.get(rel)
      if (fingerprint) toAdopt.set(rel, fingerprint)
      else finalLeaves.delete(rel)
      continue
    }
    const entry = revertLeaf(rootReal, userData, folderHash, rel, previous.get(rel), isRootClaudeMd ? 'claude-md' : 'untrusted', now)
    reverted.push(entry)
    if (entry.reverted) {
      notes.push(isRootClaudeMd ? CLAUDE_MD_NOTE : noteReverted(rel))
    } else {
      // 되돌리지 못했으니 지금 글을 받아들이지 않는다(§4.3 '실패하면').
      holdBack.add(rel)
      notes.push(`설정 파일(${rel})을 되돌리지 못했어요.`)
    }
  }

  if (toAdopt.size > 0) {
    const adopted = adoptLeaves(rootReal, userData, folderHash, toAdopt)
    for (const [rel, fingerprint] of Object.entries(adopted.leaves)) finalLeaves.set(rel, fingerprint)
    for (const rel of adopted.failed) {
      // 보관하지 못한 잎은 이전 기준을 유지한다(지금 내용을 새 기준으로 삼지 않는다).
      if (!previous.has(rel)) finalLeaves.delete(rel)
      notes.push('설정 파일 일부를 보관하지 못했어요. 다음에 다시 시도할게요.')
    }
  }

  next.leaves = Object.fromEntries(finalLeaves)
  next.injected = injectedFor(next.leaves, holdBack)
  next.queryOpen = false

  const cleaned = cleanupEmptyClaudeDirs(rootReal)
  return { kept, reverted, cleaned, notes, claudeMdChanged: changed.includes('CLAUDE.md'), state: next }
}
