import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../../../shared/chat'
import { continueAfterLimit, type LaneEntry, type LanePlan } from '../../../shared/lanes'
import type { ArchivedChat, ArchivedChatSummary, ModelRef } from '../../../shared/lanes-ipc'
import { readRecoverable, writeFileAtomic } from '../../safeWrite'
import { sha256 } from './isolation'
import type { ConversationOwner, ExecutionAccount, UsageState } from './types'
import type { OwnerTransition } from './transition'

/**
 * §1-4 ② — 대상 대화를 열어 **첫 턴이 끝난** 결과. `firstTurn` 이 `ok` 일 때만 소유를 넘긴다:
 * `limit` 은 대상도 한도(화면은 "…도 지금 한도에 걸렸어요" + [나중에]), `failed` 는 그 밖의 실패다.
 */
export type HandoffOpenResult = ConversationOwner & { firstTurn: 'ok' | 'limit' | 'failed' }

/** 사유 판정 — `firstTurn` 을 제안의 `failedReason` 으로 옮긴다(계약 `handoff-failed.reason`). */
const failedReasonOf = (firstTurn: HandoffOpenResult['firstTurn']): 'target-limit' | null =>
  firstTurn === 'limit' ? 'target-limit' : null

export interface HandoffSource {
  rootConversationId: string
  owner: ConversationOwner
  root: string
  entry: LaneEntry
  reason: UsageState
  students: { text: string; attachments: { name: string; hash: string }[] }[]
  lastAssistant: { text: string; interrupted: boolean } | null
  /**
   * 이 대화의 첫 차례·멈춘 시각. 계약 `ArchivedChatSummary.startedAt/stoppedAt` 의 근거다 —
   * 대화 기록을 읽어 내는 통로가 아직 없어 부르는 쪽이 넘긴다(없으면 제안 시각으로 채운다).
   */
  startedAt?: string
  stoppedAt?: string
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
  /** 논문 폴더 — `lanes:handoff-*` 가 폴더로 제안을 찾는다. */
  root: string
  oldOwner: ConversationOwner
  newConversationId: string
  /** 이어 받을 대상(새 대화)의 회사·모델·깊이 — `handoff-done` 의 `to`. */
  entry: LaneEntry
  /** 넘기기 전 대화의 회사·모델·깊이 — `handoff-done` 의 `from`. */
  from: ModelRef
  accountId: string
  accountFingerprint: string
  /** 묶음을 만들지 못했으면 null. */
  bundleHash: string | null
  bundlePath: string | null
  archivePath: string
  /**
   * `true` 면 이어 받기 단추를 그리지 않는다(계약 `main-limit-offer.tooLong`): 묶음이 크기
   * 제한을 넘겼거나 **학생 글이 하나도 실리지 않았다**. 그때는 [새 대화로 시작]만 보인다 —
   * 학생 글 없는 묶음으로 새 대화를 열면 인계가 아니라 빈 대화다(REVIEW-C0 중요 4).
   */
  tooLong: boolean
  /** 크기 때문에 묶음을 줄였는가(`HandoffBundle.truncated` 가 비어 있지 않음). */
  trimmed: boolean
  state: 'open' | 'running' | 'consumed' | 'failed' | 'discarded'
  shownAt: string
  clickedAt?: string
  /**
   * §1-4 — 마지막 시도가 **왜** 넘기지 못했는가. `target-limit` 은 대상(이어 받는 회사)의 첫
   * 턴이 §1-2 의 `limit` 으로 끝난 경우다(화면은 [나중에]만 그린다). 그 밖의 실패는 `null`.
   * 넘긴 제안(`consumed`)·시도 전(`open`)에는 없다.
   */
  failedReason?: 'target-limit' | null
}
interface HandoffState { version: 1; proposals: ConversationProposal[]; attempts: Record<string, string[]> }
export interface ConversationHandoffOptions {
  stateDir: string
  maxBytes: number
  account: (company: 'claude' | 'codex') => Promise<ExecutionAccount | null>
  /**
   * §1-4 ② — 누르기 전 단추 조건에 쓰는 연결 쪽 선언(㉠). `true` 인 연결만 `usage:'unknown'`
   * 이어도 첫 턴 안 확인으로 넘긴다. 넘기지 않으면 `false`(안전 기본값 = 단추 없음).
   */
  gateInTurn?: (company: 'claude' | 'codex') => boolean
  /**
   * Abort must stop in-flight creation; close also cleans a session returned after cancellation.
   *
   * §1-4 ②: **대상 첫 턴이 끝날 때까지** 기다린다 — 돌려주는 `firstTurn` 이 그 결과다.
   * `ok` 일 때만 소유를 넘기고, `limit`/`failed` 면 부르는 쪽이 접는다.
   */
  open: (request: { id: string; root: string; entry: LaneEntry; firstMessage: string; bundlePath: string; signal: AbortSignal }) => Promise<HandoffOpenResult>
  close: (owner: ConversationOwner) => Promise<void>
  /** Async preparation has no visible side effects; returned commit is synchronous. */
  prepareActivation: (oldOwner: ConversationOwner, newOwner: ConversationOwner, entry: LaneEntry, signal: AbortSignal) => Promise<() => void>
  /** JobRunner.beginOwnerTransition holds completed results until commit or cancellation. */
  beginTransition: (root: string) => OwnerTransition
  audit: (record: object) => void
  /**
   * 이어 받을 대화 id. 앱의 대화 정체성은 `(폴더, 회사)` 하나뿐이라(대화 id 를 따로 두지
   * 않는다) 호출자가 `<company>\0<root>` 로 짓는다 — 넘기지 않으면 무작위 id.
   */
  mintId?: (root: string, company: 'claude' | 'codex') => string
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
  // §1-3 ⑤ — **기준값이 없으면** 무엇이 바뀌었는지 알 수 없다. `afterHashes` 전부를 `before:null`
  // 로 실으면 "새로 생긴 파일"처럼 읽혀 거짓말이 된다. 비우고 `truncated` 로 알린다.
  if (!Object.keys(source.beforeHashes).length) {
    if (bundle.changedFiles.length) bundle.truncated.push('changedFiles')
    bundle.changedFiles = []
    bundle.changedFileCount = 0
  }
  // Priority 1: oldest student messages first, preserving every omitted byte in archive.
  // **마지막 학생 글은 남긴다** — 0건이면 인계가 아니다(REVIEW-C0 중요 4). 그 한 건조차 안
  // 들어가면 묶음을 만들지 않고 `null`(계약 `tooLong` → [새 대화로 시작]).
  while (size() > maxBytes && bundle.students.length > 1) {
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
  // [Roh 중요 4] **학생 글이 하나도 실리지 않은 묶음은 인계가 아니다.** 빈 묶음으로 새 대화를
  // 열면 이어 받은 것이 아니라 맥락 없는 대화가 된다 — 성공으로 돌리지 않는다.
  if (!bundle.students.length) return null
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
    // 재시작 뒤에는 이어 받기 작업이 살아 있지 않다 — 열린 제안과 넘기는 중은 끝난 것으로 본다.
    for (const proposal of this.state.proposals) {
      if (proposal.state === 'open' || proposal.state === 'running') proposal.state = 'discarded'
    }
    this.persist()
  }
  private persist(): void {
    const result = writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 })
    if (!result.ok) throw result.error
  }
  /**
   * §4-1 줄에 쓸 제안 — 열린 것·넘기는 중·넘기지 못한 것. 성공(`consumed`)은
   * 보관 대화(`archives`)와 `handoff-done` 기록이 맡는다.
   */
  visible(): ConversationProposal[] {
    return structuredClone(this.state.proposals.filter(p => p.state !== 'discarded' && p.state !== 'consumed'))
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
    // §1-4 ① — `allowed` 면 띄운다. `unknown`(사용량을 모름)이면 **대상이 Claude** 이고 그 연결이
    // 첫 턴 안 확인을 선언했을 때만 띄운다 — 넘긴 뒤 첫 턴에서 한도가 드러나면 되돌린다(§1-4 ②).
    // `limit`·`auth`·`null` 은 단추 없음.
    const gateAllowed = other?.usage === 'allowed' ||
      (other?.usage === 'unknown' && other.account.company === 'claude' && this.options.gateInTurn?.('claude') === true)
    if ((this.generations.get(rootId) ?? 0) !== generation || !other?.connected || !gateAllowed) return null
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
    // 묶음을 못 만들었으면(너무 김 · 학생 글 0건) 이어 받기 단추 대신 [새 대화로 시작]이다.
    // 새 대화를 열지 않으므로 묶음 파일도 만들지 않는다(계약 `main-limit-offer.tooLong`).
    const bundlePath = bundle ? join(this.options.stateDir, `${proposalId}-bundle.json`) : null
    const text = bundle ? JSON.stringify(bundle) : null
    if (bundlePath && text) {
      const result = writeFileAtomic(bundlePath, text, { mode: 0o600 })
      if (!result.ok) throw result.error
    }
    const proposal: ConversationProposal = {
      proposalId, rootConversationId: rootId, root: source.root, oldOwner: structuredClone(source.owner),
      newConversationId: this.options.mintId?.(source.root, entry.company) ?? randomUUID(), entry, accountId: other.accountId,
      from: {
        company: source.entry.company,
        model: source.entry.model ?? '',
        effort: source.entry.effort
      },
      accountFingerprint: sha256(JSON.stringify(other)),
      bundleHash: text ? sha256(text) : null, bundlePath, archivePath,
      tooLong: !bundle, trimmed: Boolean(bundle?.truncated.length),
      state: 'open', shownAt: new Date().toISOString()
    }
    this.state.proposals.push(proposal); this.persist()
    return structuredClone(proposal)
  }
  async continue(proposalId: string): Promise<ConversationOwner | null> {
    const p = this.state.proposals.find(value => value.proposalId === proposalId)
    // `failed` 는 [다시 하기] — 같은 제안으로 한 번 더 시도한다(새 제안을 만들지 않는다).
    if (!p || (p.state !== 'open' && p.state !== 'failed') || this.reservations.has(p.rootConversationId)) return null
    // 묶음이 없으면(너무 길거나 학생 글이 0건) 이어 받을 것이 없다 — [새 대화로 시작]만 남는다.
    if (!p.bundlePath || !p.bundleHash) return null
    const controller = new AbortController()
    this.reservations.set(p.rootConversationId, controller)
    // 새 시도 — 지난 시도의 실패 사유는 이 시도의 결과로 덮인다.
    p.state = 'running'; p.clickedAt = new Date().toISOString(); delete p.failedReason; this.persist()
    const generation = this.generations.get(p.rootConversationId) ?? 0
    const valid = () => !controller.signal.aborted && this.reservations.get(p.rootConversationId) === controller
      && (this.generations.get(p.rootConversationId) ?? 0) === generation
    let owner: HandoffOpenResult | undefined, transition: OwnerTransition | undefined, committed = false
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
      owner = await this.options.open({ id: p.newConversationId, root: source.root, entry: structuredClone(p.entry), bundlePath: p.bundlePath,
        signal: controller.signal,
        firstMessage: `/knuaf-dev 재개: 논문 폴더가 정본이며 아래 묶음은 대화 맥락 보조입니다. 끊긴 차례를 자동 재전송하거나 이미 한 작업을 반복하지 말고 폴더 상태를 확인하세요. 첫 답에서 “앞 대화를 이어 받았어요 — {마지막으로 하던 일}”이라고 알리세요.\n${text}` })
      if (!valid()) return null
      // §1-4 ② — **첫 턴이 성공으로 끝난 뒤에만** 소유를 넘긴다. 새 세션은 이 순간 이미 열려
      // 있지만(학생이 산 요청 1번), `finally` 가 그 연결을 닫고 보관을 만들지 않는다.
      if (owner.firstTurn !== 'ok') { p.failedReason = failedReasonOf(owner.firstTurn); return null }
      if (owner.id !== p.newConversationId || owner.company !== p.entry.company || !owner.sessionId || owner.sessionId === p.oldOwner.sessionId) throw new Error('이어 받기는 다른 새 세션이어야 해요.')
      const activate = await this.options.prepareActivation(p.oldOwner, owner, structuredClone(p.entry), controller.signal)
      if (!valid()) return null
      committed = transition.commit(owner, activate)
      if (!committed) return null
      delete p.failedReason
      p.state = 'consumed'; this.persist()
      this.options.audit({ type: 'conversation-continue-after-limit', rootConversationId: p.rootConversationId,
        oldConversationId: p.oldOwner.id, newConversationId: owner.id, reason: 'limit', clickedAt: p.clickedAt,
        company: p.entry.company, model: p.entry.model, effort: p.entry.effort, bundleHash: p.bundleHash })
      return owner
    } finally {
      try {
        if (!committed) {
          // 학생·전환으로 무효가 된 것이면 조용히 접고, 실제로 넘기지 못했으면 [다시 하기]를 남긴다.
          if (p.state !== 'discarded') p.state = controller.signal.aborted ? 'discarded' : 'failed'
          this.persist()
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
  /** §4-1 [나중에] — 제안을 접고 아무것도 넘기지 않는다. 줄은 기존 대화 오류 줄로 돌아간다. */
  later(proposalId: string): boolean {
    const p = this.state.proposals.find(value => value.proposalId === proposalId)
    if (!p || (p.state !== 'open' && p.state !== 'failed')) return false
    p.state = 'discarded'
    this.persist()
    return true
  }
  /**
   * §4-2 보관 대화 목록 — 이 폴더에서 **한도로 멈춰 실제로 이어 받은** 대화만. 넘기지 못한
   * 제안은 보관이 아니다(`consumed` 만 센다).
   */
  archives(root: string): ArchivedChatSummary[] {
    const summaries: ArchivedChatSummary[] = []
    for (const p of this.state.proposals) {
      if (p.root !== root || p.state !== 'consumed') continue
      const source = this.readArchive(p)
      if (!source) continue
      summaries.push({
        archiveId: p.proposalId,
        company: source.owner.company,
        model: source.entry.model,
        startedAt: source.startedAt ?? p.shownAt,
        stoppedAt: source.stoppedAt ?? p.clickedAt ?? p.shownAt,
        reason: 'limit',
        successorId: p.newConversationId,
        successor: { company: p.entry.company, model: p.entry.model ?? '', effort: p.entry.effort }
      })
    }
    return summaries.sort((a, b) => b.stoppedAt.localeCompare(a.stoppedAt))
  }
  /** §4-2 보관 대화 한 개 — 읽기 전용. 없으면 null. */
  archive(root: string, archiveId: string): ArchivedChat | null {
    const summary = this.archives(root).find(entry => entry.archiveId === archiveId)
    if (!summary) return null
    const p = this.state.proposals.find(value => value.proposalId === archiveId)!
    const source = this.readArchive(p)
    if (!source) return null
    const messages: ChatMessage[] = source.students.map((student, index) => ({
      id: `${archiveId}-student-${index}`,
      role: 'user' as const,
      text: student.text,
      at: source.startedAt ?? p.shownAt
    }))
    if (source.lastAssistant) {
      messages.push({
        id: `${archiveId}-assistant`,
        role: 'assistant',
        text: source.lastAssistant.text,
        at: source.stoppedAt ?? p.clickedAt ?? p.shownAt
      })
    }
    return { summary, messages }
  }
  private readArchive(proposal: ConversationProposal): HandoffSource | null {
    try { return JSON.parse(readFileSync(proposal.archivePath, 'utf8')) as HandoffSource } catch { return null }
  }
  /**
   * Later, stop, or user conversation switch. Also invalidates an in-flight click/proposal lookup.
   *
   * [C1-10] **이미 넘긴 제안(`consumed`)은 건드리지 않는다** — 그건 보관 대화이고, 여기서
   * `discarded` 로 바꾸면 보관 목록에서 사라진다. 무효화 대상은 아직 끝나지 않은 것뿐이다.
   */
  invalidate(rootConversationId: string): void {
    this.generations.set(rootConversationId, (this.generations.get(rootConversationId) ?? 0) + 1)
    this.reservations.get(rootConversationId)?.abort()
    let changed = false
    for (const p of this.state.proposals) {
      if (p.rootConversationId !== rootConversationId) continue
      if (p.state === 'discarded' || p.state === 'consumed') continue
      p.state = 'discarded'
      changed = true
    }
    if (changed) this.persist()
  }
  /**
   * 폴더 단위 무효화 — `ChatService` 는 대화 id 가 아니라 폴더를 안다. 이 폴더에서 열린 제안의
   * 차례를 올려 잡고 있는 클릭을 버린다.
   */
  invalidateRoot(root: string): void {
    const ids = new Set(this.state.proposals.filter(p => p.root === root).map(p => p.rootConversationId))
    for (const id of ids) this.invalidate(id)
  }
}
