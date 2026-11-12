// 배선 C §5 IPC 경로 — 실제 `ChatService`·`JobRunner` 를 IPC 핸들러로 부른다(가짜 엔진, AI 호출 0회).
// 시험 계획 WIRING-PLAN §4 C ②(소유권 이전) · ③(계정이 바뀐 옛 전환 요청).
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { ConversationHandoff } from '../src/main/chat/jobs/conversation'
import { JobRunner } from '../src/main/chat/jobs'
import { canonical, sha256 } from '../src/main/chat/jobs/isolation'
import { LanesHub } from '../src/main/lanes/hub'
import { registerLaneHandlers, type LaneIpcChannel } from '../src/main/lanes/handlers'
import type { AgentConnection } from '../src/main/chat/contracts'
import type {
  ConversationOwner, ExecutionAccount, JobConnection, JobEvents, RelayRequest
} from '../src/main/chat/jobs/types'
import type { ConversationProposal } from '../src/main/chat/jobs/conversation'
import type { Provider } from '../src/shared/chat'
import { planFromRow } from '../src/shared/lanes'
import { LANES_INVOKE, JOBS_INVOKE, type LanesReply } from '../src/shared/lanes-ipc'

async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('시험이 기다리던 상태에 이르지 못했어요')
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  }
}

function fakeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-wirec-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '# fake skill\n')
  writeFileSync(join(dir, 'delegation.json'), JSON.stringify({ jobSchema: 1, laneRequestSchema: 1, contractVersion: 'role-v1' }))
  return dir
}

function order(root: string, id: string): Record<string, unknown> & { id: string } {
  const entry = planFromRow('both-high').research!
  return {
    schema: 1, id, lane: 'research', task: 'Read the project and write the result',
    inputs: [{
      sourceId: 'project', path: join(root, 'project.json'),
      hash: sha256(readFileSync(join(root, 'project.json'))), section: 'one'
    }],
    outputs: ['result.md'], contractVersion: 'role-v1',
    company: entry.company, model: entry.model, effort: entry.effort,
    research: {
      research_type: '생산량', questions: [{ id: 'Q1', target: '생산량', acceptance: '공식 통계' }],
      routes: [{ doc: 'research-sources.md', id_or_name: 'KOSIS', url: 'https://kosis.kr/' }],
      keywords: ['생산량'], output_file: 'result.md'
    }
  }
}

function fakeIpc(): LaneIpcChannel & { call(channel: string, ...args: unknown[]): Promise<unknown> } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handle(channel, listener) { handlers.set(channel, listener) },
    call(channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`등록되지 않은 채널: ${channel}`)
      return Promise.resolve(handler({}, ...args))
    }
  }
}

const resultOf = <T,>(reply: LanesReply<T>): T => {
  if ('error' in reply && reply.error) throw new Error(`${reply.error.code}: ${reply.error.message}`)
  return reply.result
}

interface Fixture {
  proposals: ConversationProposal[]
  accountId: { codex: string }
}

