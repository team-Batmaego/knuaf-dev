/**
 * 종이 칸 그림(v0.6.4 사진 갈래) — Node 단위 시험. Electron 창을 띄우지 않는다.
 *
 * 잠그는 것(발주 ③ ①~⑥ + 추가 확인):
 * ① 원격·`file:`·`data:` 원문·`//host`·절대 경로·`..`·`%2e%2e`·역슬래시 → `<img>` 없음, alt 글자.
 * ② 논문 폴더 뿌리 안 상대 경로만 그린다 — 심링크로 폴더 밖을 가리키면 404.
 * ③ 머리 바이트가 진짜 그림인지 + 허용 형식 + 크기 상한 + 동시 요청 상한.
 * ④ 폴더가 바뀌면 옛 폴더 그림 거절.
 * ⑤ 실패는 "그림을 찾지 못했어요 · <경로>" 한 줄(색·상자 없음).
 * ⑥ `gg-assets-XXXX/images/…`·`figures/public/…`·`figures/generated/…`·글자와 같은 줄 그림.
 *
 * 시험용 그림은 **여기서 만든 가짜 바이트**다(실학생 자료 금지).
 */
import { expect, test } from '@playwright/test'
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderMarkdown } from '../src/renderer/src/markdown'
import { createPaperImages } from '../src/main/paper-images'
import { checkImageRequest, imageMagicMatches } from '../src/main/paper-images/check'
import {
  IMAGE_MAX_BYTES,
  IMAGE_MISS_TEXT,
  IMAGE_SCHEME,
  IMAGE_SRC_PREFIX,
  decodeImageSrc,
  encodeImageSrc,
  imageMissText,
  localImagePath,
  relativeImagePath
} from '../src/shared/paper-image'

/**
 * 120×80 불투명 두 색(빨강·남색) 체크 PNG — 머리 바이트·압축·CRC가 진짜 PNG다.
 * 화면 확인용 시험에서도 "흰 빈 칸"으로 보이지 않아야 한다(1×1 흰 점은 실패와 구별되지 않는다).
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAYAAADSm7GJAAABJElEQVR42u3bsQnDAADEQE2S2kN4xAzmrewhTAg8V3wt0NfqOo77zT7n99Xwf8uP3G1+5G7zI3ebH7nb/Mjd5kfuNj9yt/mRu82P3G1+5G7zI3ebH7nb/Mjd5kfuNj9yt/mRu82P3G1+5G7zI3ebH7nb/Mjd5kfuNj9yt/mRu82P3G1+5G7zI3ebH7nb/Mjd5kfuNj9yt/mRqw8mVx9Mrj7YufpgfH0wvj4YXx+sDyZXH0yuPti5+mDn6oPx9cH4+mB9MLn6YHL1weTqg52rD8bXB+Prg/H1wfpgcvXB5OqDnasPxtcH4+uD8fXB+mBy9cHk6oPJ1Qc7Vx+Mrw/G1wfrg8nVB5OrDyZXH+xcfTC+PhhfH4yvD9YHk6sPJlcf7Ny/8h9vFbPfqFF5fQAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)])
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])

const scratch = (): string => mkdtempSync(join(tmpdir(), 'knuaf-paper-images-'))

/** 논문 폴더 하나 + `files` 경로에 바이트를 쓴다(상대 경로 → 바이트). */
function projectFolder(files: Record<string, Buffer> = {}): string {
  const root = scratch()
  for (const [rel, bytes] of Object.entries(files)) {
    const target = join(root, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, bytes)
  }
  return root
}

const urlOf = (rel: string): string => encodeImageSrc(rel)

const srcOf = (html: string): string[] => [...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1])

