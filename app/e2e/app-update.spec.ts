import { expect, test } from '@playwright/test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentApi, probeVersion, setTreeAccess } from '../src/main/agent'
import { ChatService } from '../src/main/chat/service'
import type { AgentConnection } from '../src/main/chat/contracts'
import { AgentActivity, agentActivity } from '../src/main/update/activity'
import { AppHandoff } from '../src/main/update/handoff'
import { AppUpdates } from '../src/main/update/appService'
import { MAX_INSTALLER_BYTES, releasePage, verifyApp } from '../src/main/update/appManifest'
import { ASSET_PREFIX, CHANNEL_URL, sha256 } from '../src/main/update/manifest'
import { updateConfig } from '../src/main/update/keys'
import { SkillSwitch } from '../src/main/update/switch'
import { OwnedProcessWatch, resourcesBusy, windowsPath, type ProcessInfo, type ProcessSnapshot } from '../src/main/update/processes'
import type { InstallerLaunch } from '../src/main/update/nativeInstaller'
import { WindowsUpdateRuntime } from '../src/main/update/windows'

const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const config = () => updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })
const roots: string[] = []
const temporary = (): string => { const root = mkdtempSync(join(tmpdir(), 'knuaf-app-update-')); roots.push(root); return root }
// 앱 스킬 자리는 읽기 전용으로 잠긴 채 남는다(설계 §4.2) — 폴더가 안 써지면 rmSync 는 ENOTEMPTY 다.
test.afterEach(() => { agentActivity.resume(); for (const root of roots.splice(0)) { setTreeAccess(root, true); rmSync(root, { recursive: true, force: true }) } })
function fixture(v = '0.6.0', changes: Record<string, unknown> = {}) {
  const bytes = Buffer.from(`signed fake installer ${v}`)
  const manifest = { schema: 1, name: 'knuaf-dev-app', version: v, platform: 'win32-x64', url: `${ASSET_PREFIX}v${v}/knuaf-dev-${v}-x64.exe`, size: bytes.length, sha256: sha256(bytes), ...changes }
  const source = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const envelope = { manifest: source.toString('base64'), sig: sign(null, source, pair.privateKey).toString('base64') }
  return { bytes, manifest, envelope, channel: { schema: 1, app: { latest: v, page: releasePage(v), 'win32-x64': envelope } } }
}
const emptySnapshot = (): ProcessSnapshot => ({ processes: [], appPid: 1, appExecutable: 'C:\\App\\app.exe' })
function scenario(f = fixture()) {
  const root = temporary(), project = join(root, 'project'), bundled = join(root, 'bundle')
  mkdirSync(project); mkdirSync(bundled); writeFileSync(join(bundled, 'SKILL.md'), '# fake skill')
  const calls: string[] = [], requests: string[] = []
  let failure = '', connected = true, spawned = 0, quit = 0
  let onConfirm = async () => {}, onIdle = async () => {}, onStart = async () => {}, onStatus = async () => {}
  const chat = new ChatService({ skillSource: () => bundled, userData: root, emit: () => {}, openExternal: async () => {}, connectionFactory: (_provider, options): AgentConnection => {
    ++spawned
    return {
      status: async () => { calls.push('status'); await onStatus(); return { installed: true, connected, version: null, detail: options.root } },
      login: async () => { calls.push('login') }, models: async () => [], run: async () => { calls.push('turn') }, respond: () => {},
      stop: async () => { calls.push('close'); if (failure === 'close' && options.root === project) throw new Error('connection stop failed') }
    }
  } })
  const lock = new SkillSwitch()
  const handoff = new AppHandoff({
    chat, lock,
    sidecar: { stop: async () => { calls.push('sidecar-stop'); if (failure === 'sidecar') throw new Error('sidecar stop failed') }, restart: async () => { calls.push('sidecar-restart') } },
    windows: {
      captureOwned: async () => { calls.push('capture'); return emptySnapshot() },
      confirmStopped: async () => { calls.push('confirmed'); await onConfirm(); if (failure === 'confirm') throw new Error('tree not confirmed') },
      assertResourcesIdle: async () => { calls.push('resources'); await onIdle(); if (failure === 'resources') throw new Error('도우미 창을 닫은 뒤 다시 눌러 주세요.') }
    }
  })
  const options = {
    userData: root, current: '0.5.1', platform: 'win32' as NodeJS.Platform, arch: 'x64', config: config(), handoff,
    fetch: async (url: string) => { requests.push(url); return new Response(url === CHANNEL_URL ? JSON.stringify(f.channel) : f.bytes) },
    startInstaller: async ({ path }: InstallerLaunch) => { calls.push('installer'); expect(readFileSync(path)).toEqual(f.bytes); await onStart(); if (failure === 'start' || failure === 'uac') throw new Error(failure === 'uac' ? 'UAC cancelled' : 'spawn failed') },
    quit: () => { ++quit; calls.push('quit') }, openExternal: async () => {}
  }
  const updates = new AppUpdates(options)
  return { root, project, chat, updates, options, calls, requests, lock,
    fail: (v: string) => { failure = v }, setConnected: (v: boolean) => { connected = v },
    confirm: (fn: () => Promise<void>) => { onConfirm = fn }, idle: (fn: () => Promise<void>) => { onIdle = fn }, start: (fn: () => Promise<void>) => { onStart = fn }, status: (fn: () => Promise<void>) => { onStatus = fn },
    spawned: () => spawned, quit: () => quit, installer: join(root, 'app-update', String(f.manifest.version), 'installer.exe') }
}

