/**
 * 멈춤 진단용 **프로세스 관측 명령** — 진단 전용(`KNUAF_APP_LOG` 가 켜졌을 때만 부른다).
 *
 * 읽기만 한다 — 프로세스를 건드리지 않고(메시지 전송·덤프·종료 없음), 경로·인자·환경은 남기지 않는다(이름·상태·숫자만).
 */

export interface ProbeCommand { cmd: string; args: string[] }

/**
 * 윈도 PowerShell 5.1 의 **절대 경로**. Electron 메인의 PATH 에서는 `powershell.exe`(이름만)가
 * `ENOENT` 로 안 찾아진 적이 있다. 윈도 밖에서는 이름 그대로 둔다.
 * 시스템 폴더는 `SystemRoot`(없으면 `windir`, 그것도 없으면 `C:\Windows`)에서 얻는다.
 */
export function powershellPath(): string {
  if (process.platform !== 'win32') return 'powershell.exe'
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** PowerShell 은 따옴표 처리에서 깨지기 쉬워 `-EncodedCommand`(UTF-16LE base64)로 넘긴다. */
export function powershellCommand(script: string): ProbeCommand {
  return {
    cmd: powershellPath(),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  }
}

/**
 * 한 프로세스의 스레드 상태 요약. 윈도: 스레드 수·CPU 누적·핸들 수·`Responding`, 스레드를
 * (상태/대기 사유)별로 센 값, 가장 오래된 3개(메인 스레드 후보)와 CPU 가장 많이 쓴 3개의
 * 상태·대기 사유·CPU 누적, 직계 자식 프로세스 이름별 개수. 두 번 찍어 CPU 누적이 늘었는지 비교하면
 * "바쁨(돌고 있음)"과 "막힘(기다림)"이 갈린다. 다른 OS 는 `ps` 한 줄(상태·CPU%·대기 채널·CPU 시간).
 */
export function threadProbe(pid: number): ProbeCommand {
  if (process.platform !== 'win32') return { cmd: 'ps', args: ['-o', 'state=,pcpu=,wchan=,time=', '-p', String(pid)] }
  return powershellCommand([
    `$ErrorActionPreference='SilentlyContinue'`,
    `$p=Get-Process -Id ${pid}`,
    `if(-not $p){'gone';exit}`,
    `$t=@($p.Threads)`,
    `$s='threads='+$t.Count+' cpuMs='+[int]$p.TotalProcessorTime.TotalMilliseconds+' handles='+$p.HandleCount+' responding='+$p.Responding`,
    `$g=($t|Group-Object {''+$_.ThreadState+'/'+$_.WaitReason}|ForEach-Object{$_.Name+'x'+$_.Count}) -join ';'`,
    `$e=($t|Sort-Object StartTime|Select-Object -First 3|ForEach-Object{''+$_.Id+':'+$_.ThreadState+'/'+$_.WaitReason+'/'+[int]$_.TotalProcessorTime.TotalMilliseconds+'ms'}) -join ';'`,
    `$h=($t|Sort-Object TotalProcessorTime -Descending|Select-Object -First 3|ForEach-Object{''+$_.Id+':'+$_.ThreadState+'/'+$_.WaitReason+'/'+[int]$_.TotalProcessorTime.TotalMilliseconds+'ms'}) -join ';'`,
    `$c=(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}'|Group-Object Name|ForEach-Object{$_.Name+'x'+$_.Count}) -join ';'`,
    `$s+' states='+$g+' oldest3='+$e+' hot3='+$h+' children='+$c`
  ].join('; '))
}

/**
 * Windows SDK 디버거(`cdb.exe`, x64)가 있을 법한 자리. 앞에서부터 처음 있는 것을 쓴다.
 * 없으면 감시자가 "없음" 한 줄만 남긴다(설치하지 않는다).
 */
export function cdbCandidates(): string[] {
  if (process.platform !== 'win32') return []
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    for (const kit of ['10', '11']) out.push(`${root}\\Windows Kits\\${kit}\\Debuggers\\x64\\cdb.exe`)
  }
  const sdk = process.env.WindowsSdkDir
  if (sdk) out.push(`${sdk.replace(/[\\/]+$/, '')}\\Debuggers\\x64\\cdb.exe`)
  return [...new Set(out)]
}

/**
 * cdb 인자 — **비침투(`-pv`)** 로 붙어 모든 스레드의 호출 스택 텍스트(`~*k`)만 뜨고 바로 끝낸다(`q`).
 * `-pv` 는 대상 프로세스를 디버거로 붙잡지 않고 읽기만 한다. 덤프(`.dump`·`-ma`)·`g`·`.kill`·`.detach` 같은
 * 대상에 영향을 주는 명령은 넣지 않는다 — 시험이 이 모양을 잠근다.
 */
export function cdbStackArgs(pid: number): string[] {
  return ['-pv', '-p', String(pid), '-c', '~*k;q']
}
