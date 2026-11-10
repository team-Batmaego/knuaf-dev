/**
 * §6 "화면은 계산하지 않는다" — main 이 상태 묶음(`LanesSnapshot`)을 통째로 짓는다.
 *
 * 이 파일은 **읽기만** 한다: 앱 저장소(승인·카드·기록 줄·전달 기록)와 러너 기록을 모아
 * 계약 모양으로 옮긴다. 상태를 바꾸는 판단(카드 소비·동의·전달)은 `ChatService` 몫이다.
 *
 * 줄의 종류·순서·✕ 여부는 UI-DESIGN §2-0/§2-1 표를 그대로 옮긴 것이다. 문구는 없다 —
 * 화면이 `kind` 로 짓는다(계약 §1 "문구는 넣지 않는다").
 */
import type { Provider } from '../../shared/chat'
import type { AccountSnapshot, LaneEntry, LaneNote, LanePlan, LaneRowId, WorkLane } from '../../shared/lanes'
import { subscriptionCheck } from '../../shared/lanes'
import type {
  ArchivedChatSummary, ConsentRow, JobDetail, JobLane, LaneAnnouncement, LaneCard, LaneEvent, LaneLine,
  LaneLineKind, LanesSettingsView, LanesSnapshot, ModelRef, SettingsRow
} from '../../shared/lanes-ipc'
import type { JobRecord, ContinuationProposal } from '../chat/jobs/types'
import type { DeliveryRecord, JobStore, StoredConsent } from '../chat/jobs/store'

// ---------------------------------------------------------------- 줄 표 (UI-DESIGN §2-0/§2-1)

/** §2-0 종류: 1 막힘 · 2 학생 선택 · 3 진행 · 4 지속 경고 · 5 미결 카드. */
const TIER: Record<LaneLineKind, 1 | 2 | 3 | 4 | 5> = {
  'folder-changed': 1,
  'deliver-failed': 2,
  'deliver-uncertain': 2,
  'limit-offer': 2,
  'limit-blocked': 2,
  'continue-gone': 2,
  'usage-unknown': 2,
  auth: 2,
  failed: 2,
  interrupted: 2,
  'main-limit-offer': 2,
  'handoff-failed': 2,
  progress: 3,
  delivering: 3,
  'handoff-running': 3,
  stopped: 4,
  'review-missing': 4,
  'version-mismatch': 4,
  'card-pending': 5
}

/**
 * §2-1 ✕ 여부. 단추가 있는 줄(`limit-offer`·`auth`·`interrupted`·`main-limit-offer`·
 * `handoff-*`)과 진행 줄은 ✕ 대신 단추로만 닫는다. 미결 카드 줄은 카드가 처리될 때만 사라진다.
 */
const DISMISSIBLE: Record<LaneLineKind, boolean> = {
  'folder-changed': true,
  'deliver-failed': true,
  'deliver-uncertain': true,
  'limit-offer': false,
  'limit-blocked': true,
  'continue-gone': true,
  'usage-unknown': true,
  auth: false,
  failed: true,
  interrupted: false,
  'main-limit-offer': false,
  'handoff-failed': false,
  progress: false,
  delivering: false,
  'handoff-running': false,
  stopped: true,
  'review-missing': true,
  'version-mismatch': true,
  'card-pending': false
}

const EPOCH = new Date(0).toISOString()

/** 담당 회사 하나의 지금 상태 — 요금 동의 줄·이어 받기 사유 계산에 쓴다. */
export interface LaneAccountView {
  connected: boolean
  /** 앱 저장소가 아는 동의(로그인 계정 id 단위). */
  consented: boolean
  usage: 'allowed' | 'limit' | 'unknown' | 'auth'
  accountId: string
  account: AccountSnapshot
}

/** `temporary` 는 주문 차선만 담는다(설계는 본대화 고정). */
export interface LaneTemporary { lane: JobLane; entry: LaneEntry }

