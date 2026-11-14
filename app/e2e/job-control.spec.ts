// 배선 C §2-1 — 주문 **하나만** 멈추기·버리기·인증 나중에·다시 넘기기, 그리고 동의 철회.
// 실제 AI 호출 0회: 본대화·담당 연결 모두 가짜다. 계약: lanes:set-consent, jobs:stop-one,
// jobs:discard, jobs:auth-later, jobs:redeliver.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { canonical, sha256 } from '../src/main/chat/jobs/isolation'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { JobStore } from '../src/main/chat/jobs/store'
import type { ExecutionAccount, JobConnection, JobEvents, RelayRequest } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow, type LaneRowId } from '../src/shared/lanes'

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('시험이 기다리던 상태에 이르지 못했어요')
    await sleep(20)
  }
}

function fakeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-control-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '# fake skill\n')
  writeFileSync(join(dir, 'delegation.json'), JSON.stringify({ jobSchema: 1, laneRequestSchema: 1, contractVersion: 'role-v1' }))
  return dir
}

type Order = Record<string, unknown> & { id: string }

/** `gg.py delegate` 가 쓰는 모양 그대로 — 앱 manifest 키(status/contentHash/…)는 넣지 않는다. */
function order(root: string, id: string, lane: 'research' | 'review' | 'writing', row: LaneRowId): Order {
  const entry = planFromRow(row)[lane]!
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

interface ControlOptions {
  row?: LaneRowId
  /** codex 계정 상태 — 인증 시험은 `auth` 를 쓴다. */
  usage?: 'allowed' | 'auth' | 'limit'
  orders: (root: string) => Order[]
  jobBehavior?: (request: RelayRequest, events: JobEvents) => Promise<void>
  /** 담당 연결의 `stop()` 이 불릴 때 — 붙잡아 둔 주문을 풀어 준다. */
  jobStop?: () => void
}

/** 본대화는 한 번만 주문을 떨어뜨리고, 담당은 시험이 정한 방식으로 돈다. */
function control(opts: ControlOptions) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-control-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = mkdtempSync(join(tmpdir(), 'kd-control-ud-'))
  const skill = fakeSkill()
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
  const counters = { mainStops: 0, jobStops: [] as string[] }
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {},
    respond: () => {},
    prepare: async () => {},
    run: async (text, _sessionId, events) => {
      mainRuns.push(text)
      events.session('main-session')
      // 첫 본대화 차례에만 주문을 떨어뜨린다 — 전달 차례는 주문을 만들지 않는다.
      if (mainRuns.length > 1) return
      for (const spec of opts.orders(root)) writeFileSync(join(jobsDir, `${spec.id}.json`), JSON.stringify(spec))
    },
    stop: async () => { counters.mainStops++ }
  }
  const jobConnection = (request: RelayRequest): JobConnection => {
    let stopped = false
    return {
      relayProtocol: 1,
      status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
      login: async () => {},
      respond: () => {},
      run: async () => { throw new Error('담당 연결은 run 이 아니라 runJob 으로만 움직인다') },
      // 러너는 `options.account`(앱 동의 반영본)와 이 값의 지문을 비교한다 — 같은 키 순서로 만든다.
      availability: async () => ({ ...account(request.company), consented: true }),
      runJob: async (_text, events) => {
        jobRuns.push(request.jobId)
        if (opts.jobBehavior) return opts.jobBehavior(request, events)
        events.session(`job-${request.jobId}`)
        writeFileSync(join(request.cwd, 'result.md'), `${request.jobId} result`)
      },
      // 같은 연결에 stop 이 두 번 와도(학생 중단 + 실행 정리) 주문 하나다.
      stop: async () => { if (!stopped) { stopped = true; counters.jobStops.push(request.jobId) }; opts.jobStop?.() }
    }
  }
  const svc = new ChatService({
    skillSource: () => skill, userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    jobConnectionFactory: jobConnection,
    jobAccount: async (company) => account(company),
    jobShellSandboxAvailable: true,
    invalidateHandoff: () => {}
  })
  return {
    svc, root, userData, mainRuns, jobRuns, counters,
    deliveries: () => svc.snapshot(root, 'codex').messages.filter((m) => m.text.startsWith('자료 담당(')),
    store: () => (svc as unknown as { store: () => JobStore }).store()
  }
}

function statusOf(root: string, id: string): string | null {
  try { return JSON.parse(readFileSync(join(root, '.knuaf-gui', 'jobs', `${id}.json`), 'utf8')).status as string }
  catch { return null }
}

function deliveryRecord(userData: string, id: string): { state?: string } | undefined {
  return JSON.parse(readFileSync(join(userData, 'jobs', 'store.json'), 'utf8')).deliveries[id]
}

