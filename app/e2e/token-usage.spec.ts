/**
 * 일반 대화의 캐시 토큰 기록 (v0.6.3).
 *
 * 발주 완료 조건 넷과 검토 CT-01~03 반례를 **앱 코드로** 잠근다:
 *   ① Claude `result.usage` → 기록 줄에 cache read/write 숫자
 *   ② Codex `thread/tokenUsage/updated` 의 last/total 을 더하지 않고 그대로 기록
 *   ③ 기록 쓰기가 실패·대기해도 대화는 정상 완료 (CT-01: FIFO 반례 포함)
 *   ④ 학생 글이 기록에 남지 않음(숫자·식별자만)
 *   CT-02: 기록의 model/effort 는 그 턴에 실제로 적용된 선택값
 *   CT-03: 연결을 다시 만들어도 요청 순번이 이어지고 첫 요청 표시가 중복되지 않음
 *
 * 실제 `ClaudeConnection`·`CodexConnection` 을 가짜 CLI 로 돌린다 — 로그인·네트워크·학생 자료 없음.
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection } from '../src/main/chat/claude'
import { CodexConnection } from '../src/main/chat/codex'
import { findExecutable } from '../src/main/agent'
import { appendTokenRecord, flushTokenRecords } from '../src/main/chat/jobs/token-log'
import type { AgentEvents } from '../src/main/chat/contracts'
import type { ModelChoice } from '../src/shared/chat'
import { fakeCodexEnv } from './fixtures/fake-codex'

/** 시험이 만든 임시 폴더는 끝나면 지운다 — 기록 파일이 남지 않게. */
const scratch: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
test.afterEach(async () => {
  await flushTokenRecords()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubEvents(messages: string[] = []): AgentEvents {
  return { message: (_id, text) => messages.push(text), permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }
}

/** 실제 가짜 `claude` CLI — `run` 이 SDK 를 거쳐 이 프로세스와 줄 단위로 대화한다. */
function fakeClaude(root: string, extra: Record<string, string> = {}) {
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  return { binary, env: { ...process.env, W1_QUERY_LOG: join(root, 'query.jsonl'), ...extra } }
}

function claudeConn(root: string, env: Record<string, string | undefined>, binary: string, choice: () => ModelChoice | null = () => null, chosen?: () => boolean) {
  return new ClaudeConnection({ binary, root, skill: '', openExternal: async () => {}, env, modelChoice: choice, modelChosen: chosen })
}

function claudeRecords(root: string): Record<string, any>[] {
  try {
    const text = readFileSync(join(root, '.knuaf-gui', 'token-usage-claude.jsonl'), 'utf-8').trim()
    return text ? text.split('\n').map(line => JSON.parse(line)) : []
  } catch { return [] }
}

function codexRecords(root: string): Record<string, any>[] {
  try {
    const text = readFileSync(join(root, '.knuaf-gui', 'token-usage-codex.jsonl'), 'utf-8').trim()
    return text ? text.split('\n').map(line => JSON.parse(line)) : []
  } catch { return [] }
}

/** 가짜 Codex 서버 기준의 사용량 알림 하나 — 실제 스키마(`last`/`total`) 그대로. */
function tokenUsage(threadId: string, last: Record<string, number>, total: Record<string, number>) {
  return { method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'u-fake', tokenUsage: { last, total, modelContextWindow: 200_000 } } }
}

const USAGE_SMALL = { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheWriteInputTokens: 1, totalTokens: 15 },
  total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheWriteInputTokens: 1, totalTokens: 15 } }

