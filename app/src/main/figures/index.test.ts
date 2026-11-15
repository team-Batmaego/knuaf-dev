import type * as storageTypes from './storage'
import type * as processTypes from './process'
import type * as indexTypes from './index'
import type * as fetchTypes from './fetch'
/**
 * figures/index.test.ts — 진입점 하나로 도는 전 경로 (발주 ③: 인자로 다 받는 함수)
 *
 * 엔진·화면·ipc를 건드리지 않는 것이 이번 범위이므로, 앱이 실제로 부를 모양(`beginTurn` →
 * `recordStudentMessage` → `endTurn` → `stop`)을 그대로 불러 확인한다. 네트워크·Electron은 대역을
 * 넣는다: `fetchFn`이 응답을 만들고 `decode`가 PNG를 돌려준다.
 *
 * 잠그는 것: 폴더의 요청이 결과 파일로 닫히고, 계약 밖·만료 요청도 **사유를 남겨** 닫히며, 폴더를
 * 바꾸면 감시자가 새 폴더로 옮겨가고, `stop()`이 타이머를 남기지 않는다는 것.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MessageChannel } from 'node:worker_threads'

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

const index = (await import(new URL('./index.ts', import.meta.url).href)) as typeof import('./index')
const requestFile = (await import(new URL('./request-file.ts', import.meta.url).href)) as typeof import('./request-file')
const storage = (await import(new URL('./storage.ts', import.meta.url).href)) as typeof import('./storage')
const choices = (await import(new URL('./choices.ts', import.meta.url).href)) as typeof import('./choices')

const PAGE_URL = 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps'
const TEST_NOW = Date.UTC(2026, 10, 15, 12)
const IMAGE_URL = 'https://www.nongsaro.go.kr/ps/img/curation/a.jpg'
const IMAGE_URL_B = 'https://www.nongsaro.go.kr/ps/img/curation/b.jpg'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

function jpeg(): Buffer {
  const bytes = Buffer.alloc(40)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xe0
  bytes.writeUInt16BE(16, 4)
  bytes[20] = 0xff
  bytes[21] = 0xc0
  bytes.writeUInt16BE(17, 22)
  bytes[24] = 8
  bytes.writeUInt16BE(8, 25)
  bytes.writeUInt16BE(8, 27)
  return bytes
}
const JPEG = jpeg()

const SRC = {
  '/portal/ps/': '^/portal/ps/.*',
  image: '^/ps/img/curation/.*',
  org: '농촌진흥청'
}

function pageHtml(images: readonly string[], mark = '공공누리 제1유형'): string {
  return `<html><body><p>${mark}</p><figure>${images.map((url) => `<img src="${url}">`).join('')}</figure></body></html>`
}

const okPage: fetchTypes.FetchResult = {
  ok: true,
  finalUrl: new URL(PAGE_URL),
  status: 200,
  body: Buffer.from(pageHtml([IMAGE_URL, IMAGE_URL_B]), 'utf8'),
  contentType: 'text/html'
}
const okImage: fetchTypes.FetchResult = {
  ok: true,
  finalUrl: new URL(IMAGE_URL),
  status: 200,
  body: JPEG,
  contentType: 'image/jpeg'
}
const okImageB: fetchTypes.FetchResult = { ...okImage, finalUrl: new URL(IMAGE_URL_B) }

const fetchFn: processTypes.FetchFn = async (url) => {
  if (url === PAGE_URL) return okPage
  if (url === IMAGE_URL) return okImage
  if (url === IMAGE_URL_B) return okImageB
  return { ok: false, reason: 'status' }
}

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-index-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 실제 unref 감시자를 시험한다. 완료 신호를 기다리는 동안만 메시지 포트로 실행기를 유지한다. */
async function keepAliveUntil<T>(signal: Promise<T>): Promise<T> {
  const { port1, port2 } = new MessageChannel()
  port1.on('message', () => {})
  try { return await signal } finally { port1.close(); port2.close() }
}

interface CompletionSignal {
  promise: Promise<unknown>
  resolve: (error: unknown) => void
}

