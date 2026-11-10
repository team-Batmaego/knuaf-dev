import { Fragment, useEffect, useRef, useState } from 'react'
import type { CardAction, CardInvalidReason, CardRow, LaneCard } from '../../../shared/lanes-ipc'
import type { LaneEntry } from '../../../shared/lanes'
import { LANE_CARD, LANE_NAME, depthName, modelLabel, modelName, providerName } from '../copy-lanes'
import { appliedText, rejectedText } from '../laneLines'
import { Icon } from './Icon'

/**
 * 배치 카드 — 설계 §3. 대화 흐름 안에 앉고 **입력칸 자리를 차지하지 않는다**(정본 §3.7: 막으면 안 된다).
 * 카드 값은 전부 main이 계산해 보낸 것을 그대로 보인다: 바뀌는 줄(`rows`), 거절 사유, 요금 안내, 적용 범위.
 * 화면이 정하는 것은 셋뿐이다 — 단추 이름의 "n개", 접힌 줄 문구, 그리고 10초 무응답 안내.
 *
 * 승인은 main이 카드 id 단위로 원자적으로 소비한다(계약 `decideCard`). 화면은 `baseVersion`을 그대로
 * 돌려보내고, 결과는 밀려온 새 묶음의 `state`로만 그린다 — 두 번째 누름부터는 `already-handled`다.
 */