export interface LaneSettingsInput {
  root: string | null
  store: JobStore
  /** 이 폴더 본대화의 회사 — 설계 줄이 여기로 고정된다(정본 §3.8). */
  mainCompany: Provider
  accounts: Partial<Record<Provider, LaneAccountView>>
  /** 추천 줄(요금제에서 파생). 계정이 없으면 `null`. */
  recommended: { rowId: LaneRowId; plan: LanePlan; notes: LaneNote[] } | null
  /** [이번만]으로 도는 값 — U5 카드 적용이 남긴다. 지금은 빈 배열. */
  temporary?: LaneTemporary[]
}

/** 조립기가 러너에게서 읽는 것 — 이 둘뿐이다. `JobRunner` 가 그대로 만족한다. */
export interface LaneRunnerView {
  records: () => JobRecord[]
  proposals: () => ContinuationProposal[]
}

export interface LaneInput {
  root: string | null
  store: JobStore
  runner: LaneRunnerView | null
  settings: LanesSettingsView
  accounts: Partial<Record<Provider, LaneAccountView>>
  /** §4-2 한도로 멈춘 대화 — U6 이음매 전에는 빈 배열. */
  archives?: ArchivedChatSummary[]
  /** §4-1 본대화 인계 줄 — U6 이음매 전에는 빈 배열. */
  extraLines?: LaneLine[]
}

const OTHER: Record<Provider, Provider> = { claude: 'codex', codex: 'claude' }

/**
 * 계정 표시를 가린다(계약 §6 "가리지 않은 이메일은 화면으로 보내지 않는다").
 * `AccountSnapshot` 에 이메일이 없으므로 id 앞자리만 남긴다 — 원문은 화면으로 나가지 않는다.
 */
export function maskAccount(accountId: string): string {
  const text = accountId.trim()
  return text.length <= 6 ? '…' : `${text.slice(0, 6)}…`
}

// ---------------------------------------------------------------- §5 설정 "작업 분담"

/**
 * §5 요금 동의 줄 — 지금 로그인한 계정마다 한 줄. 저장된 동의 중 지금 로그인하지 않은 계정도
 * 남긴다(거둔 기록이 사라지면 화면이 거짓말한다). 원문 계정 id 는 `accountId` 로만 나간다.
 */
export function consentRows(accounts: Partial<Record<Provider, LaneAccountView>>, stored: StoredConsent[]): ConsentRow[] {
  const saved = new Map(stored.map(entry => [`${entry.company}\0${entry.accountId}`, entry]))
  const rows: ConsentRow[] = []
  const seen = new Set<string>()
  for (const company of ['claude', 'codex'] as const) {
    const view = accounts[company]
    if (!view) continue
    const key = `${company}\0${view.accountId}`
    const saved_ = saved.get(key)
    seen.add(key)
    rows.push({
      company,
      accountId: view.accountId,
      accountLabel: maskAccount(view.accountId),
      state: saved_?.state ?? (view.consented ? 'agreed' : 'none'),
      at: saved_?.at ?? null,
      subscribed: subscriptionCheck(view.account).usable
    })
  }
  for (const entry of stored) {
    const key = `${entry.company}\0${entry.accountId}`
    if (seen.has(key)) continue
    rows.push({
      company: entry.company,
      accountId: entry.accountId,
      accountLabel: maskAccount(entry.accountId),
      state: entry.state,
      at: entry.at,
      // 지금 로그인하지 않은 계정 — 요금제를 확인할 수 없으므로 쓰지 않음으로 본다.
      subscribed: false
    })
  }
  return rows
}

/** 승인된 배치가 추천과 같은가 — 값 비교(참조 비교 아님). */
function samePlan(a: LanePlan, b: LanePlan): boolean {
  const lanes: WorkLane[] = ['design', 'research', 'writing', 'repeat', 'review']
  return lanes.every(lane => JSON.stringify(a[lane] ?? null) === JSON.stringify(b[lane] ?? null))
}

