import { useEffect } from 'react'
import { useProject } from '../store/project'
import { PAPER_PANE_COPY as COPY } from '../copy-paper'

export function PaneHandle({ folded }: { folded: boolean }) {
  const closed = useProject((s) => s.paperClosed)
  const notice = useProject((s) => s.foldNotice)
  const setClosed = useProject((s) => s.setPaperClosed)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') { event.preventDefault(); setClosed(!useProject.getState().paperClosed) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setClosed])
  const label = folded ? COPY.expand : COPY.collapse
  return <button type="button" aria-controls="paperpane" aria-expanded={!closed} aria-label={`${label}${folded && notice ? ` · ${COPY.unseen}` : ''}`} title={`${label} ⌘\\`}
    onClick={() => { setClosed(!closed); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-controls="paperpane"]')?.focus()) }} style={{ position: 'absolute', zIndex: 7, top: '50%', ...(folded ? { right: 12, height: 34, padding: '0 12px 0 8px', borderRadius: 10 } : { left: 0, transform: 'translate(-50%, -50%)', width: 28, height: 28, borderRadius: '50%', padding: 0 }), ...(folded ? { transform: 'translateY(-50%)' } : {}), border: 'var(--hairline) solid var(--line-strong)', background: 'var(--panel)', color: 'var(--ink-2)' }}>
    {folded ? '‹ 내 논문' : '›'}{folded && notice && <span aria-hidden="true" style={{ position: 'absolute', right: -1, top: -1, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 2px var(--bg)' }} />}
  </button>
}
