/**
 * §3 카드 — main 이 짓고 main 이 소비한다. 화면은 카드 id·판·누른 단추만 돌려준다.
 *
 * 적용할 배치는 카드를 만들 때 `proposeLaneRequest` 가 만든 값을 **카드와 함께 저장**하고,
 * `decideCard` 는 그 저장값만 읽는다(§6 "화면은 계산하지 않는다"). 화면 값으로 배치를 다시
 * 짓지 않으므로 두 창·중복 IPC 가 다른 배치를 적용할 수 없다.
 *
 * 소비는 `JobStore.beginCard` 가 원자로 한다(열림→적용중). 판이 바뀌었거나 더 새 카드에
 * 밀려난 카드는 상태를 바꾸지 않고 거절한다. 적용 **직전** 카드에 묶어 둔 로그인 계정과 지금
 * 계정을 다시 대조하고, 다르면 적용도 동의 저장도 하지 않는다([Roh 중요 3]).
 */
import { randomUUID } from 'node:crypto'
import type { Provider } from '../../shared/chat'
import type {
  AccountSnapshot, LaneEntry, LanePlan, LaneRequest, LaneRequestEntry
} from '../../shared/lanes'
import { REVIEW_EFFORT, WORK_LANES, isCrossProviderModelId, judgePlan, proposeLaneRequest, type LaneProposal } from '../../shared/lanes'
import type {
  CardAction, CardDecision, CardInvalidReason, CardRow, CardState, CardVariant, FeeNotice, LaneCard,
  ModelRef, ReviewModelGroup
} from '../../shared/lanes-ipc'
import type { JobRunner } from '../chat/jobs'
import type { ExecutionAccount } from '../chat/jobs/types'
import { canonical } from '../chat/jobs/isolation'
import type { JobStore, StoredCard } from '../chat/jobs/store'
import { maskAccount, publicCard, type LaneAccountView } from './snapshot'
import { LaneFailure } from './failure'
import { providerOf } from './providers'

/** 카드 경로 밖(핸들러·시험)도 같은 형을 쓴다 — 정의는 `./failure` 한 곳. */
export { LaneFailure }
import { laneAccounts, recommendation, type LaneRecommendation } from './source'

/**
 * [이번만]은 v0.7에서 **적용 경로 자체가 꺼져 있다**(DESIGN-C0b 부록 A, DEFERRED-v071-C0b).
 *
 * 차례 범위를 차례 id 없이 판정하려던 것이 C1-04 의 뿌리였다 — 승인 시각과 이어 하기 관계로
 * 좁혀도 "그 차례에 만든 주문"을 정확히 가릴 수 없다. 그래서 v0.7은 {계속} 하나만 받고,
 * `'once'` 요청은 **아무것도 바꾸지 않고** 거절한다. 계약 칸(`CardAction`의 `'once'`,
 * `CardState.applied.scope`의 `'once'`, `boundTurn`, `once-ended`, `temporary`)은 지우지
 * 않는다 — 차례 id 와 함께 v0.7.1 에서 다시 쓴다.
 */
const ONCE_DEFERRED = '이번 차례만 적용은 아직 준비 중이에요 — [계속]으로 정해 주세요.'

/**
 * 폴더 단위 직렬화 — 카드 열기·소비·끄기가 같은 폴더에서 겹치지 않는다.
 *
 * [C1-05] 두 카드가 같은 판(`baseVersion`)을 들고 동시에 들어오면 `beginCard` 는 둘 다 통과시키고
 * 계정 조회 await 사이에 각자 적용된다(마지막 카드가 앞 카드의 배치를 덮는다). [C1-03] 끄기가
 * 끝난 뒤 앞서 시작된 승인이 이어지면 철회된 배치가 되살아난다. 둘 다 "같은 폴더에서 카드 처리는
 * 한 번에 하나"로 닫힌다 — 카드 소비는 원자였지만 **폴더 상태를 읽고 쓰는 구간**이 원자가 아니었다.
 */
const folderChains = new Map<string, Promise<unknown>>()

function withFolderLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const previous = folderChains.get(folder) ?? Promise.resolve()
  // 앞 작업이 실패해도 다음 작업은 돈다 — 잠금이 아니라 **차례**다.
  const next = previous.then(run, run)
  folderChains.set(folder, next.catch(() => undefined))
  return next
}


/** 이 폴더의 카드를 짓고 소비하는 데 필요한 이음매. 계정 조회는 `laneAccounts` 와 같은 모양이다. */
export interface CardDeps {
  store: JobStore
  account: (company: Provider) => Promise<ExecutionAccount | null>
  /** 이 폴더 본대화의 회사 — 설계 차선이 여기로 고정된다(정본 §3.8). */
  mainCompany: Provider
  /** §3-3 끄기 — 진행·대기 주문만 멈춘다(본대화는 건드리지 않는다). */
  runner?: Pick<JobRunner, 'records' | 'stopJob'> | null
  /**
   * 설계를 다른 회사로 바꾸는 적용 — 칩을 다시 쓰고 본대화를 그 회사 대화로 옮긴다(정본
   * §3.1 D2-03). 바뀌었으면 `true`. 이음매가 없으면 그런 카드는 적용하지 않고 `unavailable`
   * 로 돌려준다 — **바뀌지 않았는데 "적용됨"이라고 적지 않는다**(정본 §3.1-7).
   */
  applyDesign?: (root: string, design: LaneEntry) => Promise<boolean>
  /**
   * 캐시를 **건너뛴** 계정 조회 — 카드 적용 직전 대조는 15초 전 값이면 안 된다(C1-06).
   * 없으면 `account` 로 떨어진다(단위 시험·이음매 없는 호출자).
   */
  freshAccount?: (company: Provider) => Promise<ExecutionAccount | null>
}

// ---------------------------------------------------------------- §3 카드 짓기

/**
 * 학생 요청(또는 설정 창) → 카드. `base` 는 승인 배치, 없으면 지금 추천 배치다 — 설정 화면이
 * 보여 주는 값과 같은 것이라 "이전 → 새"가 화면과 어긋나지 않는다.
 */
export async function openCard(
  deps: CardDeps,
  root: string,
  request: LaneRequest,
  variant?: CardVariant
): Promise<LaneCard> {
  const folder = canonical(root)
  return withFolderLock(folder, () => openCardLocked(deps, folder, request, variant))
}

/** 잠금 안쪽 본체 — 같은 폴더에서 다른 카드 처리가 끼어들지 않는다. */
async function openCardLocked(
  deps: CardDeps,
  folder: string,
  request: LaneRequest,
  variant?: CardVariant
): Promise<LaneCard> {
  const accounts = await laneAccounts(deps)
  const approved = deps.store.approvedPlan(folder)
  const recommended = recommendation(accounts.executions, deps.mainCompany, approved?.design?.model ?? null)
  const base = approved ?? recommended?.plan
  if (!base) throw new LaneFailure('unavailable', '맡길 수 있는 계정이 없어요.')
  const proposal = proposeLaneRequest(
    request, recommended?.snapshots ?? accountSnapshots(accounts.executions), base, deps.mainCompany
  )
  const cardId = randomUUID()
  const card: LaneCard = {
    cardId,
    root: folder,
    variant: variant ?? (approved ? 'change' : 'first'),
    baseVersion: deps.store.versionOf(folder),
    createdAt: new Date().toISOString(),
    reviewDue: false,
    quote: request.quote ? request.quote : null,
    rows: cardRows(proposal, request),
    fees: feeNotices([proposal.next, proposal.base], accounts.views),
    fastDrain: fastDrain(proposal.next, accounts.views),
    recommendedDesign: designRef(recommended),
    state: { kind: 'open' }
  }
  // 더 새 카드가 앞 카드를 밀어낸다 — 앞 카드는 "새 카드로 바뀌었어요"로 접힌다.
  deps.store.supersedeOpenCards(folder, cardId, cardId)
  deps.store.addCard(card, boundAccounts([proposal.base, proposal.next], accounts.views), proposal.next)
  return publicCard(card)
}

