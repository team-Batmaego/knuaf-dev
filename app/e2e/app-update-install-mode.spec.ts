import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_GUID, APP_ID, REGISTRY_SCRIPT, classifyInstallMode, detectInstallMode, type InstallFacts, type InstallMode } from '../src/main/update/installMode'
import type { InstallerLaunch } from '../src/main/update/nativeInstaller'
import { WindowsUpdateRuntime, type PowerShell } from '../src/main/update/windows'

const userExe = 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev\\KNUAF-Dev.exe'
const facts = (patch: Partial<InstallFacts> = {}): InstallFacts => ({
  executable: userExe,
  localAppData: 'C:\\Users\\student\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  user: { status: 'absent', path: null },
  machine: { status: 'absent', path: null },
  ...patch
})
const request: InstallerLaunch = { userData: 'C:\\data', path: 'C:\\data\\app-update\\0.6.0\\installer.exe', version: '0.6.0', size: 1, sha256: 'a'.repeat(64) }
const runs = (mode: () => Promise<InstallMode>, reply = '{"started":true,"pid":42}') => {
  const launches: (InstallerLaunch & { elevate: boolean })[] = [], scripts: string[] = []
  const shell: PowerShell = async (script, _timeout, launch) => {
    if (!launch) throw new Error('launch request missing')
    scripts.push(script); launches.push(launch); return reply
  }
  return { launches, scripts, runtime: new WindowsUpdateRuntime('C:\\App\\resources', 'C:\\App\\app.exe', 1, shell, mode) }
}

