import type { LaneEventView } from '../laneLines'
import { LANE_EVENT } from '../copy-lanes'
import { Icon } from './Icon'

/**
 * 작업 분담 기록 줄 — 설계 §2-2. 기존 `EventLine`(`.chat-event`)과 같은 모양을 쓰되
 * 절 저장 사실이 아니라 **무슨 일이 있었는지**를 남긴다.
 *
 * `archiveId` 가 있으면(`handoff-done`) [멈춘 대화 보기] 단추를 붙인다 — 이어 받은 대화 첫 줄이
 * 옛 대화로 가는 유일한 길이다(설계 §4-2).
 */
export function LaneEventLine({ view, onArchive }: { view: LaneEventView; onArchive?: (archiveId: string) => void }) {
  return (
    <div className={view.warn ? 'chat-event warn' : 'chat-event'}>
      <Icon name="circle" size={12} />
      <span>{view.text}</span>
      {view.archiveId && onArchive && (
        <button type="button" className="lk" onClick={() => onArchive(view.archiveId!)}>{LANE_EVENT.archiveLink}</button>
      )}
    </div>
  )
}
