// paper-images — 종이 칸 그림 요청 하나를 **받아들일지** 판정하는 순수 부분.
//
// 왜 main이 다시 보는가: 마크다운 규칙(`renderer/src/markdown.ts`)이 만든 주소만 믿지 않는다.
// 렌더러가 뚫리거나 주소를 손으로 만들면 `knuaf-img://` 하나로 폴더 밖 파일을 읽게 된다.
// 여기서는 **우리가 만들 수 있는 모양인지**를 문자열로 먼저 자르고, 실제 폴더 안 판정은
// `index.ts`가 realpath + 파일 신원으로 한다(`main/file-identity.ts` 주석: 문자열 정규화 비교 금지).
//
// 발주 ③ ②의 거절 목록이 이 파일에 모여 있다: 절대 경로·`..`·`%2e%2e`·역슬래시·UNC·드라이브·
// 다른 스킴·너무 긴 주소. 파일 시스템은 건드리지 않아 node 시험이 그대로 부른다.
import {
  IMAGE_MIME,
  IMAGE_SRC_MAX_LENGTH,
  IMAGE_SRC_PREFIX,
  decodeImageSrc,
  imageMimeOfExtension,
  relativeImagePath
} from '../../shared/paper-image'

/** 거절 이유 — 화면에는 나가지 않는다(실패는 alt 글자). 로그·시험이 원인을 가른다. */
export type ImageRejectReason =
  | 'empty'
  | 'too_long'
  | 'scheme'
  | 'malformed'
  | 'format'
  | 'outside'
  | 'not_file'
  | 'too_large'
  | 'busy'
  | 'read'

export type ImageCheck = { ok: true; rel: string } | { ok: false; reason: ImageRejectReason }

/**
 * `encodeURIComponent`가 낼 수 있는 문자만 — 영숫자와 `-_.!~*'()` 그리고 `%XX`.
 * `/`는 반드시 `%2F`로 적혀야 한다: 우리가 만드는 주소는 경로가 **한 조각**이어야 하고,
 * 한 조각이면 URL 파서가 `..`를 접을 자리가 없다.
 */
const ENCODED_SEGMENT = /^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})+$/

/**
 * 주소 하나를 판정한다. 통과하면 논문 폴더 뿌리 기준 **상대 경로**를 돌려준다.
 *
 * `%2e`(점)는 어떤 경우에도 우리가 만들지 않는다(`encodeURIComponent('.') === '.'`). 받은 주소에
 * 있으면 파서가 `..`를 풀어 경로를 바꾼 흔적이므로 거절한다 — `links/validate.ts`의
 * `hasEscapedDotSegment`와 같은 발상(파서가 지운 이스케이프를 되짚는다)이다. 대문자 `%2E`는
 * URL 파서가 접지 않는 것을 실측했지만, 우리 규칙은 대소문자 모두 거절해 판정을 하나로 둔다.
 */
export function checkImageRequest(src: unknown): ImageCheck {
  if (typeof src !== 'string' || !src) return { ok: false, reason: 'empty' }
  // 인코딩 후 길이는 원문의 최대 3배다.
  if (src.length > IMAGE_SRC_PREFIX.length + IMAGE_SRC_MAX_LENGTH * 3) return { ok: false, reason: 'too_long' }
  if (!src.startsWith(IMAGE_SRC_PREFIX)) return { ok: false, reason: 'scheme' }
  const encoded = src.slice(IMAGE_SRC_PREFIX.length)
  // URL 파서가 접은 흔적(`..`)·구분자(`/`·`\`)·쿼리·조각·공백은 여기서 전부 걸린다.
  if (!ENCODED_SEGMENT.test(encoded)) return { ok: false, reason: 'malformed' }
  if (/%2e/i.test(encoded)) return { ok: false, reason: 'malformed' }
  const rel = decodeImageSrc(src)
  if (!rel) return { ok: false, reason: 'malformed' }
  // 디코드 뒤에도 한 번 더 — `%2F`로 적힌 `/`가 조각을 만들고 그 조각이 `..`일 수 있다.
  if (relativeImagePath(rel) !== rel) return { ok: false, reason: 'malformed' }
  if (imageMimeOfExtension(rel) === null) return { ok: false, reason: 'format' }
  return { ok: true, rel }
}

/** 파일 머리 바이트로 **진짜 그 형식인지** 본다. 확장자만 png인 텍스트·스크립트를 거른다(발주 ③ ③). */
export function imageMagicMatches(path: string, head: Buffer): boolean {
  const mime = imageMimeOfExtension(path)
  if (!mime) return false
  const at = (i: number): number => (i < head.length ? head[i] : -1)
  const ascii = (from: number, text: string): boolean =>
    head.length >= from + text.length && head.toString('latin1', from, from + text.length) === text
  switch (mime) {
    case IMAGE_MIME.png:
      return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case IMAGE_MIME.jpg:
      // SOI + 첫 마커. `FF D8 FF`만으로 충분히 좁다(그 뒤가 0xFF인 JPEG는 없음).
      return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff
    case IMAGE_MIME.gif:
      return ascii(0, 'GIF87a') || ascii(0, 'GIF89a')
    case IMAGE_MIME.webp:
      // `RIFF` + 크기(4바이트) + `WEBP` — 크기 자리는 무엇이든 좋다.
      return ascii(0, 'RIFF') && ascii(8, 'WEBP') && head.length >= 12
    case IMAGE_MIME.bmp:
      return ascii(0, 'BM') && head.length >= 14
    default:
      return false
  }
}
