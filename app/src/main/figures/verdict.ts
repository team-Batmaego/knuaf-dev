/**
 * figures/verdict.ts — 공공누리 판독 (설계 §5, R4-4, r5 C-05, CONTRACT §8)
 *
 * 승인은 **아래 전부**를 만족할 때만 나온다. 하나라도 못 맞추면 승인 없음.
 * 1. 그림 **최종** URL이 그 페이지 HTML 안 `<img src>`/`<a href>`로 실제 등장(절대 URL 비교).
 * 2. 페이지의 공공누리 표시가 **하나의 유형**으로만 판독된다(여러 표시가 서로 일치).
 * 3. 그 그림 **태그 자리**에 제3자 표기('제공'·'출처:'·'ⓒ')가 없다 — 공공누리는 제3자 저작물에 안 미친다.
 * 4. 유형이 1·2유형이다. 3·4유형(변경금지)은 PNG 재인코딩(R4-5)과 충돌하므로 r5에서 **ambiguous**다.
 *
 * 그리고 규칙(R4-4)이 페이지 형식·그림 경로 **쌍**에 대해 있어야 승인 후보다. 마크만 있고 규칙이
 * 없으면 ambiguous — "그 사이트는 원래 공공누리"라는 추측을 코드가 하지 않게 하려는 것이다.
 *
 * HTML 파싱은 정규식으로 하되, 판정에 쓰는 값만 뽑는다. 완전한 HTML 파서가 아니라서 못 찾으면
 * "없음"으로 가고, 없으면 승인 조건을 못 채우므로 안전한 쪽(거절·ambiguous)으로 떨어진다.
 *
 * 제3자 표기는 원문 문자열 검색이 아니라 **파싱한 태그 위치**를 기준으로 본다. 원문 `indexOf`는
 * 퍼센트 인코딩·한글 파일 이름에서 못 찾고(`needle < 0`) 그대로 "표기 없음"이 되어 승인 쪽으로
 * 새기 때문이다(review B-2).
 */

export type KoglType = 1 | 2 | 3 | 4

/** HTML에서 찾은 마크 하나. `source`는 증명에 남길 원문 조각. */
export interface KoglMark {
  kind: 'openGrade' | 'openType' | 'openMark' | 'text'
  value: string
  type: KoglType | null
  source: string
}

export interface KoglReading {
  /** 서로 일치하는 판독값. 못 정하면 null. */
  type: KoglType | null
  marks: KoglMark[]
  /** 왜 못 정했는가 — 증명·res 사유. `ok`만 승인 후보다. */
  problem: 'ok' | 'none' | 'conflict'
}

/** 페이지 HTML에서 공공누리 표시를 모은다. */
export function readKogl(html: string): KoglReading {
  const marks: KoglMark[] = []
  const add = (kind: KoglMark['kind'], token: string, type: KoglType | null): void => {
    if (marks.some((mark) => mark.source === token && mark.kind === kind)) return
    marks.push({ kind, value: token, type, source: token })
  }
  const koglType = (digit: string | undefined): KoglType | null => {
    const value = Number(digit)
    return value >= 1 && value <= 4 ? (value as KoglType) : null
  }

  for (const match of html.matchAll(/openGrade\s*_?\s*([1-4])\b/gi)) add('openGrade', match[0], koglType(match[1]))
  for (const match of html.matchAll(/img_opentype\s*_?\s*0?([1-4])\b/gi)) add('openType', match[0], koglType(match[1]))
  for (const match of html.matchAll(/open_mark\s*_?\s*([1-4])\b/gi)) add('openMark', match[0], koglType(match[1]))
  // 사람이 읽는 문구 — '공공누리 제1유형'과 '제1유형' 둘 다 잡되 한 번만 센다.
  for (const match of html.matchAll(/공공누리\s*제?\s*([1-4])\s*유형|제\s*([1-4])\s*유형/gi)) {
    add('text', match[0], koglType(match[1] ?? match[2]))
  }

  if (marks.length === 0) return { type: null, marks, problem: 'none' }
  const types = new Set(marks.map((mark) => mark.type))
  if (types.size !== 1 || types.has(null)) return { type: null, marks, problem: 'conflict' }
  return { type: [...types][0] as KoglType, marks, problem: 'ok' }
}

const CREDIT_RE = /(사진\s*제공|이미지\s*제공|자료\s*제공|출처\s*[:：]|ⓒ|\(c\)\s*\d{4}|copyright)/i

/** 페이지 HTML에서 찾은 그림 하나 — 푼 URL과 그 태그의 원문 자리. */
export interface ImageOccurrence {
  /** `<img`/`<a` 가 시작하는 원문 위치. 제3자 표기 창의 기준점이다. */
  start: number
  /** 태그가 끝나는 위치(닫는 `>` 다음). */
  end: number
  /** `src`/`href`를 페이지 URL 기준 절대 URL로 푼 값. */
  href: string
}

const TAG_RE = /<(img|a)\b[^>]*?\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi

/**
 * 페이지의 `<img src>`·`<a href>` **전부**를 순서대로 푼다. 중복 제거를 하지 않는 이유는 제3자
 * 표기가 태그마다 다를 수 있어서다 — 같은 그림이 두 번 나오면 두 자리를 다 봐야 한다(B-2).
 */
export function findImageOccurrences(html: string, pageUrl: URL): ImageOccurrence[] {
  const found: ImageOccurrence[] = []
  for (const match of html.matchAll(TAG_RE)) {
    const raw = match[4] ?? match[5] ?? match[6] ?? ''
    const href = resolveUrl(raw, pageUrl)
    if (!href) continue
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, href })
  }
  return found
}

