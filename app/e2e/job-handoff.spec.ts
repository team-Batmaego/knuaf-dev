import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHandoffBundle, ConversationHandoff, type HandoffOpenResult, type HandoffSource } from '../src/main/chat/jobs/conversation'
import { sha256 } from '../src/main/chat/jobs/isolation'
import { planFromRow } from '../src/shared/lanes'
import type { ConversationOwner, ExecutionAccount } from '../src/main/chat/jobs/types'

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'knuaf-handoff-'))
  const account: ExecutionAccount = { connected: true, consented: false, usage: 'allowed', accountId: 'codex-subscription',
    account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'gpt-6.1-sol', name: 'Sol', efforts: ['high'] }] } }
  const source: HandoffSource = {
    rootConversationId: 'root', owner: { id: 'old', sessionId: 'old-session', company: 'claude' }, root: '/thesis',
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'main' }, reason: 'limit',
    students: [{ text: 'earliest student', attachments: [{ name: 'source.pdf', hash: 'attachment-hash' }] }, { text: 'latest student', attachments: [] }],
    lastAssistant: { text: 'last AI response', interrupted: true }, beforeHashes: { 'project.json': 'before', removed: 'old' },
    afterHashes: { 'project.json': 'after', added: 'new' }, approvedPlan: planFromRow('both-high'),
    jobs: [{ id: 'running-job', status: 'running', delivered: false }, { id: 'old-job', status: 'completed', delivered: true }],
    skillVersion: 'skill-v1', sourceLocation: '/private/old-chat.json'
  }
  const opened: { id: string; firstMessage: string }[] = [], activated: object[] = [], transfers: object[] = [], audits: object[] = []
  const closed: ConversationOwner[] = []
  /** 두 자리의 읽기 횟수 — "제안은 1회, 클릭은 누를 때마다"를 이 수로 잠근다(I-01). */
  const reads = { propose: 0, click: 0 }
  let readPropose = async () => structuredClone(account)
  let readClick = async () => structuredClone(account)
  const options = {
    stateDir, maxBytes: 10_000,
    // 제안 판정과 클릭 판정은 **다른 자리**다 — 같은 함수를 쓰면 한쪽 상한이 다른 쪽 값을 굳힌다.
    account: {
      propose: async () => { reads.propose += 1; return readPropose() },
      click: async () => { reads.click += 1; return readClick() }
    },
    // §1-4 ② — 인계는 **첫 턴이 성공으로 끝난 뒤에만** 성립한다. 대역도 그 계약을 지킨다.
    open: async (request: { id: string; firstMessage: string }): Promise<HandoffOpenResult> => {
      opened.push(request)
      return { id: request.id, sessionId: 'new-session', company: 'codex', firstTurn: 'ok' }
    },
    close: async (owner: ConversationOwner) => { closed.push(owner) },
    // §1-4 ① — 연결이 "첫 턴 안 확인"을 선언했는지. 시험마다 켠다.
    gateInTurn: undefined as ((company: 'claude' | 'codex') => boolean) | undefined,
    prepareActivation: async (oldOwner: ConversationOwner, newOwner: ConversationOwner) => () => { activated.push({ oldOwner, newOwner }) },
    beginTransition: (root: string) => ({
      ready: async () => {},
      commit: (owner: ConversationOwner, activate: () => void) => { activate(); transfers.push({ root, owner }); return true },
      cancel: () => {}, flush: async () => {}
    }), audit: (record: object) => { audits.push(record) }
  }
  return { source, account, options, opened, activated, transfers, audits, closed, reads,
    handoff: new ConversationHandoff(options),
    readPropose: (fn: typeof readPropose) => { readPropose = fn },
    readClick: (fn: typeof readClick) => { readClick = fn } }
}

