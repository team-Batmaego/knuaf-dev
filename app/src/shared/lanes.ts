import {
  WORK_LANES,
  codexRecommendations,
  isCrossProviderModelId,
  resolveCodexAlias,
  type Provider,
  type WorkLane
} from './chat'

export type PlanTier = 'high' | 'low'
export type PlanGrade = 'high' | 'mid' | 'low'
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
  draft: boolean
  lanes: Record<WorkLane, LaneEntry>
}

export const DRAFT_REVIEW_EFFORT = 'high'

function lane(company: Provider, model: string, how: LaneHow, effort: string | null = null): LaneEntry {
  return { company, model, effort, how }
}

function row(
  id: LaneRowId,
  label: string,
  draft: boolean,
  design: LaneEntry,
  research: LaneEntry,
  writing: LaneEntry,
  repeat: LaneEntry,
  review: LaneEntry
): LaneRow {
  return {
    id,
    label,
    draft,
    lanes: { design, research, writing, repeat, review }
  }
}

export const LANE_TABLE: Record<LaneRowId, LaneRow> = {
  'codex-low': row(
    'codex-low',
    'ChatGPT 낮음만',
    false,
    lane('codex', 'terra', 'main'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'terra', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'codex-high': row(
    'codex-high',
    'ChatGPT 높음만',
    false,
    lane('codex', 'sol', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('codex', 'terra', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'astra', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'claude-low': row(
    'claude-low',
    'Claude 낮음만',
    false,
    lane('claude', 'sonnet', 'main'),
    lane('claude', 'haiku', 'sub'),
    lane('claude', 'haiku', 'sub'),
    lane('claude', 'haiku', 'sub'),
    lane('claude', 'sonnet', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'claude-high': row(
    'claude-high',
    'Claude 높음만',
    false,
    lane('claude', 'opus', 'main'),
    lane('claude', 'sonnet', 'sub'),
    lane('claude', 'sonnet', 'sub'),
    lane('claude', 'haiku', 'sub'),
    lane('claude', 'opus', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'both-high': row(
    'both-high',
    '둘 다 높음',
    false,
    lane('claude', 'opus', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'astra', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'claude-high-codex-low': row(
    'claude-high-codex-low',
    'Claude 높음 + ChatGPT 낮음',
    true,
    lane('claude', 'opus', 'main'),
    lane('claude', 'sonnet', 'sub'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('claude', 'opus', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'claude-low-codex-high': row(
    'claude-low-codex-high',
    'Claude 낮음 + ChatGPT 높음',
    true,
    lane('codex', 'sol', 'main'),
    lane('codex', 'astra', 'relay'),
    lane('claude', 'haiku', 'relay'),
    lane('claude', 'haiku', 'relay'),
    lane('codex', 'astra', 'relay', DRAFT_REVIEW_EFFORT)
  ),
  'both-low': row(
    'both-low',
    '둘 다 낮음',
    true,
    lane('claude', 'sonnet', 'main'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'luna', 'relay'),
    lane('codex', 'terra', 'relay', DRAFT_REVIEW_EFFORT)
  )
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

const MODEL_GRADE: Record<string, PlanGrade> = {
  opus: 'high',
  sol: 'high',
  astra: 'high',
  sonnet: 'mid',
  terra: 'mid',
  haiku: 'low',
  luna: 'low'
}

function otherCompany(company: Provider): Provider {
  return company === 'claude' ? 'codex' : 'claude'
}

function lastToken(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words[words.length - 1] ?? ''
}

function gradeOf(model: string): PlanGrade {
  const grade = MODEL_GRADE[model] ?? MODEL_GRADE[lastToken(model)]
  if (!grade) throw new Error(`unknown model grade: ${model}`)
  return grade
}

export interface DerivedLane {
  company: Provider
  model: string
}

function stronger(a: DerivedLane, b: DerivedLane, tieCompany: Provider): DerivedLane {
  const left = gradeOf(a.model)
  const right = gradeOf(b.model)
  if (left !== right) return left === 'high' || (left === 'mid' && right === 'low') ? a : b
  if (a.company === tieCompany) return a
  if (b.company === tieCompany) return b
  return a
}

function laneModel(value: LaneRowId, laneName: WorkLane): DerivedLane {
  const entry = LANE_TABLE[value].lanes[laneName]
  return { company: entry.company, model: entry.model ?? '' }
}

export function deriveLaneModels(claudeTier: PlanTier, codexTier: PlanTier): Record<WorkLane, DerivedLane> {
  const claudeRow = SOLO_ROW.claude[claudeTier]
  const codexRow = SOLO_ROW.codex[codexTier]
  const design = stronger(laneModel(claudeRow, 'design'), laneModel(codexRow, 'design'), 'claude')
  const separated = otherCompany(design.company)
  const research = stronger(laneModel(claudeRow, 'research'), laneModel(codexRow, 'research'), separated)
  const review = stronger(laneModel(claudeRow, 'review'), laneModel(codexRow, 'review'), separated)
  const writing = laneModel(SOLO_ROW[otherCompany(design.company)].low, 'writing')
  return { design, research, writing, repeat: writing, review }
}

export function howFor(
  laneName: WorkLane,
  company: Provider,
  mainCompany: Provider,
  claudeSubAllowed: boolean
): LaneHow {
  if (laneName === 'design') return 'main'
  if (laneName === 'review') return 'relay'
  if (company === 'codex') return 'relay'
  return company === mainCompany && claudeSubAllowed ? 'sub' : 'relay'
}

function findCatalogModel(
  models: readonly ModelCatalogEntry[],
  company: Provider,
  requested: string
): ModelCatalogEntry | undefined {
  const exact = models.find((entry) => entry.model === requested)
  if (exact) return exact
  if (company === 'codex') {
    const resolved = resolveCodexAlias([...models], requested)
    return resolved ? models.find((entry) => entry.model === resolved) : undefined
  }
  const token = requested.toLowerCase()
  return models.find((entry) => {
    const nameWords = entry.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    return nameWords.includes(token) || lastToken(entry.model) === token
  })
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
  claudeSubAllowed: boolean
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
        how: howFor(laneName, entry.company, context.mainCompany, context.claudeSubAllowed)
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
  mainCompany: Provider,
  claudeSubAllowed: boolean
): LaneProposal {
  const check = checkLaneRequest(request, accounts)
  const design = check.accepted.find((entry) => entry.lane === 'design' && !entry.main && entry.company)
  const nextMainCompany = design?.company ?? mainCompany
  const next = {} as LanePlan
  for (const { lane } of WORK_LANES) {
    const current = base[lane]
    next[lane] = current
      ? { ...current, how: howFor(lane, current.company, nextMainCompany, claudeSubAllowed) }
      : null
  }
  for (const accepted of check.accepted) {
    if (accepted.main) {
      next[accepted.lane] = { company: nextMainCompany, model: null, effort: null, how: 'main' }
    } else if (accepted.company && accepted.model) {
      next[accepted.lane] = {
        company: accepted.company,
        model: accepted.model,
        effort: accepted.effort,
        how: howFor(accepted.lane, accepted.company, nextMainCompany, claudeSubAllowed)
      }
    }
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
