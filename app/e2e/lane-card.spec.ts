// 배선 C §3 — 카드는 main 이 짓고 **한 번만** 소비한다. 화면은 카드 id·판·단추만 돌려준다.
// 실제 AI 호출 0회: 계정은 스텁, 러너는 기록만 돌려준다. 계약: lanes:decide-card, lanes:card-status,
// lanes:settings-card, lanes:review-models, lanes:pick-review, lanes:disable.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/main/chat/jobs/store'
import { canonical } from '../src/main/chat/jobs/isolation'
import type { ExecutionAccount, JobRecord, JobSpec } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow, type LaneRequest } from '../src/shared/lanes'
import type { LaneEntry } from '../src/shared/lanes'
import { assembleLanes } from '../src/main/lanes/snapshot'
import { laneInput } from '../src/main/lanes/source'
import {
  LaneFailure, cardStatus, decideCard, disable, openCard, pickReview, reviewModels, settingsCard,
  type CardDeps
} from '../src/main/lanes/cards'

interface Accounts {
  claude: { model: string; high: boolean }[]
  codex: { model: string; high: boolean }[]
}

/** 낮음 전용 모델(`haiku`)을 하나 끼워 §3-4 필터가 실제로 거르는지 본다. */
function catalog(overrides: Accounts = { claude: [], codex: [] }) {
  const claude = overrides.claude.length
    ? overrides.claude
    : [{ model: 'opus', high: true }, { model: 'sonnet', high: true }, { model: 'haiku', high: false }]
  const codex = overrides.codex.length
    ? overrides.codex
    : [
      { model: 'gpt-6.1-astra', high: true }, { model: 'gpt-6.1-sol', high: true },
      { model: 'gpt-6.1-terra', high: true }, { model: 'gpt-6-luna', high: false }
    ]
  return { claude, codex }
}

function setup(options: { mainCompany?: Provider; accounts?: Accounts } = {}) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-card-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  const models = catalog(options.accounts)
  const accountIds: Record<Provider, string> = { claude: 'claude-account', codex: 'codex-account' }

  const account = async (company: Provider): Promise<ExecutionAccount | null> => ({
    accountId: accountIds[company],
    connected: true,
    account: company === 'claude'
      ? {
        company: 'claude', apiKeySource: 'none', subscriptionType: 'max',
        models: models.claude.map(entry => ({
          model: entry.model, name: entry.model, efforts: entry.high ? ['low', 'high'] : ['low']
        }))
      }
      : {
        company: 'codex', accountType: 'chatgpt',
        models: models.codex.map(entry => ({
          model: entry.model, name: entry.model, efforts: entry.high ? ['low', 'high'] : ['low']
        }))
      },
    consented: false,
    usage: 'allowed'
  })

  const records: JobRecord[] = []
  const stopped: string[] = []
  /** [C1-06] 캐시를 건너뛴 대조를 시험하려면 실제 관측을 따로 센다. */
  const freshReads: string[] = []
  const runner = {
    records: () => structuredClone(records),
    stopJob: async (jobId: string) => {
      stopped.push(jobId)
      const found = records.find(record => record.spec.id === jobId)
      if (!found) throw new Error('unknown job')
      return structuredClone(found)
    }
  }
  const deps: CardDeps = {
    store,
    account,
    mainCompany: options.mainCompany ?? 'claude',
    runner,
    freshAccount: async company => {
      freshReads.push(company)
      return account(company)
    }
  }
  return { base, root, store, deps, records, stopped, accountIds, freshReads }
}

function record(root: string, id: string, status: JobRecord['status']): JobRecord {
  const plan = planFromRow('both-high')
  const spec: JobSpec = {
    schema: 1, id, lane: 'research', task: '자료를 읽고 결과를 쓴다',
    inputs: [], outputs: ['result.md'], contractVersion: 'role-v1',
    company: plan.research!.company, model: plan.research!.model!, effort: plan.research!.effort
  }
  return {
    spec, rootJobId: id, root, owner: { id: `codex\0${root}`, sessionId: 'main', company: 'codex' },
    authorSessionId: 'author', status, contentHash: 'h', outputs: [],
    createdAt: '2026-11-10T00:00:00.000Z'
  }
}

