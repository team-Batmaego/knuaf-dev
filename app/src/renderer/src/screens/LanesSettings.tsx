import { useEffect, useRef, useState } from 'react'
import { WORK_LANES, LANE_TABLE, type LaneEntry } from '../../../shared/lanes'
import type { CardAction, CardInvalidReason, ConsentRow, LaneCard, LanesSettingsView, ReviewModelGroup, SettingsRow } from '../../../shared/lanes-ipc'
import { useLanes, laneActions } from '../store/lanes'
import { useProject } from '../store/project'
import { LANE_CARD, LANE_NAME, LANES_SETTINGS, depthName, modelLabel, modelName, providerName, dayKo } from '../copy-lanes'
import { isDirect } from '../laneLines'
import { Icon } from '../components/Icon'
import { Confirm } from '../components/Confirm'
import { LanePlanCard } from '../components/LanePlanCard'
import { Sheet } from '../components/Sheet'
import { Popover, PopHead, PopRow } from '../components/Popover'
import { decideIfCurrent, recheckIfCurrent, requestCard } from '../laneCardGate'

/**
 * 늦게 온 카드 응답이 지금 화면에 아직 유효한가 — 판정은 `laneCardGate` 에 두고, 이 파일은 그 값대로만
 * 움직인다(검토 C2-C02ⓑ). 설정 창은 폴더가 바뀌어도 계속 붙어 있으므로(`SettingsModal`) 옛 폴더의
 * 응답이 지금 폴더 화면에 닿을 수 있다. 시험은 화면 모듈에서 그대로 가져다 쓴다.
 */
export {
  cardStillApplies, cardUsable, decideIfCurrent, recheckIfCurrent, requestCard
} from '../laneCardGate'

/**
 * 설정 "작업 분담"(설계 §5) — 표는 main 이 밀어 준 `LanesSettingsView` 를 그대로 그리고,
 * 바꾸는 일은 모두 **배치 카드**로만 한다(켜기·되돌리기·검토 모델 고르기·동의).
 * [나눠 맡기기 끄기]만 확인 창을 거쳐 바로 적용된다.
 *
 * 폴더가 없으면 배치 묶음은 `noFolder` 한 줄이고, 동의 묶음은 계정 단위라 그대로 보인다.
 */