function wiring() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-wirec-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = mkdtempSync(join(tmpdir(), 'kd-wirec-ud-'))
  const jobsDir = join(root, '.knuaf-gui', 'jobs')
  mkdirSync(jobsDir, { recursive: true })
  const state: Fixture = { proposals: [], accountId: { codex: 'codex-account' } }
  const mainRuns: { provider: Provider; text: string }[] = []
  const jobRuns: string[] = []
  const delivered: string[] = []
  const held = Promise.withResolvers<void>()
  let releaseHeld: () => void = () => {}
  const gate = Promise.withResolvers<void>()
  releaseHeld = () => gate.resolve()

  const account = (company: Provider): ExecutionAccount => ({
    accountId: company === 'codex' ? state.accountId.codex : 'claude-account',
    connected: true,
    account: company === 'claude'
      ? { company: 'claude', apiKeySource: 'none', subscriptionType: 'max',
        models: ['opus', 'sonnet'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
      : { company: 'codex', accountType: 'chatgpt',
        models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(model => ({
          model, name: model, efforts: ['low', 'high']
        })) },
    consented: false,
    usage: 'allowed'
  })

  let svc: ChatService
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    // [C1-12] 인계가 제안의 모델을 실제 실행에 적용한다 — 그 검증에 쓸 목록.
    models: async () => [
      { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] },
      { model: 'opus', name: 'Opus', description: '', efforts: ['low', 'high'] }
    ] as never,
    run: async (text, _sessionId, events) => {
      mainRuns.push({ provider: 'claude', text })
      events.session('claude-session')
      // 첫 본대화 차례에만 주문 두 개를 떨어뜨린다 — 전달 차례는 만들지 않는다.
      if (mainRuns.length > 1) return
      for (const spec of [order(root, 'job-a'), order(root, 'job-b')]) {
        writeFileSync(join(jobsDir, `${spec.id}.json`), JSON.stringify(spec))
      }
    },
    stop: async () => {}
  }
  const jobConnection = (request: RelayRequest): JobConnection => ({
    relayProtocol: 1,
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {},
    run: async () => { throw new Error('담당 연결은 runJob 으로만 움직인다') },
    availability: async () => ({ ...account(request.company), consented: true }),
    runJob: async (_text, events) => {
      jobRuns.push(request.jobId)
      events.session(`job-${request.jobId}`)
      // job-a 는 붙잡아 둔다 — 그 사이에 소유자가 바뀐다.
      if (request.jobId === 'job-a') await gate.promise
      writeFileSync(join(request.cwd, 'result.md'), 'done')
    },
    stop: async () => { releaseHeld() }
  })

  // 인계 이음매: 넘기기는 실제 서비스의 새 대화 열기를 거친다(앱 연결 그대로).
  const seam = {
    visible: () => structuredClone(state.proposals),
    propose: async () => null,
    continue: async (proposalId: string) => {
      const proposal = state.proposals.find(entry => entry.proposalId === proposalId)
      if (!proposal) return null
      // 계정 지문 대조 — 계정이 바뀌면 넘기지 않는다(옛 제안 거절).
      if (proposal.accountId !== account(proposal.entry.company).accountId) return null
      return svc.openHandoff({
        id: proposal.newConversationId, root,
        entry: proposal.entry,
        firstMessage: '앞 대화를 이어 받았어요',
        bundlePath: proposal.bundlePath!, signal: new AbortController().signal
      })
    },
    later: () => true,
    archives: () => [],
    archive: () => null,
    invalidateRoot: () => {}
  }

  svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    jobConnectionFactory: jobConnection,
    jobAccount: async company => account(company),
    jobShellSandboxAvailable: true,
    invalidateHandoff: () => {},
    handoff: seam
  })

  const ipc = fakeIpc()
  const hub = new LanesHub({
    store: svc.lanesStore(), runner: svc.lanesRunner(), mainCompany: 'claude',
    account: company => svc.laneAccount(company),
    archives: root_ => svc.handoffArchives(root_),
    extraLines: root_ => svc.handoffLines(root_)
  }, () => {})
  registerLaneHandlers({
    ipc, hub,
    store: svc.lanesStore(),
    runner: svc.lanesRunner(),
    account: company => svc.laneAccount(company),
    mainCompany: 'claude',
    allowed: folder => folder === root,
    applyDesign: undefined,
    setConsent: (company, accountId, on) => svc.setConsent(company, accountId, on),
    handoff: {
      continue: (root_, id) => svc.handoffContinue(root_, id),
      later: (root_, id) => svc.handoffLater(root_, id),
      archives: root_ => svc.handoffArchives(root_),
      archive: (root_, id) => svc.handoffArchive(root_, id)
    },
    jobs: {
      stopOne: (root_, id) => svc.stopJob(root_, id),
      continue: (root_, id) => svc.continueProposal(root_, id),
      later: (root_, id) => svc.laterProposal(root_, id),
      retry: (root_, id) => svc.retryJob(root_, id),
      discard: (root_, id) => svc.discardJob(root_, id),
      redeliver: (root_, id) => svc.redeliver(root_, id),
      authLater: (root_, id) => svc.authLater(root_, id),
      deliveryText: (root_, id) => svc.deliveryTextOf(root_, id)
    }
  })

  /** 넘길 제안 — 대상은 codex(설계 회사가 아니라 대화 회사가 바뀐다). */
  const offer = (): void => {
    const proposal = {
      proposalId: 'w1', rootConversationId: `claude\0${root}`, root,
      oldOwner: { id: `claude\0${root}`, sessionId: 'claude-session', company: 'claude' },
      newConversationId: `codex\0${root}`,
      entry: { company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' },
      from: { company: 'claude', model: 'opus', effort: null },
      accountId: state.accountId.codex, accountFingerprint: 'f',
      bundleHash: 'h', bundlePath: '/private/bundle.json', archivePath: '/private/archive.json',
      tooLong: false, trimmed: false, state: 'open',
      shownAt: '2026-11-10T00:00:00.000Z'
    } as unknown as ConversationProposal
    state.proposals.push(proposal)
  }

  return { svc, ipc, root, userData, mainRuns, jobRuns, delivered, state, offer, gate }
}

