import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { continueAfterLimit, subscriptionCheck } from '../../shared/lanes'
import { resolveCodexAlias } from '../../shared/chat'
import { readRecoverable, writeFileAtomic } from '../safeWrite'
import { canonical, createOutput, inside, outputName, relayIsolation, sha256, thesisHashes } from './jobs/isolation'
import { chatConnectionKey } from './jobs/key'
import { tokenRecord } from './jobs/tokens'
import { JobFailure, type ContinuationProposal, type ConversationOwner, type ExecutionAccount, type JobConnection, type JobRecord, type JobResult, type JobRunnerOptions, type JobSpec, type JobStatus } from './jobs/types'
export type * from './jobs/types'

interface State {
  version: 1
  jobs: JobRecord[]
  proposals: ContinuationProposal[]
  delivered: string[]
}
interface Approval {
  newJobId: string; parentJobId: string; cause: string; proposalId: string
  company: string; model: string; effort: string | null; accountId: string; contentHash: string
}
const now = () => new Date().toISOString()
const fingerprint = (account: ExecutionAccount) => sha256(JSON.stringify(account))

/** A single app-owned runner; no engine imports, polling, automatic retries, or hidden model changes. */
export class JobRunner {
  private state: State
  private approvals = new Map<string, Approval>()
  private active: { record: JobRecord; connection: JobConnection | null; stopped: boolean; failure?: 'limit' | 'unknown' | 'auth' } | null = null
  private draining: Promise<void> | null = null
  private generations = new Map<string, number>()
  private file: string
  constructor(private options: JobRunnerOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    this.file = join(options.stateDir, 'jobrunner.json')
    this.state = readRecoverable(this.file, text => {
      const value = JSON.parse(text) as State
      if (value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.proposals) || !Array.isArray(value.delivered)) throw new Error('Invalid JobRunner state')
      return value
    })?.value ?? { version: 1, jobs: [], proposals: [], delivered: [] }
    // Reservations/approvals never survive a process restart. No automatic resend.
    for (const job of this.state.jobs) if (job.status === 'running' || job.status === 'queued') {
      job.status = 'interrupted'; job.reason = '앱이 종료됐어요. 다시 맡기거나 버려 주세요.'
    }
    for (const proposal of this.state.proposals) if (proposal.state === 'open') proposal.state = 'discarded'
    this.persist()
    for (const job of this.state.jobs) this.publish(job)
  }
  private persist(): void {
    const result = writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 })
    if (!result.ok) throw result.error
  }
  records(): JobRecord[] { return structuredClone(this.state.jobs) }
  proposals(): ContinuationProposal[] { return structuredClone(this.state.proposals.filter(p => p.state === 'open')) }
  private job(id: string): JobRecord {
    const job = this.state.jobs.find(j => j.spec.id === id)
    if (!job) throw new Error('Unknown job')
    return job
  }
  private content(spec: JobSpec, root: string): string {
    return sha256(JSON.stringify({ lane: spec.lane, task: spec.task, inputs: spec.inputs.map(i => ({
      sourceId: i.sourceId, path: i.path, hash: i.hash, actualHash: sha256(readFileSync(i.path)), section: i.section
    })), outputs: spec.outputs, contractVersion: spec.contractVersion, root }))
  }
  private validate(spec: JobSpec, root: string): void {
    const skill = this.options.skill()
    if (!this.options.supportedSchemas.includes(spec.schema) || skill.schema !== spec.schema || skill.contractVersion !== spec.contractVersion) throw new Error('앱과 스킬 판이 맞지 않아요.')
    if (!/^[a-zA-Z0-9_-]+$/.test(spec.id) || !['research', 'writing', 'repeat', 'review'].includes(spec.lane)
      || !['claude', 'codex'].includes(spec.company) || typeof spec.model !== 'string' || !spec.model || spec.model.includes('/')
      || (spec.effort !== null && typeof spec.effort !== 'string') || typeof spec.task !== 'string' || !spec.task.trim()
      || !Array.isArray(spec.inputs) || !Array.isArray(spec.outputs) || !spec.outputs.length) throw new Error('Invalid job specification')
    if (new Set(spec.outputs).size !== spec.outputs.length || spec.outputs.some(p => typeof p !== 'string' || !outputName(p))) throw new Error('Invalid output ownership')
    for (const a of spec.outputs) for (const b of spec.outputs) if (a !== b && b.startsWith(`${a}/`)) throw new Error('Overlapping outputs')
    for (const input of spec.inputs) {
      if (!input || typeof input.sourceId !== 'string' || !input.sourceId || typeof input.section !== 'string'
        || typeof input.path !== 'string' || !isAbsolute(input.path) || !inside(root, canonical(input.path))
        || !lstatSync(input.path).isFile() || sha256(readFileSync(input.path)) !== input.hash) throw new Error('Input reference changed or unavailable')
    }
  }
  private approved(spec: JobSpec, root: string): boolean {
    const approved = this.options.approvedPlan(root)?.[spec.lane]
    return approved?.how === 'relay' && approved.company === spec.company && approved.model === spec.model && approved.effort === spec.effort
  }
  /** Called only after the main turn finishes. Neither lanes.json nor parent/cause grants authority. */
  enqueue(root: string, input: JobSpec, owner: ConversationOwner, authorSessionId: string): JobRecord {
    root = canonical(root)
    if (inside(root, canonical(this.options.stateDir))) throw new Error('App state must be outside thesis folder')
    const spec = structuredClone(input)
    this.validate(spec, root)
    if (spec.parent || spec.cause || !this.approved(spec, root)) throw new Error('주문서 요청값이 앱 승인 배치와 달라요.')
    if (!owner.sessionId || !authorSessionId || this.state.jobs.some(j => j.spec.id === spec.id)) throw new Error('Invalid job identity')
    const record: JobRecord = { spec, root, owner: structuredClone(owner), authorSessionId, rootJobId: spec.id,
      status: 'queued', contentHash: this.content(spec, root), outputs: [], createdAt: now() }
    this.state.jobs.push(record); this.persist(); this.publish(record)
    return structuredClone(record)
  }
  private publish(record: JobRecord): void {
    const folder = join(record.root, '.knuaf-gui', 'jobs')
    if (!inside(record.root, canonical(folder))) throw new Error('Job storage escaped thesis folder')
    mkdirSync(folder, { recursive: true })
    const result = writeFileAtomic(join(folder, `${record.spec.id}.json`), JSON.stringify({ ...record, ...record.spec, spec: record.spec, outputRefs: record.outputs }), { mode: 0o600 })
    if (!result.ok) throw result.error
  }
  private update(record: JobRecord, status: JobStatus, reason?: string): void {
    record.status = status; record.reason = reason; this.persist(); this.publish(record)
  }
  runQueued(): Promise<void> {
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null })
    return this.draining
  }
  private async drain(): Promise<void> {
    for (;;) {
      const next = this.state.jobs.find(j => j.status === 'queued')
      if (!next) return
      await this.execute(next)
    }
  }
  private accountFailure(account: ExecutionAccount | null, consent = true): 'auth' | 'unknown' | 'limit' | 'rejected' | null {
    if (!account?.connected || !subscriptionCheck(account.account).usable || account.usage === 'auth') return 'auth'
    if (consent && !account.consented) return 'rejected'
    if (account.usage !== 'allowed') return account.usage
    return null
  }
  private listed(account: ExecutionAccount, spec: JobSpec): boolean {
    const models = account.account.models
    if (!models) return false
    const id = spec.company === 'codex' ? resolveCodexAlias([...models], spec.model) ?? spec.model : spec.model
    const model = models.find(m => m.model === id)
    return !!model && (spec.effort === null || model.efforts.includes(spec.effort))
  }
  private async execute(record: JobRecord): Promise<void> {
    const current = { record, connection: null as JobConnection | null, stopped: false, failure: undefined as 'limit' | 'unknown' | 'auth' | undefined }
    this.active = current
    let baseline: Record<string, string> | undefined
    try {
      const spec = record.spec
      this.validate(spec, record.root)
      if (this.content(spec, record.root) !== record.contentHash) throw new Error('Job content changed')
      const approval = this.approvals.get(spec.id)
      if (spec.parent) {
        // Consumed synchronously before any async check or execution, even on failure.
        this.approvals.delete(spec.id)
        const proposal = this.state.proposals.find(p => p.proposalId === approval?.proposalId)
        if (!approval || !proposal || approval.contentHash !== record.contentHash || approval.newJobId !== spec.id
          || approval.parentJobId !== spec.parent || approval.cause !== spec.cause || approval.company !== spec.company
          || approval.model !== spec.model || approval.effort !== spec.effort || approval.accountId !== record.accountId
          || proposal.contentHash !== record.contentHash || this.job(spec.parent).contentHash !== record.contentHash) throw new Error('Continuation approval mismatch')
      } else if (!this.approved(spec, record.root)) throw new Error('Approved plan changed')
      const account = await this.options.account(spec.company)
      if (current.stopped) return
      const failure = this.accountFailure(account)
      if (failure) { this.update(record, failure); return }
      if (!account || account.account.company !== spec.company || !this.listed(account, spec)) { this.update(record, 'rejected'); return }
      if (approval) {
        const proposal = this.state.proposals.find(p => p.proposalId === approval.proposalId)!
        if (account.accountId !== approval.accountId || fingerprint(account) !== proposal.accountFingerprint) { this.update(record, 'rejected'); return }
      }
      record.accountId = account.accountId
      const cwd = createOutput(record.root, spec.id)
      baseline = thesisHashes(record.root)
      const request = { key: chatConnectionKey(record.root, spec.company, `job:${spec.id}`), jobId: spec.id, company: spec.company,
        cwd, skill: this.options.skill().path, model: spec.model, effort: spec.effort,
        isolation: relayIsolation(cwd, spec.outputs, this.options.shellSandboxAvailable) }
      const connection = this.options.connectionFactory(request)
      current.connection = connection
      if (connection.relayProtocol !== 1) throw new Error('Engine relay isolation is not wired')
      const status = await connection.status()
      if (current.stopped) return
      if (!status.connected) { this.update(record, status.probe === 'failed' ? 'unknown' : 'auth'); return }
      const live = await connection.availability()
      if (current.stopped) return
      const liveFailure = this.accountFailure(live)
      if (liveFailure) { this.update(record, liveFailure); return }
      if (fingerprint(live) !== fingerprint(account)) { this.update(record, 'rejected'); return }
      // Restore the app-authorized specification immediately before the engine reads its job file.
      if (this.content(spec, record.root) !== record.contentHash) throw new Error('Input changed before start')
      this.update(record, 'running')
      await connection.runJob(`/knuaf-dev 담당 모드: ${join(record.root, '.knuaf-gui', 'jobs', `${spec.id}.json`)}`, {
        message: () => {}, note: () => {}, skill: () => {},
        permission: p => connection.respond(p.id, false),
        session: id => {
          if (current.stopped || current.failure) return
          if (!id || (record.sessionId && record.sessionId !== id)
            || this.state.jobs.some(j => j !== record && j.sessionId === id)
            || id === record.owner.sessionId || (spec.lane === 'review' && id === record.authorSessionId)) {
            this.update(record, 'rejected', '작성자와 검토자는 다른 새 세션이어야 해요.')
            current.stopped = true; void connection.stop(); return
          }
          record.sessionId = id
          if (spec.lane === 'review') record.reviewerSessionId = id
          this.persist(); this.publish(record)
        },
        availability: state => {
          if (current.stopped || state === 'allowed' || current.failure) return
          current.failure = state; void connection.stop()
        },
        tokens: event => {
          if (!record.sessionId) return
          const token = tokenRecord({ conversationId: record.sessionId, jobId: spec.id, company: spec.company,
            model: spec.model, effort: spec.effort, role: spec.lane }, event, now())
          if (token) this.audit(record, token)
        },
        actualModel: (model, effort) => {
          record.actualModel = model; record.actualEffort = effort
          this.persist()
          this.audit(record, { type: 'actual-model', jobId: spec.id,
            requestedModel: spec.model, requestedEffort: spec.effort, model, effort,
            matchesRequest: model === spec.model && effort === spec.effort, at: now() })
        }
      })
      if (current.stopped) return
      if (current.failure) { this.update(record, current.failure); return }
      if (!record.sessionId) { this.update(record, 'rejected', '새 세션을 확인하지 못했어요.'); return }
      if (record.sessionId === record.owner.sessionId) { this.update(record, 'rejected', '새 본대화와 담당 세션이 같아요.'); return }
      if (JSON.stringify(baseline) !== JSON.stringify(thesisHashes(record.root))) { this.update(record, 'violation'); return }
      record.outputs = this.collectOutputs(cwd, spec.outputs)
      this.update(record, 'completed')
    } catch (error) {
      if (!current.stopped) this.update(record, current.failure ?? (error instanceof JobFailure ? error.status : 'error'))
    } finally {
      try { await current.connection?.stop() } finally {
        this.active = null
        this.approvals.delete(record.spec.id)
      }
      if (baseline && JSON.stringify(baseline) !== JSON.stringify(thesisHashes(record.root))) this.update(record, 'violation')
      this.audit(record, { type: 'job-result', jobId: record.spec.id, rootJobId: record.rootJobId, status: record.status,
        company: record.spec.company, requestedModel: record.spec.model, requestedEffort: record.spec.effort,
        actualModel: record.actualModel ?? 'unverified', actualEffort: record.actualEffort,
        sessionId: record.sessionId, authorSessionId: record.authorSessionId,
        reviewerSessionId: record.reviewerSessionId, at: now() })
      if (record.status === 'limit') {
        if (!(await this.propose(record))) await this.deliver(record)
      } else if (!['stopped', 'interrupted', 'violation', 'running', 'queued'].includes(record.status)) await this.deliver(record)
    }
  }
  private collectOutputs(cwd: string, outputs: string[]): string[] {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name)
        if (item.isSymbolicLink() || !inside(cwd, canonical(path))) throw new Error('Unsafe output')
        if (item.isDirectory()) walk(path)
        else if (item.isFile()) {
          const name = relative(cwd, path).split(sep).join('/')
          if (!outputs.includes(name)) throw new Error('Unowned output')
          found.push(path)
        } else throw new Error('Unsupported output type')
      }
    }
    walk(cwd)
    if (found.length !== outputs.length) throw new Error('Missing output')
    return outputs.map(name => join(cwd, name))
  }
  private audit(record: JobRecord, data: object): void {
    const folder = join(record.root, 'audit', 'model-routing')
    if (!inside(record.root, canonical(folder))) throw new Error('Unsafe audit path')
    mkdirSync(folder, { recursive: true })
    const result = writeFileAtomic(join(folder, `${record.spec.id}-${randomUUID()}.json`), JSON.stringify(data), { mode: 0o600 })
    if (!result.ok) throw result.error
    this.options.diagnostic(data)
  }
  private async deliver(record: JobRecord): Promise<void> {
    if (this.state.delivered.includes(record.rootJobId)) return
    this.state.delivered.push(record.rootJobId)
    for (const p of this.state.proposals) if (p.rootJobId === record.rootJobId && p.state === 'open') p.state = 'discarded'
    this.persist() // At-most-once claim before IPC; a crash never causes automatic replay.
    const result: JobResult = { rootJobId: record.rootJobId, jobId: record.spec.id, status: record.status,
      outputs: record.status === 'completed' ? record.outputs : [], company: record.spec.company, model: record.spec.model, effort: record.spec.effort }
    await this.options.deliver(structuredClone(record.owner), result)
  }
  private async propose(record: JobRecord): Promise<ContinuationProposal | null> {
    if (this.state.delivered.includes(record.rootJobId)) return null
    const existing = this.state.proposals.find(p => p.rootJobId === record.rootJobId && p.state === 'open')
    if (existing) return existing
    const other = await this.options.account(record.spec.company === 'claude' ? 'codex' : 'claude')
    // Recheck after await: stop/later/delivery may have won the race.
    if (record.status !== 'limit' || this.state.delivered.includes(record.rootJobId)) return null
    if (this.accountFailure(other) || !other) return null
    const entry = continueAfterLimit(record.spec.lane, { company: record.spec.company, model: record.spec.model, effort: record.spec.effort, how: 'relay' }, other.account,
      { consented: other.consented, basicUsageAllowed: other.usage === 'allowed' }, { [other.account.company]: other.account.models })
    if (!entry?.model) return null
    const alreadyTried = this.state.jobs.some(job => job.rootJobId === record.rootJobId && job.spec.company === entry.company
      && (entry.company === 'codex' ? resolveCodexAlias([...(other.account.models ?? [])], job.spec.model) ?? job.spec.model : job.spec.model) === entry.model)
    if (alreadyTried) return null
    const raced = this.state.proposals.find(p => p.rootJobId === record.rootJobId && p.state === 'open')
    if (raced) return raced
    const proposal: ContinuationProposal = { proposalId: randomUUID(), rootJobId: record.rootJobId, parentJobId: record.spec.id,
      newJobId: randomUUID(), entry, accountId: other.accountId, accountFingerprint: fingerprint(other), contentHash: record.contentHash, state: 'open', shownAt: now() }
    this.state.proposals.push(proposal); this.persist()
    return proposal
  }
  async continue(proposalId: string): Promise<JobRecord | null> {
    const p = this.state.proposals.find(p => p.proposalId === proposalId)
    if (!p || p.state !== 'open' || this.state.delivered.includes(p.rootJobId)) return null
    p.state = 'consumed'; p.clickedAt = now(); this.persist() // No await before atomic claim.
    const parent = this.job(p.parentJobId)
    const generation = this.generations.get(parent.root) ?? 0
    const other = await this.options.account(p.entry.company)
    if (this.state.delivered.includes(p.rootJobId) || parent.status !== 'limit') return null
    if ((this.generations.get(parent.root) ?? 0) !== generation) return null
    if (!other || this.accountFailure(other) || fingerprint(other) !== p.accountFingerprint) {
      p.state = 'discarded'; this.persist()
      if (!(await this.propose(parent))) await this.deliver(parent)
      return null
    }
    try {
      this.validate(parent.spec, parent.root)
      if (this.content(parent.spec, parent.root) !== p.contentHash) throw new Error('Input changed')
    } catch { p.state = 'discarded'; this.update(parent, 'rejected', '승인한 입력이 바뀌었어요.'); await this.deliver(parent); return null }
    const spec: JobSpec = { ...structuredClone(parent.spec), id: p.newJobId, parent: parent.spec.id,
      cause: 'student-continue-after-limit', company: p.entry.company, model: p.entry.model!, effort: p.entry.effort }
    const record: JobRecord = { ...structuredClone(parent), spec, status: 'queued', reason: undefined, outputs: [],
      sessionId: undefined, reviewerSessionId: undefined, actualModel: undefined, actualEffort: undefined,
      accountId: p.accountId, proposalId, createdAt: now() }
    this.approvals.set(spec.id, { newJobId: spec.id, parentJobId: parent.spec.id, cause: spec.cause!, proposalId,
      company: spec.company, model: spec.model, effort: spec.effort, accountId: p.accountId, contentHash: p.contentHash })
    this.state.jobs.push(record); this.persist(); this.publish(record)
    this.audit(record, { type: 'student-continue-after-limit', rootJobId: record.rootJobId, parentJobId: parent.spec.id,
      original: { company: parent.spec.company, model: parent.spec.model, effort: parent.spec.effort }, reason: 'limit',
      proposalId, clickedAt: p.clickedAt, company: spec.company, model: spec.model, effort: spec.effort })
    return structuredClone(record)
  }
  async later(proposalId: string): Promise<void> {
    const p = this.state.proposals.find(p => p.proposalId === proposalId)
    if (!p || p.state !== 'open') return
    p.state = 'discarded'; this.persist(); await this.deliver(this.job(p.parentJobId))
  }
  /** Conversation switch invalidates open choices, without rerunning any job. */
  async switchOwner(root: string, owner: ConversationOwner): Promise<void> {
    root = canonical(root)
    this.generations.set(root, (this.generations.get(root) ?? 0) + 1)
    for (const record of this.state.jobs) if (record.root === root) record.owner = structuredClone(owner)
    const open = this.state.proposals.filter(p => p.state === 'open' && this.job(p.parentJobId).root === root)
    for (const p of open) p.state = 'discarded'
    this.persist()
    for (const p of open) await this.deliver(this.job(p.parentJobId))
  }
  /** Explicit user retry only. It is a new root order; no old output or approval is reused. */
  retry(id: string, newJobId: string): JobRecord {
    const previous = this.job(id)
    if (!['interrupted', 'stopped', 'error', 'auth', 'unknown', 'limit'].includes(previous.status)) throw new Error('Job cannot be retried')
    const spec = structuredClone(previous.spec)
    spec.id = newJobId; delete spec.parent; delete spec.cause
    return this.enqueue(previous.root, spec, previous.owner, previous.authorSessionId)
  }
  async stop(root: string): Promise<void> {
    root = canonical(root)
    this.generations.set(root, (this.generations.get(root) ?? 0) + 1)
    const records = this.state.jobs.filter(j => j.root === root)
    for (const p of this.state.proposals) if (this.job(p.parentJobId).root === root && p.state === 'open') p.state = 'discarded'
    for (const job of records) {
      this.state.delivered.push(job.rootJobId)
      if (['queued', 'running', 'limit'].includes(job.status)) this.update(job, 'stopped')
    }
    if (this.active?.record.root === root) this.active.stopped = true
    this.persist()
    const owners = new Map(records.map(j => [j.owner.id, j.owner]))
    await Promise.all([
      this.active?.record.root === root ? this.active.connection?.stop() : undefined,
      ...[...owners.values()].map(owner => this.options.stopMain(owner))
    ])
    await this.draining
  }
}