export function LanesSettings({ root }: { root: string | null }) {
  const snapshot = useLanes((s) => s.snapshot)
  // 다른 폴더의 묶음이 늦게 닿아도 이 논문의 배치로 보이면 안 된다(검토 C02).
  const view = snapshot && snapshot.root === root ? snapshot.settings : null
  /** 폴더 없이도 보이는 동의 묶음 — `consents()` 는 묶음 밖의 답이라 한 번 받아 둔다. */
  const [fetched, setFetched] = useState<ConsentRow[]>([])
  const [confirm, setConfirm] = useState<{ kind: 'consent' | 'withdraw'; row: ConsentRow } | null>(null)
  const [offConfirm, setOffConfirm] = useState(false)
  const [pick, setPick] = useState<{ open: boolean; loading: boolean; groups: ReviewModelGroup[] }>({ open: false, loading: false, groups: [] })
  /**
   * 켜기·되돌리기 카드는 `snapshot.cards` 에 오지 않는다(계약 §3 [F5] — 확정 순간에만 접힌 카드로
   * 들어간다). 그래서 응답 값을 화면이 들고 확인 창에 같은 카드 부품을 띄운다(설계 §3-3).
   */
  const [card, setCard] = useState<LaneCard | null>(null)
  const [cardInvalid, setCardInvalid] = useState<CardInvalidReason | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [cardError, setCardError] = useState(false)
  /** 확인 창을 닫으면 누른 설정 단추로 돌아간다(설계 §3-5 초점). */
  const trigger = useRef<HTMLButtonElement | null>(null)
  /** 대화에서 온 카드 요청(설계 §2-2 지속 안내) — 소비하면 store 가 비운다. */
  const cardRequest = useProject((s) => s.lanesCardRequest)
  const consumeLanesCardRequest = useProject((s) => s.consumeLanesCardRequest)

  /**
   * 설정 창은 대화 화면 없이도 열린다 — 이음매를 여기서도 붙이고 이 폴더의 묶음을 받는다.
   * `load` 는 폴더가 같으면 같은 내용이라 두 번 불러도 화면만 한 번 더 그린다.
   */
  useEffect(() => {
    const store = useLanes.getState()
    store.attach()
    void store.load(root)
    void store.callValue(({ lanes }) => lanes.consents()).then((r) => { if ('value' in r) setFetched(r.value) })
  }, [root])

  /**
   * 폴더를 옮기면 그 폴더의 카드는 뜻이 없다 — 설정 창은 대화 화면 없이도 열리고 폴더가 바뀌어도
   * 계속 붙어 있으므로(`SettingsModal`), 옛 카드를 들고 있으면 B 폴더 화면에서 A 폴더 카드를 승인한다
   * (검토 C2-C02ⓑ).
   */
  useEffect(() => {
    setCard(null)
    setCardOpen(false)
    setCardInvalid(null)
    setCardError(false)
  }, [root])

  const consents = view?.consents.length ? view.consents : fetched
  const actions = laneActions()

  const openPick = (company: ProviderOf<ReviewModelGroup>) => {
    if (!root) return
    setPick({ open: true, loading: true, groups: [] })
    void useLanes.getState().callValue(({ lanes }) => lanes.reviewModels(root)).then((r) => {
      setPick({ open: true, loading: false, groups: 'value' in r ? r.value : [] })
    })
  }

  /**
   * 켜기·되돌리기 — 응답 카드를 확인 창에 띄운다. 응답이 없으면 단추를 누른 자리에서 실패를 알린다
   * (묶음에는 카드가 오지 않으므로 기다려도 화면이 바뀌지 않는다).
   */
  const openCard = (kind: 'enable' | 'revert', button: HTMLButtonElement | null) => {
    if (!root) return
    trigger.current = button
    setCardError(false)
    const target = root
    void requestCard(target, (r) => actions.settingsCard(r, kind), () => useLanes.getState().root)
      .then((next) => {
        if (next.action === 'drop') return
        if (next.action === 'error') {
          setCardError(true)
          return
        }
        setCardError(false)
        setCardInvalid(null)
        setCard(next.card)
        setCardOpen(true)
      })
  }

  const closeCard = () => {
    setCardOpen(false)
    setCard(null)
    setCardInvalid(null)
    trigger.current?.focus()
  }

  /**
   * 대화의 [나눠 맡기기 켜기]는 설정 창을 열면서 카드 요청을 남긴다(설계 §2-2 지속 안내 → §5 상태 ③).
   * 설정 화면이 그 요청을 여기서 한 번만 소비해 확인 창을 띄운다 — 요청은 곧바로 비운다.
   */
  useEffect(() => {
    if (!cardRequest || !root) return
    consumeLanesCardRequest()
    openCard(cardRequest, null)
  })

  /** 확인 창의 결정 — 응답 카드로 접힘·무효를 그리고, 설정 묶음은 main 이 밀어 준다. */
  const decideCard = (cardId: string, baseVersion: number, action: CardAction) => {
    const send = laneActions().decideCard
    void decideIfCurrent(card, root, () => useLanes.getState().root, cardId, baseVersion, action, send)
      .then((next) => {
        if (next.action === 'drop') return
        if (next.action === 'error') {
          setCardError(true)
          return
        }
        setCardError(false)
        setCardInvalid(next.decision.outcome === 'invalid' ? next.decision.reason : null)
        setCard(next.decision.card)
      })
  }

  const recheckCard = (cardId: string) => {
    const send = laneActions().cardStatus
    void recheckIfCurrent(card, root, () => useLanes.getState().root, cardId, send)
      .then((next) => {
        if (next.action === 'drop') return
        if (next.action === 'error') {
          setCardError(true)
          return
        }
        setCardError(false)
        setCardInvalid(next.decision.outcome === 'invalid' ? next.decision.reason : null)
        setCard(next.decision.card)
      })
  }

  return (
    <div>
      {view?.mode === null || !view ? (
        <p className="caption">{LANES_SETTINGS.noFolder}</p>
      ) : view.mode === 'off' ? (
        <>
          <p style={{ fontSize: 14 }}>{LANES_SETTINGS.offBody}</p>
          <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
            <button type="button" className="primary" disabled={!root} onClick={(e) => openCard('enable', e.currentTarget)}>{LANES_SETTINGS.turnOn}</button>
          </div>
        </>
      ) : (
        <Placement view={view} root={root} onDisable={() => setOffConfirm(true)} onOpenCard={openCard}
          pick={pick} onOpenPick={openPick} onClosePick={() => setPick({ open: false, loading: false, groups: [] })} />
      )}
      {cardError && <p className="caption" role="alert" style={{ marginTop: 'var(--sp-2)' }}>{LANE_CARD.unknown}</p>}

      <h3 className="set-sub" style={{ marginTop: 'var(--sp-6)' }}>{LANES_SETTINGS.consentTitle}<span className="caption"> · {LANES_SETTINGS.consentNote}</span></h3>
      {consents.map((row) => (
        <div className="set-row2" key={`${row.company}:${row.accountId}`}>
          <span className="nm">{providerName(row.company)}</span>
          <span className="grow">{row.accountLabel}</span>
          <span className="caption">{consentText(row)}</span>
          {row.subscribed && (
            row.state === 'agreed'
              ? <button type="button" className="quiet" onClick={() => setConfirm({ kind: 'withdraw', row })}>{LANES_SETTINGS.consentWithdraw}</button>
              : <button type="button" className="quiet" onClick={() => setConfirm({ kind: 'consent', row })}>{row.state === 'withdrawn' ? LANES_SETTINGS.consentAgain : LANES_SETTINGS.consentAgree}</button>
          )}
        </div>
      ))}
      <p className="caption" style={{ marginTop: 'var(--sp-2)' }}>{LANES_SETTINGS.consentOnly}</p>

      <Confirm open={offConfirm} title={LANES_SETTINGS.offConfirmTitle} body={<p>{LANES_SETTINGS.offConfirmBody}</p>}
        confirmLabel={LANES_SETTINGS.turnOff} danger
        onCancel={() => setOffConfirm(false)}
        onConfirm={() => { setOffConfirm(false); if (root) void actions.disable(root) }} />
      <Confirm open={confirm !== null} danger={confirm?.kind === 'withdraw'}
        title={confirm?.kind === 'withdraw' ? LANES_SETTINGS.withdrawConfirmTitle : LANES_SETTINGS.consentConfirmTitle(providerName(confirm?.row.company ?? 'claude'))}
        confirmLabel={confirm?.kind === 'withdraw' ? LANES_SETTINGS.consentWithdraw : LANES_SETTINGS.consentYes}
        body={confirm && <FeeBox row={confirm.row} withdraw={confirm.kind === 'withdraw'} />}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm
          setConfirm(null)
          if (target) void actions.setConsent(target.row.company, target.row.accountId, target.kind !== 'withdraw')
        }} />
      <SettingsCardSheet open={cardOpen} card={card} invalidReason={cardInvalid}
        onDecide={decideCard} onStatus={recheckCard} onClose={closeCard} />
    </div>
  )
}

