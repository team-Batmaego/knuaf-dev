/**
 * §10-23 — 앱 대화(`CodexConnection`)가 실제 가짜 app-server 를 상대로 지킴이를 통과하는가.
 *
 * 단위 시험(`guard-codex-tool-lock`·`guard-codex-thread-lock`)은 판정 함수만 본다. 여기서는
 * 설계 §4.1-C 의 **순서**를 프로세스 경계에서 본다: 열거가 `thread/start`·`thread/resume`
 * 앞에 끝나 그 결과가 그 호출의 `config` 로 실리고, 응답 뒤 상태 목록 대조를 통과해야
 * `turn/start` 가 나가며, 턴 id 는 응답을 받은 즉시 원장에 남는다.
 */
import { expect, test, afterAll } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexConnection } from '../src/main/chat/codex'
import { ChatService } from '../src/main/chat/service'
import { findExecutable } from '../src/main/agent'
import { folderHash } from '../src/main/guard/scope'
import { codexThreadRow, loadCodexThreads, saveCodexThreads } from '../src/main/guard/store'
import { KORDOC_COLLISION_NOTE, lockFingerprint, type LockConfig } from '../src/main/chat/codexToolLock'
import { newChatNotice, OTHER_WINDOW_COPY } from '../src/main/chat/codexThreadLock'
import type { AgentConnection, AgentEvents, AgentOptions } from '../src/main/chat/contracts'
import type { KordocMcpSpec } from '../src/main/chat/kordocMcp'
import { fakeCodexEnv } from './fixtures/fake-codex'

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** 유효 설정에 외부 MCP 하나(앱이 주입하지 않은 이름) — 잠글 것이 있는 장면. */
const FOREIGN_CONFIG = JSON.stringify({
  config: { mcp_servers: { foreign: { enabled: true } }, plugins: {} },
  layers: []
})
/** 그 이름이 실제로 꺼진 상태 — 결과 대조의 유일한 증거(목록 노브는 배열 또는 `{pages}`다). */
const FOREIGN_STATUS = JSON.stringify([{ name: 'foreign', runtimeStatus: 'disabled' }])

const FOREIGN_LOCK: LockConfig = {
  features: { apps: false },
  mcp_servers: { foreign: { enabled: false } },
  plugins: {},
  project_doc_max_bytes: 0
}
const FOREIGN_FINGERPRINT = lockFingerprint(FOREIGN_LOCK)

interface Request {
  method: string
  params: Record<string, unknown>
}

interface Scene {
  base: string
  root: string
  home: string
  skill: string
  env: Record<string, string>
  binary: string
  guard: { userData: string; folderHash: string; key: Buffer }
  notes: string[]
  sessions: string[]
  events: AgentEvents
  requests: () => Request[]
}

function scene(tag: string, knobs: Record<string, string> = {}): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `kd-conn-${tag}-`)))
  scratch.push(base)
  const root = join(base, 'paper')
  mkdirSync(root)
  // HOME 은 root 의 **형제**다 — 지시문 대조의 전역 예외 판정이 root 안/위를 보지 않게.
  const home = join(base, 'home')
  mkdirSync(home)
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
  const requestLog = join(base, 'requests.log')
  const env = {
    ...process.env,
    ...fakeCodexEnv(join(base, 'bin'), {
      HOME: home,
      FAKE_CODEX_REQUEST_LOG: requestLog,
      // 턴 id 셈은 프로세스 밖에 둔다 — 앱이 프로세스를 갈아 끼워도 새 id 가 나온다(실제 서버와 같다).
      FAKE_CODEX_TURN_SEQ_FILE: join(base, 'turn-seq'),
      ...knobs
    })
  }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const guard = { userData: join(base, 'userdata'), folderHash: 'folder-a', key: Buffer.from('conn-test-key') }
  const notes: string[] = []
  const sessions: string[] = []
  const events: AgentEvents = {
    message: () => {}, permission: () => {}, note: (t) => notes.push(t), session: (id) => sessions.push(id), skill: () => {}
  }
  const requests = (): Request[] => existsSync(requestLog)
    ? readFileSync(requestLog, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Request)
    : []
  return { base, root, home, skill, env, binary, guard, notes, sessions, events, requests }
}

/**
 * 앱 연결. `modelChosen: () => false` 를 **명시**한다 — 이 값이 없으면 `everChosen` 이 true 로
 * 읽혀(옵션을 모르는 옛 호출자 보존) 재개할 때마다 ephemeral 탐침이 나가고 그 탐침이 0.8초짜리
 * 상태 읽기를 두 번 더 부른다. 여기서 보려는 것은 잠금 순서이지 모델 기본값 복귀가 아니다.
 */