async function readRes(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

let counter = 0

interface Channel {
  channel: indexTypes.FigureChannel
  home: string
  paths: storageTypes.FigurePaths
  folder: string
  skillSource: string
  resPath: (id: string) => string
  /** 요청 파일 없음·조용한 취소까지 handler가 돌아온 시점. 결과 파일 존재와 독립적이다. */
  finished: (id: string) => Promise<void>
}

const IDS = { a: 'req-aaaaaaaa', b: 'req-bbbbbbbb', c: 'req-cccccccc' } as const

async function makeChannel(
  over: {
    folder?: string | null
    fetchFn?: processTypes.FetchFn
    write?: processTypes.WriteSeam
    clearTurn?: (path: string) => Promise<void>
    turnDraining?: (turnId: string, activeWrites: number) => void
    now?: () => number
  } = {}
): Promise<Channel> {
  counter += 1
  const base = join(root, `case-${counter}`)
  const home = join(base, 'home')
  const folder = over.folder === undefined ? join(base, 'paper') : (over.folder as string)
  const skillSource = join(base, 'skill')
  await mkdir(join(skillSource, 'references'), { recursive: true })
  await writeFile(
    join(skillSource, 'references', 'figure-sources.json'),
    JSON.stringify({
      v: 1,
      rules: [
        {
          id: 'nongsaro-curation',
          host: 'www.nongsaro.go.kr',
          org: SRC.org,
          pagePath: SRC['/portal/ps/'],
          imagePath: SRC.image,
          rule: 'page_kogl_applies_to_body_images'
        }
      ]
    })
  )
  if (folder) await mkdir(requestFile.requestDir(folder), { recursive: true })
  // 앱은 realpath를 넘긴다(계약 §2 folderHash) — 여기서도 같은 표기를 쓴다.
  const real = folder ? await realpath(folder) : folder
  const paths = storage.figurePaths(home)
  const ready = Promise.withResolvers<void>()
  const completions = new Map<string, CompletionSignal>()
  const completion = (id: string): CompletionSignal => {
    let signal = completions.get(id)
    if (!signal) {
      signal = Promise.withResolvers<unknown>()
      completions.set(id, signal)
    }
    return signal
  }
  const channel = index.startFigureChannel({
    figureHome: home,
    getFolder: () => real,
    resolveSkillSource: () => skillSource,
    decode: async () => ({ png: PNG, width: 8, height: 8 }),
    fetchFn: over.fetchFn ?? fetchFn,
    write: over.write,
    clearTurn: over.clearTurn,
    scanMs: 5,
    ttlMs: 60_000,
    now: over.now ?? (() => 0),
    observe: {
      ready: ready.resolve,
      requestFinished: (id, error) => completion(id).resolve(error),
      turnDraining: over.turnDraining
    }
  })
  await keepAliveUntil(ready.promise)
  return {
    channel,
    home,
    paths,
    folder: real as string,
    skillSource,
    resPath: (id: string) => join(paths.res, `${id}.res.json`),
    finished: async (id) => {
      const error = await keepAliveUntil(completion(id).promise)
      if (error !== undefined) throw error
    }
  }
}

/** 요청 파일을 폴더에 쓴다(도우미가 하는 일). */
async function putRequest(
  folder: string,
  id: string,
  over: Record<string, unknown> = {},
  turnId = 'turn-1',
  images: string[] = [IMAGE_URL],
  modifiedAt?: Date
): Promise<void> {
  await mkdir(requestFile.requestDir(folder), { recursive: true })
  // 감시자가 빈 파일·반쪽 JSON을 먼저 집지 않게 실제 생산자처럼 원자적으로 게시한다.
  const path = requestFile.requestFile(folder, id)
  const staged = modifiedAt ? `${path}.pending` : path
  await storage.writeAtomic(
    staged,
    JSON.stringify({ v: 1, id, turnId, slot: '3.2', page: PAGE_URL, images, ...over })
  )
  if (modifiedAt) {
    await utimes(staged, modifiedAt, modifiedAt)
    await rename(staged, path)
  }
}

/**
 * 저장소 산출물의 한 시점 — `endTurn`이 돌아온 그 틱과 전부 끝난 뒤를 견준다(R-6).
 * 결과 파일(`res`)은 따로 본다: 게이트 밖 `cancelled` 결과는 `endTurn` 뒤에 닫히는 것이 정상이다.
 */
interface DiskSnapshot {
  store: string[]
  counters: string | null
  receipts: string | null
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function diskSnapshot(c: Channel): DiskSnapshot {
  return {
    store: readdirSync(c.paths.store).sort(),
    counters: readText(c.paths.counters),
    receipts: readText(c.paths.receipts)
  }
}

/**
 * 쓰기 대역 — 지정한 종류의 **첫** 호출 하나를 멈춰 둔다. 멈춘 사이 `endTurn()`을 기다리지 않고
 * 불러, 그 턴의 산출물이 `endTurn`이 돌아온 뒤에 새로 생기는지 본다(R-6).
 */
function stallSeam(kind: 'atomic' | 'line'): {
  write: processTypes.WriteSeam
  entered: Promise<void>
  release: () => void
} {
  const stall = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let hit = false
  const hold = async (): Promise<void> => {
    if (hit) return
    hit = true
    entered.resolve()
    await stall.promise
  }
  return {
    write: {
      async atomic(path, data) {
        if (kind === 'atomic') await hold()
        await storage.writeAtomic(path, data)
      },
      async json(path, value) {
        await storage.writeJson(path, value)
      },
      async jsonNew(path, value) {
        return storage.writeJsonNew(path, value)
      },
      async line(path, value) {
        if (kind === 'line') await hold()
        await storage.appendLine(path, value)
      }
    },
    entered: entered.promise,
    release: () => stall.resolve()
  }
}

describe('startFigureChannel', () => {
  it('저장소를 만들고 하트비트를 남긴다', async () => {
    const c = await makeChannel()
    const beat = await readRes(c.paths.channel)
    assert.deepEqual(Object.keys(beat ?? {}).sort(), ['pid', 'updatedAt', 'v'])
    await c.channel.stop()
  })

  it('턴 시작은 turn.json을 쓰고, 끝은 지운다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    const record = await readRes(c.paths.turn)
    assert.equal(record?.turnId, 'turn-1')
    assert.equal(record?.folder, c.folder)
    await c.channel.endTurn('turn-1')
    assert.equal(await readRes(c.paths.turn), null)
    await c.channel.stop()
  })

  it('요청을 처리해 결과 파일로 닫는다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'done')
    assert.equal(res?.id, IDS.a)
    // 앱은 폴더에 쓰지 않는다 — 요청 파일은 그대로 남는다.
    assert.notEqual(await readRes(requestFile.requestFile(c.folder, IDS.a)), null)
    await c.channel.stop()
  })

  it('승인 2장이면 후보표가 생기고 학생 메시지가 붙는다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a, {}, 'turn-1', [IMAGE_URL, IMAGE_URL_B])
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.needsChoice, true)

    const hash = storage.folderHash(c.folder)
    const sheetPath = choices.choicePath(c.paths.choices, hash, '3.2')
    assert.notEqual(await choices.readChoiceSheet(sheetPath), null)
    const updated = await c.channel.recordStudentMessage(c.folder, 'B')
    assert.equal(updated, 1)
    const sheet = await choices.readChoiceSheet(sheetPath)
    assert.equal(sheet?.studentMessage?.text, 'B')
    await c.channel.stop()
  })

  it('계약 밖 요청·만료 요청도 사유를 남기고 닫는다', async () => {
    const c = await makeChannel({ now: () => TEST_NOW })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a, { extra: true }, 'turn-1', [IMAGE_URL], new Date(TEST_NOW))
    await putRequest(c.folder, IDS.b, {}, 'turn-1', [IMAGE_URL], new Date(TEST_NOW - 120_000))
    await Promise.all([c.finished(IDS.a), c.finished(IDS.b)])
    assert.equal((await readRes(c.resPath(IDS.a)))?.reason, 'invalid')
    assert.equal((await readRes(c.resPath(IDS.b)))?.reason, 'expired')
    await c.channel.stop()
  })

  it('파일 이름과 본문 id가 다르면 invalid — 본문 id로 결과를 만들지 않는다(R-5)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    // 파일 이름은 IDS.a인데 본문은 IDS.b — 어느 쪽이 정본인지 알 수 없으니 아무것도 받지 않는다.
    await putRequest(c.folder, IDS.a, { id: IDS.b })
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.id, IDS.a)
    assert.equal(res?.status, 'rejected')
    assert.equal(res?.reason, 'invalid')
    // 본문 id 쪽에 결과를 지어내지 않는다 — 그 id의 요청은 온 적도 없다.
    assert.equal(await readRes(c.resPath(IDS.b)), null)
    await c.channel.stop()
  })

  it('휴지 요청 내용이면 invalid(결과는 남는다)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    await storage.writeAtomic(requestFile.requestFile(c.folder, IDS.c), 'not json')
    await c.finished(IDS.c)
    const res = await readRes(c.resPath(IDS.c))
    assert.equal(res?.status, 'rejected')
    assert.equal(res?.reason, 'invalid')
    assert.deepEqual(res?.images, [])
    await c.channel.stop()
  })

  it('턴이 없으면 cancelled — 대기 요청을 닫아 준다(도우미가 60초를 안 기다린다)', async () => {
    const c = await makeChannel()
    await putRequest(c.folder, IDS.a)
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'rejected')
    assert.equal(res?.reason, 'cancelled')
    assert.deepEqual(res?.images, [])
    await c.channel.stop()
  })

  it('폴더를 바꾸면 새 폴더의 요청을 집는다', async () => {
    const first = join(root, 'switch-first')
    const second = join(root, 'switch-second')
    let current = first
    await mkdir(requestFile.requestDir(first), { recursive: true })
    await mkdir(requestFile.requestDir(second), { recursive: true })
    const home = join(root, 'switch-home')
    const skillSource = join(root, 'switch-skill')
    await mkdir(join(skillSource, 'references'), { recursive: true })
    await writeFile(
      join(skillSource, 'references', 'figure-sources.json'),
      JSON.stringify({
        v: 1,
        rules: [
          {
            id: 'nongsaro-curation',
            host: 'www.nongsaro.go.kr',
            org: SRC.org,
            pagePath: SRC['/portal/ps/'],
            imagePath: SRC.image,
            rule: 'page_kogl_applies_to_body_images'
          }
        ]
      })
    )
    const finished = Promise.withResolvers<void>()
    const channel = index.startFigureChannel({
      figureHome: home,
      getFolder: () => current,
      resolveSkillSource: () => skillSource,
      decode: async () => ({ png: PNG, width: 8, height: 8 }),
      fetchFn,
      scanMs: 5,
      ttlMs: 60_000,
      now: () => 0,
      observe: { requestFinished: (id, error) => {
        assert.equal(error, undefined)
        assert.equal(id, IDS.a)
        finished.resolve()
      } },
    })
    const resPath = (id: string): string => join(storage.figurePaths(home).res, `${id}.res.json`)

    current = second
    await channel.beginTurn(second, 'turn-2')
    await putRequest(second, IDS.a, {}, 'turn-2')
    await keepAliveUntil(finished.promise)
    assert.equal((await readRes(resPath(IDS.a)))?.status, 'done')
    await channel.stop()
  })

  it('이미 결과가 있는 id는 만료로 보여도 다시 닫지 않는다', async () => {
    const c = await makeChannel({ now: () => TEST_NOW })
    await c.channel.beginTurn(c.folder, 'turn-1')
    // 지난 실행이 남긴 결과 — 재시작 뒤 옛 요청 파일이 만료로 보여도 이 `done`을 덮으면 안 된다.
    await writeFile(
      c.resPath(IDS.a),
      JSON.stringify({ v: 1, id: IDS.a, status: 'done', slot: '3.2', needsChoice: false, images: [] })
    )
    await putRequest(c.folder, IDS.a, {}, 'turn-1', [IMAGE_URL], new Date(TEST_NOW - 120_000))
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'done')
    assert.equal(res?.reason, undefined)
    await c.channel.stop()
  })

  it('결과가 있는 id는 턴 없이 재시작해도 cancelled로 덮지 않는다(I-1)', async () => {
    const c = await makeChannel()
    // 지난 실행의 결과 — 앱이 턴 없이 다시 뜬 뒤(재시작·턴 전) 옛 요청을 다시 집어도 이 `done`이 정본이다.
    await mkdir(c.paths.res, { recursive: true })
    await writeFile(
      c.resPath(IDS.a),
      JSON.stringify({ v: 1, id: IDS.a, status: 'done', slot: '3.2', needsChoice: false, images: [] })
    )
    await putRequest(c.folder, IDS.a)
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'done')
    assert.equal(res?.reason, undefined)
    await c.channel.stop()
  })

  /**
   * R-6: `endTurn()`이 돌려준 뒤에는 그 턴의 저장소 PNG·계수·증명이 **새로 생기지 않아야** 한다.
   * 저장 쓰기를 멈춰 둔 채 `endTurn()`을 기다리지 않고 부른다 — 멈춘 쓰기를 기다리는 동안에는
   * 돌아오지 않아야 하고(수정 전에는 즉시 돌아온다), 풀어 준 뒤의 산출물은 돌아온 순간과 같아야 한다.
   */
  it('endTurn은 진행 중인 저장 쓰기를 기다린다(R-6)', async () => {
    const seam = stallSeam('atomic')
    const draining = Promise.withResolvers<number>()
    const c = await makeChannel({ write: seam.write, turnDraining: (_id, active) => draining.resolve(active) })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    await keepAliveUntil(seam.entered)
    let early: DiskSnapshot | null = null
    const ended = c.channel.endTurn('turn-1').then(() => {
      early = diskSnapshot(c)
    })
    assert.equal(await draining.promise, 1)
    assert.equal(early, null)
    seam.release()
    await ended
    await c.finished(IDS.a)
    assert.deepEqual(early, diskSnapshot(c))
    // 멈춰 있던 구간이 끝난 뒤라 저장소 PNG와 계수는 남고, 결과는 `cancelled`로 닫힌다.
    assert.equal((await readRes(c.resPath(IDS.a)))?.reason, 'cancelled')
    assert.equal(readdirSync(c.paths.store).length, 1)
    await c.channel.stop()
  })

  it('endTurn이 돌아온 뒤에 증명 줄이 새로 생기지 않는다(R-6)', async () => {
    const seam = stallSeam('line')
    const draining = Promise.withResolvers<number>()
    const c = await makeChannel({ write: seam.write, turnDraining: (_id, active) => draining.resolve(active) })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    await keepAliveUntil(seam.entered)
    let early: DiskSnapshot | null = null
    const ended = c.channel.endTurn('turn-1').then(() => {
      early = diskSnapshot(c)
    })
    assert.equal(await draining.promise, 1)
    assert.equal(early, null)
    seam.release()
    await ended
    await c.finished(IDS.a)
    assert.deepEqual(early, diskSnapshot(c))
    // 이미 시작한 구간은 끝까지 간다 — 증명 한 줄과 `done` 결과가 `endTurn` 앞에서 닫힌다.
    assert.equal((await readRes(c.resPath(IDS.a)))?.status, 'done')
    assert.equal((readText(c.paths.receipts) ?? '').trim().split('\n').length, 1)
    await c.channel.stop()
  })

  /**
   * R-6 남은 경로: `endTurn()`이 세대값만 올리고 게이트를 닫지 않으면, 턴 파일을 지우는 사이(또는 그
   * 직후)에 집힌 요청이 **새 세대값**을 받아 살아 있는 것으로 통과한다. 그러면 `endTurn()`이 돌아온
   * 뒤에도 PNG·계수·증명·`done`이 새로 생긴다. 턴 지우기를 멈춰 그 틈을 실제로 만든다.
   */
  it('endTurn이 도는 동안 집힌 요청은 endTurn이 돌아온 뒤 산출물을 만들지 않는다(R-6 남은 경로)', async () => {
    const clearEntered = Promise.withResolvers<void>()
    const clearGate = Promise.withResolvers<void>()
    let calls = 0
    const c = await makeChannel({
      now: () => 0,
      fetchFn: async (url, options) => { calls += 1; return fetchFn(url, options) },
      clearTurn: async (path) => {
        clearEntered.resolve()
        await clearGate.promise
        await rm(path, { force: true })
      }
    })
    try {
      await c.channel.beginTurn(c.folder, 'turn-1')
      const ended = c.channel.endTurn('turn-1')
      await clearEntered.promise
      await putRequest(c.folder, IDS.a)
      await c.finished(IDS.a)
      assert.equal(calls, 0)
      clearGate.resolve()
      await ended
      assert.deepEqual(diskSnapshot(c), { store: [], counters: null, receipts: null })
      const res = await readRes(c.resPath(IDS.a))
      assert.equal(res?.status, 'rejected')
      assert.equal(res?.reason, 'limit_turn')
    } finally { clearGate.resolve(); await c.channel.stop() }
  })

  it('턴이 처리 도중 끝나면 결과를 cancelled로 닫고 그림을 저장하지 않는다', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const gated: processTypes.FetchFn = async (url, options) => {
      if (url === PAGE_URL) {
        entered.resolve()
        await gate.promise
      }
      return fetchFn(url, options)
    }
    const c = await makeChannel({ fetchFn: gated })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    await keepAliveUntil(entered.promise)
    await c.channel.endTurn('turn-1')
    gate.resolve()
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'rejected')
    assert.equal(res?.reason, 'cancelled')
    assert.deepEqual(res?.images, [])
    assert.deepEqual(await readdir(c.paths.store), [])
    await c.channel.stop()
  })

  it('stop()은 두 번 불러도 안전하고 idle은 매달리지 않는다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    await c.channel.stop()
    await c.channel.stop()
    await c.channel.idle()
  })

  /**
   * I-01: 통로는 하나인데 턴은 폴더·공급자마다 있다. 소유자가 아닌 턴의 `endTurn` 이 새 턴의
   * `turn.json` 을 지우면, 지금 도는 턴의 정상 요청이 전부 `stale`·`cancelled` 가 된다.
   */
  it('다른 턴의 endTurn은 지금 턴의 turn.json을 지우지 않는다(I-01)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-a')
    // 다른 폴더·공급자의 턴이 같은 통로를 잡았다(소유권 이전).
    await c.channel.beginTurn(c.folder, 'turn-b')
    await c.channel.endTurn('turn-a')
    assert.equal((await readRes(c.paths.turn))?.turnId, 'turn-b', '남의 턴 종료는 무시된다')
    // 소유자 종료는 그대로 지운다.
    await c.channel.endTurn('turn-b')
    assert.equal(await readRes(c.paths.turn), null)
    await c.channel.stop()
  })

  it('이미 닫힌 턴의 늦은 beginTurn은 turn.json을 되살리지 않는다(I-02 상한)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-a')
    // 준비 상한으로 `endTurn` 이 먼저 도착하고, `beginTurn` 이 그 뒤에야 끝난 경우.
    await c.channel.endTurn('turn-a')
    await c.channel.beginTurn(c.folder, 'turn-a')
    assert.equal(await readRes(c.paths.turn), null, '끝난 턴이 파일을 남기면 감시자가 유령 턴을 본다')
    // 다음 턴은 정상으로 열린다.
    await c.channel.beginTurn(c.folder, 'turn-b')
    assert.equal((await readRes(c.paths.turn))?.turnId, 'turn-b')
    await c.channel.endTurn('turn-b')
    await c.channel.stop()
  })

  it('남의 턴이 끝나도 지금 턴의 요청은 계속 처리된다(I-01)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-a')
    await c.channel.beginTurn(c.folder, 'turn-b')
    await c.channel.endTurn('turn-a')
    await putRequest(c.folder, IDS.a, {}, 'turn-b')
    await c.finished(IDS.a)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.status, 'done', '지금 턴의 요청은 stale 이 아니다')
    await c.channel.endTurn('turn-b')
    await c.channel.stop()
  })

  /**
   * I-01 남은 경로: 소유 턴의 `endTurn` 이 진행 중인 쓰기를 기다리는 사이 새 턴이 열리면, 깨어난
   * `endTurn` 이 그 새 `turn.json` 을 지우면 안 된다.
   */
  it('기다리는 사이 새 턴이 열리면 옛 endTurn은 turn.json을 지우지 않는다(I-01)', async () => {
    const seam = stallSeam('atomic')
    const c = await makeChannel({ write: seam.write })
    await c.channel.beginTurn(c.folder, 'turn-a')
    await putRequest(c.folder, IDS.a, {}, 'turn-a')
    await keepAliveUntil(seam.entered)
    const ending = c.channel.endTurn('turn-a')
    // 쓰기가 멈춘 사이(=`endTurn` 이 기다리는 사이) 새 폴더·공급자의 턴이 열린다.
    await c.channel.beginTurn(c.folder, 'turn-b')
    seam.release()
    await ending
    await c.finished(IDS.a)
    assert.equal((await readRes(c.paths.turn))?.turnId, 'turn-b', '새 턴의 turn.json 은 살아 있다')
    await c.channel.endTurn('turn-b')
    assert.equal(await readRes(c.paths.turn), null)
    await c.channel.stop()
  })

  /**
   * I-01 남은 경계(검토 VM 재현): 소유권 확인이 끝난 뒤의 **지우기**가 늦어지는 동안 새 턴이 열리면,
   * 지우기가 새 턴의 `turn.json` 을 지운다. 확인만 앞에 두고 지우기를 늦추면 그 사이에 새 쓰기가 끼어
   * 들기 때문이다. 그래서 확인과 지우기를 한 사슬 안에서 하고, 새 턴의 쓰기는 그 사슬 **뒤**에 선다.
   */
  it('지우기가 늦는 사이 새 턴이 열려도 옛 endTurn은 새 turn.json을 지우지 않는다(I-01 남은 경계)', async () => {
    const clearGate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let cleared = false
    const c = await makeChannel({
      // 실제 지우기를 그대로 하되 첫 호출을 멈춘다 — 확인은 이미 통과한 상태다(검토 재현 그대로).
      clearTurn: async (path) => {
        entered.resolve()
        await clearGate.promise
        if (!cleared) assert.equal((await readRes(path))?.turnId, 'turn-a', '옛 삭제가 풀리기 전에는 새 turn.json을 쓰지 않는다')
        await rm(path, { force: true })
        cleared = true
      }
    })
    await c.channel.beginTurn(c.folder, 'turn-a')
    const ending = c.channel.endTurn('turn-a')
    await entered.promise
    // 삭제가 멈춘 사이 새 턴이 열린다 — 서비스 상한(3초)을 넘겨 실행된 경우와 같은 순서다.
    const opening = c.channel.beginTurn(c.folder, 'turn-b').then(() => {
      assert.equal(cleared, true, '새 턴 쓰기는 옛 삭제 완료 뒤에만 끝난다')
    })
    clearGate.resolve()
    await ending
    await opening
    assert.equal((await readRes(c.paths.turn))?.turnId, 'turn-b', '새 턴의 turn.json 은 살아 있다')
    // 새 턴도 정상으로 닫힌다.
    await c.channel.endTurn('turn-b')
    assert.equal(await readRes(c.paths.turn), null)
    await c.channel.stop()
  })

  /**
   * I-03 남은 경계(검토 실측): `figure-channel.json` 자리가 디렉터리면 첫 박자가 실패한다. 예전에는 그
   * 실패를 삼키기만 해서 `beginTurn` 이 `turn.json` 을 쓰고 감시자가 계속 돌았다 — 결과를 받을 곳 없는
   * 통로다. 이제 첫 박자 실패는 통로 시작 실패다: 턴 파일도, 감시자도 남지 않는다.
   */
  it('첫 하트비트가 실패하면 통로가 시작되지 않는다(I-03 남은 경계)', async () => {
    const base = join(root, `case-beat-${++counter}`)
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    // 하트비트 파일 자리만 디렉터리로 막는다 — 저장소 준비(`prepareHome`)는 성공한다.
    await mkdir(join(home, 'figure-channel.json'))
    const folder = join(base, 'paper')
    await mkdir(requestFile.requestDir(folder), { recursive: true })
    const real = await realpath(folder)
    const paths = storage.figurePaths(home)
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => { seen.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const channel = index.startFigureChannel({
      figureHome: home,
      getFolder: () => real,
      resolveSkillSource: () => null,
      decode: async () => ({ png: PNG, width: 8, height: 8 }),
      fetchFn,
      scanMs: 5,
      ttlMs: 60_000
    })
    try {
      await channel.beginTurn(real, 'turn-1')
      await putRequest(folder, IDS.a, {}, 'turn-1')
      await channel.idle()
      // 감시자가 살아 있었다면 이 요청이 결과 파일로 닫혔을 것이다.
      for (let i = 0; i < 200; i += 1) await new Promise<void>((done) => setImmediate(done))
      await channel.endTurn('turn-1')
      await channel.stop()
      await new Promise<void>((done) => setImmediate(done))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.equal(await readRes(paths.turn), null, '턴 파일을 쓰지 않는다')
    assert.equal(await readRes(join(paths.res, `${IDS.a}.res.json`)), null, '감시자도 돌지 않는다')
    assert.deepEqual(seen, [], '첫 박자 실패가 비처리 거절로 새지 않는다')
  })

  /**
   * I-03: 저장소 준비가 실패하면(여기서는 `tmp` 를 파일로 막는다) 그 거절이 밖으로 새지 않고
   * 통로만 꺼진다. 예전에는 `void ensureRunner()`·첫 `void beat()` 가 비처리 거절이 되어 프로세스를
   * 종료 코드 1 로 끝냈다.
   */
  it('저장소 준비가 실패하면 거절을 흘리지 않고 그림만 꺼진다(I-03)', async () => {
    const base = join(root, `case-broken-${++counter}`)
    const home = join(base, 'home')
    await mkdir(base, { recursive: true })
    // 저장소 자리를 **파일**로 막는다 — `prepareHome` 의 mkdir 과 하트비트의 쓰기가 모두 실패하고,
    // 실패한 쓰기가 지워지는 도중에 다시 폴더를 만들지도 않는다(정리 경합 없음).
    await writeFile(home, 'not a directory')
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => { seen.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const channel = index.startFigureChannel({
        figureHome: home,
        getFolder: () => null,
        resolveSkillSource: () => null,
        scanMs: 5
      })
      await channel.beginTurn('/tmp/paper', 'turn-1')
      await channel.recordStudentMessage('/tmp/paper', '안녕')
      await channel.idle()
      // 실패가 굳은 뒤에도 종료 경로는 안전하다.
      await channel.endTurn('turn-1')
      await channel.stop()
      // 비처리 거절이 실제로 등록되었는지 보려면 한 틱은 돌려야 한다.
      await new Promise<void>((done) => setImmediate(done))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(seen, [], '저장소 실패가 비처리 거절로 새지 않는다')
  })
})

describe('P1.1 실제 통로의 턴 상한', () => {
  it('목록·그림 합쳐 6건, 실패도 소비, 같은 turnId beginTurn은 새 세대 6건', async () => {
    let calls = 0
    const c = await makeChannel({ now: () => 0, fetchFn: async () => { calls += 1; return { ok: false, reason: 'timeout' } } })
    try {
      await c.channel.beginTurn(c.folder, 'turn-1')
      for (let i = 0; i < 7; i += 1) {
        const id = `req-first-${i}`
        await putRequest(c.folder, id, {}, 'turn-1', i % 2 ? [IMAGE_URL] : [])
        await c.finished(id)
        assert.equal((await readRes(c.resPath(id)))?.reason, i < 6 ? 'timeout' : 'limit_turn')
      }
      assert.equal(calls, 6)
      await c.channel.beginTurn(c.folder, 'turn-1')
      for (let i = 0; i < 6; i += 1) {
        const id = `req-second-${i}`
        await putRequest(c.folder, id, {}, 'turn-1', [])
        await c.finished(id)
        assert.equal((await readRes(c.resPath(id)))?.reason, 'timeout')
      }
      assert.equal(calls, 12)
      await c.channel.endTurn('turn-1')
      await c.channel.beginTurn(c.folder, 'turn-2')
      for (let i = 0; i < 6; i += 1) {
        const id = `req-third-${i}`
        await putRequest(c.folder, id, {}, 'turn-2', [])
        await c.finished(id)
        assert.equal((await readRes(c.resPath(id)))?.reason, 'timeout')
      }
      assert.equal(calls, 18)
    } finally { await c.channel.stop() }
  })

  it('중복·턴 불일치·규칙 불일치는 페이지 예약을 쓰지 않는다', async () => {
    let calls = 0
    const c = await makeChannel({ now: () => 0, fetchFn: async () => { calls += 1; return okPage } })
    try {
      await c.channel.beginTurn(c.folder, 'turn-1')
      for (let i = 0; i < 10; i += 1) {
        const id = `req-invalid-${i}`
        if (i % 3 === 0) await storage.appendLine(c.paths.receipts, { reqId: id })
        await putRequest(c.folder, id, i % 3 === 2 ? { page: 'https://outside.gov/x' } : {}, i % 3 === 1 ? 'stale' : 'turn-1', [])
        await c.finished(id)
        assert.equal((await readRes(c.resPath(id)))?.status, 'rejected')
      }
      for (let i = 0; i < 6; i += 1) {
        const id = `req-valid-${i}`
        await putRequest(c.folder, id, {}, 'turn-1', [])
        await c.finished(id)
        assert.equal((await readRes(c.resPath(id)))?.status, 'done')
      }
      assert.equal(calls, 6)
    } finally { await c.channel.stop() }
  })

  it('limit_turn 100건은 거절 파일 24개, 다음 세대에 거절 예산을 새로 준다', async () => {
    const c = await makeChannel({ now: () => 0, fetchFn: async () => okPage })
    try {
      await c.channel.beginTurn(c.folder, 'turn-1')
      const ids = Array.from({ length: 106 }, (_, i) => `req-limit-${String(i).padStart(4, '0')}`)
      for (const id of ids) await putRequest(c.folder, id, {}, 'turn-1', [])
      await Promise.all(ids.map((id) => c.finished(id)))
      const names = await readdir(c.paths.res)
      const results = await Promise.all(names.map((name) => readRes(join(c.paths.res, name))))
      assert.equal(results.filter((res) => res?.status === 'done').length, 6)
      assert.equal(results.filter((res) => res?.status === 'rejected').length, 24)
      await c.channel.endTurn('turn-1')
      await c.channel.beginTurn(c.folder, 'turn-2')
      await putRequest(c.folder, 'req-next-reject', { page: 'https://outside.gov/x' }, 'turn-2', [])
      await c.finished('req-next-reject')
      assert.equal((await readRes(c.resPath('req-next-reject')))?.reason, 'rule_missing')
    } finally { await c.channel.stop() }
  })

  it('재시작의 닫힌 게이트는 옛 turn.json이 있어도 GET 0, 목록 결과 파일 0', async () => {
    let calls = 0
    const c = await makeChannel({ now: () => 0, fetchFn: async () => { calls += 1; return okPage } })
    try {
      await storage.writeJson(c.paths.turn, { v: 1, turnId: 'turn-1', folder: c.folder, startedAt: 0 })
      await putRequest(c.folder, 'req-closed-list', {}, 'turn-1', [])
      await putRequest(c.folder, 'req-closed-image')
      await Promise.all([c.finished('req-closed-list'), c.finished('req-closed-image')])
      assert.equal(calls, 0)
      assert.equal(await readRes(c.resPath('req-closed-list')), null)
      assert.equal((await readRes(c.resPath('req-closed-image')))?.reason, 'limit_turn')
      assert.deepEqual(await readdir(c.paths.store), [])
    } finally { await c.channel.stop() }
  })

  for (const outcome of ['success', 'timeout', 'status'] as const) {
    it(`endTurn 뒤 목록 GET ${outcome}은 모든 결과·그림 산출물 0`, async () => {
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const c = await makeChannel({ now: () => 0, fetchFn: async () => {
        entered.resolve(); await resume.promise
        return outcome === 'success' ? okPage : { ok: false, reason: outcome }
      } })
      try {
        await c.channel.beginTurn(c.folder, 'turn-1')
        await putRequest(c.folder, IDS.a, {}, 'turn-1', [])
        await keepAliveUntil(entered.promise)
        await c.channel.endTurn('turn-1')
        resume.resolve()
        await c.finished(IDS.a)
        assert.deepEqual(await readdir(c.paths.res), [])
        assert.deepEqual(await readdir(c.paths.choices), [])
        assert.deepEqual(diskSnapshot(c), { store: [], counters: null, receipts: null })
      } finally { resume.resolve(); await c.channel.stop() }
    })
  }

  it('이미 시작한 목록 결과 쓰기는 endTurn이 기다린다', async () => {
    const entered = Promise.withResolvers<void>()
    const draining = Promise.withResolvers<number>()
    const resume = Promise.withResolvers<void>()
    const c = await makeChannel({
      now: () => 0,
      turnDraining: (_id, active) => draining.resolve(active),
      write: {
        atomic: storage.writeAtomic, json: storage.writeJson, line: storage.appendLine,
        jsonNew: async (path, value) => {
          entered.resolve(); await resume.promise
          return storage.writeJsonNew(path, value)
        }
      }
    })
    try {
      await c.channel.beginTurn(c.folder, 'turn-1')
      await putRequest(c.folder, IDS.a, {}, 'turn-1', [])
      await keepAliveUntil(entered.promise)
      let ended = false
      const ending = c.channel.endTurn('turn-1').then(() => { ended = true })
      assert.equal(await draining.promise, 1)
      assert.equal(ended, false)
      resume.resolve()
      await ending
      await c.finished(IDS.a)
      assert.equal((await readRes(c.resPath(IDS.a)))?.status, 'done')
      assert.deepEqual(await readdir(c.paths.res), [`${IDS.a}.res.json`])
    } finally { resume.resolve(); await c.channel.stop() }
  })
})

describe('P1.1 거절 파일 보존 경계', () => {
  it('닫힌 동안 거절은 실행당 24개, 새 턴을 거쳐도 닫힌 예산은 초기화 안 됨', async () => {
    const c = await makeChannel({ now: () => 0 })
    try {
      const ids = Array.from({ length: 30 }, (_, i) => `req-closed-${String(i).padStart(3, '0')}`)
      for (const id of ids) await putRequest(c.folder, id, { extra: true })
      await Promise.all(ids.map((id) => c.finished(id)))
      assert.equal((await readdir(c.paths.res)).length, 24)
      await c.channel.beginTurn(c.folder, 'turn-1')
      await c.channel.endTurn('turn-1')
      await putRequest(c.folder, 'req-final-closed', { extra: true })
      await c.finished('req-final-closed')
      assert.equal(await readRes(c.resPath('req-final-closed')), null)
      assert.equal((await readdir(c.paths.res)).length, 24)
    } finally { await c.channel.stop() }
  })

  it('시작 정리는 24시간 지난 rejected만 지우고 done·최근 거절·비결과는 보존', async () => {
    const c = await makeChannel()
    await c.channel.stop()
    const old = new Date(TEST_NOW - 25 * 60 * 60 * 1000)
    const fresh = new Date(TEST_NOW)
    const cases = [
      ['req-old-reject', 'rejected', true], ['req-old-done', 'done', true], ['req-new-reject', 'rejected', false]
    ] as const
    for (const [id, status, age] of cases) {
      await storage.writeJson(c.resPath(id), { v: 1, id, status, images: [] })
      await utimes(c.resPath(id), age ? old : fresh, age ? old : fresh)
    }
    const other = join(c.paths.res, 'unrelated.json')
    await writeFile(other, '{"status":"rejected"}')
    await utimes(other, old, old)
    await symlink(c.resPath('req-old-reject'), c.resPath('req-linked-reject'))
    const ready = Promise.withResolvers<void>()
    const channel = index.startFigureChannel({
      figureHome: c.home, getFolder: () => null, resolveSkillSource: () => null,
      now: () => TEST_NOW, observe: { ready: ready.resolve }
    })
    try {
      await keepAliveUntil(ready.promise)
      assert.equal(await readRes(c.resPath('req-old-reject')), null)
      assert.equal((await readRes(c.resPath('req-old-done')))?.status, 'done')
      assert.equal((await readRes(c.resPath('req-new-reject')))?.status, 'rejected')
      assert.equal(await readFile(other, 'utf8'), '{"status":"rejected"}')
      assert.equal((await readdir(c.paths.res)).includes('req-linked-reject.res.json'), true)
    } finally { await channel.stop() }
  })
})
