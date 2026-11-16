import { useState, type ReactNode } from 'react'
import { CHAT, CLOSE_LABEL, REPORT } from '../copy'
import { LANE_EVENT } from '../copy-lanes'
import { useDeliveryText, type DeliveryRead } from './useDeliveryText'
import { Icon } from './Icon'

/**
 * 입력칸 위 한 줄 알림(형님 확정 2026-10-19 알림창 B안) — 대화 화면의 기다림·경고·오류는 모두 여기 한 자리다.
 * 바탕은 옅은 회색(`--panel-2`) 하나, 색은 아이콘에만. 기다림은 빙글이 + 끝나면 저절로 사라짐(닫기 없음),
 * 경고·오류는 아이콘 + ✕ + "자세히"(원문). 허락·질문 카드가 입력칸 자리를 차지하면 그 카드 위에 선다.
 *
 * 작업 분담 줄(설계 §2-1 U6-05)은 이 모양을 그대로 쓰되 줄 자체에 role 을 주지 않는다 —
 * 낭독은 `LaneZone` 의 전용 칸이 한 문장으로 맡는다(같은 말이 두 번 읽히지 않게).
 * 기본값은 지금까지의 규칙 그대로: bad 만 `alert`, 나머지는 `status`.
 *
 * 작업 분담 줄은 [자세히] 하나로 **상태 원문**(`raw`)과 **전달문 원문**(`jobs.deliveryText`)을 함께 편다 —
 * 단추를 둘로 나누면 학생이 어느 것을 눌러야 하는지 모른다(검토 C06). 전달문은 펼칠 때 한 번만 읽는다.
 */
export type ZoneTone = 'wait' | 'bad' | 'attn' | 'info'
export function ZoneLine({ tone, title, sub, raw, rawTitle, actions, onClose, onReport, role, id, detailFirst, root, jobId, onDeliveryText }: {
  tone: ZoneTone; title: ReactNode; sub?: ReactNode; raw?: string; actions?: ReactNode
  onClose?: () => void; onReport?: () => void
  /** 줄 자체의 역할. `none` 이면 아무 역할도 주지 않는다(작업 분담 줄). */
  role?: 'alert' | 'status' | 'none'
  id?: string
  /** [자세히]를 단추들 **앞**에 둔다 — 작업 분담 줄의 기본(설계 §2-1). 기존 줄은 그대로 뒤에 둔다. */
  detailFirst?: boolean
  /** 상태 원문(`raw`) 위에 붙는 제목 — 어느 줄의 원문인지 알려 준다. */
  rawTitle?: string
  /** 전달문을 읽을 폴더·주문 — 둘 다 있어야 [자세히]가 전달문까지 편다. */
  root?: string; jobId?: string
  /** `jobs.deliveryText` — 통로 오류는 `null`(읽기 실패), 값이 없으면 `{ text: null }`. */
  onDeliveryText?: DeliveryRead
}) {
  const [open, setOpen] = useState(false)
  const delivery = useDeliveryText(onDeliveryText, root, jobId)
  const lineRole = role === 'none' ? undefined : (role ?? (tone === 'bad' ? 'alert' : 'status'))
  /** [자세히]는 **상태 원문이 있는 줄**에만 붙는다(설계 §2-1) — 전달문은 그 원문에 덧붙는 둘째 사실이다. */
  const hasDetail = !!raw
  const readDelivery = delivery.canRead && hasDetail
  /** 읽는 중에는 빈 자리를 두지 않는다 — 펼치면 원문이 먼저 보이고 전달문이 뒤따라 붙는다. */
  const deliveryText =
    delivery.state.kind === 'failed'
      ? LANE_EVENT.deliveryTextFailed
      : delivery.state.kind === 'text'
        ? (delivery.state.text ?? LANE_EVENT.deliveryTextMissing)
        : ''
  const details = hasDetail && (
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
      {CHAT.details}
    </button>
  )
  return (
    <div className="zline-wrap">
      <div id={id} className={`zline ${tone}`} role={lineRole}>
        {tone === 'wait' ? <span className="spin" /> : <Icon name={tone === 'info' ? 'info' : 'warn'} size={16} className={`ic ${tone}`} />}
        <span className="grow">{title}{sub && <small>{sub}</small>}</span>
        {detailFirst && details}
        {actions}
        {!detailFirst && details}
        {onReport && <button type="button" className="lk" onClick={onReport}>{REPORT.inline}</button>}
        {onClose && <button type="button" className="zx" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} onClick={onClose}>✕</button>}
      </div>
      {hasDetail && open && (
        <code className="zline-raw">
          {rawTitle ? <b>{rawTitle}{'\n'}</b> : null}
          {raw}
          {deliveryText && (
            <>
              {'\n'}
              {deliveryText}
            </>
          )}
        </code>
      )}
    </div>
  )
}