// ② 소유권 이전 — 새 대화로 넘기면 진행·대기 주문의 owner 가 옮겨지고 결과는 새 대화에만 온다.
test('handing off through IPC moves running and queued job owners and delivers only to the new conversation', async () => {
  const w = wiring()
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'claude', '앞 대화의 부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-a'))
  w.offer()
  const before = JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8'))
  expect(before.owner).toMatchObject({ id: `claude\0${w.root}` })

  resultOf(await w.ipc.call(LANES_INVOKE.handoffContinue, w.root, 'w1') as LanesReply<void>)
  // 넘긴 대상 회사의 새 대화가 이 폴더의 현재 대화다.
  expect(w.svc.snapshot(w.root, 'codex').sessionId).toEqual(expect.any(String))
  const switched = JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8'))
  expect(switched.owner).toMatchObject({ id: `codex\0${w.root}` })
  // 옛 대화 기록은 보관 쪽에 남고 이 폴더의 새 대화가 된다 — 옛 대화에는 결과가 끼지 않는다.
  expect(w.svc.snapshot(w.root, 'claude').messages.map(message => message.text)).toEqual(['앞 대화의 부탁'])

  w.gate.resolve()
  await until(() => w.svc.snapshot(w.root, 'codex').messages.some(message => message.text.startsWith('자료 담당(')))
  const codex = w.svc.snapshot(w.root, 'codex')
  expect(codex.messages.some(message => message.text.startsWith('자료 담당(') && message.text.includes('job-a'))).toBe(true)
  // 두 번째(대기) 주문도 새 대화 소유로 돌고, 결과도 새 대화로만 간다.
  await until(() => w.svc.snapshot(w.root, 'codex').messages.some(message => message.text.includes('job-b')))
  expect(w.svc.snapshot(w.root, 'claude').messages.every(message => !message.text.startsWith('자료 담당('))).toBe(true)
  // `handoff-done` 기록은 한 번뿐이고 넘기기 전 회사를 남긴다.
  const events = w.svc.lanesStore().events(w.root)
  expect(events.filter(event => event.kind === 'handoff-done')).toHaveLength(1)
  expect(events[0]).toMatchObject({
    kind: 'handoff-done',
    from: { company: 'claude', model: 'opus', effort: null },
    to: { company: 'codex', model: 'gpt-6.1-sol', effort: null },
    archiveId: 'w1'
  })
  await w.svc.close()
})

// ③ 계정이 바뀐 뒤 옛 전환 요청 — 넘기지 않고 오류로 돌려주며, 소유자·기록은 그대로다.
test('an old handoff request is refused after the account changed', async () => {
  const w = wiring()
  await w.svc.send(w.root, 'claude', '부탁', 'req-1')
  w.offer()
  w.state.accountId.codex = 'codex-other'
  const reply = await w.ipc.call(LANES_INVOKE.handoffContinue, w.root, 'w1') as LanesReply<void>
  // 계정이 바뀌었으면 넘기지 않는다 — 사유는 `unavailable`(지금은 넘길 수 없다).
  expect('error' in reply && reply.error?.code).toBe('unavailable')
  expect(w.svc.lanesStore().events(w.root)).toEqual([])
  // 옛 제안 id 는 그대로 줄에 남는다 — 화면은 "상황이 바뀌었어요"를 그리고 다시 시도하지 않는다.
  const lines = w.svc.handoffLines(w.root)
  expect(lines.map(line => line.kind)).toEqual(['main-limit-offer'])
  await w.svc.close()
})

