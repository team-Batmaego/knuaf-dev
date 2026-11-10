import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { CHAT } from '../copy'

/**
 * 한 턴의 중간말 묶음 — Claude·Codex 앱처럼 "작업 과정 보기 (N)" 한 줄로 접는다.
 *
 * 형님 지시(2026-11-09): "이런 말들은 그냥 실제 AI app 처럼 접기? 형식으로 하는 게 낫지 않나?"
 * 접어도 **지우지 않는다** — 펼치면 원문 그대로다. 왼쪽 색선·배경 띠 없이 글자·아이콘만 쓴다
 * (`~/.claude/docs/frontend.md`).
 */
export function ProgressFold({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="progress-fold">
      <button type="button" className="progress-fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevron'} size={13} />
        <span>{open ? CHAT.progressHide : CHAT.progressShow(count)}</span>
      </button>
      {open && <div className="progress-fold-body">{children}</div>}
    </div>
  )
}
