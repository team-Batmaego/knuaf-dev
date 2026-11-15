import { REVIEW } from '../copy'
import { EDIT } from '../editcopy'

/** `직접 수정` 이 눌리지 않는 이유 — 문자열이면 그 이유로 흐리게 둔다(설계 §3-1). */
export type EditBlock = keyof typeof EDIT.blocked | null

/**
 * 발주 QA2-B · N-I03 — 종이에서 문장을 고르면 선택 위에 뜨는 작은 행동 막대.
 *
 * `고쳐 달라기`는 고른 문장을 인용 칩으로 붙이고, `직접 수정`은 그 자리에 편집칸을 열고,
 * `복사`는 클립보드를 쓴다. 막대 자신을 누를 때 선택이 풀리지 않게 `onMouseDown` 을 막는다 —
 * 그래야 누른 뒤에도 무엇을 골랐는지가 화면에 남는다.
 *
 * `직접 수정`은 **숨기지 않는다**(설계 §3-1). 눌리지 않을 때는 흐리게 두고 왜 그런지 툴팁으로
 * 말한다 — 있다가 없다가 하면 처음 쓰는 학생이 헷갈린다.
 */
export function ReviewSelectBar({ x, top, bottom, paneWidth, onQuote, onCopy, onEdit, editBlock }: {
  x: number
  /** 선택 위쪽 모서리 — 막대를 이 위에 얹는다. */
  top: number
  /** 선택 아래쪽 모서리 — 위가 좁으면 아래로 뒤집는다. */
  bottom: number
  paneWidth: number
  onQuote: () => void
  onCopy: () => void
  /** 없으면 `직접 수정` 을 그리지 않는다(1묶음 메서드가 없는 실행기). */
  onEdit?: () => void
  editBlock?: EditBlock
}) {
  const below = top < 56
  const left = Math.max(84, Math.min(Math.max(paneWidth - 84, 84), x))
  const reason = editBlock ?? null
  return (
    <div className="selbar" data-below={below || undefined} style={{ left: `${left}px`, top: `${below ? bottom + 8 : top}px` }}
      onMouseDown={(e) => e.preventDefault()}>
      <button type="button" onClick={onQuote}>{REVIEW.quote}</button>
      {onEdit && (
        <button type="button" className="selbar-edit" data-blocked={reason || undefined}
          title={reason ? EDIT.blocked[reason] : undefined}
          aria-disabled={reason ? true : undefined}
          onClick={() => { if (!reason) onEdit() }}>{EDIT.button}</button>
      )}
      <button type="button" onClick={onCopy}>{REVIEW.copy}</button>
    </div>
  )
}
