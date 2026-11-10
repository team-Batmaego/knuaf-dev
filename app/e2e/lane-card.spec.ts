// 배선 C §3 — 카드는 main 이 짓고 **한 번만** 소비한다. 화면은 카드 id·판·단추만 돌려준다.
// 실제 AI 호출 0회: 계정은 스텁, 러너는 기록만 돌려준다. 계약: lanes:decide-card, lanes:card-status,
// lanes:settings-card, lanes:review-models, lanes:pick-review, lanes:disable.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
  const runner = {
    records: () => structuredClone(records),
    stopJob: async (jobId: string) => {
      stopped.push(jobId)
      const found = records.find(record => record.spec.id === jobId)
      if (!found) throw new Error('unknown job')
      return structuredClone(found)
    }
  }
  const deps: CardDeps = { store, account, mainCompany: options.mainCompany ?? 'claude', runner }
  return { base, root, store, deps, records, stopped, accountIds }
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

// ③ §3-2 [이번만] — 승인 배치를 덮지 않고 다음 학생 차례에 묶인다.
test('card: [이번만] keeps the approved plan and binds the run to the next student turn', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'once')
  expect(decision.outcome).toBe('applied')
  expect(decision.card.state).toEqual({ kind: 'applied', scope: 'once' })
  expect(decision.boundTurn).toBe('next-student-turn')
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.temporary(f.root)).toMatchObject({ boundTurn: 'next-student-turn' })

  const body = await snapshot(f)
  expect(body.settings.mode).toBe('undecided')
  expect(body.settings.temporary).toEqual([
    { lane: 'writing', entry: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' } }
  ])
  // [이번만]도 요금 동의는 남긴다(§3-2 "동의는 [계속]·[이번만] 모두 남는다").
  expect(f.store.consent('claude', 'claude-account')).toMatchObject({ state: 'agreed' })
})

// ④ §3-5 옛 판 — 만든 뒤 배치 판이 바뀌면 적용하지 않고 무효로 접는다.
test('card: a stale baseVersion is refused and the card closes as invalid', async () => {
  const f = setup()
  const opened = await openCard(f.deps, f.root, writingToClaude)
  f.store.bumpVersion(f.root)
  const decision = await decideCard(f.deps, f.root, opened.cardId, opened.baseVersion, 'continue')
  expect(decision.outcome).toBe('invalid')
  expect(decision.reason).toBe('base-version')
  expect(decision.card.state).toEqual({ kind: 'invalid' })
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
  expect(decision.card.state).toEqual({ kind: 'invalid' })
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

  // [이번만]으로는 본대화 소유를 옮길 수 없다.
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
  expect(decision.card.state).toEqual({ kind: 'invalid' })
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
  expect(decision.card.state).toEqual({ kind: 'invalid' })
  expect(f.store.approvedPlan(f.root)).toBeNull()
})

// ⑭ §5 [나눠 맡기기 끄기] — 그 폴더의 진행·대기 주문만 멈추고 승인·[이번만]을 접는다.
test('card: disable stops only this folder\'s live jobs and revokes the plan', async () => {
  const f = setup()
  const approved = await openCard(f.deps, f.root, writingToClaude)
  await decideCard(f.deps, f.root, approved.cardId, approved.baseVersion, 'once')
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
