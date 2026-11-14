// 배선 C §5 — IPC 22 요청 + 1 밀어 보내기. Electron 을 띄우지 않고 같은 함수를 직접 부른다
// (핸들러는 `ipcMain.handle` 에 **계약 채널 이름 그대로** 등록된다). 실제 AI 호출 0회.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/main/chat/jobs/store'
import { JobRunner } from '../src/main/chat/jobs'
import { canonical } from '../src/main/chat/jobs/isolation'
import { registerLaneHandlers, type LaneIpcChannel } from '../src/main/lanes/handlers'
import { LanesHub, connectChanges } from '../src/main/lanes/hub'
import type { JobRecord, ExecutionAccount, JobConnection, RelayRequest } from '../src/main/chat/jobs/types'
import type { Provider } from '../src/shared/chat'
import { planFromRow } from '../src/shared/lanes'
import {
  JOBS_INVOKE, LANES_INVOKE, LANES_PUSH, type LanesReply
} from '../src/shared/lanes-ipc'

function fakeIpc(): LaneIpcChannel & { channels: string[]; call(channel: string, ...args: unknown[]): Promise<unknown> } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const channels: string[] = []
  return {
    channels,
    handle(channel, listener) { channels.push(channel); handlers.set(channel, listener) },
    call(channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`등록되지 않은 채널: ${channel}`)
      return Promise.resolve(handler({}, ...args))
    }
  }
}

