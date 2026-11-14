import { expect, test } from '@playwright/test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { ASSET_PREFIX, CHANNEL_URL, compare, MAX_BYTES, sha256, verifySkill, type SkillManifest } from '../src/main/update/manifest'
import { extractSkill } from '../src/main/update/archive'
import { UPDATE_KEYS, updateConfig } from '../src/main/update/keys'
import { boundedFetch, type Transport } from '../src/main/update/network'
import { SkillStore } from '../src/main/update/store'
import { SkillSwitch, skillSwitch } from '../src/main/update/switch'
import { SkillUpdates } from '../src/main/update/service'
import { ChatService } from '../src/main/chat/service'
import { installSkill, setTreeAccess, skillTargets, skillVersion } from '../src/main/agent'
import { launch } from './helpers'

// Ephemeral test-only keys remain in this test process; no private key file is emitted.
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keys = [publicKey]
const roots: string[] = []
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'knuaf-update-test-')); roots.push(root); return root }
test.afterEach(() => { for (const root of roots.splice(0)) { setTreeAccess(root, true); rmSync(root, { recursive: true, force: true }) } })
type Entry = { name: string; data: Buffer; mode?: number; method?: number; claimedSize?: number }
function zipEntries(entries: Entry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.method === 8 ? deflateRawSync(e.data) : e.data
    const local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.claimedSize ?? e.data.length, 22); local.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(e.method ?? 0, 10)
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(e.claimedSize ?? e.data.length, 24); record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((e.mode ?? 0x81a4) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    locals.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
function envelope(m: object, whitespace = false) {
  const bytes = Buffer.from(JSON.stringify(m, null, whitespace ? 2 : undefined) + (whitespace ? '\n' : ''))
  return { manifest: bytes.toString('base64'), sig: sign(null, bytes, pair.privateKey).toString('base64') }
}
function fixture(v = '1.0.1', changes: Partial<SkillManifest> = {}, transform?: (entries: Entry[]) => Entry[]) {
  const entries: Entry[] = [
    { name: 'SKILL.md', data: Buffer.from(`# skill ${v}`), method: 8 },
    { name: 'skill.json', data: Buffer.from(JSON.stringify({ version: v, api: 1, source: { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }, overlay: 'b'.repeat(64) })) },
    { name: 'scripts/example.py', data: Buffer.from(`print('${v}')\n`) }
  ]
  const zip = zipEntries(transform ? transform(entries) : entries)
  const manifest: SkillManifest = { schema: 1, name: 'knuaf-dev', version: v, api: 1, minApp: '0.5.1', url: `${ASSET_PREFIX}skill-v${v}/knuaf-dev-skill-${v}.zip`, size: zip.length, sha256: sha256(zip), files: Object.fromEntries(entries.map(e => [e.name, sha256(e.data)])), ...changes }
  const signed = envelope(manifest)
  return { zip, manifest, signed, verified: () => verifySkill(signed, keys) }
}
function setup(bundleVersion = '1.0.0', useKeys = keys) {
  const root = temporary(), bundled = join(root, 'bundled')
  mkdirSync(join(bundled, 'scripts'), { recursive: true })
  writeFileSync(join(bundled, 'SKILL.md'), `# bundle ${bundleVersion}`)
  writeFileSync(join(bundled, 'scripts', 'example.py'), `print('${bundleVersion}')\n`)
  writeFileSync(join(bundled, 'skill.json'), JSON.stringify({ version: bundleVersion, api: 1 }))
  return { root, bundled, store: new SkillStore(root, bundled, '0.5.1', useKeys) }
}
const config = () => updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })
function updater(store: SkillStore, f = fixture(), restartSidecar: () => Promise<unknown> = async () => {}, lock = new SkillSwitch()) {
  const requests: string[] = []
  const updates = new SkillUpdates(store, { config: config(), lock, restartSidecar, fetch: async url => {
    requests.push(url)
    return new Response(url === CHANNEL_URL ? JSON.stringify({ schema: 1, skill: { ...f.signed, version: f.manifest.version, api: f.manifest.api, minApp: f.manifest.minApp, url: f.manifest.url } }) : f.zip)
  } })
  return { updates, requests }
}

test('missing or invalid S0 metadata never invents a bundled version or initializes an update store', () => {
  const root = temporary(), bundled = join(root, 'bundle')
  mkdirSync(bundled)
  for (const text of [null, '{', '{"version":"invalid","api":1}', '{"version":"1.0.0","api":2}']) {
    if (text !== null) writeFileSync(join(bundled, 'skill.json'), text)
    expect(() => new SkillStore(root, bundled, '0.5.1', keys)).toThrow()
    expect(existsSync(join(root, 'skill-store'))).toBe(false)
  }
  writeFileSync(join(bundled, 'skill.json'), '{"version":"1.0.2","api":1}')
  const store = new SkillStore(root, bundled, '0.5.1', keys)
  expect(() => store.publish(fixture('1.0.1').verified(), fixture('1.0.1').zip)).toThrow()
  expect(store.state().active).toBeNull()
  expect(store.resolveSkillSource()).toBe(bundled)
})
function channelUpdater(store: SkillStore, channel: () => unknown) {
  const requests: string[] = []
  const updates = new SkillUpdates(store, { config: config(), fetch: async url => {
    requests.push(url)
    return new Response(JSON.stringify(channel()))
  }, restartSidecar: async () => {} })
  return { updates, requests }
}
type SkillChannelFixture = { manifest: SkillManifest; signed: { manifest: string; sig: string } }

