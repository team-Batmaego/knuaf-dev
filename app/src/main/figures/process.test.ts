import type * as storageTypes from './storage'
import type * as rulesTypes from './rules'
import type * as processTypes from './process'
import type * as fetchTypes from './fetch'
import type * as contractTypes from './contract'
/**
 * figures/process.test.ts — 요청 하나의 전 경로 (설계 §3~§5).
 *
 * 이 시험은 네트워크·Electron 없이 돈다: `fetchFn`이 응답을 만들고 `decode`가 PNG를 돌려준다.
 * 잠그는 판단은 순서 그대로다 — 턴 → 중복 → 규칙 → 페이지 → 그림별 판정 → 승인만 저장.
 * 특히 **거절된 그림의 바이트는 저장소에 남지 않는다**는 것과, 승인 2장이면 후보표가 생긴다는 것.
 */

import { registerHooks } from 'node:module'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ClientRequest } from 'node:http'

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

const processMod = (await import(new URL('./process.ts', import.meta.url).href)) as typeof import('./process')
const storage = (await import(new URL('./storage.ts', import.meta.url).href)) as typeof import('./storage')
const turn = (await import(new URL('./turn.ts', import.meta.url).href)) as typeof import('./turn')
const contract = (await import(new URL('./contract.ts', import.meta.url).href)) as typeof import('./contract')
const choices = (await import(new URL('./choices.ts', import.meta.url).href)) as typeof import('./choices')
const fetchMod = (await import(new URL('./fetch.ts', import.meta.url).href)) as typeof import('./fetch')
const verdict = (await import(new URL('./verdict.ts', import.meta.url).href)) as typeof import('./verdict')
// 확장자 없는 내부 import에 등록한 해석 훅을 적용하려고 훅 등록 뒤 모듈을 읽는다.
const rulesMod = (await import(new URL('./rules.ts', import.meta.url).href)) as typeof rulesTypes
const vectors = JSON.parse((await readFile(new URL('./fixtures/pagequery-vectors.json', import.meta.url), 'utf8'))
  .replace(/\{\{(.)\*(\d+)\}\}/g, (_match, char: string, count: string) => char.repeat(Number(count)))) as {
  rules: unknown
  flow: ['page' | 'image', string, string | null, string[], boolean, string][]
}

const NOW = Date.UTC(2026, 10, 11, 12)
const PAGE_URL = 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps'
const IMAGE_URL = 'https://www.nongsaro.go.kr/ps/img/curation/a.jpg'
const IMAGE_URL_B = 'https://www.nongsaro.go.kr/ps/img/curation/b.jpg'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

/** 최소 JPEG 머리 — SOI + APP0 + SOF0(높이 8, 폭 8). sniffImage가 통과시킨다. */
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

/** EUC-KR로 인코딩한 `공공누리 제1유형` 페이지(109바이트) — 사전 계산값. */
const EUC_KR_PLAIN = Uint8Array.from([
  0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x69, 0x6d, 0x67, 0x20, 0x73,
  0x72, 0x63, 0x3d, 0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x77, 0x77, 0x77, 0x2e, 0x6e, 0x6f,
  0x6e, 0x67, 0x73, 0x61, 0x72, 0x6f, 0x2e, 0x67, 0x6f, 0x2e, 0x6b, 0x72, 0x2f, 0x70, 0x73, 0x2f, 0x69, 0x6d,
  0x67, 0x2f, 0x63, 0x75, 0x72, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x2f, 0x61, 0x2e, 0x6a, 0x70, 0x67, 0x22, 0x3e,
  0x3c, 0x70, 0x3e, 0xb0, 0xf8, 0xb0, 0xf8, 0xb4, 0xa9, 0xb8, 0xae, 0x20, 0xc1, 0xa6, 0x31, 0xc0, 0xaf, 0xc7,
  0xfc, 0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c,
  0x3e
])

/** 같은 내용에 `<meta charset="euc-kr">`만 붙인 것(145바이트). */
const EUC_KR_META = Uint8Array.from([
  0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e, 0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63,
  0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x65, 0x75, 0x63, 0x2d, 0x6b, 0x72, 0x22, 0x3e, 0x3c, 0x2f,
  0x68, 0x65, 0x61, 0x64, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x69, 0x6d, 0x67, 0x20, 0x73, 0x72,
  0x63, 0x3d, 0x22, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x77, 0x77, 0x77, 0x2e, 0x6e, 0x6f, 0x6e,
  0x67, 0x73, 0x61, 0x72, 0x6f, 0x2e, 0x67, 0x6f, 0x2e, 0x6b, 0x72, 0x2f, 0x70, 0x73, 0x2f, 0x69, 0x6d, 0x67,
  0x2f, 0x63, 0x75, 0x72, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x2f, 0x61, 0x2e, 0x6a, 0x70, 0x67, 0x22, 0x3e, 0x3c,
  0x70, 0x3e, 0xb0, 0xf8, 0xb0, 0xf8, 0xb4, 0xa9, 0xb8, 0xae, 0x20, 0xc1, 0xa6, 0x31, 0xc0, 0xaf, 0xc7, 0xfc,
  0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e
])

const rule = {
  id: 'nongsaro-curation',
  host: 'www.nongsaro.go.kr',
  org: '농촌진흥청',
  pagePath: '^/portal/ps/.*',
  imagePath: '^/ps/img/curation/.*',
  rule: 'page_kogl_applies_to_body_images'
}

const loadedRules: rulesTypes.RulesLoad = {
  ok: true,
  rules: [rule],
  source: '/skill/references/figure-sources.json',
  problem: null
}

function pageHtml(images: readonly string[], mark = '공공누리 제1유형'): string {
  const tags = images.map((url) => `<img src="${url}">`).join('\n')
  return `<html><body><p>${mark}</p><figure>${tags}</figure></body></html>`
}

