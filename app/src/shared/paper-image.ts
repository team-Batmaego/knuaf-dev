// paper-image (v0.6.4 사진 갈래) — 종이 칸 그림의 **계약**: 렌더러(마크다운 규칙)와 main(스킴 처리)이
// 같은 규칙으로 "논문 폴더 안 상대 경로인가"를 판정한다. 값만 있고 파일 시스템은 모른다(웹·노드 공용).
//
// 왜 전용 스킴인가: `renderMarkdown`은 동기이고 결과는 `dangerouslySetInnerHTML`로 그대로 들어간다.
// 비동기로 바이트를 받아 `data:`로 바꾸는 길은 그 동기 계약을 깨거나 `PaperPane`을 고쳐야 한다
// (발주 ③: `PaperPane.tsx` 수정 금지). 그래서 마크다운 규칙은 **주소만** 만들고
// (`knuaf-img://paper/<인코딩한 상대 경로>`), 실제 읽기는 main이 한다.
//
// 경로 기준은 **논문 폴더 뿌리**다(발주 추가, 형님 ts 1794462849) — 규칙집 워드 만들기
// (`build_docx.py:239~240`)가 `(base / 경로).resolve()`로 뿌리 기준으로 읽으므로, 미리보기가 다른
// 기준을 쓰면 미리보기와 최종 워드가 달라진다.

/** 전용 스킴 이름. main이 `protocol.registerSchemesAsPrivileged`·`protocol.handle`에 쓴다. */
export const IMAGE_SCHEME = 'knuaf-img'

/** 렌더러가 만드는 주소의 접두어. 호스트 자리(`paper`)는 고정값이라 경로와 섞이지 않는다. */
export const IMAGE_SRC_PREFIX = `${IMAGE_SCHEME}://paper/`

/** 그림 파일 하나의 크기 상한 — 넘으면 그리지 않고 alt 글자만 남긴다(발주 ③). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** 그림 원문 주소 길이 상한. 이보다 긴 것은 경로로 보지 않는다. */
export const IMAGE_SRC_MAX_LENGTH = 1024

/** 못 찾은 그림 자리 표시 문구(발주 추가, 형님 ts 1794469330). 뒤에 경로가 붙는다. */
export const IMAGE_MISS_TEXT = '그림을 찾지 못했어요 · '

/**
 * 그릴 수 있는 형식 — `DocxHtmlView.tsx:13`(워드 미리보기)과 **같은 목록**이다.
 * svg는 넣지 않는다: 스크립트가 든 XML이라 그림이 아니라 코드다.
 */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

/** 확장자(소문자) → MIME. 목록 밖이면 null. */
export function imageMimeOfExtension(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const ext = path.slice(dot + 1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, ext) ? IMAGE_MIME[ext] : null
}

/**
 * 상대 경로 하나를 **논문 폴더 안 경로**로 받아들일 수 있나. 통과하면 그대로 돌려준다.
 *
 * 거절(발주 ③ ②): 절대 경로(`/…`·`\\host`·`C:…`)·윈도 구분자·`.`/`..` 조각·빈 조각·제어 문자.
 * 콜론(`C:/x.png`)도 거절한다 — POSIX에서는 폴더 이름에 설 수 있지만 윈도에서는 `resolve(root, 'C:/x.png')`가
 * **드라이브 절대 경로**가 되어, 같은 문자열이 OS마다 다른 뜻이 된다. 두 뜻이 갈리는 경로는 받지 않는다.
 * 유니코드/대소문자 정규화 비교는 **하지 않는다** — 여기서는 문자열 모양만 보고, 실제로 폴더 안인지는
 * main이 realpath + 파일 신원으로 따로 판정한다(`main/file-identity.ts` 주석).
 */
export function relativeImagePath(rel: string): string | null {
  if (!rel || rel.length > IMAGE_SRC_MAX_LENGTH) return null
  // 윈도 구분자·UNC(`\\host\share`)·드라이브(`C:\x`)는 상대 경로가 아니다.
  if (rel.includes('\\')) return null
  // 콜론은 드라이브 문자(`C:`)나 대체 데이터 스트림(`x.png:stream`)의 자리다.
  if (rel.includes(':')) return null
  // 절대 경로와 `//host` — 둘 다 `/`로 시작한다.
  if (rel.startsWith('/')) return null
  // NUL·개행 같은 제어 문자는 경로에 설 자리가 없다(정규화 꼼수 방어).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rel)) return null
  // `.`·`..` 조각은 폴더 밖을 가리킬 수 있다(`%2e%2e`가 디코드된 뒤에도 같은 검사).
  const segments = rel.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  return rel
}

/**
 * 마크다운-it이 정규화해 준 그림 주소 → 논문 폴더 상대 경로. 상대 경로가 아니면 null.
 *
 * markdown-it은 `figures/사진 1.png`를 `%EC%82%AC…%201.png`로 인코딩해 준다(`normalizeLink`).
 * 그래서 한 번 디코드해 원문 경로를 되돌린 뒤 판정한다. 스킴이 붙은 주소는 디코드 전에 거절한다 —
 * `data:`·`file:`·`https:`·`C:`가 여기서 걸린다(원격 그림은 지금처럼 alt 글자만, 발주 ③ ①).
 */
export function localImagePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text.length > IMAGE_SRC_MAX_LENGTH) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null
  let rel: string
  try {
    rel = decodeURIComponent(text)
  } catch {
    // `%zz` 같은 깨진 이스케이프 — 경로로 해석하지 않는다.
    return null
  }
  return relativeImagePath(rel)
}

/** 상대 경로 → `<img src>`용 주소. `encodeURIComponent`가 `/`를 `%2F`로 만들어 경로가 한 조각으로 남는다. */
export function encodeImageSrc(rel: string): string {
  return IMAGE_SRC_PREFIX + encodeURIComponent(rel)
}

/** 우리가 만든 주소 → 상대 경로(왕복). 우리 주소가 아니면 null. */
export function decodeImageSrc(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith(IMAGE_SRC_PREFIX)) return null
  let rel: string
  try {
    rel = decodeURIComponent(src.slice(IMAGE_SRC_PREFIX.length))
  } catch {
    return null
  }
  return relativeImagePath(rel)
}

/**
 * 실패한 그림 하나를 무슨 글자로 바꿀지 — `null`이면 우리 그림이 아니므로 건드리지 않는다.
 *
 * 우리 주소인데 경로가 깨졌으면 파일 이름을 말할 수 없으니 alt 글자만 남긴다.
 * `main.tsx`의 문서 리스너가 이 값을 그대로 `<span class="paper-img-miss">`에 넣는다.
 */
export function imageMissText(src: string, alt: string): string | null {
  if (!src.startsWith(IMAGE_SRC_PREFIX)) return null
  const rel = decodeImageSrc(src)
  return rel ? IMAGE_MISS_TEXT + rel : alt
}