function fixture() {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-ipc-')))
  const root = join(base, 'thesis')
  const elsewhere = join(base, 'other')
  mkdirSync(root, { recursive: true }); mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = mkdtempSync(join(tmpdir(), 'kd-ipc-ud-'))
  const store = new JobStore(join(userData, 'jobs'))
  const accountIds: Record<Provider, string> = { claude: 'claude-account-id', codex: 'codex-account-id' }
  /**
   * [C1-07] 캐시된 A 와 실제 B 를 갈라 놓기 위한 손잡이.
   * `cached` 는 15초 캐시가 돌려주는 값, `observed` 는 캐시를 건너뛴 관측이다.
   */
  const state = {
    observed: {
      claude: { connected: true, usable: true },
      codex: { connected: true, usable: true }
    } as Record<Provider, { connected: boolean; usable: boolean }>,
    /** 지금 관측되는 계정 id — 처음에는 로그인한 계정과 같다. */
    observedId: { ...accountIds } as Record<Provider, string>
  }
  const snapshotOf = (company: Provider, accountId: string, usable: boolean): ExecutionAccount => ({
    accountId,
    connected: true,
    account: company === 'claude'
      ? {
        company: 'claude', apiKeySource: usable ? 'none' : 'ANTHROPIC_API_KEY', subscriptionType: 'max',
        models: ['opus', 'sonnet'].map(model => ({ model, name: model, efforts: ['low', 'high'] }))
      }
      : {
        company: 'codex', accountType: usable ? 'chatgpt' : 'apikey',
        models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(model => ({ model, name: model, efforts: ['low', 'high'] }))
      },
    consented: false,
    usage: 'allowed'
  })
  const account = async (company: Provider): Promise<ExecutionAccount> =>
    snapshotOf(company, accountIds[company], true)
  /** 캐시를 건너뛴 관측 — `state.observed` 를 따른다. */
  const freshAccount = async (company: Provider): Promise<ExecutionAccount> => ({
    ...snapshotOf(company, state.observedId[company], state.observed[company].usable),
    connected: state.observed[company].connected
  })
  const records: JobRecord[] = []
  const stopped: string[] = []
  // 러너 원장에 두 주문을 미리 둔다 — 핸들러의 폴더 대조가 그 기록을 본다.
  const seeded: JobRecord[] = [
    {
      spec: {
        schema: 1, id: 'job-a', lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
        contractVersion: 'role-v1', company: 'codex', model: 'astra', effort: null
      },
      rootJobId: 'job-a', root, owner: { id: `codex\0${root}`, sessionId: 'main', company: 'codex' },
      authorSessionId: 'a', status: 'running', contentHash: 'h', outputs: [], createdAt: '2026-11-10T00:00:00.000Z'
    },
    {
      spec: {
        schema: 1, id: 'job-b', lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
        contractVersion: 'role-v1', company: 'codex', model: 'astra', effort: null
      },
      rootJobId: 'job-b', root, owner: { id: `codex\0${root}`, sessionId: 'main', company: 'codex' },
      authorSessionId: 'a', status: 'interrupted', contentHash: 'h', outputs: [], createdAt: '2026-11-10T00:00:00.000Z'
    }
  ]
  mkdirSync(join(userData, 'runner'), { recursive: true })
  writeFileSync(join(userData, 'runner', 'jobrunner.json'), JSON.stringify({
    version: 1, jobs: seeded, proposals: [], delivered: []
  }))
  const runner = new JobRunner({
    stateDir: join(userData, 'runner'),
    approvedPlan: () => planFromRow('both-high'),
    account,
    skill: () => ({ path: '/fake/skill', schema: 1, contractVersion: 'role-v1' }),
    supportedSchemas: [1],
    connectionFactory: (_request: RelayRequest): JobConnection => ({
      relayProtocol: 1,
      status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
      login: async () => {}, respond: () => {}, run: async () => { throw new Error('relay') },
      availability: async () => account('codex'),
      runJob: async () => {},
      stop: async () => {}
    }),
    deliver: async () => {}, stopMain: async () => {}, diagnostic: () => {}, shellSandboxAvailable: true
  })
  const ipc = fakeIpc()
  const sent: { channel: string; snapshot: unknown }[] = []
  const hub = new LanesHub({
    store, runner,
    mainCompany: 'claude',
    account,
    archives: () => [],
    extraLines: () => []
  }, snapshot => { sent.push({ channel: LANES_PUSH.snapshot, snapshot }) })
  const jobRecord = (id: string, status: JobRecord['status']): JobRecord => ({
    spec: {
      schema: 1, id, lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
      contractVersion: 'role-v1', company: 'codex', model: 'astra', effort: null
    },
    rootJobId: id, root, owner: { id: `codex\0${root}`, sessionId: 'main', company: 'codex' },
    authorSessionId: 'a', status, contentHash: 'h', outputs: [], createdAt: '2026-11-10T00:00:00.000Z'
  })
  let retried = 0
  const handlers = registerLaneHandlers({
    ipc, hub, store, runner,
    account,
    freshAccount,
    mainCompany: 'claude',
    // [C1-08] 허용 폴더 경계 — 이 시험은 한 폴더만 연다.
    allowed: folder => folder === root,
    applyDesign: undefined,
    setConsent: (company, accountId, on) => store.setConsent(company, accountId, on),
    handoff: {
      continue: async () => {}, later: () => {}, archives: () => [], archive: () => null
    },
    jobs: {
      stopOne: async (_root, jobId) => { stopped.push(jobId); records.push(jobRecord(jobId, 'stopped')) },
      continue: async () => {},
      later: async () => {},
      retry: (_root, jobId) => { retried++; records.push(jobRecord(`${jobId}-retry`, 'queued')); return jobRecord(jobId, 'queued') },
      discard: (_root, jobId) => { records.push(jobRecord(jobId, 'stopped')); return jobRecord(jobId, 'stopped') },
      redeliver: async () => {},
      authLater: async () => {},
      deliveryText: (_root, jobId) => store.deliveryTextOf(jobId)
    }
  })
  return { ipc, handlers, store, root, elsewhere, sent, stopped, records, retried: () => retried, accountIds, hub, state }
}

const resultOf = <T,>(reply: LanesReply<T>): T => {
  if ('error' in reply && reply.error) throw new Error(`${reply.error.code}: ${reply.error.message}`)
  return reply.result
}

const errorOf = (reply: LanesReply<unknown>): { code: string; message: string } => {
  if (!('error' in reply) || !reply.error) throw new Error('오류를 기대했어요')
  return reply.error
}

// ① 채널 이름은 계약에서만 온다 — 14 + 8 = 22 요청, 밀어 보내기 1.
test('all 22 channels register under the contract names and push only lanes:changed', () => {
  const f = fixture()
  const expected = [...Object.values(LANES_INVOKE), ...Object.values(JOBS_INVOKE)]
  expect(expected).toHaveLength(22)
  expect(new Set(expected).size).toBe(22)
  expect(f.ipc.channels.slice().sort()).toEqual(expected.slice().sort())
  expect(f.ipc.channels.every(channel => channel.startsWith('lanes:') || channel.startsWith('jobs:'))).toBe(true)
  expect(LANES_PUSH.snapshot).toBe('lanes:changed')
  expect(Object.keys(LANES_INVOKE)).toHaveLength(14)
  expect(Object.keys(JOBS_INVOKE)).toHaveLength(8)
})