function request(lanes: LaneRequest['lanes'], quote = ''): LaneRequest {
  return { scope: 'continue', quote, lanes }
}

/** 글쓰기를 Claude 로 — 기본 배치(`both-high`)의 `codex/sol` 과 다른 줄 하나만 바뀐다. */
const writingToClaude: LaneRequest = request({ writing: { company: 'claude', model: 'sonnet' } }, '글쓰기는 Claude 로 맡아요')

async function snapshot(f: ReturnType<typeof setup>) {
  const input = await laneInput({
    store: f.store,
    // 줄 집합은 러너가 있을 때만 만들어진다 — 빈 러너로 카드 줄만 보게 한다.
    runner: { records: () => structuredClone(f.records), proposals: () => [] },
    mainCompany: f.deps.mainCompany,
    account: f.deps.account
  }, f.root)
  return assembleLanes(input)
}

// ① §3-2 학생 말 → 카드. 바뀌는 줄만 남고, 승인 [계속]은 앱 저장소의 배치를 바꾼다.
test('card: a request opens one row per changed lane and [계속] stores the exact plan', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  expect(opened.variant).toBe('first')
  expect(opened.quote).toBe('글쓰기는 Claude 로 맡아요')
  expect(opened.rows.map(row => row.lane)).toEqual(['writing'])
  expect(opened.rows[0]).toMatchObject({
    before: { company: 'codex', model: 'sol', how: 'relay' },
    after: { company: 'claude', model: 'sonnet', how: 'relay' },
    rejected: null, designSwitchTo: null, requested: null
  })
  // 요금 상자는 **주문이 나가는** 회사만 — 이 카드에서는 둘 다 relay 다.
  expect(opened.fees.map(fee => fee.company).sort()).toEqual(['claude', 'codex'])
  expect(opened.fees.every(fee => fee.consented === false)).toBe(true)
  expect(opened.recommendedDesign).toEqual({ company: 'claude', model: 'opus', effort: null })
  // 화면으로 나가는 카드에는 계정 id·적용 배치가 없다.
  expect(Object.keys(opened).sort()).toEqual([
    'baseVersion', 'cardId', 'createdAt', 'fastDrain', 'fees', 'quote', 'recommendedDesign',
    'reviewDue', 'root', 'rows', 'state', 'variant'
  ])

  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('applied')
  expect(decision.card.state).toEqual({ kind: 'applied', scope: 'continue' })
  expect(decision.boundTurn).toBeNull()
  const approved = f.store.approvedPlan(f.root)!
  expect(approved.writing).toEqual({ company: 'claude', model: 'sonnet', effort: null, how: 'relay' })
  expect(approved.research.company).toBe('codex')
  expect(f.store.approvedAt(f.root)).toEqual(expect.any(String))
  expect(f.store.consents().map(entry => `${entry.company}:${entry.state}`).sort())
    .toEqual(['claude:agreed', 'codex:agreed'])
  expect(f.store.temporary(f.root)).toBeNull()

  const body = await snapshot(f)
  expect(body.settings.mode).toBe('on')
  // 승인 기록이 있으니 화면은 "내가 정함"을 그린다 — 추천과 다르다.
  expect(body.settings.source.kind).toBe('mine')
  expect(body.settings.differsFromRecommendation).toBe(true)
})

// ② §8-4 원자 소비 — 두 번째 단추는 아무것도 바꾸지 않고 "이미 처리됨"이다.
test('card: a consumed card reports already-handled and keeps its applied record', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  const approved = f.store.approvedPlan(f.root)

  const again = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(again.outcome).toBe('already-handled')
  expect(again.reason).toBeNull()
  expect(again.card.state).toEqual({ kind: 'applied', scope: 'continue' })
  expect(f.store.approvedPlan(f.root)).toEqual(approved)
  expect(await cardStatus(f.deps, f.root, opened.cardId)).toMatchObject({ outcome: 'already-handled' })
})