// ④ [나중에]는 넘기지 않고 아무 기록도 남기지 않는다 — IPC 경로에서도 그렇다.
test('handoffLater through IPC leaves the transcript and records untouched', async () => {
  const w = wiring()
  await w.svc.send(w.root, 'claude', '부탁', 'req-1')
  w.offer()
  resultOf(await w.ipc.call(LANES_INVOKE.handoffLater, w.root, 'w1') as LanesReply<void>)
  expect(w.svc.lanesStore().events(w.root)).toEqual([])
  expect(w.svc.snapshot(w.root, 'claude').sessionId).toBe('claude-session')
  // 없는 제안은 `not-found`.
  const missing = await w.ipc.call(LANES_INVOKE.handoffLater, w.root, 'nope') as LanesReply<void>
  expect('error' in missing && missing.error?.code).toBe('not-found')
  await w.svc.close()
})

// ⑤ jobs:stop-one 은 IPC 를 거쳐도 그 주문 하나만 멈춘다(다른 주문·본대화 불변).
test('jobs:stop-one stops exactly one job through the handler table', async () => {
  const w = wiring()
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'claude', '부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-a'))
  resultOf(await w.ipc.call(JOBS_INVOKE.stopOne, w.root, 'job-a') as LanesReply<void>)
  const record = JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8'))
  expect(record.status).toBe('stopped')
  expect(w.svc.snapshot(w.root, 'claude').state).not.toBe('stopped')
  await w.svc.close()
})

// ⑥ 동의를 거두면 그 회사 **계정**의 대기·진행 주문이 그 자리에서 멈춘다(계약 §5·§8-8).
test('revoking consent through IPC stops exactly that account\'s live jobs', async () => {
  const w = wiring()
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  await w.svc.send(w.root, 'claude', '부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-a'))

  // 러너는 주문 전에 계정을 고정한다(`record.accountId`). 그 값이 다르면 건드리지 않는다.
  resultOf(await w.ipc.call(LANES_INVOKE.setConsent, 'codex', 'codex-other', false) as LanesReply<unknown>)
  expect(JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8')).status).toBe('running')

  resultOf(await w.ipc.call(LANES_INVOKE.setConsent, 'codex', 'codex-account', false) as LanesReply<unknown>)
  await until(() => JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8')).status === 'stopped')
  // 멈춘 주문의 결과는 넘기지 않는다.
  expect(w.svc.snapshot(w.root, 'claude').messages.some(message => message.text.startsWith('자료 담당('))).toBe(false)
  // 본대화는 그대로다.
  expect(w.svc.snapshot(w.root, 'claude').state).not.toBe('stopped')
  await w.svc.close()
})

// ⑧ 남은 주문 통로 — 없는 제안·주문은 `not-found` 로 접히고 아무것도 바뀌지 않는다.
//   (정상 경로는 `jobs.spec.ts`·`job-control.spec.ts` 가 러너·서비스 수준에서 잠근다.)
test('continue/later/redeliver/authLater refuse unknown ids without touching state', async () => {
  const w = wiring()
  for (const [channel, arg] of [
    [JOBS_INVOKE.continue, 'missing'],
    [JOBS_INVOKE.later, 'missing'],
    [JOBS_INVOKE.redeliver, 'missing'],
    [JOBS_INVOKE.authLater, 'missing']
  ] as const) {
    const reply = await w.ipc.call(channel, w.root, arg) as LanesReply<unknown>
    expect('error' in reply && reply.error?.code).toBe('not-found')
  }
  expect(w.jobRuns).toEqual([])
  expect(w.svc.lanesStore().events(w.root)).toEqual([])
  await w.svc.close()
})

// ⑨ [C1-09] 인계 세션이 **늦게** 열려도 실패하지 않고, 실패하면 이전 기록이 돌아온다.
// 기존 시험의 동기 `session` 대역이 이 경우를 가렸다(판정서 지적) — 여기서는 비동기로 준다.
test('fix C1-09: a handoff whose session arrives late still succeeds', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-late-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-late-ud-'))
  const runs: string[] = []
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    models: async () => [
      { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }
    ] as never,
    // [C1-09] 세션은 턴이 끝난 **뒤에** 온다 — `send` 는 그 전에 돌아간다.
    run: async (_text, _sessionId, events) => {
      runs.push('run')
      await new Promise<void>(resolve => setTimeout(resolve, 60))
      events.session('late-session')
    },
    stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main
  })
  // 이전 기록을 먼저 만든다 — 그 차례가 **끝난 뒤**에 넘긴다(넘기기는 학생 차례 밖에서 온다).
  await svc.send(root, 'codex', '예전 학생 글', 'req-1')
  await until(() => !svc.busy(root))
  expect(svc.snapshot(root, 'codex').messages.map(message => message.text)).toEqual(['예전 학생 글'])
  const owner = await svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: new AbortController().signal
  })
  expect(owner.sessionId).toBe('late-session')
  expect(svc.snapshot(root, 'codex').messages.map(message => message.text)).toEqual(['앞 대화를 이어 받았어요'])
  await svc.close()
})