/** 가짜 Codex 를 붙인 연결. 스킬 설치·PATH 탐색은 `model-chip` 시험과 같은 실제 경로다. */
function codexRoot(prefix: string): string {
  const root = tempDir(prefix)
  mkdirSync(join(root, '.agents', 'skills', 'knuaf-dev'), { recursive: true })
  writeFileSync(join(root, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'), '# test skill\n')
  return root
}

function codexEnv(root: string, extra: Record<string, string>) {
  return { ...process.env, ...fakeCodexEnv(join(root, 'bin'), extra) }
}

function codexConn(root: string, env: Record<string, string | undefined>, choice: () => ModelChoice | null = () => null, chosen?: () => boolean) {
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  return new CodexConnection({
    binary, root, skill: join(root, '.agents', 'skills', 'knuaf-dev'), env, openExternal: async () => {},
    modelChoice: choice, ...(chosen ? { modelChosen: chosen } : {})
  })
}

test('① Claude result.usage 의 cache read/write 숫자가 대화별 줄로 남는다', async () => {
  const root = tempDir('token-claude-')
  const { binary, env } = fakeClaude(root, {
    KNUAF_CLAUDE_MODEL: 'sonnet',
    KNUAF_CLAUDE_EFFORT: 'high',
    W1_QUERY_USAGE: JSON.stringify({
      input_tokens: 120, output_tokens: 30,
      cache_read_input_tokens: 45, cache_creation_input_tokens: 12
    })
  })
  const conn = claudeConn(root, env, binary)
  try {
    await conn.run('시험용 한 턴', undefined, stubEvents())
  } finally { await conn.stop() }
  await flushTokenRecords()

  const [record] = claudeRecords(root)
  expect(record).toMatchObject({
    conversationId: 'fake-session', company: 'claude', model: 'sonnet', effort: 'high',
    role: 'chat', firstRequest: true, requestSequence: 1, notificationSequence: 1,
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 45, cacheWriteInputTokens: 12 }
  })
  expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('② Codex last/total 은 더하지 않고 그대로, 한 턴의 알림은 같은 요청으로 묶인다', async () => {
  const root = codexRoot('token-codex-')
  const events = [
    tokenUsage('t-fake',
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 5, totalTokens: 160 },
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 5, totalTokens: 160 }),
    tokenUsage('t-fake',
      { inputTokens: 80, outputTokens: 30, cachedInputTokens: 60, cacheWriteInputTokens: 0, totalTokens: 110 },
      { inputTokens: 180, outputTokens: 70, cachedInputTokens: 80, cacheWriteInputTokens: 5, totalTokens: 270 })
  ]
  const env = codexEnv(root, { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify(events) })
  const conn = codexConn(root, env)
  try {
    await conn.run('시험용 한 턴', undefined, stubEvents())
  } finally { await conn.stop() }
  await flushTokenRecords()

  const rows = codexRecords(root)
  expect(rows).toHaveLength(2)
  // 서버가 준 last·total 그대로 — 앱이 누적하거나 합산하지 않는다.
  expect(rows[0]).toMatchObject({ conversationId: 't-fake', company: 'codex', role: 'chat', firstRequest: true,
    requestSequence: 1, notificationSequence: 1,
    last: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5 }, total: { inputTokens: 100, totalTokens: 160 } })
  expect(rows[1]).toMatchObject({ conversationId: 't-fake', firstRequest: true, requestSequence: 1, notificationSequence: 2,
    last: { inputTokens: 80, cachedInputTokens: 60 }, total: { inputTokens: 180, cachedInputTokens: 80 } })
  for (const row of rows) expect(row.usage).toBeUndefined()
})

test('CT-02: 그 턴에 고른 gpt-sol/high 가 기록되고, 기본값으로 되돌린 턴은 기본값으로 남는다', async () => {
  const root = codexRoot('token-codex-model-')
  const env = codexEnv(root, { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify([tokenUsage('t-fake', USAGE_SMALL.last, USAGE_SMALL.total)]) })
  let choice: ModelChoice | null = { model: 'gpt-sol', effort: 'high' }
  const conn = codexConn(root, env, () => choice, () => true)
  try {
    // 1턴: 고른 모델. thread/start 응답은 서버 기본값(gpt-default/medium)이지만 실제 적용은 gpt-sol/high.
    await conn.run('첫 턴', undefined, stubEvents())
    // 2턴: 선택 해제 → 앱이 서버 기본값을 명시적으로 다시 보낸다.
    choice = null
    await conn.run('둘째 턴', 't-fake', stubEvents())
  } finally { await conn.stop() }
  await flushTokenRecords()

  const rows = codexRecords(root)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ requestSequence: 1, model: 'gpt-sol', effort: 'high' })
  expect(rows[1]).toMatchObject({ requestSequence: 2, model: 'gpt-default', effort: 'medium' })
})

