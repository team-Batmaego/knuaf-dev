/**
 * 출시판 파일 로그의 계약 — **Electron 없이** 도는 Node 시험(가짜 App 더블).
 *
 * 왜 이 시험이 필요한가: 이 배선이 없어서 G0 조사가 "위임이 왜 거절됐는지"를 남은 기록으로
 * 밝히지 못했다(inv-logs/RESULT.md). 설치판에는 콘솔이 없어 `console.error`·`diag()` 가 전부
 * 증발했다. 그 고침이 조용히 되돌아가지 않게 여기서 못 박는다:
 *
 *  1. `diag()` 는 기본 경로(`setDefaultLogFile`)에 쓰고, `KNUAF_APP_LOG` 가 있으면 그쪽을 쓴다.
 *  2. 파일은 1MB(개행 포함) 에서 `main.log.1` 로 물러나고, 세 번째 세대는 남기지 않는다.
 *  3. `console.error`/`console.warn` 은 **원래 함수를 그대로 부르고**, 파일에는 **검증된 필드만** 남긴다 -
 *     원고 본문·공백 있는 경로·Error message·식별값은 파일에 닿지 않는다(검토 roh-1 중요1).
 *  4. 인수를 문자열화하지 않는다 - 사용자 정의 직렬화(`util.inspect.custom`)가 두 번 돌지 않는다(중요3).
 *  5. `uncaughtException`/`unhandledRejection` 리스너는 **달지 않는다**(달면 종료 코드·기본 처리가 바뀐다).
 *     감시는 `uncaughtExceptionMonitor` 만 쓰고, 훅 **전체**가 예외 경계 안에 있다 - 던지는 `code`
 *     accessor 가 있어도 원래 오류와 종료 코드가 그대로다(중요2, 자식 프로세스 실측).
 *  6. `render-process-gone` 은 `clean-exit` 이 아닐 때만 남기고, 파괴된 창은 Map 에서 스스로 빠진다(권고4).
 *     `dispose()` 가 전부 되돌린다.
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { inspect } from 'node:util'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { MAX_FILE_BYTES, appendScrubbed, diag, setDefaultLogFile } from '../src/main/diagLog'
import { consoleFields, installMainLog } from '../src/main/mainLog'
import { writeFileAtomic } from '../src/main/safeWrite'

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
    const old = 'x'.repeat(MAX_FILE_BYTES + 1)
    appendScrubbed(file, 'first')
    expect(existsSync(file), '없는 디렉터리를 만들지 않았다').toBe(true)
    writeFileSync(file, old, 'utf-8')

    appendScrubbed(file, 'second')
    expect(readFileSync(`${file}.1`, 'utf-8'), '이전 내용이 .1 로 물러나지 않았다').toHaveLength(old.length)
    expect(readFileSync(file, 'utf-8'), '회전 뒤 새 파일에 새 줄만 있어야 한다').not.toContain('x'.repeat(4096))

    // 두 번째 회전 - `.1` 을 먼저 비우지 못하면(윈도우 잠금) 여기서 rename 이 실패해 기록이 멈춘다.
    writeFileSync(file, 'y'.repeat(MAX_FILE_BYTES + 1), 'utf-8')
    appendScrubbed(file, 'third')
    expect(readFileSync(`${file}.1`, 'utf-8').startsWith('y'), '.1 이 두 번째 세대로 교체되지 않았다').toBe(true)
    expect(existsSync(`${file}.2`), '세 번째 세대(.2)를 남겼다 - 로그가 계속 늘어난다').toBe(false)
    expect(statSync(file).size).toBeLessThan(MAX_FILE_BYTES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('크기 판정은 개행까지 센다 - 상한 정확히 맞으면 쓰고, 1바이트만 넘어도 회전한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-boundary-'))
  try {
    const file = join(dir, 'main.log')
    // 개행 포함 바이트 = 줄 내용 + 1. 내용 1바이트를 쓰면 총 2바이트가 늘어난다.
    writeFileSync(file, 'a'.repeat(MAX_FILE_BYTES - 2), 'utf-8')
    appendScrubbed(file, 'x')
    expect(existsSync(`${file}.1`), '상한에 정확히 맞는데 회전했다').toBe(false)
    expect(statSync(file).size, '개행을 빼고 세어 상한을 넘겼다(검토 roh-1 권고5)').toBe(MAX_FILE_BYTES)

    appendScrubbed(file, 'y')
    expect(existsSync(`${file}.1`), '상한을 넘겼는데 회전하지 않았다').toBe(true)
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
    // 값 자리는 화이트리스트에 없으므로 **줄째 버린다** - `token=<값>` 처럼 남기지 않는다(검토 roh-1 중요1).
    expect(text, '토큰 필드를 <값> 으로 남겼다 - 이름만 보고 살리면 다음 값이 샌다').not.toContain('token=')
    expect(text, '공백 있는 경로 문장이 로그 줄에 남았다').not.toContain('open failed')
  } finally {
    console.error = originalError
    console.warn = originalWarn
    rmSync(dir, { recursive: true, force: true })
  }
})

test('필터 경계: 원고 본문·공백 없는 경로·식별값·Error message 는 한 글자도 남지 않는다', () => {
  // 검토 roh-1 재현 1~3 을 파일 없이 직접 잠근다 - 이 셋이 다시 통과하면 로그가 개인정보 통로가 된다.
  const cases = [
    // 재현 1: 한글 산문. 콜론·등호가 없어도 낱말 단위로 걸러진다.
    '원고 3장 마지막 문단을 요약해줘 studentKim 20201234',
    // 재현 2: 공백 없는 절대경로·상대경로. `/`·`\` 가 낱말 안에 있으면 라벨·숫자도 아니다.
    'open /Users/nara/논문/초안.hwp C:\\Users\\nara\\paper.docx .knuaf-gui/jobs/9f2.json',
    // 재현 3: 이름·식별값이 값 자리에 온 경우. `state=`·`provider=` 는 열거형이라 대문자·낙타꼴을 버린다.
    'state=studentKim provider=Codex-Claude reason=지문불일치 type=2020-12345',
    'reason=studentkim provider=studentkim code=studentkim type=studentkim',
    '원고 memo:studentkim [studentkim] 20201234',
    '{"type":"collect-skip","id":"studentkim","root":"/home/test/My Thesis/studentkim","error":"학생 원고 내용","reason":"no-declaration"}',
    // Error message 가 통째로 온 경우(예전 `safeWrite:fail ${error.message}`).
    'EACCES: permission denied, open \'/Users/nara/논문/chat.json\'',
    // base64·토큰 덩어리는 경로 규칙에 안 걸리므로 값 모양 규칙이 잡아야 한다.
    `token ${'QUJD'.repeat(20)}`
  ]
  for (const text of cases) {
    const fields = consoleFields([text])
    for (const leak of ['studentKim', 'studentkim', '20201234', '초안', 'paper.docx', '지문', '2020-12345', 'permission denied', 'QUJD']) {
      expect(fields, `필터가 값을 남겼다(${leak}): ${text}`).not.toContain(leak)
    }
    expect(fields, `맨 숫자·라벨도 아닌 문장에서 무엇을 남겼나: ${text}`).not.toContain('nara')
  }
  // 반대로 진단 가치는 남아야 한다 - 전부 버리면 로그가 쓸모없다.
  expect(consoleFields(['safeWrite:fail code=EPERM pid=321 1234ms']))
    .toBe('safeWrite:fail code=EPERM pid=321')
  expect(consoleFields(['[knuaf] jobs', '{"type":"collect-disabled","reason":"no-declaration","provider":"codex"}']))
    .toBe('[knuaf] type=collect-disabled reason=no-declaration provider=codex')
})

test('인수를 문자열화하지 않는다 - 사용자 정의 직렬화가 한 번도 돌지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-stringify-'))
  const originalError = console.error
  const calls: string[] = []
  try {
    // 문자열화 통로가 하나라도 있으면 이 객체들에서 예외가 나거나 호출이 기록된다.
    const hostile = {
      toString: () => { calls.push('toString'); throw new Error('toString called') },
      valueOf: () => { calls.push('valueOf'); throw new Error('valueOf called') },
      toJSON: () => { calls.push('toJSON'); throw new Error('toJSON called') },
      [Symbol.toPrimitive]: () => { calls.push('toPrimitive'); throw new Error('toPrimitive called') },
      inspect: () => { calls.push('inspect'); throw new Error('inspect called') }
    }
    const app = fakeApp({ userData: join(dir, 'userData'), logs: join(dir, 'logs') })
    console.error = () => { /* 원래 함수 자리 */ }
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(app as never)
      try {
        expect(() => console.error(hostile, { code: 'EPERM' })).not.toThrow()
        expect(() => console.error(new Error('boom'))).not.toThrow()
      } finally {
        handle.dispose()
      }
    })
    expect(calls, '콘솔 인수를 문자열화했다 - 원래 성공하던 호출이 실패할 수 있다(검토 roh-1 중요3)').toEqual([])
  } finally {
    console.error = originalError
    rmSync(dir, { recursive: true, force: true })
  }
})

