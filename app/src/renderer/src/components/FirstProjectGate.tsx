import { useState } from 'react'
import { PROJECT_FOLDER } from '../copy'
import { useProject } from '../store/project'
import { Sheet } from './Sheet'

export function FirstProjectGate() {
  const gate = useProject((s) => s.firstProjectGate)
  const choose = useProject((s) => s.chooseFirstProjectPermission)
  const cancel = useProject((s) => s.cancelFirstProjectGate)
  const open = useProject((s) => s.open)
  const [busy, setBusy] = useState(false)
  const permission = gate?.kind === 'permission'
  const pickFolder = async () => {
    const root = await window.knuaf.pickFolder()
    if (root) await open(root)
  }
  const chooseMode = async (mode: 'trust' | 'ask') => {
    if (busy) return
    setBusy(true)
    try { await choose(mode) } finally { setBusy(false) }
  }

  return (
    <Sheet open={!!gate} screen="first-project-gate" title={permission ? PROJECT_FOLDER.permissionTitle : '이 폴더는 아직 열리지 않았어요.'} onClose={cancel}>
      {permission ? <>
        <p>{PROJECT_FOLDER.permissionBody}</p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void chooseMode('trust')}>{PROJECT_FOLDER.permissionAlways}</button>
          <button disabled={busy} onClick={() => void chooseMode('ask')}>{PROJECT_FOLDER.permissionAsk}</button>
        </div>
      </> : <>
        <p>{PROJECT_FOLDER.windowsWriteFailed}</p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void pickFolder()}>{PROJECT_FOLDER.pick}</button>
        </div>
      </>}
    </Sheet>
  )
}
