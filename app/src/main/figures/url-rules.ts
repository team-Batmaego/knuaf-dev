/**
 * figures/url-rules.ts — URL 정규화·허용목록 판정 (설계 §4-1, R4-4)
 *
 * 규칙 하나는 **(호스트, 페이지 경로 정규식, 그림 경로 정규식, 판정 규칙)** 이다. 호스트만 맞으면
 * 통과시키지 않는다 — 같은 호스트의 무관한 페이지에 붙은 그림까지 승인 후보가 되기 때문이다.
 *
 * 여기서 거절하는 것: `http:`, 포트(443 외), 사용자정보(`@`), IP 리터럴 호스트, 허용목록에 없는
 * 호스트. IDN은 WHATWG URL이 punycode(`xn--…`)로 바꾼 뒤 비교하고, 끝 점(`example.com.`)은
 * 떼고 비교한다(shadow-server 이름 붙이기 방지).
 */

export const RULE_LEGACY = 'page_kogl_applies_to_body_images'
export const RULE_PAGE_QUERY = 'page_query_kogl_applies_to_body_images'
export const RULE_PAGE_QUERY_ORG = 'page_query_kogl_org_applies_to_body_images'

export function isQueryRule(rule: string): boolean {
  return rule === RULE_PAGE_QUERY || rule === RULE_PAGE_QUERY_ORG
}

export type QuerySpec =
  | { kind: 'literal'; value: string }
  | { kind: 'digits' }
  | { kind: 'enum'; values: ReadonlySet<string> }

export interface FigureRule {
  id: string
  host: string
  org: string
  /** 페이지 URL **pathname 전체**에 거는 정규식. */
  pagePath: string
  /** 그림 URL **pathname 전체**에 거는 정규식. */
  imagePath: string
  /** 쿼리 조건은 새 rule 값에서만 쓴다. 모르는 값은 판정하지 않는다. */
  rule: string
  pageQuery?: ReadonlyMap<string, QuerySpec>
  evidence?: string
  orgAliases?: readonly string[]
  bodyStart?: string
  bodyEnd?: string
  orgTerms?: readonly string[]
  creditWords?: readonly string[]
  latinOk?: ReadonlySet<string>
  note?: string
}

export type UrlProblem = 'url' | 'scheme' | 'credentials' | 'port' | 'ip' | 'host'

export type ParsedUrl = { ok: true; url: URL; host: string } | { ok: false; reason: UrlProblem }

/** 점으로 나뉜 10진 IPv4 모양인가(`new URL`이 이형 표기를 여기로 정규화한다). */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** https URL 하나를 규칙 비교용으로 정규화한다. */
export function parseHttpsUrl(raw: string): ParsedUrl {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'port' }
  // 대괄호 IPv6 리터럴은 hostname에 `[...]`로 남는다.
  if (url.hostname.startsWith('[') || url.hostname.includes(':')) return { ok: false, reason: 'ip' }
  if (IPV4_RE.test(url.hostname)) return { ok: false, reason: 'ip' }
  return { ok: true, url, host: normalizedHost(url.hostname) }
}

/** 끝 점을 떼고 소문자로. punycode 변환은 `URL`이 이미 했다. */
export function normalizedHost(hostname: string): string {
  let host = hostname.toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

export interface RuleMatch {
  rule: FigureRule
  org: string
}

/** 새 항목 페이지는 URL 해석기로 다듬기 전에 원문 자체를 검사한다(PQ-0). */
export function strictPage(raw: string): { host: string; path: string; query: string } | null {
  if (raw.length > 2048 || !raw.startsWith('https://')) return null
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)) continue
    if (!':/?=&._~-'.includes(char)) return null
  }
  const rest = raw.slice(8)
  if (rest.includes(':')) return null
  const question = rest.indexOf('?')
  if (question < 0 || rest.indexOf('?', question + 1) >= 0) return null
  const before = rest.slice(0, question)
  const slash = before.indexOf('/')
  if (slash < 0) return null
  const path = before.slice(slash)
  if (path.includes('=') || path.includes('&')) return null
  if (path.split('/').some((part) => part === '.' || part === '..')) return null
  return { host: before.slice(0, slash), path, query: rest.slice(question + 1) }
}