/** §5 표 줄 — 설계는 `recommendedDesign` 몫이라 넣지 않는다. */
const settingsRows = (plan: LanePlan): SettingsRow[] =>
  (['research', 'writing', 'repeat', 'review'] as const).map(lane => ({
    lane, entry: plan[lane] ?? null, note: null, recommendedModel: null
  }))

/**
 * §5 설정 — 승인 배치가 있으면 그것이 정본, 없으면 추천 줄을 보여 준다.
 * `mode` 는 저장 키를 새로 만들지 않고 파생한다: 승인 있음 `on` · 끈다는 기록 있음 `off` ·
 * 나머지 `undecided`(설정 파일 모양은 이 단위의 소유가 아니다 → `QUESTIONS-C1.md`).
 */
export function lanesSettings(input: LaneSettingsInput): LanesSettingsView {
  const { store, root } = input
  const consents = consentRows(input.accounts, store.consents())
  if (!root) {
    return {
      mode: null, source: { kind: 'none' }, rows: [], differsFromRecommendation: false,
      temporary: [], recommendedDesign: null, nextDesignCompany: null, consents
    }
  }
  const approved = store.approvedPlan(root)
  const declined = store.events(root).some(event => event.kind === 'lanes-declined')
  const mode: LanesSettingsView['mode'] = approved ? 'on' : declined ? 'off' : 'undecided'
  const recommendedPlan = input.recommended?.plan ?? null
  const shown = approved ?? recommendedPlan
  const at = store.approvedAt(root) ?? EPOCH

  const rows = modesRows(mode, shown)
  const notes = new Map((input.recommended?.notes ?? []).map(note => [note.lane, note]))
  for (const row of rows) {
    const note = notes.get(row.lane)
    const view = row.entry ? input.accounts[row.entry.company] : undefined
    if (note?.kind === 'main-takeover') {
      row.note = 'main-takeover'
      row.recommendedModel = note.model || null
    } else if (note?.kind === 'review-unavailable') {
      row.note = 'review-unavailable'
      row.recommendedModel = note.model || null
    } else if (view && !subscriptionCheck(view.account).usable) {
      row.note = 'not-subscribed'
    }
  }

  const design = (approved ?? recommendedPlan)?.design ?? null
  return {
    mode,
    source: approved
      ? recommendedPlan && input.recommended && samePlan(approved, recommendedPlan)
        ? { kind: 'recommended', rowId: input.recommended.rowId }
        : store.approvedAt(root) ? { kind: 'mine', at } : { kind: 'recommendation-changed' }
      : { kind: 'none' },
    rows,
    differsFromRecommendation: Boolean(approved && recommendedPlan && !samePlan(approved, recommendedPlan)),
    temporary: input.temporary ?? [],
    recommendedDesign: design?.model ? { company: design.company, model: design.model, effort: design.effort } : null,
    // "다음 메시지부터: 설계 {회사}" 는 [이번만] 카드가 정한다 — U5 가 `temporary` 로 넘긴다.
    nextDesignCompany: null,
    consents
  }
}

function modesRows(mode: LanesSettingsView['mode'], plan: LanePlan | null): SettingsRow[] {
  if (mode === 'off' || !plan) return []
  return settingsRows(plan)
}

// ---------------------------------------------------------------- §2 알림 자리 줄

const detailOf = (record: JobRecord): JobDetail => ({
  jobId: record.spec.id,
  status: record.status,
  reason: record.reason ?? null,
  // [자세히]는 원문 오류를 펼친다 — 실패 계열만. 나머지는 사유로 충분하다.
  error: record.status === 'error' || record.status === 'violation' || record.status === 'rejected'
    ? record.reason ?? null : null,
  task: record.spec.task
})

const assigneeOf = (record: JobRecord): ModelRef => ({
  company: record.spec.company, model: record.spec.model, effort: record.spec.effort
})