test('app signature is original-byte Ed25519, and app/platform/version/size/URL schemas fail closed', () => {
  const f = fixture()
  expect(verifyApp(f.envelope, [publicKey], '0.5.1').manifest.version).toBe('0.6.0')
  const bytes = Buffer.from(f.envelope.manifest, 'base64'); bytes[1] ^= 1
  expect(() => verifyApp({ ...f.envelope, manifest: bytes.toString('base64') }, [publicKey], '0.5.1')).toThrow(/서명/)
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(() => verifyApp(f.envelope, [other], '0.5.1')).toThrow(/서명/)
  for (const change of [{ name: 'knuaf-dev' }, { platform: 'darwin-arm64' }, { version: '0.6.0-rc.1' }, { size: MAX_INSTALLER_BYTES + 1 }, { url: 'https://evil.example/setup.exe' }, { extra: true }]) {
    expect(() => verifyApp(fixture('0.6.0', change).envelope, [publicKey], '0.5.1')).toThrow()
  }
  expect(() => verifyApp(f.envelope, [publicKey], '0.6.0')).toThrow(/새로운/)
  expect(() => verifyApp(f.envelope, [publicKey], '0.7.0')).toThrow(/새로운/)
})

test('same/current signed app is not offered or installed, and untrusted hint mismatch cannot select a target', async () => {
  const current = scenario(fixture('0.5.1'))
  expect((await current.updates.check()).phase).toBe('idle')
  await expect(current.updates.install()).rejects.toThrow(/새로운/)
  expect(current.requests).toEqual([CHANNEL_URL]); expect(current.quit()).toBe(0)
  const f = fixture(); f.channel.app.latest = '0.7.0'; f.channel.app.page = releasePage('0.7.0')
  const mismatch = scenario(f)
  expect((await mismatch.updates.check()).phase).toBe('error')
  // A failed channel validation must not leave an installable candidate.
  await expect(mismatch.updates.install()).rejects.toThrow()
  expect(mismatch.requests).toEqual([CHANNEL_URL])
})

test('an absent app key returns idle and clears the prior candidate', async () => {
  const f = fixture(), h = scenario(f)
  expect((await h.updates.check()).phase).toBe('available')
  delete (f.channel as unknown as Record<string, unknown>).app
  expect(await h.updates.check()).toMatchObject({ phase: 'idle', latest: null, page: null })
  await expect(h.updates.install()).rejects.toThrow(/먼저/)
})

test('a missing Windows x64 payload is not offered; Mac release-page behavior is unchanged', async () => {
  const f = fixture(), h = scenario(f), opened: string[] = []
  expect((await h.updates.check()).phase).toBe('available')
  h.options.openExternal = async page => { opened.push(page) }
  const app = (f.channel as unknown as Record<string, unknown>).app as Record<string, unknown>
  delete app['win32-x64']
  expect(await h.updates.check()).toMatchObject({
    phase: 'unavailable', latest: null, page: null,
    message: '새 앱 0.6.0은 아직 이 컴퓨터용으로 준비 중이에요. 지금 앱은 그대로 쓸 수 있어요.'
  })
  await expect(h.updates.install()).rejects.toThrow(/먼저/)
  await expect(h.updates.openPage()).rejects.toThrow(/먼저/)
  expect(opened).toEqual([])

  const old = fixture('0.5.1')
  delete ((old.channel as unknown as Record<string, unknown>).app as Record<string, unknown>)['win32-x64']
  expect((await scenario(old).updates.check()).phase).toBe('idle')

  const macFixture = fixture()
  delete ((macFixture.channel as unknown as Record<string, unknown>).app as Record<string, unknown>)['win32-x64']
  const macBase = scenario(macFixture), mac = new AppUpdates({ ...macBase.options, platform: 'darwin', openExternal: async page => { opened.push(page) } })
  expect((await mac.check()).phase).toBe('available')
  await mac.openPage()
  expect(opened).toEqual([releasePage('0.6.0')])
})

for (const [label, value] of [
  ['null', null],
  ['empty object', {}],
  ['empty string', '']
] as const) test(`present app entry ${label} remains an error`, async () => {
  const f = fixture()
  ;(f.channel as unknown as Record<string, unknown>).app = value
  expect((await scenario(f).updates.check()).phase).toBe('error')
})

for (const [label, entry] of [
  ['null', null],
  ['empty object', {}],
  ['empty string', ''],
  ['malformed string', 'not-an-envelope'],
  ['empty envelope', { manifest: '', sig: '' }]
] as const) test(`present Windows x64 entry ${label} remains an error`, async () => {
  const f = fixture()
  const app = (f.channel as unknown as Record<string, unknown>).app as Record<string, unknown>
  app['win32-x64'] = entry
  expect((await scenario(f).updates.check()).phase).toBe('error')
})

test('a present Windows x64 entry with a bad signature remains an error', async () => {
  const f = fixture(), app = (f.channel as unknown as Record<string, unknown>).app as Record<string, unknown>
  app['win32-x64'] = { ...f.envelope, sig: Buffer.alloc(64).toString('base64') }
  expect((await scenario(f).updates.check()).phase).toBe('error')
})

test('a Windows x64 entry signed by another key remains an error', async () => {
  const f = fixture(), app = (f.channel as unknown as Record<string, unknown>).app as Record<string, unknown>
  const other = generateKeyPairSync('ed25519')
  const sig = sign(null, Buffer.from(f.envelope.manifest, 'base64'), other.privateKey).toString('base64')
  app['win32-x64'] = { ...f.envelope, sig }
  expect((await scenario(f).updates.check()).phase).toBe('error')
})

