// kordoc MCP 연결 배선 회귀 — E2(Claude 옵션)·E3(Codex 인자)·E8(정책·재시도).
// 공급자 프로세스·계정·네트워크는 띄우지 않는다. claude.ts/codex.ts 를 CJS 로 옮겨 vm 에서 돌리고
// SDK query 와 JsonRpcProcess 만 가짜로 꽂는다(선례: app/e2e/preparation-state.spec.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const CHAT = resolve(import.meta.dirname, '../../src/main/chat')

/** 시험 하나가 만든 임시 폴더 — 워크트리 밖(tmpdir)에만 만든다. */
const tempDirs = []
function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `kordoc-wiring-${tag}-`))
  tempDirs.push(dir)
  return dir
}
test.after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

/** `load()` 가 꽂는 대역. 시험마다 갈아 끼운다 — 모듈 캐시는 파일 단위라 다시 읽지 않는다. */
let queryDouble = null
let rpcFactory = null

const cache = new Map()
function load(file) {
  const target = resolve(file)
  const cached = cache.get(target)
  if (cached) return cached.exports
  const module = { exports: {} }
  cache.set(target, module)
  const code = transpileModule(readFileSync(target, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
  const injected = (name) => {
    if (name === '@anthropic-ai/claude-agent-sdk') {
      return { query: (...args) => {
        if (!queryDouble) throw new Error('SDK 대역이 없다')
        return queryDouble(...args)
      } }
    }
    if (name === './transport') {
      // 생성자에서 돌려준 객체가 `this` 를 대신한다 — codex 는 이 객체의 메서드만 쓴다.
      return { JsonRpcProcess: class { constructor(...args) {
        if (!rpcFactory) throw new Error('transport 대역이 없다')
        return rpcFactory(...args)
      } } }
    }
    if (!name.startsWith('.')) return nodeRequire(name)
    const base = resolve(dirname(target), name)
    return load(existsSync(base + '.ts') ? base + '.ts' : base)
  }
  runInNewContext(code, {
    module, exports: module.exports, require: injected,
    process, Buffer, console, crypto: globalThis.crypto, Promise, URL,
    AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate
  })
  return module.exports
}

const mcp = load(join(CHAT, 'kordocMcp.ts'))
const claude = load(join(CHAT, 'claude.ts'))
const codex = load(join(CHAT, 'codex.ts'))

const { READ_TOOLS, WRITE_TOOLS, DENY_FOREIGN_MCP, DENY_NOT_READ, DENY_OUTSIDE_ROOT,
  MCP_DOC_READ_INSTRUCTION, LEGACY_DOC_READ_INSTRUCTION, MCP_TOOL_PREFIX } = mcp

/** 논문 폴더 하나 + 그 밖의 폴더 하나. root 는 realpath 기준으로만 비교된다. */
function fixtures(tag) {
  const base = tempDir(tag)
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'paper.hwp'), 'hwp')
  writeFileSync(join(outside, 'paper.hwp'), 'hwp')
  return { base, root, outside, insideFile: join(root, 'paper.hwp'), outsideFile: join(outside, 'paper.hwp') }
}

function specFor(root, extraEnv = {}) {
  return {
    command: '/opt/kordoc/node',
    args: ['/opt/kordoc/dist/mcp.js'],
    env: { KORDOC_ROOT: root, KORDOC_OFFLINE: '1', ...extraEnv },
    version: '4.24.39'
  }
}

/**
 * vm 안에서 만든 배열·객체는 프로토타입이 달라 `assert/strict` 의 deepEqual 이 실패한다
 * ("same structure but not reference-equal"). 호스트 것과 비교하기 전에 옮긴다.
 */
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain)
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    // 평범한 객체(호스트·vm 모두 Object.prototype 이 최상위)만 옮긴다. Error·Map 은 그대로 둔다.
    if (proto === null || (Object.getPrototypeOf(proto) === null && proto.constructor?.name === 'Object')) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
    }
  }
  return value
}