function resolveUrl(raw: string, base: URL): string | null {
  const text = raw.trim()
  if (!text || text.startsWith('data:') || text.startsWith('javascript:')) return null
  try {
    return new URL(text, base).href
  } catch {
    return null
  }
}

/**
 * URL 둘을 같은 자원으로 볼 수 있는가. 조각(#)만 다른 것은 같고, CONTRACT §8에 따라 **http: 표기는
 * https: 와 같게 본다** — 호스트·경로·쿼리가 같고 양쪽 포트가 기본일 때만. 받기는 언제나 https다.
 */
export function sameResource(a: string, b: string): boolean {
  const left = urlOf(a)
  const right = urlOf(b)
  if (!left || !right) return false
  if (left.href === right.href) return true
  return webEquivalent(left, right) || webEquivalent(right, left)
}

function urlOf(value: string): URL | null {
  try {
    const url = new URL(value)
    url.hash = ''
    return url
  } catch {
    return null
  }
}

/** http 표기 하나가 https 표기 하나와 같은 자원인가(§8). 포트가 적혀 있으면 기본이어도 안 본다. */
function webEquivalent(plain: URL, secure: URL): boolean {
  return (
    plain.protocol === 'http:' &&
    secure.protocol === 'https:' &&
    plain.port === '' &&
    secure.port === '' &&
    plain.hostname === secure.hostname &&
    plain.pathname === secure.pathname &&
    plain.search === secure.search
  )
}

/** 그림이 페이지에 실제로 걸려 있는가. 후보 중 하나라도 태그로 등장하면 참. */
export function appearsOnPage(occurrences: readonly ImageOccurrence[], candidates: readonly string[]): boolean {
  return occurrences.some((occurrence) => candidates.some((candidate) => sameResource(occurrence.href, candidate)))
}

export type CreditReading = 'none' | 'credit' | 'unknown'

/**
 * 그림 태그 자리의 제3자 표기. 태그 앞뒤 500자만 본다 — 페이지 전체 'ⓒ'는 푸터 저작권일 뿐이다.
 *
 * 같은 그림이 여러 태그로 나오면 **하나라도** 표기가 있으면 `credit`이다(승인 쪽으로 새지 않게).
 * 후보에 맞는 태그가 하나도 없으면 `unknown` — 기준점을 못 정했으므로 판정은 ambiguous로 간다.
 */
export function creditFor(
  html: string,
  occurrences: readonly ImageOccurrence[],
  candidates: readonly string[]
): CreditReading {
  const anchors = occurrences.filter((occurrence) =>
    candidates.some((candidate) => sameResource(occurrence.href, candidate))
  )
  if (anchors.length === 0) return 'unknown'
  const hit = anchors.some((anchor) =>
    CREDIT_RE.test(html.slice(Math.max(0, anchor.start - 500), Math.min(html.length, anchor.end + 500)))
  )
  return hit ? 'credit' : 'none'
}

export interface VerdictInput {
  /** 규칙(R4-4)이 이 그림을 승인 후보로 이미 인정했는가 + 그 규칙 id. */
  rule: { ok: true; ruleId: string; org: string } | { ok: false; reason: string }
  /** 페이지 HTML 안에 그림 URL이 실재하는가. */
  present: boolean
  /** 그림 태그 자리의 제3자 표기. `unknown`은 기준 태그를 못 정했다는 뜻 — 승인하지 않는다. */
  thirdPartyCredit: CreditReading
  kogl: KoglReading
  /** 리다이렉트 사슬에 규칙 밖 호스트가 있었는가(받기 단계에서 이미 거절되지만 판정에도 남긴다). */
  finalUrlAllowed: boolean
}

export interface Verdict {
  verdict: 'approved' | 'ambiguous' | 'rejected'
  reason: string
  ruleId: string | null
  org: string | null
  kogl: KoglType | null
  marks: string[]
}

export function decide(input: VerdictInput): Verdict {
  const base = {
    ruleId: input.rule.ok ? input.rule.ruleId : null,
    org: input.rule.ok ? input.rule.org : null,
    kogl: input.kogl.type,
    marks: input.kogl.marks.map((mark) => mark.source)
  }
  if (!input.rule.ok) {
    // 규칙 없음 = 승인 후보조차 아님. 마크가 있는 페이지만 ambiguous로 남겨 학생에게 후보로 보인다.
    const reason = input.kogl.type ? `rule_missing:${input.rule.reason}` : input.rule.reason
    return { ...base, verdict: 'rejected', reason }
  }
  if (!input.finalUrlAllowed) return { ...base, verdict: 'rejected', reason: 'final_url_outside_rules' }
  if (!input.present) return { ...base, verdict: 'rejected', reason: 'not_on_page' }
  // 기준 태그를 못 정했으면 표기 유무를 모른다 — 모르는 것을 "없음"으로 읽지 않는다(B-2).
  if (input.thirdPartyCredit === 'unknown') return { ...base, verdict: 'ambiguous', reason: 'third_party_unknown' }
  if (input.thirdPartyCredit === 'credit') return { ...base, verdict: 'ambiguous', reason: 'third_party_credit' }
  if (input.kogl.problem !== 'ok' || input.kogl.type === null) {
    return { ...base, verdict: 'ambiguous', reason: `kogl_${input.kogl.problem}` }
  }
  if (input.kogl.type === 3 || input.kogl.type === 4) {
    // r5 C-05: 변경금지 유형은 재인코딩과 충돌 → 미삽입·후보로만.
    return { ...base, verdict: 'ambiguous', reason: `kogl_type_${input.kogl.type}_no_derivative` }
  }
  return { ...base, verdict: 'approved', reason: `kogl_type_${input.kogl.type}` }
}
