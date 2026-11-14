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

  it('https가 아닌 페이지는 invalid', async () => {
    const h = await harness()
    const res = await processMod.processRequest(
      { request: { ...h.request, page: 'http://www.nongsaro.go.kr/portal/x' }, folder: h.folder },
      h.deps()
    )
    assert.equal(res.reason, 'invalid')
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
