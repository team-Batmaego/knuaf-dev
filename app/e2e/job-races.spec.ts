import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobRunner } from '../src/main/chat/jobs'
import { canonical } from '../src/main/chat/jobs/isolation'
import { planFromRow } from '../src/shared/lanes'
import type { ExecutionAccount, JobRunnerOptions, JobSpec } from '../src/main/chat/jobs/types'

function setup() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'knuaf-race-'))), root = join(base, 'thesis'); mkdirSync(root)
  const plan = planFromRow('both-high')
  const claude: ExecutionAccount = { accountId: 'c', connected: true, consented: true, usage: 'allowed',
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [{ model: 'sonnet', name: 'Sonnet', efforts: ['high'] }] } }
  const codex: ExecutionAccount = { accountId: 'x', connected: true, consented: true, usage: 'limit',
    account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'astra', name: 'Astra', efforts: ['high'] }] } }
  let read = async (company: 'claude' | 'codex') => structuredClone(company === 'claude' ? claude : codex)
  const delivered: object[] = [], calls: string[] = []
  const options: JobRunnerOptions = { stateDir: join(base, 'private'), python: join(__dirname, '../../.venv-dev/bin/python'), approvedPlan: () => plan,
    account: company => read(company), skill: () => ({ path: '/fake', schema: 1, contractVersion: 'v1' }), supportedSchemas: [1],
    connectionFactory: request => { calls.push(request.jobId); throw new Error('must not start') },
    deliver: async (_owner, result) => { delivered.push(result) }, stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: false }
  const runner = new JobRunner(options)
  const spec: JobSpec = { schema: 1, id: 'root-job', lane: 'research', task: 'task', inputs: [], outputs: ['result.md'], contractVersion: 'v1', company: 'codex', model: 'astra', effort: null }
  runner.enqueue(root, spec, { id: 'main', sessionId: 'main-session', company: 'claude' }, 'author')
  return { root, runner, options, delivered, calls, claude, read: (fn: typeof read) => { read = fn } }
}

test('switch/stop while click checks account cannot reserve stale continuation', async () => {
  for (const action of ['switch', 'stop'] as const) {
    const f = setup(); await f.runner.runQueued()
    const p = f.runner.proposals()[0]
    const { promise, resolve } = Promise.withResolvers<ExecutionAccount>()
    f.read(() => promise)
    const click = f.runner.continue(p.proposalId)
    if (action === 'switch') await f.runner.switchOwner(f.root, { id: 'new', sessionId: 'new-main', company: 'codex' })
    else await f.runner.stop(f.root)
    resolve(f.claude)
    expect(await click).toBeNull(); expect(f.calls).toEqual([]); expect(f.runner.records()).toHaveLength(1)
  }
})

test('disk proposal cannot replace frozen target or immutable child task', async () => {
  const f = setup(); await f.runner.runQueued()
  const proposal = f.runner.proposals()[0]
  proposal.entry.model = 'opus'
  const child = await f.runner.continue(proposal.proposalId)
  expect(child!.spec.model).toBe('sonnet')
  child!.spec.task = 'forged task'
  const disk = join(f.root, '.knuaf-gui/jobs', `${child!.spec.id}.json`)
  writeFileSync(disk, JSON.stringify(child))
  // Public snapshots and folder JSON are not authority. Private app record remains immutable.
  expect(f.runner.records()[1].spec.task).toBe('task')
  expect(f.runner.records()[1].contentHash).toBe(f.runner.records()[0].contentHash)
})

test('recovered interrupted order requires explicit retry and new identity', async () => {
  const f = setup(), restarted = new JobRunner(f.options)
  await restarted.runQueued(); expect(f.calls).toEqual([])
  const retry = restarted.retry('root-job', 'explicit-retry')
  expect(retry.status).toBe('queued'); expect(retry.rootJobId).toBe('explicit-retry')
  expect(restarted.records()[0].status).toBe('interrupted')
  const oldDisk = JSON.parse(readFileSync(join(f.root, '.knuaf-gui/jobs/root-job.json'), 'utf8'))
  expect(oldDisk.status).toBe('interrupted')
})