test('Windows installs only after drain, tree confirmation, resources check and durable pending; quit waits for start acknowledgement', async () => {
  const h = scenario(), entered = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>()
  await h.chat.status(h.project, 'claude'); await h.chat.globalStatus('codex')
  h.start(async () => { entered.resolve(); await accepted.promise })
  expect((await h.updates.check()).phase).toBe('available')
  const installed = h.updates.install(); await entered.promise
  expect(h.quit()).toBe(0); expect(agentActivity.suspended).toBe(true)
  const pending = JSON.parse(readFileSync(join(h.root, 'app-update/pending.json'), 'utf8'))
  expect(pending).toMatchObject({ from: '0.5.1', to: '0.6.0', installer: h.installer })
  const sequence = h.calls.filter(c => c !== 'status')
  expect(sequence).toEqual(['capture', 'sidecar-stop', 'close', 'close', 'confirmed', 'resources', 'installer'])
  accepted.resolve(); await installed
  expect(h.quit()).toBe(1); expect(agentActivity.suspended).toBe(true)
  expect(existsSync(h.installer)).toBe(true)
  const student = join(h.root, 'student-data'); writeFileSync(student, 'keep')
  const next = new AppUpdates({ ...h.options, current: '0.6.0' })
  await next.ready
  expect(next.status().message).toContain('마쳤')
  expect(existsSync(h.installer)).toBe(false)
  expect(existsSync(join(h.root, 'app-update/pending.json'))).toBe(false)
  expect(readFileSync(student, 'utf8')).toBe('keep')
})

for (const failure of ['sidecar', 'close', 'confirm', 'resources', 'pending', 'start', 'uac']) test(`handoff failure ${failure} restores app; fresh chat/status/login and cached retry work`, async () => {
  const h = scenario()
  await h.chat.status(h.project, 'claude'); await h.chat.globalStatus('codex')
  await h.updates.check()
  if (failure === 'pending') h.idle(async () => { mkdirSync(join(h.root, 'app-update/pending.json')) })
  else h.fail(failure)
  await expect(h.updates.install()).rejects.toThrow()
  expect(h.quit()).toBe(0); expect(agentActivity.suspended).toBe(false); expect(h.lock.switching).toBe(false)
  expect(h.calls).toContain('sidecar-restart'); expect(existsSync(h.installer)).toBe(true)
  if (['sidecar', 'close', 'confirm', 'resources', 'pending'].includes(failure)) expect(h.calls).not.toContain('installer')
  if (failure === 'start' || failure === 'uac') expect(existsSync(join(h.root, 'app-update/pending.json'))).toBe(false)
  h.fail(''); h.idle(async () => {})
  if (failure === 'pending') rmSync(join(h.root, 'app-update/pending.json'), { recursive: true, force: true })
  await h.chat.status(h.project, 'claude'); await h.chat.globalStatus('codex')
  await h.chat.globalLogin('claude'); await h.chat.globalStatus('claude')
  await h.chat.send(h.project, 'claude', 'retry after failure', 'request-retry'); await h.chat.stop(h.project, 'claude')
  const downloaded = h.requests.filter(url => url !== CHANNEL_URL).length
  await h.updates.install()
  expect(h.quit()).toBe(1)
  expect(h.requests.filter(url => url !== CHANNEL_URL).length).toBe(downloaded)
})

test('installer mutation after resource check is rejected by the immediate pre-launch hash', async () => {
  const h = scenario()
  h.idle(async () => { writeFileSync(h.installer, 'tampered installer') })
  await h.updates.check(); await expect(h.updates.install()).rejects.toThrow(/실행 직전/)
  expect(h.calls).not.toContain('installer'); expect(h.quit()).toBe(0); expect(agentActivity.suspended).toBe(false)
})

test('interrupted launch reuses only the signed verified cached installer', async () => {
  const h = scenario(); await h.updates.check(); await h.updates.install(); agentActivity.resume()
  const restarted = new AppUpdates(h.options)
  await restarted.ready
  expect(restarted.status().phase).toBe('interrupted')
  const requests = h.requests.slice()
  await restarted.install()
  expect(h.requests).toEqual(requests)
  agentActivity.resume()
  writeFileSync(h.installer, 'bad')
  const repaired = new AppUpdates(h.options)
  await repaired.install()
  expect(h.requests.length).toBe(requests.length + 1)
})

for (const missing of ['app', 'win32-x64'] as const) test(`recovered interrupted install survives missing ${missing} channel entry`, async () => {
  const f = fixture(), h = scenario(f)
  expect((await h.updates.check()).phase).toBe('available')
  await h.updates.install()
  expect(existsSync(join(h.root, 'app-update/pending.json'))).toBe(true)
  agentActivity.resume()

  const restarted = new AppUpdates(h.options)
  await restarted.ready
  const interrupted = {
    phase: 'interrupted', latest: '0.6.0', page: releasePage('0.6.0'),
    message: '업데이트가 끝나지 않았어요. 다시 시도할 수 있어요.'
  }
  expect(restarted.status()).toMatchObject(interrupted)
  const channel = f.channel as unknown as Record<string, unknown>
  if (missing === 'app') delete channel.app
  else delete (channel.app as Record<string, unknown>)['win32-x64']

  expect(await restarted.check()).toMatchObject(interrupted)
  const requests = h.requests.slice()
  await restarted.install()
  expect(h.requests).toEqual(requests)
  expect(h.quit()).toBe(2)
})

test('browser login aborts handoff immediately; outstanding probe must finish before any teardown', async () => {
  const h = scenario(); await h.updates.check()
  h.setConnected(false); await h.chat.globalLogin('claude')
  expect(h.chat.hasPendingLogin()).toBe(true)
  await expect(h.updates.install()).rejects.toThrow(/로그인/)
  expect(h.calls).not.toContain('capture'); expect(agentActivity.suspended).toBe(false)
  h.setConnected(true); await h.chat.globalStatus('claude')
  const done = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  h.status(async () => { entered.resolve(); await done.promise })
  const probe = h.chat.status(h.project, 'claude'); await entered.promise
  const installing = h.updates.install()
  await expect.poll(() => agentActivity.suspended).toBe(true)
  expect(h.calls).not.toContain('capture')
  done.resolve(); await probe; await installing
  expect(h.quit()).toBe(1)
})

