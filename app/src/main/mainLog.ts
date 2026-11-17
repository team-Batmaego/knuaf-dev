import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import type { App, Event as ElectronEvent, RenderProcessGoneDetails, WebContents } from 'electron'
import { appendScrubbed, codeOf, logFile, setDefaultLogFile } from './diagLog'

/**
 * 출시판 파일 로그의 배선 - 설치된 앱은 콘솔이 없어서 `console.error` 55곳과 `diag()` 53곳이
 * 전부 증발했다(inv-logs/RESULT.md). G0 에서 "위임이 왜 거절됐는지"를 남은 기록으로 밝히지 못한
 * 것이 이 구멍이다. 여기서 세 갈래를 **같은 파일**로 모은다:
 *
 *  1. `diag()` - 경로 기본값을 `app.getPath('logs')/main.log` 로 정한다(환경변수는 덮어쓰기용).
 *  2. `console.error`·`console.warn` - 원래 함수는 **그대로 호출**하고 사본만 파일에 남긴다.
 *     콘솔 출력을 죽이면 개발 실행·e2e 의 기존 관측이 사라진다.
 *  3. 프로세스 예외·렌더러 크래시 - `uncaughtExceptionMonitor`(감시 전용, **동작 불변**)와
 *     `web-contents-created` 뒤의 `render-process-gone`.
 *
 * `process.on('uncaughtException')` 은 **달지 않는다**: 그 리스너가 있으면 Node 가 프로세스를
 * 종료하지 않고 넘어가 종료 코드·동작이 바뀐다. 감시만 하는 훅이 `uncaughtExceptionMonitor` 다.
 * `unhandledRejection` 도 달지 않는다 - 리스너의 유무가 기본 처리(경고 후 종료)를 바꾼다.
 *
 * 모든 기록은 `diagLog.appendScrubbed` 한 곳을 지난다(`scrub` + 1MB 회전). 값·경로는 파일에 닿지 않는다.
 */

export interface MainLogHandle {
  /** 지금 기록되는 파일(절대 경로). 진단이 꺼졌으면 빈 문자열. */
  readonly file: string
  /** 건 콘솔 패치·리스너를 되돌린다. 프로세스 수명 동안 유지하는 것이 정상이지만, 시험이 누수를 본다. */
  dispose(): void
}

/** `console` 메서드의 최소 모양 - 원래 구현을 그대로 부르기만 한다. */
type ConsoleMethod = (...args: unknown[]) => void

/**
 * 로그 폴더를 정하고(없으면 만든다) `diag` 의 기본 경로를 그 안으로 옮긴 뒤 감시를 건다.
 *
 * 기동 때 한 번 부른다(`index.ts`). `app.getPath('logs')` 는 electron 기본값이
 * 맥 `~/Library/Logs/<앱 이름>`, 윈도우 `%APPDATA%\<앱 이름>\logs` 다 - `setAppLogsPath` 를
 * 부르지 않아도 된다(부르면 오히려 경로를 새로 정하는 셈이다).
 */
