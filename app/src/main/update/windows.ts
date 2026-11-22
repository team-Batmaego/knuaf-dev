import { execFile } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { hash, object, version } from './manifest'
import { NATIVE_FILES } from './nativeFiles'
import { NATIVE_INSTALLER, type InstallerLaunch } from './nativeInstaller'
import { MAX_BLOCK_ROWS, OwnedProcessWatch, resourcesBusy, type ProcessInfo, type ProcessSnapshot } from './processes'
import { NATIVE_PROCESSES } from './nativeProcesses'
import { detectInstallMode, type InstallMode } from './installMode'
import { diag, diagEnabled } from '../diagLog'

/** 어느 호출이 실패했는지 진단에 남기는 이름 — 동작에는 쓰지 않는다. */
export type ShellPhase = 'inventory' | 'mode' | 'install'
export type PowerShell = (script: string, timeout: number, launch?: InstallerLaunch & { elevate: boolean }, phase?: ShellPhase) => Promise<string>
/** stderr 본문은 싣지 않는다 — 알려진 오류 종류 이름만 고른다. */
const SHELL_ERRORS = ['InvalidOperationException', 'Win32Exception', 'UnauthorizedAccessException', 'IOException', 'ParseException', 'RuntimeException'] as const
function shellErrorKind(stderr: string): string {
  return SHELL_ERRORS.find(name => stderr.includes(name)) ?? 'other'
}
/** 인계 확인 한 번이 붙잡아 두는 표본 수의 상한(마지막 표본은 상한과 무관하게 남긴다). */
const MAX_TRACE_SAMPLES = 80
/** 마감이 지나도 이만큼은 조회한다 — 느린 조회 한두 번으로 '종료 확인'을 끝내지 않는다. */
const MIN_SAMPLES = 3
/** 최소 표본을 채우는 데 쓰는 시간의 상한 — 느린 조회가 표본 수를 채우며 확인을 끝없이 늘리지 않게. */
const CONFIRM_HARD_MS = 20_000
interface TraceSample { n: number; asked: number; at: number; rows: ProcessInfo[] }
type TraceResult = 'ok' | 'deadline' | 'error'
/**
 * 인계 확인이 끝난 뒤에 부른다. 같은 처음 목록과 같은 표본 순서를 새 감시에 다시 넣으면 분류가
 * 그대로 재현된다(분류는 입력 순서에만 달려 있다) — 판정에 쓴 감시는 건드리지 않는다.
 */