/**
 * §3-3 설정 확인 창 카드. 범위는 [계속] 하나뿐이고, 적용하면 `applied` 인 접힌 카드로 대화에
 * 들어간다(F5). 열려 있는 동안은 대화 묶음에서 빠진다(`snapshot.ts`).
 */
export async function settingsCard(deps: CardDeps, root: string, kind: 'enable' | 'revert'): Promise<LaneCard> {
  const folder = canonical(root)
  return withFolderLock(folder, () => settingsCardLocked(deps, folder, kind))
}

async function settingsCardLocked(deps: CardDeps, folder: string, kind: 'enable' | 'revert'): Promise<LaneCard> {
  const accounts = await laneAccounts(deps)
  const approved = deps.store.approvedPlan(folder)
  if (kind === 'revert' && !approved) throw new LaneFailure('not-found', '되돌릴 배치가 없어요.')
  const recommended = recommendation(accounts.executions, deps.mainCompany, approved?.design?.model ?? null)
  if (!recommended) throw new LaneFailure('unavailable', '추천 배치를 정할 수 없어요.')
  const card: LaneCard = {
    cardId: randomUUID(),
    root: folder,
    variant: kind === 'enable' ? 'settings-enable' : 'settings-revert',
    baseVersion: deps.store.versionOf(folder),
    createdAt: new Date().toISOString(),
    reviewDue: false,
    quote: null,
    rows: diffRows(approved, recommended.plan),
    fees: feeNotices([recommended.plan, approved], accounts.views),
    fastDrain: fastDrain(recommended.plan, accounts.views),
    recommendedDesign: designRef(recommended),
    state: { kind: 'open' }
  }
  // 설정 창의 카드는 대화 카드를 밀어내지 않는다 — 아직 학생이 누르지 않았다.
  deps.store.addCard(card, boundAccounts([approved, recommended.plan], accounts.views), recommended.plan)
  return publicCard(card)
}

/** §3-4 검토 모델 목록 — 그 계정 모델 중 `high` 를 지원하는 것만. 추천·자동 선택 없음. */
export async function reviewModels(deps: Pick<CardDeps, 'account'>): Promise<ReviewModelGroup[]> {
  const groups: ReviewModelGroup[] = []
  for (const company of ['claude', 'codex'] as const) {
    const account = await deps.account(company)
    const models = account?.account.models
    if (!models) continue
    const list = models
      .filter(entry => !isCrossProviderModelId(entry.model) && entry.efforts.includes(REVIEW_EFFORT))
      .map(entry => ({ model: entry.model, name: entry.name }))
    if (list.length) groups.push({ company, models: list })
  }
  return groups
}

/** §3-4 고르기 — 고르는 것만으로는 적용되지 않는다. §3-2 카드(검토 줄 하나)를 연다. */
export async function pickReview(deps: CardDeps, root: string, company: Provider, model: string): Promise<LaneCard> {
  // [C1-01] 회사 값은 계정 조회(그리고 실행 파일 선택) **전에** 닫는다.
  const provider = providerOf(company)
  const folder = canonical(root)
  return withFolderLock(folder, async () => {
    const account = await deps.account(provider)
    const matched = account?.account.models?.find(entry => entry.model === model)
    if (!matched || !matched.efforts.includes(REVIEW_EFFORT)) {
      throw new LaneFailure('not-found', '검토에 쓸 수 있는 모델이 아니에요.')
    }
    return openCardLocked(deps, folder, {
      scope: 'continue',
      quote: '',
      lanes: { review: { company: provider, model: matched.model, effort: REVIEW_EFFORT } }
    }, 'change')
  })
}

/**
 * §5 [나눠 맡기기 끄기] — 확인 창 뒤 한 번. 승인 배치를 거두고 진행·대기 주문을 멈춘다.
 * 요금 동의(계정 단위)는 건드리지 않는다 — 끄기는 배치를 접는 일이다.
 */
export async function disable(deps: CardDeps, root: string): Promise<void> {
  const folder = canonical(root)
  return withFolderLock(folder, () => disableLocked(deps, folder))
}