/** 앱이 강제 종료된 상태의 러너·저장소 — 재시작 뒤 [버리기]·[다시 넘기기] 의 출발점이다. */
function crashState(root: string, userData: string, job: Record<string, unknown>, delivery?: Record<string, unknown>): void {
  mkdirSync(join(userData, 'jobs'), { recursive: true })
  writeFileSync(join(userData, 'jobs', 'jobrunner.json'), JSON.stringify({
    version: 1, proposals: [], delivered: ['job-x'],
    jobs: [{
      rootJobId: 'job-x', root: canonical(root), owner: { id: `codex\0${canonical(root)}`, sessionId: 'main-session', company: 'codex' },
      authorSessionId: 'author', contentHash: 'h', outputs: [], createdAt: '2026-11-09T00:00:00.000Z',
      spec: { schema: 1, id: 'job-x', lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
        contractVersion: 'role-v1', company: 'codex', model: 'gpt-6.1-astra', effort: null },
      ...job
    }]
  }))
  writeFileSync(join(userData, 'jobs', 'store.json'), JSON.stringify({
    version: 1, approvals: {}, consent: {},
    deliveries: delivery ? { 'job-x': { root: canonical(root), ownerId: `codex\0${canonical(root)}`, at: '2026-11-09T00:00:00.000Z', ...delivery } } : {}
  }))
}

// ① [이 담당 멈추기] — 그 주문 하나만 멈춘다. 같은 폴더의 다른 주문·본대화는 그대로다.
test('stopping one job leaves the sibling order and the main conversation alone', async () => {
  const { promise: held, resolve: hold } = Promise.withResolvers<void>()
  const w = control({
    orders: (root) => [order(root, 'job-a', 'research', 'both-high'), order(root, 'job-b', 'research', 'both-high')],
    jobBehavior: async (request, events) => {
      if (request.jobId === 'job-b') {
        events.session('job-b-session')
        writeFileSync(join(request.cwd, 'result.md'), 'b result')
        return
      }
      events.session('job-a-session')
      await held
      writeFileSync(join(request.cwd, 'result.md'), 'a late result')
    },
    jobStop: () => hold()
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '두 개 부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-a'))

  await w.svc.stopJob(w.root, 'job-a')
  expect(statusOf(w.root, 'job-a')).toBe('stopped')
  expect(w.counters.jobStops).toEqual(['job-a'])
  // 본대화도, 같은 폴더의 다른 주문도 멈추지 않는다.
  expect(w.counters.mainStops).toBe(0)
  await until(() => statusOf(w.root, 'job-b') === 'completed')
  await until(() => w.deliveries().length === 1)
  expect(w.deliveries()[0].text).toContain('job-b')
  // 멈춘 주문은 전달되지 않는다 — 앱 claim 자체가 없다.
  expect(deliveryRecord(w.userData, 'job-a')).toBeUndefined()
  expect(deliveryRecord(w.userData, 'job-b')?.state).toBe('done')
  await w.svc.close()
})

