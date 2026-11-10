// 배선 C §4 — 본대화 인계(제안 → 줄 → 넘기기 → 보관 대화)와 [이번만] 차례 끝.
// 실제 AI 호출 0회: 본대화는 가짜 연결, 넘기기는 가짜 이음매(또는 진짜 `ConversationHandoff`).
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { ConversationHandoff, type HandoffSource } from '../src/main/chat/jobs/conversation'
import { JobStore } from '../src/main/chat/jobs/store'
import { canonical } from '../src/main/chat/jobs/isolation'
import { handoffLines } from '../src/main/lanes/handoff'
import { settleTemporary } from '../src/main/lanes/temporary'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { ConversationOwner, ExecutionAccount, JobRecord } from '../src/main/chat/jobs/types'
import type { LanePlan } from '../src/shared/lanes'
import { planFromRow } from '../src/shared/lanes'

async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('시험이 기다리던 상태에 이르지 못했어요')
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  }
}

function proposal(patch: Record<string, unknown> = {}) {
  return {
    proposalId: 'p1',
    rootConversationId: 'claude\0/thesis',
    root: '/thesis',
    oldOwner: { id: 'claude\0/thesis', sessionId: 'old', company: 'claude' as const },
    newConversationId: 'codex\0/thesis',
    entry: { company: 'codex' as const, model: 'sol', effort: 'high', how: 'relay' as const },
    from: { company: 'claude' as const, model: 'opus', effort: null },
    accountId: 'codex-account',
    accountFingerprint: 'f',
    bundleHash: 'h',
    bundlePath: '/private/bundle.json',
    archivePath: '/private/archive.json',
    tooLong: false,
    trimmed: false,
    state: 'open' as const,
    shownAt: '2026-11-10T00:00:00.000Z',
    ...patch
  }
}

// ① §4-1 제안 상태 → 계약 줄. 폴더가 다른 제안은 섞이지 않는다.
test('handoff lines mirror proposal state and never leak another folder', () => {
  const lines = handoffLines('/thesis', [
    proposal(),
    proposal({ proposalId: 'p2', state: 'running', clickedAt: '2026-11-10T00:05:00.000Z' }),
    proposal({ proposalId: 'p3', state: 'failed', clickedAt: '2026-11-10T00:06:00.000Z' }),
    proposal({ proposalId: 'p4', state: 'consumed' }),
    proposal({ proposalId: 'p5', state: 'discarded' }),
    proposal({ proposalId: 'p6', root: '/other' })
  ] as never)
  expect(lines.map(line => line.kind)).toEqual(['main-limit-offer', 'handoff-running', 'handoff-failed'])
  expect(lines[0]).toMatchObject({
    id: 'handoff:p1', tier: 2, at: '2026-11-10T00:00:00.000Z', dismissible: false,
    proposalId: 'p1', to: { company: 'codex', model: 'sol', effort: 'high' }, tooLong: false, trimmed: false
  })
  expect(lines[1]).toMatchObject({ kind: 'handoff-running', tier: 3, dismissible: false })
  expect(lines[2]).toMatchObject({ kind: 'handoff-failed', proposalId: 'p3', tier: 2 })
})

test('a handoff without a bundle offers [새 대화로 시작] and reports the trim', () => {
  const [line] = handoffLines('/thesis', [
    proposal({ tooLong: true, trimmed: true, bundleHash: null, bundlePath: null })
  ] as never)
  expect(line).toMatchObject({ kind: 'main-limit-offer', tooLong: true, trimmed: true })
})

// ② §3 [이번만] 차례 끝 — 그 차례 주문이 살아 있는 동안은 유지, 끝나면 한 번만 접는다.
test('a temporary plan survives live jobs and ends once with afterFirst', () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-temp-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  store.setTemporary(root, planFromRow('both-high'), 'next-student-turn')

  const job = (status: JobRecord['status']): JobRecord => ({
    spec: {
      schema: 1, id: `j-${status}`, lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
      contractVersion: 'role-v1', company: 'codex', model: 'astra', effort: null
    },
    rootJobId: `j-${status}`, root: canonical(root), owner: { id: `codex\0${canonical(root)}`, sessionId: 's', company: 'codex' },
    authorSessionId: 'a', status, contentHash: 'h', outputs: [], createdAt: '2026-11-10T00:00:00.000Z'
  })

  expect(settleTemporary(store, [job('running')], root)).toBe(false)
  expect(store.temporary(root)).not.toBeNull()
  expect(settleTemporary(store, [job('completed')], root)).toBe(true)
  expect(store.temporary(root)).toBeNull()
  expect(store.events(root).map(event => event.kind)).toEqual(['once-ended'])
  // 처음 카드였으니 승인 배치가 없다 — 화면은 "다음에 나눠 맡길 때 다시 물어봐요".
  expect(store.events(root)[0]).toMatchObject({ kind: 'once-ended', afterFirst: true })
  // 두 번째는 기록도 늘리지 않는다.
  expect(settleTemporary(store, [], root)).toBe(false)
  expect(store.events(root)).toHaveLength(1)
})

