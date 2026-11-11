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

/** 고침 한 건을 메모 한 줄로. 기계 검사 결과가 있으면 이유를 덧붙인다. */
function lineOf(row: EditRow): string | null {
  const edit = row.edits[0]
  if (!edit) return null
  const reasons = (row.new_issues ?? []).map((issue) => issue.reason).filter(Boolean)
  // 숫자가 바뀐 고침은 이유가 비어도 그 사실을 말한다 — 기계가 판정한 근거다(§6-2).
  const numbersChanged = /\d/.test(edit.before_block) || /\d/.test(edit.after_block)
  const why = [...reasons, ...(numbersChanged && reasons.length === 0 ? ['숫자 바뀜'] : [])].join(' · ')
  return `- ${row.section_ids[0] ?? edit.section_id}: "${edit.before_block}" → "${edit.after_block}"${why ? `  (기계 검사: ${why})` : ''}`
}

/**
 * 붙일 메모 전문. `rows` 는 **확인 전(`pending`)인 고침**만 넘긴다. 없으면 `null` —
 * 메모 없는 메시지에 빈 표지를 붙이지 않는다.
 */
export function recheckMemo(rows: EditRow[], titles: Record<string, string> = {}): string | null {
  const pending = rows.filter((row) => row.state === 'pending')
  if (pending.length === 0) return null
  const lines = pending.map((row) => {
    const line = lineOf(row)
    if (!line) return null
    const title = titles[row.section_ids[0] ?? '']
    return title ? line.replace(`- ${row.section_ids[0]}:`, `- ${title}:`) : line
  }).filter((line): line is string => line !== null)
  if (lines.length === 0) return null
  return [
    RECHECK_MARK,
    ...lines,
    '이 고침은 이미 본문에 저장·등록돼 있다. 등록된 사실·출처와 대조해라.',
    '맞으면 인용·근거 위치만 새 문장에 맞춰 다시 등록하고, 어긋나면 학생 문장을 임의로 되돌리지 말고 무엇이 다른지 학생에게 물어라.'
  ].join('\n')
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
