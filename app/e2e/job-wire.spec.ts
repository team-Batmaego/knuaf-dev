// 배선 B — 주문 수집 → JobRunner → 결과 전달 → 수명 연결.
// 실제 AI 호출 0회: 본대화·담당 연결 모두 가짜다. 시험 계획 B ①·①-2·②·③·④.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { canonical, sha256 } from '../src/main/chat/jobs/isolation'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { ConversationOwner, ExecutionAccount, JobConnection, JobEvents, RelayRequest } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow } from '../src/shared/lanes'

async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('시험이 기다리던 상태에 이르지 못했어요')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

function fakeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-wire-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '# fake skill\n')
  writeFileSync(join(dir, 'delegation.json'), JSON.stringify({ jobSchema: 1, laneRequestSchema: 1, contractVersion: 'role-v1' }))
  return dir
}

type Order = Record<string, unknown> & { id: string }

/** `gg.py delegate` 가 쓰는 모양 그대로 — 앱 manifest 키(status/contentHash/…)는 넣지 않는다. */
function order(root: string, id: string, lane: 'research' | 'review' = 'research'): Order {
  const entry = planFromRow('both-high')[lane]!
  const spec: Record<string, unknown> = {
    schema: 1, id, lane, task: 'Read the project and write the result',
    inputs: [{ sourceId: 'project', path: join(root, 'project.json'), hash: sha256(readFileSync(join(root, 'project.json'))), section: 'one' }],
    outputs: ['result.md'], contractVersion: 'role-v1',
    company: entry.company, model: entry.model, effort: entry.effort
  }
  if (lane === 'research') {
    spec.research = {
      research_type: '생산량', questions: [{ id: 'Q1', target: '생산량', acceptance: '공식 통계' }],
      routes: [{ doc: 'research-sources.md', id_or_name: 'KOSIS', url: 'https://kosis.kr/' }],
      keywords: ['생산량'], output_file: 'result.md'
    }
  }
  return spec as Order
}

interface WireOptions {
  root?: string
  userData?: string
  skill?: string
  usage?: 'allowed' | 'limit'
  /** 본대화 차례가 끝나기 전에 학생 폴더에 떨어지는 주문 파일. */
  orders?: (root: string, text: string) => Order[]
  jobBehavior?: (request: RelayRequest, events: JobEvents) => Promise<void>
  jobStop?: () => void
}

const defaultBehavior = async (request: RelayRequest, events: JobEvents): Promise<void> => {
  events.session(`job-${request.jobId}`)
  writeFileSync(join(request.cwd, 'result.md'), `${request.jobId} result`)
}

function wire(opts: WireOptions = {}) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-wire-')))
  const root = opts.root ?? join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  if (!opts.root) writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'kd-wire-ud-'))
  const skill = opts.skill ?? fakeSkill()
  const jobsDir = join(root, '.knuaf-gui', 'jobs')
  mkdirSync(jobsDir, { recursive: true })

  const account = (company: Provider): ExecutionAccount => ({
    accountId: `${company}-account`, connected: true,
    account: company === 'claude'
      ? { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: ['opus', 'sonnet', 'haiku'].map((model) => ({ model, name: model, efforts: ['low', 'high'] })) }
      : { company: 'codex', accountType: 'chatgpt', models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map((model) => ({ model, name: model, efforts: ['low', 'high'] })) },
    usage: company === 'codex' ? (opts.usage ?? 'allowed') : 'allowed',
    consented: false
  })

  const mainRuns: string[] = []
  const jobRuns: string[] = []
  const invalidated: string[] = []
  const counters = { mainStops: 0, jobStops: 0 }
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {},
    respond: () => {},
    run: async (text, _sessionId, events) => {
      mainRuns.push(text)
      events.session('main-session')
      for (const spec of opts.orders?.(root, text) ?? []) writeFileSync(join(jobsDir, `${spec.id}.json`), JSON.stringify(spec))
    },
    stop: async () => { counters.mainStops++ }
  }
  const jobConnection = (request: RelayRequest): JobConnection => ({
    relayProtocol: 1,
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {},
    respond: () => {},
    run: async () => { throw new Error('담당 연결은 run 이 아니라 runJob 으로만 움직인다') },
    // 러너는 `options.account`(앱 동의 반영본)와 이 값의 지문을 비교한다 — 같은 키 순서로 만든다.
    availability: async () => ({ ...account(request.company), consented: true }),
    runJob: async (_text, events) => {
      jobRuns.push(request.jobId)
      await (opts.jobBehavior ?? defaultBehavior)(request, events)
    },
    stop: async () => { counters.jobStops++; opts.jobStop?.() }
  })
  const svc = new ChatService({
    skillSource: () => skill, userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    jobConnectionFactory: jobConnection,
    jobAccount: async (company) => account(company),
    jobShellSandboxAvailable: true,
    invalidateHandoff: (value) => { invalidated.push(value) }
  })
  return {
    svc, root, userData, mainRuns, jobRuns, invalidated, counters,
    deliveries: () => svc.snapshot(root, 'codex').messages.filter((m) => m.text.startsWith('자료 담당('))
  }
}

