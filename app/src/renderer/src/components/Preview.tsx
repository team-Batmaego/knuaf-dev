import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
// The legacy build is required: pdfjs 6.x uses Uint8Array.toHex, missing in Electron 37's Chromium.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ArtifactItem, PreviewPayload } from '../../../shared/types'
import { joinPath } from '../paths'
import { describeError, type DescribedError } from '../copy'
import { useRunner } from './useRunner'
import { Feedback } from './Feedback'
import { Badge } from './Badge'
import { SegmentedControl } from './SegmentedControl'
import { ProgressPanel } from './ProgressPanel'
import { COMPLETION, PREVIEW, officeHint } from '../copy'
import { versioned } from '../screens/Outputs'

// Detach ④ by removing this file, docx-preview and this one lazy import.
const DocxHtmlView = lazy(() => import('./DocxHtmlView').then((m) => ({ default: m.DocxHtmlView })))

// pdf.js renders PDFs in-process; the worker file ships in the renderer bundle as an asset.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

type PreviewError = DescribedError | null

function PdfView({ bytes }: { bytes: Uint8Array }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [err, setErr] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let dead = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    setDoc(null); setErr(null); setPage(1)
    try {
      task = pdfjs.getDocument({ data: bytes })
      void task.promise.then((loaded) => { if (dead) void task?.destroy(); else setDoc(loaded) })
        .catch((e: unknown) => { if (!dead) setErr(String(e instanceof Error ? e.message : e)) })
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)) }
    return () => { dead = true; void task?.destroy() }
  }, [bytes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    let dead = false
    let task: { promise: Promise<unknown>; cancel: () => void } | null = null
    void (async () => {
      try {
        const p = await doc.getPage(page)
        if (dead) return
        const dpr = window.devicePixelRatio || 1
        const viewport = p.getViewport({ scale: 1.5 * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
        task = p.render({ canvas, viewport })
        await task.promise
      } catch (e) { if (!dead) setErr(String(e instanceof Error ? e.message : e)) }
    })()
    return () => { dead = true; task?.cancel() }
  }, [doc, page])

  if (err) return <Feedback kind="error" title={PREVIEW.loadFailed} body={<code>{err}</code>} />
  if (!doc) return <p className="caption">PDF를 여는 중…</p>
  return <div><div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
    <button onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page <= 1} aria-label="이전 페이지">{PREVIEW.prev}</button>
    <span className="caption" aria-live="polite">{PREVIEW.pageOf(page, doc.numPages)}</span>
    <button onClick={() => setPage((n) => Math.min(doc.numPages, n + 1))} disabled={page >= doc.numPages} aria-label="다음 페이지">{PREVIEW.next}</button>
  </div><div className="preview-canvas"><canvas ref={canvasRef} /></div></div>
}

function stagedPdf(item: ArtifactItem | undefined, items: ArtifactItem[]): ArtifactItem | null {
  if (!item) return null
  const stem = item.name.replace(/\.[^.]+$/, '')
  const dir = item.path.slice(0, item.path.length - item.name.length)
  return items.find((i) => i.kind === 'pdf' && i.name === `${stem}.pdf` && (i.path.startsWith(dir) || i.path.startsWith('build/native/'))) ?? null
}

function WordRender({ root, input, item, items, onRendered, showStatus }: { root: string; input: string | null; item?: ArtifactItem; items: ArtifactItem[]; onRendered: () => void; showStatus: boolean }) {
  const runner = useRunner()
  const outDir = useMemo(() => versioned('build/native', (p) => items.some((i) => i.path === p || i.path.startsWith(p + '/'))), [items])
  const doRender = async () => {
    if (!input) return
    const env = await runner.run('office.word', { root, input, out_dir: outDir })
    if (env?.ok) onRendered()
  }
  const hint = officeHint(runner.env?.block_reason ?? (runner.env?.data as { engine_stderr?: string } | null)?.engine_stderr)
  return <div>
    {showStatus && <Feedback kind="status" title={PREVIEW.docxNoPdfTitle} body={PREVIEW.docxNoPdfBody} />}
    <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
      <button className={showStatus ? 'primary' : 'quiet'} disabled={!input || runner.busy} onClick={() => void doRender()}>{runner.busy ? PREVIEW.docxRendering : PREVIEW.docxRender}</button>
    </div>
    {runner.err && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind="error" title={PREVIEW.loadFailed} body={<code>{runner.err}</code>} /></div>}
    {runner.env && !runner.busy && !runner.env.ok && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind="warning" title={hint?.title ?? 'PDF를 만들지 못했어요'} body={hint?.body ?? runner.env.block_reason ?? 'Word가 없거나 실행을 완료하지 못했어요. "원래 앱으로 열기"로 직접 확인해 주세요.'} /></div>}
    <ProgressPanel busy={runner.busy} phase={runner.phase} elapsedMs={runner.elapsedMs} lines={runner.lines} onCancel={runner.cancel} />
    {runner.env?.ok && <div style={{ marginTop: 'var(--sp-3)' }}><Feedback kind="completion" title={COMPLETION.docx_built} /></div>}
  </div>
}


