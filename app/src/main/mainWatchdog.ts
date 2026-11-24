import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { codeOf, diag } from './diagLog'
import { cdbCandidates, cdbStackArgs, threadProbe } from './psProbe'

/**
 * 메인 JS 스레드 **무응답 감시자** — 진단 전용, **기록만** 한다(앱 동작·시험 단언·시간 상한은 건드리지 않는다).
 *
 * **기본 꺼짐**: `KNUAF_APP_LOG`(e2e 환경값 또는 앱 로그를 켠 때)가 없으면 worker 를 만들지도, 카운터 타이머를
 * 걸지도 않는다 — 학생 배포본(환경값 없음)은 이 모듈이 있어도 아무 일도 일어나지 않는다.
 * `KNUAF_MAIN_WATCHDOG=0` 이면 로그가 켜져 있어도 끈다.
 *
 * 왜 필요한가: 윈도 e2e 에서 메인의 heartbeat 가 기동 직후 끊기고 다시 안 나온 적이 있다(메인 JS 스레드 통째 멈춤).
 * heartbeat 는 메인 스레드 안에 있어 "멈췄다"는 사실만 남기고, **그동안 프로세스가 CPU 를 쓰며 돌았는지(바쁨)
 * 기다리고만 있었는지(막힘)** 는 말해 주지 못한다.
 *
 * 구조: 메인이 0.5초마다 공유 카운터를 올리고, **별도 worker 스레드**가 같은 카운터를 본다.
 * 3초 넘게 안 바뀌면 worker 가 `appendFileSync` 로 직접 적는다 — 메인이 막혀도 기록이 남는다.
 *  - `cpuMs/busy` : 무응답 구간에 이 프로세스가 쓴 CPU 시간(프로세스 전체). 구간 길이에 가까우면 바쁨, 0 에 가까우면 막힘.
 *  - `probe` : 외부 관측 한 번(윈도 PowerShell — 스레드 상태·대기 사유·CPU 누적·자식 프로세스 이름별 개수).
 *    처음 3초·15초·이후 30초마다, **최대 5번**.
 *  - `cdb-stack` : 정지가 5초 넘게 이어지면 프로세스당 **1번만**, 러너에 `cdb.exe` 가 있을 때 비침투(`-pv`)로 붙어
 *    스레드 스택 **텍스트만**(`~*k`) 떠서 `stall-stacks-<pid>.txt` 로 app-log 옆에 남긴다(덤프 파일은 만들지 않는다).
 *    없으면 `cdb none` 한 줄.
 *  - 회복하면 `main-recovered` 로 총 무응답 시간을 남긴다.
 * 깨우는 시도(메시지 전송)는 하지 않는다 — 멈춘 앱을 깨우면 실패가 초록으로 덮인다.
 *
 * **무엇이 남는가**: 숫자·고정 낱말·스레드 상태 이름·`모듈!함수+오프셋` 뿐이다. worker 가 쓰는 **모든 줄**과 스택 파일은
 * 아래 `STACK_HELPERS_SOURCE` 의 `safeLine`·`summarize` 를 거쳐 경로·명령줄·토큰·한글(문서 이름) 같은 값이 지워진다.
 * (worker 는 `appendFileSync` 로 직접 쓰므로 `diagLog.scrub` 를 타지 않는다 — 그래서 같은 목적의 규칙을 여기 따로 둔다.)
 * 이 규칙은 가림 시험(`e2e/main-watchdog.spec.ts`)이 같은 문자열을 그대로 실행해 잠근다.
 *
 * worker 는 `eval: true` 문자열이다 — electron-vite 번들에서 별도 파일 경로를 풀 필요가 없다.
 * (`String.raw` 안에는 백틱·`${` 를 쓰지 않는다.)
 */