function runnerState(userData: string): { jobs: { status: string; reason?: string; outputs: string[] }[]; proposals: { state: string }[] } {
  try { return JSON.parse(readFileSync(join(userData, 'jobs', 'jobrunner.json'), 'utf8')) }
  catch { return { jobs: [], proposals: [] } }
}
function manifest(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.knuaf-gui', 'jobs', `${id}.json`), 'utf8'))
}
function statusOf(root: string, id: string): string | null {
  try { return manifest(root, id).status as string } catch { return null }
}

// ① 메인 턴이 남긴 주문을 모아 러너에 넘기고, 결과를 소유 대화의 새 차례로 한 번만 넣는다.
test('a finished main turn collects delegate orders and delivers each root job once', async () => {
  let queued = false
  const w = wire({
    orders: (root, text) => {
      if (queued || text.startsWith('자료 담당')) return []
      queued = true
      return [order(root, 'job-one')]
    }
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '첫 번째 부탁', 'req-1')
  await until(() => w.jobRuns.length === 1 && w.mainRuns.length >= 2 && !w.svc.busy(w.root))
  await until(() => w.deliveries().length === 1)

  expect(w.jobRuns).toEqual(['job-one'])
  expect(w.mainRuns[0]).toBe('첫 번째 부탁')
  expect(w.mainRuns[1]).toContain('자료 담당(ChatGPT·astra·기본) 작업 끝')
  expect(w.mainRuns[1]).toContain('jobs/job-one/out/result.md')
  expect(w.deliveries()[0].role).toBe('system')
  expect(statusOf(w.root, 'job-one')).toBe('completed')
  // 담당은 논문 정본을 건드리지 않는다.
  expect(readFileSync(join(w.root, 'project.json'), 'utf8')).toBe('{"original":true}')

  // 다음 본대화 차례가 같은 주문을 다시 줍지 않는다 — 결과도 다시 넣지 않는다.
  await w.svc.send(w.root, 'codex', '두 번째 부탁', 'req-2')
  await until(() => w.mainRuns.length >= 3 && !w.svc.busy(w.root))
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  expect(w.jobRuns).toEqual(['job-one'])
  expect(w.deliveries()).toHaveLength(1)
  await w.svc.close()
})

// ①-2 전달 claim 만 저장된 채 앱이 죽으면, 다시 보내지 않고 '확인 못 함'을 한 번만 드러낸다.
test('a delivery claimed before shutdown is surfaced once and never resent', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-wire-recover-')))
  const root = join(base, 'thesis')
  mkdirSync(root)
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = mkdtempSync(join(tmpdir(), 'kd-wire-ud-'))
  mkdirSync(join(userData, 'jobs'), { recursive: true })
  writeFileSync(join(userData, 'jobs', 'store.json'), JSON.stringify({
    version: 1, approvals: {}, consent: {},
    deliveries: { 'job-old': { state: 'started', root: canonical(root), ownerId: `codex\0${canonical(root)}`, at: '2026-11-09T00:00:00.000Z' } }
  }))

  const w = wire({ root, userData })
  const first = w.svc.snapshot(w.root, 'codex').messages
  expect(first).toHaveLength(1)
  expect(first[0].role).toBe('system')
  expect(first[0].text).toContain('확인하지 못했어요')
  expect(first[0].text).toContain('다시 보내지 않았어요')
  expect(w.mainRuns).toEqual([])
  expect(w.jobRuns).toEqual([])

  // 두 번째 스냅샷은 같은 줄을 또 넣지 않는다.
  expect(w.svc.snapshot(w.root, 'codex').messages).toHaveLength(1)
  const store = JSON.parse(readFileSync(join(userData, 'jobs', 'store.json'), 'utf8'))
  expect(store.deliveries['job-old']).toMatchObject({ state: 'uncertain', notified: true })
  await w.svc.close()
})

