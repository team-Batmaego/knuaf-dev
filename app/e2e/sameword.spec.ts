/**
 * 같은 낱말 찾기 — 순수 함수 (설계 §3-4, 정제 2-3, §11).
 *
 * AI 없이 글자만 본다: 조사 떼기, 2글자 미만·숫자 제외, 20군데 초과 제외, 드문 순 3개,
 * 조사만 고친 경우 제외, 이미지 주소·주석·코드 안은 안 셈, 같은 문단 병합.
 */
import { expect, test } from '@playwright/test'
import {
  bodyMask,
  changedSpans,
  editPreview,
  findPlaces,
  isWordCandidate,
  mergeSameWordPicks,
  sameWordSuggestions,
  vanishedWordPairs,
  wordOf
} from '../src/shared/sameword'

test('흔한 조사만 떼고, 긴 조사를 먼저 본다', () => {
  expect(wordOf('트랙터를')).toBe('트랙터')
  expect(wordOf('트랙터로')).toBe('트랙터')
  expect(wordOf('농장으로')).toBe('농장')
  expect(wordOf('농장에서는')).toBe('농장에서')
  expect(wordOf('트랙터를,')).toBe('트랙터')
  expect(wordOf('"트랙터"')).toBe('트랙터')
  expect(wordOf('트랙터')).toBe('트랙터')
})

test('후보는 2글자 이상·숫자 아님', () => {
  expect(isWordCandidate('트랙터')).toBe(true)
  expect(isWordCandidate('트랙터를')).toBe(true)
  expect(isWordCandidate('배')).toBe(false)
  expect(isWordCandidate('배를')).toBe(false)
  expect(isWordCandidate('3,000평')).toBe(false)
  expect(isWordCandidate('600평')).toBe(false)
})

test('앞뒤에서 겹치는 부분을 뗀 최소 치환 쌍', () => {
  expect(changedSpans('면적 300평', '면적 500평')).toEqual({ removed: '3', added: '5' })
  expect(changedSpans('트랙터를 들였다', '경운기를 들였다')).toEqual({ removed: '트랙터', added: '경운기' })
  expect(changedSpans('같은 글', '같은 글')).toEqual({ removed: '', added: '' })
})

test('조사만 고친 경우는 사라진 낱말이 아니다', () => {
  expect(vanishedWordPairs('농장은 트랙터를 들였다.', '농장은 트랙터가 들였다.')).toEqual([])
  // 낱말 자체를 바꾼 경우만 후보.
  expect(vanishedWordPairs('농장은 트랙터를 들였다.', '농장은 경운기를 들였다.'))
    .toEqual([{ from: '트랙터', to: '경운기' }])
  // 지운 경우 — 새 낱말은 빈 문자열.
  expect(vanishedWordPairs('농장은 트랙터를 들였다.', '농장은 들였다.'))
    .toEqual([{ from: '트랙터', to: '' }])
})

test('본문이 아닌 구간은 마스크된다 — 코드·주석·링크 주소·수식', () => {
  const block = '본문 트랙터.\n\n```\n트랙터 코드\n```\n<!-- 트랙터 주석 -->\n[트랙터](sources/트랙터.png) $트랙터$ 끝'
  const mask = bodyMask(block)
  const masked = (needle: string, from = 0): boolean => {
    const at = block.indexOf(needle, from)
    return at >= 0 && !mask[at]
  }
  expect(masked('트랙터 코드')).toBe(true)
  expect(masked('트랙터 주석')).toBe(true)
  // 링크 주소 안은 숨기고, 보이는 링크 글자는 본문이다.
  expect(masked('트랙터.png')).toBe(true)
  const linkText = block.indexOf('[트랙터]')
  expect(mask[linkText + 1]).toBe(true)
  expect(masked('트랙터$', block.indexOf('$트랙터$'))).toBe(true)
  expect(mask[0]).toBe(true)
})

test('다른 곳 출현은 본문 구간에서만 세고, 겹치는 자리는 한 번만 센다', () => {
  const sections = [
    { id: 'sec-01', draft: '트랙터를 샀다. 트랙터 관리도 한다.' },
    { id: 'sec-02', draft: '[그림](sources/트랙터.png)\n\n트랙터는 비싸다.' }
  ]
  const places = findPlaces(sections, '트랙터')
  expect(places.map((p) => [p.section_id, p.block_index])).toEqual([
    ['sec-01', 0],
    ['sec-01', 0],
    ['sec-02', 1]
  ])
  expect(places[0]).toMatchObject({ start: 0, end: 3, before_block: '트랙터를 샀다. 트랙터 관리도 한다.' })
  expect(places[0].context).toContain('트랙터')
})

