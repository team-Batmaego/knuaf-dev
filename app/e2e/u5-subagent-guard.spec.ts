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
import { CodexConnection } from '../src/main/chat/codex'

/** 하위 담당 알림은 학생 화면에 띄우지 않는다(형님 11-13: 한도·요금 문구 빼기) — 기록만 남는다. */
const subagentNotes = (notes: string[]) => notes.filter((n) => n.includes('하위 담당') || n.includes('요금'))
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
  /**
   * 앱이 CLI 에 넘긴 `--disallowedTools`. 엔진이 모델에게 주지 않는 도구 목록이고, 실CLI 두 판
   * 에서 이 목록만이 Workflow·fork Skill 을 실제로 닫았다(훅·canUseTool 은 그 경로를 못 본다).
   */
  const disallowed = (): string[] => {
    const args = rows().find((x) => Array.isArray(x.args))?.args
    const list = Array.isArray(args) ? args : []
    const at = list.indexOf('--disallowedTools')
    return at >= 0 && typeof list[at + 1] === 'string' ? String(list[at + 1]).split(',').filter(Boolean) : []
  }
  return { root, conn, env, rows, inits, hooks, disallowed }
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
  // (`Workflow`·`Skill` 은 여기 없다 — 그 둘은 이름 판정으로 닫히지 않아 엔진 옵션이 맡는다.)
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

test('U5b: Agent 는 엔진이 도구를 주지 않아 실행되지 않는다 — 훅까지 오지도 않는다', async () => {
  // 404fda3 까지는 훅이 Agent 를 거절했다. 그 훅은 **콜백이 예외를 던지면 fail-open** 이라
  // (실측) 단독 관문이 될 수 없다. 지금은 엔진 옵션이 먼저 막고, 훅은 2차 겹이다 —
  // 그래서 이 시험은 "훅이 불리지 않고 도구가 돌지 않았다"를 잠근다(그게 더 강한 사실이다).
  const r = claudeRig({ W1_HOOK_TOOL: 'Agent' })
  try {
    await r.conn.run('혼자 조사해 줘', undefined, noopEvents)
    expect(r.disallowed()).toEqual(expect.arrayContaining(['Agent', 'Task', 'Workflow', 'Skill']))
    expect(r.hooks()).toEqual([{ engineBlocked: 'Agent' }])
    // 훅 함수 자체는 2차 겹으로 남아 있다 — 이름이 목록에 없는 판을 위한 것이고, 그 판정은
    // 첫 시험(훅 단위)이 고정한다.
    expect(r.hooks().some((h) => h.executed === true)).toBe(false)
  } finally { await r.conn.stop() }
})

test('U5b(차단 1): Workflow 도 하위 담당 입구다 — 엔진 단계에서 도구를 주지 않는다', async () => {
  // 실CLI 두 판 실측: Workflow 는 훅(`tool:"Workflow"`)도 canUseTool 도 판정 밖이라 통과하고
  // "Workflow launched in background" 로 하위 담당이 뜬다. 유일하게 듣는 것은 disallowedTools 다.
  const r = claudeRig({ W1_HOOK_TOOL: 'Workflow' })
  try {
    await r.conn.run('이 일을 워크플로로 돌려 줘', undefined, noopEvents)
    // 엔진 옵션으로 내려갔는가 — 이 이름이 빠지면 그 경로가 그대로 열린다.
    expect(r.disallowed()).toContain('Workflow')
    expect(r.disallowed()).toEqual(expect.arrayContaining(['Agent', 'Task', 'Skill']))
    // 그리고 도구는 돌지 않았다(훅도 canUseTool 도 불리지 않는 엔진 차단).
    const log = r.hooks()
    expect(log).toEqual([{ engineBlocked: 'Workflow' }])
  } finally { await r.conn.stop() }
})

