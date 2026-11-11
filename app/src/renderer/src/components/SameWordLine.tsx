import { useMemo, useState } from 'react'
import { EDIT } from '../editcopy'
import { findPlaces, mergeSameWordPicks, type BatchEdit, type Place, type SectionDraft, type Suggestion } from '../../../shared/sameword'

/**
 * 저장 직후 "다른 곳에도 같은 말이 있어요" 한 줄과 목록 (설계 §3-4, §4-5-8 02·03·08).
 *
 * AI 없이, 이미 읽어 둔 본문에서만 찾는다 — 토큰 0. 이 컴포넌트는 **보여 주고 고르는 일**만
 * 하고, 실제 저장은 부모(`PaperPane`)가 `section.edit_batch` 한 번으로 한다.
 *
 * §4-5-8이 정한 세 가지:
 * - **02**: 제안은 그 순간의 본문에 대한 것이다. 본문이 바뀌면 부모가 이 줄을 접는다 —
 *   여기서 체크 상태를 다른 자리로 옮겨 붙이지 않는다(그래서 자리마다 안정적인 열쇠를 쓴다).
 * - **03**: `같이 고치기`는 **목록을 열기만** 한다. 저장은 목록 안의 `n군데 고치기`에서만.
 *   첫 클릭에 저장 호출이 없다(§3-4 표). `모두 보기`는 같은 목록을 연다 — 자리로 가는 단추가 있다.
 * - **08**: `그대로`는 그 낱말 제안 한 줄을 닫는다(다른 낱말 제안은 남는다).
 *
 * 지운 낱말(`to` 가 빈 문자열)은 기계로 같이 지우면 문장이 깨지므로 `같이 고치기` 대신
 * `도우미에게 맡기기` 다 — 입력칸에 문장을 채워 주고 보내는 것은 학생이다(§3-4 표).
 */

/** 자리 하나의 안정적인 열쇠 — 배열 차례(index)가 아니라 그 자리 자체. */
function placeKey(place: Place): string {
  return `${place.section_id}\u0000${place.block_index}\u0000${place.start}\u0000${place.end}`
}

export function SameWordLine({ suggestion, sections, busy, onBatch, onShowPlace, onAskHelper, onDismiss }: {
  suggestion: Suggestion
  /** 지금 읽어 둔 절 본문들 — 목록의 자리를 세는 데 쓴다. */
  sections: SectionDraft[]
  busy: boolean
  onBatch: (edits: BatchEdit[]) => void
  /** 그 자리로 가서 낱말을 잠깐 칠한다 — 거기서 다시 드래그해 `직접 수정`. */
  onShowPlace: (place: Place) => void
  /** 지움일 때만 — 입력칸에 채울 문장. */
  onAskHelper: (draft: string) => void
  /** `그대로` — 이 낱말 제안 한 줄을 닫는다(§4-5-8 08). */
  onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  // 체크 해제는 **자리 열쇠**로 기억한다 — 본문이 바뀌어 차례가 밀려도 다른 자리를 켜지 않는다.
  const [unchecked, setUnchecked] = useState<Record<string, true>>({})
  const places = useMemo(() => findPlaces(sections, suggestion.from), [sections, suggestion.from])
  const removal = suggestion.to === ''

  const picks = places.filter((place) => unchecked[placeKey(place)] !== true)
  const toggle = (place: Place): void => setUnchecked((c) => {
    const key = placeKey(place)
    const next = { ...c }
    if (next[key]) delete next[key]
    else next[key] = true
    return next
  })
  // 지금 본문에서 다시 센 값으로 말한다 — 0군데면 아예 접는다(§3-4 참고: 낡은 제안은 접는다).
  if (places.length === 0) return null

  return (
    <div className="sameword-wrap">
      <div className="sameword">
        <span>{EDIT.elsewhere(suggestion.from, places.length)}</span>
        {/* `같이 고치기` — 목록을 연다. 저장은 아래 `n군데 고치기`에서만(§3-4, Roh 03). */}
        {!removal && (
          <button type="button" className="sm" aria-expanded={open}
            onClick={() => setOpen(true)}>{EDIT.fixTogether}</button>
        )}
        {removal && (
          <button type="button" className="sm" onClick={() => onAskHelper(EDIT.askHelperDraft(suggestion.from))}>{EDIT.askHelper}</button>
        )}
        <button type="button" className="lnk" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{EDIT.showAll}</button>
        <button type="button" className="lnk" onClick={onDismiss}>{EDIT.keep}</button>
      </div>
      {open && (
        <div className="sameword-list" role="group" aria-label={EDIT.fixTogether}>
          {places.map((place) => (
            <div key={placeKey(place)} className="sameword-place">
              <label>
                <input type="checkbox" checked={unchecked[placeKey(place)] !== true} onChange={() => toggle(place)} />
              </label>
              <span>
                <span className="ctx">{place.context}</span>
                <small>
                  <button type="button" className="lnk" onClick={() => onShowPlace(place)}>{EDIT.showAll}</button>
                </small>
              </span>
            </div>
          ))}
          <div className="sameword-actions">
            <button type="button" className="sm" disabled={busy || picks.length === 0}
              onClick={() => onBatch(mergeSameWordPicks(picks, suggestion.to))}>
              {EDIT.fixTogetherLead(picks.length)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 그 낱말을 잠깐 칠한다 — 목록에서 한 자리를 눌렀을 때(§3-4).
 *
 * **원고 자수를 화면 자수로 쓰지 않는다.** 마크다운 기호(`**`, `[]()`, `` ` ``)는 화면에
 * 없으므로 자수가 1:1이 아니다. 대신 "그 문단 안에서 이 낱말이 몇 번째로 나오는가"를
 * 원고에서 세고, 같은 차례의 낱말을 화면 글자에서 찾아 칠한다 — 낱말 뜻이 같으니 화면에서도
 * 같은 낱말이고, 어긋나도 다른 글자를 칠하지 않는다. 못 찾으면 스크롤만 한다.
 */
export function flashWord(block: HTMLElement, beforeBlock: string, start: number, end: number): void {
  block.scrollIntoView({ block: 'center' })
  const word = beforeBlock.slice(start, end)
  if (!word) return
  // 원고에서 이 자리 앞에 같은 낱말이 몇 번 나왔는가(겹치지 않게, 앞에서부터).
  let nth = 0
  for (let i = 0; i + word.length <= start; i++) {
    if (beforeBlock.startsWith(word, i)) { nth += 1; i += word.length - 1 }
  }

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node: Node | null = walker.nextNode()
  while (node) { nodes.push(node as Text); node = walker.nextNode() }
  const full = nodes.map((n) => n.data).join('')
  let at = -1
  let from = 0
  for (let k = 0; k <= nth; k++) {
    at = full.indexOf(word, from)
    if (at < 0) return
    from = at + word.length
  }
  let seen = 0
  for (const textNode of nodes) {
    const end2 = seen + textNode.data.length
    if (at < end2) {
      const a = at - seen
      const b = Math.min(textNode.data.length, a + word.length)
      const range = document.createRange()
      range.setStart(textNode, a)
      range.setEnd(textNode, b)
      const mark = document.createElement('span')
      mark.className = 'sameword-flash'
      try { range.surroundContents(mark) } catch { return }
      setTimeout(() => {
        const parent = mark.parentNode
        if (!parent) return
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
      }, 1200)
      return
    }
    seen = end2
  }
}
