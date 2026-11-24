import type * as urlTypes from './url-rules'
import type * as rulesTypes from './rules'
/**
 * figures/url-rules.test.ts — 허용목록 정규화·판정 (설계 R4-4, C-02).
 *
 * 핵심은 "호스트만 맞으면 통과"를 막는 것: 페이지 규칙과 그림 규칙이 **같은 항목**에 걸려야 하고,
 * 접미사로 위장한 호스트(`rda.go.kr.evil.example`)·사용자정보·비443 포트·IP 리터럴은 전부 거절.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

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

// 확장자 없는 내부 import에 등록한 해석 훅을 적용하려고 훅 등록 뒤 모듈을 읽는다.
const url = (await import(new URL('./url-rules.ts', import.meta.url).href)) as typeof urlTypes
const rulesMod = (await import(new URL('./rules.ts', import.meta.url).href)) as typeof rulesTypes
const vectors = JSON.parse((await readFile(new URL('./fixtures/pagequery-vectors.json', import.meta.url), 'utf8'))
  .replace(/\{\{(.)\*(\d+)\}\}/g, (_match, char: string, count: string) => char.repeat(Number(count)))) as {
  rules: unknown
  page: [string, string | null, string][]
  image: [string, string, boolean, string][]
}

const rule = (over: Partial<urlTypes.FigureRule> = {}): urlTypes.FigureRule => ({
  id: 'rda',
  host: 'www.rda.go.kr',
  org: '농촌진흥청',
  pagePath: '^/home/.*',
  imagePath: '^/upload/.*',
  rule: 'page_kogl_applies_to_body_images',
  ...over
})

const RULES: readonly urlTypes.FigureRule[] = [rule()]

describe('parseHttpsUrl', () => {
  it('https만 받는다', () => {
    assert.deepEqual(url.parseHttpsUrl('http://www.rda.go.kr/home/1'), { ok: false, reason: 'scheme' })
  })

  it('사용자정보를 거절한다', () => {
    assert.deepEqual(url.parseHttpsUrl('https://user:pw@www.rda.go.kr/home/1'), { ok: false, reason: 'credentials' })
  })

  it('443 외 포트를 거절한다', () => {
    assert.deepEqual(url.parseHttpsUrl('https://www.rda.go.kr:8443/home/1'), { ok: false, reason: 'port' })
    assert.equal(url.parseHttpsUrl('https://www.rda.go.kr:443/home/1').ok, true)
  })

  it('IP 리터럴을 거절한다', () => {
    assert.deepEqual(url.parseHttpsUrl('https://127.0.0.1/home/1'), { ok: false, reason: 'ip' })
    assert.deepEqual(url.parseHttpsUrl('https://[::1]/home/1'), { ok: false, reason: 'ip' })
    // WHATWG URL은 이형 표기를 점 표기로 정규화한다.
    assert.deepEqual(url.parseHttpsUrl('https://0x7f.1/home/1'), { ok: false, reason: 'ip' })
  })

  it('IDN은 punycode로 바꿔 비교한다', () => {
    const parsed = url.parseHttpsUrl('https://한국.kr/home/1')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.host, 'xn--3e0b707e.kr')
  })

  it('끝 점은 떼고 소문자로 맞춘다', () => {
    const parsed = url.parseHttpsUrl('https://WWW.RDA.GO.KR./home/1')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.host, 'www.rda.go.kr')
  })
})

describe('matchPage / matchImage', () => {
  it('페이지와 그림이 같은 규칙이면 통과', () => {
    const pageRule = url.selectPageRule('https://www.rda.go.kr/home/sub/1.do', RULES)
    assert.ok(pageRule)
    const allowed = url.isAllowedImage('https://www.rda.go.kr/upload/a.jpg', pageRule, RULES)
    assert.equal(allowed.ok, true)
    if (!allowed.ok) return
    assert.equal(allowed.rule.id, 'rda')
    assert.equal(allowed.org, '농촌진흥청')
  })

  it('접미사로 위장한 호스트는 안 걸린다', () => {
    const page = new URL('https://www.rda.go.kr.evil.example/home/1')
    assert.equal(url.matchPage(page, RULES), null)
  })

  it('페이지가 허용목록 밖이면 그림도 승인 후보가 아니다', () => {
    assert.equal(url.selectPageRule('https://news.example/home/1', RULES), null)
  })

  it('그림 경로가 페이지 규칙의 그림 경로가 아니면 host', () => {
    const pageRule = url.selectPageRule('https://www.rda.go.kr/home/1', RULES)
    assert.ok(pageRule)
    assert.deepEqual(url.isAllowedImage('https://www.rda.go.kr/other/a.jpg', pageRule, RULES), { ok: false, reason: 'host' })
  })

  it('페이지와 그림이 다른 규칙 항목에 걸리면 rule_mismatch', () => {
    // 페이지는 `rda`(/home/), 그림은 `rda-board`(/board-img/)에 걸린다 — 호스트는 같다.
    const rules = [rule({ id: 'rda-board', pagePath: '^/board/.*', imagePath: '^/board-img/.*' }), rule()]
    const pageRule = url.selectPageRule('https://www.rda.go.kr/home/1', rules)
    assert.ok(pageRule)
    assert.deepEqual(url.isAllowedImage('https://www.rda.go.kr/board-img/a.jpg', pageRule, rules), {
      ok: false,
      reason: 'rule_mismatch'
    })
  })

  it('깨진 정규식 항목은 아무것도 안 맞는다', () => {
    const broken = [rule({ pagePath: '([' })]
    assert.equal(url.matchPage(new URL('https://www.rda.go.kr/home/1'), broken), null)
  })

  it('모르는 rule 값은 판정에 쓰지 않는다', () => {
    const unknown = [rule({ rule: 'some_future_rule' })]
    assert.equal(url.matchPage(new URL('https://www.rda.go.kr/home/1'), unknown), null)
  })
})

/**
 * 계약 §7은 `pagePath`·`imagePath`를 pathname **전체** 정규식으로 정했다. 사람이 쓴 패턴에 `^…$`가
 * 빠져도 `new RegExp(p).test()`의 부분 일치로 허용목록이 넓어지면 안 된다(R-2).
 */
