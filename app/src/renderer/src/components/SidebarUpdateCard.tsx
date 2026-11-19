import { SUPPORT } from '../copy-support'
import { useUpdates } from './Updates'

export function SidebarUpdateCard() {
  const app = useUpdates(s => s.app)
  const show = useUpdates(s => s.setDialog)
  const available = app?.phase === 'blocked' || !!app?.latest && ['available', 'interrupted', 'error', 'downloading', 'preparing', 'launching'].includes(app.phase)
  if (!available) return null
  return <div className="sidebar-update-card">
    <div><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h18v4H3zM5 12v8h14v-8M12 8v12M12 8C7 8 6 6.5 7 4.5 8 2.5 11 4 12 8Zm0 0c5 0 6-1.5 5-3.5C16 2.5 13 4 12 8Z" /></svg>{SUPPORT.updateReady}</div>
    <button onClick={() => show(true)}>{SUPPORT.update}</button>
  </div>
}