interface FakeFetch {
  fn: processTypes.FetchFn
  calls: string[]
}

function fakeFetch(table: Record<string, fetchTypes.FetchResult>): FakeFetch {
  const calls: string[] = []
  return {
    calls,
    fn: async (url) => {
      calls.push(url)
      return table[url] ?? { ok: false, reason: 'status' }
    }
  }
}

const okPage = (html: string, url = PAGE_URL): Record<string, fetchTypes.FetchResult> => ({
  [url]: { ok: true, finalUrl: new URL(url), status: 200, body: Buffer.from(html, 'utf8'), contentType: 'text/html' }
})

const okImage = (url = IMAGE_URL, contentType = 'image/jpeg'): fetchTypes.FetchResult => ({
  ok: true,
  finalUrl: new URL(url),
  status: 200,
  body: JPEG,
  contentType
})

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-process-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Harness {
  folder: string
  home: string
  paths: storageTypes.FigurePaths
  request: contractTypes.FigureRequest
  deps: (over?: Partial<processTypes.ProcessDeps>) => processTypes.ProcessDeps
}

let counter = 0

/** 저장소·폴더·턴을 새로 만들고 요청 하나를 준비한다. */
async function harness(over: { turn?: { id: string; folder?: string } | null; rules?: rulesTypes.RulesLoad } = {}): Promise<Harness> {
  counter += 1
  const home = join(root, `home-${counter}`)
  const paths = storage.figurePaths(home)
  await storage.prepareHome(paths)
  const realFolder = await mkdtemp(join(root, `paper-${counter}-`))
  const folderPath = over.turn?.folder ?? realFolder
  if (over.turn !== null) {
    await turn.beginTurn(paths.turn, over.turn?.id ?? 'turn-1', folderPath, NOW)
  }
  return {
    folder: realFolder,
    home,
    paths,
    request: {
      v: 1,
      id: `req-${String(counter).padStart(8, '0')}`,
      turnId: over.turn?.id ?? 'turn-1',
      slot: '3.2',
      page: PAGE_URL,
      images: [IMAGE_URL]
    },
    deps: (depsOver = {}) => ({
      paths,
      loadRules: async () => over.rules ?? loadedRules,
      decode: async () => ({ png: PNG, width: 8, height: 8 }),
      now: () => NOW,
      ...depsOver
    })
  }
}

describe('processRequest — 받지 않는 요청', () => {
  it('턴이 없으면 cancelled', async () => {
    const h = await harness({ turn: null })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps())
    assert.equal(res.status, 'rejected')
    assert.equal(res.reason, 'cancelled')
    assert.deepEqual(res.images, [])
  })

  it('turnId가 다르면 stale', async () => {
    const h = await harness()
    const res = await processMod.processRequest(
      { request: { ...h.request, turnId: 'turn-old' }, folder: h.folder },
      h.deps()
    )
    assert.equal(res.reason, 'stale')
  })

  it('턴의 폴더가 다르면 stale', async () => {
    const other = await mkdtemp(join(root, 'other-paper-'))
    const h = await harness({ turn: { id: 'turn-1', folder: other } })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps())
    assert.equal(res.reason, 'stale')
  })

  it('이미 결과가 있는 id는 duplicate', async () => {
    const h = await harness()
    await storage.writeJson(join(h.paths.res, `${h.request.id}.res.json`), { v: 1 })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps())
    assert.equal(res.reason, 'duplicate')
  })

  it('증명 줄에 있는 id도 duplicate', async () => {
    const h = await harness()
    await storage.appendLine(h.paths.receipts, { v: 1, reqId: h.request.id })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps())
    assert.equal(res.reason, 'duplicate')
  })

  it('규칙집이 없으면 no_channel(내장 목록 없음)', async () => {
    const h = await harness()
    const res = await processMod.processRequest(
      { request: h.request, folder: h.folder },
      h.deps({ loadRules: async () => ({ ok: false, rules: [], source: null, problem: 'missing' }) })
    )
    assert.equal(res.reason, 'no_channel')
  })

  it('허용목록 밖 페이지는 rule_missing — 그림은 받지도 않는다', async () => {
    const h = await harness()
    const fetch = fakeFetch(okPage(pageHtml([IMAGE_URL])))
    const res = await processMod.processRequest(
      { request: { ...h.request, page: 'https://example.com/portal/x' }, folder: h.folder },
      h.deps({ fetchFn: fetch.fn })
    )
    assert.equal(res.reason, 'rule_missing')
    assert.deepEqual(fetch.calls, [])
  })

  it('https가 아닌 페이지는 rule_missing', async () => {
    const h = await harness()
    const res = await processMod.processRequest(
      { request: { ...h.request, page: 'http://www.nongsaro.go.kr/portal/x' }, folder: h.folder },
      h.deps()
    )
    assert.equal(res.reason, 'rule_missing')
  })

  it('페이지 받기 실패는 limit·timeout만 그대로, 나머지는 page_fetch', async () => {
    for (const [received, expected] of [
      ['status', 'page_fetch'],
      ['network', 'page_fetch'],
      ['timeout', 'timeout'],
      ['limit', 'limit']
    ] as const) {
      const h = await harness()
      const fetch = fakeFetch({ [PAGE_URL]: { ok: false, reason: received } })
      const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
      assert.equal(res.reason, expected, received)
      assert.equal(fetch.calls.length, 1)
    }
  })
})