type JobLineKind = 'progress' | 'delivering' | 'deliver-failed' | 'deliver-uncertain' | 'limit-offer'
  | 'limit-blocked' | 'continue-gone' | 'usage-unknown' | 'auth' | 'failed' | 'interrupted' | 'stopped'
  | 'folder-changed'

type JobLineExtra<K extends JobLineKind> = Omit<
  Extract<LaneLine, { kind: K }>,
  'kind' | 'tier' | 'dismissible' | 'id' | 'at' | 'jobId' | 'lane' | 'assignee' | 'detail'
>

function jobLine<K extends JobLineKind>(record: JobRecord, kind: K, extra: JobLineExtra<K>): Extract<LaneLine, { kind: K }> {
  const line = {
    id: `job:${record.spec.id}:${kind}`,
    kind,
    tier: TIER[kind],
    at: record.createdAt,
    dismissible: DISMISSIBLE[kind],
    jobId: record.spec.id,
    lane: record.spec.lane,
    assignee: assigneeOf(record),
    detail: detailOf(record),
    ...extra
  }
  return line as Extract<LaneLine, { kind: K }>
}

/** 이어 받을 수 없는 사유 — 지금 계정 상태로만 판정한다(추측 금지). */
function blockedReason(
  other: Provider,
  accounts: Partial<Record<Provider, LaneAccountView>>
): Extract<LaneLine, { kind: 'limit-blocked' }>['reason'] {
  const view = accounts[other]
  if (!view || !view.connected) return 'not-logged-in'
  if (!view.consented) return 'no-consent'
  if (view.usage !== 'allowed') return 'also-unavailable'
  return 'model-missing'
}

function lineFor(record: JobRecord, ctx: {
  delivery: (rootJobId: string) => DeliveryRecord['state'] | null
  proposal: ContinuationProposal | undefined
  waiting: number
  accounts: Partial<Record<Provider, LaneAccountView>>
}): LaneLine | null {
  const delivered = ctx.delivery(record.rootJobId)
  switch (record.status) {
    case 'queued':
      return jobLine(record, 'progress', { phase: 'queued', startedAt: null, waiting: ctx.waiting })
    case 'running':
      return jobLine(record, 'progress', {
        phase: record.spec.parent ? 'continuing' : 'running',
        startedAt: record.startedAt ?? record.createdAt,
        waiting: ctx.waiting
      })
    case 'auth':
      return jobLine(record, 'auth', {})
    case 'unknown':
      return jobLine(record, 'usage-unknown', {})
    case 'interrupted':
      return jobLine(record, 'interrupted', {})
    case 'stopped':
      return jobLine(record, 'stopped', {})
    case 'violation':
      // §8-5 담당이 도는 동안 논문 파일이 바뀌었다 — 주체를 단정하지 않는다.
      return jobLine(record, 'folder-changed', {})
    case 'error':
    case 'rejected':
      return jobLine(record, 'failed', {})
    case 'completed':
      if (delivered === 'failed') return jobLine(record, 'deliver-failed', {})
      if (delivered === 'uncertain') return jobLine(record, 'deliver-uncertain', {})
      // 전달 기록이 없거나 넣는 중이면 "넘기는 중". 다 들어갔으면(`done`) 줄이 없다.
      if (delivered === 'started' || delivered === null) return jobLine(record, 'delivering', {})
      return null
    case 'limit': {
      const proposal = ctx.proposal
      if (proposal) {
        return jobLine(record, 'limit-offer', {
          proposalId: proposal.proposalId,
          to: { company: proposal.entry.company, model: proposal.entry.model ?? '', effort: proposal.entry.effort },
          // 계정 기본 깊이(null)로 내렸을 때만 "(기본 깊이)".
          effortLowered: record.spec.effort !== null && proposal.entry.effort === null,
          // 원 회사가 한도 풀림 시각을 알려 주는 통로가 아직 없다 — 모르면 null(계약).
          resetAt: null
        })
      }
      if (delivered === 'failed') return jobLine(record, 'deliver-failed', {})
      if (delivered === 'uncertain') return jobLine(record, 'deliver-uncertain', {})
      // 제안도 전달도 없을 때만 단추 없는 줄 — 사유는 지금 계정 상태로만.
      if (delivered === null) {
        const other = OTHER[record.spec.company]
        return jobLine(record, 'limit-blocked', { other, reason: blockedReason(other, ctx.accounts) })
      }
      return null
    }
  }
}

