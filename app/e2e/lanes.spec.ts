import { expect, test } from '@playwright/test'
import { CODEX_TIER_MODELS, WORK_LANES, type WorkLane } from '../src/shared/chat'
import {
  LANE_TABLE,
  REVIEW_EFFORT,
  applyLaneProposal,
  checkLaneRequest,
  continueAfterLimit,
  howFor,
  judgePlan,
  planFromRow,
  proposeLaneRequest,
  resolveLanes,
  selectLaneRow,
  subscriptionCheck,
  type AccountSnapshot,
  type LaneEntry,
  type LanePlan,
  type LaneRequest,
  type LaneRequestEntry,
  type LaneRowId,
  type ModelCatalog,
  type ModelCatalogEntry,
  type PlanTier
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

const EXPECTED_LANES: Record<LaneRowId, Record<WorkLane, LaneEntry>> = {
  'codex-low': {
    design: { company: 'codex', model: 'terra', effort: null, how: 'main' },
    research: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'luna', effort: null, how: 'relay' },
    repeat: { company: 'codex', model: 'luna', effort: null, how: 'relay' },
    review: { company: 'codex', model: 'terra', effort: 'high', how: 'relay' }
  },
  'codex-high': {
    design: { company: 'codex', model: 'sol', effort: null, how: 'main' },
    research: { company: 'codex', model: 'astra', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'sol', effort: null, how: 'relay' },
    repeat: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    review: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }
  },
  'claude-low': {
    design: { company: 'claude', model: 'sonnet', effort: null, how: 'main' },
    research: { company: 'claude', model: 'haiku', effort: null, how: 'relay' },
    writing: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' },
    repeat: { company: 'claude', model: 'haiku', effort: null, how: 'relay' },
    review: { company: 'claude', model: 'sonnet', effort: 'high', how: 'relay' }
  },
  'claude-high': {
    design: { company: 'claude', model: 'opus', effort: null, how: 'main' },
    research: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' },
    writing: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' },
    repeat: { company: 'claude', model: 'haiku', effort: null, how: 'relay' },
    review: { company: 'claude', model: 'opus', effort: 'high', how: 'relay' }
  },
  'both-high': {
    design: { company: 'claude', model: 'opus', effort: null, how: 'main' },
    research: { company: 'codex', model: 'astra', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'sol', effort: null, how: 'relay' },
    repeat: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    review: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }
  },
  'claude-high-codex-low': {
    design: { company: 'claude', model: 'opus', effort: null, how: 'main' },
    research: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    repeat: { company: 'codex', model: 'luna', effort: null, how: 'relay' },
    review: { company: 'claude', model: 'opus', effort: 'high', how: 'relay' }
  },
  'claude-low-codex-high': {
    design: { company: 'codex', model: 'sol', effort: null, how: 'main' },
    research: { company: 'codex', model: 'astra', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'sol', effort: null, how: 'relay' },
    repeat: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    review: { company: 'claude', model: 'sonnet', effort: 'high', how: 'relay' }
  },
  'both-low': {
    design: { company: 'claude', model: 'sonnet', effort: null, how: 'main' },
    research: { company: 'codex', model: 'terra', effort: null, how: 'relay' },
    writing: { company: 'codex', model: 'luna', effort: null, how: 'relay' },
    repeat: { company: 'claude', model: 'haiku', effort: null, how: 'relay' },
    review: { company: 'codex', model: 'terra', effort: 'high', how: 'relay' }
  }
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

test('LANE_TABLE 8줄의 40칸이 11-04 확정 표와 일치하고 초안 표시는 없다', () => {
  expect(Object.keys(LANE_TABLE).sort()).toEqual(Object.keys(EXPECTED_LANES).sort())
  for (const rowId of Object.keys(EXPECTED_LANES) as LaneRowId[]) {
    expect(LANE_TABLE[rowId].lanes).toEqual(EXPECTED_LANES[rowId])
    expect(LANE_TABLE[rowId]).not.toHaveProperty('draft')
  }
  expect(REVIEW_EFFORT).toBe('high')
})

test('CODEX_TIER_MODELS와 다른 칩 추천 복사본은 알려진 차이로 유지한다', () => {
  expect(LANE_TABLE['codex-low'].lanes.research.model).toBe('terra')
  expect(CODEX_TIER_MODELS.low.research).toBe('luna')
  expect(LANE_TABLE['codex-high'].lanes.writing.model).toBe('sol')
  expect(CODEX_TIER_MODELS.high.writing).toBe('terra')
  expect(LANE_TABLE['codex-high'].lanes.repeat.model).toBe('terra')
  expect(CODEX_TIER_MODELS.high.repeat).toBe('luna')
})

