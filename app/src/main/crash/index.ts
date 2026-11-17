/**
 * 오류 자동 보고 — 훅·큐·전송 (DESIGN §2-1·2-4·2-5).
 *
 * 원칙 셋:
 * - **죽는 프로세스는 비동기 전송을 기다릴 수 없다** → 잡으면 디스크 큐에만 쓰고, 보내는 것은
 *   다음 실행(`flush()`)이다.
 * - **수집기 예외는 앱 종료 코드를 바꾸지 않는다** → 세 콜백 본문은 `safely()` 한 겹만 탄다.
 * - **보낼 곳이 없으면 아무것도 안 한다** → `resolveReportUrl()` 이 주소를 못 주면 훅도 질문도
 *   디스크 기록도 0(개발 모드 기본).
 *
 * 의존 방향은 `ipc → crash → settings` 한 갈래다. 이 파일은 `ipc` 를 import 하지 않는다.
 */
import { app } from 'electron'
import type { Details as ChildProcessGoneDetails, RenderProcessGoneDetails, WebContents } from 'electron'
import { readdirSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../../shared/types'
import { loadSettings, saveSettings } from '../settings'
import {
  DAILY_MAX,
  MAX_ATTEMPT,
  buildRecord,
  clearQueue,
  dedupeKey,
  enqueue,
  logQuietly,
  readQueue,
  readState,
  safely,
  setBundleAssets,
  writeQueue,
  writeState,
  type CrashRecord,
  type CrashSource,
  type QueueItem,
  type RecordContext
} from './sanitise'

/** 운영 수신 주소 — `update/manifest.ts` 의 `CHANNEL_URL` 과 같은 자리(상수 한 곳). */
const REPORT_URL = 'https://knuaf-report.knuaf-report-worker.workers.dev/report'
const LOCAL_HOSTS = ['127.0.0.1', '[::1]', 'localhost']
/** 항목 하나의 전송 상한. 서버 16KB 상한과 무관하게 큐가 멈추지 않게 짧게 둔다. */
const POST_TIMEOUT_MS = 3000

let installed = false
let reportUrl: string | null = null
/** 진행 중 flush — 호출 자리가 둘이라 합류시킨다(C-02). */
let inflight: Promise<void> | null = null
/** 동의 전이 세대 — flush 시작 시점과 다르면 남은 항목을 보내지 않는다(C-02). */
let consentGeneration = 0
let currentAbort: AbortController | null = null
/** 429 를 받은 실행에서는 더 시도하지 않는다(같은 IP 한도 — 재시도가 악화시킨다). */
let throttled = false

/**
 * 주소 고르기 — ①`KNUAF_CRASH_URL`(검증 통과 시) ②설치판일 때만 운영 상수.
 * `updateConfig` 와 같은 모양이다: 비-로컬 주소는 https 만, http 는 루프백만.
 */
export function resolveReportUrl(): string | null {
  const raw = process.env.KNUAF_CRASH_URL
  try {
    if (raw) {
      const u = new URL(raw)
      const local = u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname) && !u.username && !u.password
      if (u.protocol === 'https:' || local) return u.toString()
      return null
    }
    return app.isPackaged ? REPORT_URL : null
  } catch {
    return null
  }
}

function context(now: Date): RecordContext {
  return { appRoot: app.getAppPath(), version: app.getVersion(), platform: process.platform, release: osRelease(), arch: process.arch, now }
}

/** `Error` 모양에서 이름·코드·스택만 꺼낸다. 메시지·인자는 읽지 않는다(개인정보). */
function errorParts(error: unknown): { name: string; code: unknown; stack: unknown } {
  if (error instanceof Error) {
    // `code` 는 Node 의 `SystemError` 에만 있다 — 기본 `Error` 타입에 없으므로 좁혀서 읽는다.
    const code = 'code' in error ? error.code : null
    return { name: error.name, code, stack: error.stack }
  }
  return { name: 'NonErrorRejection', code: null, stack: null }
}

/**
 * 동의가 `off` 면 **아무것도 쓰지 않는다**(디스크 흔적 0). `unset` 은 큐에 남긴다 — 다음 실행의
 * 질문이 "무엇을 보낼지"를 갖고 있어야 답이 의미를 갖는다(§2-4).
 */
function persist(rec: CrashRecord | null): void {
  if (!rec) return
  const consent = loadSettings().report_consent ?? 'unset'
  if (consent === 'off') return
  enqueue(app.getPath('userData'), rec, new Date())
}