test('R8-02: post-close and post-resources injections cannot spawn a new connection or external helper', async () => {
  const h = scenario()
  await h.chat.status(h.project, 'claude'); await h.chat.globalStatus('codex')
  const ctx = { home: h.root, appRoot: h.root, isPackaged: true, resourcesPath: h.root, supportDir: join(h.root, 'launch'), userData: join(h.root, 'userData'), dryRun: true, open: async () => '', venvPython: () => null }
  const blocked = async () => {
    const count = h.spawned()
    for (const operation of [
      () => h.chat.status(h.project, 'claude'), () => h.chat.globalStatus('codex'),
      () => h.chat.login(h.project, 'claude'), () => h.chat.globalLogin('codex'), () => h.chat.reopenLogin('claude'),
      () => h.chat.models(h.project, 'codex'), () => h.chat.models(null, 'codex'),
      () => h.chat.send(h.project, 'claude', 'must not run', 'blocked'),
      () => agentApi.status(ctx, h.project), () => agentApi.launch(ctx, { root: h.project, kind: 'claude', revision: null }),
      () => probeVersion(join(h.root, 'must-not-execute'))
    ]) await expect(operation()).rejects.toMatchObject({ code: 'update_suspended' })
    expect(h.spawned()).toBe(count)
    expect(existsSync(join(h.root, 'launch'))).toBe(false)
  }
  h.confirm(blocked); h.idle(blocked)
  await h.updates.check(); await h.updates.install()
  expect(h.quit()).toBe(1)
})

test('drain timeout never stops active work and releases the reversible pause', async () => {
  const done = Promise.withResolvers<void>(), task = agentActivity.run(() => done.promise), calls: string[] = []
  const handoff = new AppHandoff({ timeout: 1, lock: new SkillSwitch(),
    chat: { hasPendingLogin: () => false, flushDrafts: () => {}, closeForUpdate: async () => { calls.push('close') } },
    sidecar: { stop: async () => { calls.push('stop') }, restart: async () => {} },
    windows: { captureOwned: async () => emptySnapshot(), confirmStopped: async () => {}, assertResourcesIdle: async () => {} }
  })
  await expect(handoff.run(async () => { calls.push('launch') })).rejects.toThrow(/작업이 끝난 뒤/)
  expect(calls).toEqual([]); expect(agentActivity.suspended).toBe(false)
  done.resolve(); await task
})

test('Mac only opens a fixed newer release page and never invokes the installer', async () => {
  const h = scenario(), opened: string[] = [], mac = new AppUpdates({ ...h.options, platform: 'darwin', openExternal: async page => { opened.push(page) } })
  expect((await mac.check()).phase).toBe('available'); await mac.openPage()
  expect(opened).toEqual([releasePage('0.6.0')])
  await expect(mac.install()).rejects.toThrow(/Windows/)
  expect(h.calls).not.toContain('installer')
  const f = fixture(); f.channel.app.page = 'https://evil.example/download'
  const bad = scenario(f), rejected = new AppUpdates({ ...bad.options, platform: 'darwin' })
  expect((await rejected.check()).phase).toBe('error'); await expect(rejected.openPage()).rejects.toThrow()
})

test('packaged keys are the pinned production pair and reject a test-signed installer', async () => {
  const h = scenario(), updates = new AppUpdates({ ...h.options, config: updateConfig(true, { KNUAF_UPDATE_PUBLIC_KEY: publicKey, KNUAF_UPDATE_CHANNEL_URL: 'http://127.0.0.1:1' }) })
  expect((await updates.check()).phase).toBe('error'); expect(h.requests).toEqual([CHANNEL_URL])
  await expect(updates.install()).rejects.toThrow(); expect(h.calls).toEqual([])
})

const proc = (pid: number, path: string | null, name = 'claude.exe', parent = 1, created = new Date(pid * 1000).toISOString()): ProcessInfo => ({ pid, path, name, parent, created })
test('D1-a compares canonical Windows boundaries and blocks unreadable bundled names, not Electron or siblings', () => {
  const root = 'C:\\Program Files\\Knuaf\\resources'
  for (const path of [root + '\\codex\\codex.exe', '\\\\?\\C:\\PROGRAM FILES\\KNUAF\\RESOURCES\\app.asar.unpacked\\claude.exe', 'C:/Program Files/Knuaf/resources/python/python.exe']) {
    expect(resourcesBusy([proc(2, path)], root, ['claude.exe', 'python.exe'])).toBe(true)
  }
  expect(resourcesBusy([proc(2, 'C:\\Program Files\\Knuaf\\resources2\\claude.exe')], root, ['claude.exe'])).toBe(false)
  expect(resourcesBusy([proc(2, 'C:\\Program Files\\Knuaf\\knuaf-dev.exe', 'knuaf-dev.exe')], root, ['claude.exe'])).toBe(false)
  expect(resourcesBusy([proc(2, null, 'CLAUDE.EXE')], root, ['claude.exe'])).toBe(true)
  expect(resourcesBusy([proc(2, null, 'unrelated.exe')], root, ['claude.exe'])).toBe(false)
  expect(() => windowsPath('C:\\PROGRA~1\\Knuaf\\resources')).toThrow(/경로/)
  expect(windowsPath('\\\\?\\UNC\\server\\share\\resources')).toBe('\\\\server\\share\\resources')
  expect(windowsPath('\\\\?\\unc\\server\\share\\resources')).toBe('\\\\server\\share\\resources')
})

test('owned tree confirmation retains orphan helpers and uses process creation identity against PID reuse', () => {
  const app = 'C:\\App\\knuaf-dev.exe', outside = proc(9, 'C:\\Other\\parent.exe', 'parent.exe', 0, new Date(500).toISOString())
  const before = [proc(1, app, 'knuaf-dev.exe', 0), proc(2, 'C:\\App\\resources\\codex.exe', 'codex.exe', 1), proc(3, 'C:\\App\\resources\\rg.exe', 'rg.exe', 2), proc(4, app, 'knuaf-dev.exe', 1), outside]
  const watch = new OwnedProcessWatch({ processes: before, appPid: 1, appExecutable: app })
  expect(watch.busy([proc(3, 'C:\\App\\resources\\rg.exe', 'rg.exe', 2)])).toBe(true)
  expect(watch.busy([outside, proc(3, 'C:\\Other.exe', 'Other.exe', 9, new Date(5000).toISOString())])).toBe(false)
})

