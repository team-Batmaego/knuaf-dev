import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../../../shared/chat'
import type { LanePlan } from '../../../shared/lanes'
import type { CardState, LaneCard, LaneEvent } from '../../../shared/lanes-ipc'
import { readRecoverable, writeFileAtomic } from '../../safeWrite'
import { canonical } from './isolation'

/**
 * 앱 소유 승인·동의·전달 기록. **논문 폴더의 어떤 파일도 읽지 않는다** — 폴더 안
 * `lanes.json`·`.knuaf-gui/*` 는 사본일 뿐 승인 근거가 아니다(DESIGN §3.1-5·§3.7).
 *
 * 전달 기록은 `JobRunner` 가 claim(`delivered[]`)을 저장한 **뒤** IPC/대화 전달 전에
 * 앱이 죽는 창을 드러내기 위한 것이다. 다시 보내지 않고 `uncertain` 으로 남긴다.
 *
 * `state:'failed'` 는 그와 다르다 — 전달 호출이 **시작조차 못했음이 확실한** 경우다
 * (`deliver-failed`). 그 줄에서만 학생이 누를 때 1회 다시 넘긴다(계약 §6 Q3).
 */
export interface DeliveryRecord {
  state: 'started' | 'done' | 'uncertain' | 'failed'
  root: string
  ownerId: string
  at: string
  /** 화면에 한 번 알린 뒤 true — 다음 실행에서 같은 줄을 또 넣지 않는다. */
  notified?: true
}

/** §6 Q4 — 옛 값 `true` 는 `agreed`(날짜 모름)로 읽는다. */
export interface ConsentRecord {
  state: 'agreed' | 'withdrawn'
  at: string | null
}

export interface StoredConsent extends ConsentRecord { company: Provider; accountId: string }

/**
 * 계약 `LaneCard` + 앱만 아는 칸. `boundAccounts` 는 카드를 띄운 계정([Roh 중요 3]),
 * `plan` 은 그 카드가 적용할 **앱이 만든** 배치다 — 화면이 보낸 값으로 다시 짓지 않는다
 * (§6 "화면은 계산하지 않는다"). 화면으로는 `LaneCard` 만 나간다.
 */
export type StoredCard = LaneCard & {
  boundAccounts: Partial<Record<Provider, string>>
  /** 옛 파일의 카드에는 없다 — 그때는 적용할 배치가 없으므로 `invalid` 로 닫는다. */
  plan?: LanePlan
}

export type CardClaim =
  | { ok: true; card: StoredCard }
  | { ok: false; reason: 'not-found' | 'already-handled' | 'base-version' | 'superseded'; card: StoredCard | null }

interface StoreState {
  version: 1
  approvals: Record<string, LanePlan>
  consent: Record<string, ConsentRecord>
  deliveries: Record<string, DeliveryRecord>
  /** 폴더별 §3 카드(열림·접힘 모두). */
  cards: Record<string, StoredCard[]>
  /** 폴더별 §3 배치 판 — 카드를 만들 때의 값이 `LaneCard.baseVersion` 이다. */
  baseVersion: Record<string, number>
  /** 폴더별 §2-2 기록 줄(Q1) — 재시작 뒤에도 남는다. */
  events: Record<string, LaneEvent[]>
  /** 주문별 전달문 원문([자세히], Roh 중요 1). */
  deliveryText: Record<string, string>
  /** 폴더별 ✕로 닫은 줄 id. */
  dismissed: Record<string, string[]>
  /** 폴더별 승인 시각 — §5 "내가 정함 · {날짜}" 의 근거. 옛 파일에는 없다. */
  approvalAt: Record<string, string>
  /**
   * 폴더별 [이번만] 배치(Q5) — 승인 배치를 덮지 않는다.
   * **[v0.7.1] v0.7은 쓰지 않는다** — 카드가 만들지도 않고(`cards.ts` `ONCE_DEFERRED`),
   * 주문 판정에도 쓰지 않는다(`effectivePlan`). 옛 자료가 파싱에서 깨지지 않게 읽기만 남긴다.
   */
  temporary: Record<string, TemporaryPlan>
}

/** [이번만]으로 도는 배치와 그것이 묶인 차례. [v0.7.1] — v0.7은 만들지 않는다. */
export interface TemporaryPlan {
  plan: LanePlan
  /** 도우미가 답하는 중이었으면 그 차례 id, 쉬는 중이었으면 `'next-student-turn'`. */
  boundTurn: string
  at: string
}