test('U5b(차단 2): fork 스킬도 입구다 — Skill 도구째로 주지 않는다', async () => {
  // 동봉 스킬 code-review 가 context: fork 라 학생 PC 어디서나 Skill 한 번이면 하위 담당이 뜬다.
  // 이름 하나만 막는 Skill(code-review) 로는 폴더의 fork 스킬을 못 막으므로 도구를 통째로 뺀다.
  const r = claudeRig({ W1_HOOK_TOOL: 'Skill' })
  try {
    await r.conn.run('code-review 스킬로 검토해 줘', undefined, noopEvents)
    expect(r.disallowed()).toContain('Skill')
    expect(r.hooks()).toEqual([{ engineBlocked: 'Skill' }])
  } finally { await r.conn.stop() }
})

test('U5b: 앱은 /knuaf-dev 슬래시로 스킬을 싣는다 — Skill 도구를 빼도 앱 스킬 본문은 간다', async () => {
  // Skill 도구를 끄면 모델이 스스로 부르는 스킬은 닫힌다. 앱이 쓰는 길은 슬래시 명령이고,
  // 그것은 CLI 가 직접 확장하므로 Skill 도구와 무관하다(두 판 실측).
  const r = claudeRig()
  try {
    await r.conn.run('첫 요청', undefined, noopEvents)
    const prompts = r.rows().filter((x) => x.type === 'user').map((x) => JSON.stringify(x.message))
    expect(prompts.join('\n')).toContain('/knuaf-dev')
  } finally { await r.conn.stop() }
})

test('U5b(중요 1): canUseTool 로는 막지 못한다 — Agent 는 그 콜백을 거치지 않는다', async () => {
  // 실CLI 두 판 실측: Agent 는 승인 질문 없이 도는 도구라 can_use_tool 이 **한 번도** 불리지
  // 않는다. 그래서 "2차 그물"을 canUseTool 에 두면 막았다는 착각만 남는다. 이 시험은 그 사실을
  // 잠근다 — 가짜 CLI 가 그 콜백을 강제로 보내면 거절되지만, 강제로 보내지 않는 경로(실제
  // 엔진 동작)에서는 불리지 않으므로 **엔진 옵션(disallowedTools)** 이 유일한 관문이다.
  const r = claudeRig({ W1_PERMISSION_TOOL: 'Task' })
  try {
    await r.conn.run('혼자 조사해 줘', undefined, noopEvents)
    // 실제 앱 canUseTool 은 하위 담당 이름을 더 이상 특별히 거절하지 않는다(막을 수 없으므로).
    const [verdict] = r.hooks()
    expect(verdict).not.toMatchObject({ message: expect.stringContaining('gg.py delegate') })
  } finally { await r.conn.stop() }
})

