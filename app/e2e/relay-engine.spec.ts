// 배선 A — 담당(relay) 엔진 연결.
// 실제 AI 호출 0회: Claude 는 동봉 CLI + 127.0.0.1 가짜 Messages API, Codex 는 실 app-server +
// 가짜 Responses 백엔드. 시험 계획 A ④(a)~(d).
import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  ClaudeRelayConnection, claudeExecutionAccount, claudeSubscriptionTier, claudeUsageState
} from '../src/main/chat/claude'
import { CodexRelayConnection, codexExecutionAccount, codexRelayLockdown, codexSandboxPolicy, codexThreadParams, codexUsageState } from '../src/main/chat/codex'
import { JsonRpcProcess } from '../src/main/chat/transport'
import { relayIsolation } from '../src/main/chat/jobs/isolation'
import { claudeTokens, codexTokens, tokenRecord } from '../src/main/chat/jobs/tokens'
import type { ExecutionAccount, JobEvents, RelayRequest, UsageState } from '../src/main/chat/jobs/types'
import type { AgentOptions } from '../src/main/chat/contracts'

const appRoot = process.cwd()

/** 동봉 Claude CLI — `u5b-real-cli.spec.ts` 와 같은 해석 경로. 없으면 시험을 건너뛴다. */
function bundledCli(): string | null {
  try {
    const require = createRequire(join(appRoot, 'package.json'))
    const fromSdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
    const pkg = fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}/package.json`)
    const binary = join(dirname(pkg), 'claude')
    return existsSync(binary) ? binary : null
  } catch { return null }
}

/** PATH 의 codex — 동봉본은 이 맥(arm64)에 없다(`app/scripts/fetch-codex.mjs` 는 x86_64 Windows). */
function systemCodex(): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'codex')
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  return null
}

function appDir(tag: string): string { return realpathSync(mkdtempSync(join(tmpdir(), `kd-app-${tag}-`))) }

function fixtureRoot(tag: string): { root: string; out: string; skill: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `kd-relay-${tag}-`)))
  const out = join(root, '.knuaf-gui', 'jobs', 'j1', 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: knuaf-dev\ndescription: relay engine spec\n---\nRELAY-SPEC-SKILL\n')
  return { root, out, skill }
}

function agentOptions(binary: string, root: string, skill: string, env: NodeJS.ProcessEnv = {}): AgentOptions {
  return { binary, root, skill, env: { PATH: process.env.PATH, ...env }, openExternal: async () => {} }
}

function request(root: string, out: string, skill: string, overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    key: `${root}\0claude\0job:j1`, jobId: 'j1', company: 'claude', cwd: out, skill,
    model: 'sonnet', effort: 'high', isolation: relayIsolation(out, ['result.md'], true), ...overrides
  }
}

/** 주문 하나를 돌리며 엔진이 올린 이벤트를 모은다. `message`·`note`·`permission` 은 담당에서 쓰지 않는다. */
function recorder() {
  const seen: { kind: string; value: unknown }[] = []
  const events: JobEvents = {
    message: (id, text) => seen.push({ kind: 'message', value: [id, text] }),
    note: text => seen.push({ kind: 'note', value: text }),
    permission: request => seen.push({ kind: 'permission', value: request }),
    skill: () => seen.push({ kind: 'skill', value: true }),
    session: id => seen.push({ kind: 'session', value: id }),
    availability: (state: UsageState) => seen.push({ kind: 'availability', value: state }),
    tokens: event => seen.push({ kind: 'tokens', value: event }),
    actualModel: (model, effort) => seen.push({ kind: 'actualModel', value: [model, effort] })
  }
  return { seen, events, of: (kind: string) => seen.filter(s => s.kind === kind).map(s => s.value) }
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => handler(req, res, body))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('가짜 서버 주소를 얻지 못했어요')
  return { server, port: address.port, close: () => new Promise<void>(r => server.close(() => r())) }
}

test('relay A 판정은 관측된 사건만 쓴다', () => {
  const cases: [Parameters<typeof claudeUsageState>[0], UsageState][] = [
    [{ status: 'allowed' }, 'allowed'],
    [{ status: 'allowed_warning' }, 'allowed'],
    [{ status: 'allowed', utilization: 0.99, resetsAt: Date.now() + 60_000 }, 'allowed'],
    [{ status: 'allowed', isUsingOverage: true }, 'limit'],
    [{ status: 'allowed', overageInUse: true }, 'limit'],
    [{ status: 'rejected' }, 'limit'],
    [{ status: 'something-new' }, 'unknown'],
    [{}, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown']
  ]
  for (const [info, expected] of cases) expect(claudeUsageState(info), JSON.stringify(info)).toBe(expected)
  // Codex: 스키마 주석 "Null means unavailable" — true 만 A, false 는 한도 밖, 나머지는 모름.
  expect(codexUsageState(true)).toBe('allowed')
  expect(codexUsageState(false)).toBe('limit')
  expect(codexUsageState(null)).toBe('unknown')
  expect(codexUsageState(undefined)).toBe('unknown')
  expect(codexUsageState('true')).toBe('unknown')
  // 구독 이름은 `"Claude Max"` 처럼 온다(실측 accountInfo) — `lanes.ts` 의 `'max'` 로 접힌다.
  expect(claudeSubscriptionTier('Claude Max')).toBe('max')
  expect(claudeSubscriptionTier('max')).toBe('max')
  expect(claudeSubscriptionTier('Claude Pro')).toBe('pro')
  expect(claudeSubscriptionTier('free')).toBeNull()
  expect(claudeSubscriptionTier(null)).toBeNull()
})

test('relay 요청·토큰 변환이 계약 모양을 지킨다', () => {
  const { root, out, skill } = fixtureRoot('shape')
  const isolation = relayIsolation(out, ['result.md'], true)
  // 격리 요청은 설계 §3.3 의 네 값을 그대로 들고 있어야 한다.
  expect(isolation.settingSources).toEqual([])
  expect(isolation.codexSandbox).toBe('workspace-write')
  expect(isolation.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
  // 출력 칸 밖 쓰기·하위 담당·(셸 꺼짐) 셸은 거절, 출력 칸 안 쓰기는 허용.
  expect(isolation.preToolUse('Write', { file_path: join(out, 'result.md') }).permissionDecision).toBe('allow')
  expect(isolation.preToolUse('Write', { file_path: join(out, 'other.md') }).permissionDecision).toBe('deny')
  expect(isolation.preToolUse('Write', { file_path: join(root, 'outside.md') }).permissionDecision).toBe('deny')
  expect(isolation.preToolUse('Write', { file_path: '../outside.md' }).permissionDecision).toBe('deny')
  expect(isolation.preToolUse('Edit', { file_path: join(out, 'result.md') }).permissionDecision).toBe('allow')
  expect(isolation.preToolUse('Agent', {}).permissionDecision).toBe('deny')
  expect(isolation.preToolUse('Task', {}).permissionDecision).toBe('deny')
  expect(isolation.preToolUse('Bash', { command: 'echo hi' }).permissionDecision).toBe('allow')
  expect(isolation.preToolUse('Bash', { command: 'echo hi', dangerouslyDisableSandbox: true }).permissionDecision).toBe('deny')
  const shellOff = relayIsolation(out, ['result.md'], false)
  expect(shellOff.preToolUse('Bash', { command: 'echo hi' }).permissionDecision).toBe('deny')
  // 앱이 승인한 셸(`appApproved`)은 통과하되, 출력 칸 판정은 그대로다.
  expect(isolation.canUseTool('Bash', { command: 'ls' }, true).permissionDecision).toBe('allow')
  expect(isolation.canUseTool('Bash', { command: 'ls' }, false).permissionDecision).toBe('deny')
  expect(isolation.canUseTool('Write', { file_path: join(root, 'x.md') }, true).permissionDecision).toBe('deny')
  // 토큰 변환 — SDK 필드 이름만 옮기고 합산하지 않는다.
  expect(claudeTokens({ input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }, 1, 1))
    .toEqual({ company: 'claude', requestSequence: 1, notificationSequence: 1,
      usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 7, cacheWriteInputTokens: 2 } })
  expect(codexTokens({ last: { inputTokens: 1 }, total: { inputTokens: 2 } }, 1, 2))
    .toEqual({ company: 'codex', requestSequence: 1, notificationSequence: 2, last: { inputTokens: 1 }, total: { inputTokens: 2 } })
  // 기록은 화이트리스트 투영만 — 모르는 필드는 버리고 순번이 비정수면 만들지 않는다.
  const context = { conversationId: 's', jobId: 'j1', company: 'claude' as const, model: 'sonnet', effort: 'high', role: 'research', at: 'now' }
  expect(tokenRecord({ conversationId: 's', jobId: 'j1', company: 'claude', model: 'sonnet', effort: 'high', role: 'research' },
    { ...claudeTokens({ input_tokens: 1, output_tokens: 1 }, 1, 1), leaked: 'x' } as never, 'now')).toEqual({
    conversationId: 's', jobId: 'j1', company: 'claude', model: 'sonnet', effort: 'high', role: 'research',
    firstRequest: true, requestSequence: 1, notificationSequence: 1, at: 'now', usage: { inputTokens: 1, outputTokens: 1 }
  })
  expect(tokenRecord(context, claudeTokens({ input_tokens: 1, output_tokens: 1 }, 0, 1), 'now')).toBeNull()
  // 계정 값의 생산은 한 곳 — `consented` 는 엔진이 정하지 않고(앱 저장소가 정본), `usage` 도 여기선 모름.
  const account = claudeExecutionAccount(agentOptions('/fake/claude', root, skill), [{ model: 'sonnet', name: 'Sonnet', efforts: ['high'] }],
    { apiKeySource: 'none', subscriptionType: 'Claude Max', subject: 'me@example.com' })
  expect(Object.keys(account)).toEqual(['accountId', 'connected', 'account', 'consented', 'usage'])
  expect(account.consented).toBe(false)
  expect(account.usage).toBe('unknown')
  expect(account.connected).toBe(true)
  expect(account.account).toEqual({ company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [{ model: 'sonnet', name: 'Sonnet', efforts: ['high'] }] })
  const codexAccount = codexExecutionAccount(agentOptions('/fake/codex', root, skill), null, { accountId: 'acct-1', accountType: 'chatgpt' })
  expect(Object.keys(codexAccount)).toEqual(['accountId', 'connected', 'account', 'consented', 'usage'])
  expect(codexAccount.accountId).toBe('acct-1')
  expect(codexAccount.account).toEqual({ company: 'codex', accountType: 'chatgpt', models: null })
  void request
})

test('담당 연결은 본대화 동작을 거절하고 러너 계약만 받는다', async () => {
  const { root, out, skill } = fixtureRoot('contract')
  const claude = new ClaudeRelayConnection(agentOptions('/fake/claude', root, skill), request(root, out, skill), appDir('contract'))
  const codex = new CodexRelayConnection(agentOptions('/fake/codex', root, skill), request(root, out, skill, { company: 'codex' }))
  for (const connection of [claude, codex]) {
    expect(connection.relayProtocol).toBe(1)
    await expect(connection.run()).rejects.toThrow()
    await expect(connection.login()).rejects.toThrow()
    // 러너는 승인 응답을 무조건 부른다 — 여기서 던지면 정리가 흐트러진다.
    expect(() => connection.respond('x', false)).not.toThrow()
  }
})

type ClaudeRate = 'allowed' | 'rejected' | 'overage'

/**
 * 실물 Claude CLI 담당 연결 시험대 — 동봉 CLI + 127.0.0.1 가짜 Messages API.
 * `writes` 만큼 Write 도구를 시키고, 그 뒤 마무리 글을 낸다. `rate` 로 응답 헤더의 한도 상태를 정한다.
 */
async function claudeRelayFixture(opts: { escapes: boolean; rate: ClaudeRate }) {
  const cli = bundledCli()
  if (!cli) return null
  const { root, out, skill } = fixtureRoot(`claude-${opts.rate}`)
  const messages: string[] = []
  let turn = 0
  // 한도 상태는 **응답 헤더**로만 온다 — 앱이 추론하지 않고 엔진이 관측한 사건을 옮기는지 본다.
  const rateHeaders = {
    'anthropic-ratelimit-unified-status': opts.rate === 'rejected' ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-status': opts.rate === 'rejected' ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': opts.rate === 'rejected' ? '1.0' : '0.2',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'anthropic-ratelimit-unified-overage-status': 'allowed',
    'anthropic-ratelimit-unified-overage-in-use': opts.rate === 'overage' ? 'true' : 'false'
  }
  // ① 출력 칸 안 쓰기, ② (옵션) 같은 도구로 출력 칸 밖 쓰기 시도.
  const writes = [
    { file_path: join(out, 'result.md'), content: 'relay result' },
    ...(opts.escapes ? [{ file_path: join(root, 'escaped.md'), content: 'must not exist' }] : [])
  ]
  const fake = await startServer((req, res, body) => {
    messages.push(`${req.method} ${req.url}`)
    const send = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json', ...rateHeaders }); res.end(JSON.stringify(value)) }
    if (req.url?.includes('count_tokens')) return send(200, { input_tokens: 10 })
    if (!req.url?.startsWith('/v1/messages')) {
      if (req.url?.includes('/models')) return send(200, { data: [{ id: 'claude-sonnet-5', display_name: 'Sonnet', type: 'model' }], has_more: false })
      return send(200, {})
    }
    if (req.method === 'GET') return send(200, {})
    let parsed: { messages?: { content?: unknown }[] } = {}
    try { parsed = JSON.parse(body) } catch { /* 빈 본문 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...rateHeaders })
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    sse('message_start', { type: 'message_start', message: { id: `m${turn}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 21 + turn, output_tokens: 4 } } })
    if (turn < writes.length) {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${turn}`, name: 'Write', input: {} } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(writes[turn]) } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })
    } else {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    }
    sse('message_stop', { type: 'message_stop' })
    turn++
    res.end()
  })
  // 가짜 claude.ai 구독 자격 — API 키 경로가 아니다(relay 는 `ANTHROPIC_API_KEY` 를 쓰지 않는다).
  const home = join(root, 'home'), cfg = join(root, 'cfg'); mkdirSync(home); mkdirSync(cfg)
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'sk-ant-oat01-FAKE-for-local-mock-only', refreshToken: 'sk-ant-ort01-FAKE',
    expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }))
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fake@example.com', organizationUuid: 'x', accountUuid: 'y' },
    hasCompletedOnboarding: true, projects: { [out]: { hasTrustDialogAccepted: true }, [root]: { hasTrustDialogAccepted: true } } }))
  const options = agentOptions(cli, root, skill, {
    HOME: home, CLAUDE_CONFIG_DIR: cfg, TMPDIR: process.env.TMPDIR ?? '/tmp',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1'
  })
  const app = appDir('claude-run')
  const connection = new ClaudeRelayConnection(options, request(root, out, skill), app)
  const log = recorder()
  return { root, out, skill, app, connection, log, messages, close: () => fake.close() }
}

test('실물 Claude CLI 담당: 출력 칸 안만 쓰고 밖은 거절한다', { timeout: 180_000 }, async () => {
  const harness = await claudeRelayFixture({ rate: 'allowed', escapes: true })
  if (!harness) test.skip(true, '동봉 Claude CLI 가 없어 건너뜁니다')
  const { root, out, app, connection, log, messages, close } = harness
  try {
    const account = await connection.availability()
    // A 는 턴 밖에서 관측할 수 없다 — 지어내지 않고 모름으로 둔다(설계 §3.5 '시운전 확인거리').
    expect(account.usage).toBe('unknown')
    expect(account.consented).toBe(false)
    expect(account.account.company).toBe('claude')
    expect((account.account.models ?? []).map(m => m.model)).toContain('sonnet')

    await connection.runJob('/knuaf-dev 담당 모드: 주문서', log.events)
    expect(log.of('skill')).toEqual([true])
    expect(log.of('session').length).toBeGreaterThan(0)
    expect(String(log.of('session')[0])).not.toBe('')
    const states = log.of('availability') as UsageState[]
    expect(states.length).toBeGreaterThan(0)
    expect(states.every(s => s === 'allowed')).toBe(true)
    const tokens = log.of('tokens') as { company: string; requestSequence: number; notificationSequence: number }[]
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(t => t.company === 'claude' && t.requestSequence === 1)).toBe(true)
    const actual = log.of('actualModel') as [string, string | null][]
    expect(actual.length).toBe(1)
    expect(actual[0][0]).toContain('sonnet')
    expect(readFileSync(join(out, 'result.md'), 'utf8')).toBe('relay result')
    expect(existsSync(join(root, 'escaped.md'))).toBe(false)
    expect(messages.some(m => m.startsWith('POST /v1/messages'))).toBe(true)
    // 주문이 끝나면 그 주문의 플러그인 폴더가 남지 않는다(3회차: 앱 전용 자리 + 수명).
    expect(existsSync(join(app, 'relay-plugin', 'j1'))).toBe(false)
  } finally {
    await connection.stop(); await close()
  }
})

test('실물 Claude CLI 담당: 진행 중 한도가 깨지면 그 자리에서 멈춘다', { timeout: 180_000 }, async () => {
  // 응답 헤더가 rejected 면 엔진은 첫 rate_limit_event 에서 limit 으로 닫아야 한다(설계 §3.5 규칙 3).
  const harness = await claudeRelayFixture({ rate: 'rejected', escapes: false })
  if (!harness) test.skip(true, '동봉 Claude CLI 가 없어 건너뜁니다')
  const { connection, log, close } = harness
  try {
    await expect(connection.runJob('/knuaf-dev 담당 모드: 주문서', log.events)).rejects.toMatchObject({ status: 'limit' })
    expect(log.of('availability')).toContain('limit')
    // 한도로 닫혔으면 토큰·결과를 넘기지 않는다.
    expect(log.of('tokens')).toEqual([])
  } finally { await connection.stop(); await close() }
})

test('Codex 담당 연결: 격리 정책과 거절을 실제 파라미터로 보낸다', { timeout: 120_000 }, async () => {
  const { root, out, skill } = fixtureRoot('codex-wire')
  const logFile = join(root, 'app-server.log')
  writeFileSync(logFile, '')
  // 가짜 app-server — 이 클래스가 실제로 보내는 값만 본다(실물은 아래 시험이 맡는다).
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const options = agentOptions(process.execPath, root, skill, {
    KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill), KD_FAKE_ALLOWED: 'true'
  })
  // `serverArgsFor` 가 붙이는 `app-server` 인자를 흉내내려면 argv 가 필요하다 — 스크립트를
  // 그대로 띄우도록 얇은 래퍼를 쓴다(Node 는 스크립트 경로를 첫 인자로 받는다).
  const connection = new CodexRelayConnection({ ...options, binary: `${process.execPath} ${binary}`.replace(/ /g, '\u0000') },
    request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' }))
  void connection
  // 실행 가능한 래퍼 스크립트를 만들어 `binary` 자리에 넣는다.
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  const wired = new CodexRelayConnection({ ...options, binary: wrapper },
    request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' }))
  const recorderEvents = recorder()
  try {
    const account = await wired.availability()
    expect(account.connected).toBe(true)
    expect(account.consented).toBe(false)
    expect(account.account).toEqual({ company: 'codex', accountType: 'chatgpt', models: [{ model: 'gpt-5-codex', name: 'GPT-5 Codex', efforts: ['low', 'high'] }] })
    // 가짜가 `ordinaryUsageAllowed: true` 를 주므로 여기서는 A 로 판정된다 — 판정 경로 확인용.
    expect(account.usage).toBe('allowed')

    await wired.runJob('담당 모드: 주문서', recorderEvents.events)
    expect(recorderEvents.of('skill')).toEqual([true])
    expect(String(recorderEvents.of('session')[0])).toBe('thread-fake')
    expect(recorderEvents.of('actualModel')).toEqual([['gpt-5-codex', 'high']])
    const tokens = recorderEvents.of('tokens') as { company: string; last: unknown; total: unknown; notificationSequence: number }[]
    expect(tokens.length).toBe(1)
    expect(tokens[0].company).toBe('codex')
    expect(tokens[0].notificationSequence).toBe(1)
    // 화이트리스트 투영은 0 도 그대로 남긴다(합산·추정 없음).
    expect(tokens[0].last).toEqual({ totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5 })
    expect(tokens[0].total).toEqual({ totalTokens: 30, inputTokens: 20, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 10 })
  } finally { await wired.stop() }

  const entries = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const thread = entries.find(e => e.method === 'thread/start')
  const turn = entries.find(e => e.method === 'turn/start')
  expect(thread).toBeTruthy(); expect(turn).toBeTruthy()
  // ① app-server 도 작업 폴더에서 띄운다 — 서버 기본 cwd 가 남의 폴더가 되지 않게.
  expect(thread.spawnCwdReal).toBe(realpathSync(out))
  expect(thread.params.cwd).toBe(out)
  expect(thread.params.approvalPolicy).toBe('on-request')
  expect(thread.params.sandbox).toBe('workspace-write')
  expect(thread.params.model).toBe('gpt-5-codex')
  /**
   * 담당은 학생 설정의 MCP·플러그인·Apps를 물려받지 않는다(발주 C3). 이름은 `config/read` 가
   * 준 것만 쓰고, 전체 끄기 키가 없다는 사실은 위 실측 주석 참조.
   */
  const lockdown = thread.params.config
  expect(lockdown.features).toEqual({ apps: false })
  expect(lockdown.mcp_servers).toEqual({ 'user-mcp': { enabled: false }, 'other-mcp': { enabled: false } })
  // 설정 표(1개)뿐 아니라 **설치 목록**(2개)도 꺼야 한다 — 원격 Apps 플러그인은 설정에 없다.
  expect(lockdown.plugins).toEqual({ 'plug@mkt': { enabled: false }, 'remote-apps@remote': { enabled: false } })
  // 이름은 요청 문맥(cwd)으로 읽는다 — 프로젝트 층이 섞이지 않게 `includeLayers:false`.
  const configRead = entries.find(e => e.method === 'config/read')
  expect(configRead.params).toEqual({ cwd: out, includeLayers: false })
  // 걸린 뒤 서버에 확인한다 — 스레드 문맥의 상태 목록에 살아 있는 서버가 없어야 통과한다.
  expect(entries.some(e => e.method === 'mcpServerStatus/list' && e.params?.threadId === 'thread-fake')).toBe(true)
  // ② 턴마다 샌드박스 정책을 싣는다 — 이것이 없으면 실물에서 밖 쓰기가 통과했다.
  expect(turn.params.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [out],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
  expect(turn.params.model).toBe('gpt-5-codex')
  expect(turn.params.effort).toBe('high')
  expect(turn.params.input[0]).toEqual({ type: 'text', text: '담당 모드: 주문서', text_elements: [] })
  expect(turn.params.input[1]).toEqual({ type: 'skill', name: 'knuaf-dev', path: join(skill, 'SKILL.md') })
  // ③ 스킬 폴더가 작업 폴더 밖이므로 경로 루트를 먼저 알린다(실측: 없으면 발견 못 함).
  const extraRoots = entries.find(e => e.method === 'skills/extraRoots/set')
  expect(extraRoots.params.extraRoots).toEqual([dirname(skill)])
  // ④ 승인·인터뷰·토큰 갱신 요청은 전부 자동 거절/빈 답 — 묻는 학생이 없다.
  const responses = entries.filter(e => e.response !== undefined)
  expect(responses.some(r => r.method === 'item/commandExecution/requestApproval' && r.result?.decision === 'decline')).toBe(true)
  expect(responses.some(r => r.method === 'item/tool/requestUserInput' && r.result?.answers && Object.keys(r.result.answers).length === 0)).toBe(true)
  expect(responses.some(r => r.method === 'account/chatgptAuthTokens/refresh' && r.error?.code === -32601)).toBe(true)
})

test('Codex 담당 연결: 제한이 안 걸리면 턴을 열지 않는다', { timeout: 120_000 }, async () => {
  // 실물에서는 `thread/start.config` 를 무시하는 옛 판이나 사용자 설정이 이기는 경우가 이 모양이다.
  // 앱은 보낸 값이 아니라 **서버가 돌려준 상태**로 판정하고, 살아 있는 도구가 있으면 턴을 열지 않는다.
  const { root, out, skill } = fixtureRoot('codex-lock-ignored')
  const logFile = join(root, 'app-server.log')
  writeFileSync(logFile, '')
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  const connection = new CodexRelayConnection(
    agentOptions(wrapper, root, skill, {
      KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill),
      KD_FAKE_ALLOWED: 'true', KD_FAKE_IGNORE_LOCKS: '1'
    }),
    request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' }))
  try {
    await expect(connection.runJob('담당 모드: 주문서', recorder().events))
      .rejects.toThrow(/MCP 서버가 꺼지지 않았어요/)
  } finally { await connection.stop() }
  const entries = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  // 스레드는 열렸지만(제한을 싣고) 턴은 열리지 않는다 — 모델 호출 0회.
  expect(entries.some(e => e.method === 'thread/start')).toBe(true)
  expect(entries.some(e => e.method === 'turn/start')).toBe(false)
})

test('Codex 담당 연결: 설정을 읽지 못하면 스레드조차 열지 않는다', { timeout: 120_000 }, async () => {
  // 이름을 모르면 제한을 걸 수 없고, 아무 이름이나 넣으면 `thread/start` 가 실패한다(실측).
  // 그래서 조용히 넘어가지 않고 주문을 닫는다.
  const { root, out, skill } = fixtureRoot('codex-no-config')
  const logFile = join(root, 'app-server.log')
  writeFileSync(logFile, '')
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  const connection = new CodexRelayConnection(
    agentOptions(wrapper, root, skill, {
      KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill),
      KD_FAKE_ALLOWED: 'true', KD_FAKE_CONFIG_ERROR: '1'
    }),
    request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' }))
  try {
    await expect(connection.runJob('담당 모드: 주문서', recorder().events))
      .rejects.toThrow(/학생 설정을 읽지 못해/)
  } finally { await connection.stop() }
  const entries = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(entries.some(e => e.method === 'config/read')).toBe(true)
  expect(entries.some(e => e.method === 'thread/start')).toBe(false)
  expect(entries.some(e => e.method === 'turn/start')).toBe(false)
})

test('실물 Codex app-server: 제한을 건 담당 스레드는 사용자 MCP 를 기동조차 않는다', { timeout: 180_000 }, async () => {
  const binary = systemCodex()
  if (!binary) test.skip(true, 'PATH 에 codex 가 없어 건너뜁니다')
  const { root, out, skill } = fixtureRoot('codex-real-lock')
  /**
   * 미끼 MCP — 자기가 뜨면 표식 파일에 한 줄 쓴다. **모델 턴은 열지 않는다**: 이 시험이 보는
   * 것은 "학생 설정 서버가 담당 스레드에서 프로세스로 뜨는가" 하나다.
   */
  const codexHome = join(root, 'codex-home'); mkdirSync(codexHome)
  const marker = join(root, 'decoy-started.log')
  writeFileSync(join(codexHome, 'config.toml'), `
[mcp_servers.decoy]
command = "/bin/sh"
args = ["-c", "echo started >> '${marker}'"]
`)
  const home = join(root, 'h'); mkdirSync(home)
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home }
  const rpc = new JsonRpcProcess(binary, ['app-server'], out, env)
  const relayRequest = request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' })
  try {
    await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.6.0' }, capabilities: { experimentalApi: true } })
    rpc.send({ method: 'initialized', params: {} })
    const userConfig = await rpc.request('config/read', { cwd: out, includeLayers: false })
    const installed = await rpc.request('plugin/installed', {}).catch(() => null)
    expect(Object.keys(userConfig.config.mcp_servers)).toContain('decoy')
    const lockdown = codexRelayLockdown(userConfig.config, installed)
    expect(lockdown.mcp_servers.decoy).toEqual({ enabled: false })
    const started = await rpc.request('thread/start', codexThreadParams(relayRequest, 'gpt-5-codex', lockdown))
    const status = await rpc.request('mcpServerStatus/list', { threadId: started.thread.id, detail: 'toolsAndAuthOnly' })
    const entry = status.data.find((s: { name: string }) => s.name === 'decoy')
    expect(entry.runtimeStatus).toBe('disabled')
    // 앱이 판정에 쓰는 것과 같은 규칙 — 살아 있는 서버가 하나도 없어야 통과한다.
    expect(status.data.every((s: { runtimeStatus: string }) => s.runtimeStatus === 'disabled')).toBe(true)
    // 프로세스로 뜨지 않았다: 표식 파일이 없거나 비어 있다(기동 자체가 0회).
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>()
    setTimeout(settle, 2_000)
    await settled
    expect(existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '').toBe('')
  } finally { await rpc.stop() }
})

test('실물 Codex app-server: 턴 샌드박스가 출력 칸 밖 쓰기를 막는다', { timeout: 180_000 }, async () => {
  const binary = systemCodex()
  if (!binary) test.skip(true, 'PATH 에 codex 가 없어 건너뜁니다')
  const { root, out, skill } = fixtureRoot('codex-real')
  // 가짜 Responses API — 첫 호출은 출력 칸 안/밖 두 번의 셸 명령을 시키고, 그 결과를 받은
  // 두 번째 호출에서 마무리 글을 낸다. 실모델 호출 0회.
  let toolRound = 0
  const fake = await startServer((req, res, body) => {
    if (req.url?.startsWith('/backend-api')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ rate_limits: [], plan_type: 'plus', data: [], items: [], plugins: [] }))
    }
    if (!req.url?.startsWith('/v1/responses')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}') }
    let parsed: { input?: unknown } = {}
    try { parsed = JSON.parse(body) } catch { /* 빈 본문 */ }
    const outputRound = JSON.stringify(parsed.input ?? []).includes('function_call_output')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    if (!outputRound) {
      const command = toolRound++ === 0
        ? `echo inside > "${join(out, 'result.md')}"; echo outside > "${join(root, 'escaped.md')}"; echo done`
        : 'echo done'
      const args = JSON.stringify({ cmd: command, login: false })
      const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '' }
      sse('response.created', { type: 'response.created', response: { id: 'r1', object: 'response', status: 'in_progress', output: [] } })
      sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item })
      sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args })
      sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: args })
      sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args } })
    } else {
      const item = { type: 'message', id: 'm9', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] }
      sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
    }
    sse('response.completed', { type: 'response.completed', response: { id: 'r2', object: 'response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })
    res.end()
  })
  // ChatGPT 구독 자격 모양 — 실 자격이 아니다.
  const codexHome = join(root, 'codex-home'); mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), `
model = "gpt-5-codex"
model_provider = "fake"
approval_policy = "never"
chatgpt_base_url = "http://127.0.0.1:${fake.port}/backend-api"
sandbox_mode = "workspace-write"
[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:${fake.port}/v1"
wire_api = "responses"
env_key = "FAKE_API_KEY"
requires_openai_auth = false
`)
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', exp: now + 86_400, iat: now,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus', chatgpt_user_id: 'u', organizations: [] } })}.sig`
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'refresh-1', account_id: 'acct-1' }, last_refresh: new Date().toISOString() }))
  const home = join(root, 'h'); mkdirSync(home)
  const env = { ...process.env, CODEX_HOME: codexHome, FAKE_API_KEY: 'sk-fake', HOME: home }
  const log = recorder()
  // 이 시험의 대상은 **격리**다. 연결 클래스는 실물 app-server 에서 `account.type: chatgpt` 를
  // 만들 수 없으므로(가짜 토큰의 발급자 검증 — 실측), 여기서는 같은 파라미터를 직접 보낸다.
  const rpc = new JsonRpcProcess(binary, ['app-server'], out, env)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.6.0' }, capabilities: { experimentalApi: true } })
    rpc.send({ method: 'initialized', params: {} })
    const relayRequest = request(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'high' })
    const started = await rpc.request('thread/start', codexThreadParams(relayRequest, 'gpt-5-codex'))
    expect(started.cwd).toBe(realpathSync(out))
    // 문자열 sandbox 만으로는 정책이 비어 온다 — 이 사실이 아래 정책을 반드시 싣는 이유다.
    expect(started.sandbox.writableRoots).toEqual([])
    rpc.onRequest = (id, method) => {
      if (method === 'item/tool/requestUserInput') return rpc.send({ id, result: { answers: {} } })
      return rpc.send({ id, result: { decision: 'decline' } })
    }
    rpc.onNotification = () => {}
    await rpc.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: '격리 확인', text_elements: [] }],
      model: 'gpt-5-codex',
      sandboxPolicy: codexSandboxPolicy(out)
    })
    for (let i = 0; i < 300; i++) {
      if (existsSync(join(out, 'result.md'))) break
      await new Promise<void>(r => setTimeout(r, 100))
    }
    // ① 작업 폴더 안은 쓰인다. ② 같은 명령의 밖 쓰기는 샌드박스가 막는다.
    expect(existsSync(join(out, 'result.md'))).toBe(true)
    expect(existsSync(join(root, 'escaped.md'))).toBe(false)
  } finally { await rpc.stop(); await fake.close(); void log }
})