/** 한 폴더에 남기는 기록 줄 상한 — 무한히 자라지 않게 오래된 것부터 버린다. */
const EVENT_LIMIT = 500

const LANES = ['design', 'research', 'writing', 'repeat', 'review'] as const
const COMPANIES = ['claude', 'codex']
const HOWS = ['main', 'sub', 'relay']

function isLaneEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as { company?: unknown; model?: unknown; effort?: unknown; how?: unknown }
  // `LaneEntry.model` 은 `string | null` 이다(lanes.ts). `resolveLanes` 는 본대화가 맡는
  // 차선·모델을 확인하지 못한 차선에 `model: null` 을 넣으므로, 여기서 거부하면 정당한
  // 승인 배치가 통째로 저장되지 않아 이후 모든 주문이 승인 불일치로 거절된다.
  return typeof entry.company === 'string' && COMPANIES.includes(entry.company)
    && (entry.model === null || (typeof entry.model === 'string' && !!entry.model))
    && (entry.effort === null || typeof entry.effort === 'string')
    && typeof entry.how === 'string' && HOWS.includes(entry.how)
}

function isPlan(value: unknown): value is LanePlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).length !== LANES.length) return false
  const plan = value as Record<string, unknown>
  for (const lane of LANES) {
    if (!(lane in plan)) return false
    if (plan[lane] !== null && !isLaneEntry(plan[lane])) return false
  }
  return true
}

function isDelivery(value: unknown): value is DeliveryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as { state?: unknown; root?: unknown; ownerId?: unknown; at?: unknown; notified?: unknown }
  if (record.state !== 'started' && record.state !== 'done' && record.state !== 'uncertain' && record.state !== 'failed') return false
  if (typeof record.root !== 'string' || !record.root) return false
  if (typeof record.ownerId !== 'string' || !record.ownerId) return false
  if (typeof record.at !== 'string' || !record.at) return false
  return record.notified === undefined || record.notified === true
}

/** 옛 값 `true` → `{state:'agreed', at:null}`. 한 번 읽고 나면 새 모양으로 쓴다. */
function consentOf(value: unknown): ConsentRecord | null {
  if (value === true) return { state: 'agreed', at: null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as { state?: unknown; at?: unknown }
  if (record.state !== 'agreed' && record.state !== 'withdrawn') return null
  if (record.at !== null && (typeof record.at !== 'string' || !record.at)) return null
  return { state: record.state, at: record.at }
}

/**
 * 저장된 카드 한 건. `state` 는 `CardState` 그대로이고, 결박(`boundAccounts`)은 앱만 쓴다.
 * 카드 모양을 여기서 다시 조이지 않는 이유: 카드는 앱이 만든 값이고, 깨진 카드 하나 때문에
 * 승인·동의 기록 전체를 잃는 것이 더 나쁘다. 대신 읽을 때 걸러 낸다.
 */
function isStoredCard(value: unknown): value is StoredCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const card = value as {
    cardId?: unknown; root?: unknown; state?: unknown; rows?: unknown; boundAccounts?: unknown; plan?: unknown
  }
  if (typeof card.cardId !== 'string' || !card.cardId) return false
  if (typeof card.root !== 'string' || !card.root) return false
  if (!Array.isArray(card.rows)) return false
  if (typeof card.state !== 'object' || card.state === null) return false
  const bound = card.boundAccounts
  if (bound !== undefined && (typeof bound !== 'object' || bound === null || Array.isArray(bound))) return false
  if (card.plan !== undefined && !isPlan(card.plan)) return false
  return true
}

