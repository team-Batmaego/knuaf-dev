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
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
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

const index = (await import(new URL('./index.ts', import.meta.url).href)) as typeof import('./index')
const requestFile = (await import(new URL('./request-file.ts', import.meta.url).href)) as typeof import('./request-file')
const storage = (await import(new URL('./storage.ts', import.meta.url).href)) as typeof import('./storage')
const choices = (await import(new URL('./choices.ts', import.meta.url).href)) as typeof import('./choices')

const PAGE_URL = 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps'
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

/** 조건이 참이 될 때까지 IO를 돌린다(실시간 잠 없음). */
async function until(condition: () => Promise<boolean>, limit = 4_000): Promise<boolean> {
  for (let index = 0; index < limit; index += 1) {
    if (await condition()) return true
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return condition()
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
}

const IDS = { a: 'req-aaaaaaaa', b: 'req-bbbbbbbb', c: 'req-cccccccc' } as const

async function makeChannel(
  over: {
    folder?: string | null
    fetchFn?: processTypes.FetchFn
    write?: processTypes.WriteSeam
    clearTurn?: (path: string) => Promise<void>
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
  const channel = index.startFigureChannel({
    figureHome: home,
    getFolder: () => real,
    resolveSkillSource: () => skillSource,
    decode: async () => ({ png: PNG, width: 8, height: 8 }),
    fetchFn: over.fetchFn ?? fetchFn,
    write: over.write,
    clearTurn: over.clearTurn,
    scanMs: 5,
    ttlMs: 60_000
  })
  return {
    channel,
    home,
    paths,
    folder: real as string,
    skillSource,
    resPath: (id: string) => join(paths.res, `${id}.res.json`)
  }
}

/** 요청 파일을 폴더에 쓴다(도우미가 하는 일). */
async function putRequest(
  folder: string,
  id: string,
  over: Record<string, unknown> = {},
  turnId = 'turn-1',
  images: string[] = [IMAGE_URL]
): Promise<void> {
  await mkdir(requestFile.requestDir(folder), { recursive: true })
  await writeFile(
    requestFile.requestFile(folder, id),
    JSON.stringify({ v: 1, id, turnId, slot: '3.2', page: PAGE_URL, images, ...over })
  )
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
  state: { hit: boolean }
  release: () => void
} {
  const stall = Promise.withResolvers<void>()
  const state = { hit: false }
  const hold = async (): Promise<void> => {
    if (state.hit) return
    state.hit = true
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
    state,
    release: () => stall.resolve()
  }
}

describe('startFigureChannel', () => {
  it('저장소를 만들고 하트비트를 남긴다', async () => {
    const c = await makeChannel()
    assert.equal(await until(async () => (await readRes(c.paths.channel)) !== null), true)
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
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
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
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
    const res = await readRes(c.resPath(IDS.a))
    assert.equal(res?.needsChoice, true)

    const hash = storage.folderHash(c.folder)
    const sheetPath = choices.choicePath(c.paths.choices, hash, '3.2')
    assert.equal(await until(async () => (await choices.readChoiceSheet(sheetPath)) !== null), true)
    const updated = await c.channel.recordStudentMessage(c.folder, 'B')
    assert.equal(updated, 1)
    const sheet = await choices.readChoiceSheet(sheetPath)
    assert.equal(sheet?.studentMessage?.text, 'B')
    await c.channel.stop()
  })

  it('계약 밖 요청·만료 요청도 사유를 남기고 닫는다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a, { extra: true })
    await putRequest(c.folder, IDS.b)
    const old = new Date(Date.now() - 120_000)
    await utimes(requestFile.requestFile(c.folder, IDS.b), old, old)
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
    assert.equal((await readRes(c.resPath(IDS.a)))?.reason, 'invalid')
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.b))) !== null), true)
    assert.equal((await readRes(c.resPath(IDS.b)))?.reason, 'expired')
    await c.channel.stop()
  })

  it('파일 이름과 본문 id가 다르면 invalid — 본문 id로 결과를 만들지 않는다(R-5)', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    // 파일 이름은 IDS.a인데 본문은 IDS.b — 어느 쪽이 정본인지 알 수 없으니 아무것도 받지 않는다.
    await putRequest(c.folder, IDS.a, { id: IDS.b })
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
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
    await writeFile(requestFile.requestFile(c.folder, IDS.c), 'not json')
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.c))) !== null), true)
    const res = await readRes(c.resPath(IDS.c))
    assert.equal(res?.status, 'rejected')
    assert.equal(res?.reason, 'invalid')
    assert.deepEqual(res?.images, [])
    await c.channel.stop()
  })

  it('턴이 없으면 cancelled — 대기 요청을 닫아 준다(도우미가 60초를 안 기다린다)', async () => {
    const c = await makeChannel()
    await putRequest(c.folder, IDS.a)
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
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
    const channel = index.startFigureChannel({
      figureHome: home,
      getFolder: () => current,
      resolveSkillSource: () => skillSource,
      decode: async () => ({ png: PNG, width: 8, height: 8 }),
      fetchFn,
      scanMs: 5,
      ttlMs: 60_000
    })
    const resPath = (id: string): string => join(storage.figurePaths(home).res, `${id}.res.json`)

    current = second
    await channel.beginTurn(second, 'turn-2')
    await putRequest(second, IDS.a, {}, 'turn-2')
    assert.equal(await until(async () => (await readRes(resPath(IDS.a))) !== null), true)
    assert.equal((await readRes(resPath(IDS.a)))?.status, 'done')
    await channel.stop()
  })

  it('이미 결과가 있는 id는 만료로 보여도 다시 닫지 않는다', async () => {
    const c = await makeChannel()
    await c.channel.beginTurn(c.folder, 'turn-1')
    // 지난 실행이 남긴 결과 — 재시작 뒤 옛 요청 파일이 만료로 보여도 이 `done`을 덮으면 안 된다.
    await writeFile(
      c.resPath(IDS.a),
      JSON.stringify({ v: 1, id: IDS.a, status: 'done', slot: '3.2', needsChoice: false, images: [] })
    )
    await putRequest(c.folder, IDS.a)
    const old = new Date(Date.now() - 120_000)
    await utimes(requestFile.requestFile(c.folder, IDS.a), old, old)
    // 다른 요청이 닫히면 감시자가 IDS.a도 한 번 집은 뒤다.
    await putRequest(c.folder, IDS.b)
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.b))) !== null), true)
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
    // 다른 요청이 닫히면 감시자가 IDS.a도 집은 뒤다(만료가 아니라 정상 크기의 새 파일).
    await putRequest(c.folder, IDS.b)
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.b))) !== null), true)
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
    const c = await makeChannel({ write: seam.write })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    assert.equal(await until(async () => seam.state.hit), true)
    let early: DiskSnapshot | null = null
    const ended = c.channel.endTurn('turn-1').then(() => {
      early = diskSnapshot(c)
    })
    await until(async () => early !== null, 50)
    assert.equal(early, null)
    seam.release()
    await ended
    await c.channel.idle()
    assert.deepEqual(early, diskSnapshot(c))
    // 멈춰 있던 구간이 끝난 뒤라 저장소 PNG와 계수는 남고, 결과는 `cancelled`로 닫힌다.
    assert.equal((await readRes(c.resPath(IDS.a)))?.reason, 'cancelled')
    assert.equal(readdirSync(c.paths.store).length, 1)
    await c.channel.stop()
  })

  it('endTurn이 돌아온 뒤에 증명 줄이 새로 생기지 않는다(R-6)', async () => {
    const seam = stallSeam('line')
    const c = await makeChannel({ write: seam.write })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    assert.equal(await until(async () => seam.state.hit), true)
    let early: DiskSnapshot | null = null
    const ended = c.channel.endTurn('turn-1').then(() => {
      early = diskSnapshot(c)
    })
    await until(async () => early !== null, 50)
    assert.equal(early, null)
    seam.release()
    await ended
    await c.channel.idle()
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
    const clearGate = Promise.withResolvers<void>()
    let clearHits = 0
    const pageGate = Promise.withResolvers<void>()
    let started = false
    const gated: processTypes.FetchFn = async (url, options) => {
      if (url === PAGE_URL) {
        started = true
        await pageGate.promise
      }
      return fetchFn(url, options)
    }
    const c = await makeChannel({
      fetchFn: gated,
      // 실제 지우기를 그대로 하되 첫 호출만 멈춘다 — 그동안 `turn.json`은 살아 있다.
      clearTurn: async (path) => {
        clearHits += 1
        await clearGate.promise
        await rm(path, { force: true })
      }
    })
    await c.channel.beginTurn(c.folder, 'turn-1')
    // 진행 중인 요청이 없으니 배수는 즉시 끝나고, `endTurn`은 턴 지우기에서 멈춘다.
    const ended = c.channel.endTurn('turn-1')
    assert.equal(await until(async () => clearHits === 1), true)
    await putRequest(c.folder, IDS.a)
    // 감시자가 집어 페이지 받기에 들어갔다 — 이 요청은 `endTurn`이 시작된 뒤에 시작했다.
    assert.equal(await until(async () => started), true)
    clearGate.resolve()
    await ended
    const early: DiskSnapshot & { res: Record<string, unknown> | null } = {
      ...diskSnapshot(c),
      res: await readRes(c.resPath(IDS.a))
    }
    pageGate.resolve()
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
    await c.channel.idle()
    const late: DiskSnapshot & { res: Record<string, unknown> | null } = {
      ...diskSnapshot(c),
      res: await readRes(c.resPath(IDS.a))
    }
    // `endTurn`이 돌아온 순간에도, 그 뒤에 끝난 순간에도 저장 산출물은 없어야 한다.
    assert.deepEqual(early.store, [])
    assert.equal(early.counters, null)
    assert.equal(early.receipts, null)
    assert.equal(early.res, null)
    assert.deepEqual(late.store, [])
    assert.equal(late.counters, null)
    assert.equal(late.receipts, null)
    // 결과는 `cancelled` 하나로만 닫힌다(게이트 밖 거절 결과라 `endTurn` 뒤에 써도 된다).
    assert.equal(late.res?.status, 'rejected')
    assert.equal(late.res?.reason, 'cancelled')
    await c.channel.stop()
  })

  it('턴이 처리 도중 끝나면 결과를 cancelled로 닫고 그림을 저장하지 않는다', async () => {
    const gate = Promise.withResolvers<void>()
    let started = false
    const gated: processTypes.FetchFn = async (url, options) => {
      if (url === PAGE_URL) {
        started = true
        await gate.promise
      }
      return fetchFn(url, options)
    }
    const c = await makeChannel({ fetchFn: gated })
    await c.channel.beginTurn(c.folder, 'turn-1')
    await putRequest(c.folder, IDS.a)
    // 페이지 받기가 실제로 걸린 뒤에 턴을 끊는다 — 그 전에 끊으면 시작 검사만 보고 지나간다.
    // 감시자 박자는 unref 타이머라 그냥 await하면 Electron Node 22의 시험 실행기가 부모 취소로 끊는다.
    assert.equal(await until(async () => started), true)
    await c.channel.endTurn('turn-1')
    gate.resolve()
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
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
    assert.equal(await until(async () => (await readRes(c.resPath(IDS.a))) !== null), true)
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
    assert.equal(await until(async () => seam.state.hit), true)
    const ending = c.channel.endTurn('turn-a')
    // 쓰기가 멈춘 사이(=`endTurn` 이 기다리는 사이) 새 폴더·공급자의 턴이 열린다.
    await c.channel.beginTurn(c.folder, 'turn-b')
    seam.release()
    await ending
    assert.equal((await readRes(c.paths.turn))?.turnId, 'turn-b', '새 턴의 turn.json 은 살아 있다')
    await c.channel.endTurn('turn-b')
    assert.equal(await readRes(c.paths.turn), null)
    await c.channel.stop()
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
