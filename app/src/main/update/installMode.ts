import { win32 } from 'node:path'
import { object } from './manifest'

/**
 * electron-builder appId. The NSIS installer records its install location under a
 * registry key derived from it, so a change here silently changes the installer's
 * own "나만/모든 사용자" decision. Kept in sync with app/electron-builder.yml.
 */
export const APP_ID = 'kr.ac.knuaf.doc.companion'
/** UUID.v5(APP_ID, electron-builder's fixed NSIS namespace). */
export const APP_GUID = '37ee5a87-974a-5c53-b05e-dfb346d9d779'

export type InstallMode = 'user' | 'machine' | 'unknown'
export type InstallRecord = { status: 'present'; path: string } | { status: 'absent' | 'unknown'; path: null }
export interface InstallFacts {
  executable: string
  localAppData: string | null
  programFiles: string | null
  programFilesX86: string | null
  user: InstallRecord
  machine: InstallRecord
}
export type ScriptRunner = (script: string, timeout: number) => Promise<string>

/**
 * Electron runs as the same user the installer will run as, so these reads see
 * the two install records NSIS's initMultiUser reads: HKLM/HKCU
 * "Software\<APP_GUID>" InstallLocation. Only a missing key/value is reported as
 * absent; every present value is passed through verbatim so that a non-string
 * type (DWORD, multi-string, binary) becomes uncertainty in TS, never "no record".
 */
const REGISTRY_KEY = `Software\\${APP_GUID}`
export const REGISTRY_SCRIPT = `$ErrorActionPreference='Stop'
function Read-InstallRecord($hive) {
  try {
    $key = $hive.OpenSubKey('${REGISTRY_KEY}')
    if ($null -eq $key) { return @{ present = $false } }
    try { $value = $key.GetValue('InstallLocation', $null) } finally { $key.Close() }
    if ($null -eq $value) { return @{ present = $false } }
    return @{ present = $true; value = $value }
  } catch { return @{ error = $true } }
}
@{ user = (Read-InstallRecord ([Microsoft.Win32.Registry]::CurrentUser)); machine = (Read-InstallRecord ([Microsoft.Win32.Registry]::LocalMachine)) } | ConvertTo-Json -Depth 4 -Compress`

const normalized = (path: string | null): string | null => {
  if (!path || path.includes('\0') || !win32.isAbsolute(path)) return null
  return win32.normalize(path).replace(/\\+$/, '').toLowerCase()
}
const within = (dir: string, root: string | null): boolean => root !== null && (dir === root || dir.startsWith(root + '\\'))
const record = (value: unknown): InstallRecord => {
  const data = object(value)
  if (data.error === true) return { status: 'unknown', path: null }
  if (data.present === false) return { status: 'absent', path: null }
  // Anything short of an exact "present with a path" is uncertainty, never absence.
  if (data.present !== true || typeof data.value !== 'string' || !data.value || data.value.includes('\0')) throw new Error('설치 기록이 온전하지 않아요.')
  return { status: 'present', path: data.value }
}
export function parseInstallRecords(text: string): Pick<InstallFacts, 'user' | 'machine'> {
  const data = object(JSON.parse(text))
  return { user: record(data.user), machine: record(data.machine) }
}

/**
 * Only a proved per-user installation may launch without elevation. Any
 * contradiction or unreadable record falls back to the admin request.
 */
export function classifyInstallMode(facts: InstallFacts): InstallMode {
  const executable = normalized(facts.executable)
  if (!executable) return 'unknown'
  const dir = win32.dirname(executable)
  const local = normalized(facts.localAppData ? win32.join(facts.localAppData, 'Programs') : null)
  const programFiles = normalized(facts.programFiles)
  const programFilesX86 = normalized(facts.programFilesX86)
  if (facts.machine.status === 'present' && normalized(facts.machine.path) === dir) return 'machine'
  // Program Files is not writable without elevation, whatever the records claim.
  if (within(dir, programFiles) || within(dir, programFilesX86)) return 'machine'
  if (facts.machine.status === 'unknown' || facts.user.status === 'unknown') return 'unknown'
  if (facts.machine.status === 'present') return 'machine'
  if (facts.user.status === 'present' && normalized(facts.user.path) === dir) return 'user'
  // The default per-user location is a fallback only when BOTH records are
  // cleanly absent. A conflicting or malformed record must not be read as
  // "no record": NSIS would follow the record's own INSTDIR, so stay elevated.
  if (facts.user.status === 'absent' && facts.machine.status === 'absent' && within(dir, local)) return 'user'
  return 'unknown'
}

export async function detectInstallMode(executable: string, env: NodeJS.ProcessEnv, run: ScriptRunner): Promise<InstallMode> {
  try {
    const records = parseInstallRecords(await run(REGISTRY_SCRIPT, 10_000))
    return classifyInstallMode({
      executable,
      localAppData: env.LOCALAPPDATA ?? null,
      programFiles: env.ProgramFiles ?? null,
      programFilesX86: env['ProgramFiles(x86)'] ?? null,
      ...records
    })
  } catch {
    return 'unknown'
  }
}