// ③ §3-2 [이번만] — **[C1-04 덜어냄]** v0.7은 이 갈래를 받지 않는다(DESIGN-C0b 부록 A).
// 예전 시험 `card: [이번만] keeps the approved plan and binds the run to the next student turn`
// 은 기대를 '거절'로 바꿨다 — 요청이 아무 상태도 바꾸지 않는지가 이제 잠글 사실이다.
test('card: [이번만] is refused in v0.7 and changes no plan, consent or card state', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  await expect(decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'once'))
    .rejects.toMatchObject({ code: 'unavailable' })
  // 승인 배치·임시 배치·동의·카드 상태 어디에도 흔적이 없다.
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.temporary(f.root)).toBeNull()
  expect(f.store.consent('claude', 'claude-account')).toBeNull()
  expect(await cardStatus(f.deps, f.root, opened.cardId)).toMatchObject({
    outcome: 'open', card: { state: { kind: 'open' } }
  })
  expect(f.store.events(f.root)).toEqual([])
  // 거절은 소비가 아니다 — 같은 카드로 [계속]이 그대로 된다.
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('applied')
  expect(f.store.approvedPlan(f.root)?.writing?.company).toBe('claude')
})

// ④ §3-5 옛 판 — 만든 뒤 배치 판이 바뀌면 적용하지 않고 무효로 접는다.
test('card: a stale baseVersion is refused and the card closes as invalid', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  f.store.bumpVersion(f.root)
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('base-version')
  expect(decision.card.state).toEqual({ kind: 'invalid', reason: 'base-version' })
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.consents()).toEqual([])
})

// ⑤ §3-5·U6-04 더 새 카드가 앞 카드를 밀어낸다 — 밀려난 카드는 "새 카드로 바뀌었어요".
test('card: a newer card supersedes the open one instead of stacking two pending cards', async () => {
  const f = setup()
  const first = await openCard(f.deps, f.root, writingToClaude)
  const second = await openCard(f.deps, f.root, request({ research: { company: 'claude', model: 'opus' } }))
  expect(second.cardId).not.toBe(first.cardId)
  expect(f.store.card(first.cardId)?.state).toEqual({ kind: 'superseded', by: second.cardId })

  const decision = await decideCard(f.deps, f.root, first.cardId, first.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('superseded')
  expect(f.store.approvedPlan(f.root)).toBeNull()

  const body = await snapshot(f)
  const pending = body.lines.filter(line => line.kind === 'card-pending')
  expect(pending.map(line => line.kind === 'card-pending' ? line.cardId : null)).toEqual([second.cardId])
})

// ⑥ [Roh 중요 3] 적용 직전 대조 — 계정이 바뀌었으면 적용도 동의 저장도 하지 않는다.
test('card: a changed login account invalidates the card and saves no consent', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  f.accountIds.claude = 'claude-other'
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('account-changed')
  expect(decision.card.state).toEqual({ kind: 'invalid', reason: 'account-changed' })
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.consents()).toEqual([])
})

// ⑦ §3-1 [나눠 맡기지 않기] — 기록 줄이 남고 설정은 "끔"이 된다.
test('card: [나눠 맡기지 않기] records the decline and turns the mode off', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'decline')
  expect(decision.card.state).toEqual({ kind: 'declined' })
  expect(f.store.events(f.root).map(event => event.kind)).toEqual(['lanes-declined'])
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect((await snapshot(f)).settings.mode).toBe('off')
})