// ② snapshot 은 즉시 묶음을 돌려주고, 상태를 바꾼 요청은 끝나면 묶음을 민다.
test('snapshot answers directly; state changes push a fresh lanes:changed bundle', async () => {
  const f = fixture()
  f.sent.length = 0
  const snapshot = resultOf(await f.ipc.call(LANES_INVOKE.snapshot, f.root) as LanesReply<{ root: string | null }>)
  expect(snapshot.root).toBe(f.root)
  // 즉시 응답은 `LanesPublisher` 를 거치므로 한 번 보내진다 — 밀어 보내기와 같은 통로다.
  expect(f.sent.map(entry => entry.channel)).toEqual([LANES_PUSH.snapshot])

  const card = resultOf(await f.ipc.call(
    LANES_INVOKE.settingsCard, f.root, 'enable'
  ) as LanesReply<{ cardId: string; baseVersion: number }>)
  // 설정 카드는 열려 있는 동안 대화 묶음에서 빠진다.
  const afterCard = f.sent.at(-1)!.snapshot as { cards: unknown[] }
  expect(afterCard.cards).toEqual([])

  const decision = resultOf(await f.ipc.call(
    LANES_INVOKE.decideCard, f.root, card.cardId, card.baseVersion, 'continue'
  ) as LanesReply<{ outcome: string }>)
  expect(decision.outcome).toBe('applied')
  expect(f.store.approvedPlan(f.root)).not.toBeNull()
})

// ③ 화면이 보낸 폴더를 믿지 않는다 — 다른 폴더의 카드·줄은 만질 수 없다.
test('requests from another folder are refused without touching state', async () => {
  const f = fixture()
  const card = resultOf(await f.ipc.call(LANES_INVOKE.settingsCard, f.root, 'enable') as LanesReply<{ cardId: string; baseVersion: number }>)
  // [C1-08] 열려 있지 않은 폴더는 폴더 경계에서 먼저 닫힌다(그 전에는 저장소까지 갔다).
  expect(errorOf(await f.ipc.call(LANES_INVOKE.decideCard, f.elsewhere, card.cardId, card.baseVersion, 'continue') as LanesReply<unknown>).code)
    .toBe('no-folder')
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(errorOf(await f.ipc.call(LANES_INVOKE.dismiss, f.elsewhere, 'job:missing:interrupted') as LanesReply<unknown>).code)
    .toBe('no-folder')
  // 폴더가 없으면 `no-folder` — 가짜 성공을 만들지 않는다.
  expect(errorOf(await f.ipc.call(LANES_INVOKE.decideCard, join(f.root, 'nope'), card.cardId, 0, 'continue') as LanesReply<unknown>).code)
    .toBe('no-folder')
})

// ④ [다시 확인]은 아무것도 바꾸지 않고 묶음도 다시 지어 보내지 않는다.
test('cardStatus answers without pushing a new bundle', async () => {
  const f = fixture()
  const card = resultOf(await f.ipc.call(LANES_INVOKE.settingsCard, f.root, 'enable') as LanesReply<{ cardId: string }>)
  f.sent.length = 0
  const status = resultOf(await f.ipc.call(LANES_INVOKE.cardStatus, f.root, card.cardId) as LanesReply<{ outcome: string }>)
  expect(status.outcome).toBe('open')
  expect(f.sent).toEqual([])
})

// ⑤ 동의는 계정 단위 — 화면에 원 계정 id 를 그대로 보내지 않고 가린 표시를 준다.
test('setConsent stores per account and reports a masked label', async () => {
  const f = fixture()
  const row = resultOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'claude', 'claude-account-id', true
  ) as LanesReply<{ accountLabel: string; state: string; subscribed: boolean }>)
  expect(row.state).toBe('agreed')
  expect(row.accountLabel).toBe('claude…')
  expect(row.accountLabel).not.toContain('account-id')
  expect(row.subscribed).toBe(true)
  const rows = resultOf(await f.ipc.call(LANES_INVOKE.consents) as LanesReply<{ accountId: string; state: string }[]>)
  expect(rows.find(entry => entry.accountId === 'claude-account-id')?.state).toBe('agreed')
  // 거두면 저장은 남고 상태만 바뀐다(Q4).
  const withdrawn = resultOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'claude', 'claude-account-id', false
  ) as LanesReply<{ state: string; at: string | null }>)
  expect(withdrawn.state).toBe('withdrawn')
  expect(withdrawn.at).toEqual(expect.any(String))
})