// ①-2 화면이 보낸 폴더 값을 믿지 않는다 — 다른 폴더를 대면 그 주문을 건드리지 못한다.
test('a job id from another folder cannot be stopped', async () => {
  const { promise: held, resolve: hold } = Promise.withResolvers<void>()
  const w = control({
    orders: (root) => [order(root, 'job-a', 'research', 'both-high')],
    jobBehavior: async (request, events) => {
      events.session('job-a-session')
      await held
      writeFileSync(join(request.cwd, 'result.md'), 'a result')
    },
    jobStop: () => hold()
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-a'))

  await expect(w.svc.stopJob(join(w.root, '..', 'elsewhere'), 'job-a')).rejects.toThrow('Unknown job')
  await expect(w.svc.stopJob(w.root, 'job-missing')).rejects.toThrow('Unknown job')
  expect(statusOf(w.root, 'job-a')).toBe('running')
  await w.svc.stop(w.root, 'codex')
  expect(w.counters.jobStops).toEqual(['job-a'])
  await w.svc.close()
})

// ② 앱 재시작 줄 [버리기] — `interrupted` 주문만 접는다. 두 번째 누름·다른 상태는 거절한다.
test('discard closes an interrupted job once and refuses anything else', async () => {
  const w = control({ orders: () => [] })
  crashState(w.root, w.userData, { status: 'running' })

  expect(w.svc.discardJob(w.root, 'job-x').status).toBe('stopped')
  expect(statusOf(w.root, 'job-x')).toBe('stopped')
  expect(() => w.svc.discardJob(w.root, 'job-x')).toThrow('Job cannot be discarded')
  expect(() => w.svc.discardJob(join(w.root, '..', 'elsewhere'), 'job-x')).toThrow('Unknown job')
  // 버린 주문은 아무것도 실행하지 않는다.
  expect(w.jobRuns).toEqual([])
  await w.svc.close()
})

// ③ 인증 [나중에] — 인증으로 멈춘 주문만, `auth` 미실행 기록을 한 번 남긴다.
test('auth-later records one not-run line and refuses a job that is not waiting for auth', async () => {
  const w = control({
    usage: 'auth',
    orders: (root) => [order(root, 'job-a', 'research', 'both-high')]
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => statusOf(w.root, 'job-a') === 'auth')

  await w.svc.authLater(w.root, 'job-a')
  const lines = () => w.store().events(w.root).filter((event) => event.kind === 'not-run' && event.reason === 'auth')
  expect(lines()).toHaveLength(1)
  // 두 번 눌러도 기록 줄은 하나다.
  await w.svc.authLater(w.root, 'job-a')
  expect(lines()).toHaveLength(1)

  const done = control({ orders: () => [] })
  crashState(done.root, done.userData, { status: 'completed' })
  await expect(done.svc.authLater(done.root, 'job-x')).rejects.toThrow('Job is not waiting for authentication')
  await done.svc.close()
  await w.svc.close()
})

// ④ [다시 넘기기] — 전달이 **확실히 실패한** 주문만, 학생이 누를 때 한 번.
test('redeliver retries a failed delivery exactly once and never an uncertain one', async () => {
  const w = control({ orders: () => [] })
  crashState(w.root, w.userData, { status: 'completed' }, { state: 'failed' })

  await w.svc.redeliver(w.root, 'job-x')
  expect(w.deliveries()).toHaveLength(1)
  expect(w.deliveries()[0].text).toContain('작업 끝')
  expect(deliveryRecord(w.userData, 'job-x')?.state).toBe('done')
  await expect(w.svc.redeliver(w.root, 'job-x')).rejects.toThrow('Delivery cannot be retried')
  await w.svc.close()

  // 전달 여부가 불확실한 주문은 다시 넘기지 않는다.
  const uncertain = control({ orders: () => [] })
  crashState(uncertain.root, uncertain.userData, { status: 'completed' }, { state: 'uncertain' })
  await expect(uncertain.svc.redeliver(uncertain.root, 'job-x')).rejects.toThrow('Delivery cannot be retried')
  expect(uncertain.deliveries()).toEqual([])
  await uncertain.svc.close()
})

// ⑤ 동의를 거두면 그 회사·그 계정의 대기·진행 주문이 멈춘다. 다른 회사 주문은 그대로다.
test('revoking consent stops that company account jobs and leaves the other company queued', async () => {
  const { promise: held, resolve: hold } = Promise.withResolvers<void>()
  const w = control({
    row: 'claude-high-codex-low',
    orders: (root) => [order(root, 'a-codex', 'writing', 'claude-high-codex-low'), order(root, 'b-claude', 'research', 'claude-high-codex-low')],
    jobBehavior: async (request, events) => {
      events.session(`session-${request.jobId}`)
      if (request.jobId === 'a-codex') await held
      writeFileSync(join(request.cwd, 'result.md'), `${request.jobId} result`)
    },
    jobStop: () => hold()
  })
  w.svc.approvePlan(w.root, planFromRow('claude-high-codex-low'))
  w.svc.setConsent('codex', 'codex-account', true)
  w.svc.setConsent('claude', 'claude-account', true)
  await w.svc.send(w.root, 'codex', '두 개 부탁', 'req-1')
  await until(() => w.jobRuns.includes('a-codex'))
  expect(statusOf(w.root, 'b-claude')).toBe('queued')

  // 다른 계정 id 로 거둔 동의는 이 주문에 닿지 않는다(카드가 고정한 계정 경계).
  w.svc.setConsent('codex', 'codex-other', false)
  await sleep(50)
  expect(statusOf(w.root, 'a-codex')).toBe('running')

  w.svc.setConsent('codex', 'codex-account', false)
  await until(() => statusOf(w.root, 'a-codex') === 'stopped')
  expect(w.counters.jobStops).toEqual(['a-codex'])
  expect(w.counters.jobStops).not.toContain('b-claude')
  // 본대화는 살아 있다 — 동의 철회는 주문만 멈춘다.
  expect(w.counters.mainStops).toBe(0)
  // 다른 회사 주문은 대기 그대로였다가 자기 차례에 돈다.
  await until(() => statusOf(w.root, 'b-claude') === 'completed')
  await until(() => w.deliveries().length === 1)
  expect(w.deliveries()[0].text).toContain('Claude')
  expect(deliveryRecord(w.userData, 'a-codex')).toBeUndefined()
  await w.svc.close()
})