test('CT-03: Claude 연결을 다시 만들어 같은 대화를 이어 가면 순번이 [1, 2] 이고 첫 요청은 한 번뿐이다', async () => {
  const root = tempDir('token-claude-resume-')
  const { binary, env } = fakeClaude(root, { W1_QUERY_USAGE: JSON.stringify({ input_tokens: 5, output_tokens: 2 }) })
  const first = claudeConn(root, env, binary)
  try { await first.run('첫 턴', undefined, stubEvents()) } finally { await first.stop() }
  const second = claudeConn(root, env, binary)
  try { await second.run('이어 가는 턴', 'fake-session', stubEvents()) } finally { await second.stop() }
  await flushTokenRecords()

  const rows = claudeRecords(root)
  expect(rows.map(r => r.requestSequence)).toEqual([1, 2])
  expect(rows.map(r => r.firstRequest)).toEqual([true, false])
  for (const row of rows) expect(row.conversationId).toBe('fake-session')
})

test('CT-03: Codex 연결을 다시 만들어 같은 대화를 이어 가도 순번이 [1, 2] 이다', async () => {
  const root = codexRoot('token-codex-resume-')
  const env = codexEnv(root, { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify([tokenUsage('t-fake', USAGE_SMALL.last, USAGE_SMALL.total)]) })
  const first = codexConn(root, env)
  try { await first.run('첫 턴', undefined, stubEvents()) } finally { await first.stop() }
  const second = codexConn(root, env)
  try { await second.run('이어 가는 턴', 't-fake', stubEvents()) } finally { await second.stop() }
  await flushTokenRecords()

  const rows = codexRecords(root)
  expect(rows.map(r => r.requestSequence)).toEqual([1, 2])
  expect(rows.map(r => r.firstRequest)).toEqual([true, false])
})

test('CT-03: 앱을 다시 켠 경우처럼 기존 로그만 있어도 마지막 요청 순번을 이어받는다', async () => {
  const root = tempDir('token-carry-')
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'token-usage-claude.jsonl'),
    `${JSON.stringify({ conversationId: 'fake-session', requestSequence: 4, notificationSequence: 1 })}\n`, 'utf-8')
  const { binary, env } = fakeClaude(root, { W1_QUERY_USAGE: JSON.stringify({ input_tokens: 3, output_tokens: 1 }) })
  const conn = claudeConn(root, env, binary)
  try { await conn.run('재시작 뒤 턴', 'fake-session', stubEvents()) } finally { await conn.stop() }
  await flushTokenRecords()

  const rows = claudeRecords(root)
  expect(rows.map(r => r.requestSequence)).toEqual([4, 5])
  expect(rows[1]).toMatchObject({ conversationId: 'fake-session', firstRequest: false })
})

test('CT-01: 기록 대상이 FIFO 여도 append 호출이 즉시 돌아오고 다음 코드·타이머가 실행된다', async () => {
  test.skip(process.platform === 'win32', 'FIFO 는 POSIX 전용이다')
  const root = tempDir('token-fifo-')
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  const fifo = join(root, '.knuaf-gui', 'token-usage-claude.jsonl')
  execFileSync('mkfifo', [fifo])

  const order: string[] = []
  appendTokenRecord(root, 'claude', {
    conversationId: 'c-fifo', turnKey: 'k', build: () => ({ conversationId: 'c-fifo', requestSequence: 1, notificationSequence: 1 })
  })
  order.push('after-append')
  const tick = Promise.withResolvers<void>()
  setTimeout(() => { order.push('timer'); tick.resolve() }, 10)
  await tick.promise
  expect(order).toEqual(['after-append', 'timer'])
  // 읽는 쪽이 없는 FIFO 에 쓰기를 열지 않으므로 flush 도 멈추지 않는다.
  const raced = Promise.withResolvers<string>()
  const timer = setTimeout(() => raced.resolve('timeout'), 1500)
  void flushTokenRecords().then(() => raced.resolve('flushed'))
  await expect(raced.promise).resolves.toBe('flushed')
  clearTimeout(timer)
})

test('CT-01: 기록이 밀리면 대기 줄은 유한하고 초과분은 버린다(대화 우선)', async () => {
  const root = tempDir('token-backlog-')
  const started = Date.now()
  for (let i = 0; i < 200; i += 1) {
    appendTokenRecord(root, 'claude', {
      conversationId: 'c-backlog', turnKey: `k-${i}`,
      build: ({ requestSequence, notificationSequence }) => ({ conversationId: 'c-backlog', requestSequence, notificationSequence })
    })
  }
  // 호출은 전부 동기로 즉시 돌아온다 — I/O 를 기다리지 않는다.
  expect(Date.now() - started).toBeLessThan(1000)
  await flushTokenRecords()
  const rows = claudeRecords(root)
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThan(200)
})

