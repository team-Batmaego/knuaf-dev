import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../../../shared/chat'
import type { LanePlan } from '../../../shared/lanes'
import { readRecoverable, writeFileAtomic } from '../../safeWrite'
import { canonical } from './isolation'

/**
 * 앱 소유 승인·동의·전달 기록. **논문 폴더의 어떤 파일도 읽지 않는다** — 폴더 안
 * `lanes.json`·`.knuaf-gui/*` 는 사본일 뿐 승인 근거가 아니다(DESIGN §3.1-5·§3.7).
 *
 * 전달 기록은 `JobRunner` 가 claim(`delivered[]`)을 저장한 **뒤** IPC/대화 전달 전에
 * 앱이 죽는 창을 드러내기 위한 것이다. 다시 보내지 않고 `uncertain` 으로 남긴다.
 */
export interface DeliveryRecord {
  state: 'started' | 'done' | 'uncertain'
  root: string
  ownerId: string
  at: string
  /** 화면에 한 번 알린 뒤 true — 다음 실행에서 같은 줄을 또 넣지 않는다. */
  notified?: true
}

interface StoreState {
  version: 1
  approvals: Record<string, LanePlan>
  consent: Record<string, true>
  deliveries: Record<string, DeliveryRecord>
}

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
  if (record.state !== 'started' && record.state !== 'done' && record.state !== 'uncertain') return false
  if (typeof record.root !== 'string' || !record.root) return false
  if (typeof record.ownerId !== 'string' || !record.ownerId) return false
  if (typeof record.at !== 'string' || !record.at) return false
  return record.notified === undefined || record.notified === true
}

function parse(text: string): StoreState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid job store')
  const state = value as { version?: unknown; approvals?: unknown; consent?: unknown; deliveries?: unknown }
  if (state.version !== 1) throw new Error('Invalid job store')
  for (const group of [state.approvals, state.consent, state.deliveries]) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) throw new Error('Invalid job store')
  }
  for (const plan of Object.values(state.approvals as Record<string, unknown>)) if (!isPlan(plan)) throw new Error('Invalid job store')
  for (const on of Object.values(state.consent as Record<string, unknown>)) if (on !== true) throw new Error('Invalid job store')
  for (const record of Object.values(state.deliveries as Record<string, unknown>)) if (!isDelivery(record)) throw new Error('Invalid job store')
  return state as StoreState
}

const consentKey = (company: Provider, accountId: string): string => `${company}\0${accountId}`

/** `<userData>/jobs/store.json`. 깨진 파일은 빈 값으로 덮지 않고 던진다. */
export class JobStore {
  private readonly file: string
  private state: StoreState

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'store.json')
    // The store file only ever lives in app storage; readRecoverable also restores a complete .tmp.
    this.state = readRecoverable(this.file, parse)?.value ?? { version: 1, approvals: {}, consent: {}, deliveries: {} }
    // Delivery claim happened before the crash: surface it once, never resend automatically.
    let recovered = false
    for (const record of Object.values(this.state.deliveries)) {
      if (record.state === 'started') { record.state = 'uncertain'; recovered = true }
    }
    if (recovered) this.persist()
  }

  private persist(): void {
    const result = writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 })
    if (!result.ok) throw result.error
  }

  approve(root: string, plan: LanePlan): void {
    const key = canonical(root)
    if (!isPlan(structuredClone(plan))) throw new Error('승인 배치의 모양이 올바르지 않아요.')
    this.state.approvals[key] = structuredClone(plan)
    this.persist()
  }

  approvedPlan(root: string): LanePlan | null {
    const plan = this.state.approvals[canonical(root)]
    return plan ? structuredClone(plan) : null
  }

  revokePlan(root: string): void {
    if (this.state.approvals[canonical(root)]) {
      delete this.state.approvals[canonical(root)]
      this.persist()
    }
  }

  setConsent(company: Provider, accountId: string, on: boolean): void {
    const key = consentKey(company, accountId)
    if (on) {
      if (this.state.consent[key]) return
      this.state.consent[key] = true
    } else {
      if (!this.state.consent[key]) return
      delete this.state.consent[key]
    }
    this.persist()
  }

  consented(company: Provider, accountId: string): boolean {
    return this.state.consent[consentKey(company, accountId)] === true
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
      root: (() => { try { return canonical(root) } catch { return root } })(),
      ownerId,
      at: new Date().toISOString()
    }
    this.persist()
  }

  /**
   * At-most-once: `done`·`uncertain`·이미 진행 중이면 false — 다시 전달하지 않는다.
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
      root: record?.root ?? canonical(root),
      ownerId: record?.ownerId ?? ownerId,
      at: record?.at ?? new Date().toISOString(),
      ...(record?.notified ? { notified: true as const } : {})
    }
    this.persist()
  }

  /** 아직 화면에 드러내지 않은 불확실 전달 — root 별로. */
  undelivered(root: string): { rootJobId: string; at: string }[] {
    const canonicalRoot = (() => { try { return canonical(root) } catch { return root } })()
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
}
