import type * as heartbeatTypes from './heartbeat'
/**
 * figures/heartbeat.test.ts — 앱 생존 신호 (R4-1, 계약 §2).
 *
 * 도우미는 `updatedAt`이 15초 넘게 낡으면 즉시 실패한다. 그래서 두 가지만 잠근다: ① 시작하자마자 한 번
 * 쓰고 ② 주기마다 다시 쓰며 ③ `stop()` 뒤에는 더 쓰지 않는다(파일은 남아 스스로 낡는다).
 *
 * 시간은 `now` 주입 + 타이머 대역으로만 흐르게 한다 — 실제로 5초를 기다리는 시험은 CI에서만 느려지고
 * 경합은 그대로 남는다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})

const heartbeat = (await import(new URL('./heartbeat.ts', import.meta.url).href)) as typeof import('./heartbeat')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-beat-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readState(path: string): Promise<heartbeatTypes.HeartbeatState | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as heartbeatTypes.HeartbeatState
  } catch {
    return null
  }
}

/** 조건이 참이 될 때까지 IO 완료를 기다린다(실시간 잠 없음 — 파일 읽기가 실제 진행을 만든다). */
async function until(condition: () => Promise<boolean>, limit = 4_000): Promise<boolean> {
  for (let index = 0; index < limit; index += 1) {
    if (await condition()) return true
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return condition()
}

describe('startHeartbeat', () => {
  it('시작하자마자 {v,pid,updatedAt}를 쓴다', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'first.json')
    const beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, now: () => 1_700_000_000_000, pid: 4321 })
    assert.equal(await until(async () => (await readState(path)) !== null), true)
    await beat.stop()
    assert.deepEqual(await readState(path), { v: 1, pid: 4321, updatedAt: 1_700_000_000_000 })
  })

  it('주기마다 updatedAt을 다시 쓴다', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'repeat.json')
    let clock = 1_700_000_000_000
    const beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, now: () => clock, pid: 1 })
    assert.equal(await until(async () => (await readState(path))?.updatedAt === clock), true)
    clock += 5_000
    t.mock.timers.tick(5_000)
    assert.equal(await until(async () => (await readState(path))?.updatedAt === clock), true)
    clock += 5_000
    t.mock.timers.tick(5_000)
    assert.equal(await until(async () => (await readState(path))?.updatedAt === clock), true)
    await beat.stop()
  })

  it('stop() 뒤에는 박자가 지나도 쓰지 않고, 여러 번 불러도 안전하다', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'stop.json')
    let clock = 1_000
    const beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, now: () => clock, pid: 2 })
    assert.equal(await until(async () => (await readState(path))?.updatedAt === 1_000), true)
    await beat.stop()
    await beat.stop()
    clock += 60_000
    t.mock.timers.tick(60_000)
    await until(async () => false, 20)
    assert.equal((await readState(path))?.updatedAt, 1_000)
  })

  /**
   * I-03: 첫 박자의 쓰기 실패가 **비처리 거절**로 새면 그림 하나 때문에 프로세스가 종료된다.
   * 경로를 디렉터리로 막아 첫 쓰기를 반드시 실패시킨다.
   *
   * 남은 경계(검토 실측): 실패를 삼키기만 하면 통로가 살아 있는 채로 남아 `beginTurn` 이 `turn.json` 을
   * 쓰고 감시자가 계속 돈다 — 그래서 실패는 `first` 로 **보고**되고 타이머도 멈춰야 한다.
   */
  it('첫 박자가 실패하면 거절을 흘리지 않고 첫 박자 실패로 보고하며 멈춘다(I-03)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'broken-first')
    await mkdir(path)
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => { seen.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let beat: heartbeatTypes.Heartbeat | undefined
    let first: heartbeatTypes.FirstBeat | undefined
    try {
      beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, pid: 9 })
      first = await beat.first
      // 멈췄는지: 박자가 지나도 다시 시도하지 않는다(경로를 풀어도 파일이 생기지 않는다).
      await rm(path, { recursive: true, force: true })
      t.mock.timers.tick(5_000)
      for (let i = 0; i < 50; i += 1) await new Promise<void>((done) => setImmediate(done))
      assert.equal(await readState(path), null, '실패한 통로는 다시 쓰지 않는다')
      await beat.stop()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.equal(first?.ok, false, '첫 박자 실패가 통로에 전달된다')
    assert.deepEqual(seen, [], '첫 박자 실패가 비처리 거절로 새지 않는다')
  })

  /**
   * 첫 박자가 **성공한 뒤**의 실패는 통로를 끄지 않는다 — 일시적 쓰기 실패로 그림을 꺼 버리면 안 된다.
   * 계약: 다음 박자에 다시 시도한다.
   */
  it('첫 박자 성공 뒤의 실패는 다음 박자에 다시 시도한다(I-03 계약)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'retry.json')
    let clock = 500
    const beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, now: () => clock, pid: 4 })
    assert.equal(await until(async () => (await readState(path)) !== null), true)
    assert.deepEqual(await beat.first, { ok: true })
    // 쓰기를 실패시킨다: 같은 이름을 디렉터리로 바꾼다(원자적 쓰기의 rename 이 실패한다).
    await rm(path, { force: true })
    await mkdir(path)
    clock += 5_000
    t.mock.timers.tick(5_000)
    for (let i = 0; i < 50; i += 1) await new Promise<void>((done) => setImmediate(done))
    // 다시 쓸 수 있게 풀고 다음 박자 — 성공하면 재시도 계약이 지켜진 것이다.
    await rm(path, { recursive: true, force: true })
    clock += 5_000
    t.mock.timers.tick(5_000)
    assert.equal(await until(async () => (await readState(path))?.updatedAt === clock), true)
    await beat.stop()
  })

  it('beat()은 직접 한 번 더 쓸 수 있다', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const path = join(root, 'manual.json')
    let clock = 10
    const beat = heartbeat.startHeartbeat(path, { intervalMs: 5_000, now: () => clock, pid: 3 })
    assert.equal(await until(async () => (await readState(path))?.updatedAt === 10), true)
    clock = 20
    await beat.beat()
    await beat.stop()
    assert.equal((await readState(path))?.updatedAt, 20)
  })
})
