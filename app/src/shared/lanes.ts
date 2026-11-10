export type Provider = 'codex' | 'claude'
export type WorkLane = 'design' | 'research' | 'writing' | 'repeat' | 'review'

export type PlanTier = 'high' | 'low'
export type LaneHow = 'main' | 'sub' | 'relay'

export type LaneRowId =
  | 'codex-low'
  | 'codex-high'
  | 'claude-low'
  | 'claude-high'
  | 'both-high'
  | 'claude-high-codex-low'
  | 'claude-low-codex-high'
  | 'both-low'

export interface LaneEntry {
  company: Provider
  model: string | null
  effort: string | null
  how: LaneHow
}

export type LanePlan = Record<WorkLane, LaneEntry | null>

export interface LaneRow {
  id: LaneRowId
  label: string
  lanes: Record<WorkLane, LaneEntry>
}

export const REVIEW_EFFORT = 'high'

function lane(company: Provider, model: string, how: LaneHow, effort: string | null = null): LaneEntry {
  return { company, model, effort, how }
}

function row(
  id: LaneRowId,
  label: string,
  design: LaneEntry,
  research: LaneEntry,
  writing: LaneEntry,
  repeat: LaneEntry,
  review: LaneEntry
): LaneRow {
  return {
    id,
    label,
    lanes: { design, research, writing, repeat, review }
  }
}