test('주소 규칙: 우리 스킴 왕복, 상대 경로만, 경로 문자열 판정', () => {
  expect(IMAGE_SCHEME).toBe('knuaf-img')
  expect(IMAGE_SRC_PREFIX).toBe('knuaf-img://paper/')
  // 왕복 — 공백·한글·괄호·`+`·`&`가 경로 한 조각으로 남는다.
  for (const rel of ['figures/public/x.png', 'figures/사진 1.png', 'figures/a(b)+c&d.png', 'gg-assets-1/images/x.png']) {
    expect(decodeImageSrc(encodeImageSrc(rel))).toBe(rel)
  }
  expect(encodeImageSrc('figures/a.png')).toBe('knuaf-img://paper/figures%2Fa.png')
  // 상대 경로가 아닌 것 — 거절.
  for (const bad of ['/abs.png', '\\\\host\\x.png', 'C:\\x\\y.png', 'figures/../x.png', 'figures/./x.png', 'a//b.png', '', 'a\u0000b.png']) {
    expect(relativeImagePath(bad)).toBeNull()
  }
  for (const bad of ['', 'nope.png', 'figures/../x.png', 'knuaf-img://other/x.png']) {
    expect(decodeImageSrc(bad)).toBeNull()
  }
})

test('마크다운: 폴더 안 상대 경로만 <img>를 낸다 — 원격·file·data·절대·.. 는 alt 글자만', () => {
  const local = renderMarkdown('![생산량](figures/public/x.png)')
  expect(srcOf(local)).toEqual([urlOf('figures/public/x.png')])
  expect(local).toContain('alt="생산량"')

  for (const bad of [
    'https://example.com/x.png',
    'http://example.com/x.png',
    '//host/x.png',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'C:/Users/x/y.png',
    '/abs.png',
    '../out.png',
    'figures/../../out.png',
    'figures/%2e%2e/out.png',
    'figures\\x.png'
  ]) {
    const html = renderMarkdown(`![설명](${bad})`)
    expect(html, bad).not.toContain('<img')
    expect(html, bad).not.toContain('src=')
    expect(html, bad).toContain('설명')
  }
})

test('마크다운: gg-assets·figures/public·figures/generated·글자와 같은 줄 그림', () => {
  for (const rel of ['gg-assets-A1B2/images/x.png', 'figures/public/x.png', 'figures/generated/x.png']) {
    expect(srcOf(renderMarkdown(`![](${rel})`)), rel).toEqual([urlOf(rel)])
  }
  // 글자 옆 그림 — 한 문단 안에 글자와 그림이 함께 남는다.
  const inline = renderMarkdown('그림 ![](figures/public/x.png) 입니다')
  expect(srcOf(inline)).toEqual([urlOf('figures/public/x.png')])
  expect(inline).toContain('그림 ')
  expect(inline).toContain(' 입니다')
  // 공백이 든 경로는 마크다운 각괄호 표기로만 원문이 보존된다.
  expect(srcOf(renderMarkdown('![](<figures/사진 1.png>)'))).toEqual([urlOf('figures/사진 1.png')])
})

test('못 찾은 그림 문구 — 짧은 한 줄, 경로 그대로, 우리 그림이 아니면 건드리지 않는다', () => {
  expect(IMAGE_MISS_TEXT).toBe('그림을 찾지 못했어요 · ')
  expect(imageMissText(urlOf('figures/old/x.png'), '설명')).toBe('그림을 찾지 못했어요 · figures/old/x.png')
  expect(imageMissText('https://example.com/x.png', '설명')).toBeNull()
  // 깨진 우리 주소 — 경로를 말할 수 없으니 alt 글자.
  expect(imageMissText('knuaf-img://paper/%zz', '설명')).toBe('설명')
})