test('fix C1-09: a handoff that fails to open puts the previous transcript back', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-latefail-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-latefail-ud-'))
  // 세션을 **끝내 주지 않는** 연결 — 실패 경로를 만든다.
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    models: async () => [
      { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }
    ] as never,
    run: async () => {}, stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main
  })
  svc.snapshots.set(svc.key(root, 'codex'), {
    root, provider: 'codex', state: 'idle', sessionId: 'old',
    messages: [{ id: 'm1', role: 'user', text: '예전 학생 글', at: '2026-11-10T00:00:00.000Z' }]
  })
  await expect(svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: new AbortController().signal
  })).rejects.toThrow(/세션/)
  expect(svc.snapshot(root, 'codex').messages.map(message => message.text)).toEqual(['예전 학생 글'])
  await svc.close()
})

// [C1-09] 판정서 재현: 이전 대화가 **디스크에만** 있고 메모리에 없을 때. 예전에는 빈 대화를
// 먼저 publish 해 기존 파일을 덮어썼고, 인계가 실패해도 이전 대화가 돌아오지 않았다.
test('fix C1-09: a disk-only previous transcript survives a failed handoff', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-diskonly-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-diskonly-ud-'))
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    models: async () => [
      { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }
    ] as never,
    // 세션을 주지 않는다 — 인계는 실패하고 되돌리기가 일어나야 한다.
    run: async () => {}, stop: async () => {}
  }
  // 첫 서비스가 대화를 만들어 디스크에 남긴다(그 뒤 서비스는 새로 띄운다 = 재시작).
  const first = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => ({ ...main, run: async (_t, _s, events) => { events.session('old-session') } })
  })
  await first.send(root, 'codex', '예전 학생 글', 'req-1')
  await until(() => !first.busy(root))
  await first.close()

  // 재시작 — 메모리는 비었고 디스크에만 기록이 있다.
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main
  })
  await expect(svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: new AbortController().signal
  })).rejects.toThrow(/세션/)
  // 이전 대화가 돌아온다 — 빈 대화로 덮이지 않았다.
  expect(svc.snapshot(root, 'codex').messages.map(message => message.text)).toEqual(['예전 학생 글'])
  // 디스크에도 그대로다(읽는 새 서비스도 같은 것을 본다).
  await svc.close()
  const third = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main
  })
  expect(third.snapshot(root, 'codex').messages.map(message => message.text)).toEqual(['예전 학생 글'])
  await third.close()
})