// ⑧ §3-1 단추 밖의 단추는 소비하지 않는다 — [나눠 맡기지 않기]는 처음 카드에만 있다.
test('card: an action the variant does not offer leaves the card open', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude, 'change')
  await expect(decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'decline'))
    .rejects.toBeInstanceOf(LaneFailure)
  expect((await cardStatus(f.deps, f.root, opened.cardId)).outcome).toBe('open')
})

// ⑨ [F4] 거절된 줄은 이전 값 그대로 + 학생이 요청한 값. 모두 거절이면 [확인]만 받는다.
test('card: rejected rows keep the old entry and record what the student asked for', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, request({ writing: { company: 'claude', model: 'gpt-6.1-astra' } }))
  expect(opened.rows).toHaveLength(1)
  expect(opened.rows[0]).toMatchObject({
    lane: 'writing',
    before: { company: 'codex', model: 'sol', how: 'relay' },
    after: { company: 'codex', model: 'sol', how: 'relay' },
    rejected: 'model-not-listed',
    requested: { main: false, model: 'gpt-6.1-astra', effort: null }
  })
  await expect(decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue'))
    .rejects.toBeInstanceOf(LaneFailure)
  expect((await cardStatus(f.deps, f.root, opened.cardId)).outcome).toBe('open')
  const acked = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'ack')
  expect(acked.outcome).toBe('applied')
  expect(acked.card.state).toEqual({ kind: 'cancelled' })
})

// ⑩ §3-3 설정 확인 창 — 켜기는 추천 배치를 그대로 적용하고, 열려 있는 동안 대화에 안 뜬다.
test('card: a settings card applies the recommended plan and only shows once applied', async () => {
  const f = setup()
  const opened = await settingsCard(f.deps, f.root, 'enable')
  expect(opened.variant).toBe('settings-enable')
  expect(opened.quote).toBeNull()
  expect(opened.rows.map(row => row.lane)).toEqual(['design', 'research', 'writing', 'repeat', 'review'])

  const beforeApply = await snapshot(f)
  expect(beforeApply.cards).toEqual([])
  expect(beforeApply.lines.some(line => line.kind === 'card-pending')).toBe(false)

  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('applied')
  expect(decision.card.state).toEqual({ kind: 'applied', scope: 'continue' })
  // 범위는 [계속] 하나뿐이다.
  await expect(decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'once'))
    .rejects.toBeInstanceOf(LaneFailure)

  const approved = f.store.approvedPlan(f.root)!
  expect(approved.review).toEqual({ company: 'codex', model: 'astra', effort: 'high', how: 'relay' })
  const afterApply = await snapshot(f)
  expect(afterApply.cards.map(card => card.state.kind)).toEqual(['applied'])
  expect(afterApply.settings.source.kind).toBe('recommended')
})

test('card: settings revert without an approved plan is refused, and settings cards never supersede', async () => {
  const f = setup()
  await expect(settingsCard(f.deps, f.root, 'revert')).rejects.toBeInstanceOf(LaneFailure)
  const conversation = await openCard(f.deps, f.root, writingToClaude)
  await settingsCard(f.deps, f.root, 'enable')
  expect(f.store.card(conversation.cardId)?.state).toEqual({ kind: 'open' })
})