/** worker 안에서 쓰는 **순수 함수**(`require` 없음). 시험이 같은 문자열을 `new Function` 으로 실행한다. */
export const STACK_HELPERS_SOURCE = String.raw`
const squash = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n)
const MAX_LINE = 400
const STRICT_WORD = /^(?:watchdog|main-stalled|main-recovered|cdb-stack|worker-up|cdb|none|failed|<)$/
const STRICT_PROBE = /^probe#[0-9]+$/
const STRICT_NUM = /^(?:[A-Za-z][A-Za-z0-9_#]*[=:])?[0-9][0-9A-Za-z.:;%+/_-]*$/
const strictTokens = (s) => s.split(' ').map((w) => (STRICT_WORD.test(w) || STRICT_PROBE.test(w) || STRICT_NUM.test(w) ? w : '<x>')).join(' ')
const safeLine = (t) => {
  let s = squash(t, 4000)
  // 비ASCII(한글 문서 이름 등)가 든 줄은 사람이 쓴 자유 텍스트가 섞인 줄이다 — 주변 ASCII 낱말·확장자도 조각이므로
  // 고정 낱말·숫자(키=숫자)만 통과시키고 나머지 낱말은 통째로 가린다(허용 목록).
  if (/[^\x20-\x7e]/.test(s)) s = strictTokens(s)
  const out = s
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\).*$/, '<path>')
    .replace(/(?<![\w.])\/(?:Users|home|tmp|var|private|root|mnt|opt|Volumes)\/.*$/, '<path>')
    .replace(/\S*\\\S*/g, '<path>')
    .replace(/(?<![\w./])\/[^\s"',;]+/g, '<path>')
    .replace(/(?<![\w.-])[A-Za-z_][\w-]*\.(?!(?:exe|dll|sys|so|dylib)(?!\w))[A-Za-z0-9]{1,5}(?!\w)/g, '<name>')
    .replace(/\b(authorization|bearer|token|password|passwd|secret|api[-_]?key|cookie|session[-_]?id)\b\s*[:=]?\s*[^\s,;]*/gi, '$1=<value>')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '<value>')
  return out.length > MAX_LINE ? out.slice(0, MAX_LINE) + '...(cut)' : out
}
const FRAME = /^[0-9a-f]{8}\x60[0-9a-f]{8}\s+[0-9a-f]{8}\x60[0-9a-f]{8}\s+(.+)$/i
const THREAD = /^\s*[.#]?\s*(\d+)\s+Id:\s*([0-9a-f]+)\.([0-9a-f]+)/i
const SITE_OK = /^[A-Za-z0-9_.@?<>:~-]+(?:![A-Za-z0-9_.@?<>:~-]+)?(?:\+0x[0-9a-f]+)?$/i
const siteOf = (text) => {
  const first = String(text == null ? '' : text).trim().split(/\s+/)[0] || ''
  return first.length <= 120 && SITE_OK.test(first) ? first : '<unknown>'
}
const summarize = (text) => {
  const keep = []
  const tops = new Map()
  const thread0 = []
  let threads = 0
  let cur = -1
  let topSeen = false
  let frames = 0
  let iocp = 0
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const h = THREAD.exec(raw)
    if (h) { threads++; cur = Number(h[1]); topSeen = false; keep.push('thread ' + Number(h[1]) + ' id=' + h[2] + '.' + h[3]); continue }
    const f = FRAME.exec(raw)
    if (!f) continue
    const site = siteOf(f[1])
    frames++
    keep.push('  ' + site)
    if (!topSeen) { topSeen = true; const fn = site.replace(/\+0x[0-9a-f]+$/i, ''); tops.set(fn, (tops.get(fn) || 0) + 1) }
    if (cur === 0 && thread0.length < 6) thread0.push(site)
    if (/RemoveIoCompletion|GetQueuedCompletionStatus/i.test(site)) iocp++
  }
  const top = [...tops].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => n + 'x' + c).join(';')
  return { keep, threads, frames, iocp, top, thread0: thread0.join(' < ') }
}
`