test('main confirmed limit proposes design model without relay consent, opens one fresh packet and transfers jobs', async () => {
  const f = fixture(), originalPlan = structuredClone(f.source.approvedPlan)
  const p = (await f.handoff.propose(f.source))!
  expect(p.entry).toEqual({ company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' })
  const bundle = JSON.parse(readFileSync(p.bundlePath, 'utf8'))
  expect(bundle.students).toEqual(f.source.students)
  expect(bundle.lastAssistant).toEqual({ text: 'last AI response', interrupted: true })
  expect(bundle.changedFiles).toEqual([{ path: 'added', before: null, after: 'new' }, { path: 'project.json', before: 'before', after: 'after' }, { path: 'removed', before: 'old', after: null }])
  expect(bundle.jobs).toEqual(f.source.jobs); expect(bundle.skillVersion).toBe('skill-v1')
  const results = await Promise.all([f.handoff.continue(p.proposalId), f.handoff.continue(p.proposalId)])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(f.opened).toHaveLength(1); expect(f.activated).toHaveLength(1)
  expect(f.transfers).toEqual([{ root: '/thesis', owner: results.find(Boolean) }])
  expect(f.source.approvedPlan).toEqual(originalPlan)
  expect(f.audits).toMatchObject([{ reason: 'limit', bundleHash: p.bundleHash, newConversationId: p.newConversationId }])
  expect(f.opened[0].firstMessage).toContain('자동 재전송하거나 이미 한 작업을 반복하지 말고')
})

for (const reason of ['unknown', 'auth'] as const) test(`main ${reason} never offers continuation`, async () => {
  const f = fixture(); f.source.reason = reason
  expect(await f.handoff.propose(f.source)).toBeNull(); expect(f.opened).toEqual([])
})

test('mechanical packet shrinks in documented order, keeps the last student message, and keeps full archive reference', () => {
  const f = fixture()
  f.source.students[0].text = 'OLD'.repeat(5000)
  f.source.students[1].text = 'NEW'
  f.source.lastAssistant!.text = 'BEGIN' + 'middle'.repeat(3000) + 'END'
  const bundle = buildHandoffBundle(f.source, '/private/archive.json', 1600)!
  expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(1600)
  // 오래된 학생 글만 빠지고 마지막 한 건은 남는다 — 0건 묶음은 인계가 아니다.
  expect(bundle.students).toEqual([{ text: 'NEW', attachments: [] }])
  expect(bundle.truncated).toEqual(['students', 'lastAssistant'])
  expect(bundle.lastAssistant!.text.startsWith('BEGIN')).toBe(true)
  expect(bundle.lastAssistant!.text.endsWith('END')).toBe(true)
  expect(bundle.lastAssistant!.interrupted).toBe(true)
  expect(bundle.archive).toBe('/private/archive.json'); expect(bundle.sourceLocation).toBe('/private/old-chat.json'); expect(bundle.skillVersion).toBe('skill-v1')
  expect(buildHandoffBundle(f.source, '/private/archive.json', 50)).toBeNull()
})

test('a packet with zero student messages is never a successful handoff', () => {
  const f = fixture()
  f.source.students = []
  expect(buildHandoffBundle(f.source, '/private/archive.json', 10_000)).toBeNull()
})

test('oversize packet offers [새 대화로 시작] instead of continuation; full archive remains', async () => {
  const f = fixture(); f.options.maxBytes = 10
  const p = (await f.handoff.propose(f.source))!
  expect(p.tooLong).toBe(true)
  expect(p.bundlePath).toBeNull(); expect(p.bundleHash).toBeNull()
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  expect(f.opened).toEqual([])
})

test('account change invalidates displayed choice and refreshes; packet modification blocks opening', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  f.account.accountId = 'replacement'
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  const replacement = f.handoff.proposals()[0]
  expect(replacement.accountId).toBe('replacement'); expect(f.opened).toEqual([])
  writeFileSync(replacement.bundlePath!, 'changed')
  await expect(f.handoff.continue(replacement.proposalId)).rejects.toThrow('묶음이 바뀌었어요')
  expect(f.opened).toEqual([])
})

test('later/stop/switch and restart invalidate stale clicks and in-flight lookup', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  const { promise, resolve } = Promise.withResolvers<ExecutionAccount>()
  f.readClick(() => promise)
  const click = f.handoff.continue(p.proposalId); f.handoff.invalidate('root'); resolve(f.account)
  expect(await click).toBeNull(); expect(f.opened).toEqual([])
  f.readClick(async () => structuredClone(f.account))
  const next = (await f.handoff.propose(f.source))!
  const restarted = new ConversationHandoff(f.options)
  expect(await restarted.continue(next.proposalId)).toBeNull(); expect(restarted.proposals()).toEqual([])
})