function events() {
  const calls = { message: [], permission: [], note: [], session: [], skill: 0 }
  return {
    calls,
    message: (id, text) => calls.message.push([id, text]),
    permission: (request) => calls.permission.push(request),
    note: (text) => calls.note.push(text),
    session: (id) => calls.session.push(id),
    skill: () => { calls.skill += 1 }
  }
}

// ---------------------------------------------------------------- E2: Claude 옵션·정책

/** `run()` 한 번을 돌려 SDK 에 실제로 넘어간 options 를 잡는다. */
async function captureClaudeRun({ root, spec, sessionId = 'session-1', trusted = () => false }) {
  const captured = []
  queryDouble = (args) => {
    captured.push(args)
    return {
      supportedCommands: async () => [{ name: 'knuaf-dev' }],
      accountInfo: async () => ({}),
      close() {},
      async *[Symbol.asyncIterator]() { /* 한 턴에 메시지 없음 */ }
    }
  }
  const connection = new claude.ClaudeConnection({
    binary: 'claude', root, skill: join(root, 'skill'), env: {},
    openExternal: async () => {}, trusted
  })
  // `auth status` 는 자식 프로세스를 띄운다 — 이 시험은 배선만 본다.
  connection.status = async () => ({ installed: true, connected: true, version: null, probe: 'ok', detail: '' })
  if (spec) await connection.setMcpSpec(spec)
  await connection.run('안녕하세요', sessionId, events())
  assert.equal(captured.length, 1, 'SDK query 는 턴마다 정확히 한 번')
  return { options: captured[0].options, prompt: captured[0].prompt, connection }
}

test('E2: spec 이 있으면 mcpServers·strictMcpConfig·disallowedTools·지시문이 붙는다', async (t) => {
  t.after(() => { queryDouble = null })
  const { root } = fixtures('e2-on')
  const spec = specFor(root)
  const { options } = await captureClaudeRun({ root, spec })

  assert.deepEqual(plain(options.mcpServers.kordoc.env), spec.env)
  assert.equal(options.mcpServers.kordoc.command, spec.command)
  assert.equal(options.mcpServers.kordoc.type, 'stdio')
  assert.equal(options.mcpServers.kordoc.timeout, mcp.CLAUDE_MCP_TIMEOUT_MS)
  assert.equal(options.strictMcpConfig, true)
  assert.deepEqual(plain(options.disallowedTools), plain(WRITE_TOOLS.map((tool) => `${MCP_TOOL_PREFIX}${tool}`)))
  assert.equal(options.disallowedTools.length, 12)
  assert.ok(options.systemPrompt.append.includes(MCP_DOC_READ_INSTRUCTION))
  assert.ok(!options.systemPrompt.append.includes(LEGACY_DOC_READ_INSTRUCTION))
  // OCR 규약(설계 §3.6 밖, 책임자 결정): 생략 호출이 PDF마다 ~1 GiB·30초라 미요청은 `ocr:false` 고정.
  assert.ok(options.systemPrompt.append.includes('`ocr:false`를 꼭 넣어 부르고'))
  assert.ok(options.systemPrompt.append.includes('`ocr:true`로 한 번 더 부르세요'))
})

test('E2: spec 이 없으면 MCP 키가 없고 기존 지시문 그대로다', async (t) => {
  t.after(() => { queryDouble = null })
  const { root } = fixtures('e2-off')
  const { options } = await captureClaudeRun({ root, spec: null })

  assert.equal(options.mcpServers, undefined)
  assert.equal(options.disallowedTools, undefined)
  // strictMcpConfig 는 MCP 이전부터 있던 리터럴이다 — 이 변경이 만들거나 없애지 않았다.
  assert.equal(options.strictMcpConfig, true)
  assert.ok(options.systemPrompt.append.includes(LEGACY_DOC_READ_INSTRUCTION))
  assert.ok(!options.systemPrompt.append.includes(MCP_DOC_READ_INSTRUCTION))
})

