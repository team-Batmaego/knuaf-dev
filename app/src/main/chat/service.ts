import { CLAUDE_AUTH_COPY, CODEX_AUTH_COPY, MODEL_SELECTION_COPY } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findExecutable, installSkill, skillState, skillTargets, skillVersion, VERSION_FILE } from '../agent'
import { folderHash } from '../guard/scope'
import type { GuardKey } from '../guard/store'
import { readRecoverable, tmpOf, writeFileAtomic, type SafeWriteFs } from '../safeWrite'
import { ClaudeAuthenticationError, ClaudeConnection } from './claude'
import { CodexAuthenticationError, CodexConnection } from './codex'
import { subscriptionEnv, type AgentConnection, type AgentOptions, type GuardContext } from './contracts'
import { chatConnectionKey } from './jobs/key'
import { KordocMcpRegistry } from './kordocMcpRegistry'
import type { KordocMcpSpec, KordocRuntime } from './kordocMcp'
import { rootKey } from './kordocMcp'
import type { ChatModels, ChatModelInfo, ChatSnapshot, ModelChoice, PermissionRequest, Provider, ConnectionStatus } from '../../shared/chat'
import { effectiveModelChoice, isCrossProviderModelId } from '../../shared/chat'

import { skillSwitch } from '../update/switch'
import { agentActivity } from '../update/activity'
import { shutdownWithin } from '../shutdown'
import { codeOf, diag, diagEnabled } from '../diagLog'
/** 저장된 대화 기록을 읽고 모양을 확인한다 — 망가졌으면 던진다. */
function parseChat(text: string, provider: Provider): ChatSnapshot {
  const v = JSON.parse(text) as ChatSnapshot
  if (!Array.isArray(v?.messages) || v.provider !== provider) throw new Error('대화 기록을 읽지 못했어요. 기존 기록을 보존한 채 복구가 필요해요.')
  return v
}

const authCopy = (provider: Provider): string => provider === 'codex' ? CODEX_AUTH_COPY.required : CLAUDE_AUTH_COPY.required
/**
 * `close()` 가 진행 중인 턴을 기다리는 상한. 정상 턴은 `chat.stop`(학생 중단)이나 연결 stop 으로
 * 곧 끝나고, 이 상한에 걸리는 것은 **종료 뒤에도 안 끝난 턴**뿐이다(그 자체가 결함 신호).
 */
const CLOSE_RUN_DEADLINE_MS = 5_000
/**
 * 연결 정리(`connection.stop()`)의 상한. 종료(`close`)와 업데이트 인계(`closeForUpdate`)가 같이 쓴다.
 *
 * 이 상한이 없던 때에도 바깥 10초 마감은 걸려 있었다 — 부모(`596379f`) 실행은 10 003ms 에 끝나며
 * `pending=[chat.close]` 를 남겼다(검토 RT3 정정: "바깥 마감이 걸리지 않았다"는 서술은 틀렸다).
 * 문제는 그 안에서 **어느 연결이 안 끝났는지** 알 수 없고, 마감을 넘긴 연결이 조용히 성공으로
 * 집계되어 회수(reclaim) 대상에서 빠졌다는 점이다. 여기서 먼저 끊어 연결 단위로 분류한다.
 */
const CLOSE_CONNECTION_DEADLINE_MS = 3_000
/**
 * 종료 중 초안 쓰기의 재시도 예산. 정상 경로(300ms, `safeWrite.ts`)를 그대로 쓰면 main 스레드가
 * 그만큼 막히고, **그 루프가 돌아야** 종료 마감 타이머가 울린다 — 막는 시간이 곧 마감 지연이다.
 * 20+30=50ms 는 **파일 하나**의 상한이다: 대기 중인 초안이 N개면 최대 50×N ms 에 동기 I/O 가
 * 더해지므로, 이 값만으로 "10초 안에 닫힌다"를 보장할 수는 없다.
 */
export const QUIT_FLUSH_DELAYS_MS = [20, 30]
/**
 * 그림 준비(옛 턴 닫기·후보표·턴 열기)를 기다리는 상한(I-02).
 *
 * 이 대기는 **엔진을 부르기 전**이라 `runs` 에 아직 없다. 상한이 없으면 옛 `endTurn()` 하나가 안
 * 끝날 때 그 폴더의 다음 전송이 영원히 매달린다. 넘기면 그림 고리만 건너뛰고 엔진을 부른다 —
 * 늦게 끝난 옛 `endTurn` 이 새 `turn.json` 을 지우는 문제는 통로 쪽 소유권 검사가 막는다.
 */
const FIGURE_PREP_DEADLINE_MS = 3_000

/**
 * 그림 준비 대기 하나(I-02). `stop()`·종료가 `wake()` 로 깨우고, 깨운 쪽은 `cancelled` 로 끝난다.
 * 기다리는 쪽이 `settle()` 을 부르면 그 뒤의 `wake()` 는 아무 일도 하지 않는다(한 번만 정착).
 */
interface PrepWait {
  promise: Promise<void>
  /** 대기 끝 — 정상 정착(계속 진행) 또는 취소. 이미 정착했으면 무시된다. */
  settle(): void
  wake(): void
  cancelled: boolean
}

interface Prep extends PrepWait {
  settled: boolean
  /** 이 시각을 넘기면 남은 고리를 포기하고 엔진을 부른다(준비 전체의 상한). */
  until: number
}
// 문자열만 온 이전 Codex에서는 실제 로그아웃·계정 변경으로 갱신이 거부된 문장만 인정한다.
const codexAuthFailure = (error: unknown): boolean => error instanceof CodexAuthenticationError ||
  (error instanceof Error && /\b(?:your )?access token could not be refreshed because you have since logged out or signed in to another account\b/i.test(error.message))

/** 사양 적용 결과. `unsafe` = 공급자가 사양도 해제도 받지 못해 MCP 상태를 확인할 수 없다. */
type KordocApplyOutcome = 'attached' | 'rejected' | 'unsafe'

