// 배선 B — 주문 수집 → JobRunner → 결과 전달 → 수명 연결.
// 실제 AI 호출 0회: 본대화·담당 연결 모두 가짜다. 시험 계획 B ①·①-2·②·③·④.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { canonical, sha256 } from '../src/main/chat/jobs/isolation'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { ConversationOwner, ExecutionAccount, JobConnection, JobEvents, RelayRequest } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow, resolveLanes } from '../src/shared/lanes'

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
function order(root: string, id: string, lane: 'research' | 'review' | 'writing' = 'research'): Order {
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
  /** 본대화 차례를 붙잡아 두는 시험용 동작 — 기본은 즉시 끝난다. */
  mainBehavior?: (text: string, events: Parameters<AgentConnection['run']>[2]) => Promise<void>
  /** 본대화 연결의 stop 이 불릴 때 — 붙잡아 둔 차례를 풀어 준다. */
  mainStop?: () => void
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
  const counters = { mainStops: 0, jobStops: 0, prepared: 0 }
  /** 각 본대화 차례가 시작될 때까지 `prepare()` 가 몇 번 불렸는가 — 전달 차례의 prepare 확인용. */
  const preparedAtRun: number[] = []
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {},
    respond: () => {},
    prepare: async () => { counters.prepared++ },
    run: async (text, _sessionId, events) => {
      preparedAtRun.push(counters.prepared)
      mainRuns.push(text)
      events.session('main-session')
      if (opts.mainBehavior) return opts.mainBehavior(text, events)
      for (const spec of opts.orders?.(root, text) ?? []) writeFileSync(join(jobsDir, `${spec.id}.json`), JSON.stringify(spec))
    },
    stop: async () => { counters.mainStops++; opts.mainStop?.() }
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
    svc, root, userData, mainRuns, jobRuns, invalidated, counters, preparedAtRun,
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
/** 주문 파일을 본대화 첫 차례에서 한 번만 떨어뜨린다 — 전달 차례는 주문을 만들지 않는다. */
const once = (id: string) => {
  let queued = false
  return (root: string, text: string): Order[] => (queued || text.startsWith('자료 담당') ? [] : (queued = true, [order(root, id)]))
}
function statusOf(root: string, id: string): string | null {
  try { return manifest(root, id).status as string } catch { return null }
}
function deliveryRecord(userData: string, id: string): { state?: string } | undefined {
  return JSON.parse(readFileSync(join(userData, 'jobs', 'store.json'), 'utf8')).deliveries[id]
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

// ⑤ 승인 배치는 `resolveLanes` 가 만든 그대로 받는다 — 본대화가 맡는 차선은 `model: null` 이다.
test('approval accepts a resolved plan whose main-takeover entries carry model: null', async () => {
  const w = wire()
  const { plan } = resolveLanes('both-high', { mainCompany: 'claude', mainLanes: ['repeat'] })
  expect(plan.repeat).toMatchObject({ company: 'claude', model: null, how: 'main' })
  expect(() => w.svc.approvePlan(w.root, plan)).not.toThrow()
  const stored = JSON.parse(readFileSync(join(w.userData, 'jobs', 'store.json'), 'utf8'))
  expect(stored.approvals[canonical(w.root)].repeat).toMatchObject({ model: null, how: 'main' })
  await w.svc.close()
})

// ⑥ 업데이트 정리(closeForUpdate)가 성공한 뒤 그 다음 단계가 실패해 앱이 계속 살면 수집이 돌아온다(R1).
test('a successful update teardown that is later aborted resumes collection', async () => {
  let n = 0
  const w = wire({ orders: (root, text) => (text.startsWith('자료 담당') ? [] : [order(root, `job-${++n}`)]) })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.closeForUpdate(async () => {})
  // handoff.ts:31-43 — closeForUpdate 뒤 assertResourcesIdle/transfer 가 던져도 앱은 계속 산다.
  await w.svc.send(w.root, 'codex', '업데이트 취소 뒤', 'req-1')
  await until(() => w.jobRuns.length === 1 && w.deliveries().length === 1)
  expect(statusOf(w.root, 'job-1')).toBe('completed')
  await w.svc.close()
})

// ⑦ 폴더가 바쁜 동안에는 결과를 잃지 않고 보류한다 — '확인하지 못했어요' 는 시도했지만 모를 때만(R2).
test('a busy folder keeps the delivery pending instead of declaring uncertainty', async () => {
  test.setTimeout(80_000)
  let release: (() => void) | null = null
  const w = wire({
    orders: once('job-one'),
    jobBehavior: async (request, events) => {
      events.session(`job-${request.jobId}`)
      writeFileSync(join(request.cwd, 'result.md'), 'held result')
      release = w.svc.acquire(w.root) // 다른 작업이 폴더를 쥐고 있음
    }
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => release !== null)
  await until(() => deliveryRecord(w.userData, 'job-one')?.state === 'started')
  // 예전에는 30초가 지나면 '넣지 못한 것을 아는데도' uncertain 으로 넘어가 결과를 잃었다.
  await new Promise<void>((resolve) => setTimeout(resolve, 31_000))
  expect(deliveryRecord(w.userData, 'job-one')?.state).toBe('started')
  expect(w.deliveries()).toHaveLength(0)

  release!()
  await until(() => w.deliveries().length === 1)
  await until(() => deliveryRecord(w.userData, 'job-one')?.state === 'done')
  expect(w.deliveries()[0].text).toContain('작업 끝')
  expect(w.svc.snapshot(w.root, 'codex').messages.some((m) => m.text.includes('확인하지 못했어요'))).toBe(false)
  await w.svc.close()
})

// ⑧ 전달 차례가 실패하면 완료로 남기지 않고 '확인하지 못함'으로 드러낸다(R3).
test('a failed delivery turn is not recorded as done', async () => {
  const w = wire({ orders: once('job-one') })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  const conn = (w.svc as any).connection(w.root, 'codex'); const orig = conn.run
  let calls = 0
  conn.run = async (...args: any[]) => { if (++calls === 2) throw new Error('auth gone'); return orig(...args) }
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => w.deliveries().length === 1)
  await until(() => deliveryRecord(w.userData, 'job-one')?.state === 'uncertain')
  const s = w.svc.snapshot(w.root, 'codex')
  expect(s.state).toBe('error')
  expect(s.error).toContain('auth gone')
  expect(deliveryRecord(w.userData, 'job-one')?.state).not.toBe('done')
  await w.svc.close()
})

// ⑨ 전달 차례 도중 학생이 멈추면 오류가 아니라 '중단'이다(R5).
test('student stop during the delivery turn marks it stopped', async () => {
  const w = wire({ orders: once('job-one') })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  const conn = (w.svc as any).connection(w.root, 'codex'); const orig = conn.run
  let calls = 0
  let rejectRun: (error: Error) => void = () => {}
  conn.run = async (...args: any[]) => {
    if (++calls === 2) return new Promise<void>((_resolve, reject) => { rejectRun = reject })
    return orig(...args)
  }
  const origStop = conn.stop
  conn.stop = async () => { rejectRun(new Error('stopped')); return origStop() }
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => calls === 2)
  await w.svc.stop(w.root, 'codex')
  const s = w.svc.snapshot(w.root, 'codex')
  expect(s.state).toBe('stopped')
  expect(s.error).toBeUndefined()
  await w.svc.close()
})

// ⑩ 심링크 아래 폴더(iCloud 데스크톱 모양)에서도 담당이 부르는 canonical root 로 본대화가 멈춘다.
test('a non-canonical root still stops its main turn', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-wire-link-')))
  mkdirSync(join(base, 'real'))
  writeFileSync(join(base, 'real', 'project.json'), '{"original":true}')
  symlinkSync(join(base, 'real'), join(base, 'link'))
  const root = join(base, 'link')
  let release: (error: Error) => void = () => {}
  let started = false
  const w = wire({
    root,
    mainBehavior: async () => { started = true; return new Promise<void>((_resolve, reject) => { release = reject }) },
    mainStop: () => release(new Error('stopped'))
  })
  w.svc.approvePlan(root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(root, 'codex', '오래 걸리는 부탁', 'req-1')
  await until(() => started)

  // 담당이 부르는 `stopMain` 은 canonical root 를 넘긴다(JobRunner owner.id). 학생이 연 폴더가
  // 심링크면 같은 폴더가 두 이름으로 갈린다 — 지도 키가 이름에 따라 갈리면 이 중단이 빗나간다.
  await w.svc.stop(join(base, 'real'), 'codex')
  expect(w.counters.mainStops).toBeGreaterThanOrEqual(1)
  expect(w.svc.snapshot(root, 'codex').state).toBe('stopped')
  expect(w.svc.snapshot(root, 'codex').error).toBeUndefined()
  await w.svc.close()
})

// ⑪ 전달 차례도 send 와 같은 계약으로 prepare() 를 먼저 부른다.
test('the delivery turn calls prepare before run', async () => {
  const w = wire({ orders: once('job-one') })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => w.deliveries().length === 1 && !w.svc.busy(w.root))
  expect(w.mainRuns).toHaveLength(2)
  expect(w.preparedAtRun[0]).toBe(1)
  expect(w.preparedAtRun[1]).toBe(2)
  await w.svc.close()
})

