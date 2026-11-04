import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { MENUS } from '../copy-menus'

export type ArtifactListItem = { path: string; name: string; status?: string }
export type ArtifactMakeAction = { id: string; label: string; description: string; disabled: boolean; feedback?: ReactNode }

export function ArtifactsList({ open, onOpenChange, items, actions, stale, notice, error, loading, onOpenFile, onMake, onRetry, onReveal }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ArtifactListItem[]
  actions: ArtifactMakeAction[]
  stale: boolean
  notice?: string | null
  error?: string | null
  loading: boolean
  onOpenFile: (path: string) => void
  onMake: (id: string) => void
  onRetry: () => void
  onReveal: () => void
}) {
  return <div className="pop-host">
    <button type="button" className="lnk" style={open ? { background: 'var(--sel-bg)' } : undefined} data-focus-key="head-files" aria-expanded={open} onClick={() => onOpenChange(!open)}>
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
      {notice && <div className="pop-empty caption" role="status">{notice}</div>}
      <div className="pop-scroll">
        {error ? <div className="pop-empty" role="alert">{error} <button type="button" className="quiet" onClick={onRetry}>{MENUS.retry}</button></div>
          : !loading && items.length === 0 ? <div className="pop-empty caption">{MENUS.noFiles}</div>
            : items.map((file) => <PopRow key={file.path} icon={<Icon name="doc" size={16} />} meta={file.status} onClick={() => { onOpenChange(false); onOpenFile(file.path) }}>{file.name}</PopRow>)}
      </div>
      <PopSep />
      <PopRow icon={<Icon name="folder" size={16} />} onClick={onReveal}>{MENUS.reveal}</PopRow>
    </Popover>
  </div>
}
