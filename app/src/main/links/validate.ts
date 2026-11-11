// link (v0.6.4 ⑤) — 대화 속 http(s) 주소를 밖으로 열기 전에 **main이 다시 보는** 규칙.
//
// 렌더러 검사만 믿지 않는다(발주 ③). 이 파일은 Electron을 모르는 순수 함수라 node 시험이 그대로
// 부른다 — `new URL()`로 파싱 → 프로토콜 `http:`/`https:`만 → 사용자 정보(`user:pass@`) 없음 →
// 길이 상한 → 파싱 실패 거부. 하나라도 어긋나면 **아무것도 열지 않는다**.
//
// `http(s)` 글자 검사(`/^https?:\/\//i`)로 대신하지 않는 이유: `https://user:pw@host`·`https://a@b`
// 처럼 눈으로는 http로 보이지만 다른 곳을 여는 주소가 통과한다. 판정은 파서 결과로만 한다.

import type { LinkRejectReason } from '../../shared/link'

/** 주소 길이 상한. 브라우저도 이 근처에서 막는다 — 넘으면 열지 않고 거부한다. */
export const LINK_MAX_LENGTH = 2048

export type { LinkRejectReason }

export type LinkCheck = { ok: true; url: string } | { ok: false; reason: LinkRejectReason }

/**
 * `%2e` 로 적은 점 조각이 경로에 있나 — `/%2e%2e/x` 는 파서가 `..` 로 풀어 **다른 자원**을 연다.
 * 화면에 보인 주소와 실제 요청의 경로가 달라지므로 받지 않는다(Roh ⑤ [중요]: 보인 그대로 연다).
 * 나머지 이스케이프(`%26`·`%3D`·`%23`·`%2F`·`%20` 등)는 `href` 에 **바이트 그대로** 남는다.
 */
function hasEscapedDotSegment(text: string): boolean {
  const afterScheme = text.slice(text.indexOf('://') + 3)
  const slash = afterScheme.search(/[/?#]/)
  if (slash < 0) return false
  const path = afterScheme.slice(slash).split(/[?#]/)[0]
  if (!/%2e/i.test(path)) return false
  return /(?:^|\/)\.\.?(?:\/|$)/.test(path.replace(/%2e/gi, '.'))
}

/**
 * 렌더러가 보낸 값 하나를 검사한다. 통과하면 **파서가 정규화한** `href`를 돌려준다
 * (`https://example.com` → `https://example.com/`). 실패는 예외가 아니라 이유다.
 *
 * 정규화는 **뜻이 그대로인 것만** 한다(스킴·호스트 소문자, 기본 포트 제거, 앞뒤 공백 제거).
 * 뜻이 달라지는 것(`%2e` 점 조각)은 정규화하지 않고 거부한다 — 아래 `hasEscapedDotSegment`.
 * `link.target` 을 렌더러가 이미 디코딩해 보냈다면 그건 호출자 쪽 결함이다(여기서 되돌리지 않는다).
 */
export function checkExternalLink(input: unknown): LinkCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' }
  const text = input.trim()
  if (!text) return { ok: false, reason: 'empty' }
  // 파싱 전에 길이부터 — 긴 쓰레기 문자열에 URL 파서를 돌리지 않는다.
  if (text.length > LINK_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  let url: URL
  try { url = new URL(text) } catch { return { ok: false, reason: 'malformed' } }
  // `javascript:`·`file:`·`data:`·`mailto:` 등은 전부 여기서 걸린다(프로토콜은 소문자로 정규화된다).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  // `https://evil.example@good.example` 은 good.example 을 열지만, 사용자에게 보인 글자와
  // 실제 목적지가 다르다 — 그런 주소는 열지 않는다.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (!url.hostname) return { ok: false, reason: 'malformed' }
  if (hasEscapedDotSegment(text)) return { ok: false, reason: 'malformed' }
  return { ok: true, url: url.href }
}
