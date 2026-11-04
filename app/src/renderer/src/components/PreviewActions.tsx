import type { ReactNode } from 'react'
import { ARTIFACTS } from '../copy'

export function PreviewActions({ path, children, onOpen }: { path: string; children?: ReactNode; onOpen?: () => void }) {
  return <div className="preview-actions">
    {children}
    <button onClick={() => void window.knuaf.reveal(path)}>{ARTIFACTS.reveal}</button>
    <button onClick={onOpen ?? (() => void window.knuaf.openPath(path))}>{ARTIFACTS.openExternal}</button>
  </div>
}