async function disableLocked(deps: CardDeps, folder: string): Promise<void> {
  const runner = deps.runner ?? null
  for (const record of runner?.records() ?? []) {
    if (record.root !== folder) continue
    if (record.status !== 'queued' && record.status !== 'running' && record.status !== 'limit') continue
    await runner!.stopJob(record.spec.id)
  }
  deps.store.revokePlan(folder)
  deps.store.clearTemporary(folder)
  deps.store.addEvent(folder, { id: randomUUID(), at: new Date().toISOString(), kind: 'lanes-declined' })
  // 끄기는 배치를 바꾼 일이다 — 그 전에 만든 카드는 옛 판을 들고 있으므로 닫는다([C1-03]).
  deps.store.bumpVersion(folder)
}

// ---------------------------------------------------------------- §3 카드 소비

/**
 * 카드 단추 하나를 원자로 소비한다. 거절 사유는 카드 상태로 남기고, 적용된 배치·동의는 앱
 * 저장소에만 쓴다. 돌려주는 카드는 화면용(`publicCard`)이다 — 계정 id·배치가 새지 않는다.
 */
export async function decideCard(
  deps: CardDeps,
  root: string,
  cardId: string,
  baseVersion: number,
  action: CardAction
): Promise<CardDecision> {
  const folder = canonical(root)
  // [C1-03·05] 같은 폴더에서 카드 처리는 한 번에 하나 — 계정 조회 await 사이에 다른 카드나
  // 끄기가 끼어들면 판 검사가 무의미해진다.
  return withFolderLock(folder, () => decideCardLocked(deps, folder, cardId, baseVersion, action))
}