export class ChatService {
  private snapshots = new Map<string, ChatSnapshot>()
  private connections = new Map<string, AgentConnection>()
  private owners = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  /**
   * 아직 안 끝난 `figures.endTurn()` — 턴이 끝난 **뒤**에 시작해 다음 턴 **전**에 기다린다.
   *
   * 왜 잠금과 분리했나: 잠금 해제(`release`)를 `endTurn()` 뒤로 미루면, 그 사이 스냅샷은 이미
   * `idle` 인데 폴더는 잠겨 있어 학생의 바로 다음 전송이 "작업이 끝난 뒤 다시 실행해 주세요"로
   * 거절된다(통로가 있을 때도 똑같이 터진다). 그래서 잠금은 예전처럼 즉시 풀고, 턴 닫기만
   * 약속으로 잡아 둔다. 순서는 그대로 지켜진다 — 옛 `endTurn` 이 끝나기 전에는 새 턴을 열지 않는다.
   */
  private figureClosing: Promise<void> | null = null
  /**
   * 그림 준비(옛 턴 닫기 → 후보표 → 턴 열기) 중인 요청의 취소 토큰(I-02).
   *
   * 그 대기는 엔진 실행 **전**이라 `runs` 에 아직 없다. 그래서 `stop()` 이 `runs` 만 보면 대기 중인
   * 전송을 멈출 수 없고, 대기 풀린 뒤 엔진이 뒤늦게 실행된다(검토 실측). 여기 등록해 두면 `stop()` 이
   * 대기를 깨우고, 대기 뒤 취소를 본 `send` 는 엔진을 부르지 않는다.
   */
  private preps = new Map<string, PrepWait>()
  private shuttingDown = false
  private authRequired = new Set<Provider>()
  private authGeneration: Record<Provider, number> = { codex: 0, claude: 0 }
  private reauthenticating = new Map<Provider, AgentConnection>()
  private pendingLogins = new Set<Provider>()
  private closingConnections = new Set<AgentConnection>()
  /** 폴더별 kordoc MCP 수명 — 성공 캐시·실패 재시도·안내 1회는 레지스트리가 지킨다(§3.2). */
  private kordocRegistries = new Map<string, KordocMcpRegistry>()
  /** acquire 가 도는 동안만 열리는 안내 통로 — 폴더 키로 그 대화 스냅샷에 묶는다. */
  private kordocNoteSinks = new Map<string, (text: string) => void>()
  /** 연결별 kordoc 부착 상태. 항목 없음 = 아직 확인 안 함. `key` 는 부착 당시의 폴더 식별(realpath). */
  private kordocAttach = new WeakMap<AgentConnection, { state: 'attached' | 'notified'; key: string }>()
  /**
   * 마감을 넘겼거나 실패로 정착한 연결 — **재사용 금지**는 그대로지만, 앱이 띄운 자식 pid 는
   * 계속 우리 소유로 남겨 회수(reclaim) 대상에 들어가야 한다(검토 RT3 차단).
   * 예전에는 마감을 넘긴 연결을 `connections`/`closingConnections` 에서 지워 pid 가 `ownedPids()`
   * 에서 사라졌고, 호출부는 그 정리를 `done` 으로 읽어 회수 분기를 건너뛰었다.
   */
  private reclaimPending = new Set<AgentConnection>()
  hasPendingLogin(): boolean { return this.pendingLogins.size > 0 }
  /**
   * 앱이 띄운 엔진 자식 pid — 종료 마감 뒤 회수 대상(검토 RT2-03).
   * 연결이 스스로 아는 것만 돌려준다(`Connection.ownedPids` 선택 메서드). 없으면 빈 배열이다.
   */
  ownedPids(): number[] {
    const pids: number[] = []
    for (const connection of new Set([...this.connections.values(), ...this.globals.values(), ...this.closingConnections, ...this.reclaimPending])) {
      if (typeof connection.ownedPids === 'function') pids.push(...connection.ownedPids())
    }
    return pids
  }
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
  beginShutdown(): void {
    this.shuttingDown = true
    // 종료도 그림 준비 대기를 깨운다(I-02) — 종료 중에 매달린 전송이 남지 않게.
    for (const prep of this.preps.values()) prep.wake()
  }
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
  constructor(private opts: {
    skillSource: () => string; userData: string; env?: NodeJS.ProcessEnv
    emit: (s: ChatSnapshot) => void; openExternal: (url: string) => Promise<void>
    /** Test seam: build connections without spawning real agent processes (e2e/chat.spec.ts). */
    connectionFactory?: (provider: Provider, options: AgentOptions) => AgentConnection
    /**
     * 지킴이 무결성 열쇠(§4.3). `null`/`undefined` 는 **디스크 장부를 못 믿는다**는 뜻이지
     * 지킴이가 꺼진다는 뜻이 아니다 — 격리·잠금·플러그인 열거는 열쇠와 무관하게 늘 돈다.
     * 열쇠가 없으면 원장은 메모리에만 남고(다음 실행에서 사라진다) 디스크에는 쓰지 않는다(C-02).
     */
    guardKey?: GuardKey
    /** True while the app itself holds a sidecar write transaction; send() must not interleave. */
    sidecarBusy?: (root: string) => boolean
    /**
     * 폴더의 kordoc 실행 런타임(설계 §3.2). 값은 v0.6.0 ③이 정하고, 여기서는 **입력으로만** 받는다 —
     * 없으면 MCP 를 붙이지 않고(기존 동작 그대로) `setMcpSpec` 도 부르지 않는다.
     * 실패는 `null` 또는 예외(둘 다 "이번엔 못 붙었다")이고, 그때도 대화는 그대로 간다.
     */
    ensureKordoc?: (root: string) => Promise<KordocRuntime | null>
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
    /**
     * 그림 통로(`figures/index.ts` 의 `FigureChannel`). 앱이 하는 일은 **고리 넷**뿐이다 — 메인 엔진의
     * 환경에 저장소 자리를 얹고(`env`), 학생 원문을 후보표에 남기고(`recordStudentMessage`),
     * 턴을 열고(`beginTurn`), 닫는다(`endTurn`). 무엇을 어떻게 할지는 규칙집이 정한다: 그림 명령이
     * 없는 판에서는 이 고리가 불려도 조용해야 한다. 없으면 지금까지와 바이트까지 같은 동작이다.
     */
    figures?: {
      env: Record<string, string>
      beginTurn(root: string, turnId: string): Promise<void>
      /** `turnId` 를 받는 이유는 통로가 하나뿐이기 때문이다 — 소유자만 자기 턴을 닫는다(I-01). */
      endTurn(turnId: string): Promise<void>
      recordStudentMessage(root: string, text: string): Promise<number>
    }
    /** Test seam: 대화 기록·초안을 쓰는 파일시스템(e2e/safe-write.spec.ts 가 실패를 주입한다). */
    fs?: SafeWriteFs
  }) {}
  private get writeFs(): SafeWriteFs { return this.opts.fs ?? { writeFileSync, renameSync, unlinkSync, readFileSync: (p) => readFileSync(p, 'utf8') } }
  /** PATH 앞자리에 둘 인터프리터 bin 경로 — 프로젝트 .venv 가 번들보다 우선한다. */
  private pythonBinDirs(root: string): string[] {
    const venv = this.opts.venvPython?.(root) ?? null
    const bundled = this.opts.bundledPython?.() ?? null
    return [venv, bundled].filter((p): p is string => !!p).map((p) => dirname(p))
  }
  private key(root: string, provider: Provider, role = 'main') { return chatConnectionKey(root, provider, role) }
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
  /**
   * 대기 중인 초안을 지금 쓴다. 종료 직전에도 불리므로 동기다.
   *
   * `delaysMs` 는 재시도 예산이다 — 종료 경로는 `QUIT_FLUSH_DELAYS_MS` 로 줄여 부른다. 이 함수가
   * 동기라서, 예산만큼 main 스레드가 서고 그동안 종료 마감 타이머도 서 있는다(멈춤 후보 1a).
   */
  flushDrafts(opts: { delaysMs?: number[] } = {}): void {
    // 진단: 이 함수는 before-quit 마다 동기로 돌고, 재시도 대기(safeWrite)를 안고 있다 — 멈춤 후보 1a.
    // 진단이 꺼져 있으면 시계 읽기·문자열 조립도 하지 않는다(검토 RT3 권고).
    const traced = diagEnabled() && this.draftPending.size > 0
    const startedAt = traced ? Date.now() : 0
    if (traced) diag(`drafts:flush:start n=${this.draftPending.size} shuttingDown=${this.shuttingDown}`)
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
            console.error(`[knuaf] 빈 초안을 지우지 못했어요: ${basename(path)} (${codeOf(e)})`)
          }
        }
        if (cleared) this.draftPending.delete(root)
        continue
      }
      try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 아래 쓰기가 같은 이유로 실패한다 */ }
      // 던지지 않는 공용 쓰기(WIN-ONEDRIVE). **성공한 것만** 지운다 — 실패하면 대기 값으로 남겨
      // 다음 flush 가 다시 시도하고, 그 사이 `draft()` 는 최신 글을 계속 돌려준다.
      const at = traced ? Date.now() : 0
      if (writeFileAtomic(file, text, { mode: 0o600, fs: this.writeFs, delaysMs: opts.delaysMs }).ok) this.draftPending.delete(root)
      if (traced) diag(`drafts:flush:file elapsed=${Date.now() - at}ms pending=${this.draftPending.size}`)
    }
    if (traced) diag(`drafts:flush:end elapsed=${Date.now() - startedAt}ms 남음=${this.draftPending.size}`)
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
    return structuredClone(s)
  }
  busy(root: string) { try { return this.owners.has(realpathSync(root)) } catch { return false } }
  acquire(root: string): () => void {
    root = realpathSync(root)
    if (this.owners.has(root)) throw new Error('현재 작업이 끝나거나 중단된 뒤 다시 실행해 주세요.')
    const releaseActivity = agentActivity.enter()
    let releaseSwitch: () => void
    try { releaseSwitch = skillSwitch.enter() } catch (error) { releaseActivity(); throw error }
    this.owners.add(root)
    return () => { this.owners.delete(root); releaseSwitch(); releaseActivity() }
  }
  private skillDir(root: string, provider: Provider) { return skillTargets(root, this.opts.userData)[provider] }
  /**
   * 지킴이 보관본 자리(§4.3). 열쇠를 못 얻었으면 `key: null` — 디스크 장부를 믿지 않는 것이지
   * 지킴이를 끄는 것이 아니다(C-02). 격리·잠금·플러그인 열거는 열쇠와 무관하게 늘 돌아야 하므로
   * 문맥 자체는 언제나 넘긴다.
   */
  private guardFor(root: string): GuardContext {
    return { userData: this.opts.userData, folderHash: folderHash(root), key: this.opts.guardKey ?? null }
  }
  /** 폴더의 kordoc 레지스트리 — 성공 캐시·실패 재시도·안내 1회는 이 객체가 지킨다(§3.2). */
  private kordocRegistry(root: string): KordocMcpRegistry {
    const key = rootKey(root)
    let registry = this.kordocRegistries.get(key)
    if (!registry) {
      const ensureKordoc = this.opts.ensureKordoc
      if (!ensureKordoc) throw new Error('kordoc 런타임 공급자가 없어요.')
      registry = new KordocMcpRegistry({
        ensureKordoc,
        // 안내 줄은 **그 순간 그 폴더의 대화**에만 남는다 — acquire 는 폴더별 잠금 안에서만 돈다.
        note: (text) => this.kordocNoteSinks.get(key)?.(text)
      })
      this.kordocRegistries.set(key, registry)
    }
    return registry
  }
  /**
   * 이 턴에 붙일 kordoc MCP 사양을 연결에 넘긴다(설계 §3.2 '언제'·'실패 시').
   *
   * - **`send()` 에서만** 부른다(`status()`·`login()`·전역 연결은 타지 않는다).
   * - 공급자가 `setMcpSpec` 을 구현하지 않았거나 런타임 공급자가 없으면 아무 것도 하지 않는다 —
   *   확인 자체가 kordoc 설치(수백 MB)를 일으킬 수 있으므로 받을 곳이 없으면 시도하지 않는다.
   * - 확인에 실패하면 `null` 을 넘기고 대화는 그대로 간다. 안내 줄은 레지스트리가 폴더당 1회 넣는다.
   * - 같은 연결·같은 폴더에 이미 붙은 사양은 다시 넘기지 않는다 — 공급자에게는 이 호출이 재기동이다.
   *   폴더 식별(realpath)이 달라졌으면 **옛 사양을 먼저 뗀다** — A 의 울타리로 B 턴을 돌리지 않는다(M1-01).
   * - 부착·해제가 모두 실패해 상태를 확인할 수 없으면 그 연결로는 턴을 열지 않고, 새 연결로 한 번만
   *   다시 연다. 그것도 안 되면 전송을 막고 알린다(M1-02). 반환된 연결을 `execute()` 에 넘긴다.
   */
  private async attachKordoc(s: ChatSnapshot, connection: AgentConnection): Promise<{ notes: string[]; connection: AgentConnection }> {
    if (!connection.setMcpSpec || !this.opts.ensureKordoc) return { notes: [], connection }
    const key = rootKey(s.root)
    const state = this.kordocAttach.get(connection)
    if (state?.state === 'attached' && state.key === key) return { notes: [], connection }

    const notes: string[] = []
    this.kordocNoteSinks.set(key, (text) => { notes.push(text) })
    try {
      const registry = this.kordocRegistry(s.root)
      const spec = await registry.acquire(s.root)
      let target = connection
      let outcome: KordocApplyOutcome = 'rejected'
      // 남아 있는 상태가 **다른 폴더의 부착**이면 옛 울타리를 먼저 뗀다 — A 의 사양으로 B 턴을
      // 돌리지 않는다(M1-01). 이 해제는 필수다: 못 떼면 그 연결의 MCP 범위를 확인할 수 없다.
      if (state?.state === 'attached' && state.key !== key) {
        outcome = (await this.releaseKordocSpec(target, registry, s.root, true)) ? 'rejected' : 'unsafe'
      }
      if (outcome !== 'unsafe') {
        if (spec !== null) outcome = await this.applyKordocSpec(target, spec, registry, s.root)
        // 처음 보는 연결에는 "붙일 것이 없다"를 알린다. 실패해도 안전 문제는 아니다 — 아직 아무것도
        // 넘기지 않은 연결이므로 남은 구성이 없다(M1-02 는 이미 사양이 올라간 연결의 경우다).
        else if (!state) this.releaseKordocSpec(target, registry, s.root, false)
      }
      if (outcome === 'unsafe') {
        target = await this.reopenConnection(s.root, s.provider, connection, s.sessionId)
        // 새 연결은 처음 보는 연결이다 — 같은 사양을 한 번 더 적용한다.
        if (spec !== null) outcome = await this.applyKordocSpec(target, spec, registry, s.root)
        else { this.releaseKordocSpec(target, registry, s.root, false); outcome = 'rejected' }
        if (outcome === 'unsafe') {
          throw new Error('한글 문서 읽기 도구를 붙이지 못했어요. 이 대화 도구가 문서 읽기 설정을 받아들이지 못해 안전하게 보낼 수 없어요. 잠시 뒤 다시 시도해 주세요.')
        }
      }
      this.kordocAttach.set(target, { state: outcome === 'attached' ? 'attached' : 'notified', key })
      return { notes, connection: target }
    } finally {
      this.kordocNoteSinks.delete(key)
    }
  }
  /** 논문 폴더 밖 접근을 막는 사양을 하나 적용한다. 공급자가 거절하면 `null` 로 내리는 것까지가 몫이다. */
  private async applyKordocSpec(
    connection: AgentConnection,
    spec: KordocMcpSpec,
    registry: KordocMcpRegistry,
    root: string
  ): Promise<KordocApplyOutcome> {
    const setSpec = connection.setMcpSpec!
    try { await setSpec.call(connection, spec); return 'attached' }
    catch {
      // 공급자가 사양을 받아들이지 못하면 MCP 없이 간다 — 붙이지 못한 것이 전송을 막지는 않는다.
      // 다음 send 는 레지스트리의 성공 캐시에서 같은 사양을 다시 받아 재시도한다.
      registry.reportProviderFailure(root)
      return (await this.releaseKordocSpec(connection, registry, root, false)) ? 'rejected' : 'unsafe'
    }
  }
  /**
   * 사양을 내린다. `required` 면 이것이 옛 울타리를 떼는 일이라 실패가 곧 "MCP 범위를 확인할 수
   * 없음"이다(M1-02). 아니면 아직 아무것도 안 올라간 연결을 정리하는 것이라 실패해도 안전하다.
   * 반환값 `true` = MCP 없는 상태로 확인됨.
   */
  private async releaseKordocSpec(
    connection: AgentConnection,
    registry: KordocMcpRegistry,
    root: string,
    required: boolean
  ): Promise<boolean> {
    try { await connection.setMcpSpec!.call(connection, null); return true }
    catch {
      if (!required) return false
      registry.reportProviderFailure(root)
      return false
    }
  }
  /** 안전을 확인하지 못한 연결을 버리고 같은 폴더·공급자의 새 연결을 연다(M1-02). */
  private async reopenConnection(root: string, provider: Provider, dead: AgentConnection, sessionId: string | undefined): Promise<AgentConnection> {
    const key = this.key(root, provider)
    if (this.connections.get(key) === dead) this.connections.delete(key)
    this.kordocAttach.delete(dead)
    try { await dead.stop() } catch { /* 이미 죽은 연결 — 버리는 것이 목적이다 */ }
    const fresh = this.connection(root, provider)
    if (!(await this.checkedStatus(provider, fresh)).connected) {
      throw new Error(this.authRequired.has(provider) ? authCopy(provider) : 'AI 계정 연결을 먼저 완료해 주세요.')
    }
    // 새 연결도 첫 전송과 같은 준비를 거친다 — 모델 기본값 확인을 건너뛰면 다른 모델로 조용히 보낸다.
    await fresh.prepare?.(sessionId)
    return fresh
  }
  private connection(root: string, provider: Provider): AgentConnection {
    this.ensureActive()
    const key = this.key(root, provider)
    let c = this.connections.get(key)
    if (!c) {
      const guard = this.guardFor(root)
      const env = this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root))
      const figureEnv = this.opts.figures?.env
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider),
        // 그림 통로의 저장소 자리는 **메인 턴 엔진에만** 얹는다. 고리가 없으면 같은 객체 그대로다
        // (정체성까지 지금과 같다) — 전역 연결(상태 확인·로그인)에는 얹지 않는다, 턴이 없으니까.
        env: figureEnv ? { ...env, ...figureEnv } : env,
        openExternal: this.opts.openExternal, trusted: () => this.opts.isTrusted?.(root) ?? false,
        guard,
        // 설치본 내용이 동봉본과 같은지 자동 실행 전에 대조한다(C-01ⓒ) — 설치 때 쓴 원본과
        // 같은 함수를 쓴다(`skillSource`).
        skillBundleSource: () => this.opts.skillSource(),
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
      // 이 연결은 상태 확인·로그인만 한다(턴 없음). 그래도 받는 자리를 똑같이 채운다 —
      // 공급자 코드가 guard 유무로 갈리므로 전역 연결만 종전 모양으로 남기지 않는다.
      // 열쇠가 없어도(`key: null`) 문맥은 넘긴다(C-02) — 격리·열거는 열쇠와 무관하다.
      const guard = this.guardFor(root)
      const options: AgentOptions = {
        binary: '', root, skill: this.skillDir(root, provider),
        env: this.opts.env ?? subscriptionEnv(this.pythonBinDirs(root)),
        openExternal: this.opts.openExternal, trusted: () => false,
        guard,
        skillBundleSource: () => this.opts.skillSource()
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
      // 대조본을 넘겨 판 표시뿐 아니라 **내용**까지 본다(C-01ⓒ) — 표시만 같은 변조본은 다시 깐다.
      const state = skillState(skill, version, source)
      if (state === 'missing') installSkill(source, skill, version, source)
      else if (state === 'outdated' || (s.skillHash && s.skillHash !== version)) {
        // A changed skill is never a send-blocker: reinstall (with backup) and note it in the transcript.
        const marker = join(skill, VERSION_FILE)
        const old = s.skillHash && s.skillHash !== version ? s.skillHash : existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : '이전 버전'
        installSkill(source, skill, version, source)
        s.messages.push({ id: randomUUID(), role: 'system', text: `규칙집이 갱신됐어요 (이전 ${old} → 현재 ${version})`, at: new Date().toISOString() })
      } else installSkill(source, skill, version, source) // Refresh GUI ownership even for an unchanged copy.
      const connection = this.connection(root, provider)
      if (!(await this.checkedStatus(provider, connection)).connected) throw new Error(this.authRequired.has(provider) ? authCopy(provider) : 'AI 계정 연결을 먼저 완료해 주세요.')
      // 전송 전 확인 — 여기서 던지면 보낸 말이 대화에 남지 않고 초안도 그대로다. 예전 모델로
      // 조용히 보내는 대신 학생에게 오류로 알린다(검토 MC1-01).
      await connection.prepare?.(s.sessionId)
      // 폴더의 첫 전송에서만 kordoc 런타임을 확인해 이 연결에 넘긴다(§3.2). 실패해도 대화는 간다.
      // 상태를 확인하지 못한 연결은 버리고 새 연결을 받을 수 있다(M1-02) — 그 연결로 실행한다.
      const attach = await this.attachKordoc(s, connection)
      for (const note of attach.notes) {
        s.messages.push({ id: randomUUID(), role: 'system', text: note, at: new Date().toISOString() })
      }
      const live = attach.connection
      s.skillHash = version; s.skillLoaded = false; s.state = 'running'; s.error = undefined
      s.authRequired = undefined
      s.messages.push({ id: requestId, role: 'user', text, at: new Date().toISOString(), delivery: 'pending' })
      this.publish(s)
      /**
       * 그림 통로 고리 — 학생 메시지가 대화에 남은 뒤, 엔진을 부르기 전. 그림 명령이 없는 판에서는
       * 이 고리가 할 일이 없고, 있는 판에서도 그림은 대화의 **조건이 아니다**: 던지거나 거절하면
       * 조용히 버린다(학생 화면에 오류·알림을 만들지 않는다). 순서는 계약이다 —
       * `recordStudentMessage`(후보표에 원문) → `beginTurn`(턴 열기). turnId 는 이 요청 id.
       */
      const figures = this.opts.figures
      const figureKey = this.key(root, provider)
      if (figures) {
        /**
         * 그림 준비 대기 — 옛 턴 닫기 · 후보표 · 턴 열기(I-02). 이 대기는 엔진 실행 **전**이라 `runs`
         * 에 아직 없다. 그래서 취소 토큰(`preps`)에 등록해 중단·종료가 깨울 수 있게 하고, 전체 대기에
         * 상한도 둔다. 깨우면 남은 고리를 건너뛰고 **엔진을 부르지 않는다**(중단된 요청을 뒤늦게
         * 실행하지 않는다). 상한을 넘기면 그림 고리만 포기하고 대화는 그대로 간다 — 그때 늦게 끝나는
         * 옛 `endTurn` 이 새 턴을 지우지 않는 것은 통로의 소유권 검사가 맡는다.
         */
        const prep = this.beginFigurePrep(figureKey)
        let opening: Promise<unknown> = Promise.resolve()
        try {
          // 옛 턴의 `endTurn()` 이 아직 돌고 있으면 **새 턴을 열기 전에** 기다린다. 안 기다리면 옛
          // `endTurn` 이 방금 연 새 턴의 `turn.json` 을 지워, 감시자가 새 턴의 요청을 전부 `stale` 로 본다.
          const closing = this.figureClosing
          if (closing) {
            await this.racePrep(prep, closing)
            if (this.figureClosing === closing) this.figureClosing = null
          }
          if (!prep.settled) await this.racePrep(prep, figures.recordStudentMessage(root, text))
          // 취소된 뒤에는 턴을 열지 않는다 — 열면 곧바로 닫아야 하고, 그 사이 감시자가 요청을 집는다.
          if (!prep.settled) {
            opening = figures.beginTurn(root, requestId)
            await this.racePrep(prep, opening)
          }
        } finally {
          prep.settle()
          if (this.preps.get(figureKey) === prep) this.preps.delete(figureKey)
        }
        if (prep.cancelled) {
          // 중단·종료가 준비 도중에 왔다. `stop()` 이 이미 `stopped` 를 게시했다 — 여기서 엔진을 부르면
          // 학생이 멈춘 턴이 뒤늦게 시작된다. 잠금만 풀고 지금 스냅샷을 돌려준다.
          //
          // 다만 **열린 턴은 닫는다**. 안 닫으면 감시자가 멈춘 턴의 요청을 계속 집는다. `beginTurn` 이
          // 아직 도는 중일 수 있으므로 그 약속 뒤에 닫고, 그 약속은 다음 전송이 기다리도록 기존
          // `figureClosing` 에 잡아 둔다(소유권 검사가 있어 새 턴을 지울 위험은 없다).
          this.trackFigureClose(figures, requestId, opening)
          // 엔진에 닿지 못했지만 학생 화면에서는 "전송 중"이 영원히 남으면 안 된다 — 중단으로 끝난
          // 턴(`execute` 의 catch)과 같은 표기로 맞춘다.
          const sentMsg = s.messages.find((m) => m.id === requestId)
          if (sentMsg?.delivery === 'pending') sentMsg.delivery = 'uncertain'
          // `stop()` 이 게시한 것과 같은 상태로 맞춘다 — 종료 경로(`beginShutdown`)로 깨어난 경우에도
          // 스냅샷이 'running' 으로 남아 학생 화면이 "작업 중"에 걸리지 않게.
          if (s.state === 'running' || s.state === 'permission') { s.state = 'stopped'; s.error = undefined; this.publish(s) }
          release()
          return structuredClone(s)
        }
      }
      /**
       * 잠금 해제는 통로가 있든 없든 **예전 그대로** `.finally(release)` 다. `async` 콜백·`await` 로
       * 감싸면 해제가 마이크로태스크만큼 늦어지는데, 그 사이 `state` 는 이미 `idle` 이라
       * (`execute` 가 반환 전에 정한다) 바로 다음 `send` 가 `acquire` 에서 "작업 중"으로 거절된다
       * (`e2e/chat.spec.ts` "규칙집 갱신" 시험이 결정적으로 그 자리였다). 그래서 통로가 있을 때는
       * 잠금을 그대로 풀고 `endTurn()` **약속만** `figureClosing` 에 잡아 둔다 — 다음 턴이 시작 전에
       * 그 약속을 기다린다(위 `figures` 블록). 통로가 없으면 이 블록 자체가 없다(바이트 동일 경로).
       */
      const finished = this.execute(s, live, text, requestId)
      const run = figures
        ? finished.finally(() => {
          // 턴이 성공·실패·중단 어느 쪽으로 끝나도 닫는다. 동기 예외까지 삼키고 잠금은 반드시 푼다.
          try { this.trackFigureClose(figures, requestId) }
          catch { /* 위와 같다 */ }
          finally { release() }
        })
        : finished.finally(release)
      this.runs.set(this.key(root, provider), run)
      void run.finally(() => this.runs.delete(this.key(root, provider)))
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
  /**
   * 그림 턴 닫기를 `figureClosing` 에 잡아 둔다 — 다음 전송이 이 약속 **전체**를 기다린다.
   *
   * 이미 잡힌 종료가 있으면(준비 상한을 넘겨 기다리지 못한 것) 그것도 함께 기다린다. 덮어쓰면 그 종료가
   * 새 턴의 `turn.json` 을 지울 수 있는데, 그 한 번을 놓치는 것이 여기서 잃는 전부는 아니다.
   * 동기 예외까지 삼키고 잠금 해제는 호출부가 한다(그림은 대화의 조건이 아니다).
   */
  private trackFigureClose(figures: { endTurn(turnId: string): Promise<void> }, turnId: string, opening: Promise<unknown> = Promise.resolve()): void {
    const previous = this.figureClosing ?? Promise.resolve()
    // `opening` 이 거절해도 턴은 닫아야 한다 — 열렸는지 확실하지 않으면 통로가 소유권으로 판단한다.
    const close = Promise.allSettled([previous, opening]).then(() => figures.endTurn(turnId))
    this.figureClosing = close.catch(() => { /* 그림 통로 실패는 대화에 알리지 않는다 */ })
  }
  /**
   * 그림 준비 대기 하나를 연다(I-02). 같은 폴더·공급자의 옛 대기가 남아 있으면 먼저 깨운다 — 잠금이
   * 이미 그 자리를 배타적으로 쥐고 있으므로 실제로는 하나뿐이지만, 남아 있다면 그것은 끝나지 않은
   * 대기이고 새 전송을 막을 이유가 없다.
   */
  private beginFigurePrep(key: string): Prep {
    this.preps.get(key)?.wake()
    const { promise, resolve } = Promise.withResolvers<void>()
    const prep: Prep = {
      promise,
      settled: false,
      cancelled: false,
      // 상한은 준비 **전체**에 하나다 — 고리마다 새로 재면 세 고리가 각각 기다려 3배가 된다.
      until: Date.now() + FIGURE_PREP_DEADLINE_MS,
      settle() {
        if (prep.settled) return
        prep.settled = true
        resolve()
      },
      wake() {
        prep.cancelled = true
        prep.settle()
      }
    }
    this.preps.set(key, prep)
    return prep
  }
  /**
   * 준비 대기 하나를 **상한·취소** 안에서 기다린다. 거절은 삼킨다(그림은 대화의 조건이 아니다).
   * 상한을 넘기면 그 대기는 포기하고 진행한다 — 통로 쪽 소유권 검사가 늦은 `endTurn` 을 무해하게 만든다.
   */
  private async racePrep(prep: Prep, work: Promise<unknown>): Promise<void> {
    if (prep.settled) return
    const settled = work.then(() => 'work' as const, () => 'work' as const)
    const { promise: timer, resolve } = Promise.withResolvers<'timer'>()
    const handle = setTimeout(() => resolve('timer'), Math.max(0, prep.until - Date.now()))
    handle.unref?.()
    try {
      await Promise.race([settled, prep.promise.then(() => 'prep' as const), timer])
    } finally { clearTimeout(handle) }
  }
  /**
   * 연결 정리 하나를 상한 안에서 기다린다.
   *
   * `shutdownWithin` 은 던지지 않으므로, **정착한 거절은 종전처럼 다시 던진다**(IPC 오류 문구가
   * 그대로 살아야 한다). 마감을 넘긴 것은 `'pending'` 으로 **돌려준다** — 이름만 남기고 넘어가면
   * 호출부가 그 정리를 완료로 읽고(검토 RT3 차단) 회수 분기를 건너뛴다. 기다림 자체는 여기서 끝난다:
   * 끝나지 않는 연결 때문에 호출자(중단 버튼·앱 종료)가 매달리지는 않는다.
   */
  private async stopConnectionWithin(name: string, connection: AgentConnection, deadlineMs: number, label: string): Promise<'settled' | 'pending'> {
    const outcome = await shutdownWithin([{ name, start: () => connection.stop() }], deadlineMs)
    if (outcome.failed.length) throw outcome.failed[0].reason
    if (!outcome.pending.length) return 'settled'
    console.error(`[shutdown] ${label}: ${deadlineMs}ms 안에 끝나지 않은 연결 — ${outcome.pending.join(', ')}`)
    return 'pending'
  }
  async stop(root: string, provider: Provider) {
    const key = this.key(root, provider), s = this.snapshots.get(key)
    // 진단: 예전에는 아래 두 기다림이 마감 밖이었다 — 멈춤 후보 1b. 진단이 꺼져 있으면
    // 시계도 문자열도 만들지 않는다(검토 RT3 권고) — 중단 버튼은 학생이 누르는 경로다.
    const traced = diagEnabled()
    const startedAt = traced ? Date.now() : 0
    /**
     * 아직 `runs` 에 없는 **그림 준비 대기**도 멈춘다(I-02). 이걸 빼면 중단이 효력이 없어 대기가 풀린 뒤
     * 엔진이 뒤늦게 실행된다(검토 실측). 상태를 `stopped` 로 게시하는 것과 같은 틱에 깨운다 — 그래야
     * 깨어난 `send` 가 게시된 `stopped` 를 그대로 보고 엔진을 부르지 않는다.
     */
    const prep = this.preps.get(key)
    prep?.wake()
    if (s && (this.runs.has(key) || prep)) { s.state = 'stopped'; s.error = undefined; this.publish(s) }
    // 멈춘 연결은 버린다 — 다음 send/status 가 새 연결을 열어야 '다시 확인'이 살아난다.
    const connection = this.connections.get(key)
    if (traced) diag(`stop:connection:start provider=${provider} has=${connection ? 'y' : 'n'} elapsed=${Date.now() - startedAt}ms`)
    if (connection) {
      // 마감을 넘긴 연결은 **재사용하지 않지만**(맵에서 지운다) 소유권은 남긴다 — 나중 `close()` 가
      // 그 자식까지 회수해야 한다(검토 RT3 차단).
      if (await this.stopConnectionWithin(`stop:${provider}`, connection, CLOSE_CONNECTION_DEADLINE_MS, '중단') === 'pending') this.reclaimPending.add(connection)
    }
    this.connections.delete(key)
    if (traced) diag(`stop:connection:end provider=${provider} elapsed=${Date.now() - startedAt}ms`)
    const run = this.runs.get(key)
    if (traced) diag(`stop:run:start provider=${provider} has=${run ? 'y' : 'n'} elapsed=${Date.now() - startedAt}ms`)
    if (run) {
      // 턴도 상한을 둔다. 마감을 넘긴 턴은 상태가 이미 `stopped` 라 화면은 멈췄고,
      // 실행기 쪽 정리는 그 연결의 stop 이 맡는다 — 여기서 더 기다려 봐야 호출자만 막힌다.
      const outcome = await shutdownWithin([{ name: `run:${provider}`, start: () => run }], CLOSE_RUN_DEADLINE_MS)
      if (outcome.failed.length) throw outcome.failed[0].reason
      if (outcome.pending.length) console.error(`[shutdown] 중단: ${CLOSE_RUN_DEADLINE_MS}ms 안에 끝나지 않은 턴 — ${outcome.pending.join(', ')}`)
    }
    if (traced) diag(`stop:run:end provider=${provider} elapsed=${Date.now() - startedAt}ms`)
  }
  /**
   * Reversible handoff teardown: never sets shuttingDown; dead connection objects are not reused.
   *
   * 마감을 넘긴 연결은 여기서 **던지지 않는다**(인계는 계속돼야 한다). 다만 그 연결은
   * `reclaimPending` 에 남겨 소유권을 유지하고 `'pending'` 으로 알린다 — 정리를 완료로 읽지 않게.
   * **호출 전부터 남아 있던 미회수 연결**(학생 중단이 3초를 넘긴 것)도 같은 판정에 들어간다:
   * 이번 호출이 그 `stop()` 을 다시 부르지 않더라도, 아직 살아 있는 자식은 완료가 아니다.
   */
  async closeForUpdate(confirmStopped: () => Promise<void>): Promise<'settled' | 'pending'> {
    for (const connection of [...this.connections.values(), ...this.globals.values()]) this.closingConnections.add(connection)
    this.connections.clear()
    this.globals.clear()
    this.reauthenticating.clear()
    // 진단: 예전에는 이 기다림이 마감 밖이었다 — 멈춤 후보 1b.
    // 진단이 꺼져 있으면 시계도 문자열도 만들지 않는다(검토 RT3 권고).
    const traced = diagEnabled()
    const startedAt = traced ? Date.now() : 0
    /**
     * 인계 전에 이미 마감을 넘겨 남아 있던 연결(`stop()` 타임아웃분). 이번 `list` 에는 없으므로
     * 따로 합쳐야 완료 판정이 "정말 다 정리됐는가"가 된다 — `close()` 와 같은 규칙이다.
     */
    const stranded = [...this.reclaimPending]
    if (traced) diag(`closeForUpdate:stop:start n=${this.closingConnections.size} stranded=${stranded.length}`)
    // 이름(`stop:<i>`)을 같은 배열의 순번으로 되돌려야 한다 — 순회 대상은 한 번만 만든다.
    const list = [...this.closingConnections]
    const stopped = await shutdownWithin(
      // 이름에 논문 폴더 경로를 넣지 않는다(로그가 CI 산출물로 올라간다) — 순번만.
      list.map((connection, i) => ({ name: `stop:${i}`, start: () => connection.stop() })),
      CLOSE_CONNECTION_DEADLINE_MS
    )
    if (traced) diag(`closeForUpdate:stop:end elapsed=${Date.now() - startedAt}ms failed=${stopped.failed.length} pending=${stopped.pending.length}`)
    if (stopped.pending.length) console.error(`[shutdown] 연결 정리: ${CLOSE_CONNECTION_DEADLINE_MS}ms 안에 끝나지 않은 연결 ${stopped.pending.length}건 — ${stopped.pending.join(', ')}`)
    const pending = list.filter((_, i) => stopped.pending.includes(`stop:${i}`))
    for (const connection of pending) this.reclaimPending.add(connection)
    // 이번 호출에서 실제로 정착한 연결은 회수 목록에서도 지운다 — 남겨 두면 완료 판정이 거짓 미완료가 된다.
    for (const connection of list) if (!pending.includes(connection)) this.reclaimPending.delete(connection)
    // 인계 판정도 이번 pending ∪ (아직 남아 있는) 호출 전 미회수 — 이전 `stop()` 타임아웃분이 있으면 완료가 아니다.
    const unreclaimed = [...this.reclaimPending]
    await confirmStopped()
    if (traced) diag(`closeForUpdate:confirm:end elapsed=${Date.now() - startedAt}ms unreclaimed=${unreclaimed.length}`)
    const failed = stopped.failed[0]
    if (failed) throw failed.reason
    // 확인까지 끝났고 마감을 넘긴 연결이 없을 때만 목록을 비운다.
    if (!pending.length) this.closingConnections.clear()
    if (unreclaimed.length) {
      console.error(`[shutdown] 연결 정리: 회수하지 못한 연결 ${unreclaimed.length}건 — 이번 마감 초과 ${pending.length} · 이전 타임아웃 ${stranded.length}`)
      return 'pending'
    }
    return 'settled'
  }
  /**
   * 종료 정리. 돌려주는 값은 **정리 결과의 분류**다:
   *  - `done` — 모든 연결 정리가 마감 안에 끝났다(진행 중 턴은 종전처럼 자기 상한만 둔다).
   *  - `pending` — 마감을 넘긴 연결이 있다. `pids` 는 그 연결들이 띄운 자식이다.
   *
   * 예전에는 `void` 를 돌려주고 마감 초과를 `console.error` 로만 남겼다. 호출부(`index.ts`)는
   * 그 `chat.close` 를 완료로 읽어 `needsReclaim=false` → 회수 분기를 건너뛰었고, 그 연결의 pid 는
   * `ownedPids()` 에서도 사라졌다(검토 RT3 차단). 분류를 돌려주면 호출부가 실패로 승격할 수 있다.
   * 마감을 넘긴 연결은 **다시 쓰지 않지만**(맵을 비운다) 소유권은 `reclaimPending` 에 남는다.
   * `done` 의 뜻은 "지금 정말로 회수할 것이 없다"다 — 이번 호출에서 마감을 넘긴 연결뿐 아니라
   * **이전 `stop()` 이 남겨 둔 미회수 연결**까지 없어야 `done` 이다(검토 hangfix-fix2 차단).
   */
  async close(): Promise<{ outcome: 'done' } | { outcome: 'pending'; pids: number[] }> {
    // 진단이 꺼져 있으면 시계·문자열 조립을 하지 않는다(검토 RT3 권고) — 종료 경로다.
    const traced = diagEnabled()
    const startedAt = traced ? Date.now() : 0
    /**
     * **호출 전부터 남아 있던 미회수 연결.** `stop()`(학생 중단)이 3초 마감을 넘기면 그 연결을
     * `reclaimPending` 에 넣고 활성 맵에서 지운다 — 재사용하면 안 되기 때문이다. 그런데 이 목록을
     * 완료 판정에서 빼면 다음 `close()` 가 "이번에 찾은 pending 없음"만 보고 `done` 을 돌려준다:
     * 검토 hangfix-fix2 실측이 정확히 그랬다(close 0ms · done=[sidecar.stop, chat.close] ·
     * `needsReclaim=false` · 자식 생존). 그래서 **이번 pending 과 이 스냅숏의 합집합**으로 정한다.
     *
     * 이 연결들의 `stop()` 은 **다시 부르지 않는다**: 이미 한 번 마감을 넘긴 stop 을 또 3초
     * 기다리면 종료만 늦어지고(검토자 실측 stop 호출 1회), 남은 자식은 `reclaimChildren` 이 pid 로
     * 회수한다. "남아 있다"는 사실 자체가 미완료다.
     */
    const stranded = [...this.reclaimPending]
    if (traced) diag(`close:start runs=${this.runs.size} connections=${this.connections.size} globals=${this.globals.size} closing=${this.closingConnections.size} stranded=${stranded.length}`)
    this.beginShutdown()
    const connections = new Set([...this.connections.values(), ...this.globals.values(), ...this.closingConnections])
    /**
     * 연결 정리에도 **상한**을 둔다. 예전에는 이 `Promise.allSettled` 가 `shutdownWithin` **밖**이라
     * 바깥 10초 마감이 걸리지 않았다: 연결 하나의 `stop()` 이 안 끝나면 정리 전체가 마감 없이
     * 매달렸다(멈춤 후보 1b). 정착한 거절은 종전처럼 나중에 다시 던진다.
     */
    if (traced) diag(`close:connections:start n=${connections.size}`)
    // 이름(`stop:<i>`)을 같은 배열의 순번으로 되돌려야 한다 — 순회 대상은 한 번만 만든다.
    const list = [...connections]
    const stopped = await shutdownWithin(
      // 이름에 논문 폴더 경로를 넣지 않는다(로그가 CI 산출물로 올라간다) — 순번만.
      list.map((connection, i) => ({ name: `stop:${i}`, start: () => connection.stop() })),
      CLOSE_CONNECTION_DEADLINE_MS
    )
    if (traced) diag(`close:connections:end elapsed=${Date.now() - startedAt}ms failed=${stopped.failed.length} pending=${stopped.pending.length}`)
    if (stopped.pending.length) console.error(`[shutdown] close: ${CLOSE_CONNECTION_DEADLINE_MS}ms 안에 끝나지 않은 연결 ${stopped.pending.length}건 — ${stopped.pending.join(', ')}`)
    const pending = list.filter((_, i) => stopped.pending.includes(`stop:${i}`))
    for (const connection of pending) this.reclaimPending.add(connection)
    // 이번 호출에서 실제로 정착한 연결은 회수 목록에서도 지운다 — 아니면 한 번 넘긴 것이 영원히 미완료로 남는다.
    for (const connection of list) if (!pending.includes(connection)) this.reclaimPending.delete(connection)
    // 완료 판정 대상 = 이번 pending ∪ 호출 전부터 남아 있던 미회수(위에서 둘을 합쳐 놓았다).
    const unreclaimed = new Set(this.reclaimPending)
    /**
     * 진행 중인 턴을 기다리되 **상한**을 둔다. 예전에는 `await Promise.all(this.runs.values())`
     * 였는데, 턴 하나가 안 끝나면 앱 종료가 영원히 매달렸다(윈도우 e2e 종료 멈춤). 남은 턴은
     * 기록만 남기고 넘긴다 — 버퍼에 남은 마지막 답이 잘릴 수는 있지만, 다음 실행의
     * `snapshot()` 이 `running`/`permission` 상태를 `interrupted` 로 복구한다(service.ts:212-215).
     */
    const runs = [...this.runs.entries()]
    if (traced) diag(`close:runs:start n=${runs.length} elapsed=${Date.now() - startedAt}ms`)
    const outcome = await shutdownWithin(
      runs.map(([key, run], i) => {
        // 이름에 논문 폴더 경로를 넣지 않는다(로그가 CI 산출물로 올라간다) — provider/role 만.
        const name = `run:${key.split('\0').slice(1).join('/') || i}`
        return {
          name,
          start: () => {
            // 진단이 꺼져 있으면 문자열 조립도 구독도 만들지 않는다 — 이 함수는 종료 경로다.
            if (traced) {
              diag(`close:run:start ${name} elapsed=${Date.now() - startedAt}ms`)
              // 거절도 함께 받는다: 성공 콜백만 달면 남은 턴의 거절이 unhandled 로 샌다.
              void run.then(
                () => diag(`close:run:end ${name} elapsed=${Date.now() - startedAt}ms`),
                (e: unknown) => diag(`close:run:reject ${name} code=${codeOf(e)} elapsed=${Date.now() - startedAt}ms`)
              )
            }
            return run
          }
        }
      }),
      CLOSE_RUN_DEADLINE_MS
    )
    if (traced) diag(`close:runs:end elapsed=${Date.now() - startedAt}ms done=${outcome.done.length} pending=${outcome.pending.length} 내부경과=${outcome.elapsedMs}ms`)
    if (outcome.pending.length) console.error(`[shutdown] close: ${CLOSE_RUN_DEADLINE_MS}ms 안에 끝나지 않은 턴 ${outcome.pending.length}건 — ${outcome.pending.join(', ')}`)
    this.connections.clear()
    this.globals.clear()
    // 마감을 넘긴 연결이 있으면 그 목록은 남긴다 — 소유권(pid)이 회수 경로까지 살아야 한다.
    if (!pending.length) this.closingConnections.clear()
    if (traced) diag(`close:end elapsed=${Date.now() - startedAt}ms pendingConnections=${pending.length}`)
    const failed = stopped.failed[0]
    if (failed) throw failed.reason
    /**
     * **호출 전부터 남아 있던 연결도 미완료다.** `stop()` 타임아웃분은 이번 `list` 에 없지만 자식은
     * 아직 살아 있다 — 여기서 `done` 을 돌려주면 `index.ts` 가 회수 분기를 건너뛴다(검토 hangfix-fix2 차단).
     */
    if (!unreclaimed.size) return { outcome: 'done' }
    const pids = [...new Set([...unreclaimed].flatMap((connection) => connection.ownedPids?.() ?? []))]
    if (traced) diag(`close:pending pids=${pids.join(',') || '없음'} reclaimed=${unreclaimed.size}`)
    return { outcome: 'pending', pids }
  }
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