/** main 예외·거부 1건. `origin` 은 Electron 이 주는 두 값만 받는다. */
function recordMain(error: unknown, origin: string): void {
  const parts = errorParts(error)
  persist(buildRecord({
    source: 'main',
    name: parts.name,
    code: parts.code,
    origin,
    stack: parts.stack
  }, context(new Date())))
}

/** 렌더러·자식 사망 — 스택이 없으므로 위치는 `null` 이고 `code` 가 `d.reason` 이다. */
function recordGone(source: CrashSource, name: string, details: { reason: string }, origin?: 'Utility'): void {
  // 정상 종료는 사망이 아니다.
  if (!details || typeof details.reason !== 'string' || details.reason === 'clean-exit') return
  persist(buildRecord({ source, name, code: details.reason, origin, stack: null }, context(new Date())))
}

/**
 * 렌더러 청크 허용 목록 — 앱 묶음 안 `out/renderer/assets` 를 **실행 중에** 읽는다(C-01).
 * 빌드 때 생성한 목록 파일을 두지 않는 이유: 설치판에서 묶음 경로가 실행 중에만 정해지고,
 * 목록과 실제 산출물이 어긋나면 조용히 다른 이름이 통과하기 때문이다.
 * 실패는 빈 목록 = 렌더러 프레임 미수집으로 끝난다(진단 1줄 손실 < 잘못된 이름 통과).
 */
function loadBundleAssets(): void {
  try {
    const dir = join(app.getAppPath(), 'out', 'renderer', 'assets')
    setBundleAssets(readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name))
  } catch {
    setBundleAssets([])
  }
}

/**
 * 훅 설치 — `app.setPath('userData')` 뒤, `whenReady` 앞에서 1회. 주소가 없으면 **아무것도
 * 하지 않고 반환**한다(수집·큐·질문 0).
 */
export function installCrashHooks(): void {
  if (installed) return
  reportUrl = resolveReportUrl()
  if (!reportUrl) return
  installed = true
  loadBundleAssets()
  // `uncaughtException`·`unhandledRejection` 리스너는 **달지 않는다** — 달면 앱이 안 죽거나
  // (전자) 거부가 경고로 강등된다(후자). monitor 는 원래 종료 동작을 바꾸지 않는다.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    safely(() => recordMain(error, origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException'))
  })
  // `GPU`·`Zygote`·helper 는 드라이버·가상화 잡음이라 이벤트를 만들지 않는다 — `Utility` 만.
  app.on('child-process-gone', (_e, details: ChildProcessGoneDetails) => {
    safely(() => {
      if (details.type !== 'Utility') return
      recordGone('child', 'ChildProcessGone', details, 'Utility')
    })
  })
}

/** 창마다 렌더러 사망을 본다 — `createWindow` 의 `new BrowserWindow` 직후에 단다. */
export function watchRenderer(contents: WebContents): void {
  if (!installed) return
  contents.on('render-process-gone', (_e, details: RenderProcessGoneDetails) => {
    safely(() => recordGone('renderer', 'RendererGone', details))
  })
}

/** 응답 → 큐 처리. 표에 없는 응답(3xx·402·405 등)은 폐기해 큐를 영원히 붙들지 않는다. */
function outcomeFor(status: number): 'sent' | 'drop' | 'retry' | 'stop' {
  if (status === 201) return 'sent'
  if (status === 429) return 'stop'
  if (status >= 500) return 'retry'
  return 'drop'
}

/**
 * 한 항목의 결과를 디스크에 반영한다. **쓰기 전에 다시 읽는다** — 카운터·큐는 한 파일을 공유하고
 * 다른 경로(수집기)가 그 사이에 항목을 더했을 수 있다.
 */
function applyOutcome(userData: string, item: QueueItem, outcome: 'sent' | 'drop' | 'retry'): void {
  const now = new Date()
  const key = dedupeKey(item.rec)
  const kept: QueueItem[] = []
  for (const current of readQueue(userData, now)) {
    if (dedupeKey(current.rec) !== key) {
      kept.push(current)
      continue
    }
    if (outcome !== 'retry') continue
    const attempt = current.attempt + 1
    if (attempt <= MAX_ATTEMPT) kept.push({ ...current, attempt })
  }
  writeQueue(userData, kept)
  if (outcome === 'sent') {
    const state = readState(userData, now)
    writeState(userData, { ...state, sent: state.sent + 1 })
  }
}