async function decideCardLocked(
  deps: CardDeps,
  folder: string,
  cardId: string,
  baseVersion: number,
  action: CardAction
): Promise<CardDecision> {
  const stored = deps.store.card(cardId)
  if (!stored || canonical(stored.root) !== folder) throw new LaneFailure('not-found', '카드를 찾지 못했어요.')
  checkAction(stored.variant, action)
  const plan = deps.store.cardPlan(cardId)
  const design = plan?.design ?? null
  const switchesDesign = Boolean(design && design.company !== deps.mainCompany)
  // 모두 거절된 카드는 [확인]만 받는다(UI-DESIGN §3-5) — 적용할 줄이 없는데 "적용됨"을 만들지
  // 않고, 바뀌는 줄이 있는 카드는 [확인]으로 접지 않는다(누를 단추는 [계속]/[이번만]이다).
  const allRejected = stored.rows.length > 0 && stored.rows.every(row => row.rejected !== null)
  if (allRejected && action !== 'ack' && action !== 'cancel') {
    throw new LaneFailure('internal', '이 카드는 바꿀 수 있는 줄이 없어 [확인]만 받아요.')
  }
  if (!allRejected && action === 'ack') {
    throw new LaneFailure('internal', '이 카드에는 [확인]이 없어요.')
  }
  // 이음매가 없으면 **누르기 전에** 막는다 — 카드를 적용중으로 붙잡아 두지 않는다.
  if (switchesDesign && !deps.applyDesign) {
    throw new LaneFailure('unavailable', '설계를 다른 회사로 바꾸는 적용이 아직 앱에 이어지지 않았어요.')
  }
  // [C1-04 덜어냄] v0.7은 [이번만]을 쓰지 않는다 — 소비(`beginCard`) **전에** 닫는다. 상태를
  // 건드리지 않으므로 카드는 열린 채로 남고 학생은 [계속]을 다시 누를 수 있다.
  if (action === 'once') throw new LaneFailure('unavailable', ONCE_DEFERRED)

  const claim = deps.store.beginCard(cardId, baseVersion)
  if (!claim.ok) {
    if (claim.reason === 'not-found') throw new LaneFailure('not-found', '카드를 찾지 못했어요.')
    // 이미 접힌 카드는 상태를 덮어쓰지 않는다 — 두 번째 클릭·중복 IPC 가 "적용됨" 기록을
    // "무효"로 바꾸면 §3-5 접힌 줄이 통째로 사라진다. 밀려난 카드만 그 사유를 돌려준다.
    if (claim.card && claim.card.state.kind !== 'open') {
      if (claim.card.state.kind === 'superseded') {
        return { outcome: 'invalid', reason: 'superseded', card: publicCard(claim.card), boundTurn: null }
      }
      return { outcome: 'already-handled', reason: null, card: publicCard(claim.card), boundTurn: null }
    }
    // 아직 열려 있는데 판이 바뀐 카드 — 적용하지 않고 무효로 접는다.
    const settled = deps.store.settleCard(cardId, { kind: 'invalid' })
    return {
      outcome: 'invalid',
      reason: claim.reason === 'base-version' ? 'base-version' : null,
      card: publicCard(settled ?? stored),
      boundTurn: null
    }
  }

  // 옛 파일의 카드 — 무엇을 적용할지 main 이 갖고 있지 않다. 화면 값으로 다시 짓지 않고 닫는다.
  if (!plan) return closeAsInvalid(deps, cardId, null)

  // 계정 결박 대조 — 카드를 띄운 계정과 **지금** 계정이 하나라도 다르면 아무것도 저장하지 않는다.
  // [C1-06] 이 대조는 권한을 바꾸기 직전이라 캐시를 건너뛴 관측을 쓴다(15초 전 값이면 A 카드가
  // B 계정에서 적용된다). 관측 실패(`null`)도 불일치다 — 모르면 닫는다.
  const fresh = deps.freshAccount ?? deps.account
  for (const company of ['claude', 'codex'] as const) {
    const bound = stored.boundAccounts[company]
    if (!bound) continue
    const account = await fresh(company)
    if (account?.accountId === bound) continue
    return closeAsInvalid(deps, cardId, 'account-changed')
  }

  // 여기까지 await 가 있었다 — 그 사이 끄기·새 카드가 폴더 상태를 바꿨을 수 있다([C1-03]).
  // 폴더 판이 그대로이고 이 카드가 아직 적용 중일 때만 실제 적용으로 넘어간다.
  if (deps.store.versionOf(folder) !== baseVersion) return closeAsInvalid(deps, cardId, 'base-version')
  const live = deps.store.card(cardId)
  if (!live || live.state.kind !== 'applying') return alreadyHandled(live ?? stored)

  switch (action) {
    case 'continue': {
      // 부작용(설계 칩 바꾸기)은 **승인 분기 안에서만** — 취소·거절은 아무것도 바꾸지 않는다(
      // [C1-02]: 예전에는 계정 대조 뒤 action 분기보다 먼저 불렀다).
      if (switchesDesign) {
        const applied = await deps.applyDesign!(folder, design!)
        if (!applied) return closeAsInvalid(deps, cardId, null)
      }
      saveConsents(deps, stored)
      deps.store.approve(folder, plan)
      return settle(deps, cardId, { kind: 'applied', scope: 'continue' }, null, null)
    }
    case 'decline':
      deps.store.addEvent(folder, { id: randomUUID(), at: new Date().toISOString(), kind: 'lanes-declined' })
      return settle(deps, cardId, { kind: 'declined' }, null, null)
    default:
      return settle(deps, cardId, { kind: 'cancelled' }, null, null)
  }
}

/** 이미 접힌 카드(두 창·중복 IPC) — 상태를 덮어쓰지 않고 그대로 알린다. */
function alreadyHandled(card: StoredCard): CardDecision {
  if (card.state.kind === 'superseded') {
    return { outcome: 'invalid', reason: 'superseded', card: publicCard(card), boundTurn: null }
  }
  return { outcome: 'already-handled', reason: null, card: publicCard(card), boundTurn: null }
}