describe('processRequest — 승인 경로', () => {
  it('1유형·페이지에 실재 ⇒ 승인, PNG만 저장하고 증명을 남긴다', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))

    assert.equal(res.status, 'done')
    assert.equal(res.needsChoice, false)
    const image = res.images[0]
    assert.equal(image?.verdict, 'approved')
    assert.equal(image?.reason, 'kogl_type_1')
    assert.equal(image?.kogl, 1)
    assert.equal(image?.org, '농촌진흥청')
    assert.equal(image?.sha256, storage.sha256Hex(PNG))
    assert.equal(image?.token, `app-figure:${storage.sha256Hex(PNG)}`)
    assert.equal(image?.label, null)

    // 결과 파일은 계약 경로에 있다.
    const written = JSON.parse(await readFile(join(h.paths.res, `${h.request.id}.res.json`), 'utf8'))
    assert.equal(written.id, h.request.id)
    assert.equal(written.status, 'done')

    // 저장소에는 재인코딩 PNG 하나뿐 — 원본 JPEG 바이트는 없다.
    const stored = await readdir(h.paths.store)
    assert.deepEqual(stored, [`${storage.sha256Hex(PNG)}.png`])
    assert.equal(await storage.fileSize(join(h.paths.store, stored[0] as string)), PNG.length)

    const receipt = JSON.parse((await readFile(h.paths.receipts, 'utf8')).trim())
    assert.equal(receipt.reqId, h.request.id)
    assert.equal(receipt.page.url, PAGE_URL)
    assert.equal(receipt.page.sha256, storage.sha256Hex(Buffer.from(pageHtml([IMAGE_URL]), 'utf8')))
    assert.deepEqual(receipt.page.marks, ['공공누리 제1유형'])
    assert.equal(receipt.image.origSha256, storage.sha256Hex(JPEG))
    assert.equal(receipt.image.sha256, storage.sha256Hex(PNG))
    assert.equal(receipt.image.ruleId, rule.id)
    assert.equal(contract.isApprovedReceipt(receipt), true)
  })

  it('승인 2장이면 후보표(A·B)를 쓰고 res에 이름을 붙인다', async () => {
    const h = await harness()
    const request = { ...h.request, images: [IMAGE_URL, IMAGE_URL_B] }
    const fetch = fakeFetch({
      ...okPage(pageHtml([IMAGE_URL, IMAGE_URL_B])),
      [IMAGE_URL]: okImage(),
      [IMAGE_URL_B]: okImage(IMAGE_URL_B)
    })
    const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))

    assert.equal(res.needsChoice, true)
    assert.deepEqual(res.images.map((image) => image.label), ['A', 'B'])
    assert.equal(res.images.every((image) => image.verdict === 'approved'), true)

    const sheet = await choices.readChoiceSheet(choices.choicePath(h.paths.choices, storage.folderHash(await realpath(h.folder)), '3.2'))
    assert.equal(sheet?.slot, '3.2')
    assert.deepEqual(sheet?.candidates.map((candidate) => candidate.label), ['A', 'B'])
    assert.equal(sheet?.studentMessage, null)
    assert.equal(sheet?.candidates[0]?.sha256, res.images[0]?.sha256)
  })

  it('3장 승인이면 A·B·C', async () => {
    const h = await harness()
    const third = 'https://www.nongsaro.go.kr/ps/img/curation/c.jpg'
    const request = { ...h.request, images: [IMAGE_URL, IMAGE_URL_B, third] }
    const fetch = fakeFetch({
      ...okPage(pageHtml([IMAGE_URL, IMAGE_URL_B, third])),
      [IMAGE_URL]: okImage(),
      [IMAGE_URL_B]: okImage(IMAGE_URL_B),
      [third]: okImage(third)
    })
    const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.deepEqual(res.images.map((image) => image.label), ['A', 'B', 'C'])
  })
})

describe('processRequest — 거절·애매', () => {
  it('공공누리 표시가 없으면 ambiguous, 원본만 증명하고 PNG는 저장하지 않는다', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL], '저작권 보호 자료')), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))

    assert.equal(res.status, 'done')
    assert.equal(res.images[0]?.verdict, 'ambiguous')
    assert.equal(res.images[0]?.reason, 'kogl_none')
    assert.equal(res.images[0]?.sha256, null)
    assert.equal(res.images[0]?.token, null)
    assert.deepEqual(await readdir(h.paths.store), [])

    const receipt = JSON.parse((await readFile(h.paths.receipts, 'utf8')).trim())
    assert.equal(receipt.image.verdict, 'ambiguous')
    assert.equal(receipt.image.sha256, null)
    assert.equal(receipt.image.origSha256, storage.sha256Hex(JPEG))
    assert.equal(contract.isApprovedReceipt(receipt), false)
  })

  it('3유형은 ambiguous(재인코딩 충돌)', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL], '공공누리 제3유형')), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.verdict, 'ambiguous')
    assert.equal(res.images[0]?.reason, 'kogl_type_3_no_derivative')
  })

  it('그림이 페이지 HTML에 없으면 rejected not_on_page', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.verdict, 'rejected')
    assert.equal(res.images[0]?.reason, 'not_on_page')
  })

  it('그림이 규칙 밖이면 받지 않고 거절', async () => {
    const h = await harness()
    const outside = 'https://www.nongsaro.go.kr/etc/a.jpg'
    const fetch = fakeFetch(okPage(pageHtml([outside])))
    const res = await processMod.processRequest(
      { request: { ...h.request, images: [outside] }, folder: h.folder },
      h.deps({ fetchFn: fetch.fn })
    )
    assert.equal(res.images[0]?.reason, 'host')
    assert.deepEqual(fetch.calls, [PAGE_URL])
  })

  it('Content-Type이 이미지도 octet-stream도 아니면 format', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage(IMAGE_URL, 'text/html') })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.reason, 'format')
    assert.equal(res.images[0]?.finalUrl, IMAGE_URL)
    assert.deepEqual(await readdir(h.paths.store), [])
  })

  it('매직 바이트가 이미지가 아니면 format', async () => {
    const h = await harness()
    const fetch = fakeFetch({
      ...okPage(pageHtml([IMAGE_URL])),
      [IMAGE_URL]: { ok: true, finalUrl: new URL(IMAGE_URL), status: 200, body: Buffer.from('not an image'), contentType: 'image/jpeg' }
    })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.reason, 'format')
  })

  it('디코더가 실패하면 decode_*로 거절하고 PNG를 저장하지 않는다', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest(
      { request: h.request, folder: h.folder },
      h.deps({ fetchFn: fetch.fn, decode: async () => ({ png: new Uint8Array(0), width: 8, height: 8 }) })
    )
    assert.equal(res.images[0]?.reason, 'decode_decode')
    assert.deepEqual(await readdir(h.paths.store), [])
  })

  it('하루 파일 상한이면 limit_daily_files', async () => {
    const h = await harness()
    await storage.writeJson(h.paths.counters, {
      v: 1,
      day: '2026-11-11',
      filesToday: storage.DAILY_FILE_LIMIT,
      folders: {}
    })
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.reason, 'limit_daily_files')
    assert.deepEqual(await readdir(h.paths.store), [])
  })

  it('폴더 바이트 상한이면 limit_folder_bytes', async () => {
    const h = await harness()
    const hash = storage.folderHash(await realpath(h.folder))
    await storage.writeJson(h.paths.counters, {
      v: 1,
      day: '2026-11-11',
      filesToday: 0,
      folders: { [hash]: storage.FOLDER_BYTE_LIMIT }
    })
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.reason, 'limit_folder_bytes')
  })
})

