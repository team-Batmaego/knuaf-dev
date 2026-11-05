import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHandoffBundle, ConversationHandoff, type HandoffSource } from '../src/main/chat/jobs/conversation'
import { planFromRow } from '../src/shared/lanes'
import type { ConversationOwner, ExecutionAccount } from '../src/main/chat/jobs/types'

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'knuaf-handoff-'))
  const account: ExecutionAccount = { connected: true, consented: false, usage: 'allowed', accountId: 'codex-subscription',
    account: { company: 'codex', accountType: 'chatgpt', models: [{ model: 'gpt-6.1-sol', name: 'Sol', efforts: ['high'] }] } }
  const source: HandoffSource = {
    rootConversationId: 'root', owner: { id: 'old', sessionId: 'old-session', company: 'claude' }, root: '/thesis',
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'main' }, reason: 'limit',
    students: [{ text: 'earliest student', attachments: [{ name: 'source.pdf', hash: 'attachment-hash' }] }, { text: 'latest student', attachments: [] }],
    lastAssistant: { text: 'last AI response', interrupted: true }, beforeHashes: { 'project.json': 'before', removed: 'old' },
    afterHashes: { 'project.json': 'after', added: 'new' }, approvedPlan: planFromRow('both-high'),
    jobs: [{ id: 'running-job', status: 'running', delivered: false }, { id: 'old-job', status: 'completed', delivered: true }],
    skillVersion: 'skill-v1', sourceLocation: '/private/old-chat.json'
  }
  const opened: { id: string; firstMessage: string }[] = [], activated: object[] = [], transfers: object[] = [], audits: object[] = []
  let readAccount = async () => structuredClone(account)
  const options = {
    stateDir, maxBytes: 10_000, account: async () => readAccount(),
    open: async (request: { id: string; firstMessage: string }) => { opened.push(request); return { id: request.id, sessionId: 'new-session', company: 'codex' } as ConversationOwner },
    activate: async (oldOwner: ConversationOwner, newOwner: ConversationOwner) => { activated.push({ oldOwner, newOwner }) },
    transferJobs: async (root: string, owner: ConversationOwner) => { transfers.push({ root, owner }) }, audit: (record: object) => { audits.push(record) }
  }
  return { source, account, options, opened, activated, transfers, audits, handoff: new ConversationHandoff(options),
    readAccount: (fn: typeof readAccount) => { readAccount = fn } }
}

test('main confirmed limit proposes design model without relay consent, opens one fresh packet and transfers jobs', async () => {
  const f = fixture(), originalPlan = structuredClone(f.source.approvedPlan)
  const p = (await f.handoff.propose(f.source))!
  expect(p.entry).toEqual({ company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' })
  const bundle = JSON.parse(readFileSync(p.bundlePath, 'utf8'))
  expect(bundle.students).toEqual(f.source.students)
  expect(bundle.lastAssistant).toEqual({ text: 'last AI response', interrupted: true })
  expect(bundle.changedFiles).toEqual([{ path: 'added', before: null, after: 'new' }, { path: 'project.json', before: 'before', after: 'after' }, { path: 'removed', before: 'old', after: null }])
  expect(bundle.jobs).toEqual(f.source.jobs); expect(bundle.skillVersion).toBe('skill-v1')
  const results = await Promise.all([f.handoff.continue(p.proposalId), f.handoff.continue(p.proposalId)])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(f.opened).toHaveLength(1); expect(f.activated).toHaveLength(1)
  expect(f.transfers).toEqual([{ root: '/thesis', owner: results.find(Boolean) }])
  expect(f.source.approvedPlan).toEqual(originalPlan)
  expect(f.audits).toMatchObject([{ reason: 'limit', bundleHash: p.bundleHash, newConversationId: p.newConversationId }])
  expect(f.opened[0].firstMessage).toContain('자동 재전송하거나 이미 한 작업을 반복하지 말고')
})

for (const reason of ['unknown', 'auth'] as const) test(`main ${reason} never offers continuation`, async () => {
  const f = fixture(); f.source.reason = reason
  expect(await f.handoff.propose(f.source)).toBeNull(); expect(f.opened).toEqual([])
})

test('mechanical packet shrinks in documented order and keeps full archive reference and immutable metadata', () => {
  const f = fixture()
  f.source.students[0].text = 'OLD'.repeat(5000)
  f.source.students[1].text = 'NEW'.repeat(5000)
  f.source.lastAssistant!.text = 'BEGIN' + 'middle'.repeat(3000) + 'END'
  const bundle = buildHandoffBundle(f.source, '/private/archive.json', 1600)!
  expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(1600)
  expect(bundle.students).toEqual([])
  expect(bundle.truncated).toEqual(['students', 'lastAssistant'])
  expect(bundle.lastAssistant!.text.startsWith('BEGIN')).toBe(true)
  expect(bundle.lastAssistant!.text.endsWith('END')).toBe(true)
  expect(bundle.lastAssistant!.interrupted).toBe(true)
  expect(bundle.archive).toBe('/private/archive.json'); expect(bundle.sourceLocation).toBe('/private/old-chat.json'); expect(bundle.skillVersion).toBe('skill-v1')
  expect(buildHandoffBundle(f.source, '/private/archive.json', 50)).toBeNull()
})

test('oversize packet does not open a new conversation; full archive remains', async () => {
  const f = fixture(); f.options.maxBytes = 10
  await expect(f.handoff.propose(f.source)).rejects.toThrow('너무 길어')
  expect(f.opened).toEqual([])
})

test('account change invalidates displayed choice and refreshes; packet modification blocks opening', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  f.account.accountId = 'replacement'
  expect(await f.handoff.continue(p.proposalId)).toBeNull()
  const replacement = f.handoff.proposals()[0]
  expect(replacement.accountId).toBe('replacement'); expect(f.opened).toEqual([])
  writeFileSync(replacement.bundlePath, 'changed')
  await expect(f.handoff.continue(replacement.proposalId)).rejects.toThrow('묶음이 바뀌었어요')
  expect(f.opened).toEqual([])
})

test('later/stop/switch and restart invalidate stale clicks and in-flight lookup', async () => {
  const f = fixture(), p = (await f.handoff.propose(f.source))!
  const { promise, resolve } = Promise.withResolvers<ExecutionAccount>()
  f.readAccount(() => promise)
  const click = f.handoff.continue(p.proposalId); f.handoff.invalidate('root'); resolve(f.account)
  expect(await click).toBeNull(); expect(f.opened).toEqual([])
  f.readAccount(async () => structuredClone(f.account))
  const next = (await f.handoff.propose(f.source))!
  const restarted = new ConversationHandoff(f.options)
  expect(await restarted.continue(next.proposalId)).toBeNull(); expect(restarted.proposals()).toEqual([])
})

test('unsupported depth resets explicitly to default and auth or API path cannot continue', async () => {
  const f = fixture(); f.source.entry.effort = 'ultra'
  expect((await f.handoff.propose(f.source))!.entry.effort).toBeNull()
  const g = fixture(); g.account.account = { company: 'codex', accountType: 'apiKey', models: g.account.account.models }
  expect(await g.handoff.propose(g.source)).toBeNull()
})
