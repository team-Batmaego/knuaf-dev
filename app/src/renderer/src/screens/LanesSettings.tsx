import { useEffect, useState } from 'react'
import { WORK_LANES, LANE_TABLE, type LaneEntry } from '../../../shared/lanes'
import type { ConsentRow, LanesSettingsView, ReviewModelGroup, SettingsRow } from '../../../shared/lanes-ipc'
import { useLanes, laneActions } from '../store/lanes'
import { LANE_CARD, LANE_NAME, LANES_SETTINGS, depthName, modelLabel, modelName, providerName, dayKo } from '../copy-lanes'
import { Icon } from '../components/Icon'
import { Confirm } from '../components/Confirm'
import { Popover, PopHead, PopRow } from '../components/Popover'

/**
 * 설정 "작업 분담"(설계 §5) — 표는 main 이 밀어 준 `LanesSettingsView` 를 그대로 그리고,
 * 바꾸는 일은 모두 **배치 카드**로만 한다(켜기·되돌리기·검토 모델 고르기·동의).
 * [나눠 맡기기 끄기]만 확인 창을 거쳐 바로 적용된다.
 *
 * 폴더가 없으면 배치 묶음은 `noFolder` 한 줄이고, 동의 묶음은 계정 단위라 그대로 보인다.
 */
export function LanesSettings({ root }: { root: string | null }) {
  const snapshot = useLanes((s) => s.snapshot)
  const view = snapshot?.settings ?? null
  /** 폴더 없이도 보이는 동의 묶음 — `consents()` 는 묶음 밖의 답이라 한 번 받아 둔다. */
  const [fetched, setFetched] = useState<ConsentRow[]>([])
  const [confirm, setConfirm] = useState<{ kind: 'consent' | 'withdraw'; row: ConsentRow } | null>(null)
  const [offConfirm, setOffConfirm] = useState(false)
  const [pick, setPick] = useState<{ open: boolean; loading: boolean; groups: ReviewModelGroup[] }>({ open: false, loading: false, groups: [] })

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

  const consents = view?.consents.length ? view.consents : fetched
  const actions = laneActions()
  const reviewRow = view?.rows.find((row) => row.note === 'review-unavailable') ?? null

  const openPick = (company: ProviderOf<ReviewModelGroup>) => {
    if (!root) return
    setPick({ open: true, loading: true, groups: [] })
    void useLanes.getState().callValue(({ lanes }) => lanes.reviewModels(root)).then((r) => {
      setPick({ open: true, loading: false, groups: 'value' in r ? r.value : [] })
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
            <button type="button" className="primary" disabled={!root} onClick={() => root && void actions.settingsCard(root, 'enable')}>{LANES_SETTINGS.turnOn}</button>
          </div>
        </>
      ) : (
        <Placement view={view} root={root} onDisable={() => setOffConfirm(true)}
          pick={pick} onOpenPick={openPick} onClosePick={() => setPick({ open: false, loading: false, groups: [] })} />
      )}

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
    </div>
  )
}

type ProviderOf<T> = T extends { company: infer C } ? C : never

/** 표 줄 순서는 칩·설계 표와 같다 — 설계 줄은 위에서 따로 그리므로 뺀다. */
const JOB_LANES: SettingsRow['lane'][] = WORK_LANES
  .map(({ lane }) => lane)
  .filter((lane): lane is SettingsRow['lane'] => lane !== 'design')

/** 배치 묶음 — 상태 ①·③. 표·출처·지금만·다음 메시지·단추. */
function Placement({ view, root, onDisable, pick, onOpenPick, onClosePick }: {
  view: LanesSettingsView
  root: string | null
  onDisable: () => void
  pick: { open: boolean; loading: boolean; groups: ReviewModelGroup[] }
  onOpenPick: (company: ProviderOf<ReviewModelGroup>) => void
  onClosePick: () => void
}) {
  const actions = laneActions()
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
          onClick={() => root && void actions.settingsCard(root, 'revert')}>{LANES_SETTINGS.revert}</button>
        <button type="button" className="quiet" disabled={!root} onClick={onDisable}>{LANES_SETTINGS.turnOff}</button>
        {view.mode === 'undecided' && (
          <button type="button" className="primary" disabled={!root}
            onClick={() => root && void actions.settingsCard(root, 'enable')}>{LANES_SETTINGS.turnOn}</button>
        )}
      </div>
    </>
  )
}

/** 표 한 줄 — 예외(`note`)면 값 칸이 글이 되고 깊이 칸이 `—` 가 된다. */
function Row({ lane, row }: { lane: SettingsRow['lane']; row: SettingsRow | null }) {
  const entry = row?.entry ?? null
  const note = row?.note ?? null
  return (
    <tr>
      <td>{LANE_NAME[lane]}</td>
      <td>
        {note === null
          ? (entry ? `${providerName(entry.company)} · ${modelName(entry.model) || '기본'}` : '—')
          : <span className="exc"><Icon name="info" size={14} className="ic" />{' '}{noteText(row!)}</span>}
      </td>
      <td>{note !== null ? '—' : depthName(entry?.effort)}</td>
      <td>{entry ? (entry.how === 'main' ? LANES_SETTINGS.whereMain : LANES_SETTINGS.whereNew) : '—'}</td>
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
  if (!entry.model) return LANES_SETTINGS.whereMain
  return `${providerName(entry.company)} ${modelName(entry.model)}`
}
