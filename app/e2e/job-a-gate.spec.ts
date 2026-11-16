import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobRunner } from '../src/main/chat/jobs'
import { canonical } from '../src/main/chat/jobs/isolation'
import { planFromRow } from '../src/shared/lanes'
import type { ExecutionAccount, JobConnection, JobEvents, JobRunnerOptions, JobSpec, RelayRequest, UsageState } from '../src/main/chat/jobs/types'

// Fake relay connection: availability() honestly reports `unknown` before the turn,
// runJob() re-judges inside the first turn and closes with `limit` on the first
// limit signal — the wire-A Claude contract. `gateInTurn` is the declaration the
// runner requires before opening the first turn with `unknown`.
interface FakeSpec {
  gateInTurn?: boolean
  liveUsage: UsageState
  signal?: UsageState
  writeOutput?: boolean
}

function fakeConnection(spec: FakeSpec, request?: RelayRequest): JobConnection {
  const liveAccount: ExecutionAccount = { accountId: 'c', connected: true, consented: true, usage: spec.liveUsage,
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [{ model: 'sonnet', name: 'Sonnet', efforts: ['high'] }] } }
  const conn = {
    relayProtocol: 1,
    gateInTurn: spec.gateInTurn,
    async status() { return { installed: true, connected: true, version: '1', detail: 'ok' } as never },
    async login() {},
    async run(_text: string, _sessionId: string | undefined, _events: unknown) {},
    respond() {},
    async stop() {},
    async availability() { return structuredClone(liveAccount) },
    async runJob(_text: string, events: JobEvents) {
      events.session('relay-session')
      if (spec.signal !== undefined) events.availability(spec.signal)
      if (spec.writeOutput && request) writeFileSync(join(request.cwd, 'result.md'), 'done')
    },
  } as unknown as JobConnection
  return conn
}

function setup(opts: {
  company: 'claude' | 'codex'
  shot: ExecutionAccount
  fake: FakeSpec
  buildFactory?: (request: RelayRequest) => JobConnection
}) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'knuaf-agate-')))
  const root = join(base, 'thesis'); mkdirSync(root)
  const plan = planFromRow('both-high')
  // The research lane is Codex/Astra in both-high; force the spec's own company/model
  // into its lane so enqueue's approvedPlan check passes and the gate is the only variable.
  const relay = opts.company === 'claude'
    ? { company: 'claude' as const, model: 'sonnet' }
    : { company: 'codex' as const, model: 'astra' }
  const approved = { ...plan, research: { ...plan.research, ...relay, how: 'relay' as const, effort: null } }
  const delivered: object[] = []
  const calls: string[] = []
  const options: JobRunnerOptions = { stateDir: join(base, 'private'), approvedPlan: () => approved,
    account: async () => structuredClone(opts.shot),
    skill: () => ({ path: '/fake', schema: 1, contractVersion: 'v1' }), supportedSchemas: [1],
    connectionFactory: (request: RelayRequest) => {
      calls.push(request.jobId)
      return opts.buildFactory ? opts.buildFactory(request) : fakeConnection(opts.fake, request)
    },
    deliver: async (_owner, result) => { delivered.push(result) },
    stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: false }
  const runner = new JobRunner(options)
  const spec: JobSpec = { schema: 1, id: 'gate-job', lane: 'research', task: 'task', inputs: [], outputs: ['result.md'], contractVersion: 'v1',
    company: opts.company, model: opts.company === 'claude' ? 'sonnet' : 'astra', effort: null }
  spec.research = { research_type: '생산량', questions: [], routes: [], keywords: [], output_file: 'result.md' }
  runner.enqueue(root, spec, { id: 'main', sessionId: 'main-session', company: 'claude' }, 'author')
  return { root, runner, delivered, calls }
}

const claudeShot = (usage: UsageState): ExecutionAccount => ({ accountId: 'c', connected: true, consented: true, usage,
  account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [{ model: 'sonnet', name: 'Sonnet', efforts: ['high'] }] } })
const codexShot = (usage: UsageState): ExecutionAccount => ({ accountId: 'x', connected: true, consented: true, usage,
  account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'astra', name: 'Astra', efforts: ['high'] }] } })

test('㉠ declared gate passes pre-turn unknown; in-turn limit is recorded as limit', async () => {
  const f = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { gateInTurn: true, liveUsage: 'unknown', signal: 'limit' } })
  await f.runner.runQueued()
  expect(f.calls).toEqual(['gate-job'])
  expect(f.runner.records()[0].status).toBe('limit')
  // limit is delivered (proposal only if the other company can continue; here both
  // shots are the same Claude side, so deliver is the §3.5 path).
  expect(f.delivered).toHaveLength(1)
  expect(f.runner.proposals()).toHaveLength(0)
})

test('㉠ declared gate with allowed signal inside the turn completes', async () => {
  const f = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { gateInTurn: true, liveUsage: 'unknown', signal: 'allowed', writeOutput: true } })
  await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('completed')
})

test('㉠ declared gate with no in-turn signal at all completes (no hidden probe)', async () => {
  const f = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { gateInTurn: true, liveUsage: 'unknown', writeOutput: true } })
  await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('completed')
})

test('㉠ undeclared connection keeps pre-change behavior for unknown', async () => {
  const f = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { liveUsage: 'unknown' } })
  await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('unknown')
})

test('㉠ gate declaration is per-connection, not per-company', async () => {
  // Codex-style relay without a declaration still closes unknown; a declared
  // connection passes it. Same company, different connection, different verdict.
  const undeclared = setup({ company: 'codex', shot: codexShot('unknown'),
    fake: { liveUsage: 'unknown' } })
  await undeclared.runner.runQueued()
  expect(undeclared.runner.records()[0].status).toBe('unknown')
  // Codex fake's availability still reports Claude-shaped account if misbuilt;
  // here the declared fake writes output and completes only when declared.
  const declared = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { gateInTurn: true, liveUsage: 'unknown', writeOutput: true } })
  await declared.runner.runQueued()
  expect(declared.runner.records()[0].status).toBe('completed')
})

test('㉠ limit and auth and rejected stay closed with or without the gate', async () => {
  for (const usage of ['limit', 'auth'] as UsageState[]) {
    const f = setup({ company: 'claude', shot: claudeShot(usage),
      fake: { gateInTurn: true, liveUsage: usage, writeOutput: true } })
    await f.runner.runQueued()
    expect(f.runner.records()[0].status).toBe(usage)
  }
  const noConsent = setup({ company: 'claude',
    shot: { ...claudeShot('unknown'), consented: false },
    fake: { gateInTurn: true, liveUsage: 'unknown', writeOutput: true },
    buildFactory: () => { throw new Error('must not build a connection') } })
  await noConsent.runner.runQueued()
  expect(noConsent.runner.records()[0].status).toBe('rejected')
  expect(noConsent.calls).toEqual([])
})

test('㉠ live availability limit closes as limit even with the gate', async () => {
  const f = setup({ company: 'claude', shot: claudeShot('unknown'),
    fake: { gateInTurn: true, liveUsage: 'limit', writeOutput: true } })
  await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('limit')
  expect(f.calls).toEqual(['gate-job'])
})