test('a temporary plan over an approved one ends with afterFirst false', () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-temp2-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  store.approve(root, planFromRow('both-high'))
  store.setTemporary(root, planFromRow('codex-high'), 'next-student-turn')
  // 주문 판정은 [이번만]이 이긴다 — 승인 기록은 그대로다.
  expect(store.effectivePlan(root)?.design?.model).toBe('sol')
  expect(settleTemporary(store, [], root)).toBe(true)
  expect(store.effectivePlan(root)?.design?.model).toBe('opus')
  expect(store.events(root)[0]).toMatchObject({ kind: 'once-ended', afterFirst: false })
})

// ③ §4-2 보관 대화 — 넘긴 제안만 읽히고, 넘기지 못한 제안은 보관이 아니다.
function handoffFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'kd-handoff-'))
  const account: ExecutionAccount = {
    accountId: 'codex-subscription', connected: true, consented: false, usage: 'allowed',
    account: {
      company: 'codex', accountType: 'chatgpt',
      models: [{ model: 'gpt-6.1-sol', name: 'Sol', efforts: ['high'] }]
    }
  }
  const source: HandoffSource = {
    rootConversationId: 'claude\0/thesis',
    owner: { id: 'claude\0/thesis', sessionId: 'old-session', company: 'claude' },
    root: '/thesis',
    entry: { company: 'claude', model: 'opus', effort: null, how: 'main' },
    reason: 'limit',
    students: [{ text: '첫 학생 글', attachments: [] }, { text: '마지막 학생 글', attachments: [] }],
    lastAssistant: { text: '마지막 답', interrupted: true },
    startedAt: '2026-11-10T00:00:00.000Z',
    stoppedAt: '2026-11-10T01:00:00.000Z',
    beforeHashes: {}, afterHashes: {},
    approvedPlan: planFromRow('both-high'),
    jobs: [], skillVersion: 'v1', sourceLocation: '/private/chat.json'
  }
  const options = {
    stateDir, maxBytes: 10_000,
    account: async () => structuredClone(account),
    open: async (request: { id: string }) => ({ id: request.id, sessionId: `s-${request.id}`, company: 'codex' }),
    close: async () => {},
    prepareActivation: async () => () => {},
    beginTransition: () => ({ ready: async () => {}, commit: () => true, cancel: () => {}, flush: async () => {} }),
    audit: () => {},
    mintId: (root: string, company: 'claude' | 'codex') => `${company}\0${root}`
  }
  return { handoff: new ConversationHandoff(options), options, source }
}

test('archives list only conversations that were actually continued, and read-only history', async () => {
  const f = handoffFixture()
  expect(f.handoff.archives('/thesis')).toEqual([])
  const p = (await f.handoff.propose(f.source))!
  expect(p.tooLong).toBe(false)
  expect(p.trimmed).toBe(false)
  // 넘기기 전에는 보관이 없다 — 보관은 성공한 인계의 결과다.
  expect(f.handoff.archives('/thesis')).toEqual([])

  const owner = await f.handoff.continue(p.proposalId)
  expect(owner?.id).toBe('codex\0/thesis')
  const summaries = f.handoff.archives('/thesis')
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({
    archiveId: p.proposalId, company: 'claude', model: 'opus',
    startedAt: '2026-11-10T00:00:00.000Z', stoppedAt: '2026-11-10T01:00:00.000Z', reason: 'limit',
    successorId: 'codex\0/thesis', successor: { company: 'codex', model: 'gpt-6.1-sol', effort: null }
  })
  const archive = f.handoff.archive('/thesis', p.proposalId)!
  expect(archive.messages.map(message => [message.role, message.text])).toEqual([
    ['user', '첫 학생 글'], ['user', '마지막 학생 글'], ['assistant', '마지막 답']
  ])
  // 다른 폴더에서는 보이지 않는다.
  expect(f.handoff.archives('/other')).toEqual([])
  expect(f.handoff.archive('/other', p.proposalId)).toBeNull()
  // 보관 대화는 새 차례·담당 결과를 받지 않는다 — 읽기 통로뿐이다.
  expect(typeof (f.handoff as unknown as { send?: unknown }).send).toBe('undefined')
})

