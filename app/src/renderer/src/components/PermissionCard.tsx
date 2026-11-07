import type { PermissionRequest } from '../../../shared/chat'
import { CHAT } from '../copy'
import { Disclosure } from './Disclosure'
import { FileChangePreview } from './FileChangePreview'

export function PermissionCard({ request, onRespond, onAllowAlways }: {
  request: PermissionRequest
  onRespond: (id: string, allow: boolean) => void
  onAllowAlways: (id: string) => void
}) {
  return <div className="askcard" role="alert">
    <div className="askcard-h"><span className="ask-dot" />{CHAT.askTitle}</div>
    <div className="askcard-t">{request.title}</div>
    {request.title === '파일 변경 확인' ? <>
      {request.detail && <div className="caption">{request.detail}</div>}
      {request.fileChanges && <FileChangePreview changes={request.fileChanges} />}
    </> : <>
      {/* 명령·이유는 여러 줄일 수 있어 나누지 않고 그대로 보여 준다. */}
      {request.detail && <div className="askcard-raw">{request.detail}</div>}
      <Disclosure label={CHAT.askDetail}>
        <div className="prose">{request.detail}</div>
      </Disclosure>
    </>}
    <div className="caption">{CHAT.allowAlwaysHint}</div>
    <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
      <button className="primary" onClick={() => onRespond(request.id, true)}>{CHAT.allow}</button>
      <button onClick={() => onAllowAlways(request.id)}>{CHAT.allowAlways}</button>
      <button onClick={() => onRespond(request.id, false)}>{CHAT.deny}</button>
    </div>
  </div>
}
