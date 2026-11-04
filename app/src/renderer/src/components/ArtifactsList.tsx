import { useRef, type ReactNode } from 'react'
import type { ListIntent } from '../store/project'
import { useListIntent } from './useListIntent'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { MENUS } from '../copy-menus'

export type ArtifactListItem = { path: string; name: string; status?: string }
export type ArtifactMakeAction = { id: string; label: string; description: string; disabled: boolean; feedback?: ReactNode }

export function ArtifactsList({ open, onOpenChange, listIntent, consumeListIntent, items, actions, stale, notice, error, loading, onOpenFile, onMake, onRetry, onReveal }: {
  open: boolean
  listIntent: ListIntent | null
  consumeListIntent: (seq: number) => void
  onOpenChange: (open: boolean) => void
  items: ArtifactListItem[]
  actions: ArtifactMakeAction[]
  stale: boolean
  notice?: { title: string; body: string } | null
  error?: string | null
  loading: boolean
  onOpenFile: (path: string, fallback: HTMLElement | null) => void
  onMake: (id: string) => void
  onRetry: () => void
  onReveal: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  useListIntent(listIntent, 'files', onOpenChange, consumeListIntent)
  return <div className="pop-host">
    <button ref={button} type="button" className="lnk" style={open ? { background: 'var(--sel-bg)' } : undefined} data-focus-key="head-files" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      {stale && <span className="dot attn" aria-label="다시 만들 파일이 있어요" />}
      <Icon name="box" size={14} />{MENUS.files(items.length)}
    </button>
    <Popover open={open} onClose={() => onOpenChange(false)} align="right" width={400} label={MENUS.files(items.length)}>
      <PopHead>{MENUS.make}</PopHead>
      {actions.map((action) => <div key={action.id} className="pop-make-block" data-make={action.id}>
        <div className={`pop-make${action.disabled ? ' off' : ''}`}>
          <span className="c"><b>{action.label}</b><small>{action.description}</small></span>
          <button type="button" className="quiet" disabled={action.disabled} onClick={() => onMake(action.id)}>{MENUS.make}</button>
        </div>{action.feedback}
      </div>)}
      <PopSep />
      <PopHead>{MENUS.madeFiles}</PopHead>
      {notice && <div className="pop-empty caption" role="status"><strong>{notice.title}</strong> {notice.body}</div>}
      <div className="pop-scroll">
        {error ? <div className="pop-empty" role="alert">{error} <button type="button" className="quiet" onClick={onRetry}>{MENUS.retry}</button></div>
          : !loading && items.length === 0 ? <div className="pop-empty caption">{MENUS.noFiles}</div>
            : items.map((file) => <PopRow key={file.path} icon={<Icon name="doc" size={16} />} meta={file.status} onClick={() => { onOpenChange(false); onOpenFile(file.path, button.current) }}>{file.name}</PopRow>)}
      </div>
      <PopSep />
      <PopRow icon={<Icon name="folder" size={16} />} onClick={onReveal}>{MENUS.reveal}</PopRow>
    </Popover>
  </div>
}
