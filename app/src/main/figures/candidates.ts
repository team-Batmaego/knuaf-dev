/** P1.1 §4-2. 승인 판정기의 느슨한 태그 정규식과 독립적인 후보 추출. */
import type { FigureCandidate } from './contract'
import { imageAllowedByRule, parseHttpsUrl, RULE_PAGE_QUERY_ORG, type FigureRule } from './url-rules'
import { creditFor, hasCreditMark } from './verdict'
import { bodyRegion, foreignMarkIn } from './org-check'

const INACTIVE: Record<string, true> = {
  script: true, style: true, template: true, noscript: true,
  textarea: true, title: true, xmp: true, iframe: true
}
const SPACE = /[\t\n\f\r ]/
const BOUNDARY = /[\t\n\f\r />]/
const TAG_LIMIT = 4096

interface Tag {
  name: string
  end: number
  src: string | null
}

/** 속성값 안의 >·<·주석·닫는 태그는 언제나 데이터다(I-05). */
function openingTag(html: string, start: number): Tag | null {
  const limit = Math.min(html.length, start + TAG_LIMIT)
  let at = start + 1
  const nameStart = at
  while (at < limit && !BOUNDARY.test(html[at]!)) at += 1
  const name = html.slice(nameStart, at).toLowerCase()
  let src: string | null = null
  let sawSrc = false
  while (at < limit) {
    while (at < limit && (SPACE.test(html[at]!) || html[at] === '/')) at += 1
    if (html[at] === '>') return { name, end: at + 1, src }
    const attrStart = at
    while (at < limit && !/[=\t\n\f\r />]/.test(html[at]!)) at += 1
    const attr = html.slice(attrStart, at).toLowerCase()
    while (at < limit && SPACE.test(html[at]!)) at += 1
    let value = ''
    if (html[at] === '=') {
      at += 1
      while (at < limit && SPACE.test(html[at]!)) at += 1
      const quote = html[at]
      if (quote === '"' || quote === "'") {
        at += 1
        const valueStart = at
        while (at < limit && html[at] !== quote) at += 1
        if (at === limit) return null
        value = html.slice(valueStart, at)
        at += 1
      } else {
        const valueStart = at
        while (at < limit && !SPACE.test(html[at]!) && html[at] !== '>') at += 1
        value = html.slice(valueStart, at)
      }
    }
    if (attr === 'src' && !sawSrc) {
      sawSrc = true
      src = value
    }
    if (at === attrStart) at += 1
  }
  return null
}

/** 같은 길이 빈칸으로 가려 원문 credit 창의 위치를 보존한다. */
function maskInactive(html: string): string {
  const chunks: string[] = []
  let kept = 0
  let at = 0
  let hiddenStart = -1
  let hiddenName = ''
  let depth = 0
  const hideThrough = (end: number): void => {
    chunks.push(html.slice(kept, hiddenStart), ' '.repeat(end - hiddenStart))
    kept = end
    hiddenStart = -1
    hiddenName = ''
    depth = 0
  }
  while (at < html.length) {
    if (html[at] !== '<') { at += 1; continue }
    if (!depth && html.startsWith('<!--', at)) {
      hiddenStart = at
      const close = html.indexOf('-->', at + 4)
      at = close < 0 ? html.length : close + 3
      hideThrough(at)
      continue
    }
    if (/[A-Za-z]/.test(html[at + 1] ?? '')) {
      const tag = openingTag(html, at)
      if (!tag) {
        if (hiddenStart < 0) hiddenStart = at
        hideThrough(html.length)
        at = html.length
        break
      }
      if (depth) {
        if (tag.name === hiddenName) depth += 1
      } else if (Object.hasOwn(INACTIVE, tag.name)) {
        hiddenStart = at
        hiddenName = tag.name
        depth = 1
      }
      at = tag.end
      continue
    }
    if (html[at + 1] === '/') {
      const match = /^<\/([A-Za-z]+)(?=[\t\n\f\r />])/.exec(html.slice(at, at + 32))
      const close = html.indexOf('>', at + 2)
      if (match && depth && match[1]!.toLowerCase() === hiddenName) {
        depth -= 1
        if (!depth) hideThrough(close < 0 ? html.length : close + 1)
      }
      at = close < 0 ? html.length : close + 1
      continue
    }
    at += 1
  }
  if (hiddenStart >= 0) hideThrough(html.length)
  chunks.push(html.slice(kept))
  return chunks.join('')
}