// ⑪ §3-4 검토 모델 고르기 — `high` 를 지원하는 모델만, 고르면 §3-2 카드가 열린다.
test('card: review models list only high-effort models and picking one opens a change card', async () => {
  const f = setup()
  const groups = await reviewModels(f.deps)
  expect(groups).toEqual([
    { company: 'claude', models: [{ model: 'opus', name: 'opus' }, { model: 'sonnet', name: 'sonnet' }] },
    {
      company: 'codex',
      models: [
        { model: 'gpt-6.1-astra', name: 'gpt-6.1-astra' },
        { model: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
        { model: 'gpt-6.1-terra', name: 'gpt-6.1-terra' }
      ]
    }
  ])
  // `high` 를 못 쓰는 모델은 고를 수 없다 — 조용히 다른 모델로 바꾸지 않는다.
  await expect(pickReview(f.deps, f.root, 'codex', 'gpt-6-luna')).rejects.toBeInstanceOf(LaneFailure)

  const opened = await pickReview(f.deps, f.root, 'claude', 'opus')
  expect(opened.variant).toBe('change')
  expect(opened.rows.map(row => row.lane)).toEqual(['review'])
  expect(opened.rows[0]).toMatchObject({
    before: { company: 'codex', model: 'astra', effort: 'high' },
    after: { company: 'claude', model: 'opus', effort: 'high', how: 'relay' }
  })
  // 고르기만으로는 적용되지 않는다.
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect((await cardStatus(f.deps, f.root, opened.cardId)).outcome).toBe('open')
  await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(f.store.approvedPlan(f.root)?.review).toEqual({
    company: 'claude', model: 'opus', effort: 'high', how: 'relay'
  })
})

// ⑫ §3.1 D2-03 설계 회사 전환 — 이음매가 없으면 누르기 전에 막고, 바뀌지 않았으면 적용이 아니다.
test('card: a design-company switch needs the apply seam and only reports applied when it changed', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, request({ design: { company: 'codex', model: 'gpt-6.1-sol' } }))
  expect(opened.rows[0]).toMatchObject({ lane: 'design', designSwitchTo: 'codex', rejected: null })
  await expect(decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue'))
    .rejects.toBeInstanceOf(LaneFailure)
  expect((await cardStatus(f.deps, f.root, opened.cardId)).outcome).toBe('open')
  expect(f.store.approvedPlan(f.root)).toBeNull()

  // [이번만]은 v0.7에서 통째로 거절된다 — 설계를 바꾸는 카드라도 이음매를 부르지 않는다.
  const seam: LaneEntry[] = []
  const withSeam: CardDeps = {
    ...f.deps,
    applyDesign: async (_root, design) => { seam.push(design); return true }
  }
  await expect(decideCard(withSeam, f.root, opened.cardId, opened.baseVersion, 'once'))
    .rejects.toBeInstanceOf(LaneFailure)
  expect(seam).toEqual([])

  const decision = await decideCard(withSeam, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('applied')
  expect(seam).toEqual([{ company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' }])
  expect(f.store.approvedPlan(f.root)?.design).toEqual({
    company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main'
  })
})

test('card: a design switch the seam reports as unchanged is not "applied"', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, request({ design: { company: 'codex', model: 'gpt-6.1-sol' } }))
  const decision = await decideCard(
    { ...f.deps, applyDesign: async () => false }, f.root, opened.cardId, opened.baseVersion, 'continue'
  )
  expect(decision.outcome).toBe('invalid')
  expect(decision.card.state).toEqual({ kind: 'invalid', reason: null })
  expect(f.store.approvedPlan(f.root)).toBeNull()
})

// ⑬ §3-5 [다시 확인] — 상태만 묻는다. 재적용하지 않는다.
test('card: status never re-applies and old cards without a stored plan close as invalid', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  expect(await cardStatus(f.deps, f.root, opened.cardId)).toMatchObject({ outcome: 'open', reason: null })
  f.store.beginCard(opened.cardId, opened.baseVersion)
  expect(await cardStatus(f.deps, f.root, opened.cardId)).toMatchObject({ outcome: 'pending' })
  expect(f.store.approvedPlan(f.root)).toBeNull()

  // 옛 파일의 카드 — 적용할 배치가 저장돼 있지 않다. 화면 값으로 다시 짓지 않고 닫는다.
  const legacy = {
    cardId: 'legacy', root: f.root, variant: 'first' as const, baseVersion: f.store.versionOf(f.root),
    createdAt: '2026-11-10T00:00:00.000Z', reviewDue: false, quote: null, rows: [], fees: [],
    fastDrain: false, recommendedDesign: null, state: { kind: 'open' as const }
  }
  f.store.addCard(legacy, {})
  const decision = await decideCard(f.deps, f.root, 'legacy', legacy.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.card.state).toEqual({ kind: 'invalid', reason: null })
  expect(f.store.approvedPlan(f.root)).toBeNull()
})

// ⑭ §5 [나눠 맡기기 끄기] — 그 폴더의 진행·대기 주문만 멈추고 승인을 거두고 옛 임시 배치도 지운다.
test('card: disable stops only this folder\'s live jobs and revokes the plan', async () => {
  const f = setup()
  const approved = await openCard(f.deps, f.root, writingToClaude)
  await decideCard(f.deps, f.root, approved.cardId, approved.baseVersion, 'continue')
  for (const [id, status] of [['j-queued', 'queued'], ['j-running', 'running'], ['j-limit', 'limit'], ['j-done', 'delivered']] as const) {
    f.records.push(record(f.root, id, status))
  }
  f.records.push(record('/elsewhere', 'j-other', 'running'))

  await disable(f.deps, f.root)
  expect(f.stopped.sort()).toEqual(['j-limit', 'j-queued', 'j-running'])
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.temporary(f.root)).toBeNull()
  expect(f.store.events(f.root).map(event => event.kind)).toEqual(['lanes-declined'])
  // 끄기는 요금 동의를 건드리지 않는다 — 동의는 계정 단위다.
  expect(f.store.consent('claude', 'claude-account')).toMatchObject({ state: 'agreed' })
  expect((await snapshot(f)).settings.mode).toBe('off')
})