function isEvent(value: unknown): value is LaneEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const event = value as { id?: unknown; at?: unknown; kind?: unknown }
  return typeof event.id === 'string' && !!event.id && typeof event.at === 'string' && !!event.at
    && typeof event.kind === 'string' && !!event.kind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(text: string): StoreState {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('Invalid job store')
  const state = value as Partial<Record<keyof StoreState, unknown>>
  if (state.version !== 1) throw new Error('Invalid job store')
  for (const key of ['approvals', 'consent', 'deliveries'] as const) if (!isRecord(state[key])) throw new Error('Invalid job store')
  for (const plan of Object.values(state.approvals as Record<string, unknown>)) if (!isPlan(plan)) throw new Error('Invalid job store')
  const parsed: StoreState = {
    version: 1,
    approvals: state.approvals as Record<string, LanePlan>,
    consent: {},
    deliveries: state.deliveries as Record<string, DeliveryRecord>,
    cards: {}, baseVersion: {}, events: {}, deliveryText: {}, dismissed: {}, approvalAt: {}, temporary: {}
  }
  for (const [key, record] of Object.entries(state.consent as Record<string, unknown>)) {
    const consent = consentOf(record)
    if (!consent) throw new Error('Invalid job store')
    parsed.consent[key] = consent
  }
  for (const record of Object.values(parsed.deliveries)) if (!isDelivery(record)) throw new Error('Invalid job store')
  // 아래 묶음은 이번 판에 새로 생겼다 — 없으면 빈 값으로 읽는다(옛 파일·시험 리터럴).
  if (state.cards !== undefined) {
    if (!isRecord(state.cards)) throw new Error('Invalid job store')
    for (const [root, list] of Object.entries(state.cards as Record<string, unknown>)) {
      if (!Array.isArray(list)) throw new Error('Invalid job store')
      parsed.cards[root] = list.filter(isStoredCard)
    }
  }
  if (state.baseVersion !== undefined) {
    if (!isRecord(state.baseVersion)) throw new Error('Invalid job store')
    for (const [root, version] of Object.entries(state.baseVersion as Record<string, unknown>)) {
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new Error('Invalid job store')
      parsed.baseVersion[root] = version
    }
  }
  if (state.events !== undefined) {
    if (!isRecord(state.events)) throw new Error('Invalid job store')
    for (const [root, list] of Object.entries(state.events as Record<string, unknown>)) {
      if (!Array.isArray(list)) throw new Error('Invalid job store')
      parsed.events[root] = list.filter(isEvent)
    }
  }
  if (state.deliveryText !== undefined) {
    if (!isRecord(state.deliveryText)) throw new Error('Invalid job store')
    for (const [jobId, text] of Object.entries(state.deliveryText as Record<string, unknown>)) {
      if (typeof text !== 'string') throw new Error('Invalid job store')
      parsed.deliveryText[jobId] = text
    }
  }
  if (state.dismissed !== undefined) {
    if (!isRecord(state.dismissed)) throw new Error('Invalid job store')
    for (const [root, list] of Object.entries(state.dismissed as Record<string, unknown>)) {
      if (!Array.isArray(list)) throw new Error('Invalid job store')
      parsed.dismissed[root] = list.filter((id): id is string => typeof id === 'string' && !!id)
    }
  }
  if (state.approvalAt !== undefined) {
    if (!isRecord(state.approvalAt)) throw new Error('Invalid job store')
    for (const [root, at] of Object.entries(state.approvalAt as Record<string, unknown>)) {
      if (typeof at !== 'string' || !at) throw new Error('Invalid job store')
      parsed.approvalAt[root] = at
    }
  }
  if (state.temporary !== undefined) {
    if (!isRecord(state.temporary)) throw new Error('Invalid job store')
    for (const [root, value] of Object.entries(state.temporary as Record<string, unknown>)) {
      if (!isRecord(value) || !isPlan(value.plan)) throw new Error('Invalid job store')
      if (typeof value.boundTurn !== 'string' || !value.boundTurn) throw new Error('Invalid job store')
      if (typeof value.at !== 'string' || !value.at) throw new Error('Invalid job store')
      parsed.temporary[root] = { plan: value.plan, boundTurn: value.boundTurn, at: value.at }
    }
  }
  return parsed
}

const consentKey = (company: Provider, accountId: string): string => `${company}\0${accountId}`

/** `canonical` 은 없는 경로에서 던진다 — 저장 키는 그때도 필요하다. */
function rootKey(root: string): string {
  try { return canonical(root) } catch { return root }
}

