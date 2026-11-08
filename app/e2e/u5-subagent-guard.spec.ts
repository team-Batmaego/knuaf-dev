// U5 — 메인 대화가 스스로 하위 담당을 띄우는 길을 막고(Claude)·기록한다(Codex).
// 실제 AI 호출 0회: 가짜 CLI(fixtures/fake-claude-query.mjs)·가짜 app-server
// (fixtures/fake-codex-server.mjs)만 띄운다.
//
// 고정하는 것(설계 §3.2 [r11]·§5-7·§8):
//  1. Claude 메인의 PreToolUse 훅이 Agent·Task(별칭) 호출을 **언제나** 거절한다 — 신뢰 폴더·
//     승인 배치·동의와 무관. 같은 판정이 canUseTool(2차 그물)에도 있다.
//  2. 메인 대화 옵션에 `agents` 가 **없고**, 훅이 실제 초기화 요청에 실린다.
//  3. 훅이 못 듣는 판(훅 꺼짐)에서도 can_use_tool 이 같은 거절을 낸다.
//  4. Codex 메인이 띄운 하위 담당은 `collabAgentToolCall`·`subAgentActivity` 로 기록·알림만
//     되고, 담당 thread 의 말은 대화에 섞이지 않는다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection, isSubagentTool, subagentGuardHook } from '../src/main/chat/claude'
import { CodexConnection, SUBAGENT_SPAWNED_NOTE } from '../src/main/chat/codex'
import { findExecutable } from '../src/main/agent'
import type { AgentEvents } from '../src/main/chat/contracts'
import { fakeCodexEnv } from './fixtures/fake-codex'

const noopEvents: AgentEvents = { message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }

/** 가짜 CLI 하나 — `auth status` 는 늘 로그인됨, 대화는 초기화·훅 왕복까지만. */
function claudeRig(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u5-claude-'))
  const log = join(root, 'query.jsonl')
  const hookLog = join(root, 'hooks.jsonl')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  writeFileSync(hookLog, '')
  const env: NodeJS.ProcessEnv = { ...process.env, W1_QUERY_LOG: log, W1_HOOK_LOG: hookLog, ...extra }
  const conn = new ClaudeConnection({ binary, root, skill: '', env, openExternal: async () => {}, trusted: () => true })
  const rows = (): Record<string, unknown>[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const inits = () => rows().filter((r) => r.type === 'control_request' && (r.request as { subtype?: string } | undefined)?.subtype === 'initialize')
  const hooks = (): Record<string, unknown>[] => readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { root, conn, env, rows, inits, hooks }
}

test('U5: 하위 담당 도구 이름은 언제나 거절한다 — 정본 Agent·옛 별칭 Task·대소문자', async () => {
  for (const name of ['Agent', 'Task', 'agent', 'TASK', 'tAsK']) expect(isSubagentTool(name), name).toBe(true)
  // 이름이 비슷한 다른 도구는 막지 않는다(할 일 목록·종료). 막으면 앱 기능이 줄어든다.
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'Bash', 'Write', 'SendMessage']) {
    expect(isSubagentTool(name), name).toBe(false)
  }
  expect(isSubagentTool(undefined)).toBe(false)
  expect(isSubagentTool(42)).toBe(false)
  // 훅은 도구가 아니면 아무 판단도 하지 않는다(통과) — 다른 도구의 흐름을 건드리지 않는다.
  for (const other of ['Bash', 'Write', 'TaskCreate']) {
    const out = await subagentGuardHook({ hook_event_name: 'PreToolUse', tool_name: other, tool_input: {}, tool_use_id: 't' })
    expect(out).toEqual({ continue: true })
  }
  // 그리고 하위 담당이면 결정은 늘 deny — 승인 배치·신뢰 폴더 같은 입력 자체를 받지 않는다.
  for (const name of ['Agent', 'Task']) {
    const out = await subagentGuardHook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: {}, tool_use_id: 't' })
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(String(out.hookSpecificOutput?.permissionDecisionReason)).toContain('gg.py delegate')
  }
})