export function LanePlanCard({ card, invalidReason = null, onDecide, onStatus }: {
  card: LaneCard
  /** 계약 `CardDecision.reason` — 응답에만 실려 store 가 카드 id로 모아 둔 값. */
  invalidReason?: CardInvalidReason | null
  onDecide: (cardId: string, baseVersion: number, action: CardAction) => void
  onStatus: (cardId: string) => void
}) {
  const [pressed, setPressed] = useState<CardAction | null>(null)
  const [slow, setSlow] = useState(false)
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(false)
  const folded = useRef<HTMLButtonElement>(null)
  const state = card.state
  const settled = state.kind !== 'open' && state.kind !== 'applying'

  // 누른 뒤 10초 안에 새 상태가 안 오면 "확인하지 못했어요" — 다시 적용하지 않고 상태만 다시 묻는다.
  useEffect(() => {
    if (!pressed || settled) return
    const timer = window.setTimeout(() => setSlow(true), 10_000)
    return () => window.clearTimeout(timer)
  }, [pressed, settled])

  // 누른 카드가 접히면 초점은 접힌 줄의 [자세히]로(설계 §3-5).
  useEffect(() => {
    if (settled && pressed) folded.current?.focus()
  }, [settled, pressed])

  const first = card.variant === 'first' || card.variant === 'settings-enable'
  const settings = card.variant === 'settings-enable' || card.variant === 'settings-revert'
  const busy = state.kind === 'applying' || (pressed !== null && state.kind === 'open' && !slow)

  if (settled) {
    return (
      <div className="lane-card folded" id={`lane-card-${card.cardId}`} tabIndex={-1}>
        <div className="lane-folded">
          <span className="dot" aria-hidden="true"><Icon name="check" size={14} /></span>
          <span>{foldedText(card, first, state, invalidReason)}</span>
          <button type="button" className="lk" ref={folded} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? LANE_CARD.folded.detailsClose : LANE_CARD.folded.details}
          </button>
        </div>
        {open && <CardBody card={card} first={first} settings={settings} detail setDetail={() => undefined} readOnly />}
      </div>
    )
  }

  const changed = card.rows.filter((row) => row.after && !row.rejected).length
  const allRejected = changed === 0
  const allApplied = changed === card.rows.length
  const scope = settings ? LANE_CARD.scopeSettings : LANE_CARD.scope(first)
  const actions: { action: CardAction; label: string; look: string }[] = []
  if (settings) {
    actions.push({ action: 'continue', label: LANE_CARD.act.settingsContinue, look: 'primary' })
    actions.push({ action: 'cancel', label: LANE_CARD.act.cancel, look: 'quiet' })
  } else if (card.variant === 'first') {
    actions.push({ action: 'continue', label: allRejected ? LANE_CARD.act.ack : LANE_CARD.act.continue, look: 'primary' })
    if (!allRejected) actions.push({ action: 'once', label: LANE_CARD.act.once, look: '' })
    actions.push({ action: 'decline', label: LANE_CARD.act.decline, look: 'quiet' })
  } else if (allRejected) {
    actions.push({ action: 'ack', label: LANE_CARD.act.ack, look: 'primary' })
  } else {
    actions.push({ action: 'continue', label: allApplied ? LANE_CARD.act.allContinue : LANE_CARD.act.changeContinue(changed), look: 'primary' })
    actions.push({ action: 'once', label: allApplied ? LANE_CARD.act.allOnce : LANE_CARD.act.changeOnce(changed), look: '' })
    actions.push({ action: 'cancel', label: LANE_CARD.act.cancel, look: 'quiet' })
  }

  const decide = (action: CardAction): void => {
    setPressed(action)
    setSlow(false)
    onDecide(card.cardId, card.baseVersion, action)
  }

  return (
    <div className="lane-card" id={`lane-card-${card.cardId}`} role="group" aria-labelledby={`lane-card-title-${card.cardId}`} tabIndex={-1}>
      <h3 id={`lane-card-title-${card.cardId}`}>{LANE_CARD.title[card.variant]}</h3>
      {card.variant === 'first' && <p className="lead">{LANE_CARD.firstLead}</p>}
      {card.reviewDue && <p className="lead">{LANE_CARD.reviewDue}</p>}
      {card.quote && <p className="quote">{LANE_CARD.quote(card.quote)}</p>}
      <CardBody card={card} first={first} settings={settings} detail={detail} setDetail={setDetail} />
      {card.fastDrain && <p className="scope">ⓘ {LANE_CARD.fastDrain}</p>}
      <div className="lane-actions">
        {actions.map((item) => (
          <button
            key={item.action}
            type="button"
            className={item.look || undefined}
            disabled={busy}
            onClick={() => decide(item.action)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {busy && <p className="data" role="status">{LANE_CARD.acting}</p>}
      {slow && state.kind === 'open' && (
        <p className="data" role="alert">
          {LANE_CARD.unknown}{' '}
          <button type="button" className="lk" onClick={() => onStatus(card.cardId)}>{LANE_CARD.recheck}</button>
        </p>
      )}
      <p className="scope">{scope}</p>
    </div>
  )
}

/** 카드 본문 — 열린 카드와 접힌 카드의 [자세히]가 같은 것을 보여 준다(읽기 전용이면 단추 없음). */
function CardBody({ card, first, settings, detail, setDetail, readOnly = false }: {
  card: LaneCard
  first: boolean
  settings: boolean
  detail: boolean
  setDetail: (value: boolean) => void
  readOnly?: boolean
}) {
  const design = card.rows.find((row) => row.lane === 'design')
  const rows = card.rows.filter((row) => row.lane !== 'design')
  const missing = card.fees.filter((fee) => !fee.consented)
  const consentedOnly = missing.length === 0 && card.fees.length > 0
  return (
    <>
      {rows.length > 0 && (
        <dl className="lane-dl">
          {rows.map((row) => (
            <Fragment key={row.lane}><Row row={row} /></Fragment>
          ))}
          {(design || card.variant === 'first') && (
            <div className="chipref">
              {LANE_CARD.chipref(card.recommendedDesign ? modelLabel(card.recommendedDesign) : null)}
            </div>
          )}
        </dl>
      )}
      {!readOnly && (
        <p className="data">
          {LANE_CARD.readScope}{' '}
          <button type="button" className="lk" aria-expanded={detail} onClick={() => setDetail(!detail)}>
            {detail ? LANE_CARD.quoteLess : LANE_CARD.quoteMore}
          </button>
        </p>
      )}
      {detail && <p className="data">{LANE_CARD.readScopeDetail}</p>}
      {missing.length > 0 && (
        <div className="lane-risk">
          <span className="i">ⓘ</span>
          {missing.map((fee) => (
            <Fragment key={fee.company}>{LANE_CARD.feeNotConsented(providerName(fee.company))} </Fragment>
          ))}
          {LANE_CARD.feeIntro}
          <ul>
            <li>{LANE_CARD.feeApp}</li>
            {card.fees.some((fee) => fee.company === 'codex') && <li>{LANE_CARD.feeSpawn}</li>}
          </ul>
          {missing.map((fee) => (
            <Fragment key={fee.company}>{LANE_CARD.feeConsent(providerName(fee.company), fee.accountLabel)} </Fragment>
          ))}
        </div>
      )}
      {consentedOnly && (
        <div className="lane-risk">
          <span className="i">ⓘ</span>
          {card.fees.map((fee, index) => (
            <Fragment key={fee.company}>
              {index > 0 ? ' ' : ''}
              {LANE_CARD.feeAlready(providerName(fee.company), fee.accountLabel)}
            </Fragment>
          ))}
        </div>
      )}
      {!settings && <p className="scope">{LANE_CARD.scope(first)}</p>}
      {design?.designSwitchTo && <p className="scope">{LANE_CARD.designSwitch(providerName(design.designSwitchTo))}</p>}
    </>
  )
}

/** 한 줄: 역할 · 이전 → 새. 거절이면 ✕ + "적용 안 함 — {이유}". */
function Row({ row }: { row: CardRow }) {
  if (row.rejected) {
    return (
      <>
        <dt>{LANE_NAME[row.lane]}</dt>
        <dd className="rej">
          <Icon name="x" size={14} className="ic" />
          <span><b>{LANE_CARD.rowRejected}</b> — {LANE_CARD.reject[row.rejected]}</span>
        </dd>
      </>
    )
  }
  return (
    <>
      <dt>{LANE_NAME[row.lane]}</dt>
      <dd>
        {row.before && (
          <>
            <span className="was">{entryText(row.before)}</span>
            <span className="arrow">→</span>
          </>
        )}
        {row.after ? entryText(row.after) : '—'}
      </dd>
    </>
  )
}

/** "ChatGPT · Astra · 높게" + 새 대화에서 하는 역할이면 "· 새 대화". */
function entryText(entry: LaneEntry): string {
  const model = modelName(entry.model) || '기본'
  const parts = [providerName(entry.company), model, depthName(entry.effort)]
  if (entry.how === 'sub') parts.push('새 대화')
  return parts.join(' · ')
}

/** 접힌 카드 한 줄 — 설계 §3-5 원문. `card.rows` 하나만 읽어 실제로 바뀐 줄을 나열한다(적용 = `rejected === null`). */
function foldedText(card: LaneCard, first: boolean, state: LaneCard['state'], invalidReason: CardInvalidReason | null): string {
  switch (state.kind) {
    case 'applied': {
      const applied = card.rows
        .filter((row) => row.after && !row.rejected)
        .map((row) => appliedText(row.lane, row.after!))
      const rejected = card.rows
        .filter((row) => row.rejected)
        .map((row) => rejectedText(row.lane, row.rejected!, LANE_CARD.rejectShort))
      return LANE_CARD.folded.applied(
        first,
        applied.length > 0 ? applied.join(' · ') : LANE_CARD.folded.cancelled,
        state.scope === 'continue' ? '계속' : '이번만',
        rejected
      )
    }
    case 'declined':
      return LANE_CARD.folded.declined
    case 'cancelled':
      return LANE_CARD.folded.cancelled
    case 'invalid':
      // [r3c C0] 계정이 바뀌어 거절된 카드는 다른 한 줄로 접힌다 — 사유는 응답(`CardDecision.reason`)에서 왔다.
      return invalidReason === 'account-changed' ? LANE_CARD.folded.accountChanged : LANE_CARD.folded.invalid
    case 'superseded':
      return LANE_CARD.folded.superseded
    default:
      return LANE_CARD.folded.cancelled
  }
}
