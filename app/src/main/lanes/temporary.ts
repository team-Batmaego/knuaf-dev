/**
 * §3 [이번만] 차례 끝(Q5) — 묶인 차례가 끝나고 그 차례 주문이 모두 끝났으면 배치를 접고
 * `once-ended` 를 남긴다.
 *
 * 승인 배치(폴더 단위)는 건드리지 않는다: 처음 카드의 [이번만]이 끝나면 상태가 "아직 정하지
 * 않았어요"로 돌아가고(`afterFirst`), 요금 동의(계정 단위)는 그대로 남는다(UI-DESIGN §3).
 * 접을 때 실제로 지웠을 때만 기록을 남긴다 — 두 번 남기면 기록 줄이 두 개가 된다.
 *
 * **[C1-04] 어느 주문이 [이번만]을 붙잡는가** — 두 축으로 좁힌다. 둘 다 차례 id 없이 판정된다.
 *
 * ① **누른 뒤에 만든 주문만** 센다. UI-DESIGN §3 은 "[이번만]은 그 차례 안에서 **누른 뒤에**
 *    만든 주문서에만 쓴다(소급하지 않음)" 이므로, 승인 시각보다 먼저 만들어진 주문은 이 승인과
 *    무관하다 — 그게 `limit` 로 남아 있다고 임시 승인을 살려 두면 **승인이 넘친다**(판정서
 *    C1-04: 과거 limit 하나로 [이번만]이 영원히 안 접혔다).
 * ② **학생 결정이 기록된 limit 은 미해결이 아니다.** 이어 받은 자식이 끝났거나, 학생이 [나중에]를
 *    골라 그 주문의 결과가 이미 넘어갔으면(전달 기록 있음) 그 주문은 더 물어볼 것이 없다.
 *
 * TODO(C4): 차례 id 가 생기면 ①을 "그 차례에 만든 주문" 으로 바꾼다. 지금은 승인 시각(`at`)을
 * 차례로 읽은 것이고, 승인 직전에 만든 주문이 아직 대기 중이면 그 주문이 임시 승인을 붙잡지
 * 않는다 — 그 주문은 승인 전 배치로 도는 것이 맞기 때문이다.
 */
import { randomUUID } from 'node:crypto'
import type { JobRecord } from '../chat/jobs/types'
import type { JobStore } from '../chat/jobs/store'
import { canonical } from '../chat/jobs/isolation'

/** 아직 학생이 결정하지 못한(또는 처리 중인) 주문인가. */
function pending(record: JobRecord): boolean {
  return record.status === 'queued' || record.status === 'running'
}

/**
 * 이 폴더에 **아직 미해결**인 주문이 있는가. `since` = [이번만] 승인 시각(ISO).
 * `records` 는 러너가 준 것 그대로(없으면 빈 배열).
 */
function live(store: JobStore, records: JobRecord[], root: string, since: string): boolean {
  const inFolder = records.filter(record => record.root === root)
  const latest = new Map<string, JobRecord>()
  for (const record of inFolder) latest.set(record.rootJobId, record)
  /** 이어 받은 자식이 이 부모의 일을 마쳤는가 — 자식이 아예 없으면 `false`(아직 안 끝남). */
  const continuedPast = (record: JobRecord): boolean => {
    const children = inFolder.filter(child => child.spec.parent === record.spec.id)
    if (!children.length) return false
    return children.some(child => {
      const latestChild = latest.get(child.rootJobId)
      return Boolean(latestChild) && !pending(latestChild!) && latestChild!.status !== 'limit'
    })
  }
  /** 학생이 이 주문에 대해 이미 결정했는가 — 결과가 넘어갔으면([나중에] 포함) 결정된 것이다. */
  const decided = (record: JobRecord): boolean => {
    try { return store.deliveryState(record.rootJobId) !== null } catch { return false }
  }
  return inFolder.some(record => {
    // ① 승인 전에 만든 주문은 이 승인과 무관하다(소급하지 않음).
    if (record.createdAt < since) return false
    if (pending(record)) return true
    if (record.status !== 'limit') return false
    // ② 학생 결정이 기록된 limit 은 미해결이 아니다.
    return !decided(record) && !continuedPast(record)
  })
}

/**
 * 끌 차례가 있으면 접는다. 접었으면 `true` — 부른 쪽이 묶음을 다시 지어 보내는 근거다.
 * `records` 는 러너가 준 것 그대로(없으면 빈 배열).
 */
export function settleTemporary(store: JobStore, records: JobRecord[], root: string): boolean {
  const temporary = store.temporary(root)
  if (!temporary) return false
  if (live(store, records, canonical(root), temporary.at)) return false
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