/** §3-5 [다시 확인] — 상태만 묻는다. 다시 적용하지 않고 아무것도 바꾸지 않는다. */
export function cardStatus(deps: Pick<CardDeps, 'store'>, root: string, cardId: string): CardDecision {
  const folder = canonical(root)
  const stored = deps.store.card(cardId)
  if (!stored || canonical(stored.root) !== folder) throw new LaneFailure('not-found', '카드를 찾지 못했어요.')
  const card = publicCard(stored)
  switch (stored.state.kind) {
    case 'open':
      return { outcome: 'open', reason: null, card, boundTurn: null }
    case 'applying':
      return { outcome: 'pending', reason: null, card, boundTurn: null }
    case 'superseded':
      return { outcome: 'invalid', reason: 'superseded', card, boundTurn: null }
    // 계약 `CardState` 는 무효 사유를 담지 않는다 — 두 창·판 불일치·계정 변경을 구별할 수 없다.
    case 'invalid':
      return { outcome: 'invalid', reason: null, card, boundTurn: null }
    default:
      return { outcome: 'already-handled', reason: null, card, boundTurn: null }
  }
}

// ---------------------------------------------------------------- 카드 조각

/** 그 갈래에서 쓸 수 없는 단추는 애초에 소비하지 않는다 — 카드는 열린 채로 남는다. */
function checkAction(variant: CardVariant, action: CardAction): void {
  if (variant.startsWith('settings-')) {
    if (action === 'continue' || action === 'cancel' || action === 'ack') return
    throw new LaneFailure('internal', '설정에서 연 카드는 [계속]만 받아요.')
  }
  // [나눠 맡기지 않기]는 §3-1 처음 카드에만 있다.
  if (action === 'decline' && variant !== 'first') throw new LaneFailure('internal', '이 카드에는 [나눠 맡기지 않기]가 없어요.')
}

function settle(
  deps: CardDeps,
  cardId: string,
  state: CardState,
  reason: CardInvalidReason | null,
  boundTurn: CardDecision['boundTurn']
): CardDecision {
  const settled = deps.store.settleCard(cardId, state)
  if (!settled) throw new LaneFailure('not-found', '카드를 찾지 못했어요.')
  return { outcome: 'applied', reason, card: publicCard(settled), boundTurn }
}

function closeAsInvalid(deps: CardDeps, cardId: string, reason: CardInvalidReason | null): CardDecision {
  const settled = deps.store.settleCard(cardId, { kind: 'invalid' })
  if (!settled) throw new LaneFailure('not-found', '카드를 찾지 못했어요.')
  return { outcome: 'invalid', reason, card: publicCard(settled), boundTurn: null }
}

/** 요금 동의는 카드에 낀 회사의 **카드를 띄운 계정 id** 에 남는다([이번만]도 동의는 남는다). */
function saveConsents(deps: CardDeps, stored: StoredCard): void {
  for (const fee of stored.fees) {
    const accountId = stored.boundAccounts[fee.company]
    if (accountId) deps.store.setConsent(fee.company, accountId, true)
  }
}

/**
 * 바뀌는 줄. 거절된 줄은 `after` 가 이전 값 그대로이고 `requested` 가 학생이 요청한 값이다.
 * 설계 회사가 바뀌면 **그 줄 하나만** `designSwitchTo` 를 단다(UI-DESIGN §3-2) — 평소 설계는
 * 칩이 정본이라 줄로 넣지 않는다(D2-03).
 */
function cardRows(proposal: LaneProposal, request: LaneRequest): CardRow[] {
  const rows: CardRow[] = []
  const design = designRow(proposal, request)
  if (design) rows.push(design)
  for (const { lane } of WORK_LANES) {
    if (lane === 'design') continue
    const before = proposal.base[lane] ?? null
    const rejected = proposal.rejected.find(entry => entry.lane === lane)
    if (rejected) {
      rows.push({
        lane, before, after: before, rejected: rejected.reason, designSwitchTo: null,
        requested: requestedOf(request.lanes[lane])
      })
      continue
    }
    const after = proposal.next[lane] ?? null
    if (!sameEntry(before, after)) {
      rows.push({ lane, before, after, rejected: null, designSwitchTo: null, requested: null })
    }
  }
  return rows
}