// ⑩ [C1-10] 이미 취소된 인계 요청은 세션을 열지 않는다.
test('fix C1-10: an already-aborted handoff request opens nothing', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-abort-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-abort-ud-'))
  const runs: string[] = []
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    models: async () => [
      { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }
    ] as never,
    run: async (_text, _sessionId, events) => { runs.push('run'); events.session('new-session') },
    stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main
  })
  const controller = new AbortController()
  controller.abort()
  await expect(svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: null, how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: controller.signal
  })).rejects.toThrow(/취소/)
  expect(runs).toEqual([])
  await svc.close()
})

// [C1-10] 판정서 재현: 모델 조회를 기다리는 사이 취소하면 **run 이 한 번도 불리지 않는다**.
test('fix C1-10: cancelling while the model lookup is pending never starts the turn', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-cancel-await-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-cancel-await-ud-'))
  const runs: string[] = []
  let releaseModels: () => void = () => {}
  const modelsGate = new Promise<void>(resolve => { releaseModels = resolve })
  const controller = new AbortController()
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    // 목록 조회가 붙잡혀 있는 동안 학생이 취소한다.
    models: async () => {
      await modelsGate
      return [{ model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }] as never
    },
    run: async (_text, _session, events) => { runs.push('run'); events.session('s') },
    stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    modelChoice: () => ({ model: 'gpt-6.1-astra', effort: 'low' }),
    modelChosen: () => true,
    storeModelChoice: () => {}
  })
  const opening = svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: controller.signal
  })
  const settled = opening.catch(error => error as Error)
  // 목록 조회가 실제로 걸려 있는지 확인한 뒤 취소하고, 그 뒤에 조회를 풀어 준다.
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  controller.abort()
  releaseModels()
  const error = await settled
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/취소/)
  // 대기가 끝난 뒤에도 실행은 시작되지 않았다.
  expect(runs).toEqual([])
  await svc.close()
})

// ⑪ [C1-10] 중단·전환은 **실제 제안**을 무효화하고 보관된 대화는 건드리지 않는다.
test('fix C1-10: invalidating a folder drops open proposals but keeps archives', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'kd-inv-'))
  const account: ExecutionAccount = {
    accountId: 'codex-subscription', connected: true, consented: false, usage: 'allowed',
    account: { company: 'codex', accountType: 'chatgpt',
      models: [{ model: 'gpt-6.1-sol', name: 'Sol', efforts: ['high'] }] }
  }
  const source = {
    rootConversationId: 'claude\0/thesis', owner: { id: 'claude\0/thesis', sessionId: 'old', company: 'claude' as const },
    root: '/thesis', entry: { company: 'claude' as const, model: 'opus', effort: null, how: 'main' as const },
    reason: 'limit' as const, students: [{ text: '학생 글', attachments: [] }], lastAssistant: null,
    beforeHashes: {}, afterHashes: {}, approvedPlan: null, jobs: [], skillVersion: 'v1', sourceLocation: '/p'
  }
  const handoff = new ConversationHandoff({
    stateDir, maxBytes: 10_000,
    account: async () => structuredClone(account),
    open: async request => ({ id: request.id, sessionId: `s-${request.id}`, company: 'codex' as const, firstTurn: 'ok' as const }),
    close: async () => {}, prepareActivation: async () => () => {},
    beginTransition: () => ({ ready: async () => {}, commit: () => true, cancel: () => {}, flush: async () => {} }),
    audit: () => {}, mintId: (root, company) => `${company}\0${root}`
  })
  const done = (await handoff.propose(source))!
  await handoff.continue(done.proposalId)
  expect(handoff.archives('/thesis')).toHaveLength(1)

  handoff.invalidate('/thesis')
  // 보관은 그대로 — 무효화가 넘긴 대화를 지우지 않는다.
  expect(handoff.archives('/thesis')).toHaveLength(1)
  expect(handoff.archive('/thesis', done.proposalId)).not.toBeNull()
})

