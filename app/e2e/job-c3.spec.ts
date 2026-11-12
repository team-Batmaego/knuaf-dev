import { expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobRunner } from '../src/main/chat/jobs'
import { ConversationHandoff, type ConversationHandoffOptions, type HandoffSource } from '../src/main/chat/jobs/conversation'
import { writePublicFile } from '../src/main/chat/jobs/publicWrite'
import { canonical } from '../src/main/chat/jobs/isolation'
import { planFromRow, type LanePlan } from '../src/shared/lanes'
import type { ConversationOwner, ExecutionAccount, JobEvents, JobResult, JobSpec, RelayRequest } from '../src/main/chat/jobs/types'

function fixture() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'w6b-c3-'))), root = join(base, 'thesis'), stateDir = join(base, 'private')
  mkdirSync(root); writeFileSync(join(root, 'project.json'), 'ORIGINAL')
  const models = (ids: string[]) => ids.map(model => ({ model, name: model, efforts: ['high'] }))
  const accounts: Record<'claude' | 'codex', ExecutionAccount> = {
    claude: { accountId: 'c', connected: true, consented: true, usage: 'allowed', account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: models(['opus', 'sonnet', 'haiku']) } },
    codex: { accountId: 'x', connected: true, consented: true, usage: 'allowed', account: { company: 'codex', accountType: 'chatgpt', models: models(['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) } }
  }
  const owner: ConversationOwner = { id: 'old', sessionId: 'old-session', company: 'claude' }
  const deliveries: { owner: ConversationOwner; result: JobResult }[] = [], calls: string[] = []
  let plan: LanePlan | null = planFromRow('both-high')
  let account = async (company: 'claude' | 'codex') => structuredClone(accounts[company])
  let behavior = async (request: RelayRequest, events: JobEvents) => { events.session(`s-${request.jobId}`); writeFileSync(join(request.cwd, 'result.md'), 'OK') }
  let engineCalls = 0
  const runner = new JobRunner({ stateDir, approvedPlan: () => plan, account: company => account(company),
    skill: () => ({ path: '/fake', schema: 1, contractVersion: 'v1' }), supportedSchemas: [1],
    connectionFactory: request => { calls.push(request.jobId); return { relayProtocol: 1,
      status: async () => ({ installed: true, connected: true, detail: '', version: 'fake' }),
      availability: async () => structuredClone(accounts[request.company]), runJob: async (_text, events) => { engineCalls++; await behavior(request, events) },
      stop: async () => {}, respond: () => {}, login: async () => {}, run: async () => { throw Error('ordinary path') } } },
    deliver: async (target, result) => { deliveries.push({ owner: target, result }) }, stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: false })
  const spec: JobSpec = { schema: 1, id: 'job', lane: 'research', task: 'Read inputs', inputs: [], outputs: ['result.md'], contractVersion: 'v1', company: 'codex', model: 'astra', effort: null }
  spec.research = { research_type: '생산량', questions: [], routes: [], keywords: [], output_file: 'result.md' }
  return { base, root, stateDir, owner, accounts, deliveries, calls, runner,
    enqueue: () => runner.enqueue(root, spec, owner, 'author'), revoke: () => { plan = null }, engineCalls: () => engineCalls,
    account: (fn: typeof account) => { account = fn }, behavior: (fn: typeof behavior) => { behavior = fn },
    handoff: (patch: Partial<ConversationHandoffOptions> = {}) => {
      const opened: ConversationOwner[] = [], closed: ConversationOwner[] = [], activated: ConversationOwner[] = []
      const source: HandoffSource = { rootConversationId: 'root-conv', owner, root,
        entry: { company: 'claude', model: 'opus', effort: null, how: 'main' }, reason: 'limit',
        // 학생 글이 0건인 묶음은 인계가 아니다(REVIEW-C0 중요 4) — 픽스처도 한 건을 싣는다.
        students: [{ text: '앞 대화의 마지막 학생 차례', attachments: [] }], lastAssistant: null,
        beforeHashes: {}, afterHashes: {}, approvedPlan: plan, jobs: [], skillVersion: 'v1', sourceLocation: '/private/chat' }
      const options: ConversationHandoffOptions = { stateDir: join(base, 'handoff'), maxBytes: 10000,
        account: company => account(company), open: async request => { const target = { id: request.id, sessionId: `s-${request.id}`, company: request.entry.company, firstTurn: 'ok' as const }; opened.push(target); return target },
        close: async target => { closed.push(target) }, prepareActivation: async (_old, target) => () => { activated.push(target) },
        beginTransition: folder => runner.beginOwnerTransition(folder), audit: () => {}, ...patch }
      return { h: new ConversationHandoff(options), source, options, opened, closed, activated }
    }
  }
}

test('PUBLIC_TMP_ESCAPE: external bytes unchanged and unsafe public manifest rejected', () => {
  for (const attack of ['tmp', 'target', 'ancestor'] as const) {
    const f = fixture(), dir = join(f.root, '.knuaf-gui/jobs'), victim = join(f.stateDir, 'outside-sentinel')
    mkdirSync(dir, { recursive: true }); writeFileSync(victim, 'KEEP')
    if (attack === 'tmp') { writeFileSync(join(dir, 'job.json'), '{}'); symlinkSync(victim, join(dir, 'job.json.tmp')) }
    if (attack === 'target') symlinkSync(victim, join(dir, 'job.json'))
    if (attack === 'ancestor') {
      const outside = join(f.stateDir, 'outside-audit'); mkdirSync(outside)
      symlinkSync(outside, join(f.root, 'audit'))
      expect(() => writePublicFile(f.root, join(f.root, 'audit/model-routing/probe.json'), 'unsafe')).toThrow('ancestor')
    }
    if (attack !== 'ancestor') expect(() => f.enqueue()).toThrow('Unsafe public file')
    else expect(readFileSync(victim, 'utf8')).toBe('KEEP')
    expect(readFileSync(victim, 'utf8')).toBe('KEEP'); expect(f.engineCalls()).toBe(0)
  }
})

test('SWITCH_ORPHAN: consumed relay choice resolves limit exactly once to new owner', async () => {
  const f = fixture(); f.accounts.codex.usage = 'limit'; f.enqueue(); await f.runner.runQueued()
  const p = f.runner.proposals()[0], gate = Promise.withResolvers<ExecutionAccount>()
  f.account(() => gate.promise)
  const click = f.runner.continue(p.proposalId)
  await f.runner.switchOwner(f.root, { id: 'new', sessionId: 'new-session', company: 'codex' })
  gate.resolve(f.accounts.claude); expect(await click).toBeNull()
  expect(f.runner.proposals()).toEqual([]); expect(f.runner.records()).toHaveLength(1)
  expect(f.deliveries.map(d => [d.owner.id, d.result.status])).toEqual([['new', 'limit']])
})

test('REVOKED_PLAN_EXECUTES: approval revoked during lookup prevents runJob and output delivery', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.account(async company => { entered.resolve(); await release.promise; return structuredClone(f.accounts[company]) })
  f.enqueue(); const run = f.runner.runQueued(); await entered.promise; f.revoke(); release.resolve(); await run
  expect(f.engineCalls()).toBe(0); expect(f.runner.records()[0].status).toBe('rejected')
  expect(f.deliveries.map(d => d.result.outputs)).toEqual([[]])
})

test('HANDOFF_DOUBLE_RESERVATION: reproposal during consumed account check cannot open twice', async () => {
  const f = fixture(), g = f.handoff(), p = (await g.h.propose(g.source))!, gate = Promise.withResolvers<ExecutionAccount>()
  f.account(() => gate.promise)
  const first = g.h.continue(p.proposalId)
  expect(await g.h.propose(g.source)).toBeNull()
  expect(await g.h.continue(p.proposalId)).toBeNull()
  gate.resolve(f.accounts.codex); await first
  expect(g.opened).toHaveLength(1); expect(g.activated).toHaveLength(1)
})

test('HANDOFF_OLD_OWNER_DELIVERY: completion during activation preparation waits for new owner commit', async () => {
  const f = fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.behavior(async (request, events) => { events.session('relay-session'); started.resolve(); await release.promise; writeFileSync(join(request.cwd, 'result.md'), 'OK') })
  f.enqueue(); const run = f.runner.runQueued(); await started.promise
  let readOnly = false
  const g = f.handoff({ prepareActivation: async () => {
    release.resolve(); await run; expect(f.deliveries).toEqual([])
    return () => { readOnly = true }
  } })
  const p = (await g.h.propose(g.source))!, target = await g.h.continue(p.proposalId)
  expect(readOnly).toBe(true); expect(f.deliveries.map(d => d.owner.id)).toEqual([target!.id])
  expect(f.runner.records()[0].owner.id).toBe(target!.id)
})

test('SWITCH_STALE_PROPOSAL: initial relay proposal lookup cannot reopen after owner switch', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.accounts.codex.usage = 'limit'
  f.account(async company => { if (company === 'claude') { entered.resolve(); await release.promise }; return structuredClone(f.accounts[company]) })
  f.enqueue(); const run = f.runner.runQueued(); await entered.promise
  await f.runner.switchOwner(f.root, { id: 'new', sessionId: 'new-session', company: 'codex' })
  release.resolve(); await run
  expect(f.runner.proposals()).toEqual([]); expect(f.deliveries.map(d => [d.owner.id, d.result.status])).toEqual([['new', 'limit']])
})

