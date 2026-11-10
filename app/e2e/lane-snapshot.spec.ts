// 배선 C §6 — main 이 상태 묶음을 **통째로** 짓는다. 실제 AI 호출 0회: 러너는 기록만
// 돌려주는 스텁이고, 저장소는 진짜 `JobStore`(임시 폴더)다. 계약: `LanesSnapshot`.
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore, type StoredConsent } from '../src/main/chat/jobs/store'
import type { ContinuationProposal, JobRecord, JobSpec } from '../src/main/chat/jobs/types'
import {
  LanesPublisher, assembleLanes, consentRows, lanesLines, lanesSettings, maskAccount,
  type LaneAccountView, type LaneInput, type LaneRunnerView
} from '../src/main/lanes/snapshot'
import { laneInput, lanesPublisher, recommendedRow, type LaneSource } from '../src/main/lanes/source'
import { canonical } from '../src/main/chat/jobs/isolation'
import type { ExecutionAccount } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow, resolveLanes } from '../src/shared/lanes'

function fixture() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-lanes-')))
  const root = join(base, 'thesis')
  const store = new JobStore(join(base, 'jobs'))
  return { base, root, store }
}

function record(root: string, id: string, status: JobRecord['status'], patch: Partial<JobRecord> = {}): JobRecord {
  const plan = planFromRow('both-high')
  const spec: JobSpec = {
    schema: 1, id, lane: 'research', task: '자료를 읽고 결과를 쓴다',
    inputs: [], outputs: ['result.md'], contractVersion: 'role-v1',
    company: plan.research!.company, model: plan.research!.model!, effort: plan.research!.effort
  }
  return {
    spec, rootJobId: id, root, owner: { id: `codex\0${root}`, sessionId: 'main-session', company: 'codex' },
    authorSessionId: 'author', status, contentHash: 'h', outputs: [],
    createdAt: '2026-11-09T00:00:00.000Z', ...patch
  }
}

/** 러너 읽기 이음매 그대로 — 기록·열린 제안만 돌려준다. */
function runnerStub(records: JobRecord[], proposals: ContinuationProposal[] = []): LaneRunnerView {
  return { records: () => structuredClone(records), proposals: () => structuredClone(proposals) }
}

function proposal(record: JobRecord, entry: ContinuationProposal['entry']): ContinuationProposal {
  return {
    proposalId: 'proposal-1', rootJobId: record.rootJobId, parentJobId: record.spec.id, newJobId: 'job-next',
    entry, accountId: 'claude-account', accountFingerprint: 'f', contentHash: 'h',
    state: 'open', shownAt: '2026-11-09T00:01:00.000Z'
  }
}