test('실제 Console 직렬화는 한 번만 실행하고 후속 호출도 계속된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-inspect-'))
  const originalError = console.error
  let calls = 0
  let output = ''
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } })
  const originalConsole = new Console({ stdout: stream, stderr: stream })
  try {
    console.error = originalConsole.error.bind(originalConsole)
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(fakeApp({ userData: dir, logs: join(dir, 'logs') }) as never)
      try {
        console.error({ [inspect.custom]() {
          calls += 1
          if (calls > 1) throw new Error('duplicate serialization')
          return 'PRIVATE_CONSOLE_ONLY'
        } })
        console.error('safeWrite:fail code=EPERM')
        expect(calls).toBe(1)
        expect(output).toContain('PRIVATE_CONSOLE_ONLY')
        const text = readFileSync(handle.file, 'utf8')
        expect(text).not.toContain('PRIVATE_CONSOLE_ONLY')
        expect(text).toContain('safeWrite:fail code=EPERM')
      } finally { handle.dispose() }
    })
  } finally {
    console.error = originalError
    stream.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('실제 파일 쓰기 실패의 학생 파일명과 오류 본문은 지속 로그에 남지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-write-'))
  const file = join(dir, 'main.log')
  try {
    withEnv({ KNUAF_APP_LOG: file }, () => {
      const result = writeFileAtomic(join(dir, 'studentkim-초안.txt'), 'PRIVATE_DRAFT', {
        fs: {
          readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
          writeFileSync: () => { throw Object.assign(new Error('PRIVATE_ERROR_BODY'), { code: 'EACCES' }) },
          renameSync: () => {}, unlinkSync: () => {}
        }, delaysMs: [], log: () => {}
      })
      expect(result.ok).toBe(false)
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('safeWrite:fail code=EACCES')
      for (const value of ['studentkim', '초안', 'PRIVATE_DRAFT', 'PRIVATE_ERROR_BODY']) expect(text).not.toContain(value)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('직접 diag 오류 코드·이름의 학생값은 버리고 OS 코드와 표준 이름은 남긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-code-'))
  const file = join(dir, 'main.log')
  const errors = [
    Object.assign(new Error('PRIVATE_BODY'), { code: 'studentkim' }),
    Object.assign(new Error('PRIVATE_BODY'), { name: 'PRIVATE_DRAFT_FRAGMENT' }),
    Object.assign(new Error('PRIVATE_BODY'), { code: '김학생-초안.hwp', name: 'studentkim' }),
    Object.assign(new Error('PRIVATE_BODY'), { code: 'EACCES' }),
    new TypeError('PRIVATE_BODY')
  ]
  try {
    withEnv({ KNUAF_APP_LOG: file }, () => {
      for (const error of errors) {
        const result = writeFileAtomic(join(dir, 'unused.txt'), 'PRIVATE_BODY', {
          fs: {
            readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
            writeFileSync: () => { throw error }, renameSync: () => {}, unlinkSync: () => {}
          }, delaysMs: [], log: () => {}
        })
        expect(result.ok).toBe(false)
        expect(!result.ok && result.error).toBe(error)
      }
      const text = readFileSync(file, 'utf8')
      for (const value of ['studentkim', 'PRIVATE_DRAFT_FRAGMENT', '김학생', '초안.hwp', 'PRIVATE_BODY']) {
        expect(text).not.toContain(value)
      }
      expect(text).toContain('safeWrite:fail code=unknown')
      expect(text).toContain('safeWrite:fail code=EACCES')
      expect(text).toContain('safeWrite:fail code=TypeError')
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sidecar 종료와 kordoc 설치 실패의 임의 값은 지속 로그에 없다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-direct-'))
  const file = join(dir, 'main.log')
  const before = process.env.KNUAF_APP_LOG
  process.env.KNUAF_APP_LOG = file
  try {
    const timers: (() => void)[] = []
    const killer = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: { write() {} } })
    const sideFile = join(__dirname, '../src/main/sidecar.ts')
    const exports: Record<string, any> = {}
    const realRequire = createRequire(sideFile)
    const js = transpileModule(readFileSync(sideFile, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(js, {
      exports, Promise, process: { platform: 'win32', env: {} },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout() {},
      require: (name: string) => name === './diagLog' ? { diag }
        : name === './python' ? { scriptsDir: () => '', sidecarDir: () => '' }
        : name === 'node:child_process' ? { spawn: () => killer } : realRequire(name)
    })
    const sidecar = new exports.Sidecar()
    sidecar.owner = { child, exited: false, closed: false, tree: 'normal' }
    const stopped = sidecar.stopForExit().catch((error: unknown) => error)
    timers[0]()
    killer.emit('exit', 'PRIVATE_SIDECAR_CODE')
    await stopped

    const runtimeFile = join(__dirname, '../src/main/kordocRuntime.ts')
    const runtimeRequire = createRequire(runtimeFile)
    const runtimeExports: Record<string, any> = {}
    const runtimeJs = transpileModule(readFileSync(runtimeFile, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(runtimeJs + '\ninstallKordocRuntime = async () => { throw { code: "PRIVATE_KORDOC_CODE" } }; exports.testKick = kickInstall;', {
      exports: runtimeExports, process, console, AbortController,
      setTimeout: () => ({ unref() {} }), clearTimeout() {}, __dirname: join(__dirname, '../src/main'),
      require: (name: string) => name === 'electron' ? { app: { isPackaged: false } }
        : name === './diagLog' ? { diag } : runtimeRequire(name)
    })
    runtimeExports.testKick()
    const tick = Promise.withResolvers<void>()
    setImmediate(tick.resolve)
    await tick.promise
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('sidecar:stop:')
    expect(text).toContain('kordoc 설치 실패')
    expect(text).not.toContain('PRIVATE_SIDECAR_CODE')
    expect(text).not.toContain('PRIVATE_KORDOC_CODE')
  } finally {
    if (before === undefined) delete process.env.KNUAF_APP_LOG
    else process.env.KNUAF_APP_LOG = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('감시 훅이 던지지 않는다 - 던지는 code accessor 가 있어도 원래 오류와 종료 코드 1 이 그대로다', () => {
  // 중요2 는 "던지면 종료 코드가 1 → 7 로 바뀐다"는 자식 프로세스 실측이었다. 여기서도 자식에서 직접 잰다.
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-hook-'))
  try {
    // mainLog 는 electron 을 **타입으로만** import 한다 - 트랜스파일하면 런타임 의존은 diagLog 뿐이다.
    const transpile = (file: string): string => transpileModule(readFileSync(file, 'utf-8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    writeFileSync(join(dir, 'diagLog.js'), transpile(join(__dirname, '..', 'src', 'main', 'diagLog.ts')))
    writeFileSync(join(dir, 'mainLog.js'), transpile(join(__dirname, '..', 'src', 'main', 'mainLog.ts')))

    const driver = join(dir, 'driver.js')
    writeFileSync(driver, `
      const { EventEmitter } = require('node:events')
      const { installMainLog } = require('./mainLog.js')
      const logs = ${JSON.stringify(join(dir, 'logs'))}
      const app = Object.assign(new EventEmitter(), {
        getPath: (name) => (name === 'logs' ? logs : ${JSON.stringify(dir)}),
        setAppLogsPath: () => {}, setPath: () => {}
      })
      if (process.env.KNUAF_TEST_MONITOR === '1') installMainLog(app)
      const error = new Error('원래 오류 message - 경로 /Users/nara/논문')
      Object.defineProperty(error, 'code', { get() { throw new Error('code getter') } })
      Object.defineProperty(error, 'name', { get() { throw new Error('name getter') } })
      throw error
    `)
    // name getter 는 Node 자체의 Error 출력도 막을 수 있다. 메시지 존재를 가정하지 않고
    // 동일한 오류를 감시 설치 전/후 각각 던져 종료 코드와 stderr 전체가 같은지 비교한다.
    const baseline = spawnSync(process.execPath, [driver], {
      encoding: 'utf-8', timeout: 30_000, env: { ...process.env, KNUAF_TEST_MONITOR: '0' }
    })
    const result = spawnSync(process.execPath, [driver], {
      encoding: 'utf-8', timeout: 30_000, env: { ...process.env, KNUAF_TEST_MONITOR: '1' }
    })
    expect(baseline.error).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(baseline.status).toBe(1)
    expect(result.signal, '자식이 시그널로 죽었다').toBe(baseline.signal)
    expect(result.status, '감시 훅이 종료 코드를 바꿨다').toBe(baseline.status)
    expect(result.stderr, '감시 훅이 Node 원래 오류 출력을 바꿨다').toBe(baseline.stderr)

    const text = readFileSync(join(dir, 'logs', 'main.log'), 'utf-8')
    expect(text, '던지는 accessor 를 만나면 코드 자리는 unknown 이어야 한다').toContain('[uncaught] origin=uncaughtException code=unknown')
    expect(text, '예외 기록에 Error message 가 샜다').not.toContain('원래 오류 message')
  } finally {
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

test('파괴된 창은 감시 목록에서 빠지고 리스너도 떨어진다 - 창을 반복 생성해도 쌓이지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-mainlog-destroyed-'))
  try {
    const app = fakeApp({ userData: join(dir, 'userData'), logs: join(dir, 'logs') })
    const created: (EventEmitter & { gone: number })[] = []
    withEnv({ KNUAF_APP_LOG: undefined }, () => {
      const handle = installMainLog(app as never)
      try {
        for (let i = 0; i < 5; i += 1) {
          const contents = Object.assign(new EventEmitter(), { gone: 0 })
          contents.on('render-process-gone', () => { contents.gone += 1 })
          created.push(contents)
          app.emit('web-contents-created', {}, contents)
        }
        expect(handle.renderers, '감시 목록에 창이 안 들어왔다').toBe(5)
        // 창이 닫히면(파괴) 목록·리스너가 함께 정리된다. 안 하면 figures/reencode-window 처럼
        // 창을 반복해서 만드는 경로에서 참조가 무한히 쌓인다(검토 roh-1 권고4).
        created[0].emit('destroyed')
        created[1].emit('destroyed')
        expect(handle.renderers, 'destroyed 인데 감시 목록에 남았다 - 참조 누수').toBe(3)
        expect(created[0].listenerCount('render-process-gone'), '파괴된 창의 리스너를 떼지 않았다').toBe(1)
      } finally {
        handle.dispose()
      }
      expect(handle.renderers, 'dispose 가 목록을 비우지 않았다').toBe(0)
    })
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