// ---------------------------------------------------------------------------------
// 독립검토 1회째(REVIEW-C1-MAIN) 재현 — 고침을 빼면 실패하는 시험들.
// ---------------------------------------------------------------------------------

// [C1-02] 취소·거절한 카드는 설계 칩을 건드리지 않는다(부작용은 승인 분기 안에서만).
for (const action of ['cancel', 'decline'] as const) {
  test(`card fix: [${action}] never runs the design switch`, async () => {
    const f = setup()
    const designCalls: string[] = []
    const deps: CardDeps = {
      ...f.deps,
      applyDesign: async (_root, design) => { designCalls.push(`${design.company}:${design.model}`); return true }
    }
    const opened = await openCard(deps, f.root, request({ design: { company: 'codex', model: 'gpt-6.1-sol' } }))
    expect(opened.rows[0]).toMatchObject({ lane: 'design', designSwitchTo: 'codex' })
    const decision = await decideCard(deps, f.root, opened.cardId, opened.baseVersion, action)
    expect(decision.card.state.kind).toBe(action === 'cancel' ? 'cancelled' : 'declined')
    expect(designCalls).toEqual([])
    expect(f.store.approvedPlan(f.root)).toBeNull()
  })
}

test('card fix: [계속] is the only action that runs the design switch', async () => {
  const f = setup()
  const designCalls: string[] = []
  const opened = await openCard({
    ...f.deps, applyDesign: async (_root, design) => { designCalls.push(`${design.company}:${design.model}`); return true }
  }, f.root, request({ design: { company: 'codex', model: 'gpt-6.1-sol' } }))
  const decision = await decideCard({
    ...f.deps, applyDesign: async (_root, design) => { designCalls.push(`${design.company}:${design.model}`); return true }
  }, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('applied')
  expect(designCalls).toEqual(['codex:gpt-6.1-sol'])
})

// [C1-03] 끄기가 끝난 뒤 앞서 시작된 승인이 이어지면 배치를 되살리지 않는다.
// 폴더 단위 직렬화로 두 순서 모두 안전하다: 끄기가 먼저면 승인은 옛 판이라 무효,
// 승인이 먼저면 끄기가 그 뒤에 철회한다. 어느 쪽도 "철회됨 + 승인됨" 이 동시에 남지 않는다.
test('card fix: a disable that lands before a stale approval cannot be undone by it', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  await disable(f.deps, f.root)
  // 끄기 전에 뜬 카드를 그대로 누른다 — 화면이 늦게 보낸 단추.
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('base-version')
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.events(f.root).map(event => event.kind)).toEqual(['lanes-declined'])
})

