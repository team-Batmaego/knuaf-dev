import { expect, test } from '@playwright/test'
import { CODEX_TIER_MODELS, WORK_LANES, type WorkLane } from '../src/shared/chat'
import {
  DRAFT_REVIEW_EFFORT,
  LANE_TABLE,
  applyLaneProposal,
  checkLaneRequest,
  deriveLaneModels,
  howFor,
  judgePlan,
  planFromRow,
  proposeLaneRequest,
  resolveLanes,
  selectLaneRow,
  subscriptionCheck,
  type AccountSnapshot,
  type DerivedLane,
  type LaneEntry,
  type LanePlan,
  type LaneRequest,
  type LaneRequestEntry,
  type LaneRowId,
  type ModelCatalogEntry
} from '../src/shared/lanes'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function model(model: string, name: string, efforts: readonly string[] = EFFORTS): ModelCatalogEntry {
  return { model, name, efforts }
}

const CLAUDE_MODELS = [
  model('opus', 'Opus', ['low', 'medium', 'high', 'xhigh', 'max']),
  model('sonnet', 'Sonnet', ['low', 'medium', 'high', 'xhigh', 'max']),
  model('haiku', 'Haiku', ['low', 'medium', 'high'])
]

const CODEX_MODELS = [
  model('gpt-6.1-sol', 'Sol', [...EFFORTS, 'ultra']),
  model('gpt-6.1-terra', 'Terra', [...EFFORTS, 'ultra']),
  model('gpt-6.1-astra', 'Astra', [...EFFORTS, 'ultra']),
  model('gpt-6-luna', 'Luna', EFFORTS)
]

function claude(over: { apiKeySource?: string | null; subscriptionType?: string | null; models?: readonly ModelCatalogEntry[] | null } = {}): AccountSnapshot {
  return {
    company: 'claude',
    apiKeySource: over.apiKeySource ?? null,
    subscriptionType: over.subscriptionType === undefined ? 'max' : over.subscriptionType,
    models: over.models === undefined ? CLAUDE_MODELS : over.models
  }
}

function codex(over: { accountType?: string | null; models?: readonly ModelCatalogEntry[] | null } = {}): AccountSnapshot {
  return {
    company: 'codex',
    accountType: over.accountType === undefined ? 'chatgpt' : over.accountType,
    models: over.models === undefined ? CODEX_MODELS : over.models
  }
}

function tableModels(rowId: LaneRowId): Record<WorkLane, DerivedLane> {
  const source = LANE_TABLE[rowId]
  const out = {} as Record<WorkLane, DerivedLane>
  for (const { lane } of WORK_LANES) {
    out[lane] = { company: source.lanes[lane].company, model: source.lanes[lane].model ?? '' }
  }
  return out
}

function laneOf(plan: LanePlan, lane: WorkLane): LaneEntry {
  const entry = plan[lane]
  if (!entry) throw new Error(`${lane} is not part of the plan`)
  return entry
}

test('요금제 판정 — Claude는 max만 높음이고 나머지는 보수적으로 낮음, API 키는 분담에 안 쓴다', () => {
  expect(judgePlan(claude())).toMatchObject({ usable: true, tier: 'high' })
  for (const subscriptionType of ['pro', 'team', 'enterprise', null, 'other']) {
    expect(judgePlan(claude({ subscriptionType }))).toMatchObject({ usable: true, tier: 'low' })
  }
  expect(judgePlan(claude({ apiKeySource: 'ANTHROPIC_API_KEY' }))).toMatchObject({ usable: false, tier: null })
  expect(judgePlan(claude({ apiKeySource: 'none' })).usable).toBe(true)
  expect(subscriptionCheck(claude({ apiKeySource: 'ANTHROPIC_API_KEY' })).reason).toBe('claude-api-key')
})