/**
 * 설정 확인 창 — 켜기·되돌리기의 승인 카드(설계 §3-3). 대화 카드와 **같은 부품**을 쓰므로 보는 값과
 * 누르는 단추가 같다. 카드가 제목(`h3`)을 직접 그리므로 시트 머리 글자는 비운다.
 */
export function SettingsCardSheet({ open, card, invalidReason, onDecide, onStatus, onClose }: {
  open: boolean
  card: LaneCard | null
  invalidReason: CardInvalidReason | null
  onDecide: (cardId: string, baseVersion: number, action: CardAction) => void
  onStatus: (cardId: string) => void
  onClose: () => void
}) {
  return (
    <Sheet open={open} title="" screen="lane-settings-card" onClose={onClose}>
      {card && <LanePlanCard card={card} invalidReason={invalidReason} onDecide={onDecide} onStatus={onStatus} />}
    </Sheet>
  )
}

type ProviderOf<T> = T extends { company: infer C } ? C : never

/** 표 줄 순서는 칩·설계 표와 같다 — 설계 줄은 위에서 따로 그리므로 뺀다. */
const JOB_LANES: SettingsRow['lane'][] = WORK_LANES
  .map(({ lane }) => lane)
  .filter((lane): lane is SettingsRow['lane'] => lane !== 'design')