export function installMainLog(app: App): MainLogHandle {
  /**
   * e2e 는 `KNUAF_USER_DATA` 로 userData 를 임시 폴더에 격리한다. 로그도 같은 격리 안에 둬야
   * 병렬 샤드가 개발자의 실제 로그 폴더에서 섞이지 않고, 임시 폴더가 지워질 때 함께 사라진다.
   * 설치판·개발 실행에는 이 변수가 없으므로 electron 기본값(`app.getPath('logs')`)을 쓴다.
   *
   * 격리 경로는 `setAppLogsPath` 로 electron 에도 알린다 - '로그 폴더 열기'(ipc.ts)가
   * `app.getPath('logs')` 를 열기 때문이다. 그 호출이 실패해도 파일 위치는 아래에서 정한
   * 경로 그대로 쓴다(경로를 못 바꾸면 폴더 열기가 기본 자리를 열 수 있다 - 그 경우만 어긋난다).
   */
  const userData = (): string => {
    try { return app.getPath('userData') } catch { return '' }
  }
  const isolated = process.env.KNUAF_USER_DATA ? join(userData() || '.', 'logs') : ''
  let dir = isolated
  if (isolated) {
    try { app.setAppLogsPath(isolated) } catch {
      // 아주 이른 실패를 대비한 두 번째 통로 - setPath 는 폴더가 이미 있어야 한다.
      try { mkdirSync(isolated, { recursive: true }); app.setPath('logs', isolated) } catch { /* 파일 위치는 isolated 그대로 */ }
    }
  } else {
    try { dir = app.getPath('logs') } catch { dir = userData() ? join(userData(), 'logs') : '' }
  }
  if (dir) {
    // '로그 폴더 열기'(ipc.ts)가 만들던 폴더를 이제 기동이 만든다 - 열었을 때 비어 있지 않게.
    try { mkdirSync(dir, { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
    setDefaultLogFile(join(dir, 'main.log'))
  }

  // 원래 함수를 기억해 둔다 - 패치가 겹쳐도(중복 설치) 원본을 부르고, dispose 가 정확히 되돌린다.
  const before: Record<'error' | 'warn', ConsoleMethod> = { error: console.error, warn: console.warn }
  const patch = (tag: string, original: ConsoleMethod): ConsoleMethod =>
    (...args: unknown[]): void => {
      // 값·경로는 appendScrubbed 안의 scrub 이 지운다. 조립(format)은 진단이 켜졌을 때만 한다.
      const target = logFile()
      if (target) appendScrubbed(target, `${Date.now()} [${tag}] ${format(...args)}`)
      original.apply(console, args)
    }
  const patched = { error: patch('console.error', before.error), warn: patch('console.warn', before.warn) }
  console.error = patched.error
  console.warn = patched.warn

  /**
   * 감시 전용 훅. `origin` 은 `uncaughtException`·`unhandledRejection` 이고, 오류는 **이름·코드만**
   * 남긴다 - `message`·`stack` 에는 경로·토큰·원고 본문이 들어올 수 있다.
   */
  const onUncaught = (error: Error, origin: string): void => {
    appendScrubbed(logFile(), `${Date.now()} [uncaught] origin=${origin} code=${codeOf(error)}`)
  }
  // 진단이 꺼져 있으면(경로를 못 얻음) 리스너를 달지 않는다 - 쓸 곳이 없는데 전역 상태만 늘린다.
  if (logFile()) process.on('uncaughtExceptionMonitor', onUncaught)

  /** 렌더러가 죽은 이유. `clean-exit` 은 그냥 창이 닫힌 것이라 남기지 않는다. */
  const goneListeners = new Map<WebContents, (event: ElectronEvent, details: RenderProcessGoneDetails) => void>()
  const onWebContentsCreated = (_event: ElectronEvent, contents: WebContents): void => {
    const listener = (_e: ElectronEvent, details: RenderProcessGoneDetails): void => {
      if (details.reason === 'clean-exit') return
      appendScrubbed(logFile(), `${Date.now()} [renderer-gone] reason=${details.reason} exit=${details.exitCode}`)
    }
    goneListeners.set(contents, listener)
    contents.on('render-process-gone', listener)
  }
  if (logFile()) app.on('web-contents-created', onWebContentsCreated)

  return {
    get file() { return logFile() },
    dispose() {
      process.removeListener('uncaughtExceptionMonitor', onUncaught)
      app.removeListener('web-contents-created', onWebContentsCreated)
      for (const [contents, listener] of goneListeners) {
        // 이미 파괴된 창은 던진다 - 되돌리기가 예외로 끝나면 나머지 정리가 멈춘다.
        try { contents.removeListener('render-process-gone', listener) } catch { /* 파괴된 contents */ }
      }
      goneListeners.clear()
      // 다른 코드가 그 사이 console 을 다시 감쌌다면 남의 패치를 벗기지 않는다.
      if (console.error === patched.error) console.error = before.error
      if (console.warn === patched.warn) console.warn = before.warn
    }
  }
}
