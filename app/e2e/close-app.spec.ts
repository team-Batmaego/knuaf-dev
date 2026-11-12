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
 * 고정하는 계약:
 *  - `close()` 가 영영 안 돌아와도 `ms` 안에 돌아온다.
 *  - 그때 프로세스를 강제로 정리하고 `close:force` 를 남긴다(조용히 넘기지 않는다).
 *  - `close()` 가 거절해도 시험을 깨뜨리지 않는다.
 *  - 어느 갈래든 마지막 표시는 **반드시** `close:end` 다. 없으면 헬스비트가 워커 종료까지
 *    돌아, 통과한 시험도 매달린 것처럼 보인다(오탐).
 */
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { closeApp } from './helpers'

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

test('close() 가 안 돌아오면 상한 안에 끝나고, 강제 정리 흔적을 남긴다', async () => {
  const { app, killed } = fakeApp({ close: () => new Promise<void>(() => {}), pid: 4242 })
  const log = recorder()
  const started = Date.now()
  await closeApp(app, log, 300)
  const elapsed = Date.now() - started

  expect(elapsed, '상한을 넘겨 매달렸다').toBeLessThan(3_000)
  expect(log.stages[0]).toBe('close:start')
  expect(log.stages).toContain('close:force pid=4242 상한=300ms')
  expect(log.stages.at(-1), '마지막 표시가 close:end 가 아니다').toBe('close:end')
  // 맥·리눅스 갈래는 proc.kill 이다(윈도우는 taskkill /T /F — 이 시험은 그 갈래를 못 만든다).
  if (process.platform !== 'win32') expect(killed).toEqual(['SIGKILL'])
})

test('close() 가 정상으로 끝나면 강제 정리하지 않고 close:end 만 남긴다', async () => {
  const { app, killed } = fakeApp({ close: async () => {}, pid: 4242 })
  const log = recorder()
  await closeApp(app, log, 5_000)

  expect(log.stages).toEqual(['close:start', 'close:end'])
  expect(killed, '정상 종료인데 프로세스를 죽였다').toEqual([])
})

test('close() 가 거절해도 시험을 깨뜨리지 않고 close:end 를 남긴다', async () => {
  const { app } = fakeApp({ close: async () => { throw new Error('Application exited') }, pid: 4242 })
  const log = recorder()
  await expect(closeApp(app, log, 5_000)).resolves.toBeUndefined()
  expect(log.stages).toEqual(['close:start', 'close:end'])
})

test('pid 가 없으면 강제 정리를 건너뛰되 close:end 는 남긴다', async () => {
  const { app } = fakeApp({ close: () => new Promise<void>(() => {}) })
  const log = recorder()
  await closeApp(app, log, 200)

  expect(log.stages).toContain('close:force pid=없음 상한=200ms')
  expect(log.stages.at(-1)).toBe('close:end')
})