/** `<userData>/jobs/store.json`. 깨진 파일은 빈 값으로 덮지 않고 던진다. */
export class JobStore {
  private readonly file: string
  private state: StoreState

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'store.json')
    // The store file only ever lives in app storage; readRecoverable also restores a complete .tmp.
    this.state = readRecoverable(this.file, parse)?.value ?? {
      version: 1, approvals: {}, consent: {}, deliveries: {},
      cards: {}, baseVersion: {}, events: {}, deliveryText: {}, dismissed: {}, approvalAt: {}, temporary: {}
    }
    // Delivery claim happened before the crash: surface it once, never resend automatically.
    let recovered = false
    for (const record of Object.values(this.state.deliveries)) {
      if (record.state === 'started') { record.state = 'uncertain'; recovered = true }
    }
    // [C1-13] 적용 중(`applying`)에 앱이 죽은 카드는 **결과를 모른다**. 다시 소비할 수는 없고
    // (중복 적용 금지), `pending` 으로 영원히 둘 수도 없다. 예전 판은 폴더의 승인 유무로
    // 추정했다 — 그 폴더에 다른 카드의 승인이 있으면 **아무 일도 하지 않은 카드가 `applied`**
    // 가 됐고, 이번만 승인이 살아 있으면 적용된 카드가 `invalid` 가 됐다. 이제는 추정하지
    // 않는다: 결과를 모르는 카드는 **무효**로 접고, 학생이 카드를 다시 열어 확인하게 한다
    // (계약 `CardState.invalid` — 사유 없이 기본 문구). 판은 그대로 두어 남은 카드가 옛 판으로
    // 밀리지 않게 한다.
    for (const list of Object.values(this.state.cards)) {
      for (const card of list) {
        if (card.state.kind !== 'applying') continue
        card.state = { kind: 'invalid' }
        recovered = true
      }
    }
    if (recovered) this.persist()
  }

  private persist(): void {
    const result = writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 })
    if (!result.ok) throw result.error
    // [C1-14] 저장이 실제로 일어났을 때만 알린다 — 화면의 `lanes:changed` 가 여기 붙는다.
    for (const listener of this.listeners) {
      try { listener() } catch { /* 구독자 오류가 저장을 되돌리지는 않는다 */ }
    }
  }

  private readonly listeners = new Set<() => void>()

  /**
   * 저장소가 **바뀐 순간**을 구독한다. 화면의 줄·카드·동의가 IPC 요청 없이도 바뀌는 경로
   * (러너의 비동기 완료, 자동 정리)를 묶음으로 밀어 보내려면 이 훅이 필요하다([C1-14]).
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  approve(root: string, plan: LanePlan): void {
    const key = canonical(root)
    if (!isPlan(structuredClone(plan))) throw new Error('승인 배치의 모양이 올바르지 않아요.')
    this.state.approvals[key] = structuredClone(plan)
    // 같은 배치를 다시 저장해도 "내가 정한 날"이 조용히 밀리지 않게 최초 승인만 남긴다.
    this.state.approvalAt[key] ??= new Date().toISOString()
    this.persist()
  }

  approvedPlan(root: string): LanePlan | null {
    const plan = this.state.approvals[canonical(root)]
    return plan ? structuredClone(plan) : null
  }

  /**
   * 주문 판정에 쓰는 지금 배치 — **승인 배치뿐**이다.
   *
   * [C1-04 덜어냄] v0.7은 [이번만]을 쓰지 않는다(DESIGN-C0b 부록 A). 예전 판에서 저장된
   * `temporary` 가 남아 있어도 **그 값으로 주문을 열지 않는다** — 남은 임시 승인이 학생이 고르지
   * 않은 일을 실행하던 길이 바로 C1-04 였다. `temporary` 묶음과 접근자는 v0.7.1 이 다시 쓰도록
   * 그대로 두되, 판정에는 끼우지 않는다.
   */
  effectivePlan(root: string): LanePlan | null {
    return this.approvedPlan(root)
  }

  revokePlan(root: string): void {
    const key = canonical(root)
    if (this.state.approvals[key]) {
      delete this.state.approvals[key]
      delete this.state.approvalAt[key]
      this.persist()
    }
  }

  /** §5 "내가 정함 · {날짜}" — 승인 기록이 없으면 null. */
  approvedAt(root: string): string | null {
    return this.state.approvalAt[rootKey(root)] ?? null
  }

  // ------------------------------------------------------------------ §3 [이번만]

  /** 지금 [이번만]으로 도는 배치 — 없으면 null. */
  temporary(root: string): TemporaryPlan | null {
    const value = this.state.temporary[rootKey(root)]
    return value ? structuredClone(value) : null
  }

  /**
   * [이번만] 배치를 세운다. 승인 배치(`approvals`)는 건드리지 않는다 — 그 차례가 끝나면
   * 이 값만 지우면 원래 배치로 돌아간다.
   */
  setTemporary(root: string, plan: LanePlan, boundTurn: string): TemporaryPlan {
    const key = rootKey(root)
    const next: TemporaryPlan = { plan: structuredClone(plan), boundTurn, at: new Date().toISOString() }
    this.state.temporary[key] = next
    this.persist()
    return structuredClone(next)
  }

  /** [이번만]을 접는다. 실제로 지웠을 때만 true — `once-ended` 를 두 번 남기지 않는다. */
  clearTemporary(root: string): boolean {
    const key = rootKey(root)
    if (!this.state.temporary[key]) return false
    delete this.state.temporary[key]
    this.persist()
    return true
  }

  /** 동의는 **지우지 않는다** — 거둠도 날짜와 함께 남아야 §5 가 `withdrawn` 을 그린다(Q4). */
  setConsent(company: Provider, accountId: string, on: boolean): ConsentRecord {
    const key = consentKey(company, accountId)
    const previous = this.state.consent[key]
    // 같은 날 다시 켠 것을 새 동의로 적지 않는다 — 날짜가 조용히 밀리면 화면이 거짓말을 한다.
    if (on && previous?.state === 'agreed') return structuredClone(previous)
    const next: ConsentRecord = { state: on ? 'agreed' : 'withdrawn', at: new Date().toISOString() }
    this.state.consent[key] = next
    this.persist()
    return structuredClone(next)
  }

  consent(company: Provider, accountId: string): ConsentRecord | null {
    const record = this.state.consent[consentKey(company, accountId)]
    return record ? structuredClone(record) : null
  }

  consented(company: Provider, accountId: string): boolean {
    return this.state.consent[consentKey(company, accountId)]?.state === 'agreed'
  }

  /** §5 요금 동의 줄 — 계정 id 단위 전체. */
  consents(): StoredConsent[] {
    return Object.entries(this.state.consent).map(([key, record]) => {
      const [company, accountId] = key.split('\0')
      return { company: company as Provider, accountId: accountId ?? '', ...structuredClone(record) }
    })
  }

  /** 기록이 있으면 그 상태 — 재구동이 「이미 닫힌 claim」을 가려내는 데 쓴다. */
  deliveryState(rootJobId: string): DeliveryRecord['state'] | null {
    return this.state.deliveries[rootJobId]?.state ?? null
  }

  /**
   * 러너는 자기 `delivered[]` 를 먼저 영속하고(jobs.ts `deliver`) 이 claim 을 부른다. 그 두
   * 쓰기 **사이**에 앱이 죽으면 기록이 없어 다음 실행이 '확인하지 못함'을 띄우지 않고
   * 결과가 조용히 사라진다. 두 파일을 한 트랜잭션으로 묶을 수 없으므로, 복구할 때 러너
   * 기록과 대조해 **이 창에 걸린 것으로 보이는** 결과를 드러낸다.
   *
   * 근거는 "러너는 전달했다는데 이쪽 기록이 없다"뿐이다. 그러므로 이 대조는 알림만 하고
   * 다시 보내지 않는다(at-most-once 계약 유지).
   */
  orphanedDeliveries(delivered: readonly string[]): string[] {
    return delivered.filter(rootJobId => !(rootJobId in this.state.deliveries))
  }

  /**
   * 창에 걸린 것으로 보이는 결과를 `uncertain` 으로 세운다. `notified` 는 세우지 않는다 —
   * 다음 스냅샷이 '확인하지 못했어요' 줄로 한 번 드러내고 그때 닫는다(다시 보내지 않음).
   */
  adoptOrphan(rootJobId: string, root: string, ownerId: string): void {
    if (!rootJobId || rootJobId in this.state.deliveries) return
    this.state.deliveries[rootJobId] = {
      state: 'uncertain',
      root: rootKey(root),
      ownerId,
      at: new Date().toISOString()
    }
    this.persist()
  }

  /**
   * At-most-once: `done`·`uncertain`·`failed`·이미 진행 중이면 false — 다시 전달하지 않는다.
   *
   * 러너는 자기 `delivered` 목록을 먼저 영속한 뒤(jobs.ts `deliver`) 이 claim 을 부른다.
   * 그 두 쓰기 **사이**에 앱이 죽으면 이 기록이 없어 다음 실행이 '확인하지 못함'을
   * 띄우지 않고 결과가 조용히 사라진다. 두 파일을 한 트랜잭션으로 묶을 수 없어 남는
   * 창이며, 정상 종료·크래시 복구 경로는 이 claim 을 기준으로 동작한다.
   */
  beginDelivery(rootJobId: string, root: string, ownerId: string): boolean {
    const existing = this.state.deliveries[rootJobId]
    if (existing) return false
    this.state.deliveries[rootJobId] = {
      state: 'started', root: canonical(root), ownerId, at: new Date().toISOString()
    }
    this.persist()
    return true
  }

  finishDelivery(rootJobId: string): void {
    const record = this.state.deliveries[rootJobId]
    if (!record || record.state === 'done') return
    record.state = 'done'
    delete record.notified
    this.persist()
  }

  markUncertain(rootJobId: string, root: string, ownerId: string): void {
    const record = this.state.deliveries[rootJobId]
    if (record?.state === 'done') return
    this.state.deliveries[rootJobId] = {
      state: 'uncertain',
      root: record?.root ?? rootKey(root),
      ownerId: record?.ownerId ?? ownerId,
      at: record?.at ?? new Date().toISOString(),
      ...(record?.notified ? { notified: true as const } : {})
    }
    this.persist()
  }

  /**
   * 전달 호출이 **시작조차 못했음이 확실한** 경우(연결을 열 수 없음 등). `uncertain` 과 달리
   * 학생이 [다시 넘기기]를 누르면 1회 다시 시도할 수 있다(Q3).
   */
  markFailed(rootJobId: string, root: string, ownerId: string): void {
    const record = this.state.deliveries[rootJobId]
    if (record?.state === 'done' || record?.state === 'uncertain') return
    this.state.deliveries[rootJobId] = {
      state: 'failed',
      root: record?.root ?? rootKey(root),
      ownerId: record?.ownerId ?? ownerId,
      at: record?.at ?? new Date().toISOString()
    }
    this.persist()
  }

  /**
   * [다시 넘기기] 한 번 — `failed` 를 `started` 로 되돌린다. 그 밖의 상태(`done`·`uncertain`·
   * 기록 없음)면 false. 두 번 눌러도 한 번만 통과한다.
   */
  redeliverAllowed(rootJobId: string): boolean {
    const record = this.state.deliveries[rootJobId]
    if (record?.state !== 'failed') return false
    record.state = 'started'
    record.at = new Date().toISOString()
    delete record.notified
    this.persist()
    return true
  }

  /** 아직 화면에 드러내지 않은 불확실 전달 — root 별로. */
  undelivered(root: string): { rootJobId: string; at: string }[] {
    const canonicalRoot = rootKey(root)
    return Object.entries(this.state.deliveries)
      .filter(([, record]) => record.state === 'uncertain' && !record.notified && record.root === canonicalRoot)
      .map(([rootJobId, record]) => ({ rootJobId, at: record.at }))
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  markNotified(rootJobId: string): void {
    const record = this.state.deliveries[rootJobId]
    if (!record || record.notified) return
    record.notified = true
    this.persist()
  }

  // ------------------------------------------------------------------ §3 카드·§2-2 기록

  /** 이 폴더의 카드 — 만든 순. 결박(`boundAccounts`)은 앱 안에만 남는다. */
  cards(root: string): StoredCard[] {
    const list = this.state.cards[rootKey(root)] ?? []
    return structuredClone([...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  }

  card(cardId: string): StoredCard | null {
    for (const list of Object.values(this.state.cards)) {
      const found = list.find(card => card.cardId === cardId)
      if (found) return structuredClone(found)
    }
    return null
  }

  /** 현재 판 — 새 카드의 `baseVersion` 이 된다. 카드를 접거나 무를 때 1 오른다. */
  versionOf(root: string): number {
    return this.state.baseVersion[rootKey(root)] ?? 0
  }

  bumpVersion(root: string): number {
    const key = rootKey(root)
    const next = (this.state.baseVersion[key] ?? 0) + 1
    this.state.baseVersion[key] = next
    this.persist()
    return next
  }

  /**
   * 카드 하나를 연다. `plan` 은 그 카드가 적용할 배치 — `decideCard` 가 화면 값 대신 이것을
   * 쓴다. `boundAccounts` 는 지금 로그인한 계정(나중에 다시 대조한다).
   */
  addCard(card: LaneCard, boundAccounts: Partial<Record<Provider, string>>, plan?: LanePlan): StoredCard {
    const key = rootKey(card.root)
    const stored: StoredCard = { ...structuredClone(card), boundAccounts: { ...boundAccounts } }
    if (plan) stored.plan = structuredClone(plan)
    const list = this.state.cards[key] ??= []
    list.push(stored)
    this.persist()
    return structuredClone(stored)
  }

  /** 카드가 적용할 배치. 옛 파일의 카드처럼 없으면 `null` — 그 카드는 적용할 수 없다. */
  cardPlan(cardId: string): LanePlan | null {
    for (const list of Object.values(this.state.cards)) {
      const found = list.find(card => card.cardId === cardId)
      if (found) return found.plan ? structuredClone(found.plan) : null
    }
    return null
  }

  /**
   * §8-4 원자 소비 — 열림(`open`)에서만 `applying` 으로 넘긴다. 두 창·중복 IPC 중 두 번째는
   * `already-handled` 이고, 판이 바뀌었으면 `base-version` 이다. **저장이 실패하면 던진다** —
   * 메모리만 바뀐 소비는 재시작 뒤 되살아난 카드를 두 번 적용하게 만든다.
   */
  beginCard(cardId: string, baseVersion: number): CardClaim {
    for (const [root, list] of Object.entries(this.state.cards)) {
      const card = list.find(candidate => candidate.cardId === cardId)
      if (!card) continue
      if (card.baseVersion !== baseVersion || this.versionOf(root) !== baseVersion) {
        return { ok: false, reason: 'base-version', card: structuredClone(card) }
      }
      if (card.state.kind === 'superseded') return { ok: false, reason: 'superseded', card: structuredClone(card) }
      if (card.state.kind !== 'open') return { ok: false, reason: 'already-handled', card: structuredClone(card) }
      card.state = { kind: 'applying' }
      this.persist()
      return { ok: true, card: structuredClone(card) }
    }
    return { ok: false, reason: 'not-found', card: null }
  }

  /** 처리 결과로 카드 상태를 닫는다. 판도 함께 올라간다 — 남은 카드가 옛 판을 들고 있게 된다. */
  settleCard(cardId: string, state: CardState): StoredCard | null {
    for (const [root, list] of Object.entries(this.state.cards)) {
      const card = list.find(candidate => candidate.cardId === cardId)
      if (!card) continue
      card.state = structuredClone(state)
      this.state.baseVersion[root] = (this.state.baseVersion[root] ?? 0) + 1
      this.persist()
      return structuredClone(card)
    }
    return null
  }

  /** 더 새 카드가 밀어낸 열린 카드 — `by` 는 새 카드 id. */
  supersedeOpenCards(root: string, exceptCardId: string, by: string): void {
    const list = this.state.cards[rootKey(root)]
    if (!list) return
    let changed = false
    for (const card of list) {
      if (card.cardId === exceptCardId || card.state.kind !== 'open') continue
      card.state = { kind: 'superseded', by }
      changed = true
    }
    if (changed) this.persist()
  }

  /** §2-2 기록 줄 — 오래된 것부터 버리며 상한을 지킨다. */
  events(root: string): LaneEvent[] {
    return structuredClone(this.state.events[rootKey(root)] ?? [])
  }

  addEvent(root: string, event: LaneEvent): void {
    const key = rootKey(root)
    const list = this.state.events[key] ??= []
    list.push(structuredClone(event))
    if (list.length > EVENT_LIMIT) list.splice(0, list.length - EVENT_LIMIT)
    this.persist()
  }

  /** [자세히] 전달문 원문 — 전달을 마칠 때 여기 남긴다. */
  saveDeliveryText(rootJobId: string, text: string): void {
    if (this.state.deliveryText[rootJobId] === text) return
    this.state.deliveryText[rootJobId] = text
    this.persist()
  }

  deliveryTextOf(rootJobId: string): string | null {
    return this.state.deliveryText[rootJobId] ?? null
  }

  dismissed(root: string): string[] {
    return [...(this.state.dismissed[rootKey(root)] ?? [])]
  }

  dismiss(root: string, lineId: string): void {
    const key = rootKey(root)
    const list = this.state.dismissed[key] ??= []
    if (list.includes(lineId)) return
    list.push(lineId)
    this.persist()
  }
}
