/**
 * 뷰어 직접 수정 — 화면 선택 → 원고 문단 전·후 (설계 §4-1, §11).
 *
 * 위치 찾기는 이 기능에서 가장 잘 깨지는 자리다. 굵게·링크·표 경계를 넘는 선택, 같은
 * 글자가 여러 번인 문단, 줄바꿈이 낀 선택을 창 없이 밟는다.
 */
import { expect, test } from '@playwright/test'
import { renderMarkdown } from '../src/renderer/src/markdown'
import {
  isPlainParagraph,
  isTableParagraph,
  locateSelection,
  replacementViolation,
  replaceInBlock
} from '../src/shared/edit'

const DRAFT = [
  '농장A의 재배 면적은 600평이다.',
  '',
  '올해 트랙터를 새로 들였다.',
  '',
  '내년에는 트랙터를 두 대 더 들인다. 트랙터를 관리하는 사람도 늘린다.'
].join('\n')

test('선택 글자를 문단 원고 안에서 찾아 전·후 문단을 낸다', () => {
  const draft = DRAFT
  const blocks = draft.split('\n\n')
  const rendered = blocks[0]
  const r = replaceInBlock({
    draft,
    blockIndex: 0,
    renderedBlock: rendered,
    renderedBefore: '농장A의 재배 면적은 ',
    selectionText: '600평',
    replacement: '700평'
  }, renderMarkdown)
  expect(r).toEqual({
    ok: true,
    before_block: '농장A의 재배 면적은 600평이다.',
    after_block: '농장A의 재배 면적은 700평이다.'
  })
})

test('같은 글자가 여럿이면 화면에서 센 자리로 고른다', () => {
  const blocks = DRAFT.split('\n\n')
  const block = blocks[2]
  const at = block.indexOf('트랙터를 관리')
  const second = replaceInBlock({
    draft: DRAFT,
    blockIndex: 2,
    renderedBlock: block,
    renderedBefore: block.slice(0, at),
    selectionText: '트랙터를',
    replacement: '경운기를'
  }, renderMarkdown)
  expect(second).toEqual({
    ok: true,
    before_block: block,
    after_block: '내년에는 트랙터를 두 대 더 들인다. 경운기를 관리하는 사람도 늘린다.'
  })
  // 첫 번째 자리를 고르면 앞쪽만 바뀐다.
  const first = replaceInBlock({
    draft: DRAFT,
    blockIndex: 2,
    renderedBlock: block,
    renderedBefore: '내년에는 ',
    selectionText: '트랙터를',
    replacement: '경운기를'
  }, renderMarkdown)
  expect(first).toMatchObject({
    ok: true,
    after_block: '내년에는 경운기를 두 대 더 들인다. 트랙터를 관리하는 사람도 늘린다.'
  })
})

test('문단 번호가 원고 밖이면 거절한다', () => {
  expect(locateSelection({ draft: DRAFT, blockIndex: 9, renderedBlock: 'x', renderedBefore: '', selectionText: 'x' }, renderMarkdown))
    .toEqual({ ok: false, reason: 'block_missing' })
})

test('링크 주소의 같은 글자는 보이지 않는다 — 다시 그려 확인해 보이는 자리로 좁힌다', () => {
  // 링크 주소에도 `600평` 이 있지만 화면에는 안 보인다. 예전에는 '맞는 횟수가 다르니 거절'
  // 이었고, 그 거절이 곧 학생이 못 고치는 문단이었다. 이제 후보를 다시 그려 확인한다.
  const block = '[재배](600평.md) 기록과 600평 측정값이다.'
  const linked = locateSelection({
    draft: block,
    blockIndex: 0,
    renderedBlock: '재배 기록과 600평 측정값이다.',
    renderedBefore: '재배 기록과 ',
    selectionText: '600평'
  }, renderMarkdown)
  expect(linked.ok).toBe(true)
  if (linked.ok) {
    expect(linked.start).toBe(18) // 본문 자리 — 링크 주소(7)가 아니다
    expect(linked.before_block.slice(linked.start, linked.end)).toBe('600평')
  }
  // 같은 글자가 화면에도 둘이면 여전히 특정할 수 없다.
  const plain = '재배 면적은 600평, 수확량도 600평이다.'
  expect(locateSelection({
    draft: plain,
    blockIndex: 0,
    renderedBlock: plain,
    renderedBefore: '재배 면적은 ',
    selectionText: '600평'
  }, renderMarkdown)).toEqual({ ok: true, before_block: plain, start: 7, end: 11, occurrence: 0 })
})

