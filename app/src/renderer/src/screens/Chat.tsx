import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useProject } from '../store/project'
import { chatProvider, resolveChatMode, useChat, type ChatMode } from '../store/chat'
import { chosenProvider, useConnect, type ConnState } from '../store/connect'
import { useReview, buildQuotedMessage, type ReviewEdit } from '../store/review'
import { preparationFailureTitle, usePrep, waitKind } from '../store/prep'
import { cutAtLine, formFold as formFoldOf, progressGroups, stripLines } from '../../../shared/chat-fold'
import { mergeFoldSpans, progressHide } from '../../../shared/progress-list'
import { ChatMarkdown } from '../components/ChatMarkdown'
import { ProgressFold } from '../components/ProgressFold'
import { ReviewQuoteChip } from '../components/ReviewQuote'
import { ComposerModelChip } from '../components/ComposerModelChip'
import { PermissionCard } from '../components/PermissionCard'
import { QuestionCard } from '../components/QuestionCard'
import { QuestionForm } from '../components/QuestionForm'
import { Icon } from '../components/Icon'
import { RuntimeFix } from '../components/RuntimeFix'
import { QUESTION_FORM } from '../copy'
import { CHAT, CHAT_EVENT, CLOSE_LABEL, ONBOARD, PROJECT_FOLDER, PROVIDER_NAME, REPORT, REVIEW, RUNTIME, describeChatError, projectFolderCreationError } from '../copy'
import { chatSuggestion } from '../suggest'
import { joinPath } from '../paths'
import { useStage } from '../components/useStage'
import { zoneOf } from '../../../shared/zone'
import type { ChatMessage, Provider } from '../../../shared/chat'
import { projectFolderName } from '../../../shared/project-folder'
import { useShallow } from 'zustand/react/shallow'
import { create } from 'zustand'

export type DraftIntent = { seq: number; root: string | null; title?: string }
export const useReportIntent = create<{ intent: DraftIntent | null }>(() => ({ intent: null }))
let reportSeq = 0

/** TitleBar onReport callback; survives Chat unmounting in a narrow window. */
export function requestReport(title?: string): void {
  const project = useProject.getState()
  useReportIntent.setState({ intent: { seq: ++reportSeq, root: project.root, title } })
  project.setPaneView('chat')
}

export function reportDraft(draft: string, title?: string): string {
  const prefix = title ? REPORT.prefillError(title) : REPORT.prefill
  return draft ? `${prefix}\n${draft}` : prefix
}

/** Claim before changing a draft so replayed effects cannot apply an intent twice. */
export function applyReportIntent(intent: DraftIntent, projectRoot: string | null, chatRoot: string | null, connState: ConnState, disconnected: boolean): 'no-folder' | 'disconnected' | 'status-failed' | 'ready' | null {
  if (useReportIntent.getState().intent?.seq !== intent.seq) return null
  if (intent.root === projectRoot && projectRoot && (chatRoot !== projectRoot || connState === 'checking')) return null
  useReportIntent.setState({ intent: null })
  if (intent.root !== projectRoot) return null
  if (!projectRoot) return 'no-folder'
  if (connState === 'failed' || connState === 'unknown') return 'status-failed'
  if (disconnected) return 'disconnected'
  useChat.getState().setDraft(reportDraft(useChat.getState().draft, intent.title))
  return 'ready'
}

/**
 * 한 말풍선이 이보다 길면 접는다. 도우미가 도구 보고 원문을 그대로 채팅에 쏟으면
 * (주행에서 20,600자가 들어왔다) 대화가 사람이 지나갈 수 없는 길이가 된다.
 * 내용을 버리지는 않는다 — 펼치면 전문이 그대로 있다.
 */
const LONG_MESSAGE = 2000

/**
 * 카드가 떠 있는 동안 대화 원문에서 접을 줄 범위. 같은 보기(또는 같은 칸)가 카드와 원문에 두 번
 * 보이면 어디를 눌러야 할지 헷갈린다 — 글자를 버리지는 않는다("여기에 펼치기").
 *
 * `kind` 는 접힌 것이 **보기 목록**인지 **여러 칸 질문**인지다. 형식 질문(`1.` `2.` 번호 칸)은
 * `parseQuestion` 이 읽지 못해 zone 이 `form` 이 되는데, 예전에는 그때 span 을 넘기지 않아
 * 카드와 원문이 같은 칸을 두 번 보여 줬다(형님 11-09 실측).
 */
export interface FoldOptions { spans: { start: number; end: number }[]; count: number; kind: 'options' | 'fields' }

/**
 * 학생 말풍선 **밖** 아래 오른쪽의 작은 글자(형님 확정 2026-10-19 전송 중 A안). 말풍선 안 알약·단추는 없다.
 * `sending` — 작업 중이고 이 말풍선이 마지막 학생 메시지이며 아직 `pending` 일 때만(진행 표시는 늘 1개 —
 * 아래 빙글이 줄과 번갈아 쓴다, `Chat` 의 L·R·P 판정). 과거 메시지에 남은 `pending` 에는 붙이지 않는다.
 */
function Delivery({ m, sending, onResend }: { m: ChatMessage; sending: boolean; onResend?: () => void }) {
  if (m.role !== 'user') return null
  if (m.delivery === 'uncertain') {
    return <div className="deliv bad" data-st="unsure">{CHAT.uncertainLine}{onResend && <> · <button className="lk" onClick={onResend}>{CHAT.resend}</button></>}</div>
  }
  if (sending && m.delivery === 'pending') return <div className="deliv" data-st="sending"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{CHAT.sendingLine}</div>
  return null
}

