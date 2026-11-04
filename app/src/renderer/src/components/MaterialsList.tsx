import { useRef } from 'react'
import type { ListIntent } from '../store/project'
import { useListIntent } from './useListIntent'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { MENUS } from '../copy-menus'

export type MaterialListItem = { path: string; name: string }
export type CurrentMaterial = { label: string; file: MaterialListItem | null }

export function MaterialsList({ open, onOpenChange, listIntent, consumeListIntent, count, current, references, onOpenFile, onAttach, onAddMaterial }: {
  open: boolean
  count: number
  listIntent: ListIntent | null
  consumeListIntent: (seq: number) => void
  onOpenChange: (open: boolean) => void
  current: CurrentMaterial[]
  references: MaterialListItem[]
  onOpenFile: (path: string, fallback: HTMLElement | null) => void
  onAttach: (path: string) => void
  onAddMaterial: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  useListIntent(listIntent, 'materials', onOpenChange, consumeListIntent)
  const openFile = (path: string) => { onOpenChange(false); onOpenFile(path, button.current) }
  return <div className="pop-host">
    <button ref={button} type="button" className="lnk" style={open ? { background: 'var(--sel-bg)' } : undefined} data-focus-key="head-materials" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <Icon name="files" size={14} />{MENUS.materials(count)}
    </button>
    <Popover open={open} onClose={() => onOpenChange(false)} align="right" width={380} label={MENUS.materials(count)}>
      <PopHead>{MENUS.current}</PopHead>
      {current.map(({ label, file }) => <PopRow key={label} icon={<Icon name="doc" size={16} />} onClick={file ? () => openFile(file.path) : undefined}>
        <span className="c"><b>{label}</b><small title={file?.path}>{file?.name ?? MENUS.missing}</small></span>
      </PopRow>)}
      <PopSep />
      <PopHead>{MENUS.references}</PopHead>
      <div className="pop-scroll">
        {references.map((file) => <div key={file.path} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}><PopRow icon={<Icon name="doc" size={16} />} onClick={() => openFile(file.path)}><span title={file.path}>{file.name}</span></PopRow></div>
          <button type="button" className="quiet" onClick={() => { onOpenChange(false); onAttach(file.path) }}>{MENUS.attach}</button>
        </div>)}
      </div>
      <PopSep />
      <PopRow icon={<Icon name="plus" size={16} />} onClick={() => { onOpenChange(false); onAddMaterial() }}>{MENUS.addMaterial}</PopRow>
    </Popover>
  </div>
}