function connection(s: Scene, extra: Partial<AgentOptions> = {}): CodexConnection {
  return new CodexConnection({
    binary: s.binary, root: s.root, skill: s.skill, env: s.env,
    openExternal: async () => {},
    modelChosen: () => false,
    guard: s.guard,
    ...extra
  })
}

/** 실제 스레드 적재 — ephemeral 탐침(`serverDefaults`)은 스레드가 아니다. */
const liveLoads = (requests: Request[], method: 'thread/start' | 'thread/resume') =>
  requests.filter((r) => r.method === method && r.params.ephemeral !== true)

test('§10-23 ⓐ 열거 결과가 thread/start 의 config 로 실리고, 턴 원장이 그 지문으로 남는다', async () => {
  const s = scene('fresh', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique'
  })
  const conn = connection(s)
  try {
    await conn.run('첫 메시지', undefined, s.events)
  } finally {
    await conn.stop()
  }
  // 안내 없이 새 대화 — 학생이 본 것이 없다.
  expect(s.notes).toEqual([])
  expect(s.sessions).toEqual(['t-fake'])
  const starts = liveLoads(s.requests(), 'thread/start')
  expect(starts, 'thread/start 는 한 번, 잠금 config 를 실어서').toHaveLength(1)
  expect(starts[0].params.config).toEqual(FOREIGN_LOCK)
  // 턴 id 는 turn/start 응답 즉시 원장에 남는다(§4.1-C ⑨).
  expect(loadCodexThreads(s.guard)).toEqual({ 't-fake': { fingerprint: FOREIGN_FINGERPRINT, turns: ['u-1'] } })
})

test('§10-23 ⓑ 앱이 열지 않은 턴이 섞인 대화는 잠김에 이르러도 턴을 열지 않고 새 대화로 바뀐다', async () => {
  const s = scene('polluted', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique',
    FAKE_CODEX_THREAD_TURNS: JSON.stringify({ 't-fake': ['u-outer'] })
  })
  // 앱이 연 턴 하나만 원장에 있는 상태에서, 서버는 앱이 모르는 턴 하나를 더 들고 있다.
  expect(saveCodexThreads(s.guard, (rows) => ({ ...rows, 't-fake': codexThreadRow(FOREIGN_FINGERPRINT, ['u-app']) }))).toBe(true)
  const conn = connection(s)
  try {
    await conn.run('이어서', 't-fake', s.events)
  } finally {
    await conn.stop()
  }
  expect(s.notes).toEqual([newChatNotice('d', 0)])
  const requests = s.requests()
  const resumeAt = requests.findIndex((r) => r.method === 'thread/resume')
  const startAt = requests.findIndex((r) => r.method === 'thread/start' && r.params.ephemeral !== true)
  expect(resumeAt, '이어 하기는 먼저 resume 한다').toBeGreaterThanOrEqual(0)
  expect(startAt, '원장이 어긋나면 그 뒤에 새 대화를 연다').toBeGreaterThan(resumeAt)
  // 새 대화의 턴도 원장에 남고, 앱이 모르던 턴은 지우지 않는다(그 턴은 여전히 서버에 있다).
  expect(loadCodexThreads(s.guard)['t-fake'].turns).toEqual(['u-1', 'u-app'])
})

test('§10-23 ⓒ 다른 창이 대화를 쥐고 있으면 재전송도 새 대화도 없이 그대로 멈춘다', async () => {
  const s = scene('writer', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique',
    FAKE_CODEX_RESUME_ERROR: 'active-writer',
    FAKE_CODEX_RESUME_FAIL_TIMES: '1'
  })
  const conn = connection(s)
  try {
    await conn.run('첫 메시지', undefined, s.events)
    const seen = s.requests().length
    await expect(conn.run('이어서', 't-fake', s.events)).rejects.toThrow(OTHER_WINDOW_COPY)
    const after = s.requests().slice(seen)
    expect(after.filter((r) => r.method === 'thread/resume')).toHaveLength(1)
    expect(liveLoads(after, 'thread/start'), '다른 창이 쥔 대화를 새 대화로 갈아치우지 않는다').toEqual([])
    expect(s.notes).toEqual([])
  } finally {
    await conn.stop()
  }
})

