// Unit test for src/main/win.ts `killTree` — plain Playwright `test()` in Node: no Electron.
//
// RT3(검토 RT2-02): 종료 경로의 윈도우 트리 종료가 `spawnSync(timeout 10_000)` 이라 main 스레드를
// 최대 10초 막았고, 그래서 "종료 마감 10초"가 이벤트 루프 안에서 지켜지지 않았다. 이 시험은
// **같은 이벤트 루프가 그 사이 돌 수 있는지**를 본다 — 맥에서도 가짜 taskkill 로 결정적으로.
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTree } from '../src/main/win'

/**
 * `taskkill.exe` 대역 — `killTree` 가 보는 `<SystemRoot>\System32\taskkill.exe` 자리에 둔다.
 *
 * **윈도우에서는 셸 스크립트가 실행되지 않는다**(CI 실패: `ENOENT …\System32\taskkill.exe`,
 * 그리고 폴더도 만들지 않았다). 그래서 플랫폼마다 실제로 실행되는 형식을 쓴다:
 *  - macOS·리눅스: `#!/bin/sh` 스크립트(`sleep` 으로 느리게).
 *  - 윈도우: **node 실행 파일 복사본**을 `taskkill.exe` 로 두고, `NODE_OPTIONS=--require <bootstrap>`
 *    으로 마커·인자를 적고 지정 시간만큼 기다린 뒤 종료 코드를 정한다. 제품은 `taskkill.exe` 를
 *    인자(`/pid <n> /T /F`)로 직접 spawn 하므로 이 대역이 그대로 그 경로를 지난다.
 */
function fakeTaskkill(ms: number, exitCode = 0): {
  root: string
  run: () => Promise<void>
  restore: () => void
  ran: () => boolean
  args: () => string[]
  /** 가짜 실행 파일이 **끝까지 돌아** 완료 표식을 남길 때 resolve — 시간 대기 대신 이 신호를 쓴다. */
  finished: Promise<void>
} {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-kill-'))
  const marker = join(root, 'ran.txt')
  const argsFile = join(root, 'args.txt')
  const doneFile = join(root, 'done.txt')
  const finished = Promise.withResolvers<void>()
  // 완료 표시를 기다리는 **유일한** 감시 — 시험이 시간 여유를 늘리지 않고 실행 완료를 알 수 있게 한다.
  const doneWatch = setInterval(() => {
    if (!existsSync(doneFile)) return
    clearInterval(doneWatch)
    finished.resolve()
  }, 5)
  doneWatch.unref?.()
  const stopWatching = (): void => { clearInterval(doneWatch) }
  const exe = process.platform === 'win32' ? join(root, 'System32', 'taskkill.exe') : `${root}\\System32\\taskkill.exe`
  const previous = process.env.NODE_OPTIONS
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'System32'), { recursive: true })   // 윈도우는 실제 폴더가 필요하다
    const bootstrap = join(root, 'taskkill-bootstrap.cjs')
    writeFileSync(bootstrap, [
      `const { writeFileSync } = require('node:fs')`,
      // node 실행 파일을 **인자와 함께** 부르면 node 는 argv[1] 을 실행할 스크립트로 읽는다.
      // 우리 bootstrap 은 그 전에 exit 하므로, 인자는 argv.slice(1) 가 제품이 넘긴 전부다.
      `writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(1).join('\\n') + '\\n')`,
      `writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      // 동기 대기 — 제품이 기다리지 않는다는 것이 이 시험의 요점이다.
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Math.max(0, Math.round(ms))})`,
      `writeFileSync(${JSON.stringify(doneFile)}, 'done')`,
      `process.exit(${exitCode})`
    ].join('\n'), 'utf-8')
    // node 실행 파일을 그 자리에 둔다 — 하드링크 우선(복사 비용 없음), 안 되면 복사.
    try { linkSync(process.execPath, exe) } catch { copyFileSync(process.execPath, exe) }
    return {
      root,
      run: async () => { process.env.NODE_OPTIONS = `--require ${JSON.stringify(bootstrap)}` },
      restore: () => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; stopWatching() },
      ran: () => { try { return existsSync(marker) } catch { return false } },
      args: () => { try { return readFileSync(argsFile, 'utf-8').trim().split('\n') } catch { return [] } },
      finished: finished.promise
    }
  }
  mkdirSync(root, { recursive: true })   // POSIX 에서는 `System32\taskkill.exe` 가 **파일 이름 하나**다
  writeFileSync(exe, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    `: > ${JSON.stringify(marker)}`,
    `sleep ${(ms / 1000).toFixed(3)}`,
    `: > ${JSON.stringify(doneFile)}`,
    `exit ${exitCode}`
  ].join('\n'), { mode: 0o755 })
  return {
    root,
    run: async () => { /* POSIX 는 환경 준비가 필요 없다 */ },
    restore: () => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; stopWatching() },
    ran: () => { try { return existsSync(marker) } catch { return false } },
    args: () => { try { return readFileSync(argsFile, 'utf-8').trim().split('\n') } catch { return [] } },
    finished: finished.promise
  }
}