async function post(item: QueueItem): Promise<number | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), POST_TIMEOUT_MS)
  currentAbort = abort
  try {
    const response = await fetch(reportUrl as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 3xx 를 **따라가지 않는다**(I-02). 따라가면 보고 본문이 다른 수신지로 한 번 더 나가고,
      // 원래 응답 코드도 사라져 `outcomeFor` 가 폐기로 분류할 기회를 잃는다(DESIGN §2-4 표).
      redirect: 'manual',
      // `rec` 만 보낸다 — `attempt`·`first_seen` 은 로컬 관리용이라 본문에 섞지 않는다.
      body: JSON.stringify(item.rec),
      signal: abort.signal
    })
    return response.status
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    currentAbort = null
  }
}

async function runFlush(): Promise<void> {
  if (!reportUrl) return
  const userData = app.getPath('userData')
  let consent = loadSettings().report_consent ?? 'unset'
  if (consent === 'off') {
    safely(() => clearQueue(userData))
    return
  }
  if (consent !== 'on') return
  const generation = consentGeneration
  const started = new Date()
  let state = readState(userData, started)
  if (state.sent >= DAILY_MAX) return
  for (const item of readQueue(userData, started)) {
    if (throttled) return
    if (generation !== consentGeneration) return
    // POST 직전 디스크 재확인 — 메모리 캐시를 믿지 않는다(설정 시트에서 방금 껐을 수 있다).
    consent = loadSettings().report_consent ?? 'unset'
    if (consent !== 'on') return
    state = readState(userData, new Date())
    if (state.sent >= DAILY_MAX) return
    const status = await post(item)
    // 응답을 기다리는 사이 철회·전이가 있었으면 큐를 건드리지 않는다 — 늦은 응답이 지운 큐를
    // 되살리거나, 보내지 않기로 한 학생의 항목을 지우는 경로를 여기서 끊는다.
    if (generation !== consentGeneration) return
    const outcome = status === null ? 'retry' : outcomeFor(status)
    if (outcome === 'stop') {
      throttled = true
      return
    }
    if (outcome === 'drop') logQuietly(`[crash] dropped: http ${status}`)
    if (outcome === 'retry' && item.attempt + 1 > MAX_ATTEMPT) logQuietly('[crash] dropped: attempts exhausted')
    safely(() => applyOutcome(userData, item, outcome))
  }
}

/**
 * 다음 실행 전송. 호출 자리는 둘 — ①창을 만든 뒤 1회 ②`off`/`unset` → `on` 전이.
 * 이미 진행 중이면 새로 만들지 않고 그 promise 에 합류한다(C-02).
 */
export function flush(): Promise<void> {
  // `throttled` 는 **이번 실행 내내** 유지한다(R-01) — 429 는 같은 IP 한도라 재시도가 악화시킨다.
  // 여기서 되돌리면 같은 실행의 두 번째 flush 가 곧바로 다시 POST 한다(계약 위반).
  inflight ??= runFlush()
    .catch((error) => { logQuietly(`[crash] flush failed ${String(error)}`) })
    .finally(() => { inflight = null })
  return inflight
}

/** 질문할까 — `report_consent === 'unset' && queue.length > 0`. 훅이 없으면 언제나 `false`. */
export function crashStatus(): { ask: boolean } {
  if (!reportUrl) return { ask: false }
  try {
    if ((loadSettings().report_consent ?? 'unset') !== 'unset') return { ask: false }
    return { ask: readQueue(app.getPath('userData')).length > 0 }
  } catch {
    return { ask: false }
  }
}

/**
 * 질문 응답. 답하면 평생 1회다 — `unset` 에서만 묻고, "안 보내기"도 답으로 굳힌다.
 * 훅이 없는 실행에서는 저장만 한다(큐·전송 손대지 않음).
 */
export function crashAnswer(allow: boolean): void {
  const saved = saveSettings({ report_consent: allow ? 'on' : 'off' })
  onConsentChanged(saved.report_consent)
}

/** 설정 변경(설정 라디오·질문 응답 공통). `off` 는 진행 중 전송을 끊고 대기 항목을 지운다. */
export function onConsentChanged(consent: Settings['report_consent']): void {
  consentGeneration += 1
  if (!reportUrl) return
  if (consent === 'off') {
    currentAbort?.abort()
    safely(() => clearQueue(app.getPath('userData')))
    return
  }
  if (consent === 'on') void flush()
}
