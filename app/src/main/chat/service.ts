import { CLAUDE_AUTH_COPY, CODEX_AUTH_COPY, MODEL_SELECTION_COPY } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findExecutable, installSkill, skillState, skillTargets, skillVersion, VERSION_FILE } from '../agent'
import { readRecoverable, tmpOf, writeFileAtomic, type SafeWriteFs } from '../safeWrite'
import { ClaudeAuthenticationError, ClaudeConnection } from './claude'
import { CodexAuthenticationError, CodexConnection } from './codex'
import { subscriptionEnv, type AgentConnection, type AgentOptions } from './contracts'
import { chatConnectionKey } from './jobs/key'
import { JobRunner, type JobConnection, type JobResult, type JobSpec, type RelayRequest } from './jobs'
import { JobStore } from './jobs/store'
import { canonical } from './jobs/isolation'
import type { ConversationOwner, ExecutionAccount } from './jobs/types'
import type { LanePlan } from '../../shared/lanes'
import type { ChatModels, ChatModelInfo, ChatSnapshot, ModelChoice, PermissionRequest, Provider, ConnectionStatus } from '../../shared/chat'
import { effectiveModelChoice, isCrossProviderModelId } from '../../shared/chat'

import { skillSwitch } from '../update/switch'
import { agentActivity } from '../update/activity'
/** 저장된 대화 기록을 읽고 모양을 확인한다 — 망가졌으면 던진다. */
function parseChat(text: string, provider: Provider): ChatSnapshot {
  const v = JSON.parse(text) as ChatSnapshot
  if (!Array.isArray(v?.messages) || v.provider !== provider) throw new Error('대화 기록을 읽지 못했어요. 기존 기록을 보존한 채 복구가 필요해요.')
  return v
}

const authCopy = (provider: Provider): string => provider === 'codex' ? CODEX_AUTH_COPY.required : CLAUDE_AUTH_COPY.required
// 문자열만 온 이전 Codex에서는 실제 로그아웃·계정 변경으로 갱신이 거부된 문장만 인정한다.
const codexAuthFailure = (error: unknown): boolean => error instanceof CodexAuthenticationError ||
  (error instanceof Error && /\b(?:your )?access token could not be refreshed because you have since logged out or signed in to another account\b/i.test(error.message))