test('요금제 판정 — Codex는 chatgpt 로그인만 쓰고, Sol·Astra가 목록에 있으면 높음이다', () => {
  expect(judgePlan(codex())).toMatchObject({ usable: true, tier: 'high' })
  const lowModels = CODEX_MODELS.filter((entry) => entry.model !== 'gpt-6.1-sol' && entry.model !== 'gpt-6.1-astra')
  expect(judgePlan(codex({ models: lowModels }))).toMatchObject({ usable: true, tier: 'low' })
  expect(judgePlan(codex({ models: null }))).toMatchObject({ usable: true, tier: 'low' })
  for (const accountType of ['apiKey', 'amazonBedrock', null, 'other']) {
    expect(judgePlan(codex({ accountType }))).toMatchObject({ usable: false, tier: null })
  }
  expect(subscriptionCheck(codex({ accountType: 'apiKey' })).reason).toBe('codex-not-chatgpt')
})

test('요금제 조합이 레인표 8줄 중 어느 줄인지 고른다', () => {
  expect(selectLaneRow('high', 'high')).toBe('both-high')
  expect(selectLaneRow('high', 'low')).toBe('claude-high-codex-low')
  expect(selectLaneRow('low', 'high')).toBe('claude-low-codex-high')
  expect(selectLaneRow('low', 'low')).toBe('both-low')
  expect(selectLaneRow('high', null)).toBe('claude-high')
  expect(selectLaneRow('low', null)).toBe('claude-low')
  expect(selectLaneRow(null, 'high')).toBe('codex-high')
  expect(selectLaneRow(null, 'low')).toBe('codex-low')
  expect(selectLaneRow(null, null)).toBeNull()
})

test('LANE_TABLE 8줄 — 1·2번은 기존 CODEX_TIER_MODELS와 같고, 6~8번과 검토 깊이는 초안으로 표시한다', () => {
  expect(Object.keys(LANE_TABLE)).toHaveLength(8)
  for (const [rowId, tier] of [['codex-low', 'low'], ['codex-high', 'high']] as const) {
    for (const { lane } of WORK_LANES) {
      expect(LANE_TABLE[rowId].lanes[lane].model).toBe(CODEX_TIER_MODELS[tier][lane])
    }
  }
  for (const rowId of ['claude-high-codex-low', 'claude-low-codex-high', 'both-low'] as const) {
    expect(LANE_TABLE[rowId].draft).toBe(true)
  }
  for (const rowId of ['codex-low', 'codex-high', 'claude-low', 'claude-high', 'both-high'] as const) {
    expect(LANE_TABLE[rowId].draft).toBe(false)
  }
  for (const rowId of Object.keys(LANE_TABLE) as LaneRowId[]) {
    const lanes = LANE_TABLE[rowId].lanes
    expect(lanes.design.how).toBe('main')
    expect(lanes.review.how).toBe('relay')
    expect(lanes.review.effort).toBe(DRAFT_REVIEW_EFFORT)
    for (const lane of ['design', 'research', 'writing', 'repeat'] as const) {
      expect(lanes[lane].effort).toBeNull()
    }
    for (const lane of ['research', 'writing', 'repeat'] as const) {
      expect(['sub', 'relay']).toContain(lanes[lane].how)
      if (lanes[lane].company === 'codex') expect(lanes[lane].how).toBe('relay')
    }
  }
  for (const rowId of ['claude-low', 'claude-high'] as const) {
    for (const lane of ['research', 'writing', 'repeat'] as const) {
      expect(LANE_TABLE[rowId].lanes[lane].how).toBe('sub')
    }
  }
  expect(LANE_TABLE['claude-high-codex-low'].lanes.research.how).toBe('sub')
})

test('규칙 1~4로 5번 줄과 초안 3줄이 그대로 다시 나온다', () => {
  expect(deriveLaneModels('high', 'high')).toEqual(tableModels('both-high'))
  expect(deriveLaneModels('high', 'low')).toEqual(tableModels('claude-high-codex-low'))
  expect(deriveLaneModels('low', 'high')).toEqual(tableModels('claude-low-codex-high'))
  expect(deriveLaneModels('low', 'low')).toEqual(tableModels('both-low'))
})

test('how 규칙 — 설계는 main, 검토는 relay, ChatGPT는 언제나 relay, Claude만 허용 시 sub', () => {
  expect(howFor('design', 'codex', 'claude', true)).toBe('main')
  expect(howFor('review', 'claude', 'claude', true)).toBe('relay')
  expect(howFor('research', 'claude', 'claude', true)).toBe('sub')
  expect(howFor('research', 'codex', 'claude', true)).toBe('relay')
  expect(howFor('research', 'codex', 'codex', true)).toBe('relay')
  expect(howFor('research', 'claude', 'claude', false)).toBe('relay')
  expect(howFor('design', 'claude', 'claude', false)).toBe('main')
  expect(howFor('review', 'claude', 'claude', false)).toBe('relay')
})