function XlsxView({ data }: { data: Extract<PreviewPayload, { kind: 'xlsx' }> }) {
  const [sheet, setSheet] = useState(0)
  const s = data.sheets[sheet] ?? data.sheets[0]
  return <div>
    {data.formulas_uncalculated && <div style={{ marginBottom: 'var(--sp-3)' }}><Feedback kind="warning" title={PREVIEW.uncalculatedTitle} body={PREVIEW.uncalculatedBody} /></div>}
    <div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
      {data.sheets.length > 1 && <SegmentedControl value={String(sheet)} options={data.sheets.map((sh, i) => ({ id: String(i), label: sh.name }))} onChange={(v) => setSheet(Number(v))} label="시트" />}
      {s?.truncated && <Badge label={PREVIEW.truncated} />}
    </div>
    {s && <div className="preview-table-wrap"><table className="preview-table"><tbody>
      {s.rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}
    </tbody></table>{s.rows.length === 0 && <p className="caption">{PREVIEW.empty}</p>}</div>}
  </div>
}

function PreviewBody({ payload, root, item, items, target, onRendered }: { payload: PreviewPayload; root: string; item?: ArtifactItem; items: ArtifactItem[]; target: string; onRendered: () => void }) {
  const [htmlFailed, setHtmlFailed] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [pdfMode, setPdfMode] = useState(false)
  const [siblingPdf, setSiblingPdf] = useState<{ target: string; path: string } | null>(null)
  const onFailed = useCallback((_message: string): void => setHtmlFailed(true), [])
  const pdf = useMemo(() => payload.kind === 'docx' ? stagedPdf(item, items) : null, [payload, item, items])
  useEffect(() => {
    setSiblingPdf(null)
    if (payload.kind !== 'docx' || pdf) return
    const separator = window.knuaf.platform === 'win32' ? '\\' : '/'
    const prefix = root.endsWith(separator) ? root : root + separator
    if (!target.startsWith(prefix)) return
    const relative = target.slice(prefix.length)
    const pdfRelative = relative.replace(/\.docx$/i, '.pdf')
    if (pdfRelative === relative) return
    let dead = false
    const pdfTarget = joinPath(root, pdfRelative)
    void window.knuaf.fileExists(root, pdfRelative).then((reply) => {
      if (!dead && 'result' in reply && reply.result) setSiblingPdf({ target, path: pdfTarget })
    })
    return () => { dead = true }
  }, [payload.kind, pdf, root, target])
  const pdfTarget = pdf ? joinPath(root, pdf.path) : siblingPdf?.target === target ? siblingPdf.path : null
  const pdfLabel = pdf?.path ?? pdfTarget
  const input = useMemo(() => {
    if (item) return item.path
    const separator = window.knuaf.platform === 'win32' ? '\\' : '/'
    const prefix = root.endsWith(separator) ? root : root + separator
    return target.startsWith(prefix) ? target.slice(prefix.length) : null
  }, [item, root, target])
  if (payload.kind === 'pdf') return <PdfView bytes={payload.bytes} />
  if (payload.kind === 'xlsx') return <XlsxView data={payload} />
  if (payload.kind === 'text') return <div>
    {payload.truncated && <div className="preview-truncation-badge" style={{ marginBottom: 'var(--sp-2)' }}><Badge label={PREVIEW.truncated} /></div>}
    <div className="prose">{payload.text || PREVIEW.empty}</div>
  </div>
  if (payload.kind === 'image') return imageFailed
    ? <Feedback kind="warning" title={PREVIEW.imageFailedTitle} body={PREVIEW.imageFailedBody} />
    : <img className="preview-image" src={payload.dataUrl} alt={payload.name} onError={() => setImageFailed(true)} />
  if (payload.kind === 'docx') {
    if (htmlFailed) return <>
      <Feedback kind="warning" title="미리보기를 불러오지 못했어요" body={'"원래 앱으로 열기"로 직접 확인해 주세요.'} />
      {pdfTarget
        ? <div><p className="caption">{PREVIEW.docxPdfCaption} <code>{pdfLabel}</code></p><Preview root={root} item={pdf ?? undefined} target={pdfTarget} items={items} /></div>
        : <WordRender root={root} input={input} item={item} items={items} onRendered={onRendered} showStatus />}
    </>
    return <div>
      {pdfTarget && <div className="row" style={{ marginBottom: 'var(--sp-2)' }}>
        <button aria-pressed={pdfMode} onClick={() => setPdfMode(true)}>{PREVIEW.pdfView}</button>
        <button aria-pressed={!pdfMode} onClick={() => setPdfMode(false)}>{PREVIEW.docxView}</button>
      </div>}
      {pdfMode && pdfTarget
        ? <div><p className="caption">{PREVIEW.docxPdfCaption} <code>{pdfLabel}</code></p><Preview root={root} item={pdf ?? undefined} target={pdfTarget} items={items} /></div>
        : <Suspense fallback={<p className="caption">문서를 불러오는 중…</p>}><DocxHtmlView bytes={payload.bytes} onFailed={onFailed} /></Suspense>}
    </div>
  }
  if (payload.kind === 'empty') return <Feedback kind="status" title={PREVIEW.empty} />
  if (payload.kind === 'too_large') return <Feedback kind="status" title={PREVIEW.tooLargeTitle} body={PREVIEW.tooLargeBody} />
  if (payload.kind === 'preview_error') return payload.reason === 'too_large'
    ? <Feedback kind="status" title={PREVIEW.tooLargeTitle} body={PREVIEW.tooLargeBody} />
    : <Feedback kind="warning" title={PREVIEW.loadFailed} body={'"원래 앱으로 열기"로 직접 확인해 주세요.'} />
  if (payload.kind === 'unsupported') return <Feedback kind="status" title={PREVIEW.unsupportedTitle} body={PREVIEW.unsupportedBody} />
  return null
}