test('unsupported depth resets explicitly to default and auth or API path cannot continue', async () => {
  const f = fixture(); f.source.entry.effort = 'ultra'
  expect((await f.handoff.propose(f.source))!.entry.effort).toBeNull()
  const g = fixture(); g.account.account = { company: 'codex', accountType: 'apiKey', models: g.account.account.models }
  expect(await g.handoff.propose(g.source)).toBeNull()
})

// §0-5 2 — 인계는 **대상 첫 턴이 성공으로 끝난 뒤에만** 성립한다. 대역이 `limit` 을 돌려주면
// 소유를 넘기지 않고(전환 commit 0) 시도한 새 세션을 접으며, 사유는 `target-limit` 이다.
test('handoff: 대상 allowed 뒤 결과 limit이면 commit 0', async () => {
  const f = fixture()
  f.options.open = async (request: { id: string }): Promise<HandoffOpenResult> =>
    ({ id: request.id, sessionId: 'new-session', company: 'codex', firstTurn: 'limit' })
  const p = (await f.handoff.propose(f.source))!
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  expect(f.opened).toHaveLength(0); expect(f.activated).toEqual([])
  expect(f.transfers).toEqual([]); expect(f.audits).toEqual([])
  expect(f.handoff.proposals()).toEqual([])
  expect(f.handoff.visible()).toMatchObject([{ state: 'failed', failedReason: 'target-limit' }])
  // 넘기지 못한 새 대화는 접는다 — 0 이면 세션이 그 폴더의 대화인 척 남는다.
  expect(f.closed).toHaveLength(1)
})

// §0-5 2 — 첫 사건이 거절이면 같은 결과이고, 그 대상 모델로는 **다시 제안하지 않는다**(`attempts`).
test('handoff: 대상 첫 사건 rejected', async () => {
  const f = fixture()
  f.options.open = async (request: { id: string }): Promise<HandoffOpenResult> =>
    ({ id: request.id, sessionId: 'new-session', company: 'codex', firstTurn: 'limit' })
  const p = (await f.handoff.propose(f.source))!
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  expect(f.transfers).toEqual([]); expect(f.closed).toHaveLength(1)
  expect(f.handoff.visible()).toMatchObject([{ state: 'failed', failedReason: 'target-limit' }])
  // 이미 시도한 `codex:gpt-6.1-sol` 은 새 제안이 되지 않는다.
  expect(await f.handoff.propose(f.source)).toBeNull()
  expect(f.handoff.proposals()).toEqual([])
  expect(f.handoff.visible()).toHaveLength(1)
})

// §0-5 2 — 넘기는 도중 무효화되면 늦게 도착한 세션은 버린다(늦은 콜백이 소유를 뒤집지 않는다).
test('handoff: 늦은 콜백 무시', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  const { promise, resolve } = Promise.withResolvers<HandoffOpenResult>()
  f.options.open = () => promise
  const click = f.handoff.continue(p.proposalId)
  await new Promise(resolve => setTimeout(resolve, 10))
  f.handoff.invalidate('root')
  resolve({ id: p.newConversationId, sessionId: 'late-session', company: 'codex', firstTurn: 'ok' })
  expect(await click).toBeNull()
  expect(f.transfers).toEqual([]); expect(f.activated).toEqual([]); expect(f.audits).toEqual([])
  expect(f.handoff.visible()).toEqual([])
})