// ⑫ 다른 폴더의 같은 주문 번호는 조용히 버리지 않고 이 폴더 대화에 한 번 알린다(진단).
test('a duplicate job id from another folder is refused with a visible notice', async () => {
  const ud = mkdtempSync(join(tmpdir(), 'kd-wire-ud-'))
  const skill = fakeSkill()
  const a = wire({ userData: ud, skill, orders: once('job-one') })
  a.svc.approvePlan(a.root, planFromRow('both-high'))
  a.svc.setConsent('codex', 'codex-account', true)
  await a.svc.send(a.root, 'codex', 'A', 'r1')
  await until(() => a.deliveries().length === 1 && !a.svc.busy(a.root))

  const b2 = canonical(mkdtempSync(join(tmpdir(), 'kd-wire-b-')))
  const rootB = join(b2, 'thesis')
  mkdirSync(rootB); writeFileSync(join(rootB, 'project.json'), '{}')
  mkdirSync(join(rootB, '.knuaf-gui', 'jobs'), { recursive: true })
  writeFileSync(join(rootB, '.knuaf-gui', 'jobs', 'job-one.json'), JSON.stringify(order(rootB, 'job-one')))
  a.svc.approvePlan(rootB, planFromRow('both-high'))
  await a.svc.send(rootB, 'codex', 'B', 'r2')
  await until(() => a.svc.snapshot(rootB, 'codex').messages.some((m) => m.text.includes('이미 접수한 번호')))
  expect(a.jobRuns).toEqual(['job-one'])
  expect(manifest(rootB, 'job-one').status).toBeUndefined()
  await a.svc.close()
})

// ⑬ 학생이 멈추면 보류해 둔 전달도 따라 멈춘다 — 잠시 뒤 타이머가 몰래 넣지 않는다.
test('student stop discards a parked delivery instead of inserting it later', async () => {
  let release: (() => void) | null = null
  const w = wire({
    orders: once('job-one'),
    jobBehavior: async (request, events) => {
      events.session(`job-${request.jobId}`)
      writeFileSync(join(request.cwd, 'result.md'), 'held result')
      release = w.svc.acquire(w.root)
    }
  })
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'codex', '부탁', 'req-1')
  await until(() => release !== null)
  await until(() => deliveryRecord(w.userData, 'job-one')?.state === 'started')

  await w.svc.stop(w.root, 'codex')
  release!()
  await new Promise<void>((resolve) => setTimeout(resolve, 2_500))
  expect(w.deliveries()).toHaveLength(0)
  expect(deliveryRecord(w.userData, 'job-one')?.state).toBe('done')
  expect((w.svc as any).pendingDeliveries.size).toBe(0)
  await w.svc.close()
})