/**
 * 이 폴더의 알림 줄. 정렬은 종류 1→5, 같은 종류는 먼저 생긴 것부터(계약 `lines`).
 * ✕로 닫은 줄은 빼되 `dismissible:false` 인 줄은 닫을 수 없으므로 그대로 둔다.
 */
export function lanesLines(input: LaneInput): LaneLine[] {
  if (!input.root || !input.runner) return input.extraLines ?? []
  const root = input.root
  const records = input.runner.records().filter(record => record.root === root)
  const proposals = input.runner.proposals()
  const delivery = (rootJobId: string): DeliveryRecord['state'] | null => {
    try { return input.store.deliveryState(rootJobId) } catch { return null }
  }
  const lines: LaneLine[] = []
  records.forEach((record, index) => {
    // "다음 n건 기다림" — 이 주문 뒤에 줄 선 대기 수(직렬 실행).
    const waiting = records.slice(index + 1).filter(next => next.status === 'queued').length
    const line = lineFor(record, {
      delivery,
      proposal: proposals.find(proposal => proposal.rootJobId === record.rootJobId),
      waiting,
      accounts: input.accounts
    })
    if (line) lines.push(line)
  })
  lines.push(...cardLines(input))
  lines.push(...reviewLines(input))
  lines.push(...versionLines(input))
  lines.push(...(input.extraLines ?? []))
  const dismissed = new Set(input.store.dismissed(root))
  return lines
    .filter(line => !(line.dismissible && dismissed.has(line.id)))
    .sort((a, b) => a.tier - b.tier || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** §3·§2-0 미결 카드 — [F5] 설정 확인 창 카드는 열려 있는 동안 대화에 넣지 않는다. */
function cardLines(input: LaneInput): LaneLine[] {
  if (!input.root) return []
  return input.store.cards(input.root)
    .filter(card => card.state.kind === 'open' && !card.variant.startsWith('settings-'))
    .map(card => ({
      id: `card:${card.cardId}`,
      kind: 'card-pending' as const,
      tier: 5 as const,
      at: card.createdAt,
      dismissible: DISMISSIBLE['card-pending'],
      cardId: card.cardId
    }))
}

/**
 * §2-2 지속 안내 — 나눠 맡기기는 켜져 있는데 독립 검토 차선이 없다.
 * 사유는 `model-missing` 하나뿐이다: 배치가 켜져 있다는 것 자체가 `lanes-off` 가 아니고,
 * 검토가 한도로 빠진 것은 러너가 `review-skipped{reason:'limit'}` 을 남길 때만 알 수 있다.
 */
function reviewLines(input: LaneInput): LaneLine[] {
  const { root, settings, store } = input
  if (!root || settings.mode !== 'on') return []
  const review = settings.rows.find(row => row.lane === 'review')
  if (review?.entry && review.entry.how !== 'main') return []
  const skipped = [...store.events(root)].reverse().find(event => event.kind === 'review-skipped')
  if (skipped?.kind === 'review-skipped') {
    return [{
      id: 'review-missing', kind: 'review-missing', tier: 4,
      at: skipped.at, dismissible: DISMISSIBLE['review-missing'], reason: skipped.reason
    }]
  }
  if (!review || review.note !== 'review-unavailable') return []
  return [{
    id: 'review-missing', kind: 'review-missing', tier: 4,
    at: store.approvedAt(root) ?? EPOCH, dismissible: DISMISSIBLE['review-missing'], reason: 'model-missing'
  }]
}

/** §2-2 지속 안내 — 앱·스킬 판이 맞지 않아 주문을 받지 못했다. */
function versionLines(input: LaneInput): LaneLine[] {
  if (!input.root) return []
  const event = [...input.store.events(input.root)].reverse().find(candidate => candidate.kind === 'version-mismatch')
  if (!event) return []
  return [{
    id: 'version-mismatch', kind: 'version-mismatch', tier: 4,
    at: event.at, dismissible: DISMISSIBLE['version-mismatch']
  }]
}

// ---------------------------------------------------------------- 묶음

/** `seq`·`announcement` 는 보내는 쪽(`LanesPublisher`)이 붙인다. */
export type SnapshotBody = Omit<LanesSnapshot, 'seq' | 'announcement'>

/** 카드에서 앱 전용 칸(`boundAccounts`)을 떼고 계약 모양만 남긴다. */
const publicCard = (card: LaneCard): LaneCard => ({
  cardId: card.cardId,
  root: card.root,
  variant: card.variant,
  baseVersion: card.baseVersion,
  createdAt: card.createdAt,
  reviewDue: card.reviewDue,
  quote: card.quote,
  rows: card.rows,
  fees: card.fees,
  fastDrain: card.fastDrain,
  recommendedDesign: card.recommendedDesign,
  state: card.state
})

/**
 * 한 폴더의 묶음 — `seq`·`announcement` 없이. 폴더가 없으면(`root === null`) 요금 동의 묶음만
 * 의미 있다(계약 §4).
 */
export function assembleLanes(input: LaneInput): SnapshotBody {
  const root = input.root
  const lines = lanesLines(input)
  const cards = root
    ? input.store.cards(root)
      .filter(card => !(card.state.kind === 'open' && card.variant.startsWith('settings-')))
      .map(publicCard)
    : []
  const events = root
    ? [...input.store.events(root)].sort((a, b) => a.at.localeCompare(b.at))
    : []
  return {
    root,
    lines,
    cards,
    events,
    settings: input.settings,
    archives: input.archives ?? [],
    stopButton: lines.some(line => line.kind === 'progress') ? 'chat-and-lanes' : 'chat'
  }
}

/**
 * 묶음을 보내고 `seq` 를 올린다. `announcement` 는 **줄 집합이 바뀐 순간에만** 새 값이 된다 —
 * 경과 시간·대기 개수 변화로는 낭독이 다시 울리지 않는다(계약 §2-1 낭독).
 */
export class LanesPublisher {
  private seq = 0
  private readonly seen = new Map<string, { lines: Map<string, LaneLine>; announcement: LaneAnnouncement | null }>()

  constructor(private readonly send: (snapshot: LanesSnapshot) => void) {}

  publish(input: LaneInput): LanesSnapshot {
    const body = assembleLanes(input)
    const key = input.root ?? ''
    const previous = this.seen.get(key)
    const current = new Map(body.lines.map(line => [line.id, line]))
    const seq = ++this.seq
    const announcement = this.announce(previous?.lines, current, seq) ?? previous?.announcement ?? null
    const snapshot: LanesSnapshot = { ...body, seq, announcement }
    this.seen.set(key, { lines: current, announcement })
    this.send(snapshot)
    return snapshot
  }

  /** 새로 생긴 줄이 없으면 낭독도 새로울 것이 없다 — 옛 낭독 값을 그대로 둔다. */
  private announce(
    previous: Map<string, LaneLine> | undefined,
    current: Map<string, LaneLine>,
    seq: number
  ): LaneAnnouncement | null {
    if (!previous) return null
    const added = [...current.values()].filter(line => !previous.has(line.id))
    const first = added[0]
    if (!first) return null
    if (first.kind === 'progress' && first.phase !== 'queued') {
      return { seq, kind: 'started', lane: first.lane, lineId: first.id }
    }
    return { seq, kind: 'line', lane: 'lane' in first ? first.lane : null, lineId: first.id }
  }
}
