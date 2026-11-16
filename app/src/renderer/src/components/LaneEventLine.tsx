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
  /** 전달문을 읽을 폴더 — 없으면 전달문은 못 읽지만, 주문 전문은 여전히 [자세히]로 연다. */
  root?: string
  /** `jobs.deliveryText` — 통로 오류는 `null`(읽기 실패), 값이 없으면 `{ text: null }`. */
  onDeliveryText?: DeliveryRead
}) {
  const [open, setOpen] = useState(false)
  const delivery = useDeliveryText(onDeliveryText, root, view.jobId)
  /**
   * [자세히]는 **원 주문이 있거나 전달문을 읽을 수 있으면** 붙는다 — 줄의 `text` 는 40자로 접힌
   * 요약이라, 주문 전문을 볼 길이 전달문 읽기 통로에만 매달리면 안 된다(검토 C06).
   */
  const hasDetail = !!view.task || delivery.canRead
  const readDelivery = delivery.canRead && hasDetail
  /** 읽는 중에는 빈 자리를 두지 않는다 — 주문이 먼저 보이고 전달문이 뒤따라 붙는다(`ZoneLine` 과 같은 규칙). */
  const deliveryText =
    delivery.state.kind === 'failed'
      ? LANE_EVENT.deliveryTextFailed
      : delivery.state.kind === 'text'
        ? (delivery.state.text ?? LANE_EVENT.deliveryTextMissing)
        : ''
  return (
    <div className="chat-event-wrap">
      <div className={view.warn ? 'chat-event warn' : 'chat-event'}>
        {/* 시안 `v07.r3.html:103` — 경고 기록 줄은 ⚠ 글리프, 보통 줄은 가운뎃점(검토 C2-V02). */}
        <Icon name={view.warn ? 'warn' : 'circle'} size={12} />
        <span>{view.text}</span>
        {view.archiveId && onArchive && (
          <button type="button" className="lk" onClick={() => onArchive(view.archiveId!)}>{LANE_EVENT.archiveLink}</button>
        )}
        {hasDetail && (
          <button
            type="button"
            className="lk"
            aria-expanded={open}
            onClick={() => {
              const next = !open
              setOpen(next)
              if (next && readDelivery) delivery.load()
            }}
          >
            {LANE_ACTION.details}
          </button>
        )}
      </div>
      {/* 본문은 flex 줄 **밖** 독립 블록이다 — 안에 두면 오른쪽 좁은 상자로 밀린다(검토 C06, `ZoneLine` 과 같은 모양). */}
      {hasDetail && open && (view.task || deliveryText) && (
        <code className="zline-raw">
          {view.task ? <b>{LANE_EVENT.detailTitle.task}{'\n'}</b> : null}
          {view.task}
          {deliveryText && (
            <>
              {view.task ? '\n' : null}
              <b>{LANE_EVENT.detailTitle.delivery}{'\n'}</b>
              {deliveryText}
            </>
          )}
        </code>
      )}
    </div>
  )
}
