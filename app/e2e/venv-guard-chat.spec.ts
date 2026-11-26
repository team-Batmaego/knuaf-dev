// 검토 r1 I-02: 준비 전에 만들어진 본대화 연결이 준비가 끝난 뒤에도 빈 환경·옛 PATH 를 계속 쓰면, 앱과 사이드카는
// 준비 완료인데 도우미만 새 앱 환경(KNUAF_DEPS_VENV·PATH)을 못 본다. 전송 직전에 환경을 비교해 바뀌었으면 연결을 새로 연다.
// 실제 ChatService·subscriptionEnv 를 쓰고 외부 에이전트 연결만 가짜다(Codex·Claude CLI 실행 없음).
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import type { AgentConnection, AgentOptions } from '../src/main/chat/contracts'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

function setup() {
  const userData = mkdtempSync(join(tmpdir(), 'knuaf-i02-')), root = mkdtempSync(join(tmpdir(), 'knuaf-i02-root-'))
  const created: { options: AgentOptions; stopped: boolean; sent: string[] }[] = []
  const state = { deps: '/app/deps/_none', python: null as string | null }
  const service = new ChatService({
    skillSource: () => source, userData, emit: () => {}, openExternal: async () => {},
    depsVenv: () => state.deps, venvPython: () => state.python,
    connectionFactory: (_provider, options) => {
      const entry = { options, stopped: false, sent: [] as string[] }
      created.push(entry)
      const connection: AgentConnection = {
        status: async () => ({ connected: true, installed: true, version: 'test', detail: '' }),
        login: async () => { throw new Error('login forbidden') },
        run: async (body) => { entry.sent.push(body) }, respond: () => {}, stop: async () => { entry.stopped = true }
      }
      return connection
    }
  })
  return { service, root, created, state }
}

test('I-02: 준비 전 status → 준비 완료 → 같은 폴더 send 는 새 앱 환경이 든 연결로 간다', async () => {
  const h = setup()
  try {
    await h.service.status(h.root, 'codex') // 준비 전: "없음" 경로·옛 PATH 로 연결이 만들어진다
    expect(h.created).toHaveLength(1)
    expect(h.created[0].options.env![ 'KNUAF_DEPS_VENV' ]).toBe('/app/deps/_none')
    // 준비 완료(main 이 표식을 쓰고 사이드카를 다시 띄움)
    h.state.deps = '/app/deps/0123456789abcdef'; h.state.python = '/app/deps/0123456789abcdef/bin/python3'
    await h.service.send(h.root, 'codex', '다음 말', 'req-1')
    expect(h.created).toHaveLength(2)
    expect(h.created[0].stopped).toBe(true) // 옛 연결은 정리
    const env = h.created[1].options.env!
    expect(env['KNUAF_DEPS_VENV']).toBe('/app/deps/0123456789abcdef')
    expect((env.PATH ?? env.Path ?? '').split(delimiter)[0]).toBe(dirname(h.state.python))
    expect(env['KNUAF_DEPS_VENV_READONLY']).toBe('1')
  } finally { await h.service.close() }
})

test('I-02: 환경이 그대로면 연결을 다시 만들지 않는다', async () => {
  const h = setup()
  try {
    await h.service.status(h.root, 'codex')
    await h.service.send(h.root, 'codex', '하나', 'req-1')
    expect(h.created).toHaveLength(1)
    expect(h.created[0].stopped).toBe(false)
  } finally { await h.service.close() }
})