test('CT-01: 막힌 기록 대상 뒤에도 다른 기록은 계속 남는다(줄이 막히지 않는다)', async () => {
  test.skip(process.platform === 'win32', 'FIFO 는 POSIX 전용이다')
  const root = tempDir('token-recover-')
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  execFileSync('mkfifo', [join(root, '.knuaf-gui', 'token-usage-claude.jsonl')])
  appendTokenRecord(root, 'claude', {
    conversationId: 'c-blocked', turnKey: 'k', build: () => ({ conversationId: 'c-blocked', requestSequence: 1, notificationSequence: 1 })
  })
  appendTokenRecord(root, 'codex', {
    conversationId: 'c-ok', turnKey: 'k', build: () => ({ conversationId: 'c-ok', requestSequence: 1, notificationSequence: 1 })
  })
  await flushTokenRecords()
  expect(codexRecords(root)).toHaveLength(1)
  expect(codexRecords(root)[0]).toMatchObject({ conversationId: 'c-ok', requestSequence: 1 })
})

test('CT-01: 기록 경로가 FIFO 여도 Claude 대화는 정상 완료된다', async () => {
  test.skip(process.platform === 'win32', 'FIFO 는 POSIX 전용이다')
  const root = tempDir('token-fifo-run-')
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  execFileSync('mkfifo', [join(root, '.knuaf-gui', 'token-usage-claude.jsonl')])
  const { binary, env } = fakeClaude(root, { W1_QUERY_USAGE: JSON.stringify({ input_tokens: 9, output_tokens: 4 }) })
  const messages: string[] = []
  const conn = claudeConn(root, env, binary)
  try {
    await expect(conn.run('시험용 한 턴', undefined, stubEvents(messages))).resolves.toBeUndefined()
  } finally { await conn.stop() }
  expect(messages).toEqual(['가짜 CLI 응답'])
})

test('③ 기록을 못 써도 Claude 대화는 정상 완료된다', async () => {
  const root = tempDir('token-claude-fail-')
  writeFileSync(join(root, '.knuaf-gui'), 'not a dir', 'utf-8') // 기록 경로 자리에 파일을 놓아 쓰기를 실패시킨다
  const { binary, env } = fakeClaude(root, { W1_QUERY_USAGE: JSON.stringify({ input_tokens: 1, output_tokens: 1 }) })
  const messages: string[] = []
  const conn = claudeConn(root, env, binary)
  try {
    await expect(conn.run('시험용 한 턴', undefined, stubEvents(messages))).resolves.toBeUndefined()
  } finally { await conn.stop() }
  expect(messages).toEqual(['가짜 CLI 응답'])
})

test('③ 기록을 못 써도 Codex 대화는 정상 완료된다', async () => {
  const root = codexRoot('token-codex-fail-')
  writeFileSync(join(root, '.knuaf-gui'), 'not a dir', 'utf-8')
  const env = codexEnv(root, { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify([tokenUsage('t-fake', USAGE_SMALL.last, USAGE_SMALL.total)]) })
  const conn = codexConn(root, env)
  try {
    await expect(conn.run('시험용 한 턴', undefined, stubEvents())).resolves.toBeUndefined()
  } finally { await conn.stop() }
})

test('④ 학생 글이 기록에 남지 않는다 — 숫자·식별자만', async () => {
  const root = tempDir('token-privacy-')
  const STUDENT_TEXT = '학생 인터뷰 원문: 홍길동, 900101-1234567, 매출 1억'
  const { binary, env } = fakeClaude(root, {
    W1_QUERY_USAGE: JSON.stringify({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 })
  })
  const conn = claudeConn(root, env, binary)
  try {
    await conn.run(STUDENT_TEXT, undefined, stubEvents())
  } finally { await conn.stop() }
  await flushTokenRecords()

  const raw = readFileSync(join(root, '.knuaf-gui', 'token-usage-claude.jsonl'), 'utf-8')
  for (const leaked of ['홍길동', '900101-1234567', '매출 1억', '인터뷰 원문', STUDENT_TEXT]) {
    expect(raw, `기록에 학생 글이 남았다: ${leaked}`).not.toContain(leaked)
  }
  const [record] = claudeRecords(root)
  expect(Object.keys(record).sort()).toEqual([
    'at', 'company', 'conversationId', 'effort', 'firstRequest', 'jobId', 'model',
    'notificationSequence', 'requestSequence', 'role', 'usage'
  ])
  for (const value of Object.values(record.usage as Record<string, unknown>)) expect(typeof value).toBe('number')
})