// ④ [나중에]는 제안을 접고, 폴더 단위 무효화는 잡고 있는 클릭을 버린다.
test('later closes a proposal and folder invalidation aborts an in-flight handoff', async () => {
  const f = handoffFixture()
  const first = (await f.handoff.propose(f.source))!
  expect(f.handoff.later(first.proposalId)).toBe(true)
  expect(f.handoff.later(first.proposalId)).toBe(false)
  expect(f.handoff.visible()).toEqual([])

  const second = (await f.handoff.propose(f.source))!
  const gate = Promise.withResolvers<ExecutionAccount>()
  const slow = new ConversationHandoff({
    ...f.options,
    account: () => gate.promise
  })
  // 앞 제안은 이미 넘긴 것으로 기록돼 다시 열리지 않는다 — 새 인스턴스 상태는 따로다.
  const click = slow.continue(second.proposalId)
  slow.invalidateRoot('/thesis')
  gate.resolve({
    accountId: 'codex-subscription', connected: true, consented: false, usage: 'allowed',
    account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'gpt-6.1-sol', name: 'Sol', efforts: ['high'] }] }
  })
  expect(await click).toBeNull()
})

// ⑤ §4-1 IPC 경로 — 넘긴 뒤에만 `handoff-done` 이 남고, 새 대화가 그 폴더의 대화가 된다.
function serviceFixture(options: { proposals?: unknown[] } = {}) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-handoff-svc-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'project.json'), '{"original":true}')
  const userData = mkdtempSync(join(tmpdir(), 'kd-handoff-ud-'))
  const emitted: { ownerId: string; label: string }[] = []
  const mainRuns: { root: string; text: string }[] = []
  const plan: LanePlan = planFromRow('both-high')
  const proposals = (options.proposals ?? [proposal({
    root, rootConversationId: `claude\0${root}`, oldOwner: { id: `claude\0${root}`, sessionId: 'old', company: 'claude' },
    newConversationId: `codex\0${root}`
  })]) as ReturnType<typeof proposal>[]

  const main: AgentConnection = {
    status: async () => ({ installed: true, connected: true, version: 'fake', detail: '' }),
    login: async () => {},
    respond: () => {},
    prepare: async () => {},
    // [C1-12] 인계는 제안의 모델을 실제 실행에 적용한다 — 그 검증이 쓸 목록을 준다.
    models: async () => [
      { model: 'sol', name: 'Sol', description: '', efforts: ['low', 'high'] },
      { model: 'opus', name: 'Opus', description: '', efforts: ['low', 'high'] }
    ] as never,
    run: async (text, _sessionId, events) => {
      mainRuns.push({ root, text })
      events.session(`session-${mainRuns.length}`)
    },
    stop: async () => {}
  }
  // 넘기기는 실제 경로 그대로 — 인계 이음매의 `open` 이 서비스의 새 대화 열기를 부른다.
  let svc: ChatService
  const seam = {
    visible: () => structuredClone(proposals as never),
    propose: async () => null,
    continue: async (proposalId: string) => {
      const found = proposals.find(entry => entry.proposalId === proposalId)
      if (!found) return null
      return svc.openHandoff({
        id: found.newConversationId, root, entry: found.entry,
        firstMessage: '앞 대화를 이어 받았어요', bundlePath: '/private/bundle.json',
        signal: new AbortController().signal
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
    jobConnectionFactory: () => { throw new Error('담당은 이 시험에서 쓰지 않는다') },
    jobAccount: async () => null,
    jobShellSandboxAvailable: true,
    invalidateHandoff: () => {},
    handoff: seam
  })
  return { svc, root, userData, mainRuns, proposals, seam, plan, emitted }
}

function fakeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-handoff-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '# fake skill\n')
  writeFileSync(join(dir, 'delegation.json'), JSON.stringify({ jobSchema: 1, laneRequestSchema: 1, contractVersion: 'role-v1' }))
  return dir
}

test('handoffContinue switches the conversation, and only then records handoff-done', async () => {
  const f = serviceFixture()
  f.svc.approvePlan(f.root, f.plan)
  await f.svc.send(f.root, 'claude', '앞 대화의 질문', 'req-1')
  expect(f.svc.handoffLines(f.root).map(line => line.kind)).toEqual(['main-limit-offer'])

  await expect(f.svc.handoffContinue(f.root, 'missing')).rejects.toThrow('찾지 못했어요')
  await f.svc.handoffContinue(f.root, 'p1')
  const store = (f.svc as unknown as { store: () => JobStore }).store()
  const events = store.events(f.root)
  expect(events.map(event => event.kind)).toEqual(['handoff-done'])
  expect(events[0]).toMatchObject({
    kind: 'handoff-done',
    from: { company: 'claude', model: 'opus', effort: null },
    to: { company: 'codex', model: 'sol', effort: 'high' },
    archiveId: 'p1'
  })
  // 넘긴 대상 회사(codex)의 대화가 새로 열렸다 — 옛 대화(claude) 기록은 그대로다.
  expect(f.mainRuns).toHaveLength(2)
  expect(f.mainRuns[1].text).toBe('앞 대화를 이어 받았어요')
  expect(f.svc.snapshot(f.root, 'codex').sessionId).toBe('session-2')
  expect(f.svc.snapshot(f.root, 'claude').messages.map(message => message.text)).toEqual(['앞 대화의 질문'])

  // [나중에]는 기록을 남기지 않는다.
  expect(() => f.svc.handoffLater(f.root, 'missing')).toThrow('찾지 못했어요')
  f.svc.handoffLater(f.root, 'p1')
  expect(store.events(f.root)).toHaveLength(1)
})

