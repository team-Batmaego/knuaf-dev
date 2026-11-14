/**
 * codexThreadLock.ts — Codex 스레드를 **이어도 되는가**를 가르는 자리(설계 §4.1-C).
 *
 * 두 기록을 함께 본다:
 *   - **적재 표**(메모리, 프로세스 수명) — "이 app-server 프로세스가 이 스레드를 잠금 `config`로
 *     처음 적재했다". 칸은 없음 → 불명 → 잠김(지문)으로만 올라가고, 항목은 지워지지 않는다.
 *     잠김 → 불명은 있다(재적재가 어긋났을 때).
 *   - **스레드 잠금 장부**(디스크, `guard/<폴더 sha>/state.json` 의 `codexThreads`) — "이 스레드의
 *     **모든** 턴은 앱이 잠금 지문 X로 열었다" + 그 스레드에서 앱이 연 턴 id 의 집합(턴 원장).
 *     줄이 없으면 불명이고, 불명은 오염으로 본다.
 *
 * 이 모듈은 전송을 모른다 — `LoadTransport` 를 호출자가 넣는다. 그래서 판정만 시험할 수 있다.
 * 학생에게 보이는 글은 설계 §4.1-C 원문 그대로다.
 */

import { codexThreadRow, loadCodexThreads, saveCodexThreads, type CodexThreadRow, type ThreadStore } from '../guard/store'

/** 적재 호출의 전송. `codex.ts` 가 실제 app-server 로, 시험이 가짜로 채운다. */
export interface LoadTransport {
  /** `thread/start` — 잠금 `config` 를 실어 보낸다. */
  start: () => Promise<LoadReply>
  /** `thread/resume` — 같은 `config`+`cwd` 를 다시 싣는다. */
  resume: (threadId: string) => Promise<LoadReply>
  /** 결과 대조 — MCP 상태·Apps·`instructionSources`. 그 스레드로 턴을 열어도 되는가. */
  verify: (threadId: string, instructionSources: unknown) => Promise<{ ok: boolean; detail?: string }>
  /** 재기동 — 이 프로세스를 닫는다(표·표식도 함께 사라진다). */
  restart: () => Promise<void>
}

/** 적재 응답 — 실패는 던지지 않고 결말로 온다. */
export type LoadReply =
  | { ok: true; threadId: string; turns?: unknown; instructionSources: unknown }
  | { ok: false; kind: 'error' | 'timeout' | 'no-id' | 'active-writer' | 'no-rollout'; message?: string }

/** 새 대화로 바뀐 사유 — 설계 §4.1-C 의 ⓐ·ⓑ·ⓓ. */
export type NewChatReason = 'a' | 'b' | 'd'

export interface NewChatInfo {
  reason: NewChatReason
  /** 화면에 넣는 안내 글 — 사유 줄 + 공통 줄 + 이월 줄 */
  notice: string
}

export type AcquireOutcome =
  | { ok: true; threadId: string; fingerprint: string; switched?: NewChatInfo }
  | {
    ok: false
    kind: 'other-window' | 'refused'
    reason: string
    /** 학생에게 그대로 보여 줄 글 */
    studentCopy: string
  }

/** 다른 창이 그 스레드를 쥐고 있을 때(⑨) — 재전송·재기동·새 대화 어느 것도 하지 않는다. */
export const OTHER_WINDOW_COPY =
  '**다른 창에서 이 대화를 열고 있어요.** 그 창(터미널의 Codex 등)을 닫은 뒤 다시 보내 주세요.'
/** 이어 하기가 잠김에 이르지 못했을 때(재기동 1회까지 쓴 뒤). */
export const RESUME_REFUSAL_COPY = '이어 하기에서 외부 도구를 끄지 못했어요. 새 대화로 열어 주세요'
/** 새 대화가 잠김에 이르지 못했을 때. */
export const NEW_CHAT_REFUSAL_COPY = 'Codex 설정의 외부 도구를 끄지 못했어요'

