import { useEffect, useRef, useState } from 'react'
import type { ArchivedChat, ArchivedChatSummary } from '../../../shared/lanes-ipc'
import type { ChatMessage } from '../../../shared/chat'
import { LANE_ARCHIVE, LANE_EVENT, modelLabel, stampKo } from '../copy-lanes'
import { Icon } from './Icon'

/**
 * 한도로 멈춘 대화 보기(설계 §4-2) — **읽기 전용**.
 *
 * 말풍선은 대화 칸의 것과 같은 모양(`.chat-msg`)으로 그리되 앱이 아는 것만 그린다:
 * 다시 보내기·파일 링크·접기·인용 같은 살아 있는 동작은 붙이지 않는다(D7-02 "새 차례를 받지 않는다").
 * 맨 끝에는 그 대화가 어떻게 끝났는지 기록 줄 하나를 붙인다 — 저장된 사건이 아니라 보관 요약이 말해 준다.
 *
 * 입력칸 자리는 info 줄이 차지한다. 쓸 수 없음을 자리로 보이고, 돌아가기 단추가 그 자리에 있다.
 * 이 화면에서는 지금 대화의 작업 분담 줄을 부모가 숨긴다(옛 대화의 단추를 잘못 누르지 않게).
 */
export function StoppedChatView({ chat, others, notices, loading, error, onBack, onOpen }: {
  chat: ArchivedChat | null
  /** [다른 멈춘 대화 ▾] — 보관이 둘 이상일 때만 펼친다. */
  others: ArchivedChatSummary[]
  /** 지금 대화에 떠 있는 안내 건수(작업 분담 줄). 0이면 작은 글에 안 붙인다. */
  notices: number
  loading: boolean
  error: string | null
  onBack: () => void
  onOpen: (archiveId: string) => void
}) {
  const back = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const list = others.filter((a) => a.archiveId !== chat?.summary.archiveId)
  // 보관 대화를 열면 초점은 돌아가기 단추로 — 읽기 전용 화면에서 유일하게 할 일이다.
  useEffect(() => { back.current?.focus() }, [])
  const summary = chat?.summary
  const sub = summary
    ? [LANE_ARCHIVE.bannerSub(modelLabel({ company: summary.company, model: summary.model }), stoppedStamp(summary.stoppedAt)),
        notices > 0 ? LANE_ARCHIVE.notices(notices) : null].filter(Boolean).join(' · ')
    : undefined
  return (
    <>
      <div className="chat-thread" aria-busy={loading || undefined}>
        {loading && <p className="caption">불러오는 중…</p>}
        {error && <p className="caption">{error}</p>}
        {chat && (
          <>
            {chat.messages.map((m) => <Frozen key={m.id} m={m} />)}
            <div className="chat-event warn" role="status">
              <span aria-hidden="true">⚠</span>
              <span>{LANE_EVENT.handoffEnd(modelLabel(chat.summary.successor))}</span>
            </div>
          </>
        )}
      </div>
      <div className="chat-zone">
        <div className="zline-wrap stopped-banner">
          <div className="zline info" role="region" aria-label="한도로 멈춘 대화">
            <Icon name="info" size={16} />
            <span className="grow">{LANE_ARCHIVE.bannerTitle}{sub && <small>{sub}</small>}</span>
            <button type="button" className="primary" ref={back} onClick={onBack}>{LANE_ARCHIVE.back}</button>
            {list.length > 0 && (
              <span className="stopped-others">
                <button type="button" className="quiet" aria-expanded={menu} onClick={() => setMenu(!menu)}>{LANE_ARCHIVE.others}</button>
                {menu && (
                  <div className="lane-pick" role="group" aria-label={LANE_ARCHIVE.others}>
                    {list.map((a) => (
                      <button key={a.archiveId} type="button" className="quiet" onClick={() => { setMenu(false); onOpen(a.archiveId) }}>
                        {modelLabel({ company: a.company, model: a.model })} · {stoppedStamp(a.stoppedAt)}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/** 보관 대화의 말풍선 하나 — 앱이 이미 아는 글자만 그린다(링크·재전송·접기 없음). */
function Frozen({ m }: { m: ChatMessage }) {
  if (m.role === 'system') return <div className="chat-msg system"><span className="caption">{m.text}</span></div>
  return <div className={`chat-msg ${m.role}`}><div className="prose">{m.text}</div></div>
}

/** "11월 8일 오후 2:40" — 보관 요약의 시각은 절대 시각이라 지난 날에도 같은 글이다. */
function stoppedStamp(iso: string): string {
  return stampKo(iso) || iso
}