describe('pathPattern — 전체 일치 강제', () => {
  it('앵커 없는 패턴도 부분 일치하지 않는다', () => {
    assert.equal(url.pathPattern('a/b').test('/xa/by'), false)
    assert.equal(url.pathPattern('a/b').test('a/b'), true)
  })

  it('앵커 없는 규칙 패턴은 pathname 전체가 맞아야 통과한다', () => {
    const loose = [rule({ id: 'loose', pagePath: '/home' })]
    assert.equal(url.matchPage(new URL('https://www.rda.go.kr/home'), loose)?.rule.id, 'loose')
    assert.equal(url.matchPage(new URL('https://www.rda.go.kr/home/sub/1.do'), loose), null)

    const looseImage = [rule({ id: 'loose-img', imagePath: '/img' })]
    assert.equal(url.matchImage(new URL('https://www.rda.go.kr/ps/img/a.jpg'), looseImage), null)
    assert.equal(url.matchImage(new URL('https://www.rda.go.kr/img'), looseImage)?.rule.id, 'loose-img')
  })
})

describe('pageQuery — 공용 벡터', () => {
  const rules = rulesMod.parseRules(JSON.stringify(vectors.rules))
  for (const [raw, expected, memo] of vectors.page) {
    it(`page: ${memo}`, () => {
      const selected = url.selectPageRule(raw, rules)
      assert.equal(selected?.id ?? null, expected)
      if (selected?.rule === url.RULE_PAGE_QUERY) {
        assert.equal(new URL(raw).href, raw)
        assert.equal(url.matchPage(new URL(raw), rules), null)
      }
    })
  }
  for (const [page, image, expected, memo] of vectors.image) {
    it(`image: ${memo}`, () => {
      const selected = url.selectPageRule(page, rules)
      assert.ok(selected)
      const result = url.isAllowedImage(image, selected, rules)
      assert.equal(result.ok, expected)
      if (result.ok) assert.equal(result.rule, selected)
      else {
        const parsed = url.parseHttpsUrl(image)
        assert.ok(parsed.ok)
        assert.equal(result.reason, url.matchImage(parsed.url, rules) ? 'rule_mismatch' : 'host')
      }
    })
  }
})

describe('RDA — all pageQuery page/image vectors with third rule kind', () => {
  const raw = structuredClone(vectors.rules) as { rules: Record<string, unknown>[] }
  Object.assign(raw, { orgTerms: ['협회'], creditWords: ['제공'], latinOk: [] })
  for (const item of raw.rules) {
    if (item.rule !== url.RULE_PAGE_QUERY) continue
    Object.assign(item, { rule: url.RULE_PAGE_QUERY_ORG, org: '시험기관', orgAliases: ['시험기관'],
      bodyStart: '<div id="body">', bodyEnd: '<div id="mark">' })
  }
  const rules = rulesMod.parseRules(JSON.stringify(raw))
  for (const [page, expected, memo] of vectors.page) {
    it(`page: ${memo}`, () => assert.equal(url.selectPageRule(page, rules)?.id ?? null, expected))
  }
  for (const [page, image, expected, memo] of vectors.image) {
    it(`image: ${memo}`, () => {
      const selected = url.selectPageRule(page, rules)
      assert.ok(selected)
      assert.equal(url.isAllowedImage(image, selected, rules).ok, expected)
    })
  }
})