test('E2: canUseTool 은 trusted() 보다 먼저 mcp 정책을 본다', async (t) => {
  t.after(() => { queryDouble = null })
  const { root, outside, insideFile, outsideFile } = fixtures('e2-policy')
  // 폴더 안 심볼릭 링크가 밖을 가리키는 경우 — 문자열 비교로는 걸러지지 않는다.
  symlinkSync(outside, join(root, 'link'))
  const { options } = await captureClaudeRun({ root, spec: specFor(root), trusted: () => true })
  const canUseTool = options.canUseTool
  const signal = new AbortController().signal
  const ask = (name, input) => canUseTool(name, input, { signal })

  // 쓰기 도구는 이름만으로 거절(허용 목록에 없다).
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}generate_document`, { file_path: insideFile })),
    { behavior: 'deny', message: DENY_NOT_READ })
  // 외부 MCP 는 전부 거절.
  assert.deepEqual(plain(await ask('mcp__other__tool', {})), { behavior: 'deny', message: DENY_FOREIGN_MCP })
  // 폴더 밖 파일.
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}parse_document`, { file_path: outsideFile })),
    { behavior: 'deny', message: DENY_OUTSIDE_ROOT })
  // 상대 경로 탈출.
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}parse_document`, { file_path: '../outside/paper.hwp' })),
    { behavior: 'deny', message: DENY_OUTSIDE_ROOT })
  // 폴더 안 심볼릭 링크로 밖을 가리킴.
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}parse_document`, { file_path: join(root, 'link', 'paper.hwp') })),
    { behavior: 'deny', message: DENY_OUTSIDE_ROOT })
  // 경로 인자가 없으면 거절.
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}parse_document`, {})),
    { behavior: 'deny', message: DENY_OUTSIDE_ROOT })
  // 폴더 안 파일은 통과 — 그리고 trust 판정으로 새지 않고 allow 로 떨어진다.
  assert.deepEqual(plain(await ask(`${MCP_TOOL_PREFIX}parse_document`, { file_path: insideFile })),
    { behavior: 'allow', updatedInput: { file_path: insideFile } })
  // MCP 가 아닌 도구는 이 정책이 건드리지 않는다(trusted 폴더 → 허용).
  assert.deepEqual(plain(await ask('Bash', { command: 'ls' })), { behavior: 'allow', updatedInput: { command: 'ls' } })
})

test('E2: 정책은 신뢰하지 않는 폴더에서도 MCP 도구를 통과시키지 않는다', async (t) => {
  t.after(() => { queryDouble = null })
  const { root, insideFile } = fixtures('e2-untrusted')
  const { options } = await captureClaudeRun({ root, spec: specFor(root), trusted: () => false })
  const signal = new AbortController().signal
  // 승인 카드를 띄우지 않고 끝나야 한다(MCP 경로는 정책이 먼저 답한다).
  assert.deepEqual(plain(await options.canUseTool(`${MCP_TOOL_PREFIX}parse_document`, { file_path: insideFile }, { signal })),
    { behavior: 'allow', updatedInput: { file_path: insideFile } })
  assert.deepEqual(plain(await options.canUseTool(`${MCP_TOOL_PREFIX}patch_document`, { file_path: insideFile }, { signal })),
    { behavior: 'deny', message: DENY_NOT_READ })
})

// ---------------------------------------------------------------- E3: Codex 인자

test('E3: codexMcpArgs 는 -c 6쌍이고 논문 폴더 경로를 argv 에 넣지 않는다', () => {
  const { root } = fixtures('e3-args')
  const spec = specFor(root, { ELECTRON_RUN_AS_NODE: '1' })
  const argv = mcp.codexMcpArgs(spec)

  assert.equal(argv.length, 12)
  assert.equal(argv.filter((a) => a === '-c').length, 6)
  // 각 항목은 `mcp_servers.kordoc.<key>=<JSON/숫자>` — `-c` 뒤에만 온다.
  const pairs = argv.map((a, i) => (i % 2 === 1 ? a : null)).filter(Boolean)
  const settings = new Map(pairs.map((pair) => {
    const at = pair.indexOf('=')
    return [pair.slice(0, at).replace(/^mcp_servers\.kordoc\./, ''), pair.slice(at + 1)]
  }))
  assert.deepEqual([...settings.keys()],
    ['command', 'args', 'env_vars', 'enabled_tools', 'startup_timeout_sec', 'tool_timeout_sec'])
  const value = (key) => settings.get(key)
  assert.equal(JSON.parse(value('command')), spec.command)
  assert.deepEqual(JSON.parse(value('args')), spec.args)
  // env_vars 는 값이 아니라 **이름**만 — 울타리 키가 먼저 온다.
  assert.deepEqual(JSON.parse(value('env_vars')), ['KORDOC_ROOT', 'KORDOC_OFFLINE', 'ELECTRON_RUN_AS_NODE'])
  assert.deepEqual(JSON.parse(value('enabled_tools')), plain([...READ_TOOLS]))
  assert.equal(value('startup_timeout_sec'), String(mcp.CODEX_STARTUP_TIMEOUT_SEC))
  assert.equal(value('tool_timeout_sec'), String(mcp.CODEX_TOOL_TIMEOUT_SEC))
  assert.equal(argv.join(' ').includes(root), false, '논문 폴더 경로는 명령줄에 남지 않는다')

  assert.deepEqual(plain(mcp.codexMcpEnv(spec)), spec.env)
})

test('E3: spawnArgs 는 app-server 바로 앞에 -c 블록을 끼우고, 없으면 뒤에 붙인다', () => {
  const { root } = fixtures('e3-spawn')
  const home = tempDir('e3-home')
  const connection = new codex.CodexConnection({
    binary: 'codex', root, skill: join(root, 'skill'), env: { HOME: home },
    openExternal: async () => {}, modelChosen: () => false
  })
  const spec = specFor(root)
  const block = mcp.codexMcpArgs(spec)

  assert.deepEqual(plain(connection.spawnArgs()), ['app-server'])
  connection.mcpSpec = spec
  assert.deepEqual(plain(connection.spawnArgs()), plain([...block, 'app-server']))
  // 옛 CLI 의 `--listen stdio://` 재시도가 뒤에 붙어도 -c 블록은 subcommand 앞에 남는다.
  connection.serverArgs = ['--listen', 'stdio://', 'app-server']
  assert.deepEqual(plain(connection.spawnArgs()), plain(['--listen', 'stdio://', ...block, 'app-server']))
  // subcommand 가 없으면 끝에 붙는다(추측해서 문자열을 꽂지 않는다).
  connection.serverArgs = []
  assert.deepEqual(plain(connection.spawnArgs()), plain([...block]))
})