const NEW_CHAT_HEAD = '**Codex 도우미가 새 대화로 이어 갈게요.**'
const NEW_CHAT_REASON: Record<NewChatReason, string> = {
  a: '이 대화는 앱이 바깥 도구(플러그인 같은 것)를 잠그기 전에 시작한 대화예요.',
  b: '이 대화를 시작한 뒤에 이 컴퓨터의 Codex 도구 설정이 바뀌었어요.',
  d: '이 대화에 앱이 열지 않은 기록이 끼어 있어요. 앱 밖에서 이 대화를 이어 썼거나, 메시지를 보내는 순간 앱이 꺼졌을 때 생겨요.'
}
const NEW_CHAT_WHY =
  '예전 대화를 그대로 이어 붙이면, 그때 켜져 있던 바깥 도구가 남긴 지시가 도우미에게 다시 전달될 수 있어요. 그래서 깨끗한 새 대화에서 시작해요.'

/**
 * 새 대화 안내 글. `carried` 는 새 스레드 첫 턴 앞에 함께 넘긴 지난 메시지 수다 —
 * 전송 장부 배선 전(2단계)에는 늘 0 이고, 그때는 '다시 말해 주세요' 줄이 나간다.
 */
export function newChatNotice(reason: NewChatReason, carried: number): string {
  return [
    NEW_CHAT_HEAD,
    NEW_CHAT_REASON[reason],
    NEW_CHAT_WHY,
    '· 위에 보이는 지난 대화와 논문 폴더의 파일은 그대로예요. 지워진 것은 없어요.',
    '· 방금 보내신 메시지는 새 대화에 그대로 전달했어요.',
    carried > 0
      ? `· 도우미는 지난 대화를 기억하지 못해요. 대신 앞에서 보내신 메시지 ${carried}개를 참고하라고 함께 넘겼어요.`
      : '· 도우미는 지난 대화를 기억하지 못해요. 하던 일이 있으면 한 줄로 다시 말해 주세요.'
  ].join('\n')
}

// ── 적재 표 ──────────────────────────────────────────────────────────────────

export type Cell = 'none' | 'unknown' | 'locked'

/**
 * 한 프로세스의 적재 표. 프로세스가 새로 뜨면 비어 있다.
 * 칸은 올라가기만 하고(없음→불명→잠김), 항목을 지우는 길은 `discard()`(프로세스 폐기)뿐이다.
 */
export class LoadTable {
  private cells = new Map<string, { cell: 'unknown' | 'locked'; fingerprint: string }>()
  /** 프로세스 단위 '미결 시작' 표식 — `thread/start` 는 응답 전에 threadId 가 없다. */
  private pending: string | null = null

  cell(threadId: string): Cell {
    return this.cells.get(threadId)?.cell ?? 'none'
  }

  fingerprintOf(threadId: string): string | null {
    const entry = this.cells.get(threadId)
    return entry?.cell === 'locked' ? entry.fingerprint : null
  }

  /** 불명으로 올린다. 잠김은 내리지 않는다(`demote` 가 그 자리다). */
  markUnknown(threadId: string): void {
    if (this.cells.get(threadId)?.cell === 'locked') return
    this.cells.set(threadId, { cell: 'unknown', fingerprint: '' })
  }

  markLocked(threadId: string, fingerprint: string): void {
    this.cells.set(threadId, { cell: 'locked', fingerprint })
  }

  /** 잠김 → 불명. 잠금이 확인되지 않은 재적재 뒤에만 부른다. */
  demote(threadId: string): void {
    if (!this.cells.has(threadId)) return
    this.cells.set(threadId, { cell: 'unknown', fingerprint: '' })
  }

  /** `thread/start` 직전. 미결 표식은 프로세스에 하나뿐이다. */
  beginStart(fingerprint: string): void {
    if (this.pending !== null) throw new Error('적재 호출은 한 번에 하나만 보낼 수 있어요')
    this.pending = fingerprint
  }

  pendingFingerprint(): string | null {
    return this.pending
  }

  clearPending(): void {
    this.pending = null
  }