test('U5: 메인 대화 옵션에 agents 가 없고, PreToolUse 훅이 초기화 요청에 실린다', async () => {
  const r = claudeRig()
  try {
    await r.conn.run('훅 등록 확인', undefined, noopEvents)
    const [init] = r.inits()
    expect(init, '초기화 요청이 있어야 한다').toBeTruthy()
    const request = init.request as {
      agents?: unknown
      hooks?: { PreToolUse?: { hookCallbackIds?: string[] }[] }
    }
    // 하위 담당 정의는 메인 대화에 싣지 않는다(§3.2 [r11] — 두 회사 모두 sub 없음).
    expect(request.agents).toBeUndefined()
    // 훅이 실제로 등록돼 CLI 가 앱에 물어볼 id 를 받았다.
    const ids = (request.hooks?.PreToolUse ?? []).flatMap((m) => m.hookCallbackIds ?? [])
    expect(ids.length).toBeGreaterThan(0)
  } finally { await r.conn.stop() }
})

test('U5: 훅이 켜진 일반 도구 경로 — Agent 호출이 거절되고 도구가 실행되지 않는다', async () => {
  const r = claudeRig({ W1_HOOK_TOOL: 'Agent' })
  try {
    await r.conn.run('혼자 조사해 줘', undefined, noopEvents)
    const [verdict, executed] = r.hooks()
    expect(verdict).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(String(verdict.permissionDecisionReason)).toContain('gg.py delegate')
    // 거절이 곧 "Agent 가 돌지 않았다"는 아니다 — CLI 가 그 판단을 실제로 따랐는지까지 본다.
    expect(executed).toEqual({ executed: false })
    expect(r.hooks().some((h) => h.executed === true)).toBe(false)
  } finally { await r.conn.stop() }
})

test('U5: 훅이 못 듣는 판에서도 can_use_tool 이 같은 거절을 낸다 (2차 그물)', async () => {
  const r = claudeRig({ W1_PERMISSION_TOOL: 'Task' })
  try {
    await r.conn.run('혼자 조사해 줘', undefined, noopEvents)
    const [verdict, executed] = r.hooks()
    expect(verdict).toMatchObject({ behavior: 'deny' })
    expect(String(verdict.message)).toContain('gg.py delegate')
    expect(executed).toEqual({ executed: false })
  } finally { await r.conn.stop() }
})

/** 가짜 app-server 하나 — 하위 담당 알림을 그대로 흘려보낸다. */
function codexRig(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u5-codex-'))
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), {
    FAKE_CODEX_SUBAGENT_EVENTS: JSON.stringify(events)
  }) }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const conn = new CodexConnection({ binary, root, skill, env, openExternal: async () => {} })
  const notes: string[] = []
  const messages: { id: string; text: string }[] = []
  const agentEvents: AgentEvents = {
    message: (id, text) => messages.push({ id, text }), permission: () => {}, note: (t) => notes.push(t),
    session: () => {}, skill: () => {}
  }
  const auditDir = join(root, 'audit', 'model-routing')
  const audit = (): Record<string, unknown>[] => existsSync(auditDir)
    ? readdirSync(auditDir).map((f) => JSON.parse(readFileSync(join(auditDir, f), 'utf8')) as Record<string, unknown>)
    : []
  return { root, conn, notes, messages, audit, agentEvents }
}