test('선택 글자가 원고 글자에 없으면(굵게·링크·표 경계를 넘음) 거절한다', () => {
  // 굵게 경계를 가로지르는 선택 — 화면에는 이어져 보이지만 원고에는 `**` 가 끼어 있다.
  const draft = '이 농장은 **새벽빛 농원**이다.'
  expect(locateSelection({
    draft,
    blockIndex: 0,
    renderedBlock: '이 농장은 새벽빛 농원이다.',
    renderedBefore: '이 농장은 ',
    selectionText: '농장은 새벽빛'
  }, renderMarkdown)).toEqual({ ok: false, reason: 'not_located' })
  // 굵게 안쪽만 고르는 것은 그대로 된다 — 마크다운 기호는 선택 밖에 있다.
  expect(locateSelection({
    draft,
    blockIndex: 0,
    renderedBlock: '이 농장은 새벽빛 농원이다.',
    renderedBefore: '이 농장은 ',
    selectionText: '새벽빛 농원'
  }, renderMarkdown)).toEqual({ ok: true, before_block: draft, start: 8, end: 14, occurrence: 0 })
})

test('공백 한 덩어리는 원고의 줄바꿈 한 덩어리와 맞는다 — 순수 문단이면 허용', () => {
  const block = '첫 줄 문장이다.\n둘째 줄 문장이다.'
  const r = replaceInBlock({
    draft: block,
    blockIndex: 0,
    renderedBlock: '첫 줄 문장이다. 둘째 줄 문장이다.',
    renderedBefore: '첫 줄 문장이다. ',
    selectionText: '둘째 줄',
    replacement: '셋째 줄'
  }, renderMarkdown)
  expect(r).toEqual({
    ok: true,
    before_block: block,
    after_block: '첫 줄 문장이다.\n셋째 줄 문장이다.'
  })
})

test('표·목록 문단에서 줄을 넘는 선택은 거절한다', () => {
  const table = '| 항목 | 값 |\n| --- | --- |\n| 면적 | 600평 |'
  expect(isTableParagraph(table)).toBe(true)
  expect(isPlainParagraph(table)).toBe(false)
  expect(locateSelection({
    draft: table,
    blockIndex: 0,
    renderedBlock: '항목 값 면적 600평',
    renderedBefore: '항목 ',
    selectionText: '값 면적'
  }, renderMarkdown).ok).toBe(false)
})

test('표 문단에서 한 칸 안 고침은 되고 `|` 를 넣으면 거절한다', () => {
  const table = '| 항목 | 값 |\n| --- | --- |\n| 면적 | 600평 |'
  // 화면 글자에는 `|` 가 없다 — 칸 글자만 이어지고, 표를 다시 그려 확인해도 같은 칸이 남는다.
  expect(replaceInBlock({
    draft: table,
    blockIndex: 0,
    renderedBlock: '항목 값 면적 600평',
    renderedBefore: '항목 값 면적 ',
    selectionText: '600평',
    replacement: '700평'
  }, renderMarkdown)).toEqual({
    ok: true,
    before_block: table,
    after_block: '| 항목 | 값 |\n| --- | --- |\n| 면적 | 700평 |'
  })
  expect(replaceInBlock({
    draft: table,
    blockIndex: 0,
    renderedBlock: '항목 값 면적 600평',
    renderedBefore: '항목 값 면적 ',
    selectionText: '600평',
    replacement: '600|700평'
  }, renderMarkdown)).toEqual({ ok: false, reason: 'table_pipe' })
})

test('고친 글자의 줄바꿈·DRAFT 마커·빈 문단은 거절한다', () => {
  expect(replacementViolation('두 줄\n쓰기')).toBe('newline')
  expect(replacementViolation('앞 <!-- gg:draft:end --> 뒤')).toBe('marker')
  expect(replacementViolation('한 줄')).toBeNull()
  const base = { draft: '한 문단이다.', blockIndex: 0, renderedBlock: '한 문단이다.', renderedBefore: '', selectionText: '한 문단이다.' }
  expect(replaceInBlock({ ...base, replacement: 'a\nb' }, renderMarkdown)).toEqual({ ok: false, reason: 'invalid_replacement' })
  expect(replaceInBlock({ ...base, replacement: '   ' }, renderMarkdown)).toEqual({ ok: false, reason: 'empty_block' })
})