test('inspect explains every blocking row with the same verdict as busy, and never leaks a raw PID', () => {
  const app = 'C:\\App\\knuaf-dev.exe', at = (ms: number): string => new Date(ms).toISOString()
  // 다른 계정 프로세스: 일반 권한으로는 생성 시각·경로를 읽지 못한다(created '', path null).
  const service = proc(700, null, 'svchost.exe', 5, ''), other = proc(9, 'C:\\Other\\parent.exe', 'parent.exe', 0, at(500))
  const sidecar = proc(20, 'C:\\App\\resources\\python\\python.exe', 'python.exe', 1, at(2000))
  const before = [proc(1, app, 'knuaf-dev.exe', 0, at(1000)), proc(4, app, 'knuaf-dev.exe', 1, at(1500)), sidecar, service, other]
  const fresh = (): OwnedProcessWatch => new OwnedProcessWatch({ processes: before, appPid: 1, appExecutable: app }, 5000)
  const view = (rows: ProcessInfo[]) => { const a = fresh().busy(rows), b = fresh().inspect(rows, true), off = fresh().inspect(rows); expect(b.busy).toBe(a); expect(off).toMatchObject({ busy: a, blocked: b.blocked, counts: b.counts }); expect(off.rows()).toEqual([]); return { ...b, rows: b.rows() } }
  const only = (rows: ProcessInfo[]) => view(rows).rows.filter(r => r.role === 'block')

  // 판독 불가 부모 아래 새 프로세스는 **부모가 처음 목록에서 무관이었어도** 막는다 — 생성 시각
  // 없이는 PID·부모·이름·경로가 같아도 같은 세대라는 보장이 없다(추측으로 '무관'을 만들지 않는다).
  const foreign = view([service, proc(800, 'C:\\Tools\\pythonw3.12.exe', 'pythonw3.12.exe', 700, at(9000))])
  expect(foreign).toMatchObject({ busy: true, blocked: 1, counts: { unknown: 1, unrelated: 1 } })
  expect(foreign.rows.map(r => [r.role, r.kind, r.ownership, r.why])).toEqual([['block', 'pythonw', 'u', 'parent-time-unreadable'], ['ancestor', 'svchost', 'x', 'history']])
  // 실기기 모양: 부모의 생성 시각이 **읽히는** 다른 계정 프로세스(첫 목록에 무관으로 있음) 아래
  // 새 자식은 `parent-live` 로 무관이 된다 — 판정 규칙이 그대로 돌아 F1 없이도 막지 않는다.
  const readable = view([other, proc(900, 'C:\\Tools\\pythonw3.12.exe', 'pythonw3.12.exe', 9, at(9000))])
  expect(readable).toMatchObject({ busy: false, blocked: 0, counts: { unknown: 0, unrelated: 2 } })
  expect(readable.rows).toEqual([])
  // 같은 PID 라도 이름·부모 PID 가 다르면 다른 세대다 → 무관으로 넘기지 않고 그대로 unknown, 막는다.
  const stranger = view([proc(801, 'C:\\Tools\\pythonw3.12.exe', 'pythonw3.12.exe', 700, at(9000)), proc(700, null, 'dllhost.exe', 6, '')])
  expect(stranger.busy).toBe(true); expect(stranger.counts).toMatchObject({ unknown: 2, unrelated: 0 })
  expect(stranger.rows.map(r => [r.role, r.kind, r.ownership, r.why])).toEqual([['block', 'pythonw', 'u', 'parent-time-unreadable'], ['ancestor', 'dllhost', 'u', 'parent-missing']])
  // 첫 목록에 없던 판독 불가 부모 아래 새 행 — 계보를 댈 수 없으니 unknown, 막는다.
  const scheduled = view([proc(800, 'C:\\Tools\\pythonw3.12.exe', 'pythonw3.12.exe', 600, at(9000)), proc(600, null, 'wmiprvse.exe', 5, '')])
  expect(scheduled.busy).toBe(true); expect(scheduled.counts).toMatchObject({ unknown: 2 })
  expect(scheduled.rows.map(r => [r.role, r.kind, r.ownership, r.why])).toEqual([['block', 'pythonw', 'u', 'parent-time-unreadable'], ['ancestor', 'wmiprvse', 'u', 'parent-missing']])
  expect(scheduled.rows[0].parentId).toBe(scheduled.rows[1].id); expect(scheduled.rows[1].parentId).toBe('gone')
  // 같은 판독 불가 부모라도 예외 둘이 먼저다: 부모가 앱이면 owned, 이력의 owned 세대가 먼저 태어났으면 owned.
  expect(only([proc(30, null, 'taskkill.exe', 1, '')])[0]).toMatchObject({ kind: 'taskkill', ownership: 'o', why: 'parent-app', parentId: 'app', pathRead: false, bornMs: null })
  expect(only([proc(21, 'C:\\Tools\\pip.exe', 'pip.exe', 20, at(3000))])[0]).toMatchObject({ kind: 'other', ownership: 'o', why: 'parent-history' })
  // 부모가 이미 죽었고 이력에도 없다 / 부모 PID 가 나중에 태어난 다른 프로세스다.
  expect(only([proc(40, 'C:\\x\\cmd.exe', 'cmd.exe', 555, at(9000))])[0]).toMatchObject({ kind: 'cmd', ownership: 'u', why: 'parent-missing', parentId: 'gone' })
  expect(only([other, proc(41, 'C:\\x\\node.exe', 'node.exe', 9, at(100))])[0]).toMatchObject({ ownership: 'u', why: 'parent-reused', parentId: 'gone' })
  // 이력의 owned 부모가 죽고 같은 PID 를 늦게 태어난 다른 프로세스가 쓴다 — 부모 번호는 판정에 쓴 옛 세대를 가리킨다.
  const reused = view([proc(20, 'C:\\Other\\late.exe', 'late.exe', 555, at(8000)), proc(21, 'C:\\Tools\\pip.exe', 'pip.exe', 20, at(3000))]).rows
  const pip = reused.find(r => r.why === 'parent-history')!, late = reused.find(r => r.why === 'parent-missing')!, old = reused.find(r => r.kind === 'python')!
  expect(old).toMatchObject({ role: 'ancestor', ownership: 'o', parentId: 'app' }); expect(pip.parentId).toBe(old.id); expect(late.id).not.toBe(old.id)
  // 앱 자손인데 경로를 못 읽으면 도우미 제외를 못 받는다. 경로가 읽히면 제외된다.
  expect(only([proc(4, null, 'knuaf-dev.exe', 1, at(1500))])[0]).toMatchObject({ ownership: 'o', why: 'history', pathRead: false })
  expect(view([proc(4, app, 'knuaf-dev.exe', 1, at(1500))])).toMatchObject({ busy: false, blocked: 0, counts: { helper: 1 } })
  // 임시 번호만 쓴다: 어느 행에도 PID 원값이 번호로 나오지 않고, 가리키는 부모는 같은 표본에 실려 있다.
  const pids = new Set([700, 800, 30, 21, 40, 41])
  for (const row of scheduled.rows) { expect(pids.has(row.id)).toBe(false); if (typeof row.parentId === 'number') expect(scheduled.rows.some(r => r.id === row.parentId)).toBe(true) }
  // 깊은 계보는 6칸에서 끊고 마지막 행의 부모를 cut 으로 적는다 — 로그에 없는 번호를 내지 않는다.
  const chain = Array.from({ length: 10 }, (_, i) => proc(100 + i, `C:\\x\\n${i}.exe`, 'node.exe', i ? 99 + i : 555, at(9000 + i)))
  const deep = view([...chain].reverse()).rows
  expect(deep.some(r => r.parentId === 'cut')).toBe(true)
  expect(deep.every(r => typeof r.parentId !== 'number' || deep.some(x => x.id === r.parentId))).toBe(true)
  expect(deep.some(r => r.parentId === 'gone')).toBe(true)
})

