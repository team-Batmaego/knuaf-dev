// Unit test for src/main/win.ts `killTree` — plain Playwright `test()` in Node: no Electron.
//
// RT3(검토 RT2-02): 종료 경로의 윈도우 트리 종료가 `spawnSync(timeout 10_000)` 이라 main 스레드를
// 최대 10초 막았고, 그래서 "종료 마감 10초"가 이벤트 루프 안에서 지켜지지 않았다. 이 시험은
// **같은 이벤트 루프가 그 사이 돌 수 있는지**를 본다 — 맥에서도 가짜 taskkill 로 결정적으로.
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTree } from '../src/main/win'

/**
 * `taskkill.exe` 대역 — `Windows/System32/taskkill.exe` 자리에 느린 스크립트를 둔다.
 * `killTree` 는 `SystemRoot` 아래 절대 경로만 보므로, 이 환경값 하나로 갈아 끼울 수 있다.
 */
function slowTaskkill(ms: number): { env: Record<string, string | undefined>; ran: () => boolean; args: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-kill-'))
  // `taskkillPath` 는 `<SystemRoot>\System32\taskkill.exe` 를 **문자열로** 만든다 — 맥에서는
  // 그 역슬래시가 경로 구분자가 아니라 파일 이름의 일부다. 같은 문자열을 그대로 만들어 둔다.
  const exe = `${root}\\System32\\taskkill.exe`
  mkdirSync(root, { recursive: true })  // System32 는 파일 이름 안에 있으므로 폴더를 만들지 않는다
  const marker = join(root, 'ran.txt')
  const argsFile = join(root, 'args.txt')
  writeFileSync(exe, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    `: > ${JSON.stringify(marker)}`,
    // 셸에서만 잠깐 잡아 둔다 — Node 쪽이 기다리지 않는지가 이 시험의 요점이다.
    `sleep ${(ms / 1000).toFixed(3)}`
  ].join('\n'), { mode: 0o755 })
  return {
    env: { SystemRoot: root },
    ran: () => { try { return existsSync(marker) } catch { return false } },
    args: () => { try { return readFileSync(argsFile, 'utf-8').trim().split('\n') } catch { return [] } }
  }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

test('윈도우 트리 종료는 동기로 기다리지 않는다 — 같은 이벤트 루프가 그 사이 돈다 (RT2-02)', async () => {
  const fake = slowTaskkill(600)
  // 죽이면 안 되는 관측 대상 — 이 시험은 "막히지 않았는가"만 본다.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  try {
    let ticks = 0
    const ticker = setInterval(() => { ++ticks }, 20)
    const started = Date.now()
    killTree({ pid: child.pid!, kill: () => true }, 'SIGTERM', { platform: 'win32', env: fake.env })
    const callMs = Date.now() - started
    // 호출 자체가 바로 돌아와야 한다 — taskkill 이 끝나기를 기다리면 여기서 600ms 가 걸린다.
    expect(callMs, `killTree 가 ${callMs}ms 동기로 막았다`).toBeLessThan(250)
    // 그리고 그 600ms 동안 타이머가 여러 번 돌아야 한다(루프가 살아 있었다는 뜻).
    await new Promise((resolve) => setTimeout(resolve, 700))
    clearInterval(ticker)
    expect(ticks, '이벤트 루프가 막혀 타이머가 돌지 못했다').toBeGreaterThan(5)
    expect(fake.ran(), 'taskkill 을 아예 띄우지 않았다').toBe(true)
    expect(fake.args(), 'pid·트리 인자로 부르지 않았다').toEqual(['/pid', String(child.pid), '/T', '/F'])
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
})

test('taskkill 이 거절하면 직접 kill 로 넘어간다 (RT2-02)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-win-kill-fail-'))
  writeFileSync(`${root}\\System32\\taskkill.exe`, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  const pid = child.pid!
  try {
    const signals: (NodeJS.Signals | undefined)[] = []
    killTree({ pid, kill: (signal) => { signals.push(signal); return true } }, 'SIGTERM', { platform: 'win32', env: { SystemRoot: root } })
    // 거절은 비동기로 관측되므로 잠깐 기다린다(동기 대기가 아니라는 것도 함께 증명된다).
    for (let i = 0; i < 50 && !signals.length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(signals, 'taskkill 실패 뒤 직접 kill 이 없었다').toEqual(['SIGTERM'])
    expect(alive(pid), '시험용 자식이 죽었다 — 이 시험은 신호만 본다').toBe(true)
  } finally {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
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
