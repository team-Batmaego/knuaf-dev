import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/main/chat/jobs/store'
import { laneModels, setPlacement, selectDesign, consumePendingDesign, disable, type CardDeps } from '../src/main/lanes/cards'
import { laneInput } from '../src/main/lanes/source'
import type { ExecutionAccount } from '../src/main/chat/jobs/types'
import type { PlacementEntries } from '../src/shared/lanes-ipc'
import { LANE_TABLE, FREE_DS_MODEL, fitEffort } from '../src/shared/lanes'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'placement-'))
  const root = join(base, 'paper'); mkdirSync(root)
  const store = new JobStore(join(base, 'private'))
  const account: ExecutionAccount = {
    accountId: 'student', connected: true, consented: false, usage: 'allowed',
    account: { company: 'codex', accountType: 'chatgpt', models: [
      { model: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'high'] },
      { model: 'gpt-6.1-astra', name: 'Astra', efforts: ['high'] },
      { model: 'gpt-6.1-terra', name: 'Terra', efforts: ['medium', 'high'] },
      { model: 'gpt-6-luna', name: 'Luna', efforts: [] }
    ] }
  }
  const deps: CardDeps = { store, mainCompany: 'codex',
    designChoice: () => ({ model: 'gpt-6.1-sol', effort: 'high' }),
    account: async company => company === 'codex' ? structuredClone(account) : null }
  deps.applyDesign = async () => true
  const entries: PlacementEntries = { research: null, repeat: null, review: null,
    writing: { company: 'codex', model: 'gpt-6-luna', effort: null, how: 'relay' } }
  return { base, root, store, account, deps, entries }
}

test('menu saves without a card or consent, preserves chip design and survives restart', async () => {
  const f = fixture()
  expect(await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })).toEqual({ outcome: 'applied', version: 1 })
  const restored = new JobStore(join(f.base, 'private'))
  expect(restored.approvedPlan(f.root)).toEqual({ ...f.entries,
    design: { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' } })
  expect(restored.placementOrigin(f.root)).toEqual({ kind: 'mine' })
  expect(restored.cards(f.root)).toEqual([])
  expect(restored.consents()).toEqual([])
})

test('recommendation actually changes entries, unavailable free roles go to main, customization marks mine', async () => {
  const f = fixture()
  expect((await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'recommended', rowId: 'codex-high' })).outcome).toBe('applied')
  expect(f.store.approvedPlan(f.root)?.writing?.model).toBe('gpt-6.1-terra')
  expect(f.store.approvedPlan(f.root)?.repeat).toEqual({ company: 'codex', model: null, effort: null, how: 'main' })
  expect(f.store.placementOrigin(f.root)).toEqual({ kind: 'recommended', rowId: 'codex-high' })
  expect((await setPlacement(f.deps, f.root, 1, f.entries, { kind: 'mine' })).outcome).toBe('applied')
  const input = await laneInput({ ...f.deps, runner: null }, f.root)
  expect(input.settings.source.kind).toBe('mine')
  expect(input.settings.differsFromRecommendation).toBe(true)
  expect(input.settings.consents).toEqual([])
})

for (const [model, effort, reason] of [
  ['missing', null, 'model-not-listed'], ['gpt-6-luna', 'high', 'effort-not-supported'],
  ['other/gpt-6-luna', null, 'cross-provider']
] as const) test(`invalid placement ${reason} leaves every role unchanged`, async () => {
  const f = fixture()
  f.entries.writing = { company: 'codex', model, effort, how: 'relay' }
  expect(await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })).toEqual({ outcome: 'rejected', rejected: [{ lane: 'writing', reason }] })
  expect(f.store.approvedPlan(f.root)).toBeNull()
  expect(f.store.versionOf(f.root)).toBe(0)
})

test('two simultaneous saves of one version cannot overwrite one another', async () => {
  const f = fixture()
  const results = await Promise.all([0, 1].map(() => setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })))
  expect(results).toEqual([{ outcome: 'applied', version: 1 }, { outcome: 'invalid', reason: 'base-version' }])
})

test('fresh account changes and A usage gate block placement without approval', async () => {
  const f = fixture()
  f.deps.freshAccount = async () => ({ ...f.account, accountId: 'other-student' })
  expect(await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })).toEqual({ outcome: 'invalid', reason: 'account-changed' })
  f.deps.freshAccount = async () => ({ ...f.account, usage: 'unknown' })
  await expect(setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })).rejects.toThrow('나눠 맡길 수')
  expect(f.store.approvedPlan(f.root)).toBeNull()
})

