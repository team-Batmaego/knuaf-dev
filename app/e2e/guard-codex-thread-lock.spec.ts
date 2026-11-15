/**
 * §10-21 — Codex 스레드 잠금(`codexThreadLock`)의 적재 표·장부·턴 원장·새 대화 판정.
 *
 * 전송(`thread/start`·`thread/resume`)은 시험이 갈아 끼운다 — 프로세스·모델 추론·학생 설정 없음.
 * 설계 §4.1-C: 적재 표는 "이번 적재"만, 장부는 "과거 턴 전부"를 말하고, 둘 중 하나라도
 * 잠김(같은 지문)이 아니면 그 스레드로 `turn/start` 를 보내지 않는다.
 */
import { test, expect, afterAll } from '@playwright/test'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexThreadGuard, LoadTable, acquireThread, judgeTurns, newChatNotice, resumeGate,
  NEW_CHAT_REFUSAL_COPY, OTHER_WINDOW_COPY, RESUME_REFUSAL_COPY,
  type LoadReply, type LoadTransport
} from '../src/main/chat/codexThreadLock'
import { codexThreadRow, loadCodexThreads, saveCodexThreads, type ThreadStore } from '../src/main/guard/store'

// ── 임시 폴더 ─────────────────────────────────────────────────────────────────

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})
function tempDir(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kd-thread-${tag}-`)))
  scratch.push(dir)
  return dir
}

const KEY = Buffer.from('thread-lock-test-key')
const F1 = 'fp-one'
const F2 = 'fp-two'

/** 논문 폴더 하나의 장부 자리. 폴더별로 갈리는지(ⓦ) 보려고 해시를 인자로 받는다. */
function storeOf(userData: string, folderHash = 'folder-a'): ThreadStore {
  return { userData, folderHash, key: KEY }
}

/** 장부에 줄을 미리 심는다(앱의 이전 실행이 남긴 것). */
function seed(store: ThreadStore, threadId: string, fingerprint: string, turns: string[] = []): void {
  const ok = saveCodexThreads(store, rows => ({ ...rows, [threadId]: codexThreadRow(fingerprint, turns) }))
  expect(ok).toBe(true)
}

// ── 가짜 전송 ─────────────────────────────────────────────────────────────────

interface Call {
  method: 'start' | 'resume' | 'verify' | 'restart'
  threadId?: string
  /** `resume` 에 실린 params — ㉲(`excludeTurns` 금지)를 여기서 본다 */
  params?: Record<string, unknown>
}

type Reply = LoadReply | Promise<LoadReply>

interface TransportOptions {
  start?: (n: number) => Reply
  resume?: (threadId: string, n: number) => Reply
  verify?: (threadId: string, sources: unknown, n: number) => { ok: boolean } | Promise<{ ok: boolean }>
  restart?: () => void | Promise<void>
  /** `resume` 에 넘기는 params — 기본은 `{threadId, cwd}` */
  resumeParams?: Record<string, unknown>
}

interface Fake extends LoadTransport {
  calls: Call[]
  methods: () => string[]
  counts: (method: Call['method']) => number
}

function fake(opts: TransportOptions = {}): Fake {
  const calls: Call[] = []
  let starts = 0
  let resumes = 0
  let verifies = 0
  const transport: Fake = {
    calls,
    methods: () => calls.map(c => c.method),
    counts: method => calls.filter(c => c.method === method).length,
    async start() {
      calls.push({ method: 'start' })
      return opts.start ? opts.start(starts++) : { ok: true, threadId: 't-new', instructionSources: [] }
    },
    async resume(threadId) {
      calls.push({ method: 'resume', threadId, params: opts.resumeParams ?? { threadId, cwd: '/paper' } })
      return opts.resume ? opts.resume(threadId, resumes++) : { ok: true, threadId, turns: [], instructionSources: [] }
    },
    async verify(threadId, sources) {
      calls.push({ method: 'verify', threadId })
      return opts.verify ? opts.verify(threadId, sources, verifies++) : { ok: true }
    },
    async restart() {
      calls.push({ method: 'restart' })
      if (opts.restart) await opts.restart()
    }
  }
  return transport
}

const ok = (threadId: string, turns: unknown = [], instructionSources: unknown = []): LoadReply =>
  ({ ok: true, threadId, turns, instructionSources })
const failed = (kind: 'error' | 'timeout' | 'no-id' | 'active-writer' | 'no-rollout'): LoadReply =>
  ({ ok: false, kind })

// ── 적재 표 전이(ⓛ·ⓚ) ────────────────────────────────────────────────────────

test('§10-21 ⓛ 적재 표는 올라가기만 한다 — 없음→불명→잠김, 잠김→불명, 지우는 길은 폐기뿐', () => {
  const table = new LoadTable()
  expect(table.cell('t-1')).toBe('none')

  table.markUnknown('t-1')
  expect(table.cell('t-1')).toBe('unknown')
  expect(table.fingerprintOf('t-1')).toBeNull()

  table.markLocked('t-1', F1)
  expect(table.cell('t-1')).toBe('locked')
  expect(table.fingerprintOf('t-1')).toBe(F1)

  // 불명으로 되돌리는 표시가 잠김을 내리지 않는다.
  table.markUnknown('t-1')
  expect(table.cell('t-1')).toBe('locked')

  // 잠김 → 불명은 있다(재적재가 어긋났을 때).
  table.demote('t-1')
  expect(table.cell('t-1')).toBe('unknown')
  expect(table.fingerprintOf('t-1')).toBeNull()

  // 불명 → 잠김은 결과 대조를 통과했을 때뿐이다.
  table.markLocked('t-1', F1)
  expect(table.fingerprintOf('t-1')).toBe(F1)

  // 표에 항목을 지우는 공개 경로는 프로세스 폐기뿐이다.
  table.discard()
  expect(table.cell('t-1')).toBe('none')
})

test('§10-21 ⓓ 프로세스가 새로 뜨면 표가 비어 있고 디스크에는 아무것도 남지 않는다', async () => {
  const userData = tempDir('fresh')
  const store = storeOf(userData)
  const guard = new CodexThreadGuard(store)
  expect(guard.table.cell('t-1')).toBe('none')

  const t = fake({ resume: id => ok(id) })
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  // 줄이 없는 스레드라 새 대화다 — 표는 디스크로 가지 않고, 장부에 새 줄 하나만 남는다.
  expect(out.ok).toBe(true)
  expect(out.ok && out.switched?.reason).toBe('a')
  expect(loadCodexThreads(store)['t-1']).toBeUndefined()

  // 새 프로세스 = 빈 표. 디스크에 남은 것은 장부 한 줄뿐이고 표의 흔적은 없다.
  const fresh = new CodexThreadGuard(store)
  expect(fresh.table.cell('t-new')).toBe('none')
  expect(Object.keys(loadCodexThreads(store))).toEqual(['t-new'])
  expect(readdirSync(join(userData, 'guard', 'folder-a'))).toEqual(['state.json'])
})

// ── 보내기 전 판정(ⓐ·ⓑ·ⓜ) ───────────────────────────────────────────────────

test('§10-21 ⓐ 지문이 바뀐 스레드는 resume 도 turn 도 나가지 않고 새 대화로 바뀐다', async () => {
  const store = storeOf(tempDir('fp-changed'))
  seed(store, 't-1', F1)
  const guard = new CodexThreadGuard(store)
  const t = fake()

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F2, transport: t })
  expect(out.ok && out.switched?.reason).toBe('b')
  expect(out.ok && out.threadId).toBe('t-new')
  // 옛 id 로는 아무 호출도 나가지 않는다.
  expect(t.calls.some(c => c.threadId === 't-1')).toBe(false)
  expect(t.counts('resume')).toBe(0)
  expect(t.counts('restart')).toBe(0)
  expect(out.ok && out.switched?.notice).toContain('이 대화를 시작한 뒤에 이 컴퓨터의 Codex 도구 설정이 바뀌었어요.')

  // 재기동해도 그 스레드로는 열리지 않는다 — 새 프로세스의 판정도 같다.
  const next = new CodexThreadGuard(store)
  const t2 = fake()
  const again = await next.acquire({ sessionId: 't-1', fingerprint: F2, transport: t2 })
  expect(again.ok && again.switched?.reason).toBe('b')
  expect(t2.counts('resume')).toBe(0)
})

test('§10-21 ⓑ resume 이 시간 초과된 스레드는 이 프로세스에서 다시 보내지 않고 재기동 뒤 첫 적재로만 열린다', async () => {
  const store = storeOf(tempDir('timeout'))
  seed(store, 't-1', F1)
  const guard = new CodexThreadGuard(store)
  let restarts = 0
  const t = fake({
    resume: (_id, n) => (n === 0 ? failed('timeout') : ok('t-1')),
    restart: () => { restarts++ }
  })

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(true)
  expect(restarts).toBe(1)
  // 시간 초과한 그 프로세스에서는 다시 보내지 않는다 — 둘째 resume 은 재기동 뒤 새 프로세스의
  // 첫 적재다(빈 표 = `config` 가 먹는 자리). 그래서 resume 은 정확히 두 번이다.
  expect(t.calls.filter(c => c.method === 'resume').length).toBe(2)

  expect(guard.table.cell('t-1')).toBe('locked')
  expect(guard.table.fingerprintOf('t-1')).toBe(F1)
})

test('§10-21 ⓜ 잠김이 아니거나 지문이 다른 스레드는 턴을 열 수 있는 결말을 받지 못한다', async () => {
  const store = storeOf(tempDir('no-turn'))
  seed(store, 't-1', F1)

  // 장부 줄이 없다 — 새 대화.
  const missing = fake()
  const a = await acquireThread({ sessionId: 't-9', fingerprint: F1, transport: missing })
  expect(a.ok && a.switched?.reason).toBe('a')
  expect(missing.counts('resume')).toBe(0)

  // 지문이 다르다 — 새 대화.
  const guard = new CodexThreadGuard(store)
  const b = await guard.acquire({ sessionId: 't-1', fingerprint: F2, transport: fake() })
  expect(b.ok && b.switched?.reason).toBe('b')

  // 줄이 있는데 결과 대조가 어긋난다 — 턴을 열 수 있는 결말이 아니다.
  const c = await new CodexThreadGuard(store).acquire({
    sessionId: 't-1', fingerprint: F1, transport: fake({ verify: () => ({ ok: false }) })
  })
  expect(c.ok).toBe(false)
  expect(c.ok === false && c.studentCopy).toBe(RESUME_REFUSAL_COPY)
})

// ── thread/start 미결(ⓕ·ⓖ·ⓗ·ⓘ·ⓙ·ⓚ) ─────────────────────────────────────────

test('§10-21 ⓕ thread/start 가 응답 없이 끝나면 그 프로세스를 버리고, 그 프로세스로 어떤 호출도 더 보내지 않는다', async () => {
  const t = fake({ start: () => failed('timeout') })
  const out = await acquireThread({ fingerprint: F1, transport: t })
  expect(out.ok).toBe(false)
  expect(out.ok === false && out.studentCopy).toBe(NEW_CHAT_REFUSAL_COPY)
  // 시작 두 번(재기동 1회) 뒤에는 그만둔다 — resume 은 한 번도 안 나간다.
  expect(t.counts('start')).toBe(2)
  expect(t.counts('resume')).toBe(0)
  expect(t.counts('restart')).toBe(2)
})

test('§10-21 ⓖ thread/start 오류·id 없음·비문자열 id 는 모두 프로세스 폐기다', async () => {
  for (const reply of [failed('error'), failed('no-id')]) {
    const t = fake({ start: () => reply })
    const out = await acquireThread({ fingerprint: F1, transport: t })
    expect(out.ok).toBe(false)
    expect(t.counts('start')).toBe(2)
    expect(t.counts('verify')).toBe(0)
  }
})

test('§10-21 ⓗ id 가 왔지만 대조가 어긋나면 그 id 는 불명으로 남고, 같은 프로세스에서 resume 하지 않는다', async () => {
  let guard: CodexThreadGuard | undefined
  const atVerify: Array<{ cell: string; fp: string | null }> = []
  const t = fake({
    start: () => ok('t-9'),
    verify: () => {
      // 대조 직전: id 는 이미 표에 있고 잠김이 아니다('없음'으로 돌아가지 않는다).
      atVerify.push({ cell: guard?.table.cell('t-9') ?? 'gone', fp: guard?.table.fingerprintOf('t-9') ?? null })
      return { ok: false }
    }
  })
  guard = new CodexThreadGuard(undefined)

  const out = await guard.acquire({ fingerprint: F1, transport: t })
  expect(out.ok).toBe(false)
  expect(out.ok === false && out.studentCopy).toBe(NEW_CHAT_REFUSAL_COPY)
  expect(atVerify).toEqual([{ cell: 'unknown', fp: null }, { cell: 'unknown', fp: null }])
  // 그 id 로 resume 하는 요청은 나가지 않는다 — 재기동이 먼저다.
  expect(t.counts('resume')).toBe(0)
  expect(t.counts('start')).toBe(2)
  expect(t.counts('restart')).toBe(2)
})

test('§10-21 ⓚ id 가 온 직후·대조 전에 표를 읽으면 불명이다', async () => {
  let guard: CodexThreadGuard | undefined
  let atVerify: { cell: string; fp: string | null; pending: string | null } | null = null
  const t = fake({
    start: () => ok('t-5'),
    verify: () => {
      if (!guard) throw new Error('판이 아직 없다')
      atVerify = { cell: guard.table.cell('t-5'), fp: guard.table.fingerprintOf('t-5'), pending: guard.table.pendingFingerprint() }
      return { ok: true }
    }
  })
  guard = new CodexThreadGuard(undefined)
  const out = await guard.acquire({ fingerprint: F1, transport: t })
  expect(out.ok && out.threadId).toBe('t-5')
  expect(guard).toBeDefined()
  expect(atVerify).toEqual({ cell: 'unknown', fp: null, pending: null })
  // 대조를 통과한 뒤에야 잠김이다.
  expect(guard.table.cell('t-5')).toBe('locked')
  expect(guard.table.fingerprintOf('t-5')).toBe(F1)
})

test('§10-21 ⓘ 미결 시작이 남은 동안 들어온 다른 적재는 나가지 않고 기다린다', async () => {
  const gate = Promise.withResolvers<void>()
  let started = false
  const t = fake({
    start: async () => {
      if (!started) {
        started = true
        await gate.promise
        return ok('t-a')
      }
      return ok('t-b')
    }
  })
  const guard = new CodexThreadGuard(undefined)
  const first = guard.acquire({ fingerprint: F1, transport: t })
  const second = guard.acquire({ sessionId: 't-b', fingerprint: F1, transport: t })

  // 첫 적재가 미결인 동안 둘째는 전송을 타지 않는다(표식이 하나뿐이라 겹치지도 않는다).
  await Promise.resolve()
  expect(t.counts('start')).toBe(1)
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  expect(a.ok && a.threadId).toBe('t-a')
  // 둘째는 장부에 줄이 없는 스레드라 새 대화로 바뀐다 — 미결 뒤에 판정한다.
  expect(b.ok && b.switched?.reason).toBe('a')
  expect(t.counts('start')).toBe(2)
})

test('§10-21 ⓙ start 가 시간 초과된 뒤 다른 길로 안 id 의 resume 은 새 프로세스의 첫 적재로만 나간다', async () => {
  const order: string[] = []
  const t = fake({
    start: () => { order.push('start'); return failed('timeout') },
    resume: (id) => { order.push('resume'); return ok(id) },
    verify: () => { order.push('verify'); return { ok: true } },
    restart: () => { order.push('restart') }
  })
  const store = storeOf(tempDir('learned-id'))
  seed(store, 't-listed', F1)
  const guard = new CodexThreadGuard(store)

  // ① 시작이 시간 초과되면 그 프로세스는 버려진다(두 번 다).
  const refused = await guard.acquire({ fingerprint: F1, transport: t })
  expect(refused.ok).toBe(false)
  expect(order).toEqual(['start', 'restart', 'start', 'restart'])

  // ② 다른 길로 안 id 로 이어 하면 — 이미 새 프로세스의 첫 적재다. 버린 프로세스로는 아무것도 안 나갔다.
  const out = await guard.acquire({ sessionId: 't-listed', fingerprint: F1, transport: t })
  expect(out.ok && out.threadId).toBe('t-listed')
  expect(order).toEqual(['start', 'restart', 'start', 'restart', 'resume', 'verify'])
})

// ── 재기동 1회(ⓒ·ⓔ) ─────────────────────────────────────────────────────────

test('§10-21 ⓒ 재기동 뒤에도 대조가 어긋나면 턴을 거부하고 그 프로세스도 닫는다', async () => {
  const store = storeOf(tempDir('still-bad'))
  seed(store, 't-1', F1)
  const t = fake({ resume: id => ok(id), verify: () => ({ ok: false }) })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(false)
  expect(out.ok === false && out.kind).toBe('refused')
  expect(out.ok === false && out.studentCopy).toBe(RESUME_REFUSAL_COPY)
  expect(t.counts('resume')).toBe(2)
  expect(t.counts('restart')).toBe(2)
  // 장부는 그대로다 — 실패한 적재가 줄을 만들지 않는다(ⓧ).
  expect(loadCodexThreads(store)['t-1']?.fingerprint).toBe(F1)
})

test('§10-21 ⓔ 지문이 같은 둘째 resume 은 재기동 없이 열린다', async () => {
  const store = storeOf(tempDir('second-resume'))
  seed(store, 't-1', F1)
  const t = fake({ resume: id => ok(id) })
  const guard = new CodexThreadGuard(store)

  const first = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  const second = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(first.ok && second.ok).toBe(true)
  expect(t.counts('resume')).toBe(2)
  expect(t.counts('restart')).toBe(0)
  expect(guard.table.cell('t-1')).toBe('locked')
})

// ── 플러그인 잠금의 성공 조건(⑥ ⓝ·ⓞ·ⓟ) ────────────────────────────────────

test('§10-21 ⓝ 플러그인 잠금의 근거는 적재 기록 그 자체다 — 목록 RPC 가 켜졌다고 해도 잠김은 잠김이다', async () => {
  const store = storeOf(tempDir('plugin-record'))
  seed(store, 't-1', F1)
  const t = fake({ resume: id => ok(id), verify: () => ({ ok: true }) })
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(true)
  expect(guard.table.cell('t-1')).toBe('locked')
  // 판정에 쓴 호출은 적재·대조뿐이다 — `skills/list`·`hooks/list`·`disabledPluginIds` 는 없다.
  expect(t.methods()).toEqual(['resume', 'verify'])
})

test('§10-21 ⓞ 목록 RPC 는 잠금 판정에 쓰이지 않는다 — 지문이 다르면 목록이 전부 꺼져 있어도 새 대화다', async () => {
  const store = storeOf(tempDir('list-never'))
  seed(store, 't-1', F1)
  const t = fake({
    resume: id => ok(id),
    // 대조는 늘 통과한다고 답하는 가짜다. 그래도 지문이 다르면 열리지 않는다.
    verify: () => ({ ok: true })
  })
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F2, transport: t })
  expect(out.ok && out.switched?.reason).toBe('b')
  expect(t.methods()).toEqual(['start', 'verify'])
})

test('§10-21 ⓟ 앱은 훅 신뢰(hooks.state)를 읽지도 쓰지도 않는다 — 적재·턴 어느 쪽도 CODEX_HOME 을 건드리지 않는다', async () => {
  const userData = tempDir('hooks-state')
  const codexHome = tempDir('codex-home')
  const configFile = join(codexHome, 'config.toml')
  writeFileSync(configFile, '[plugins.P]\nenabled = true\n')
  const before = readdirSync(codexHome).sort()

  const store = storeOf(userData)
  seed(store, 't-1', F1)
  const guard = new CodexThreadGuard(store)
  const t = fake({ resume: id => ok(id, [{ id: 'u-1' }]) })
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(true)
  guard.noteTurn('t-1', 'u-1', F1)

  expect(readdirSync(codexHome).sort()).toEqual(before)
  // 앱이 쓴 것은 보관본(논문 폴더 밖)뿐이다.
  expect(readdirSync(userData)).toEqual(['guard'])
})

// ── 오염 스레드(ⓠ·ⓡ·ⓢ·ⓣ·ⓤ·ⓥ·ⓦ·ⓧ·ⓨ) ──────────────────────────────────

test('§10-21 ⓠ 잠금 없이 돈 1턴 스레드(장부 줄 없음)는 resume 없이 새 대화가 되고 옛 본문을 재생하지 않는다', async () => {
  const store = storeOf(tempDir('unlocked-thread'))
  const t = fake()
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-old', fingerprint: F1, transport: t })

  expect(out.ok && out.switched?.reason).toBe('a')
  expect(out.ok && out.threadId).toBe('t-new')
  expect(t.counts('resume')).toBe(0)
  expect(out.ok && out.switched?.notice).toContain('이 대화는 앱이 바깥 도구(플러그인 같은 것)를 잠그기 전에 시작한 대화예요.')
})

test('§10-21 ⓡ 전송 장부가 생기기 전(v0.6.2) 대화는 이월 없이 새 대화가 된다', async () => {
  const store = storeOf(tempDir('legacy'))
  const t = fake()
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-v062', fingerprint: F1, transport: t })

  expect(out.ok && out.switched?.reason).toBe('a')
  const notice = out.ok ? out.switched!.notice : ''
  expect(notice).toContain('도우미는 지난 대화를 기억하지 못해요. 하던 일이 있으면 한 줄로 다시 말해 주세요.')
  expect(notice).not.toContain('참고하라고 함께 넘겼어요')
})

test('§10-21 ⓢ 이월은 학생 글만 10개·4,000자까지 — 2단계(전송 장부 배선 전)에는 늘 없음이다', () => {
  // 2단계는 이월 0 이다. 4단계에서 전송 장부가 붙으면 같은 문구에 개수가 실린다.
  expect(newChatNotice('b', 0)).not.toContain('함께 넘겼어요')
  const carried = newChatNotice('b', 3)
  expect(carried).toContain('대신 앞에서 보내신 메시지 3개를 참고하라고 함께 넘겼어요.')
  expect(carried).toContain('이 대화를 시작한 뒤에 이 컴퓨터의 Codex 도구 설정이 바뀌었어요.')
  // 이월 줄 말고는 두 글이 같다.
  expect(carried.split('\n').slice(0, 5)).toEqual(newChatNotice('b', 0).split('\n').slice(0, 5))
})

test('§10-21 ⓣ 장부 줄이 있고 지문이 같으면 새 프로세스의 첫 적재로 같은 스레드가 열린다', async () => {
  const store = storeOf(tempDir('same-thread'))
  seed(store, 't-1', F1)
  const t = fake({ resume: id => ok(id) })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok && out.threadId).toBe('t-1')
  expect(out.ok && out.switched).toBeUndefined()
  expect(t.counts('start')).toBe(0)
})

test('§10-21 ⓤ 장부 쓰기가 실패해도 그 실행은 이어지고, 앱을 다시 켜면 새 대화다', async () => {
  const userData = tempDir('write-fail')
  // 열쇠가 없으면 디스크 장부를 믿지 않는다 — 쓰기 실패와 같은 결말이다.
  const store: ThreadStore = { userData, folderHash: 'folder-a', key: null }
  const guard = new CodexThreadGuard(store)
  const t = fake()

  const out = await guard.acquire({ fingerprint: F1, transport: t })
  expect(out.ok).toBe(true)
  const threadId = out.ok ? out.threadId : ''
  // 이 실행에서는 메모리 장부로 이어진다.
  guard.noteTurn(threadId, 'u-1', F1)
  expect(guard.turnsOf(threadId)).toEqual(['u-1'])
  const again = await guard.acquire({ sessionId: threadId, fingerprint: F1, transport: t })
  expect(again.ok && again.threadId).toBe(threadId)
  expect(t.counts('resume')).toBe(1)

  // 앱을 다시 켜면(새 프로세스) 그 줄은 없다 — 새 대화.
  const next = new CodexThreadGuard(store)
  const after = await next.acquire({ sessionId: threadId, fingerprint: F1, transport: fake() })
  expect(after.ok && after.switched?.reason).toBe('a')
})

test('§10-21 ⓥ 무결성 표식이 안 맞으면 디스크 장부를 믿지 않는다 — 모두 새 대화가 된다', async () => {
  const userData = tempDir('integrity')
  const good = storeOf(userData)
  seed(good, 't-1', F1)

  // 다른 열쇠로 읽으면 표식이 안 맞아 빈 장부다.
  const wrong: ThreadStore = { userData, folderHash: 'folder-a', key: Buffer.from('another-key') }
  expect(loadCodexThreads(wrong)).toEqual({})
  const t = fake()
  const guard = new CodexThreadGuard(wrong)
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok && out.switched?.reason).toBe('a')
  expect(t.counts('resume')).toBe(0)
})

test('§10-21 ⓦ 다른 폴더의 깨끗한 id 로 바꿔 넣어도 이 폴더의 장부에 없으면 새 대화다', async () => {
  const userData = tempDir('swapped-id')
  const otherFolder = storeOf(userData, 'folder-b')
  seed(otherFolder, 't-clean', F1)

  const mine = storeOf(userData, 'folder-a')
  expect(loadCodexThreads(mine)).toEqual({})
  const t = fake()
  const guard = new CodexThreadGuard(mine)
  const out = await guard.acquire({ sessionId: 't-clean', fingerprint: F1, transport: t })
  expect(out.ok && out.switched?.reason).toBe('a')
  expect(t.counts('resume')).toBe(0)
  // 남의 폴더 장부는 그대로다.
  expect(loadCodexThreads(otherFolder)['t-clean']?.fingerprint).toBe(F1)
})

test('§10-21 ⓧ resume 으로 장부 줄이 생기지 않는다 — 줄은 앱이 그 스레드를 만들 때만 생긴다', async () => {
  const store = storeOf(tempDir('no-row-from-resume'))
  seed(store, 't-1', F1)
  const t = fake({ resume: id => ok(id) })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(true)
  // 이어 하기는 원장을 늘리지도 않는다.
  expect(loadCodexThreads(store)).toEqual({ 't-1': { fingerprint: F1, turns: [] } })
})

test('§10-21 ⓨ 새 대화로 바뀌면 옛 id 로는 아무 호출도 안 나가고 새 줄이 같은 지문으로 생긴다', async () => {
  const store = storeOf(tempDir('switch'))
  seed(store, 't-1', F1)
  const t = fake({ start: () => ok('t-fresh') })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F2, transport: t })
  expect(out.ok && out.threadId).toBe('t-fresh')
  expect(t.calls.filter(c => c.threadId === 't-1')).toEqual([])
  const rows = loadCodexThreads(store)
  expect(rows['t-fresh']).toEqual({ fingerprint: F2, turns: [] })
  // 옛 줄은 지워지지 않는다(지우는 것은 닫는 방향이지만, 앱은 남의 기록을 지우지 않는다).
  expect(rows['t-1']?.fingerprint).toBe(F1)
})

// ── 턴 원장(ⓩ·㉮·㉯·㉰·㉱·㉲·㉳·㉴·㉵) ───────────────────────────────────

test('§10-21 ⓩ turn/start 응답을 받은 즉시 원장에 적고, 같은 id 가 겹쳐 와도 한 줄이다', async () => {
  const store = storeOf(tempDir('turn-ledger'))
  seed(store, 't-1', F1)
  const guard = new CodexThreadGuard(store)
  await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: fake({ resume: id => ok(id) }) })

  guard.noteTurn('t-1', 'u-1', F1)
  expect(loadCodexThreads(store)['t-1']?.turns).toEqual(['u-1'])
  // 겹친 시작이 같은 id 를 줘도 원장은 한 줄이다.
  guard.noteTurn('t-1', 'u-1', F1)
  expect(loadCodexThreads(store)['t-1']?.turns).toEqual(['u-1'])
  guard.noteTurn('t-1', 'u-2', F1)
  expect(loadCodexThreads(store)['t-1']?.turns).toEqual(['u-1', 'u-2'])
})

test('§10-21 ㉮ 앱이 열지 않은 턴이 끼어 있으면 resume 은 나가지만 턴은 열지 않고 새 대화로 바뀐다', async () => {
  for (const status of ['completed', 'interrupted', 'failed']) {
    const store = storeOf(tempDir(`polluted-${status}`))
    seed(store, 't-1', F1, ['u-1'])
    const t = fake({
      resume: id => ok(id, [{ id: 'u-1', status }, { id: 'outside', status }]),
      start: () => ok('t-fresh')
    })
    const guard = new CodexThreadGuard(store)
    const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })

    expect(out.ok && out.switched?.reason).toBe('d')
    expect(out.ok && out.threadId).toBe('t-fresh')
    expect(out.ok && out.switched?.notice).toContain('이 대화에 앱이 열지 않은 기록이 끼어 있어요.')
    expect(t.counts('resume')).toBe(1)
  }
})

test('§10-21 ㉯ 중단·실패·앱이 꺼진 턴은 원장에 있으면 같은 스레드를 이어 쓴다', async () => {
  const store = storeOf(tempDir('known-turns'))
  seed(store, 't-1', F1, ['u-1', 'u-2'])
  const t = fake({ resume: id => ok(id, [{ id: 'u-1', status: 'interrupted' }, { id: 'u-2', status: 'failed' }]) })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok && out.threadId).toBe('t-1')
  expect(out.ok && out.switched).toBeUndefined()
  expect(t.counts('start')).toBe(0)
})

test('§10-21 ㉰ 재기동은 원장을 다시 세우지 않고, resume 만으로는 원장이 늘지 않는다', async () => {
  const store = storeOf(tempDir('no-rebaseline'))
  seed(store, 't-1', F1, ['u-1'])
  let restarts = 0
  const t = fake({
    resume: (_id, n) => (n === 0 ? failed('timeout') : ok('t-1', [{ id: 'u-1' }])),
    restart: () => { restarts++ }
  })
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })

  expect(out.ok).toBe(true)
  expect(restarts).toBe(1)
  expect(loadCodexThreads(store)['t-1']?.turns).toEqual(['u-1'])
})

test('§10-21 ㉱ 턴이 만들어진 뒤 응답을 적기 전에 앱이 꺼진 스레드는 새 대화다', async () => {
  const store = storeOf(tempDir('crash-before-record'))
  // 앱이 꺼져 원장에 못 적은 턴 하나 — 서버 기록에는 남아 있다.
  seed(store, 't-1', F1, [])
  const t = fake({
    resume: id => ok(id, [{ id: 'u-crashed' }]),
    start: () => ok('t-fresh')
  })
  const guard = new CodexThreadGuard(store)
  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok && out.switched?.reason).toBe('d')
  expect(t.counts('start')).toBe(1)
})

test('§10-21 ㉲ resume 본문에 excludeTurns·initialTurnsPage 를 싣지 않고, turns 모양이 이상하면 새 대화다', async () => {
  const store = storeOf(tempDir('no-exclude'))
  seed(store, 't-1', F1, ['u-1'])
  const t = fake({ resume: id => ok(id, [{ id: 'u-1' }]) })
  const guard = new CodexThreadGuard(store)
  await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })

  const resumeCalls = t.calls.filter(c => c.method === 'resume')
  expect(resumeCalls.length).toBe(1)
  for (const call of resumeCalls) {
    expect(call.params && 'excludeTurns' in call.params).toBe(false)
    expect(call.params && 'initialTurnsPage' in call.params).toBe(false)
    // 앱의 resume 은 rollout 꼴이다 — threadId 와 cwd 만.
    expect(Object.keys(call.params ?? {}).sort()).toEqual(['cwd', 'threadId'])
  }

  // `thread.turns` 가 배열이 아니거나 id 없는 항목이 있으면 판정 불가 = 새 대화.
  for (const turns of [undefined, null, 'nope', [{}], [{ id: 5 }], [{ id: '' }]]) {
    expect(judgeTurns(turns, ['u-1'])).toBe('unjudgeable')
    const s = storeOf(tempDir('bad-turns'))
    seed(s, 't-2', F1, ['u-1'])
    const reply: LoadReply = { ok: true, threadId: 't-2', turns, instructionSources: [] }
    const bad = fake({ resume: () => reply, start: () => ok('t-fresh') })
    const out = await new CodexThreadGuard(s).acquire({ sessionId: 't-2', fingerprint: F1, transport: bad })
    expect(out.ok && out.switched?.reason).toBe('d')
  }
  // 원장에 없는 id 만 오염이고, 빈 목록은 통과다.
  expect(judgeTurns([], ['u-1'])).toBe('pass')
  expect(judgeTurns([{ id: 'u-9' }], ['u-1'])).toBe('polluted')
})

test('§10-21 ㉳ thread/turns/list 경로는 이 단계에 배선되지 않았다 — 어떤 적재도 그 RPC 를 부르지 않는다', async () => {
  const store = storeOf(tempDir('no-turns-list'))
  seed(store, 't-1', F1, ['u-1'])
  const t = fake({ resume: id => ok(id, [{ id: 'u-1' }]) })
  const guard = new CodexThreadGuard(store)
  await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(t.methods()).not.toContain('thread/turns/list')
  // 판정 근거는 resume 응답의 thread.turns 하나뿐이다.
  expect(t.methods()).toEqual(['resume', 'verify'])
})

test('§10-21 ㉴ 다른 창이 쥐고 있으면 재전송·재기동·새 대화 없이 안내만 낸다', async () => {
  const store = storeOf(tempDir('active-writer'))
  seed(store, 't-1', F1, ['u-1'])
  const t = fake({ resume: () => failed('active-writer') })
  const guard = new CodexThreadGuard(store)

  const out = await guard.acquire({ sessionId: 't-1', fingerprint: F1, transport: t })
  expect(out.ok).toBe(false)
  expect(out.ok === false && out.kind).toBe('other-window')
  expect(out.ok === false && out.studentCopy).toBe(OTHER_WINDOW_COPY)
  expect(t.counts('resume')).toBe(1)
  expect(t.counts('start')).toBe(0)
  expect(t.counts('restart')).toBe(0)
  // 칸은 불명인 채로 남는다.
  expect(guard.table.cell('t-1')).toBe('unknown')

  // 학생이 다시 보내면 새 프로세스에서 한 번만 적재한다.
  const next = new CodexThreadGuard(store)
  const again = fake({ resume: id => ok(id, [{ id: 'u-1' }]) })
  const retry = await next.acquire({ sessionId: 't-1', fingerprint: F1, transport: again })
  expect(retry.ok).toBe(true)
  expect(again.counts('resume')).toBe(1)
})

test('§10-21 ㉵ 장부 쓰기가 실패한 턴도 그 실행에서는 이어지고, 다시 켜면 새 대화다', async () => {
  const userData = tempDir('turn-write-fail')
  const store: ThreadStore = { userData, folderHash: 'folder-a', key: null }
  const guard = new CodexThreadGuard(store)
  const t = fake()
  const out = await guard.acquire({ fingerprint: F1, transport: t })
  const threadId = out.ok ? out.threadId : ''
  guard.noteTurn(threadId, 'u-1', F1)
  guard.noteTurn(threadId, 'u-2', F1)

  // 이 실행: 원장이 메모리에 있어 같은 스레드를 이어 쓴다.
  const again = await guard.acquire({ sessionId: threadId, fingerprint: F1, transport: t })
  expect(again.ok && again.threadId).toBe(threadId)
  expect(guard.turnsOf(threadId)).toEqual(['u-1', 'u-2'])

  // 다시 켜면: 줄도 원장도 없다.
  const next = new CodexThreadGuard(store)
  const after = await next.acquire({ sessionId: threadId, fingerprint: F1, transport: fake() })
  expect(after.ok && after.switched?.reason).toBe('a')
})

// ── 판정 함수 직접 확인 ──────────────────────────────────────────────────────

test('§10-21 resumeGate — 칸과 장부 줄의 네 조합이 전이표와 같다', () => {
  const row = codexThreadRow(F1, [])
  expect(resumeGate('none', undefined, F1)).toEqual({ action: 'new-chat', reason: 'a' })
  expect(resumeGate('locked', row, F2)).toEqual({ action: 'new-chat', reason: 'b' })
  expect(resumeGate('none', row, F1)).toEqual({ action: 'send' })
  expect(resumeGate('unknown', row, F1)).toEqual({ action: 'restart' })
  expect(resumeGate('locked', row, F1)).toEqual({ action: 'send' })
})