  /** 프로세스 폐기 — 표·표식이 함께 사라진다. */
  discard(): void {
    this.cells.clear()
    this.pending = null
  }
}

// ── 판정(순수 함수 — 시험이 직접 부른다) ──────────────────────────────────────

export type ResumeGate =
  | { action: 'send' }
  | { action: 'new-chat'; reason: 'a' | 'b' }
  | { action: 'restart' }

/**
 * `resume` 을 보내기 **전에** 아는 것만으로 가른다(전이표 윗줄들).
 * 장부를 먼저 본다 — 장부가 어긋난 스레드는 적재하지 않는다(같은 프로세스로 새 `start` 는 된다).
 */
export function resumeGate(cell: Cell, row: CodexThreadRow | undefined, fingerprint: string): ResumeGate {
  if (!row) return { action: 'new-chat', reason: 'a' }
  if (row.fingerprint !== fingerprint) return { action: 'new-chat', reason: 'b' }
  if (cell === 'unknown') return { action: 'restart' }
  return { action: 'send' }
}

/** 턴 원장 대조(⑨) — 응답 `thread.turns` 의 id 가 전부 원장에 있어야 통과다. */
export function judgeTurns(raw: unknown, ledger: string[]): 'pass' | 'polluted' | 'unjudgeable' {
  if (!Array.isArray(raw)) return 'unjudgeable'
  const known = new Set(ledger)
  for (const turn of raw) {
    if (!turn || typeof turn !== 'object' || !('id' in turn)) return 'unjudgeable'
    const id = turn.id
    if (typeof id !== 'string' || !id) return 'unjudgeable'
    if (!known.has(id)) return 'polluted'
  }
  return 'pass'
}

// ── 장부 ──────────────────────────────────────────────────────────────────────

/**
 * 디스크 장부 위에 이 실행의 메모리 장부를 겹친다.
 * 디스크 쓰기가 실패한 줄(ⓤ·㉵)도 이 실행 동안은 이어지고, 앱을 다시 켜면 새 대화가 된다.
 */
function mergeRows(disk: Record<string, CodexThreadRow>, memory: Map<string, CodexThreadRow>): Record<string, CodexThreadRow> {
  const rows: Record<string, CodexThreadRow> = { ...disk }
  for (const [threadId, row] of memory) {
    const seen = rows[threadId]
    rows[threadId] = seen
      ? codexThreadRow(row.fingerprint, [...seen.turns, ...row.turns])
      : row
  }
  return rows
}

// ── 하나의 턴을 열기까지 ──────────────────────────────────────────────────────

export interface AcquireRequest {
  /** 이어 하려는 스레드. `undefined` 면 새 대화다. */
  sessionId?: string
  /** 지금 실을 잠금 `config` 의 지문(`codexToolLock().fingerprint`). */
  fingerprint: string
  transport: LoadTransport
  /** 새 대화 첫 턴 앞에 실어 보낼 지난 메시지 수(전송 장부 배선 전에는 0). */
  carried?: number
}