/** 가짜 app-server 하나 — 하위 담당 알림을 그대로 흘려보낸다. */
function codexRig(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u5-codex-'))
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
  const threadLog = join(root, 'thread-start.jsonl')
  writeFileSync(threadLog, '')
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), {
    FAKE_CODEX_SUBAGENT_EVENTS: JSON.stringify(events), FAKE_CODEX_THREAD_START_LOG: threadLog
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
  const threadStarts = (): { method: string; params: Record<string, unknown> }[] =>
    readFileSync(threadLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { root, conn, notes, messages, audit, agentEvents, threadStarts }
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

test('U5: Codex 메인이 띄운 하위 담당은 기록만 — 화면 알림 없음, 담당의 말은 대화에 섞이지 않는다', async () => {
  const r = codexRig([spawnCall('t-fake', 't-child'), activityStarted('t-child', 't-child'), childMessage])
  try {
    await r.conn.run('자료 조사해 줘', undefined, r.agentEvents)
    // ① 알림 없음 — 학생 화면에는 아무 줄도 뜨지 않는다.
    expect(subagentNotes(r.notes)).toHaveLength(0)
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

test('U5b(중요 2): 자식 thread id 는 완료 알림에만 온다 — 시작에서 닫지 않고 기다린다', async () => {
  // 엔진 실측(CollabAgentSpawnBeginEvent 엔 새 thread 필드가 없고 EndEvent 에만 new_thread_id):
  // 시작 알림의 receiverThreadIds 는 비어 있고 완료 알림에서야 채워진다. 시작에서 "처리됨"으로
  // 닫으면 요청값↔실제값 대조가 통째로 비어버린다(검토 U5b 중요 2 재현 그대로).
  const begin = { method: 'item/started', params: { threadId: 't-fake', turnId: 'u-fake', startedAtMs: 1, item: {
    type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'inProgress',
    senderThreadId: 't-fake', receiverThreadIds: [], prompt: '조사해 줘',
    model: 'gpt-child', reasoningEffort: 'high', agentsStates: {}
  } } }
  const end = { method: 'item/completed', params: { threadId: 't-fake', turnId: 'u-fake', completedAtMs: 2, item: {
    type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'completed',
    senderThreadId: 't-fake', receiverThreadIds: ['t-child'], prompt: '조사해 줘',
    model: 'gpt-child', reasoningEffort: 'high', agentsStates: { 't-child': { status: 'pendingInit', message: null } }
  } } }
  const r = codexRig([begin, end, activityStarted('t-child', 't-child')])
  try {
    await r.conn.run('자료 조사해 줘', undefined, r.agentEvents)
    // 화면 알림은 없다(시작·완료 어느 쪽에서도).
    expect(subagentNotes(r.notes)).toHaveLength(0)
    // 기록은 id 가 확정된 뒤 한 번, 그 id 와 요청값을 들고.
    const spawned = r.audit().filter((x) => x.event === 'spawned')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ threadIds: ['t-child'], requestedModel: 'gpt-child', requestedEffort: 'high' })
    // 실제값도 그 id 에 붙어 요청값과 나란히 남는다.
    expect(r.audit().find((x) => x.event === 'resolved')).toMatchObject({
      threadIds: ['t-child'], requestedModel: 'gpt-child', requestedEffort: 'high',
      actualModel: 'gpt-resolved', actualEffort: 'medium'
    })
  } finally { await r.conn.stop() }
})

test('U5b(권고 1): 같은 활동 알림이 started·completed 로 두 번 와도 실제값 기록은 하나다', async () => {
  const activity = activityStarted('t-child', 't-child')
  const r = codexRig([spawnCall('t-fake', 't-child'), activity, { ...activity, method: 'item/completed' }])
  try {
    await r.conn.run('자료 조사해 줘', undefined, r.agentEvents)
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
    expect(subagentNotes(r.notes)).toHaveLength(0)
    expect(r.audit()).toEqual([])
  } finally { await r.conn.stop() }
})

test('U5: 메인 Codex 의 thread/start 에 역할 config·sub 요청이 없다 — 엔진 하위 담당을 열지 않는다', async () => {
  const r = codexRig([])
  try {
    await r.conn.run('평범한 요청', undefined, r.agentEvents)
    const main = r.threadStarts().filter((t) => t.params.ephemeral !== true)
    expect(main.length).toBeGreaterThan(0)
    for (const { method, params } of main) {
      expect(method === 'thread/start' || method === 'thread/resume').toBe(true)
      // §3.2 Codex 열의 담당 정의 자리(config 의 agents.<역할>)를 싣지 않는다.
      expect(params.config).toBeUndefined()
      // 하위 담당을 미리 띄우는 요청도 없다.
      expect(params.spawnAgent).toBeUndefined()
      expect(params.agents).toBeUndefined()
      expect(params.subAgent).toBeUndefined()
      // 대화는 여전히 논문 폴더에서, 쓰기는 그 폴더로 가둔다.
      expect(params.cwd).toBe(r.root)
      expect(params.sandbox).toBe('workspace-write')
    }
  } finally { await r.conn.stop() }
})
