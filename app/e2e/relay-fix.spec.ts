// 배선 A Roh 지적 고침(WA-fix) 잠금 시험.
//
// 원칙: 지적마다 **먼저 재현**하고, 고친 뒤 같은 시험이 통과함을 본다. 실행으로 재현할 수 없는
// 것(차단 2)은 스키마 근거 + 보낸 옵션 고정으로 잠근다. 실제 AI 호출 0회.
import { expect, test } from '@playwright/test'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ClaudeRelayConnection, claudeExecutionAccount, prepareRelayPlugin, removeRelayPlugin, sweepRelayPlugins } from '../src/main/chat/claude'
import { CodexRelayConnection, codexExecutionAccount, codexThreadParams } from '../src/main/chat/codex'
import { JobRunner } from '../src/main/chat/jobs'
import { canonical, relayIsolation, sha256 } from '../src/main/chat/jobs/isolation'
import { JobFailure, type ConversationOwner, type ExecutionAccount, type JobConnection, type JobEvents, type RelayRequest } from '../src/main/chat/jobs/types'
import type { AgentOptions } from '../src/main/chat/contracts'
import { planFromRow } from '../src/shared/lanes'

const appRoot = process.cwd()
const owner: ConversationOwner = { id: 'main', sessionId: 'author', company: 'claude' }

function fixtureRoot(tag: string): { root: string; out: string; skill: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `kd-fix-${tag}-`)))
  const out = join(root, '.knuaf-gui', 'jobs', 'j1', 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: knuaf-dev\ndescription: fix spec\n---\nFIX-SPEC\n')
  return { root, out, skill }
}

function agentOptions(binary: string, root: string, skill: string, env: NodeJS.ProcessEnv = {}): AgentOptions {
  return { binary, root, skill, env: { PATH: process.env.PATH, ...env }, openExternal: async () => {} }
}

function relayRequest(root: string, out: string, skill: string, overrides: Partial<RelayRequest> = {}): RelayRequest {
  return { key: `${root}\0claude\0job:j1`, jobId: 'j1', company: 'claude', cwd: out, skill,
    model: 'sonnet', effort: 'high', isolation: relayIsolation(out, ['result.md'], true), ...overrides }
}

function recorder() {
  const seen: { kind: string; value: unknown }[] = []
  const events: JobEvents = {
    message: () => {}, note: () => {}, permission: () => {}, skill: () => {},
    session: id => seen.push({ kind: 'session', value: id }),
    availability: state => seen.push({ kind: 'availability', value: state }),
    tokens: event => seen.push({ kind: 'tokens', value: event }),
    actualModel: (model, effort) => seen.push({ kind: 'actualModel', value: [model, effort] })
  }
  return { seen, events, of: (kind: string) => seen.filter(s => s.kind === kind).map(s => s.value) }
}

/**
 * [차단 1 · 3회차] relay 플러그인은 **학생 폴더에 아무것도 만들지 않는다**.
 *
 * 1·2회차는 학생 폴더 안 경로를 검사하며 링크를 막았지만, 검사한 부모와 실제로 쓰는 대상이
 * 경로 문자열 재해석으로 갈라질 수 있었다(검토 3회차, 정적 분석). 링크를 하나씩 막는 대신
 * **위치를 앱 전용 자리로 옮겨** 그 경합 자체를 없앤다. 학생 폴더에는 쓸 경로가 없으므로
 * 그 안에 어떤 링크가 있어도 무관하다.
 */
test('[차단 1·3회차] relay 플러그인은 학생 폴더 밖 앱 자리에 만들어진다', () => {
  const { root, skill } = fixtureRoot('plugin-outside')
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'kd-app-relay-')))
  const dir = prepareRelayPlugin(appDir, 'j1', skill)
  // ① 플러그인은 앱 자리 안에 있다.
  expect(realpathSync(dirname(dir))).toBe(realpathSync(join(appDir, 'relay-plugin')))
  expect(existsSync(join(dir, '.claude-plugin', 'plugin.json'))).toBe(true)
  expect(existsSync(join(dir, 'skills', 'knuaf-dev', 'SKILL.md'))).toBe(true)
  // ② 학생 폴더에는 relay 가 만든 플러그인 경로가 없다(`.knuaf-gui/jobs` 는 픽스처가 만든 것).
  expect(existsSync(join(root, '.knuaf-gui', 'relay-plugin'))).toBe(false)
})

