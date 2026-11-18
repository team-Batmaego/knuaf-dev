import { useEffect, useRef, useState } from 'react'
import type { NewsState } from '../../../shared/types'
import { NEWS } from '../copy-news'
import { ReleaseNotesList } from './ReleaseNotesList'

export function NewsDialog({ state, onSeen }: { state: NewsState; onSeen: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); return () => { if (dialog?.open) dialog.close() } }, [])
  const acknowledge = async () => {
    setBusy(true); setFailed(false)
    try { await window.knuaf.news.seen({ app: state.app, skill: state.skill }); onSeen() } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <dialog ref={ref} className="sheet news-dialog" aria-labelledby="news-dialog-title" onCancel={e => e.preventDefault()}>
    <div className="sheet-head"><h2 id="news-dialog-title">{NEWS.title}</h2></div>
    <div className="sheet-body"><ReleaseNotesList state={state} notes={state.unread} current={false} />{failed && <p role="alert">{NEWS.saveFailed}</p>}</div>
    <div className="sheet-foot"><button className="primary" disabled={busy} onClick={() => void acknowledge()}>{NEWS.acknowledge}</button></div>
  </dialog>
}