// ⑫ [C1-12] 인계 제안의 모델·깊이가 **실제 실행**에 적용된다(완료 기록만이 아니라).
test('fix C1-12: the proposed model and effort reach the real turn', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-effort-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-effort-ud-'))
  const choices: ({ model: string; effort: string | null } | null)[] = []
  let stored: { model: string; effort: string | null } | null = { model: 'gpt-6.1-astra', effort: 'low' }
  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {}, respond: () => {}, prepare: async () => {},
    models: async () => [
      { model: 'gpt-6.1-astra', name: 'Astra', efforts: ['low', 'high'] },
      { model: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'high'] }
    ].map(model => ({ ...model, description: '' })) as never,
    run: async (_text, _sessionId, events) => { choices.push(stored); events.session('s') },
    stop: async () => {}
  }
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    modelChoice: () => stored,
    modelChosen: () => true,
    storeModelChoice: (_provider, choice) => { stored = choice }
  })
  await svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: new AbortController().signal
  })
  // 실행에 쓰인 선택이 제안과 같다 — 저장된 옛 칩(Astra/low)이 아니다.
  expect(choices).toEqual([{ model: 'gpt-6.1-sol', effort: 'high' }])
  await svc.close()
})

// [C1-12] 판정서 재현: 인계를 준비하는 사이 학생이 칩을 바꿔도, 그 실행은 제안의 모델·깊이로 돈다.
test('fix C1-12: a model change during handoff does not hijack the pinned turn', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-pin-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-pin-ud-'))
  const choices: ({ model: string; effort: string | null } | null)[] = []
  let stored: { model: string; effort: string | null } | null = { model: 'gpt-6.1-astra', effort: 'low' }
  let onRun: (() => void) | null = null
  const svc = new ChatService({
    skillSource: () => fakeSkill(), userData, emit: () => {}, openExternal: async () => {},
    // 실제 연결은 실행 때마다 `options.modelChoice()` 를 다시 읽는다 — 여기서도 그 통로로 본다.
    connectionFactory: (_provider, options): AgentConnection => ({
      status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
      login: async () => {}, respond: () => {}, prepare: async () => {},
      models: async () => [
        { model: 'gpt-6.1-astra', name: 'Astra', description: '', efforts: ['low', 'high'] },
        { model: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: ['low', 'high'] }
      ] as never,
      run: async (_text, _sessionId, events) => {
        // 실행 직전에 다른 카드·설정이 칩을 바꾼다(제안은 이미 승인됐다).
        onRun?.()
        choices.push(options.modelChoice?.() ?? null)
        events.session('s')
      },
      stop: async () => {}
    }),
    modelChoice: () => stored,
    modelChosen: () => true,
    storeModelChoice: (_provider, choice) => { stored = choice }
  })
  // 연결이 만드는 `modelChoice` 는 실행 시점에 불린다 — 그때 바뀐 칩이 아니라 고정값을 봐야 한다.
  onRun = () => { stored = { model: 'gpt-6.1-astra', effort: 'low' } }
  await svc.openHandoff({
    id: `codex\0${root}`, root,
    entry: { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
    signal: new AbortController().signal
  })
  // 실제 턴에 쓰인 값은 제안의 것 — 예전에는 Astra/low 가 전달됐다.
  expect(choices).toEqual([{ model: 'gpt-6.1-sol', effort: 'high' }])
  await svc.close()
})

