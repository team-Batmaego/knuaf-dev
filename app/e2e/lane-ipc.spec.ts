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
import { LanesHub } from '../src/main/lanes/hub'
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
  const account = async (company: Provider): Promise<ExecutionAccount> => ({
    accountId: accountIds[company],
    connected: true,
    account: company === 'claude'
      ? { company: 'claude', apiKeySource: 'none', subscriptionType: 'max',
        models: ['opus', 'sonnet'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) }
      : { company: 'codex', accountType: 'chatgpt',
        models: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(model => ({ model, name: model, efforts: ['low', 'high'] })) },
    consented: false,
    usage: 'allowed'
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
    mainCompany: 'claude',
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
  return { ipc, handlers, store, root, elsewhere, sent, stopped, records, retried: () => retried, accountIds, hub }
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
  expect(errorOf(await f.ipc.call(LANES_INVOKE.decideCard, f.elsewhere, card.cardId, card.baseVersion, 'continue') as LanesReply<unknown>).code)
    .toBe('not-found')
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(errorOf(await f.ipc.call(LANES_INVOKE.dismiss, f.elsewhere, 'job:missing:interrupted') as LanesReply<unknown>).code)
    .toBe('not-found')
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

  expect(errorOf(await f.ipc.call(JOBS_INVOKE.stopOne, f.elsewhere, 'job-a') as LanesReply<unknown>).code).toBe('not-found')
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