test('드문 것부터 최대 3개, 20군데를 넘거나 0군데면 빼고, 조사만 고친 건 안 뜬다', () => {
  const filler = Array.from({ length: 21 }, (_, i) => `문단 ${i} 흔한말 채우기.`).join('\n\n')
  const sections = [
    { id: 'sec-01', draft: '농장 트랙터 관리.' },
    { id: 'sec-02', draft: `경운기 보관. 트랙터 정비.\n\n${filler}` },
    { id: 'sec-03', draft: '비료 살포. 트랙터 점검.' }
  ]
  const rows = sameWordSuggestions(sections, '농장 트랙터 관리.', '농장 경운기 관리.', 3)
  expect(rows.map((r) => [r.from, r.to, r.count])).toEqual([['트랙터', '경운기', 3]])
  // 21군데 넘는 말은 후보에서 빠진다.
  const tooCommon = Array.from({ length: 21 }, (_, i) => `흔한말 ${i}.`).join('\n\n')
  expect(sameWordSuggestions([{ id: 'sec-01', draft: tooCommon }], '흔한말 하나.', '다른말 하나.', 3)).toEqual([])
  // 조사만 고친 경우는 아무것도 안 뜬다.
  expect(sameWordSuggestions(sections, '농장은 트랙터를 관리.', '농장은 트랙터가 관리.', 3)).toEqual([])
  // 다른 곳에 없으면 0군데 → 안 뜬다.
  expect(sameWordSuggestions([{ id: 'sec-01', draft: '비료만.' }], '농장 트랙터 관리.', '농장 경운기 관리.', 3)).toEqual([])
})

test('드문 것부터, 개수가 같으면 앞 문단에서 먼저 나온 낱말이 앞', () => {
  // 둘 다 1군데 — 같은 수면 다른 곳에서 먼저 나오는 낱말이 앞이다(같은 본문이면 늘 같은 줄).
  const sections = [{ id: 'sec-01', draft: '경운기 정비. 트랙터 점검.' }]
  const rows = sameWordSuggestions(sections, '경운기 트랙터 관리.', '자동차 트랙터 관리.', 3)
  expect(rows.map((r) => [r.from, r.to, r.count])).toEqual([['경운기', '자동차', 1]])
  // 드문 것이 앞: 1군데짜리가 2군데짜리보다 먼저.
  const mixed = sameWordSuggestions(
    [{ id: 'sec-01', draft: '경운기 정비. 트랙터 점검. 경운기 보관.' }],
    '경운기 트랙터 관리.',
    '자동차 트랙터 관리.',
    3
  )
  expect(mixed.map((r) => [r.from, r.to, r.count])).toEqual([['경운기', '자동차', 2]])
})

test('같은 문단의 여러 자리는 한 건으로 합치고, 치환은 뒤에서부터 한다', () => {
  const before = '내년에는 트랙터를 두 대 더 들인다. 트랙터를 관리하는 사람도 늘린다.'
  const first = before.indexOf('트랙터를')
  const second = before.indexOf('트랙터를', first + 1)
  const picks = [
    { section_id: 'sec-01', block_index: 2, before_block: before, start: first, end: first + 3, context: '' },
    { section_id: 'sec-01', block_index: 2, before_block: before, start: second, end: second + 3, context: '' },
    { section_id: 'sec-02', block_index: 0, before_block: '트랙터는 비싸다.', start: 0, end: 3, context: '' }
  ]
  expect(mergeSameWordPicks(picks, '경운기')).toEqual([
    {
      section_id: 'sec-01',
      before_block: before,
      after_block: '내년에는 경운기를 두 대 더 들인다. 경운기를 관리하는 사람도 늘린다.'
    },
    { section_id: 'sec-02', before_block: '트랙터는 비싸다.', after_block: '경운기는 비싸다.' }
  ])
})

test('인라인 코드와 중첩 괄호 링크 주소 안 낱말은 본문으로 세지 않는다', () => {
  expect(findPlaces([{ id: 'sec-01', draft: '사용 명령은 `트랙터`이다.' }], '트랙터')).toEqual([])
  expect(findPlaces([{ id: 'sec-01', draft: '[자료](https://example.test/(x)트랙터.png)' }], '트랙터')).toEqual([])
  // 보이는 링크 글자는 본문이다 — 주소만 숨긴다.
  const visible = findPlaces([{ id: 'sec-01', draft: '[트랙터 자료](https://example.test/x.png)' }], '트랙터')
  expect(visible).toHaveLength(1)
  expect(visible[0].start).toBe(1)
})