function channelSkill(f: SkillChannelFixture) {
  return { ...f.signed, version: f.manifest.version, api: f.manifest.api, minApp: f.manifest.minApp, url: f.manifest.url }
}

test('Ed25519 verifies exact bytes, rejects altered bytes, signature, another key and unsigned hint mismatch', () => {
  const f = fixture()
  const formatted = envelope(f.manifest, true)
  expect(verifySkill(formatted, keys).manifest.version).toBe('1.0.1')
  expect(verifySkill(formatted, keys).digest).not.toBe(f.verified().digest)
  const changed = Buffer.from(formatted.manifest, 'base64'); changed[1] ^= 1
  expect(() => verifySkill({ ...formatted, manifest: changed.toString('base64') }, keys)).toThrow(/서명/)
  const bad = Buffer.from(f.signed.sig, 'base64'); bad[0] ^= 1
  expect(() => verifySkill({ ...f.signed, sig: bad.toString('base64') }, keys)).toThrow(/서명/)
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(() => verifySkill(f.signed, [other])).toThrow(/서명/)
  expect(() => verifySkill({ ...f.signed, url: `${ASSET_PREFIX}other/file.zip` }, keys)).toThrow(/달라/)
  expect(() => verifySkill({ ...f.signed, manifest: f.signed.manifest + '\n' }, keys)).toThrow(/인코딩/)
})

for (const changes of [
  { version: '1.0.1-1' }, { version: '01.0.1' }, { version: '9007199254740992.0.1' }, { api: 0 }, { size: MAX_BYTES + 1 },
  { sha256: 'A'.repeat(64) }, { url: `${ASSET_PREFIX}../evil/file.zip` }, { url: 'https://evil.example/file.zip' },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), '../escape': 'c'.repeat(64) } },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), 'scripts/CON.txt': 'c'.repeat(64) } },
  { files: { 'SKILL.md': 'a'.repeat(64), 'skill.json': 'b'.repeat(64), 'skill.JSON': 'c'.repeat(64) } }
]) test(`strict signed manifest rejects ${JSON.stringify(changes)}`, () => {
  expect(() => fixture('1.0.1', changes).verified()).toThrow()
})

test('asset URLs are pinned to the new org prefix (old org rejected)', () => {
  expect(fixture().verified().manifest.url.startsWith(ASSET_PREFIX)).toBe(true)
  expect(() => fixture('1.0.1', { url: 'https://github.com/knuaf-devcat/knuaf-dev/releases/download/skill-v1.0.1/skill.zip' }).verified()).toThrow(/내려받기 주소/)
})

test('unknown signed fields and unsupported app/API are rejected before download', async () => {
  const f = fixture()
  expect(() => verifySkill(envelope({ ...f.manifest, executable: 'oops' }), keys)).toThrow(/항목/)
  for (const change of [{ api: 2 }, { minApp: '0.6.0' }]) {
    const { store } = setup(), { updates, requests } = updater(store, fixture('1.0.1', change))
    expect((await updates.check()).phase).toBe('needs-app')
    await expect(updates.install()).rejects.toThrow(/앱 새 판/)
    expect(requests).toEqual([CHANNEL_URL])
    expect(store.state().highest).toBeNull()
  }
})

test('removing the only skill channel entry returns idle and clears its candidate', async () => {
  const { store } = setup(), f = fixture('1.0.1')
  let channel: unknown = { schema: 1, skill: channelSkill(f) }
  const { updates, requests } = channelUpdater(store, () => channel)
  expect((await updates.check()).phase).toBe('available')
  channel = { schema: 1 }
  expect(await updates.check()).toMatchObject({ phase: 'idle', available: null })
  await expect(updates.install()).rejects.toThrow(/먼저 업데이트/)
  expect(requests).toEqual([CHANNEL_URL, CHANNEL_URL])
})

for (const [label, entry] of [
  ['null', null],
  ['empty object', {}],
  ['empty string', ''],
  ['malformed string', 'not-an-envelope'],
  ['empty envelope', { manifest: '', sig: '' }]
] as const) test(`present skill entry ${label} remains an error`, async () => {
  const { store } = setup(), { updates } = channelUpdater(store, () => ({ schema: 1, skill: entry }))
  expect((await updates.check()).phase).toBe('error')
})

test('a present skill entry with a bad signature remains an error', async () => {
  const { store } = setup(), f = fixture('1.0.1')
  const entry = { ...channelSkill(f), sig: Buffer.alloc(64).toString('base64') }
  const { updates } = channelUpdater(store, () => ({ schema: 1, skill: entry }))
  expect((await updates.check()).phase).toBe('error')
})

test('a skill entry signed by another key remains an error', async () => {
  const { store } = setup(), f = fixture('1.0.1'), entry = channelSkill(f)
  const other = generateKeyPairSync('ed25519')
  const sig = sign(null, Buffer.from(entry.manifest, 'base64'), other.privateKey).toString('base64')
  const { updates } = channelUpdater(store, () => ({ schema: 1, skill: { ...entry, sig } }))
  expect((await updates.check()).phase).toBe('error')
})

