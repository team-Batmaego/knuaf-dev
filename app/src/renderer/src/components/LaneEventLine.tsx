import { useState } from 'react'
import type { LaneEventView } from '../laneLines'
import { LANE_ACTION, LANE_EVENT } from '../copy-lanes'
import { Icon } from './Icon'
import { useDeliveryText, type DeliveryRead } from './useDeliveryText'

/**
 * 작업 분담 기록 줄 — 설계 §2-2. 기존 `EventLine`(`.chat-event`)과 같은 모양을 쓰되
 * 절 저장 사실이 아니라 **무슨 일이 있었는지**를 남긴다.
 *
 * `archiveId` 가 있으면(`handoff-done`) [멈춘 대화 보기] 단추를 붙인다 — 이어 받은 대화 첫 줄이
 * 옛 대화로 가는 유일한 길이다(설계 §4-2).
 *
 * 줄의 `task` 는 40자로 접혀 있다(설계 §2-2). 전체 주문과 전달문 원문은 [자세히]로만 연다 —
 * 읽기만 하고 다시 넘기지 않는다(검토 C06).
 */
export function LaneEventLine({ view, onArchive, root, onDeliveryText }: {
  view: LaneEventView
  onArchive?: (archiveId: string) => void
  /** 전달문을 읽을 폴더 — 없으면 [자세히]를 붙이지 않는다. */
  root?: string
  /** `jobs.deliveryText` — 통로 오류는 `null`(읽기 실패), 값이 없으면 `{ text: null }`. */
  onDeliveryText?: DeliveryRead
}) {
  const [open, setOpen] = useState(false)
  const delivery = useDeliveryText(onDeliveryText, root, view.jobId)
  return (
    <div className={view.warn ? 'chat-event warn' : 'chat-event'}>
      {/* 시안 `v07.r3.html:103` — 경고 기록 줄은 ⚠ 글리프, 보통 줄은 가운뎃점(검토 C2-V02). */}
      <Icon name={view.warn ? 'warn' : 'circle'} size={12} />
      <span>{view.text}</span>
      {view.archiveId && onArchive && (
        <button type="button" className="lk" onClick={() => onArchive(view.archiveId!)}>{LANE_EVENT.archiveLink}</button>
      )}
      {delivery.canRead && (
        <button
          type="button"
          className="lk"
          aria-expanded={open}
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) delivery.load()
          }}
        >
          {LANE_ACTION.details}
        </button>
      )}
      {delivery.canRead && open && (delivery.state.kind === 'text' || delivery.state.kind === 'failed') && (
        <code className="zline-raw">
          {delivery.state.kind === 'failed'
            ? LANE_EVENT.deliveryTextFailed
            : delivery.state.text ?? LANE_EVENT.deliveryTextMissing}
        </code>
      )}
    </div>
  )
}
