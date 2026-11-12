/**
 * figures/verdict.test.ts — 공공누리 판독·승인 조건 (설계 §5, R4-4, r5 C-05, CONTRACT §8).
 *
 * 이 파일이 잠그는 경계: ① 표시가 하나로 모여야 한다(여럿·불일치·없음 = ambiguous) ② 3·4유형은
 * r5에서 ambiguous(변경금지 ↔ PNG 재인코딩 충돌) ③ 제3자 표기는 **파싱한 그림 태그 자리**에서 본다
 * (B-2: 원문 문자열 검색은 퍼센트 인코딩·한글 이름을 놓친다) ④ http: 표기는 §8에 따라 https:와 같은
 * 자원으로 본다 ⑤ 기준 태그를 못 정하면 `unknown` → ambiguous ⑥ 규칙이 없으면 마크가 있어도 승인 없음.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
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

const verdict = (await import(new URL('./verdict.ts', import.meta.url).href)) as typeof import('./verdict')

const IMAGE = 'https://www.nongsaro.go.kr/ps/img/curation/leaf.jpg'
const PAGE = new URL('https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps')

/** 실제 기관 페이지 모양을 줄인 것 — 마크는 `marks`만 바꾼다. */
const pageHtml = (marks: string, extra = ''): string =>
  `<html><body><div class="curation">${marks}</div>` +
  `<p>본문</p><img src="/ps/img/curation/leaf.jpg" alt="들깨"><p>${extra}</p></body></html>`

const approved = {
  rule: { ok: true as const, ruleId: 'nongsaro-curation', org: '농촌진흥청 국립원예특작과학원' },
  present: true,
  thirdPartyCredit: 'none' as const,
  finalUrlAllowed: true
}

describe('readKogl', () => {
  it('openGrade 하나면 그 유형', () => {
    const reading = verdict.readKogl('<span class="openGrade_1"></span>')
    assert.equal(reading.type, 1)
    assert.equal(reading.problem, 'ok')
    assert.equal(reading.marks.length, 1)
  })

  it('여러 표시가 같은 유형이면 ok', () => {
    const reading = verdict.readKogl(
      pageHtml('<span class="openGrade_2"></span><img class="img_opentype02"><p>공공누리 제2유형</p>')
    )
    assert.equal(reading.type, 2)
    assert.equal(reading.problem, 'ok')
    assert.equal(reading.marks.length, 3)
  })

  it('표시가 없으면 none', () => {
    assert.deepEqual(verdict.readKogl(pageHtml('')), { type: null, marks: [], problem: 'none' })
  })

  it('서로 다른 유형이 있으면 conflict', () => {
    const reading = verdict.readKogl('<span class="openGrade_1"></span><span class="open_mark2"></span>')
    assert.equal(reading.type, null)
    assert.equal(reading.problem, 'conflict')
  })

  it('같은 표시 문자열은 한 번만 센다', () => {
    const reading = verdict.readKogl('<img class="img_opentype01"><img class="img_opentype01">')
    assert.equal(reading.marks.length, 1)
    assert.equal(reading.problem, 'ok')
  })

  it('범위 밖 숫자는 유형으로 안 읽는다', () => {
    assert.equal(verdict.readKogl('<span class="openGrade_7"></span>').problem, 'none')
  })
})

