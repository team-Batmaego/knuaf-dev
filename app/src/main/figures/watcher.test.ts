import type * as watcherTypes from './watcher'
/**
 * figures/watcher.test.ts — 요청 칸을 한 건씩 집는다 (설계 §3, R4-1).
 *
 * 잠그는 것: 파일 이름 규칙 밖·심볼릭 링크·이미 집은 id는 넘기지 않고, 60초 지난 요청은 `expired`로
 * 표시하며, 처리기가 던져도 감시자는 계속 돌고, `stop()` 뒤에는 새로 생긴 요청을 집지 않는다.
 *
 * 감시자에게 "훑었다"는 신호가 없으므로, 시험은 **처리기가 받은 순서**로 판단한다. 같은 id를 두 번
 * 집는다면 그 id가 연달아 나오므로 두 번째 항목만 기다려도 드러난다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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

const watcher = (await import(new URL('./watcher.ts', import.meta.url).href)) as typeof import('./watcher')
const requestFile = (await import(new URL('./request-file.ts', import.meta.url).href)) as typeof import('./request-file')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-watch-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

const IDS = { a: 'req-aaaaaaaa', b: 'req-bbbbbbbb', c: 'req-cccccccc' } as const

async function makeFolder(name: string): Promise<string> {
  const folder = join(root, name)
  await mkdir(requestFile.requestDir(folder), { recursive: true })
  return folder
}

/** 이름 하나를 요청 칸에 만든다(내용은 scan이 안 본다). */
async function put(folder: string, id: string, ageMs = 0, mtimeNow = Date.now()): Promise<string> {
  const path = requestFile.requestFile(folder, id)
  await writeFile(path, '{}')
  if (ageMs > 0) {
    const when = new Date(mtimeNow - ageMs)
    await utimes(path, when, when)
  }
  return path
}

/** 처리기가 넘긴 항목을 순서대로 꺼내는 대기열 — 시험은 "기다리기"만 한다. */
function received(): {
  push: (item: watcherTypes.FoundRequest) => void
  next: () => Promise<watcherTypes.FoundRequest>
  /** 아직 꺼내지 않은 항목 수 — "더 집히지 않았다"를 시간 없이 확인한다. */
  pending: () => number
} {
  const queue: watcherTypes.FoundRequest[] = []
  const waiters: Array<(item: watcherTypes.FoundRequest) => void> = []
  return {
    pending: () => queue.length,
    push(item) {
      const waiter = waiters.shift()
      if (waiter) waiter(item)
      else queue.push(item)
    },
    next() {
      const item = queue.shift()
      if (item) return Promise.resolve(item)
      return new Promise<watcherTypes.FoundRequest>((resolve) => waiters.push(resolve))
    }
  }
}

describe('scan', () => {
  it('규칙에 맞는 파일만, 이름순으로 돌려준다', async () => {
    const folder = await makeFolder('scan-basic')
    await put(folder, IDS.b)
    await put(folder, IDS.a)
    await writeFile(join(requestFile.requestDir(folder), 'notes.txt'), '')
    await writeFile(join(requestFile.requestDir(folder), 'short.req.json'), '{}')
    await mkdir(join(requestFile.requestDir(folder), `${IDS.c}.req.json`), { recursive: true })
    const found = await watcher.scan(folder, new Set())
    assert.deepEqual(found.map((item) => item.id), [IDS.a, IDS.b])
    assert.equal(found.every((item) => item.expired === false), true)
  })

  it('이미 집은 id·심볼릭 링크는 넘기지 않는다', async () => {
    const folder = await makeFolder('scan-skip')
    await put(folder, IDS.a)
    const target = await put(folder, IDS.b)
    await symlink(target, requestFile.requestFile(folder, IDS.c))
    const found = await watcher.scan(folder, new Set([IDS.a]))
    assert.deepEqual(found.map((item) => item.id), [IDS.b])
  })

  it('60초를 넘긴 요청은 expired', async () => {
    const folder = await makeFolder('scan-ttl')
    const now = 1_800_000_000_000
    await put(folder, IDS.a, 59_000, now)
    await put(folder, IDS.b, 61_000, now)
    const found = await watcher.scan(folder, new Set(), { ttlMs: 60_000, now: () => now })
    assert.deepEqual(
      found.map((item) => [item.id, item.expired]),
      [
        [IDS.a, false],
        [IDS.b, true]
      ]
    )
  })

  it('요청 칸이 없으면 빈 목록', async () => {
    assert.deepEqual(await watcher.scan(join(root, 'no-such-folder'), new Set()), [])
  })

  it('담당 출력 칸(jobs)과 같은 자리면 아무것도 집지 않는다', async () => {
    const folder = await makeFolder('scan-jobs')
    await put(folder, IDS.a)
    const found = await watcher.scan(folder, new Set(), { ignoreDir: requestFile.requestDir(folder) })
    assert.deepEqual(found, [])
  })
})

describe('runWatcher', () => {
  it('한 건씩 처리하고 stop() 뒤에는 새 요청을 집지 않는다', async () => {
    const folder = await makeFolder('run-stop')
    await put(folder, IDS.a)
    const gate = Promise.withResolvers<void>()
    const done = received()
    const runner = watcher.runWatcher({
      folder,
      scanMs: 5,
      handle: async (item) => {
        done.push(item)
        await gate.promise
      }
    })
    assert.equal((await done.next()).id, IDS.a)

    runner.stop()
    await put(folder, IDS.b)
    gate.resolve()
    await runner.idle()
    // b는 stop 뒤에 생겼으므로 집히면 안 된다(집혔다면 대기열에 남아 있다).
    assert.equal(done.pending(), 0)
  })

  it('같은 id를 두 번 넘기지 않는다', async () => {
    const folder = await makeFolder('run-once')
    await put(folder, IDS.a)
    await put(folder, IDS.b)
    const done = received()
    const runner = watcher.runWatcher({ folder, scanMs: 5, handle: async (item) => done.push(item) })
    assert.equal((await done.next()).id, IDS.a)
    // seen이 없으면 여기서 a가 다시 나온다.
    assert.equal((await done.next()).id, IDS.b)
    runner.stop()
    await runner.idle()
  })

  it('처리기가 던져도 다음 요청은 집는다', async () => {
    const folder = await makeFolder('run-throw')
    await put(folder, IDS.a)
    await put(folder, IDS.b)
    const done = received()
    const runner = watcher.runWatcher({
      folder,
      scanMs: 5,
      handle: async (item) => {
        done.push(item)
        if (item.id === IDS.a) throw new Error('boom')
      }
    })
    assert.equal((await done.next()).id, IDS.a)
    assert.equal((await done.next()).id, IDS.b)
    runner.stop()
    await runner.idle()
  })

  it('stop() 뒤 idle()은 매달리지 않는다', async () => {
    const folder = await makeFolder('run-idle')
    const runner = watcher.runWatcher({ folder, scanMs: 5, handle: async () => {} })
    runner.stop()
    await runner.idle()
  })
})