const WORKER_SOURCE = STACK_HELPERS_SOURCE + String.raw`
const { workerData } = require('node:worker_threads')
const fs = require('node:fs')
const cp = require('node:child_process')
const { buf, file, pid, probeCmd, probeArgs, probeCwd, cdbPaths, cdbArgs, stackFile } = workerData
const counter = new Int32Array(buf)
const STALL_MS = 3000
const CDB_AFTER_MS = 5000
const MAX_PROBES = 5
const write = (text) => { try { fs.appendFileSync(file, Date.now() + ' ' + safeLine(text) + '\n') } catch {} }
const cpuMs = (u) => Math.round((u.user + u.system) / 1000)
let last = Atomics.load(counter, 0)
let lastChange = Date.now()
let cpuBase = cpuMs(process.cpuUsage())
let stalled = false
let probes = 0
let nextProbeAt = STALL_MS
let reportedAt = 0
let cdbStarted = false
const findCdb = () => { for (const p of cdbPaths || []) { try { if (fs.existsSync(p)) return p } catch {} } return '' }
const cwdOpt = () => (probeCwd ? { cwd: probeCwd } : {})
const startCdb = (stallSince) => {
  cdbStarted = true
  const cdb = findCdb()
  if (!cdb) { write('watchdog cdb none checked=' + (cdbPaths || []).length); return }
  const cs = Date.now()
  const env = Object.assign({}, process.env)
  delete env._NT_SYMBOL_PATH
  delete env._NT_ALT_SYMBOL_PATH
  cp.execFile(cdb, cdbArgs, Object.assign({ encoding: 'utf8', timeout: 45000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env }, cwdOpt()), (err, stdout, stderr) => {
    const sum = summarize(stdout)
    let saved = 'no'
    if (sum.threads > 0) {
      try { fs.writeFileSync(stackFile, '# cdb -pv ~*k pid=' + pid + ' stalledMsAtStart=' + (cs - stallSince) + ' tookMs=' + (Date.now() - cs) + ' threads=' + sum.threads + '\n' + sum.keep.join('\n') + '\n'); saved = 'yes' } catch {}
    }
    const base = 'watchdog cdb-stack took=' + (Date.now() - cs) + 'ms exit=' + (err ? (err.code || err.name || 'error') : 0) + ' threads=' + sum.threads + ' frames=' + sum.frames + ' iocpFrames=' + sum.iocp + ' saved=' + saved
    write(sum.threads > 0 ? base + ' tops=' + sum.top + ' thread0=' + sum.thread0 : base + ' (no-threads outLen=' + String(stdout || '').length + ' errLen=' + String(stderr || '').length + ')')
  })
}
const probe = () => {
  const started = Date.now()
  try {
    const r = cp.spawnSync(probeCmd, probeArgs, Object.assign({ encoding: 'utf8', timeout: 12000, windowsHide: true }, cwdOpt()))
    const out = squash(r.stdout, 700)
    return 'probe#' + probes + ' took=' + (Date.now() - started) + 'ms ' + (out || ('(no-output status=' + r.status + (r.error ? ' error=' + (r.error.code || r.error.name) : '') + ')'))
  } catch (e) { return 'probe#' + probes + ' failed ' + ((e && (e.code || e.name)) || 'unknown') }
}
setInterval(() => {
  const now = Date.now()
  const cur = Atomics.load(counter, 0)
  if (cur !== last) {
    if (stalled) write('watchdog main-recovered stalledMs=' + (now - lastChange) + ' cpuMs=' + (cpuMs(process.cpuUsage()) - cpuBase))
    stalled = false; probes = 0; nextProbeAt = STALL_MS; reportedAt = 0
    last = cur; lastChange = now; cpuBase = cpuMs(process.cpuUsage())
    return
  }
  const idle = now - lastChange
  if (idle < STALL_MS) return
  if (!stalled) { stalled = true; write('watchdog main-stalled idleMs=' + idle + ' pid=' + pid) }
  if (!cdbStarted && idle >= CDB_AFTER_MS) startCdb(lastChange)
  if (now - reportedAt < 5000 && idle < nextProbeAt) return
  reportedAt = now
  const cpu = cpuMs(process.cpuUsage()) - cpuBase
  let line = 'watchdog main-stalled idleMs=' + idle + ' cpuMs=' + cpu + ' busy=' + (idle > 0 ? Math.round((cpu / idle) * 100) : 0) + '%'
  if (idle >= nextProbeAt && probes < MAX_PROBES) {
    probes++
    nextProbeAt = probes === 1 ? 15000 : 15000 + (probes - 1) * 30000
    line += ' ' + probe()
  }
  write(line)
}, 500)
write('watchdog worker-up cdbPaths=' + (cdbPaths || []).length)
`