// §0-5 2 — 첫 턴이 성공하면 한 번만 넘긴다.
test('handoff: 대상 성공 → commit 1', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  const owner = await f.handoff.continue(p.proposalId)
  expect(owner).toMatchObject({ id: p.newConversationId, sessionId: 'new-session', company: 'codex' })
  expect(f.opened).toHaveLength(1); expect(f.activated).toHaveLength(1)
  expect(f.transfers).toHaveLength(1); expect(f.audits).toHaveLength(1)
  expect(f.handoff.visible()).toEqual([]); expect(f.closed).toEqual([])
})

// §0-5 2 — 누른 뒤 계정이 바뀌면 지문이 어긋나므로 아무것도 넘기지 않는다.
test('handoff: 클릭 때 지문 다르면 0', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  f.account.accountId = 'replacement'
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  expect(f.opened).toEqual([]); expect(f.transfers).toEqual([]); expect(f.closed).toEqual([])
  // 제안은 접히고 같은 폴더의 새 제안이 선다(계정이 바뀌었으니 새로 고른다).
  expect(f.handoff.proposals()).toMatchObject([{ accountId: 'replacement' }])
})

// §1-4 ① — 제안 판정과 클릭 판정은 **다른 자리**다. 같은 세대 안에서 계정이 바뀌면 제안 시점
// 값은 그대로여도 클릭은 새로 읽은 값으로 지문을 대조해야 한다(REVIEW-C4 I-01).
test('handoff: 클릭은 누를 때마다 새로 읽고 같은 세대 계정 교체를 잡는다', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  expect(f.reads).toEqual({ propose: 1, click: 0 })
  const replacement: ExecutionAccount = { ...structuredClone(f.account), accountId: 'replacement' }
  // 제안 시점 값은 옛 계정 그대로 — 클릭만 새 계정을 본다.
  f.readClick(async () => structuredClone(replacement))
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  expect(f.opened).toEqual([]); expect(f.transfers).toEqual([]); expect(f.closed).toEqual([])
  // 누를 때 정확히 1회, 제안 자리는 다시 태우지 않는다.
  expect(f.reads).toEqual({ propose: 1, click: 1 })
  // 새로 열린 제안은 **클릭 때 읽은 값**으로 지어진다 — 옛 지문을 되살리면 새 단추도 같은 이유로 실패한다.
  const refreshed = f.handoff.proposals()[0]
  expect(refreshed).toMatchObject({ state: 'open', accountId: 'replacement' })
  expect(refreshed.accountFingerprint).toBe(sha256(JSON.stringify(replacement)))
  expect(f.reads.propose).toBe(1)
  // 그 단추는 실제로 눌린다 — 새 제안의 지문이 클릭 값과 같기 때문이다.
  expect(await f.handoff.continue(refreshed.proposalId)).toMatchObject({ company: 'codex' })
  expect(f.reads).toEqual({ propose: 1, click: 2 })
})

// §1-4 ① — 누를 때마다 1회. 두 제안을 각각 누르면 클릭 읽기는 2회이고, 그 사이 상한 자리는 늘지 않는다.
test('handoff: 두 번 누르면 클릭 읽기도 두 번', async () => {
  const f = fixture()
  const second = structuredClone(f.source)
  second.rootConversationId = 'root-b'; second.root = '/thesis-b'
  second.owner = { id: 'old-b', sessionId: 'old-session-b', company: 'claude' }
  const [a, b] = [(await f.handoff.propose(f.source))!, (await f.handoff.propose(second))!]
  expect(f.reads).toEqual({ propose: 2, click: 0 })
  expect(await f.handoff.continue(a.proposalId)).not.toBeNull()
  expect(await f.handoff.continue(b.proposalId)).not.toBeNull()
  expect(f.reads).toEqual({ propose: 2, click: 2 })
  expect(f.opened).toHaveLength(2); expect(f.transfers).toHaveLength(2)
})

