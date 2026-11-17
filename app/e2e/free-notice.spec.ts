// 실제 모델·중계 호출 0회. 가짜 연결이 보낸 사건으로 무료 본대화의 종료 안내를 잠근다.
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { findExecutable, skillSource } from '../src/main/agent'
import { FreeRelayError, freeRelayError } from '../src/main/free/provider'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { Provider } from '../src/shared/chat'
import { CodexConnection } from '../src/main/chat/codex'
import { fakeCodexEnv } from './fixtures/fake-codex'
import { describeFreeRelayError } from '../src/renderer/src/copy'

const source = skillSource(resolve(__dirname, '..'), false, '/nonexistent')
const globals = globalThis as typeof globalThis & { __KNUAF_FREE_TOKEN__?: string }
let previousToken: string | undefined

test.beforeEach(() => {
  previousToken = globals.__KNUAF_FREE_TOKEN__
  // 형식만 맞는 합성 출입증. 연결은 아래 대역뿐이며 네트워크에 보내지 않는다.
  globals.__KNUAF_FREE_TOKEN__ = `kf1_${'A'.repeat(43)}`
})
test.afterEach(() => {
  if (previousToken === undefined) delete globals.__KNUAF_FREE_TOKEN__
  else globals.__KNUAF_FREE_TOKEN__ = previousToken
})

function fixture(run: AgentConnection['run'], stop: AgentConnection['stop'] = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-free-notice-'))
  const svc = new ChatService({
    skillSource: () => source,
    userData: mkdtempSync(join(tmpdir(), 'kd-free-notice-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => ({
      status: async () => ({ installed: true, connected: true, version: null, detail: '' }),
      login: async () => {}, respond: () => {}, run, stop
    })
  })
  return { root, svc }
}

async function finish(svc: ChatService, root: string, provider: Provider) {
  await expect.poll(() => svc.busy(root)).toBe(false)
  return svc.snapshot(root, provider)
}

for (const output of [null, '', ' \n\t']) {
  test(`free-no-answer: 정상 종료 + 빈 답(${JSON.stringify(output)})은 안내`, async () => {
    const { root, svc } = fixture(async (_text, _session, events) => {
      events.note('작업 도구를 확인했어요.')
      if (output !== null) events.message('empty', output)
    })
    try {
      await svc.send(root, 'free', '논문을 작성해 주세요', 'empty-turn')
      const snapshot = await finish(svc, root, 'free')
      expect(snapshot.state).toBe('error')
      expect(snapshot.errorKind).toBe('free-no-answer')
      expect(snapshot.messages.find(m => m.id === 'empty-turn')?.delivery).toBe('sent')
    } finally { await svc.close() }
  })
}

test('free-no-answer: 답이 온 턴은 정상, 다음 무응답 턴은 앞 답에 가려지지 않는다', async () => {
  let turn = 0
  const { root, svc } = fixture(async (_text, _session, events) => {
    if (++turn === 1) events.message('answer', '전공을 알려 주세요.')
  })
  try {
    await svc.send(root, 'free', '시작해 주세요', 'answered')
    const first = await finish(svc, root, 'free')
    expect(first.state).toBe('idle')
    expect(first.errorKind).toBeUndefined()
    await svc.send(root, 'free', '식량작물이에요', 'unanswered')
    const second = await finish(svc, root, 'free')
    expect(second.state).toBe('error')
    expect(second.errorKind).toBe('free-no-answer')
    expect(second.messages.find(m => m.id === 'answer')?.text).toBe('전공을 알려 주세요.')
  } finally { await svc.close() }
})

for (const provider of ['codex', 'claude'] as const) {
  test(`free-no-answer: ${provider} 구독의 빈 정상 종료는 기존 idle 유지`, async () => {
    const { root, svc } = fixture(async () => {})
    try {
      await svc.send(root, provider, '계속해 주세요', 'subscription')
      const snapshot = await finish(svc, root, provider)
      expect(snapshot.state).toBe('idle')
      expect(snapshot.error).toBeUndefined()
      expect(snapshot.errorKind).toBeUndefined()
    } finally { await svc.close() }
  })
}

test('free-no-answer: 무료 중계가 실패하면 기존 오류 종류 유지', async () => {
  const { root, svc } = fixture(async () => { throw new FreeRelayError('free-busy') })
  try {
    await svc.send(root, 'free', '계속해 주세요', 'failed')
    const snapshot = await finish(svc, root, 'free')
    expect(snapshot.state).toBe('error')
    expect(snapshot.errorKind).toBe('free-busy')
  } finally { await svc.close() }
})

test('free-no-answer: 학생 중단 뒤 run이 정상 반환해도 중단 안내 유지', async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const { root, svc } = fixture(async () => { await held }, async () => { release() })
  try {
    await svc.send(root, 'free', '오래 걸리는 일', 'stop')
    await svc.stop(root, 'free')
    const snapshot = await finish(svc, root, 'free')
    expect(snapshot.state).toBe('stopped')
    expect(snapshot.errorKind).toBeUndefined()
    expect(snapshot.error).toBeUndefined()
  } finally { release(); await svc.close() }
})

const progress = { type: 'agentMessage', id: 'progress', text: '전공 표기를 확인했습니다.', phase: null }
const tool = (type: string) => ({ type, id: 'tool', command: 'true', aggregatedOutput: '', exitCode: 0 })
const answer = (phase: string | null = null) => ({ type: 'agentMessage', id: 'answer', text: '작성을 마쳤어요.', phase })

