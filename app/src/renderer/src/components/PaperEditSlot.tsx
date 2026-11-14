import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderMarkdown } from '../markdown'
import { EDIT } from '../editcopy'

/**
 * 드래그한 글자 자리에 그대로 열리는 한 줄 입력칸 (설계 §3-2, 정제 2-3).
 *
 * HTML 문자열을 잘라 내지 않는다 — 고칠 문단의 원고에서 대상 글자를 **영숫자 표식**으로
 * 바꿔 마크다운을 다시 그리고, 그려진 DOM 에서 표식 글자 노드를 찾아 `<span>` 으로 감싼 뒤
 * `createPortal` 로 입력칸을 그 안에 올린다. `<p>`·`<li>`·`<td>` 어디서든 문단 구조가 그대로
 * 남고, 한글 입력기 이벤트를 React 가 받는다.
 *
 * 원고에 우연히 같은 표식이 있으면 난수를 바꿔 다시 그린다(그때만 한 번 더 그린다).
 */
const MARK = 'GGEDITSLOT'

function markerFor(seed: number): string {
  // 마크다운·HTML 이스케이프에 안 걸리는 글자만 쓴다(영숫자).
  return `${MARK}${seed.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

/** 대상 구간을 표식으로 바꾼 문단 원고 — 표식은 문단 안에 정확히 한 번 들어간다. */
function markedBlock(block: string, start: number, end: number, marker: string): string {
  return block.slice(0, start) + marker + block.slice(end)
}

export function PaperEditSlot({ block, start, end, value, onChange, onSave, onCancel }: {
  /** 고칠 문단의 원고(마크다운). */
  block: string
  /** 그 문단 안에서 고칠 구간. */
  start: number
  end: number
  /** 입력칸의 지금 글자 — 부모가 쥔다(저장·취소 판정이 같은 값을 봐야 한다). */
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [marker, setMarker] = useState(() => markerFor(block.length + start))
  const input = useRef<HTMLInputElement>(null)
  /** 입력칸 밖을 눌렀는가 — 글자가 바뀌었으면 취소하지 않는다(§3-2). */
  const dirty = value !== block.slice(start, end)
  /** 결과 문단이 비면 저장할 수 없다(§3-2). 저장 단추도 그래야 거짓말하지 않는다. */
  const empty = !(block.slice(0, start) + value + block.slice(end)).trim()

  // 원고에 같은 표식이 이미 있으면 한 번만 다른 난수로 다시 그린다.
  useEffect(() => {
    if (!block.includes(marker)) return
    setMarker(markerFor(block.length + start + 7))
  }, [block, marker, start])

  const html = renderMarkdown(markedBlock(block, start, end, marker))

  useLayoutEffect(() => {
    const root = host.current
    if (!root) { setSlot(null); return }
    // 표식이 들어 있는 **글자 노드**를 찾아 셋으로 쪼갠다: 앞 글자 · 표식 자리 · 뒤 글자.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    let at = -1
    while (node) {
      const i = (node.nodeValue ?? '').indexOf(marker)
      if (i >= 0) { at = i; break }
      node = walker.nextNode()
    }
    if (!node || at < 0) { setSlot(null); return }
    const text = node.nodeValue ?? ''
    const parent = node.parentNode
    if (!parent) { setSlot(null); return }
    const anchor = document.createElement('span')
    anchor.className = 'edit-slot-anchor'
    anchor.dataset.editSlot = '1'
    parent.insertBefore(document.createTextNode(text.slice(0, at)), node)
    parent.insertBefore(anchor, node)
    parent.insertBefore(document.createTextNode(text.slice(at + marker.length)), node)
    parent.removeChild(node)
    setSlot(anchor)
    return () => { setSlot(null) }
  }, [html, marker])

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
  }, [slot])

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onSave(); return }
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }

  return (
    <div className="paper-edit" ref={host}>
      {/* 고친 문단은 여기서 한 번 더 그려진다 — 편집 중에는 폴링 재그리기가 이 문단을 건드리지 않는다. */}
      <div className="blk editing" dangerouslySetInnerHTML={{ __html: html }} />
      {slot && createPortal(
        <span className="edit-slot">
          <input
            ref={input}
            className="edit-slot-input"
            aria-label={EDIT.slotLabel}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
            onKeyDown={onKey}
            onBlur={() => { if (!dirty) onCancel() }}
          />
          <span className="edit-slot-actions" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" className="accent sm" disabled={empty} onClick={onSave}>{EDIT.save}</button>
            <button type="button" className="quiet" onClick={onCancel}>{EDIT.cancel}</button>
          </span>
        </span>,
        slot
      )}
    </div>
  )
}
