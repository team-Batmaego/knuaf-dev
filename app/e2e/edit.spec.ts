/**
 * 뷰어 직접 수정 — 화면 선택 → 원고 문단 전·후 (설계 §4-1, §11).
 *
 * 위치 찾기는 이 기능에서 가장 잘 깨지는 자리다. 굵게·링크·표 경계를 넘는 선택, 같은
 * 글자가 여러 번인 문단, 줄바꿈이 낀 선택을 창 없이 밟는다.
 */
import { expect, test } from '@playwright/test'
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
    renderedBefore: '농장A의 ',
    selectionText: '600평',
    replacement: '700평'
  })
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
  })
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
  })
  expect(first).toMatchObject({
    ok: true,
    after_block: '내년에는 경운기를 두 대 더 들인다. 트랙터를 관리하는 사람도 늘린다.'
  })
})

test('문단 번호가 원고 밖이면 거절한다', () => {
  expect(locateSelection({ draft: DRAFT, blockIndex: 9, renderedBlock: 'x', renderedBefore: '', selectionText: 'x' }))
    .toEqual({ ok: false, reason: 'block_missing' })
})

test('렌더 글자에서 맞는 횟수와 원고에서 맞는 횟수가 다르면 위치를 특정하지 못한다', () => {
  // 링크 주소에도 같은 글자가 들어 있다 — 화면은 한 번만 그렸는데 원고에는 둘이다.
  // 어느 쪽을 골랐는지 알 수 없으므로 거절한다(링크 주소를 고치면 링크가 깨진다).
  const block = '[재배](600평.md) 기록과 600평 측정값이다.'
  expect(locateSelection({
    draft: block,
    blockIndex: 0,
    renderedBlock: '재배 기록과 600평 측정값이다.',
    renderedBefore: '재배 기록과 ',
    selectionText: '600평'
  })).toEqual({ ok: false, reason: 'ambiguous' })
  // 횟수가 같으면 화면에서 센 자리로 고른다.
  const plain = '재배 면적은 600평, 수확량도 600평이다.'
  expect(locateSelection({
    draft: plain,
    blockIndex: 0,
    renderedBlock: plain,
    renderedBefore: '재배 면적은 600평, 수확량도 ',
    selectionText: '600평'
  })).toEqual({ ok: true, before_block: plain, start: 18, end: 22, occurrence: 1 })
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
  })).toEqual({ ok: false, reason: 'not_located' })
  // 굵게 안쪽만 고르는 것은 그대로 된다 — 마크다운 기호는 선택 밖에 있다.
  expect(locateSelection({
    draft,
    blockIndex: 0,
    renderedBlock: '이 농장은 새벽빛 농원이다.',
    renderedBefore: '이 농장은 ',
    selectionText: '새벽빛 농원'
  })).toEqual({ ok: true, before_block: draft, start: 8, end: 14, occurrence: 0 })
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
  })
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
  }).ok).toBe(false)
})

test('표 문단에서 한 칸 안 고침은 되고 `|` 를 넣으면 거절한다', () => {
  const table = '| 항목 | 값 |\n| --- | --- |\n| 면적 | 600평 |'
  expect(replaceInBlock({
    draft: table,
    blockIndex: 0,
    renderedBlock: table,
    renderedBefore: '| 항목 | 값 |\n| --- | --- |\n| 면적 | ',
    selectionText: '600평',
    replacement: '700평'
  })).toEqual({
    ok: true,
    before_block: table,
    after_block: '| 항목 | 값 |\n| --- | --- |\n| 면적 | 700평 |'
  })
  expect(replaceInBlock({
    draft: table,
    blockIndex: 0,
    renderedBlock: table,
    renderedBefore: '| 항목 | 값 |\n| --- | --- |\n| 면적 | ',
    selectionText: '600평',
    replacement: '600|700평'
  })).toEqual({ ok: false, reason: 'table_pipe' })
})

test('고친 글자의 줄바꿈·DRAFT 마커·빈 문단은 거절한다', () => {
  expect(replacementViolation('두 줄\n쓰기')).toBe('newline')
  expect(replacementViolation('앞 <!-- gg:draft:end --> 뒤')).toBe('marker')
  expect(replacementViolation('한 줄')).toBeNull()
  const base = { draft: '한 문단이다.', blockIndex: 0, renderedBlock: '한 문단이다.', renderedBefore: '', selectionText: '한 문단이다.' }
  expect(replaceInBlock({ ...base, replacement: 'a\nb' })).toEqual({ ok: false, reason: 'invalid_replacement' })
  expect(replaceInBlock({ ...base, replacement: '   ' })).toEqual({ ok: false, reason: 'empty_block' })
})