test('§10-23 ⓓ rollout 이 아직 없는 대화는 새 대화로 다시 열되, 안내는 내지 않는다', async () => {
  const s = scene('rollout', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique',
    FAKE_CODEX_RESUME_ERROR: 'no-rollout',
    FAKE_CODEX_RESUME_FAIL_TIMES: '1'
  })
  const conn = connection(s)
  try {
    await conn.run('첫 메시지', undefined, s.events)
    const seen = s.requests().length
    await conn.run('이어서', 't-fake', s.events)
    const after = s.requests().slice(seen)
    expect(after.filter((r) => r.method === 'thread/resume')).toHaveLength(1)
    expect(liveLoads(after, 'thread/start'), '버리고 새로 연다').toHaveLength(1)
    // 학생이 본 대화가 아직 없다(턴 0) — '새 대화로 바뀐다'고 겁줄 것이 없다.
    expect(s.notes).toEqual([])
    expect(loadCodexThreads(s.guard)['t-fake'].turns).toEqual(['u-1', 'u-2'])
  } finally {
    await conn.stop()
  }
})

test('§10-23 ⓔ 학생 설정에 같은 이름의 kordoc 이 있으면 앱 것이 아니라 그 이름을 끄고 알린다', async () => {
  const s = scene('kordoc', {
    FAKE_CODEX_CONFIG_READ: JSON.stringify({
      config: { mcp_servers: { kordoc: { command: '/x/node' } }, plugins: {} },
      layers: [{ name: { type: 'user' }, config: { mcp_servers: { kordoc: { command: '/x/node' } } } }]
    }),
    FAKE_CODEX_MCP_STATUS: JSON.stringify([{ name: 'kordoc', runtimeStatus: 'disabled' }]),
    FAKE_CODEX_TURN_ID_MODE: 'unique'
  })
  const spec: KordocMcpSpec = {
    command: '/opt/homebrew/bin/node',
    args: ['/Users/nara/work/kordoc/dist/mcp.js'],
    env: { KORDOC_ROOT: s.root, KORDOC_OFFLINE: '1', ELECTRON_RUN_AS_NODE: '1' },
    version: '4.17.1'
  }
  const conn = connection(s)
  try {
    await conn.setMcpSpec(spec)
    await conn.run('첫 메시지', undefined, s.events)
  } finally {
    await conn.stop()
  }
  expect(s.notes).toEqual([KORDOC_COLLISION_NOTE])
  const start = liveLoads(s.requests(), 'thread/start')[0]
  expect(start.params.config).toMatchObject({ mcp_servers: { kordoc: { enabled: false } } })
})

test('§10-23 ⓕ 열쇠가 없어도 잠금은 켜지고, 장부는 디스크에 남기지 않는다(C-02)', async () => {
  const s = scene('keyless', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique'
  })
  // 열쇠를 못 얻은 실행: 디스크 장부는 못 믿지만 **잠금·격리는 그대로** 돌아야 한다.
  const keyless = { ...s.guard, key: null }
  const conn = connection(s, { guard: keyless, modelChosen: () => true })
  try {
    await conn.run('첫 메시지', undefined, s.events)
    // 열쇠 없는 경로는 탐침(`serverDefaults`)을 돌지 않는다 — 프로세스는 하나다.
    expect(s.requests().filter((r) => r.method === 'initialize')).toHaveLength(1)
    const methods = s.requests().map((r) => r.method)
    expect(methods).toContain('config/read')
    expect(methods).toContain('plugin/installed')
  } finally {
    await conn.stop()
  }
  const start = liveLoads(s.requests(), 'thread/start')[0]
  expect(start.params.config, '설정에 있던 외부 MCP 를 끈 그 config 가 실린다').toEqual(FOREIGN_LOCK)
  expect(existsSync(join(s.guard.userData, 'guard')), '열쇠가 없으면 디스크 장부 자리를 만들지 않는다').toBe(false)
})