function Message({ m, onResend, onFileLink, fold, hide, sending = false }: { m: ChatMessage; onResend?: () => void; onFileLink?: (relative: string) => void; fold?: FoldOptions; hide?: { start: number; end: number }[]; sending?: boolean }) {
  const [open, setOpen] = useState(false)
  const [unfolded, setUnfolded] = useState(false)
  const projectRoot = useProject((s) => s.root)
  if (m.role === 'system') return <div className="chat-msg system"><span className="caption">{m.text}</span></div>
  const folding = !!fold && !unfolded
  // 진행 목록 덩어리는 안내 줄 없이 조용히 걷는다(IMPL-T1 §3-1). 카드 접기와 원문 줄 번호
  // 기준으로 합쳐 `stripLines`를 한 번 부른다 — 겹침·맞닿음 줄은 한 번만 걷힌다.
  // unfold("여기에 펼치기")는 카드 접기만 풀고, 진행 덩어리는 계속 숨겨 둔다 — 진행 표시는 제목줄 하나다.
  const combined = (() => {
    const cardSpans = folding && fold ? fold.spans : []
    const hideSpans = hide ?? []
    if (cardSpans.length === 0 && hideSpans.length === 0) return null
    return mergeFoldSpans([...cardSpans, ...hideSpans])
  })()
  const text = combined ? stripLines(m.text, combined) : m.text
  const long = text.length > LONG_MESSAGE
  // 한도가 표·목록 한가운데를 가르지 않게 **줄 경계**에서 자른다. "더 보기"의 수는 자르기 전이
  // 아니라 **접힌 뒤 실제로 남은 글** 기준이다(예전에는 원문 길이를 써서 실제보다 크게 보였다).
  const shown = long && !open ? cutAtLine(text, LONG_MESSAGE) : text
  // 접은 줄은 "더 보기"로 되돌릴 글도 아니다 — 수는 지금 화면 기준으로 센다.
  const hidden = text.length - shown.length
  const quoted = m.role === 'user' ? /^> ([^\n]+)\n\(([^\n]+)에서\)\n\n([\s\S]+)$/.exec(shown) : null
  // 도우미는 **테두리·상자·발화자/시간 머리 없는 본문**, 학생만 오른쪽 말풍선(시안 D/E/G, N-I01).
  return (<>
    <div className={`chat-msg ${m.role}`}>
      <div className="prose">{m.role === 'assistant' ? <ChatMarkdown text={shown} root={projectRoot} messageId={m.id} onFile={onFileLink} /> : quoted ? <>
        <span className="msg-quote" style={{ display: 'block', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '1px 0 6px', padding: '6px 10px', background: 'color-mix(in srgb, var(--panel) 70%, transparent)', borderRadius: 10 }}>
          <b style={{ display: 'block', fontWeight: 500, fontSize: 11.5, color: 'var(--faint)' }}>{REVIEW.quoteLead(quoted[2])}</b>
          <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{quoted[1]}</span>
        </span>{quoted[3]}
      </> : shown}</div>
      {folding && fold && (
        <div className="q-fold">
          <span className="caption">{fold.kind === 'fields' ? CHAT.foldFields(fold.count) : CHAT.foldHint(fold.count)}</span>
          <span className="caption">·</span>
          <button className="lk" onClick={() => setUnfolded(true)}>{CHAT.unfold}</button>
        </div>
      )}
      {long && <button className="lk" onClick={() => setOpen(!open)}>{open ? CHAT.showLess : CHAT.showMore(hidden)}</button>}
    </div>
    <Delivery m={m} sending={sending} onResend={onResend} />
  </>)
}

/**
 * 대화 이벤트 줄 — 도우미가 절을 저장한 사실을 앱이 그린다(IMPL-PLAN §3 신규).
 * 절 제목은 `project.sections`에서 온다(도우미 답변의 머리 배너를 되뇌지 않는다).
 * 대화 기록 파일에는 없다 — 앱을 다시 켜면 이 줄도 사라진다.
 */
function EventLine({ title, edit, onGo }: { title: string; edit: ReviewEdit | null; onGo: () => void }) {
  const edited = edit?.kind === 'edited'
  return (
    <div className="chat-event">
      {edited ? <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l4-.8L19 8.2 15.8 5 4.8 16zM14.5 6.3l3.2 3.2" /></svg> : <Icon name="doc" size={14} />}
      <span>{edited ? CHAT_EVENT.edited(title, edit.count) : CHAT_EVENT.wrote(title)}</span>
      <button className="lk" onClick={onGo}>{edited ? CHAT_EVENT.showDiff : CHAT_EVENT.goPaper}</button>
    </div>
  )
}

function NoFolder({ text, setText, onSubmit, submitted, name, setName, onPick, onCreate, busy, createError, onBack, reportNotice, onCloseReport }: {
  text: string; setText: (text: string) => void; onSubmit: () => void; submitted: string | null
  name: string; setName: (name: string) => void; onPick: () => void; onCreate: () => void
  busy: boolean; createError: string | null; onBack: () => void; reportNotice: boolean; onCloseReport: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const error = useProject((s) => s.error)
  const failure = useProject((s) => s.openFailure)
  const retryFailed = useProject((s) => s.retryFailed)
  const retryOpen = useProject((s) => s.retryOpen)
  const clearError = useProject((s) => s.clearError)
  return (
    <div className="new-chat">
      {!submitted && <><h1>어떤 논문을 쓰고 있어요?</h1>
      <p>주제 한 줄이면 돼요. 도우미가 질문하면서 논문을 같이 채워 갈게요.</p></>}
      {reportNotice && <ZoneLine tone="info" title={REPORT.noFolder} onClose={onCloseReport} />}
      {error && <ZoneLine tone={toneOf(error.kind)} title={error.title} sub={error.action} raw={error.raw} onClose={clearError} />}
      {failure && <>{retryFailed && <ZoneLine tone="attn" title={RUNTIME.retryFailedTitle} sub={RUNTIME.retryFailedBody} />}<RuntimeFix failure={failure} onRetry={async () => retryOpen(failure.root)} /></>}
      {submitted ? <div className="folder-question">
        <div className="folder-message">{submitted}</div>
        <section className="folder-card">
            <h2>{PROJECT_FOLDER.title}</h2>
            <p>{PROJECT_FOLDER.body}</p>
            <label>{PROJECT_FOLDER.name}<input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
            <button className="folder-option recommended" onClick={onCreate} disabled={busy}>
              <strong>{PROJECT_FOLDER.create} · {PROJECT_FOLDER.recommended}</strong>
              <small>{PROJECT_FOLDER.location(projectFolderName(name))}</small>
            </button>
            <button className="folder-option" onClick={onPick} disabled={busy}>
              <strong>{PROJECT_FOLDER.pick}</strong><small>{PROJECT_FOLDER.pickBody}</small>
            </button>
          {createError && <p role="alert">{createError}</p>}
          <button className="quiet" onClick={onBack} disabled={busy}>돌아가기</button>
        </section>
      </div> : <>
        <div className="chat-composer">
          <textarea ref={inputRef} rows={2} aria-label={CHAT.placeholder} value={text} placeholder={CHAT.firstRunPlaceholder}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit() } }} />
          <div className="crow"><ComposerModelChip placement="down" /><span className="sp" /><button className="send" aria-label={CHAT.send} disabled={!text.trim()} onClick={onSubmit}><Icon name="up" size={17} /></button></div>
        </div>
        <div className="first-suggestions">
          {CHAT.firstSuggestions.map(({ label, prompt }) => <button type="button" key={label} onClick={() => {
            setText(text.trim() ? `${text}\n${prompt}` : prompt)
            inputRef.current?.focus()
          }}>{label}</button>)}
        </div>
      </>}
    </div>
  )
}


/**
 * 입력칸 위 한 줄 알림(형님 확정 2026-10-19 알림창 B안) — 대화 화면의 기다림·경고·오류는 모두 여기 한 자리다.
 * 바탕은 옅은 회색(`--panel-2`) 하나, 색은 아이콘에만. 기다림은 빙글이 + 끝나면 저절로 사라짐(닫기 없음),
 * 경고·오류는 아이콘 + ✕ + "자세히"(원문). 허락·질문 카드가 입력칸 자리를 차지하면 그 카드 위에 선다.
 */