export interface WatchdogWorkerData {
  buf: SharedArrayBuffer
  file: string
  pid: number
  probeCmd: string
  probeArgs: string[]
  probeCwd: string
  cdbPaths: string[]
  cdbArgs: string[]
  stackFile: string
}

/** 시험이 가짜로 바꿔 끼울 수 있는 worker 모양(진짜는 `node:worker_threads` 의 `Worker`). */
export interface WatchdogWorkerLike {
  on(event: 'error', listener: (error: unknown) => void): unknown
  unref(): unknown
  terminate?(): unknown
}

export interface WatchdogOptions {
  /** 기본 `process.env`. 시험이 환경값 없는 모양(학생 배포본)을 그대로 넘긴다. */
  env?: NodeJS.ProcessEnv
  createWorker?: (source: string, options: { eval: true; workerData: WatchdogWorkerData }) => WatchdogWorkerLike
}

export interface WatchdogHandle { stop(): void }

const defaultCreateWorker: NonNullable<WatchdogOptions['createWorker']> = (source, options) =>
  new Worker(source, options) as unknown as WatchdogWorkerLike

/** worker 에 넘기는 소스(시험이 금지 낱말·모양을 검사한다). */
export function watchdogWorkerSource(): string { return WORKER_SOURCE }

/**
 * 진단이 켜졌을 때만 메인 감시자를 띄운다. 꺼져 있으면 `null` — worker 도 타이머도 만들지 않는다.
 * 어떤 실패도 앱을 깨지 않는다.
 */
export function startMainWatchdog(options: WatchdogOptions = {}): WatchdogHandle | null {
  const env = options.env ?? process.env
  const file = env.KNUAF_APP_LOG
  if (!file || env.KNUAF_MAIN_WATCHDOG === '0') return null
  try {
    const buf = new SharedArrayBuffer(4)
    const counter = new Int32Array(buf)
    const { cmd, args } = threadProbe(process.pid)
    // 윈도: 절대 경로 PowerShell + 시스템 폴더를 cwd 로 — 앱 cwd 가 사라졌어도 ENOENT 가 나지 않게.
    const probeCwd = process.platform === 'win32' ? dirname(cmd) : ''
    // 스택 텍스트는 app-log 옆 `stall-stacks-<pid>.txt` — CI 가 이미 올리는 산출물 폴더다.
    const stackFile = join(dirname(file), `stall-stacks-${process.pid}.txt`)
    const worker = (options.createWorker ?? defaultCreateWorker)(WORKER_SOURCE, {
      eval: true,
      workerData: { buf, file, pid: process.pid, probeCmd: cmd, probeArgs: args, probeCwd, cdbPaths: cdbCandidates(), cdbArgs: cdbStackArgs(process.pid), stackFile }
    })
    worker.on('error', (error) => diag(`watchdog worker-error code=${codeOf(error)}`))
    worker.unref()
    const tick = setInterval(() => { Atomics.add(counter, 0, 1) }, 500)
    tick.unref?.()
    diag('watchdog started')
    return { stop() { clearInterval(tick); void worker.terminate?.() } }
  } catch (error) {
    diag(`watchdog start-failed code=${codeOf(error)}`)
    return null
  }
}
