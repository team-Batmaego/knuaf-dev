import { useState, type ReactNode } from 'react'
import { CHAT, CLOSE_LABEL, REPORT } from '../copy'
import { Icon } from './Icon'

/**
 * 입력칸 위 한 줄 알림(형님 확정 2026-10-19 알림창 B안) — 대화 화면의 기다림·경고·오류는 모두 여기 한 자리다.
 * 바탕은 옅은 회색(`--panel-2`) 하나, 색은 아이콘에만. 기다림은 빙글이 + 끝나면 저절로 사라짐(닫기 없음),
 * 경고·오류는 아이콘 + ✕ + "자세히"(원문). 허락·질문 카드가 입력칸 자리를 차지하면 그 카드 위에 선다.
 *
 * 작업 분담 줄(설계 §2-1 U6-05)은 이 모양을 그대로 쓰되 줄 자체에 role 을 주지 않는다 —
 * 낭독은 `LaneZone` 의 전용 칸이 한 문장으로 맡는다(같은 말이 두 번 읽히지 않게).
 * 기본값은 지금까지의 규칙 그대로: bad 만 `alert`, 나머지는 `status`.
 */
export type ZoneTone = 'wait' | 'bad' | 'attn' | 'info'
export function ZoneLine({ tone, title, sub, raw, actions, onClose, onReport, role, id }: {
  tone: ZoneTone; title: ReactNode; sub?: ReactNode; raw?: string; actions?: ReactNode
  onClose?: () => void; onReport?: () => void
  /** 줄 자체의 역할. `none` 이면 아무 역할도 주지 않는다(작업 분담 줄). */
  role?: 'alert' | 'status' | 'none'
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const lineRole = role === 'none' ? undefined : (role ?? (tone === 'bad' ? 'alert' : 'status'))
  return (
    <div className="zline-wrap">
      <div id={id} className={`zline ${tone}`} role={lineRole}>
        {tone === 'wait' ? <span className="spin" /> : <Icon name={tone === 'info' ? 'info' : 'warn'} size={16} className={`ic ${tone}`} />}
        <span className="grow">{title}{sub && <small>{sub}</small>}</span>
        {actions}
        {raw && <button type="button" className="lk" aria-expanded={open} onClick={() => setOpen(!open)}>{CHAT.details}</button>}
        {onReport && <button type="button" className="lk" onClick={onReport}>{REPORT.inline}</button>}
        {onClose && <button type="button" className="zx" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} onClick={onClose}>✕</button>}
      </div>
      {raw && open && <code className="zline-raw">{raw}</code>}
    </div>
  )
}