test('card fix: an approval and a disable never both win in the same folder', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  const [decision] = await Promise.all([
    decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue'),
    disable(f.deps, f.root)
  ])
  // 끄기는 언제나 마지막 손이라는 규칙은 없다 — 순서는 직렬화가 정한다. 어느 쪽이든
  // "철회 기록이 있는데 승인 배치가 살아 있는" 상태는 나오지 않는다.
  expect(decision.outcome === 'applied' || decision.outcome === 'invalid').toBe(true)
  const declined = f.store.events(f.root).some(event => event.kind === 'lanes-declined')
  if (declined) expect(f.store.approvedPlan(f.root)).toBeNull()
})

// [C1-05] 같은 판을 들고 동시에 들어온 두 카드는 하나만 적용된다.
test('card fix: two cards of the same version never both apply', async () => {
  const f = setup()
  const conversation = await openCard(f.deps, f.root, writingToClaude)
  const settings = await settingsCard(f.deps, f.root, 'enable')
  expect(conversation.baseVersion).toBe(settings.baseVersion)

  const results = await Promise.all([
    decideCard(f.deps, f.root, conversation.cardId, conversation.baseVersion, 'continue'),
    decideCard(f.deps, f.root, settings.cardId, settings.baseVersion, 'continue')
  ])
  expect(results.filter(result => result.outcome === 'applied')).toHaveLength(1)
  expect(results.filter(result => result.outcome === 'invalid')).toHaveLength(1)
  // 마지막 카드가 앞 카드의 배치를 덮어쓰지 않는다 — 적용된 하나의 배치만 남는다.
  const approved = f.store.approvedPlan(f.root)!
  expect(approved.writing.company).toBe('claude')
  expect(approved.review?.company).toBe('codex')
})

// [C1-13] 적용 중에 앱이 죽은 카드는 재시작 뒤 `pending` 으로 남지 않고, **결과를 모르는 카드를
// 적용된 것으로 추정하지 않는다** — 학생이 다시 확인하게 한다.
test('card fix: a card interrupted while applying is invalid after restart, never guessed as applied', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  f.store.beginCard(opened.cardId, opened.baseVersion)
  // 반례 ①: **다른 카드의** 승인이 폴더에 남아 있다. 예전 판은 이것만 보고 `applied` 로 복구했다.
  f.store.approve(f.root, f.store.cardPlan(opened.cardId)!)
  const reopened = new JobStore(join(f.base, 'jobs'))
  const status = cardStatus({ store: reopened }, f.root, opened.cardId)
  expect(status.outcome).not.toBe('pending')
  // 사유는 `null` — 결과를 모르는 카드라 사유별 문구(계정 바뀜·판 불일치)를 지어내지 않는다.
  expect(status.card.state).toEqual({ kind: 'invalid', reason: null })
  // 판은 그대로다 — 남은 카드가 옛 판으로 밀리지 않는다.
  expect(reopened.versionOf(f.root)).toBe(f.store.versionOf(f.root))

  // 반례 ②: 승인 기록이 없어도 같은 결과다(추정이 아니라 "모른다"로 통일).
  const g = setup()
  const other = await openCard(g.deps, g.root, writingToClaude)
  g.store.beginCard(other.cardId, other.baseVersion)
  const reopenedAgain = new JobStore(join(g.base, 'jobs'))
  expect(cardStatus({ store: reopenedAgain }, g.root, other.cardId).card.state).toEqual({ kind: 'invalid', reason: null })
})

// [C1-06] 적용 직전 계정 대조는 캐시가 아니라 **지금** 관측을 쓴다.
test('card fix: apply re-reads the account instead of trusting a cached probe', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  f.freshReads.length = 0
  await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  // 카드가 묶은 두 회사 중 하나라도 캐시를 건너뛰지 않으면 15초 동안 계정 변경을 못 본다.
  expect(f.freshReads).toEqual(['claude', 'codex'])
})

