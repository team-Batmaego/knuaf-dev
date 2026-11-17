/**
 * 출시판 파일 로그의 계약 — **Electron 없이** 도는 Node 시험(가짜 App 더블).
 *
 * 왜 이 시험이 필요한가: 이 배선이 없어서 G0 조사가 "위임이 왜 거절됐는지"를 남은 기록으로
 * 밝히지 못했다(inv-logs/RESULT.md). 설치판에는 콘솔이 없어 `console.error`·`diag()` 가 전부
 * 증발했다. 그 고침이 조용히 되돌아가지 않게 여기서 못 박는다:
 *
 *  1. `diag()` 는 기본 경로(`setDefaultLogFile`)에 쓰고, `KNUAF_APP_LOG` 가 있으면 그쪽을 쓴다.
 *  2. 파일은 1MB 에서 `main.log.1` 로 물러나고, 세 번째 세대는 남기지 않는다.
 *  3. `console.error`/`console.warn` 은 **원래 함수를 그대로 부르고**, 파일 사본은 `scrub` 을 거친다.
 *  4. `uncaughtException`/`unhandledRejection` 리스너는 **달지 않는다**(달면 종료 코드·기본 처리가 바뀐다).
 *     감시는 `uncaughtExceptionMonitor` 만 쓴다 - 이름·코드만 남기고 `message`·`stack` 은 남기지 않는다.
 *  5. `render-process-gone` 은 `clean-exit` 이 아닐 때만 남기고, `dispose()` 가 전부 되돌린다.
 */
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendScrubbed, diag, setDefaultLogFile } from '../src/main/diagLog'
import { installMainLog } from '../src/main/mainLog'

/** 절대 쓰지 않는 가짜 표식 — 파일에 남았는지만 본다. */
const PATH_MARK = 'MARKER-user-papers-9a1c'
const TOKEN_MARK = 'sk-test-MARKERTOKEN1111111111111111111111'

/** `App` 중 이 배선이 쓰는 부분만. `getPath`/`setAppLogsPath`/`setPath` 는 electron 과 같은 의미로 흉내 낸다. */
function fakeApp(paths: { userData: string; logs: string }): EventEmitter & {
  paths: { userData: string; logs: string }
  setLogsCalls: string[]
  getPath(name: string): string
  setAppLogsPath(path?: string): void
  setPath(name: string, path: string): void
} {
  const app = Object.assign(new EventEmitter(), {
    paths,
    setLogsCalls: [] as string[],
    getPath(name: string): string {
      if (name === 'userData') return app.paths.userData
      if (name === 'logs') return app.paths.logs
      throw new Error(`getPath(${name}) 는 이 시험에서 정의되지 않았다`)
    },
    setAppLogsPath(path?: string): void {
      app.setLogsCalls.push(path ?? '(default)')
      if (path) app.paths.logs = path
    },
    setPath(name: string, path: string): void {
      if (!existsSync(path)) throw new Error(`setPath(${name}) 는 없는 폴더를 받지 않는다`)
      if (name === 'logs') app.paths.logs = path
      else if (name === 'userData') app.paths.userData = path
    }
  })
  return app
}

/** 시험이 환경을 바꾼 채 끝나도 다음 시험에 새지 않게. */
function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { run() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setDefaultLogFile('')
  }
}

test('diag() 는 기본 경로에 쓰고, KNUAF_APP_LOG 가 있으면 그쪽이 이긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-default-'))
  try {
    const fallback = join(dir, 'main.log')
    const override = join(dir, 'override.log')
    setDefaultLogFile(fallback)
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      diag('stage=boot pid=1')
      expect(readFileSync(fallback, 'utf-8'), '기본 경로에 기동 줄이 없다').toContain('stage=boot pid=1')
    })
    withEnv({ KNUAF_APP_LOG: override }, () => {
      diag('stage=override pid=2')
      expect(readFileSync(override, 'utf-8')).toContain('stage=override pid=2')
      expect(readFileSync(fallback, 'utf-8'), '환경변수가 있는데 기본 경로에도 썼다').not.toContain('stage=override')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('1MB 를 넘으면 main.log.1 로 물러나고 세 번째 세대는 남기지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-rotate-'))
  try {
    // 상한을 넘긴 파일을 직접 만들어 둔다 - 1MB 를 append 로 채우면 시험이 느려지고, 여기서 보는 것은
    // "넘쳤을 때 회전하는가"이지 "상한까지 쓰는가"가 아니다.
    const file = join(dir, 'nested', 'main.log')
    const old = 'x'.repeat(1024 * 1024 + 1)
    appendScrubbed(file, 'first')
    expect(existsSync(file), '없는 디렉터리를 만들지 않았다').toBe(true)
    writeFileSync(file, old, 'utf-8')

    appendScrubbed(file, 'second')
    expect(readFileSync(`${file}.1`, 'utf-8'), '이전 내용이 .1 로 물러나지 않았다').toHaveLength(old.length)
    expect(readFileSync(file, 'utf-8'), '회전 뒤 새 파일에 새 줄만 있어야 한다').not.toContain('x'.repeat(4096))

    // 두 번째 회전 - `.1` 을 먼저 비우지 못하면(윈도우 잠금) 여기서 rename 이 실패해 기록이 멈춘다.
    writeFileSync(file, 'y'.repeat(1024 * 1024 + 1), 'utf-8')
    appendScrubbed(file, 'third')
    expect(readFileSync(`${file}.1`, 'utf-8').startsWith('y'), '.1 이 두 번째 세대로 교체되지 않았다').toBe(true)
    expect(existsSync(`${file}.2`), '세 번째 세대(.2)를 남겼다 - 로그가 계속 늘어난다').toBe(false)
    expect(statSync(file).size).toBeLessThan(1024 * 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('console.error·warn 은 원래 함수를 그대로 부르고, 파일 사본은 값을 지운다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-console-'))
  const originalError = console.error
  const originalWarn = console.warn
  const captured: unknown[][] = []
  try {
    const app = fakeApp({ userData: join(dir, 'userData'), logs: join(dir, 'logs') })
    // 배선 전에 콘솔을 가로채 "원래 함수가 불렸는가"를 본다(패치는 이 함수를 기억해 부른다).
    console.error = (...args: unknown[]) => { captured.push(args) }
    console.warn = (...args: unknown[]) => { captured.push(args) }
    let file = ''
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(app as never)
      try {
        expect(handle.file, '로그 파일 경로가 정해지지 않았다').toBe(join(dir, 'logs', 'main.log'))
        console.error('safeWrite:fail code=EPERM', `token=${TOKEN_MARK}`)
        console.error(`open failed path=/Users/${PATH_MARK}/논문/chat.json`)
        console.warn('sidecar:warn code=ENOENT')
      } finally {
        file = handle.file
        handle.dispose()
      }
    })
    expect(captured, '원래 console 함수가 불리지 않았다 - 개발 실행·e2e 관측이 사라진다').toHaveLength(3)
    expect(captured[0][0]).toBe('safeWrite:fail code=EPERM')

    const text = readFileSync(file, 'utf-8')
    for (const secret of [TOKEN_MARK, PATH_MARK]) {
      expect(text, `로그 파일에 비밀값이 닿았다: ${secret}`).not.toContain(secret)
    }
    // 지우되 진단 가치는 남긴다 - 이게 없으면 로그가 무의미해진다.
    expect(text).toContain('[console.error] safeWrite:fail code=EPERM')
    expect(text).toContain('[console.warn] sidecar:warn code=ENOENT')
    expect(text).toContain('token=<값>')
  } finally {
    console.error = originalError
    console.warn = originalWarn
    rmSync(dir, { recursive: true, force: true })
  }
})

