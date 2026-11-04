import { useEffect, useRef } from 'react'
import { SettingsScreen } from '../screens/Settings'
import { CLOSE_LABEL, SETTINGS } from '../copy'
import { Icon } from './Icon'

/** Native modal dialog traps focus and restores it to the opener on close. */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = () => {
    onClose()
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-focus-key="settings"]')?.focus())
  }
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
    return () => { if (dialog.open) dialog.close() }
  }, [open])
  return <dialog ref={ref} className="sheet" data-screen="settings" aria-labelledby="settings-modal-title"
    style={{ width: 'min(780px, calc(100vw - 48px))', height: 'min(600px, calc(100vh - 96px))', maxWidth: 'none', ...(open ? { display: 'flex', flexDirection: 'column' } : {}) }}
    onCancel={(event) => { event.preventDefault(); close() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
    }}>
    <div className="sheet-head"><h2 id="settings-modal-title">{SETTINGS.title}</h2><button type="button" className="quiet" aria-label={CLOSE_LABEL} onClick={close}><Icon name="x" /></button></div>
    <div className="sheet-body" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}><SettingsScreen /></div>
  </dialog>
}
