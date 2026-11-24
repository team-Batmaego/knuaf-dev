/**
 * 메인 무응답 감시자(`src/main/mainWatchdog.ts`) 계약 시험. Node 단위 — Electron 창·실제 worker 없이.
 *
 * 고정하는 계약:
 *  - **기본 꺼짐(검토 I-01)**: 패키징된 앱이거나(`isPackaged` 가 `false` 로 명시되지 않음), e2e 전용 환경값
 *    `KNUAF_E2E_MAIN_WATCHDOG=1` 이 없거나, `KNUAF_APP_LOG` 가 없으면 worker 를 만들지 않는다. 셋 다 맞을 때만 시작한다.
 *  - **종료(검토 I-02)**: `stop()` 이 worker 를 종료하고, `index.ts` 가 종료 경로(`will-quit`)에서 `stop()` 을 부른다.
 *  - **자식 프로세스 없음(검토 C-02)**: worker 소스에 자식 프로세스·PowerShell·cdb·`Responding` 이 없다.
 *  - **고정 서식(검토 C-01)**: worker 가 쓸 수 있는 줄은 **허용 목록 정규식**에만 맞는다. 줄에는 문자열 인자가 하나도 없고
 *    숫자만 들어가므로, 드라이브 상대 경로(`D:Jane Doe\plan.hwpx`)·`1SPRINGBUDGET`·`Private Draft.exe`·`PrivateDraft.docx!…`
 *    같은 외부 문자열이 들어갈 **자리가 서식에 없다**. 지우기 함수에 의존하지 않는다.
 *  - 시험은 가짜 표식만 쓴다 — 실제 경로·비밀값은 넣지 않는다.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startMainWatchdog,
  WATCHDOG_LINES_SOURCE,
  watchdogWorkerSource,
  type WatchdogWorkerData,
  type WatchdogWorkerLike
} from '../src/main/mainWatchdog'

interface Lines {
  LINE_OK: RegExp
  lineUp(): string
  lineStalled(idleMs: unknown, cpuMs: unknown, busy: unknown): string
  lineRecovered(stalledMs: unknown, cpuMs: unknown): string
}
// worker 가 실제로 받는 문자열 그대로 실행한다(복사본을 시험하지 않는다).
const lines = new Function(`${WATCHDOG_LINES_SOURCE}\nreturn { LINE_OK, lineUp, lineStalled, lineRecovered }`)() as Lines

/** 시험이 독립적으로 쥔 허용 목록 — 접두 타임스탬프(`<숫자> `) + 고정 낱말 + 숫자뿐. 메인 쪽 줄(`diag`)도 같은 목록이다. */
const ALLOWED =
  /^\d+ watchdog (?:started|start-failed|worker-error|worker-up|main-stalled idleMs=\d+ cpuMs=\d+ busy=\d+%|main-recovered stalledMs=\d+ cpuMs=\d+)$/

function spyWorker() {
  const calls: { source: string; options: { eval: true; workerData: WatchdogWorkerData } }[] = []
  const events: string[] = []
  const create = (source: string, options: { eval: true; workerData: WatchdogWorkerData }): WatchdogWorkerLike => {
    calls.push({ source, options })
    return {
      on: (event) => { events.push(`on:${event}`) },
      unref: () => { events.push('unref') },
      terminate: () => { events.push('terminate') }
    }
  }
  return { calls, events, create }
}

const LOG = join('artifacts', 'run-1', 'app-log.txt')
const ON = { KNUAF_APP_LOG: LOG, KNUAF_E2E_MAIN_WATCHDOG: '1' } as NodeJS.ProcessEnv

test('기본 꺼짐 — 환경값이 없는 학생 배포본 모양에서는 worker 를 만들지 않는다', () => {
  const cases: NodeJS.ProcessEnv[] = [
    {},
    { KNUAF_APP_LOG: '' },
    { KNUAF_APP_LOG: LOG }, // 앱 로그만 — 학생 배포본에 로그 값만 주어도 켜지면 안 된다
    { KNUAF_E2E_MAIN_WATCHDOG: '1' }, // e2e 값만 — 기록 파일이 없다
    { KNUAF_APP_LOG: LOG, KNUAF_E2E_MAIN_WATCHDOG: '0' },
    { KNUAF_APP_LOG: LOG, KNUAF_E2E_MAIN_WATCHDOG: 'true' }
  ]
  for (const env of cases) {
    const spy = spyWorker()
    expect(startMainWatchdog({ env, isPackaged: false, createWorker: spy.create })).toBeNull()
    expect(spy.calls).toHaveLength(0)
    expect(spy.events).toEqual([])
  }
})