/* ── B-3: 리다이렉트 최종 URL ────────────────────────────────────────────────────────────────
 * 예전 구현은 `finalUrlAllowed`를 `true`로 박아 두고 리다이렉트 전 URL의 실재만 봤다. 그러면
 * 다른 기관 규칙의 그림으로 넘겨도 그 페이지의 공공누리가 붙는다. 아래 셋은 ①홉 검사 ②받은 뒤
 * 독립 재검사 ③실재 대조가 **최종** URL 기준이라는 것을 각각 잠근다.
 */

const otherRule = {
  id: 'other-org',
  host: 'www.nongsaro.go.kr',
  org: '다른기관',
  pagePath: '^/portal/other/.*',
  imagePath: '^/ps/img/other/.*',
  rule: 'page_kogl_applies_to_body_images'
}

const PUBLIC_DNS = async () => [{ address: '203.241.1.1', family: 4 }]

/** 응답 대역 — `hop`번째 요청에 무엇을 돌려줄지 고르고, 몇 번 불렸는지 센다. */
function hopTransport(pick: (hop: number) => { status: number; location?: string; body?: Buffer }): {
  transport: fetchTypes.Transport
  hops: () => number
} {
  let used = 0
  return {
    hops: () => used,
    transport: (_options, onResponse) => {
      const hop = used
      used += 1
      const plan = pick(hop)
      const request = { on() {}, end() {}, destroy() {} } as unknown as ClientRequest
      setImmediate(() => {
        const emitter = new EventEmitter()
        onResponse({
          statusCode: plan.status,
          headers: plan.location ? { location: plan.location } : { 'content-type': 'image/jpeg' },
          on: emitter.on.bind(emitter) as fetchTypes.TransportResponse['on'],
          destroy() {
            emitter.emit('close')
          }
        })
        setImmediate(() => {
          if (plan.body) emitter.emit('data', plan.body)
          emitter.emit('end')
        })
      })
      return request
    }
  }
}

describe('processRequest — 리다이렉트 최종 URL (B-3)', () => {
  it('다른 규칙의 그림 경로로 넘어가면 받지 않고 거절한다', async () => {
    const h = await harness()
    // 실제 fetchLimited를 쓴다 — process가 넘긴 홉 검사가 실제로 도는지 보려면 대역 fetch로는 부족하다.
    const redirect = hopTransport(() => ({ status: 302, location: 'https://www.nongsaro.go.kr/ps/img/other/x.jpg' }))
    const page = fakeFetch(okPage(pageHtml([IMAGE_URL])))
    const fetchFn: processTypes.FetchFn = async (url, options) => {
      const pageHit = page.fn
      if (url === PAGE_URL) return pageHit(url, options)
      return fetchMod.fetchLimited(url, { ...options, deps: { lookupAll: PUBLIC_DNS, transport: redirect.transport } })
    }
    const res = await processMod.processRequest(
      { request: h.request, folder: h.folder },
      h.deps({ fetchFn, loadRules: async () => ({ ...loadedRules, rules: [rule, otherRule] }) })
    )
    assert.equal(res.images[0]?.verdict, 'rejected')
    assert.equal(res.images[0]?.reason, 'outside_rules')
    // 두 번째 홉은 규칙 검사에서 끊겼으므로 요청이 나가지 않았다.
    assert.equal(redirect.hops(), 1)
    assert.deepEqual(await readdir(h.paths.store), [])
  })

  it('같은 규칙 안 리다이렉트라도 최종 URL이 페이지에 없으면 not_on_page', async () => {
    const h = await harness()
    // 원래 URL(IMAGE_URL)은 페이지에 있지만 최종 URL(IMAGE_URL_B)은 없다 — 예전 구현은 원래 URL을 봐서 통과했다.
    const redirect = hopTransport((hop) =>
      hop === 0 ? { status: 302, location: IMAGE_URL_B } : { status: 200, body: JPEG }
    )
    const page = fakeFetch(okPage(pageHtml([IMAGE_URL])))
    const fetchFn: processTypes.FetchFn = async (url, options) =>
      url === PAGE_URL
        ? page.fn(url, options)
        : fetchMod.fetchLimited(url, { ...options, deps: { lookupAll: PUBLIC_DNS, transport: redirect.transport } })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn }))
    assert.equal(res.images[0]?.finalUrl, IMAGE_URL_B)
    assert.equal(res.images[0]?.verdict, 'rejected')
    assert.equal(res.images[0]?.reason, 'not_on_page')
    assert.deepEqual(await readdir(h.paths.store), [])
  })

  it('페이지에 최종 URL만 있으면 승인 — 실재는 최종 URL로 본다', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL_B])), [IMAGE_URL]: okImage(IMAGE_URL_B) })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.finalUrl, IMAGE_URL_B)
    assert.equal(res.images[0]?.verdict, 'approved')
  })

  it('최종 URL이 다른 규칙의 그림 경로면 final_url_outside_rules', async () => {
    const h = await harness()
    // 홉 검사가 못 본 경우(대역 fetch)에도 받은 뒤 최종 URL을 **따로** 규칙에 물린다.
    const outside = 'https://www.nongsaro.go.kr/ps/img/other/b.jpg'
    const fetch = fakeFetch({ ...okPage(pageHtml([outside])), [IMAGE_URL]: okImage(outside) })
    const res = await processMod.processRequest(
      { request: h.request, folder: h.folder },
      h.deps({ fetchFn: fetch.fn, loadRules: async () => ({ ...loadedRules, rules: [rule, otherRule] }) })
    )
    assert.equal(res.images[0]?.verdict, 'rejected')
    assert.equal(res.images[0]?.reason, 'final_url_outside_rules')
    assert.deepEqual(await readdir(h.paths.store), [])
  })
})

