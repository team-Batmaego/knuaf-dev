/**
 * 옮긴·복사한 논문 폴더의 잠금 풀기(`lock.upgrade_offline`) — 화면이 쓰는 판정만 모은다.
 *
 * 판정의 주인은 규칙집 `gg_lock` 이다. 앱은 `relocation_candidate`·`status`·`commit_state`·`reason`
 * 정해진 값만 보고 새 판정을 만들지 않는다. 모르는 값은 '풀지 못함(경고)'으로 접는다.
 */
import type { LockInfo, OfflineRecovery } from './types'

/** 풀기 단추를 보일지: 규칙집이 '옮긴 폴더로 보인다'고 한 손상일 때만(L1). 다른 손상·옛 판은 안 보인다(L3·L4). */
export function canRecoverMoved(lock: LockInfo | undefined | null): boolean {
  return !!lock && lock.structure === 'damaged' && lock.relocation_candidate === true
}

export type RecoveryOutcome =
  /** 잠금이 새로 준비됐다. */
  | { kind: 'done' }
  /** 확인이 없어 아무것도 안 바꿨다. */
  | { kind: 'not_confirmed' }
  /** 바뀐 것 없이 멈췄다 — 이유를 보여 준다. */
  | { kind: 'not_committed'; reason: string | null }
  /** 새 잠금은 섰지만 마무리 정리가 남았다 — 같은 복구를 이어서 마칠 수 있다. */
  | { kind: 'cleanup_pending'; resumeId: string | null; reason: string | null }
  /** 어디까지 됐는지 확인할 수 없다 — 담당자 확인이 필요하다. */
  | { kind: 'indeterminate'; resumeId: string | null; reason: string | null }

export function recoveryOutcome(r: OfflineRecovery): RecoveryOutcome {
  if ((r.status === 'completed' || r.status === 'already_completed') && r.commit_state === 'committed') return { kind: 'done' }
  if (r.status === 'blocked' && r.commit_state === 'not_committed' && r.reason === 'offline_confirmation_required') return { kind: 'not_confirmed' }
  if (r.commit_state === 'committed_cleanup_pending') return { kind: 'cleanup_pending', resumeId: r.recovery_id, reason: r.reason }
  if (r.commit_state === 'not_committed') return { kind: 'not_committed', reason: r.reason }
  return { kind: 'indeterminate', resumeId: r.recovery_id, reason: r.reason }
}