/** 배치 묶음 — 상태 ①·③. 표·출처·지금만·다음 메시지·단추. */
function Placement({ view, root, onDisable, onOpenCard, pick, onOpenPick, onClosePick }: {
  view: LanesSettingsView
  root: string | null
  onDisable: () => void
  onOpenCard: (kind: 'enable' | 'revert', button: HTMLButtonElement | null) => void
  pick: { open: boolean; loading: boolean; groups: ReviewModelGroup[] }
  onOpenPick: (company: ProviderOf<ReviewModelGroup>) => void
  onClosePick: () => void
}) {
  const rows = view.rows
  const reviewRow = rows.find((row) => row.note === 'review-unavailable') ?? null
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-3)' }}>
        <h3 className="set-sub" style={{ margin: '0 0 2px', flex: 1 }}>{LANES_SETTINGS.tableTitle}</h3>
        <span className="caption">{sourceText(view.source)}</span>
      </div>
      <p className="caption" style={{ margin: '0 0 6px' }}>{LANES_SETTINGS.caption}</p>
      {view.mode === 'undecided' && <p className="caption" style={{ margin: '0 0 6px', color: 'var(--ink-2)' }}>{LANES_SETTINGS.pendingHead}</p>}
      <table className="lane-table">
        {/* 열 폭 고정(검토 C2-V01) — 역할·깊이·어디서는 짧은 값이라 줄바꿈을 막고, 둘째 칸이 남는 폭을 쓴다. */}
        <colgroup>
          <col style={{ width: '19%' }} />
          <col />
          <col style={{ width: '12%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{LANES_SETTINGS.colLane}</th>
            <th scope="col">{LANES_SETTINGS.colModel}</th>
            <th scope="col">{LANES_SETTINGS.colDepth}</th>
            <th scope="col">{LANES_SETTINGS.colWhere}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{LANE_NAME.design}</td>
            <td colSpan={3} className="muted">{LANES_SETTINGS.designCell(view.recommendedDesign ? modelLabel(view.recommendedDesign) : null)}</td>
          </tr>
          {JOB_LANES.map((lane) => {
            const row = rows.find((r) => r.lane === lane) ?? null
            return <Row key={lane} lane={lane} row={row} />
          })}
        </tbody>
      </table>
      {reviewRow && (
        <div className="pop-host" style={{ alignItems: 'center' }}>
          <button type="button" onClick={() => onOpenPick(reviewRow.entry?.company ?? 'claude')}>{LANES_SETTINGS.reviewPick}</button>
          {pick.open && <ReviewPick pick={pick} root={root} onClose={onClosePick} />}
        </div>
      )}
      {view.temporary.map(({ lane, entry }) => (
        <p key={lane} className="caption">{LANES_SETTINGS.temporary(`${LANE_NAME[lane]} ${entryWords(entry)}`)}</p>
      ))}
      {view.nextDesignCompany && <p className="caption">{LANES_SETTINGS.nextDesign(providerName(view.nextDesignCompany))}</p>}
      <p className="caption" style={{ marginTop: 'var(--sp-3)' }}>{LANES_SETTINGS.hint}</p>
      <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button type="button" disabled={!root || !view.differsFromRecommendation}
          onClick={(e) => onOpenCard('revert', e.currentTarget)}>{LANES_SETTINGS.revert}</button>
        <button type="button" className="quiet" disabled={!root} onClick={onDisable}>{LANES_SETTINGS.turnOff}</button>
        {view.mode === 'undecided' && (
          <button type="button" className="primary" disabled={!root}
            onClick={(e) => onOpenCard('enable', e.currentTarget)}>{LANES_SETTINGS.turnOn}</button>
        )}
      </div>
    </>
  )
}