test('예외는 감시만 한다 - 종료 동작을 바꾸는 리스너를 달지 않고, 이름·코드만 남긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-uncaught-'))
  try {
    const app = fakeApp({ userData: join(dir, 'userData'), logs: join(dir, 'logs') })
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
      monitor: process.listenerCount('uncaughtExceptionMonitor')
    }
    let file = ''
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(app as never)
      try {
        expect(process.listenerCount('uncaughtException'), 'uncaughtException 리스너를 달았다 - 앱이 안 죽고 종료 코드가 바뀐다').toBe(before.uncaught)
        expect(process.listenerCount('unhandledRejection'), 'unhandledRejection 리스너를 달았다 - 기본 처리(경고 후 종료)가 바뀐다').toBe(before.rejection)
        expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.monitor + 1)

        // monitor 는 관측 전용이다 - 직접 emit 해도 기본 처리(종료)는 일어나지 않는다.
        const error = Object.assign(new Error(`boom /Users/${PATH_MARK}/논문 token=${TOKEN_MARK}`), { code: 'EACCES' })
        process.emit('uncaughtExceptionMonitor', error, 'uncaughtException')
      } finally {
        file = handle.file
        handle.dispose()
      }
    })
    expect(process.listenerCount('uncaughtExceptionMonitor'), 'dispose 가 리스너를 되돌리지 않았다').toBe(before.monitor)

    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('[uncaught] origin=uncaughtException code=EACCES')
    for (const secret of [TOKEN_MARK, PATH_MARK, 'boom']) {
      expect(text, `예외 기록에 값이 샜다: ${secret}`).not.toContain(secret)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('렌더러 크래시는 이유·종료코드만 남기고 clean-exit 는 남기지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-renderer-'))
  try {
    const app = fakeApp({ userData: join(dir, 'userData'), logs: join(dir, 'logs') })
    const contents = Object.assign(new EventEmitter(), {})
    let file = ''
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(app as never)
      try {
        app.emit('web-contents-created', {}, contents)
        contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
        contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 })
        contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
      } finally {
        file = handle.file
        handle.dispose()
      }
    })
    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('[renderer-gone] reason=crashed exit=5')
    expect(text).toContain('[renderer-gone] reason=oom exit=9')
    expect(text, '창을 그냥 닫은 것(clean-exit)까지 남기면 로그가 잡음으로 찬다').not.toContain('reason=clean-exit')

    // dispose 뒤에는 새 창·새 크래시를 더 보지 않는다.
    const later = Object.assign(new EventEmitter(), {})
    app.emit('web-contents-created', {}, later)
    later.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 })
    expect(readFileSync(file, 'utf-8')).not.toContain('exit=7')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('e2e 격리(KNUAF_USER_DATA)에서는 로그도 userData 아래에 두고, 폴더 열기 경로도 같이 옮긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-isolated-'))
  try {
    const userData = join(dir, 'userData')
    withEnv({ KNUAF_USER_DATA: userData, KNUAF_APP_LOG: undefined }, () => {
      const app = fakeApp({ userData, logs: join(dir, 'real-logs') })
      const handle = installMainLog(app as never)
      try {
        const expected = join(userData, 'logs')
        expect(handle.file, 'e2e 실행이 개발자의 실제 로그 폴더에 썼다').toBe(join(expected, 'main.log'))
        expect(app.getPath('logs'), "앱의 '로그 폴더 열기'(ipc.ts)와 실제 파일 위치가 어긋난다").toBe(expected)
        diag('stage=boot pid=3')
        expect(readFileSync(handle.file, 'utf-8')).toContain('stage=boot pid=3')
      } finally {
        handle.dispose()
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
