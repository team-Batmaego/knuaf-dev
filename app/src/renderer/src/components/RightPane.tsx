import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { Preview } from './Preview'
import { PreviewActions } from './PreviewActions'
import { Feedback } from './Feedback'
import { ARTIFACTS, PREVIEW, describeError } from '../copy'
import { PAPER_PANE_COPY as COPY } from '../copy-paper'
import { joinPath } from '../paths'

export function RightPane({ paper }: { paper: ReactNode }) {
  const root = useProject((s) => s.root)
  const path = useProject((s) => s.docPath)
  const tab = useProject((s) => s.paneTab)
  const setTab = useProject((s) => s.setPaneTab)
  const items = useProject((s) => s.artifacts)
  const loadLists = useProject((s) => s.loadLists)
  const paperTab = useRef<HTMLButtonElement>(null)
  const fileTab = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const requestId = useRef(0)
  useEffect(() => { requestId.current += 1; setError(null); setSaved(null) }, [root, path])
  const close = () => {
    requestId.current += 1
    const state = useProject.getState()
    const target = state.docReturn
    const fallback = state.closePreview()
    requestAnimationFrame(() => {
      const el = target?.key ? Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).find((node) => node.dataset.focusKey === target.key && node.isConnected && node.offsetParent !== null) : null
      ;(el ?? (fallback?.trigger?.isConnected && fallback.trigger.offsetParent !== null ? fallback.trigger : null) ?? (target?.view === 'paper' ? document.querySelector<HTMLElement>('.paperpane button') : null) ?? document.querySelector<HTMLElement>('textarea'))?.focus({ preventScroll: true })
    })
  }
  useEffect(() => {
    if (!path || tab !== 'file') return
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (fileTab.current?.contains(document.activeElement) || document.activeElement?.closest('[data-doc-content]'))) { event.stopPropagation(); close() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [path, tab])
  if (!path || !root) return <>{paper}</>
  const name = path.split(/[\\/]/).at(-1) ?? path
  const item = items?.find((candidate) => joinPath(root, candidate.path) === path)
  const readError = (err: { code: string; message: string }) => {
    if (useProject.getState().docPath !== path || useProject.getState().root !== root) return
    if (err.code === 'not_openable') { close(); void window.knuaf.openFileLink(path); return }
    if (err.code === 'not_found' || err.code === 'outside_project') {
      useProject.getState().closePreview()
      useProject.getState().setPreviewNotice(err.code === 'outside_project' ? { title: COPY.outsideProject, body: '' } : { title: COPY.notFound(name), body: COPY.otherFiles })
      useProject.getState().openList('files')
      return
    }
    setError(PREVIEW.readFailedBody)
  }
  const open = async () => {
    const id = ++requestId.current
    const result = await window.knuaf.openPath(path)
    if (requestId.current !== id || useProject.getState().docPath !== path || useProject.getState().root !== root) return
    if ('error' in result) setError(result.error.message)
    else if (result.result.reason === 'open_failed') setError(ARTIFACTS.openFallback)
  }
  const save = async () => {
    if (!item) return
    const id = ++requestId.current
    const result = await window.knuaf.fileSaveAs(root, item.path)
    if (requestId.current !== id || useProject.getState().docPath !== path || useProject.getState().root !== root) return
    if (result.error) setError(describeError(result.error).title)
    else if (result.result) setSaved(String(result.result))
  }
  const selected = (on: boolean): React.CSSProperties => ({ border: 'var(--hairline) solid', borderColor: on ? 'var(--line)' : 'transparent', background: on ? 'var(--bg)' : 'transparent', fontWeight: on ? 600 : 400, borderRadius: '10px 10px 0 0', padding: '7px 12px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
    <div role="tablist" aria-label={COPY.tabList} style={{ display: 'flex', height: 42, alignItems: 'end', padding: '7px 12px 0', background: 'var(--bg-2)', borderBottom: 'var(--hairline) solid var(--line)' }} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = tab === 'paper' ? 'file' : 'paper'; setTab(next); (next === 'paper' ? paperTab : fileTab).current?.focus() } }}>
      <button ref={paperTab} role="tab" aria-selected={tab === 'paper'} tabIndex={tab === 'paper' ? 0 : -1} style={selected(tab === 'paper')} onClick={() => setTab('paper')}>{COPY.paperTab}</button>
      <button ref={fileTab} role="tab" aria-selected={tab === 'file'} tabIndex={tab === 'file' ? 0 : -1} title={name} style={selected(tab === 'file')} onClick={() => setTab('file')}>{name}</button>
      <button aria-label={COPY.closeFile} onClick={close}>×</button>
    </div>
    {tab === 'paper' ? paper : <section data-doc-content style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 20px', minHeight: 56, borderBottom: 'var(--hairline) solid var(--line)' }}><strong title={name}>{name}</strong><span style={{ flex: 1 }} />{item && <button onClick={() => void save()}>{ARTIFACTS.save}</button>}<PreviewActions path={path} onOpen={() => void open()} /></header>
      <div style={{ flex: 1, overflow: 'auto', padding: '22px 26px', background: 'var(--desk)' }}>
        {/\.(xlsx|xlsm)$/i.test(path) && <p className="caption">{COPY.excelHint}</p>}
        {saved && <p role="status">{saved}</p>}{error && <Feedback kind="warning" title={PREVIEW.loadFailed} body={error} />}
        <Preview root={root} item={item} target={path} items={items ?? []} onRendered={() => void loadLists()} onReadError={readError} onUnsupported={(payload) => { close(); if (!payload.openable) void window.knuaf.openFileLink(path) }} />
      </div>
    </section>}
  </div>
}