function designRow(proposal: LaneProposal, request: LaneRequest): CardRow | null {
  const before = proposal.base.design ?? null
  const rejected = proposal.rejected.find(entry => entry.lane === 'design')
  if (rejected) {
    return {
      lane: 'design', before, after: before, rejected: rejected.reason, designSwitchTo: null,
      requested: requestedOf(request.lanes.design)
    }
  }
  const after = proposal.next.design ?? null
  if (!sameEntry(before, after)) {
    return {
      lane: 'design', before, after, rejected: null,
      // 같은 회사면 칩의 모델만 바뀐다 — 대화가 넘어가는 것은 회사가 바뀔 때뿐이다.
      designSwitchTo: before && after && before.company !== after.company ? after.company : null,
      requested: null
    }
  }
  return null
}

/** 설정 카드 — 승인 배치(없으면 빈 값) → 추천 배치. 거절 줄이 없다(추천은 검증된 값이다). */
function diffRows(base: LanePlan | null, next: LanePlan): CardRow[] {
  const rows: CardRow[] = []
  for (const { lane } of WORK_LANES) {
    const before = base?.[lane] ?? null
    const after = next[lane] ?? null
    if (sameEntry(before, after)) continue
    rows.push({
      lane, before, after, rejected: null,
      designSwitchTo: before && after && before.company !== after.company ? after.company : null,
      requested: null
    })
  }
  return rows
}

function sameEntry(a: LaneEntry | null, b: LaneEntry | null): boolean {
  if (!a || !b) return a === b
  return a.company === b.company && a.model === b.model && a.effort === b.effort && a.how === b.how
}

function requestedOf(entry: LaneRequestEntry | undefined): CardRow['requested'] {
  if (!entry) return null
  return { main: entry.main === true, model: entry.model ?? null, effort: entry.effort ?? null }
}

/** 카드에 끼는 회사 — 배치의 모든 차선에 등장하는 회사. 이 회사들의 계정만 결박한다. */
function boundAccounts(
  plans: (LanePlan | null)[],
  views: Partial<Record<Provider, LaneAccountView>>
): Partial<Record<Provider, string>> {
  const bound: Partial<Record<Provider, string>> = {}
  for (const company of ['claude', 'codex'] as const) {
    const view = views[company]
    if (!view) continue
    const involved = plans.some(plan => WORK_LANES.some(({ lane }) => plan?.[lane]?.company === company))
    if (involved) bound[company] = view.accountId
  }
  return bound
}

/**
 * 요금 안내 — **주문이 나가는** 회사(`how:'relay'`)만. 설계·직접 맡기는 차선은 본대화가 하므로
 * 따로 동의 상자를 띄우지 않는다. 이미 동의한 회사는 화면이 한 줄로 줄인다.
 */
function feeNotices(plans: (LanePlan | null)[], views: Partial<Record<Provider, LaneAccountView>>): FeeNotice[] {
  const notices: FeeNotice[] = []
  for (const company of ['claude', 'codex'] as const) {
    const view = views[company]
    if (!view) continue
    const relay = plans.some(plan => WORK_LANES.some(({ lane }) => {
      const entry = plan?.[lane]
      return entry?.how === 'relay' && entry.company === company
    }))
    if (!relay) continue
    notices.push({ company, accountLabel: maskAccount(view.accountId), consented: view.consented })
  }
  return notices
}

/** 한도가 빨리 주는 조합(높음 요금제) — 막지 않고 알리기만 한다. */
function fastDrain(plan: LanePlan, views: Partial<Record<Provider, LaneAccountView>>): boolean {
  return WORK_LANES.some(({ lane }) => {
    const entry = plan[lane]
    if (!entry || entry.how !== 'relay') return false
    const view = views[entry.company]
    return Boolean(view && judgePlan(view.account).tier === 'high')
  })
}

function designRef(recommended: LaneRecommendation | null): ModelRef | null {
  const design = recommended?.plan.design ?? null
  return design?.model ? { company: design.company, model: design.model, effort: design.effort } : null
}

function accountSnapshots(executions: Partial<Record<Provider, ExecutionAccount>>): AccountSnapshot[] {
  const snapshots: AccountSnapshot[] = []
  for (const company of ['claude', 'codex'] as const) {
    const account = executions[company]
    if (account) snapshots.push(account.account)
  }
  return snapshots
}