test('catalog exposes only observed per-model efforts and refuses API accounts', async () => {
  const f = fixture()
  expect(await laneModels(f.deps)).toEqual({ groups: [{ company: 'codex', models: f.account.account.models }], failed: [] })
  if (f.account.account.company === 'codex') f.account.account.accountType = 'apiKey'
  expect(await laneModels(f.deps)).toEqual({ groups: [], failed: [] })
})
test('catalog refresh bypasses stale account results', async () => {
  const f = fixture()
  const stale = { ...f.account, connected: false }
  f.deps.account = async company => company === 'codex' ? stale : null
  f.deps.freshAccount = async company => company === 'codex' ? f.account : null
  expect(await laneModels(f.deps)).toEqual({ groups: [], failed: [] })
  expect(await laneModels(f.deps, { fresh: true })).toEqual({ groups: [{ company: 'codex', models: f.account.account.models }], failed: [] })
})

test('connected account with an unavailable catalog reports failure, disconnected does not', async () => {
  const f = fixture()
  const unavailable: ExecutionAccount = { ...f.account, account: { ...f.account.account, models: null } }
  f.deps.account = async company => company === 'codex' ? unavailable : null
  expect(await laneModels(f.deps)).toEqual({ groups: [], failed: ['codex'] })
  unavailable.connected = false
  expect(await laneModels(f.deps)).toEqual({ groups: [], failed: [] })
})


test('approved eight recommendation model assignments match product decision', () => {
  const expected = [
    ['codex-low', 'terra', FREE_DS_MODEL, 'luna', FREE_DS_MODEL, 'terra'],
    ['codex-high', 'sol', 'astra', 'terra', FREE_DS_MODEL, 'astra'],
    ['claude-low', 'sonnet', FREE_DS_MODEL, 'sonnet', FREE_DS_MODEL, 'sonnet'],
    ['claude-high', 'opus', FREE_DS_MODEL, 'sonnet', FREE_DS_MODEL, 'opus'],
    ['both-high', 'opus', 'astra', 'terra', FREE_DS_MODEL, 'astra'],
    ['claude-high-codex-low', 'opus', 'terra', 'luna', FREE_DS_MODEL, 'opus'],
    ['claude-low-codex-high', 'sol', 'astra', 'terra', FREE_DS_MODEL, 'sonnet'],
    ['both-low', 'sonnet', 'terra', 'luna', FREE_DS_MODEL, 'terra']
  ] as const
  for (const [id, ...models] of expected) {
    expect(['design', 'research', 'writing', 'repeat', 'review'].map(lane => LANE_TABLE[id].lanes[lane].model)).toEqual(models)
    expect(LANE_TABLE[id].label).toContain('플랜')
  }
})

test('cross-company recommendation reserves design through restart without changing current chip', async () => {
  const f = fixture()
  const original = f.deps.account
  f.deps.account = async company => company === 'claude' ? {
    accountId: 'claude-student', connected: true, consented: false, usage: 'allowed',
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [
      { model: 'opus', name: 'Opus', efforts: ['high'] }, { model: 'sonnet', name: 'Sonnet', efforts: ['high'] }
    ] }
  } : original(company)
  expect((await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'recommended', rowId: 'both-high' })).outcome).toBe('applied')
  const restored = new JobStore(join(f.base, 'private'))
  expect(restored.pendingDesign(f.root)).toEqual({ company: 'claude', model: 'opus', effort: 'high', how: 'main' })
  expect(restored.approvedPlan(f.root)?.design?.company).toBe('codex')
  const input = await laneInput({ ...f.deps, store: restored, runner: null }, f.root)
  expect(input.settings.nextDesignCompany).toBe('claude')
})

test('opening the reserved company applies the choice once, failures retain reservation', async () => {
  const f = fixture()
  const entry = { company: 'claude' as const, model: 'opus', effort: 'high', how: 'main' as const }
  f.store.setPendingDesign(f.root, entry)
  const applied: unknown[] = []
  await consumePendingDesign(f.store, f.root, 'codex', async value => { applied.push(value) })
  expect(applied).toEqual([])
  await expect(consumePendingDesign(f.store, f.root, 'claude', async () => { throw new Error('model unavailable') })).rejects.toThrow('model unavailable')
  expect(f.store.pendingDesign(f.root)).toEqual(entry)
  await consumePendingDesign(f.store, f.root, 'claude', async value => { applied.push(value) })
  await consumePendingDesign(f.store, f.root, 'claude', async value => { applied.push(value) })
  expect(applied).toEqual([entry])
  expect(f.store.pendingDesign(f.root)).toBeNull()
})