test('패키징된 앱은 환경값을 다 줘도 꺼짐 — isPackaged 가 true 이거나 안 주어져도 null', () => {
  for (const isPackaged of [true, undefined]) {
    const spy = spyWorker()
    expect(startMainWatchdog({ env: ON, isPackaged, createWorker: spy.create })).toBeNull()
    expect(spy.calls).toHaveLength(0)
    expect(spy.events).toEqual([])
  }
})

test('켜짐 — 패키징 안 됨 + e2e 값 + 앱 로그가 모두 맞을 때만 worker 를 한 번 만든다', () => {
  const spy = spyWorker()
  const handle = startMainWatchdog({ env: ON, isPackaged: false, createWorker: spy.create })
  try {
    expect(handle).not.toBeNull()
    expect(spy.calls).toHaveLength(1)
    const { source, options } = spy.calls[0]
    expect(options.eval).toBe(true)
    expect(source).toBe(watchdogWorkerSource())
    // worker 에 넘기는 것은 공유 카운터와 기록 파일 경로뿐이다(자식 프로세스 인자·명령 없음).
    expect(Object.keys(options.workerData).sort()).toEqual(['buf', 'file'])
    expect(options.workerData.file).toBe(LOG)
    expect(spy.events).toEqual(['on:error', 'unref'])
  } finally {
    handle?.stop()
  }
})

test('종료 — stop() 은 worker 를 terminate 한다', () => {
  const spy = spyWorker()
  const handle = startMainWatchdog({ env: ON, isPackaged: false, createWorker: spy.create })
  expect(handle).not.toBeNull()
  expect(spy.events).not.toContain('terminate')
  handle?.stop()
  expect(spy.events).toContain('terminate')
})

test('index.ts — 진단 블록 안에서 isPackaged 를 넘겨 시작하고, will-quit 에서 stop() 한다', () => {
  const text = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
  const open = text.indexOf('\nif (diagEnabled()) {\n')
  expect(open).toBeGreaterThan(-1)
  const close = text.indexOf('\n}\n', open)
  const block = text.slice(open, close)
  expect(block).toContain('startMainWatchdog({ isPackaged: app.isPackaged })')
  const quit = block.slice(block.indexOf("app.on('will-quit'"))
  expect(quit).toContain('mainWatchdog?.stop()')
  // import 한 줄 + 부르는 한 줄 — 다른 곳에서 부르지 않는다.
  expect(text.match(/startMainWatchdog/g)).toHaveLength(2)
  // e2e launch 도우미만 켜는 값을 넣는다.
  const helpers = readFileSync(join(__dirname, 'helpers.ts'), 'utf8')
  expect(helpers).toContain("env.KNUAF_E2E_MAIN_WATCHDOG = '1'")
})

