// U1 — Claude 모델·생각 깊이 칩의 **뒷단**. 실제 AI 호출은 0회다:
// 가짜 CLI(`fixtures/fake-claude-query.mjs`)만 띄우고, SDK 의 초기화 왕복까지만 쓴다.
//
// 고정하는 것(설계 §1·§8):
//  1. `models()` 가 초기화 응답의 `models` 를 앱 모델 목록으로 옮긴다 — 깊이는 모델이 준 그대로.
//  2. 칩에서 고른 모델·깊이가 다음 턴의 CLI 인자(`--model`·`--effort`)로 나간다.
//  3. "안 고름" 되돌리기 — 덮어쓴 대화에서 해제하면 **기본 모델이 명시**된다(D1-03).
//  4. 기본값을 모를 때(=첫 턴부터 모델을 골랐던 대화)는 해제를 전송 전에 막는다.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection, CLAUDE_MODEL_COPY, toChatModelInfo } from '../src/main/chat/claude'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { MODEL_PICKER } from '../src/renderer/src/copy'
import type { AgentConnection, AgentOptions } from '../src/main/chat/contracts'
import type { ChatSnapshot, ModelChoice } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')

/** 실제 계정 목록의 모양을 옮긴 가짜 초기화 응답 — Opus 는 max 까지, Sonnet 은 high 까지. */
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: '계정 기본 모델', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '가장 깊은 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '일상 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
]

/**
 * 가짜 CLI. `auth status` 는 늘 로그인됨으로 답하고, 대화 쪽은 초기화 요청에만 응답한다.
 * 띄운 인자·요청을 `W1_QUERY_LOG` 에 남기므로 시험이 CLI 에 실제로 무엇이 갔는지 본다.
 */
function rig(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u1-claude-'))
  const log = join(root, 'query.jsonl')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  const env = { ...process.env, W1_QUERY_LOG: log, W1_MODELS: JSON.stringify(MODELS), ...extra }
  const launches = (): { args: string[] }[] =>
    readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { args?: string[] })
      .filter((row): row is { args: string[] } => Array.isArray(row.args) && !row.args.includes('auth'))
  const snapshots: ChatSnapshot[] = []
  // 설정 저장소의 최소 사본 — 실제 앱은 settings.json 이 이 자리를 맡는다(ipc.ts).
  const stored = new Map<string, ModelChoice | null>()
  const svc = new ChatService({
    skillSource: () => skillSource(appRoot, false, ''),
    userData: join(root, 'userdata'),
    emit: (s) => snapshots.push(s),
    openExternal: async () => {},
    modelChoice: (provider) => stored.get(provider) ?? null,
    modelChosen: (provider) => stored.has(provider),
    storeModelChoice: (provider, choice) => { stored.set(provider, choice) },
    connectionFactory: (provider, options) => provider === 'claude'
      ? new ClaudeConnection({ ...options, binary, env })
      : {
          status: async () => ({ installed: true, connected: true, version: null, detail: '' }),
          login: async () => {}, run: async () => {}, respond: () => {}, stop: async () => {}
        }
  })
  return { root, log, env, binary, svc, launches, snapshots }
}

async function settled(svc: ChatService, root: string): Promise<ChatSnapshot> {
  await expect.poll(() => svc.snapshot(root, 'claude').state, { timeout: 20_000 }).not.toBe('running')
  return svc.snapshot(root, 'claude')
}

test('U1: SDK 모델 목록을 앱 목록으로 옮긴다 — 깊이는 모델이 준 그대로', () => {
  expect(toChatModelInfo(MODELS[1])).toEqual({
    model: 'opus', name: 'Opus', description: '가장 깊은 작업',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, isDefault: false
  })
  // 모델마다 목록이 다르다 — Sonnet 은 xhigh·max 가 없다(줄이지도, 더하지도 않는다).
  expect(toChatModelInfo(MODELS[2])?.efforts).toEqual(['low', 'medium', 'high'])
  // 값이 비었거나 모델 이름이 없으면 목록에 올리지 않는다.
  expect(toChatModelInfo({ ...MODELS[1], value: '  ' })).toBeNull()
  expect(toChatModelInfo({ value: 'opus', displayName: '', description: '' })).toEqual({
    model: 'opus', name: 'opus', description: '', efforts: [], defaultEffort: null, isDefault: false
  })
  // SDK 가 모르는 깊이 값은 목록에 남기지 않는다 — 엔진이 받지 않는 값을 칩에 띄우지 않는다.
  expect(toChatModelInfo({ value: 'opus', displayName: 'Opus', description: '', supportedEffortLevels: ['ultra'] })?.efforts).toEqual([])
})

