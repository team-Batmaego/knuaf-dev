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

/**
 * 아직 **미해결**인 주문이 있는가.
 *
 * [C1-04] 예전에는 `status === 'limit'` 를 그대로 살아 있는 것으로 봤다. 그래서 이어 하기 자식이
 * `completed` 로 끝나도 부모는 `limit` 로 남아 있고, 그 폴더에 과거 한도 주문이 하나라도 있으면
 * `[이번만]` 이 영원히 안 접혔다 — 다음 학생 차례에도 "한 번만" 배치가 유효했다.
 *
 * 한도로 멈춘 주문은 **그 주문서를 이어 받은 자식이 끝났으면 미해결이 아니다**(부모의 일은
 * 자식이 마쳤다). `parent` 로 이어진 자식을 찾아 그 `rootJobId` 의 최신 기록이 끝났는지 본다.
 *
 * TODO(C4): 차례 id 가 생기면 "지금 차례의 주문만" 으로 더 좁힌다. 지금은 이어 하기 관계로만
 * 좁힌 것이고, 이어 하기 없이 한도로 끝난 과거 주문은 여전히 살아 있는 것으로 센다(보수적).
 */
function live(records: JobRecord[], root: string): boolean {
  const inFolder = records.filter(record => record.root === root)
  const latest = new Map<string, JobRecord>()
  for (const record of inFolder) latest.set(record.rootJobId, record)
  const settled = (rootJobId: string): boolean => {
    const record = latest.get(rootJobId)
    if (!record) return true
    if (record.status === 'queued' || record.status === 'running') return false
    return record.status !== 'limit'
  }
  return inFolder.some(record => {
    if (record.status === 'queued' || record.status === 'running') return true
    if (record.status !== 'limit') return false
    // 이어 받은 자식이 이 부모의 일을 마쳤으면 미해결이 아니다(자식이 아예 없으면 살아 있다).
    const children = inFolder.filter(child => child.spec.parent === record.spec.id)
    return children.length === 0 || !children.some(child => settled(child.rootJobId))
  })
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