const spawnCall = (threadId: string, childId: string) => ({
  method: 'item/started', params: { threadId, turnId: 'u-fake', startedAtMs: 1, item: {
    type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'inProgress',
    senderThreadId: threadId, receiverThreadIds: [childId], prompt: '조사해 줘',
    model: 'gpt-child', reasoningEffort: 'high', agentsStates: {}
  } }
})
const activityStarted = (threadId: string, childId: string) => ({
  method: 'item/started', params: { threadId, turnId: 'u-child', startedAtMs: 2, item: {
    type: 'subAgentActivity', id: 'act-1', kind: 'started', agentThreadId: childId,
    agentPath: '/child', model: 'gpt-resolved', reasoningEffort: 'medium'
  } }
})
/** 담당 thread 의 말 — 대화에 섞이면 안 된다(§8). */
const childMessage = {
  method: 'item/completed', params: { threadId: 't-child', turnId: 'u-child', item: { id: 'child-msg', type: 'agentMessage', text: '담당이 조사한 중간 결과' } }
}

test('U5: Codex 메인이 띄운 하위 담당은 기록·알림만 — 담당의 말은 대화에 섞이지 않는다', async () => {
  const r = codexRig([spawnCall('t-fake', 't-child'), activityStarted('t-child', 't-child'), childMessage])
  try {
    await r.conn.run('자료 조사해 줘', undefined, r.agentEvents)
    // ① 알림 — 학생에게 한 번, 그 사용량이 한도·요금에 들어간다는 것까지.
    expect(r.notes.filter((n) => n === SUBAGENT_SPAWNED_NOTE)).toHaveLength(1)
    // ② 기록 — 띄운 사실과 실제값이 감사 자리에 남는다(요청값 = spawnAgent 의 model).
    const records = r.audit()
    const spawned = records.find((x) => x.event === 'spawned')
    expect(spawned).toMatchObject({ type: 'subagent-spawned', provider: 'codex', threadIds: ['t-child'], requestedModel: 'gpt-child', requestedEffort: 'high' })
    const resolved = records.find((x) => x.event === 'resolved')
    expect(resolved).toMatchObject({ type: 'subagent-resolved', threadIds: ['t-child'], requestedModel: 'gpt-child', actualModel: 'gpt-resolved', actualEffort: 'medium' })
    // ③ 분리 — 담당 thread 의 말은 대화로 오지 않는다.
    expect(r.messages.map((m) => m.text)).not.toContain('담당이 조사한 중간 결과')
  } finally { await r.conn.stop() }
})

test('U5: 하위 담당 알림이 여러 번 와도 알림은 한 번, 기록은 실제값이 확인될 때만 늘어난다', async () => {
  // 같은 호출을 item/started·item/completed 로 두 번 보내는 것은 실제 서버에서도 흔하다.
  const completed = { ...spawnCall('t-fake', 't-child'), method: 'item/completed' }
  const r = codexRig([spawnCall('t-fake', 't-child'), completed, activityStarted('t-child', 't-child')])
  try {
    await r.conn.run('자료 조사해 줘', undefined, r.agentEvents)
    expect(r.notes.filter((n) => n === SUBAGENT_SPAWNED_NOTE)).toHaveLength(1)
    expect(r.audit().filter((x) => x.event === 'spawned')).toHaveLength(1)
    expect(r.audit().filter((x) => x.event === 'resolved')).toHaveLength(1)
  } finally { await r.conn.stop() }
})

test('U5: 다른 collab 도구(sendInput 등)는 담당 생성이 아니다 — 알림을 띄우지 않는다', async () => {
  const send = { method: 'item/started', params: { threadId: 't-fake', turnId: 'u-fake', startedAtMs: 1, item: {
    type: 'collabAgentToolCall', id: 'collab-2', tool: 'sendInput', status: 'inProgress',
    senderThreadId: 't-fake', receiverThreadIds: ['t-child'], prompt: null, model: null, reasoningEffort: null, agentsStates: {}
  } } }
  const r = codexRig([send])
  try {
    await r.conn.run('계속해 줘', undefined, r.agentEvents)
    expect(r.notes.filter((n) => n === SUBAGENT_SPAWNED_NOTE)).toHaveLength(0)
    expect(r.audit()).toEqual([])
  } finally { await r.conn.stop() }
})