function candidateUrl(raw: string, base: URL, rule: FigureRule): string | null {
  const value = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').replace(/&amp;/g, '&')
  if (!value || value.length > 2048 || /&(?:#\w+|[A-Za-z][A-Za-z0-9]*);/.test(value)) return null
  const questionAt = value.indexOf('?')
  if ((questionAt >= 0 && /[\[\]]/.test(value.slice(questionAt + 1))) ||
    /[^A-Za-z0-9\-._~/?=&%:@!$'()*+,;\[\]\u0080-\uFFFF]/.test(value) || /%(?![0-9A-Fa-f]{2})/.test(value)) return null
  if (/^(?:data|javascript|blob|about):/i.test(value)) return null
  // 두 해석기가 다르게 접는 표기는 원문에서 닫는다(DISPOSITION impl-1 I-01).
  if (/\?(?:#|$)/.test(value)) return null
  const path = value.split(/[?#]/, 1)[0]!
    .replace(/^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/]*/, '')
  if (path.includes('//')) return null
  if (path.split('/').some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) return null
  // URL은 기본 포트와 유니코드 호스트를 지워 버린다. 지우기 전에 원문 권한부를 검사한다.
  const authority = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?]*)/.exec(value)?.[1]
  if (authority !== undefined && (!authority || /[^\x00-\x7f]|[:@]/.test(authority))) return null
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.port || url.username || url.password) return null
    url.protocol = 'https:'
    // WHATWG는 쿼리의 홑따옴표도 인코딩한다. 계약은 ASCII를 보존하고 유니코드만 인코딩한다.
    const question = value.indexOf('?')
    const query = question >= 0 ? value.slice(question + 1) : url.search.slice(1)
    const encodedQuery = query.replace(/[^\x00-\x7f]+/g, (text) => encodeURI(text))
    const pathname = url.pathname.replace(/\[/g, '%5B').replace(/\]/g, '%5D')
    const result = `https://${url.hostname.toLowerCase()}${pathname}${question >= 0 || url.search ? `?${encodedQuery}` : ''}`
    if (result.length > 2048) return null
    const parsed = parseHttpsUrl(result)
    return parsed.ok && imageAllowedByRule(rule, parsed.url) ? result : null
  } catch {
    return null
  }
}

/** The P1.1 scanner, with original HTML offsets and no URL or rights filtering. */
export function* candidateTags(html: string): Generator<{ start: number; end: number; src: string }> {
  const masked = maskInactive(html)
  for (let at = 0; at < masked.length;) {
    if (masked[at] !== '<' || !/[A-Za-z]/.test(masked[at + 1] ?? '')) { at += 1; continue }
    const start = at
    const tag = openingTag(masked, at)
    if (!tag) break
    at = tag.end
    if (tag.name === 'img' && tag.src) yield { start, end: tag.end, src: tag.src }
  }
}

export function extractCandidates(html: string, pageUrl: URL, pageRule: FigureRule): {
  candidates: FigureCandidate[]
  candidatesTruncated: boolean
} {
  const region = pageRule.rule === RULE_PAGE_QUERY_ORG ? bodyRegion(html, pageRule) : null
  const bodyCredit = region ? hasCreditMark(region.text) || foreignMarkIn(region.text, pageRule) : true
  const candidates: FigureCandidate[] = []
  const seen = new Set<string>()
  for (const tag of candidateTags(html)) {
    const { start } = tag
    const url = candidateUrl(tag.src, pageUrl, pageRule)
    if (!url || seen.has(url)) continue
    if (candidates.length === 30) return { candidates, candidatesTruncated: true }
    seen.add(url)
    const credit = pageRule.rule === RULE_PAGE_QUERY_ORG
      ? (!region || start < region.start || tag.end > region.end || bodyCredit ? 'credit' : 'none')
      : creditFor(html, [{ start, end: tag.end, href: url }], [url])
    candidates.push({ url, credit: credit === 'credit' ? 'credit' : 'none' })
  }
  return { candidates, candidatesTruncated: false }
}