test('추천 줄을 실행 배치로 풀면 표의 how가 나오고, 칩 회사가 바뀌면 실제 본대화 회사로 다시 계산한다', () => {
  const same = resolveLanes('both-high', { mainCompany: 'claude', claudeSubAllowed: true })
  expect(laneOf(same.plan, 'research')).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
  expect(laneOf(same.plan, 'writing')).toMatchObject({ company: 'codex', model: 'luna', how: 'relay' })
  expect(laneOf(same.plan, 'review')).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })

  const swapped = resolveLanes('both-high', { mainCompany: 'codex', claudeSubAllowed: true })
  expect(laneOf(swapped.plan, 'research')).toMatchObject({ company: 'codex', how: 'relay' })
  expect(laneOf(swapped.plan, 'writing')).toMatchObject({ company: 'codex', how: 'relay' })
  expect(laneOf(swapped.plan, 'repeat')).toMatchObject({ company: 'codex', how: 'relay' })
  expect(laneOf(swapped.plan, 'review')).toMatchObject({ company: 'codex', how: 'relay' })
})

test('ChatGPT는 같은 회사여도 relay, Claude는 허용 때만 sub이고 아니면 relay — 설계·검토는 그대로', () => {
  const codexPlan = resolveLanes('codex-low', { mainCompany: 'codex', claudeSubAllowed: true })
  expect(laneOf(codexPlan.plan, 'design')).toMatchObject({ company: 'codex', how: 'main' })
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(codexPlan.plan, lane).how).toBe('relay')
  }
  expect(laneOf(codexPlan.plan, 'review')).toMatchObject({ company: 'codex', how: 'relay' })

  const claudeAllowed = resolveLanes('claude-low', {
    mainCompany: 'claude',
    claudeSubAllowed: true
  })
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(claudeAllowed.plan, lane).how).toBe('sub')
  }
  expect(laneOf(claudeAllowed.plan, 'design').how).toBe('main')
  expect(laneOf(claudeAllowed.plan, 'review').how).toBe('relay')

  const claudeBlocked = resolveLanes('claude-low', {
    mainCompany: 'claude',
    claudeSubAllowed: false
  })
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(claudeBlocked.plan, lane).how).toBe('relay')
  }
  expect(laneOf(claudeBlocked.plan, 'design').how).toBe('main')
  expect(laneOf(claudeBlocked.plan, 'review').how).toBe('relay')
})

test('검토 모델이 목록에 없으면 검토는 미실행이고 본대화로 돌리지 않는다', () => {
  const withoutTerra = CODEX_MODELS.filter((entry) => entry.model !== 'gpt-6.1-terra')
  const resolved = resolveLanes('both-low', {
    mainCompany: 'claude',
    claudeSubAllowed: true,
    catalog: { claude: CLAUDE_MODELS, codex: withoutTerra }
  })
  expect(resolved.plan.review).toBeNull()
  expect(resolved.notes).toContainEqual({ lane: 'review', kind: 'review-unavailable', model: 'terra' })
  expect(laneOf(resolved.plan, 'research')).toMatchObject({ company: 'codex', model: 'luna', how: 'relay' })
})

