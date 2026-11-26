/**
 * 옮긴·복사한 논문 폴더의 잠금 풀기(`lock.upgrade_offline`) — 화면이 쓰는 판정만 모은다.
 *
 * 판정의 주인은 규칙집 `gg_lock` 이다. 앱은 `relocation_candidate`·`status`·`commit_state`·`reason`
 * 정해진 값만 보고 새 판정을 만들지 않는다. 모르는 값은 '풀지 못함(경고)'으로 접는다.
 */
import type { LockInfo, OfflineRecovery } from './types'

/**
 * 풀기 단추를 보일지: 규칙집이 '옮긴 폴더로 보인다'고 한 손상이고, 그 규칙집이 승인된 폴더 식별값을 받는 판일 때만(L1·가2).
 * 다른 손상·옛 판은 안 보인다(L3·L4).
 */
export function canRecoverMoved(lock: LockInfo | undefined | null): boolean {
  return !!lock && lock.structure === 'damaged' && lock.relocation_candidate === true && !lock.recovery_id
    && lock.relocation_supported === true
}

/** 옮긴 폴더·멈춘 잠금 풀기가 보이지만 규칙집이 틈 있는 판(v0.6.5 이하)이라 단추 대신 '업데이트 필요'를 보일지(L4·가2). */
export function needsSkillUpdate(lock: LockInfo | undefined | null): boolean {
  if (!lock || lock.relocation_supported === true) return false
  return (lock.structure === 'damaged' && lock.relocation_candidate === true) || validId(lock.recovery_id)
}

const RECOVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 끝나지 않은 복구의 ID — 규칙집 `lock.info` 가 이 폴더의 활성 복구 기록에서 읽어 준다(Roh I-02).
 * 화면 상태가 아니라 폴더에서 다시 읽으므로 앱을 다시 켜거나 폴더를 다시 열어도 이어 하기를 되살린다.
 * 사이드카도 같은 폴더의 같은 ID 일 때만 이어 하기를 받는다.
 */
export function resumableRecovery(lock: LockInfo | undefined | null): string | null {
  const id = lock?.recovery_id
  return lock?.relocation_supported === true && validId(id) ? id as string : null
}

function validId(id: unknown): boolean {
  return typeof id === 'string' && RECOVERY_ID.test(id)
}

export type RecoveryOutcome =
  /** 잠금이 새로 준비됐다. */
  | { kind: 'done' }
  /** 확인이 없어 아무것도 안 바꿨다. */
  | { kind: 'not_confirmed' }
  /** 커밋 전에 멈췄다 — 확인 전 거절과 달리 중간까지 진행됐을 수 있어 잠금 상태를 다시 본다(Roh I-01). */
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
