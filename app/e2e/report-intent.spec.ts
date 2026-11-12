/** Node-only: report intent lifecycle; no Electron, browser, or network. */
import { expect, test } from '@playwright/test'
import { applyReportIntent, requestDraftText, requestReport, useReportIntent, type DraftIntent } from '../src/renderer/src/screens/Chat'
import { useChat } from '../src/renderer/src/store/chat'
import { useProject } from '../src/renderer/src/store/project'
import { zoneOf } from '../src/shared/zone'
import type { ConnectionStatus } from '../src/shared/chat'

const connected: ConnectionStatus = { installed: true, connected: true, version: 'test', detail: '' }
const loginNeeded: ConnectionStatus = { installed: true, connected: false, version: 'test', detail: '' }
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

test.beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knuaf: { chat: { setDraft: async () => ({ result: true }) } } } })
  useProject.setState({ root: '/A', paneView: 'chat' })
  useChat.setState({ root: '/A', draft: '쓰던 글', draftSeq: 0 })
  useReportIntent.setState({ intent: null })
})
test.afterEach(() => {
  useReportIntent.setState({ intent: null })
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function pending() {
  requestReport()
  const intent = useReportIntent.getState().intent
  if (!intent) throw new Error('report request missing')
  return intent
}

function apply(intent: DraftIntent, projectRoot: string | null, chatRoot: string | null, state: 'checking' | 'connected' | 'need-login' | 'failed' | 'unknown', connection: ConnectionStatus | null) {
  return applyReportIntent(intent, projectRoot, chatRoot, state, zoneOf(null, connection, null).kind === 'disconnected')
}

test('연결 확인 중 요청은 유지되고 연결 성공 뒤 기존 초안 앞에 붙는다', () => {
  const intent = pending()
  expect(apply(intent, '/A', '/A', 'checking', null)).toBeNull()
  expect(useReportIntent.getState().intent).toEqual(intent)
  expect(useChat.getState().draft).toBe('쓰던 글')
  expect(apply(intent, '/A', '/A', 'connected', connected)).toBe('ready')
  expect(useChat.getState().draft).toBe('신고할래 — \n쓰던 글')
  expect(useReportIntent.getState().intent).toBeNull()
})

test('연결 확인 중에서 로그인 필요로 바뀌면 안내하고 초안은 보존한다', () => {
  const intent = pending()
  expect(apply(intent, '/A', '/A', 'checking', null)).toBeNull()
  expect(apply(intent, '/A', '/A', 'need-login', loginNeeded)).toBe('disconnected')
  expect(useChat.getState().draft).toBe('쓰던 글')
  expect(useReportIntent.getState().intent).toBeNull()
})

test('확인 중 다른 논문으로 이동하면 이전 요청은 버린다', () => {
  const intent = pending()
  expect(apply(intent, '/A', '/A', 'checking', null)).toBeNull()
  useProject.setState({ root: '/B' })
  useChat.setState({ root: '/B', draft: '다른 논문' })
  expect(apply(intent, '/B', '/B', 'checking', null)).toBeNull()
  expect(useReportIntent.getState().intent).toBeNull()
  expect(apply(intent, '/B', '/B', 'connected', connected)).toBeNull()
  expect(useChat.getState().draft).toBe('다른 논문')
})

test('확인 실패와 unknown은 로그인 필요로 오인하지 않는다', () => {
  for (const state of ['failed', 'unknown'] as const) {
    const intent = pending()
    expect(apply(intent, '/A', '/A', state, null)).toBe('status-failed')
    expect(useChat.getState().draft).toBe('쓰던 글')
    expect(useReportIntent.getState().intent).toBeNull()
  }
})

test('같은 요청 재실행은 한 번만 적용하고 다른 요청은 각각 적용한다', () => {
  const first = pending()
  expect(apply(first, '/A', '/A', 'connected', connected)).toBe('ready')
  expect(apply(first, '/A', '/A', 'connected', connected)).toBeNull()
  expect(useChat.getState().draft).toBe('신고할래 — \n쓰던 글')
  const second = pending()
  expect(apply(first, '/A', '/A', 'connected', connected)).toBeNull()
  expect(useReportIntent.getState().intent).toEqual(second)
  expect(apply(second, '/A', '/A', 'connected', connected)).toBe('ready')
  expect(useChat.getState().draft).toBe('신고할래 — \n신고할래 — \n쓰던 글')
})

/**
 * 알림의 [각주 넣어 줘] — 신고가 아니라 입력칸 채우기다. 신고 접두사가 붙지 않고, AI 연결·차단
 * 상태와 무관하게 채우며, 보내지 않는다(보내기 단추는 학생 손 아래 그대로).
 *
 * 판정 중요3 — **학생이 쓰던 글을 지우지 않는다**: 비었으면 그 문장만, 있으면 줄을 바꿔 덧붙인다.
 */
function fill(text: string, projectRoot = '/A', chatRoot = '/A', state: 'checking' | 'connected' | 'need-login' | 'failed' | 'unknown' = 'failed', connection: ConnectionStatus | null = null) {
  requestDraftText(text)
  const intent = useReportIntent.getState().intent
  if (!intent) throw new Error('draft request missing')
  expect(intent.text).toBe(text)
  return apply(intent, projectRoot, chatRoot, state, connection)
}

test('알림의 채우기 요청은 신고 접두사 없이 그 문장만 넣고 연결 상태를 따지지 않는다', () => {
  const text = '각주 넣어 줘'
  // 끊김·확인 실패 상태여도 채운다 — 채우기는 도우미 호출이 아니다.
  expect(fill(text)).toBe('ready')
  expect(useChat.getState().draft).toBe('쓰던 글\n각주 넣어 줘')
  expect(useReportIntent.getState().intent).toBeNull()
})

test('입력칸이 비었으면 그 문장만 넣는다', () => {
  useChat.setState({ draft: '' })
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(useChat.getState().draft).toBe('각주 넣어 줘')
})

test('입력칸이 공백뿐이면 학생 글으로 치지 않고 그 문장만 넣는다', () => {
  useChat.setState({ draft: '  \n ' })
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(useChat.getState().draft).toBe('각주 넣어 줘')
})

test('이미 줄바꿈으로 끝나는 초안 뒤에는 빈 줄을 만들지 않고 덧붙인다', () => {
  useChat.setState({ draft: '쓰던 글\n' })
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(useChat.getState().draft).toBe('쓰던 글\n각주 넣어 줘')
})

test('같은 채우기를 연속으로 눌러도 문장이 두 번 쌓이지 않는다', () => {
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(useChat.getState().draft).toBe('쓰던 글\n각주 넣어 줘')
})

test('채우기는 초안만 바꾸고 보내지 않는다 — 전송 계열 호출이 없고 초안 순번만 오른다', () => {
  const sent: unknown[] = []
  const chat = (globalThis.window as unknown as { knuaf: { chat: Record<string, unknown> } }).knuaf.chat
  chat.send = (...args: unknown[]) => { sent.push(args); return { result: true } }
  const before = useChat.getState().draftSeq
  expect(fill('각주 넣어 줘')).toBe('ready')
  expect(sent).toEqual([])
  expect(useChat.getState().draftSeq).toBe(before + 1)
})