function writeTrace(before: ProcessSnapshot, started: number, samples: TraceSample[], count: number, result: TraceResult, finished: number): void {
  const watch = new OwnedProcessWatch(before, started)
  for (const { n, asked, at, rows } of samples) {
    const view = watch.inspect(rows, true)
    diag(`confirm:sample n=${n} at=${at - started}ms inventoryMs=${at - asked} rows=${rows.length} busy=${view.busy ? 1 : 0} owned=${view.counts.owned} unknown=${view.counts.unknown} unrelated=${view.counts.unrelated} helper=${view.counts.helper}`)
    for (const row of view.rows()) diag(`confirm:block n=${n} role=${row.role} id=${row.id} parent=${row.parentId} kind=${row.kind} own=${row.ownership} why=${row.why} path=${row.pathRead ? 1 : 0} born=${row.bornMs === null ? '-' : `${row.bornMs}ms`}`)
    if (view.blocked > MAX_BLOCK_ROWS) diag(`confirm:block n=${n} more=+${view.blocked - MAX_BLOCK_ROWS}`)
  }
  diag(`confirm:end result=${result} samples=${count} elapsed=${result === 'error' ? '-' : `${finished - started}ms`}`)
}
const literal = (s: string): string => "'" + s.replaceAll("'", "''") + "'"
export const runPowerShell: PowerShell = async (script, timeout, _launch, phase) => {
  if (process.platform !== 'win32') throw new Error('Windows에서만 실행할 수 있어요.')
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const exe = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ' + script
  const bootstrap = 'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))'
  const started = Date.now()
  const child = execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', bootstrap], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) {
      // 시간 초과(killed·signal)와 비정상 종료(exit)가 같은 문구로 뭉개지기 전에 모양만 남긴다.
      if (diagEnabled()) diag(`shell:error phase=${phase ?? '-'} elapsed=${Date.now() - started}ms timeout=${timeout}ms code=${String(error.code ?? '-')} killed=${error.killed ? 1 : 0} signal=${error.signal ?? '-'} stderrLen=${String(stderr ?? '').length} kind=${shellErrorKind(String(stderr ?? ''))}`)
      reject(Object.assign(new Error('Windows 실행 결과를 확인하지 못했어요.'), { code: 'installer_unknown', cause: error }))
      return
    }
    resolve(stdout.replace(/^\uFEFF/, '').trim())
  })
  child.stdin?.end(Buffer.from(script, 'utf8').toString('base64'))
  return promise
}
const LONG_PATH = `Add-Type -ReferencedAssemblies System.dll,System.Core.dll -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class UpdateNativePath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetLongPathName(string input, StringBuilder output, uint size);
 public static string Expand(string input) {
  if (String.IsNullOrEmpty(input)) return null;
  var output = new StringBuilder(32768);
  var count = GetLongPathName(input, output, 32768);
  return count > 0 && count < 32768 ? output.ToString() : null;
 }
}
${NATIVE_PROCESSES}
'@;`
export interface Inventory { resources: string; appExecutable: string; processes: ProcessInfo[] }
export class WindowsUpdateRuntime {
  constructor(private resources: string, private appExecutable: string, private appPid = process.pid, private shell: PowerShell = runPowerShell,
    private mode: () => Promise<InstallMode> = () => detectInstallMode(appExecutable, process.env, (script, timeout) => runPowerShell(script, timeout, undefined, 'mode'))) {}
  async inventory(): Promise<Inventory> {
    const text = await this.shell(`$ErrorActionPreference='Stop'; ${LONG_PATH}
$r=[UpdateNativePath]::Expand(${literal(this.resources)}); if (!$r) { throw 'resources path unavailable' };
$e=[UpdateNativePath]::Expand(${literal(this.appExecutable)}); if (!$e) { throw 'app path unavailable' };
$rows=@([KnuafUpdate.ProcessSnapshot]::Read($PID));
@{resources=$r;appExecutable=$e;processes=$rows} | ConvertTo-Json -Depth 5 -Compress`, 15_000, undefined, 'inventory')
    const data = object(JSON.parse(text))
    if (typeof data.resources !== 'string' || typeof data.appExecutable !== 'string' || !Array.isArray(data.processes)) throw new Error('프로세스 목록을 확인하지 못했어요.')
    const processes = data.processes.map(value => {
      const p = object(value)
      if (!Number.isSafeInteger(p.pid) || Number(p.pid) < 1 || !Number.isSafeInteger(p.parent) || Number(p.parent) < 0 || typeof p.created !== 'string' || typeof p.name !== 'string' || !(p.path === null || typeof p.path === 'string')) throw new Error('프로세스 목록이 온전하지 않아요.')
      return p as unknown as ProcessInfo
    })
    return { resources: data.resources, appExecutable: data.appExecutable, processes }
  }
  async captureOwned(): Promise<ProcessSnapshot> {
    const inventory = await this.inventory()
    return { processes: inventory.processes, appPid: this.appPid, appExecutable: inventory.appExecutable }
  }
  /** `hard`: 최소 표본을 채우는 데 쓰는 시간의 상한 — 기본값이 운영 값이고, 셋째 인자는 시험 이음매다. */
  async confirmStopped(before: ProcessSnapshot, timeout = 6_000, hard = CONFIRM_HARD_MS): Promise<void> {
    const watch = new OwnedProcessWatch(before)
    // 판정 경로는 진단이 켜져 있든 꺼져 있든 같은 일을 한다: `busy` → 마감 판독 → 다음 조회 예약.
    // 진단(`KNUAF_APP_LOG`)이 켜져 있으면 표본(조회 결과 배열)과 시각만 붙잡아 두고, 근거 조립과
    // 파일 쓰기는 이 함수가 끝난 **뒤**(`setImmediate`)에 같은 표본을 다시 분류해서 한다.
    const traced = diagEnabled(), started = traced ? Date.now() : 0, samples: TraceSample[] = []
    // 느린 조회가 최소 표본을 채우며 확인을 무한히 늘리지 않게 상한 시각을 함수 진입에 잡는다.
    const entered = Date.now()
    let count = 0, result: TraceResult = 'error', finished = 0, end = 0
    try {
      for (let n = 1; ; n++) {
        const asked = traced ? Date.now() : 0
        const rows = (await this.inventory()).processes
        count = n
        // 마감은 첫 조회가 **돌아온 뒤**부터 센다 — 느린 첫 조회가 표본 수를 깎지 않게.
        if (n === 1) end = Date.now() + timeout
        if (!watch.busy(rows)) {
          if (traced) { finished = Date.now(); samples.push({ n, asked, at: finished, rows }); result = 'ok' }
          return
        }
        const now = Date.now()
        // 마감이 지났어도 최소 표본 수는 채운다 — 단 상한(`hard`)을 넘기면 표본이 모자라도 막는다.
        if (now >= end && (n >= MIN_SAMPLES || now >= entered + hard)) {
          if (traced) { finished = now; samples.push({ n, asked, at: now, rows }); result = 'deadline' }
          throw new Error('대화 도우미 프로세스 종료를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
        }
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, Math.min(100, Math.max(0, end - Date.now())))
        if (traced && samples.length < MAX_TRACE_SAMPLES) samples.push({ n, asked, at: now, rows })
        await promise
      }
    } finally {
      if (traced) setImmediate(() => { try { writeTrace(before, started, samples, count, result, finished) } catch { /* 진단이 앱 동작을 깨지 않는다 */ } })
    }
  }
  async assertResourcesIdle(): Promise<void> {
    const names: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name), st = lstatSync(path)
        if (st.isSymbolicLink()) throw new Error('동봉 실행물의 실제 경로를 확인하지 못했어요.')
        if (st.isDirectory()) walk(path)
        else if (st.isFile() && /\.exe$/i.test(entry.name)) names.push(entry.name)
      }
    }
    walk(this.resources)
    const inventory = await this.inventory()
    if (resourcesBusy(inventory.processes, inventory.resources, names)) throw new Error('도우미 창을 닫은 뒤 다시 눌러 주세요.')
  }
  async startInstaller(request: InstallerLaunch): Promise<void> {
    version(request.version); hash(request.sha256)
    if (!Number.isSafeInteger(request.size) || request.size < 1) throw new Error('설치 파일 크기가 잘못됐어요.')
    // A failed or uncertain detection keeps the admin request; only a proved
    // per-user installation may launch the installer with the user's own token.
    const elevate = await this.mode().then(mode => mode !== 'user', () => true)
    const text = await this.shell(`$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.dll,System.Core.dll -TypeDefinition @'
${NATIVE_FILES}
${NATIVE_INSTALLER}
'@; [KnuafUpdate.Installer]::Execute(${literal(request.userData)},${literal(request.path)},${literal(request.version)},${request.size},${literal(request.sha256)},${elevate ? '$true' : '$false'}) | ConvertTo-Json -Compress`, 0, { ...request, elevate }, 'install')
    const unknown = (): Error => Object.assign(new Error('설치 파일 시작 여부를 확인하지 못했어요. 설치 기록을 보관했어요.'), { code: 'installer_unknown' })
    let result: Record<string, unknown>
    try { result = object(JSON.parse(text)) } catch { throw unknown() }
    // Only an exact acknowledgement may erase pending or permit quit. Noise, partial
    // output and contradictory fields cannot prove the process did NOT start.
    const fields = Object.keys(result).sort().join(',')
    if (fields === 'pid,started' && result.started === true && Number.isSafeInteger(result.pid) && Number(result.pid) > 0) return
    if (fields === 'cancelled,started' && result.started === false && typeof result.cancelled === 'boolean') throw new Error(result.cancelled ? '관리자 확인을 취소했어요. 다시 시도할 수 있어요.' : '설치 파일을 시작하지 못했어요.')
    throw unknown()
  }
}