test('E3: setMcpSpec 은 턴 중에는 거절하고, 상태를 바꾸지 않는다', async () => {
  const { root } = fixtures('e3-setspec')
  const home = tempDir('e3-home-guard')
  const connection = new codex.CodexConnection({
    binary: 'codex', root, skill: join(root, 'skill'), env: { HOME: home },
    openExternal: async () => {}, modelChosen: () => false
  })
  const spec = specFor(root)
  await connection.setMcpSpec(spec)
  connection.turn = 'turn-1'
  await assert.rejects(connection.setMcpSpec(null), /턴이 진행 중/)
  assert.equal(connection.mcpSpec, spec, '거절된 호출은 상태를 바꾸지 않는다')
  connection.turn = undefined
  await connection.setMcpSpec(null)
  assert.equal(connection.mcpSpec, null)
  assert.equal(connection.stopped, false, 'setMcpSpec 은 stopped 를 건드리지 않는다')
})

// ---------------------------------------------------------------- E8: 정책 전수·재시도

test('E8: 쓰기 12개는 폴더 안 경로를 줘도 정책이 거절한다', () => {
  const { root, insideFile } = fixtures('e8-write')
  for (const tool of WRITE_TOOLS) {
    assert.deepEqual(plain(mcp.mcpPolicy(root, `${MCP_TOOL_PREFIX}${tool}`, { file_path: insideFile })),
      { behavior: 'deny', message: DENY_NOT_READ }, tool)
  }
  // 모르는 이름도 같은 문구로 닫힌다(새 도구는 목록에 넣기 전까지 안 열린다).
  assert.deepEqual(plain(mcp.mcpPolicy(root, `${MCP_TOOL_PREFIX}brand_new_tool`, { file_path: insideFile })),
    { behavior: 'deny', message: DENY_NOT_READ })
})