/** 연결 하나가 드는 판 — 표·메모리 장부를 여러 턴에 걸쳐 유지하고 적재 호출을 한 줄로 세운다. */
export class CodexThreadGuard {
  readonly table = new LoadTable()
  private memoryRows = new Map<string, CodexThreadRow>()
  /** 적재 호출을 한 줄로 세우는 꼬리(프로세스마다 하나). */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private store: ThreadStore | undefined) {}

  /** 프로세스가 새로 뜰 때 — 표와 메모리 장부를 함께 버린다(재기동·폐기 공통). */
  discard(): void {
    this.table.discard()
  }

  /** 적재 호출은 프로세스마다 한 줄로 선다 — 앞 호출의 결말이 난 뒤에 다음 것을 보낸다. */
  acquire(req: AcquireRequest): Promise<AcquireOutcome> {
    const run = this.tail.then(() => this.run(req), () => this.run(req))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** `turn/start` 응답을 받은 즉시 — 그 턴의 첫 알림을 처리하기 **전에** 부른다. */
  noteTurn(threadId: string, turnId: string, fingerprint: string): void {
    if (!threadId || !turnId) return
    this.remember(threadId, fingerprint, turnId)
    if (this.store && this.table.cell(threadId) === 'locked') {
      saveCodexThreads(this.store, rows => {
        const row = rows[threadId]
        if (!row) return { ...rows, [threadId]: codexThreadRow(fingerprint, [turnId]) }
        if (row.turns.includes(turnId)) return rows
        return { ...rows, [threadId]: codexThreadRow(row.fingerprint, [...row.turns, turnId]) }
      })
    }
  }

  /** 탐침(ephemeral) 스레드는 장부에 안 적고 표에만 불명으로 남긴다 — 이어 할 일이 없다. */
  noteProbe(threadId: string): void {
    if (!threadId) return
    this.table.markUnknown(threadId)
    this.table.clearPending()
  }

  /** 이 실행에서 원장에 더한 id — 시험·기록용. */
  turnsOf(threadId: string): string[] {
    return this.memoryRows.get(threadId)?.turns ?? []
  }

  private remember(threadId: string, fingerprint: string, turnId?: string): void {
    const row = this.memoryRows.get(threadId) ?? { fingerprint, turns: [] }
    this.memoryRows.set(threadId, codexThreadRow(row.fingerprint, turnId ? [...row.turns, turnId] : row.turns))
  }

  private rows(): Record<string, CodexThreadRow> {
    const disk = this.store ? loadCodexThreads(this.store) : {}
    return mergeRows(disk, this.memoryRows)
  }

  private run(req: AcquireRequest): Promise<AcquireOutcome> {
    return runAcquire(req, this.table, () => this.rows(), (threadId, fingerprint) => {
      this.remember(threadId, fingerprint)
      // `resume` 으로 줄이 생기는 길은 없다 — `startNew` 만 부르고, 그 안에서 `saveCodexThreads` 가
      // 이미 있는 줄을 덮지 않는다.
      if (this.store) {
        saveCodexThreads(this.store, rows => {
          if (rows[threadId]) return rows
          return { ...rows, [threadId]: codexThreadRow(fingerprint, []) }
        })
      }
    })
  }
}

/** 표를 밖에서 들지 않는 판 — 시험·단발 호출용. */
export function acquireThread(req: AcquireRequest): Promise<AcquireOutcome> {
  return runAcquire(req, new LoadTable(), () => ({}), () => {})
}