// ② 승인·동의는 앱 저장소만 근거다. 폴더 안 lanes.json 은 무시하고, 동의 철회는 다음 실행부터 즉시다.
test('approval and billing consent come from app storage, never the thesis folder', async () => {
  let n = 0
  const w = wire({ orders: (root, text) => (text.startsWith('자료 담당') ? [] : [order(root, `job-${++n}`)]) })
  // 폴더 안 가짜 승인 — both-low 라서 both-high 주문과 맞지 않는다. 근거가 되면 아래가 전부 실패한다.
  writeFileSync(join(w.root, 'lanes.json'), JSON.stringify(planFromRow('both-low')))

  await w.svc.send(w.root, 'codex', '아직 승인 없음', 'req-1')
  await until(() => w.mainRuns.length >= 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  expect(w.jobRuns).toEqual([])

  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '승인 뒤', 'req-2')
  await until(() => w.jobRuns.length === 2 && w.deliveries().length === 2)
  expect(statusOf(w.root, 'job-1')).toBe('completed')
  expect(statusOf(w.root, 'job-2')).toBe('completed')

  w.svc.setConsent('codex', 'codex-account', false)
  await w.svc.send(w.root, 'codex', '동의 철회 뒤', 'req-3')
  await until(() => w.deliveries().length === 3)
  await until(() => statusOf(w.root, 'job-3') === 'rejected')
  expect(w.jobRuns).toEqual(['job-1', 'job-2'])
  expect(w.deliveries()[2].text).toContain('결과: rejected')
  await w.svc.close()
})

// ③ 학생이 멈추면 진행 담당·본대화가 함께 멈추고, 제안 무효화 통로가 불린다.
test('student stop stops the running job and its main turn and invalidates handoff', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let started = false
  const w = wire({
    orders: (root, text) => (text.startsWith('자료 담당') ? [] : [order(root, 'job-one')]),
    jobStop: () => release(),
    jobBehavior: async (request, events) => {
      started = true
      events.session(`job-${request.jobId}`)
      await held
      writeFileSync(join(request.cwd, 'result.md'), 'late result')
    }
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '오래 걸리는 부탁', 'req-1')
  await until(() => started)

  await w.svc.stop(w.root, 'codex')
  expect(statusOf(w.root, 'job-one')).toBe('stopped')
  expect(w.counters.jobStops).toBeGreaterThanOrEqual(1)
  expect(w.counters.mainStops).toBeGreaterThanOrEqual(1)
  expect(w.invalidated.map(canonical)).toContain(canonical(w.root))
  expect(w.deliveries()).toEqual([])
  await w.svc.close()
})

// ③-2 업데이트 준비: 열린 이어하기 제안을 버리고 담당을 멈춘다. 종료도 같은 통로를 지난다.
test('update teardown discards open continuation proposals and stops jobs', async () => {
  const w = wire({ usage: 'limit', orders: (root, text) => (text.startsWith('자료 담당') ? [] : [order(root, 'job-one')]) })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  w.svc.setConsent('claude', 'claude-account', true)
  await w.svc.send(w.root, 'codex', '한도에 걸리는 부탁', 'req-1')
  await until(() => runnerState(w.userData).proposals.filter((p) => p.state === 'open').length === 1)

  await w.svc.closeForUpdate(async () => {})
  const state = runnerState(w.userData)
  expect(state.jobs[0].status).toBe('stopped')
  expect(state.proposals.every((p) => p.state !== 'open')).toBe(true)
  expect(w.invalidated.map(canonical)).toContain(canonical(w.root))

  await w.svc.close()
  expect(w.invalidated.length).toBeGreaterThanOrEqual(2)
})

// ④ 항목 7 — 전환으로 검토 세션이 새 본대화 세션과 같아지면 결과를 버린다.
test('review rejects a reviewer session that becomes the new owner session', async () => {
  let svc: ChatService
  const w = wire({
    orders: (root, text) => (text.startsWith('자료 담당') ? [] : [order(root, 'job-review', 'review')]),
    jobBehavior: async (_request, events) => {
      const owner: ConversationOwner = { id: `codex\0${canonical(w.root)}`, sessionId: 'new-owner-session', company: 'codex' }
      await svc.switchOwner(w.root, owner)
      events.session('new-owner-session')
    }
  })
  svc = w.svc
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '검토 부탁', 'req-1')
  await until(() => statusOf(w.root, 'job-review') === 'rejected')
  await until(() => w.deliveries().length === 1)

  const record = manifest(w.root, 'job-review')
  expect(record.reason).toContain('작성자와 검토자는 다른 새 세션이어야 해요.')
  // manifest 의 `outputs` 는 주문서가 요청한 값(스펙)이고, 실제로 거둔 파일은 `outputRefs` 다.
  expect(record.outputRefs).toEqual([])
  expect(record.status).toBe('rejected')
  expect(w.deliveries()[0].text).toContain('결과: rejected')
  expect(w.invalidated.map(canonical)).toContain(canonical(w.root))
  await w.svc.close()
})
