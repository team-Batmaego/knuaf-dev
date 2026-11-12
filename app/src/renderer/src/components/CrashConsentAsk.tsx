import { useEffect, useState } from 'react'
import { CRASH_REPORT } from '../copy'
import { useProject } from '../store/project'
import { Disclosure } from './Disclosure'
import { Sheet } from './Sheet'

/**
 * 오류 자동 보고 동의 시트 (DESIGN §2-5·§2-8).
 *
 * **push 이벤트를 만들지 않는다.** 마운트 때 `crash.status()` 를 한 번 읽어 `ask` 를 지역
 * 상태로 잡는다 — main 이 언제 답을 갖게 될지 렌더러가 모르고, push 를 쓰면 구독 전 이벤트를
 * 잃는다. `ask` 는 디스크 상태에서 계산되는 값이라 늦게 물어도 답이 달라지지 않는다.
 *
 * **다른 시트와 겹치면 미룬다.** 실제로 화면을 덮는 것은 셋뿐이다: `sheet`(설정·점검),
 * `firstProjectGate`. 첫 화면(`splashVisible`)은 이 컴포넌트가 그 슬롯 **안에** 살아서 자동으로
 * 해결된다. 하나라도 참이면 `open={false}` 로 두고 모두 거짓이 되면 열린다(store 파생값).
 *
 * 닫기(Esc·바깥 클릭·X)는 **답이 아니다** — `report_consent` 를 그대로 두고 이번 실행에서만
 * 다시 묻지 않는다. 다음 실행에서 큐가 남아 있으면 한 번 더 묻는다.
 */
export function CrashConsentAsk() {
  const sheet = useProject((s) => s.sheet)
  const gate = useProject((s) => s.firstProjectGate)
  const [ask, setAsk] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    // 실패해도 조용히 넘어간다 — 질문을 못 띄우는 것이 오류 화면을 띄우는 이유가 되면 안 된다.
    void window.knuaf.crash.status()
      .then((s) => { if (live) setAsk(s.ask === true) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  const open = ask && !dismissed && sheet === null && gate === null
  const answer = async (allow: boolean) => {
    if (busy) return
    setBusy(true)
    try { await window.knuaf.crash.answer(allow) } finally { setBusy(false); setDismissed(true) }
  }
  return (
    <Sheet open={open} screen="crash-consent" title={CRASH_REPORT.askTitle} onClose={() => setDismissed(true)}
      foot={<><button onClick={() => void answer(false)} disabled={busy}>{CRASH_REPORT.askDeny}</button>
        <button className="primary" disabled={busy} onClick={() => void answer(true)}>{CRASH_REPORT.askAllow}</button></>}>
      <p>{CRASH_REPORT.askBody}</p>
      <p className="caption">{CRASH_REPORT.askScope}</p>
      <Disclosure label={CRASH_REPORT.askDetailLabel}><p>{CRASH_REPORT.askDetail}</p></Disclosure>
    </Sheet>
  )
}
