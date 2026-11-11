import { useMemo, useState } from 'react'
import { EDIT } from '../editcopy'
import { findPlaces, mergeSameWordPicks, type BatchEdit, type Place, type SectionDraft, type Suggestion } from '../../../shared/sameword'

/**
 * 저장 직후 "다른 곳에도 같은 말이 있어요" 한 줄과 목록 (설계 §3-4).
 *
 * AI 없이, 이미 읽어 둔 본문에서만 찾는다 — 토큰 0. 찾을 낱말은 부모가 정해 준다
 * (`sameWordSuggestions`). 이 컴포넌트는 **보여 주고 고르는 일**만 하고, 실제 저장은
 * 부모(`PaperPane`)가 `section.edit_batch` 한 번으로 한다.
 *
 * 지운 낱말(`to` 가 빈 문자열)은 기계로 같이 지우면 문장이 깨지므로 `같이 고치기` 대신
 * `도우미에게 맡기기` 다 — 입력칸에 문장을 채워 주고 보내는 것은 학생이다(§3-4 표).
 */
export function SameWordLine({ suggestion, sections, busy, onBatch, onShowPlace, onAskHelper }: {
  suggestion: Suggestion
  /** 지금 읽어 둔 절 본문들 — `모두 보기` 목록의 자리를 세는 데 쓴다. */
  sections: SectionDraft[]
  busy: boolean
  onBatch: (edits: BatchEdit[]) => void
  /** 그 자리로 가서 낱말을 잠깐 칠한다 — 거기서 다시 드래그해 `직접 수정`. */
  onShowPlace: (place: Place) => void
  /** 지움일 때만 — 입력칸에 채울 문장. */
  onAskHelper: (draft: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const places = useMemo(() => findPlaces(sections, suggestion.from), [sections, suggestion.from])
  const removal = suggestion.to === ''

  // 목록은 전부 체크된 상태로 뜬다 — 빼고 싶은 곳만 체크를 끈다(§3-4 `같이 고치기`).
  const picks = places.filter((_, i) => checked[i] !== false)
  const toggle = (i: number): void => setChecked((c) => ({ ...c, [i]: c[i] === false }))
  // 지금 본문에서 다시 센 값으로 말한다 — 한 줄이 떠 있는 사이 본문이 바뀌면 그 제안은 낡은
  // 것이고, 0군데면 아예 접는다(§3-4 참고: 낡은 제안은 접는 쪽이 안전하다).
  if (places.length === 0) return null

  return (
    <div className="sameword-wrap">
      <div className="sameword">
        <span>{EDIT.elsewhere(suggestion.from, places.length)}</span>
        <button type="button" className="lnk" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{EDIT.showAll}</button>
        {/* 주된 단추 하나만 단추답게 — 나머지는 가벼운 글자 단추로 둔다(ADD4 3번). */}
        {removal
          ? <button type="button" className="sm" onClick={() => onAskHelper(EDIT.askHelperDraft(suggestion.from))}>{EDIT.askHelper}</button>
          : <button type="button" className="sm" disabled={busy || picks.length === 0}
            onClick={() => onBatch(mergeSameWordPicks(picks, suggestion.to))}>{EDIT.fixTogether}</button>}
        <button type="button" className="lnk" onClick={() => setOpen(false)}>{EDIT.keep}</button>
      </div>
      {open && (
        <div className="sameword-list" role="group" aria-label={EDIT.showAll}>
          {places.map((place, i) => (
            <label key={`${place.section_id}:${place.block_index}:${place.start}`} className="sameword-place">
              <input type="checkbox" checked={checked[i] !== false} onChange={() => toggle(i)} />
              <span>
                <span className="ctx">{place.context}</span>
                <small>
                  <button type="button" className="lnk" onClick={() => onShowPlace(place)}>{EDIT.showAll}</button>
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/** 목록에서 `n군데 고치기` — 부모가 만든 체크 목록으로 부른다. */
export function sameWordBatchLabel(n: number): string {
  return EDIT.fixTogetherLead(n)
}

/**
 * 그 낱말을 잠깐 칠한다 — `모두 보기` 목록에서 한 자리를 눌렀을 때(§3-4).
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
  // 화면 글자 전체에서 nth 번째 낱말의 위치를 찾는다.
  const full = nodes.map((n) => n.data).join('')
  let at = -1
  let from = 0
  for (let k = 0; k <= nth; k++) {
    at = full.indexOf(word, from)
    if (at < 0) return
    from = at + word.length
  }
  // 그 자리가 어느 글자 노드의 어디인가.
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
