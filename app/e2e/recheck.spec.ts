/**
 * 재확인 메모 — 순수 함수 (설계 §6-1·§6-2, 화면 묶음 B).
 *
 * Node 설정(`playwright.node.config.ts`)으로 돈다. 화면·Electron 없이 문구·순서·경계만 잠근다.
 */
import { expect, test } from '@playwright/test'
import { RECHECK_MARK, recheckChipLabel, recheckMemo, recheckPlan, splitRecheck, withRecheck } from '../src/shared/recheck'
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

// ── 고침1(차단 1): 메모는 행의 edits 전부, 유실 행은 §5 문구 한 줄 ──────────────

function batchRow(id: string, before: string[], after: string[]): EditRow {
  return {
    ...row(id, 'pending', before[0], after[0]),
    edits: before.map((b, i) => ({ section_id: 'sec-01', before_block: b, after_block: after[i] })),
    section_ids: ['sec-01']
  }
}

test('묶음 고침(edits 2)은 메모에 두 줄로 실린다 — 첫 줄만 실으면 나머지 곳은 도우미가 못 본다', () => {
  const memo = recheckMemo([batchRow('e1', ['600평이다.', '정읍 기후다.'], ['700평이다.', '정읍 기상이다.'])])!
  const lines = memo.split('\n').filter((l) => l.startsWith('- '))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('"600평이다." → "700평이다."')
  expect(lines[1]).toContain('"정읍 기후다." → "정읍 기상이다."')
})

test('묶음 고침은 절이 둘이면 장 제목도 둘로 붙는다', () => {
  const two = {
    ...row('e1', 'pending', '가.', '나.'),
    edits: [{ section_id: 'sec-01', before_block: '가.', after_block: '나.' }, { section_id: 'sec-02', before_block: '다.', after_block: '라.' }],
    section_ids: ['sec-01', 'sec-02']
  } as EditRow
  const memo = recheckMemo([two], { 'sec-01': 'Ⅰ. 머리말', 'sec-02': 'Ⅱ. 현황' })!
  expect(memo).toContain('- Ⅰ. 머리말: "가." → "나."')
  expect(memo).toContain('- Ⅱ. 현황: "다." → "라."')
})

test('기록 유실 행은 설계 §5 문구 한 줄로 실린다 — edits 가 비어도 빠지지 않는다', () => {
  const lost: EditRow = {
    ...row('app:student-edit:sec-01:abc', 'pending', '', ''),
    edits: [], section_ids: ['sec-01'], lost_record: true
  }
  const memo = recheckMemo([lost], { 'sec-01': 'Ⅰ. 머리말' })!
  expect(memo).toContain('Ⅰ. 머리말: 직접 고친 기록이 유실됨 — 이 장 전체를 사실·출처와 대조')
  // 줄이 실렸으니 닫을 목록에도 들어간다(다만 서버로는 안 보낸다 — 원장에 없다).
  expect(recheckPlan([lost]).ids).toEqual(['app:student-edit:sec-01:abc'])
})

test('유실 행과 정상 행이 섞이면 정상 건만 서버 목록에 든다', () => {
  const lost: EditRow = { ...row('app:student-edit:sec-02:xyz', 'pending', '', ''), edits: [], section_ids: ['sec-02'], lost_record: true }
  const plan = recheckPlan([lost, row('e1', 'pending', '가.', '나.')])
  // 화면에서는 둘 다 닫는다(메모에 둘 다 실렸으니 같은 세션에 되풀이하지 않는다).
  expect(plan.ids).toEqual(['app:student-edit:sec-02:xyz', 'e1'])
  // 그러나 서버로는 유실 id 를 **보내지 않는다** — 원장에 없어 호출 전체가 거절되고 정상 건까지 죽는다.
  expect(plan.marks).toEqual(['e1'])
  expect(plan.localOnly).toEqual(["app:student-edit:sec-02:xyz"])
})

// ── 고침1(권고 3→중요): 메모가 초안·다시 보내기에 섞이지 않는다 ──────────────────

test('이미 메모를 품은 글을 다시 보내도 메모는 한 벌이다 — 표지도 항목도 겹치지 않는다', () => {
  const rows = [row('e1', 'pending', '600평이다.', '700평이다.')]
  const first = recheckPlan(rows)
  const already = withRecheck('인용 자료가 맞는지 봐 줘', first.memo)
  // `다시 보내기`·실패 복구 초안은 이 `already` 를 그대로 다시 보낸다.
  const second = recheckPlan(rows)
  const { body } = splitRecheck(already)
  const again = withRecheck(body, second.memo)
  expect(again.split(RECHECK_MARK)).toHaveLength(2)   // 표지 1개 = 나눈 조각 2개
  expect(again.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
  expect(splitRecheck(again).count).toBe(1)
})

// ── 고침1: 턴 끝 판정 — 진행 알림을 끝으로 읽으면 칩이 되살아난다 ─────────────

test('턴 끝은 끝 상태로 넘어갈 때만이다 — 진행 알림(running→running)은 끝이 아니다', async () => {
  const { turnEnded, turnSucceeded } = await import('../src/renderer/src/store/chat')
  expect(turnEnded('running', 'running')).toBe(false)      // 진행 알림 — 여기서 닫으면 칩이 되살아난다
  expect(turnEnded('permission', 'running')).toBe(false)   // 승인 응답 — 아직 도는 중
  expect(turnEnded('running', 'permission')).toBe(false)
  expect(turnEnded('running', 'idle')).toBe(true)
  expect(turnEnded('running', 'error')).toBe(true)
  expect(turnEnded('running', 'stopped')).toBe(true)
  expect(turnEnded('running', 'interrupted')).toBe(true)
  expect(turnEnded('idle', 'idle')).toBe(false)            // 끝난 뒤의 같은 상태 반복
  expect(turnEnded(null, 'idle')).toBe(false)              // 앱 시작 첫 스냅샷
  // `answered` 는 정상 종료에만(§5).
  expect(turnSucceeded('idle')).toBe(true)
  expect(['error', 'stopped', 'interrupted', 'running', 'permission'].map((s) => turnSucceeded(s as never))).toEqual([false, false, false, false, false])
})