test('자료·글쓰기·반복 모델이 목록에 없으면 그 레인만 본대화가 맡는다', () => {
  const withoutSonnet = CLAUDE_MODELS.filter((entry) => entry.model !== 'sonnet')
  const resolved = resolveLanes('claude-high-codex-low', {
    mainCompany: 'claude',
    claudeSubAllowed: true,
    catalog: { claude: withoutSonnet, codex: CODEX_MODELS }
  })
  expect(resolved.plan.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  expect(resolved.notes).toContainEqual({ lane: 'research', kind: 'main-takeover', model: 'sonnet' })
  expect(laneOf(resolved.plan, 'review')).toMatchObject({ company: 'claude', model: 'opus', how: 'relay' })
})

test('학생이 "이 레인은 본대화가 직접" 하면 그 레인만 main이 되고, 검토는 그 예외가 없다', () => {
  const forced = resolveLanes('both-high', { mainCompany: 'claude', claudeSubAllowed: true, mainLanes: ['research'] })
  expect(forced.plan.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  const reviewForced = resolveLanes('both-high', { mainCompany: 'claude', claudeSubAllowed: true, mainLanes: ['review'] })
  expect(laneOf(reviewForced.plan, 'review').how).toBe('relay')
})

test('모델 목록을 아직 모르면 없는 것으로 단정하지 않는다', () => {
  const resolved = resolveLanes('both-high', { mainCompany: 'claude', claudeSubAllowed: true })
  expect(laneOf(resolved.plan, 'research').how).toBe('relay')
  expect(resolved.notes).toEqual([])
})

const BASE = planFromRow('both-high')
const ACCOUNTS = [claude(), codex()]

test('학생 배치안 — 통과한 레인만 바꾸고 나머지 레인은 추천 그대로 둔다', () => {
  const request: LaneRequest = {
    scope: 'once',
    quote: '글쓰기는 Terra high로 해',
    lanes: { writing: { company: 'codex', model: 'terra', effort: 'high' } }
  }
  const proposal = proposeLaneRequest(request, ACCOUNTS, BASE, 'claude', true)
  expect(proposal.rejected).toEqual([])
  expect(proposal.accepted).toEqual([
    { lane: 'writing', main: false, company: 'codex', model: 'gpt-6.1-terra', effort: 'high' }
  ])
  expect(proposal.next.writing).toEqual({ company: 'codex', model: 'gpt-6.1-terra', effort: 'high', how: 'relay' })
  expect(proposal.next.research).toEqual(BASE.research)
  expect(proposal.next.review).toEqual(BASE.review)
})

test('학생이 설계를 다른 회사로 옮기면 나머지 레인의 how도 새 본대화 회사로 다시 계산한다', () => {
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '설계는 Codex Sol로', lanes: { design: { company: 'codex', model: 'sol' } } },
    ACCOUNTS,
    BASE,
    'claude',
    true
  )
  expect(proposal.rejected).toEqual([])
  expect(proposal.next.design).toMatchObject({ company: 'codex', model: 'gpt-6.1-sol', how: 'main' })
  expect(proposal.next.research).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
  expect(proposal.next.writing).toMatchObject({ company: 'codex', model: 'luna', how: 'relay' })
  expect(proposal.next.repeat).toMatchObject({ company: 'codex', model: 'luna', how: 'relay' })
  expect(proposal.next.review).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
})

test('학생 지정 병합도 ChatGPT는 relay, Claude는 허용 때만 sub — 설계·검토는 그대로', () => {
  const request: LaneRequest = { scope: 'once', quote: '', lanes: {} }
  const claudeBase = planFromRow('claude-low')
  const claudeAllowed = proposeLaneRequest(request, ACCOUNTS, claudeBase, 'claude', true)
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(claudeAllowed.next, lane).how).toBe('sub')
  }
  expect(laneOf(claudeAllowed.next, 'design').how).toBe('main')
  expect(laneOf(claudeAllowed.next, 'review').how).toBe('relay')

  const claudeBlocked = proposeLaneRequest(request, ACCOUNTS, claudeBase, 'claude', false)
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(claudeBlocked.next, lane).how).toBe('relay')
  }
  expect(laneOf(claudeBlocked.next, 'design').how).toBe('main')
  expect(laneOf(claudeBlocked.next, 'review').how).toBe('relay')

  const codexBase = planFromRow('codex-low')
  const codexPlan = proposeLaneRequest(request, ACCOUNTS, codexBase, 'codex', true)
  for (const lane of ['research', 'writing', 'repeat'] as const) {
    expect(laneOf(codexPlan.next, lane).how).toBe('relay')
  }
  expect(laneOf(codexPlan.next, 'design').how).toBe('main')
  expect(laneOf(codexPlan.next, 'review').how).toBe('relay')
})

