import { Worker } from 'node:worker_threads'
import { diag } from './diagLog'

/**
 * 메인 JS 스레드 **무응답 감시자** — 진단 전용, **기록만** 한다(앱 동작·시험 단언·시간 상한은 건드리지 않는다).
 *
 * **자식 프로세스를 하나도 만들지 않는다.** PowerShell·cdb·`Responding` 조회 같은 관측은 창에 메시지를 보내거나
 * 대상을 멈출 수 있고(검토 C-02), 종료 때 회수할 자식이 생긴다(검토 I-02). 이 모듈이 만드는 것은 worker 스레드 하나뿐이다.
 *
 * **기본 꺼짐 — 세 조건이 모두 맞을 때만 켠다**(검토 I-01):
 *  ① 앱이 패키징되지 않았다(`isPackaged === false` 를 호출자가 **명시**해야 한다. 안 주면 꺼짐),
 *  ② e2e 전용 환경값 `KNUAF_E2E_MAIN_WATCHDOG=1`(`e2e/helpers.ts` 의 launch 만 넣는다),
 *  ③ 기록 파일 `KNUAF_APP_LOG`.
 * 하나라도 빠지면 worker 도 타이머도 만들지 않는다 — 학생 배포본(패키징됨·환경값 없음)은 이 모듈이 있어도 아무 일도 없다.
 *
 * 구조: 메인이 0.5초마다 공유 카운터를 올리고, **별도 worker 스레드**가 같은 카운터를 본다.
 * 3초 넘게 안 바뀌면 worker 가 `appendFileSync` 로 직접 적는다 — 메인이 막혀도 기록이 남는다.
 *
 * **무엇이 남는가(검토 C-01)**: 지우는 방식이 아니라 **고정 서식**이다. worker 가 쓸 수 있는 줄은 아래 세 가지뿐이고,
 * 줄마다 문자열 인자가 없다(숫자만 들어간다). 경로·이름·명령줄이 들어갈 자리가 서식에 아예 없다.
 *   watchdog worker-up
 *   watchdog main-stalled idleMs=<숫자> cpuMs=<숫자> busy=<숫자>%
 *   watchdog main-recovered stalledMs=<숫자> cpuMs=<숫자>
 * `write` 는 `LINE_OK` 에 맞지 않는 줄을 버린다(이중 안전). 메인 쪽 줄도 고정 낱말뿐이다
 * (`watchdog started|start-failed|worker-error`).
 *
 * worker 는 `eval: true` 문자열이다 — electron-vite 번들에서 별도 파일 경로를 풀 필요가 없다.
 * (`String.raw` 안에는 백틱·`${` 를 쓰지 않는다.)
 */

/** worker 안에서 쓰는 **순수 함수**(`require` 없음). 시험이 같은 문자열을 `new Function` 으로 실행한다. */
export const WATCHDOG_LINES_SOURCE = String.raw`
const LINE_OK = /^watchdog (?:worker-up|main-stalled idleMs=[0-9]+ cpuMs=[0-9]+ busy=[0-9]+%|main-recovered stalledMs=[0-9]+ cpuMs=[0-9]+)$/
const num = (n) => { const v = Math.floor(Number(n)); return String(Number.isFinite(v) && v > 0 ? Math.min(v, 1e15) : 0) }
const lineUp = () => 'watchdog worker-up'
const lineStalled = (idleMs, cpuMs, busy) => 'watchdog main-stalled idleMs=' + num(idleMs) + ' cpuMs=' + num(cpuMs) + ' busy=' + num(busy) + '%'
const lineRecovered = (stalledMs, cpuMs) => 'watchdog main-recovered stalledMs=' + num(stalledMs) + ' cpuMs=' + num(cpuMs)
`

const WORKER_SOURCE = WATCHDOG_LINES_SOURCE + String.raw`
const { workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { buf, file } = workerData
const counter = new Int32Array(buf)
const STALL_MS = 3000
const REPORT_MS = 5000
const write = (line) => { if (!LINE_OK.test(line)) return; try { fs.appendFileSync(file, Date.now() + ' ' + line + '\n') } catch {} }
const cpuMs = (u) => Math.round((u.user + u.system) / 1000)
let last = Atomics.load(counter, 0)
let lastChange = Date.now()
let cpuBase = cpuMs(process.cpuUsage())
let stalled = false
let reportedAt = 0
setInterval(() => {
  const now = Date.now()
  const cur = Atomics.load(counter, 0)
  if (cur !== last) {
    if (stalled) write(lineRecovered(now - lastChange, cpuMs(process.cpuUsage()) - cpuBase))
    stalled = false; reportedAt = 0
    last = cur; lastChange = now; cpuBase = cpuMs(process.cpuUsage())
    return
  }
  const idle = now - lastChange
  if (idle < STALL_MS) return
  stalled = true
  if (now - reportedAt < REPORT_MS) return
  reportedAt = now
  const cpu = cpuMs(process.cpuUsage()) - cpuBase
  write(lineStalled(idle, cpu, idle > 0 ? Math.round((cpu / idle) * 100) : 0))
}, 500)
write(lineUp())
`

export interface WatchdogWorkerData {
  buf: SharedArrayBuffer
  file: string
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
  /** `app.isPackaged`. **`false` 를 명시해야만** 켤 수 있다 — 안 주거나 `true` 면 환경값이 다 있어도 꺼짐. */
  isPackaged?: boolean
  createWorker?: (source: string, options: { eval: true; workerData: WatchdogWorkerData }) => WatchdogWorkerLike
}

export interface WatchdogHandle { stop(): void }

const defaultCreateWorker: NonNullable<WatchdogOptions['createWorker']> = (source, options) =>
  new Worker(source, options) as unknown as WatchdogWorkerLike

/** worker 에 넘기는 소스(시험이 금지 낱말·모양을 검사한다). */
export function watchdogWorkerSource(): string { return WORKER_SOURCE }

/**
 * 켜짐 조건을 모두 채울 때만 메인 감시자를 띄운다. 꺼져 있으면 `null` — worker 도 타이머도 만들지 않는다.
 * 돌려준 핸들의 `stop()` 은 타이머를 걷고 worker 를 종료한다(종료 경로에서 부른다). 어떤 실패도 앱을 깨지 않는다.
 */
export function startMainWatchdog(options: WatchdogOptions = {}): WatchdogHandle | null {
  if (options.isPackaged !== false) return null
  const env = options.env ?? process.env
  const file = env.KNUAF_APP_LOG
  if (env.KNUAF_E2E_MAIN_WATCHDOG !== '1' || !file) return null
  try {
    const buf = new SharedArrayBuffer(4)
    const counter = new Int32Array(buf)
    const worker = (options.createWorker ?? defaultCreateWorker)(WORKER_SOURCE, { eval: true, workerData: { buf, file } })
    worker.on('error', () => diag('watchdog worker-error'))
    worker.unref()
    const tick = setInterval(() => { Atomics.add(counter, 0, 1) }, 500)
    tick.unref?.()
    diag('watchdog started')
    return {
      stop() {
        clearInterval(tick)
        try { void worker.terminate?.() } catch { /* 종료 중 실패는 삼킨다 */ }
      }
    }
  } catch {
    diag('watchdog start-failed')
    return null
  }
}