/**
 * 완료 신호를 **정해진 예산 안에서만** 기다린다. 예산을 넘기면 false —
 * 실행되지 않은 것을 시간 초과가 아니라 단언 실패로 드러내기 위한 것이고,
 * 예산 자체는 예전 20ms×50(=1000ms) 관측보다 **길지 않다**(늘리지 않는다).
 */
const settle = async (done: Promise<void>, budgetMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs) })
  const finished = done.then(() => true)
  const result = await Promise.race([finished, timeout])
  if (timer) clearTimeout(timer)
  return result
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

test('윈도우 트리 종료는 동기로 기다리지 않는다 — 같은 이벤트 루프가 그 사이 돈다 (RT2-02)', async () => {
  const fake = fakeTaskkill(600)
  // 죽이면 안 되는 관측 대상 — 이 시험은 "막히지 않았는가"만 본다.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  try {
    await fake.run()
    let ticks = 0
    const ticker = setInterval(() => { ++ticks }, 20)
    const started = Date.now()
    killTree({ pid: child.pid!, kill: () => true }, 'SIGTERM', { platform: 'win32', env: { SystemRoot: fake.root } })
    const callMs = Date.now() - started
    // 호출 자체가 바로 돌아와야 한다 — taskkill 이 끝나기를 기다리면 여기서 600ms 가 걸린다.
    expect(callMs, `killTree 가 ${callMs}ms 동기로 막았다`).toBeLessThan(250)
    // 그리고 그 600ms 동안 타이머가 여러 번 돌아야 한다(루프가 살아 있었다는 뜻).
    await new Promise((resolve) => setTimeout(resolve, 700))
    clearInterval(ticker)
    expect(ticks, '이벤트 루프가 막혀 타이머가 돌지 못했다').toBeGreaterThan(5)
    // 실제로 띄웠는지 — 시간 여유를 두지 않고 **가짜 실행 파일의 완료 신호**를 기다린다.
    // 예산은 바로 위 관측 창과 같은 700ms 다(600ms 지연 + 시작이 그 안에 들어와야 한다).
    expect(await settle(fake.finished, 700), '가짜 taskkill 이 700ms 안에 끝나지 않았다').toBe(true)
    expect(fake.ran(), 'taskkill 을 아예 띄우지 않았다').toBe(true)
    expect(fake.args(), 'pid·트리 인자로 부르지 않았다').toEqual(['/pid', String(child.pid), '/T', '/F'])
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    fake.restore()
  }
})

test('taskkill 이 거절하면 직접 kill 로 넘어간다 (RT2-02)', async () => {
  const fake = fakeTaskkill(0, 1)   // 종료 코드 1 = 거절
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  const pid = child.pid!
  try {
    await fake.run()
    const signals: (NodeJS.Signals | undefined)[] = []
    killTree({ pid, kill: (signal) => { signals.push(signal); return true } }, 'SIGTERM', { platform: 'win32', env: { SystemRoot: fake.root } })
    // 가짜 실행 파일이 **실제로 실행돼 끝났는지** 먼저 증명한다 — 이게 없으면 "실행 자체가
    // 실패해 직접 kill 로 갔다"와 "실행은 됐고 종료 코드 1 이었다"를 구별할 수 없다(검토 중요 1).
    expect(await settle(fake.finished, 700), '가짜 taskkill 이 700ms 안에 끝나지 않았다').toBe(true)
    expect(fake.ran(), 'taskkill 을 아예 띄우지 않았다').toBe(true)
    expect(fake.args(), 'pid·트리 인자로 부르지 않았다').toEqual(['/pid', String(pid), '/T', '/F'])
    // 직접 kill 로 넘어가는 것은 제품이 taskkill 의 **종료 코드**를 받은 뒤라, 실행 완료 표시
    // 다음에 온다. 아래는 그 신호를 기다리는 짧은 상한(≤100ms)이다 — '실행됐는가'의 허용 시간을
    // 늘리는 대기가 아니다(그 증명은 바로 위에서 이미 끝났다).
    for (let i = 0; i < 20 && !signals.length; i++) await new Promise((r) => setTimeout(r, 5))
    expect(signals, 'taskkill 실패 뒤 직접 kill 이 없었다').toEqual(['SIGTERM'])
    expect(alive(pid), '시험용 자식이 죽었다 — 이 시험은 신호만 본다').toBe(true)
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    fake.restore()
  }
})

test('taskkill 이 없으면 즉시 직접 kill 로 간다 (RT2-02)', () => {
  const signals: (NodeJS.Signals | undefined)[] = []
  killTree({ pid: 4242, kill: (signal) => { signals.push(signal); return true } }, 'SIGKILL', { platform: 'win32', env: { SystemRoot: mkdtempSync(join(tmpdir(), 'kd-nokill-')) } })
  expect(signals).toEqual(['SIGKILL'])
})

test('맥 경로는 그대로 child.kill 이다 (동작 불변)', () => {
  const signals: (NodeJS.Signals | undefined)[] = []
  killTree({ pid: 4242, kill: (signal) => { signals.push(signal); return true } }, 'SIGTERM', { platform: 'darwin', env: {} })
  expect(signals).toEqual(['SIGTERM'])
})