test('a skill channel hint that differs from the signed version remains an error', async () => {
  const { store } = setup(), f = fixture('1.0.1')
  const { updates } = channelUpdater(store, () => ({ schema: 1, skill: { ...channelSkill(f), version: '1.0.2' } }))
  expect((await updates.check()).phase).toBe('error')
})

for (const [label, transform] of [
  ['added file', (es: Entry[]) => [...es, { name: 'scripts/extra.py', data: Buffer.from('bad') }]],
  ['missing file', (es: Entry[]) => es.slice(0, -1)],
  ['traversal', (es: Entry[]) => [...es, { name: '../escape', data: Buffer.from('bad') }]],
  ['absolute', (es: Entry[]) => [...es, { name: '/escape', data: Buffer.from('bad') }]],
  ['symlink', (es: Entry[]) => es.map(e => e.name === 'scripts/example.py' ? { ...e, mode: 0xa1ff } : e)],
  ['device', (es: Entry[]) => es.map(e => e.name === 'scripts/example.py' ? { ...e, mode: 0x21ff } : e)],
  ['duplicate', (es: Entry[]) => [...es, es[0]]],
  ['decompression bomb', (es: Entry[]) => es.map(e => e.name === 'SKILL.md' ? { ...e, data: Buffer.alloc(100000), method: 8, claimedSize: 10 } : e)],
  ['version mismatch', (es: Entry[]) => es.map(e => e.name === 'skill.json' ? { ...e, data: Buffer.from('{"version":"1.0.2","api":1}') } : e)]
] as const) test(`ZIP rejects ${label} without raising highest or writing outside store`, () => {
  const { store, root } = setup(), f = fixture('1.0.1', {}, transform)
  expect(() => store.publish(f.verified(), f.zip)).toThrow()
  expect(store.state()).toEqual({ active: null, kept: {}, highest: null })
  expect(existsSync(join(root, 'escape'))).toBe(false)
  const good = fixture()
  store.publish(good.verified(), good.zip)
  expect(store.state().highest?.version).toBe('1.0.1')
})

test('archive byte mutation, extracted file mutation, extra/missing files and symlinks cannot become active', () => {
  const { store, bundled } = setup(), f = fixture()
  const bad = Buffer.from(f.zip); bad[40] ^= 1
  expect(() => extractSkill(bad, join(store.root, 'bad'), f.manifest)).toThrow(/확인값/)
  store.publish(f.verified(), f.zip); store.select('1.0.1')
  const file = join(store.root, '1.0.1', 'scripts', 'example.py')
  for (const mutate of [
    () => writeFileSync(file, 'corrupt'),
    () => writeFileSync(join(store.root, '1.0.1', 'extra'), 'bad'),
    () => rmSync(file),
    () => { rmSync(file); symlinkSync(join(bundled, 'SKILL.md'), file) }
  ]) {
    mutate()
    expect(store.resolveSkillSource()).toBe(bundled)
    expect(store.disposition(f.verified())).toBe('repair')
    expect(store.state().highest?.version).toBe('1.0.1')
    store.publish(f.verified(), f.zip)
    expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  }
})

test('rollback never lowers highest, old signed replay and same-version replacement fail; restart preserves choice', async () => {
  const { root, bundled, store } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip); store.select(v) }
  store.select(store.rollbackTarget())
  expect(store.state().active).toBe('1.0.1')
  expect(store.state().highest?.version).toBe('1.0.2')
  expect(() => store.disposition(fixture('1.0.1').verified())).toThrow(/이전 판/)
  expect(() => store.disposition(fixture('1.0.2', { minApp: '0.5.0' }).verified())).toThrow(/내용이 달라/)
  const restored = new SkillStore(root, bundled, '0.5.1', keys)
  const { updates } = updater(restored, fixture('1.0.2'))
  expect((await updates.check()).phase).toBe('ready')
  expect(restored.state().active).toBe('1.0.1')
  expect(restored.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  await updates.select('1.0.2')
  expect(restored.state().active).toBe('1.0.2')
})

test('state damage falls back to bundle but highest backup still prevents replay; incomplete atomic tmp is ignored', () => {
  const { root, bundled, store } = setup(), f = fixture('1.0.2')
  store.publish(f.verified(), f.zip); store.select('1.0.2')
  writeFileSync(join(store.root, 'state.json.tmp'), '{')
  expect(store.state().active).toBe('1.0.2')
  writeFileSync(join(store.root, 'state.json'), '{')
  const reopened = new SkillStore(root, bundled, '0.5.1', keys)
  expect(reopened.resolveSkillSource()).toBe(bundled)
  expect(reopened.state().highest?.version).toBe('1.0.2')
  expect(() => reopened.disposition(fixture('1.0.1').verified())).toThrow(/이전 판/)
  expect(reopened.disposition(f.verified())).toBe('repair')
})