/** 학생 폴더 안에 링크가 미리 놓여 있어도 relay 는 그 링크를 건드리지 않는다(위치가 다르므로). */
test('[차단 1·3회차] 학생 폴더의 링크는 무관하다', () => {
  const { root, skill } = fixtureRoot('plugin-root-links')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kd-fix-outside-link-')))
  writeFileSync(join(outside, 'SKILL.md'), 'ORIGINAL')
  const bait = join(root, '.knuaf-gui', 'relay-plugin')
  mkdirSync(dirname(bait), { recursive: true })
  symlinkSync(outside, bait)
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'kd-app-relay2-')))
  const dir = prepareRelayPlugin(appDir, 'j1', skill)
  expect(dir.startsWith(realpathSync(appDir))).toBe(true)
  // 바깥 원본은 그대로이고, 링크도 그대로다(우리가 만든 것이 아니다).
  expect(readdirSync(outside)).toEqual(['SKILL.md'])
  expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('ORIGINAL')
  expect(lstatSync(bait).isSymbolicLink()).toBe(true)
})

/** 주문이 끝나면(성공·실패·중단 모두) 그 주문 전용 폴더를 지운다. */
test('[차단 1·3회차] 주문이 끝나면 플러그인 폴더를 지운다', () => {
  const { skill } = fixtureRoot('plugin-cleanup')
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'kd-app-relay3-')))
  const dir = prepareRelayPlugin(appDir, 'j1', skill)
  expect(existsSync(dir)).toBe(true)
  removeRelayPlugin(appDir, 'j1')
  expect(existsSync(dir)).toBe(false)
  // 지울 것이 없어도 조용히 넘어간다(실패 경로에서 두 번 불릴 수 있다).
  expect(() => removeRelayPlugin(appDir, 'j1')).not.toThrow()
})

/** 앱 시작 때 남은 것을 치운다 — 지난 실행이 중간에 죽어 남긴 폴더. */
test('[차단 1·3회차] 앱 시작 정리가 지난 실행의 잔여 폴더를 지운다', () => {
  const { skill } = fixtureRoot('plugin-sweep')
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'kd-app-relay4-')))
  const stale = prepareRelayPlugin(appDir, 'old-job', skill)
  expect(existsSync(stale)).toBe(true)
  sweepRelayPlugins(appDir)
  expect(existsSync(join(appDir, 'relay-plugin', 'old-job'))).toBe(false)
  expect(existsSync(join(appDir, 'relay-plugin'))).toBe(true)
})

/** SDK 에 넘어가는 `plugins` 경로가 앱 전용 자리다 — 실제 연결 옵션으로 확인한다. */
test('[차단 1·3회차] SDK 에 넘기는 plugins 경로는 앱 자리다', async () => {
  const { root, out, skill } = fixtureRoot('plugin-options')
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'kd-app-relay5-')))
  const connection = new ClaudeRelayConnection(agentOptions('/fake/claude', root, skill), relayRequest(root, out, skill), appDir)
  const options = connection.debugQueryOptions()
  const plugins = (options as { plugins?: { path: string }[] }).plugins ?? []
  expect(plugins.length).toBe(1)
  // 경로만 계산하므로 아직 없을 수 있다 — 문자열 기준으로 앱 자리 안인지만 본다(실체 생성은 위 시험들).
  expect(plugins[0].path).toBe(join(appDir, 'relay-plugin', 'j1'))
  expect(plugins[0].path.startsWith(root)).toBe(false)
})

/**
 * [차단 2] `thread/start` 에 심사자를 명시한다.
 *
 * 스키마 근거(`/tmp/opencode/codex-schema/v2/ApprovalsReviewer.ts`, 0.167.0):
 * `"user" | "auto_review" | "guardian_subagent"` — "Configures who approval requests are routed to
 * for review. Examples include sandbox escapes, blocked network access, MCP approval prompts…
 * Defaults to `user`." 즉 지정하지 않으면 **사용자 설정을 상속**해 자동 심사 에이전트가 승격을
 * 따로 판단할 수 있다. 그래서 앱은 `user` 를 명시하고, 돌려받은 값을 대조한다.
 * (실행 재현은 이 환경에서 불가 — 스키마 + 보낸 옵션 고정으로 잠근다.)
 */
