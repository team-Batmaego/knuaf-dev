/**
 * §3 [이번만] 차례 끝(Q5) — 묶인 차례가 끝나고 그 차례 주문이 모두 끝났으면 배치를 접고
 * `once-ended` 를 남긴다.
 *
 * 승인 배치(폴더 단위)는 건드리지 않는다: 처음 카드의 [이번만]이 끝나면 상태가 "아직 정하지
 * 않았어요"로 돌아가고(`afterFirst`), 요금 동의(계정 단위)는 그대로 남는다(UI-DESIGN §3).
 * 접을 때 실제로 지웠을 때만 기록을 남긴다 — 두 번 남기면 기록 줄이 두 개가 된다.
 */
import { randomUUID } from 'node:crypto'
import type { JobRecord } from '../chat/jobs/types'
import type { JobStore } from '../chat/jobs/store'
import { canonical } from '../chat/jobs/isolation'

/** 지금까지 살아 있는 주문이 있는가 — 대기·진행·한도 판정 중이면 아직 차례가 안 끝났다. */
function live(records: JobRecord[], root: string): boolean {
  return records.some(record => record.root === root &&
    (record.status === 'queued' || record.status === 'running' || record.status === 'limit'))
}

/**
 * 끌 차례가 있으면 접는다. 접었으면 `true` — 부른 쪽이 묶음을 다시 지어 보내는 근거다.
 * `records` 는 러너가 준 것 그대로(없으면 빈 배열).
 */
export function settleTemporary(store: JobStore, records: JobRecord[], root: string): boolean {
  const temporary = store.temporary(root)
  if (!temporary) return false
  if (live(records, canonical(root))) return false
  if (!store.clearTemporary(root)) return false
  store.addEvent(root, {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: 'once-ended',
    // 처음 카드였으면 승인 배치가 없다 — 화면은 "다음에 나눠 맡길 때 다시 물어봐요"를 그린다.
    afterFirst: store.approvedPlan(root) === null
  })
  return true
}