test('newer bundle wins and cleanup runs only on explicit startup, retaining active plus previous', () => {
  const { root, bundled, store } = setup()
  for (const v of ['1.0.1', '1.0.2', '1.0.3']) { const f = fixture(v); store.publish(f.verified(), f.zip); store.select(v) }
  expect(existsSync(join(store.root, '1.0.1'))).toBe(true)
  const abandoned = ['.stage-interrupted', '.download-interrupted', '.damaged-1.0.1-1000']
  for (const name of abandoned) mkdirSync(join(store.root, name))
  store.cleanup()
  expect(store.state().kept).toEqual({ '1.0.2': fixture('1.0.2').verified().digest, '1.0.3': fixture('1.0.3').verified().digest })
  expect(existsSync(join(store.root, '1.0.1'))).toBe(false)
  for (const name of abandoned) expect(existsSync(join(store.root, name))).toBe(false)
  writeFileSync(join(bundled, 'skill.json'), JSON.stringify({ version: '1.0.4', api: 1 }))
  const newer = new SkillStore(root, bundled, '0.5.1', keys)
  expect(newer.resolveSkillSource()).toBe(bundled)
  expect(() => newer.select('1.0.3')).toThrow(/사용할 수 없/)
  expect(compare('1.10.0', '1.9.99')).toBe(1)
})

test('packaged ignores all developer overrides and uses the two pinned production keys', async () => {
  const env = { KNUAF_UPDATE_PUBLIC_KEY: publicKey, KNUAF_UPDATE_CHANNEL_URL: 'http://127.0.0.1:3210/channel.json' }
  expect(updateConfig(false, env)).toEqual({ channel: env.KNUAF_UPDATE_CHANNEL_URL, keys, development: true })
  const packaged = updateConfig(true, env)
  expect(packaged).toEqual({ channel: CHANNEL_URL, keys: Object.values(UPDATE_KEYS), development: false })
  expect(packaged.keys).toHaveLength(2); expect(new Set(packaged.keys).size).toBe(2)
  expect(() => verifySkill(fixture().signed, packaged.keys)).toThrow(/서명/)
  const { store, bundled } = setup('1.0.0', packaged.keys)
  const fetched: string[] = []
  const updates = new SkillUpdates(store, { config: packaged, fetch: async url => { fetched.push(url); throw new Error('offline') }, restartSidecar: async () => {} })
  expect((await updates.check()).phase).toBe('error')
  await expect(updates.install()).rejects.toThrow()
  expect(fetched).toEqual([CHANNEL_URL])
  expect(store.resolveSkillSource()).toBe(bundled)
})

test('redirects to an arbitrary host stop before second request, allowed CDN works, oversized streaming stops', async () => {
  const f = fixture(), signal = new AbortController().signal, requests: string[] = []
  await expect(boundedFetch(f.manifest.url, signal, async url => { requests.push(url); return new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }) }, f.zip.length, config())).rejects.toThrow(/이동 주소/)
  expect(requests).toEqual([f.manifest.url])
  const cdn = 'https://release-assets.githubusercontent.com/release-assets/test?token=fake'
  const response = await boundedFetch(f.manifest.url, signal, async url => url === cdn ? new Response(f.zip) : new Response(null, { status: 302, headers: { location: cdn } }), f.zip.length, config())
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.zip)
  const large = await boundedFetch(f.manifest.url, signal, async () => new Response(Buffer.alloc(10)), 5, config())
  await expect(large.arrayBuffer()).rejects.toThrow(/상한/)
})

