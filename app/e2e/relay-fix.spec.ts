// 배선 A Roh 지적 고침(WA-fix) 잠금 시험.
//
// 원칙: 지적마다 **먼저 재현**하고, 고친 뒤 같은 시험이 통과함을 본다. 실행으로 재현할 수 없는
// 것(차단 2)은 스키마 근거 + 보낸 옵션 고정으로 잠근다. 실제 AI 호출 0회.
import { expect, test } from '@playwright/test'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ClaudeRelayConnection, claudeExecutionAccount, prepareRelayPlugin } from '../src/main/chat/claude'
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
 * [차단 1] plugin 폴더를 만들기 전에 심볼릭 링크를 확인해야 한다.
 *
 * 반례: `<root>/.knuaf-gui/relay-plugin` 을 작업 폴더 밖 디렉터리로 링크해 두면, SDK 격리가
 * 시작되기 전에 앱이 그 바깥에 `plugin.json`·`SKILL.md` 를 쓴다. 그래서 폴더 조립을
 * `prepareRelayPlugin()` 하나로 모으고, 링크·경로 탈출이면 **아무것도 쓰기 전에** 던진다.
 */
test('[차단 1] 담당 플러그인 폴더가 작업 폴더 밖을 가리키면 쓰지 않는다', () => {
  const { root, out, skill } = fixtureRoot('plugin')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kd-fix-outside-')))
  const pluginRoot = join(root, '.knuaf-gui', 'relay-plugin')
  mkdirSync(dirname(pluginRoot), { recursive: true })
  symlinkSync(outside, pluginRoot)
  expect(() => prepareRelayPlugin(root, 'j1', skill)).toThrow()
  // 바깥에 아무것도 만들어지지 않았어야 한다.
  expect(existsSync(join(outside, 'j1'))).toBe(false)
})

/** 링크가 없으면 정상 생성되고, 경로가 작업 폴더 안에 있다. */
test('[차단 1] 링크가 없으면 플러그인 폴더를 작업 폴더 안에 만든다', () => {
  const { root, skill } = fixtureRoot('plugin-ok')
  const dir = prepareRelayPlugin(root, 'j1', skill)
  expect(realpathSync(dir).startsWith(realpathSync(root))).toBe(true)
  expect(existsSync(join(dir, '.claude-plugin', 'plugin.json'))).toBe(true)
  expect(existsSync(join(dir, 'skills', 'knuaf-dev', 'SKILL.md'))).toBe(true)
})

/**
 * [차단 1 · 2회차] **파일 자체**가 링크인 경우까지 막는다.
 *
 * 반례(2회차 검토): 상위 폴더 검사만으로는 부족하다. `.claude-plugin/plugin.json` **파일**이
 * 작업 폴더 밖 파일을 가리키는 링크면 `writeFileSync` 가 그 링크를 따라가 바깥 파일을 덮어쓴다.
 * 같은 방식으로 쓰는 SKILL.md·스킬 폴더도 같다.
 *
 * 처방: 링크를 따라가지 않는 쓰기 — 임시 폴더에 다 쓰고 `rename` 으로 통째로 바꾼다.
 * `rename` 은 대상이 링크여도 **링크 자체**를 교체하며 링크를 따라가지 않는다.
 */
test('[차단 1·2회차] plugin.json 파일이 링크면 작업 폴더 밖 파일을 덮어쓰지 않는다', () => {
  const { root, skill } = fixtureRoot('file-link-manifest')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kd-fix-outside-file-')))
  const victim = join(outside, 'victim.json')
  writeFileSync(victim, 'ORIGINAL')
  const dir = join(root, '.knuaf-gui', 'relay-plugin', 'j1', '.claude-plugin')
  mkdirSync(dir, { recursive: true })
  symlinkSync(victim, join(dir, 'plugin.json'))
  // 성공하든 거절하든 **바깥 파일은 그대로**여야 한다. 이 앱은 주문 폴더를 통째로 새로 만들고
  // rename 으로 교체하므로 성공 쪽이 정상이다(링크는 따라가지 않고 링크 자체가 사라진다).
  prepareRelayPlugin(root, 'j1', skill)
  expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
  expect(lstatSync(join(dir, 'plugin.json')).isSymbolicLink()).toBe(false)
})

test('[차단 1·2회차] 스킬 폴더나 SKILL.md 가 링크면 그 링크를 따라 쓰지 않는다', () => {
  const { root, skill } = fixtureRoot('file-link-skill')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kd-fix-outside-skill-')))
  writeFileSync(join(outside, 'SKILL.md'), 'ORIGINAL')
  const skillsDir = join(root, '.knuaf-gui', 'relay-plugin', 'j1', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  // 스킬 폴더 자체를 바깥으로 링크.
  symlinkSync(outside, join(skillsDir, 'knuaf-dev'))
  prepareRelayPlugin(root, 'j1', skill)
  // 바깥 폴더는 그대로이고, 안쪽 스킬 사본은 링크가 아닌 실제 폴더다.
  expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('ORIGINAL')
  expect(readdirSync(outside)).toEqual(['SKILL.md'])
  expect(lstatSync(join(skillsDir, 'knuaf-dev')).isSymbolicLink()).toBe(false)
})

test('[차단 1·2회차] 이미 있는 plugin.json 링크도 결과적으로 링크가 아닌 실제 파일이 된다', () => {
  const { root, skill } = fixtureRoot('file-link-replace')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kd-fix-outside-replace-')))
  const victim = join(outside, 'victim.json')
  writeFileSync(victim, 'ORIGINAL')
  const dir = join(root, '.knuaf-gui', 'relay-plugin', 'j1', '.claude-plugin')
  mkdirSync(dir, { recursive: true })
  symlinkSync(victim, join(dir, 'plugin.json'))
  // 고침 뒤에는 링크가 실제 파일로 **교체**되고 바깥은 그대로다.
  let failed = false
  try { prepareRelayPlugin(root, 'j1', skill) } catch { failed = true }
  expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
  if (!failed) {
    const saved = lstatSync(join(dir, 'plugin.json'))
    expect(saved.isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).name).toBe('knuaf')
  }
})

/** 같은 주문을 두 번 조립해도 안전하고(기존 폴더 교체) 임시 폴더가 남지 않는다. */
test('[차단 1·2회차] 같은 주문을 다시 조립해도 임시 폴더가 남지 않는다', () => {
  const { root, skill } = fixtureRoot('relay-rebuild')
  const first = prepareRelayPlugin(root, 'j1', skill)
  const second = prepareRelayPlugin(root, 'j1', skill)
  expect(second).toBe(first)
  expect(JSON.parse(readFileSync(join(second, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('knuaf')
  expect(readFileSync(join(second, 'skills', 'knuaf-dev', 'SKILL.md'), 'utf8')).toContain('FIX-SPEC')
  // 작업 폴더 안 임시·물림 폴더가 남지 않았어야 한다.
  const base = join(root, '.knuaf-gui', 'relay-plugin')
  expect(readdirSync(base).filter(name => name.startsWith('.staging-') || name.startsWith('.retired-'))).toEqual([])
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
