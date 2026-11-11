import type { EditRow } from './types'

/**
 * 재확인 메모 — 학생이 직접 고친 문장을 다음 메시지에 붙여 도우미가 함께 보게 한다
 * (설계 §6-1·§6-2, 화면 묶음 B).
 *
 * 규칙집이 이 기능을 몰라도 통하게 **스스로 설명하는** 고정 서식이다. 표지 줄(대괄호 줄)로
 * 시작하므로 말풍선이 그 줄부터 끝까지를 떼어 칩 한 줄로 접을 수 있다(§6-1).
 *
 * 순수 함수만 둔다 — Node 시험(`playwright.node.config.ts`)이 잠근다.
 */

/** 표지 줄 — 말풍선이 이 줄부터 끝까지를 메모로 본다. 문구를 바꾸면 여기만 바꾼다. */
export const RECHECK_MARK = '[학생이 뷰어에서 직접 고친 문장 — 확인 요청]'

/** 인용 안에 넣어도 메모 서식이 깨지지 않게 — 줄바꿈은 공백으로 눕힌다(권고 4 '알려진 한계'의 완화). */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** 고침 한 건의 기계 검사 이유 — 숫자가 바뀌었는데 이유가 비어 있으면 그 사실을 말한다(§6-2). */
function whyOf(row: EditRow, edit: { before_block: string; after_block: string }): string {
  const reasons = (row.new_issues ?? []).map((issue) => issue.reason).filter(Boolean)
  const numbersChanged = /\d/.test(edit.before_block) || /\d/.test(edit.after_block)
  return [...reasons, ...(numbersChanged && reasons.length === 0 ? ['숫자 바뀜'] : [])].join(' · ')
}

/**
 * 행 하나가 메모에 남길 줄들 — **`edits[]` 전부**다.
 *
 * 첫 항목만 쓰면 `n곳 고치기`(§3-4)의 나머지 곳이 메모에 안 실린다. 그런데 행 전체는
 * `sent` 로 닫히므로, 도우미가 못 본 고침이 "답함"이 된다(검토 B-R1 차단 1).
 *
 * 기록 유실 행(`lost_record`, `edits: []`)은 §5 가 정한 문구 한 줄로 싣는다. 그 행은
 * 본문 변경 내용을 알 수 없으므로 장 전체를 대조하라고 말한다.
 */
function linesOf(row: EditRow, titles: Record<string, string>): string[] {
  if (row.lost_record === true) {
    const id = row.section_ids[0] ?? ''
    return [`- ${titles[id] ?? id}: 직접 고친 기록이 유실됨 — 이 장 전체를 사실·출처와 대조`]
  }
  return row.edits.map((edit) => {
    const title = titles[edit.section_id] ?? edit.section_id
    const why = whyOf(row, edit)
    return `- ${title}: "${oneLine(edit.before_block)}" → "${oneLine(edit.after_block)}"${why ? `  (기계 검사: ${why})` : ''}`
  })
}

/**
 * 붙일 것·닫을 것·서버로 보낼 것을 한 번에 정한다.
 *
 * - `ids`: 메모에 줄이 **실제로 실린** 행들. 이것만 화면에서 닫는다.
 * - `marks`: 그중 **서버 원장에 있는** 행. 기록 유실 행은 원장에 없어 `edits_mark` 가
 *   호출 전체를 거절하므로(`methods_edit.py` `section_edits_mark`) 여기서 빼야 정상 건이 산다.
 * - `localOnly`: 기록 유실 행 — 화면에서만 닫아 같은 세션에 되풀이되지 않게 한다.
 * - `memo`: 붙일 문구. 실을 줄이 없으면 `null`.
 *
 * 유실 행은 `marks` 에서 빠지므로 서버 상태는 `pending` 그대로다 — 앱을 다시 켜면 한 번 더
 * 붙는다. 설계 §6-3 "두 번 가도 해가 없다"가 그 경우를 이미 받아들인다(알려진 한계).
 */
export interface RecheckPlan {
  /** 메모에 줄이 실린 행들 — 화면에서 닫을 것. */
  ids: string[]
  /** 그중 서버 원장에 있는 행 — `section.edits_mark` 로 보낼 것(유실 행 제외). */
  marks: string[]
  /** 이번 세션에 화면에서만 닫아 둘 행(기록 유실) — 서버는 모른다. */
  localOnly: string[]
  /** 붙일 문구. 실을 줄이 없으면 `null`. */
  memo: string | null
}

export function recheckPlan(rows: EditRow[], titles: Record<string, string> = {}): RecheckPlan {
  const pending = rows.filter((row) => row.state === 'pending')
  const ids: string[] = []
  const lines: string[] = []
  for (const row of pending) {
    const own = linesOf(row, titles)
    if (own.length === 0) continue          // 실을 줄이 없으면 닫지도 않는다 — 붙인 범위 = 닫는 범위
    ids.push(row.edit_id)
    lines.push(...own)
  }
  const memo = lines.length === 0 ? null : [
    RECHECK_MARK,
    ...lines,
    '이 고침은 이미 본문에 저장·등록돼 있다. 등록된 사실·출처와 대조해라.',
    '맞으면 인용·근거 위치만 새 문장에 맞춰 다시 등록하고, 어긋나면 학생 문장을 임의로 되돌리지 말고 무엇이 다른지 학생에게 물어라.'
  ].join('\n')
  const lostId = (id: string): boolean => pending.find((row) => row.edit_id === id)?.lost_record === true
  const marks = ids.filter((id) => !lostId(id))
  const localOnly = ids.filter(lostId)
  return { ids, marks, localOnly, memo }
}

/**
 * 붙일 메모 전문. `rows` 는 **확인 전(`pending`)인 고침**만 넘긴다. 없으면 `null` —
 * 메모 없는 메시지에 빈 표지를 붙이지 않는다.
 */
export function recheckMemo(rows: EditRow[], titles: Record<string, string> = {}): string | null {
  return recheckPlan(rows, titles).memo
}

/**
 * 보낼 본문에 메모를 붙인다 — 본문과 **빈 줄 하나**로 띄운다(§6-1).
 * 메모가 없으면 본문 그대로. 본문이 비어 있으면 메모만 보낸다.
 */
export function withRecheck(text: string, memo: string | null): string {
  const body = text.trim()
  if (!memo) return text
  if (!body) return memo
  return `${body}\n\n${memo}`
}

/**
 * 말풍선 접기 — 메시지에서 표지 줄부터 끝까지를 떼어 낸다(§6-1 순서).
 *
 * **인용 정규식보다 먼저** 부른다. 순서가 바뀌면 인용 본문 끝에 메모 전문이 드러난다.
 * 표지가 없으면 `memo: null` 이고 본문은 그대로다.
 */
export function splitRecheck(text: string): { body: string; memo: string | null; count: number } {
  const at = text.indexOf(RECHECK_MARK)
  if (at < 0) return { body: text, memo: null, count: 0 }
  const body = text.slice(0, at).replace(/\s+$/, '')
  const memo = text.slice(at)
  // 메모의 항목 줄 수 — 칩이 `n개`를 말한다. 항목이 없으면 1건으로 센다.
  const count = Math.max(1, memo.split('\n').filter((line) => line.trim().startsWith('- ')).length)
  return { body, memo, count }
}

/** 칩 한 줄에 쓸 말 — 설계 §6-1 `직접 고친 문장 n개 확인 요청`. */
export function recheckChipLabel(count: number): string {
  return `직접 고친 문장 ${count}개 확인 요청`
}