export const LANE_TABLE: Record<LaneRowId, LaneRow> = {
  'codex-low': row(
    'codex-low',
    'ChatGPT 낮음만',
    lane('codex', 'terra', 'main'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'terra', 'relay', REVIEW_EFFORT)
  ),
  'codex-high': row(
    'codex-high',
    'ChatGPT 높음만',
    lane('codex', 'sol', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('codex', 'sol', 'relay'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'astra', 'relay', REVIEW_EFFORT)
  ),
  'claude-low': row(
    'claude-low',
    'Claude 낮음만',
    lane('claude', 'sonnet', 'main'),
    lane('claude', 'haiku', 'relay'),
    lane('claude', 'sonnet', 'relay'),
    lane('claude', 'haiku', 'relay'),
    lane('claude', 'sonnet', 'relay', REVIEW_EFFORT)
  ),
  'claude-high': row(
    'claude-high',
    'Claude 높음만',
    lane('claude', 'opus', 'main'),
    lane('claude', 'sonnet', 'relay'),
    lane('claude', 'sonnet', 'relay'),
    lane('claude', 'haiku', 'relay'),
    lane('claude', 'opus', 'relay', REVIEW_EFFORT)
  ),
  'both-high': row(
    'both-high',
    '둘 다 높음',
    lane('claude', 'opus', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('codex', 'sol', 'relay'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'astra', 'relay', REVIEW_EFFORT)
  ),
  'claude-high-codex-low': row(
    'claude-high-codex-low',
    'Claude 높음 + ChatGPT 낮음',
    lane('claude', 'opus', 'main'),
    lane('claude', 'sonnet', 'relay'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('claude', 'opus', 'relay', REVIEW_EFFORT)
  ),
  'claude-low-codex-high': row(
    'claude-low-codex-high',
    'Claude 낮음 + ChatGPT 높음',
    lane('codex', 'sol', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('codex', 'sol', 'relay'),
    lane('codex', 'terra', 'relay'),
    lane('claude', 'sonnet', 'relay', REVIEW_EFFORT)
  ),
  'both-low': row(
    'both-low',
    '둘 다 낮음',
    lane('claude', 'sonnet', 'main'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('claude', 'haiku', 'relay'),
    lane('codex', 'terra', 'relay', REVIEW_EFFORT)
  )
}
// ---------------------------------------------------------------- 모델 추천 (형님 확정표)
//
// 형님 확정표(`../DECISIONS.md` '최종 추천 레인 배치')를 **그대로** 옮긴 데이터다. 화면은
// 이 상수와 `codexRecommendations()` 만 쓰면 되고, 문구를 화면 쪽에서 다시 짓지 않는다.
//
// 값은 **별칭**(sol·terra·astra·luna)이다. 계정이 실제로 쓰는 모델 id 는 요금제마다 달라
// 아직 확인되지 않았다 — `model/list` 가 준 model/name 의 **끝 낱말**이 별칭인지로 찾는다
// (`resolveCodexAlias`). 실제 목록을 실기기에서 확인하면 `CODEX_MODEL_ALIASES` 만 고치면 된다.

export const WORK_LANES: { lane: WorkLane; label: string }[] = [
  { lane: 'design', label: '설계' },
  { lane: 'research', label: '자료 찾기' },
  { lane: 'writing', label: '글쓰기' },
  { lane: 'repeat', label: '반복 작업' },
  { lane: 'review', label: '검토(새 대화)' }
]
export type CodexTier = 'low' | 'high'
/** 추천 맵은 ChatGPT 낮음·높음 전용 행에서 파생한다. */
export const CODEX_TIER_MODELS: Record<CodexTier, Record<WorkLane, string>> = {
  low: {
    design: LANE_TABLE['codex-low'].lanes.design.model!,
    research: LANE_TABLE['codex-low'].lanes.research.model!,
    writing: LANE_TABLE['codex-low'].lanes.writing.model!,
    repeat: LANE_TABLE['codex-low'].lanes.repeat.model!,
    review: LANE_TABLE['codex-low'].lanes.review.model!
  },
  high: {
    design: LANE_TABLE['codex-high'].lanes.design.model!,
    research: LANE_TABLE['codex-high'].lanes.research.model!,
    writing: LANE_TABLE['codex-high'].lanes.writing.model!,
    repeat: LANE_TABLE['codex-high'].lanes.repeat.model!,
    review: LANE_TABLE['codex-high'].lanes.review.model!
  }
}
/** 별칭 판정 낱말. 목록의 model·name 의 끝 낱말이 별칭인지 확인한다. */
export const CODEX_MODEL_ALIASES: Record<string, string[]> = {
  sol: ['sol'], terra: ['terra'], astra: ['astra'], luna: ['luna']
}

/**
 * 다른 공급자로 우회되는 id 인가 — OpenAI 쪽 id 에는 `공급자/` 접두어가 없고, 다른 공급자
 * 모델은 전부 `<공급자>/…` 형식이다(DQA-01 실측: `anthropic/claude-…`,
 * `commandcode-auth/gpt-5.6-terra`). 이런 id 는 이 ChatGPT 계정의 모델이 아니므로 목록·추천·
 * 전송 어디에도 올리지 않는다 — 고르면 다른 회사·다른 과금 경로로 간다.
 */
export function isCrossProviderModelId(model: string): boolean {
  return model.includes('/')
}

export interface LaneRecommendation { lane: WorkLane; label: string; model: string }
export interface CodexRecommendation {
  /** 이 계정 목록으로 고른 줄. Sol·Astra 가 보이면 높음, 아니면 낮음. */
  tier: CodexTier
  /** 그 줄에서 **목록에 있는** 모델만 남긴 추천. 목록에 없는 모델은 빼고 칩에도 안 띄운다. */
  lanes: LaneRecommendation[]
  /** 모델별 용도 한 줄 — `model` 키, 값은 그 모델이 추천된 레인 이름들(` · ` 로 이은 문구). */
  byModel: Record<string, { alias: string; lanes: WorkLane[]; purpose: string }>
}

/**
 * 별칭 하나가 가리키는 모델을 계정 목록에서 찾는다. 없으면 undefined.
 *
 * 예전에는 model·name **어디에든** 별칭 낱말이 들어 있으면 맞다고 봤다. 그래서
 * `commandcode-auth/gpt-5.6-terra` 같은 다른 공급자 모델이 terra 로 잡혀 추천이 붙었다
 * (DQA-01). 지금은 **끝 낱말**만 본다 — `GPT-6.1-Sol` → `sol`, `GPT Sol (높음)` → `sol`.
 * 다른 공급자 id 는 애초에 넘기지 않지만, 넘어와도 여기서 다시 거른다. 세대가 읽히는
 * 후보가 있으면 가장 높은 GPT 버전을 고르고, 없거나 동률이면 목록의 첫 후보를 쓴다.
 */
export function resolveCodexAlias(models: readonly { model: string; name: string }[], alias: string): string | undefined {
  const words = (CODEX_MODEL_ALIASES[alias] ?? [alias]).map((w) => w.toLowerCase())
  let best: string | undefined
  let bestVersion: number[] | null = null
  for (const m of models) {
    if (isCrossProviderModelId(m.model)) continue
    if (!words.includes(lastWord(m.model)) && !words.includes(lastWord(m.name))) continue
    const version = codexVersion(m.model) ?? codexVersion(m.name)
    if (best === undefined || (version && (!bestVersion || compareVersion(version, bestVersion) > 0))) {
      best = m.model
      bestVersion = version
    }
  }
  return best
}

/** GPT 뒤의 세대만 읽는다 — 다른 숫자(설명·날짜)를 모델 버전으로 오인하지 않는다. */
function codexVersion(text: string): number[] | null {
  const match = /\bgpt[-\s]+(\d+(?:\.\d+)*)/i.exec(text)
  return match ? match[1].split('.').map(Number) : null
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 낱말 하나로 쪼갠 마지막 토큰 — `gpt-6.1-sol` → `sol`, `GPT Sol (높음)` → `sol`. */
function lastWord(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words[words.length - 1] ?? ''
}

/**
 * 계정이 쓸 수 있는 모델 목록 → 형님 표의 추천.
 *
 * 줄 판정: 이번 판 규칙은 **높음 줄 전용 모델(Sol·Astra)이 목록에 하나라도 보이면 높음**이다
 * (`../DECISIONS.md`: "Sol·Astra 가 있으면 높음"). 요금제별 실제 목록이 아직 확인되지 않아
 * 추측을 최소화한 규칙이고, 실기기 확인 뒤 이 함수 하나만 고치면 화면은 그대로다.
 */
export function codexRecommendations(models: readonly { model: string; name: string }[]): CodexRecommendation {
  const highOnly = ['sol', 'astra'].filter((a) => resolveCodexAlias(models, a))
  const tier: CodexTier = highOnly.length > 0 ? 'high' : 'low'
  const lanes: LaneRecommendation[] = []
  const byModel: CodexRecommendation['byModel'] = {}
  for (const { lane, label } of WORK_LANES) {
    const alias = CODEX_TIER_MODELS[tier][lane]
    const model = resolveCodexAlias(models, alias)
    if (!model) continue
    lanes.push({ lane, label, model })
    const got = (byModel[model] ??= { alias, lanes: [], purpose: '' })
    got.lanes.push(lane)
  }
  for (const entry of Object.values(byModel)) {
    const labels = WORK_LANES.filter((l) => entry.lanes.includes(l.lane)).map((l) => l.label)
    entry.purpose = labels.join(' · ')
  }
  return { tier, lanes, byModel }
}

export function planFromRow(value: LaneRowId | LaneRow): LanePlan {
  const source = typeof value === 'string' ? LANE_TABLE[value] : value
  return {
    design: { ...source.lanes.design },
    research: { ...source.lanes.research },
    writing: { ...source.lanes.writing },
    repeat: { ...source.lanes.repeat },
    review: { ...source.lanes.review }
  }
}

export type UnusableReason = 'claude-api-key' | 'codex-not-chatgpt'

export interface SubscriptionVerdict {
  usable: boolean
  reason: UnusableReason | null
}

export type ModelCatalogEntry = {
  model: string
  name: string
  efforts: readonly string[]
}

export type ModelCatalog = Partial<Record<Provider, readonly ModelCatalogEntry[] | null>>

export type AccountSnapshot =
  | {
      company: 'claude'
      apiKeySource?: string | null
      subscriptionType?: string | null
      models: readonly ModelCatalogEntry[] | null
    }
  | {
      company: 'codex'
      accountType?: string | null
      models: readonly ModelCatalogEntry[] | null
    }

export interface PlanJudgement extends SubscriptionVerdict {
  company: Provider
  tier: PlanTier | null
}

export function subscriptionCheck(account: AccountSnapshot): SubscriptionVerdict {
  if (account.company === 'claude') {
    const keyed = Boolean(account.apiKeySource) && account.apiKeySource !== 'none'
    return keyed ? { usable: false, reason: 'claude-api-key' } : { usable: true, reason: null }
  }
  return account.accountType === 'chatgpt'
    ? { usable: true, reason: null }
    : { usable: false, reason: 'codex-not-chatgpt' }
}

export function judgePlan(account: AccountSnapshot): PlanJudgement {
  const verdict = subscriptionCheck(account)
  if (!verdict.usable) return { ...verdict, company: account.company, tier: null }
  if (account.company === 'claude') {
    const tier: PlanTier = account.subscriptionType === 'max' ? 'high' : 'low'
    return { ...verdict, company: 'claude', tier }
  }
  const tier: PlanTier = account.models && codexRecommendations([...account.models]).tier === 'high' ? 'high' : 'low'
  return { ...verdict, company: 'codex', tier }
}

export function selectLaneRow(claudeTier: PlanTier | null, codexTier: PlanTier | null): LaneRowId | null {
  if (claudeTier && codexTier) {
    if (claudeTier === 'high') return codexTier === 'high' ? 'both-high' : 'claude-high-codex-low'
    return codexTier === 'high' ? 'claude-low-codex-high' : 'both-low'
  }
  if (claudeTier) return claudeTier === 'high' ? 'claude-high' : 'claude-low'
  if (codexTier) return codexTier === 'high' ? 'codex-high' : 'codex-low'
  return null
}

const SOLO_ROW: Record<Provider, Record<PlanTier, LaneRowId>> = {
  claude: { low: 'claude-low', high: 'claude-high' },
  codex: { low: 'codex-low', high: 'codex-high' }
}

function otherCompany(company: Provider): Provider {
  return company === 'claude' ? 'codex' : 'claude'
}

export function howFor(laneName: WorkLane): LaneHow {
  return laneName === 'design' ? 'main' : 'relay'
}

function findCatalogModel(
  models: readonly ModelCatalogEntry[],
  company: Provider,
  requested: string
): ModelCatalogEntry | undefined {
  const exact = models.find((entry) => entry.model === requested)
  if (exact) return isCrossProviderModelId(exact.model) ? undefined : exact
  if (company === 'claude') return undefined
  const resolved = resolveCodexAlias([...models], requested)
  if (!resolved || isCrossProviderModelId(resolved)) return undefined
  return models.find((entry) => entry.model === resolved)
}

function modelPresent(company: Provider, model: string, catalog: ModelCatalog | undefined): boolean | null {
  if (!catalog) return null
  const models = catalog[company]
  if (!models) return null
  if (models.length === 0) return false
  return Boolean(findCatalogModel(models, company, model))
}

export interface LaneDesignChoice {
  model: string | null
  effort: string | null
}

export interface LaneContext {
  mainCompany: Provider
  catalog?: ModelCatalog
  mainLanes?: readonly WorkLane[]
  design?: LaneDesignChoice
}

export type LaneNote =
  | { lane: WorkLane; kind: 'main-takeover'; model: string }
  | { lane: 'review'; kind: 'review-unavailable'; model: string }

export interface ResolvedLanes {
  plan: LanePlan
  notes: LaneNote[]
}

export function resolveLanes(value: LaneRowId | LaneRow, context: LaneContext): ResolvedLanes {
  const plan = planFromRow(value)
  const notes: LaneNote[] = []
  const sourceDesign = plan.design
  const designModel = context.design
    ? context.design.model
    : sourceDesign && sourceDesign.company === context.mainCompany
      ? sourceDesign.model
      : null
  plan.design = {
    company: context.mainCompany,
    model: designModel,
    effort: context.design ? context.design.effort : (sourceDesign?.effort ?? null),
    how: 'main'
  }
  for (const { lane: laneName } of WORK_LANES) {
    if (laneName === 'design') continue
    const entry = plan[laneName]
    if (!entry) continue
    if (laneName === 'review') {
      const present = entry.model ? modelPresent(entry.company, entry.model, context.catalog) : null
      if (present === false) {
        plan.review = null
        notes.push({ lane: 'review', kind: 'review-unavailable', model: entry.model ?? '' })
      } else {
        plan.review = { ...entry, how: 'relay' }
      }
      continue
    }
    const forcedMain = context.mainLanes?.includes(laneName) ?? false
    const missing = entry.model ? modelPresent(entry.company, entry.model, context.catalog) === false : false
    if (forcedMain || missing) {
      plan[laneName] = { company: context.mainCompany, model: null, effort: null, how: 'main' }
      if (missing) notes.push({ lane: laneName, kind: 'main-takeover', model: entry.model ?? '' })
    } else {
      plan[laneName] = {
        ...entry,
        how: howFor(laneName)
      }
    }
  }
  return { plan, notes }
}

export type RequestScope = 'once' | 'continue'

export interface LaneRequestEntry {
  main?: boolean
  company?: Provider
  model?: string
  effort?: string | null
}

export interface LaneRequest {
  scope: RequestScope
  quote: string
  lanes: Partial<Record<WorkLane, LaneRequestEntry>>
}

export type LaneRejectReason =
  | 'not-subscribed'
  | 'malformed'
  | 'cross-provider'
  | 'model-unverified'
  | 'model-not-listed'
  | 'effort-not-supported'
  | 'review-main'

export interface LaneRejection {
  lane: WorkLane
  reason: LaneRejectReason
  model?: string
  effort?: string | null
}

export interface AcceptedLaneOverride {
  lane: WorkLane
  main: boolean
  company: Provider | null
  model: string | null
  effort: string | null
}

export interface LaneRequestCheck {
  accepted: AcceptedLaneOverride[]
  rejected: LaneRejection[]
}

export function checkLaneRequest(request: LaneRequest, accounts: readonly AccountSnapshot[]): LaneRequestCheck {
  const accepted: AcceptedLaneOverride[] = []
  const rejected: LaneRejection[] = []
  for (const { lane: laneName } of WORK_LANES) {
    const entry = request.lanes[laneName]
    if (!entry) continue
    if (entry.main) {
      if (laneName === 'review') {
        rejected.push({ lane: laneName, reason: 'review-main' })
        continue
      }
      accepted.push({ lane: laneName, main: true, company: null, model: null, effort: null })
      continue
    }
    if ((entry.company !== 'claude' && entry.company !== 'codex') || !entry.model) {
      rejected.push({ lane: laneName, reason: 'malformed', model: entry.model, effort: entry.effort ?? null })
      continue
    }
    if (isCrossProviderModelId(entry.model)) {
      rejected.push({ lane: laneName, reason: 'cross-provider', model: entry.model, effort: entry.effort ?? null })
      continue
    }
    const account = accounts.find((candidate) => candidate.company === entry.company)
    if (!account || !subscriptionCheck(account).usable) {
      rejected.push({ lane: laneName, reason: 'not-subscribed', model: entry.model, effort: entry.effort ?? null })
      continue
    }
    if (account.models === null) {
      rejected.push({ lane: laneName, reason: 'model-unverified', model: entry.model, effort: entry.effort ?? null })
      continue
    }
    const matched = findCatalogModel(account.models, entry.company, entry.model)
    if (!matched) {
      rejected.push({ lane: laneName, reason: 'model-not-listed', model: entry.model, effort: entry.effort ?? null })
      continue
    }
    const effort = entry.effort ?? null
    if (effort !== null && !matched.efforts.includes(effort)) {
      rejected.push({ lane: laneName, reason: 'effort-not-supported', model: entry.model, effort })
      continue
    }
    accepted.push({ lane: laneName, main: false, company: entry.company, model: matched.model, effort })
  }
  return { accepted, rejected }
}

export function continueAfterLimit(
  failedLane: 'design' | 'research' | 'writing' | 'repeat' | 'review',
  failedEntry: LaneEntry,
  otherAccount: AccountSnapshot | null,
  otherState: { consented: boolean; basicUsageAllowed: boolean },
  otherCatalog: ModelCatalog
): LaneEntry | null {
  const isDesign = failedLane === 'design'
  if (!otherAccount || (!isDesign && !otherState.consented) || !otherState.basicUsageAllowed) return null

  const company = otherCompany(failedEntry.company)
  if (
    otherAccount.company !== company ||
    failedEntry.how !== (isDesign ? 'main' : 'relay') ||
    !failedEntry.model
  ) {
    return null
  }

  const judgement = judgePlan(otherAccount)
  if (!judgement.usable || !judgement.tier) return null

  const candidate = LANE_TABLE[SOLO_ROW[company][judgement.tier]].lanes[failedLane]
  const models = otherCatalog[company]
  if (!candidate.model || !models) return null

  const matched = findCatalogModel(models, company, candidate.model)
  if (!matched) return null

  const effort = failedLane === 'review' ? REVIEW_EFFORT : failedEntry.effort
  if (failedLane === 'review' && !matched.efforts.includes(REVIEW_EFFORT)) return null

  return {
    company,
    model: matched.model,
    effort: effort !== null && matched.efforts.includes(effort) ? effort : null,
    how: candidate.how
  }
}

export interface LaneProposal {
  quote: string
  scope: RequestScope
  base: LanePlan
  next: LanePlan
  accepted: AcceptedLaneOverride[]
  rejected: LaneRejection[]
}

export function proposeLaneRequest(
  request: LaneRequest,
  accounts: readonly AccountSnapshot[],
  base: LanePlan,
  mainCompany: Provider
): LaneProposal {
  const check = checkLaneRequest(request, accounts)
  const design = check.accepted.find((entry) => entry.lane === 'design' && !entry.main && entry.company)
  const nextMainCompany = design?.company ?? mainCompany
  const acceptedByLane = new Map(check.accepted.map((entry) => [entry.lane, entry]))
  const next = {} as LanePlan
  for (const { lane } of WORK_LANES) {
    const current = base[lane]
    const accepted = acceptedByLane.get(lane)
    if (accepted) {
      next[lane] = accepted.main
        ? { company: nextMainCompany, model: null, effort: null, how: 'main' }
        : accepted.company && accepted.model
          ? {
              company: accepted.company,
              model: accepted.model,
              effort: accepted.effort,
              how: howFor(lane)
            }
          : current
      continue
    }
    if (!current) {
      next[lane] = null
      continue
    }
    if (current.how === 'main') {
      next[lane] =
        current.company === nextMainCompany ? { ...current } : { ...current, company: nextMainCompany }
      continue
    }
    next[lane] = { ...current, how: howFor(lane) }
  }
  return {
    quote: request.quote,
    scope: request.scope,
    base,
    next,
    accepted: check.accepted,
    rejected: check.rejected
  }
}

export type LaneCardAction = 'once' | 'continue' | 'cancel'

export interface LaneApplication {
  plan: LanePlan
  scope: RequestScope | null
}

export function applyLaneProposal(proposal: LaneProposal, action: LaneCardAction): LaneApplication {
  if (action === 'cancel') return { plan: proposal.base, scope: null }
  return { plan: proposal.next, scope: action }
}