describe('decodeBody — 문자셋 (R-3)', () => {
  // EUC-KR 바이트. `공공누리 제1유형`이 깨지면 readKogl이 마크를 못 읽어 승인이 통째로 사라진다.
  // 원문은 EUC_KR_PLAIN_HTML이고, 아래 배열은 그 문자열을 EUC-KR로 인코딩한 값(109바이트)이다.
  it('content-type의 charset을 쓴다', () => {
    const text = processMod.decodeBody(EUC_KR_PLAIN, 'text/html; charset=euc-kr')
    assert.match(text, /공공누리 제1유형/)
    assert.equal(verdict.readKogl(text).type, 1)
  })

  it('<meta charset>만 있어도 그 charset을 쓴다', () => {
    const text = processMod.decodeBody(EUC_KR_META, 'text/html')
    assert.match(text, /공공누리 제1유형/)
    assert.equal(verdict.readKogl(text).type, 1)
  })

  it('charset 표시가 없으면 utf-8', () => {
    assert.equal(processMod.decodeBody(Buffer.from('공공누리', 'utf8'), null), '공공누리')
  })

  it('모르는 charset 이름은 utf-8로 떨어진다(던지지 않는다)', () => {
    assert.equal(processMod.decodeBody(Buffer.from('공공누리', 'utf8'), 'text/html; charset=x-nope'), '공공누리')
  })

  it('EUC-KR 페이지가 끝에서 끝까지 승인된다', async () => {
    const h = await harness()
    const fetch = fakeFetch({
      [PAGE_URL]: {
        ok: true,
        finalUrl: new URL(PAGE_URL),
        status: 200,
        body: Buffer.from(EUC_KR_PLAIN),
        contentType: 'text/html; charset=euc-kr'
      },
      [IMAGE_URL]: okImage()
    })
    const res = await processMod.processRequest({ request: h.request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.verdict, 'approved')
    assert.equal(res.images[0]?.kogl, 1)
  })
})

describe('pageQuery — 공용 flow 벡터', () => {
  const rules = rulesMod.parseRules(JSON.stringify(vectors.rules))
  const thirdFile = structuredClone(vectors.rules) as { rules: Record<string, unknown>[] }
  Object.assign(thirdFile, { orgTerms: ['협회'], creditWords: ['제공'], latinOk: [] })
  for (const item of thirdFile.rules) {
    if (item.rule !== 'page_query_kogl_applies_to_body_images') continue
    Object.assign(item, { rule: 'page_query_kogl_org_applies_to_body_images', org: '시험기관', orgAliases: ['시험기관'],
      bodyStart: '<div id="body">', bodyEnd: '<div id="mark">' })
  }
  const thirdRules = rulesMod.parseRules(JSON.stringify(thirdFile))
  for (const [label, flowRules] of [['second', rules], ['third', thirdRules]] as const) {
  for (const [kind, page, image, locations, expected, memo] of vectors.flow) {
    it(`${label}: ${memo}`, async () => {
      const h = await harness({ rules: { ...loadedRules, rules: flowRules } })
      const start = kind === 'page' ? page : image!
      // 최종 그림 주소를 페이지에 넣어 실재 대조가 홉 규칙 시험을 가리지 않게 한다.
      let final = new URL(start)
      for (const location of locations) final = new URL(location, final)
      const content = pageHtml(kind === 'image' ? [final.href] : [])
      const html = label === 'third' ? `<div id="body">${content}<div id="mark">` : content
      const sent: string[] = []
      const transport = hopTransport((hop) => hop < locations.length
        ? { status: 302, location: locations[hop]! }
        : { status: 200, body: kind === 'image' ? JPEG : Buffer.from(html) })
      const fetchFn: processTypes.FetchFn = async (raw, options) => {
        if (kind === 'image' && raw === page) return okPage(html, page)[page]!
        return fetchMod.fetchLimited(raw, {
          ...options,
          deps: {
            lookupAll: PUBLIC_DNS,
            transport: (request, respond) => {
              sent.push(`https://${request.host}${request.path}`)
              return transport.transport(request, respond)
            }
          }
        })
      }
      const request = { ...h.request, page, images: kind === 'image' ? [image!] : [] }
      const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ fetchFn, gate: listGate() }))
      assert.equal(kind === 'page' ? res.status === 'done' : res.images[0]?.verdict === 'approved', expected)
      // 실제 전송 목록을 독립적인 원문 경로 경계로 계산한다. 거절된 홉은 전송되지 않아야 한다.
      const expectedSent = [start]
      let current = new URL(start)
      for (const location of locations) {
        if (kind === 'page' && page.startsWith('https://www.example.go.kr/')) break
        if (expectedSent.length === 4) break
        const next = new URL(location, current)
        const allowedPrefix = kind === 'page'
          ? 'https://plain.example.go.kr/plain/view.do?'
          : start.slice(0, start.lastIndexOf('/') + 1)
        if (!next.href.startsWith(allowedPrefix)) break
        expectedSent.push(next.href)
        current = next
      }
      assert.deepEqual(sent, expectedSent)
      if (!expected && kind === 'page') assert.equal(res.reason, 'page_fetch')
      if (!expected) assert.deepEqual(await readdir(h.paths.store), [])
    })
  }
  }

  it('같은 호스트·겹친 imagePath의 둘째 페이지 항목이 승인·증명까지 간다', async () => {
    const h = await harness({ rules: { ...loadedRules, rules } })
    const page = 'https://www.example.go.kr/board/board.do?boardId=cardnews&prgId=con_cardnews&mode=view&dataNo=1'
    const image = 'https://www.example.go.kr/files/a.png'
    const fetch = fakeFetch({ ...okPage(pageHtml([image]), page), [image]: okImage(image) })
    const request = { ...h.request, page, images: [image] }
    const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.verdict, 'approved')
    assert.equal(res.images[0]?.org, '시험기관(카드뉴스)')
    assert.deepEqual(await readdir(h.paths.store), [`${storage.sha256Hex(PNG)}.png`])
    const receipt = JSON.parse((await readFile(h.paths.receipts, 'utf8')).trim())
    assert.equal(receipt.image.ruleId, 't-card')
    assert.equal(contract.isApprovedReceipt(receipt), true)
  })
})