/**
 * codex app-server 대역. 검증 실패를 흉내 내려면 `failVerify`.
 * `userKordoc` 은 학생 사용자 층(`~/.codex/config.toml`)의 같은 이름 서버 —
 * `config/read` 병합 결과에 쓰기 도구·/tmp root 로 나타나고, 스레드 config 로 끄지 않으면
 * 상태 목록에서 `connected` 로 되살아난다(Roh 재현). `lockIgnored` 는 그 잠금이 조용히
 * 무시되는 경우(f 실측 — 요청은 성공하는데 효력이 없다)를 흉내 낸다.
 */
function fakeRpc({ root, skill, failVerify, failSkills, log, userKordoc = false, lockIgnored = false, holdTurnStart = false }) {
  // 검증은 `realpathSync(root)` 로 탐침한다 — /var → /private/var 를 흉내 쪽에서도 맞춘다.
  const rootReal = realpathSync(root)
  const rpc = {
    closed: false,
    lastStderr: '',
    onNotification: null,
    onRequest: null,
    onClose: null,
    sent: [],
    stopped: false,
    /** `thread/start`|`thread/resume` 에 실려 온 `params.config` — 잠금이 실제로 나갔는지 본다. */
    threadConfig: undefined,
    kordocStatus: undefined,
    send(message) { this.sent.push(message) },
    async stop() { this.stopped = true; this.closed = true },
    async request(method, params) {
      log.push(method)
      switch (method) {
        case 'initialize': return { userAgent: 'knuaf_dev_gui/0.162.1' }
        case 'account/read': return { account: { type: 'chatgpt' } }
        case 'skills/list':
          if (failSkills) throw new Error('스킬 목록을 읽지 못했어요')
          return { data: [{ skills: [{ path: realpathSync(join(skill, 'SKILL.md')), enabled: true }] }] }
        // 병합된 설정 — `mcp_servers` 는 항상 있고(없으면 `{}`), 사용자 층 표가 그대로 보인다.
        case 'config/read':
          return { config: { mcp_servers: userKordoc
            ? {
                kordoc: {
                  command: '/bin/false',
                  args: ['/tmp/kordoc/dist/mcp.js'],
                  enabled: true,
                  enabled_tools: ['generate_document', 'parse_document'],
                  env: { KORDOC_ROOT: '/tmp' }
                },
                foreign: { command: '/bin/false', args: ['/tmp/other.js'], enabled: true }
              }
            : {} } }
        case 'thread/start':
        case 'thread/resume':
          rpc.threadConfig = params.config
          return { thread: { id: method === 'thread/start' ? 'thread-1' : params.threadId } }
        case 'mcpServerStatus/list': {
          if (failVerify) throw new Error('MCP 서버가 떠오르지 않았어요')
          const off = rpc.threadConfig?.mcp_servers?.kordoc?.enabled === false && !lockIgnored
          if (!userKordoc) {
            return { data: [{ runtimeStatus: 'connected', serverInfo: { name: 'kordoc', version: '4.24.39' }, tools: [...READ_TOOLS], toolsError: null }] }
          }
          // 잠갔으면 프로세스가 뜨지 않는다 — 목록에는 `disabled` 로만 남는다(실측 fix1-filter).
          rpc.kordocStatus = off ? 'disabled' : 'connected'
          return { data: [
            off
              ? { name: 'kordoc', runtimeStatus: 'disabled', tools: {}, toolsError: null }
              : { name: 'kordoc', runtimeStatus: 'connected', serverInfo: { name: 'kordoc', version: '4.24.39' }, tools: [...READ_TOOLS, 'generate_document'], toolsError: null },
            // 다른 이름의 학생 MCP 는 건드리지 않는다(설계 §3.3 현상 유지).
            { name: 'foreign', runtimeStatus: 'connected', tools: [], toolsError: null }
          ] }
        }
        case 'mcpServer/tool/call': {
          const path = params.arguments.file_path
          // safePath 실측 순서(realpath → 경계 → 확장자): 폴더는 경계를 지나 확장자에서 걸린다.
          return path === rootReal
            ? { content: [{ type: 'text', text: `지원하지 않는 확장자입니다: (폴더) ${path}` }], isError: true }
            : { content: [{ type: 'text', text: `허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다: ${path}` }], isError: true }
        }
        case 'turn/start':
          // `holdTurnStart` 면 응답을 보류한다 — M2-R1-02 의 "턴 id 를 받기 전" 구간을 만든다.
          if (holdTurnStart) {
            rpc.turnStartPending = params
            return new Promise((resolve) => {
              rpc.releaseTurnStart = () => {
                resolve({ turn: { id: 'turn-1' } })
                setTimeout(() => rpc.onNotification?.('turn/completed', {
                  threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' }
                }), 0)
              }
            })
          }
          // 턴 완료는 알림으로만 온다 — threadId 가 현재 스레드와 같아야 처리된다.
          setTimeout(() => rpc.onNotification?.('turn/completed', {
            threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' }
          }), 0)
          return { turn: { id: 'turn-1' } }
        default:
          throw new Error(`대역에 없는 메서드: ${method}`)
      }
    }
  }
  return rpc
}