test('자식 프로세스 없음 — worker 소스에 자식·PowerShell·cdb·Responding·깨움이 없다', () => {
  const source = watchdogWorkerSource()
  // 구문 검사만(실행하지 않는다) — Function 생성자는 본문을 파싱만 한다.
  expect(() => new Function(source)).not.toThrow()
  for (const word of [
    /child_process/i, /\bspawn/i, /\bexec/i, /fork\(/i, /powershell/i, /\bcdb\b/i, /Responding/i,
    /PostMessage/i, /PostThreadMessage/i, /WM_NULL/i, /wake/i, /\.dump/i, /\.kill/i, /process\.kill/i
  ]) {
    expect(source).not.toMatch(word)
  }
  // require 는 worker_threads(공유 카운터 전달)와 fs(기록) 둘뿐이다.
  expect([...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort()).toEqual(['node:fs', 'node:worker_threads'])
  const main = readFileSync(join(__dirname, '../src/main/mainWatchdog.ts'), 'utf8')
  expect(main).not.toMatch(/child_process|psProbe/)
})

test('고정 서식 — worker 가 쓰는 자리는 줄 만드는 함수 셋뿐이고, 모든 줄이 허용 목록에만 맞는다', () => {
  const source = watchdogWorkerSource()
  const writes = [...source.matchAll(/\bwrite\(([A-Za-z]*)\(/g)].map((m) => m[1])
  // `write(` 호출은 전부 `write(lineXxx(` 꼴이다 — 변수·문자열을 그대로 넘기는 호출이 없다.
  expect(source.match(/\bwrite\(/g)).toHaveLength(writes.length)
  expect(new Set(writes)).toEqual(new Set(['lineRecovered', 'lineStalled', 'lineUp']))
  // 쓰기 자리(`appendFileSync`)는 하나이고 그 앞에서 `LINE_OK` 로 한 번 더 거른다.
  expect(source.match(/appendFileSync/g)).toHaveLength(1)
  expect(source).toContain('if (!LINE_OK.test(line)) return')

  const stamp = (line: string) => `1700000000000 ${line}`
  expect(stamp(lines.lineUp())).toMatch(ALLOWED)
  expect(stamp(lines.lineStalled(5500, 12, 0))).toMatch(ALLOWED)
  expect(stamp(lines.lineRecovered(135000, 40))).toBe('1700000000000 watchdog main-recovered stalledMs=135000 cpuMs=40')
  expect(stamp(lines.lineStalled(5500, 12, 0))).toBe('1700000000000 watchdog main-stalled idleMs=5500 cpuMs=12 busy=0%')
})

test('가림 — 외부 문자열(경로·이름·명령줄)이 들어갈 자리가 서식에 없다: 어떤 인자를 줘도 줄은 허용 목록에만 맞는다', () => {
  // 검토에서 나온 반례를 포함한 적대적 인자. 줄 만드는 함수는 이것들을 숫자(0)로 바꿀 뿐 문자열을 싣지 못한다.
  const hostile: unknown[] = [
    'D:Jane Doe\\plan.hwpx',
    '1SPRINGBUDGET',
    '1SPRINGBUDGET 논문',
    'Private Draft.exe',
    'PrivateDraft.docx!SampleText+0x10',
    'SpringBudget.exe!SampleText+0x1',
    'C:\\Users\\Jane Doe\\Documents\\thesis.docx',
    '/Users/jane/work/thesis.docx',
    '\\\\server\\share\\x.docx',
    'pass' + 'word=' + 'hunter2' + 'MARKER',
    '12abc',
    { toString: () => 'PrivateDraft.docx' },
    ['Private Draft.exe'],
    null, undefined, NaN, -5, Infinity, 1e30, 1.9
  ]
  const stamp = (line: string) => `1700000000000 ${line}`
  const forbidden = /Jane|Doe|plan|hwpx|SPRING|Spring|Private|Draft|docx|exe|SampleText|thesis|server|hunter2|MARKER|논문|[A-Za-z]:|\\|\//
  for (const value of hostile) {
    for (const line of [lines.lineStalled(value, value, value), lines.lineRecovered(value, value), lines.lineUp()]) {
      expect(stamp(line), `허용 목록 밖: ${stamp(line)}`).toMatch(ALLOWED)
      expect(line).not.toMatch(forbidden)
      expect(lines.LINE_OK.test(line)).toBe(true)
    }
  }
  // 어떤 줄도 아닌 원문(외부 문자열)은 쓰기 직전 거름망 `LINE_OK` 가 버린다.
  for (const value of hostile) {
    if (typeof value !== 'string') continue
    expect(lines.LINE_OK.test(value), value).toBe(false)
    expect(lines.LINE_OK.test(`watchdog worker-up ${value}`), value).toBe(false)
    expect(lines.LINE_OK.test(`watchdog main-stalled idleMs=5 cpuMs=5 busy=5% ${value}`), value).toBe(false)
  }
  // 숫자는 그대로 남는다(과하게 지우지 않음).
  expect(lines.lineStalled('5500', 12.9, 0)).toBe('watchdog main-stalled idleMs=5500 cpuMs=12 busy=0%')
})