test('겹치는 같은 글자는 화면에서 고른 자리를 따른다', () => {
  // `가가가` 에서 두 번째 `가가` 를 골랐다 — 겹치지 않게 세면 0번째로 가서 앞이 바뀐다.
  expect(replaceInBlock({
    draft: '가가가',
    blockIndex: 0,
    renderedBlock: '가가가',
    renderedBefore: '가',
    selectionText: '가가',
    replacement: '나'
  }, renderMarkdown)).toEqual({ ok: true, before_block: '가가가', after_block: '가나' })
  expect(replaceInBlock({
    draft: '가가가',
    blockIndex: 0,
    renderedBlock: '가가가',
    renderedBefore: '',
    selectionText: '가가',
    replacement: '나'
  }, renderMarkdown)).toEqual({ ok: true, before_block: '가가가', after_block: '나가' })
})

test('서식·링크가 섞인 문단은 다시 그려 확인한다 — 고르지 않은 자리를 바꾸지 않는다 (Roh 01)', () => {
  // 원고 `가**나** 가나 [x](가나)` 는 화면에 `가나 가나 x` 로 그려진다. 원고에서 이어진 `가나` 는
  // 본문 둘째와 숨은 링크 주소 두 곳, 화면의 첫째 `가나` 는 굵게 경계를 넘는다.
  const draft = '가**나** 가나 [x](가나)'
  const renderedBlock = '가나 가나 x'
  // 첫째 `가나`(굵게 경계를 넘음) — 원고 대응을 입증할 수 없으므로 거절한다.
  expect(locateSelection({
    draft, blockIndex: 0, renderedBlock, renderedBefore: '', selectionText: '가나'
  }, renderMarkdown)).toEqual({ ok: false, reason: 'not_located' })
  // 둘째 `가나`(화면의 본문) — 링크 주소가 아니라 본문 그 자리만 잡는다.
  const second = locateSelection({
    draft, blockIndex: 0, renderedBlock, renderedBefore: '가나 ', selectionText: '가나'
  }, renderMarkdown)
  expect(second.ok).toBe(true)
  if (second.ok) {
    expect(second.before_block.slice(second.start, second.end)).toBe('가나')
    expect(second.start).toBe(7) // 원고 `가**나** ` 다음 — 링크 주소(12)가 아니다
    const r = replaceInBlock({
      draft, blockIndex: 0, renderedBlock, renderedBefore: '가나 ', selectionText: '가나', replacement: '다라'
    }, renderMarkdown)
    expect(r).toEqual({ ok: true, before_block: draft, after_block: '가**나** 다라 [x](가나)' })
  }
})

test('표 안에서도 다시 그려 확인한다 — 첫 칸을 골라 링크 주소를 바꾸지 않는다 (Roh 01, 표)', () => {
  // 표 한 줄: 첫 칸은 굵게 경계를 넘어(`가**나**`), 둘째 칸 주소에 같은 `가나` 가 숨어 있다.
  // 화면에는 `가나`·`x` 두 칸만 보인다 — 보이지 않는 주소가 바뀌면 안 된다.
  const draft = '| 가**나** | [x](가나) |'
  const renderedBlock = '가나 x'
  const first = locateSelection({
    draft, blockIndex: 0, renderedBlock, renderedBefore: '', selectionText: '가나'
  }, renderMarkdown)
  expect(first).toEqual({ ok: false, reason: 'not_located' })
})

test('서식 없는 표 칸은 그 칸만 바뀐다 (Roh 01, 표 정상 경로)', () => {
  const table = '| 항목 | 값 |\n| --- | --- |\n| 면적 | 600평 |'
  const r = replaceInBlock({
    draft: table,
    blockIndex: 0,
    renderedBlock: '항목 값 면적 600평',
    renderedBefore: '항목 값 면적 ',
    selectionText: '600평',
    replacement: '700평'
  }, renderMarkdown)
  expect(r).toEqual({
    ok: true,
    before_block: table,
    after_block: '| 항목 | 값 |\n| --- | --- |\n| 면적 | 700평 |'
  })
})