/**
 * codex.ts 의 E8 재시도: 검증이 실패하면 **MCP 만 끄고** 같은 텍스트로 한 번 더 돈다.
 * 실패한 프로세스는 닫히고, 두 번째 프로세스는 `mcp_servers.kordoc` 인자 없이 뜬다.
 * `userKordoc` 이면 학생 사용자 층에 같은 이름 서버가 있는 합성 HOME(반례 M2-R1-01)이다.
 */
async function runCodexRetryScenario(scenario, { userKordoc = false, lockIgnored = false } = {}) {
  const { root } = fixtures(`e8-retry-${scenario}`)
  const skill = join(root, 'skill')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# knuaf-dev\n')
  const home = tempDir('e8-home')
  const rpcs = []
  // 검증은 첫 프로세스에서만 실패한다(재시도 성공) 또는 계속 실패한다(재시도 실패).
  rpcFactory = (binary, argv, cwd, env) => {
    const failVerify = scenario === 'double' || rpcs.length === 0
    // 재시도 턴이 다른 이유로 깨지는 경우(검증이 아닌 오류)도 한 번만 돌아야 한다.
    const failSkills = scenario === 'retry-error' && rpcs.length > 0
    const log = []
    const rpc = fakeRpc({ root, skill, failVerify, failSkills, log, userKordoc, lockIgnored })
    rpc.argv = argv
    rpc.env = env
    rpc.log = log
    rpcs.push(rpc)
    return rpc
  }
  const connection = new codex.CodexConnection({
    binary: 'codex', root, skill, env: { HOME: home },
    openExternal: async () => {}, modelChosen: () => false
  })
  await connection.setMcpSpec(specFor(root))
  const ev = events()
  const run = connection.run('논문 읽어 줘', 'session-1', ev)
  return { run, rpcs, ev, connection, root, home }
}

