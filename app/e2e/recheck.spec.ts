/**
 * 재확인 메모 — 순수 함수 (설계 §6-1·§6-2, 화면 묶음 B).
 *
 * Node 설정(`playwright.node.config.ts`)으로 돈다. 화면·Electron 없이 문구·순서·경계만 잠근다.
 */
import { expect, test } from '@playwright/test'
import { RECHECK_MARK, recheckChipLabel, recheckMemo, splitRecheck, withRecheck } from '../src/shared/recheck'
import type { EditRow } from '../src/shared/types'

function row(id: string, state: EditRow['state'], before: string, after: string, extra: Partial<EditRow> = {}): EditRow {
  return {
    edit_id: id, at: '2026-11-11T00:00:00+00:00', state, revision_before: 1, revision_after: 2,
    edits: [{ section_id: 'sec-01', before_block: before, after_block: after }],
    section_ids: ['sec-01'], needs_check: true, new_issues: [], remaining_issues: [], answered: false,
    ...extra
  }
}

test('확인 전 고침만 메모에 실린다', () => {
  const memo = recheckMemo([
    row('e1', 'pending', '600평이다.', '700평이다.'),
    row('e2', 'plain', '오타.', '고침.'),      // 가벼운 고침 — 재확인 대상 아님
    row('e3', 'sent', '600평.', '700평.')       // 이미 보냈다
  ], { 'sec-01': 'Ⅰ. 머리말' })
  expect(memo).toContain(RECHECK_MARK)
  expect(memo).toContain('Ⅰ. 머리말')
  expect(memo).toContain('"600평이다." → "700평이다."')
  expect(memo).not.toContain('오타.')
  expect(memo).not.toContain('이미 보냈다')
  expect(memo?.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
})

test('확인 전 고침이 없으면 메모도 없다', () => {
  expect(recheckMemo([])).toBeNull()
  expect(recheckMemo([row('e1', 'plain', 'a.', 'b.')])).toBeNull()
})

test('메모는 본문과 빈 줄 하나로 띄고, 본문이 비면 메모만 보낸다', () => {
  const memo = recheckMemo([row('e1', 'pending', '600평이다.', '700평이다.')])!
  expect(withRecheck('단위를 바꿔 줘', memo)).toBe(`단위를 바꿔 줘\n\n${memo}`)
  expect(withRecheck('   ', memo)).toBe(memo)
  expect(withRecheck('본문만', null)).toBe('본문만')
})

test('말풍선은 표지를 먼저 떼고 남은 본문을 돌려준다 — 인용 정규식보다 앞선다', () => {
  const memo = recheckMemo([row('e1', 'pending', '600평이다.', '700평이다.')])!
  const sent = withRecheck('> 고른 문장\n(Ⅰ. 머리말에서)\n\n단위를 바꿔 줘', memo)
  const split = splitRecheck(sent)
  expect(split.memo).toBe(memo)
  expect(split.count).toBe(1)
  // 남은 본문에는 메모가 한 글자도 없다 — 그래야 인용 접기가 그대로 동작한다.
  expect(split.body).not.toContain(RECHECK_MARK)
  expect(split.body).toContain('(Ⅰ. 머리말에서)')
  expect(split.body.endsWith('단위를 바꿔 줘')).toBe(true)
})

test('메모가 없는 메시지는 그대로 통과한다', () => {
  expect(splitRecheck('그냥 글')).toEqual({ body: '그냥 글', memo: null, count: 0 })
})

test('칩 문구는 건수를 센다', () => {
  expect(recheckChipLabel(1)).toBe('직접 고친 문장 1개 확인 요청')
  expect(recheckChipLabel(3)).toBe('직접 고친 문장 3개 확인 요청')
})
