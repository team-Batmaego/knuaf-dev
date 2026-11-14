/**
 * §6 상태 묶음의 **이음매** — `ChatService` 가 아는 것(계정·승인·러너·저장소)을 묶음 조립기에
 * 넘긴다. 조립기(`snapshot.ts`)는 저장소·러너만 읽고, 계정 조회는 여기서 한 번만 한다.
 *
 * 폴더가 없으면(`root === null`) 계정도 요금 동의 줄도 전역 연결에서 읽는다 — §5 요금 동의는
 * 폴더 없이도 보이고, 그때 모드는 `null` 이다.
 */
import type { Provider } from '../../shared/chat'
import type { AccountSnapshot, LaneEntry, LaneNote, LanePlan, LaneRowId } from '../../shared/lanes'
import { judgePlan, planFromRow, resolveLanes, selectLaneRow } from '../../shared/lanes'
import type { LanesSnapshot } from '../../shared/lanes-ipc'
import type { JobRunner } from '../chat/jobs'
import type { ExecutionAccount } from '../chat/jobs/types'
import type { JobStore } from '../chat/jobs/store'
import {
  LanesPublisher, lanesSettings, type LaneAccountView, type LaneInput
} from './snapshot'

/** 이 폴더 상태를 만들기 위해 `ChatService` 가 넘기는 읽기 이음매. */
export interface LaneSource {
  store: JobStore
  runner: JobRunner | null
  /** 이 폴더 본대화의 회사 — 설계 차선이 여기로 고정된다(정본 §3.8). */
  mainCompany: Provider
  /** 지금 로그인한 계정. 없으면 그 회사는 `undefined`. */
  account: (company: Provider) => Promise<ExecutionAccount | null>
  /** §4-2 한도로 멈춘 대화 — 인계 이음매가 없으면 빈 배열(U6). */
  archives?: (root: string) => LanesSnapshot['archives']
  /** §4-1 본대화 인계 줄 — 인계 이음매가 없으면 빈 배열(U6). */
  extraLines?: (root: string) => LanesSnapshot['lines']
}

/** 엔진이 준 계정과 조립기용 보기 — 두 회사를 한 번씩만 묻는다. */
export interface LaneAccounts {
  executions: Partial<Record<Provider, ExecutionAccount>>
  views: Partial<Record<Provider, LaneAccountView>>
}

export async function laneAccounts(
  source: Pick<LaneSource, 'account'>
): Promise<LaneAccounts> {
  const executions: Partial<Record<Provider, ExecutionAccount>> = {}
  const views: Partial<Record<Provider, LaneAccountView>> = {}
  for (const company of ['claude', 'codex'] as const) {
    const account = await source.account(company)
    if (!account) continue
    executions[company] = account
    views[company] = {
      connected: account.connected,
      consented: account.consented,
      usage: account.usage,
      accountId: account.accountId,
      account: account.account
    }
  }
  return { executions, views }
}

/** 추천 줄 + 제안에 필요한 계정 묶음. 계정이 없거나 차선표를 못 고르면 `null`. */
export interface LaneRecommendation {
  rowId: LaneRowId
  plan: LanePlan
  notes: LaneNote[]
  /** `proposeLaneRequest` 가 요금제·모델 목록을 판정하는 데 쓰는 값. */
  snapshots: AccountSnapshot[]
}

/**
 * 추천 배치 — 두 회사의 요금제를 읽어 차선표 한 줄을 고른다. 계정이 하나도 없으면 `null`.
 * `mainCompany` 를 설계 회사로 고정한다(설계는 본대화가 맡는다).
 */
export function recommendation(
  accounts: Partial<Record<Provider, ExecutionAccount>>,
  mainCompany: Provider,
  designModel: string | null
): LaneRecommendation | null {
  const snapshots = (['claude', 'codex'] as const)
    .map(company => accounts[company]?.account)
    .filter((account): account is AccountSnapshot => Boolean(account))
  if (!snapshots.length) return null
  const tiers = snapshots.map(account => judgePlan(account))
  const claudeTier = tiers.find(tier => tier.company === 'claude')?.tier ?? null
  const codexTier = tiers.find(tier => tier.company === 'codex')?.tier ?? null
  const rowId = selectLaneRow(claudeTier, codexTier)
  if (!rowId) return null
  const catalog = Object.fromEntries(snapshots.map(account => [account.company, account.models])) as Partial<
    Record<Provider, AccountSnapshot['models']>
  >
  const resolved = resolveLanes(rowId, {
    mainCompany,
    catalog,
    design: designModel ? { model: designModel, effort: null } : undefined
  })
  return { rowId, plan: resolved.plan, notes: resolved.notes, snapshots }
}

/** 저장소·러너 → 조립기 입력. 폴더가 없으면 승인·카드·주문 줄이 모두 비어 있다. */
export async function laneInput(source: LaneSource, root: string | null): Promise<LaneInput> {
  const { executions, views } = await laneAccounts(source)
  const design = root ? source.store.approvedPlan(root)?.design?.model ?? null : null
  const recommended = recommendation(executions, source.mainCompany, design)
  const settings = lanesSettings({
    root,
    store: source.store,
    mainCompany: source.mainCompany,
    accounts: views,
    recommended: recommended ? { rowId: recommended.rowId, plan: recommended.plan, notes: recommended.notes } : null,
    // [C1-04 덜어냄] v0.7은 [이번만]을 쓰지 않는다 — 설정 화면의 "지금 이번 차례만" 줄도
    // 비어 있다. 옛 판이 남긴 `temporary` 를 여기서 읽어 보여 주면 쓰지 않는 배치를 광고한다.
    temporary: [],
    temporaryDesign: null
  })
  return {
    root,
    store: source.store,
    runner: source.runner,
    settings,
    accounts: views,
    archives: root && source.archives ? source.archives(root) : [],
    extraLines: root && source.extraLines ? source.extraLines(root) : []
  }
}

/** 묶음을 지어 보낸다. `send` 는 `ipc.ts` 가 넘기는 창 송신기. */
export function lanesPublisher(source: LaneSource, send: (snapshot: LanesSnapshot) => void): {
  publish: (root: string | null) => Promise<LanesSnapshot>
} {
  const publisher = new LanesPublisher(snapshot => send(snapshot))
  return { publish: async root => publisher.publish(await laneInput(source, root)) }
}

/** 추천 줄 id 만 필요한 호출자(설정 창)용 — 조립기 전체를 돌리지 않는다. */
export function recommendedRow(accounts: Partial<Record<Provider, ExecutionAccount>>): LaneRowId | null {
  const claude = accounts.claude ? judgePlan(accounts.claude.account) : null
  const codex = accounts.codex ? judgePlan(accounts.codex.account) : null
  return selectLaneRow(claude?.tier ?? null, codex?.tier ?? null)
}

/** 추천 줄의 설계 모델 — [F2] "아래 칩에서 골라요 (추천 {회사 모델)". */
export function recommendedDesignModel(rowId: LaneRowId): string | null {
  return planFromRow(rowId).design?.model ?? null
}
