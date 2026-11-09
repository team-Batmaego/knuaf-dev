import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppUpdates } from '../src/main/update/appService'
import type { OpenStore } from '../src/main/update/appStore'
import { parseApp, releasePage, verifyApp } from '../src/main/update/appManifest'
import type { Transport } from '../src/main/update/network'

const vector = JSON.parse(readFileSync(resolve(__dirname, '../scripts/tests/fixtures/app-signature-vector.json'), 'utf8'))
const channel = vector.expectedChannel
const publicKeys: string[] = vector.publicKeys
const originalEnvelope = channel.app['win32-x64']
const openStore: OpenStore = async () => ({
  request: async command => command.op === 'read' ? null : null,
  close: async () => {}
})

async function checkChannel(document: unknown) {
  const userData = mkdtempSync(join(tmpdir(), 'knuaf-app-vector-'))
  try {
    const fetch: Transport = async () => new Response(JSON.stringify(document), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
    const updates = new AppUpdates({
      userData,
      current: '0.5.1',
      platform: 'win32',
      arch: 'x64',
      config: { channel: 'https://updates.example.invalid/channel.json', keys: publicKeys, development: true },
      fetch,
      handoff: { run: async () => {} },
      startInstaller: async () => {},
      quit: () => {},
      openExternal: async () => {},
      openStore
    })
    return await updates.check()
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
}

test('the signed vector passes the production app parser, verifier, and channel check', async () => {
  const parsed = parseApp(originalEnvelope, publicKeys)
  expect(verifyApp(originalEnvelope, publicKeys, '0.5.1').manifest).toEqual(parsed.manifest)
  expect(parsed.manifest.version).toBe(channel.app.latest)
  expect(channel.app.page).toBe(releasePage(channel.app.latest))
  const status = await checkChannel(channel)
  expect(status.phase).toBe('available')
  expect(status.latest).toBe('0.6.1')
})

test('one changed manifest byte and mismatched envelope URL/version are rejected by the production verifier', async () => {
  const manifest = Buffer.from(originalEnvelope.manifest, 'base64')
  manifest[vector.mutation.offset] ^= vector.mutation.xor
  const changedBytes = { ...channel, app: { ...channel.app, 'win32-x64': { ...originalEnvelope, manifest: manifest.toString('base64') } } }
  expect(() => verifyApp(changedBytes.app['win32-x64'], publicKeys, '0.5.1')).toThrow()
  expect((await checkChannel(changedBytes)).phase).toBe('error')
  expect(() => parseApp({ ...originalEnvelope, url: `${originalEnvelope.url}.other` }, publicKeys)).toThrow()
  expect(() => parseApp({ ...originalEnvelope, version: '0.6.2' }, publicKeys)).toThrow()
})

test('channel version and release page must agree with the verified manifest', async () => {
  const wrongPage = { ...channel, app: { ...channel.app, page: releasePage('0.6.0') } }
  expect((await checkChannel(wrongPage)).phase).toBe('error')
  const wrongVersion = { ...channel, app: { ...channel.app, latest: '0.6.0', page: releasePage('0.6.0') } }
  expect((await checkChannel(wrongVersion)).phase).toBe('error')
})
