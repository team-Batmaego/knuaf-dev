import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/main/chat/jobs/store'
import type { LaneCard } from '../src/shared/lanes-ipc'

function dir(): string { return mkdtempSync(join(tmpdir(), 'kd-store-')) }

function card(root: string, cardId: string, baseVersion: number): LaneCard {
  return {
    cardId, root, variant: 'first', baseVersion, createdAt: '2026-11-10T00:00:00.000Z',
    reviewDue: false, quote: null, rows: [], fees: [], fastDrain: false,
    recommendedDesign: null, state: { kind: 'open' }
  }
}

test('store: legacy consent true is read as agreed with no date', () => {
  const d = dir()
  writeFileSync(join(d, 'store.json'), JSON.stringify({
    version: 1, approvals: {}, consent: { 'codex\u0000a': true }, deliveries: {}
  }))
  const store = new JobStore(d)
  const record = store.consent('codex', 'a')
  expect(record).toEqual({ state: 'agreed', at: null })
  expect(store.consented('codex', 'a')).toBe(true)
  store.setConsent('codex', 'a', false)
  const written = JSON.parse(readFileSync(join(d, 'store.json'), 'utf8'))
  expect(written.consent['codex\u0000a'].state).toBe('withdrawn')
  expect(typeof written.consent['codex\u0000a'].at).toBe('string')
  expect(store.consented('codex', 'a')).toBe(false)
})

test('store: a card is consumed once and stale baseVersion is refused', () => {
  const d = dir()
  const root = dir()
  const store = new JobStore(d)
  const version = store.bumpVersion(root)
  store.addCard(card(root, 'c1', version), { codex: 'acct-1' })
  expect(store.beginCard('c1', version - 1)).toMatchObject({ ok: false, reason: 'base-version' })
  const first = store.beginCard('c1', version)
  expect(first.ok).toBe(true)
  expect(store.beginCard('c1', version)).toMatchObject({ ok: false, reason: 'already-handled' })
  const settled = store.settleCard('c1', { kind: 'applied', scope: 'once' })
  expect(settled?.state).toEqual({ kind: 'applied', scope: 'once' })
  expect(store.card('c1')?.boundAccounts).toEqual({ codex: 'acct-1' })
  expect(store.versionOf(root)).toBe(version + 1)
})

test('store: events, delivery text, dismissal and failed redelivery round-trip', () => {
  const d = dir()
  const root = dir()
  const store = new JobStore(d)
  store.addEvent(root, { id: 'e1', at: '2026-11-10T00:00:00.000Z', kind: 'lanes-declined' })
  expect(store.events(root)).toHaveLength(1)
  store.saveDeliveryText('j1', '자료 담당 작업 끝')
  expect(store.deliveryTextOf('j1')).toBe('자료 담당 작업 끝')
  store.dismiss(root, 'line-1')
  expect(store.dismissed(root)).toEqual(['line-1'])
  store.beginDelivery('j1', root, 'owner')
  store.markFailed('j1', root, 'owner')
  expect(store.deliveryState('j1')).toBe('failed')
  expect(store.redeliverAllowed('j1')).toBe(true)
  expect(store.redeliverAllowed('j1')).toBe(false)
  expect(store.deliveryState('j1')).toBe('started')
  store.markUncertain('j1', root, 'owner')
  expect(store.redeliverAllowed('j1')).toBe(false)
  const reopened = new JobStore(d)
  expect(reopened.events(root)).toHaveLength(1)
  expect(reopened.dismissed(root)).toEqual(['line-1'])
  expect(reopened.deliveryTextOf('j1')).toBe('자료 담당 작업 끝')
})
