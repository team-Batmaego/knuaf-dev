/** Node-only: report intent lifecycle; no Electron, browser, or network. */
import { expect, test } from '@playwright/test'
import { applyReportIntent, requestReport, useReportIntent, type DraftIntent } from '../src/renderer/src/screens/Chat'
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