async function runAcquire(
  req: AcquireRequest,
  table: LoadTable,
  rows: () => Record<string, CodexThreadRow>,
  remember: (threadId: string, fingerprint: string) => void
): Promise<AcquireOutcome> {
  const { fingerprint, transport } = req
  const carried = req.carried ?? 0

  const refuse = (kind: 'other-window' | 'refused', reason: string, copy: string): AcquireOutcome =>
    ({ ok: false, kind, reason, studentCopy: copy })
  const newChat = (reason: NewChatReason): NewChatInfo => ({ reason, notice: newChatNotice(reason, carried) })

  /** 재기동 = 프로세스를 닫는다. 표·표식도 함께 사라진다. */
  const restart = async (): Promise<void> => {
    table.discard()
    await transport.restart().catch(() => {})
  }

  /** 새 스레드를 하나 열어 잠김까지 간다. 실패하면 재기동 1회 뒤 턴을 거부한다. */
  const startNew = async (): Promise<AcquireOutcome> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      // id 를 얻지 못하면 서버가 스레드를 만들었는지 알 수 없다 — 그 프로세스를 다시 쓰지 않는다.
      table.beginStart(fingerprint)
      let reply: LoadReply
      try {
        reply = await transport.start()
      } catch (e) {
        reply = { ok: false, kind: 'error', message: (e as Error)?.message ?? String(e) }
      }
      if (!reply.ok) {
        await restart()
        continue
      }
      // 결과 대조보다 **먼저** 불명으로 적고 표식을 내린다(전이표).
      table.markUnknown(reply.threadId)
      table.clearPending()
      const verified = await transport.verify(reply.threadId, reply.instructionSources)
      if (!verified.ok) {
        // id 는 불명인 채로 남긴다 — 같은 프로세스에서 그 id 로 resume 하는 길은 `restart` 뿐이다.
        await restart()
        continue
      }
      table.markLocked(reply.threadId, fingerprint)
      // 줄은 잠김이 된 뒤·첫 `turn/start` 전에 쓴다. 실패해도 이 실행은 메모리 장부로 이어진다.
      remember(reply.threadId, fingerprint)
      return { ok: true, threadId: reply.threadId, fingerprint }
    }
    // 마지막 실패에서 이미 그 프로세스를 닫았다 — 같은 프로세스를 두 번 닫지 않는다.
    return refuse('refused', 'not-locked', NEW_CHAT_REFUSAL_COPY)
  }

  if (!req.sessionId) return startNew()
  const sessionId = req.sessionId

  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = resumeGate(table.cell(sessionId), rows()[sessionId], fingerprint)
    if (gate.action === 'new-chat') {
      const outcome = await startNew()
      return outcome.ok ? { ...outcome, switched: newChat(gate.reason) } : outcome
    }
    if (gate.action === 'restart') {
      // 불명인 스레드로는 보내지 않는다 — 새 프로세스(빈 표)의 첫 적재로만 열린다.
      await restart()
      const after = resumeGate(table.cell(sessionId), rows()[sessionId], fingerprint)
      if (after.action === 'new-chat') {
        const outcome = await startNew()
        return outcome.ok ? { ...outcome, switched: newChat(after.reason) } : outcome
      }
      if (after.action === 'restart') continue
    }

    // ① 이번 적재 — 칸 없음이면 보내기 전에 불명으로 적는다.
    if (table.cell(sessionId) === 'none') table.markUnknown(sessionId)
    const wasLocked = table.cell(sessionId) === 'locked'

    let reply: LoadReply
    try {
      reply = await transport.resume(sessionId)
    } catch (e) {
      reply = { ok: false, kind: 'error', message: (e as Error)?.message ?? String(e) }
    }

    if (!reply.ok) {
      if (reply.kind === 'active-writer') {
        // 다른 프로세스가 쥐고 있다 — 재기동해도 같은 답이라 자동 복구를 타지 않는다(⑨·㉴).
        table.demote(sessionId)
        return refuse('other-window', 'active-writer', OTHER_WINDOW_COPY)
      }
      if (reply.kind === 'no-rollout') {
        // 턴 0인 갓 만든 스레드 — 디스크에 rollout 이 없어 resume 할 수 없다. 버리고 새로 연다.
        // 학생이 본 대화가 아직 없으므로(턴 0) '새 대화' 안내는 내지 않는다.
        await restart()
        return startNew()
      }
      if (wasLocked) table.demote(sessionId)
      await restart()
      continue
    }

    const checkId = reply.threadId
    if (checkId !== sessionId) table.markUnknown(checkId)
    const verified = await transport.verify(checkId, reply.instructionSources)
    if (!verified.ok) {
      if (wasLocked) table.demote(sessionId)
      else table.markUnknown(sessionId)
      await restart()
      continue
    }
    table.markLocked(checkId, fingerprint)
    // 응답 id 가 요청과 다르면(history 꼴 — 앱 경로에는 없다) 요청한 id 는 불명인 채 둔다.
    if (checkId !== sessionId) table.markUnknown(sessionId)

    // ③ 턴 원장 대조 — 앱이 열지 않은 턴이 끼어 있으면 적재는 잠김이지만 턴을 열지 않는다.
    const row = rows()[sessionId]
    const verdict = judgeTurns(reply.turns, row?.turns ?? [])
    if (verdict !== 'pass') {
      const outcome = await startNew()
      return outcome.ok ? { ...outcome, switched: newChat('d') } : outcome
    }
    return { ok: true, threadId: checkId, fingerprint }
  }
  // 마지막 실패에서 이미 그 프로세스를 닫았다.
  return refuse('refused', 'not-locked', RESUME_REFUSAL_COPY)
}