type ZoneTone = 'wait' | 'bad' | 'attn' | 'info'
function ZoneLine({ tone, title, sub, raw, actions, onClose, onReport }: { tone: ZoneTone; title: ReactNode; sub?: ReactNode; raw?: string; actions?: ReactNode; onClose?: () => void; onReport?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="zline-wrap">
      <div className={`zline ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
        {tone === 'wait' ? <span className="spin" /> : <Icon name={tone === 'info' ? 'info' : 'warn'} size={16} className={`ic ${tone}`} />}
        <span className="grow">{title}{sub && <small>{sub}</small>}</span>
        {actions}
        {raw && <button type="button" className="lk" aria-expanded={open} onClick={() => setOpen(!open)}>{CHAT.details}</button>}
        {onReport && <button type="button" className="lk" onClick={onReport}>{REPORT.inline}</button>}
        {onClose && <button type="button" className="zx" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} onClick={onClose}>✕</button>}
      </div>
      {raw && open && <code className="zline-raw">{raw}</code>}
    </div>
  )
}

const toneOf = (kind: string): ZoneTone => kind === 'error' ? 'bad' : kind === 'warning' ? 'attn' : 'info'

/** "내 논문": 도우미와의 대화 — 인터뷰와 작문이 일어나는 곳. 폴더가 없으면 폴더 고르기 상태가 된다. */
export function Chat() {
  const projectRoot = useProject((s) => s.root)
  const newProjectSeq = useProject((s) => s.newProjectSeq)
  const settings = useProject((s) => s.settings)
  const pStatus = useProject((s) => s.status)
  const pError = useProject((s) => s.error)
  const pOpenFailure = useProject((s) => s.openFailure)
  const pRetryFailed = useProject((s) => s.retryFailed)
  const retryOpen = useProject((s) => s.retryOpen)
  const firstProjectGate = useProject((s) => s.firstProjectGate)
  const clearPError = useProject((s) => s.clearError)
  const openSheet = useProject((s) => s.openSheet)
  const openPreview = useProject((s) => s.openPreview)
  const events = useProject((s) => s.events)
  const focusSection = useProject((s) => s.focusSection)
  const paperClosed = useProject((s) => s.paperClosed)
  const setPaperClosed = useProject((s) => s.setPaperClosed)
  const setPaneView = useProject((s) => s.setPaneView)
  const quoteIntent = useProject((s) => s.quoteIntent)
  const consumeQuoteIntent = useProject((s) => s.consumeQuoteIntent)
  const setPaneTab = useProject((s) => s.setPaneTab)
  const revision = useProject((s) => s.status?.revision ?? s.peek?.revision ?? null)
  const { root, snapshot, status, statusFailed, connState, draft, busy, error, mode, setDraft, insertPath, clearError, load, send, respond, stop } = useChat(useShallow((s) => ({ root: s.root, snapshot: s.snapshot, status: s.status, statusFailed: s.statusFailed, connState: s.connState, draft: s.draft, busy: s.busy, error: s.error, mode: s.mode, setDraft: s.setDraft, insertPath: s.insertPath, clearError: s.clearError, load: s.load, send: s.send, respond: s.respond, stop: s.stop })))
  /** 이 폴더의 준비(.venv) 중인가 — 그동안 보낸 글은 끝날 때까지 기다린다(store/prep.ts). */
  /** 이 폴더에서 기다리는 것 — 폴더 준비('prep')·저장·검사('write'). 그동안 보내기는 잠긴다. */
  const waiting = usePrep((s) => waitKind(s, projectRoot))
  const waitingPrep = useChat((s) => s.waitingPrep)
  const preparation = usePrep(s => projectRoot ? s.dependencies[projectRoot] : undefined)
  /** 온보딩 2단계에서 폴더를 고른 순간의 시작 의사 — 한 번만 쓴다(store/chat.ts 주석). */
  const startIntent = useChat((s) => s.startIntent)
  const disarmStart = useChat((s) => s.disarmStart)
  /**
   * 지금 대화할 공급자. 우선순위: 학생이 고른 것(온보딩 1단계·설정·계정) → 세션에서 고른 것
   * → 옛 설정(`helper_mode`). 연결 상태도 같은 공급자를 본다.
   */
  const connectSelected = useConnect((s) => s.selected)
  const seg: ChatMode = resolveChatMode(mode, settings)
  const provider: Provider = chosenProvider(connectSelected, settings) ?? chatProvider(seg)
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  useEffect(() => {
    const sync = (): void => setOffline(!window.navigator.onLine)
    window.addEventListener('offline', sync)
    window.addEventListener('online', sync)
    return () => {
      window.removeEventListener('offline', sync)
      window.removeEventListener('online', sync)
    }
  }, [])
  const reportIntent = useReportIntent((s) => s.intent)
  const [reportNotice, setReportNotice] = useState<'normal' | 'offline' | 'disconnected' | 'status-failed' | 'no-folder' | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  /** 입력칸 — 한 줄에서 시작해 글이 늘면 자란다(시안 P/L). 최대 높이 뒤에는 스크롤. */
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** 바닥에 붙어 있는가 — 학생이 굴린 결과로만 바뀐다. 글이 늘어나는 것은 scroll 을 부르지 않으므로 늘기 전 값이 남는다. */
  const stick = useRef(true)
  const [dragging, setDragging] = useState(false)
  const [newText, setNewText] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const createdFolder = useRef<{ name: string; root: string } | null>(null)
  const submission = useRef(0)
  const folderOpening = useRef<number | null>(null)
  const [queued, setQueued] = useState<{ root: string; text: string; submission: number } | null>(null)
  const [switchNotice, setSwitchNotice] = useState<Provider | null>(null)
  const previous = useRef<{ root: string | null; provider: Provider }>({ root: projectRoot, provider })
  const recordingFirstRun = useRef(false)
  const submitNew = (): void => {
    if (!newText.trim()) return
    submission.current += 1
    setQueued(null)
    setSubmitted(newText.trim())
    setFolderName(PROJECT_FOLDER.defaultName)
    setFolderError(null)
  }
  const openFirstFolder = async (dir: string, generation: number, projectSeq: number): Promise<void> => {
    const live = (): boolean => submission.current === generation && useProject.getState().newProjectSeq === projectSeq
    if (!submitted || !live()) return
    if (!settings?.provider_choice && useConnect.getState()[provider].state === 'connected') {
      await window.knuaf.setSettings({ helper_mode: provider === 'claude' ? 'claude-chat' : 'codex-chat', provider_choice: { provider, at: new Date().toISOString() } })
      if (!live()) return
      useConnect.getState().select(provider)
      await useProject.getState().loadSettings()
      if (!live()) return
    }
    if (!live() || useProject.getState().root) return
    setQueued({ root: dir, text: submitted, submission: generation })
    await useProject.getState().open(dir)
  }
  const chooseFolder = async (automatic: boolean): Promise<void> => {
    if (folderOpening.current !== null) return
    const generation = submission.current
    const projectSeq = useProject.getState().newProjectSeq
    const live = (): boolean => submission.current === generation && useProject.getState().newProjectSeq === projectSeq
    folderOpening.current = generation
    setFolderBusy(true)
    setFolderError(null)
    try {
      let dir: string | null
      if (automatic) {
        const name = projectFolderName(folderName)
        if (createdFolder.current?.name === name) dir = createdFolder.current.root
        else {
          const result = await window.knuaf.createProjectFolder(name)
          if (!live()) return
          if ('error' in result) {
            setFolderError(projectFolderCreationError(window.knuaf.platform, result.error.message))
            return
          }
          dir = result.result.root
          createdFolder.current = { name, root: dir }
        }
      } else {
        dir = await window.knuaf.pickFolder()
        if (!live()) return
      }
      if (!dir || !live()) return
      await openFirstFolder(dir, generation, projectSeq)
    } catch {
      if (live()) setFolderError(PROJECT_FOLDER.createFailed)
    } finally {
      if (folderOpening.current === generation) {
        folderOpening.current = null
        setFolderBusy(false)
      }
    }
  }
  useEffect(() => {
    submission.current += 1
    folderOpening.current = null
    setFolderBusy(false)
    setNewText(''); setSubmitted(null); setQueued(null); setFolderError(null); createdFolder.current = null
  }, [newProjectSeq])
  const previousProjectGate = useRef(firstProjectGate)
  useEffect(() => {
    const previous = previousProjectGate.current
    if (
      previous?.kind === 'write-error' &&
      firstProjectGate &&
      firstProjectGate.root !== previous.root &&
      queued?.root === previous.root &&
      queued.submission === submission.current &&
      queued.text === submitted
    ) {
      // The student replaced the folder that failed the write probe; continue this request at the selected root.
      setQueued({ ...queued, root: firstProjectGate.root })
    } else if (previous && !firstProjectGate && !projectRoot && queued?.root === previous.root) {
      setQueued(null); setSubmitted(null); setFolderError(null)
    }
    previousProjectGate.current = firstProjectGate
  }, [firstProjectGate, projectRoot, queued, submitted])
  useEffect(() => {
    if (projectRoot && submitted && !queued) setQueued({ root: projectRoot, text: submitted, submission: submission.current })
  }, [projectRoot, submitted, queued])
  useEffect(() => {
    if (previous.current.root === projectRoot && projectRoot && previous.current.provider !== provider) setSwitchNotice(provider)
    else if (previous.current.root !== projectRoot) setSwitchNotice(null)
    previous.current = { root: projectRoot, provider }
  }, [projectRoot, provider])
  useEffect(() => {
    if (!projectRoot || !settings || settings.onboarded_at || recordingFirstRun.current) return
    recordingFirstRun.current = true
    if ((!queued || queued.root !== projectRoot) && !submitted) useChat.getState().armStart(projectRoot)
    void window.knuaf.setSettings({ onboarded_at: new Date().toISOString() })
      .then(() => useProject.getState().loadSettings())
      .finally(() => { recordingFirstRun.current = false })
  }, [projectRoot, settings, queued, submitted])
  useEffect(() => {
    if (!queued || queued.submission !== submission.current || queued.text !== submitted || queued.root !== projectRoot || root !== projectRoot || !snapshot || snapshot.provider !== provider) return
    const text = queued.text
    const target = queued.root
    setNewText('')
    setSubmitted(null)
    setQueued(null)
    if (status?.connected && !settings?.provider_choice && !useConnect.getState().selected) {
      void window.knuaf.setSettings({ helper_mode: provider === 'claude' ? 'claude-chat' : 'codex-chat', provider_choice: { provider, at: new Date().toISOString() } })
        .then(() => { useConnect.getState().select(provider); return useProject.getState().loadSettings() })
    }
    if (status?.connected) {
      void send(text, { preserveDraftOnFailure: true })
    } else {
      useChat.getState().appendDraft(text)
    }
  }, [queued, submitted, projectRoot, root, snapshot, provider, status, settings, send])

  // 스냅샷의 provider가 화면 provider와 다르면(설정·시작 버튼으로 모드 전환) 다시 불러온다 —
  // codex 대화가 claude 화면에 남는 식의 혼합은 없어야 한다.
  useEffect(() => { if (projectRoot && (projectRoot !== root || provider !== snapshot?.provider)) void load(projectRoot, provider) }, [projectRoot, root, snapshot?.provider, provider, load])
  /**
   * 예전에는 `.chat-log` 를 스크롤하려 했는데 그 요소에는 overflow 가 없다 — 실제로
   * 흐르는 것은 화면 전체(.main)여서 이 호출은 아무 일도 하지 않았다(시험주행 발견 5).
   * v5에서는 대화 칸이 자기 안에서 흐르므로(`.chat-thread`) 이제 실제로 움직인다.
   *
   * 바닥에 붙어 있을 때만 따라 내려간다 — 위를 읽는 중인 학생의 화면을 빼앗지 않는다.
   * 허락 카드는 예외다. 진행을 막는 것이라 어디를 보고 있든 데려간다.
   *
   * 붙어 있는지는 칸의 스크롤 위치로 잰다(형님 맥 실사용 2026-10-20 ③). 예전에는 끝 표시 요소를
   * IntersectionObserver 로 보고 **메시지 수**가 바뀔 때만 내려갔는데, 도우미 답은 같은 말풍선에
   * 글이 붙으며 자라서(스트리밍) 수가 그대로였다 — 새 글이 생겨도 화면이 멈춰 있었다. 그래서
   * 그리기마다(글이 자랄 때마다) 붙어 있으면 바닥으로 맞추고, 아래 칸 높이가 바뀌어 대화 칸이
   * 줄어들 때도(작업 중 줄 → 입력칸·질문 카드) ResizeObserver 로 다시 맞춘다.
   */
  const toBottom = (smooth = false): void => {
    const el = threadRef.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  /**
   * 바닥이면 붙고, **위로** 굴렸을 때만 떨어진다. 아래로 가는 중(맨 아래로의 부드러운 이동)에는 그대로 둔다 —
   * 이동 도중의 scroll 마다 떨어지면 단추가 깜박인다. 칸이 커져 브라우저가 위치를 당긴 경우는 바닥이라 붙는다.
   */
  const lastTop = useRef(0)
  const onThreadScroll = (): void => {
    const el = threadRef.current
    if (!el) return
    const top = el.scrollTop
    if (el.scrollHeight - top - el.clientHeight <= 24) stick.current = true
    else if (top < lastTop.current - 1) stick.current = false
    lastTop.current = top
    setAtBottom(stick.current)
  }
  // 대화 칸은 폴더가 열린 뒤에야 있다(`NoFolder` 먼저) — 폴더가 바뀔 때마다 다시 단다.
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    return () => ro.disconnect()
  }, [projectRoot])
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => { toBottom() }, [root, snapshot?.provider])
  useEffect(() => { if (snapshot?.permission) toBottom() }, [snapshot?.permission?.id])

  const running = snapshot?.state === 'running' || snapshot?.state === 'permission'
  const lastUncertain = snapshot?.messages.filter((m) => m.role === 'user' && m.delivery === 'uncertain').at(-1)
  const attach = async (): Promise<void> => { const p = await window.knuaf.pickFile({ title: CHAT.attach }); if (p) insertPath(p) }

  /**
   * 종이에서 고른 문장(인용) — 입력칸 위 칩이 보여 주고, 보낼 때 메시지에 합쳐진다(N-I03).
   * 두 상태 다 앱 메모리에만 산다(정본 폴더에 쓰지 않는다).
   */
  const quote = useReview((s) => s.quote)
  const clearQuote = useReview((s) => s.clearQuote)
  /**
   * 보내기 — 인용이 붙어 있으면 `> 문장 · (장에서) · 글` 형식으로 합쳐 보낸다(발주 QA2-B §2 (a)).
   * **인용은 그 논문의 것**이라 다른 폴더 대화에는 붙이지 않는다(QA2B-R1-01). 초안은
   * `consumeDraft` 로 넘겨 일반 전송과 **같은 규칙**으로 소비한다 — 보낸 글이 입력칸에 남지 않고,
   * 전송 중 새로 쓴 글은 지켜진다(QA2B-R1-02). 보낸 뒤에는 그 인용이 아직 그대로일 때만 지운다
   * — 늦게 온 결과가 그사이 새로 붙인 인용을 지우지 않게.
   */
  const sendBody = async (text?: string): Promise<boolean> => {
    const q = useReview.getState().quote
    if (!q || q.root !== projectRoot) return send(text)
    const ok = await send(buildQuotedMessage(q, text ?? draft), { consumeDraft: true })
    if (ok && useReview.getState().quote === q) clearQuote()
    return ok
  }

  // 인용은 그 논문의 것 — 다른 논문을 열면 지운다(QA2B-R1-01).
  useEffect(() => {
    const q = useReview.getState().quote
    if (q && q.root !== projectRoot) clearQuote()
  }, [projectRoot, clearQuote])

  /** 인용은 현재 논문에서 고른 것만 보낼 수 있다. */
  const canSend = !!draft.trim() || !!quote && quote.root === projectRoot

  const emptyChat = !!snapshot && snapshot.messages.length === 0
  const hasRevision = (revision ?? 0) >= 1

  /**
   * 첫 대화 한 번 — 온보딩에서 폴더를 고른 순간이 학생의 시작 의사다(설계 §4-3 "첫 대화 시작").
   * 그 폴더의 대화가 비어 있고 연결돼 있으면 `시작하기`(기록이 있으면 `이어서 하기`)를 한 번
   * 보낸다. 의사는 보내는 순간 소비되므로 다시 보내지 않고, **다시 열었을 때**는 아무 일도
   * 일어나지 않는다 — 그때는 빈 대화의 단추를 학생이 직접 누른다.
   */
  useEffect(() => {
    if (!startIntent || !projectRoot || startIntent !== projectRoot) return
    if (!snapshot || snapshot.provider !== provider || status?.connected !== true) return
    disarmStart()
    if (snapshot.messages.length === 0) void send(hasRevision ? CHAT.firstTurnNext : CHAT.firstTurn)
  }, [startIntent, projectRoot, snapshot, status, provider, hasRevision, send, disarmStart])

  const chatErr = error ? describeChatError(error) : null
  const snapErr = snapshot?.error && snapshot.state !== 'interrupted' && snapshot.state !== 'stopped' ? describeChatError(snapshot.error) : null
  /**
   * 스냅샷 오류·중단 안내는 main 이 쥔 값이라 화면에서 지울 수 없다 — 학생이 닫은 **그 건**만 기억해 감춘다.
   * 건 = 폴더·공급자·마지막 메시지·문구. 문구만 기억하면 다음 턴의 같은 오류까지 숨는다(검토 RETAKE-UI-R1-01).
   */
  const [closedNotes, setClosedNotes] = useState<ReadonlySet<string>>(() => new Set())
  const noteKey = (kind: string, text: string): string => [projectRoot, snapshot?.provider, snapshot?.messages.at(-1)?.id ?? '', kind, text].join('\0')
  const closeNote = (key: string): void => setClosedNotes((prev) => new Set(prev).add(key))
  const haltKey = snapshot?.state === 'stopped' || snapshot?.state === 'interrupted' ? noteKey(snapshot.state, '') : null
  const snapErrKey = snapErr && snapshot?.error ? noteKey('error', snapshot.error) : null
  /**
   * 끊긴 자리에서 무엇을 말하고 무엇을 권할지 — 연결 상태와 브라우저의 오프라인 신호를 쓴다.
   * 확인 실패(failed·unknown)는 로그인 안내가 아니라 "확인하지 못했어요 + 다시 확인"이다.
   */
  const connFailed = connState === 'failed' || connState === 'unknown'
  const chatConnTitle = connFailed ? CHAT.statusFailTitle : connState === 'no-tool' ? CHAT.needInstallTitle : CHAT.needLoginTitleFor(provider)
  const chatConnBody = connFailed ? CHAT.statusFailBody : connState === 'no-tool' ? CHAT.needInstallBody : CHAT.needLoginBody
  const chatConnSub = offline && connState === 'need-login'
    ? <>{ONBOARD.offlineHint} {chatConnBody}</>
    : chatConnBody

  // 아래 칸 하나를 정한다 — 허락 · 질문 카드 · 작업 중 · 입력칸 · 미연결(설계 §4-1).
  const zone = zoneOf(snapshot, status, pStatus ?? null)
  const [freeFormId, setFreeFormId] = useState<string | null>(null)
  const freeForm = zone.kind === 'form' && freeFormId === zone.messageId
  const [freeRequest, setFreeRequest] = useState<{ messageId: string; seq: number } | null>(null)
  // 초점은 인용을 그린 commit에서 옮긴다. 숨긴 Windows 창의 다음 프레임을 기다리지 않는다.
  useLayoutEffect(() => {
    if (!quoteIntent || !quote || quote.root !== projectRoot) return
    if (zone.kind === 'question') setFreeRequest((prev) => ({ messageId: zone.messageId, seq: (prev?.seq ?? 0) + 1 }))
    else if (zone.kind === 'form' && !freeForm) {
      setFreeFormId(zone.messageId)
      return // 입력칸이 실제로 마운트된 다음 commit에서 초점을 준다.
    } else if (zone.kind === 'composer' || zone.kind === 'running' || freeForm) {
      taRef.current?.focus()
    } else return
    consumeQuoteIntent(quoteIntent.seq)
  }, [quoteIntent, quote, projectRoot, zone.kind, zone.kind === 'form' || zone.kind === 'question' ? zone.messageId : null, freeForm, consumeQuoteIntent])

  useEffect(() => { setReportNotice(null) }, [projectRoot])
  useEffect(() => {
    if (!reportIntent) return
    const result = applyReportIntent(reportIntent, projectRoot, root, connState, zone.kind === 'disconnected')
    if (!result) return
    if (result !== 'ready') setReportNotice(result)
    else {
      setReportNotice(offline ? 'offline' : 'normal')
      if (zone.kind === 'question') setFreeRequest((prev) => ({ messageId: zone.messageId, seq: (prev?.seq ?? 0) + 1 }))
      else if (zone.kind === 'form') {
        setFreeFormId(zone.messageId)
        requestAnimationFrame(() => taRef.current?.focus())
      } else if (zone.kind !== 'permission') requestAnimationFrame(() => taRef.current?.focus())
    }
  }, [reportIntent, projectRoot, root, connState, zone.kind, zone.kind === 'form' || zone.kind === 'question' ? zone.messageId : null, offline])
  /**
   * 빈 입력칸의 추천 문구 — 지금 상황(`suggest.ts` 의 `situationOf`)이 먼저고, 그 안에서 보낸
   * 말 수로 문구를 돌린다. 대화가 비었거나·인용이 붙었거나·작업 중이거나 1단계면 `null` 이고
   * 그때는 기존 `답변을 입력하세요` 가 그대로 보인다.
   */
  const { derived: stage } = useStage()
  const lastMessage = snapshot?.messages.at(-1)
  const suggestion = chatSuggestion({
    hasMessages: (snapshot?.messages.length ?? 0) > 0,
    hasQuote: !!quote && quote.root === projectRoot,
    running: zone.kind === 'running',
    lastAssistant: lastMessage?.role === 'assistant' ? lastMessage.text : null,
    stage,
    userCount: snapshot?.messages.filter((m) => m.role === 'user').length ?? 0
  })
  /**
   * 진행 표시 판정 하나(형님 확정 전송 중 A안, 시안 검토 R2-01): L = 마지막 **학생** 메시지, R = 작업 중,
   * P = L 이 아직 보내는 중. R 이면 "보내는 중" 글자(L 에만)나 빙글이 줄 중 정확히 하나, R 이 아니면 0개.
   */
  const lastUser = snapshot?.messages.filter((m) => m.role === 'user').at(-1)
  const lastPending = zone.kind === 'running' && lastUser?.delivery === 'pending'
  /**
   * 입력칸 높이를 내용에 맞춘다 — `height:auto` 로 되돌린 뒤 `scrollHeight` 를 준다(그래야
   * 글이 줄어도 줄어든다). 최대 높이는 CSS(`max-height`)가 막고 그 위로는 스크롤이다.
   *
   * 의존성에 `zone.kind` 를 넣는 이유(검토 QA-R1-02): 허락·질문 카드가 입력칸 자리를
   * 차지하면 textarea 가 사라졌다가 다시 나타나는데, Chat 자신은 계속 마운트돼 있고 초안도
   * 그대로라 `[draft]` 만으로는 다시 실행되지 않았다 — 5줄 초안이 한 줄 높이로 줄어 보였다.
   * 구역이 입력칸으로 돌아올 때도 높이를 다시 잰다.
   */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, zone.kind])
  /**
   * 대화 이벤트 줄의 "종이에서 보기" — 학생이 **명시적으로** 누른 이동이다. 그래서 닫아 둔
   * 종이도 다시 열고(자동으로 열리지 않는 규칙은 저장·감시에만 적용된다), 좁은 창이면 종이로
   * 넘어간다. 둘 중 하나만 하면 화면이 안 바뀐다(검토 P3-R1-04).
   */
  const goPaper = (sectionId: string, edited: boolean): void => {
    setPaneTab('paper')
    focusSection(sectionId)
    setPaneView('paper')
    if (paperClosed) setPaperClosed(false)
    if (edited) useReview.getState().setShowDiff(true)
  }

  if (!projectRoot) return <NoFolder text={newText} setText={setNewText} onSubmit={submitNew} submitted={submitted}
    name={folderName} setName={setFolderName} onPick={() => void chooseFolder(false)} onCreate={() => void chooseFolder(true)}
    busy={folderBusy} createError={folderError} onBack={() => { submission.current += 1; setQueued(null); setSubmitted(null); setFolderError(null) }}
    reportNotice={reportNotice === 'no-folder'} onCloseReport={() => setReportNotice(null)} />

  /**
   * 문서 링크는 인앱 미리보기를 먼저 연다. 실제 경로·종류 판정과 읽기는 메인의 단일 관문이 맡는다.
   */
  const openFileLink = (relative: string): void => {
    openPreview(joinPath(projectRoot, relative))
  }

  /**
   * 대화 기록과 이벤트 줄을 **시각 순으로** 섞는다 — 이벤트 줄은 저장된 글이 아니라 앱이
   * 그리는 표시라 대화 파일에 없고, 그래서 화면에서만 순서를 맞춘다.
   *
   * 접기는 두 축이다(형님 11-09).
   *  - 한 턴의 중간말: 그 턴의 마지막 assistant 말만 최종 답으로 펴고 앞말은 `ProgressFold` 한 줄로 묶는다.
   *  - 지금 질문 카드가 읽는 말: 카드가 이미 보여 주는 줄(보기 목록·번호 칸)을 원문에서 접는다.
   * 어느 축이든 **글자를 지우지 않는다** — 펼치면 원문 그대로다.
   *
   * 카드가 **실제로 보일 때만** 원문을 접는다. 형식 질문에서 '자유롭게 답하기'를 누르면 카드는 숨고
   * 입력칸이 뜨는데(`freeForm`), 그때까지 접어 두면 학생은 무엇에 답해야 하는지 '여기에 펼치기'를
   * 눌러야 볼 수 있다. 접힘은 카드가 보여 주는 글의 대역이므로 카드와 함께 사라져야 한다(검토 wFJ:p1).
   */
  const cardId = zone.kind === 'question' ? zone.messageId
    : zone.kind === 'form' && !freeForm ? zone.messageId
      : null
  /** 여러 칸 질문 카드는 `parseQuestionForm` 이 읽은 원문의 머리 줄~마지막 칸 줄을 이미 보여 준다. */
  const formFold = zone.kind === 'form'
    ? (() => {
        const found = formFoldOf(snapshot?.messages.find((m) => m.id === zone.messageId)?.text ?? '')
        return found ? { spans: found.spans, count: found.count, kind: 'fields' as const } : null
      })()
    : null
  const folds = progressGroups(snapshot?.messages ?? [])
  const thread: { key: string; at: number; node: ReactNode }[] = []
  const messageNode = (m: ChatMessage): ReactNode => {
    const card = cardId === m.id
    const span = card
      ? zone.kind === 'question' ? { spans: [zone.card.span], count: zone.card.options.length, kind: 'options' as const }
        : formFold
      : null
    // 도우미 답의 진행 목록 덩어리는 제목줄에만 보인다(IMPL-T1 §3-1) — 본문에서 조용히 걷는다.
    // 무효 덩어리는 감추지 않는다(글이 사라지면 안 됨). `다음 작업`·`지금 확인할 것` 줄은 구간 밖이라 남는다.
    const hide = m.role === 'assistant' ? progressHide(m.text) : []
    return <Message key={m.id} m={m} sending={lastPending && m.id === lastUser?.id} onFileLink={openFileLink} onResend={!running && m.delivery === 'uncertain' ? () => void send(m.text) : undefined}
      fold={span ?? undefined} hide={hide.length ? hide : undefined} />
  }
  // 한 묶음은 첫 말 자리에 한 번만 선다 — 두 번째 말에서 또 만들면 같은 묶음이 여러 번 그려진다.
  const placed = new Set<string>()
  for (const m of snapshot?.messages ?? []) {
    const group = folds.find((g) => g.ids.has(m.id))
    if (group) {
      if (!placed.has(group.key)) {
        placed.add(group.key)
        thread.push({
          key: group.key, at: group.at,
          node: <ProgressFold key={group.key} count={group.count}>{group.messages.map(messageNode)}</ProgressFold>
        })
      }
      continue
    }
    thread.push({ key: m.id, at: Date.parse(m.at) || 0, node: messageNode(m) })
  }
  for (const e of events) {
    const edit = e.edit
    thread.push({ key: `ev-${e.id}`, at: Date.parse(e.at) || 0, node: <EventLine key={`ev-${e.id}`} title={e.title} edit={edit} onGo={() => goPaper(e.sectionId, edit?.kind === 'edited')} /> })
  }
  thread.sort((a, b) => a.at - b.at)

  return (
    <div className="chat-inner">
      {/* 빈 대화: "시작하기"를 타이핑하게 하지 않고 버튼이 문자열을 대신 보낸다(03-화면/03 결정). */}
      {emptyChat && (
        <div className="chat-empty">
          <div className="t">{CHAT.emptyTitle}</div>
          {status?.connected && !statusFailed ? (<>
            <div>{CHAT.emptyBodyStart}</div>
            {/* 고른 AI 로 바로 시작한다 — AI 를 고르는 자리는 첫 실행 1단계와 계정 팝오버다
                (여기서 다시 고르게 하지 않는다, DESIGN §4). 고르는 규칙은 그대로다. */}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <button className="primary" disabled={busy} onClick={() => void send(hasRevision ? CHAT.firstTurnNext : CHAT.firstTurn)}>{hasRevision ? CHAT.resume : CHAT.startNew}</button>
            </div>
            <p className="caption">{CHAT.emptyChangeAi}</p>
          </>) : <div>{CHAT.emptyBody}</div>}
        </div>
      )}

      <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll}>
        {switchNotice && <div className="chat-event" role="status">{PROVIDER_NAME[switchNotice]}는 {PROVIDER_NAME[switchNotice === 'claude' ? 'codex' : 'claude']}와 나눈 대화를 볼 수 없어요. 논문 파일과 진행 상황은 그대로 이어져요. 방금 한 답이 아직 논문에 안 들어갔다면 다시 말해 주세요.</div>}
        {thread.map((t) => <Fragment key={t.key}>{t.node}</Fragment>)}
      </div>

      {/* 아래 칸 — 질문 카드 · 허락 카드 · 작업 중 한 줄 · 입력칸이 이 한 자리를 번갈아 쓴다.
          무엇이 쓸지는 zone.ts 한 함수가 정한다(설계 §4-1). */}
      <div className="chat-zone">
        {/* 맨 아래로 — 아래 칸 바로 위 가운데 원형 아래 화살표(형님 맥 실사용 2026-10-20 ④). 화면 구석 고정이 아니다. */}
        {!atBottom && snapshot && snapshot.messages.length > 0 && (
          <button type="button" className="to-bottom" title={CHAT.toBottom} aria-label={CHAT.toBottom} onClick={() => toBottom(true)}><Icon name="down" size={18} /></button>
        )}
        {/* 입력칸 위 한 줄 알림 — 기다림·경고·오류가 쓰는 한 자리(알림창 B안). */}
        {waiting && <ZoneLine tone="wait" title={waiting === 'prep' ? CHAT.preparingLine : CHAT.appBusyTitle}
          sub={waitingPrep ? CHAT.preparingQueued : waiting === 'write' ? CHAT.appBusyWaitSub : undefined} />}
        {preparation?.phase === 'blocked' && <ZoneLine tone="attn" title={preparationFailureTitle(preparation.error)}
          sub="쓴 글은 그대로 남아 있어요. 준비한 뒤 다시 보내 주세요." raw={preparation.error?.message}
          actions={<button type="button" className="lk" onClick={() => projectRoot && void useProject.getState().prepareDeps(projectRoot)}>다시 준비</button>} />}
        {pError && <ZoneLine tone={toneOf(pError.kind)} title={pError.title} sub={pError.action} raw={pError.raw} onClose={clearPError} onReport={toneOf(pError.kind) !== 'info' ? () => requestReport(pError.title) : undefined} />}
        {/* 전역 오류로 같은 실패가 뜨는 자리 — 재시도 대상 root 는 store 가 오류와 함께 보관한
            `openFailure.root` 다(이전 프로젝트 root 가 아니다). */}
        {pError && pOpenFailure && pError.code === pOpenFailure.code && (
          <>
            {pRetryFailed && <ZoneLine tone="attn" title={RUNTIME.retryFailedTitle} sub={RUNTIME.retryFailedBody} onReport={() => requestReport(RUNTIME.retryFailedTitle)} />}
            <RuntimeFix failure={pOpenFailure} onRetry={async () => retryOpen(pOpenFailure.root)} />
          </>
        )}
        {chatErr && <ZoneLine tone={toneOf(chatErr.kind)} title={chatErr.title} sub={chatErr.action} raw={chatErr.raw} onClose={clearError} onReport={toneOf(chatErr.kind) !== 'info' ? () => requestReport(chatErr.title) : undefined} />}
        {snapshot && haltKey && !closedNotes.has(haltKey) && (
          <ZoneLine tone="attn" title={snapshot.state === 'stopped' ? CHAT.stoppedTitle : CHAT.interruptedTitle} sub={snapshot.state === 'stopped' ? CHAT.stoppedBody : CHAT.interruptedBody}
            actions={lastUncertain ? <button type="button" className="lk" onClick={() => void send(lastUncertain.text)} disabled={running || busy || !!waiting}>{CHAT.resend}</button> : undefined}
            onClose={() => closeNote(haltKey)} onReport={() => requestReport(snapshot.state === 'stopped' ? CHAT.stoppedTitle : CHAT.interruptedTitle)} />
        )}
        {snapErr && snapErrKey && !closedNotes.has(snapErrKey) && <ZoneLine tone="bad" title={snapErr.title} sub={snapErr.action} raw={snapErr.raw} onClose={() => closeNote(snapErrKey)} onReport={() => requestReport(snapErr.title)} />}
        {reportNotice && reportNotice !== 'no-folder' && <ZoneLine tone="info"
          title={reportNotice === 'status-failed' ? CHAT.statusFailTitle : reportNotice === 'disconnected' ? REPORT.disconnected : reportNotice === 'offline' ? REPORT.offline : REPORT.notice}
          sub={reportNotice === 'status-failed' ? CHAT.statusFailBody : zone.kind === 'permission' && reportNotice !== 'disconnected' ? REPORT.permission : undefined}
          actions={reportNotice === 'disconnected' ? <button type="button" className="lk" onClick={() => {
            const button = document.querySelector<HTMLButtonElement>('.chat-composer .composer-model-host > button.model')
            if (button?.getAttribute('aria-expanded') !== 'true') button?.click()
            button?.focus()
          }}>{REPORT.login}</button> : undefined}
          onClose={() => setReportNotice(null)} />}
        {zone.kind === 'permission' && <PermissionCard request={zone.request}
          onRespond={(id, allow) => void respond(id, allow)}
          onAllowAlways={(id) => { if (projectRoot) void window.knuaf.trustProject(projectRoot, true); void respond(id, true) }} />}

        {zone.kind === 'question' && (
          <>
            <div className="qcard-wrap">
              {quote && quote.root === projectRoot && <ReviewQuoteChip quote={quote} onRemove={clearQuote} style={{ marginTop: 'var(--sp-4)', marginBottom: -8, position: 'relative', zIndex: 1 }} />}
              <QuestionCard key={zone.messageId} card={zone.card} draft={draft} onDraft={setDraft} onSend={send}
                onSendFree={() => sendBody()} canSendFree={canSend && !busy && !waiting} freeRequest={freeRequest?.messageId === zone.messageId ? freeRequest.seq : 0} />
            </div>
            <div className="crow question-model"><ComposerModelChip /></div>
          </>
        )}

        {zone.kind === 'form' && (
          <>
            <div hidden={freeForm}><QuestionForm key={zone.messageId} form={zone.form} onFree={() => setFreeFormId(zone.messageId)} onSend={send} disabled={busy || !!waiting} /></div>
            {!freeForm && <div className="crow question-model"><ComposerModelChip /></div>}
          </>
        )}

        {(zone.kind === 'running' || zone.kind === 'composer' || zone.kind === 'disconnected' || freeForm) && (
          <>
            {freeForm && <button type="button" onClick={() => setFreeFormId(null)}>{QUESTION_FORM.back}</button>}
            {zone.kind === 'disconnected' && <ZoneLine tone="info" title={connState === 'checking' ? CHAT.checking : chatConnTitle} sub={connState === 'checking' ? undefined : chatConnSub} />}
            {/* 작업 중 한 줄 — 입력칸 위. 입력칸은 쓸 수 있게 두고 보내기만 막는다. 마지막 학생 메시지가 아직
                보내는 중이면 그 말풍선 아래 글자가 진행 표시라 이 줄은 그리지 않는다(작업 중엔 늘 1개). */}
            {zone.kind === 'running' && !lastPending && (
              <div className="zone-status"><span className="spin" />{CHAT.runningLine}</div>
            )}
            {/* 인용 칩 — 입력칸 바로 위(N-I03). 이 논문의 인용만 보여 준다(QA2B-R1-01). */}
            {quote && quote.root === projectRoot && <ReviewQuoteChip quote={quote} onRemove={clearQuote} />}
            <div className="chat-composer" data-dragging={dragging || undefined}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation(); setDragging(false)
                const f = e.dataTransfer.files[0]
                if (f) insertPath(window.knuaf.pathForFile(f))
              }}>
              {/* 한 줄에서 시작해 글이 늘면 자란다 — 최대 높이 뒤에는 스크롤(시안 P/L). */}
              {/* placeholder 는 추천 문구로 바뀌지만 접근 이름은 고정이다(`aria-label`) — 낭독이 흔들리지 않고
                  선택자도 placeholder 에 기대지 않는다. `aria-live` 는 붙이지 않는다(입력칸 이름이 조용해야 한다). */}
              <textarea ref={taRef} value={draft} rows={1} aria-label={CHAT.placeholder}
                placeholder={suggestion ? CHAT.suggestionPlaceholder(suggestion) : CHAT.placeholder} title={CHAT.placeholderHint}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  /**
                   * → 키: 빈 입력칸이면 예시를 **채우기만** 한다(보내지 않는다 — Enter 는 학생 몫).
                   * 조합 중(한글 IME)이거나 수식키를 함께 누른 경우는 건드리지 않는다. Tab 은 쓰지 않는다
                   * (키보드 사용자의 초점 이동을 빼앗는다).
                   */
                  if (e.key === 'ArrowRight' && draft === '' && suggestion && !e.nativeEvent.isComposing
                    && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault()
                    setDraft(suggestion)
                    return
                  }
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  // 보내기 단추와 같은 조건이다. 작업 중·전송 중에는 키보드로도 보내지 않는다 —
                  // 단추만 막으면 Enter 로 들어와 main 의 소유권 잠금에 걸린다(검토 P1-R1-03).
                  if (zone.kind === 'running' || zone.kind === 'disconnected' || busy || !!waiting || !canSend) return
                  void sendBody()
                }} />
              <div className="crow">
                {/* 왼쪽 아래 32×32 원형 `+` — 파일 첨부(기존 동작 그대로). */}
                <button type="button" className="circ" title={CHAT.attach} aria-label={CHAT.attach} onClick={() => void attach()}><Icon name="plus" size={16} /></button>
                <ComposerModelChip />
                <span className="sp" />
                {/* 오른쪽 아래 34×34 원형 위 화살표(먹색 채움) — 작업 중이면 같은 자리 멈추기. */}
                {zone.kind === 'running'
                  ? <button type="button" className="send" title={CHAT.stop} aria-label={CHAT.stop} onClick={() => void stop()}><Icon name="stop" size={20} /></button>
                  : <button type="button" className="send" title={CHAT.send} aria-label={CHAT.send} onClick={() => void sendBody()} disabled={zone.kind === 'disconnected' || busy || !!waiting || !canSend}><Icon name="up" size={17} /></button>}
              </div>
            </div>
            <p className="disc">{CHAT.disclaimer}</p>
          </>
        )}

      </div>
    </div>
  )
}