test('구분자 경계를 정확히 읽는다 — 긴 백틱 묶음·escape 괄호', () => {
  // 여는 묶음과 길이가 다른 백틱은 닫이가 아니다 — 코드 안이므로 세지 않는다.
  expect(findPlaces([{ id: 'sec-01', draft: '명령 `코드 ``` 트랙터` 끝' }], '트랙터')).toEqual([])
  // escape 된 `)` 는 주소를 닫지 않는다 — 주소는 끝까지 숨는다.
  expect(findPlaces([{ id: 'sec-01', draft: '[자료](https://example.test/(x)\\)트랙터.png)' }], '트랙터'))
    .toEqual([])
  expect(findPlaces([{ id: 'sec-01', draft: '[자료](https://example.test/(x)\\(트랙터.png)' }], '트랙터'))
    .toEqual([])
  // 짝이 안 맞는 주소도 줄 끝까지 숨긴다(애매하면 안 세는 쪽).
  expect(findPlaces([{ id: 'sec-01', draft: '[자료](https://example.test/(x 트랙터.png' }], '트랙터'))
    .toEqual([])
})

test('전→후 미리보기는 바뀐 가운데만 남기고 문맥을 자른다', () => {
  // 낱말 하나만 바뀐 경우 — 앞뒤 문맥은 짧아 그대로 남는다.
  expect(editPreview('농장A의 재배 면적은 600평이다.', '농장A의 재배 면적은 700평이다.'))
    .toEqual({ lead: '농장A의 재배 면적은 ', removed: '600', added: '700', trail: '평이다.' })
  // 바뀐 곳이 없으면 문맥만 남고 바뀐 글은 비어 있다(깨지지 않는다).
  const same = editPreview('같은 글이다.', '같은 글이다.')
  expect(same.removed).toBe('')
  expect(same.added).toBe('')
  expect(same.lead + same.trail).toBe('같은 글이다.')
  // 문단 전체가 딴 글이면 문맥이 비고 바뀐 글이 그대로 보인다(앞뒤가 전혀 다름).
  const whole = editPreview('옛 문단 전체.', '새 문단 전체.')
  expect(whole.lead).toBe('')
  expect(whole.removed).toBe('옛')
  expect(whole.added).toBe('새')
  expect(whole.trail).toBe(' 문단 전체.')
  // 긴 문맥은 잘라내고 `…` 로 표시한다.
  const long = editPreview('가'.repeat(40) + '600' + '나'.repeat(40), '가'.repeat(40) + '700' + '나'.repeat(40))
  expect(long.lead).toBe('…' + '가'.repeat(12))
  expect(long.trail).toBe('나'.repeat(12) + '…')
  expect(long.removed).toBe('600')
  expect(long.added).toBe('700')
})

test('같이 고치기는 목록을 열기만 한다 — 저장은 n군데 고치기에서 (Roh 03)', () => {
  // 컴포넌트는 DOM 이 필요하므로 여기서는 **계약**만 잠근다: 저장에 쓰는 값은 목록에서 고른
  // 자리들이고, 체크를 뺀 자리는 빠진다. 화면 쪽 두 단계는 `viewer-edit.spec.ts` 가 본다.
  const sections = [{ id: 'sec-01', draft: '트랙터를 들였다. 트랙터를 팔았다.' }]
  const places = findPlaces(sections, '트랙터')
  expect(places).toHaveLength(2)
  // 전부 체크면 두 건이 한 문단 한 건으로 합쳐진다.
  expect(mergeSameWordPicks(places, '경운기')).toEqual([
    { section_id: 'sec-01', before_block: '트랙터를 들였다. 트랙터를 팔았다.', after_block: '경운기를 들였다. 경운기를 팔았다.' }
  ])
  // 하나를 빼면 그 자리는 손대지 않는다 — 화면의 체크 해제가 곧 이 입력이다.
  expect(mergeSameWordPicks([places[0]], '경운기')).toEqual([
    { section_id: 'sec-01', before_block: '트랙터를 들였다. 트랙터를 팔았다.', after_block: '경운기를 들였다. 트랙터를 팔았다.' }
  ])
})