/** 요청 처리 순서 시험의 동기 게이트. 실제 통로의 계수는 index.test에서 별도로 잠근다. */
function listGate(limit = 6): processTypes.TurnGate & { close(): void; used(): number } {
  let alive = true
  let used = 0
  let rejected = 0
  return {
    close() { alive = false },
    used: () => used,
    begin: () => ({
      live: () => alive,
      open: () => alive ? () => {} : null,
      reserve: () => {
        if (!alive || used >= limit) return false
        used += 1
        return true
      },
      noteReject: () => {
        if (rejected >= 24) return false
        rejected += 1
        return true
      }
    })
  }
}

const writes: processTypes.WriteSeam = {
  atomic: storage.writeAtomic, json: storage.writeJson,
  jsonNew: storage.writeJsonNew, line: storage.appendLine
}

describe('processRequest — P1.1 list', () => {
  it('페이지 GET 하나와 정확한 목록 결과만, 그림 저장·증명·후보표·계수는 무접촉', async () => {
    const h = await harness()
    const request = { ...h.request, images: [] }
    const fetch = fakeFetch(okPage(pageHtml([IMAGE_URL])))
    await storage.writeJson(h.paths.counters, { sentinel: 'old counters' })
    await storage.appendLine(h.paths.receipts, { reqId: 'older-request' })
    const counters = await readFile(h.paths.counters, 'utf8')
    const receipts = await readFile(h.paths.receipts, 'utf8')
    const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ gate: listGate(), fetchFn: fetch.fn }))
    assert.deepEqual(res, {
      v: 1, id: request.id, status: 'done', slot: request.slot, needsChoice: false, images: [],
      kogl: 1, org: rule.org, candidates: [{ url: IMAGE_URL, credit: 'none' }], candidatesTruncated: false
    })
    assert.deepEqual(fetch.calls, [PAGE_URL])
    assert.deepEqual(await readdir(h.paths.store), [])
    assert.deepEqual(await readdir(h.paths.choices), [])
    assert.equal(await readFile(h.paths.counters, 'utf8'), counters)
    assert.equal(await readFile(h.paths.receipts, 'utf8'), receipts)
    assert.deepEqual(await storage.readJson(join(h.paths.res, `${request.id}.res.json`)), res)
  })

  for (const [mark, kogl] of [['공공누리 제4유형', 4], ['', null], ['제1유형 제2유형', null]] as const) {
    it(`목록은 권리 판독 ${String(kogl)}도 후보를 싣고 승인을 주장하지 않는다: ${mark}`, async () => {
      const h = await harness()
      const fetch = fakeFetch(okPage(pageHtml([IMAGE_URL], mark)))
      const res = await processMod.processRequest({ request: { ...h.request, images: [] }, folder: h.folder },
        h.deps({ gate: listGate(), fetchFn: fetch.fn }))
      assert.equal(res.kogl, kogl)
      assert.deepEqual(res.candidates, [{ url: IMAGE_URL, credit: 'none' }])
      assert.deepEqual(res.images, [])
    })
  }

  it('그림 없는 페이지도 done 빈 목록', async () => {
    const h = await harness()
    const res = await processMod.processRequest({ request: { ...h.request, images: [] }, folder: h.folder },
      h.deps({ gate: listGate(), fetchFn: fakeFetch(okPage(pageHtml([]))).fn }))
    assert.equal(res.status, 'done')
    assert.deepEqual(res.candidates, [])
    assert.equal(res.candidatesTruncated, false)
  })

  for (const image of [IMAGE_URL, 'https://www.nongsaro.go.kr/ps/img/curation/%ED%8F%AC%EC%8A%A4%ED%84%B0.png']) {
    it(`목록 URL 그대로 다음 그림 요청에서 승인: ${image}`, async () => {
      const h = await harness()
      const htmlImage = image === IMAGE_URL ? image : '/ps/img/curation/포스터.png'
      const fetch = fakeFetch({ ...okPage(pageHtml([htmlImage])), [image]: okImage(image) })
      const gate = listGate()
      const listing = await processMod.processRequest({ request: { ...h.request, images: [] }, folder: h.folder },
        h.deps({ gate, fetchFn: fetch.fn }))
      const request = { ...h.request, id: `${h.request.id}-fetch`, images: [listing.candidates![0]!.url] }
      assert.equal(contract.parseFigureRequest(JSON.stringify(request)).ok, true)
      const fetched = await processMod.processRequest({ request, folder: h.folder }, h.deps({ gate, fetchFn: fetch.fn }))
      assert.equal(fetched.images[0]?.verdict, 'approved')
      for (const key of ['kogl', 'org', 'candidates', 'candidatesTruncated']) assert.equal(Object.hasOwn(fetched, key), false)
      assert.deepEqual(fetch.calls, [PAGE_URL, PAGE_URL, image])
    })
  }

  it('gate 없는 목록은 no_channel 전송 0, gate 없는 그림 요청은 기존 승인', async () => {
    const h = await harness()
    const fetch = fakeFetch({ ...okPage(pageHtml([IMAGE_URL])), [IMAGE_URL]: okImage() })
    const res = await processMod.processRequest({ request: { ...h.request, images: [] }, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.reason, 'no_channel')
    assert.deepEqual(fetch.calls, [])
    const fetched = await processMod.processRequest({ request: { ...h.request, id: `${h.request.id}-next` }, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(fetched.images[0]?.verdict, 'approved')
  })

  it('jsonNew 중복 경쟁은 파일을 덮지 않고 정본 결과를 반환', async () => {
    const h = await harness()
    const request = { ...h.request, images: [] }
    const existing = { v: 1, id: request.id, status: 'done', slot: 'older', needsChoice: false, images: [],
      kogl: 2, org: 'old', candidates: [], candidatesTruncated: false }
    const write: processTypes.WriteSeam = { ...writes, jsonNew: async (path) => {
      await storage.writeJsonNew(path, existing)
      return false
    } }
    const res = await processMod.processRequest({ request, folder: h.folder },
      h.deps({ gate: listGate(), write, fetchFn: fakeFetch(okPage(pageHtml([IMAGE_URL]))).fn }))
    assert.deepEqual(res, existing)
    assert.deepEqual(await storage.readJson(join(h.paths.res, `${request.id}.res.json`)), existing)
  })

  for (const reason of ['rule_missing', 'limit_turn', 'page_fetch', 'timeout', 'limit'] as const) {
    it(`살아 있는 목록 거절은 결과 파일을 남긴다: ${reason}`, async () => {
      const h = await harness()
      const fetch = fakeFetch({ [PAGE_URL]: { ok: false, reason: reason === 'timeout' || reason === 'limit' ? reason : 'status' } })
      const request = { ...h.request, images: [], ...(reason === 'rule_missing' ? { page: 'https://outside.gov/x' } : {}) }
      const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ gate: listGate(reason === 'limit_turn' ? 0 : 6), fetchFn: fetch.fn }))
      assert.equal(res.reason, reason)
      assert.deepEqual(await storage.readJson(join(h.paths.res, `${request.id}.res.json`)), res)
    })
  }

  for (const point of ['rules', 'before-reserve', 'reserve', 'get-success', 'get-status', 'get-timeout', 'get-limit', 'settle', 'closed'] as const) {
    it(`죽은 세대의 목록은 ${point}에서도 cancelled 우선, 모든 산출물 0`, async () => {
      const h = await harness()
      const gate = listGate()
      const baseLease = gate.begin()
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const deps = h.deps({ gate, fetchFn: async () => {
        if (point.startsWith('get-')) { entered.resolve(); await resume.promise }
        if (point === 'get-status') return { ok: false, reason: 'status' }
        if (point === 'get-timeout') return { ok: false, reason: 'timeout' }
        if (point === 'get-limit') return { ok: false, reason: 'limit' }
        return okPage(pageHtml([IMAGE_URL]))[PAGE_URL]!
      } })
      if (point === 'rules') deps.loadRules = async () => {
        entered.resolve(); await resume.promise
        return { ...loadedRules, rules: [] }
      }
      if (point === 'before-reserve') deps.loadRules = async () => {
        entered.resolve(); await resume.promise
        return loadedRules
      }
      if (point === 'reserve' || point === 'settle') deps.gate = { begin: () => ({ ...baseLease,
        ...(point === 'reserve' ? { reserve: () => { gate.close(); return false } } : {}),
        ...(point === 'settle' ? { open: () => { gate.close(); return null } } : {})
      }) }
      if (point === 'closed') gate.close()
      const pending = processMod.processRequest({ request: { ...h.request, images: [] }, folder: h.folder }, deps)
      if (point === 'rules' || point === 'before-reserve' || point.startsWith('get-')) {
        await entered.promise
        gate.close()
        resume.resolve()
      }
      const res = await pending
      assert.equal(res.reason, 'cancelled')
      assert.deepEqual(await readdir(h.paths.res), [])
      assert.deepEqual(await readdir(h.paths.store), [])
      assert.deepEqual(await readdir(h.paths.choices), [])
      assert.equal(await storage.fileExists(h.paths.receipts), false)
      assert.equal(await storage.fileExists(h.paths.counters), false)
      if (point === 'reserve' || point === 'before-reserve' || point === 'closed') assert.equal(gate.used(), 0)
    })
  }

  it('동시 목록·그림 7건은 GET 6건, 실패해도 자리를 돌려주지 않는다', async () => {
    const h = await harness()
    const gate = listGate()
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    const deps = h.deps({ gate, fetchFn: async () => {
      calls += 1
      if (calls === 6) entered.resolve()
      await release.promise
      return { ok: false, reason: 'timeout' }
    } })
    const pending = Array.from({ length: 7 }, (_, i) => processMod.processRequest({
      request: { ...h.request, id: `${h.request.id}-${i}`, images: i % 2 ? [IMAGE_URL] : [] }, folder: h.folder
    }, deps))
    await entered.promise
    release.resolve()
    const results = await Promise.all(pending)
    assert.equal(calls, 6)
    assert.equal(results.filter((res) => res.reason === 'limit_turn').length, 1)
    const later = await processMod.processRequest({ request: { ...h.request, id: `${h.request.id}-later`, images: [] }, folder: h.folder }, deps)
    assert.equal(later.reason, 'limit_turn')
    assert.equal(calls, 6)
  })
})

