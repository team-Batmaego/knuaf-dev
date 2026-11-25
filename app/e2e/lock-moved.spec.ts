/**
 * v0.7.5 — 옮긴·복사한 논문 폴더 잠금 풀기(`lock.upgrade_offline`).
 *
 * 화면 없이 판정만 잠근다(`playwright.node.config.ts`):
 *  1) 풀기 단추는 규칙집이 `relocation_candidate: true` 라고 한 손상에서만 보인다(L1). 다른 손상·옛
 *     규칙집(키 없음)·정상 폴더에서는 안 보인다(L3·L4).
 *  2) 결과 판정 → 안내 한 개. 확인 없음은 '아무것도 안 바뀜'(L2), 끝나지 못한 마무리는 같은 복구 ID 로
 *     이어서 마치기, 모르는 값은 경고로 접는다.
 *  3) RPC 이름이 쓰기 메서드 목록에 있다(동시 쓰기 막기), 규칙집 업데이트 필요 오류는 알아볼 수 있는 안내다.
 */
import { expect, test } from '@playwright/test'
import { canRecoverMoved, recoveryOutcome, resumableRecovery } from '../src/shared/lock-recovery'
import type { LockInfo, OfflineRecovery } from '../src/shared/types'
import { LOCK_COPY, describeError, describeRecovery } from '../src/renderer/src/copy'
import { WRITE_METHODS } from '../src/renderer/src/store/prep'

function lock(extra: Partial<LockInfo>): LockInfo {
  return {
    structure: 'damaged', lock_state: 'unprobed', reason: 'directory_identity_mismatch', protocol: null, owner: null,
    observed_at: '2026-11-26T00:00:00Z', recovery_id: null, ...extra
  }
}

function result(extra: Partial<OfflineRecovery>): OfflineRecovery {
  return {
    recovery_id: 'rid-1', status: 'completed', commit_state: 'committed', reason: null, receipt_path: null,
    preserved_paths: [], cleanup_errors: [], ...extra
  }
}

test('옮긴 폴더(relocation_candidate=true)에서만 풀기 단추가 보인다', () => {
  expect(canRecoverMoved(lock({ relocation_candidate: true }))).toBe(true)
  expect(canRecoverMoved(lock({ relocation_candidate: false }))).toBe(false) // L3
  expect(canRecoverMoved(lock({}))).toBe(false) // L4: 옛 규칙집은 키가 없다
  expect(canRecoverMoved(lock({ structure: 'ready', relocation_candidate: true, reason: null }))).toBe(false)
  expect(canRecoverMoved(lock({ structure: 'legacy', relocation_candidate: true }))).toBe(false)
  expect(canRecoverMoved(undefined)).toBe(false)
  // 문자열 'true' 같은 엉뚱한 값은 판정으로 보지 않는다.
  expect(canRecoverMoved(lock({ relocation_candidate: 'true' as unknown as boolean }))).toBe(false)
})

test('복구 결과 → 안내', () => {
  expect(describeRecovery(recoveryOutcome(result({})))).toEqual({ kind: 'completion', title: LOCK_COPY.moveDone })
  expect(describeRecovery(recoveryOutcome(result({ status: 'already_completed' })))).toEqual({ kind: 'completion', title: LOCK_COPY.moveDone })
  // L2: 확인 없이 불린 경우 — 아무것도 안 바뀌었다.
  expect(describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'not_committed', reason: 'offline_confirmation_required' }))))
    .toEqual({ kind: 'status', title: LOCK_COPY.moveNotConfirmed })
  const busy = describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'not_committed', reason: 'recovery_active_exists' })))
  expect(busy.kind).toBe('warning')
  expect(busy.title).toBe(LOCK_COPY.moveNotCommitted)
  expect(busy.body).toContain('recovery_active_exists')
  expect(busy.resumeId).toBeUndefined()
  const pending = describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'committed_cleanup_pending', reason: 'cleanup_failed' })))
  expect(pending).toMatchObject({ kind: 'warning', title: LOCK_COPY.moveCleanupPending, resumeId: 'rid-1' })
  const pendingNoId = describeRecovery(recoveryOutcome(result({ recovery_id: null, status: 'blocked', commit_state: 'committed_cleanup_pending' })))
  expect(pendingNoId.resumeId).toBeUndefined()
  const unknown = describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'indeterminate' })))
  expect(unknown).toMatchObject({ kind: 'warning', title: LOCK_COPY.moveIndeterminate })
  expect(unknown.resumeId).toBeUndefined()
  // 모르는 상태 이름도 '끝남'으로 읽지 않는다.
  expect(describeRecovery(recoveryOutcome(result({ status: 'weird', commit_state: 'weird' }))).kind).toBe('warning')
  expect(describeRecovery(recoveryOutcome(result({ status: 'completed', commit_state: 'indeterminate' }))).kind).toBe('warning')
})

test('쓰기 메서드로 등록되고, 규칙집 업데이트 필요 오류는 알아볼 수 있는 안내다(L4)', () => {
  expect(WRITE_METHODS.has('lock.upgrade_offline')).toBe(true)
  const described = describeError({ code: 'skill_update_required', message: 'x', data: { feature: 'lock.upgrade_offline' } })
  expect(described.kind).toBe('warning')
  expect(described.title).toContain('규칙집 업데이트')
})

test('Roh I-01: "아무것도 안 바뀜"은 확인 전에 끝난 경우에만, 그 밖 미커밋은 잠금 상태를 다시 보라고 한다', () => {
  const confirmLess = describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'not_committed', reason: 'offline_confirmation_required' })))
  expect(confirmLess.title).toContain('아무것도 바꾸지 않았어요')
  for (const reason of ['recovery_active_exists', 'guard_busy', null]) {
    const v = describeRecovery(recoveryOutcome(result({ status: 'blocked', commit_state: 'not_committed', reason })))
    const text = `${v.title} ${v.body ?? ''}`
    expect(text).not.toContain('그대로')
    expect(text).not.toContain('바꾸지 않았')
    expect(text).toContain(LOCK_COPY.moveRecheck)
  }
})

test('Roh I-02: 화면에 다시 들어와도 lock.info 의 활성 복구 ID 로 이어 하기를 되살린다', () => {
  const rid = '0b8f8a0e-6c1e-4d3e-9f57-1c2d3e4f5a6b'
  // 정리만 남은 경우: 새 잠금은 섰다(ready) — 규칙집은 reason 을 recovery_active 로 돌려준다.
  expect(resumableRecovery(lock({ structure: 'ready', reason: 'recovery_active', recovery_id: rid }))).toBe(rid)
  // 격리 뒤 멈춘 경우: 잠금 폴더가 없다(absent).
  expect(resumableRecovery(lock({ structure: 'absent', reason: 'recovery_active', recovery_id: rid }))).toBe(rid)
  expect(resumableRecovery(lock({ structure: 'damaged', recovery_id: rid }))).toBe(rid)
  expect(resumableRecovery(lock({ recovery_id: null }))).toBeNull()
  expect(resumableRecovery(lock({ recovery_id: '../x' }))).toBeNull()
  expect(resumableRecovery(undefined)).toBeNull()
  // 활성 복구가 있으면 새 복구 단추는 안 보인다(규칙집도 relocation_candidate 를 끈다).
  expect(canRecoverMoved(lock({ relocation_candidate: true, recovery_id: rid }))).toBe(false)
})