// ⑥ jobs:stop-one / retry / discard / delivery-text — 화면은 id 만 준다.
test('job channels route through the service seams and keep folder guards', async () => {
  const f = fixture()
  f.store.saveDeliveryText('job-a', '자료 담당(ChatGPT·astra·기본) 작업 끝')
  resultOf(await f.ipc.call(JOBS_INVOKE.stopOne, f.root, 'job-a') as LanesReply<void>)
  expect(f.stopped).toEqual(['job-a'])

  resultOf(await f.ipc.call(JOBS_INVOKE.retry, f.root, 'job-a') as LanesReply<void>)
  expect(f.retried()).toBe(1)

  resultOf(await f.ipc.call(JOBS_INVOKE.discard, f.root, 'job-b') as LanesReply<void>)
  // 버린 주문의 줄은 ✕로 숨긴다(계약에 `discarded` 상태가 없다 — U9 보고).
  expect(f.store.dismissed(f.root)).toEqual(expect.arrayContaining(['job:job-b:stopped']))

  const detail = resultOf(await f.ipc.call(JOBS_INVOKE.deliveryText, f.root, 'job-a') as LanesReply<{ text: string | null }>)
  expect(detail.text).toContain('자료 담당')
  // 없는 주문의 원문은 `not-found` — 빈 문자열로 성공을 만들지 않는다.
  expect(errorOf(await f.ipc.call(JOBS_INVOKE.deliveryText, f.root, 'job-none') as LanesReply<unknown>).code).toBe('not-found')

  expect(errorOf(await f.ipc.call(JOBS_INVOKE.stopOne, f.elsewhere, 'job-a') as LanesReply<unknown>).code).toBe('no-folder')
})

// ⑦ 이음매가 없으면 `unavailable` — 가짜 성공을 만들지 않는다.
test('a missing design seam reports unavailable and leaves the card open', async () => {
  const f = fixture()
  const card = resultOf(await f.ipc.call(LANES_INVOKE.settingsCard, f.root, 'enable') as LanesReply<{ cardId: string; baseVersion: number }>)
  // 설정 카드의 추천 배치는 설계 회사를 바꾸지 않으므로 통과한다 — 대신 없는 카드는 `not-found`.
  expect(errorOf(await f.ipc.call(LANES_INVOKE.decideCard, f.root, 'missing', 0, 'continue') as LanesReply<unknown>).code)
    .toBe('not-found')
  // [추천으로 되돌리기]는 승인 배치가 없으면 `not-found`(되돌릴 것이 없다).
  expect(errorOf(await f.ipc.call(LANES_INVOKE.settingsCard, f.root, 'revert') as LanesReply<unknown>).code).toBe('not-found')
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(card.cardId).toEqual(expect.any(String))
})

// ⑧ 동의 거두기는 저장과 응답에 그대로 남는다 — 주문 정지까지의 연결은 `lane-ipc-wiring` 이 본다.
test('revoking consent keeps the record and reports withdrawn through IPC', async () => {
  const f = fixture()
  resultOf(await f.ipc.call(LANES_INVOKE.setConsent, 'codex', 'codex-account-id', true) as LanesReply<{ state: string }>)
  resultOf(await f.ipc.call(LANES_INVOKE.setConsent, 'codex', 'codex-account-id', false) as LanesReply<{ state: string }>)
  const row = resultOf(await f.ipc.call(LANES_INVOKE.consents) as LanesReply<{ accountId: string; state: string }[]>)
  expect(row.find(entry => entry.accountId === 'codex-account-id')?.state).toBe('withdrawn')
  // 동의 기록은 지우지 않는다 — 거둠도 날짜와 함께 남는다(Q4).
  expect(f.store.consent('codex', 'codex-account-id')?.at).toEqual(expect.any(String))
})

