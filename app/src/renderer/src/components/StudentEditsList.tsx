import { PopHead, Popover, PopRow } from './Popover'
import { EDIT } from '../editcopy'
import { editPreview } from '../../../shared/sameword'
import type { EditRow } from '../../../shared/types'

/**
 * `직접 고친 곳 n` — 목록 (설계 §3-3, §4-5-6).
 *
 * 보여 주는 것: 장 · 전→후 · 시각 · 상태. **되돌리기 단추는 없다** — v0.6.4에는 되돌리기가
 * 없다(§4-5-1). 잘못 고쳤으면 학생이 그 문장을 다시 드래그해 고친다.
 *
 * 전→후는 문단 전체가 아니라 **바뀐 가운데와 앞뒤 문맥**만 보여 준다(ADD4 1번) — 무엇이
 * 바뀌었는지 학생이 찾아 헤매지 않게. 강조는 `고친 부분 보기`와 같은 색(`del`/`ins`)을 쓴다.
 *
 * 앱은 "확인 끝·맞음"이라고 말하지 않는다(§5) — 상태는 `확인 전`·`도우미에게 전달됨`뿐이다.
 */
export function StudentEditsList({ open, onOpenChange, rows, titles, recheckSections, onAskNow, onAskAgain }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: EditRow[]
  /** 절 id → 장 제목. 제목은 언제나 지금 목록에서 읽는다(옛 제목을 붙이지 않는다). */
  titles: Record<string, string>
  /** 제출 전 점검이 필요한 장들(§4-5-8 07) — 그 장의 검토가 다시 유효해질 때까지 보인다. */
  recheckSections: string[]
  /** `지금 확인받기`(§6-4) — 메모만 담은 메시지를 바로 보낸다. 보낼 수 없으면 `null`. */
  onAskNow: (() => void) | null
  /** `다시 확인 요청`(§6-3) — 그 건을 `pending` 으로 되돌려 다음 메시지에 다시 싣는다. */
  onAskAgain: (editId: string) => void
}) {
  const label = EDIT.listButton(rows.length)
  const pending = rows.filter((row) => row.state === 'pending').length
  const clock = (at: string | null): string => {
    if (!at) return ''
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return (
    <div className="pop-host">
      <button className="lnk" aria-expanded={open} onClick={() => onOpenChange(!open)}>{label}</button>
      <Popover open={open} onClose={() => onOpenChange(false)} align="right" width={380} label={EDIT.listTitle}>
        <PopHead>{EDIT.listTitle}</PopHead>
        {/* 맨 위 — 확인 전 고침이 있을 때만. 메모만 담은 메시지를 곧장 보낸다(§6-4). */}
        {pending > 0 && onAskNow && (
          <div className="edit-asknow">
            <span>{EDIT.askNowLead(pending)}</span>
            <button type="button" className="lnk" onClick={onAskNow}>{EDIT.askNow}</button>
          </div>
        )}
        {recheckSections.length > 0 && (
          <div className="edit-recheck" role="status">
            {EDIT.listRecheck(recheckSections.map((id) => titles[id] ?? id).join(' · '))}
          </div>
        )}
        {rows.length === 0 && <PopRow>{EDIT.listEmpty}</PopRow>}
        {rows.map((row) => (
          <div className="edit-row" key={row.edit_id}>
            {(row.edits.length ? row.edits : [{ section_id: row.section_ids[0] ?? '', before_block: '', after_block: '' }]).map((edit, i) => {
              const preview = editPreview(edit.before_block, edit.after_block)
              return (
                <div key={`${row.edit_id}:${i}`}>
                  <div className="where">{titles[edit.section_id] ?? edit.section_id}</div>
                  <div className="what">
                    {preview.lead}
                    <del>{preview.removed}</del>
                    {preview.added && <ins>{preview.added}</ins>}
                    {preview.trail}
                  </div>
                </div>
              )
            })}
            <div className="meta">
              <span className="state" data-state={row.state}>
                {row.answered ? EDIT.listState.answered : EDIT.listState[row.state] ?? row.state}
              </span>
              <span>{clock(row.at)}</span>
              {/* 이미 보낸 건은 다음 메시지에 저절로 다시 붙지 않는다(같은 말 반복 방지, §6-3).
                  다시 확인받고 싶으면 학생이 여기서 되돌린다 — 되돌린 건은 `pending` 이 된다. */}
              {row.state === 'sent' && (
                <button type="button" className="lnk" onClick={() => onAskAgain(row.edit_id)}>{EDIT.askAgain}</button>
              )}
            </div>
          </div>
        ))}
      </Popover>
    </div>
  )
}