test('how 규칙 — 설계만 main이고 나머지는 모두 relay다', () => {
  expect(howFor('design')).toBe('main')
  for (const lane of ['research', 'writing', 'repeat', 'review'] as const) {
    expect(howFor(lane)).toBe('relay')
  }
})

test('추천 줄을 풀어도 회사와 관계없이 설계 밖 레인은 모두 relay다', () => {
  for (const rowId of Object.keys(LANE_TABLE) as LaneRowId[]) {
    const mainCompany = LANE_TABLE[rowId].lanes.design.company
    const resolved = resolveLanes(rowId, { mainCompany })
    expect(laneOf(resolved.plan, 'design').how).toBe('main')
    for (const lane of ['research', 'writing', 'repeat', 'review'] as const) {
      expect(laneOf(resolved.plan, lane).how).toBe('relay')
    }
  }
})

test('검토 모델이 목록에 없으면 검토는 미실행이고 다른 레인은 유지된다', () => {
  const withoutSonnet = CLAUDE_MODELS.filter((entry) => entry.model !== 'sonnet')
  const resolved = resolveLanes('claude-low', {
    mainCompany: 'claude',
    catalog: { claude: withoutSonnet }
  })
  expect(resolved.plan.review).toBeNull()
  expect(resolved.notes).toContainEqual({ lane: 'review', kind: 'review-unavailable', model: 'sonnet' })
  expect(laneOf(resolved.plan, 'research')).toMatchObject({ company: 'claude', model: 'haiku', how: 'relay' })
})

