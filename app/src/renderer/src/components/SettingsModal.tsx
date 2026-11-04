import { useEffect, useRef } from 'react'
import { SettingsScreen } from '../screens/Settings'
import { CLOSE_LABEL, SETTINGS } from '../copy'
import { Icon } from './Icon'

/** Native modal dialog traps focus and restores it to the opener on close. */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
    return () => { if (dialog.open) dialog.close() }
  }, [open])
  return <dialog ref={ref} className="sheet" data-screen="settings" aria-labelledby="settings-modal-title"
    style={{ width: 'min(780px, calc(100vw - 48px))', height: 'min(600px, calc(100vh - 96px))', maxWidth: 'none', ...(open ? { display: 'flex', flexDirection: 'column' } : {}) }}
    onCancel={(event) => { event.preventDefault(); onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
    }}>
    <div className="sheet-head"><h2 id="settings-modal-title">{SETTINGS.title}</h2><button type="button" className="quiet" aria-label={CLOSE_LABEL} onClick={onClose}><Icon name="x" /></button></div>
    <div className="sheet-body" style={{ overflow: 'auto', flex: 1 }}><SettingsScreen /></div>
  </dialog>
}
