import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet } from './Sheet'
import { Preview } from './Preview'
import { Feedback } from './Feedback'
import { PreviewActions } from './PreviewActions'
import { ARTIFACTS, PREVIEW } from '../copy'
import { useProject } from '../store/project'
import { useShallow } from 'zustand/react/shallow'
import { joinPath } from '../paths'

export function PreviewSheet() {
  const { root, path, close, openSheet, setNotice, notice, items, loadLists } = useProject(useShallow((s) => ({
    root: s.root, path: s.previewPath, close: s.closePreview, openSheet: s.openSheet,
    setNotice: s.setPreviewNotice, notice: s.previewNotice, items: s.artifacts, loadLists: s.loadLists
  })))
  const [openError, setOpenError] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  const closing = useRef(false)
  const openRequestId = useRef(0)
  useEffect(() => {
    openRequestId.current += 1
    if (path) closing.current = false
    setOpenError(null)
    setReadError(false)
  }, [root, path])
  const name = useMemo(() => path?.split(/[\\/]/).at(-1) ?? '', [path])
  const item = useMemo(() => items?.find((candidate) => joinPath(root, candidate.path) === path), [items, root, path])
  if (!root || !path) return null
  const onReadError = (error: { code: string; message: string }): void => {
    if (error.code === 'not_openable') {
      openRequestId.current += 1
      close()
      void window.knuaf.openFileLink(path)
      return
    }
    if (error.code === 'outside_project' || error.code === 'not_found') {
      openRequestId.current += 1
      close()
      if (error.code === 'outside_project') setNotice({ title: '이 논문 폴더 밖의 파일은 열 수 없어요.', body: '' })
      else setNotice({ title: `"${name}"을 찾지 못했어요.`, body: '아래는 이 논문에서 만든 다른 파일이에요.' })
      openSheet('artifacts')
      return
    }
    setReadError(true)
  }
  const onUnsupported = (payload: { name: string; ext: string; openable: boolean }): void => {
    openRequestId.current += 1
    close()
    if (!payload.openable) void window.knuaf.openFileLink(path)
  }
  const onOpen = async (): Promise<void> => {
    const requestId = ++openRequestId.current
    const requestedRoot = root
    const requestedPath = path
    setOpenError(null)
    const reply = await window.knuaf.openPath(requestedPath)
    const current = useProject.getState()
    if (requestId !== openRequestId.current || current.root !== requestedRoot || current.previewPath !== requestedPath) return
    if ('error' in reply) setOpenError(reply.error.code === 'not_openable' ? ARTIFACTS.openNotSupported : reply.error.message)
    else if (reply.result.reason === 'open_failed') setOpenError(ARTIFACTS.openFallback)
  }
  const closeAndRestore = (): void => {
    if (closing.current) return
    closing.current = true
    openRequestId.current += 1
    const focusReturn = close()
    requestAnimationFrame(() => {
      const target = focusReturn?.trigger?.isConnected ? focusReturn.trigger : focusReturn?.fallback
      target?.focus({ preventScroll: true })
    })
  }
  return <Sheet open side screen="preview" title={name} onClose={closeAndRestore}>
    <PreviewActions path={path} onOpen={() => void onOpen()} />
    {openError && <Feedback kind="warning" title={ARTIFACTS.openFailedTitle} body={openError} actions={<button onClick={() => void window.knuaf.reveal(path)}>{ARTIFACTS.reveal}</button>} />}
    {notice && <Feedback kind="warning" title={notice.title} body={notice.body} />}
    {readError
      ? <Feedback kind="warning" title={PREVIEW.loadFailed} body={PREVIEW.readFailedBody} />
      : <Preview root={root} item={item} target={path} items={items ?? []} onRendered={() => { void loadLists() }} onReadError={onReadError} onUnsupported={onUnsupported} />}
  </Sheet>
}