// ⑨ 전달 원문은 요청할 때만 나간다 — 묶음(`LanesSnapshot`)에는 원문이 없다.
test('the bundle never carries the delivery text; only the explicit request returns it', async () => {
  const f = fixture()
  f.store.saveDeliveryText('job-a', '자료 담당(ChatGPT·astra·기본) 작업 끝 — 출력 `jobs/job-a/out/result.md`')
  const bundle = resultOf(await f.ipc.call(LANES_INVOKE.snapshot, f.root) as LanesReply<{ events: unknown[]; lines: unknown[] }>)
  expect(JSON.stringify(bundle)).not.toContain('출력 `jobs/job-a/out/result.md`')
  const detail = resultOf(await f.ipc.call(JOBS_INVOKE.deliveryText, f.root, 'job-a') as LanesReply<{ text: string | null }>)
  expect(detail.text).toContain('출력 `jobs/job-a/out/result.md`')
})

// ⑩ [다시 확인]·[나중에] 같은 읽기·무상태 요청은 묶음을 다시 지어 보내지 않는다.
test('read-only requests never push a bundle', async () => {
  const f = fixture()
  f.sent.length = 0
  resultOf(await f.ipc.call(LANES_INVOKE.consents) as LanesReply<unknown[]>)
  resultOf(await f.ipc.call(LANES_INVOKE.reviewModels, f.root) as LanesReply<unknown[]>)
  resultOf(await f.ipc.call(LANES_INVOKE.archives, f.root) as LanesReply<unknown[]>)
  resultOf(await f.ipc.call(JOBS_INVOKE.deliveryText, f.root, 'job-a') as LanesReply<unknown>)
  expect(f.sent).toEqual([])
})

// [C1-08] root 와 주문 id 를 **함께** 바꿔도 다른 폴더의 상태·전달 원문에 닿지 않는다.
test('fix C1-08: a root and job id swapped together never reach another folder', async () => {
  const f = fixture()
  // 그 폴더에 실제 주문이 있고 전달 원문도 있다 — 화면이 그 id 를 알고 있다고 가정한다.
  f.store.saveDeliveryText('other-job', 'raw other-folder delivery')
  const card = resultOf(await f.ipc.call(LANES_INVOKE.settingsCard, f.root, 'enable') as LanesReply<{ cardId: string }>)
  expect(card.cardId).toEqual(expect.any(String))
  for (const [channel, args] of [
    [JOBS_INVOKE.deliveryText, [f.elsewhere, 'other-job']],
    [JOBS_INVOKE.stopOne, [f.elsewhere, 'other-job']],
    [JOBS_INVOKE.discard, [f.elsewhere, 'other-job']],
    [LANES_INVOKE.settingsCard, [f.elsewhere, 'enable']],
    [LANES_INVOKE.snapshot, [f.elsewhere]]
  ] as const) {
    const reply = await f.ipc.call(channel, ...(args as unknown[])) as LanesReply<unknown>
    expect(errorOf(reply).code).toBe('no-folder')
  }
  // 열린 폴더의 저장 상태는 그대로다.
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.deliveryTextOf('other-job')).toContain('raw other-folder')
})

// [C1-15] 전역 동의 변경은 **보이는 폴더를 바꾸지 않는다** — 폴더 없는 알림은 같은 폴더를 다시 짓는다.
test('fix C1-15: a folder-less change never resets the viewed folder', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-hub-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  const sent: { root: string | null; seq: number }[] = []
  const hub = new LanesHub({
    store, runner: null, mainCompany: 'claude', account: async () => null
  }, snapshot => sent.push({ root: snapshot.root, seq: snapshot.seq }))

  await hub.snapshot(root)
  expect(hub.root()).toBe(root)
  // 전역 변경(동의) — 폴더를 모르는 알림.
  hub.nudge()
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  expect(hub.root()).toBe(root)
  expect(sent.map(entry => entry.root)).toEqual([root, root])
  hub.dispose()
})

// [C1-15] 판정서 재현은 **실제 IPC 경로**였다: `setConsent` → `hub.touch(null)` → 구독 root A→null.
// 핸들러를 거쳐 같은 일을 확인한다(push 의 root 가 A 그대로여야 한다).
test('fix C1-15: granting consent through IPC keeps the pushed bundle on the viewed folder', async () => {
  const f = fixture()
  // 화면이 A 폴더를 열어 둔 상태(묶음 요청이 구독 폴더를 정한다).
  resultOf(await f.ipc.call(LANES_INVOKE.snapshot, f.root) as LanesReply<unknown>)
  expect(f.hub.root()).toBe(f.root)
  f.sent.length = 0

  resultOf(await f.ipc.call(LANES_INVOKE.setConsent, 'claude', 'claude-account-id', true) as LanesReply<unknown>)
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  expect(f.hub.root()).toBe(f.root)
  // 폴더 없는 요청이 밀어 보낸 묶음도 A 폴더의 것이다 — 전역 묶음이 아니다.
  expect(f.sent.length).toBeGreaterThan(0)
  expect(f.sent.every(entry => (entry.snapshot as { root: string | null }).root === f.root)).toBe(true)
  f.hub.dispose()
})