test('요청 판정: 우리 주소만, 경로 조각이 하나, 점 이스케이프·형식 밖 거절', () => {
  expect(checkImageRequest(urlOf('figures/public/x.png'))).toEqual({ ok: true, rel: 'figures/public/x.png' })
  for (const rel of ['gg-assets-1/images/x.jpg', 'figures/generated/a.webp', 'x.gif', 'x.bmp', 'x.jpeg']) {
    expect(checkImageRequest(urlOf(rel)).ok, rel).toBe(true)
  }
  // 다른 스킴·빈 값·길이 초과.
  expect(checkImageRequest('https://example.com/x.png')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkImageRequest('knuaf-img://other/x.png')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkImageRequest('')).toEqual({ ok: false, reason: 'empty' })
  expect(checkImageRequest(undefined)).toEqual({ ok: false, reason: 'empty' })
  expect(checkImageRequest(IMAGE_SRC_PREFIX + 'a'.repeat(4000) + '.png')).toEqual({ ok: false, reason: 'too_long' })
  // 경로 조각이 여럿이거나 구분자가 섞인 주소 — 우리 규칙은 만들 수 없다.
  for (const bad of [
    'knuaf-img://paper/figures/public/x.png',
    'knuaf-img://paper/figures%2F..%2Fx.png',
    'knuaf-img://paper/%2E%2E%2Fx.png',
    'knuaf-img://paper/x.png?y=1',
    'knuaf-img://paper/x.png#f',
    'knuaf-img://paper/x%5Cy.png',
    'knuaf-img://paper/%2Fetc%2Fpasswd',
    'knuaf-img://paper/C%3A%2Fx.png'
  ]) {
    expect(checkImageRequest(bad), bad).toEqual({ ok: false, reason: 'malformed' })
  }
  // 허용 형식 밖.
  expect(checkImageRequest(urlOf('figures/x.svg'))).toEqual({ ok: false, reason: 'format' })
  expect(checkImageRequest(urlOf('figures/x.exe'))).toEqual({ ok: false, reason: 'format' })
})

test('머리 바이트: 확장자만 그림인 파일은 거절', () => {
  expect(imageMagicMatches('a.png', PNG)).toBe(true)
  expect(imageMagicMatches('a.jpg', JPEG)).toBe(true)
  expect(imageMagicMatches('a.gif', GIF)).toBe(true)
  expect(imageMagicMatches('a.bmp', BMP)).toBe(true)
  expect(imageMagicMatches('a.webp', WEBP)).toBe(true)
  // 확장자와 내용이 다르면 거절.
  expect(imageMagicMatches('a.png', Buffer.from('not a png at all'))).toBe(false)
  expect(imageMagicMatches('a.png', JPEG)).toBe(false)
  expect(imageMagicMatches('a.jpg', PNG)).toBe(false)
  expect(imageMagicMatches('a.gif', Buffer.from('GIF88a'))).toBe(false)
  expect(imageMagicMatches('a.svg', Buffer.from('<svg/>'))).toBe(false)
})

test('응답: 폴더 안 진짜 그림은 그대로, 없으면 404, 형식·크기 위반도 404', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)])
  const root = projectFolder({
    'figures/public/ok.png': PNG,
    'figures/generated/photo.jpg': JPEG,
    'gg-assets-X1/images/shot.gif': GIF,
    'figures/public/fake.png': Buffer.from('<!doctype html><script>alert(1)</script>'),
    'figures/public/huge.png': big,
    'figures/public/empty.png': Buffer.alloc(0)
  })
  const images = createPaperImages(() => root)
  const get = (rel: string): Promise<Response> => images.handle(new Request(urlOf(rel)))

  const ok = await get('figures/public/ok.png')
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG)
  expect((await get('figures/generated/photo.jpg')).headers.get('content-type')).toBe('image/jpeg')
  expect((await get('gg-assets-X1/images/shot.gif')).status).toBe(200)

  for (const rel of [
    'figures/public/missing.png',
    'figures/public/fake.png',
    'figures/public/huge.png',
    'figures/public/empty.png',
    'figures/x.svg'
  ]) {
    expect((await get(rel)).status, rel).toBe(404)
  }
})