test('U1: Claude 칩 — 계정 모델 목록을 받고, 고른 모델·깊이가 설정에 남는다', async () => {
  const r = rig()
  try {
    const list = await r.svc.models(r.root, 'claude')
    expect(list.supported).toBe(true)
    expect(list.error).toBeUndefined()
    expect(list.models.map((m) => m.model)).toEqual(['default', 'opus', 'sonnet'])
    expect(list.selected).toBeNull()
    // 목록 조회는 턴을 보내지 않는다 — 초기화 요청만 나가고 사용자 프롬프트는 없다.
    expect(r.launches().length).toBeGreaterThan(0)

    expect(await r.svc.setModel(r.root, 'claude', { model: 'opus', effort: 'max' })).toEqual({ model: 'opus', effort: 'max' })
    // 모델이 지원하지 않는 깊이는 저장하지 않는다 — Sonnet 에 max 를 붙이면 거절한다.
    await expect(r.svc.setModel(r.root, 'claude', { model: 'sonnet', effort: 'max' })).rejects.toThrow('이 모델은 그 생각 깊이를 지원하지 않아요')
    // 목록에 없는 모델도 거절한다(요금제가 바뀐 뒤의 옛 값).
    await expect(r.svc.setModel(r.root, 'claude', { model: 'haiku-9', effort: null })).rejects.toThrow('이 계정에서 쓸 수 없는 모델이에요')
  } finally { await r.svc.close() }
})

test('U1: 고른 모델·깊이가 다음 턴의 CLI 인자로 나간다', async () => {
  const r = rig()
  try {
    await r.svc.setModel(r.root, 'claude', { model: 'opus', effort: 'high' })
    await r.svc.send(r.root, 'claude', '모델 확인', 'u1-turn')
    const s = await settled(r.svc, r.root)
    expect(s.state, s.error).toBe('idle')
    const args = r.launches().at(-1)!.args
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus', '--effort', 'high']))
  } finally { await r.svc.close() }
})

test('U1: "안 고름" 되돌리기 — 덮어쓴 대화에서 해제하면 기본 모델을 명시해서 보낸다 (D1-03)', async () => {
  const r = rig()
  try {
    // 1) 새 대화를 모델 없이 연다 → 초기화가 계정 기본 모델을 알려 준다.
    await r.svc.send(r.root, 'claude', '첫 턴', 'u1-first')
    expect((await settled(r.svc, r.root)).state).toBe('idle')
    // 첫 턴은 모델 키 없이 나갔다(학생 설정을 덮지 않는다).
    expect(r.launches().at(-1)!.args).not.toContain('--model')

    // 2) 칩에서 Opus 로 고른다 → 다음 턴은 그 모델.
    await r.svc.setModel(r.root, 'claude', { model: 'opus', effort: null })
    await r.svc.send(r.root, 'claude', '두 번째 턴', 'u1-second')
    expect((await settled(r.svc, r.root)).state).toBe('idle')
    expect(r.launches().at(-1)!.args).toEqual(expect.arrayContaining(['--model', 'opus']))

    // 3) "안 고름"으로 되돌린다 → 생략이 아니라 **기본 모델 명시**(생략하면 CLI 가 마지막
    //    모델을 복원한다 — 실측). 기본값은 1)의 init 에서 확인한 `claude-opus-5` 다.
    await r.svc.setModel(r.root, 'claude', null)
    await r.svc.send(r.root, 'claude', '세 번째 턴', 'u1-third')
    expect((await settled(r.svc, r.root)).state).toBe('idle')
    const args = r.launches().at(-1)!.args
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5']))
    expect(args).not.toContain('opus')
  } finally { await r.svc.close() }
})

test('U1: 기본값을 모르면 해제를 전송 전에 막는다 — 글은 대화에 남지 않는다', async () => {
  const r = rig()
  try {
    // 첫 턴부터 모델을 고른 대화: 그 init 은 선택값이므로 기본값으로 저장하지 않는다.
    await r.svc.setModel(r.root, 'claude', { model: 'opus', effort: null })
    await r.svc.send(r.root, 'claude', '고른 채 시작', 'u1-chosen-first')
    const first = await settled(r.svc, r.root)
    expect(first.state).toBe('idle')

    await r.svc.setModel(r.root, 'claude', null)
    await expect(r.svc.send(r.root, 'claude', '해제 뒤 전송', 'u1-unset'))
      .rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
    // 보내지 못한 글은 대화에 남지 않는다(초안은 화면이 그대로 들고 있다).
    expect(r.svc.snapshot(r.root, 'claude').messages.map((m) => m.id)).not.toContain('u1-unset')
  } finally { await r.svc.close() }
})