/** 표 한 줄 — 예외(`note`)면 값 칸이 글이 되고 깊이 칸이 `—` 가 된다. */
function Row({ lane, row }: { lane: SettingsRow['lane']; row: SettingsRow | null }) {
  const entry = row?.entry ?? null
  const note = row?.note ?? null
  const direct = entry !== null && isDirect(entry)
  return (
    <tr>
      <td className="nw">{LANE_NAME[lane]}</td>
      <td>
        {note === null
          ? (entry ? (direct ? LANE_CARD.direct : `${providerName(entry.company)} · ${modelName(entry.model) || '기본'}`) : '—')
          : <span className="exc"><Icon name="info" size={14} className="ic" />{' '}{noteText(row!)}</span>}
      </td>
      <td className="nw">{note !== null ? '—' : depthName(entry?.effort)}</td>
      <td className="nw">{entry ? (direct ? LANES_SETTINGS.whereMain : LANES_SETTINGS.whereNew) : '—'}</td>
    </tr>
  )
}

function noteText(row: SettingsRow): string {
  if (row.note === 'main-takeover') return LANES_SETTINGS.mainTakeover(modelName(row.recommendedModel) || row.recommendedModel || '')
  if (row.note === 'review-unavailable') return LANES_SETTINGS.reviewUnavailable
  return LANES_SETTINGS.notSubscribed
}

/** §3-4 검토 모델 목록 — 고르면 `pickReview` 가 배치 카드를 밀어 준다(여기서 적용하지 않는다). */
function ReviewPick({ pick, root, onClose }: { pick: { loading: boolean; groups: ReviewModelGroup[] }; root: string | null; onClose: () => void }) {
  return (
    <Popover open onClose={onClose} label={LANE_CARD.reviewPickTitle} align="left" width={380}>
      <PopHead>{LANE_CARD.reviewPickTitle}</PopHead>
      <p className="caption" style={{ padding: '0 10px 6px' }}>{LANE_CARD.reviewPickNote}</p>
      {pick.loading ? <PopRow>{'불러오는 중…'}</PopRow>
        : pick.groups.length === 0 ? <PopRow>{LANE_CARD.reviewPickEmpty}</PopRow>
          : pick.groups.map((group) => group.models.map((model) => (
            <PopRow key={`${group.company}:${model.model}`}
              onClick={() => { onClose(); if (root) void laneActions().pickReview(root, group.company, model.model) }}
              meta={providerName(group.company)}>{model.name}</PopRow>
          )))}
    </Popover>
  )
}

/** 확인 창 본문 — §3-1 요금 상자와 같은 문구(동의 확인도, 거둠 확인도). */
function FeeBox({ row, withdraw }: { row: ConsentRow; withdraw: boolean }) {
  const company = providerName(row.company)
  return (
    <div>
      {withdraw
        ? <p>{LANES_SETTINGS.withdrawConfirmBody(company, row.accountLabel)}</p>
        : (
          <>
            <p>{LANE_CARD.feeIntro}</p>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              <li>{LANE_CARD.feeApp}</li>
              <li>{LANE_CARD.feeSpawn}</li>
            </ul>
            <p>{LANE_CARD.feeConsent(company, row.accountLabel)}</p>
          </>
        )}
      <p className="caption">{LANES_SETTINGS.spent}</p>
    </div>
  )
}

function consentText(row: ConsentRow): string {
  const day = row.at ? dayKo(row.at) : ''
  if (row.state === 'agreed') return LANES_SETTINGS.consentAgreed(day)
  if (row.state === 'withdrawn') return LANES_SETTINGS.consentWithdrawn(day)
  return LANES_SETTINGS.consentNone
}

function sourceText(source: LanesSettingsView['source']): string {
  switch (source.kind) {
    case 'recommended': return LANES_SETTINGS.source.recommended(LANE_TABLE[source.rowId].label)
    case 'mine': return LANES_SETTINGS.source.mine(source.at)
    case 'recommendation-changed': return LANES_SETTINGS.source.changed
    default: return LANES_SETTINGS.source.none
  }
}

/** "ChatGPT Astra" — 이번 차례만 문구. 도우미가 직접 맡으면 회사 이름이 없다. */
function entryWords(entry: LaneEntry): string {
  if (isDirect(entry)) return LANE_CARD.direct
  return `${providerName(entry.company)} ${modelName(entry.model) || '기본'}`
}