/** All preview kinds receive their bytes from the one main-process preview:read response. */
export function Preview({ root, item, items, target, onRendered = () => {}, onReadError, onUnsupported }: {
  root: string
  item?: ArtifactItem
  items: ArtifactItem[]
  target?: string
  onRendered?: () => void
  onReadError?: (error: { code: string; message: string }) => void
  onUnsupported?: (payload: Extract<PreviewPayload, { kind: 'unsupported' }>) => void
}) {
  const path = target ?? (item ? joinPath(root, item.path) : '')
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [error, setError] = useState<PreviewError>(null)
  const callbacks = useRef({ onReadError, onUnsupported })
  callbacks.current = { onReadError, onUnsupported }
  useEffect(() => {
    let dead = false
    setPayload(null); setError(null)
    void window.knuaf.previewRead(path).then((reply) => {
      if (dead) return
      if (reply.error) {
        if (callbacks.current.onReadError) callbacks.current.onReadError(reply.error)
        else setError(describeError(reply.error))
      } else if (reply.result) {
        if (reply.result.kind === 'unsupported' && !reply.result.openable && callbacks.current.onUnsupported) callbacks.current.onUnsupported(reply.result)
        else setPayload(reply.result)
      }
    }).catch((e: unknown) => { if (!dead) setError(describeError(e)) })
    return () => { dead = true }
  }, [path])
  if (error) return <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />
  if (!payload) return <p className="caption">불러오는 중…</p>
  const body: ReactNode = <PreviewBody payload={payload} root={root} item={item} items={items} target={path} onRendered={onRendered} />
  return <div className="preview">{body}</div>
}