test('manual chip selection replaces cross-company reservation and same-company selection clears it', async () => {
  const f = fixture()
  const original = f.deps.account
  f.deps.account = async company => company === 'claude' ? {
    accountId: 'claude-student', connected: true, consented: false, usage: 'allowed',
    account: { company: 'claude', apiKeySource: 'none', subscriptionType: 'max', models: [
      { model: 'opus', name: 'Opus', efforts: ['high'] }, { model: 'sonnet', name: 'Sonnet', efforts: ['high'] }
    ] }
  } : original(company)
  await selectDesign(f.deps, f.root, { company: 'claude', model: 'opus', effort: 'high', how: 'main' })
  await selectDesign(f.deps, f.root, { company: 'claude', model: 'sonnet', effort: 'high', how: 'main' })
  expect(f.store.pendingDesign(f.root)).toEqual({ company: 'claude', model: 'sonnet', effort: 'high', how: 'main' })
  const input = await laneInput({ ...f.deps, runner: null }, f.root)
  expect(input.settings.pendingDesign).toMatchObject({ company: 'claude', model: 'sonnet', effort: 'high' })
  await selectDesign(f.deps, f.root, { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'main' })
  expect(f.store.pendingDesign(f.root)).toBeNull()
})

test('Team off still exposes account recommendation and enables that exact row', async () => {
  const f = fixture()
  await disable(f.deps, f.root)
  const off = await laneInput({ ...f.deps, runner: null }, f.root)
  expect(off.settings).toMatchObject({ mode: 'off', source: { kind: 'none' }, recommendedRowId: 'codex-high' })
  expect((await setPlacement(f.deps, f.root, f.store.versionOf(f.root), f.entries,
    { kind: 'recommended', rowId: off.settings.recommendedRowId! })).outcome).toBe('applied')
  expect(f.store.placementOrigin(f.root)).toEqual({ kind: 'recommended', rowId: 'codex-high' })
  f.deps.account = async () => null
  const disconnected = await laneInput({ ...f.deps, runner: null }, f.root)
  expect(disconnected.settings.recommendedRowId).toBeNull()
})

test('D-CODE-01 snapshot rows roundtrip accepts displayed main assignees when only writing changes', async () => {
  const f = fixture()
  f.entries.research = { company: 'codex', model: null, effort: null, how: 'main' }
  expect((await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'mine' })).outcome).toBe('applied')
  expect((await setPlacement(f.deps, f.root, 1, f.entries, { kind: 'recommended', rowId: 'codex-high' })).outcome).toBe('applied')
  const input = await laneInput({ ...f.deps, runner: null }, f.root)
  const entries = Object.fromEntries(input.settings.rows.map(row => [row.lane, row.entry])) as PlacementEntries
  expect(entries.repeat).toMatchObject({ how: 'main', model: 'gpt-6.1-sol', effort: 'high' })
  entries.writing = { company: 'codex', model: 'gpt-6-luna', effort: null, how: 'relay' }
  expect(await setPlacement(f.deps, f.root, 2, entries, { kind: 'mine' })).toEqual({ outcome: 'applied', version: 3 })
  expect(f.store.approvedPlan(f.root)?.repeat).toEqual({ company: 'codex', model: null, effort: null, how: 'main' })
  expect(f.store.approvedPlan(f.root)?.writing).toEqual(entries.writing)
})

for (const [current, supported, expected] of [
  ['high', ['low', 'high'], 'high'],
  ['xhigh', ['high', 'low', 'medium'], 'high'],
  ['low', ['high', 'medium'], 'medium'],
  ['max', [], null],
  [null, ['high'], null]
] as const) test(`D-CODE-02 effort fit ${current} into ${supported.join(',')}`, () => {
  expect(fitEffort(current, supported)).toBe(expected)
})

for (const [current, supported, expected] of [
  ['high', ['low', 'high'], 'high'], ['xhigh', ['low', 'high'], 'high'], ['high', [], null]
] as const) test(`D-CODE-02 recommended main keeps or fits ${current} to ${expected}`, async () => {
  const f = fixture()
  if (f.account.account.models) f.account.account.models[0].efforts = [...supported]
  f.deps.designChoice = () => ({ model: 'gpt-6.1-sol', effort: current })
  const applied: unknown[] = []
  f.deps.applyDesign = async (_root, entry) => { applied.push(entry); return true }
  expect((await setPlacement(f.deps, f.root, 0, f.entries, { kind: 'recommended', rowId: 'codex-high' })).outcome).toBe('applied')
  expect(applied).toEqual([{ company: 'codex', model: 'gpt-6.1-sol', effort: expected, how: 'main' }])
  expect(f.store.approvedPlan(f.root)?.design?.effort).toBe(expected)
})