export class ChatService {
  private snapshots = new Map<string, ChatSnapshot>()
  private connections = new Map<string, AgentConnection>()
  private owners = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  private shuttingDown = false
  private authRequired = new Set<Provider>()
  private authGeneration: Record<Provider, number> = { codex: 0, claude: 0 }
  private reauthenticating = new Map<Provider, AgentConnection>()
  private pendingLogins = new Set<Provider>()
  private closingConnections = new Set<AgentConnection>()
  hasPendingLogin(): boolean { return this.pendingLogins.size > 0 }
  suspend(): void { agentActivity.suspend() }
  resume(): void { agentActivity.resume() }
  private async checkedStatus(provider: Provider, connection: AgentConnection): Promise<ConnectionStatus> {
    const login = this.reauthenticating.get(provider)
    if (login) {
      const status = await login.status()
      if (status.connected && this.reauthenticating.get(provider) === login &&
          (!(login instanceof ClaudeConnection) || login.loginConfirmed)) {
        this.authGeneration[provider]++
        this.pendingLogins.delete(provider)
        this.authRequired.delete(provider)
        this.reauthenticating.delete(provider)
        return status
      }
      return { installed: true, connected: false, version: null, probe: 'ok', detail: authCopy(provider) }
    }
    if (this.authRequired.has(provider)) return { installed: true, connected: false, version: null, probe: 'ok', detail: authCopy(provider) }
    const status = await connection.status()
    if (status.connected) this.pendingLogins.delete(provider)
    return status
  }
  private async startLogin(provider: Provider, connection: AgentConnection): Promise<void> {
    this.pendingLogins.add(provider)
    this.reauthenticating.set(provider, connection)
    try { await connection.login() }
    catch (error) {
      if (this.reauthenticating.get(provider) === connection) this.reauthenticating.delete(provider)
      this.pendingLogins.delete(provider)
      throw error
    }
  }
  /** 종료 시작과 동시에 새 연결·상태 확인을 막는다. 기존 연결은 close()가 정리한다. */
  beginShutdown(): void { this.shuttingDown = true }
  private ensureActive(): void {
    if (this.shuttingDown) throw new Error('앱을 종료하고 있어요.')
  }
  /**
   * 아직 카드로 올리지 못한 권한 요청 줄. 카드는 한 번에 하나만 뜨지만 요청은 동시에
   * 온다 — 도우미가 서브에이전트를 띄우면 그쪽 도구 호출도 같은 통로로 들어온다.
   *
   * 슬롯 하나에 덮어쓰던 때에는 덮인 요청이 아무에게도 닿지 않았다. 학생 화면에는
   * 승인 창이 아예 뜨지 않은 채 "도우미가 작업 중"만 남았고, 기다리던 도구 호출은
   * SDK 가 끊을 때까지 매달렸다가 도우미에게 "Tool permission request failed:
   * AbortError: Stream closed"로 돌아갔다. 도우미는 그것을 "쓰기 권한 차단"으로 읽고
   * 학생에게 앱에 없는 설정을 켜라고 안내했다.
   *
   * 디스크에 남기지 않는다 — 앱이 다시 뜨면 기다리던 쪽은 이미 죽어 있다.
   */
  private waiting = new Map<string, PermissionRequest[]>()
  // ---------------------------------------------------------------- 담당(relay) 배선
  //
  // 앱당 하나의 `JobRunner` 를 이 서비스가 소유한다(ipc.ts 는 이음매를 넘기지 않는다).
  // 승인·동의는 `<userData>/jobs/` 앱 저장소만 근거다 — 논문 폴더의 `lanes.json` 은 사본일 뿐이다.
  private jobStoreInstance: JobStore | null = null
  private jobRunner: JobRunner | null = null
  /** 주문을 처음 본 폴더 — 종료·업데이트 때 `runner.stop` 대상. */
  private jobRoots = new Set<string>()
  /** 설치본이 읽는 스킬 폴더 — `RelayRequest.skill` 은 폴더다(엔진이 `SKILL.md` 를 붙인다). */
  private jobSkill: { path: string; schema: number; contractVersion: string } | null = null
  /** 업데이트 준비 구간 — 새 전달 차례를 열지 않는다(closeForUpdate 는 되돌릴 수 있다). */
  private jobsClosing = false
  /**
   * 아직 대화에 넣지 **못한** 담당 결과. claim(`beginDelivery`)은 이미 영속됐으므로 다시
   * 보내면 이중 전달이 된다 — 대신 이 지도에 들고 있다가 폴더가 빌 때 다시 넣는다.
   * `uncertain` 은 시도했지만 결과를 모를 때만 쓴다(넣지 않은 것이 확실한 대기와 구분).
   */
  private pendingDeliveries = new Map<string, { owner: ConversationOwner; result: JobResult }>()
  /** 다시 넣기 운전 중인 폴더 — 같은 결과를 두 번 넣지 않는다. */
  private drivingDeliveries = new Set<string>()
  /**
   * 보류 재구동의 단일 비행은 **폴더 단위**다. 전역으로 하나만 두면 A 폴더의 전달 차례가
   * 오래 걸리거나 승인 대기에서 멈출 때 독립된 B 폴더의 준비된 결과까지 함께 멈춘다.
   * 같은 폴더 안에서만 직렬화하면 겹친 회차의 중복 재전달은 그대로 막힌다.
   */
  private drivingPending = new Map<string, Promise<void>>()
  /**
   * 학생이 중단할 때마다 오르는 폴더별 세대. `prepare()` 처럼 오래 기다리는 구간을 지나
   * 돌아왔을 때 "그 사이 중단됐는가"를 화면 상태와 별개로 확정한다(상태 문자열은 다른
   * 경로가 다시 'running' 으로 덮을 수 있다).
   */
  private stopEpoch = new Map<string, number>()
  /** 수집이 꺼진 사실을 폴더·공급자당 한 번만 알린다. */
  private collectDisabled = new Set<string>()
  /** 같은 주문 번호가 다른 폴더에 있어 건너뛴 사실을 폴더·번호당 한 번만 알린다. */
  private duplicateNotified = new Set<string>()
  /** 남의 폴더 대기 주문을 이번 차례에서 미뤘다는 사실을 폴더·주문 묶음당 한 번만 남긴다. */
  private deferredNotified = new Set<string>()
  /** 러너 전달 기록 ↔ 앱 전달 기록 대조를 이미 했는가(프로세스당 한 번). */
  private reconciled = false
  /** 보류한 전달을 다시 시도하는 타이머 — 폴더가 빌거나 업데이트 준비가 풀리면 깨어난다. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** 주문 수집 직렬화 — 러너의 `skill()` 이 폴더 인자를 받지 않는 계약 때문이다. */
  private collectChain: Promise<void> = Promise.resolve()
  constructor(private opts: {
    skillSource: () => string; userData: string; env?: NodeJS.ProcessEnv
    emit: (s: ChatSnapshot) => void; openExternal: (url: string) => Promise<void>
    /** Test seam: build connections without spawning real agent processes (e2e/chat.spec.ts). */
    connectionFactory?: (provider: Provider, options: AgentOptions) => AgentConnection
    /** True while the app itself holds a sidecar write transaction; send() must not interleave. */
    sidecarBusy?: (root: string) => boolean
    /** 도우미가 쓸 Python — 프로젝트 .venv 와 번들 CPython. */
    venvPython?: (root: string) => string | null
    bundledPython?: () => string | null
    /** 학생이 "이 폴더에서는 계속 허용"을 고른 폴더인가. */
    isTrusted?: (root: string) => boolean
    /**
     * 지금 설정에 남은 모델 선택(공급자별). 대화 파일이 아니라 설정 쪽이 정본이다 —
     * 이번 판은 대화 저장 형식을 그대로 둔다.
     */
    modelChoice?: (provider: Provider) => ModelChoice | null
    /**
     * 이 공급자로 모델을 고른 적이 있는가(설정에 흔적이 있는가). 없으면 해제를 저장하지도,
     * 기본값 복귀를 확인하지도 않는다 — 고른 적 없는 학생의 요청은 지금까지와 같아야 한다.
     */
    modelChosen?: (provider: Provider) => boolean
    /**
     * 고른 값을 설정에 남기는 통로(ipc 가 settings.json 에 쓴다). 저장을 여기서 하는 이유는
     * **선택의 선후**를 한 곳에서 지키기 위해서다 — 느린 검증이 나중에 끝나도 마지막 선택을
     * 덮지 않는다(검토 MC1-03).
     */
    storeModelChoice?: (provider: Provider, choice: ModelChoice | null) => void
    /** Test seam: 대화 기록·초안을 쓰는 파일시스템(e2e/safe-write.spec.ts 가 실패를 주입한다). */
    fs?: SafeWriteFs
    /**
     * 담당(relay) 연결 — 본대화 연결과 **다른** 통로다(설계 §3.3 ④). 없으면 주문 수집이
     * 꺼진다. 가짜 기본값을 만들지 않는다: `AgentConnection` 에는 계정·usage 통로가 없어
     * 배선 A가 공급해야 한다.
     */
    jobConnectionFactory?: (request: RelayRequest) => JobConnection
    /** 담당 회사의 구독·한도 상태. 계정이 없으면 `null`. */
    jobAccount?: (company: Provider) => Promise<ExecutionAccount | null>
    /** 셸 격리를 실제로 걸 수 있는가(배선 A의 플랫폼 확인값). 모르면 false. */
    jobShellSandboxAvailable?: boolean
    /**
     * 대화 전환·중단 때 열린 제안을 버리는 통로(`ConversationHandoff.invalidate`).
     * 실제 인스턴스는 ipc.ts가 쥐고 있어 이 단위에서는 연결할 수 없다 — 통합 몫.
     */
    invalidateHandoff?: (root: string) => void | Promise<void>
  }) {}
  private get writeFs(): SafeWriteFs { return this.opts.fs ?? { writeFileSync, renameSync, unlinkSync, readFileSync: (p) => readFileSync(p, 'utf8') } }
  /** PATH 앞자리에 둘 인터프리터 bin 경로 — 프로젝트 .venv 가 번들보다 우선한다. */
  private pythonBinDirs(root: string): string[] {
    const venv = this.opts.venvPython?.(root) ?? null
    const bundled = this.opts.bundledPython?.() ?? null
    return [venv, bundled].filter((p): p is string => !!p).map((p) => dirname(p))
  }
  /**
   * 스냅샷·연결·실행·권한 줄의 지도 키. 폴더 경로는 **호출자가 준 문자열 그대로**가 아니라
   * 실제 경로(심링크 해소)로 맞춘다. `JobRunner` 는 `owner.id` 에 canonical root 를 넣고
   * 그 값으로 `stopMain` 을 부르는데, 지도가 raw 문자열로 키를 잡으면 macOS 의 iCloud
   * 데스크톱(`~/Desktop` 심링크) 같은 폴더에서 본대화 중단·연결 정지가 빗나간다.
   * 파일 경로(`file()`·`skillDir()`)는 학생이 고른 경로 그대로 둔다 — 여기서만 맞춘다.
   */
  private key(root: string, provider: Provider, role = 'main') {
    let path = root
    try { path = canonical(root) } catch { /* 없는 경로는 준 문자열로 둔다 */ }
    return chatConnectionKey(path, provider, role)
  }
  private file(root: string, provider: Provider) { return join(root, '.knuaf-gui', `chat-${provider}.json`) }
  /**
   * 아직 보내지 않은 입력. 대화 기록과 같은 자리에 두되 공급자별로 나누지 않는다 —
   * 학생이 쓰던 문장은 도우미를 바꿔도 그대로여야 한다. 폴더별로 따로 있어야
   * 프로젝트를 옮겼을 때 남의 초안이 따라가지 않는다(GUI 감사 GUI-01·GUI-06).
   */
  private draftFile(root: string) { return join(root, '.knuaf-gui', 'draft.txt') }
  /**
   * 초안은 메인이 쥐고 있다가 모아서 쓴다. 렌더러에 타이머를 두면 "쓰고 곧바로 종료"
   * 하는 학생의 입력이 타이머가 돌기 전에 사라진다 — 실제로 테스트가 그 틈을 밟았다.
   * 종료 직전 flushDrafts() 가 동기로 쓰므로 그 틈이 없다.
   */
  private draftPending = new Map<string, string>()
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  draft(root: string): string {
    const pending = this.draftPending.get(root)
    if (pending !== undefined) return pending   // 아직 안 쓴 값이 디스크보다 최신이다
    let got: ReturnType<typeof readRecoverable<string>>
    try { got = readRecoverable(this.draftFile(root), (t) => t) } catch { return '' }
    if (!got) return ''
    // 저장이 막혀 `.tmp` 에만 남았던 글 — 다음 flush 가 제자리로 옮긴다(WIN-ONEDRIVE-R1-01).
    if (got.from === 'tmp') this.setDraft(root, got.value)
    return got.value
  }
  setDraft(root: string, text: string, expected?: string): boolean {
    // 첫 메시지 보관본의 성공 정리: 그 사이 편집된 초안은 건드리지 않는다(INT1-01).
    if (expected !== undefined && this.draft(root) !== expected) return false
    this.draftPending.set(root, text)
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => this.flushDrafts(), 250)
    return true
  }
  /** 대기 중인 초안을 지금 쓴다. 종료 직전에도 불리므로 동기다. */
  flushDrafts(): void {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null }
    for (const [root, text] of this.draftPending) {
      const file = this.draftFile(root)
      if (!text) {
        // 빈 값도 최신 초안이다 — 지우기가 막혔는데 대기를 비우면 이미 보낸 글이 `draft()` 로 되살아난다
        // (WIN-ONEDRIVE-R1-02). 남은 `.tmp` 도 지운다: 그것도 되살리는 자리다.
        let cleared = true
        for (const path of [file, tmpOf(file)]) {
          try { this.writeFs.unlinkSync(path) } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue
            cleared = false
            console.error(`[knuaf] 빈 초안을 지우지 못했어요: ${path} (${(e as NodeJS.ErrnoException)?.code ?? String(e)})`)
          }
        }
        if (cleared) this.draftPending.delete(root)
        continue
      }
      try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
      // 던지지 않는 공용 쓰기(WIN-ONEDRIVE). **성공한 것만** 지운다 — 실패하면 대기 값으로 남겨
      // 다음 flush 가 다시 시도하고, 그 사이 `draft()` 는 최신 글을 계속 돌려준다.
      if (writeFileAtomic(file, text, { mode: 0o600, fs: this.writeFs }).ok) this.draftPending.delete(root)
    }
  }
  /**
   * 대화 기록을 남기고 화면으로 내보낸다.
   *
   * 저장은 **던지지 않는** 공용 쓰기로 한다(WIN-ONEDRIVE): 윈도우에서 논문 폴더가 OneDrive
   * 동기화 폴더면 `renameSync` 가 `EPERM` 으로 막히는데, 이 함수는 에이전트 이벤트 콜백에서
   * 불리므로 예외가 올라가면 Electron 이 "A JavaScript error occurred in the main process"
   * 창을 띄운다. 저장이 실패해도 **메모리의 스냅샷을 그대로 내보낸다** — 화면 흐름을 막지 않는다.
   * 실패는 로그 한 줄로 강등한다(앱에 비치명 알림 자리가 없다 — §REPORT-WIN-ONEDRIVE).
   */
  private publish(s: ChatSnapshot) {
    const file = this.file(s.root, s.provider)
    try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
    // 승인 대기는 프로세스가 종료되면 복구할 수 없다. 파일 내용(diff)은 화면으로만 보낸다.
    const { permission: _permission, ...persisted } = s
    writeFileAtomic(file, JSON.stringify(persisted, null, 2), { mode: 0o600, fs: this.writeFs, complete: (text) => { try { parseChat(text, s.provider); return true } catch { return false } } })
    this.opts.emit(structuredClone(s))
  }
  snapshot(root: string, provider: Provider): ChatSnapshot {
    const key = this.key(root, provider)
    let s = this.snapshots.get(key)
    if (!s) {
      // Corrupt state must not silently reset the interview or its session.
      // 저장이 막혀 완성본이 `.tmp` 에만 있으면 그것으로 되살린다(WIN-ONEDRIVE-R1-01).
      const got = readRecoverable(this.file(root, provider), (text) => parseChat(text, provider))
      if (got) {
        s = got.value
        s.root = root; s.permission = undefined
        // `.tmp` 에서 되살린 기록은 곧바로 다시 저장한다 — 이름 바꾸기가 풀렸으면 제자리로 간다.
        let persist = got.from === 'tmp'
        if (s.state === 'running' || s.state === 'permission') {
          s.state = 'interrupted'; s.error = '앱이 작업 도중 종료됐어요. 마지막 답변은 자동 재전송하지 않았어요.'
          for (const m of s.messages) if (m.delivery === 'pending') m.delivery = 'uncertain'
          // Persist the recovered state at once so the renderer and the file agree after restart.
          persist = true
        }
        if (persist) {
          this.snapshots.set(key, s)
          this.publish(s)
        }
      } else s = { root, provider, state: 'idle', messages: [] }
      this.snapshots.set(key, s)
    }
    this.surfaceUncertain(root, s)
    return structuredClone(s)
  }
  /**
   * 전달 claim 뒤에 앱이 죽은 담당 결과를 **한 번** 드러낸다. 다시 보내지 않는다 —
   * 화면은 이 시스템 줄로 "확인 안 됨"을 알게 된다(시험 계획 B ①-2).
   */
  private surfaceUncertain(root: string, s: ChatSnapshot): void {
    if (!this.opts.jobConnectionFactory || !this.opts.jobAccount) return
    // 복구 대조는 성공할 때까지 스냅샷마다 다시 본다 — 저장 오류로 한 번 실패했다고 그
    // 결과를 영영 잃으면, 창에 걸린 전달을 드러내려던 이 장치가 무용지물이 된다.
    if (!this.reconciled) {
      try { this.reconciled = this.reconcileDeliveries() } catch (error) {
        console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-reconcile', error: error instanceof Error ? error.message : String(error) }))
      }
    }
    let pending: { rootJobId: string; at: string }[]
    try { pending = this.store().undelivered(root) } catch (error) {
      console.error('[knuaf] jobs', JSON.stringify({ type: 'store', error: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (!pending.length) return
    for (const item of pending) {
      s.messages.push({
        id: randomUUID(), role: 'system',
        text: '자료 담당 작업은 끝났는데 결과를 대화에 넣었는지 확인하지 못했어요. 다시 보내지 않았어요 — 작업 파일(`.knuaf-gui/jobs`)을 확인해 주세요.',
        at: new Date().toISOString()
      })
      try { this.store().markNotified(item.rootJobId) } catch (error) {
        console.error('[knuaf] jobs', JSON.stringify({ type: 'store', error: error instanceof Error ? error.message : String(error) }))
      }
    }
    this.publish(s)
  }
  busy(root: string) { try { return this.owners.has(realpathSync(root)) } catch { return false } }
  acquire(root: string): () => void {
    root = realpathSync(root)
    if (this.owners.has(root)) throw new Error('현재 작업이 끝나거나 중단된 뒤 다시 실행해 주세요.')
    const releaseActivity = agentActivity.enter()
    let releaseSwitch: () => void
    try { releaseSwitch = skillSwitch.enter() } catch (error) { releaseActivity(); throw error }
    this.owners.add(root)
    return () => {
      this.owners.delete(root); releaseSwitch(); releaseActivity()
      // 폴더가 빈 뒤에야 보류한 전달을 다시 시도할 수 있다 — 기다리지 않고 다음 틱에 넘긴다.
      void this.drivePending()
    }
  }
  /**
   * 보류한 전달을 다시 넣는다. 폴더가 비었고 업데이트 준비 구간이 아니면 지금 넣고,
   * 아니면 깨어날 조건(폴더 해제·업데이트 준비 끝)에서 다시 불린다. 조건이 밖에서
   * 풀리지 않는 경우(예: 전달 차례 자체가 대화 점유)에 대비해 짧은 타이머도 둔다.
   * 같은 폴더를 두 번에 걸쳐 운전하지 않는다(`drivingPending`).
   */
  private async drivePending(): Promise<void> {
    if (this.shuttingDown || this.jobsClosing) return
    // 업데이트 인계는 바깥 `agentActivity` 를 먼저 정지시킨다(handoff.ts). 정지 중에는
    // `acquire()` 가 `UpdateSuspendedError` 를 던지므로 실행이 재개되지 않는다 — 여기서는
    // 헛되이 꺼내지 않고 깨어날 때까지 미룬다. 정지는 인계가 끝나며 풀린다.
    if (agentActivity.suspended) { this.schedulePending(); return }
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    // 폴더마다 회차를 하나씩 띄운다. 서로 기다리지 않는다 — A 폴더의 전달 차례가 붙잡혀
    // 있어도 B 폴더의 준비된 결과는 들어간다. 회차는 자기 폴더 항목을 다 넣거나 막힐
    // 때까지 도는 루프이므로, 도중에 새로 보류된 항목도 같은 회차가 집어 간다.
    const roots = new Set<string>()
    for (const entry of this.pendingDeliveries.values()) {
      const parsed = this.ownerOf(entry.owner)
      if (parsed) roots.add(parsed.root)
    }
    for (const root of roots) this.launchDrive(root)
  }
  /**
   * 한 폴더의 재구동 회차를 띄운다. 같은 폴더의 회차가 이미 돌고 있으면 새로 띄우지 않는다 —
   * 그 회차가 지도에서 항목을 하나씩 다시 집어 가므로 겹친 호출이 같은 결과를 두 번 넣지 않는다.
   * 기다리지 않는다(호출자는 `acquire` 해제·타이머처럼 기다릴 수 없는 자리다).
   */
  private launchDrive(root: string): void {
    if (this.drivingPending.has(root)) return
    const run = this.driveRootOnce(root)
      .then(state => { if (state === 'blocked') this.schedulePending() },
        error => {
          console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-drive', root, error: error instanceof Error ? error.message : String(error) }))
          this.schedulePending()
        })
      .finally(() => { this.drivingPending.delete(root) })
    this.drivingPending.set(root, run)
  }
  /**
   * 이 폴더의 보류를 순서대로 넣는다. 항목은 **꺼내는 순간마다** 살아 있는 지도와 claim 을
   * 다시 확인한다 — 그 사이 지워졌거나 이미 넣은 결과를 다시 넣지 않기 위해서다.
   * `'blocked'` 는 폴더가 바쁘거나 방금 넣은 항목이 다시 보류로 돌아온 경우다(그때는
   * 타이머가 깨어날 때 다시 시도한다 — 여기서 곧바로 다시 집으면 뜨거운 루프가 된다).
   */
  private async driveRootOnce(root: string): Promise<'done' | 'blocked'> {
    for (;;) {
      if (this.shuttingDown || this.jobsClosing) return 'done'
      const next = this.takeParked(root)
      if (next === 'blocked') return 'blocked'
      if (!next) return 'done'
      const [rootJobId, entry] = next
      this.drivingDeliveries.add(root)
      try { await this.deliverResult(entry.owner, entry.result) }
      catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-drive', rootJobId, error: error instanceof Error ? error.message : String(error) })) }
      finally { this.drivingDeliveries.delete(root) }
      // 넣지 못해 방금 보류로 되돌아온 항목이면 회차를 접는다(다음 타이머가 재시도).
      if (this.pendingDeliveries.has(rootJobId)) return 'blocked'
    }
  }
  /**
   * **이 폴더의** 보류 중 지금 넣을 수 있는 하나를 지도에서 꺼낸다. 주인을 못 읽거나 claim 이
   * 닫힌 항목은 지우고 넘어간다. 다른 폴더 항목은 이 회차의 대상이 아니다(폴더별 단일 비행).
   * 넣을 수 없는데 남아 있으면 `'blocked'`(바쁨).
   */
  private takeParked(root: string): [string, { owner: ConversationOwner; result: JobResult }] | 'blocked' | null {
    let remaining = false
    for (const [rootJobId, entry] of [...this.pendingDeliveries]) {
      // 순회 중 지워졌거나 같은 키로 바뀌었으면 이 복사본은 낡았다.
      if (this.pendingDeliveries.get(rootJobId) !== entry) continue
      const parsed = this.ownerOf(entry.owner)
      if (!parsed) { this.pendingDeliveries.delete(rootJobId); continue }
      if (parsed.root !== root) continue
      // claim 이 이미 닫힌 결과(다른 경로가 넣었거나 학생이 중단으로 닫음)는 다시 넣지 않는다.
      if (!this.claimOpen(rootJobId)) { this.pendingDeliveries.delete(rootJobId); continue }
      if (this.busy(root)) { remaining = true; continue }
      this.pendingDeliveries.delete(rootJobId)
      return [rootJobId, entry]
    }
    return remaining ? 'blocked' : null
  }
  /** 이 폴더에 아직 넣지 못한 보류가 남아 있는가. */
  private pendingForRoot(root: string): boolean {
    for (const entry of this.pendingDeliveries.values()) if (this.ownerOf(entry.owner)?.root === root) return true
    return false
  }
  /** 이 결과의 전달 기록이 아직 열려 있는가(다른 경로가 `done`·`uncertain` 으로 닫지 않았는가). */
  private claimOpen(rootJobId: string): boolean {
    try { return this.store().deliveryState(rootJobId) === 'started' } catch { return true } // 저장소를 못 읽으면 기존 동작(넣기 시도)을 유지한다.
  }
  /** 보류 전달이 남아 있으면 잠시 뒤 다시 시도한다 — 조건이 밖에서 풀릴 때까지. */
  private schedulePending(): void {
    if (this.pendingTimer || this.shuttingDown || !this.pendingDeliveries.size) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      void this.drivePending()
    }, 1_000)
    this.pendingTimer.unref?.()
  }
  private skillDir(root: string, provider: Provider) { return skillTargets(root)[provider] }
  private connection(root: string, provider: Provider): AgentConnection {
    this.ensureActive()
    const key = this.key(root, provider)
    let c = this.connections.get(key)
    if (!c) {
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider), env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)),
        openExternal: this.opts.openExternal, trusted: () => this.opts.isTrusted?.(root) ?? false,
        // 연결은 폴더·공급자마다 한 번만 만들어진다 — 선택은 전송할 때마다 다시 읽는다.
        modelChoice: () => this.effectiveChoice(provider),
        modelChosen: () => this.opts.modelChosen?.(provider) ?? false
      }
      if (this.opts.connectionFactory) {
        c = this.opts.connectionFactory(provider, options)
      } else {
        const binary = findExecutable(provider)
        if (!binary) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 연결 설정의 설치 안내를 열어 주세요.`)
        options.binary = binary
        c = provider === 'codex' ? new CodexConnection(options) : new ClaudeConnection(options)
      }
      this.connections.set(key, c)
    }
    return c
  }
  async status(root: string, provider: Provider): Promise<ConnectionStatus> {
    return agentActivity.run(async () => {
    this.ensureActive()
    if (!this.opts.connectionFactory && !findExecutable(provider)) return { installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }
    return this.checkedStatus(provider, this.connection(root, provider))
    })
  }
  async login(root: string, provider: Provider) { return agentActivity.run(() => this.startLogin(provider, this.connection(root, provider))) }

  // ---------------------------------------------------------------- 모델 고르기 (ChatGPT 쪽)
  /**
   * 마지막으로 성공한 모델 목록. 전송할 때 고른 모델이 아직 이 계정에 있는지 판정하는 데 쓴다 —
   * 요금제가 바뀌어 목록에서 사라진 모델을 계속 보내면 **모든 전송이 실패**한다.
   * 아직 목록을 못 받았으면(`null`) 선택을 그대로 보낸다(학생이 방금 고른 값을 이유 없이 무시하지 않는다).
   */
  private modelLists = new Map<Provider, ChatModelInfo[]>()
  /** 선택 호출의 선후 — 느린 검증이 나중 선택을 덮지 않게 한다(검토 MC1-03). */
  private selectionSeq = new Map<Provider, number>()
  /** 설정의 선택을 이 계정 목록에 비춰 정규화한다 — 고른 모델이 없으면 `null`(안 골름). */
  private effectiveChoice(provider: Provider): ModelChoice | null {
    const stored = this.opts.modelChoice?.(provider) ?? null
    // 제외된 저장 선택은 해제(null)가 아니다. 명시적 재선택 전에는 전송을 차단한다.
    if (provider === 'codex' && stored?.model && isCrossProviderModelId(stored.model)) {
      throw new Error(MODEL_SELECTION_COPY.reselectionRequired)
    }
    return effectiveModelChoice(stored, this.modelLists.get(provider) ?? null)
  }
  /**
   * 이 계정이 쓸 수 있는 모델 목록. 통로가 없는 공급자는 `supported:false` 로 답한다 —
   * 화면은 추천도 칩도 띄우지 않고 지금처럼 기본값으로 둔다. 지금은 두 회사 모두 통로가
   * 있다(ChatGPT `model/list`, Claude 초기화 응답의 `models`).
   */
  async models(root: string | null, provider: Provider): Promise<ChatModels> {
    return agentActivity.run(async () => {
    // 폴더를 정하기 전에도 계정 목록은 고를 수 있다. 전역 연결로는 턴을 보내지 않는다.
    const connection = root ? this.connection(root, provider) : this.globalConnection(provider)
    if (!connection.models) return { provider, supported: false, models: [], selected: null }
    try {
      const models = await connection.models()
      this.modelLists.set(provider, models)
      return { provider, supported: true, models, selected: effectiveModelChoice(this.opts.modelChoice?.(provider), models) }
    } catch (e) {
      // 목록을 못 받았다고 저장된 선택을 지우지 않는다 — 화면이 "안 골름"으로 보이면 고른 것이 사라진 줄 안다.
      return {
        provider, supported: true, models: [],
        selected: provider === 'codex' && isCrossProviderModelId(this.opts.modelChoice?.(provider)?.model ?? '')
          ? null : this.opts.modelChoice?.(provider) ?? null,
        error: e instanceof Error ? e.message : '모델 목록을 받지 못했어요.'
      }
    }
    })
  }
  /**
   * 고른 모델·생각 깊이를 이 계정 목록으로 검증해 **설정에 남긴다**. `null` 은 "안 골름".
   *
   * 선택은 마지막 것이 이긴다: 호출마다 번호를 올리고, 목록을 기다리는 동안 더 새 선택이
   * 들어왔으면 저장하지 않고 **지금 설정값**을 돌려준다. 해제(null)는 목록을 기다리지 않으므로
   * 느린 선택 검증이 그 뒤에 끝나도 해제를 되살리지 못한다(검토 MC1-03).
   */
  async setModel(root: string | null, provider: Provider, choice: ModelChoice | null): Promise<ModelChoice | null> {
    return agentActivity.run(async () => {
    const seq = (this.selectionSeq.get(provider) ?? 0) + 1
    this.selectionSeq.set(provider, seq)
    if (!choice || typeof choice.model !== 'string' || !choice.model.trim()) {
      // 고른 적 없는 학생의 "해제"는 아무것도 남기지 않는다 — 흔적을 만들면 다음 재개부터
      // 기본값 조회가 돌아, 고른 적 없는 학생의 동작이 달라진다(검토 L-02).
      if (this.opts.modelChosen?.(provider) ?? true) this.opts.storeModelChoice?.(provider, null)
      return null
    }
    const list = await this.models(root, provider)
    if (this.selectionSeq.get(provider) !== seq) return this.opts.modelChoice?.(provider) ?? null
    if (!list.supported) throw new Error('이 도우미는 아직 모델 고르기를 지원하지 않아요.')
    if (list.error) throw new Error(list.error)
    const picked = effectiveModelChoice(choice, list.models)
    if (!picked) throw new Error('이 계정에서 쓸 수 없는 모델이에요. 목록을 다시 불러와 주세요.')
    if (choice.effort && !picked.effort) throw new Error('이 모델은 그 생각 깊이를 지원하지 않아요.')
    this.opts.storeModelChoice?.(provider, picked)
    return picked
    })
  }

  // ---------------------------------------------------------------- 전역 연결 (폴더 없이)
  //
  // 첫 실행은 폴더를 고르기 전에 "쓸 AI 를 연결"한다(IMPL-PLAN §4-3). 연결 대상은 CLI 전역
  // 계정이고 cwd 와 무관하므로(root 를 받는 것과 무관하게 같은 답이 나온다) 폴더별 연결과
  // **다른 맵**에 하나씩 둔다 — 키가 겹칠 자리가 없다.
  //
  // 이 연결은 상태 확인·로그인만 한다. 파일을 쓰는 일(스킬 설치)은 send() 안에서만
  // 일어나고 send() 는 폴더 연결만 쓴다 — 그래서 여기서는 논문 폴더도, connect-probe
  // 폴더도 건드리지 않는다. 그 성질을 깨려면 이 클래스에 새 메서드를 만들어야 한다.
  private globalRoot: string | null = null
  private globals = new Map<Provider, AgentConnection>()
  /** 전역 연결의 cwd — 빈 폴더. 논문 폴더가 아직 없어도 CLI 가 설 자리가 필요하다. */
  private connectRoot(): string {
    if (!this.globalRoot) {
      const dir = join(this.opts.userData, 'connect-probe')
      mkdirSync(dir, { recursive: true })
      this.globalRoot = dir
    }
    return this.globalRoot
  }
  private globalConnection(provider: Provider): AgentConnection {
    this.ensureActive()
    let c = this.globals.get(provider)
    if (!c) {
      const root = this.connectRoot()
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider),
        env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)),
        openExternal: this.opts.openExternal, trusted: () => false
      }
      if (this.opts.connectionFactory) {
        c = this.opts.connectionFactory(provider, options)
      } else {
        const binary = findExecutable(provider)
        if (!binary) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 연결 설정의 설치 안내를 열어 주세요.`)
        options.binary = binary
        c = provider === 'codex' ? new CodexConnection(options) : new ClaudeConnection(options)
      }
      this.globals.set(provider, c)
    }
    return c
  }
  /**
   * 폴더 없이 연결 상태를 본다. 설치가 없으면 `installed:false`, 있는데 핸드셰이크·계정
   * 조회가 실패하면(`probe:'failed'`) — 확인하지 못한 것을 "로그인 필요"로 꾸미지 않는다.
   */
  async globalStatus(provider: Provider): Promise<ConnectionStatus> {
    return agentActivity.run(async () => {
    this.ensureActive()
    if (!this.opts.connectionFactory && !findExecutable(provider)) return { installed: false, connected: false, version: null, detail: '설치 안내를 열어 준비한 뒤 다시 확인해 주세요.' }
    try {
      return await this.checkedStatus(provider, this.globalConnection(provider))
    } catch (e) {
      return { installed: true, connected: false, version: null, probe: 'failed', detail: e instanceof Error ? e.message : '연결 상태를 확인하지 못했어요.' }
    }
    })
  }
  async globalLogin(provider: Provider): Promise<void> { return agentActivity.run(() => this.startLogin(provider, this.globalConnection(provider))) }
  /** 취소 뒤에는 연결을 버린다 — 다음 확인이 새 프로세스로 상태를 다시 묻는다. */
  async cancelLogin(provider: Provider): Promise<void> {
    this.pendingLogins.delete(provider)
    this.reauthenticating.delete(provider)
    const c = this.globals.get(provider)
    this.globals.delete(provider)
    if (!c) return
    if (c.cancelLogin) await c.cancelLogin()
    else await c.stop()
  }
  async reopenLogin(provider: Provider): Promise<void> {
    return agentActivity.run(async () => {
      this.pendingLogins.add(provider)
      try {
        const c = this.globalConnection(provider)
        if (c.reopenLogin) await c.reopenLogin()
        else await c.login()
        this.reauthenticating.set(provider, c)
      } catch (error) { this.pendingLogins.delete(provider); throw error }
    })
  }
  async send(root: string, provider: Provider, text: string, requestId: string) {
    agentActivity.ensureActive()
    if (!text.trim() || text.length > 100_000) throw new Error('답변을 입력해 주세요. 한 번에 100,000자까지 보낼 수 있어요.')
    this.effectiveChoice(provider)
    this.snapshot(root, provider)
    const s = this.snapshots.get(this.key(root, provider))!
    if (s.messages.some(m => m.id === requestId)) return structuredClone(s)
    // The app may be mid-write (export/restore/init); agent writes must wait, not interleave.
    if (this.opts.sidecarBusy?.(root)) throw new Error('앱이 저장·검사 작업 중이에요. 끝난 뒤 답변을 보내 주세요.')
    const release = this.acquire(root)
    try {
      const skill = this.skillDir(root, provider)
      const source = this.opts.skillSource()
      const version = skillVersion(source)
      const state = skillState(skill, version)
      if (state === 'missing') installSkill(source, skill, version)
      else if (state === 'outdated' || (s.skillHash && s.skillHash !== version)) {
        // A changed skill is never a send-blocker: reinstall (with backup) and note it in the transcript.
        const marker = join(skill, VERSION_FILE)
        const old = s.skillHash && s.skillHash !== version ? s.skillHash : existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : '이전 버전'
        installSkill(source, skill, version)
        s.messages.push({ id: randomUUID(), role: 'system', text: `규칙집이 갱신됐어요 (이전 ${old} → 현재 ${version})`, at: new Date().toISOString() })
      } else installSkill(source, skill, version) // Refresh GUI ownership even for an unchanged copy.
      const connection = this.connection(root, provider)
      if (!(await this.checkedStatus(provider, connection)).connected) throw new Error(this.authRequired.has(provider) ? authCopy(provider) : 'AI 계정 연결을 먼저 완료해 주세요.')
      // 전송 전 확인 — 여기서 던지면 보낸 말이 대화에 남지 않고 초안도 그대로다. 예전 모델로
      // 조용히 보내는 대신 학생에게 오류로 알린다(검토 MC1-01).
      await connection.prepare?.(s.sessionId)
      s.skillHash = version; s.skillLoaded = false; s.state = 'running'; s.error = undefined
      s.authRequired = undefined
      s.messages.push({ id: requestId, role: 'user', text, at: new Date().toISOString(), delivery: 'pending' })
      this.publish(s)
      const run = this.execute(s, connection, text, requestId).finally(release)
      this.runs.set(this.key(root, provider), run)
      void run.finally(() => {
        this.runs.delete(this.key(root, provider))
        // 본대화 차례가 끝난 뒤에만 주문을 줍는다(설계 §3.3). 전달 차례는 주문을 줍지
        // 않는다 — 전달이 남긴 주문은 다음 학생 차례가 끝날 때 수집된다.
        void this.collectJobs(s)
      })
      return structuredClone(s)
    } catch (e) { release(); throw e }
  }
  private async execute(s: ChatSnapshot, connection: AgentConnection, text: string, requestId: string) {
    const key = this.key(s.root, s.provider)
    // 서버 재생(과거 턴)은 스냅샷에 assistant 기록이 하나도 없을 때만 — 이미 있으면
    // item-N/msg_* id가 달라 중복으로 들어온다.
    const replayHistory = !s.messages.some(m => m.role === 'assistant')
    const authGeneration = this.authGeneration[s.provider]
    /**
     * 답장이 오기 시작했으면 전달된 것이다. 예전에는 run() 이 끝나야 'sent' 로 바꿨는데,
     * 에이전트 턴은 몇 분씩 가므로 도우미가 눈앞에서 말하는 내내 학생 메시지에
     * "전송 중"이 붙어 있었다. 전달 여부와 턴 완료는 다른 사실이다.
     */
    const delivered = () => {
      const m = s.messages.find((x) => x.id === requestId)
      if (m?.delivery === 'pending') m.delivery = 'sent'
    }
    try {
      await connection.run(text, s.sessionId, {
        session: id => { s.sessionId = id; this.publish(s) },
        skill: () => { s.skillLoaded = true; this.publish(s) },
        message: (id, text) => {
          const old = s.messages.find(m => m.id === id)
          if (old) old.text = text
          else s.messages.push({ id, role: 'assistant', text, at: new Date().toISOString() })
          delivered()
          this.publish(s)
        },
        note: text => {
          s.messages.push({ id: randomUUID(), role: 'system', text, at: new Date().toISOString() })
          this.publish(s)
        },
        permission: permission => {
          // 같은 서버 요청의 늦은 파일 변경 정보는 새 승인으로 줄 세우지 않는다.
          if (s.permission?.id === permission.id) s.permission = permission
          else {
            const q = this.waiting.get(key) ?? []
            const existing = q.findIndex(p => p.id === permission.id)
            if (existing >= 0) q[existing] = permission
            else q.push(permission)
            this.waiting.set(key, q)
            this.showNextPermission(s, key)
          }
          delivered(); this.publish(s)
        }
      }, replayHistory)
      delivered(); s.state = 'idle'
    } catch (e) {
      // 이미 답장이 왔다면 전달은 된 것이다 — 그 뒤에 실패한 것은 턴이지 전송이 아니다.
      const sentMsg = s.messages.find(m => m.id === requestId)!
      if (sentMsg.delivery === 'pending') sentMsg.delivery = 'uncertain'
      // 학생이 멈춘 것은 실패가 아니다 — 취소로 끝난 턴에 오류 문구를 붙이지 않는다.
      // (중단하면 연결이 끊겨 run 이 예외로 끝나므로 여기로 온다.)
      if (s.state !== 'stopped') {
        if ((s.provider === 'claude' && e instanceof ClaudeAuthenticationError) || (s.provider === 'codex' && codexAuthFailure(e))) {
          if (authGeneration === this.authGeneration[s.provider]) {
            this.authRequired.add(s.provider)
            s.authRequired = true
          }
          s.error = authGeneration === this.authGeneration[s.provider] ? authCopy(s.provider) : '이전 답변의 인증이 만료됐어요. 보냈는지 확인한 뒤 이어서 보내 주세요.'
        }
        if (s.state !== 'interrupted') s.state = 'error'
        s.error ??= e instanceof Error ? e.message : '작업이 완료되지 않았어요.'
      }
    } finally { s.permission = undefined; this.waiting.delete(key); this.publish(s) }
  }
  /** 줄 맨 앞의 요청을 카드로 올린다. 이미 하나 떠 있으면 그대로 둔다. */
  private showNextPermission(s: ChatSnapshot, key: string): void {
    if (s.permission) return
    const q = this.waiting.get(key)
    if (!q?.length) return
    // 학생이 그 사이 "이 폴더에서는 계속 허용"을 골랐으면 줄에 남은 것도 묻지 않는다.
    // 같은 폴더를 두고 다시 묻는 것은 방금 받은 답을 무르는 일이다.
    if (this.opts.isTrusted?.(s.root)) {
      const c = this.connections.get(key)
      for (const p of q.splice(0)) { try { c?.respond(p.id, true) } catch { /* 이미 닫힌 요청 */ } }
      return
    }
    s.permission = q.shift()!; s.state = 'permission'
  }
  respond(root: string, provider: Provider, id: string, allow: boolean) {
    const key = this.key(root, provider)
    const s = this.snapshots.get(key)
    if (!s || s.permission?.id !== id) throw new Error('이미 종료된 권한 요청이에요.')
    this.connection(root, provider).respond(id, allow)
    s.permission = undefined
    this.showNextPermission(s, key)
    // 줄에 남은 것이 있으면 아직 학생 차례다 — 화면을 '작업 중'으로 되돌리지 않는다.
    if (!s.permission) s.state = 'running'
    this.publish(s)
  }
  // ---------------------------------------------------------------- 담당(relay) 배선

  private store(): JobStore {
    if (!this.jobStoreInstance) this.jobStoreInstance = new JobStore(join(this.opts.userData, 'jobs'))
    return this.jobStoreInstance
  }
  /**
   * 승인 배치·과금 동의는 **앱 저장소에만** 쓴다. 논문 폴더의 사본은 근거가 아니다.
   * 철회는 다음 실행부터 즉시 반영된다(러너가 매 검사마다 이 저장소를 읽는다).
   */
  approvePlan(root: string, plan: LanePlan): void { this.store().approve(root, plan) }
  revokePlan(root: string): void { this.store().revokePlan(root) }
  setConsent(company: Provider, accountId: string, on: boolean): void { this.store().setConsent(company, accountId, on) }
  /** 앱당 하나의 `JobRunner`. 이음매가 없으면 담당 기능 자체가 꺼진다(가짜 기본값 금지). */
  private runnerFor(): JobRunner | undefined {
    if (!this.opts.jobConnectionFactory || !this.opts.jobAccount) return undefined
    if (this.jobRunner) return this.jobRunner
    const store = this.store()
    this.jobRunner = new JobRunner({
      stateDir: join(this.opts.userData, 'jobs'),
      approvedPlan: root => store.approvedPlan(root),
      // 동의는 앱 저장소가 정본이다 — 엔진이 준 계정 값 위에 앱의 동의만 얹는다.
      account: async company => {
        const account = await this.opts.jobAccount!(company)
        return account ? { ...account, consented: store.consented(company, account.accountId) } : null
      },
      skill: () => {
        if (!this.jobSkill) throw new Error('설치된 스킬에서 주문 판 선언을 찾지 못했어요.')
        return this.jobSkill
      },
      supportedSchemas: [1],
      connectionFactory: request => this.opts.jobConnectionFactory!(request),
      deliver: (owner, result) => this.deliverJob(owner, result),
      stopMain: owner => this.stopMainFor(owner),
      diagnostic: record => console.error('[knuaf] jobs', JSON.stringify(record)),
      shellSandboxAvailable: this.opts.jobShellSandboxAvailable ?? false
    })
    return this.jobRunner
  }
  /**
   * 러너 `delivered[]` ↔ 앱 저장소 전달 기록을 **복구 시 한 번** 대조한다.
   *
   * 러너는 자기 `delivered[]` 를 먼저 영속하고 그 다음 앱 claim(`beginDelivery`)을 부른다.
   * 두 쓰기 사이에 앱이 죽으면 앱 쪽 기록이 없어 '확인하지 못했어요' 가 뜨지 않고 결과가
   * 조용히 사라졌다. 파일 두 개를 한 트랜잭션으로 묶을 수는 없으므로, 다음 실행이 두 기록을
   * 맞춰 보고 **러너는 전달했다는데 앱 기록이 없는** 결과를 `uncertain` 으로 드러낸다
   * (다시 보내지는 않는다 — at-most-once 는 그대로다).
   *
   * 중단(`stopped`)·중단된 재시작(`interrupted`)·진행 중(`running`·`queued`)은 러너가
   * `delivered` 에 넣어도 전달한 것이 아니므로 제외한다.
   */
  private reconcileDeliveries(): boolean {
    const runner = this.runnerFor()
    if (!runner) return true
    const deliveredStatuses = new Set(['completed', 'limit', 'error', 'auth', 'unknown', 'rejected', 'violation'])
    let records: ReturnType<JobRunner['records']>
    try { records = runner.records() } catch { return false }
    const latest = new Map<string, (typeof records)[number]>()
    for (const record of records) latest.set(record.rootJobId, record)
    const store = this.store()
    const orphans: string[] = []
    for (const rootJobId of runner.deliveredRootJobs()) {
      const record = latest.get(rootJobId)
      if (!record || !deliveredStatuses.has(record.status)) continue
      try { if (store.deliveryState(rootJobId) !== null) continue } catch { continue }
      orphans.push(rootJobId)
    }
    if (!orphans.length) return true
    let all = true
    for (const rootJobId of orphans) {
      const record = latest.get(rootJobId)!
      try { store.adoptOrphan(rootJobId, record.root, record.owner.id) } catch (error) {
        all = false
        console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-reconcile', rootJobId, error: error instanceof Error ? error.message : String(error) }))
        continue
      }
      console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-reconcile', rootJobId, outcome: 'adopted-uncertain' }))
    }
    return all
  }
  /**
   * 설치본의 `delegation.json` — 앱이 실제로 고른 스킬의 선언만 근거로 삼는다.
   * 설치기는 이 파일을 복사하지 않으므로(agent.ts 의 SKILL_METADATA) 설치본에 없으면
   * **지금 설치본과 같은 판임을 확인한** 묶음 원본에서 읽는다. 어느 쪽도 아니면 `null`.
   * 형식이 다르거나 심링크면 `null`(수집 skip) — 임의 기본값을 만들지 않는다.
   */
  private declaration(root: string, provider: Provider): { path: string; schema: number; contractVersion: string } | null {
    const dir = this.skillDir(root, provider)
    const installed = this.readDeclarationFile(join(dir, 'delegation.json'))
    if (installed !== undefined) return installed && { ...installed, path: dir }
    if (!existsSync(join(dir, 'SKILL.md'))) return null
    const source = this.opts.skillSource()
    try { if (skillState(dir, skillVersion(source)) !== 'installed') return null } catch { return null }
    const bundled = this.readDeclarationFile(join(source, 'delegation.json'))
    return bundled ? { ...bundled, path: dir } : null
  }
  private readDeclarationFile(file: string): { schema: number; contractVersion: string } | null | undefined {
    let text: string
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      text = readFileSync(file, 'utf8')
    } catch { return undefined }
    let value: unknown
    try { value = JSON.parse(text) } catch { return null }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'contractVersion,jobSchema,laneRequestSchema') return null
    const { jobSchema, laneRequestSchema, contractVersion } = record
    if (!Number.isSafeInteger(jobSchema) || (jobSchema as number) < 1) return null
    if (!Number.isSafeInteger(laneRequestSchema) || (laneRequestSchema as number) < 1) return null
    if (typeof contractVersion !== 'string' || !contractVersion) return null
    return { schema: jobSchema as number, contractVersion }
  }
  /**
   * 수집은 한 번에 하나 — 러너의 `skill()` 이 폴더 인자를 받지 않으므로(계약 고정)
   * 두 폴더가 동시에 수집하면 엔진에 남의 스킬 폴더 경로가 넘어갈 수 있다.
   */
  private collectJobs(s: ChatSnapshot): Promise<void> {
    const next = this.collectChain.then(() => this.collectNow(s))
    this.collectChain = next.catch(error => console.error('[knuaf] jobs', JSON.stringify({ type: 'collect', error: error instanceof Error ? error.message : String(error) })))
    return this.collectChain
  }
  private async collectNow(s: ChatSnapshot): Promise<void> {
    if (this.shuttingDown || this.jobsClosing) return
    if (!this.opts.jobConnectionFactory || !this.opts.jobAccount) return
    if (!s.sessionId) return
    const declaration = this.declaration(s.root, s.provider)
    if (!declaration) {
      // 수집이 꺼진 사실을 남긴다 — v0.4.2 처럼 delegation.json 이 없는 스킬 판에서는
      // 주문이 쌓이기만 하고 아무 신호도 없었다. 폴더·공급자당 한 번만 알린다.
      const off = this.key(s.root, s.provider)
      if (!this.collectDisabled.has(off)) {
        this.collectDisabled.add(off)
        console.error('[knuaf] jobs', JSON.stringify({ type: 'collect-disabled', root: canonical(s.root), provider: s.provider, reason: 'no-declaration' }))
      }
      return
    }
    const runner = this.runnerFor()
    if (!runner) return
    const root = canonical(s.root)
    this.jobRoots.add(root)
    this.jobSkill = declaration
    let names: string[]
    try { names = readdirSync(join(s.root, '.knuaf-gui', 'jobs')) } catch { return }
    const owner: ConversationOwner = { id: `${s.provider}\0${root}`, sessionId: s.sessionId, company: s.provider }
    let records: ReturnType<JobRunner['records']>
    try { records = runner.records() } catch { records = [] }
    // 주문 번호는 앱 전체에서 하나다(`JobRunner.enqueue`). 다른 폴더의 같은 번호는
    // 조용히 버리지 않고 이 폴더 대화에 한 번 알린다 — 학생이 번호를 바꿀 수 있게.
    const known = new Map(records.map(record => [record.spec.id, record.root]))
    let queued = false
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue
      const existingRoot = known.get(id)
      if (existingRoot !== undefined) {
        if (existingRoot !== root) {
          const notice = `${root}\0${id}`
          if (!this.duplicateNotified.has(notice)) {
            this.duplicateNotified.add(notice)
            console.error('[knuaf] jobs', JSON.stringify({ type: 'collect-skip', id, reason: 'duplicate-id', root, existingRoot }))
            s.messages.push({
              id: randomUUID(), role: 'system',
              text: `이 폴더의 주문 \`${id}\` 는 다른 폴더에서 이미 접수한 번호라 받지 않았어요. 번호를 새로 만들어 다시 맡겨 주세요.`,
              at: new Date().toISOString()
            })
            this.publish(s)
          }
        }
        continue
      }
      const file = join(s.root, '.knuaf-gui', 'jobs', name)
      try {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const raw = value as Record<string, unknown>
        if (['status', 'contentHash', 'rootJobId', 'outputRefs', 'spec'].some(key => key in raw)) continue
        if ('parent' in raw || 'cause' in raw) continue
        if (raw.schema !== declaration.schema || raw.contractVersion !== declaration.contractVersion) continue
        if (raw.id !== id) continue
        // 모양은 JobRunner.validate 가 깊이 검사한다 — 여기서는 타입 경계만 넘긴다.
        runner.enqueue(s.root, raw as unknown as JobSpec, owner, s.sessionId)
        known.set(id, root)
        queued = true
      } catch (error) {
        console.error('[knuaf] jobs', JSON.stringify({ type: 'collect-skip', id, error: error instanceof Error ? error.message : String(error) }))
      }
    }
    // 이번에 새로 넣은 주문이 없어도 이 폴더의 대기 주문이 남아 있을 수 있다(재시작 뒤,
    // 다른 폴더의 차례에서 미뤄진 주문). 그때도 이 폴더 차례에 실행한다.
    const pendingForRoot = queued || runner.records().some(record => record.status === 'queued' && record.root === root)
    if (pendingForRoot) {
      // `runQueued(root)` 는 **이 폴더의** 대기 주문만 돈다. 러너의 `skill()` 은 폴더 인자를
      // 받지 않는 계약이라, 남의 폴더 주문을 지금 돌리면 이번 폴더의 스킬 경로가 그 주문에
      // 넘어간다(잘못된 스킬로 실행). 그 주문은 자기 폴더의 수집 차례까지 기다린다.
      const foreign = runner.records().filter(record => record.status === 'queued' && record.root !== root)
      if (foreign.length) {
        const deferred = `${root}\0${foreign.map(record => record.spec.id).join(',')}`
        if (!this.deferredNotified.has(deferred)) {
          this.deferredNotified.add(deferred)
          console.error('[knuaf] jobs', JSON.stringify({ type: 'defer-foreign-root', root, ids: foreign.map(record => record.spec.id) }))
        }
      }
      await runner.runQueued(root)
    }
  }
  /** `owner.id` = `<provider>\0<canonical root>` — 재시작 뒤에도 메모리 지도에 기대지 않는다. */
  private ownerOf(owner: ConversationOwner): { root: string; provider: Provider } | null {
    const split = owner.id.indexOf('\0')
    if (split < 0) return null
    const provider = owner.id.slice(0, split)
    const root = owner.id.slice(split + 1)
    if (provider !== 'codex' && provider !== 'claude') return null
    if (!root) return null
    return { root, provider }
  }
  /**
   * 담당 결과를 소유 대화의 **새 차례**로 넣는다. `rootJobId` 당 한 번:
   * 저장소 claim(`beginDelivery`)이 먼저 영속되고, claim 뒤 전달 전에 죽으면 다시 보내지 않는다.
   *
   * 넣지 **못한** 것이 확실한 경우(폴더가 바쁨·업데이트 준비)는 `uncertain` 이 아니라
   * `pendingDeliveries` 에 들고 있다가 폴더가 빌 때 다시 넣는다. `uncertain` 은 전달을
   * 시도했지만 결과를 모를 때만 쓴다 — 거짓 경보를 만들지 않는다.
   */
  private async deliverJob(owner: ConversationOwner, result: JobResult): Promise<void> {
    const parsed = this.ownerOf(owner)
    if (!parsed) return
    const store = this.store()
    if (this.shuttingDown) { store.markUncertain(result.rootJobId, parsed.root, owner.id); return }
    if (!store.beginDelivery(result.rootJobId, parsed.root, owner.id)) return
    await this.deliverResult(owner, result)
  }
  /** 이미 claim 된 결과를 대화에 넣는다. 못 넣으면 `pendingDeliveries` 에 남긴다. */
  private async deliverResult(owner: ConversationOwner, result: JobResult): Promise<void> {
    const parsed = this.ownerOf(owner)
    if (!parsed) return
    const { root, provider } = parsed
    const store = this.store()
    const park = () => {
      this.pendingDeliveries.set(result.rootJobId, { owner, result })
      this.schedulePending()
    }
    // 앱이 곧 종료된다. claim 은 이미 영속됐으므로 여기서 started 로 두면 다음 실행이
    // `uncertain` 으로 드러낸다 — 다시 보내지 않는다.
    if (this.shuttingDown) return
    // 다른 경로(겹친 재구동·학생 중단)가 이미 이 결과를 닫았으면 넣지 않는다. 보류 목록에서
    // 꺼낸 시점과 여기 사이에 상태가 바뀔 수 있으므로 **넣기 직전**에 한 번 더 확인한다.
    if (!this.claimOpen(result.rootJobId)) return
    if (this.jobsClosing || this.busy(root)) { park(); return }
    let release: (() => void) | null = null
    let s: ChatSnapshot
    let key: string | undefined
    let deliveryRun: Promise<void> | null = null
    let delivered = false
    try {
      // 본대화 차례가 돌고 있으면 끝날 때까지 기다린다 — 그 대화의 결과이므로 순서가 맞다.
      // (기다리는 동안에도 claim 은 이미 영속됐다: 이 창에서 죽으면 다시 보내지 않는다.)
      await this.runs.get(this.key(root, provider))?.catch(() => {})
      if (this.shuttingDown) return
      if (this.jobsClosing || this.busy(root)) { park(); return }
      release = this.acquire(root)
      // `snapshot()` 는 복제본을 돌려준다 — 살아 있는 기록은 지도 쪽만 고칠 수 있다.
      this.snapshot(root, provider)
      key = this.key(root, provider)
      s = this.snapshots.get(key)!
      const connection = this.connection(root, provider)
      const text = deliveryText(result, root)
      // [자세히] 원문은 여기서 한 번 남긴다 — 전달이 실패해도 학생이 무슨 글이었는지 볼 수 있다.
      try { store.saveDeliveryText(result.rootJobId, text) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-text', error: error instanceof Error ? error.message : String(error) })) }
      const epoch = this.stopEpoch.get(this.key(root, provider)) ?? 0
      // 전달 차례도 `runs` 에 올린다 — 학생이 중단하면 `stopped` 로 표시되고
      // `close()` 가 이 차례가 끝나기를 기다린다. 주문은 줍지 않는다(수집은 `send` 몫).
      // async 본문은 첫 await 전까지 동기로 돌므로 `state='running'` 과 줄 넣기가
      // `runs.set` 앞에서 끝난다 — 그 사이에 `stop` 이 끼어들 수 없다.
      deliveryRun = (async () => {
        s.state = 'running'; s.error = undefined; s.authRequired = undefined
        s.messages.push({ id: randomUUID(), role: 'system', text, at: new Date().toISOString() })
        this.publish(s)
        delivered = await this.deliveryTurn(s, connection, text, owner.sessionId, result.rootJobId, epoch)
        if (s.state === 'running') s.state = 'idle'
        this.publish(s)
      })()
      this.runs.set(key, deliveryRun)
      await deliveryRun
    } catch (error) {
      // 전달을 시작조차 못했다. 다시 시도할 수 있는 상태(바쁨·업데이트 준비·일시 정지)면
      // 보류하고, 그렇지 않으면(연결을 열 수 없음 등) **확실한 실패**로 드러낸다 —
      // `deliver-failed` 줄에서만 학생이 누를 때 1회 다시 넘긴다(Q3).
      if (!release && !this.shuttingDown && (this.jobsClosing || agentActivity.suspended || this.busy(root))) { park(); return }
      store.markFailed(result.rootJobId, root, owner.id)
      console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-failed', rootJobId: result.rootJobId, error: error instanceof Error ? error.message : String(error) }))
      return
    } finally {
      if (key && this.runs.get(key) === deliveryRun) this.runs.delete(key)
      release?.()
    }
    if (!delivered) {
      // 결과 줄은 대화에 남았지만 담당 결과를 넣는 차례는 확인하지 못했다. 학생이 직접
      // 멈춘 것이면 그 선택을 존중해 완료로 남기고, 실패면 다시 보내지 않고 드러낸다.
      if (s.state === 'stopped') {
        console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-stopped', rootJobId: result.rootJobId }))
      } else {
        store.markUncertain(result.rootJobId, root, owner.id)
        console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-failed', rootJobId: result.rootJobId, error: s.error ?? 'unknown' }))
        return
      }
    }
    try { store.finishDelivery(result.rootJobId) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-record', error: error instanceof Error ? error.message : String(error) })) }
  }
  /**
   * 이 전달 차례가 시작된 뒤 학생이 멈췄는가. 화면 상태와 중단 세대를 함께 본다 — `prepare()`
   * 가 오래 걸리는 동안 `stop()` 이 상태를 'stopped' 로 바꾸고 세대도 올린다.
   */
  private deliveryCancelled(s: ChatSnapshot, epoch: number): boolean {
    return s.state === 'stopped' || (this.stopEpoch.get(this.key(s.root, s.provider)) ?? 0) !== epoch
  }
  /** 전달 차례가 결과를 대화에 넣었는가. 실패는 던지지 않고 false 로 돌려준다. */
  private async deliveryTurn(s: ChatSnapshot, connection: AgentConnection, text: string, sessionId: string, rootJobId: string, epoch: number): Promise<boolean> {
    const key = this.key(s.root, s.provider)
    try {
      // send() 와 같은 계약 — 재개한 대화의 기본값 복귀를 전달 전에도 확인한다.
      await connection.prepare?.(sessionId)
      // `prepare()` 는 네트워크를 타므로 그 사이 학생이 멈출 수 있다(시험 ⑨ 는 `run()` 에
      // 들어간 뒤만 잡는다). 준비가 끝난 뒤에도 취소 상태면 새 차례를 열지 않는다 —
      // 멈춘 대화에 결과를 밀어 넣으면 중단 표시가 실행으로 덮인다.
      if (this.deliveryCancelled(s, epoch)) {
        // 학생이 멈춘 것이면 중단으로, 업데이트·종료면 실패로 갈린다(아래 `!delivered` 처리).
        console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-stopped', rootJobId, phase: 'after-prepare' }))
        return false
      }
      await connection.run(text, sessionId, {
        session: id => { if (id) s.sessionId = id; this.publish(s) },
        skill: () => { s.skillLoaded = true; this.publish(s) },
        message: (id, content) => {
          const old = s.messages.find(m => m.id === id)
          if (old) old.text = content
          else s.messages.push({ id, role: 'assistant', text: content, at: new Date().toISOString() })
          this.publish(s)
        },
        note: content => {
          s.messages.push({ id: randomUUID(), role: 'system', text: content, at: new Date().toISOString() })
          this.publish(s)
        },
        permission: permission => {
          if (s.permission?.id === permission.id) s.permission = permission
          else {
            const q = this.waiting.get(key) ?? []
            const existing = q.findIndex(p => p.id === permission.id)
            if (existing >= 0) q[existing] = permission
            else q.push(permission)
            this.waiting.set(key, q)
            this.showNextPermission(s, key)
          }
          this.publish(s)
        }
      })
      return true
    } catch (error) {
      if (s.state !== 'stopped') {
        s.state = 'error'
        s.error = error instanceof Error ? error.message : '담당 결과를 대화로 넣지 못했어요.'
      }
      return false
    } finally { s.permission = undefined; this.waiting.delete(key); this.publish(s) }
  }
  /** 열린 제안·진행 담당을 버린다 — 실제 인스턴스 연결은 C/통합 몫. */
  private async invalidate(root: string): Promise<void> {
    try { await this.opts.invalidateHandoff?.(root) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'invalidate', error: error instanceof Error ? error.message : String(error) })) }
  }
  /** `JobRunner.stop` 의 `stopMain` — 본대화만 멈춘다(러너 재진입 없음). */
  private async stopMainFor(owner: ConversationOwner): Promise<void> {
    const parsed = this.ownerOf(owner)
    if (parsed) await this.stopMain(parsed.root, parsed.provider)
  }
  /** 열린 제안을 버리고 담당·본대화를 멈춘다. */
  async switchOwner(root: string, owner: ConversationOwner): Promise<void> {
    this.jobRoots.add(canonical(root))
    try { await this.jobRunner?.switchOwner(root, owner) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'switch-owner', error: error instanceof Error ? error.message : String(error) })) }
    await this.invalidate(root)
  }
  /** 본대화만 멈춘다. `JobRunner.stop` 이 이 자리를 부르므로 러너로 되돌아가지 않는다. */
  private async stopMain(root: string, provider: Provider) {
    const key = this.key(root, provider), s = this.snapshots.get(key)
    if (s && this.runs.has(key)) { s.state = 'stopped'; s.error = undefined; this.publish(s) }
    // 멈춘 연결은 버린다 — 다음 send/status 가 새 연결을 열어야 '다시 확인'이 살아난다.
    await this.connections.get(key)?.stop(); this.connections.delete(key)
    await this.runs.get(key)
  }
  /** 학생이 중단: 진행 담당·열린 제안·본대화를 함께 멈춘다(설계 §3.5). */
  async stop(root: string, provider: Provider) {
    this.jobRoots.add(canonical(root))
    // 이 폴더에서 이미 시작된 전달 차례가 `prepare()` 를 마치고 돌아와도 새 차례를 열지 않게 한다.
    const stoppedKey = this.key(root, provider)
    this.stopEpoch.set(stoppedKey, (this.stopEpoch.get(stoppedKey) ?? 0) + 1)
    try { await this.jobRunner?.stop(root) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'stop', error: error instanceof Error ? error.message : String(error) })) }
    await this.stopMain(root, provider)
    // 아직 넣지 못한 결과도 학생의 중단을 따른다 — 잠시 뒤 타이머가 몰래 넣지 않는다.
    // claim 은 이미 영속됐으므로 `done` 으로 닫는다(다시 보내지 않음).
    const stopped = canonical(root)
    for (const [rootJobId, entry] of [...this.pendingDeliveries]) {
      if (this.ownerOf(entry.owner)?.root !== stopped) continue
      this.pendingDeliveries.delete(rootJobId)
      try { this.store().finishDelivery(rootJobId) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'delivery-record', error: error instanceof Error ? error.message : String(error) })) }
      console.error('[knuaf] jobs', JSON.stringify({ type: 'deliver-stopped', rootJobId }))
    }
    await this.invalidate(root)
  }
  /** 수명 정리 — 러너를 쓰지 않았어도 부르는 자리는 같다. */
  private async stopJobs(): Promise<void> {
    this.jobsClosing = true
    const roots = new Set<string>(this.jobRoots)
    try { for (const record of this.jobRunner?.records() ?? []) roots.add(record.root) } catch { /* 상태를 못 읽으면 아는 것만 멈춘다 */ }
    await Promise.allSettled([...roots].map(async root => {
      try { await this.jobRunner?.stop(root) } catch (error) { console.error('[knuaf] jobs', JSON.stringify({ type: 'stop', error: error instanceof Error ? error.message : String(error) })) }
      await this.invalidate(root)
    }))
  }

  /** Reversible handoff teardown: never sets shuttingDown; dead connection objects are not reused. */
  async closeForUpdate(confirmStopped: () => Promise<void>): Promise<void> {
    // 연결을 끊기 전에 담당·제안을 먼저 멈춘다 — 끊은 뒤에는 멈출 대상이 사라진다(설계 §3.5).
    await this.stopJobs()
    try {
      for (const connection of [...this.connections.values(), ...this.globals.values()]) this.closingConnections.add(connection)
      this.connections.clear()
      this.globals.clear()
      this.reauthenticating.clear()
      const results = await Promise.allSettled([...this.closingConnections].map(connection => connection.stop()))
      await confirmStopped()
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      this.closingConnections.clear()
    } finally {
      // 이 함수가 성공해도 그 뒤 `assertResourcesIdle`·취소·`transfer` 가 실패하면 앱은 계속
      // 산다(handoff.ts:31-43). 수집·전달을 재시작까지 꺼 둔 채 남기지 않는다 —
      // 영구 종료는 `close()` 의 `shuttingDown` 만 정한다.
      this.jobsClosing = false
      void this.drivePending()
    }
  }
  async close() {
    this.beginShutdown()
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    // 러너를 먼저 멈춘다 — 진행 담당 연결이 본대화 연결 정리 뒤에 남지 않게.
    await this.stopJobs()
    const connections = new Set([...this.connections.values(), ...this.globals.values(), ...this.closingConnections])
    const results = await Promise.allSettled([...connections].map(connection => connection.stop()))
    await Promise.all(this.runs.values())
    this.connections.clear()
    this.globals.clear()
    this.closingConnections.clear()
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}