/** 풀거나 다듬지 않은 이름=값. 예약 이름도 Map의 자기 키로만 찾는다(PQ-1~5). */
export function matchesQuery(rule: FigureRule, query: string): boolean {
  if (!rule.pageQuery) return false
  const seen = new Set<string>()
  for (const part of query.split('&')) {
    const pair = part.split('=')
    if (pair.length !== 2) return false
    const [name, value] = pair as [string, string]
    if (!name || seen.has(name) || !rule.pageQuery.has(name)) return false
    const spec = rule.pageQuery.get(name)!
    if (spec.kind === 'literal' && value !== spec.value) return false
    if (spec.kind === 'enum' && !spec.values.has(value)) return false
    if (spec.kind === 'digits') {
      if (value.length < 1 || value.length > 20) return false
      for (const char of value) if (char < '0' || char > '9') return false
    }
    seen.add(name)
  }
  return seen.size === rule.pageQuery.size
}

/** 요청 원문으로 규칙집 첫 일치 하나를 고른다. 이후 검사는 이 객체를 그대로 쓴다. */
export function selectPageRule(raw: string, rules: readonly FigureRule[]): FigureRule | null {
  const strict = strictPage(raw)
  let legacy: ParsedUrl | undefined
  for (const rule of rules) {
    if (isQueryRule(rule.rule)) {
      if (strict && strict.host === rule.host && matchesPath(rule.pagePath, strict.path) && matchesQuery(rule, strict.query)) {
        return rule
      }
    } else if (rule.rule === RULE_LEGACY) {
      legacy ??= parseHttpsUrl(raw)
      if (legacy.ok && pageHopAllowed(rule, legacy.url)) return rule
    }
  }
  return null
}

/** 옛 항목의 페이지 홉만 허용. 새 항목은 URL 객체에서 원문을 복원해 승인하지 않는다. */
export function pageHopAllowed(rule: FigureRule, url: URL): boolean {
  return rule.rule === RULE_LEGACY && normalizedHost(url.hostname) === rule.host && matchesPath(rule.pagePath, url.pathname)
}

/** 그림은 페이지에서 고른 항목의 imagePath만 본다. 그림 쿼리는 검사하지 않는다. */
export function imageAllowedByRule(rule: FigureRule, url: URL): boolean {
  return (rule.rule === RULE_LEGACY || isQueryRule(rule.rule)) &&
    normalizedHost(url.hostname) === rule.host && matchesPath(rule.imagePath, url.pathname)
}

/** URL 객체로는 옛 항목만 고른다. 새 항목에는 selectPageRule의 원문 검사가 필수다. */
export function matchPage(url: URL, rules: readonly FigureRule[]): RuleMatch | null {
  for (const rule of rules) {
    if (!pageHopAllowed(rule, url)) continue
    return { rule, org: rule.org }
  }
  return null
}

/** 이 URL이 **그림**으로서 어느 규칙에 걸리는가(`page` 규칙과 같은 항목이어야 승인 후보). */
export function matchImage(url: URL, rules: readonly FigureRule[]): RuleMatch | null {
  for (const rule of rules) {
    if (!imageAllowedByRule(rule, url)) continue
    return { rule, org: rule.org }
  }
  return null
}

/**
 * 규칙의 경로 정규식을 **전체 일치**로 만든다. 사람이 쓴 패턴에 `^…$`가 빠져도 `new RegExp(p).test()`
 * 가 부분 일치로 넓어지지 않게 한다(R-2: 허용목록이 넓어지는 보안 경로).
 */
export function pathPattern(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`)
}

function matchesPath(pattern: string, pathname: string): boolean {
  if (!pattern) return false
  try {
    return pathPattern(pattern).test(pathname)
  } catch {
    // 깨진 정규식은 "아무것도 안 맞음"이다 — 넓히지 않는다.
    return false
  }
}

/** 그림 후보 URL이 허용목록·페이지 규칙 안에 있는가. 승인 후보 여부만 본다(권리 판정은 verdict). */
export function isAllowedImage(
  raw: string,
  pageRule: FigureRule,
  rules: readonly FigureRule[]
): { ok: true; url: URL; rule: FigureRule; org: string } | { ok: false; reason: string } {
  const parsed = parseHttpsUrl(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  if (imageAllowedByRule(pageRule, parsed.url)) {
    return { ok: true, url: parsed.url, rule: pageRule, org: pageRule.org }
  }
  return { ok: false, reason: matchImage(parsed.url, rules) ? 'rule_mismatch' : 'host' }
}