test('자료·글쓰기·반복 모델이 목록에 없으면 해당 레인만 본대화가 맡는다', () => {
  const withoutSonnet = CLAUDE_MODELS.filter((entry) => entry.model !== 'sonnet')
  const resolved = resolveLanes('claude-high-codex-low', {
    mainCompany: 'claude',
    catalog: { claude: withoutSonnet, codex: CODEX_MODELS }
  })
  expect(resolved.plan.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  expect(resolved.notes).toContainEqual({ lane: 'research', kind: 'main-takeover', model: 'sonnet' })
  expect(laneOf(resolved.plan, 'review')).toMatchObject({ company: 'claude', model: 'opus', how: 'relay' })
})

test('학생이 레인을 본대화로 지정해도 검토는 넘김으로 유지된다', () => {
  const forced = resolveLanes('both-high', { mainCompany: 'claude', mainLanes: ['research'] })
  expect(forced.plan.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  const reviewForced = resolveLanes('both-high', { mainCompany: 'claude', mainLanes: ['review'] })
  expect(laneOf(reviewForced.plan, 'review').how).toBe('relay')
})

test('모델 목록을 아직 모르면 없는 것으로 단정하지 않는다', () => {
  const resolved = resolveLanes('both-high', { mainCompany: 'claude' })
  expect(laneOf(resolved.plan, 'research').how).toBe('relay')
  expect(resolved.notes).toEqual([])
})

test('추천 줄에서 본대화 회사가 바뀌어도 담당 모델은 유지되고 모두 relay다', () => {
  const same = resolveLanes('both-high', { mainCompany: 'claude' })
  expect(laneOf(same.plan, 'research')).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
  expect(laneOf(same.plan, 'writing')).toMatchObject({ company: 'codex', model: 'sol', how: 'relay' })
  expect(laneOf(same.plan, 'repeat')).toMatchObject({ company: 'codex', model: 'terra', how: 'relay' })
  expect(laneOf(same.plan, 'review')).toMatchObject({ company: 'codex', model: 'astra', effort: 'high', how: 'relay' })

  const swapped = resolveLanes('both-high', { mainCompany: 'codex' })
  expect(laneOf(swapped.plan, 'design')).toEqual({ company: 'codex', model: null, effort: null, how: 'main' })
  expect(laneOf(swapped.plan, 'research')).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
  expect(laneOf(swapped.plan, 'writing')).toMatchObject({ company: 'codex', model: 'sol', how: 'relay' })
  expect(laneOf(swapped.plan, 'repeat')).toMatchObject({ company: 'codex', model: 'terra', how: 'relay' })
  expect(laneOf(swapped.plan, 'review')).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
})

const BASE = planFromRow('both-high')
const ACCOUNTS = [claude(), codex()]

test('학생 배치안 — 통과한 레인만 바꾸고 나머지는 추천 그대로 둔다', () => {
  const request: LaneRequest = {
    scope: 'once',
    quote: '글쓰기는 Terra high로 해',
    lanes: { writing: { company: 'codex', model: 'terra', effort: 'high' } }
  }
  const proposal = proposeLaneRequest(request, ACCOUNTS, BASE, 'claude')
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
    'claude'
  )
  expect(proposal.rejected).toEqual([])
  expect(proposal.next.design).toMatchObject({ company: 'codex', model: 'gpt-6.1-sol', how: 'main' })
  expect(proposal.next.research).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
  expect(proposal.next.writing).toMatchObject({ company: 'codex', model: 'sol', how: 'relay' })
  expect(proposal.next.repeat).toMatchObject({ company: 'codex', model: 'terra', how: 'relay' })
  expect(proposal.next.review).toMatchObject({ company: 'codex', model: 'astra', how: 'relay' })
})

test('학생 배치 병합에서 설계만 main이고 네 담당 레인은 모두 relay다', () => {
  const request: LaneRequest = { scope: 'once', quote: '', lanes: {} }
  for (const rowId of Object.keys(LANE_TABLE) as LaneRowId[]) {
    const row = LANE_TABLE[rowId]
    const proposal = proposeLaneRequest(request, ACCOUNTS, planFromRow(rowId), row.lanes.design.company)
    expect(proposal.next.design?.how).toBe('main')
    for (const lane of ['research', 'writing', 'repeat', 'review'] as const) {
      expect(proposal.next[lane]?.how).toBe('relay')
    }
  }
})

test('L-01 학생 지정·목록 부재로 main이 된 레인은 요청에 없으면 main으로 보존한다', () => {
  const accounts = [
    claude({ models: [model('opus', 'Claude Opus', ['high'])] }),
    codex({ models: [model('astra', 'Astra', ['high'])] })
  ]
  const request: LaneRequest = {
    scope: 'once',
    quote: '검토만 Astra high',
    lanes: { review: { company: 'codex', model: 'astra', effort: 'high' } }
  }
  const base = resolveLanes('both-high', {
    mainCompany: 'claude',
    mainLanes: ['research']
  }).plan
  const next = proposeLaneRequest(request, accounts, base, 'claude').next
  expect(next.research).toEqual(base.research)
  expect(next.research).toMatchObject({ company: 'claude', model: null, effort: null, how: 'main' })

  const missingBase = resolveLanes('claude-high', {
    mainCompany: 'claude',
    catalog: { claude: [model('opus', 'Claude Opus', ['high'])] }
  }).plan
  expect(missingBase.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  const missingNext = proposeLaneRequest(request, accounts, missingBase, 'claude').next
  expect(missingNext.research).toEqual(missingBase.research)
})

test('L-01 설계를 다른 회사로 옮겨도 기존 main 레인은 새 본대화 회사로 맞춘다', () => {
  const accounts = [
    claude({ models: [model('opus', 'Claude Opus', ['high'])] }),
    codex({ models: [model('sol', 'Sol', [...EFFORTS, 'ultra'])] })
  ]
  const base = resolveLanes('both-high', {
    mainCompany: 'claude',
    mainLanes: ['research']
  }).plan
  const next = proposeLaneRequest(
    { scope: 'once', quote: '설계는 Codex Sol', lanes: { design: { company: 'codex', model: 'sol' } } },
    accounts,
    base,
    'claude'
  ).next
  expect(next.research).toEqual({ company: 'codex', model: null, effort: null, how: 'main' })
})

test('카드를 누르기 전에는 적용되지 않고, 취소하면 추천 그대로다', () => {
  const before = structuredClone(BASE)
  const proposal = proposeLaneRequest(
    { scope: 'continue', quote: '글쓰기는 Terra', lanes: { writing: { company: 'codex', model: 'terra' } } },
    ACCOUNTS,
    BASE,
    'claude'
  )
  expect(BASE).toEqual(before)
  expect(applyLaneProposal(proposal, 'cancel')).toEqual({ plan: before, scope: null })
})

test('카드에서 이번만·계속을 고르면 그 범위가 결과에 남는다', () => {
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '글쓰기는 Terra', lanes: { writing: { company: 'codex', model: 'terra' } } },
    ACCOUNTS,
    BASE,
    'claude'
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

test('L-02 Claude는 목록 ID와 정확히 같을 때만 인정하고 표시 이름 낱말로 추측하지 않는다', () => {
  for (const [requested, listed, name] of [
    ['claude', 'opus', 'Claude Opus'],
    ['sonnet', 'opus', 'Opus (formerly Sonnet)'],
    ['opus', 'anthropic/claude-opus', 'Claude Opus']
  ] as const) {
    const check = checkWriting(
      { company: 'claude', model: requested },
      [claude({ models: [model(listed, name, ['high'])] })]
    )
    expect(check.accepted).toEqual([])
    expect(check.rejected).toEqual([
      { lane: 'writing', reason: 'model-not-listed', model: requested, effort: null }
    ])
  }

  const base = planFromRow('both-high')
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '글쓰기는 sonnet', lanes: { writing: { company: 'claude', model: 'sonnet' } } },
    [claude({ models: [model('opus', 'Opus (formerly Sonnet)', ['high'])] })],
    base,
    'claude',
  )
  expect(proposal.accepted).toEqual([])
  expect(proposal.next.writing).toEqual(base.writing)
})

test('L-02 추천 모델 목록 대조도 표시 이름이 아니라 정확한 목록 ID로만 한다', () => {
  const resolved = resolveLanes('claude-high', {
    mainCompany: 'claude',
    catalog: { claude: [model('opus', 'Opus (formerly Sonnet)', ['high'])] }
  })
  expect(resolved.plan.research).toEqual({ company: 'claude', model: null, effort: null, how: 'main' })
  expect(resolved.notes).toContainEqual({ lane: 'research', kind: 'main-takeover', model: 'sonnet' })
})

test('L-02 Codex 별칭이 다른 공급자 ID로만 풀리면 거절한다', () => {
  const check = checkWriting(
    { company: 'codex', model: 'astra' },
    [claude(), codex({ models: [model('openai/gpt-6.1-astra', 'Astra', ['high'])] })]
  )
  expect(check.accepted).toEqual([])
  expect(check.rejected).toEqual([
    { lane: 'writing', reason: 'model-not-listed', model: 'astra', effort: null }
  ])
})

test('학생이 "검토도 이 대화에서" 하면 검토 레인만 거절하고 추천 검토는 그대로 둔다', () => {
  const check = checkLaneRequest({ scope: 'once', quote: '', lanes: { review: { main: true } } }, ACCOUNTS)
  expect(check.accepted).toEqual([])
  expect(check.rejected).toEqual([{ lane: 'review', reason: 'review-main' }])
  const proposal = proposeLaneRequest(
    { scope: 'once', quote: '', lanes: { review: { main: true } } },
    ACCOUNTS,
    BASE,
    'claude'
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

  const proposal = proposeLaneRequest(all, ACCOUNTS, BASE, 'claude')
  expect(laneOf(proposal.next, 'design').how).toBe('main')
  expect(laneOf(proposal.next, 'review')).toMatchObject({ company: 'codex', effort: 'ultra', how: 'relay' })

  const claudeReview = proposeLaneRequest(
    { scope: 'once', quote: '검토는 Claude Opus max', lanes: { review: { company: 'claude', model: 'opus', effort: 'max' } } },
    ACCOUNTS,
    BASE,
    'claude'
  )
  expect(claudeReview.rejected).toEqual([])
  expect(claudeReview.next.review).toMatchObject({ company: 'claude', model: 'opus', effort: 'max', how: 'relay' })
})
const CONTINUATION_STATE = { consented: true, basicUsageAllowed: true }
const SOLO_ROWS: Record<AccountSnapshot['company'], Record<PlanTier, LaneRowId>> = {
  claude: { low: 'claude-low', high: 'claude-high' },
  codex: { low: 'codex-low', high: 'codex-high' }
}

function accountFor(company: AccountSnapshot['company'], tier: PlanTier): AccountSnapshot {
  if (company === 'claude') return claude({ subscriptionType: tier === 'high' ? 'max' : 'pro' })
  const models =
    tier === 'high'
      ? CODEX_MODELS
      : CODEX_MODELS.filter((entry) => entry.model !== 'gpt-6.1-sol' && entry.model !== 'gpt-6.1-astra')
  return codex({ models })
}

function catalogFor(account: AccountSnapshot): ModelCatalog {
  return account.company === 'claude' ? { claude: account.models } : { codex: account.models }
}

test('한도 이어 하기는 8개 표와 네 담당 역할에서 반대 회사의 혼자 줄을 쓴다', () => {
  for (const rowId of Object.keys(LANE_TABLE) as LaneRowId[]) {
    for (const lane of ['research', 'writing', 'repeat', 'review'] as const) {
      const failedEntry = LANE_TABLE[rowId].lanes[lane]
      const otherCompany = failedEntry.company === 'claude' ? 'codex' : 'claude'
      expect(continueAfterLimit(lane, failedEntry, null, CONTINUATION_STATE, {})).toBeNull()

      for (const tier of ['low', 'high'] as const) {
        const otherAccount = accountFor(otherCompany, tier)
        const target = LANE_TABLE[SOLO_ROWS[otherCompany][tier]].lanes[lane]
        const listedTarget =
          otherAccount.company === 'claude'
            ? target.model
            : otherAccount.models?.find((entry) => entry.name.toLowerCase() === target.model)?.model
        const result = continueAfterLimit(
          lane,
          failedEntry,
          otherAccount,
          CONTINUATION_STATE,
          catalogFor(otherAccount)
        )

        expect(result).toEqual({
          company: otherCompany,
          model: listedTarget,
          effort: lane === 'review' ? 'high' : null,
          how: 'relay'
        })
      }
    }
  }
})

test('한도 이어 하기는 동의·기본 사용·구독·대상 모델 목록을 모두 요구한다', () => {
  const failedCodex = LANE_TABLE['codex-low'].lanes.research
  const failedClaude = LANE_TABLE['claude-low'].lanes.research
  const claudeHigh = claude({ subscriptionType: 'max' })
  const codexHigh = codex()

  expect(continueAfterLimit('research', failedCodex, claudeHigh, { ...CONTINUATION_STATE, consented: false }, catalogFor(claudeHigh))).toBeNull()
  expect(continueAfterLimit('research', failedCodex, claudeHigh, { ...CONTINUATION_STATE, basicUsageAllowed: false }, catalogFor(claudeHigh))).toBeNull()
  expect(continueAfterLimit('research', failedCodex, codexHigh, CONTINUATION_STATE, catalogFor(codexHigh))).toBeNull()
  expect(
    continueAfterLimit(
      'research',
      failedCodex,
      claude({ apiKeySource: 'ANTHROPIC_API_KEY' }),
      CONTINUATION_STATE,
      { claude: CLAUDE_MODELS }
    )
  ).toBeNull()
  expect(
    continueAfterLimit(
      'research',
      failedClaude,
      codex({ accountType: 'apiKey' }),
      CONTINUATION_STATE,
      { codex: CODEX_MODELS }
    )
  ).toBeNull()
  expect(continueAfterLimit('research', failedCodex, claudeHigh, CONTINUATION_STATE, { claude: null })).toBeNull()
  expect(
    continueAfterLimit(
      'research',
      failedCodex,
      claudeHigh,
      CONTINUATION_STATE,
      { claude: CLAUDE_MODELS.filter((entry) => entry.model !== 'sonnet') }
    )
  ).toBeNull()
  expect(
    continueAfterLimit(
      'research',
      { ...failedCodex, how: 'main' },
      claudeHigh,
      CONTINUATION_STATE,
      { claude: CLAUDE_MODELS }
    )
  ).toBeNull()
})

test('한도 이어 하기는 깊이를 지원할 때만 유지하고 검토는 high를 반드시 요구한다', () => {
  const failedWriting = { ...LANE_TABLE['codex-low'].lanes.writing, effort: 'high' }
  const claudeHigh = claude({ subscriptionType: 'max' })
  const preserved = continueAfterLimit('writing', failedWriting, claudeHigh, CONTINUATION_STATE, { claude: CLAUDE_MODELS })
  expect(preserved).toMatchObject({ company: 'claude', model: 'sonnet', effort: 'high', how: 'relay' })

  const sonnetWithoutHigh = CLAUDE_MODELS.map((entry) =>
    entry.model === 'sonnet' ? { ...entry, efforts: ['low'] } : entry
  )
  const reset = continueAfterLimit('writing', failedWriting, claudeHigh, CONTINUATION_STATE, { claude: sonnetWithoutHigh })
  expect(reset).toMatchObject({ company: 'claude', model: 'sonnet', effort: null, how: 'relay' })

  const failedReview = LANE_TABLE['codex-low'].lanes.review
  const review = continueAfterLimit('review', failedReview, claudeHigh, CONTINUATION_STATE, { claude: CLAUDE_MODELS })
  expect(review).toMatchObject({ company: 'claude', model: 'opus', effort: 'high', how: 'relay' })
  const opusWithoutHigh = CLAUDE_MODELS.map((entry) =>
    entry.model === 'opus' ? { ...entry, efforts: ['low'] } : entry
  )
  expect(continueAfterLimit('review', failedReview, claudeHigh, CONTINUATION_STATE, { claude: opusWithoutHigh })).toBeNull()
})
