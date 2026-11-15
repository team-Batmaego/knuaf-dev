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

export interface FigureRule {
  id: string
  host: string
  org: string
  /** 페이지 URL **pathname 전체**에 거는 정규식. */
  pagePath: string
  /** 그림 URL **pathname 전체**에 거는 정규식. */
  imagePath: string
  /** 지금은 `page_kogl_applies_to_body_images` 하나. 모르는 값이면 그 규칙은 쓰지 않는다. */
  rule: string
  evidence?: string
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

/** 이 URL이 **페이지**로서 어느 규칙에 걸리는가. 여러 개면 첫 항목(규칙집 순서). */
export function matchPage(url: URL, rules: readonly FigureRule[]): RuleMatch | null {
  const host = normalizedHost(url.hostname)
  for (const rule of rules) {
    if (rule.rule !== 'page_kogl_applies_to_body_images') continue
    if (normalizedHost(rule.host) !== host) continue
    if (!matchesPath(rule.pagePath, url.pathname)) continue
    return { rule, org: rule.org }
  }
  return null
}

/** 이 URL이 **그림**으로서 어느 규칙에 걸리는가(`page` 규칙과 같은 항목이어야 승인 후보). */
export function matchImage(url: URL, rules: readonly FigureRule[]): RuleMatch | null {
  const host = normalizedHost(url.hostname)
  for (const rule of rules) {
    if (rule.rule !== 'page_kogl_applies_to_body_images') continue
    if (normalizedHost(rule.host) !== host) continue
    if (!matchesPath(rule.imagePath, url.pathname)) continue
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
  pageUrl: URL,
  rules: readonly FigureRule[]
): { ok: true; url: URL; rule: FigureRule; org: string } | { ok: false; reason: string } {
  const parsed = parseHttpsUrl(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const page = matchPage(pageUrl, rules)
  if (!page) return { ok: false, reason: 'page_not_allowlisted' }
  const image = matchImage(parsed.url, rules)
  if (!image) return { ok: false, reason: 'host' }
  if (image.rule.id !== page.rule.id) return { ok: false, reason: 'rule_mismatch' }
  return { ok: true, url: parsed.url, rule: image.rule, org: image.org }
}