// [C1-17] 조립이 느린 옛 폴더의 묶음은 새 폴더 뒤에 보내지 않는다.
test('fix C1-17: a late bundle from the previous folder is not sent', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-hub2-')))
  const a = join(base, 'a'), b = join(base, 'b')
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  const sent: { root: string | null; seq: number }[] = []
  const gate = Promise.withResolvers<void>()
  let first = true
  const hub = new LanesHub({
    store, runner: null, mainCompany: 'claude',
    // A 의 조회만 붙잡는다.
    account: async () => { if (first) { first = false; await gate.promise }; return null }
  }, snapshot => sent.push({ root: snapshot.root, seq: snapshot.seq }))

  const slow = hub.snapshot(a)
  await hub.snapshot(b)
  gate.resolve()
  const late = await slow
  // 늦게 완성된 A 묶음은 **보내지 않는다** — 화면은 B 에 그대로 있다(돌려주는 값은 그대로다).
  expect(late.root).toBe(a)
  expect(sent.map(entry => entry.root)).toEqual([b])
  expect(hub.root()).toBe(b)
  // 이후 변경도 B 만 짓는다.
  hub.nudge()
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  expect(sent.map(entry => entry.root)).toEqual([b, b])
  hub.dispose()
})

// [C1-14] 저장소의 실제 변경이 묶음을 다시 짓게 한다(IPC 요청과 무관하게).
test('fix C1-14: a store change nudges the bundle without any IPC request', async () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-hub3-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  const sent: { events: number }[] = []
  const hub = new LanesHub({
    store, runner: null, mainCompany: 'claude', account: async () => null
  }, snapshot => sent.push({ events: snapshot.events.length }))
  // 배선의 정본 함수를 그대로 쓴다 — `ipc.ts` 도 이 함수를 부른다.
  const disconnect = connectChanges(hub, [store])

  await hub.snapshot(root)
  expect(sent.at(-1)!.events).toBe(0)
  store.addEvent(root, { id: 'e1', at: '2026-11-10T00:00:00.000Z', kind: 'lanes-declined' })
  await new Promise<void>(resolve => setTimeout(resolve, 120))
  expect(sent.at(-1)!.events).toBe(1)
  // 연결을 끊으면 더 이상 밀지 않는다.
  disconnect()
  store.addEvent(root, { id: 'e2', at: '2026-11-10T00:01:00.000Z', kind: 'lanes-declined' })
  await new Promise<void>(resolve => setTimeout(resolve, 120))
  expect(sent.at(-1)!.events).toBe(1)
  hub.dispose()
})

// [C1-01] 회사 문자열은 실행 파일 선택 **전에** 닫힌다 — 계정 조회조차 부르지 않는다.
test('fix C1-01: an unknown company never reaches the account probe', async () => {
  const f = fixture()
  const probed: unknown[] = []
  const ipc = fakeIpc()
  const hub = new LanesHub({
    store: f.store, runner: null, mainCompany: 'claude', account: async () => null
  }, () => {})
  registerLaneHandlers({
    ipc, hub, store: f.store, runner: null,
    account: async company => { probed.push(company); return null },
    allowed: folder => folder === f.root,
    mainCompany: 'claude', applyDesign: undefined,
    setConsent: () => ({ state: 'withdrawn', at: null }),
    handoff: { continue: async () => {}, later: () => {}, archives: () => [], archive: () => null, invalidateRoot: () => {} },
    jobs: {
      stopOne: async () => {}, continue: async () => {}, later: async () => {},
      retry: () => { throw new Error('unused') }, discard: () => { throw new Error('unused') },
      redeliver: async () => {}, authLater: async () => {}, deliveryText: () => null
    }
  })
  for (const company of ['node', '', 'Claude', 'codex\n', '../codex']) {
    const reply = await ipc.call(LANES_INVOKE.pickReview, f.root, company, 'opus') as LanesReply<unknown>
    expect(errorOf(reply).code).toBe('internal')
  }
  // 동의 켜기도 같은 검사를 지난다.
  expect(errorOf(await ipc.call(LANES_INVOKE.setConsent, 'node', 'x', true) as LanesReply<unknown>).code).toBe('internal')
  // 계정 조회(→ 실행 파일 선택)는 한 번도 불리지 않았다.
  expect(probed).toEqual([])
  hub.dispose()
})