test('opening a handoff mints the new conversation and closing it restores the old transcript', async () => {
  const f = serviceFixture()
  await f.svc.send(f.root, 'claude', '예전 학생 글', 'req-1')
  const before = f.svc.snapshot(f.root, 'claude')
  expect(before.messages.map(message => message.text)).toEqual(['예전 학생 글'])

  const controller = new AbortController()
  const owner = await f.svc.openHandoff({
    id: 'claude\0' + f.root, root: f.root,
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요',
    bundlePath: '/private/bundle.json', signal: controller.signal
  })
  expect(owner).toEqual({ id: 'claude\0' + f.root, sessionId: 'session-2', company: 'claude' })
  const opened = f.svc.snapshot(f.root, 'claude')
  expect(opened.messages.map(message => message.text)).toEqual(['앞 대화를 이어 받았어요'])

  // 넘기지 못하면 대화 칸은 넘기기 전 기록으로 돌아간다.
  await f.svc.closeHandoff(owner)
  expect(f.svc.snapshot(f.root, 'claude').messages.map(message => message.text)).toEqual(['예전 학생 글'])
})

test('a temporary plan is cleared at the end of the bound student turn', async () => {
  const f = serviceFixture({ proposals: [] })
  const store = (f.svc as unknown as { store: () => JobStore }).store()
  store.setTemporary(f.root, planFromRow('codex-high'), 'next-student-turn')
  await f.svc.send(f.root, 'claude', '차례 하나', 'req-1')
  await until(() => store.temporary(f.root) === null)
  expect(store.events(f.root).map(event => event.kind)).toEqual(['once-ended'])
  expect(f.svc.snapshot(f.root, 'claude').messages.some(message => message.text === '차례 하나')).toBe(true)
})

// [C1-04] 이어 하기 자식이 끝난 부모 `limit` 는 미해결이 아니다 — [이번만]이 다음 차례까지 남지 않는다.
test('fix C1-04: a limit parent whose continuation child completed does not keep the temporary plan', () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-temp-fix-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  store.setTemporary(root, planFromRow('codex-high'), 'next-student-turn')

  const job = (id: string, status: JobRecord['status'], parent?: string): JobRecord => ({
    spec: {
      schema: 1, id, lane: 'research', task: 't', inputs: [], outputs: ['result.md'],
      contractVersion: 'role-v1', company: 'codex', model: 'astra', effort: null,
      ...(parent ? { parent, cause: 'student-continue-after-limit' as const } : {})
    },
    rootJobId: id, root: canonical(root),
    owner: { id: `codex\0${canonical(root)}`, sessionId: 's', company: 'codex' },
    authorSessionId: 'a', status, contentHash: 'h', outputs: [], createdAt: '2026-11-10T00:00:00.000Z'
  })

  // 판정서 재현: 같은 rootJobId 의 limit 부모 + completed 자식.
  expect(settleTemporary(store, [job('p0', 'limit'), job('c0', 'completed', 'p0')], root)).toBe(true)
  expect(store.temporary(root)).toBeNull()
  expect(store.effectivePlan(root)).toBeNull()

  // 이어 받은 자식이 아직 도는 중이면 아직 끝난 것이 아니다.
  store.setTemporary(root, planFromRow('codex-high'), 'next-student-turn')
  expect(settleTemporary(store, [job('p1', 'limit'), job('c1', 'running', 'p1')], root)).toBe(false)
  expect(store.temporary(root)).not.toBeNull()

  // 자식도 한도로 끝났으면 그 일은 아직 안 끝났다.
  expect(settleTemporary(store, [job('p2', 'limit'), job('c2', 'limit', 'p2')], root)).toBe(false)
  expect(store.temporary(root)).not.toBeNull()

  // 이어 하기 없이 과거에 한도로 끝난 주문은 여전히 보수적으로 살아 있는 것으로 센다(C4 에서 차례 id 로 좁힌다).
  expect(settleTemporary(store, [job('p3', 'limit')], root)).toBe(false)
  expect(store.temporary(root)).not.toBeNull()
})