test('§10-23 ⓗ 기본값 탐침이 실패하거나 대화 id 를 못 주면 그 프로세스를 버리고 다음에 새로 연다(I-02)', async () => {
  // 셈과 "한 번만" 표식을 파일에 둔다 — 앱이 프로세스를 버리면 새 프로세스가 다시 읽는데,
  // 프로세스 안 셈이면 같은 실패가 무한히 반복돼 재시도 경로를 볼 수 없다.
  const knobs = realpathSync(mkdtempSync(join(tmpdir(), 'kd-eph-')))
  scratch.push(knobs)
  const s = scene('probe-discard', {
    FAKE_CODEX_EPHEMERAL_FAIL_FILE: join(knobs, 'fail'),
    FAKE_CODEX_EPHEMERAL_THREAD_ID_MODE: 'missing',
    FAKE_CODEX_EPHEMERAL_THREAD_ID_FILE: join(knobs, 'missing'),
    FAKE_CODEX_TURN_ID_MODE: 'unique'
  })
  writeFileSync(join(knobs, 'fail'), '1')
  writeFileSync(join(knobs, 'missing'), '')
  const conn = connection(s, { modelChosen: () => true })
  try {
    // 1) 서버 오류 — 응답이 없으니 그 프로세스가 무엇을 남겼는지 앱은 모른다. 버린다.
    await expect(conn.prepare('t-fake')).rejects.toThrow('temporary failure')
    // 2) 새 프로세스가 다시 묻고, 이번엔 대화 id 가 없는 응답 — 남은 model 을 기본값으로 삼지 않는다.
    await expect(conn.prepare('t-fake')).rejects.toThrow('Codex가 기본 대화를 만들지 못했어요.')
    // 3) 세 번째 프로세스에서 정상 응답 — 기본값이 확정된다.
    await expect(conn.prepare('t-fake')).resolves.toBeUndefined()
    // 확정된 뒤에는 다시 묻지 않는다(네 번째 프로세스가 생기지 않는다).
    await expect(conn.prepare('t-fake')).resolves.toBeUndefined()
    expect(s.requests().filter((r) => r.method === 'initialize')).toHaveLength(3)
    expect(liveLoads(s.requests(), 'thread/start'), '탐침은 실제 적재가 아니다').toHaveLength(0)
  } finally {
    await conn.stop()
  }
})

test('§10-23 ⓘ 앱이 만드는 연결은 열쇠가 없어도 지킴이 문맥을 받는다(C-02)', async () => {
  const s = scene('service-guard')
  // 동봉본(설치 원본)은 설치 대상과 **다른** 자리다 — 같은 폴더면 설치는 자기 자신을 지우고 복사한다.
  const bundle = join(s.base, 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), '# bundled skill\n')
  let captured: AgentOptions | undefined
  const stub: AgentConnection = {
    status: async () => ({ installed: true, connected: false, version: null, detail: '연결 안 됨' }),
    login: async () => { throw new Error('Login is forbidden in this test') },
    run: async () => { throw new Error('Run is forbidden in this test') },
    respond: () => {}, stop: async () => {}
  }
  const service = new ChatService({
    skillSource: () => bundle, userData: s.guard.userData,
    emit: () => {}, openExternal: async () => {},
    connectionFactory: (_provider, options) => { captured = options; return stub },
    guardKey: null
  })
  try {
    await expect(service.send(s.root, 'codex', '첫 메시지', 'r1')).rejects.toThrow()
  } finally {
    await service.close()
  }
  expect(captured?.guard, '열쇠가 없어도 문맥은 늘 넘어간다').toBeDefined()
  expect(captured!.guard!.key).toBeNull()
  expect(captured!.guard!.userData).toBe(s.guard.userData)
  expect(captured!.guard!.folderHash).toBe(folderHash(s.root))
  expect(existsSync(join(s.guard.userData, 'guard')), '열쇠가 없으면 디스크 장부 자리를 만들지 않는다').toBe(false)
})

test('§10-23 ⓖ 이어 하기는 같은 잠금 config 를 다시 싣고, 원장에 이번 턴을 더한다', async () => {
  const s = scene('resume', {
    FAKE_CODEX_CONFIG_READ: FOREIGN_CONFIG,
    FAKE_CODEX_MCP_STATUS: FOREIGN_STATUS,
    FAKE_CODEX_TURN_ID_MODE: 'unique'
  })
  const conn = connection(s)
  try {
    await conn.run('첫 메시지', undefined, s.events)
    await conn.run('이어서', 't-fake', s.events)
  } finally {
    await conn.stop()
  }
  expect(s.notes).toEqual([])
  const resumes = liveLoads(s.requests(), 'thread/resume')
  expect(resumes).toHaveLength(1)
  expect(resumes[0].params.config).toEqual(FOREIGN_LOCK)
  expect(loadCodexThreads(s.guard)).toEqual({
    't-fake': { fingerprint: FOREIGN_FINGERPRINT, turns: ['u-1', 'u-2'] }
  })
})