const orderedCases = [
  ...['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
    'functionCallOutput', 'webSearch', 'imageView', 'imageGeneration', 'sleep', 'contextCompaction'].map(type => ({
    name: `진행 서술 → ${type} → 답 없음`, items: [progress, tool(type)], missing: true
  })),
  { name: '진행 서술 → 도구 → phase null 최종 서술', items: [progress, tool('commandExecution'), answer()], missing: false },
  { name: '도구 → 명시적 final_answer', items: [tool('mcpToolCall'), answer('final_answer')], missing: false },
  { name: '도구 → commentary는 최종 답 아님', items: [tool('mcpToolCall'), answer('commentary')], missing: true },
  { name: '도구 → partial_answer는 최종 답 아님', items: [tool('mcpToolCall'), answer('partial_answer')], missing: true },
  { name: '최종 답 뒤 다시 도구 → 답 없음', items: [answer('final_answer'), tool('commandExecution')], missing: true },
  { name: '알려진 한계: G0 도구 → 확인하겠습니다(phase null) → 정상 종료', items: [
    tool('commandExecution'),
    { ...answer(), text: '본문 작성 전에 전공 표기 검사 규칙을 확인하겠습니다.' }
  ], missing: false }
]

for (const provider of ['free', 'codex'] as const) for (const scenario of orderedCases) {
  test(`free-no-answer app-server: ${provider} ${scenario.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-free-events-'))
    const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), {
      FAKE_CODEX_SUBAGENT_EVENTS: JSON.stringify(scenario.items.map(item => ({
        method: 'item/completed', params: { threadId: 't-fake', item }
      })))
    }) }
    const binary = findExecutable('codex', env)
    if (!binary) throw new Error('가짜 Codex 실행기를 찾지 못했어요.')
    const svc = new ChatService({
      skillSource: () => source,
      userData: mkdtempSync(join(tmpdir(), 'kd-free-events-ud-')),
      emit: () => {}, openExternal: async () => {}, env,
      connectionFactory: (_provider, options) => new CodexConnection({ ...options, binary, modelChosen: () => false })
    })
    try {
      await svc.send(root, provider, '논문을 작성해 주세요', 'ordered')
      const snapshot = await finish(svc, root, provider)
      const missing = provider === 'free' && scenario.missing
      expect(snapshot.state).toBe(missing ? 'error' : 'idle')
      expect(snapshot.errorKind).toBe(missing ? 'free-no-answer' : undefined)
      expect(snapshot.messages.find(m => m.id === 'ordered')?.delivery).toBe('sent')
    } finally { await svc.close() }
  })
}

test('free-context-full: Codex incomplete 이유만 새 안내로 분류하고 다른 오류는 유지', () => {
  const message = 'Incomplete response returned, reason: max_output_tokens'
  for (const value of [new Error(message), { message, codexErrorInfo: 'other' }]) {
    const error = freeRelayError(value)
    expect(error.kind).toBe('free-context-full')
    expect(error.message).toBe('free-context-full')
    const copy = describeFreeRelayError(error.kind)
    expect(copy.title).toBe('용량이 찼어요. Claude나 Codex로 바꿔 주세요.')
    expect(copy.action).toBeNull()
    expect(copy.raw).toBe('')
  }
  for (const [message, kind] of [
    ['Incomplete response returned, reason: unknown', 'free-error'],
    ['Incomplete response returned, reason: content_filter', 'free-error'],
    ['Incomplete response returned, reason: max_output_tokens_extra', 'free-error'],
    ['prefixmax_output_tokens', 'free-error'],
    ['Invalid parameter: max_output_tokens', 'free-error'],
    ['busy', 'free-busy'], ['daily_limit', 'free-daily-limit'], ['401 unauthorized', 'free-auth']
  ]) expect(freeRelayError(new Error(message)).kind).toBe(kind)
  expect(freeRelayError({ message: 'busy', param: 'max_output_tokens' }).kind).toBe('free-busy')
})

for (const provider of ['free', 'codex'] as const) {
  test(`free-context-full app-server: ${provider} 진행 서술 뒤 incomplete 실패`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-free-incomplete-'))
    const message = 'Incomplete response returned, reason: max_output_tokens'
    const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), {
      FAKE_CODEX_SUBAGENT_EVENTS: JSON.stringify([
        { method: 'item/completed', params: { threadId: 't-fake', item: {
          ...progress, text: '본문 작성 전에 전공 표기 검사 규칙을 확인하겠습니다.'
        } } },
        { method: 'turn/completed', params: { threadId: 't-fake', turn: {
          id: 'u-fake', status: 'failed', error: { message, codexErrorInfo: 'other' }
        } } }
      ])
    }) }
    const binary = findExecutable('codex', env)
    if (!binary) throw new Error('가짜 Codex 실행기를 찾지 못했어요.')
    const svc = new ChatService({
      skillSource: () => source,
      userData: mkdtempSync(join(tmpdir(), 'kd-free-incomplete-ud-')),
      emit: () => {}, openExternal: async () => {}, env,
      connectionFactory: (_provider, options) => new CodexConnection({ ...options, binary, modelChosen: () => false })
    })
    try {
      await svc.send(root, provider, '논문을 작성해 주세요', 'incomplete')
      const snapshot = await finish(svc, root, provider)
      expect(snapshot.state).toBe('error')
      expect(snapshot.messages.find(m => m.id === 'progress')?.text).toContain('확인하겠습니다.')
      if (provider === 'free') {
        expect(snapshot.errorKind).toBe('free-context-full')
        expect(describeFreeRelayError(snapshot.errorKind!).title).toBe('용량이 찼어요. Claude나 Codex로 바꿔 주세요.')
      } else {
        expect(snapshot.errorKind).toBeUndefined()
        expect(snapshot.error).toBe(message)
      }
    } finally { await svc.close() }
  })
}