test('U1: 앱을 다시 켜서 재개한 대화도 "안 고름"을 막는다 — 기본값을 모르면 조용히 이전 모델로 보내지 않는다', async () => {
  const r = rig()
  try {
    // 재시작을 흉내 낸다: 설정에 "전에 골랐다"는 흔적만 남아 있고, 이 연결은 기본값을 모른다.
    const stored = new Map<string, ModelChoice | null>([['claude', null]])
    const svc = new ChatService({
      skillSource: () => skillSource(appRoot, false, ''),
      userData: join(r.root, 'userdata2'),
      emit: () => {}, openExternal: async () => {},
      modelChoice: (p) => stored.get(p) ?? null,
      modelChosen: (p) => stored.has(p),
      storeModelChoice: (p, choice) => { stored.set(p, choice) },
      connectionFactory: (provider, options) => provider === 'claude'
        ? new ClaudeConnection({ ...options, binary: r.binary, env: r.env })
        : { status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, run: async () => {}, respond: () => {}, stop: async () => {} }
    })
    try {
      mkdirSync(join(r.root, '.knuaf-gui'), { recursive: true })
      writeFileSync(join(r.root, '.knuaf-gui', 'chat-claude.json'), JSON.stringify({
        root: r.root, provider: 'claude', sessionId: 'prior-session', state: 'idle',
        messages: [{ id: 'old', role: 'assistant', text: '이전 답변', at: new Date().toISOString() }]
      }))
      svc.snapshot(r.root, 'claude')
      await expect(svc.send(r.root, 'claude', '재개한 대화', 'u1-resume'))
        .rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
    } finally { await svc.close() }
  } finally { await r.svc.close() }
})

test('U1: 요청한 별칭과 초기화가 준 실제 id 는 같은 모델이다 — 거짓 경고를 내지 않는다', async () => {
  const r = rig()
  try {
    const notes: string[] = []
    const options: AgentOptions = {
      binary: r.binary, root: r.root, skill: '', env: r.env, openExternal: async () => {},
      modelChoice: () => ({ model: 'opus', effort: null })
    }
    const conn = new ClaudeConnection(options)
    await conn.run('별칭 확인', undefined, {
      message: () => {}, permission: () => {}, note: (t) => notes.push(t), session: () => {}, skill: () => {}
    })
    expect(notes.filter((n) => n.includes('모델') && n.includes('진행되고 있어요'))).toEqual([])
  } finally { await r.svc.close() }
})

test('U1: 존재하지 않는 모델을 보내면 초기화가 어긋났다고 알린다', async () => {
  const r = rig()
  try {
    const notes: string[] = []
    const conn = new ClaudeConnection({
      binary: r.binary, root: r.root, skill: '', env: r.env, openExternal: async () => {},
      modelChoice: () => ({ model: 'haiku-9', effort: null })
    })
    await conn.run('없는 모델', undefined, {
      message: () => {}, permission: () => {}, note: (t) => notes.push(t), session: () => {}, skill: () => {}
    }).catch(() => {})
    expect(notes.some((n) => n.includes('haiku-9'))).toBe(true)
  } finally { await r.svc.close() }
})

test('U1: ultra 이름표는 있고 한도 안내 줄은 없다 (F22, 형님 11-13)', () => {
  expect(MODEL_PICKER.efforts.ultra).toBe('울트라(자동 분담)')
  // 한도·요금 문구는 학생 화면에서 뺐다 — 다시 생기면 여기서 걸린다.
  expect('ultraNotice' in MODEL_PICKER).toBe(false)
  expect('limitNotice' in MODEL_PICKER).toBe(false)
  // 회사 이름이 문구에 박혀 있지 않다 — 칩은 두 회사가 같이 쓴다.
  expect(MODEL_PICKER.modelsTitleFor('Claude')).toBe('Claude 모델')
  expect(MODEL_PICKER.sameConversationFor('Claude')).toContain('Claude')
  expect(MODEL_PICKER.accountDefaultHintFor('Claude')).toContain('Claude')
})

test('U1: 연결이 없으면 모델 목록은 supported:false 로 남는다 — 통로 없는 공급자의 옛 계약', async () => {
  const conn: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: null, detail: '' }),
    login: async () => {}, run: async () => {}, respond: () => {}, stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => skillSource(appRoot, false, ''),
    userData: mkdtempSync(join(tmpdir(), 'kd-u1-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => conn
  })
  const root = mkdtempSync(join(tmpdir(), 'kd-u1-proj-'))
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  expect(await svc.models(root, 'claude')).toEqual({ provider: 'claude', supported: false, models: [], selected: null })
  await svc.close()
})