test('INVALIDATED_OPEN_ORPHAN: abort in-flight open and close late-created session', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let live = false, signal: AbortSignal | undefined
  const g = f.handoff({ open: async request => { signal = request.signal; live = true; entered.resolve(); await release.promise; return { id: request.id, sessionId: 'late-session', company: request.entry.company } }, close: async () => { live = false } })
  const p = (await g.h.propose(g.source))!, click = g.h.continue(p.proposalId)
  await entered.promise; g.h.invalidate(g.source.rootConversationId)
  expect(signal!.aborted).toBe(true); release.resolve()
  expect(await click).toBeNull(); expect(live).toBe(false); expect(g.activated).toEqual([])
})

test('INVALIDATED_ACTIVATION_TRANSFERS: stale prepared activation cannot replace user selection', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.enqueue(); let commits = 0
  const g = f.handoff({ prepareActivation: async () => { entered.resolve(); await release.promise; return () => { commits++ } } })
  const p = (await g.h.propose(g.source))!, click = g.h.continue(p.proposalId)
  await entered.promise; g.h.invalidate(g.source.rootConversationId)
  await f.runner.switchOwner(f.root, { id: 'user-selected', sessionId: 'user-session', company: 'claude' })
  release.resolve(); expect(await click).toBeNull()
  expect(commits).toBe(0); expect(f.runner.records()[0].owner.id).toBe('user-selected'); expect(g.closed).toHaveLength(1)
})
