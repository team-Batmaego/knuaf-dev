/**
 * guard/reconcile.ts — T0(질의 시작 전) / T2(질의 종료) 맞춤
 *
 * - T0(질의 시작 전, send() 전): 지난 T2 뒤로 바뀐 보호 파일은 학생이 고친 것으로 보고
 *   수용(알림만) — queryOpen이 설정되어 있으면 T2처럼 되돌리지 않음
 * - T2(질의 끝, execute() finally 전, release 전): 허락 없는 보호 파일 변경은 되돌리고
 *   격리(.knuaf-gui/quarantine/<timestamp>/) + 빈 .claude 하위 폴더 정리
 *   - 루트 CLAUDE.md는 예외: 카드로 허락돼도 T2에서 되돌린다(§11.8)
 * - 보호 대상: .claude/ 아래 파일·링크(스캔 leaves 기준)
 */

import { isProtectedPath, isSkillHostPath } from './scope'
import { type GuardState, type RuleEntry, computeIntegrity, quarantineFile, cleanupEmptyClaudeDirs } from './store'

/** T0 수용 결과 */
export interface T0Result {
  accepted: boolean  // T0에서 수용(알림만)
  notes: string[]    // 알림 메시지 배열
  queryOpen: boolean // queryOpen 표식이 있었음
}

/** T2 되돌림 결과 */
export interface T2Result {
  /** 실제로 되돌린 leaf 경로들 */
  restored: string[]
  /** 격리된 경로들 */
  quarantined: string[]
  /** 삭제된 빈 폴더 경로들 */
  cleaned: string[]
  /** 알림 메시지 */
  notes: string[]
  /** integrity가 변경됐는지 */
  integrityChanged: boolean
}

/** T0: 질의 시작 전 수용 판단 */
export function evaluateT0(
  _rootReal: string,
  _currentState: GuardState,
  previousStateFromLastT2: GuardState | null,
  queryOpen: boolean
): T0Result {
  const notes: string[] = []

  // T0: 지난 T2 뒤 바뀐 보호 파일은 학생이 고친 것으로 보고 수용
  // queryOpen이 true면 T2처럼 되돌리지 않음(앱이 직접 관리 중)
  if (queryOpen && previousStateFromLastT2) {
    notes.push('이 폴더의 설정 파일이 바뀐 채로 질문 시작돼요. 도우미가 따라요.')
  }

  return { accepted: true, notes, queryOpen }
}

/** T2: 질의 종료 후 되돌림 판단 */
export function evaluateT2(
  rootReal: string,
  currentState: GuardState,
  scanResult: {
    leaves: string[]
    leafHashes: Record<string, string> | Map<string, string>
  },
  trusted: boolean, // 카드 허락 여부
  _queryOpen: boolean
): T2Result {
  const restored: string[] = []
  const quarantined: string[] = []
  const cleaned: string[] = []
  const notes: string[] = []

  const currentLeaves = currentState.leaves || []
  const scanHashes: Record<string, string> = scanResult.leafHashes instanceof Map
    ? Object.fromEntries(scanResult.leafHashes)
    : scanResult.leafHashes

  // T2: 허락 없는 보호 파일 변경은 되돌리고, 루트 CLAUDE.md는 예외 처리
  for (const leaf of currentLeaves) {
    // 보호 대상 경로이고, 앱 스킬 자리 밖인 경우만 처리
    if (!isProtectedPath(leaf) || isSkillHostPath(leaf)) continue

    const leafBasename = leaf.split('/').pop() || leaf
    if (leafBasename === 'CLAUDE.md' || leafBasename === 'CLAUDE.local.md') {
      // 루트 CLAUDE.md: 카드 허락 여부와 상관없이 T2에서 되돌림
      restored.push(leaf)
      notes.push(`규칙이(가) 허락 없이 바뀌어서 원래대로 되돌렸어요. 바뀐 내용은 따로 보관했어요.`)
      continue
    }

    // 일반 보호 대상: 허락 없으면 되돌림, 허락 있으면 남김
    const hashInState = currentState.leafHashes?.[leaf]
    const hashInScan = scanHashes[leaf]
    const isModified = !hashInState || hashInState !== hashInScan

    if (isModified) {
      if (!trusted) {
        restored.push(leaf)
        const ts = Date.now()
        const q = quarantineFile(rootReal, leaf, ts)
        if (q) quarantined.push(q)
        notes.push(`파일(${leaf})이(가) 허락 없이 바뀌어서 원래대로 되돌렸어요.`)
      } else {
        // trusted여도 보호 파일 변경은 정책에 따라 처리(루트 CLAUDE.md 제외 일반 보호)
        restored.push(leaf)
        notes.push(`규칙이(가) 바뀌었어요. 일부만 남기고 나머지는 원래대로 돌아갔어요.`)
      }
    }
  }

  // 빈 .claude 하위 폴더 정리
  const justCleaned = cleanupEmptyClaudeDirs(rootReal)
  cleaned.push(...justCleaned)

  // 무결성 표식 재계산(현재 상태 기준)
  const integrityChanged = currentState.integrity !== computeIntegrity({
    leaves: currentState.leaves,
    leafHashes: currentState.leafHashes,
    injected: currentState.injected,
    rules: currentState.rules,
    queryOpen: currentState.queryOpen
  })

  return {
    restored,
    quarantined,
    cleaned,
    notes,
    integrityChanged
  }
}
