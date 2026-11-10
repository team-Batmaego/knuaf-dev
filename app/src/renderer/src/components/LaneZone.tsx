import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { LaneAnnouncement, LaneLine } from '../../../shared/lanes-ipc'
import type { LaneActionId, LaneLineView } from '../laneLines'
import { LESS_LABEL, moreLabel, sayText, tierGroups } from '../laneLines'
import { ZoneLine } from './ZoneLine'

/**
 * 작업 분담 알림 줄(설계 §2-0·§2-1) — `chat-zone` 안 `to-bottom` 바로 아래, 기존 줄보다 위.
 *
 * 종류(1~5)마다 **한 줄만** 보이고 나머지는 [n건 더 보기] 뒤에 각자 단추와 함께 펼쳐진다.
 * 줄 자체에는 role 을 주지 않는다(막힘만 `alert`) — 같은 말이 두 번 읽히지 않게 낭독은 늘 있는
 * `.sr-only` 한 칸(`#lane-say`)이 `announcement.seq` 가 바뀔 때만 맡는다.
 */
export function LaneZone({ lines, announcement, onAction, onShowCard }: {
  lines: LaneLine[]
  announcement: LaneAnnouncement | null
  onAction: (action: LaneActionId, line: LaneLine) => void
  /** 미결 카드 [카드 보기] — 카드 제목으로 스크롤·초점. */
  onShowCard: (cardId: string) => void
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  /** "{n}분째"만 시계로 센다 — 30초마다 새 값(설계 §2-1: 낭독 칸 밖). */
  const [now, setNow] = useState(() => Date.now())
  const ticking = lines.some((line) => line.kind === 'progress' && line.phase === 'running')
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [ticking])

  const groups = useMemo(() => tierGroups(lines, now), [lines, now])
  const said = sayText(announcement, lines, now)
  /**
   * 낭독 칸 글은 **사건(`seq`)이 바뀔 때만** 갈아 끼운다 — 경과 분 변화로 다시 읽히면 안 된다.
   * 칸 자체는 줄이 없을 때도 늘 그려 둔다(나중에 생기면 낭독기가 그 칸을 모른다).
   */
  const [spoken, setSpoken] = useState('')
  const lastSeq = useRef(-1)
  useEffect(() => {
    if (!announcement || announcement.seq === lastSeq.current || !said) return
    lastSeq.current = announcement.seq
    setSpoken(said)
  }, [announcement, said])

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" id="lane-say">{spoken}</div>
      {groups.map((group) => {
        const [head, ...rest] = group.lines
        const open = !!expanded[group.tier]
        const toggle = (on: boolean) => setExpanded((prev) => ({ ...prev, [group.tier]: on }))
        return (
          <Fragment key={group.tier}>
            <LaneZoneLine view={head.view} line={head.line} onAction={onAction} onShowCard={onShowCard}
              more={rest.length > 0 && !open ? { count: rest.length, onOpen: () => toggle(true) } : undefined}
              less={rest.length > 0 && open ? { onClose: () => toggle(false) } : undefined} />
            {open && rest.map(({ view, line }) => (
              <LaneZoneLine key={view.id} view={view} line={line} onAction={onAction} onShowCard={onShowCard} />
            ))}
          </Fragment>
        )
      })}
    </>
  )
}

function LaneZoneLine({ view, line, onAction, onShowCard, more, less }: {
  view: LaneLineView
  line: LaneLine
  onAction: (action: LaneActionId, line: LaneLine) => void
  onShowCard: (cardId: string) => void
  more?: { count: number; onOpen: () => void }
  less?: { onClose: () => void }
}) {
  const actions = (
    <>
      {view.actions.map((action) => (
        <button key={action.id} type="button" className={action.look ?? 'lk'}
          onClick={() => onAction(action.id, line)}>{action.label}</button>
      ))}
      {more && <button type="button" className="lk more" aria-expanded={false} onClick={more.onOpen}>{moreLabel(more.count)}</button>}
      {less && <button type="button" className="lk more" aria-expanded onClick={less.onClose}>{LESS_LABEL}</button>}
    </>
  )
  return (
    <ZoneLine tone={view.tone} title={view.title} sub={subOf(view.sub)} raw={view.detail}
      detailFirst={!view.detailAfterActions}
      role={view.alert ? 'alert' : 'none'} id={view.id} actions={actions}
      onClose={view.close ? () => onAction('dismiss', line) : undefined} />
  )
}

/** 작은 글의 `\n` 은 줄바꿈 — 시안 `limit`·`card1` 과 같은 모양. */
function subOf(sub: string | undefined) {
  if (!sub) return undefined
  return sub.split('\n').map((part, index) => <Fragment key={index}>{index > 0 && <br />}{part}</Fragment>)
}