// §0-5 2 — `usage:'unknown'` 은 연결이 첫 턴 안 확인을 선언했을 때만 Claude 대상 단추를 연다.
test('handoff: gateInTurn 없으면 Claude 대상 단추 0', async () => {
  const f = fixture()
  f.source.entry = { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' }
  f.account.accountId = 'claude-subscription'
  f.account.usage = 'unknown'
  f.account.account = { company: 'claude', subscriptionType: 'max', apiKeySource: 'none',
    models: [{ model: 'opus', name: 'Opus', efforts: ['high'] }] }
  expect(await f.handoff.propose(f.source)).toBeNull()
  f.options.gateInTurn = company => company === 'claude'
  expect(await f.handoff.propose(f.source)).toMatchObject({
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'main' }
  })
})

// §1-4 ① — 제안이 연 단추는 **같은 판정**으로 눌러야 열린다. `unknown`+첫 턴 확인으로 띄운
// Claude 단추를 클릭에서 `allowed` 만 보면 아예 열리지 않는다(REVIEW-C4 I-02).
test('handoff: gateInTurn 단추는 같은 판정으로 눌러진다', async () => {
  const f = fixture()
  f.source.entry = { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' }
  f.account.accountId = 'claude-subscription'
  f.account.usage = 'unknown'
  f.account.account = { company: 'claude', subscriptionType: 'max', apiKeySource: 'none',
    models: [{ model: 'opus', name: 'Opus', efforts: ['high'] }] }
  f.options.gateInTurn = company => company === 'claude'
  // 기본 대역 `open` 은 codex 세션을 돌려준다 — 이 인계의 대상 회사는 claude 다.
  // 기록(`opened`)도 그대로 남겨야 "첫 턴을 실제로 열었는가"를 이 시험이 잠근다.
  f.options.open = async (request: { id: string; firstMessage: string }): Promise<HandoffOpenResult> => {
    f.opened.push(request)
    return { id: request.id, sessionId: 'new-session', company: 'claude', firstTurn: 'ok' }
  }
  const p = (await f.handoff.propose(f.source))!
  expect(p).toMatchObject({ entry: { company: 'claude', model: 'opus', effort: 'high' } })
  const owner = await f.handoff.continue(p.proposalId)
  expect(owner).toMatchObject({ company: 'claude', sessionId: 'new-session' })
  expect(f.opened).toHaveLength(1); expect(f.transfers).toHaveLength(1); expect(f.audits).toHaveLength(1)
  // 클릭도 새로 읽었다 — 같은 판정을 새 값으로 다시 본다.
  expect(f.reads).toEqual({ propose: 1, click: 1 })
})

// §1-4 ① — 선언이 없으면(`false`) 클릭도 닫힌다. 단추가 없는데 눌린 것처럼 넘어가면 안 된다.
test('handoff: gateInTurn false 면 클릭도 닫힌다', async () => {
  const f = fixture()
  f.source.entry = { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' }
  f.account.accountId = 'claude-subscription'
  f.account.usage = 'unknown'
  f.account.account = { company: 'claude', subscriptionType: 'max', apiKeySource: 'none',
    models: [{ model: 'opus', name: 'Opus', efforts: ['high'] }] }
  f.options.gateInTurn = () => false
  expect(await f.handoff.propose(f.source)).toBeNull()
  expect(f.handoff.proposals()).toEqual([])
  expect(f.opened).toEqual([]); expect(f.reads.click).toBe(0)
})

// §0-5 2 — 기준값(beforeHashes)이 없으면 무엇이 바뀌었는지 알 수 없다 — 비우고 `truncated` 로 알린다.
test('handoff: beforeHashes 없으면 changedFiles 비움', () => {
  const f = fixture(); f.source.beforeHashes = {}
  const bundle = buildHandoffBundle(f.source, '/private/archive.json', 10_000)!
  expect(bundle.changedFiles).toEqual([]); expect(bundle.changedFileCount).toBe(0)
  expect(bundle.truncated).toEqual(['changedFiles'])
})