test('redirect chain stops at five hops and channel addresses never follow a redirect', async () => {
  const f = fixture(), signal = new AbortController().signal, requests: string[] = []
  // 끝없는 허용 목록 이동 — 5회를 넘기면 멈춰야 한다(루프가 요청을 무한히 내지 않는다는 증거).
  const chain: Transport = async url => {
    requests.push(url)
    return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/r${requests.length}` } })
  }
  await expect(boundedFetch(f.manifest.url, signal, chain, f.zip.length, config())).rejects.toThrow(/이동 주소/)
  expect(requests).toHaveLength(6)
  const channelRequests: string[] = []
  const c = config()
  await expect(boundedFetch(c.channel, signal, async url => {
    channelRequests.push(url)
    return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/r1' } })
  }, 1024, c, true)).rejects.toThrow(/이동 주소/)
  expect(channelRequests).toEqual([c.channel])
})

test('same-process update downloads and publishes before switch; timeout keeps verified storage and highest', async () => {
  const { store, bundled } = setup(), lock = new SkillSwitch(), release = lock.enter(), { updates } = updater(store, fixture(), async () => {}, lock)
  await updates.check()
  const installation = updates.install()
  await expect.poll(() => store.state().highest?.version).toBe('1.0.1')
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(() => lock.enter()).toThrow(/규칙집/)
  release()
  expect((await installation).current).toBe('1.0.1')
  const held = lock.enter()
  await expect(lock.switch(async () => { throw new Error('must not execute') }, 1)).rejects.toThrow(/작업이 끝난 뒤/)
  held()
  expect(store.state().highest?.version).toBe('1.0.1')
  expect(lock.switching).toBe(false)
})

test('sidecar restart failure restores previous active while keeping newly verified highest; explicit reuse avoids download', async () => {
  const { store, bundled } = setup()
  let attempts = 0
  const { updates, requests } = updater(store, fixture(), async () => { if (++attempts === 1) throw new Error('restart failed') })
  await updates.check()
  await expect(updates.install()).rejects.toThrow('restart failed')
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(store.state().highest?.version).toBe('1.0.1')
  const before = requests.slice()
  await updates.install()
  expect(requests).toEqual(before)
  expect(store.state().active).toBe('1.0.1')
})

test('chat pins one source per send and holds switch admission until the whole turn finishes', async () => {
  const { root, bundled, store } = setup(), f = fixture()
  const project = join(root, 'project'); mkdirSync(project)
  const userData = join(root, 'chat')
  // Claude 사본은 논문 폴더 밖 앱 자리(§4.2), Codex 사본만 폴더 안이다.
  const hostSkill = skillTargets(project, userData).claude
  const hostMarker = join(userData, 'skill-host', '.knuaf-gui/skill-install.json')
  const done = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  let sourceReads = 0, source = bundled
  const chat = new ChatService({ skillSource: () => { ++sourceReads; return source }, userData: join(root, 'chat'), emit: () => {}, openExternal: async () => {}, connectionFactory: () => ({
    status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, respond: () => {}, stop: async () => {},
    run: async () => { started.resolve(); await done.promise }
  }) })
  await chat.send(project, 'claude', 'hello', 'request-1'); await started.promise
  const switchDone = skillSwitch.switch(async () => { store.publish(f.verified(), f.zip); store.select('1.0.1'); source = store.resolveSkillSource() })
  expect(() => skillSwitch.enter()).toThrow(/규칙집/)
  expect(sourceReads).toBe(1)
  expect(readFileSync(join(hostSkill, 'SKILL.md'), 'utf8')).toContain('bundle')
  done.resolve(); await switchDone
  await chat.send(project, 'claude', 'next', 'request-2')
  await chat.stop(project, 'claude')
  expect(sourceReads).toBe(2)
  expect(readFileSync(join(hostSkill, 'SKILL.md'), 'utf8')).toBe('# skill 1.0.1')
  expect(chat.snapshot(project, 'claude').messages.some(m => m.role === 'system' && m.text.includes('규칙집이 갱신'))).toBe(true)
  const marker = JSON.parse(readFileSync(hostMarker, 'utf8'))
  expect(marker).toEqual({ schema: 'knuaf-gui/skill-install@1', installs: [{ path: '.claude/skills/knuaf-dev' }, { path: '.agents/skills/knuaf-dev' }] })
  installSkill(bundled, join(project, '.agents/skills/knuaf-dev'), skillVersion(bundled))
  expect(JSON.parse(readFileSync(hostMarker, 'utf8'))).toEqual(marker)
  // 이 배선의 목적: 논문 폴더에는 `.claude` 가 생기지 않는다(그 폴더를 CLI 가 설정으로 읽지 않게).
  expect(existsSync(join(project, '.claude'))).toBe(false)
  await chat.close()
})

test('cancelled streamed download preserves previous state and the next explicit attempt succeeds', async () => {
  const { store, bundled } = setup(), f = fixture(), downloading = Promise.withResolvers<void>()
  let slow = true
  const updates = new SkillUpdates(store, {
    config: config(), lock: new SkillSwitch(), restartSidecar: async () => {},
    fetch: async url => {
      if (url === CHANNEL_URL) return new Response(JSON.stringify({ schema: 1, skill: f.signed }))
      if (!slow) return new Response(f.zip)
      downloading.resolve()
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(f.zip.subarray(0, 10)) } }))
    }
  })
  await updates.check()
  const attempt = updates.install()
  const cancelled = expect(attempt).rejects.toMatchObject({ code: 'runtime_cancelled' })
  await downloading.promise
  expect(updates.cancel()).toBe(true)
  await cancelled
  expect(store.state().highest).toBeNull()
  expect(store.resolveSkillSource()).toBe(bundled)
  slow = false
  expect((await updates.install()).current).toBe('1.0.1')
})

test('repair waits for running consumers before replacing the active directory', async () => {
  const { store } = setup(), f = fixture(), lock = new SkillSwitch()
  store.publish(f.verified(), f.zip); store.select('1.0.1')
  const file = join(store.root, '1.0.1/scripts/example.py')
  writeFileSync(file, 'damaged')
  const release = lock.enter(), { updates } = updater(store, f, async () => {}, lock)
  expect((await updates.check()).phase).toBe('repair')
  const repairing = updates.install()
  await expect.poll(() => lock.switching).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('damaged')
  release()
  expect((await repairing).current).toBe('1.0.1')
  expect(readFileSync(file, 'utf8')).toBe("print('1.0.1')\n")
})

test('signed file count limit and signed skill.json API/version mismatch are enforced', () => {
  const f = fixture(), files = { ...f.manifest.files }
  for (let i = 0; i < 600; i++) files[`scripts/${i}.py`] = 'a'.repeat(64)
  expect(() => fixture('1.0.1', { files }).verified()).toThrow(/파일 목록/)
  for (const metadata of [{ version: '1.0.2', api: 1 }, { version: '1.0.1', api: 2 }]) {
    const bad = fixture('1.0.1', {}, entries => entries.map(e => e.name === 'skill.json' ? { ...e, data: Buffer.from(JSON.stringify(metadata)) } : e))
    bad.manifest.files['skill.json'] = sha256(JSON.stringify(metadata))
    const p = verifySkill(envelope(bad.manifest), keys)
    expect(() => extractSkill(bad.zip, temporary(), p.manifest)).toThrow(/ZIP/)
  }
})

class SelectionSwitch extends SkillSwitch {
  attempts = 0
  override async switch<T>(work: () => Promise<T>, timeout?: number): Promise<T> {
    ++this.attempts
    return super.switch(work, timeout)
  }
}

for (const [label, input] of [
  ['undefined', undefined], ['number', 1], ['object', {}], ['array', []],
  ['relative path', '../escape'], ['absolute path', '/tmp/escape'], ['prerelease', '1.0.1-rc.1']
] as const) test(`select rejects invalid input without side effects: ${label}`, async () => {
  const { store } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip) }
  store.select('1.0.1')
  const before = store.state(), lock = new SelectionSwitch(), phases: string[] = []
  let restarts = 0
  const updates = new SkillUpdates(store, {
    config: config(), lock, emit: status => { phases.push(status.phase) },
    fetch: async () => { throw new Error('selection must not fetch') },
    restartSidecar: async () => { ++restarts }
  })
  const status = updates.status()
  await expect(updates.select(input as string | null)).rejects.toThrow()
  expect(store.state()).toEqual(before)
  expect(restarts).toBe(0)
  expect(phases).toEqual([])
  expect(lock.attempts).toBe(0)
  expect(lock.switching).toBe(false)
  expect(updates.status()).toEqual(status)
})

test('select accepts a stored version and null; rollback keeps highest', async () => {
  const { store, bundled } = setup()
  for (const v of ['1.0.1', '1.0.2']) { const f = fixture(v); store.publish(f.verified(), f.zip) }
  store.select('1.0.1')
  const highest = store.state().highest, lock = new SelectionSwitch(), phases: string[] = []
  let restarts = 0
  const updates = new SkillUpdates(store, {
    config: config(), lock, emit: status => { phases.push(status.phase) },
    fetch: async () => { throw new Error('selection must not fetch') },
    restartSidecar: async () => { ++restarts }
  })
  expect((await updates.select('1.0.2')).current).toBe('1.0.2')
  expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.2'))
  expect((await updates.rollback()).current).toBe('1.0.1')
  expect(store.resolveSkillSource()).toBe(join(store.root, '1.0.1'))
  expect((await updates.select(null)).bundled).toBe(true)
  expect(store.state().active).toBeNull()
  expect(store.resolveSkillSource()).toBe(bundled)
  expect(store.state().highest).toEqual(highest)
  expect(restarts).toBe(3)
  expect(lock.attempts).toBe(3)
  expect(phases).toEqual(['switching', 'ready', 'switching', 'ready', 'switching', 'ready'])
})

/**
 * 실제 전송 계층(`netRequestTransport`)은 Electron 메인에만 있으므로 **앱을 띄워** 태운다.
 * 결함(0.6.1~0.6.3): `net.fetch(…, {redirect:'manual'})` 이 3xx 를 돌려주지 않고 스스로 취소해
 * `Redirect was cancelled` 로 끝났다 — 허용 목록 검사가 한 번도 실행되지 않았다.
 *
 * 이 시험이 잠그는 것 셋:
 *   1. Electron 이 manual 모드에서 `redirect` 이벤트로 3xx 를 준다(고침이 기대는 계약).
 *   2. 그 3xx 가 **응답으로** 올라와 허용 목록 검사에 닿는다(오류 문구가 '이동 주소').
 *   3. 가리킨 호스트로 요청이 **한 건도** 나가지 않는다(서버 로그가 증거).
 * 양성 대조(같은 서버가 200 서명 채널을 주면 정상)가 없으면 위 실패가 '설정이 틀려서'와 구별되지 않는다.
 */
test('channel 302 surfaces as a response, the allowlist rejects it, and the pointed host is never contacted', async () => {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const hitsA: string[] = [], hitsB: string[] = []
  let mode: 'redirect' | 'ok' = 'redirect'
  const upstream = createServer((req, res) => { hitsB.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"schema":1}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const channel = createServer((req, res) => {
    hitsA.push(req.url ?? '')
    if (mode === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/evil.json` }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ schema: 1, app: { latest: '0.0.1', page: 'https://github.com/team-Batmaego/knuaf-dev/releases/tag/v0.0.1' } }))
  })
  await new Promise<void>(resolve => channel.listen(0, '127.0.0.1', resolve))
  const channelUrl = `http://127.0.0.1:${(channel.address() as AddressInfo).port}/channel.json`
  const { electronApp, page, appLog } = await launch({ env: {
    KNUAF_AGENT_PATH_ONLY: '1', KNUAF_UPDATE_PUBLIC_KEY: publicKey, KNUAF_UPDATE_CHANNEL_URL: channelUrl
  } })
  try {
    // 1. Electron 계약: manual 모드에서 3xx 는 `redirect` 이벤트로 온다(따라가지 않는다).
    const observed = await electronApp.evaluate(({ net }, url) => new Promise<string>(resolve => {
      const request = net.request({ url, method: 'GET', redirect: 'manual' })
      // 따라가지 않으면 Chromium 이 스스로 요청을 취소한다 — 그 'error' 는 정상이고, 우리는 이벤트만 본다.
      request.on('redirect', (status, _method, location) => resolve(`${status} ${location}`))
      request.on('error', (error: Error) => resolve(`error ${error.message}`))
      request.end()
    }), channelUrl)
    expect(observed).toBe(`302 http://127.0.0.1:${upstreamPort}/evil.json`)

    // 2. 두 갈래(규칙집·앱)가 같은 채널 읽기를 쓴다 — 둘 다 허용 목록 오류로 끝나야 한다.
    type Reply = { result?: { phase: string; message?: string }; error?: { code: string; message: string } }
    const ask = (): Promise<[Reply, Reply]> => page.evaluate(() => Promise.all([window.knuaf.update.check(), window.knuaf.appUpdate.check()])) as Promise<[Reply, Reply]>
    const [skill, appUpdate] = await ask()
    expect(skill.result?.phase).toBe('error')
    expect(skill.result?.message).toContain('허용되지 않은 업데이트 이동 주소')
    expect(appUpdate.result?.phase).toBe('error')
    expect(appUpdate.result?.message).toContain('허용되지 않은 업데이트 이동 주소')

    // 3. 증거: 가리킨 호스트는 요청을 한 건도 받지 않았다(응답 문구만으로는 부족하다).
    expect(hitsA.length).toBeGreaterThanOrEqual(1)
    expect(hitsB).toHaveLength(0)

    // 4. main 로그 한 줄 — 맥 실측에서 실패 원인이 로그에 0줄이었다(ORDER 추가 3). 남기는 것은
    //    단계·호스트·상태 코드·오류 이름뿐이고 쿼리 문자열·주소 전체는 싣지 않는다.
    const appLogText = (): string => existsSync(appLog) ? readFileSync(appLog, 'utf-8') : ''
    await expect.poll(appLogText).toMatch(/update:failed stage=channel host=127\.0\.0\.1 status=302 error=Error/)
    // 두 갈래(규칙집·앱)가 같은 채널을 각각 읽으므로 줄이 둘 이상일 수 있다 - 전부 같은 모양이어야 한다.
    const failureLines = appLogText().split('\n').filter(line => line.includes('update:failed'))
    expect(failureLines.length).toBeGreaterThanOrEqual(2)
    for (const line of failureLines) {
      // 주소·쿼리 문자열은 싣지 않는다 - 이 줄은 CI 산출물로 올라간다.
      expect(line).not.toContain('channel.json')
      expect(line).not.toContain('http')
    }

    // 양성 대조: 같은 서버가 200 으로 채널을 주면 두 갈래 모두 오류 없이 '할 일 없음'으로 끝난다.
    // 시작 시 자동 확인(ipc.ts 의 `void …check()`)의 결과가 섞일 수 있어 최종 상태가 바뀔 때까지 다시 묻는다.
    mode = 'ok'
    await expect.poll(async () => (await ask()).map(reply => `${reply.error?.code ?? '-'}/${reply.result?.phase ?? '-'}`).join(' '), { timeout: 20_000 })
      .toBe('-/idle -/idle')
    expect(hitsB).toHaveLength(0)
  } finally {
    await electronApp.close()
    await new Promise<void>((resolve, reject) => channel.close(error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})

/**
 * Roh R-01 회귀 시험 — 받은 본문을 **큐에 쌓지 않고** 소비자 속도로 당긴다.
 *
 * 예전 구현은 `data` 를 붙여 흘려 받았다: 4MiB 응답을 300ms 동안 읽지 않아도 4,194,304바이트가
 * 전부 들어왔다(R1 실측). 본문 상한은 80MiB(`manifest.MAX_BYTES`)·1GiB
 * (`appManifest.MAX_INSTALLER_BYTES`)라 그 큐가 힙에 그대로 남는다.
 *
 * 그래서 16MiB 를 로컬에서 주고, **읽지 않고 1.5초** 둔 뒤 서버가 실제로 몇 바이트를 내보냈는지 본다.
 * 흘려 받는 구현이면 16MiB 가 loopback 에서 수십 ms 만에 다 나가 서버 쓰기가 끝나 있다. 당기는
 * 구현이면 서버 쓰기가 `drain` 에서 멈춘다(`allWritten=false`). 이어서 끝까지 읽어 **바이트 수와
 * SHA-256 이 일치**하는지 확인한다(배압이 본문을 자르지 않는다는 증거). 마지막으로 큐가 멈춘
 * 상태에서 '취소'가 연결을 실제로 끊는지(`AbortError` + 서버 소켓 close) 확인한다.
 *
 * 전송 계층은 Electron 메인에만 있으므로 앱을 띄워 `netTransport.ts` 를 그 자리에서 심는다.
 */
test('a stalled consumer stops the transfer instead of buffering the whole body, and cancel still tears it down', async () => {
  const payload = Buffer.alloc(16 * 1024 * 1024)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff
  const digest = createHash('sha256').update(payload).digest('hex')

  // 서버 쪽 관측점: 이 요청의 소켓이 실제로 내보낸 바이트와, 쓰기 루프가 끝났는지.
  let socketRef: Socket | null = null
  let allWritten = false
  let socketClosed = false
  const server = createServer((req, res) => {
    const socket = req.socket
    socketRef = socket
    socket.on('close', () => { socketClosed = true })
    void (async () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        if (!res.write(payload.subarray(offset, offset + 64 * 1024))) {
          const drained = Promise.withResolvers<void>()
          res.once('drain', drained.resolve)
          await drained.promise
        }
      }
      res.end()
      allWritten = true
    })().catch(() => {})
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/asset.bin`

  const source = transpileModule(readFileSync(join(__dirname, '../src/main/update/netTransport.ts'), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText

  const { electronApp } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1' } })
  const stall = 1_500
  type Outcome = { stallStart: number; stallEnd: number; bytes: number; digest: string; error: string }
  const run = (mode: 'stall' | 'cancel'): Promise<Outcome> =>
    electronApp.evaluate(async (electron, args) => {
      type Transport = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>
      const loaded = { exports: {} as { netRequestTransport: Transport } }
      // 실물 모듈을 그대로 심는다 — `electron` 말고는 의존하지 않는다(계약 import 는 타입뿐이라 사라진다).
      new Function('require', 'module', 'exports', args.source)((name: string) => {
        if (name === 'electron') return electron
        throw new Error(`unexpected dependency ${name}`)
      }, loaded, loaded.exports)
      const { createHash } = process.getBuiltinModule('node:crypto')
      const controller = new AbortController()
      const response = await loaded.exports.netRequestTransport(args.url, { signal: controller.signal, redirect: 'manual' })
      const reader = response.body!.getReader()
      const hash = createHash('sha256')
      let bytes = 0
      let error = ''
      const stallStart = Date.now()
      const waited = Promise.withResolvers<void>()
      setTimeout(waited.resolve, args.stall)
      await waited.promise
      const stallEnd = Date.now()
      if (args.mode === 'cancel') {
        controller.abort()
        // 취소는 **다음 당김**에서 드러난다(이미 큐에 든 조각 하나는 정상 반환). 그래서 끝까지 당겨 본다.
        for (;;) {
          try {
            const { done } = await reader.read()
            if (done) break
          } catch (thrown) {
            const failure = thrown as Error
            error = `${failure.name}:${failure.message}`
            break
          }
        }
        return { stallStart, stallEnd, bytes, digest: '', error }
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        hash.update(value)
      }
      return { stallStart, stallEnd, bytes, digest: hash.digest('hex'), error }
    }, { source, url, stall, mode })

  /** 멈춰 있는 동안 서버가 내보낸 양. 흘려 받는 구현이면 여기서 이미 16MiB 가 다 나간다. */
  const sample = async (outcome: Promise<{ stallStart: number; stallEnd: number }>): Promise<{ peak: number; finished: boolean }> => {
    const samples: { t: number; flushed: number; written: boolean }[] = []
    const timer = setInterval(() => samples.push({ t: Date.now(), flushed: socketRef?.bytesWritten ?? 0, written: allWritten }), 25)
    let window: { stallStart: number; stallEnd: number }
    try { window = await outcome } finally { clearInterval(timer) }
    const during = samples.filter(entry => entry.t >= window.stallStart && entry.t <= window.stallEnd)
    return { peak: Math.max(0, ...during.map(entry => entry.flushed)), finished: during.some(entry => entry.written) }
  }

  try {
    const stalled = run('stall')
    const during = await sample(stalled)
    expect(during.peak, '수신이 아예 시작되지 않았다').toBeGreaterThan(0)
    expect(during.finished, '읽지 않는데 서버가 본문을 끝까지 내보냈다 — 수신 배압이 없다').toBe(false)
    // 흘려 받는 구현은 16MiB 를 다 밀어 넣는다. 배압이 있으면 소켓·파이프 버퍼 몫만 남는다.
    expect(during.peak, '읽지 않는 동안 본문이 거의 다 들어왔다').toBeLessThan(payload.length * 0.75)

    // 이어서 읽으면 잘리지 않고 전부 온다 — 배압이 본문을 훼손하지 않는다.
    const outcome = await stalled
    expect(outcome.bytes).toBe(payload.length)
    expect(outcome.digest).toBe(digest)
    await expect.poll(() => allWritten).toBe(true)
    // `bytesWritten` 은 응답 헤더까지 센다 — 본문 길이 이상이면 다 나간 것이다.
    await expect.poll(() => socketRef?.bytesWritten ?? 0).toBeGreaterThanOrEqual(payload.length)

    // 멈춘 상태에서의 '취소' — 남은 본문을 흘려보내지 않고 연결을 끊는다.
    socketClosed = false
    allWritten = false
    const cancelled = run('cancel')
    const held = await sample(cancelled)
    expect(held.finished).toBe(false)
    const abort = await cancelled
    expect(abort.error).toMatch(/^AbortError:/)
    await expect.poll(() => socketClosed, { message: "'취소' 뒤에도 서버 소켓이 살아 있다" }).toBe(true)
  } finally {
    await electronApp.close()
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(error => error ? closed.reject(error) : closed.resolve())
    await closed.promise
  }
})
