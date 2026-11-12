/**
 * `closeApp` 의 **마감 갈래**를 잠그는 Node 단위 시험 — Electron 창 없이.
 *
 * 왜 필요한가: 윈도우 CI 에서 앱이 `stage=process-exit code=0` 으로 정상 종료했는데도
 * Playwright 의 `close()` 가 돌아오지 않아 시험이 90초 타임아웃으로 죽었다(run 43296520840
 * 윈도우 샤드 4). 그 대기에는 상한이 없다 — `closeApp` 이 그 위에 상한을 얹는다.
 *
 * 그런데 **상한에 실제로 닿는 갈래는 CI 에서 거의 안 돈다**(앱이 정상 종료하면 안 닿는다).
 * 맥에서는 더더욱 안 돈다. 그래서 여기서 가짜 앱으로 갈래를 직접 만든다.
 *
 * **실제 프로세스를 절대 건드리지 않는다**(검토 C-01). 강제 종료는 `opts.forceKill` 주입으로
 * 갈아 끼우고, 윈도우 명령·pid·옵션은 `killPlan()` 이 만든 **값**으로 단언한다 — 가짜 pid 를
 * `taskkill` 에 넘겨 무관한 러너 프로세스를 죽이는 경로가 없다.
 *
 * 고정하는 계약:
 *  - `close()` 가 영영 안 돌아와도 `ms` 안에 돌아온다.
 *  - 그때 프로세스를 강제로 정리하고 `close:force` 를 남긴다(조용히 넘기지 않는다).
 *  - 정리 명령은 윈도우에서 `taskkill /pid <pid> /T /F`(+timeout), 그 외 `SIGKILL` 이다.
 *  - `close()` 가 거절해도 시험을 깨뜨리지 않고 `close:rejected` 에 이유를 남긴다.
 *  - 강제 정리가 실패하면 `close:force-failed` 를 남기고 **던진다**(통과로 덮지 않는다).
 *  - 어느 갈래든 마지막 표시는 **반드시** `close:end` 다. 없으면 헬스비트가 워커 종료까지
 *    돌아, 통과한 시험도 매달린 것처럼 보인다(오탐).
 */
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { closeApp, forceKill, killPlan, type ForceKiller, type KillOutcome, type SpawnOutcome } from './helpers'

/** `closeApp` 이 실제로 쓰는 두 가지만 흉내 낸다 — close() 와 process(). */
function fakeApp(behaviour: { close: () => Promise<void>; pid?: number }) {
  const killed: string[] = []
  const app = {
    close: behaviour.close,
    process: () => ({ pid: behaviour.pid, kill: (sig: string) => { killed.push(sig); return true } })
  } as unknown as ElectronApplication
  return { app, killed }
}

function recorder(): { mark: (stage: string) => void; stages: string[] } {
  const stages: string[] = []
  return { mark: (stage: string) => { stages.push(stage) }, stages }
}

/** 실제 종료 대신 호출만 기록하는 실행기. */
function spyKiller(outcome: KillOutcome = { ok: true }) {
  const calls: { pid: number; kind: string }[] = []
  const forceKill: ForceKiller = (target) => {
    calls.push({ pid: target.pid, kind: 'injected' })
    return outcome
  }
  return { forceKill, calls }
}

test('마감 명령: 윈도우는 taskkill /T /F + timeout, 그 외는 SIGKILL — 실제 실행 없음', () => {
  const win = killPlan(4242, 'win32')
  expect(win).toEqual({
    kind: 'taskkill',
    command: 'taskkill /pid 4242 /T /F',
    options: { shell: true, windowsHide: true, timeout: 5_000 }
  })
  expect(killPlan(4242, 'darwin')).toEqual({ kind: 'signal', signal: 'SIGKILL' })
  expect(killPlan(4242, 'linux')).toEqual({ kind: 'signal', signal: 'SIGKILL' })
})

test('close() 가 안 돌아오면 상한 안에 끝나고, 강제 정리 흔적을 남긴다', async () => {
  const { app } = fakeApp({ close: () => new Promise<void>(() => {}), pid: 4242 })
  const log = recorder()
  const killer = spyKiller()
  const started = Date.now()
  await closeApp(app, log, 300, { forceKill: killer.forceKill })
  const elapsed = Date.now() - started

  expect(elapsed, '상한을 넘겨 매달렸다').toBeLessThan(3_000)
  expect(log.stages[0]).toBe('close:start')
  expect(log.stages).toContain('close:force pid=4242 상한=300ms')
  expect(log.stages.at(-1), '마지막 표시가 close:end 가 아니다').toBe('close:end')
  expect(killer.calls, '강제 정리 대상 pid 가 다르다').toEqual([{ pid: 4242, kind: 'injected' }])
})