describe('P1.1 농사로 철회 경계', () => {
  it('removed 메타데이터가 있어도 규칙 없는 농사로 목록·받기는 rule_missing, 전송 0', async () => {
    const rules = rulesMod.parseRules(JSON.stringify({ v: 1, rules: [], removed: [{ id: 'nongsaro-curation' }] }))
    for (const images of [[], [IMAGE_URL]]) {
      const h = await harness({ rules: { ...loadedRules, rules } })
      const fetch = fakeFetch(okPage(pageHtml([IMAGE_URL])))
      const res = await processMod.processRequest({ request: { ...h.request, images }, folder: h.folder },
        h.deps({ gate: listGate(), fetchFn: fetch.fn }))
      assert.equal(res.reason, 'rule_missing')
      assert.deepEqual(fetch.calls, [])
    }
  })
})

describe('RDA — process storage and comparison boundaries', () => {
  const page = 'https://www.example.go.kr/board/board.do?k=v'
  const image = 'https://www.example.go.kr/files/%5b%EA%B0%80%5d_a.png'
  const final = 'https://www.example.go.kr/files/b.png'
  const source = { v: 1, orgTerms: ['협회'], creditWords: ['제공'], latinOk: ['AI'], rules: [{
    id: 'rda-test', host: 'www.example.go.kr', org: '시험기관', pagePath: '^/board/board\\.do$',
    imagePath: '^/files/.+', rule: 'page_query_kogl_org_applies_to_body_images', pageQuery: { k: { literal: 'v' } },
    orgAliases: ['시험기관'], bodyStart: '<div id="body">', bodyEnd: '<div id="mark">'
  }] }
  const rules = rulesMod.parseRules(JSON.stringify(source))
  for (const [name, body, redirected, reason] of [
    ['approved bracket resource', '<div id="body"><img src="/files/[가]_a.png" alt="AI 안내"><div id="mark">', false, 'kogl_type_1'],
    ['organization hit', '<div id="body"><img src="/files/[가]_a.png" alt="식량과기후 제공시험기관"><div id="mark">', false, 'third_party_org'],
    ['no body markers', '<img src="/files/[가]_a.png">', false, 'third_party_unknown'],
    ['request present but redirected final absent', '<div id="body"><img src="/files/[가]_a.png"><div id="mark">', true, 'not_on_page'],
    ['explicit rights far from image', `<div id="body"><img src="/files/[가]_a.png">${'x'.repeat(1500)}<p>ⓒ 2026</p><div id="mark">`, false, 'third_party_credit']
  ] as const) {
    it(name, async () => {
      const h = await harness({ rules: { ...loadedRules, rules } })
      const fetch = fakeFetch({ ...okPage(`${body}<p>공공누리 제1유형</p>`, page), [image]: okImage(redirected ? final : image) })
      let decodes = 0
      const request = { ...h.request, page, images: [image] }
      const res = await processMod.processRequest({ request, folder: h.folder }, h.deps({ fetchFn: fetch.fn,
        decode: async () => { decodes += 1; return { png: PNG, width: 8, height: 8 } } }))
      const approved = reason === 'kogl_type_1'
      assert.equal(res.images[0]?.verdict, approved ? 'approved' : reason === 'not_on_page' ? 'rejected' : 'ambiguous')
      assert.equal(res.images[0]?.reason, reason)
      assert.deepEqual(fetch.calls, [page, image])
      assert.equal(res.images[0]?.url, image)
      assert.equal(res.images[0]?.finalUrl, redirected ? final : image)
      assert.equal(decodes, approved ? 1 : 0)
      assert.deepEqual(await readdir(h.paths.store), approved ? [`${storage.sha256Hex(PNG)}.png`] : [])
      const receipt = JSON.parse((await readFile(h.paths.receipts, 'utf8')).trim())
      assert.equal(receipt.image.url, image)
      assert.equal(receipt.image.finalUrl, redirected ? final : image)
      assert.equal(receipt.image.reason, reason)
      assert.equal(receipt.image.sha256, approved ? storage.sha256Hex(PNG) : null)
      assert.deepEqual(await storage.readJson(join(h.paths.res, `${request.id}.res.json`)), res)
    })
  }
  it('comparison equivalence never bypasses the original imagePath check', async () => {
    const narrow = structuredClone(source)
    narrow.rules[0]!.imagePath = '^/files/%5B.+'
    const h = await harness({ rules: { ...loadedRules, rules: rulesMod.parseRules(JSON.stringify(narrow)) } })
    const html = '<div id="body"><img src="/files/[가]_a.png"><div id="mark"><p>제1유형</p>'
    const fetch = fakeFetch(okPage(html, page))
    const res = await processMod.processRequest({ request: { ...h.request, page, images: [image] }, folder: h.folder }, h.deps({ fetchFn: fetch.fn }))
    assert.equal(res.images[0]?.verdict, 'rejected')
    assert.equal(res.images[0]?.reason, 'host')
    assert.deepEqual(fetch.calls, [page])
    assert.deepEqual(await readdir(h.paths.store), [])
  })
})