// ⑬ [C1-11] 소유자 이전 중 공개 주문서 저장이 실패하면 소유자가 부분 커밋되지 않는다.
test('fix C1-11: a failed public manifest write leaves the owner untouched', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-owner-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const stateDir = join(base, 'private')
  const plan = planFromRow('both-high')
  const account: ExecutionAccount = {
    accountId: 'codex-account', connected: true, consented: true, usage: 'allowed',
    account: { company: 'codex', accountType: 'chatgpt',
      models: [{ model: 'gpt-6.1-astra', name: 'astra', efforts: ['high'] }] }
  }
  const owner: ConversationOwner = { id: `claude\0${root}`, sessionId: 'main', company: 'claude' }
  const runner = new JobRunner({
    stateDir, approvedPlan: () => plan, account: async () => structuredClone(account),
    // 주문서(`order()`)는 `role-v1` 로 만든다 — 스킬 선언도 같아야 한다.
    skill: () => ({ path: '/fake', schema: 1, contractVersion: 'role-v1' }), supportedSchemas: [1],
    connectionFactory: (): JobConnection => ({
      relayProtocol: 1,
      status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
      login: async () => {}, respond: () => {}, run: async () => { throw new Error('relay') },
      availability: async () => structuredClone(account),
      runJob: async () => {}, stop: async () => {}
    }),
    deliver: async () => {}, stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: false
  })
  const spec = order(root, 'owner-job')
  runner.enqueue(root, spec as never, owner, 'author')
  // 공개 주문서 쓰기를 실패시킨다 — 원장 영속 전에 예외가 난다.
  const target = join(root, '.knuaf-gui', 'jobs', 'owner-job.json')
  ;(runner as unknown as { publish: (record: unknown) => void }).publish = () => { throw new Error('read-only public manifest') }

  const transition = runner.beginOwnerTransition(root)
  await transition.ready()
  let activated = false
  const next: ConversationOwner = { id: `codex\0${root}`, sessionId: 'new', company: 'codex' }
  expect(() => transition.commit(next, () => { activated = true })).toThrow('read-only public manifest')
  // activate 는 이미 불렸지만 어떤 주문도 새 소유자를 들고 남지 않는다.
  expect(activated).toBe(true)
  expect(runner.records().every(record => record.owner.id === owner.id)).toBe(true)
  expect(readFileSync(target, 'utf8')).toContain(`claude`)
  await transition.flush()
})

// §0-5 6번 — 승인 배치가 없어 `enqueue` 가 거절한 주문이 있으면 **그 차례에 한 번** 시스템 줄.
// 파일은 앱이 지우지 않으므로 다음 차례에도 같은 줄이 한 번 더 나간다("차례마다 1회").
test('no-plan: 차례마다 1회', async () => {
  const w = wiring()
  const systemLines = () =>
    w.svc.snapshot(w.root, 'claude').messages.filter(message => message.role === 'system')
  // 승인 배치를 만들지 않는다 — 주문 2건은 모양이 맞아도 승인 불일치로 거절된다.
  await w.svc.send(w.root, 'claude', '첫 차례', 'req-1')
  await until(() => systemLines().length === 1)
  expect(systemLines().map(message => message.text)).toEqual([
    '작업 분담이 켜져 있지 않아 맡기지 않았어요 — 설정 › 작업 분담에서 켤 수 있어요'
  ])
  expect(w.jobRuns).toEqual([])

  // 두 번째 차례 — 주문 파일은 그대로 남아 있다(앱은 지우지 않는다). 줄이 또 1개 붙는다.
  await w.svc.send(w.root, 'claude', '둘째 차례', 'req-2')
  await until(() => systemLines().length === 2)
  expect(systemLines().map(message => message.text)).toEqual([
    '작업 분담이 켜져 있지 않아 맡기지 않았어요 — 설정 › 작업 분담에서 켤 수 있어요',
    '작업 분담이 켜져 있지 않아 맡기지 않았어요 — 설정 › 작업 분담에서 켤 수 있어요'
  ])
  // 주문 파일은 고치지도 지우지도 않는다.
  expect(JSON.parse(readFileSync(join(w.root, '.knuaf-gui', 'jobs', 'job-a.json'), 'utf8')).id).toBe('job-a')
  expect(w.jobRuns).toEqual([])
  await w.svc.close()
})

test('no-plan: 승인 있으면 0', async () => {
  const w = wiring()
  w.svc.approvePlan(w.root, planFromRow('both-high'))
  w.svc.setConsent('codex', 'codex-account', true)
  w.gate.resolve()
  await w.svc.send(w.root, 'claude', '부탁', 'req-1')
  await until(() => w.jobRuns.includes('job-b'))
  const systemLines = w.svc.snapshot(w.root, 'claude').messages.filter(message => message.role === 'system')
  // 승인 배치가 있으면 안내 줄은 0개다(주문이 실제로 돌아 남는 "자료 담당…" 줄은 별개).
  expect(systemLines.filter(message => message.text.includes('작업 분담이 켜져 있지 않아'))).toEqual([])
  expect(w.jobRuns).toContain('job-a')
  await w.svc.close()
})
