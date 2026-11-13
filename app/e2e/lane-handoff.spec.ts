// 배선 C §4 — 본대화 인계(제안 → 줄 → 넘기기 → 보관 대화)와 [이번만] 차례 끝.
// 실제 AI 호출 0회: 본대화는 가짜 연결, 넘기기는 가짜 이음매(또는 진짜 `ConversationHandoff`).
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import { ConversationHandoff, type ConversationProposal, type HandoffSource } from '../src/main/chat/jobs/conversation'
import { JobStore } from '../src/main/chat/jobs/store'
import { canonical } from '../src/main/chat/jobs/isolation'
import { handoffLines } from '../src/main/lanes/handoff'
import { skillSource, skillVersion } from '../src/main/agent'
import type { AgentConnection } from '../src/main/chat/contracts'
import type { ExecutionAccount } from '../src/main/chat/jobs/types'
import type { LanePlan } from '../src/shared/lanes'
import { planFromRow } from '../src/shared/lanes'

function proposal(patch: Partial<ConversationProposal> = {}): ConversationProposal {
  return {
    proposalId: 'p1',
    rootConversationId: 'claude\0/thesis',
    root: '/thesis',
    oldOwner: { id: 'claude\0/thesis', sessionId: 'old', company: 'claude' },
    newConversationId: 'codex\0/thesis',
    entry: { company: 'codex', model: 'sol', effort: 'high', how: 'relay' },
    from: { company: 'claude', model: 'opus', effort: null },
    accountId: 'codex-account',
    accountFingerprint: 'f',
    bundleHash: 'h',
    bundlePath: '/private/bundle.json',
    archivePath: '/private/archive.json',
    tooLong: false,
    trimmed: false,
    state: 'open',
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

// ② §3 [이번만] — **[C1-04 덜어냄]** v0.7은 이 배치를 쓰지 않는다(DESIGN-C0b 부록 A).
// 예전 시험 `a temporary plan survives live jobs and ends once with afterFirst` ·
// `a temporary plan over an approved one ends with afterFirst false` ·
// `a temporary plan is cleared at the end of the bound student turn` 은 지웠다 — 지키던 사실
// (차례 끝에 접힌다)이 v0.7에 없는 경로의 것이고, 남은 위험은 반대쪽(잔여 배치가 주문을 연다)이다.
test('fix C1-04: a leftover temporary plan never opens an order on its own', () => {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-temp-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const store = new JobStore(join(base, 'jobs'))
  // 예전 판이 남긴 [이번만] 배치를 그대로 심는다(옛 store.json 이 그대로 읽힌다).
  store.setTemporary(root, planFromRow('both-high'), 'next-student-turn')

  // 승인 배치가 없으면 주문 판정에 쓰는 배치는 **없다** — 임시 배치가 대신 열지 않는다.
  expect(store.effectivePlan(root)).toBeNull()

  // 승인 배치가 있으면 그것만 쓴다.
  store.approve(root, planFromRow('codex-high'))
  expect(store.effectivePlan(root)?.design?.model).toBe('sol')
  expect(store.effectivePlan(root)).toEqual(planFromRow('codex-high'))
  store.clearTemporary(root)
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
    account: { propose: async () => structuredClone(account), click: async () => structuredClone(account) },
    open: async (request: { id: string }) => ({ id: request.id, sessionId: `s-${request.id}`, company: 'codex' as const, firstTurn: 'ok' as const }),
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
    account: { propose: () => gate.promise, click: () => gate.promise }
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
function serviceFixture(options: {
  proposals?: unknown[]
  main?: Partial<AgentConnection>
  proposeResult?: (source: HandoffSource) => ConversationProposal | null
} = {}) {
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
  })]) as ConversationProposal[]

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
    stop: async () => {},
    ...options.main
  }
  // 넘기기는 실제 경로 그대로 — 인계 이음매의 `open` 이 서비스의 새 대화 열기를 부른다.
  let svc: ChatService
  /** 서비스가 이음매에 건넨 실패 당시 사실 — 제안이 실제로 무엇으로 판정됐는지 본다. */
  const sources: HandoffSource[] = []
  const seam = {
    visible: () => structuredClone(proposals as never),
    propose: async (source: HandoffSource) => {
      sources.push(source)
      const made = options.proposeResult?.(source) as ReturnType<typeof proposal> | undefined
      if (made) proposals.push(made)
      return made ?? null
    },
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
  return { svc, root, userData, mainRuns, proposals, seam, plan, emitted, sources }
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
  // §1-4 ② — 돌려주는 값에 첫 턴 결과가 붙는다(`ok` 일 때만 소유를 넘긴다).
  expect(owner).toEqual({ id: 'claude\0' + f.root, sessionId: 'session-2', company: 'claude', firstTurn: 'ok' })
  const opened = f.svc.snapshot(f.root, 'claude')
  expect(opened.messages.map(message => message.text)).toEqual(['앞 대화를 이어 받았어요'])

  // 넘기지 못하면 대화 칸은 넘기기 전 기록으로 돌아간다.
  await f.svc.closeHandoff(owner)
  expect(f.svc.snapshot(f.root, 'claude').messages.map(message => message.text)).toEqual(['예전 학생 글'])
})