test('E8: 검증이 실패하면 MCP 를 끄고 한 번 다시 돌아 턴이 끝난다', async (t) => {
  t.after(() => { rpcFactory = null })
  const { run, rpcs, ev, connection, root } = await runCodexRetryScenario('once')
  await run

  assert.equal(rpcs.length, 2, '실패한 프로세스 + MCP 없는 프로세스')
  assert.equal(rpcs[0].argv.join(' ').includes('mcp_servers.kordoc'), true)
  assert.equal(rpcs[1].argv.join(' ').includes('mcp_servers.kordoc'), false)
  assert.equal(rpcs[1].argv.join(' ').includes(root), false)
  assert.equal(rpcs[0].stopped, true, '실패한 프로세스는 닫는다')
  assert.equal(connection.mcpSpec, null)
  // 학생에게는 정확히 한 줄 — 대화는 계속된다.
  assert.deepEqual(ev.calls.note, ['안전 검사를 통과하지 못해 한글 문서 도구를 끄고 진행해요'])
  // 스킬 확인은 `runTurn` 마다 한 번이라 두 번 — 재시도가 스킬 단계를 건너뛰지 않는다.
  assert.equal(ev.calls.skill, 2)
  // 재시도는 인자를 빼는 데 그치지 않고 **병합 설정을 먼저 본다**(M2-R1-01). 여기 설정에는
  // kordoc 이 없으므로 잠글 이름도, 확인할 상태도 없다 — 그래도 턴은 정상으로 돈다.
  assert.equal(rpcs[1].log.includes('config/read'), true)
  assert.equal(rpcs[1].threadConfig, undefined, '설정에 없는 이름은 잠금 키를 만들지 않는다')
  assert.equal(rpcs[1].log.includes('mcpServerStatus/list'), false, '잠글 이름이 없으면 상태 조회도 없다')
  assert.ok(rpcs[1].log.includes('turn/start'))
})

test('E8: 재시도 턴이 다른 오류로 깨지면 그 오류가 그대로 올라온다(재시도 반복 없음)', async (t) => {
  t.after(() => { rpcFactory = null })
  const { run, rpcs, ev } = await runCodexRetryScenario('retry-error')
  await assert.rejects(run, /스킬 목록을 읽지 못했어요/)

  assert.equal(rpcs.length, 2, '재시도는 한 번뿐이다 — McpSafetyError 가 아닌 오류는 다시 돌지 않는다')
  assert.equal(rpcs[1].argv.join(' ').includes('mcp_servers.kordoc'), false)
  // 안내는 첫 시도(관문 실패)에서 한 줄뿐 — 재시도 오류는 학생 안내가 아니라 오류다.
  assert.deepEqual(ev.calls.note, ['안전 검사를 통과하지 못해 한글 문서 도구를 끄고 진행해요'])
})

test('E8: 재시도 프로세스는 §3.3 기동 검증을 다시 하지 않는다(잠금 확인만 한다)', async (t) => {
  t.after(() => { rpcFactory = null })
  const { run, rpcs, ev, connection } = await runCodexRetryScenario('once')
  await run

  // 첫 프로세스만 §3.3 관문(도구 탐침 포함)을 지난다. 재시도 프로세스는 mcpSpec 이 비어 있고
  // 대신 잠금 확인(M2-R1-01)만 한다 — 그 확인은 도구를 부르지 않는다.
  assert.equal(rpcs[0].log.includes('mcpServerStatus/list'), true)
  assert.equal(rpcs[1].log.includes('mcpServer/tool/call'), false)
  assert.equal(rpcs[1].log.includes('turn/start'), true)
  // 재시도가 끝나도 spec 은 꺼진 채 남는다(같은 연결로 다음 턴도 MCP 없이).
  assert.equal(connection.mcpSpec, null)
  assert.equal(ev.calls.note.length, 1)
})

// ------------------------------------------------- M2-R1-02: turn/start 응답 대기 구간

