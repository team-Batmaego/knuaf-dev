import type { PermissionRequest } from '../../../shared/chat'
import { CHAT } from '../copy'
import { Disclosure } from './Disclosure'
import { FileChangePreview } from './FileChangePreview'

export function PermissionCard({ request, onRespond, onAllowAlways, onStop, stopText }: {
  request: PermissionRequest
  onRespond: (id: string, allow: boolean) => void
  onAllowAlways: (id: string) => void
  /** 현재 턴 중단 — 입력칸 ■ 와 같은 `chat:stop` 이다. '거절'(이 도구 요청 하나에 대한 답)과 다르다. */
  onStop: () => void
  stopText: string
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
      <button type="button" className="askcard-stop" onClick={onStop}>{stopText}</button>
    </div>
  </div>
}