test('[차단 2] Codex 담당은 승인 심사자를 앱이 명시하고 돌려받은 값을 확인한다', async () => {
  const { root, out, skill } = fixtureRoot('reviewer')
  // 보낸 옵션: 심사자를 항상 'user' 로 고정한다.
  expect(codexThreadParams(relayRequest(root, out, skill, { company: 'codex' }), 'gpt-5-codex').approvalsReviewer).toBe('user')
  // 돌려받은 값이 다르면 주문을 열지 않는다(사용자 설정이 심사자를 바꿔 놓은 경우).
  const logFile = join(root, 'app-server.log'); writeFileSync(logFile, '')
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  const hijacked = new CodexRelayConnection(
    agentOptions(wrapper, root, skill, { KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill), KD_FAKE_THREAD_REVIEWER: 'auto_review' }),
    relayRequest(root, out, skill, { company: 'codex', model: 'gpt-5-codex' }))
  try { await expect(hijacked.runJob('담당 모드: 주문서', recorder().events)).rejects.toThrow(/심사자|approvalsReviewer/) }
  finally { await hijacked.stop() }
  // 앱이 실제로 'user' 를 보냈는지 — 서버 요청 로그로 확인한다.
  const sent = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const thread = sent.find(e => e.method === 'thread/start')
  expect(thread.params.approvalsReviewer).toBe('user')
})

/**
 * [중요 1] 승인된 주문이 엔진 `consented:false` 때문에 거절되면 안 된다.
 *
 * 동의는 **앱 저장소**가 정본이다(설계 §3.5 규칙 1). 러너는 `options.account()`(앱 값)로 동의를
 * 판정하고, `availability()` 값은 **사용량·계정** 비교에만 쓴다. 그래서 지문 비교에서
 * `consented` 를 빼고(엔진은 그 값을 모른다), 동의는 앱 값으로만 본다.
 */
test('[중요 1] 앱이 동의한 주문은 엔진 availability 의 consented:false 때문에 막히지 않는다', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-fix-consent-')))
  const root = join(base, 'thesis'), stateDir = join(base, 'private')
  mkdirSync(root); writeFileSync(join(root, 'project.json'), '{"original":true}')
  // research 가 Claude 담당인 줄 — 이 시험은 엔진 availability 의 consented:false 만 본다.
  const plan = planFromRow('claude-high-codex-low')
  const models = ['opus', 'sonnet', 'haiku'].map(model => ({ model, name: model, efforts: ['low', 'high', 'medium', 'xhigh', 'max'] }))
  const baseOptions = { binary: 'fake', root, skill: '/fake/skill', env: {}, openExternal: async () => {} }
  // 실제 배선과 같은 생산자를 쓴다 — 앱과 엔진이 같은 값을 만들고, 다른 것은 `consented` 뿐이다.
  const produced = claudeExecutionAccount(baseOptions, models, { apiKeySource: 'none', subscriptionType: 'max', subject: 'claude-account' })
  const appAccount: ExecutionAccount = { ...produced, consented: true, usage: 'allowed' }
  let runs = 0
  const options = {
    stateDir, approvedPlan: () => plan, account: async () => structuredClone(appAccount),
    skill: () => ({ path: '/fake/skill', schema: 1, contractVersion: 'role-v1' }), supportedSchemas: [1],
    connectionFactory: (request: RelayRequest): JobConnection => ({
      relayProtocol: 1,
      status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
      // 엔진은 동의를 모른다 — 이 값이 주문을 막아서는 안 된다.
      // 계정 쪽 값(apiKeySource·subscriptionType·models)은 앱 값과 같고, 다른 것은 consented 뿐이다.
      availability: async () => ({ ...produced, consented: false, usage: 'allowed' }),
      login: async () => {}, respond: () => {},
      run: async () => { throw new Error('relay') },
      runJob: async (_text, events) => { runs++; events.session(`session-${request.jobId}`); writeFileSync(join(request.cwd, 'result.md'), 'ok') },
      stop: async () => {}
    }),
    deliver: async () => {}, stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: true
  }
  const runner = new JobRunner(options)
  const id = 'fix-consent'
  runner.enqueue(root, { schema: 1, id, lane: 'research', task: 'Read the source and write the result',
    inputs: [{ sourceId: 'project', path: join(root, 'project.json'), hash: sha256(readFileSync(join(root, 'project.json'))), section: 'one' }],
    research: { research_type: '생산량', questions: [{ id: 'Q1', target: '생산량', acceptance: '공식 통계' }],
      routes: [{ doc: 'research-sources.md', id_or_name: 'KOSIS', url: 'https://kosis.kr/' }], keywords: ['생산량'], output_file: 'result.md' },
    outputs: ['result.md'], contractVersion: 'role-v1',
    company: plan.research!.company, model: plan.research!.model!, effort: plan.research!.effort }, owner, 'author')
  await runner.runQueued()
  expect({ status: runner.records()[0]?.status, reason: runner.records()[0]?.reason }).toEqual({ status: 'completed', reason: undefined })
  expect(runs).toBe(1)
})