test('confirm and handoff diagnostics are silent without KNUAF_APP_LOG and name the blocking row with it', async () => {
  const root = temporary(), file = join(root, 'diag.log'), saved = process.env.KNUAF_APP_LOG
  // 무관한 행 하나 + 첫 목록에 없던 판독 불가 부모 아래 새 프로세스(막는 행, 부모도 조상으로 실린다).
  const clean = proc(9, 'C:\\Other\\parent.exe', 'parent.exe', 0)
  const rows = [clean, proc(800, 'C:\\Tools\\secret-tool.exe', 'secret-tool.exe', 700), proc(700, null, 'svchost.exe', 4, '')]
  const runtime = new WindowsUpdateRuntime(root, 'C:\\App\\app.exe', 1, async () => JSON.stringify({ resources: 'C:\\App\\resources', appExecutable: 'C:\\App\\app.exe', processes: rows }))
  const snapshot = { ...emptySnapshot(), processes: [clean] }
  const handoff = (fail: boolean): AppHandoff => new AppHandoff({
    chat: { hasPendingLogin: () => false, flushDrafts: () => {}, closeForUpdate: async confirm => { await confirm() } },
    sidecar: { stop: async () => {}, restart: async () => {} }, activity: new AgentActivity(), lock: new SkillSwitch(),
    windows: { captureOwned: async () => snapshot, confirmStopped: before => runtime.confirmStopped(before, 0), assertResourcesIdle: async () => { if (fail) throw new Error('busy') } }
  })
  // 파일이 없다는 것만으로는 진단 일을 안 했다는 뜻이 아니다 — 근거 조립을 실제로 불렀는지 센다.
  const inspect = OwnedProcessWatch.prototype.inspect, asked: boolean[] = []; let assembled = 0
  OwnedProcessWatch.prototype.inspect = function (processes, detail) {
    asked.push(!!detail); const view = inspect.call(this, processes, detail)
    return { ...view, rows: () => { assembled++; return view.rows() } }
  }
  // 진단은 인계 확인이 끝난 다음 차례에 쓴다 — 읽기 전에 한 차례 넘긴다.
  const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
  try {
    delete process.env.KNUAF_APP_LOG
    await expect(runtime.confirmStopped(snapshot, 0)).rejects.toThrow(/종료/)
    // MIN_SAMPLES=3: 마감(timeout 0)이 지나도 표본 3번을 채운 뒤에 판정한다 — 진단이 꺼져 있어도 같다.
    await settle(); expect(existsSync(file)).toBe(false); expect(asked).toEqual([false, false, false]); expect(assembled).toBe(0)
    process.env.KNUAF_APP_LOG = file
    await expect(runtime.confirmStopped(snapshot, 0)).rejects.toThrow(/종료/)
    // 판정 경로는 꺼짐과 같은 호출(근거 없음) 세 번뿐이고, 돌아온 시점에는 아직 아무것도 쓰지 않았다.
    expect(asked).toEqual([false, false, false, false, false, false]); expect(assembled).toBe(0); expect(existsSync(file)).toBe(false)
    // settle 뒤 재생은 표본마다 한 번씩 — 표본 3개면 재생 3번, 근거 조립 3번.
    await settle(); expect(asked).toEqual([false, false, false, false, false, false, true, true, true]); expect(assembled).toBe(3)
    // 바쁜 표본 뒤에도 조회가 이어지고, 조회 도중에는 파일이 비어 있다.
    writeFileSync(file, ''); let calls = 0, during = ''
    const slow = new WindowsUpdateRuntime(root, 'C:\\App\\app.exe', 1, async () => { if (calls++) during += readFileSync(file, 'utf8'); return JSON.stringify({ resources: 'C:\\App\\resources', appExecutable: 'C:\\App\\app.exe', processes: calls > 2 ? [rows[0]] : rows }) })
    await slow.confirmStopped(snapshot, 5_000)
    expect(during).toBe(''); expect(readFileSync(file, 'utf8')).toBe(''); await settle(); expect(readFileSync(file, 'utf8')).toMatch(/confirm:sample n=1 [^\n]*busy=1[\s\S]*confirm:sample n=3 [^\n]*busy=0[\s\S]*confirm:end result=ok samples=3/)
    writeFileSync(file, ''); await expect(runtime.confirmStopped(snapshot, 0)).rejects.toThrow(/종료/); await settle()
    // 조회가 던지면 붙잡은 표본 없이 끝 줄만 남는다.
    const broken = new WindowsUpdateRuntime(root, 'C:\\App\\app.exe', 1, async () => { throw new Error('shell') })
    await expect(broken.confirmStopped(snapshot, 0)).rejects.toThrow('shell'); await settle()
    expect(readFileSync(file, 'utf8')).toMatch(/confirm:end result=error samples=0 elapsed=-/)
    const log = readFileSync(file, 'utf8')
    expect(log).toMatch(/confirm:sample n=1 at=\d+ms inventoryMs=\d+ rows=3 busy=1 owned=0 unknown=2 unrelated=1 helper=0/)
    expect(log).toMatch(/confirm:block n=1 role=block id=\d+ parent=\d+ kind=other own=u why=parent-time-unreadable path=1 born=/)
    expect(log).toMatch(/confirm:block n=1 role=ancestor id=\d+ parent=gone kind=svchost own=u why=parent-missing path=0 born=-/)
    // 마감(timeout 0)이 지나도 MIN_SAMPLES=3 을 채운 뒤에 실패한다.
    expect(log).toMatch(/confirm:end result=deadline samples=3 elapsed=\d+ms/)
    expect(log).not.toMatch(/secret-tool|Tools|id=(?:800|700)\b|parent=(?:800|700)\b/)
    rows.length = 1; writeFileSync(file, '')
    await handoff(false).run(async () => {}); await settle()
    const ok = readFileSync(file, 'utf8')
    expect(ok).toMatch(/confirm:end result=ok samples=1/)
    expect([...ok.matchAll(/handoff:step name=(\w+) ms=\d+ ok=1/g)].map(m => m[1])).toEqual(['drain', 'capture', 'sidecar', 'chat', 'resources', 'transfer'])
    writeFileSync(file, '')
    await expect(handoff(true).run(async () => {})).rejects.toThrow(/busy/)
    expect(readFileSync(file, 'utf8')).toMatch(/handoff:step name=resources ms=\d+ ok=0 error=Error/)
    // 하위 작업이 던진 임의의 code 문자열(실행 파일 이름일 수도 있다)은 그대로 싣지 않는다.
    writeFileSync(file, '')
    await expect(handoff(false).run(async () => { throw Object.assign(new Error('x'), { code: 'tool.exe' }) })).rejects.toThrow('x')
    const failed = readFileSync(file, 'utf8')
    expect(failed).toMatch(/handoff:step name=transfer ms=\d+ ok=0 error=other/); expect(failed).not.toMatch(/tool\.exe/)
  } finally {
    OwnedProcessWatch.prototype.inspect = inspect
    if (saved === undefined) delete process.env.KNUAF_APP_LOG
    else process.env.KNUAF_APP_LOG = saved
  }
})