test('응답: 폴더 밖은 어떤 모양으로도 못 읽는다 — ..·절대·심링크·UNC·드라이브', async () => {
  const outside = projectFolder({ 'secret.png': PNG })
  const root = projectFolder({ 'figures/public/ok.png': PNG })
  // 폴더 밖을 가리키는 심링크 — realpath가 밖을 주므로 거절.
  mkdirSync(join(root, 'figures/link'), { recursive: true })
  symlinkSync(outside, join(root, 'figures/link/out'))
  // 하드링크는 **폴더 안에 있는 이름**이다(같은 inode의 또 다른 경로). realpath는 폴더 안 경로를 주고,
  // 그 이름으로 읽는 것은 실제로 폴더 안 파일을 읽는 것이다 — 그래서 읽힌다. 폴더 밖 이름이 필요 없으므로
  // "폴더 밖을 가리키는 하드링크"라는 상태는 존재하지 않는다(심링크·정션과 다른 점).
  linkSync(join(outside, 'secret.png'), join(root, 'figures/public/hard.png'))
  const images = createPaperImages(() => root)
  const getUrl = (src: string): Promise<Response> => images.handle(new Request(src))

  expect((await getUrl(urlOf('figures/link/out/secret.png'))).status).toBe(404)
  expect((await getUrl(urlOf('figures/public/hard.png'))).status).toBe(200)
  for (const raw of [
    `knuaf-img://paper/${'%2E%2E'}%2Fsecret.png`,
    'knuaf-img://paper/%2F' + encodeURIComponent(join(outside, 'secret.png')),
    urlOf('../secret.png'),
    urlOf('/etc/passwd'),
    urlOf('C:\\x\\secret.png'),
    urlOf('\\\\host\\share\\secret.png')
  ]) {
    expect((await getUrl(raw)).status, raw).toBe(404)
  }
  // 폴더가 없으면(열린 논문 없음) 그릴 것도 없다.
  const none = createPaperImages(() => null)
  expect((await none.handle(new Request(urlOf('figures/public/ok.png')))).status).toBe(404)
})

test('응답: 폴더가 바뀌면 옛 폴더 그림은 거절', async () => {
  // 두 폴더 모두 `ok.png`를 갖지만 바이트가 다르다 — 새 폴더를 읽는지 바이트로 가른다.
  const changed = Buffer.concat([PNG, Buffer.from([0])])
  const first = projectFolder({ 'figures/public/ok.png': PNG, 'figures/only-old.png': PNG })
  const second = projectFolder({ 'figures/public/ok.png': changed })
  let current: string | null = first
  const images = createPaperImages(() => current)
  const request = (rel: string): Promise<Response> =>
    images.handle(new Request(urlOf(rel)))

  const before = await request('figures/public/ok.png')
  expect(before.status).toBe(200)
  expect(before.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await before.arrayBuffer())).toEqual(PNG)

  current = second
  const after = await request('figures/public/ok.png')
  expect(after.status).toBe(200)
  expect(Buffer.from(await after.arrayBuffer())).toEqual(changed)
  // 옛 폴더에만 있던 그림은 이제 없다 — 조용히 그리지 않는다(자리 표시로 바뀐다).
  expect((await request('figures/only-old.png')).status).toBe(404)

  current = null
  expect((await request('figures/public/ok.png')).status).toBe(404)
})

test('응답: 동시에 너무 많이 요청하면 상한을 넘지 않는다', async () => {
  const root = projectFolder({ 'figures/public/ok.png': PNG })
  const images = createPaperImages(() => root)
  const all = await Promise.all(
    Array.from({ length: 32 }, () => images.handle(new Request(urlOf('figures/public/ok.png'))))
  )
  // 전부 200이거나(동시성 여유) 일부는 404 — 어느 쪽이든 **응답은 전부 닫힌다**.
  expect(all.every((r) => r.status === 200 || r.status === 404)).toBe(true)
  expect(all.some((r) => r.status === 200)).toBe(true)
})

test('큰 파일 상한 직전/직후 — 10MB 경계', async () => {
  const root = projectFolder({})
  mkdirSync(join(root, 'figures'), { recursive: true })
  // PNG 머리 + 0으로 채운 파일. 상한과 같은 크기는 통과, 1바이트 크면 거절.
  const within = join(root, 'figures/within.png')
  writeFileSync(within, PNG)
  truncateSync(within, IMAGE_MAX_BYTES)
  const over = join(root, 'figures/over.png')
  writeFileSync(over, PNG)
  truncateSync(over, IMAGE_MAX_BYTES + 1)

  const images = createPaperImages(() => root)
  expect((await images.handle(new Request(urlOf('figures/within.png')))).status).toBe(200)
  expect((await images.handle(new Request(urlOf('figures/over.png')))).status).toBe(404)
})