const accounts: Partial<Record<Provider, LaneAccountView>> = {
  claude: {
    connected: true, consented: true, usage: 'allowed', accountId: 'claude-account',
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max',
      models: ['opus', 'sonnet', 'haiku'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
  },
  codex: {
    connected: true, consented: true, usage: 'allowed', accountId: 'codex-account',
    account: { company: 'codex', accountType: 'chatgpt',
      models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
  }
}

function input(f: ReturnType<typeof fixture>, records: JobRecord[], patch: Partial<LaneInput> = {}): LaneInput {
  return {
    root: f.root, store: f.store, runner: runnerStub(records), settings: lanesSettings({
      root: f.root, store: f.store, mainCompany: 'codex', accounts, recommended: null
    }),
    accounts, ...patch
  }
}

const kinds = (lines: { kind: string }[]) => lines.map(line => line.kind)

// ① §2-1 상태 → 줄. 실행 중·대기·실패·폴더 변경은 종류가 다르고, 다 들어간 주문은 줄이 없다.
test('job status maps to exactly one line kind, and delivered jobs leave no line', () => {
  const f = fixture()
  const ids: Record<string, string> = {
    queued: 'j-queued', running: 'j-running', auth: 'j-auth', unknown: 'j-unknown',
    interrupted: 'j-interrupted', stopped: 'j-stopped', violation: 'j-violation',
    rejected: 'j-rejected', error: 'j-error'
  }
  const records = Object.entries(ids).map(([status, id]) => record(f.root, id, status as JobRecord['status']))
  // 진행 중인 주문만 `startedAt` 이 있다 — 대기 줄은 없다(계약 `progress.startedAt`).
  records.find(r => r.spec.id === 'j-running')!.startedAt = '2026-11-09T00:02:00.000Z'
  const lines = lanesLines(input(f, records))
  const byId = new Map(lines.map(line => [(line as { jobId?: string }).jobId, line]))
  expect(byId.get('j-queued')).toMatchObject({ kind: 'progress', phase: 'queued', startedAt: null })
  expect(byId.get('j-running')).toMatchObject({ kind: 'progress', phase: 'running', startedAt: '2026-11-09T00:02:00.000Z' })
  expect(byId.get('j-auth')!.kind).toBe('auth')
  expect(byId.get('j-unknown')!.kind).toBe('usage-unknown')
  expect(byId.get('j-interrupted')!.kind).toBe('interrupted')
  expect(byId.get('j-stopped')!.kind).toBe('stopped')
  // §8-5 — 주체를 단정하지 않는 종류 1 막힘.
  expect(byId.get('j-violation')).toMatchObject({ kind: 'folder-changed', tier: 1 })
  expect(byId.get('j-rejected')!.kind).toBe('failed')
  expect(byId.get('j-error')!.kind).toBe('failed')

  // 전달이 끝난(`done`) 주문은 줄도 없다. 전달 기록이 없으면 "넘기는 중"이다.
  const completed = record(f.root, 'j-done', 'completed')
  const pending = record(f.root, 'j-pending', 'completed')
  f.store.beginDelivery('j-done', f.root, 'owner')
  f.store.finishDelivery('j-done')
  const after = lanesLines(input(f, [completed, pending]))
  expect(after.map(line => (line as { jobId?: string }).jobId)).toEqual(['j-pending'])
  expect(after[0].kind).toBe('delivering')
})

// ② 한도 — 열린 제안이 있으면 [이어 받기] 줄, 없고 전달도 없으면 사유 있는 막힘 줄.
test('limit offers a continuation only while a proposal is open and otherwise blocks with a reason', () => {
  const f = fixture()
  const limited = record(f.root, 'j-limit', 'limit', { spec: { ...record(f.root, 'x', 'limit').spec, effort: 'high' } })
  const open = proposal(limited, { company: 'claude', model: 'opus', effort: null, how: 'relay' })
  const offer = lanesLines(input(f, [limited], { runner: runnerStub([limited], [open]) }))
  expect(offer).toHaveLength(1)
  expect(offer[0]).toMatchObject({
    kind: 'limit-offer', proposalId: 'proposal-1',
    to: { company: 'claude', model: 'opus', effort: null },
    // 깊이가 high → 계정 기본(null)로 내렸다.
    effortLowered: true, resetAt: null
  })

  // 제안도 전달도 없음 — 사유는 지금 계정 상태로만 판정한다.
  const blocked = (patch: Partial<Record<Provider, LaneAccountView>>) => {
    const lines = lanesLines(input(f, [limited], {
      runner: runnerStub([limited]), accounts: patch
    }))
    return lines[0]
  }
  expect(blocked({})).toMatchObject({ kind: 'limit-blocked', other: 'claude', reason: 'not-logged-in' })
  expect(blocked({ claude: { ...accounts.claude!, consented: false } }))
    .toMatchObject({ kind: 'limit-blocked', reason: 'no-consent' })
  expect(blocked({ claude: { ...accounts.claude!, usage: 'limit' } }))
    .toMatchObject({ kind: 'limit-blocked', reason: 'also-unavailable' })
  expect(blocked({ claude: { ...accounts.claude!, account: { company: 'claude', apiKeySource: 'ANTHROPIC', subscriptionType: 'max', models: [] } } }))
    .toMatchObject({ kind: 'limit-blocked', reason: 'model-missing' })

  // 전달이 확실히 실패했으면 막힘 줄이 아니라 [다시 넘기기] 갈래다.
  f.store.beginDelivery('j-limit', f.root, 'owner')
  f.store.markFailed('j-limit', f.root, 'owner')
  expect(lanesLines(input(f, [limited], { runner: runnerStub([limited]) }))[0].kind).toBe('deliver-failed')
})

// ③ 정렬·✕ — 종류 1→5, 같은 종류는 먼저 생긴 것. 닫은 줄은 ✕ 있는 줄만 사라진다.
test('lines sort by tier then time and only dismissible lines can be closed', () => {
  const f = fixture()
  const late = record(f.root, 'j-late', 'stopped', { createdAt: '2026-11-09T02:00:00.000Z' })
  const early = record(f.root, 'j-early', 'stopped', { createdAt: '2026-11-09T01:00:00.000Z' })
  const blocked = record(f.root, 'j-blocked', 'violation', { createdAt: '2026-11-09T03:00:00.000Z' })
  f.store.dismiss(f.root, 'job:j-early:stopped')
  // ✕ 없는 진행 줄을 닫아도 사라지지 않는다.
  const running = record(f.root, 'j-running', 'running')
  f.store.dismiss(f.root, 'job:j-running:progress')

  const lines = lanesLines(input(f, [late, early, blocked, running]))
  expect(lines.map(line => line.id)).toEqual([
    'job:j-blocked:folder-changed', 'job:j-running:progress', 'job:j-late:stopped'
  ])
  expect(lines[1].dismissible).toBe(false)
  expect(lines[2].dismissible).toBe(true)
})

// ④ 카드 — 열린 설정 카드는 대화에 넣지 않고, 앱 전용 결박(`boundAccounts`)은 화면으로 나가지 않는다.
test('open cards become pending lines except settings cards, and bound accounts never leave main', () => {
  const f = fixture()
  const card = (cardId: string, variant: 'first' | 'settings-enable') => ({
    cardId, root: f.root, variant, baseVersion: 0, createdAt: '2026-11-09T00:00:00.000Z',
    reviewDue: false, quote: null, rows: [], fees: [], fastDrain: false,
    recommendedDesign: null, state: { kind: 'open' as const }
  })
  f.store.addCard(card('card-1', 'first'), { claude: 'claude-account' })
  f.store.addCard(card('card-2', 'settings-enable'), { codex: 'codex-account' })

  const body = assembleLanes(input(f, []))
  expect(body.lines.map(line => line.id)).toEqual(['card:card-1'])
  expect(body.lines[0]).toMatchObject({ kind: 'card-pending', tier: 5, dismissible: false })
  expect(body.cards.map(shown => shown.cardId)).toEqual(['card-1'])
  expect(JSON.stringify(body.cards)).not.toContain('boundAccounts')
  // 카드 쪽에는 계정 id 가 없다 — 요금 줄의 가린 표시만 있다(계약 `FeeNotice.accountLabel`).
  expect(JSON.stringify(body.cards)).not.toContain('claude-account')

  // 입력칸 ■ 는 진행 줄이 있을 때만 "대화와 담당 함께 멈추기"다.
  expect(body.stopButton).toBe('chat')
  const running = record(f.root, 'j-running', 'running')
  expect(assembleLanes(input(f, [running])).stopButton).toBe('chat-and-lanes')
})

// ⑤ 낭독 — 같은 상태를 다시 지어도 `seq` 만 오르고, 새 진행 줄이 생길 때만 낭독이 바뀐다.
test('publisher raises seq without re-announcing unchanged lines and announces a new start once', () => {
  const f = fixture()
  const sent: { seq: number; announcement: { kind: string; lineId: string | null } | null }[] = []
  const publisher = new LanesPublisher(snapshot => sent.push(snapshot))
  const running = record(f.root, 'j-running', 'running')
  running.startedAt = '2026-11-09T00:02:00.000Z'

  const first = publisher.publish(input(f, [running]))
  expect(first.seq).toBe(1)
  expect(first.announcement).toBeNull()
  const second = publisher.publish(input(f, [running]))
  expect(second.seq).toBe(2)
  expect(second.announcement).toBeNull()

  const queued = record(f.root, 'j-queued', 'queued', { createdAt: '2026-11-09T00:03:00.000Z' })
  const third = publisher.publish(input(f, [running, queued]))
  // 대기 줄은 "시작" 낭독이 아니다 — 새 줄 종류 낭독.
  expect(third.announcement).toMatchObject({ seq: 3, kind: 'line', lineId: 'job:j-queued:progress' })

  const fourth = publisher.publish(input(f, [running, queued]))
  expect(fourth.seq).toBe(4)
  expect(fourth.announcement).toEqual(third.announcement)
})

// ⑥ 계정 표시 — 원문 계정 id 는 화면으로 나가지 않는다.
test('account labels never carry the raw account id', () => {
  // 앞 6글자만 남긴다 — 원문 id 전체는 어떤 경우에도 나가지 않는다.
  expect(maskAccount('claude-account')).toBe('claude…')
  expect(maskAccount('a@b.c')).toBe('…')
  expect(maskAccount('claude-account')).not.toContain('account')

  const stored: StoredConsent[] = [
    { company: 'claude', accountId: 'claude-account', state: 'agreed', at: '2026-11-09T00:00:00.000Z' },
    // 지금 로그인하지 않은 계정 — 거둔 기록은 남는다.
    { company: 'codex', accountId: 'codex-old', state: 'withdrawn', at: null }
  ]
  const rows = consentRows(accounts, stored)
  expect(rows).toEqual([
    { company: 'claude', accountId: 'claude-account', accountLabel: 'claude…', state: 'agreed', at: '2026-11-09T00:00:00.000Z', subscribed: true },
    { company: 'codex', accountId: 'codex-account', accountLabel: 'codex-…', state: 'agreed', at: null, subscribed: true },
    { company: 'codex', accountId: 'codex-old', accountLabel: 'codex-…', state: 'withdrawn', at: null, subscribed: false }
  ])
})

// ⑦ §5 설정 — 승인 있음 `on`, 끈 기록 있음 `off`, 없으면 `undecided`, 폴더 없으면 `null`.
test('settings mode and source derive from the approval record, never from a new settings key', () => {
  const f = fixture()
  // 실제 이음매(`source.ts` `recommend`)와 같은 경로 — 설계 차선은 본대화 회사로 고정된다.
  const catalog = { claude: accounts.claude!.account.models, codex: accounts.codex!.account.models }
  const resolved = resolveLanes('both-high', { mainCompany: 'codex', catalog })
  const recommended = { rowId: 'both-high' as const, plan: resolved.plan, notes: resolved.notes }
  const view = () => lanesSettings({ root: f.root, store: f.store, mainCompany: 'codex', accounts, recommended })

  // 아직 안 정함 — 추천 줄을 미리 보여 준다(§5 F1). 승인 기록이 없으므로 `source` 는 none.
  expect(view()).toMatchObject({ mode: 'undecided', source: { kind: 'none' }, differsFromRecommendation: false })
  expect(view().rows.map(row => row.lane)).toEqual(['research', 'writing', 'repeat', 'review'])

  // 카드는 승인할 때 **해석된** 배치를 저장한다(`resolveLanes` 결과) — 차선표 원본이 아니다.
  f.store.approve(f.root, resolved.plan)
  const approved = view()
  expect(approved.mode).toBe('on')
  expect(approved.source).toEqual({ kind: 'recommended', rowId: 'both-high' })
  expect(approved.differsFromRecommendation).toBe(false)
  expect(approved.rows.map(row => row.lane)).toEqual(['research', 'writing', 'repeat', 'review'])
  // 설계는 본대화(codex)가 맡는다. 차선표의 설계 모델은 claude/opus 라 회사가 다르다 —
  // 지금 로그인한 codex 계정에서 무엇을 추천할지는 알 수 없으므로 null(문구에서 뺀다).
  expect(approved.recommendedDesign).toBeNull()

  // 본대화가 claude 면 차선표의 설계 모델이 그대로 추천이 된다(승인 전 폴더).
  const fresh = fixture()
  const claudeMain = resolveLanes('both-high', { mainCompany: 'claude', catalog })
  expect(lanesSettings({
    root: fresh.root, store: fresh.store, mainCompany: 'claude', accounts,
    recommended: { rowId: 'both-high', plan: claudeMain.plan, notes: claudeMain.notes }
  }).recommendedDesign).toEqual({ company: 'claude', model: 'opus', effort: null })

  // 추천이 바뀐 뒤 — 승인은 그대로지만 "내가 정함"으로 보인다.
  const changed = lanesSettings({
    root: f.root, store: f.store, mainCompany: 'codex', accounts,
    recommended: { rowId: 'both-low', plan: planFromRow('both-low'), notes: [] }
  })
  expect(changed.source).toEqual({ kind: 'mine', at: f.store.approvedAt(f.root) })
  expect(changed.differsFromRecommendation).toBe(true)

  f.store.addEvent(f.root, { id: 'e1', at: '2026-11-09T00:00:00.000Z', kind: 'lanes-declined' })
  f.store.revokePlan(f.root)
  const off = view()
  expect(off.mode).toBe('off')
  expect(off.rows).toEqual([])
  expect(off.source).toEqual({ kind: 'none' })

  expect(lanesSettings({ root: null, store: f.store, mainCompany: 'codex', accounts, recommended }).mode).toBeNull()
})

// ⑧ 서비스 이음매 — 계정 두 회사로 추천 줄을 고르고, 폴더 없이도 요금 동의 줄은 보인다.
test('laneInput reads accounts through the source and publishes the assembled snapshot', async () => {
  const f = fixture()
  const execution = (company: Provider): ExecutionAccount => ({
    accountId: `${company}-account`, connected: true, usage: 'allowed', consented: true,
    account: accounts[company]!.account
  })
  const source: LaneSource = {
    store: f.store, runner: runnerStub([]), mainCompany: 'codex',
    account: async company => execution(company)
  }
  const sent: number[] = []
  const hub = lanesPublisher(source, snapshot => sent.push(snapshot.seq))

  const snapshot = await hub.publish(f.root)
  expect(snapshot.root).toBe(f.root)
  expect(snapshot.seq).toBe(1)
  expect(sent).toEqual([1])
  // 추천 줄은 요금제에서 파생한다 — 승인 전이므로 `undecided` + 추천 줄 미리보기.
  expect(snapshot.settings.mode).toBe('undecided')
  expect(snapshot.settings.rows.map(row => row.entry?.model)).toEqual(['astra', 'sol', 'terra', 'astra'])
  expect(snapshot.settings.consents.map(row => row.accountId)).toEqual(['claude-account', 'codex-account'])
  expect(snapshot.stopButton).toBe('chat')

  // 폴더가 없으면 모드는 `null` 이지만 요금 동의는 그대로 보인다.
  const global = await laneInput(source, null)
  expect(global.settings.mode).toBeNull()
  expect(global.settings.consents).toHaveLength(2)
  expect(global.root).toBeNull()

  expect(recommendedRow({ claude: execution('claude'), codex: execution('codex') })).toBe('both-high')
  expect(recommendedRow({})).toBeNull()
})