test('M2-R1-02: turn/start 응답을 기다리는 동안에도 setMcpSpec 은 거절한다', async (t) => {
  t.after(() => { rpcFactory = null })
  const { root } = fixtures('r1-02')
  const skill = join(root, 'skill')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# knuaf-dev\n')
  const home = tempDir('r1-02-home')
  let held
  rpcFactory = (binary, argv, cwd, env) => {
    const log = []
    held = fakeRpc({ root, skill, failVerify: false, failSkills: false, log, holdTurnStart: true })
    held.log = log
    return held
  }
  const connection = new codex.CodexConnection({
    binary: 'codex', root, skill, env: { HOME: home },
    openExternal: async () => {}, modelChosen: () => false
  })
  const spec = specFor(root)
  await connection.setMcpSpec(spec)
  const run = connection.run('논문 읽어 줘', 'session-1', events())
  // 턴 id 를 받기 전(= `turn/start` 응답 보류 중)에 사양을 내리려 한다.
  for (let i = 0; i < 200 && !held?.turnStartPending; i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(held?.turnStartPending, 'turn/start 는 나갔고 응답은 보류 중이다')
  assert.equal(connection.turn, undefined, '아직 턴 id 가 없다 — 이 구간이 결함이었다')
  await assert.rejects(connection.setMcpSpec(null), /턴이 진행 중/)
  assert.equal(connection.mcpSpec, spec, '거절된 호출은 사양을 바꾸지 않는다')
  assert.equal(held.stopped, false, '진행 중인 RPC 를 닫지 않는다')
  // 응답을 풀어 턴을 정상 종료시킨다 — 거절이 턴을 망가뜨리지 않았는지까지 본다.
  held.releaseTurnStart()
  await run
})

test('M2-R1-01: 사용자 층에 같은 이름 kordoc 이 있어도 재시도 턴은 그 서버 없이 돈다', async (t) => {
  t.after(() => { rpcFactory = null })
  // 학생 사용자 층: kordoc enabled + 쓰기 도구 + 폴더 밖 root(/tmp) — Roh 재현 그대로.
  const { run, rpcs, ev, connection, root } = await runCodexRetryScenario('user-layer', { userKordoc: true })
  await run

  assert.equal(rpcs.length, 2)
  assert.equal(rpcs[1].argv.join(' ').includes('mcp_servers.kordoc'), false, '인자로는 여전히 안 붙는다')
  assert.equal(rpcs[1].argv.join(' ').includes(root), false)
  // 잠금이 스레드 config 로 실제로 나갔다 — 사용자 층 표를 덮는 유일한 채널(fix1-lock 실측).
  assert.deepEqual(plain(rpcs[1].threadConfig), { mcp_servers: { kordoc: { enabled: false } } })
  // 그리고 끈 사실을 **상태 목록으로 확인한 뒤에만** 턴을 열었다.
  assert.equal(rpcs[1].kordocStatus, 'disabled')
  assert.equal(rpcs[1].log.includes('mcpServerStatus/list'), true)
  assert.equal(rpcs[1].log.includes('turn/start'), true)
  assert.equal(rpcs[1].log.includes('mcpServer/tool/call'), false, '검증되지 않은 도구를 탐침하지도 않는다')
  assert.deepEqual(ev.calls.note, ['안전 검사를 통과하지 못해 한글 문서 도구를 끄고 진행해요'])
  assert.equal(connection.mcpSpec, null)
})

test('M2-R1-01: 잠금이 조용히 무시되면(서버가 살아 있으면) 재시도 턴을 열지 않는다', async (t) => {
  t.after(() => { rpcFactory = null })
  const { run, rpcs, ev } = await runCodexRetryScenario('user-layer-live', { userKordoc: true, lockIgnored: true })
  await assert.rejects(run, /재시도 턴에서 kordoc MCP가 꺼지지 않았어요\(kordoc: connected\)/)

  assert.equal(rpcs.length, 2, '세 번째 시도는 없다 — 확인 실패는 실패로 끝난다')
  assert.equal(rpcs[1].kordocStatus, 'connected', '요청이 성공해도 상태가 살아 있으면 통과가 아니다')
  assert.equal(rpcs[1].log.includes('turn/start'), false, '턴을 열지 않는다')
  assert.equal(ev.calls.note.length, 1, '안내는 여전히 한 줄')
})