const COMPANY_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'ChatGPT' }
const EFFORT_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', max: '최대' }

/**
 * 돌려주기 문구(DESIGN §3.3). 앱은 파일을 **복사하지 않는다** — 메인이 정본을 쓴다.
 * 출력은 논문 폴더 기준 상대 경로(`jobs/<id>/out/…`)로만 보여 준다.
 */
function deliveryText(result: JobResult, root: string): string {
  const company = COMPANY_LABEL[result.company]
  const effort = result.effort ? EFFORT_LABEL[result.effort] ?? result.effort : '기본'
  const head = `자료 담당(${company}·${result.model}·${effort}) 작업 ${result.status === 'completed' ? '끝' : `결과: ${result.status}`}`
  const outputs = result.outputs.map(path => {
    const rel = relative(join(root, '.knuaf-gui'), path).split(sep).join('/')
    return rel.startsWith('..') ? basename(path) : rel
  })
  const tail = result.status === 'completed' && outputs.length
    ? ` — 출력 ${outputs.map(name => `\`${name}\``).join(', ')}`
    : ''
  return `${head}${tail}. 담당 메모와 출력 파일을 확인한 뒤, 정본 반영은 스킬 규칙대로 직접 해 주세요.`
}

/** Personal validation never writes the user's original thesis or the source backup. */
export function personalProject(source: string | null, userData: string): string {
  const base = join(userData, 'projects'); mkdirSync(base, { recursive: true })
  if (source) {
    source = realpathSync(source)
    if (source.split(sep).includes('backups')) throw new Error('보관본은 작업 대상으로 열지 않아요.')
    const inside = relative(realpathSync(base), source)
    if (inside && !inside.startsWith('..') && !resolve(inside).startsWith(base) && existsSync(join(source, '.knuaf-gui', 'personal-copy.json'))) return source
    if (source === base || relative(source, base).split(sep)[0] !== '..') throw new Error('앱 작업 폴더의 상위 폴더는 복사할 수 없어요.')
  }
  const root = join(base, `${source ? basename(source) : '새 논문'}-${randomUUID().slice(0, 8)}`)
  if (source) cpSync(source, root, { recursive: true, dereference: false, filter: p => !lstatSync(p).isSymbolicLink() && !['backups', '.git', '.venv', 'node_modules', '.knuaf-gui'].includes(basename(p)) })
  else mkdirSync(root)
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'personal-copy.json'), JSON.stringify({ source, createdAt: new Date().toISOString() }))
  return root
}