test('only a proved per-user installation is classified as non-elevated', () => {
  // Default per-user location with no records at all: NSIS itself would install per user.
  expect(classifyInstallMode(facts())).toBe('user')
  // A custom directory is trusted only through the matching per-user install record.
  expect(classifyInstallMode(facts({ executable: 'D:\\Helper\\knuaf-dev.exe', user: { status: 'present', path: 'd:\\helper' } }))).toBe('user')
  expect(classifyInstallMode(facts({ user: { status: 'present', path: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev' }, machine: { status: 'present', path: 'C:\\Program Files\\knuaf-dev' } }))).toBe('user')
  expect(classifyInstallMode(facts({ executable: 'D:\\Helper\\knuaf-dev.exe' }))).toBe('unknown')
  // All-users evidence wins even when the per-user record also matches.
  expect(classifyInstallMode(facts({ machine: { status: 'present', path: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev' } }))).toBe('machine')
  expect(classifyInstallMode(facts({ executable: 'D:\\Helper\\knuaf-dev.exe', user: { status: 'present', path: 'D:\\Helper' }, machine: { status: 'present', path: 'D:\\Helper' } }))).toBe('machine')
  expect(classifyInstallMode(facts({ executable: 'D:\\Other\\knuaf-dev.exe', machine: { status: 'present', path: 'D:\\Helper' } }))).toBe('machine')
  // Program Files is never writable without elevation, whatever the records claim.
  expect(classifyInstallMode(facts({ executable: 'C:\\Program Files\\knuaf-dev\\KNUAF-Dev.exe' }))).toBe('machine')
  expect(classifyInstallMode(facts({ executable: 'C:\\Program Files (x86)\\knuaf-dev\\KNUAF-Dev.exe', programFiles: null }))).toBe('machine')
  // A conflicting or unreadable per-user record is not "no record": the default
  // path may not fall through to a non-elevated launch.
  expect(classifyInstallMode(facts({ user: { status: 'present', path: 'D:\\OldInstall' } }))).toBe('unknown')
  expect(classifyInstallMode(facts({ user: { status: 'present', path: 'relative-invalid' } }))).toBe('unknown')
  expect(classifyInstallMode(facts({ user: { status: 'present', path: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev-other' } }))).toBe('unknown')
  // Unreadable or contradictory records fall back to the admin request.
  expect(classifyInstallMode(facts({ machine: { status: 'unknown', path: null } }))).toBe('unknown')
  expect(classifyInstallMode(facts({ user: { status: 'unknown', path: null } }))).toBe('unknown')
  expect(classifyInstallMode(facts({ executable: 'D:\\Helper\\knuaf-dev.exe', user: { status: 'present', path: 'D:\\Old' } }))).toBe('unknown')
  expect(classifyInstallMode(facts({ executable: 'knuaf-dev.exe' }))).toBe('unknown')
  expect(classifyInstallMode(facts({ executable: '\\\\server\\share\\knuaf-dev.exe', user: { status: 'absent', path: null } }))).toBe('unknown')
})

test('install mode detection reads only exact install records and fails closed', async () => {
  const detect = (records: unknown, env: NodeJS.ProcessEnv = { LOCALAPPDATA: 'C:\\Users\\student\\AppData\\Local' }) =>
    detectInstallMode(userExe, env, async () => JSON.stringify(records))
  expect(await detect({ user: { present: true, value: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev' }, machine: { present: false } })).toBe('user')
  expect(await detect({ user: { present: false }, machine: { present: false } })).toBe('user')
  expect(await detect({ user: { present: true, value: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev' }, machine: { present: true, value: 'C:\\Program Files\\knuaf-dev' } })).toBe('user')
  expect(await detect({ user: { present: false }, machine: { present: true, value: 'C:\\Program Files\\knuaf-dev' } })).toBe('machine')
  // Conflict at the default per-user location: the record's own INSTDIR wins inside
  // NSIS, so this must stay on the admin side rather than run non-elevated.
  expect(await detect({ user: { present: true, value: 'D:\\OldInstall' }, machine: { present: false } })).toBe('unknown')
  expect(await detect({ user: { present: true, value: 'relative-invalid' }, machine: { present: false } })).toBe('unknown')
  expect(await detect({ user: { present: true, value: ['D:\\OldInstall'] }, machine: { present: false } })).toBe('unknown')
  expect(await detect({ user: { error: true }, machine: { present: false } })).toBe('unknown')
  expect(await detect({ user: { present: true, value: 42 }, machine: { present: false } })).toBe('unknown')
  expect(await detect({ user: { present: 'yes' }, machine: { present: false } })).toBe('unknown')
  expect(await detect({})).toBe('unknown')
  expect(await detect({ user: { error: true }, machine: { error: true } })).toBe('unknown')
  expect(await detectInstallMode(userExe, {}, async () => { throw new Error('registry unavailable') })).toBe('unknown')
})

test('registry producer reports absent only for a missing key or value', () => {
  // The PowerShell side must not downgrade a present non-string value (DWORD,
  // multi-string, binary) to "no record": TS is what turns it into uncertainty.
  expect(REGISTRY_SCRIPT).toContain('if ($null -eq $key) { return @{ present = $false } }')
  expect(REGISTRY_SCRIPT).toContain('if ($null -eq $value) { return @{ present = $false } }')
  expect(REGISTRY_SCRIPT).toContain('return @{ present = $true; value = $value }')
  expect(REGISTRY_SCRIPT).not.toMatch(/-isnot \[string\]|-is \[string\]/)
})

test('registry key stays derived from the packaged appId', () => {
  const yml = readFileSync(join(__dirname, '../electron-builder.yml'), 'utf8')
  const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1]
  expect(appId).toBe(APP_ID)
  // electron-builder: UUID.v5(appId, "50e065bc-3134-11e6-9bab-38c9862bdaf3").
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')
  const digest = createHash('sha1').update(namespace).update(Buffer.from(APP_ID, 'utf8')).digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  expect(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`).toBe(APP_GUID)
})

test('installer launch elevates for machine or uncertain modes only', async () => {
  const user = runs(async () => 'user')
  await user.runtime.startInstaller(request)
  expect(user.launches[0].elevate).toBe(false)
  expect(user.scripts[0]).toContain(',$false)')

  for (const mode of ['machine', 'unknown'] as const) {
    const launched = runs(async () => mode)
    await launched.runtime.startInstaller(request)
    expect(launched.launches[0].elevate).toBe(true)
    expect(launched.scripts[0]).toContain(',$true)')
  }
  const failed = runs(async () => { throw new Error('detection failed') })
  await failed.runtime.startInstaller(request)
  expect(failed.launches[0].elevate).toBe(true)
})

test('stale machine install record does not elevate consecutive per-user updates', async () => {
  const installed = runs(async () => classifyInstallMode(facts({
    user: { status: 'present', path: 'C:\\Users\\student\\AppData\\Local\\Programs\\knuaf-dev' },
    machine: { status: 'present', path: 'C:\\Program Files\\knuaf-dev' }
  })))
  await installed.runtime.startInstaller(request)
  await installed.runtime.startInstaller({ ...request, version: '0.6.1', path: 'C:\\data\\app-update\\0.6.1\\installer.exe' })
  expect(installed.launches.map(({ elevate }) => elevate)).toEqual([false, false])
})

test('non-elevated launch preserves cancelled, failed and unknown acknowledgements', async () => {
  for (const reply of ['{"started":false,"cancelled":true}', '{"started":false,"cancelled":false}']) {
    const launched = runs(async () => 'user', reply)
    await expect(launched.runtime.startInstaller(request)).rejects.toThrow(reply.includes('true') ? /취소/ : /시작하지 못했어요/)
  }
  for (const reply of ['', 'noise\n{"started":true,"pid":42}', '{"started":true}', '{"started":false}']) {
    const launched = runs(async () => 'user', reply)
    await expect(launched.runtime.startInstaller(request)).rejects.toMatchObject({ code: 'installer_unknown' })
  }
})