// ---------------------------------------------------------------------------------
// §0-5 5번 — 무효 사유는 카드 **상태**에 남는다(계약 `CardState.invalid.reason`).
// 다시 그릴 때 사유별 문구를 고르려면 화면이 아니라 main 저장소가 정본이어야 한다.
// ---------------------------------------------------------------------------------

test('card: invalid 사유 저장·재시작 뒤 유지', async () => {
  // 계정이 바뀐 카드 — 사유가 카드 상태에 남고, 재시작한 앱의 [다시 확인]도 같은 사유를 본다.
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  const changed = async (company: Provider) =>
    ({ ...(await f.deps.account(company))!, accountId: `other-${company}` })
  const decision = await decideCard({ ...f.deps, freshAccount: changed }, f.root,
    opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('account-changed')
  // 응답의 카드에도 사유가 실린다 — 화면이 상태를 다시 묻지 않고 바로 그릴 수 있다.
  expect(decision.card.state).toEqual({ kind: 'invalid', reason: 'account-changed' })
  const reopened = new JobStore(join(f.base, 'jobs'))
  expect(cardStatus({ store: reopened }, f.root, opened.cardId))
    .toMatchObject({ outcome: 'invalid', reason: 'account-changed' })

  // 판이 바뀐 카드도 같은 자리에 사유를 남긴다(끄기가 먼저 끝난 뒤 늦게 온 단추).
  const g = setup()
  const stale = await openCard(g.deps, g.root, writingToClaude)
  await disable(g.deps, g.root)
  const raced = await decideCard(g.deps, g.root, stale.cardId, stale.baseVersion, 'continue')
  expect(raced).toMatchObject({ outcome: 'invalid', reason: 'base-version' })
  const again = new JobStore(join(g.base, 'jobs'))
  expect(cardStatus({ store: again }, g.root, stale.cardId))
    .toMatchObject({ outcome: 'invalid', reason: 'base-version' })
})

test('card: 옛 자료 null', () => {
  // 이 칸이 생기기 전에 저장된 카드 = `{ kind: 'invalid' }` 뿐이다. 저장소가 그대로 읽어도
  // 사유는 `null`(§3-5 기본 문구)이어야 한다 — 없는 값을 지어내지 않는다.
  const f = setup()
  const legacy = {
    cardId: 'legacy-invalid', root: f.root, variant: 'first' as const, baseVersion: f.store.versionOf(f.root),
    createdAt: '2026-11-10T00:00:00.000Z', reviewDue: false, quote: null, rows: [], fees: [],
    fastDrain: false, recommendedDesign: null, state: { kind: 'open' as const }
  }
  f.store.addCard(legacy, {})
  f.store.settleCard('legacy-invalid', { kind: 'invalid', reason: null })
  // 파일에서 사유 칸을 지워 **옛 판이 쓴 모양 그대로** 만든다(옛 앱은 이 칸을 쓰지 않았다).
  const file = join(f.base, 'jobs', 'store.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    cards: Record<string, { cardId: string; state: Record<string, unknown> }[]>
  }
  const saved = raw.cards[f.root]!.find(card => card.cardId === 'legacy-invalid')!
  delete saved.state.reason
  writeFileSync(file, JSON.stringify(raw))
  const reopened = new JobStore(join(f.base, 'jobs'))
  // 읽을 때 이관한다 — 계약이 필수 칸이 됐으므로 저장소 밖으로 사유 없는 무효 카드가 나가지 않는다.
  expect(reopened.card('legacy-invalid')!.state).toEqual({ kind: 'invalid', reason: null })
  expect(cardStatus({ store: reopened }, f.root, 'legacy-invalid'))
    .toMatchObject({ outcome: 'invalid', reason: null })
})
