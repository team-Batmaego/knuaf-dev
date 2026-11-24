/**
 * 메인 무응답 감시자(`src/main/mainWatchdog.ts`) 계약 시험. Node 단위 — Electron 창·실제 worker 없이.
 *
 * 고정하는 계약:
 *  - **기본 꺼짐**: `KNUAF_APP_LOG` 가 없는 환경(학생 배포본)에서는 worker 를 만들지도 않는다. `KNUAF_MAIN_WATCHDOG=0` 도 끈다.
 *    켜질 때는 worker 를 정확히 한 번 만들고 스택 파일을 app-log 옆(CI 가 올리는 폴더)에 둔다.
 *  - **기록만**: worker 소스·cdb 인자에 깨움(메시지 전송)·덤프·종료 명령이 없다. cdb 는 비침투 `-pv` + `~*k;q` 텍스트뿐이다.
 *  - **가림**: worker 가 쓰는 모든 줄(`safeLine`)과 cdb 스택 요약(`summarize`)에서 경로·토큰·한글(문서 이름)이 지워지고,
 *    숫자·스레드 상태 이름·`모듈!함수+오프셋` 은 남는다. 시험은 shipped 소스 문자열을 그대로 실행한다.
 *  - 시험은 가짜 표식만 쓴다 — 실제 경로·비밀값은 넣지 않는다.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  STACK_HELPERS_SOURCE,
  startMainWatchdog,
  watchdogWorkerSource,
  type WatchdogWorkerData,
  type WatchdogWorkerLike
} from '../src/main/mainWatchdog'
import { cdbStackArgs } from '../src/main/psProbe'

interface Helpers {
  safeLine(text: unknown): string
  siteOf(text: unknown): string
  summarize(text: unknown): { keep: string[]; threads: number; frames: number; iocp: number; top: string; thread0: string }
}
// worker 가 실제로 받는 문자열 그대로 실행한다(복사본을 시험하지 않는다).
const helpers = new Function(`${STACK_HELPERS_SOURCE}\nreturn { safeLine, siteOf, summarize }`)() as Helpers

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

test('기본 꺼짐 — KNUAF_APP_LOG 가 없는 환경(학생 배포본)에서는 worker 를 만들지 않는다', () => {
  for (const env of [{}, { KNUAF_APP_LOG: '' }, { KNUAF_MAIN_WATCHDOG: '1' }] as NodeJS.ProcessEnv[]) {
    const spy = spyWorker()
    expect(startMainWatchdog({ env, createWorker: spy.create })).toBeNull()
    expect(spy.calls).toHaveLength(0)
    expect(spy.events).toEqual([])
  }
})

test('끄는 스위치 — KNUAF_MAIN_WATCHDOG=0 이면 로그가 켜져 있어도 worker 를 만들지 않는다', () => {
  const spy = spyWorker()
  const env = { KNUAF_APP_LOG: join('artifacts', 'app-log.txt'), KNUAF_MAIN_WATCHDOG: '0' } as NodeJS.ProcessEnv
  expect(startMainWatchdog({ env, createWorker: spy.create })).toBeNull()
  expect(spy.calls).toHaveLength(0)
})

test('켜짐 — 로그가 있을 때만 worker 를 한 번 만들고, 스택 파일은 app-log 옆에 둔다', () => {
  const spy = spyWorker()
  const file = join('artifacts', 'run-1', 'app-log.txt')
  const handle = startMainWatchdog({ env: { KNUAF_APP_LOG: file } as NodeJS.ProcessEnv, createWorker: spy.create })
  try {
    expect(handle).not.toBeNull()
    expect(spy.calls).toHaveLength(1)
    const { source, options } = spy.calls[0]
    expect(options.eval).toBe(true)
    expect(source).toBe(watchdogWorkerSource())
    expect(options.workerData.file).toBe(file)
    expect(options.workerData.pid).toBe(process.pid)
    // CI 가 이미 올리는 폴더(app-log 와 같은 곳)이며 파일 이름이 업로드 패턴 `stall-stacks-*.txt` 와 맞는다.
    expect(options.workerData.stackFile).toBe(join(dirname(file), `stall-stacks-${process.pid}.txt`))
    expect(options.workerData.cdbArgs).toEqual(cdbStackArgs(process.pid))
    expect(spy.events).toEqual(['on:error', 'unref'])
  } finally {
    handle?.stop()
  }
  expect(spy.events).toContain('terminate')
})

test('index.ts 는 진단 블록(diagEnabled) 안에서만 감시자를 부른다', () => {
  const text = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
  const open = text.indexOf('\nif (diagEnabled()) {\n')
  expect(open).toBeGreaterThan(-1)
  const close = text.indexOf('\n}\n', open)
  const block = text.slice(open, close)
  expect(block).toContain('startMainWatchdog()')
  // import 한 줄 + 부르는 한 줄 — 다른 곳에서 부르지 않는다.
  expect(text.match(/startMainWatchdog/g)).toHaveLength(2)
})

test('기록만 한다 — worker 소스·cdb 인자에 깨움·덤프·종료 명령이 없다', () => {
  const source = watchdogWorkerSource()
  // 구문 검사만(실행하지 않는다) — Function 생성자는 본문을 파싱만 한다.
  expect(() => new Function(source)).not.toThrow()
  for (const word of [/PostMessage/i, /PostThreadMessage/i, /WM_NULL/i, /wake/i, /\.dump/i, /MiniDump/i, /\.kill/i, /\.detach/i, /process\.kill/i]) {
    expect(source).not.toMatch(word)
  }
  const args = cdbStackArgs(4242)
  expect(args).toEqual(['-pv', '-p', '4242', '-c', '~*k;q'])
  for (const arg of args) expect(arg).not.toMatch(/dump|^-ma$|^-g$|^-o$|kill|detach/i)
  // 시도 횟수가 한정돼 있다 — probe 5번·cdb 1번.
  expect(source).toContain('const MAX_PROBES = 5')
  expect(source.match(/startCdb\(/g)).toHaveLength(1) // 호출 한 곳뿐이고, `!cdbStarted` 문이 프로세스당 1회로 막는다
  expect(source).toContain('if (!cdbStarted && idle >= CDB_AFTER_MS) startCdb(lastChange)')
})

test('CI 는 스택 텍스트를 이미 올리는 산출물 목록에 싣는다 — 줄은 한 줄', () => {
  const ci = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  expect(ci.match(/app\/test-results\/e2e-artifacts\/\*\*\/stall-stacks-\*\.txt/g)).toHaveLength(1)
})

test('가림(cdb) — 스택 요약에는 모듈!함수+오프셋만 남고 경로·토큰·문서 이름·스레드 이름이 없다', () => {
  const tick = '\x60'
  const addr = (a: string, b: string) => `${a}${tick}${b}`
  const sample = [
    'Microsoft (R) Windows Debugger Version 10.0.26100.1 AMD64',
    'Symbol search path is: srv*C:\\Users\\Jane Doe\\AppData\\Local\\Symbols MARKER-user-papers-7fd3',
    `.  0  Id: 1c4.2b8 Suspend: 0 Teb: ${addr('000000a1', '2b8d4000')} Unfrozen`,
    'Child-SP          RetAddr           Call Site',
    `${addr('000000a1', '2b8ff3a8')} ${addr('00007ff8', '1a2b3c4d')} ntdll!NtWaitForSingleObject+0x14`,
    `${addr('000000a1', '2b8ff3b0')} ${addr('00007ff8', '1a2b3c4e')} KERNELBASE!WaitForSingleObjectEx+0x9c`,
    `${addr('000000a1', '2b8ff450')} ${addr('00007ff6', '00001234')} C:\\Users\\Jane Doe\\논문\\thesis.docx+0x10`,
    `${addr('000000a1', '2b8ff460')} ${addr('00007ff6', '00005678')} secret=MARKERTOKEN0123456789012345678901234+0x1`,
    `   1  Id: 1c4.2c0 Suspend: 0 Teb: ${addr('000000a1', '2b8d6000')} Unfrozen "MARKER-user-papers-7fd3 내 창업논문"`,
    `${addr('000000a1', '2b9ff3a8')} ${addr('00007ff8', '1a2b3c4d')} ntdll!RtlUserThreadStart+0x21 [C:\\Users\\Jane Doe\\src.c @ 55]`
  ].join('\n')
  const sum = helpers.summarize(sample)
  const written = [sum.keep.join('\n'), sum.top, sum.thread0].join('\n')
  for (const leak of ['Jane', 'Doe', 'thesis', '논문', '창업', 'MARKER', 'secret', 'C:', 'Users', 'AppData', 'src.c']) {
    expect(written).not.toContain(leak)
  }
  expect(written).not.toMatch(/[^\x20-\x7e\n]/)
  // 쓸모 있는 것은 남는다.
  expect(sum.threads).toBe(2)
  expect(sum.frames).toBe(5)
  expect(sum.keep[0]).toBe('thread 0 id=1c4.2b8')
  expect(sum.keep).toContain('  ntdll!NtWaitForSingleObject+0x14')
  expect(sum.keep).toContain('  KERNELBASE!WaitForSingleObjectEx+0x9c')
  expect(sum.keep).toContain('  <unknown>')
  expect(sum.top).toContain('ntdll!NtWaitForSingleObject')
  expect(sum.thread0.startsWith('ntdll!NtWaitForSingleObject+0x14 < KERNELBASE!WaitForSingleObjectEx+0x9c')).toBe(true)
  expect(helpers.siteOf('foo.dll!Bar<int>+0x2f [C:\\x.c @ 1]')).toBe('foo.dll!Bar<int>+0x2f')
  expect(helpers.siteOf('C:\\Users\\Jane\\x.exe+0x1')).toBe('<unknown>')
})

test('가림(줄) — worker 가 쓰는 모든 줄에서 경로·명령줄·토큰·한글이 지워진다', () => {
  const leaks = ['Jane', 'Doe', 'thesis', '논문', '창업', 'MARKER', 'hunter2', 'nara', 'Users']
  const dirty = [
    'probe#1 took=120ms threads=40 children=powershell.exe x1 C:\\Users\\Jane Doe\\Documents\\논문 최종 thesis.docx --token=MARKERARG',
    'watchdog cdb-stack took=900ms exit=0 threads=0 (no-threads out=/Users/nara/work/thesis.docx MARKER err=',
    'probe#2 failed exec D:\\papers\\Jane Doe\\x.exe Authorization: Bearer MARKERHEADER000000000000000000000000',
    // 비밀 꼴 문자열이 소스에 통째로 없도록 실행 중에 조립한다(스캐너가 가짜 값을 진짜로 오인하지 않게).
    'x ' + 'pass' + 'word=' + 'hunter2' + 'MARKER' + ' coo' + 'kie: ' + 'MARKER' + 'COOKIE',
    '내 창업논문.docx 열림 thesis',
    `blob ${'A1b2'.repeat(12)} end`
  ]
  for (const line of dirty) {
    const out = helpers.safeLine(line)
    for (const leak of leaks) expect(out, `${leak} 가 남았다: ${out}`).not.toContain(leak)
    expect(out).not.toMatch(/[^\x20-\x7e]/)
    expect(out).not.toMatch(/[A-Za-z]:\\/)
  }
  expect(helpers.safeLine('blob ' + 'A1b2'.repeat(12) + ' end')).toBe('blob <value> end')
  // 길이 상한.
  expect(helpers.safeLine('a '.repeat(1000)).length).toBeLessThanOrEqual(408)
})

test('가림(줄)은 과하지 않다 — 숫자·상태 이름·대기 사유는 그대로 남는다', () => {
  const clean =
    'probe#1 took=120ms threads=40 cpuMs=1234 handles=300 responding=True states=Wait/UserRequestx38;Running/Executivex2 ' +
    'oldest3=1:Wait/UserRequest/12ms;7:Running/Executive/3ms hot3=1:Wait/UserRequest/12ms children=node.exe x1'
  expect(helpers.safeLine(clean)).toBe(clean)
  const stalled = 'watchdog main-stalled idleMs=5500 cpuMs=12 busy=0%'
  expect(helpers.safeLine(stalled)).toBe(stalled)
  expect(helpers.safeLine('watchdog main-recovered stalledMs=135000 cpuMs=40')).toBe('watchdog main-recovered stalledMs=135000 cpuMs=40')
})