// [C1-07] 동의 켜기는 **지금 확인된 계정**에만 — 캐시된 값·미연결·비구독이면 저장하지 않는다.
test('fix C1-07: consent cannot be granted to an account that is not logged in', async () => {
  const f = fixture()
  const reply = await f.ipc.call(LANES_INVOKE.setConsent, 'codex', 'never-seen-account', true) as LanesReply<unknown>
  expect(errorOf(reply).code).toBe('not-found')
  expect(f.store.consent('codex', 'never-seen-account')).toBeNull()
  // 거두기는 과거 계정에도 허용한다 — 지난 동의를 되돌릴 길을 막지 않는다.
  f.store.setConsent('codex', 'past-account', true)
  const revoked = resultOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'codex', 'past-account', false
  ) as LanesReply<{ state: string }>)
  expect(revoked.state).toBe('withdrawn')
})

// [C1-07] 판정서 재현: 캐시는 A, 실제 계정은 B. 예전에는 캐시된 A 의 동의가 저장됐다.
test('fix C1-07: a stale cached account cannot authorize consent for the account that replaced it', async () => {
  const f = fixture()
  // 캐시(account)는 계속 A 를 말하지만, 캐시를 건너뛴 관측은 B 다.
  f.state.observedId.claude = 'replaced-account'
  const bogus = await f.ipc.call(LANES_INVOKE.setConsent, 'claude', 'claude-account-id', true) as LanesReply<unknown>
  expect(errorOf(bogus).code).toBe('not-found')
  expect(f.store.consent('claude', 'claude-account-id')).toBeNull()
  // 새 계정(B)에는 켤 수 있다 — 다만 관측이 그것을 확인해 줄 때만.
  resultOf(await f.ipc.call(LANES_INVOKE.setConsent, 'claude', 'replaced-account', true) as LanesReply<unknown>)
  expect(f.store.consent('claude', 'replaced-account')?.state).toBe('agreed')
})

// [C1-07] 판정서 재현: 연결되지 않았거나 구독이 아닌 경로(API 키)에는 동의가 저장되지 않는다.
test('fix C1-07: consent is refused for a disconnected account and for a non-subscription login', async () => {
  const f = fixture()
  f.state.observed.claude = { connected: false, usable: true }
  expect(errorOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'claude', 'claude-account-id', true
  ) as LanesReply<unknown>).code).toBe('not-found')
  f.state.observed.claude = { connected: true, usable: false }
  expect(errorOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'claude', 'claude-account-id', true
  ) as LanesReply<unknown>).code).toBe('unavailable')
  expect(f.store.consents()).toEqual([])
  // 거두기는 여전히 열려 있다 — 권한을 주는 길만 닫는다.
  f.store.setConsent('claude', 'claude-account-id', true)
  expect(resultOf(await f.ipc.call(
    LANES_INVOKE.setConsent, 'claude', 'claude-account-id', false
  ) as LanesReply<{ state: string }>).state).toBe('withdrawn')
})

// [C1-16] 없는 폴더의 조회는 **응답**(`LanesReply`)으로 돌아온다 — 예외로 IPC 밖에 새지 않는다.
test('fix C1-16: a missing folder on read-only requests answers instead of throwing', async () => {
  const f = fixture()
  for (const channel of [LANES_INVOKE.snapshot, LANES_INVOKE.reviewModels, LANES_INVOKE.archives] as const) {
    const reply = await f.ipc.call(channel, join(f.root, 'absent')) as LanesReply<unknown>
    expect(errorOf(reply).code).toBe('no-folder')
  }
  // 폴더가 아예 없어도 마찬가지다.
  const empty = await f.ipc.call(LANES_INVOKE.snapshot, '') as LanesReply<unknown>
  expect('result' in empty).toBe(true)
})