test('confirmStopped starts the deadline at the first sample and never stops before MIN_SAMPLES', async () => {
  const root = temporary()
  const reply = (processes: ProcessInfo[]) => JSON.stringify({ resources: 'C:\\App\\resources', appExecutable: 'C:\\App\\app.exe', processes })
  // 첫 목록에 없는 부모를 가진 행 — 표본마다 늘 막는 행(unknown).
  const blocked = proc(800, 'C:\\Tools\\secret-tool.exe', 'secret-tool.exe', 700)
  const wait = (ms: number): Promise<void> => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise }
  // 조회마다 지연을 주고, 호출이 **돌아온** 시각을 적는다.
  const fake = (delay: number | ((n: number) => number), answer: (n: number) => ProcessInfo[]) => {
    const returned: number[] = []
    const shell = async (): Promise<string> => { const n = returned.length + 1; await wait(typeof delay === 'function' ? delay(n) : delay); returned.push(Date.now()); return reply(answer(n)) }
    return { runtime: new WindowsUpdateRuntime(root, 'C:\\App\\app.exe', 1, shell), returned }
  }
  // ① 마감은 첫 조회가 돌아온 **뒤**부터 센다: 첫 조회가 마감(100ms)보다 느리면(300ms) 다음 표본까지
  //    마감만큼(≈100ms) 기다린다. 첫 조회 전에 마감을 잡으면 이미 지나 있어 간격이 0 이 된다.
  const late = fake(n => n === 1 ? 300 : 0, () => [blocked])
  await expect(late.runtime.confirmStopped(emptySnapshot(), 100)).rejects.toThrow(/종료/)
  expect(late.returned.length).toBe(3)
  expect(late.returned[1] - late.returned[0]).toBeGreaterThanOrEqual(50)
  // ② 마감이 지나도 최소 표본 수(3)는 채운다 — 조회 하나가 마감보다 느린 경우에도 표본이 깎이지 않는다.
  const slow = fake(40, () => [blocked])
  await expect(slow.runtime.confirmStopped(emptySnapshot(), 25)).rejects.toThrow(/종료/)
  expect(slow.returned.length).toBe(3)
  // ③ 둘째 표본에서 풀리면 최소 표본 수를 채우지 않고 바로 성공한다.
  const settles = fake(20, n => n === 1 ? [blocked] : [])
  await settles.runtime.confirmStopped(emptySnapshot(), 500)
  expect(settles.returned.length).toBe(2)
  // ④ 계속 바쁘면 표본 3번을 채운 뒤 같은 문구로 실패한다 — 조회 하나의 상한이 있어 끝없이 늘지 않는다.
  const stuck = fake(120, () => [blocked])
  await expect(stuck.runtime.confirmStopped(emptySnapshot(), 50)).rejects.toThrow('대화 도우미 프로세스 종료를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  expect(stuck.returned.length).toBe(3)
  // ⑤ 느린 조회가 최소 표본을 채우기 전에 상한(50ms)을 넘기면 첫 표본에서 바로 막는다 — 상한은
  //    마감(`end`)과 따로 보므로, 마감(10초)이 아직 멀어도 새 조회를 예약하지 않는다.
  const capped = fake(80, () => [blocked])
  await expect(capped.runtime.confirmStopped(emptySnapshot(), 10_000, 50)).rejects.toThrow('대화 도우미 프로세스 종료를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  expect(capped.returned.length).toBe(1)
})

test('native inventory consumes expanded 8.3 paths; tree and resources checks fail closed on missing helpers', async () => {
  const root = temporary(); writeFileSync(join(root, 'rg.exe'), 'bundled helper')
  let rows = [proc(3, 'C:\\Program Files\\Knuaf\\resources\\rg.exe', 'rg.exe', 1)]
  const runtime = new WindowsUpdateRuntime(root, 'C:\\PROGRA~1\\Knuaf\\app.exe', 1, async () => JSON.stringify({ resources: 'C:\\Program Files\\Knuaf\\resources', appExecutable: 'C:\\Program Files\\Knuaf\\app.exe', processes: rows }))
  await expect(runtime.assertResourcesIdle()).rejects.toThrow(/도우미 창/)
  await expect(runtime.confirmStopped({ ...emptySnapshot(), processes: rows }, 0)).rejects.toThrow(/종료/)
  rows = []
  await runtime.assertResourcesIdle(); await runtime.confirmStopped({ ...emptySnapshot(), processes: [proc(3, null, 'rg.exe')] }, 0)
  const malformed = new WindowsUpdateRuntime(root, 'C:\\App\\app.exe', 1, async () => '{"processes":null}')
  await expect(malformed.captureOwned()).rejects.toThrow(/목록/)
})


test('corrupt downloaded installer never reaches handoff or execution', async () => {
  const f = fixture(), h = scenario(f)
  const updates = new AppUpdates({ ...h.options, fetch: async url => new Response(url === CHANNEL_URL ? JSON.stringify(f.channel) : Buffer.alloc(f.bytes.length)) })
  await updates.check()
  await expect(updates.install()).rejects.toMatchObject({ code: 'runtime_hash_mismatch' })
  expect(h.calls).toEqual([]); expect(h.quit()).toBe(0)
  expect(existsSync(join(h.root, 'app-update/pending.json'))).toBe(false)
})

test('cancel while draining leaves cached installer but never starts it', async () => {
  const h = scenario(), done = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  h.status(async () => { entered.resolve(); await done.promise })
  const probe = h.chat.globalStatus('claude'); await entered.promise
  await h.updates.check()
  const install = h.updates.install()
  const cancelled = expect(install).rejects.toThrow(/취소/)
  await expect.poll(() => agentActivity.suspended).toBe(true)
  expect(h.updates.cancel()).toBe(true)
  done.resolve(); await probe; await cancelled
  expect(h.calls).not.toContain('installer'); expect(h.quit()).toBe(0)
  expect(agentActivity.suspended).toBe(false)
  expect(existsSync(h.installer)).toBe(true)
})


test('failed recovery remains paused; retry completes recovery before admitting a new handoff', async () => {
  let failRecovery = true, failTransfer = true, launched = false
  const handoff = new AppHandoff({ lock: new SkillSwitch(),
    chat: { hasPendingLogin: () => false, flushDrafts: () => {}, closeForUpdate: async confirm => { await confirm() } },
    sidecar: { stop: async () => {}, restart: async () => { if (failRecovery) throw new Error('recovery failed') } },
    windows: { captureOwned: async () => emptySnapshot(), confirmStopped: async () => {}, assertResourcesIdle: async () => { if (failTransfer) throw new Error('resources busy') } }
  })
  await expect(handoff.run(async () => { launched = true })).rejects.toThrow(/복구/)
  expect(agentActivity.suspended).toBe(true)
  expect(() => agentActivity.enter()).toThrow(/준비/)
  expect(launched).toBe(false)
  failRecovery = false; failTransfer = false
  await handoff.run(async () => { launched = true })
  expect(launched).toBe(true)
})

test('a redirected installer cache cannot create or overwrite files outside its store', async () => {
  const h = scenario(), outside = join(h.root, 'student-folder')
  mkdirSync(outside); writeFileSync(join(outside, 'student.txt'), 'keep')
  symlinkSync(outside, join(h.root, 'app-update'), process.platform === 'win32' ? 'junction' : 'dir')
  await h.updates.check()
  await expect(h.updates.install()).rejects.toThrow(/보관 경로/)
  expect(existsSync(join(outside, '0.6.0'))).toBe(false)
  expect(readFileSync(join(outside, 'student.txt'), 'utf8')).toBe('keep')
  expect(h.calls).toEqual([])
})

test('ordinary app shutdown also closes connections quarantined by a failed update', async () => {
  const root = temporary(), live = new Set<number>()
  let next = 0, fail = true
  const chat = new ChatService({ skillSource: () => root, userData: root, emit: () => {}, openExternal: async () => {}, connectionFactory: () => {
    const id = next++; live.add(id)
    return {
      status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, run: async () => {}, respond: () => {},
      stop: async () => { if (id === 0 && fail) throw new Error('old connection close failed'); live.delete(id) }
    }
  } })
  await chat.status(root, 'claude'); await chat.globalStatus('codex')
  await expect(chat.closeForUpdate(async () => {})).rejects.toThrow(/old connection/)
  expect(live).toEqual(new Set([0]))
  fail = false
  await chat.status(root, 'claude')
  expect(live).toEqual(new Set([0, 2]))
  await chat.close()
  expect(live).toEqual(new Set())
})