test('카드를 누르기 전에는 적용되지 않고, 취소하면 추천 그대로다', () => {
  const before = structuredClone(BASE)
  const proposal = proposeLaneRequest(
    { scope: 'continue', quote: '글쓰기는 Terra', lanes: { writing: { company: 'codex', model: 'terra' } } },
    ACCOUNTS,
    BASE,
    'claude',
    true
  )
  expect(BASE).toEqual(before)
  expect(applyLaneProposal(proposal, 'cancel')).toEqual({ plan: before, scope: null })
})

test('카드에서 이번만·계속을 고르면 그 범위가 결과에 남는다', () => {
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '글쓰기는 Terra', lanes: { writing: { company: 'codex', model: 'terra' } } },
    ACCOUNTS,
    BASE,
    'claude',
    true
  )
  expect(applyLaneProposal(proposal, 'once')).toMatchObject({ scope: 'once' })
  expect(applyLaneProposal(proposal, 'continue')).toMatchObject({ scope: 'continue' })
})

function checkWriting(entry: LaneRequestEntry, accounts: readonly AccountSnapshot[] = ACCOUNTS) {
  return checkLaneRequest({ scope: 'once', quote: '', lanes: { writing: entry } }, accounts)
}

test('학생 배치안 검사 — 목록에 없는 모델·깊이, 다른 공급자 id, 구독 아닌 로그인을 거절한다', () => {
  expect(checkWriting({ company: 'codex', model: 'gpt-없는모델' }).rejected[0]).toMatchObject({
    lane: 'writing',
    reason: 'model-not-listed'
  })
  expect(checkWriting({ company: 'codex', model: 'luna', effort: 'ultra' }).rejected[0]).toMatchObject({
    lane: 'writing',
    reason: 'effort-not-supported'
  })
  expect(checkWriting({ company: 'codex', model: 'anthropic/claude-opus-4-1' }).rejected[0]).toMatchObject({
    lane: 'writing',
    reason: 'cross-provider'
  })
  expect(
    checkWriting({ company: 'claude', model: 'sonnet' }, [claude({ apiKeySource: 'ANTHROPIC_API_KEY' }), codex()]).rejected[0]
  ).toMatchObject({ lane: 'writing', reason: 'not-subscribed' })
  expect(checkWriting({ company: 'codex', model: 'astra' }, [claude(), codex({ models: null })]).rejected[0]).toMatchObject({
    lane: 'writing',
    reason: 'model-unverified'
  })
})

test('학생이 "검토도 이 대화에서" 하면 검토 레인만 거절하고 추천 검토는 그대로 둔다', () => {
  const check = checkLaneRequest({ scope: 'once', quote: '', lanes: { review: { main: true } } }, ACCOUNTS)
  expect(check.accepted).toEqual([])
  expect(check.rejected).toEqual([{ lane: 'review', reason: 'review-main' }])
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '', lanes: { review: { main: true } } },
    ACCOUNTS,
    BASE,
    'claude',
    true
  )
  expect(proposal.next.review).toEqual(BASE.review)
})

test('학생 배치안 — 한 모델로 몰기, 검토를 같은 회사로 두기, max·ultra 올리기를 막지 않는다', () => {
  const all: LaneRequest = {
    scope: 'continue',
    quote: '다 Astra ultra로',
    lanes: Object.fromEntries(
      WORK_LANES.map(({ lane }) => [lane, { company: 'codex', model: 'astra', effort: 'ultra' }])
    )
  }
  const check = checkLaneRequest(all, ACCOUNTS)
  expect(check.rejected).toEqual([])
  expect(check.accepted).toHaveLength(5)

  const proposal = proposeLaneRequest(all, ACCOUNTS, BASE, 'claude', true)
  expect(laneOf(proposal.next, 'design').how).toBe('main')
  expect(laneOf(proposal.next, 'review')).toMatchObject({ company: 'codex', effort: 'ultra', how: 'relay' })

  const claudeReview = proposeLaneRequest(
    { scope: 'once', quote: '검토는 Claude Opus max', lanes: { review: { company: 'claude', model: 'opus', effort: 'max' } } },
    ACCOUNTS,
    BASE,
    'claude',
    true
  )
  expect(claudeReview.rejected).toEqual([])
  expect(claudeReview.next.review).toMatchObject({ company: 'claude', model: 'opus', effort: 'max', how: 'relay' })
})
