// 가짜 `codex app-server` — 담당 연결(CodexRelayConnection)이 실제로 보내는 값을 고정한다.
//
// 실물 app-server 는 가짜 자격으로 `account.type: 'chatgpt'` 를 만들지 못한다(토큰 발급자
// 검증 — 실측: `account/read` 가 `{account:null}`). 그래서 **격리 자체는 실물 바이너리**로
// (e2e/relay-engine.spec.ts 의 실물 시험), **연결이 보내는 파라미터**는 이 가짜로 확인한다.
//
// 받은 요청은 전부 `KD_FAKE_CODEX_LOG` 파일에 JSON 줄로 남긴다.
import { createInterface } from 'node:readline'
import { appendFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const LOG = process.env.KD_FAKE_CODEX_LOG ?? ''
const SKILL_ROOT = process.env.KD_FAKE_SKILL_ROOT ?? ''
const real = (path) => { try { return realpathSync(path) } catch { return path } }
const log = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n') }
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')

/** 서버가 클라이언트에게 묻는 요청 — 응답(result)을 로그로 남겨 자동 거절을 확인한다. */
let askSeq = 0
const asked = new Map()

/**
 * 학생 설정 흉내 — 사용자 MCP 두 개, 플러그인 하나(그 플러그인이 MCP 하나를 딸고 온다).
 * 이름은 실기기 이름과 겹치지 않게 지은 가짜다. `config/read` 는 **이름만** 돌려준다.
 */
const USER_SERVERS = ['user-mcp', 'other-mcp']
const USER_PLUGINS = ['plug@mkt']
const PLUGIN_SERVERS = ['plug-mcp']
/** 마지막 `thread/start` 가 받은 config — `mcpServerStatus/list` 가 이 값으로 상태를 만든다. */
let threadConfig = null

/** 실물과 같은 규칙: 이름별 `enabled:false` 만 듣는다. 전체 끄기 키·빈 테이블은 무시된다(실측). */
const disabledBy = (table, name) => table?.[name]?.enabled === false

const handlers = {
  initialize: (params) => {
    log({ method: 'initialize', params, cwd: process.cwd() })
    return { userAgent: 'knuaf_dev_gui/0.9.9 (fake) codex-cli/9.9.9', platformFamily: 'unix', platformOs: 'macos' }
  },
  'account/read': (params) => {
    log({ method: 'account/read', params })
    return { account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus', workspaceName: null }, requiresOpenaiAuth: false }
  },
  'account/rateLimits/read': (params) => {
    log({ method: 'account/rateLimits/read', params })
    return {
      ordinaryUsageAllowed: process.env.KD_FAKE_ALLOWED === 'false' ? false : process.env.KD_FAKE_ALLOWED === 'null' ? null : true,
      rateLimits: { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1 }, secondary: null,
        credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null },
      rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: 'acct-1', rateLimitUpsell: null
    }
  },
  'model/list': (params) => {
    log({ method: 'model/list', params })
    return { data: [
      { model: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: 'fake', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high', isDefault: true }
    ], nextCursor: null }
  },
  'skills/extraRoots/set': (params) => { log({ method: 'skills/extraRoots/set', params }); return {} },
  'config/read': (params) => {
    log({ method: 'config/read', params })
    // 설정을 읽지 못하는 경우(옛 판·권한 오류)를 흉내내는 스위치 — 앱은 담당 스레드를 열지 않는다.
    if (process.env.KD_FAKE_CONFIG_ERROR === '1') throw new Error('config unavailable')
    return {
      config: {
        model: 'gpt-5-codex',
        mcp_servers: Object.fromEntries(USER_SERVERS.map(name => [name, { command: '/fake/bin', args: [] }])),
        plugins: Object.fromEntries(USER_PLUGINS.map(id => [id, { enabled: true }])),
        // Apps 설정은 실기기에서 null 로 온다 — 값이 없어도 제한은 걸려야 한다.
        apps: null
      },
      origins: {}, layers: []
    }
  },
  'skills/list': (params) => {
    log({ method: 'skills/list', params })
    const cwd = Array.isArray(params?.cwds) && params.cwds[0] ? params.cwds[0] : process.cwd()
    return { data: [{ cwd, skills: [{ name: 'knuaf-dev', description: 'fake', shortDescription: null, interface: null,
      path: join(SKILL_ROOT, 'knuaf-dev', 'SKILL.md'), enabled: true }], errors: [] }] }
  },
  'thread/start': (params) => {
    log({ method: 'thread/start', params, spawnCwd: process.cwd(), spawnCwdReal: real(process.cwd()) })
    threadConfig = params?.config ?? null
    return { thread: { id: 'thread-fake', turns: [], ephemeral: false }, model: params?.model ?? 'gpt-5-codex', modelProvider: 'openai',
      serviceTier: null, disabledPluginIds: [], cwd: real(params?.cwd ?? process.cwd()), instructionSources: [],
      approvalPolicy: params?.approvalPolicy ?? 'on-request', approvalsReviewer: 'user',
      // 실물 0.167.0 은 문자열 sandbox 만 주면 이렇게 빈 writableRoots 로 답한다(실측).
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      // 사용자 설정이 심사자를 바꿔 놓은 경우를 흉내내는 스위치(차단 2 재현).
      approvalsReviewer: process.env.KD_FAKE_THREAD_REVIEWER ?? 'user',
      reasoningEffort: process.env.KD_FAKE_THREAD_EFFORT ?? 'high' }
  },
  /** 설치 목록 — 설정 표에 없는 원격 플러그인도 여기 있어 합집합이 필요하다(실측 17 vs 26). */
  'plugin/installed': (params) => {
    log({ method: 'plugin/installed', params })
    return { marketplaces: [{
      name: 'mkt', path: '/fake/mkt',
      plugins: [
        { id: 'plug@mkt', name: 'plug', source: { type: 'local', path: '/fake/mkt/plug' } },
        { id: 'remote-apps@remote', name: 'remote-apps', source: { type: 'remote' } }
      ]
    }] }
  },
  /**
   * 실물과 같은 판정: `thread/start.config` 의 이름별 `enabled:false` 가 있으면 `disabled`,
   * 없으면 `connected`. 이 응답이 **제한을 빼면 실패하는 시험**의 근거다 — 앱이 보낸 제한이
   * 사라지면 여기가 `connected` 를 돌려주고 연결이 턴을 열지 않는다.
   */
  'mcpServerStatus/list': (params) => {
    log({ method: 'mcpServerStatus/list', params })
    const table = threadConfig?.mcp_servers
    const plugOff = (threadConfig?.plugins ?? {}) && USER_PLUGINS.every(id => disabledBy(threadConfig.plugins, id))
    const servers = [...USER_SERVERS, ...(plugOff ? [] : PLUGIN_SERVERS)]
    // 사용자 설정이 제한을 이기는 경우(옛 판이 키를 무시하는 경우)를 흉내내는 스위치.
    const ignores = process.env.KD_FAKE_IGNORE_LOCKS === '1'
    return { data: servers.map(name => ({
      name, pluginId: null, authStatus: 'unsupported', serverCapabilities: null, serverInfo: null,
      tools: {}, resources: [], resourceTemplates: [],
      runtimeStatus: !ignores && disabledBy(table, name) ? 'disabled' : 'connected'
    })), nextCursor: null }
  },
  'turn/start': (params) => {
    log({ method: 'turn/start', params })
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-fake', rootTurnId: 'turn-fake', items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } })
      send({ method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, turnId: 'turn-fake',
        tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 10, reasoningOutputTokens: 2 },
          last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
          modelContextWindow: 200000 } } })
      for (const method of ['item/commandExecution/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'account/chatgptAuthTokens/refresh']) {
        const id = `srv-${++askSeq}`
        asked.set(id, method)
        send({ id, method, params: { threadId: params.threadId, turnId: 'turn-fake', reason: 'fake', command: 'echo hi' } })
      }
      setTimeout(() => {
        send({ method: 'turn/completed', params: { threadId: params.threadId,
          turn: { id: 'turn-fake', rootTurnId: 'turn-fake', items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } } })
      }, 150)
    }, 10)
    return { turn: { id: 'turn-fake', rootTurnId: 'turn-fake', items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } }
  },
  'turn/interrupt': (params) => { log({ method: 'turn/interrupt', params }); return {} }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method && message.id === undefined) { log({ notification: message.method }); return }
  if (message.id !== undefined && message.method === undefined) {
    log({ response: message.id, method: asked.get(String(message.id)) ?? null, result: message.result, error: message.error })
    return
  }
  const handler = handlers[message.method]
  if (!handler) {
    log({ method: message.method, unsupported: true })
    send({ id: message.id, error: { code: -32601, message: 'fake app-server: unsupported' } })
    return
  }
  try { send({ id: message.id, result: handler(message.params ?? {}) }) }
  catch (error) { send({ id: message.id, error: { code: -32603, message: String(error) } }) }
})
