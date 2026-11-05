import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { continueAfterLimit, type LaneEntry, type LanePlan } from '../../../shared/lanes'
import { readRecoverable, writeFileAtomic } from '../../safeWrite'
import { sha256 } from './isolation'
import type { ConversationOwner, ExecutionAccount, UsageState } from './types'
import type { OwnerTransition } from './transition'

export interface HandoffSource {
  rootConversationId: string
  owner: ConversationOwner
  root: string
  entry: LaneEntry
  reason: UsageState
  students: { text: string; attachments: { name: string; hash: string }[] }[]
  lastAssistant: { text: string; interrupted: boolean } | null
  beforeHashes: Record<string, string>
  afterHashes: Record<string, string>
  approvedPlan: LanePlan | null
  jobs: { id: string; status: string; delivered: boolean }[]
  skillVersion: string
  sourceLocation: string
}
export interface HandoffBundle {
  root: string
  students: HandoffSource['students']
  lastAssistant: HandoffSource['lastAssistant']
  changedFiles: { path: string; before: string | null; after: string | null }[]
  changedFileCount: number
  approvedPlan: LanePlan | null
  jobs: HandoffSource['jobs']
  skillVersion: string
  truncated: string[]
  archive: string
  sourceLocation: string
}
export interface ConversationProposal {
  proposalId: string
  rootConversationId: string
  oldOwner: ConversationOwner
  newConversationId: string
  entry: LaneEntry
  accountId: string
  accountFingerprint: string
  bundleHash: string
  bundlePath: string
  archivePath: string
  state: 'open' | 'consumed' | 'discarded'
  shownAt: string
  clickedAt?: string
}
interface HandoffState { version: 1; proposals: ConversationProposal[]; attempts: Record<string, string[]> }
export interface ConversationHandoffOptions {
  stateDir: string
  maxBytes: number
  account: (company: 'claude' | 'codex') => Promise<ExecutionAccount | null>
  /** Abort must stop in-flight creation; close also cleans a session returned after cancellation. */
  open: (request: { id: string; entry: LaneEntry; firstMessage: string; bundlePath: string; signal: AbortSignal }) => Promise<ConversationOwner>
  close: (owner: ConversationOwner) => Promise<void>
  /** Async preparation has no visible side effects; returned commit is synchronous. */
  prepareActivation: (oldOwner: ConversationOwner, newOwner: ConversationOwner, entry: LaneEntry, signal: AbortSignal) => Promise<() => void>
  /** JobRunner.beginOwnerTransition holds completed results until commit or cancellation. */
  beginTransition: (root: string) => OwnerTransition
  audit: (record: object) => void
}
/** Deterministic mechanical packet. Full source remains in private storage, never an AI summary. */
export function buildHandoffBundle(source: HandoffSource, archive: string, maxBytes: number): HandoffBundle | null {
  const paths = [...new Set([...Object.keys(source.beforeHashes), ...Object.keys(source.afterHashes)])].sort()
  const changedFiles = paths.filter(path => source.beforeHashes[path] !== source.afterHashes[path]).map(path => ({
    path, before: source.beforeHashes[path] ?? null, after: source.afterHashes[path] ?? null
  }))
  const bundle: HandoffBundle = {
    root: source.root,
    students: structuredClone(source.students), lastAssistant: structuredClone(source.lastAssistant),
    changedFiles, changedFileCount: changedFiles.length, approvedPlan: structuredClone(source.approvedPlan),
    jobs: structuredClone(source.jobs), skillVersion: source.skillVersion, truncated: [], archive, sourceLocation: source.sourceLocation
  }
  const size = () => Buffer.byteLength(JSON.stringify(bundle))
  // Priority 1: oldest student messages first, preserving every omitted byte in archive.
  while (size() > maxBytes && bundle.students.length) {
    if (!bundle.truncated.includes('students')) bundle.truncated.push('students')
    bundle.students.shift()
  }
  // Priority 2: only the first/last parts of the last AI response; interruption flag remains.
  if (size() > maxBytes && bundle.lastAssistant) {
    bundle.truncated.push('lastAssistant')
    const text = Array.from(bundle.lastAssistant.text)
    let low = 0, high = Math.floor(text.length / 2), best = ''
    while (low <= high) {
      const n = Math.floor((low + high) / 2)
      bundle.lastAssistant.text = n ? `${text.slice(0, n).join('')}\n[…]\n${text.slice(-n).join('')}` : '[…]'
      if (size() <= maxBytes) { best = bundle.lastAssistant.text; low = n + 1 } else high = n - 1
    }
    bundle.lastAssistant.text = best || '[…]'
  }
  // Priority 3: file count and leading entries.
  if (size() > maxBytes && bundle.changedFiles.length) {
    bundle.truncated.push('changedFiles')
    while (size() > maxBytes && bundle.changedFiles.length) bundle.changedFiles.pop()
  }
  // Priority 4: only active or not-yet-delivered jobs.
  if (size() > maxBytes) {
    bundle.truncated.push('jobs')
    bundle.jobs = bundle.jobs.filter(j => !j.delivered || ['queued', 'running'].includes(j.status))
  }
  return size() <= maxBytes ? bundle : null
}
export class ConversationHandoff {
  private state: HandoffState
  private file: string
  private generations = new Map<string, number>()
  private reservations = new Map<string, AbortController>()
  constructor(private options: ConversationHandoffOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    this.file = join(options.stateDir, 'conversation-handoff.json')
    this.state = readRecoverable(this.file, text => {
      const value = JSON.parse(text) as HandoffState
      if (value.version !== 1 || !Array.isArray(value.proposals) || !value.attempts) throw new Error('Invalid handoff state')
      return value
    })?.value ?? { version: 1, proposals: [], attempts: {} }
    for (const proposal of this.state.proposals) if (proposal.state === 'open') proposal.state = 'discarded'
    this.persist()
  }
  private persist(): void {
    const result = writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 })
    if (!result.ok) throw result.error
  }
  proposals(): ConversationProposal[] { return structuredClone(this.state.proposals.filter(p => p.state === 'open')) }
  async propose(source: HandoffSource): Promise<ConversationProposal | null> {
    if (source.reason !== 'limit' || source.entry.how !== 'main') return null
    const rootId = source.rootConversationId
    const generation = this.generations.get(rootId) ?? 0
    const existing = this.state.proposals.find(p => p.rootConversationId === rootId && p.state === 'open')
    if (existing) return structuredClone(existing)
    if (this.reservations.has(rootId)) return null
    const other = await this.options.account(source.entry.company === 'claude' ? 'codex' : 'claude')
    if ((this.generations.get(rootId) ?? 0) !== generation || !other?.connected || other.usage !== 'allowed') return null
    const entry = continueAfterLimit('design', source.entry, other.account,
      { consented: other.consented, basicUsageAllowed: true }, { [other.account.company]: other.account.models })
    const attempts = this.state.attempts[rootId] ??= [`${source.entry.company}:${source.entry.model}`]
    if (!entry?.model || attempts.includes(`${entry.company}:${entry.model}`)) return null
    const raced = this.state.proposals.find(p => p.rootConversationId === rootId && p.state === 'open')
    if (raced) return structuredClone(raced)
    if (this.reservations.has(rootId)) return null
    const proposalId = randomUUID(), archivePath = join(this.options.stateDir, `${proposalId}-archive.json`)
    const stored = writeFileAtomic(archivePath, JSON.stringify(source), { mode: 0o600 })
    if (!stored.ok) throw stored.error
    const bundle = buildHandoffBundle(source, archivePath, this.options.maxBytes)
    if (!bundle) throw new Error('앞 대화가 너무 길어 자동으로 이어 받을 수 없어요 — 새 대화에서 다시 시작해 주세요')
    const bundlePath = join(this.options.stateDir, `${proposalId}-bundle.json`), text = JSON.stringify(bundle)
    const result = writeFileAtomic(bundlePath, text, { mode: 0o600 })
    if (!result.ok) throw result.error
    const proposal: ConversationProposal = { proposalId, rootConversationId: rootId, oldOwner: structuredClone(source.owner),
      newConversationId: randomUUID(), entry, accountId: other.accountId, accountFingerprint: sha256(JSON.stringify(other)),
      bundleHash: sha256(text), bundlePath, archivePath, state: 'open', shownAt: new Date().toISOString() }
    this.state.proposals.push(proposal); this.persist()
    return structuredClone(proposal)
  }
  async continue(proposalId: string): Promise<ConversationOwner | null> {
    const p = this.state.proposals.find(value => value.proposalId === proposalId)
    if (!p || p.state !== 'open' || this.reservations.has(p.rootConversationId)) return null
    const controller = new AbortController()
    this.reservations.set(p.rootConversationId, controller)
    p.state = 'consumed'; p.clickedAt = new Date().toISOString(); this.persist()
    const generation = this.generations.get(p.rootConversationId) ?? 0
    const valid = () => !controller.signal.aborted && this.reservations.get(p.rootConversationId) === controller
      && (this.generations.get(p.rootConversationId) ?? 0) === generation
    let owner: ConversationOwner | undefined, transition: OwnerTransition | undefined, committed = false
    let refresh: HandoffSource | undefined
    try {
      const account = await this.options.account(p.entry.company)
      if (!valid()) return null
      if (!account?.connected || account.usage !== 'allowed' || sha256(JSON.stringify(account)) !== p.accountFingerprint) {
        p.state = 'discarded'; this.persist()
        refresh = JSON.parse(readFileSync(p.archivePath, 'utf8')) as HandoffSource
        return null
      }
      const text = readFileSync(p.bundlePath, 'utf8')
      if (sha256(text) !== p.bundleHash) { p.state = 'discarded'; this.persist(); throw new Error('이어 받기 묶음이 바뀌었어요.') }
      const source = JSON.parse(readFileSync(p.archivePath, 'utf8')) as HandoffSource
      transition = this.options.beginTransition(source.root)
      await transition.ready()
      if (!valid()) return null
      this.state.attempts[p.rootConversationId].push(`${p.entry.company}:${p.entry.model}`)
      this.persist()
      owner = await this.options.open({ id: p.newConversationId, entry: structuredClone(p.entry), bundlePath: p.bundlePath,
        signal: controller.signal,
        firstMessage: `/knuaf-dev 재개: 논문 폴더가 정본이며 아래 묶음은 대화 맥락 보조입니다. 끊긴 차례를 자동 재전송하거나 이미 한 작업을 반복하지 말고 폴더 상태를 확인하세요. 첫 답에서 “앞 대화를 이어 받았어요 — {마지막으로 하던 일}”이라고 알리세요.\n${text}` })
      if (!valid()) return null
      if (owner.id !== p.newConversationId || owner.company !== p.entry.company || !owner.sessionId || owner.sessionId === p.oldOwner.sessionId) throw new Error('이어 받기는 다른 새 세션이어야 해요.')
      const activate = await this.options.prepareActivation(p.oldOwner, owner, structuredClone(p.entry), controller.signal)
      if (!valid()) return null
      committed = transition.commit(owner, activate)
      if (!committed) return null
      this.options.audit({ type: 'conversation-continue-after-limit', rootConversationId: p.rootConversationId,
        oldConversationId: p.oldOwner.id, newConversationId: owner.id, reason: 'limit', clickedAt: p.clickedAt,
        company: p.entry.company, model: p.entry.model, effort: p.entry.effort, bundleHash: p.bundleHash })
      return owner
    } finally {
      try {
        if (!committed) {
          p.state = 'discarded'; this.persist()
          controller.abort()
          if (owner) await this.options.close(owner)
        }
      } finally {
        if (!committed) transition?.cancel()
        if (this.reservations.get(p.rootConversationId) === controller) this.reservations.delete(p.rootConversationId)
        await transition?.flush()
      }
      if (refresh && (this.generations.get(p.rootConversationId) ?? 0) === generation) await this.propose(refresh)
    }
  }
  /** Later, stop, or user conversation switch. Also invalidates an in-flight click/proposal lookup. */
  invalidate(rootConversationId: string): void {
    this.generations.set(rootConversationId, (this.generations.get(rootConversationId) ?? 0) + 1)
    this.reservations.get(rootConversationId)?.abort()
    for (const p of this.state.proposals) if (p.rootConversationId === rootConversationId && p.state !== 'discarded') p.state = 'discarded'
    this.persist()
  }
}
