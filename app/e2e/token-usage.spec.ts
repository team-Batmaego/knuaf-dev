/**
 * 일반 대화의 캐시 토큰 기록 (v0.6.3).
 *
 * 발주 완료 조건 넷을 **앱 코드로** 잠근다 — 앞 워커의 파이썬 사본 시험은 여기서 대체했다:
 *   ① Claude `result.usage` → 기록 줄에 cache read/write 숫자
 *   ② Codex `thread/tokenUsage/updated` 의 last/total 을 더하지 않고 그대로 기록
 *   ③ 기록 쓰기가 실패해도 대화는 정상 완료
 *   ④ 학생 글이 기록에 남지 않음(숫자·식별자만)
 *
 * 실제 `ClaudeConnection`·`CodexConnection` 을 가짜 CLI 로 돌린다 — 로그인·네트워크·학생 자료 없음.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection } from '../src/main/chat/claude'
import { CodexConnection } from '../src/main/chat/codex'
import { findExecutable } from '../src/main/agent'
import type { AgentEvents } from '../src/main/chat/contracts'
import { fakeCodexEnv } from './fixtures/fake-codex'

/** 시험이 만든 임시 폴더는 끝나면 지운다 — 기록 파일이 남지 않게. */
const scratch: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
test.afterEach(() => {
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

function claudeRecords(root: string): Record<string, any>[] {
  const file = join(root, '.knuaf-gui', 'token-usage-claude.jsonl')
  return readFileSync(file, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
}

function codexRecords(root: string): Record<string, any>[] {
  const file = join(root, '.knuaf-gui', 'token-usage-codex.jsonl')
  return readFileSync(file, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
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
  const conn = new ClaudeConnection({ binary, root, skill: '', openExternal: async () => {}, env })
  try {
    await conn.run('시험용 한 턴', undefined, stubEvents())
  } finally { await conn.stop() }

  const [record] = claudeRecords(root)
  expect(record).toMatchObject({
    conversationId: 'fake-session', company: 'claude', model: 'sonnet', effort: 'high',
    role: 'chat', firstRequest: true, requestSequence: 1, notificationSequence: 1,
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 45, cacheWriteInputTokens: 12 }
  })
  expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('② Codex last/total 은 더하지 않고 그대로, 턴마다 요청 순번이 늘어난다', async () => {
  const root = tempDir('token-codex-')
  mkdirSync(join(root, '.agents', 'skills', 'knuaf-dev'), { recursive: true })
  writeFileSync(join(root, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'), '# test skill\n')
  const notification = (turnId: string, last: Record<string, number>, total: Record<string, number>) => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 't-fake', turnId, tokenUsage: { last, total, modelContextWindow: 200_000 } }
  })
  const events = [
    notification('u-1', { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 5, totalTokens: 160 },
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 5, totalTokens: 160 }),
    notification('u-1', { inputTokens: 80, outputTokens: 30, cachedInputTokens: 60, cacheWriteInputTokens: 0, totalTokens: 110 },
      { inputTokens: 180, outputTokens: 70, cachedInputTokens: 80, cacheWriteInputTokens: 5, totalTokens: 270 }),
    notification('u-2', { inputTokens: 5, outputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 0, totalTokens: 7 },
      { inputTokens: 185, outputTokens: 72, cachedInputTokens: 83, cacheWriteInputTokens: 5, totalTokens: 277 })
  ]
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify(events) }) }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const conn = new CodexConnection({ binary, root, skill: join(root, '.agents', 'skills', 'knuaf-dev'), env, openExternal: async () => {} })
  try {
    await conn.run('시험용 한 턴', undefined, stubEvents())
  } finally { await conn.stop() }

  const rows = codexRecords(root)
  expect(rows).toHaveLength(3)
  // 서버가 준 last·total 그대로 — 앱이 누적하거나 합산하지 않는다.
  expect(rows[0]).toMatchObject({ conversationId: 't-fake', company: 'codex', role: 'chat', requestSequence: 1, notificationSequence: 1,
    last: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5 }, total: { inputTokens: 100, totalTokens: 160 } })
  expect(rows[1]).toMatchObject({ requestSequence: 1, notificationSequence: 2,
    last: { inputTokens: 80, cachedInputTokens: 60 }, total: { inputTokens: 180, cachedInputTokens: 80 } })
  expect(rows[2]).toMatchObject({ requestSequence: 2, notificationSequence: 1,
    last: { inputTokens: 5 }, total: { inputTokens: 185, totalTokens: 277 } })
  // 합산 흔적이 없어야 한다: total 은 언제나 서버 값이고, usage 키는 쓰지 않는다.
  for (const row of rows) expect(row.usage).toBeUndefined()
})

test('③ 기록을 못 써도 Claude 대화는 정상 완료된다', async () => {
  const root = tempDir('token-claude-fail-')
  writeFileSync(join(root, '.knuaf-gui'), 'not a dir', 'utf-8') // 기록 경로 자리에 파일을 놓아 쓰기를 실패시킨다
  const { binary, env } = fakeClaude(root, { W1_QUERY_USAGE: JSON.stringify({ input_tokens: 1, output_tokens: 1 }) })
  const messages: string[] = []
  const conn = new ClaudeConnection({ binary, root, skill: '', openExternal: async () => {}, env })
  try {
    await expect(conn.run('시험용 한 턴', undefined, stubEvents(messages))).resolves.toBeUndefined()
  } finally { await conn.stop() }
  expect(messages).toEqual(['가짜 CLI 응답'])
})

test('③ 기록을 못 써도 Codex 대화는 정상 완료된다', async () => {
  const root = tempDir('token-codex-fail-')
  mkdirSync(join(root, '.agents', 'skills', 'knuaf-dev'), { recursive: true })
  writeFileSync(join(root, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'), '# test skill\n')
  writeFileSync(join(root, '.knuaf-gui'), 'not a dir', 'utf-8')
  const events = [{ method: 'thread/tokenUsage/updated', params: {
    threadId: 't-fake', turnId: 'u-fake',
    tokenUsage: { last: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, cacheWriteInputTokens: 0, totalTokens: 2 },
      total: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, cacheWriteInputTokens: 0, totalTokens: 2 } }
  } }]
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify(events) }) }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const conn = new CodexConnection({ binary, root, skill: join(root, '.agents', 'skills', 'knuaf-dev'), env, openExternal: async () => {} })
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
  const conn = new ClaudeConnection({ binary, root, skill: '', openExternal: async () => {}, env })
  try {
    await conn.run(STUDENT_TEXT, undefined, stubEvents())
  } finally { await conn.stop() }

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