test('close() 가 정상으로 끝나면 강제 정리하지 않고 close:end 만 남긴다', async () => {
  const { app } = fakeApp({ close: async () => {}, pid: 4242 })
  const log = recorder()
  const killer = spyKiller()
  await closeApp(app, log, 5_000, { forceKill: killer.forceKill })

  expect(log.stages).toEqual(['close:start', 'close:end'])
  expect(killer.calls, '정상 종료인데 프로세스를 죽였다').toEqual([])
})

test('close() 가 거절해도 시험을 깨뜨리지 않고 close:rejected 에 이유를 남긴다', async () => {
  const { app } = fakeApp({ close: async () => { throw new Error('Application exited') }, pid: 4242 })
  const log = recorder()
  await expect(closeApp(app, log, 5_000, { forceKill: spyKiller().forceKill })).resolves.toBeUndefined()
  expect(log.stages).toEqual(['close:start', 'close:rejected Application exited', 'close:end'])
})

test('강제 정리가 실패하면 close:force-failed 를 남기고 던진다', async () => {
  const { app } = fakeApp({ close: () => new Promise<void>(() => {}), pid: 4242 })
  const log = recorder()
  const killer = spyKiller({ ok: false, detail: 'taskkill status=1' })
  await expect(closeApp(app, log, 200, { forceKill: killer.forceKill }))
    .rejects.toThrow('close:force-failed taskkill status=1')

  expect(log.stages).toContain('close:force-failed taskkill status=1')
  expect(log.stages.at(-1), '실패해도 close:end 는 남아야 한다').toBe('close:end')
})

test('pid 가 없으면 강제 정리를 건너뛰되 close:end 는 남긴다', async () => {
  const { app } = fakeApp({ close: () => new Promise<void>(() => {}) })
  const log = recorder()
  const killer = spyKiller()
  await closeApp(app, log, 200, { forceKill: killer.forceKill })

  expect(log.stages).toContain('close:force pid=없음 상한=200ms')
  expect(log.stages.at(-1)).toBe('close:end')
  expect(killer.calls, 'pid 가 없는데 정리를 시도했다').toEqual([])
})

/** 실제 `taskkill`·`kill` 없이 `forceKill` 의 판정만 본다 — spawn·생존 확인을 갈아 끼운다. */
function spawned(platform: NodeJS.Platform, outcome: SpawnOutcome, aliveAfter: boolean) {
  const calls: { command: string; options: object }[] = []
  return {
    calls,
    deps: {
      platform,
      alive: () => aliveAfter,
      spawn: (command: string, options: object) => { calls.push({ command, options }); return outcome }
    }
  }
}

test('forceKill: 윈도우는 실제 명령 없이 taskkill /T /F 를 그대로 넘기고 성공을 받는다', () => {
  const s = spawned('win32', { status: 0, signal: null }, false)
  const target = { pid: 4242, kill: () => true }
  expect(forceKill(target, s.deps)).toEqual({ ok: true })
  expect(s.calls).toEqual([
    {
      command: 'taskkill /pid 4242 /T /F',
      options: { shell: true, windowsHide: true, timeout: 5_000 }
    }
  ])
})

test('forceKill: 0 이 아닌 코드라도 pid 가 이미 없으면 성공으로 본다', () => {
  const s = spawned('win32', { status: 128, signal: null }, false)
  expect(forceKill({ pid: 4242, kill: () => true }, s.deps)).toEqual({ ok: true })
})

test('forceKill: 0 이 아닌 코드 + pid 생존이면 실패로 드러낸다', () => {
  const s = spawned('win32', { status: 1, signal: null }, true)
  expect(forceKill({ pid: 4242, kill: () => true }, s.deps))
    .toEqual({ ok: false, detail: 'taskkill status=1' })
})

test('forceKill: spawn 자체 오류·시그널 종료도 이유를 남긴다', () => {
  const missing = spawned('win32', { status: null, signal: null, error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }, true)
  expect(forceKill({ pid: 4242, kill: () => true }, missing.deps))
    .toEqual({ ok: false, detail: 'taskkill ENOENT' })

  const killed = spawned('win32', { status: null, signal: 'SIGTERM' }, true)
  expect(forceKill({ pid: 4242, kill: () => true }, killed.deps))
    .toEqual({ ok: false, detail: 'taskkill signal=SIGTERM' })
})

test('forceKill: POSIX 는 kill() false 를 생존 여부로 판정한다', () => {
  const alive = { pid: 4242, kill: () => false }
  expect(forceKill(alive, { platform: 'darwin', alive: () => true }))
    .toEqual({ ok: false, detail: 'kill(SIGKILL) false' })
  expect(forceKill(alive, { platform: 'darwin', alive: () => false })).toEqual({ ok: true })
})