describe('findImageOccurrences', () => {
  it('상대 경로를 절대 URL로 풀고 태그 자리를 남긴다', () => {
    const html = '<img src="/ps/img/curation/leaf.jpg"><a href="other.pdf">첨부</a>'
    const found = verdict.findImageOccurrences(html, PAGE)
    assert.deepEqual(
      found.map((item) => item.href),
      ['https://www.nongsaro.go.kr/ps/img/curation/leaf.jpg', 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/other.pdf']
    )
    // 자리는 원문 그대로 가리킨다 — 제3자 표기 창의 기준점.
    assert.equal(html.slice(found[0]?.start, found[0]?.end), '<img src="/ps/img/curation/leaf.jpg">')
  })

  it('data:·javascript:는 거절', () => {
    assert.deepEqual(
      verdict.findImageOccurrences('<img src="data:image/png;base64,AA"><a href="javascript:void(0)">x</a>', PAGE),
      []
    )
  })

  it('같은 그림이 두 번 나와도 두 자리를 다 남긴다', () => {
    const html = `<img src="${IMAGE}"><p>본문</p><img src="${IMAGE}">`
    assert.equal(verdict.findImageOccurrences(html, PAGE).length, 2)
  })
})

describe('sameResource / appearsOnPage', () => {
  it('조각(#)만 다른 것은 같은 자원', () => {
    assert.equal(verdict.sameResource(`${IMAGE}#a`, `${IMAGE}#b`), true)
    assert.equal(verdict.sameResource(IMAGE, 'https://www.nongsaro.go.kr/ps/img/curation/leaf.png'), false)
  })

  it('페이지에 실재하는가', () => {
    const found = verdict.findImageOccurrences(pageHtml(''), PAGE)
    assert.equal(verdict.appearsOnPage(found, [IMAGE]), true)
    assert.equal(verdict.appearsOnPage(found, [`${IMAGE}?v=2`]), false)
  })

  // CONTRACT §8: 페이지가 http:로 적어도 받기는 https:로 간다 — 같은 자원으로 봐야 승인이 막히지 않는다.
  it('§8 http: 표기와 https: 후보는 같은 자원', () => {
    const found = verdict.findImageOccurrences(`<img src="http://www.nongsaro.go.kr/ps/img/curation/leaf.jpg">`, PAGE)
    assert.equal(verdict.appearsOnPage(found, [IMAGE]), true)
  })

  it('§8 호스트가 다르면 다른 자원', () => {
    const found = verdict.findImageOccurrences(`<img src="http://www.other.go.kr${new URL(IMAGE).pathname}">`, PAGE)
    assert.equal(verdict.appearsOnPage(found, [IMAGE]), false)
  })

  it('§8 경로가 다르면 다른 자원', () => {
    const found = verdict.findImageOccurrences('<img src="http://www.nongsaro.go.kr/ps/img/curation/other.jpg">', PAGE)
    assert.equal(verdict.appearsOnPage(found, [IMAGE]), false)
  })

  it('§8 명시 포트가 다르면 다른 자원', () => {
    const page8080 = verdict.findImageOccurrences('<img src="http://www.nongsaro.go.kr:8080/ps/img/curation/leaf.jpg">', PAGE)
    assert.equal(verdict.appearsOnPage(page8080, [IMAGE]), false)
  })

  // `https://x:443/`은 WHATWG URL이 포트를 지워 `https://x/`과 같은 문자열이 된다 — 같은 종점이므로
  // 일치가 맞다. 이 시험은 그 정규화에 기대고 있다는 사실을 잠근다(포트 구분은 비기본 포트에서만 산다).
  it('§8 기본 포트 표기는 URL 정규화로 사라진다 — 같은 자원', () => {
    const page443 = verdict.findImageOccurrences('<img src="https://www.nongsaro.go.kr:443/ps/img/curation/leaf.jpg">', PAGE)
    assert.equal(page443[0]?.href, IMAGE)
    assert.equal(verdict.appearsOnPage(page443, [IMAGE]), true)
  })
})

describe('creditFor', () => {
  it('그림 바로 옆의 표기를 잡는다', () => {
    const html = `<p>사진 제공: 산림청</p><img src="${IMAGE}">`
    assert.equal(verdict.creditFor(html, verdict.findImageOccurrences(html, PAGE), [IMAGE]), 'credit')
  })

  it('ⓒ·(c) 연도·출처: 도 잡는다', () => {
    for (const credit of ['ⓒ 2024 농촌진흥청', '(c) 2023 KREI', '출처: 국립수목원']) {
      const html = `<img src="${IMAGE}"><span>${credit}</span>`
      assert.equal(verdict.creditFor(html, verdict.findImageOccurrences(html, PAGE), [IMAGE]), 'credit', credit)
    }
  })

  it('멀리 떨어진 푸터 저작권은 안 잡는다', () => {
    const html = `<img src="${IMAGE}">${'가'.repeat(600)}<footer>ⓒ 2024 농촌진흥청</footer>`
    assert.equal(verdict.creditFor(html, verdict.findImageOccurrences(html, PAGE), [IMAGE]), 'none')
  })

  it('페이지에 없는 URL이면 기준 태그를 못 정한다 — none이 아니라 unknown', () => {
    const html = '<p>사진 제공: 산림청</p>'
    assert.equal(verdict.creditFor(html, verdict.findImageOccurrences(html, PAGE), [IMAGE]), 'unknown')
  })

  // B-2 반례: 파일 이름이 한글이라 원문 `indexOf`가 못 찾았다. 태그 자리를 기준으로 보면 잡힌다.
  it('B-2 한글 파일 이름이어도 태그 자리의 표기를 잡는다', () => {
    const html = '<p>본문</p><img src="/ps/img/curation/사진.jpg"><p>사진 제공: 홍길동</p>'
    const candidate = 'https://www.nongsaro.go.kr/ps/img/curation/%EC%82%AC%EC%A7%84.jpg'
    const found = verdict.findImageOccurrences(html, PAGE)
    assert.equal(verdict.appearsOnPage(found, [candidate]), true)
    assert.equal(verdict.creditFor(html, found, [candidate]), 'credit')
  })

  it('B-2 같은 그림이 두 번 나오면 표기가 있는 쪽을 본다', () => {
    const gap = '가'.repeat(1200)
    const html = `<img src="${IMAGE}">${gap}<img src="${IMAGE}"><p>사진 제공: 홍길동</p>`
    const found = verdict.findImageOccurrences(html, PAGE)
    assert.equal(verdict.creditFor(html, found, [IMAGE]), 'credit')
  })
})

describe('decide', () => {
  const kogl = (type: 1 | 2 | 3 | 4) => verdict.readKogl(`<span class="openGrade_${type}"></span>`)

  it('1유형·2유형은 승인', () => {
    for (const type of [1, 2] as const) {
      const result = verdict.decide({ ...approved, kogl: kogl(type) })
      assert.equal(result.verdict, 'approved', String(type))
      assert.equal(result.reason, `kogl_type_${type}`)
      assert.equal(result.kogl, type)
      assert.equal(result.org, '농촌진흥청 국립원예특작과학원')
    }
  })

  it('3·4유형은 ambiguous(변경금지 ↔ 재인코딩 충돌)', () => {
    for (const type of [3, 4] as const) {
      const result = verdict.decide({ ...approved, kogl: kogl(type) })
      assert.equal(result.verdict, 'ambiguous', String(type))
      assert.equal(result.reason, `kogl_type_${type}_no_derivative`)
    }
  })

  it('마크가 없거나 불일치면 ambiguous', () => {
    assert.deepEqual({ verdict: verdict.decide({ ...approved, kogl: verdict.readKogl('') }).verdict }, { verdict: 'ambiguous' })
    const conflict = verdict.readKogl('<span class="openGrade_1"></span><span class="openGrade_2"></span>')
    const result = verdict.decide({ ...approved, kogl: conflict })
    assert.equal(result.verdict, 'ambiguous')
    assert.equal(result.reason, 'kogl_conflict')
  })

  it('제3자 표기가 있으면 ambiguous(유형보다 먼저 본다)', () => {
    const result = verdict.decide({ ...approved, thirdPartyCredit: 'credit', kogl: kogl(1) })
    assert.equal(result.verdict, 'ambiguous')
    assert.equal(result.reason, 'third_party_credit')
  })

  // B-2: 기준 태그를 못 정한 것은 "표기 없음"이 아니다 — 모르는 채로 승인하지 않는다.
  it('기준 태그를 못 정했으면 ambiguous', () => {
    const result = verdict.decide({ ...approved, thirdPartyCredit: 'unknown', kogl: kogl(1) })
    assert.equal(result.verdict, 'ambiguous')
    assert.equal(result.reason, 'third_party_unknown')
  })

  it('규칙이 없으면 rejected — 마크가 있어도 승인 없음', () => {
    const result = verdict.decide({ ...approved, rule: { ok: false, reason: 'page_not_allowlisted' }, kogl: kogl(1) })
    assert.equal(result.verdict, 'rejected')
    assert.equal(result.reason, 'rule_missing:page_not_allowlisted')
  })

  it('페이지에 없으면 rejected, 최종 URL이 규칙 밖이면 rejected', () => {
    assert.equal(verdict.decide({ ...approved, present: false, kogl: kogl(1) }).reason, 'not_on_page')
    assert.equal(verdict.decide({ ...approved, finalUrlAllowed: false, kogl: kogl(1) }).reason, 'final_url_outside_rules')
  })

  it('판정 순서: 규칙 → 최종 URL → 페이지 실재 → 제3자 → 유형', () => {
    // 여러 조건이 동시에 깨질 때 앞 조건의 사유가 남는다(증명에서 원인 추적용).
    const result = verdict.decide({
      rule: { ok: false, reason: 'host' },
      present: false,
      thirdPartyCredit: 'credit',
      finalUrlAllowed: false,
      kogl: verdict.readKogl('')
    })
    assert.equal(result.reason, 'host')
  })
})