// [C1-09] 파일이 **있는데** 읽지 못하면 새 대화로 덮지 않고 인계를 실패로 멈춘다(fail-closed).
// 고침을 빼면(`readChat` 의 `catch { return null }`) 빈 대화가 publish 되고 디스크 기록이 덮인다.
test('fix C1-09: a handoff never overwrites a chat file it could not read', async () => {
  const f = serviceFixture({ proposals: [] })
  // 정상 차례 한 번으로 디스크에 대화 파일을 만든 뒤, 그 파일을 **깨진 JSON** 으로 바꾼다.
  await f.svc.send(f.root, 'claude', '읽지 못할 기록', 'req-1')
  const file = join(f.root, '.knuaf-gui', 'chat-claude.json')
  expect(readFileSync(file, 'utf8')).toContain('읽지 못할 기록')
  const broken = '{"provider":"claude","messages":[' // 잘린 JSON — parseChat 이 던진다
  writeFileSync(file, broken)
  // 앱을 다시 켠 상태 — 메모리 스냅샷이 없어 `openHandoff` 가 디스크를 읽는다.
  // (재시작을 흉내 낼 통로는 이 비공개 맵뿐이라 시험에서만 직접 비운다.)
  const memory = f.svc as unknown as { snapshots: Map<string, unknown> }
  memory.snapshots.clear()

  const controller = new AbortController()
  await expect(f.svc.openHandoff({
    id: 'claude\0' + f.root, root: f.root,
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'main' },
    firstMessage: '앞 대화를 이어 받았어요',
    bundlePath: '/private/bundle.json', signal: controller.signal
  })).rejects.toThrow()
  // 이전 기록 파일은 **한 바이트도 바뀌지 않는다** — 빈 새 대화로 덮지 않았다.
  expect(readFileSync(file, 'utf8')).toBe(broken)
})

// [C1-04 덜어냄] 예전 시험 `a temporary plan is cleared at the end of the bound student turn` 은
// 지웠다. 잠그던 것은 이제 없는 경로(차례 끝 접기)이고, 이 자리에서 확인할 사실은 **차례를
// 보내도 잔여 임시 배치가 주문 판정에 끼지 않는다**는 것이다.
test('fix C1-04: ending a student turn never revives a leftover temporary plan', async () => {
  const f = serviceFixture({ proposals: [] })
  const store = (f.svc as unknown as { store: () => JobStore }).store()
  store.setTemporary(f.root, planFromRow('codex-high'), 'next-student-turn')
  await f.svc.send(f.root, 'claude', '차례 하나', 'req-1')
  expect(f.svc.snapshot(f.root, 'claude').messages.some(message => message.text === '차례 하나')).toBe(true)
  // 차례가 끝나도 판정은 승인 배치만 본다.
  expect(store.effectivePlan(f.root)).toBeNull()
  expect(store.events(f.root).map(event => event.kind)).not.toContain('once-ended')
  store.clearTemporary(f.root)
})
