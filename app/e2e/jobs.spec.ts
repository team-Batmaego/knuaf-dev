import { expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobRunner } from '../src/main/chat/jobs'
import { JobFailure, type ConversationOwner, type ExecutionAccount, type JobConnection, type JobEvents, type JobResult, type JobSpec, type RelayRequest } from '../src/main/chat/jobs/types'
import { canonical, relayIsolation, sha256 } from '../src/main/chat/jobs/isolation'
import { planFromRow } from '../src/shared/lanes'
import { claudeTokens, codexTokens } from '../src/main/chat/jobs/tokens'

const owner: ConversationOwner = { id: 'main', sessionId: 'author', company: 'claude' }
function fixture() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'knuaf-jobs-'))), root = join(base, 'thesis'), stateDir = join(base, 'private')
  mkdirSync(root); writeFileSync(join(root, 'project.json'), '{"original":true}')
  const models = (ids: string[]) => ids.map(model => ({ model, name: model, efforts: ['low', 'high'] }))
  const accounts: Record<'claude' | 'codex', ExecutionAccount> = {
    claude: { accountId: 'claude-account', connected: true, consented: true, usage: 'allowed', account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: models(['opus', 'sonnet', 'haiku']) } },
    codex: { accountId: 'codex-account', connected: true, consented: true, usage: 'allowed', account: { company: 'codex', accountType: 'chatgpt', models: models(['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) } }
  }
  const plan = planFromRow('both-high'), requests: RelayRequest[] = [], deliveries: { owner: ConversationOwner; result: JobResult }[] = [], diagnostics: object[] = []
  let stops = 0, mainStops = 0
  let behavior = async (request: RelayRequest, events: JobEvents) => {
    events.session(`session-${request.jobId}`)
    writeFileSync(join(request.cwd, 'result.md'), 'actual result')
  }
  let accountRead = async (company: 'claude' | 'codex') => structuredClone(accounts[company])
  const options = {
    stateDir, approvedPlan: () => plan, account: (company: 'claude' | 'codex') => accountRead(company),
    skill: () => ({ path: '/fake/skill', schema: 1, contractVersion: 'role-v1' }), supportedSchemas: [1],
    connectionFactory: (request: RelayRequest): JobConnection => {
      requests.push(request)
      return { relayProtocol: 1, status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
        availability: async () => structuredClone(accounts[request.company]), login: async () => {}, respond: () => {},
        run: async () => { throw new Error('Ordinary run must not execute relay') },
        runJob: async (_text, events) => behavior(request, events), stop: async () => { stops++ } }
    },
    deliver: async (target: ConversationOwner, result: JobResult) => { deliveries.push({ owner: target, result }) },
    stopMain: async () => { mainStops++ }, diagnostic: (data: object) => { diagnostics.push(data) }, shellSandboxAvailable: true
  }
  const runner = new JobRunner(options)
  const spec = (id = 'job-one', lane: JobSpec['lane'] = 'research'): JobSpec => ({ schema: 1, id, lane, task: 'Read the source and write the result',
    inputs: [{ sourceId: 'project', path: join(root, 'project.json'), hash: sha256(readFileSync(join(root, 'project.json'))), section: 'one' }],
    ...(lane === 'research' ? { research: { research_type: '생산량', questions: [{ id: 'Q1', target: '생산량', acceptance: '공식 통계' }],
      routes: [{ doc: 'research-sources.md', id_or_name: 'KOSIS', url: 'https://kosis.kr/' }], keywords: ['생산량'], output_file: 'result.md' } } : {}),
    outputs: ['result.md'], contractVersion: 'role-v1', company: plan[lane]!.company, model: plan[lane]!.model!, effort: plan[lane]!.effort })
  return { root, stateDir, accounts, plan, requests, deliveries, diagnostics, options, runner, spec,
    behavior: (fn: typeof behavior) => { behavior = fn }, accountRead: (fn: typeof accountRead) => { accountRead = fn },
    stops: () => ({ stops, mainStops }) }
}

test('serial fresh sessions deliver isolated files without touching thesis or main transcript', async () => {
  const f = fixture(); let active = 0, peak = 0
  f.behavior(async (r, e) => {
    active++; peak = Math.max(peak, active); e.session(`fresh-${r.jobId}`)
    e.message('private', 'must not appear in main'); e.note('private note')
    await Promise.resolve()
    const manifest = JSON.parse(readFileSync(join(f.root, '.knuaf-gui/jobs', `${r.jobId}.json`), 'utf8'))
    expect(manifest.outputs).toEqual(['result.md'])
    writeFileSync(join(r.cwd, manifest.outputs[0]), r.jobId); active--
  })
  f.runner.enqueue(f.root, f.spec('a'), owner, 'author'); f.runner.enqueue(f.root, f.spec('b'), owner, 'author')
  await Promise.all([f.runner.runQueued(), f.runner.runQueued()])
  expect(peak).toBe(1)
  expect(f.runner.records().map(r => r.status)).toEqual(['completed', 'completed'])
  expect(f.requests.map(r => r.key)).toEqual([`${f.root}\0codex\0job:a`, `${f.root}\0codex\0job:b`])
  expect(f.requests[0].cwd).toBe(join(f.root, '.knuaf-gui/jobs/a/out'))
  expect(f.requests[0].isolation.codexSandbox).toBe('workspace-write')
  expect(f.deliveries.map(d => readFileSync(d.result.outputs[0], 'utf8'))).toEqual(['a', 'b'])
  expect(readFileSync(join(f.root, 'project.json'), 'utf8')).toBe('{"original":true}')
  expect(JSON.stringify(f.deliveries)).not.toContain('must not appear')
})

test('research presence follows the lane and its output file must exactly match an owned output', () => {
  const f = fixture(), valid = f.spec()
  const missing = { ...valid }; delete missing.research
  const invalid = [missing, ...[null, [], 'research', {}, { output_file: './result.md' }, { output_file: 'other.md' }]
    .map(research => ({ ...valid, research }) as JobSpec)]
  for (const lane of ['writing', 'repeat', 'review'] as const) {
    invalid.push({ ...f.spec(`invalid-${lane}`, lane), research: valid.research })
  }
  for (const spec of invalid) expect(() => f.runner.enqueue(f.root, spec, owner, 'author')).toThrow()
  expect(f.runner.records()).toEqual([]); expect(f.requests).toEqual([])
})

test('research semantics stay skill-owned and continuation resolves all outputs in the new job directory', async () => {
  const f = fixture(), spec = f.spec()
  spec.outputs = ['tables/result.md', 'source.json']
  spec.research = { research_type: '', questions: [], routes: [], keywords: [], output_file: 'tables/result.md',
    conditions: { region: '미확정', year: null }, opened_routes: [{ id: 'D01', reason: '접근 실패' }] }
  f.accounts.codex.usage = 'limit'
  f.runner.enqueue(f.root, spec, owner, 'author'); await f.runner.runQueued()
  const child = (await f.runner.continue(f.runner.proposals()[0].proposalId))!
  f.behavior(async (request, events) => {
    events.session(`fresh-${request.jobId}`)
    const manifest = JSON.parse(readFileSync(join(f.root, '.knuaf-gui/jobs', `${request.jobId}.json`), 'utf8'))
    mkdirSync(join(request.cwd, 'tables'))
    writeFileSync(join(request.cwd, manifest.research.output_file), 'Q1: 확인 불가')
    writeFileSync(join(request.cwd, 'source.json'), '{"status":"unavailable"}')
  })
  await f.runner.runQueued()
  expect(f.deliveries.map(d => d.result.status)).toEqual(['completed'])
  expect(f.deliveries[0].result.outputs).toEqual(spec.outputs.map(name => join(f.root, '.knuaf-gui/jobs', child.spec.id, 'out', name)))
  expect(readFileSync(f.deliveries[0].result.outputs[0], 'utf8')).toBe('Q1: 확인 불가')
  expect(f.runner.records()[1].spec.research).toEqual(spec.research)
})

const researchChanges: Record<string, (research: NonNullable<JobSpec['research']>) => void> = {
  type: r => { r.research_type = '법령' },
  question: r => { r.questions[0] = { id: 'Q1', target: '다른 지표', acceptance: '다른 조건' } },
  route: r => { r.routes[0].url = 'https://kosis.kr/changed' },
  keyword: r => { r.keywords.push('다른 품목') },
  output: r => { r.output_file = 'alternate.md' },
  extension: r => { r.conditions = { region: '변경된 지역', year: 2026 } }
}

for (const phase of ['queued', 'before-click', 'after-click'] as const) test(`changed research never executes: ${phase}`, async () => {
  for (const change of Object.values(researchChanges)) {
    const f = fixture(), spec = f.spec()
    spec.outputs.push('alternate.md')
    spec.research!.conditions = { region: '미확정', year: 2025 }
    if (phase !== 'queued') f.accounts.codex.usage = 'limit'
    f.runner.enqueue(f.root, spec, owner, 'author')
    if (phase !== 'queued') await f.runner.runQueued()
    if (phase === 'after-click') await f.runner.continue(f.runner.proposals()[0].proposalId)
    // Inject corruption into app-owned state; public manifests and returned records are only copies.
    const internal = f.runner as unknown as { state: { jobs: { spec: JobSpec }[] } }
    change(internal.state.jobs.at(-1)!.spec.research!)
    if (phase === 'before-click') expect(await f.runner.continue(f.runner.proposals()[0].proposalId)).toBeNull()
    else await f.runner.runQueued()
    expect(f.requests).toEqual([])
    expect(f.deliveries.map(d => d.result.status)).toEqual([phase === 'before-click' ? 'rejected' : 'error'])
    expect(f.deliveries[0].result.outputs).toEqual([])
  }
})

test('untrusted job routing, fake continuation, unknown schema and changed input never execute', async () => {
  const f = fixture()
  expect(() => f.runner.enqueue(f.root, { ...f.spec(), model: 'opus' }, owner, 'author')).toThrow('승인 배치')
  expect(() => f.runner.enqueue(f.root, { ...f.spec(), parent: 'fake', cause: 'student-continue-after-limit' }, owner, 'author')).toThrow('승인 배치')
  expect(() => f.runner.enqueue(f.root, { ...f.spec(), schema: 20 }, owner, 'author')).toThrow('판')
  f.runner.enqueue(f.root, f.spec(), owner, 'author')
  writeFileSync(join(f.root, 'project.json'), 'modified input')
  await f.runner.runQueued()
  expect(f.requests).toEqual([])
  expect(f.runner.records()[0].status).toBe('error')
})

for (const state of ['limit', 'unknown', 'auth'] as const) test(`start gate distinguishes ${state} with no execution`, async () => {
  const f = fixture(); f.accounts.codex.usage = state
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe(state)
  expect(f.requests).toEqual([])
  expect(f.runner.proposals().length).toBe(state === 'limit' ? 1 : 0)
  expect(f.deliveries.map(d => d.result.status)).toEqual(state === 'limit' ? [] : [state])
})

test('consent and subscription gates reject API/Bedrock and withdrawn consent', async () => {
  for (const patch of [{ consented: false }, { account: { company: 'codex', accountType: 'apiKey', models: [] } }, { account: { company: 'codex', accountType: 'amazonBedrock', models: [] } }] as const) {
    const f = fixture(); Object.assign(f.accounts.codex, patch)
    f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
    expect(f.requests).toEqual([]); expect(f.runner.proposals()).toEqual([])
    expect(f.runner.records()[0].status).toBe('consented' in patch ? 'rejected' : 'auth')
  }
})

test('Claude tool guards reject escape paths, symlinks, shell bypass and trust fallback', () => {
  const f = fixture(), out = join(f.root, 'out'); mkdirSync(out)
  symlinkSync(f.stateDir, join(out, 'escape'))
  const policy = relayIsolation(out, ['result.md', 'escape/secret'], true)
  for (const [tool, input] of [
    ['Write', { file_path: '../project.json' }], ['Edit', { file_path: join(f.root, 'project.json') }],
    ['NotebookEdit', { notebook_path: '../project.json' }], ['Write', { file_path: 'escape/secret' }],
    ['Write', { file_path: 'not-owned.md' }], ['Bash', { dangerouslyDisableSandbox: true }], ['Agent', {}], ['Task', {}]
  ] as const) expect(policy.preToolUse(tool, input).permissionDecision).toBe('deny')
  expect(policy.preToolUse('Write', { file_path: 'result.md' }).permissionDecision).toBe('allow')
  expect(policy.canUseTool('Bash', { command: 'safe' }).permissionDecision).toBe('deny')
  expect(policy.settingSources).toEqual([])
  expect(policy.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
  expect(relayIsolation(out, ['result.md'], false).preToolUse('Bash', {}).permissionDecision).toBe('deny')
})

test('review rejects author/main/reused sessions including continuation', async () => {
  const f = fixture()
  f.behavior(async (_r, e) => { e.session('author') })
  f.runner.enqueue(f.root, f.spec('review', 'review'), owner, 'author'); await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('rejected')
  expect(f.deliveries[0].result.outputs).toEqual([])
  const g = fixture(); g.accounts.codex.usage = 'limit'
  g.runner.enqueue(g.root, g.spec('review', 'review'), owner, 'writer-session'); await g.runner.runQueued()
  await g.runner.continue(g.runner.proposals()[0].proposalId)
  g.behavior(async (_r, e) => { e.session('writer-session') }); await g.runner.runQueued()
  expect(g.runner.records()[1].status).toBe('rejected')
})

test('double click reserves once, keeps plan, rewrites output refs and delivers root once', async () => {
  const f = fixture(), before = structuredClone(f.plan); f.accounts.codex.usage = 'limit'
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  const proposal = f.runner.proposals()[0]
  expect(proposal.entry).toEqual({ company: 'claude', model: 'sonnet', effort: null, how: 'relay' })
  expect(f.deliveries).toEqual([])
  const results = await Promise.all([f.runner.continue(proposal.proposalId), f.runner.continue(proposal.proposalId)])
  expect(results.filter(Boolean)).toHaveLength(1)
  const child = results.find(Boolean)!
  expect(child.spec.parent).toBe('job-one'); expect(child.spec.cause).toBe('student-continue-after-limit')
  expect(child.contentHash).toBe(f.runner.records()[0].contentHash)
  await f.runner.runQueued(); await f.runner.later(proposal.proposalId)
  expect(f.plan).toEqual(before)
  expect(f.deliveries.map(d => d.result.status)).toEqual(['completed'])
  expect(f.deliveries[0].result.outputs[0]).toBe(join(f.root, '.knuaf-gui/jobs', child.spec.id, 'out/result.md'))
})

test('click account changes refresh the displayed proposal; input changes reject approval', async () => {
  const f = fixture(); f.accounts.codex.usage = 'limit'
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  const old = f.runner.proposals()[0]
  f.accounts.claude.accountId = 'different-account'
  expect(await f.runner.continue(old.proposalId)).toBeNull()
  expect(f.requests).toEqual([])
  expect(f.runner.proposals()[0].accountId).toBe('different-account')
  writeFileSync(join(f.root, 'project.json'), 'changed')
  expect(await f.runner.continue(f.runner.proposals()[0].proposalId)).toBeNull()
  expect(f.deliveries.map(d => d.result.status)).toEqual(['rejected'])
})

test('later wins over stale click and repeat limits never return to tried route', async () => {
  const f = fixture(); f.accounts.codex.usage = 'limit'
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  const p = f.runner.proposals()[0]; await f.runner.later(p.proposalId)
  expect(await f.runner.continue(p.proposalId)).toBeNull()
  expect(f.deliveries.map(d => d.result.status)).toEqual(['limit'])
  const g = fixture(); g.accounts.codex.usage = 'limit'
  g.runner.enqueue(g.root, g.spec(), owner, 'author'); await g.runner.runQueued()
  await g.runner.continue(g.runner.proposals()[0].proposalId)
  g.accounts.codex.usage = 'allowed'; g.behavior(async () => { throw new JobFailure('limit', 'fake quota') })
  await g.runner.runQueued()
  expect(g.runner.proposals()).toEqual([])
  expect(g.deliveries.map(d => d.result.status)).toEqual(['limit'])
})

test('usage loss stops active relay, suppresses partial outputs and main result waits for choice', async () => {
  const f = fixture()
  f.behavior(async (r, e) => { e.session('new'); writeFileSync(join(r.cwd, 'result.md'), 'partial'); e.availability('limit'); e.message('late', 'late original result') })
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  expect(f.runner.records()[0].status).toBe('limit')
  expect(f.stops().stops).toBeGreaterThanOrEqual(1)
  expect(f.deliveries).toEqual([])
  await f.runner.later(f.runner.proposals()[0].proposalId)
  expect(f.deliveries[0].result.outputs).toEqual([])
})

test('student stop cancels main and relay, rejects late completion and pending choices', async () => {
  const f = fixture()
  const { promise: ready, resolve: started } = Promise.withResolvers<void>()
  const { promise: wait, resolve: release } = Promise.withResolvers<void>()
  f.behavior(async (r, e) => { e.session('fresh'); started(); await wait; writeFileSync(join(r.cwd, 'result.md'), 'late') })
  f.runner.enqueue(f.root, f.spec(), owner, 'author')
  const running = f.runner.runQueued(); await ready
  const stopping = f.runner.stop(f.root); release(); await Promise.all([running, stopping])
  expect(f.runner.records()[0].status).toBe('stopped')
  expect(f.deliveries).toEqual([]); expect(f.stops().mainStops).toBe(1)
})

test('restart invalidates reservations and running jobs without execution', async () => {
  const f = fixture(); f.accounts.codex.usage = 'limit'
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  await f.runner.continue(f.runner.proposals()[0].proposalId)
  const restarted = new JobRunner(f.options); await restarted.runQueued()
  expect(restarted.records().map(r => r.status)).toEqual(['limit', 'interrupted'])
  expect(restarted.proposals()).toEqual([]); expect(f.requests).toEqual([])
  const text = JSON.parse(readFileSync(join(f.stateDir, 'jobrunner.json'), 'utf8'))
  text.jobs[1].status = 'running'; writeFileSync(join(f.stateDir, 'jobrunner.json'), JSON.stringify(text))
  expect(new JobRunner(f.options).records()[1].status).toBe('interrupted')
})

test('active and queued orders move to new main without re-execution', async () => {
  const f = fixture()
  const { promise: ready, resolve: started } = Promise.withResolvers<void>()
  const { promise: wait, resolve: release } = Promise.withResolvers<void>()
  f.behavior(async (r, e) => { e.session(`s-${r.jobId}`); if (r.jobId === 'a') { started(); await wait }; writeFileSync(join(r.cwd, 'result.md'), 'done') })
  f.runner.enqueue(f.root, f.spec('a'), owner, 'author'); f.runner.enqueue(f.root, f.spec('b'), owner, 'author')
  const running = f.runner.runQueued(); await ready
  await f.runner.switchOwner(f.root, { id: 'new-main', sessionId: 'new-author', company: 'codex' }); release(); await running
  expect(f.deliveries.map(d => d.owner.id)).toEqual(['new-main', 'new-main'])
  expect(f.requests.map(r => r.jobId)).toEqual(['a', 'b'])
})

test('canonical mutation and symlink outputs are withheld as violations/errors', async () => {
  for (const mode of ['thesis', 'symlink', 'extra'] as const) {
    const f = fixture()
    f.behavior(async (r, e) => { e.session('fresh')
      if (mode === 'thesis') writeFileSync(join(f.root, 'project.json'), 'tampered')
      if (mode === 'symlink') symlinkSync(join(f.root, 'project.json'), join(r.cwd, 'result.md'))
      else { writeFileSync(join(r.cwd, 'result.md'), 'result'); if (mode === 'extra') writeFileSync(join(r.cwd, 'extra.md'), 'extra') }
    })
    f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
    expect(f.runner.records()[0].status).toBe(mode === 'thesis' ? 'violation' : 'error')
    expect(f.deliveries.flatMap(d => d.result.outputs)).toEqual([])
  }
})

test('token audit contains only metadata/counts, preserves Codex last/total and event sequences', async () => {
  const f = fixture()
  f.behavior(async (r, e) => {
    e.session('usage-session'); e.message('secret', 'PRIVATE BODY')
    e.tokens({ ...codexTokens({ last: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 2, totalTokens: 14 }, total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }, 1, 1), body: 'PRIVATE BODY', tool: 'PRIVATE ARG' } as never)
    e.tokens(codexTokens({ last: { inputTokens: 3 }, total: { inputTokens: 103 } }, 2, 2))
    writeFileSync(join(r.cwd, 'result.md'), 'FILE CONTENT')
  })
  f.runner.enqueue(f.root, f.spec(), owner, 'author'); await f.runner.runQueued()
  const tokenDiagnostics = f.diagnostics.filter(record => 'requestSequence' in record)
  expect(tokenDiagnostics).toMatchObject([{ last: { inputTokens: 12 }, total: { inputTokens: 100 }, firstRequest: true, requestSequence: 1, notificationSequence: 1 }, { last: { inputTokens: 3 }, total: { inputTokens: 103 }, firstRequest: false }])
  const audit = readdirSync(join(f.root, 'audit/model-routing')).map(name => readFileSync(join(f.root, 'audit/model-routing', name), 'utf8')).join('')
  for (const secret of ['PRIVATE BODY', 'PRIVATE ARG', 'FILE CONTENT', 'hitRate']) expect(audit).not.toContain(secret)
  expect(claudeTokens({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }, 1, 1)).toEqual({ company: 'claude', requestSequence: 1, notificationSequence: 1, usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, cacheWriteInputTokens: 2 } })
})