/**
 * [중요 2] 실제 노력 수준은 **주문값**으로 기록한다.
 *
 * `turn/start.effort` 는 "this turn and subsequent turns" 에 적용된다. 그래서 서버가 돌려준
 * thread 기본값(예: high)을 actualEffort 로 적으면, 주문이 low 일 때 실제 턴은 low 인데 기록은
 * high 가 된다. 기록은 주문이 실제로 보낸 값이어야 한다.
 */
test('[중요 2] Codex 담당의 실제 노력 수준은 thread 기본값이 아니라 주문 effort 다', async () => {
  const { root, out, skill } = fixtureRoot('effort')
  const logFile = join(root, 'app-server.log'); writeFileSync(logFile, '')
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  // 서버 thread 기본값은 high, 주문은 low.
  const connection = new CodexRelayConnection(
    agentOptions(wrapper, root, skill, { KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill), KD_FAKE_THREAD_EFFORT: 'high' }),
    relayRequest(root, out, skill, { company: 'codex', model: 'gpt-5-codex', effort: 'low' }))
  const log = recorder()
  try { await connection.runJob('담당 모드: 주문서', log.events) } finally { await connection.stop() }
  expect(log.of('actualModel')).toEqual([['gpt-5-codex', 'low']])
})

/**
 * [중요 3] `item/permissions/requestApproval` 의 거절 응답은 스키마 모양이어야 한다.
 *
 * 스키마(`v2/PermissionsRequestApprovalResponse.ts`): `{permissions, scope}`. 다른 승인 요청처럼
 * `{decision:'decline'}` 을 보내면 서버 쪽에서 역직렬화 오류·중단 위험이 있다.
 */
test('[중요 3] 권한 요청 거절은 스키마 모양으로 보낸다', async () => {
  const { root, out, skill } = fixtureRoot('permissions')
  const logFile = join(root, 'app-server.log'); writeFileSync(logFile, '')
  const binary = join(appRoot, 'e2e', 'fixtures', 'fake-codex-relay.mjs')
  const wrapper = join(root, 'codex-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`, { mode: 0o755 })
  const connection = new CodexRelayConnection(agentOptions(wrapper, root, skill, { KD_FAKE_CODEX_LOG: logFile, KD_FAKE_SKILL_ROOT: dirname(skill) }),
    relayRequest(root, out, skill, { company: 'codex', model: 'gpt-5-codex' }))
  try { await connection.runJob('담당 모드: 주문서', recorder().events) } finally { await connection.stop() }
  const sent = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const answer = sent.find(e => e.response !== undefined && e.method === 'item/permissions/requestApproval')
  expect(answer).toBeTruthy()
  expect(answer.error).toBeUndefined()
  // 승격 없이 거절: 허용 목록·네트워크가 비어 있어야 한다.
  expect(answer.result).toEqual({ permissions: { network: null, fileSystem: null }, scope: 'turn' })
})

/**
 * [A 관문 ㉠] Claude 담당은 첫 턴에서 사용량을 판정한다고 선언한다.
 * 필드 이름은 a-gate 갈래 `jobs/types.ts` 와 같다(`gateInTurn`).
 */
test('[㉠] Claude 담당 연결이 gateInTurn 을 선언한다', () => {
  const { root, out, skill } = fixtureRoot('gate')
  const connection = new ClaudeRelayConnection(agentOptions('/fake/claude', root, skill), relayRequest(root, out, skill))
  expect(connection.gateInTurn).toBe(true)
  // Codex 는 턴 밖에서 A 를 읽을 수 있으므로 선언하지 않는다(unknown 이면 그대로 차단).
  const codex = new CodexRelayConnection(agentOptions('/fake/codex', root, skill), relayRequest(root, out, skill, { company: 'codex' }))
  expect(codex.gateInTurn).toBeUndefined()
  expect(new JobFailure('limit', 'x').status).toBe('limit')
})
