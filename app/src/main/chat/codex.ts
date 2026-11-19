import { MODEL_SELECTION_COPY } from '../../shared/copy'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JsonRpcProcess } from './transport'
import { applyRejection, recordRejection } from './rejectLog'
import { codexTokens, tokenRecord, type TokenCounts } from './jobs/tokens'
import { appendTokenRecord } from './jobs/token-log'
import { SKILL_NAME, codexSkillConfigOverride, workFolderInstructions } from '../agent'
import { writeFileAtomic } from '../safeWrite'
// v0.7(한도 실패 구분·레인 출처)와 v0.6.4(지킴이 스레드·도구 잠금, kordoc MCP)가 같은 파일에 산다.
// `codexTokens`·`tokenRecord` 는 위에서 이미 들여왔다 — 여기서 다시 넣지 않는다.
import { MainTurnUsageError, type AgentConnection, type AgentEvents, type AgentOptions } from './contracts'
import type { ChatModelInfo, ConnectionStatus, PermissionFileChange, PermissionRequest } from '../../shared/chat'
import { isCrossProviderModelId, resolveCodexAlias } from '../../shared/chat'
import type { LaneEntry, ModelCatalogEntry } from '../../shared/lanes'
import { JobFailure, type ExecutionAccount, type JobConnection, type JobEvents, type RelayRequest, type UsageState } from './jobs/types'
import { codexMcpArgs, codexMcpEnv, mcpPolicy, MCP_TOOL_PREFIX, MCP_DOC_READ_INSTRUCTION, LEGACY_DOC_READ_INSTRUCTION, MCP_SERVER_NAME, type KordocMcpSpec } from './kordocMcp'
import { McpSafetyError, verifyCodexKordoc, verifyKordocAbsent } from './kordocMcpVerify'
import { appThreadLockPlan, appThreadLockVerify, type AppThreadPlan } from './codexToolLock'
import { CodexThreadGuard, type LoadReply, type LoadTransport } from './codexThreadLock'
import { codeOf, diag } from '../diagLog'
import { FREE_RELAY_URL, FREE_MODELS, FreeRelayError, freeStatus, freeExecutionAccount, freeRelayError } from '../free/provider'
import { FREE_DS_MODEL } from '../../shared/lanes'

/** Codex 턴이 구조화해 보낸 인증 거절. 오류 본문은 판정·저장에 쓰지 않는다. */
export class CodexAuthenticationError extends Error {}

/** 존재하면 realpath, 아니면 입력 그대로. 경로 비교는 반드시 이것을 거친다. */
export function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * `codex app-server` argv. 전역 스킬 사본·플러그인 기능은 프로세스 시작 전에 끈다.
 * thread/start 의 plugins config 는 capability 필터가 아니므로 startup 차단을 병행한다.
 * `-c` 는 subcommand 앞의 루트 인자다.
 */
export function serverArgsFor(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = []
  const cfg = codexSkillConfigOverride(env.HOME)
  if (cfg) args.push('-c', cfg)
  // 모델·추론 강도도 같은 방식으로 이 프로세스에서만 정한다. 값이 없으면 인자를 늘리지
  // 않고 CLI 기본값(학생의 config.toml)을 그대로 쓴다.
  if (env.KNUAF_CODEX_MODEL) args.push('-c', `model=${env.KNUAF_CODEX_MODEL}`)
  if (env.KNUAF_CODEX_EFFORT) args.push('-c', `model_reasoning_effort=${env.KNUAF_CODEX_EFFORT}`)
  if (env.KNUAF_FREE_RELAY === '1') {
    if (!env.KNUAF_FREE_TOKEN) throw new FreeRelayError('free-unavailable')
    args.push('-c', 'model_provider="knuaf-free"',
      '-c', 'model_providers.knuaf-free.name="knuaf-free"',
      '-c', `model_providers.knuaf-free.base_url="${FREE_RELAY_URL}"`,
      '-c', 'model_providers.knuaf-free.wire_api="responses"',
      '-c', 'model_providers.knuaf-free.env_key="KNUAF_FREE_TOKEN"')
  }
  // 논문 폴더의 `AGENTS.md` 는 도우미에게 새어 들어가면 안 된다(설계 §4.1-E). 스칼라라 `-c` 가
  // 안전하고, 프로세스 전체(모든 스레드)에 걸린다 — 기동 뒤 `instructionSources` 로 한 번 더 본다.
  args.push('-c', 'project_doc_max_bytes=0')
  args.push('-c', 'features.plugins=false')
  return [...args, 'app-server']
}
const FILE_CHANGE_UNAVAILABLE = '변경 내용을 확인하지 못했어요. 거절한 뒤 도우미에게 어떤 파일을 어떻게 바꾸는지 물어봐 주세요.'

/** 다른 턴의 같은 itemId와 섞이지 않도록 서버가 보내는 세 식별자를 함께 쓴다. */
function fileChangeKey(thread: unknown, turn: unknown, item: unknown): string | undefined {
  return typeof thread === 'string' && typeof turn === 'string' && typeof item === 'string'
    ? JSON.stringify([thread, turn, item]) : undefined
}

/**
 * 배열 아닌 객체 — 이 파일이 다루는 JSON-RPC 봉투(`params`·`item`·`_meta`)의 공통 모양 검사.
 * 필드 타입은 좁히지 않는다(필드는 쓰는 자리에서 `typeof` 로 본다).
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * JSON 값의 깊은 동등 — 키 **순서**는 무시하고 배열은 순서를 본다. 승인 요청의 `_meta.tool_params`와
 * 진행 중 호출의 `item.arguments`를 대조하는 데만 쓴다(둘 다 JSON 직렬화에서 온 값이다).
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  }
  const left = plainObject(a)
  const right = plainObject(b)
  if (left && right) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every((k) => Object.hasOwn(right, k) && sameJson(left[k], right[k]))
  }
  return false
}

/**
 * 승인 요청 `_meta` 에서 이름을 아는 키 — 실물 0.164.0 다섯 개와 옛 모양·위험 플래그 셋.
 * 진단은 이 목록에 없는 키를 **개수로만** 남긴다(미지 키 이름에 경로·자유문이 실릴 수 있다).
 */
const KNOWN_META_KEYS: readonly string[] = [
  'codex_approval_kind', 'persist', 'tool_description', 'tool_params', 'tool_params_display',
  'tool_name', 'codex_requires_user_input', 'codex_sensitive_action'
]

function readFileChanges(value: unknown): PermissionFileChange[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const changes: PermissionFileChange[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) return undefined
    const kind = typeof raw.kind === 'string' ? raw.kind : raw.kind?.type
    const type = kind === 'add' || kind === 'delete' || kind === 'update' ? kind : 'unknown'
    changes.push({ path: raw.path, kind: type === 'update'
      ? { type, move_path: typeof raw.kind?.move_path === 'string' ? raw.kind.move_path : null }
      : { type }, diff: typeof raw.diff === 'string' ? raw.diff : null })
  }
  return changes
}

function filePermission(id: string, reason: unknown, changes?: PermissionFileChange[]): PermissionRequest {
  const detail = typeof reason === 'string' && reason.trim() ? reason : ''
  return { id, title: '파일 변경 확인', detail: changes ? detail : [detail, FILE_CHANGE_UNAVAILABLE].filter(Boolean).join('\n\n'),
    ...(changes ? { fileChanges: changes } : {}) }
}

export class CodexConnection implements AgentConnection {
  private get free(): boolean { return this.options.env.KNUAF_FREE_RELAY === '1' }
  private rpc?: JsonRpcProcess
  private events?: AgentEvents
  private serverVersion: string | null = null
  private thread?: string
  private loginPending = false
  private loginConfirmed = false
  private earlyLogin?: { id: string; success: boolean }
  private turn?: string
  /**
   * 이 연결이 **이 대화에** model/effort 덮어쓰기를 보낸 적이 있는가.
   * `turn/start` 의 model/effort 는 같은 thread 의 뒤 턴에 계속 남으므로, 선택을 해제할 때는
   * 생략이 아니라 **서버 기본값을 명시적으로 다시 보내야** 되돌아간다(검토 MC1-01).
   */
  private overridden = false
  /** 마지막 `thread/start`/`thread/resume` 응답이 알려 준 그 대화의 model·effort. */
  private threadModel: string | null = null
  private threadEffort: string | null = null
  /**
   * 마지막 `turn/start` 에 **실제로 실어 보낸** model·effort(설계 §1-3 ②). 거절은
   * `connect()` 의 `turn/completed` 처리에서 오는데 거기엔 `run()` 지역 값이 없다 —
   * 실패 당시의 출처를 만들려면 보낸 값을 여기 남겨야 한다. 턴마다 새로 덮는다.
   */
  private turnChoice: { model: string | null; effort: string | null } = { model: null, effort: null }
  /** 재개한 대화가 기본값과 다른지 한 번만 본다. */
  private resumeChecked = false
  /** 서버가 새 대화에 실제로 쓰는 기본값(계정·CLI 설정). `model/list` 나 설정을 추측하지 않는다. */
  private defaults?: { model: string; effort: string | null }
  /** 마지막 `model/list` 결과 — 고른 모델의 기본 생각 깊이를 찾는 데 쓴다. */
  private catalog?: ChatModelInfo[]
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  /** 무료 모델의 phase=null 호환: 마지막 도구 완료 뒤에 완성된 말이 있어야 답이다. */
  private freeAnswered = false
  private approvals = new Map<string, number | string>()
  private messages = new Map<string, string>()
  private fileChanges = new Map<string, PermissionFileChange[]>()
  private pendingFileApprovals = new Map<string, { key: string; reason: unknown }>()
  /**
   * 이 프로세스가 지금 도는 중인 MCP 도구 호출(`item/started`→`item/completed`).
   * 동봉 Codex 0.164.0 의 승인 요청 `_meta` 에는 **`tool_name` 이 없고**, 도구 이름은 같은 턴의
   * `item/started` 안 `mcpToolCall.tool` 에만 있다(실기기 run4:60~62). 승인은 이 표에서
   * 같은 턴·서버·인자로 **하나로 특정된** 호출에만 준다 — 표시 문구(`message`)는 근거가 아니다.
   */
  private mcpCalls = new Map<string, { thread: string; turn: string; server: string; tool: string; args: unknown }>()
  /** 이 프로세스에 붙일 kordoc MCP 사양(§3.3). 미부착이면 undefined/null. */
  private mcpSpec?: KordocMcpSpec | null
  /** MCP 기동 검증(§3.3 4단계)을 이미 통과한 프로세스 — 프로세스당 1회만 부른다. */
  private verifiedOn?: JsonRpcProcess
  /**
   * 최신 CLI 는 평문 `app-server`; 실패하면 옛 `--listen stdio://` 로 한 번 재시도한다.
   * 앞의 `-c` 는 전역 knuaf-dev 스킬 사본을 끄는 config 오버라이드 — ~/.codex/skills 등에
   * 낡은 사본이 있으면 프로젝트 사본과 함께 enabled 로 보여 모델이 옛 지침을 따른다.
   * Claude 는 settingSources 로 막는 자리이고 Codex 에는 세션 범위 옵션이 없어 프로세스
   * 오버라이드로 대신한다(사용자 config.toml 은 건드리지 않는다). live 스모크가 검증.
   */
  private serverArgs: string[]
  /** stop() 이후에는 진행 중인 connect() 의 재시도가 새 프로세스를 다시 띄우지 않는다. */
  private stopped = false
  /** 이 턴에 **실제로 적용된** model·effort 와 턴 식별자 — 기록의 귀속 기준(검토 CT-02). */
  private turnTokens?: { key: string; model: string; effort: string | null }
  /**
   * 응답 대기 구간까지 포함한 "턴이 도는 중" 표식(검토 M2-R1-02). `this.turn` 은 서버가 턴 id 를
   * 준 뒤에야 채워지므로, 그 전에 `setMcpSpec` 이 들어오면 RPC 를 닫아 **진행 중인 턴을 끊었다**.
   * 계약("턴 중에는 바꾸지 않는다")은 id 를 받기 전 구간도 포함해야 한다.
   */
  private turnActive = false
  /**
   * 지킴이 적재 표·턴 원장(설계 §4.1-C). `options.guard` 가 아예 없을 때만(지킴이 없이 뜬 옛
   * 호출부·시험) 이 필드가 비고 아래 경로가 종전 그대로다. 앱이 만드는 연결은 열쇠가 없어도
   * 문맥을 늘 받는다(`key: null`) — 그때는 디스크 원장을 믿지 않고 메모리 원장만 쓰며,
   * **격리·잠금·플러그인 열거는 그대로 돈다**(C-02).
   */
  private guard?: CodexThreadGuard
  /** 이번 턴의 잠금 계획 — `verify` 가 같은 `config` 를 기준으로 대조한다. */
  private plan?: AppThreadPlan
  /** 마지막 적재 응답이 알려 준 값 — 보호 경로에는 `r` 이 남지 않으므로 여기에 담는다. */
  private loaded?: { model: string | null; effort: string | null; turns: unknown }
  /**
   * 메인이 스스로 띄운 하위 담당(설계 §3.2 Codex 열, §5-7). 앱에는 부모의 도구 호출을 막을
   * 관문이 없으므로 **기록·알림까지만** 한다. 담당 thread id → 띄울 때 요청한 model·effort.
   * 실제 model·effort 는 `subAgentActivity` 가 알려 준다(F6).
   */
  private subagents = new Map<string, { model: string | null; effort: string | null }>()
  /**
   * 아직 자식 thread id 를 못 받은 spawn 호출 — 키는 `<부모 thread>:<호출 item id>`.
   *
   * 왜 미뤄 두는가: 엔진은 `item/started` 에서 **새 thread id 를 아직 모른다**(`CollabAgentSpawnBeginEvent`
   * 에는 그 필드가 없고 `CollabAgentSpawnEndEvent` 에만 `new_thread_id` 가 있다). 그래서
   * 시작 알림의 `receiverThreadIds` 는 비어 있고 완료 알림에서야 채워진다 — 시작에서 곧바로
   * "처리됨"으로 닫으면 그 id 를 버려 요청값↔실제값 대조가 깨진다(검토 U5b 중요 2).
   */
  private pendingSpawns = new Map<string, { model: string | null; effort: string | null }>()
  /** 실제값을 이미 기록한 담당 thread — `subAgentActivity` 가 started 로 두 번 와도 한 번만. */
  private recordedActivities = new Set<string>()
  constructor(private options: AgentOptions) {
    this.serverArgs = serverArgsFor(options.env)
    const guard = options.guard
    if (guard) this.guard = new CodexThreadGuard({ userData: guard.userData, folderHash: guard.folderHash, key: guard.key })
  }
  /**
   * 프로세스가 바뀌었다 — 적재 표·잠금 계획·적재 응답은 **그 프로세스의 것**이다(설계 §4.1-C
   * PROCESS DISCARD RULE). 지킴이가 없으면 만질 것이 없다.
   */
  private dropGuard(): void {
    this.guard?.discard()
    this.plan = undefined
    this.loaded = undefined
  }
  /** `instructionSources` 의 전역 예외(CODEX_HOME 바로 아래 `AGENTS.md`) 판정 기준. */
  private codexHome(): string | undefined {
    const env = this.options.env
    if (env.CODEX_HOME) return env.CODEX_HOME
    return env.HOME ? join(env.HOME, '.codex') : undefined
  }
  /** 열거·계획 한 번(§4.1-C 1번) — `thread/start|resume` **앞**에 부른다. */
  private async lockPlan(rpc: JsonRpcProcess): Promise<AppThreadPlan> {
    const injected = this.mcpSpec ? [{ name: MCP_SERVER_NAME, spec: this.mcpSpec }] : []
    const plan = await appThreadLockPlan({
      root: this.options.root, form: 'app-thread', injected, rpc, codexHome: this.codexHome()
    })
    if (!plan.ok) {
      diag(`codex-lock stage=plan reason=${plan.reason}`)
      throw new Error(plan.studentCopy)
    }
    // Restart without -c injection before any inventory/probe can start a contaminated MCP.
    if (this.mcpSpec && plan.plan.kordocCollision) {
      throw new McpSafetyError('학생 설정의 동명 한글 문서 도구는 붙이지 않아요', 'server-collision')
    }
    return plan.plan
  }
  /** 이 턴의 계획을 재사용한다 — `verify` 가 **같은** `config` 를 기준으로 대조해야 한다. */
  private async ensurePlan(rpc: JsonRpcProcess): Promise<AppThreadPlan> {
    if (this.plan) return this.plan
    return (this.plan = await this.lockPlan(rpc))
  }
  /**
   * 지금 프로세스를 버린다 — 다음 호출은 새 프로세스를 띄운다(설계 §4.1-C PROCESS DISCARD RULE).
   *
   * 표·적재 응답은 **그 프로세스의 것**이라 함께 버린다. 계획(`this.plan`)은 **이 턴**의 것이라
   * 그대로 둔다 — `acquire` 가 쥔 지문과 `verify` 가 대조하는 `config` 가 같은 것이어야 한다.
   * 탐침(`serverDefaults`)이 쓸 수 없는 응답(대화 id·모델 없음, 요청 실패)을 받은 프로세스도
   * 여기로 버린다. 그 프로세스는 잠금을 확인하지 않은 채 시작 표식만 남아 있어, 다음 적재가
   * "잠긴 프로세스"로 믿으면 안 된다(I-02).
   */
  private async discardProcess(): Promise<void> {
    await this.rpc?.stop().catch(() => {})
    this.rpc = undefined
    this.verifiedOn = undefined
    this.guard?.discard()
    this.loaded = undefined
  }
  /**
   * 재기동을 거친 뒤 `turnBody` 의 `rpc` 는 죽은 프로세스다. 전송은 매 호출에서 **지금**
   * 연결을 다시 잡는다 — 적재가 끝난 시점의 연결이 곧 이어 쓸 연결이다.
   */
  private loadTransport(args: Record<string, unknown>): LoadTransport {
    const injected = this.mcpSpec ? [{ name: MCP_SERVER_NAME, spec: this.mcpSpec }] : []
    const text = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))
    return {
      start: async () => {
        try {
          const rpc = await this.connect()
          const plan = await this.ensurePlan(rpc)
          return this.loadReply(await rpc.request('thread/start', { ...args, config: plan.config }))
        } catch (e) {
          diag(`codex-lock stage=thread-start code=${codeOf(e)}`)
          return { ok: false, kind: 'error', message: text(e) }
        }
      },
      resume: async (threadId) => {
        try {
          const rpc = await this.connect()
          const plan = await this.ensurePlan(rpc)
          return this.loadReply(await rpc.request('thread/resume', { ...args, threadId, config: plan.config }))
        } catch (e) {
          diag(`codex-lock stage=thread-resume code=${codeOf(e)}`)
          const message = text(e)
          const kind = message.includes('already has an active writer')
            ? 'active-writer'
            : message.includes('no rollout found for thread id')
              ? 'no-rollout'
              : message.includes('AI 응답 시간이 초과됐어요')
                ? 'timeout'
                : 'error'
          return { ok: false, kind, message }
        }
      },
      verify: async (threadId, instructionSources) => {
        try {
          const rpc = await this.connect()
          const plan = await this.ensurePlan(rpc)
          const out = await appThreadLockVerify({
            root: this.options.root,
            form: 'app-thread',
            injected,
            rpc,
            codexHome: this.codexHome(),
            check: { threadId, instructionSources }
          }, plan)
          // Process/cwd scoped, not thread scoped: verify the startup cutoff, not the
          // thread config's disabled-plugin declaration.
          if (out.ok) {
            const listed = await rpc.request('skills/list', { cwds: [this.options.root], forceReload: true })
            const entries: unknown = listed?.data
            const clean = Array.isArray(entries) && entries.length === 1 && entries.every((entry) =>
              Array.isArray(entry?.skills) && entry.skills.every((skill: { enabled?: unknown; pluginId?: unknown } | null) =>
                typeof skill?.enabled === 'boolean' && skill.pluginId === null))
            if (!clean) {
              diag('codex-lock stage=verify reason=plugin-skills')
              return { ok: false, detail: 'plugin-skills' }
            }
          }
          if (!out.ok) {
            // Exact product names only: kordocMcp.MCP_SERVER_NAME and bundled Codex's node_repl
            // (scripts/fetch-codex.mjs). Even short user names can contain secrets or personal data.
            let userMcp = 0
            const names = out.remaining.map((name) => name === MCP_SERVER_NAME || name === 'node_repl' ? name : `user-mcp-${++userMcp}`)
            diag(`codex-lock stage=verify reason=${out.reason} remaining=${out.remaining.length} names=${JSON.stringify(names)}`)
          }
          return out.ok ? { ok: true } : { ok: false, detail: out.reason }
        } catch (e) {
          diag(`codex-lock stage=verify code=${codeOf(e)}`)
          return { ok: false, detail: 'exception' }
        }
      },
      restart: async () => { await this.discardProcess() }
    }
  }
  /** 적재 응답 옮기기 — 보호 경로에는 응답 객체가 남지 않으므로 model·effort·turns 만 담는다. */
  private loadReply(raw: unknown): LoadReply {
    const reply = raw && typeof raw === 'object'
      ? (raw as { thread?: unknown; model?: unknown; reasoningEffort?: unknown; instructionSources?: unknown })
      : undefined
    const thread = reply?.thread && typeof reply.thread === 'object'
      ? (reply.thread as { id?: unknown; turns?: unknown })
      : undefined
    const threadId = typeof thread?.id === 'string' ? thread.id : ''
    // id 가 없으면 서버가 스레드를 만들었는지 알 수 없다 — 그 프로세스를 다시 쓰지 않는다.
    if (!threadId) return { ok: false, kind: 'no-id' }
    this.loaded = {
      model: typeof reply?.model === 'string' && reply.model ? reply.model : null,
      effort: typeof reply?.reasoningEffort === 'string' && reply.reasoningEffort ? reply.reasoningEffort : null,
      turns: thread?.turns
    }
    return { ok: true, threadId, turns: thread?.turns, instructionSources: reply?.instructionSources }
  }
  /** 적재 응답의 `thread.turns` 에서 되살릴 대화만 골라 낸다(모양이 다르면 빈 배열). */
  private loadedMessages(): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = []
    const turns = this.loaded?.turns
    if (!Array.isArray(turns)) return out
    for (const turn of turns) {
      const items = turn && typeof turn === 'object' && 'items' in turn ? turn.items : undefined
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'agentMessage') continue
        if (!('id' in item) || typeof item.id !== 'string' || !('text' in item) || typeof item.text !== 'string') continue
        out.push({ id: item.id, text: item.text })
      }
    }
    return out
  }
  /**
   * 이 프로세스에 실제로 넘길 argv. kordoc 사양이 있으면 `-c` 6쌍을 subcommand(`app-server`)
   * **앞에** 끼운다 — 옛 CLI 재시도(`--listen`)가 뒤에 붙어도 자리는 그대로다(§3.3).
   */
  private spawnArgs(): string[] {
    if (!this.mcpSpec) return this.serverArgs
    const at = this.serverArgs.lastIndexOf('app-server')
    if (at < 0) return [...this.serverArgs, ...codexMcpArgs(this.mcpSpec)]
    return [...this.serverArgs.slice(0, at), ...codexMcpArgs(this.mcpSpec), ...this.serverArgs.slice(at)]
  }
  /**
   * `setMcpSpec` — 다음 프로세스부터 새 인자로 뜨게 한다. **턴이 도는 중에는 바꾸지 않고**
   * 던진다(service 가 MCP 를 포기하고 대화는 계속한다). `stopped` 는 건드리지 않는다 —
   * 그 플래그는 앱 종료 뜻이고, 여기서는 rpc 만 닫아 다음 `run()` 이 재기동하게 한다(§3.3).
   */
  async setMcpSpec(spec: KordocMcpSpec | null): Promise<void> {
    if (this.turn || this.turnActive) throw new Error('턴이 진행 중이라 한글 문서 도구를 지금 붙일 수 없어요.')
    this.mcpSpec = spec
    this.verifiedOn = undefined
    this.retriedWithoutMcp = false
    this.mcpLocked = false
    if (this.rpc && !this.rpc.closed) {
      await this.rpc.stop().catch(() => {})
      this.rpc = undefined
    }
    // 인자(주입 서버)가 바뀌면 잠금 지문도 바뀐다 — 옛 계획·표를 들고 가면 안 된다.
    this.dropGuard()
  }
  /**
   * `thread/tokenUsage/updated` 알림 하나를 대화별 JSONL 한 줄로 남긴다. `last`(이번 턴)와
   * `total`(서버 누적)을 **더하지 않고** 그대로 옮기며, 숫자·식별자만 담는다.
   * 기록은 비동기·best-effort 라 대화를 막지 않는다(token-log.ts).
   */
  private recordTokenUsage(p: { threadId?: unknown; turnId?: unknown; tokenUsage?: unknown }): void {
    try {
      const usage = p.tokenUsage as
        | { last?: unknown; total?: unknown }
        | undefined
      if (!usage || typeof usage.last !== 'object' || !usage.last || typeof usage.total !== 'object' || !usage.total) return
      const conversationId = typeof p.threadId === 'string' && p.threadId ? p.threadId : this.thread ?? ''
      if (!conversationId) return
      // 턴마다 새 키 — 같은 턴의 알림 여러 개만 한 요청으로 묶고, 다음 턴은 새 요청이다.
      // (서버 턴 id 를 키로 쓰면 재연결 뒤 같은 id 가 다시 와도 이어 세게 된다.)
      const turnKey = this.turnTokens?.key ?? ''
      if (!turnKey) return
      const model = this.turnTokens?.model ?? ''
      const effort = this.turnTokens?.effort ?? null
      appendTokenRecord(this.options.root, this.free ? 'free' : 'codex', {
        conversationId, turnKey,
        build: ({ requestSequence, notificationSequence }) => tokenRecord({
          conversationId, jobId: '', company: this.free ? 'free' : 'codex', model, effort, role: 'chat'
        }, codexTokens({ last: usage.last as TokenCounts, total: usage.total as TokenCounts }, requestSequence, notificationSequence, this.free ? 'free' : 'codex'),
        new Date().toISOString())
      })
    } catch { /* 기록 실패는 대화를 막지 않는다 */ }
  }
  /**
   * 하위 담당 알림 하나를 보고 기록한다. **대화에는 아무것도 넣지 않는다** — 담당의 말·도구
   * 출력은 학생 화면의 대화로 섞이지 않고(§8), 기록·알림만 남는다.
   *
   * 근거(동봉본 스키마): `collabAgentToolCall` 은 부모 thread 의 turn item 이고
   * `tool: spawnAgent|sendInput|resumeAgent|wait|closeAgent|sendMessage|followupTask|
   * interruptAgent|listAgents`, `receiverThreadIds`·`model`·`reasoningEffort` 를 든다.
   * `subAgentActivity` 는 담당 thread 의 item 이고 `kind: started|interacted|interrupted|
   * completed`, `agentThreadId`·`model`·`reasoningEffort` 를 든다.
   */
  private observeSubagent(p: unknown): void {
    if (!p || typeof p !== 'object') return
    const threadId = 'threadId' in p && typeof p.threadId === 'string' ? p.threadId : ''
    const item = 'item' in p && p.item && typeof p.item === 'object' ? p.item : null
    if (!item) return
    const type = 'type' in item ? item.type : undefined
    const id = 'id' in item && typeof item.id === 'string' ? item.id : ''
    if (type === 'collabAgentToolCall' && 'tool' in item && item.tool === 'spawnAgent') {
      this.observeSpawn(threadId, id, item)
    } else if (type === 'subAgentActivity' && 'kind' in item && item.kind === 'started') {
      this.observeActivity(item)
    }
  }
  /**
   * spawn 호출 하나. 자식 thread id 가 아직 없으면 **보류**하고, 완료 알림에서 채워진다.
   * 알림은 spawn 이 처음 확인될 때 한 번, 기록은 id 가 확정될 때 한 번 남긴다.
   */
  private observeSpawn(threadId: string, itemId: string, item: object): void {
    const key = `${threadId}:${itemId}`
    const model = 'model' in item && typeof item.model === 'string' && item.model ? item.model : null
    const effort = 'reasoningEffort' in item && typeof item.reasoningEffort === 'string' && item.reasoningEffort ? item.reasoningEffort : null
    const raw = 'receiverThreadIds' in item && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    const receivers = raw.filter((v: unknown): v is string => typeof v === 'string' && v !== '')
    const pending = this.pendingSpawns.get(key)
    // 학생 화면에는 알리지 않는다(형님 11-13: 한도·요금 문구 빼기) — 아래 기록만 남긴다.
    // 담당의 중간 말도 대화에 넣지 않는다(§8).
    if (receivers.length === 0) {
      // 시작 알림: 아직 id 가 없다. 요청값만 붙들어 둔다.
      this.pendingSpawns.set(key, { model, effort })
      return
    }
    // 완료 알림 — 붙들어 두었던 요청값을 지우고 id 를 확정한다(없으면 넘어온 값을 쓴다).
    if (pending) this.pendingSpawns.delete(key)
    const requested = {
      model: model ?? pending?.model ?? null,
      effort: effort ?? pending?.effort ?? null
    }
    for (const thread of receivers) this.subagents.set(thread, requested)
    this.recordSubagent({ event: 'spawned', threadIds: receivers, requestedModel: requested.model, requestedEffort: requested.effort })
  }
  /** 담당의 실제 model·effort 확인(`subAgentActivity`). 같은 담당은 한 번만 기록한다. */
  private observeActivity(item: object): void {
    const thread = 'agentThreadId' in item && typeof item.agentThreadId === 'string' ? item.agentThreadId : ''
    const activityId = 'id' in item && typeof item.id === 'string' ? item.id : ''
    const key = activityId || thread
    if (!key || this.recordedActivities.has(key)) return
    this.recordedActivities.add(key)
    const requested = this.subagents.get(thread) ?? { model: null, effort: null }
    const model = 'model' in item && typeof item.model === 'string' && item.model ? item.model : null
    const effort = 'reasoningEffort' in item && typeof item.reasoningEffort === 'string' && item.reasoningEffort ? item.reasoningEffort : null
    this.recordSubagent({ event: 'resolved', threadIds: [thread], requestedModel: requested.model, requestedEffort: requested.effort, actualModel: model ?? 'unverified', actualEffort: effort })
  }
  /**
   * `audit/model-routing/` 에 한 줄 남긴다 — 스킬의 담당 기록 계약(model-routing.md)과 같은
   * 자리다. JobRunner 도 같은 폴더에 쓴다. **던지지 않는다** — 기록을 못 남겼다고 대화가
   * 멈추면 학생은 이유도 모른 채 답을 잃는다.
   */
  private recordSubagent(data: { event: 'spawned' | 'resolved' } & Record<string, unknown>): void {
    try {
      const dir = join(this.options.root, 'audit', 'model-routing')
      mkdirSync(dir, { recursive: true })
      const name = `subagent-${randomUUID()}.json`
      writeFileAtomic(join(dir, name), JSON.stringify({
        type: `subagent-${data.event}`, provider: this.free ? 'free' : 'codex', at: new Date().toISOString(), ...data
      }))
    } catch { /* 기록 자리는 최선 노력 — 대화 흐름을 막지 않는다 */ }
  }
  private async connect(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new Error('Codex 연결이 중단됐어요.')
    /**
     * **초기화가 끝난 연결만** 돌려준다. `open()` 은 initialize 응답을 기다리기 전에
     * `this.rpc` 를 넣으므로, 그 값을 먼저 돌려주면 그 사이에 나간 요청(모델 목록 등)이
     * 서버에서 `Not initialized` 로 거절된다(검토 MC1-02). 진행 중인 한 번을 함께 기다린다 —
     * 동시에 부른 쪽이 각자 프로세스를 띄우는 것도 같은 자리에서 막힌다.
     */
    const inflight = this.connecting
    if (inflight) return inflight
    if (this.rpc && !this.rpc.closed) return this.rpc
    return (this.connecting = this.open().finally(() => { this.connecting = undefined }))
  }
  private connecting?: Promise<JsonRpcProcess>
  private async open(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new Error('Codex 연결이 중단됐어요.')
    if (this.rpc && !this.rpc.closed) return this.rpc
    // 인자는 Codex CLI 쪽 사정이라 고정할 수 없다. 최신 CLI 의 `app-server` 에는
    // --listen 이 없어서(0.155 에서 확인) 그 인자로 띄우면 아무 말 없이 즉시 끝난다.
    // 구버전에는 필요했으므로 평문을 먼저 쓰고 실패하면 옛 인자로 한 번 더 시도한다.
    const rpc = this.rpc = new JsonRpcProcess(this.options.binary, this.spawnArgs(), this.options.root,
      { ...this.options.env, ...(this.mcpSpec ? codexMcpEnv(this.mcpSpec) : {}) })
    // 새 프로세스에는 진행 중 호출이 없다 — 이전 프로세스의 표를 물려받지 않는다.
    this.mcpCalls.clear()
    rpc.onNotification = (method, p) => {
      if (method === 'account/login/completed' && this.loginPending && typeof p?.loginId === 'string') {
        if (!this.loginInfo) this.earlyLogin = { id: p.loginId, success: p.success === true }
        else if (p.loginId === this.loginInfo.id) {
          this.loginPending = false
          this.loginConfirmed = p.success === true
        }
      }
      // 하위 담당은 **다른 thread** 에서 온다 — 아래 thread 거르기 전에 본다. 이 알림은
      // 대화에 섞지 않고 기록·알림으로만 남긴다(§3.2 Codex, §5-7, §8).
      if (method === 'item/started' || method === 'item/completed') this.observeSubagent(p)
      if (p?.threadId && p.threadId !== this.thread) return
      if (this.free && this.waiter && method === 'item/completed') {
        const item = p.item
        if (item?.type === 'agentMessage') {
          this.freeAnswered = typeof item.text === 'string' && item.text.trim() !== '' &&
            (item.phase == null || item.phase === 'final_answer')
        } else {
          // 0.164.0 ThreadItem의 도구/작업 항목. reasoning·plan 등은 답을 무효화하지 않는다.
          switch (item?.type) {
            case 'commandExecution': case 'fileChange': case 'mcpToolCall':
            case 'dynamicToolCall': case 'collabAgentToolCall': case 'functionCallOutput':
            case 'webSearch': case 'imageView': case 'imageGeneration': case 'sleep':
            case 'contextCompaction':
              this.freeAnswered = false
          }
        }
      }
      if ((method === 'item/started' || method === 'item/completed') && p.item?.type === 'mcpToolCall') this.observeMcpCall(method, p)
      if (method === 'item/started' && p.item?.type === 'fileChange') {
        this.rememberFileChanges(fileChangeKey(p.threadId, p.turnId, p.item.id), p.item.changes)
      } else if (method === 'item/fileChange/patchUpdated') {
        this.rememberFileChanges(fileChangeKey(p.threadId, p.turnId, p.itemId), p.changes)
      } else if (method === 'item/completed' && p.item?.type === 'fileChange') {
        const key = fileChangeKey(p.threadId, p.turnId, p.item.id)
        this.rememberFileChanges(key, undefined)
      } else if (method === 'item/completed' && p.item?.type === 'commandExecution') {
        // 정본 등록 거절은 도우미의 셸 출력으로만 돌아오고 지금까지 어디에도 남지 않았다
        // (윈도우 W-08). 출력에서 거절 결과를 찾아 한 줄 남긴다 — 학생 화면은 그대로다.
        const record = applyRejection({
          provider: 'codex', command: p.item.command, output: p.item.aggregatedOutput, exitCode: p.item.exitCode
        })
        if (record) recordRejection(join(this.options.root, '.knuaf-gui', 'apply-reject.log'), record)
      } else if (method === 'thread/tokenUsage/updated') {
        // 캐시 토큰(cachedInputTokens·cacheWriteInputTokens)을 대화별로 기록만 한다 — 동작 불변.
        // last 는 이번 턴, total 은 서버가 준 누적이다. 앱이 더하지 않고 그대로 옮긴다.
        this.recordTokenUsage(p)
      }
      if (method === 'item/agentMessage/delta') {
        const text = (this.messages.get(p.itemId) ?? '') + p.delta
        this.messages.set(p.itemId, text); this.events?.message(p.itemId, text)
      } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        this.events?.message(p.item.id, p.item.text)
      } else if (method === 'turn/started') this.turn = p.turn.id
      else if (method === 'turn/completed') {
        this.fileChanges.clear(); this.pendingFileApprovals.clear(); this.mcpCalls.clear()
        const w = this.waiter; this.waiter = undefined; this.turn = undefined
        if (p.turn.status === 'completed') {
          if (this.free && !this.freeAnswered) w?.reject(new FreeRelayError('free-no-answer'))
          else w?.resolve()
        }
        else if (this.free) w?.reject(freeRelayError(p.turn.error))
        else if (p.turn.error?.codexErrorInfo === 'unauthorized') w?.reject(new CodexAuthenticationError('ChatGPT 인증이 거절됐어요.'))
        // 한도는 **구조 코드** `usageLimitExceeded` 만 인정한다(설계 §1-2, p1X 11-11).
        // `rateLimitExceeded` 는 한도가 아니라 `unknown` 이다 — 단추를 덜 띄우는 방향.
        else if (p.turn.error?.codexErrorInfo === 'usageLimitExceeded') {
          w?.reject(new MainTurnUsageError('limit',
            { company: 'codex', model: this.turnChoice.model, effort: this.turnChoice.effort, how: 'main' },
            p.turn.error?.message ?? '작업이 중단됐어요. 저장된 대화에서 이어갈 수 있어요.'))
        } else {
          w?.reject(new MainTurnUsageError('unknown',
            { company: 'codex', model: this.turnChoice.model, effort: this.turnChoice.effort, how: 'main' },
            p.turn.error?.message ?? '작업이 중단됐어요. 저장된 대화에서 이어갈 수 있어요.'))
        }
      }
    }
    rpc.onRequest = (id, method, p) => {
      if (method === 'item/commandExecution/requestApproval') {
        this.approvals.set(String(id), id)
        // 명령과 이유를 모두 보존한다. 명령 카드의 기존 표시와 승인 동작은 그대로다.
        const detail = [p.command, p.reason].filter((v: unknown): v is string => typeof v === 'string' && v.trim() !== '').join('\n\n')
        this.events?.permission({ id: String(id), title: '명령 실행 확인', detail: detail || JSON.stringify(p) })
      } else if (method === 'item/fileChange/requestApproval') {
        const requestId = String(id)
        this.approvals.set(requestId, id)
        const key = fileChangeKey(p?.threadId, p?.turnId, p?.itemId)
        if (key) this.pendingFileApprovals.set(requestId, { key, reason: p.reason })
        this.events?.permission(filePermission(requestId, p?.reason, key ? this.fileChanges.get(key) : undefined))
      } else if (method === 'item/tool/requestUserInput') {
        // The unmodified interview contract requires chat text, not tool popups.
        rpc.send({ id, result: { answers: {} } })
      } else if (method === 'mcpServer/elicitation/request') {
        // Codex 0.169 mcp_tool_call.rs: tool approval is a form with an empty object
        // schema and codex_approval_kind=mcp_tool_call. Never accept arbitrary MCP forms.
        // 승인 대상은 `_meta` 가 아니라 같은 턴의 진행 중 `mcpToolCall` 에서 특정한다(0.164.0 실물).
        const verdict = this.mcpApprovalVerdict(rpc, p ?? {})
        // 개수만 남긴다 — 미지 키의 **이름**에도 자유문·경로가 실릴 수 있어 이름 자체를 쓰지 않는다.
        const metaKeys = Object.keys(plainObject(p?._meta) ?? {})
        const unknownKeys = metaKeys.filter((key) => !KNOWN_META_KEYS.includes(key)).length
        diag(`codex-mcp-approval verdict=${verdict.allow ? 'accept' : 'decline'} reason=${verdict.reason}`
          + ` meta_key_count=${metaKeys.length} unknown_key_count=${unknownKeys}`)
        // One call only: no persist/session metadata and no student-config writes.
        rpc.send({ id, result: { action: verdict.allow ? 'accept' : 'decline', content: null, _meta: null } })
      } else if (method === 'item/permissions/requestApproval') {
        rpc.send({ id, result: { permissions: { network: null, fileSystem: null }, scope: 'turn' } })
      } else {
        // Method only: request parameters may contain student text, paths or secrets.
        diag(`codex-request unsupported method=${JSON.stringify(method.slice(0, 160))}`)
        rpc.send({ id, error: { code: -32601, message: '이 요청은 GUI에서 지원하지 않습니다. 질문은 채팅 텍스트로 제시하세요.' } })
      }
    }
    rpc.onClose = () => { this.waiter?.reject(new Error('Codex 연결이 종료됐어요. 답변은 자동 재전송하지 않아요.')); this.waiter = undefined }
    let init: { userAgent?: string } | undefined
    try {
      init = await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.7.0' }, capabilities: { experimentalApi: true } })
    } catch (e) {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      if (this.stopped) throw e
      if (!this.serverArgs.includes('--listen')) {
        // 평문이 안 되면 옛 인자로 한 번 더. 다음 connect() 부터는 그 인자를 쓴다.
        this.serverArgs = [...this.serverArgs, '--listen', 'stdio://']
        this.dropGuard()
        return this.open()
      }
      // 원인을 지어내지 않는다. 전에는 버전이 낮다고 단정했는데, 실제로는 CLI 가 새로워
      // 인자가 바뀐 경우였고 사용자를 엉뚱한 업데이트로 보냈다.
      const detail = [(e as Error)?.message, rpc.lastStderr].filter(Boolean).join(' / ')
      throw new Error('Codex와 연결하지 못했어요.' + (detail ? ` (${detail})` : ''))
    }
    // The server answers with a userAgent like "knuaf_dev_gui/0.133.0 (Mac OS …)": first token after '/' is the Codex version.
    const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
    this.serverVersion = /^[^/\s]+\/([^\s]+)/.exec(ua)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(ua)?.[1] ?? null
    rpc.send({ method: 'initialized', params: {} })
    return rpc
  }
  /** `item/started`/`item/completed` 의 `mcpToolCall` 한 건 — 진행 중 표에 넣거나 지운다. */
  private observeMcpCall(method: string, p: Record<string, unknown>): void {
    const item = plainObject(p.item)
    if (!item || item.type !== 'mcpToolCall') return
    const key = fileChangeKey(p.threadId, p.turnId, item.id)
    if (!key) return
    if (method === 'item/completed') { this.mcpCalls.delete(key); return }
    if (typeof item.server !== 'string' || typeof item.tool !== 'string') { this.mcpCalls.delete(key); return }
    this.mcpCalls.set(key, {
      thread: p.threadId as string, turn: p.turnId as string,
      server: item.server, tool: item.tool, args: item.arguments
    })
  }
  /**
   * MCP 도구 승인 요청(`mcpServer/elicitation/request`)의 판정.
   *
   * 동봉 Codex 0.164.0 의 `_meta` 키는 `codex_approval_kind`·`persist`·`tool_description`·
   * `tool_params`·`tool_params_display` 다섯 개뿐이고 **`tool_name` 이 없다**(실기기
   * `probe-run4.log` 62행). 도구 이름은 같은 턴의 `item/started` 안 `mcpToolCall.tool` 에만 있으므로,
   * 승인 대상은 그 표에서 **같은 턴·서버·인자로 하나만 특정되는** 호출이다. 0건이거나 2건 이상이면
   * 거절한다 — 표시 문구(`message`)는 모델이 쓴 글이라 근거로 쓰지 않는다(검토 g2-4).
   */
  private mcpApprovalVerdict(rpc: JsonRpcProcess, p: Record<string, unknown>): { allow: boolean; reason: string } {
    const no = (reason: string) => ({ allow: false, reason })
    if (this.rpc !== rpc || this.verifiedOn !== rpc || rpc.closed || !this.mcpSpec) return no('not-verified')
    if (!this.turnActive || typeof this.turn !== 'string' || !this.turn) return no('no-active-turn')
    if (p.threadId !== this.thread) return no('wrong-thread')
    if (p.turnId !== this.turn) return no('wrong-turn')
    if (p.serverName !== MCP_SERVER_NAME) return no('wrong-server')
    if (p.mode !== 'form') return no('mode')
    if (typeof p.message !== 'string') return no('message')
    // 승인 폼은 **빈 객체 스키마**뿐이다 — 그 밖의 폼은 학생 입력을 요구하는 다른 흐름이다.
    const schema = plainObject(p.requestedSchema)
    if (!schema || schema.type !== 'object' || !plainObject(schema.properties)) return no('schema')
    if (Object.keys(schema.properties as object).length !== 0) return no('schema')
    if (!Object.keys(schema).every((key) => key === 'type' || key === 'properties')) return no('schema')
    const meta = plainObject(p._meta)
    if (!meta) return no('meta')
    if (meta.codex_approval_kind !== 'mcp_tool_call') return no('kind')
    if (meta.codex_requires_user_input === true || meta.codex_sensitive_action === true) return no('risk-flag')
    const params = plainObject(meta.tool_params)
    if (!params) return no('no-params')
    // 이름이 있으면 **키가 있는지**와 **값이 맞는지**를 나눈다: 키가 없으면 생략(실물 0.164.0),
    // 키가 있는데 빈 문자열·비문자열이면 불일치다 — 생략으로 봐 주면 이름 위조가 통한다.
    const hasName = Object.hasOwn(meta, 'tool_name')
    const named = typeof meta.tool_name === 'string' && meta.tool_name !== '' ? meta.tool_name : undefined
    if (hasName && !named) return no('bad-name')
    // 이름으로 후보를 **먼저** 줄이지 않는다 — 같은 인자의 다른 도구 두 건이 이름 하나로 1건이 되면
    // 어느 호출을 승인하는지 정해지지 않은 채 정책만 통과한다(검토 차단 1).
    const matches = [...this.mcpCalls.values()].filter((call) => call.thread === p.threadId && call.turn === p.turnId
      && call.server === p.serverName && sameJson(call.args, params))
    if (matches.length === 0) return no('no-call')
    if (matches.length > 1) return no('ambiguous-call')
    const call = matches[0]
    if (named && call.tool !== named) return no('name-mismatch')
    const verdict = mcpPolicy(this.options.root, MCP_TOOL_PREFIX + call.tool, params)
    if (verdict?.behavior !== 'allow') return no(verdict ? 'policy' : 'not-mcp')
    return { allow: true, reason: named ? 'call+named' : 'call' }
  }
  private rememberFileChanges(key: string | undefined, raw: unknown): void {
    if (!key) return
    const changes = readFileChanges(raw)
    if (changes) this.fileChanges.set(key, changes)
    else this.fileChanges.delete(key)
    for (const [id, pending] of this.pendingFileApprovals) {
      if (pending.key === key) this.events?.permission(filePermission(id, pending.reason, changes))
    }
  }
  async status() {
    if (this.free) return freeStatus()
    const rpc = await this.connect()
    const r = await rpc.request('account/read', { refreshToken: false })
    const connected = !this.loginPending && r.account?.type === 'chatgpt' && (!this.loginInfo || this.loginConfirmed)
    return { installed: true, connected, version: this.serverVersion, probe: 'ok' as const, detail: connected ? '' : 'ChatGPT 로그인이 필요해요. API 계정으로 자동 전환하지 않아요.' }
  }
  /**
   * 이 계정이 쓸 수 있는 모델(`model/list`). 요금제마다 목록이 다르므로 앱에 박아 두지 않고
   * 계정에 묻는다 — 목록에 없는 모델은 추천에서도 칩에서도 빠진다.
   *
   * `hidden` 은 기본 고르기 목록에서 숨긴 모델이라 뺀다. `model`(턴에 넣는 값)이 비어 있는
   * 응답은 건너뛴다. 쪽이 남아 있으면 이어 받는다(서버가 한 번에 다 안 줄 수 있다).
   *
   * **다른 공급자로 우회되는 모델도 뺀다**(DQA-01). 로컬 중계(opencodex)를 거치는 CLI 는
   * 이 계정이 쓸 수 없는 남의 회사 모델까지 `<공급자>/…` id 로 같이 내놓는다(실측 92개 중
   * 다수). 칩 목록·추천·전송이 모두 이 목록에서 나오므로 여기서 한 번 거르면 셋 다 막힌다.
   * 실계정 목록은 미확인이다 — 이번 판 시험은 가짜 서버로만 돈다.
   */
  async models(): Promise<ChatModelInfo[]> {
    if (this.free) return FREE_MODELS
    const rpc = await this.connect()
    const out: ChatModelInfo[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    // 서버가 끝나지 않는 쪽을 계속 주는 경우에도 화면이 멈추지 않게 상한을 둔다.
    for (let page = 0; page < 20; page++) {
      const r = await rpc.request('model/list', cursor ? { limit: 100, cursor } : { limit: 100 })
      const data: unknown[] = Array.isArray(r?.data) ? r.data : []
      for (const raw of data) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        if (m.hidden === true) continue
        const model = typeof m.model === 'string' && m.model ? m.model : typeof m.id === 'string' ? m.id : ''
        if (!model || isCrossProviderModelId(model) || seen.has(model)) continue
        seen.add(model)
        const efforts = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts
            .map((e) => (e && typeof e === 'object' && 'reasoningEffort' in e ? e.reasoningEffort : undefined))
            .filter((e): e is string => typeof e === 'string' && e !== '')
          : []
        out.push({
          model,
          name: typeof m.displayName === 'string' && m.displayName ? m.displayName : model,
          description: typeof m.description === 'string' ? m.description : '',
          efforts,
          defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
          isDefault: m.isDefault === true
        })
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null
      if (!cursor) break
    }
    this.catalog = out
    return out
  }
  async login() {
    if (this.free) { if (!freeStatus().connected) throw new FreeRelayError('free-unavailable'); return }
    this.loginPending = true
    this.loginConfirmed = false
    this.loginInfo = undefined
    this.earlyLogin = undefined
    let r: { loginId?: unknown; authUrl?: unknown }
    try { r = await (await this.connect()).request('account/login/start', { type: 'chatgpt' }) }
    catch (error) { this.loginPending = false; throw error }
    this.loginInfo = { id: typeof r.loginId === 'string' ? r.loginId : '', url: typeof r.authUrl === 'string' ? r.authUrl : '' }
    const early = this.earlyLogin as { id: string; success: boolean } | undefined
    if (early?.id === this.loginInfo.id) {
      this.loginPending = false
      this.loginConfirmed = early.success
    }
    this.earlyLogin = undefined
    // 브라우저를 못 열었다고 로그인 자체를 실패로 만들지 않는다. 서버 쪽 로그인은 이미
    // 시작됐고, 학생에게는 "브라우저 다시 열기"가 있다. 여기서 던지면 화면이 '확인 실패'가
    // 되어 방금 시작한 로그인을 취소한 것처럼 보인다(실제로 그 문구가 떴다 —
    // openExternal('about:blank') 이 거절하는 환경에서 e2e 가 잡았다).
    if (this.loginInfo.url) { try { await this.options.openExternal(this.loginInfo.url) } catch { /* 다시 열기로 재시도할 수 있다 */ } }
  }
  /** 브라우저를 닫아 버린 학생을 위해 같은 주소를 다시 연다. */
  async reopenLogin() {
    if (!this.loginInfo?.url) throw new Error('다시 열 로그인 주소가 없어요. 로그인을 다시 시작해 주세요.')
    await this.options.openExternal(this.loginInfo.url)
  }
  /**
   * 취소는 app-server 의 `account/login/cancel` 이다(0.162.1 실측: `{ loginId }` 를 요구하고,
   * 빠지면 `Invalid request: missing field \`loginId\`` 를 돌려준다). 이어서 프로세스도 닫는다 —
   * 옛 CLI 에 그 메서드가 없을 수 있고, 남은 프로세스가 로그인을 계속 물고 있으면
   * 취소가 화면에서만 일어난 것처럼 보인다. ChatService 는 취소 뒤 이 연결을 버리므로
   * 다음 확인이 새 프로세스로 상태를 다시 묻는다.
   */
  async cancelLogin() {
    const rpc = this.rpc
    const loginId = this.loginInfo?.id
    this.loginInfo = undefined
    this.loginPending = false
    this.loginConfirmed = false
    if (rpc && !rpc.closed && loginId) {
      try { await rpc.request('account/login/cancel', { loginId }) } catch { /* 옛 CLI: 메서드가 없으면 프로세스를 닫아 취소한다 */ }
    }
    await this.stop()
  }
  private loginInfo?: { id: string; url: string }
  /** MCP 검증 실패 뒤 같은 텍스트로 한 번만 다시 돌기 위한 표식 — 재귀를 막는다(E8). */
  private retriedWithoutMcp = false
  /**
   * 재시도 턴에서 kordoc MCP 를 **끈 채로** 돌린다는 표식(검토 M2-R1-01).
   * 실패한 프로세스를 닫고 인자 없이 새로 띄우면, 학생 사용자 층(`~/.codex/config.toml`)에
   * 같은 이름의 서버가 있으면 그것이 **검증 없이 되살아난다**(Roh 실측). 그래서 재시도부터는
   * 스레드 `config` 로 그 이름을 끄고, 끈 사실을 턴 앞에서 확인한다.
   */
  private mcpLocked = false
  /**
   * 한 턴. kordoc 기동 검증(§3.3)이 실패하면 `McpSafetyError` 가 올라오므로 여기서 받아
   * **MCP만 끄고** 같은 텍스트로 한 번 더 돈다. `service.ts` 는 이 예외를 모르고(일반 오류로
   * 처리해 대화를 error 로 남긴다) 연결 객체를 버리는 처분도 하지 않으므로, 같은 처분을
   * 연결 안에서 한다 — 실패한 rpc 를 닫고 spec 을 비우면 다음 `runTurn` 이 MCP 없이 뜬다.
   * 인자를 빼는 것만으로는 부족하므로 잠금 표식을 함께 세운다(아래 `mcpLocked`).
   */
  async run(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory = false) {
    try {
      return await this.runTurn(text, sessionId, events, replayHistory)
    } catch (e) {
      if (!(e instanceof McpSafetyError)) throw e
      this.mcpSpec = null
      this.verifiedOn = undefined
      this.mcpLocked = true
      await this.rpc?.stop().catch(() => {})
      this.rpc = undefined
      // 프로세스가 바뀐다 — 표·계획·적재 응답은 다시 세운다. 재시도는 잠금 없이(=학생 층
      // 이름 전부를 끈 계획으로) 새 프로세스에서 다시 열린다.
      this.dropGuard()
      // 재시도가 없으면 안내도 없다 — 대화는 error 로 남고 그 문장이 오해를 부른다.
      if (this.retriedWithoutMcp) throw e
      events.note('안전 검사를 통과하지 못해 한글 문서 도구를 끄고 진행해요')
      this.retriedWithoutMcp = true
      // 검증 실패는 `turn/start` 앞이라 그 대화에는 아무 턴도 없다 — 같은 입력으로 새 프로세스에서
      // 다시 시작한다(새 대화면 빈 thread 하나가 남지만 학생 기록에는 아무것도 안 남는다).
      return this.runTurn(text, sessionId, events, replayHistory)
    }
  }
  /**
   * 재시도 턴의 스레드 `config` — kordoc 을 끈다. **설정에 그 이름이 실제로 보일 때만** 싣는다:
   * `-c`/config 의 부분 표기는 그 이름의 표를 통째로 갈아 끼우므로, 어느 층에도 없는 이름을
   * 부르면 기동이 `invalid transport` 로 죽는다(실측 j-names `t-ghost-partial`). 빈 `{}` 도
   * 아무것도 지우지 않으므로(실측 `t-empty-servers`) 이름이 없으면 키 자체를 넣지 않는다.
   * 다른 이름의 MCP(foreign)는 설계 §3.3대로 건드리지 않는다 — 이 잠금은 kordoc 하나다.
   */
  private async mcpLockParams(rpc: JsonRpcProcess): Promise<{ config?: { mcp_servers: Record<string, { enabled: false }> }; locked: string[] }> {
    if (!this.mcpLocked) return { locked: [] }
    let merged: unknown
    try {
      // `cwd` 를 줘야 프로젝트 층까지 병합된, 스레드가 실제로 받는 그 설정이 온다.
      merged = await rpc.request('config/read', { cwd: this.options.root })
    } catch (e) {
      throw new McpSafetyError(`재시도 턴에서 한글 문서 도구 설정을 읽지 못했어요: ${(e as Error)?.message ?? String(e)}`, 'retry-config-read')
    }
    const servers = (merged as { config?: { mcp_servers?: unknown } } | undefined)?.config?.mcp_servers
    const present = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : []
    if (!present.includes(MCP_SERVER_NAME)) {
      // 설정 어디에도 kordoc 이 없다 = 새 프로세스가 그 서버를 띄울 수 없다. 잠글 것도, 확인할 것도 없다.
      return { locked: [] }
    }
    return { config: { mcp_servers: { [MCP_SERVER_NAME]: { enabled: false } } }, locked: [MCP_SERVER_NAME] }
  }
  /** 한 턴 전체(기동 검증·턴 시작·완료 대기)를 "진행 중"으로 표시하고 본문을 돈다(M2-R1-02). */
  private async runTurn(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory = false) {
    this.turnActive = true
    try { return await this.turnBody(text, sessionId, events, replayHistory) }
    catch (error) { throw this.free && !(error instanceof FreeRelayError) ? freeRelayError(error) : error }
    finally { this.turnActive = false }
  }
  private async turnBody(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory = false) {
    let rpc = await this.connect()
    if (!(await this.status()).connected) throw new Error('Codex에서 ChatGPT 계정 로그인을 먼저 완료해 주세요.')
    this.events = events
    const skillPath = join(this.options.skill, 'SKILL.md')
    // Codex 는 스킬 경로를 realpath 로 보고한다. 앱이 쥔 경로는 학생이 고른 그대로다.
    // 심링크를 하나라도 지나면 문자열 비교가 어긋나 "스킬을 찾지 못했어요" 로 막힌다.
    // macOS 에서 iCloud 데스크톱을 켜면 ~/Desktop 이 심링크가 되므로 드문 경우가 아니다
    // (임시 폴더 /var → /private/var 가 live 스모크에서 이걸 먼저 드러냈다).
    const want = realOrSelf(skillPath)
    const skills = await rpc.request('skills/list', { cwds: [this.options.root], forceReload: true })
    if (!skills.data?.some((entry: any) => entry.skills?.some((s: any) => realOrSelf(s.path) === want && s.enabled))) throw new Error('Codex가 프로젝트의 knuaf-dev 스킬을 찾지 못했어요.')
    events.skill()
    const args = { cwd: this.options.root, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: '이 세션은 knuaf-dev 개인용 GUI입니다. 제공된 knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 같은 이름의 사용자·전역 스킬 사본이 보여도 무시하고 이 프로젝트의 스킬만 따르세요. 질문은 채팅 텍스트로 제시하세요. 인터뷰 원문과 해석은 스킬의 로그 계약대로 기록하세요. GUI의 첨부는 사용자 답변의 일부이며 현재 작성물 채택은 스킬의 확인 절차를 따르세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). ' + (this.mcpSpec ? MCP_DOC_READ_INSTRUCTION : LEGACY_DOC_READ_INSTRUCTION) }
    const guard = this.guard
    if (guard) {
      // 열거는 **스레드 앞**(§4.1-C 1번) — 계획의 `config` 가 이 턴의 잠금 전부다.
      const plan = await this.lockPlan(rpc)
      this.plan = plan
      const acquired = await guard.acquire({ sessionId, fingerprint: plan.fingerprint, transport: this.loadTransport(args) })
      if (!acquired.ok) throw new Error(acquired.studentCopy)
      // 재기동을 거쳤으면 위 `rpc` 는 죽은 프로세스다 — 이어 쓸 연결을 다시 잡는다.
      rpc = await this.connect()
      if (acquired.switched) events.note(acquired.switched.notice)
      this.thread = acquired.threadId; events.session(acquired.threadId)
      // 앱이 붙인 kordoc 은 잠금 대상이 아니라 **검증 대상**이다(§4.1-D ②). 실패하면
      // `McpSafetyError` 로 올라가 MCP 를 끄고 같은 텍스트를 다시 돈다 — 종전 경로 그대로.
      if (this.mcpSpec && plan.kordocAttached) {
        await verifyCodexKordoc(rpc, { threadId: acquired.threadId, root: this.options.root, spec: this.mcpSpec })
        this.verifiedOn = rpc
      }
      if (this.mcpLocked) await verifyKordocAbsent(rpc, { threadId: acquired.threadId, names: plan.lockedNames })
      this.threadModel = this.loaded?.model ?? null
      this.threadEffort = this.loaded?.effort ?? null
      if (!sessionId) { this.overridden = false; this.resumeChecked = false }
      if (replayHistory) for (const m of this.loadedMessages()) events.message(m.id, m.text)
    } else {
      const { config: lockConfig, locked } = await this.mcpLockParams(rpc)
      const r = sessionId ? await rpc.request('thread/resume', { ...args, ...(lockConfig ? { config: lockConfig } : {}), threadId: sessionId }) : await rpc.request('thread/start', { ...args, ...(lockConfig ? { config: lockConfig } : {}) })
      const threadId: string = r.thread.id
      this.thread = threadId; events.session(threadId)
      // Codex 쪽 승인 정책의 전부는 이 검증이다(§3.3) — 프로세스당 1회, `turn/start` 앞.
      // 하나라도 못 채우면 `McpSafetyError` 로 올려 보내 MCP 를 끄고 같은 텍스트를 다시 돈다.
      if (this.mcpSpec && this.verifiedOn !== rpc) {
        await verifyCodexKordoc(rpc, { threadId, root: this.options.root, spec: this.mcpSpec })
        this.verifiedOn = rpc
      }
      // 재시도 폴백의 관문(M2-R1-01): 스레드 config 로 끈 kordoc 이 **실제로 꺼졌는지** 턴 앞에서
      // 확인한다. 스레드 config 는 서버가 스레드를 처음 적재할 때만 먹으므로(f 실측) 요청의 성공은
      // 증거가 아니다 — 상태 목록이 유일한 판정 근거다. 확인 못 하면 턴을 열지 않는다(재시도 없음).
      if (this.mcpLocked) await verifyKordocAbsent(rpc, { threadId, names: locked })
      this.threadModel = typeof r.model === 'string' && r.model ? r.model : null
      this.threadEffort = typeof r.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null
      if (!sessionId) { this.overridden = false; this.resumeChecked = false }
      // Replayed turns use a different id space (item-N) than the live stream (msg_*), so
      // id-dedup cannot catch them — replay only when the app snapshot has no assistant
      // history at all (e.g. snapshot file lost while the server thread survived).
      if (replayHistory) for (const turn of r.thread.turns ?? []) for (const item of turn.items ?? []) if (item.type === 'agentMessage') events.message(item.id, item.text)
    }
    this.messages.clear()
    // 첫 턴에는 논문 작업 폴더 경계와 스킬 생성 폴더 허용을 명시한다.
    const prompt = sessionId ? text : `${text}\n\n${workFolderInstructions(this.options.root)}`
    /**
     * 학생이 고른 모델·생각 깊이. `turn/start` 의 model/effort 는 **이 턴과 그 뒤 턴에**
     * 적용되므로(turnStartParams: "this turn and subsequent turns") 같은 대화의 맥락이
     * 끊기지 않는다. 다만 그래서 **생략은 "기본값으로 돌아가기"가 아니다** — 예전에 보낸
     * Sol/high 가 그대로 남는다. 고른 적이 없으면 지금처럼 키를 넣지 않고, 해제했다면
     * 서버가 새 대화에 쓰는 기본값을 명시적으로 다시 보낸다(검토 MC1-01).
     */
    const turnModel = await this.turnModelParams(!!sessionId)
    // 실패 당시 출처는 **이 턴이 실제로 실어 보낸** 값이다(설계 §1-3 ②). 거절은
    // `connect()` 의 `turn/completed` 에서 오므로 여기에 남긴다.
    this.turnChoice = { model: turnModel.params.model ?? null, effort: turnModel.params.effort ?? null }
    /**
     * 기록에 남길 **실제 적용값**(검토 CT-02). `thread/start` 응답은 이전 값이고, 학생이 이 턴에
     * 고른 model·effort 는 `turn/start` 에 실려 나간다 — 보낸 값이 있으면 그 값이 이 턴에 적용된다.
     * 없으면 이 대화가 지금 쓰는 값(thread 응답)이다.
     *
     * `turnChoice`(위)와 값이 겹쳐 보이지만 쓰임이 다르다 — `turnChoice` 는 **실패 안내에 실을
     * 회사·모델**이고 여기 없는 thread/env 기본값을 뒤지지 않는다(그 턴이 실제로 보낸 것만).
     * `turnTokens` 는 **토큰 원장에 남길 적용값**이라 보낸 값이 없을 때 대화 기본값으로 내려간다.
     */
    this.turnTokens = {
      key: randomUUID(),
      model: turnModel.params.model ?? this.threadModel ?? this.options.env.KNUAF_CODEX_MODEL ?? '',
      effort: turnModel.params.effort ?? this.threadEffort ?? this.options.env.KNUAF_CODEX_EFFORT ?? null
    }
    this.freeAnswered = false
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', {
        threadId: this.thread,
        input: [{ type: 'text', text: prompt, text_elements: [] }, { type: 'skill', name: SKILL_NAME, path: skillPath }],
        ...turnModel.params
      }).then(r => {
        // 원장 기록은 첫 알림보다 **먼저** — 턴 id 를 받은 즉시(§4.1-C ⑨).
        if (this.guard && this.plan) this.guard.noteTurn(this.thread ?? '', r.turn.id, this.plan.fingerprint)
        this.turn = r.turn.id
        // 되돌리기를 실제로 보낸 턴이 시작됐을 때만 "더 되돌릴 것이 없다"로 바꾼다.
        // 턴이 실패했는데 false 로 두면 다음 턴이 생략되어 예전 덮어쓰기가 남는다.
        if (turnModel.clears) this.overridden = false
      }).catch(e => { this.waiter = undefined; reject(e) })
    })
  }
  /**
   * 이 턴에 실을 model·effort. 네 경우를 구분한다.
   * 1. 고른 모델이 있다 → 그 모델 + (고른 깊이 또는 그 모델의 기본 깊이).
   * 2. 고른 적이 없고 이 대화에 덮어쓴 적도 없다 → 아무 키도 넣지 않는다(지금까지와 같은 요청).
   * 3. 이 앱이 덮어쓴 뒤 해제했다 → 서버 기본값을 **명시적으로** 보내 되돌린다.
   * 4. 앱을 다시 켜서 재개했고 선택이 없다 → 그 대화가 기본값과 다른지 한 번 보고, 다르면 3과 같다.
   *
   * 기본값은 `model/list` 의 isDefault 나 CLI 설정을 **추측하지 않는다** — 서버에 새 대화를
   * 하나 물어(ephemeral) 실제로 쓸 model·effort 를 받아 그대로 보낸다.
   *
   * **이 공급자로 모델을 고른 적이 없는 학생은 3·4 를 하지 않는다**(검토 L-02). 덮어쓴 적이
   * 없으니 되돌릴 것도 없고, 요청은 첫 발주서 그대로 model·effort 키 없이 나간다 — 실서버에서
   * 아직 검증하지 않은 조회도 하지 않는다.
   */
  private async turnModelParams(resumed: boolean): Promise<{ params: { model?: string; effort?: string }; clears: boolean }> {
    if (this.free) {
      const choice = this.options.modelChoice?.()
      const model = choice?.model ?? FREE_DS_MODEL
      if (!FREE_MODELS.some(entry => entry.model === model)) throw new FreeRelayError('free-error')
      return { params: { model }, clears: false }
    }
    const choice = this.options.modelChoice?.() ?? null
    if (choice?.model && isCrossProviderModelId(choice.model)) throw new Error(MODEL_SELECTION_COPY.reselectionRequired)
    if (choice?.model) {
      this.overridden = true
      const effort = choice.effort ?? await this.defaultEffortOf(choice.model)
      return { params: { model: choice.model, ...(effort ? { effort } : {}) }, clears: false }
    }
    if (!this.everChosen) return { params: {}, clears: false }
    if (!this.overridden && resumed && !this.resumeChecked) {
      const base = await this.serverDefaultsOrFail()
      // **성공했을 때만** 확인을 마쳤다고 표시한다. 실패를 확인 완료로 치면 다음 메시지에서
      // 다시 묻지 않고, 선택 없음인데 이전 모델로 계속 보내게 된다(검토 MC1-01).
      this.resumeChecked = true
      const baseEffort = base.effort ?? await this.defaultEffortOf(base.model)
      this.overridden = this.threadModel !== base.model || this.threadEffort !== baseEffort
    }
    if (!this.overridden) return { params: {}, clears: false }
    const base = await this.serverDefaultsOrFail()
    const effort = base.effort ?? await this.defaultEffortOf(base.model)
    return { params: { model: base.model, ...(effort ? { effort } : {}) }, clears: true }
  }
  /**
   * 전송 전 확인. 되돌릴 기본값이 필요할 수 있는데 그것을 확인하지 못하면 **여기서 던진다** —
   * 보낸 글이 대화에 남거나 초안이 사라지기 전에 막고, 학생이 다시 보낼 수 있게 한다.
   * 새 대화(`sessionId` 없음)는 덮어쓴 적이 없으므로 묻지 않는다.
   */
  async prepare(sessionId: string | undefined): Promise<void> {
    if (this.free) { await this.turnModelParams(Boolean(sessionId)); return }
    const choice = this.options.modelChoice?.()
    if (choice?.model && isCrossProviderModelId(choice.model)) throw new Error(MODEL_SELECTION_COPY.reselectionRequired)
    if (!sessionId) return
    if (!this.everChosen) return
    if (this.options.modelChoice?.()?.model) return
    if (!this.overridden && this.resumeChecked) return
    await this.serverDefaultsOrFail()
  }
  /** 이 공급자로 모델을 **고른 적이 있는가**(설정의 흔적). 없으면 기본값 조회 자체를 하지 않는다. */
  private get everChosen(): boolean { return this.options.modelChosen?.() ?? true }
  /** 기본값 조회 실패를 학생이 읽을 수 있는 오류로 바꾼다 — 조용히 이전 모델로 보내지 않는다. */
  private async serverDefaultsOrFail(): Promise<{ model: string; effort: string | null }> {
    let base: { model: string; effort: string | null }
    try {
      base = await this.serverDefaults()
    } catch (e) {
      const detail = e instanceof Error && e.message ? ` (${e.message})` : ''
      throw new Error(`Codex 기본 모델을 확인하지 못해 이전 모델 설정을 되돌리지 못했어요. 잠시 뒤 다시 보내 주세요.${detail}`)
    }
    if (isCrossProviderModelId(base.model)) throw new Error(MODEL_SELECTION_COPY.crossProviderDefault)
    return base
  }
  /**
   * 서버가 새 대화에 쓰는 기본 model·effort. `ephemeral` 대화는 디스크에 남지 않는다.
   * 한 연결에서 한 번만 묻는다 — 학생 설정·요금제가 바뀌면 앱을 다시 켜며 연결도 새로 생긴다.
   */
  private async serverDefaults(): Promise<{ model: string; effort: string | null }> {
    if (this.defaults) return this.defaults
    const rpc = await this.connect()
    // 탐침도 적재 호출이다(§4.1-C PROCESS DISCARD RULE). 표를 거치지 않은 채 나가면 그 프로세스는
    // 잠금을 확인하지 않은 것이므로, 시작 표식을 세우고 끝나면 불명으로 남긴다 — 다음 적재가
    // 이 프로세스를 잠긴 것으로 믿지 않는다.
    const plan = this.guard ? await this.ensurePlan(rpc) : undefined
    if (plan) this.guard?.table.beginStart(plan.fingerprint)
    let r: unknown
    try {
      r = await rpc.request('thread/start', { ephemeral: true, cwd: this.options.root, ...(plan ? { config: plan.config } : {}) })
    } catch (e) {
      // 요청이 실패하면 그 프로세스가 무엇을 남겼는지 앱은 모른다 — 버리고 다음에 새로 연다.
      await this.discardProcess()
      throw e
    } finally {
      if (plan) this.guard?.table.clearPending()
    }
    const threadId = r && typeof r === 'object' && 'thread' in r && r.thread && typeof r.thread === 'object' && 'id' in r.thread ? r.thread.id : undefined
    const reply = r && typeof r === 'object' ? (r as { model?: unknown; reasoningEffort?: unknown }) : undefined
    const model = typeof reply?.model === 'string' && reply.model ? reply.model : ''
    if (!(typeof threadId === 'string' && threadId)) {
      // 대화 id 가 없는 응답은 서버가 스레드를 만들었는지 알 수 없다 — 그 프로세스를 다시 쓰지
      // 않는다(적재 경로 `loadReply` 의 `no-id` 와 같은 선). 남은 model 을 기본값으로 삼지도 않는다.
      await this.discardProcess()
      throw new Error('Codex가 기본 대화를 만들지 못했어요.')
    }
    if (plan && typeof threadId === 'string' && threadId) this.guard?.noteProbe(threadId)
    if (!model) {
      await this.discardProcess()
      throw new Error('Codex가 기본 모델을 알려 주지 않았어요.')
    }
    this.defaults = { model, effort: typeof reply?.reasoningEffort === 'string' && reply.reasoningEffort ? reply.reasoningEffort : null }
    return this.defaults
  }
  /** 그 모델의 기본 생각 깊이(`model/list`). 목록에 없으면 null — 깊이는 생략한다. */
  private async defaultEffortOf(model: string): Promise<string | null> {
    if (!this.catalog) {
      try { await this.models() } catch { /* 목록 없이도 모델 선택은 보낸다 */ }
    }
    return this.catalog?.find(m => m.model === model)?.defaultEffort ?? null
  }
  respond(id: string, allow: boolean) {
    const request = this.approvals.get(id)
    if (request === undefined) throw new Error('이미 종료된 권한 요청이에요.')
    this.rpc?.send({ id: request, result: { decision: allow ? 'accept' : 'decline' } }); this.approvals.delete(id)
    const pending = this.pendingFileApprovals.get(id)
    if (pending) this.fileChanges.delete(pending.key)
    this.pendingFileApprovals.delete(id)
  }
  /** 앱이 띄운 엔진 pid — 종료 마감 뒤 회수 대상(검토 RT2-03). 종료 동작은 바꾸지 않는다. */
  ownedPids(): number[] {
    const pid = this.rpc?.closed === false ? this.rpc.pid : undefined
    return typeof pid === 'number' && pid > 0 ? [pid] : []
  }
  async stop() {
    this.stopped = true
    if (this.turn && this.thread && this.rpc && !this.rpc.closed) {
      // 종료 중에는 interrupt를 45s 전체 대기하지 않는다 — 짧은 예산 뒤에 kill로 넘어간다.
      const { promise, reject } = Promise.withResolvers<void>()
      const budget = setTimeout(() => reject(new Error('shutdown')), 3000)
      try { await Promise.race([this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }), promise]) } catch { /* process termination below */ } finally { clearTimeout(budget) }
    }
    await this.rpc?.stop(); this.rpc = undefined; this.approvals.clear()
    this.fileChanges.clear(); this.pendingFileApprovals.clear(); this.mcpCalls.clear()
    this.dropGuard()
  }
}

/**
 * 담당(relay) 한 번의 한도 판정 — 설계 §3.5 A.
 *
 * 근거(동봉 `codex app-server generate-ts`, 0.167.0):
 * `v2/GetAccountRateLimitsResponse.ordinaryUsageAllowed: boolean | null` — 주석이
 * "Null means unavailable; clients must not infer recovery from percentages or reset times" 다.
 * 즉 `true` 만 A 이고, `false` 는 B(한도 밖), `null`·미확인은 **모름**이다.
 * `rateLimits.primary/secondary` 의 사용률·리셋 시각으로 추론하지 않는다.
 */
export function codexUsageState(ordinaryUsageAllowed: unknown): UsageState {
  return ordinaryUsageAllowed === true ? 'allowed' : ordinaryUsageAllowed === false ? 'limit' : 'unknown'
}

/**
 * 이 계정이 누구인가 — `JobRunner` 가 `options.account()`(앱 동의 반영본)와
 * `availability()` 를 **지문으로 대조**하므로 두 값은 같은 함수에서 나와야 한다.
 * `consented`·`usage` 는 여기서 정하지 않는다(앱 저장소·관측값이 정본).
 *
 * 계정 식별자는 `account/read` 가 준 `accountId` 를 쓴다. 앱이 서버에 물어 얻는 값이므로
 * 이메일·요금제를 해시해 지어내지 않는다. 없으면(옛 서버) 쓸 수 있는 값으로 대신하고,
 * 그 사실을 호출자가 `detail.subjectKnown=false` 로 알 수 있게 한다.
 */
export function codexExecutionAccount(options: AgentOptions, models: readonly ModelCatalogEntry[] | null,
  detail: { accountId?: string | null; accountType?: string | null; subject?: string } = {}): ExecutionAccount {
  const subject = detail.accountId ?? detail.subject ?? options.root
  const accountType = typeof detail.accountType === 'string' ? detail.accountType : null
  return {
    accountId: detail.accountId ?? createHash('sha256').update(JSON.stringify([options.binary, subject])).digest('hex'),
    connected: true,
    account: { company: 'codex', ...(accountType ? { accountType } : {}), models },
    consented: false,
    usage: 'unknown'
  }
}

/**
 * 담당 턴의 샌드박스 정책 — 격리의 **본체**다.
 *
 * `thread/start.sandbox: 'workspace-write'` 문자열은 정책을 정하지 못한다: 실측(PATH codex
 * 0.167.0)에서 `thread/start` 응답이 `writableRoots: []` 로 와서 **작업 폴더 밖 쓰기가 그대로
 * 통과**했다(`outside-a.md` 생성). 같은 명령이 이 정책을 `turn/start` 에 실으면
 * `operation not permitted` 로 막혔다. 그래서 턴마다 이 값을 싣는다.
 * `excludeTmpdirEnvVar`/`excludeSlashTmp` 는 참 — 임시 폴더가 쓰기 구멍이 되지 않게 한다.
 */
export function codexSandboxPolicy(cwd: string): {
  type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean
  excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean
} {
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
}

/**
 * 담당 스레드를 여는 값 — 시험도 같은 함수를 써서 요청 모양이 갈라지지 않게 한다.
 *
 * `approvalsReviewer: 'user'` 를 **명시**한다. 스키마(`v2/ApprovalsReviewer.ts`, 0.167.0):
 * `"user" | "auto_review" | "guardian_subagent"` 이고 주석은 "Configures who approval requests
 * are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval
 * prompts, and ARC escalations. Defaults to `user`." 다. 즉 생략하면 **사용자 설정을 상속**해
 * `auto_review`/`guardian_subagent` 가 샌드박스 탈출·네트워크 승격을 따로 심사할 수 있다.
 * 담당에는 묻는 학생이 없고 앱이 승인 요청을 전부 거절하므로, 심사자도 앱 쪽(사용자 자리)으로
 * 고정해 승격 경로를 만들지 않는다(검토 차단 2).
 *
 * `lockdown` 은 담당에서만 싣는다 — 학생의 MCP·플러그인·Apps 를 담당 스레드에서 끄는 값이고
 * 본대화의 `open()`/`serverArgsFor` 는 같은 값을 쓰지 않는다(발주 C3). 시험은 이 값을 그대로 고정한다.
 */
export function codexThreadParams(request: RelayRequest, model: string, lockdown?: RelayLockdown) {
  return {
    cwd: request.cwd, approvalPolicy: 'on-request' as const, sandbox: request.isolation.codexSandbox,
    approvalsReviewer: 'user' as const,
    model, developerInstructions: RELAY_DEVELOPER_INSTRUCTIONS,
    // 담당 전용 자리 — 본대화(`serverArgsFor`, `CodexConnection`)는 이 값을 쓰지 않는다.
    ...(lockdown ? { config: lockdown } : {})
  }
}

/** RPC 응답은 `unknown` 이다 — 객체가 아니면 빈 표로 본다(필드 하나 읽으려고 캐스팅하지 않는다). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** 이름 → `{enabled:false}` 표. 빈 이름은 codex 가 거절하므로 거른다. */
function disabledTable(table: unknown): Record<string, { enabled: false }> {
  return Object.fromEntries(Object.keys(asRecord(table)).filter(name => name !== '')
    .map(name => [name, { enabled: false as const }]))
}

/**
 * 담당 스레드에서 학생의 MCP 서버·플러그인·Apps 를 끄는 값(`thread/start.config`).
 *
 * 실측(PATH codex 0.167.0, 합성 HOME): `-c mcp_servers={}`·`-c mcp.enabled=false`·
 * `-c orchestrator.mcp.enabled=false` 는 **안 듣는다**(미끼 서버가 그대로 기동). 듣는 것은
 * 이름별 `enabled=false` 뿐이고, `-c` 는 본대화와 공유(`serverArgsFor`)라 여기 쓴다.
 *  · `mcp_servers.<이름>.enabled=false` → 그 서버는 기동조차 않는다(표식 파일 0회).
 *  · `plugins.<id>.enabled=false` → 그 플러그인이 딸고 오는 MCP 가 사라진다.
 *  · `features.apps=false` → 계정 커넥터(Apps)가 `app/list` 에서 0개, `codex_apps` 도구 0개.
 * 이름을 **모두 열거**해야 한다(전체 끄기 키 없음). 이름은 `config/read` 의 `mcp_servers`/
 * `plugins` 키와 `plugin/installed` 의 설치 id 합집합에서 받는다 — 추측 금지, 그리고 둘 다
 * MCP 를 기동하지 않는다(실측: 미끼 표식 파일 0회).
 *
 * 실측 함정 셋: ① `config.mcp_servers` 에 **없는** 이름을 넣으면 `invalid transport` 로
 * `thread/start` 가 실패한다(플러그인 MCP 이름을 여기 넣으면 안 된다). ② `-c` 로
 * `plugins."id@mkt"` 처럼 따옴표를 쓰면 새 키가 생길 뿐 원래 키는 안 꺼진다.
 * ③ 설정의 `plugins` 는 설치 목록보다 작다(17 vs 26) — 원격 Apps 플러그인(`gmail@…` 등)이
 * 설정 표에 없어도 설치되어 있으므로 합집합이 필요하다(없는 id 를 넣어도 무해 — 실측).
 */
export interface RelayLockdown {
  features: { apps: false }
  mcp_servers: Record<string, { enabled: false }>
  plugins: Record<string, { enabled: false }>
}

export function codexRelayLockdown(config: unknown, installed?: unknown): RelayLockdown {
  const settings = asRecord(config)
  // `plugin/installed` → `{ marketplaces: [{ plugins: [{ id }] }] }`.
  const marketplaces = asRecord(installed).marketplaces
  const installedIds = (Array.isArray(marketplaces) ? marketplaces : []).flatMap(market => {
    const plugins = asRecord(market).plugins
    return (Array.isArray(plugins) ? plugins : []).map(plugin => asRecord(plugin).id)
  })
  const plugins = disabledTable(settings.plugins)
  for (const id of installedIds) if (typeof id === 'string' && id !== '') plugins[id] = { enabled: false }
  return { features: { apps: false }, mcp_servers: disabledTable(settings.mcp_servers), plugins }
}

/** 담당 세션의 개발자 지침 — 본대화와 달리 "묻지 말고 출력 칸에만 쓰라"가 핵심이다. */
const RELAY_DEVELOPER_INSTRUCTIONS = '이 세션은 knuaf-dev 개인용 GUI가 연 담당(relay)입니다. 주문서 파일을 읽고 그 지시대로 일하세요. 결과 파일은 주문서가 정한 출력 칸에만 쓰세요 — 그 밖의 경로는 샌드박스가 막습니다. 학생에게 직접 묻지 말고, 판단이 필요한 항목은 주문서의 조건 칸에 적으세요. 셸 명령은 앱이 그대로 읽을 수 있게 따옴표로 감싼 절대경로를 쓰고 변수 대입·서브셸·리다이렉트를 피하세요.'

/**
 * 담당 연결 — 본대화 `CodexConnection` 과 **별개의 프로세스·스레드**를 쓴다.
 *
 * 격리(설계 §3.3 Codex 몫)는 두 곳을 함께 걸어야 실제로 선다 — 실측(PATH codex 0.167.0):
 *  · `spawn` cwd 와 `thread/start.cwd` = `jobs/<id>/out`
 *  · **`turn/start.sandboxPolicy`** = `workspaceWrite{writableRoots:[out], networkAccess:false,
 *    excludeTmpdirEnvVar:true, excludeSlashTmp:true}`
 *  `thread/start.sandbox: 'workspace-write'` 문자열만 주면 `thread/start` 응답의 정책이
 *  `writableRoots: []` 로 와서 **out 밖 쓰기가 그대로 통과했다**(실측: `outside-a.md` 생성됨).
 *  `turn/start.sandboxPolicy` 를 주면 같은 명령이 `operation not permitted` 로 막혔다.
 *  그래서 이 클래스는 `sandboxPolicy` 를 **반드시** 싣는다.
 *
 * 승인: 이 연결에는 묻는 학생이 없다. 명령·파일변경 승인 요청은 전부 `decline` 이고,
 * `requestUserInput` 은 빈 답, 모르는 요청은 `-32601` 이다. 그래서 모델이 샌드박스 밖으로
 * 나가려 해도 통과하지 못한다(`danger-full-access` 승격 경로가 없다).
 */
export class CodexRelayConnection implements JobConnection {
  readonly relayProtocol = 1 as const
  get gateInTurn(): boolean { return this.free }
  private get free(): boolean { return this.request.company === 'free' }
  private rpc?: JsonRpcProcess
  private connecting?: Promise<JsonRpcProcess>
  private serverArgs: string[]
  private thread?: string
  private turn?: string
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private stopped = false
  private events?: JobEvents
  /** 알림 순번 — 토큰 기록의 `notificationSequence`. 주문 한 건 안에서 1부터 센다. */
  private notifications = 0
  constructor(private options: AgentOptions, private request: RelayRequest) {
    this.serverArgs = serverArgsFor(options.env)
  }

  async status(): Promise<ConnectionStatus> {
    if (this.free) return freeStatus()
    try {
      const rpc = await this.connect()
      const r = await rpc.request('account/read', { refreshToken: false })
      const connected = r?.account?.type === 'chatgpt'
      return { installed: true, connected, version: this.version, probe: 'ok',
        detail: connected ? '' : 'ChatGPT 로그인이 필요해요. API 계정으로 자동 전환하지 않아요.' }
    } catch (error) {
      return { installed: true, connected: false, version: this.version, probe: 'failed',
        detail: `Codex 연결을 확인하지 못했어요. (${(error as Error)?.message ?? '알 수 없음'})` }
    }
  }
  login(): Promise<void> { return Promise.reject(new Error('담당 연결은 로그인을 열지 않아요.')) }
  respond(): void {}
  run(): Promise<void> { return Promise.reject(new Error('담당 연결은 runJob 으로만 움직여요.')) }

  private version: string | null = null

  /**
   * 주문 전 계정·한도 조회. Codex 는 턴 **밖에서도** `account/rateLimits/read` 가
   * `ordinaryUsageAllowed` 를 직접 준다(실측: `{ordinaryUsageAllowed, rateLimits, …, accountId}`).
   * 그래서 Claude 와 달리 여기서 A 를 사실대로 판정할 수 있다.
   */
  async availability(): Promise<ExecutionAccount> {
    if (this.free) return freeExecutionAccount()
    let rpc: JsonRpcProcess
    try { rpc = await this.connect() } catch { return { ...codexExecutionAccount(this.options, null), connected: false, usage: 'auth' } }
    let accountType: string | null = null
    try { const account = await rpc.request('account/read', { refreshToken: false }); accountType = account?.account?.type ?? null }
    catch { /* 확인 실패는 아래 usage 로 드러난다 */ }
    const models = await this.catalog(rpc)
    const limits = await this.readLimits(rpc)
    return {
      ...codexExecutionAccount(this.options, models, { accountId: limits.accountId, accountType }),
      connected: accountType === 'chatgpt',
      usage: accountType === 'chatgpt' ? limits.usage : 'auth'
    }
  }

  /** 한도 스냅샷 한 번. 못 읽으면 `'unknown'` — `allowed` 를 지어내지 않는다(설계 §3.5). */
  private async readLimits(rpc: JsonRpcProcess): Promise<{ usage: UsageState; accountId: string | null }> {
    try {
      const limits = await rpc.request('account/rateLimits/read', {})
      return {
        usage: codexUsageState(limits?.ordinaryUsageAllowed),
        accountId: typeof limits?.accountId === 'string' ? limits.accountId : null
      }
    } catch { return { usage: 'unknown', accountId: null } }
  }

  /** 이 계정의 모델 목록 — `JobRunner.listed()` 가 요청 모델을 이 목록에서 찾는다. */
  private async catalog(rpc: JsonRpcProcess): Promise<ModelCatalogEntry[] | null> {
    const out: ModelCatalogEntry[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < 20; page++) {
        const r = await rpc.request('model/list', cursor ? { limit: 100, cursor } : { limit: 100 })
        for (const raw of Array.isArray(r?.data) ? r.data : []) {
          if (!raw || typeof raw !== 'object') continue
          const m = raw as Record<string, unknown>
          if (m.hidden === true) continue
          const model = typeof m.model === 'string' && m.model ? m.model : ''
          if (!model || isCrossProviderModelId(model) || out.some(x => x.model === model)) continue
          out.push({
            model,
            name: typeof m.displayName === 'string' && m.displayName ? m.displayName : model,
            efforts: Array.isArray(m.supportedReasoningEfforts)
              ? m.supportedReasoningEfforts
                .map(e => (e && typeof e === 'object' && 'reasoningEffort' in e ? e.reasoningEffort : undefined))
                .filter((e): e is string => typeof e === 'string' && e !== '')
              : []
          })
        }
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null
        if (!cursor) break
      }
    } catch { return null }
    return out
  }

  async runJob(text: string, events: JobEvents): Promise<void> {
    try { return await this.runJobBody(text, events) }
    catch (error) { throw this.free && !(error instanceof FreeRelayError) ? freeRelayError(error) : error }
  }

  private async runJobBody(text: string, events: JobEvents): Promise<void> {
    this.events = events
    const rpc = await this.connect()
    if (!this.free) {
      const account = await rpc.request('account/read', { refreshToken: false })
      if (account?.account?.type !== 'chatgpt') throw new JobFailure('auth', 'ChatGPT 계정 로그인이 필요해요.')
    } else if (!freeStatus().connected) throw new FreeRelayError('free-unavailable')
    // 별칭(`astra`·`sol`…)을 이 계정의 실제 id 로 푼다. 목록에 없으면 보낸 값을 그대로 쓴다 —
    // 서버가 거절하면 그 오류가 그대로 주문 실패로 남는다(추측으로 다른 모델을 고르지 않는다).
    const models = this.free ? FREE_MODELS : (await this.catalog(rpc)) ?? []
    const model = resolveCodexAlias([...models], this.request.model) ?? this.request.model
    const skillPath = join(this.request.skill, 'SKILL.md')
    if (this.free && !FREE_MODELS.some(entry => entry.model === model)) throw new FreeRelayError('free-error')
    // 스킬 폴더가 작업 폴더 밖이므로 경로 루트를 따로 알려 준다(실측: 이것 없이는 발견 못 함).
    try { await rpc.request('skills/extraRoots/set', { extraRoots: [dirname(this.request.skill)] }) } catch { /* 옛 서버: 아래 확인이 실패로 잡는다 */ }
    const skills = await rpc.request('skills/list', { cwds: [this.request.cwd], forceReload: true })
    const found = (Array.isArray(skills?.data) ? skills.data : []).some((entry: unknown) => {
      const list = (entry as { skills?: unknown })?.skills
      return Array.isArray(list) && list.some((s: unknown) => {
        const skill = s as { path?: unknown; enabled?: unknown }
        return typeof skill?.path === 'string' && realOrSelf(skill.path) === realOrSelf(skillPath) && skill.enabled === true
      })
    })
    if (!found) throw new Error('Codex가 knuaf-dev 스킬을 찾지 못했어요.')
    events.skill()
    /**
     * 학생 설정에서 **이름만** 받아 담당 전용 제한을 만든다. `config/read` 는 MCP 를 기동하지
     * 않으므로 여기서 먼저 불러도 부작용이 없다(실측).
     *
     * 플러그인은 `config.plugins` 만으로 부족하다 — 실측 0.167.0: 설정 17개 vs 설치 26개,
     * 원격 Apps 플러그인(`gmail@…` 등)은 설정 표에 없어도 설치되어 있다. 그래서 설치 목록과
     * 합집합을 쓴다(없는 id 를 넣어도 `thread/start` 는 정상 — 실측).
     *
     * **설치 목록을 읽지 못하면 스레드를 열지 않는다**(검토 중요 2). 목록 없이 만든 제한은 설치
     * 전용 플러그인을 놓치고, 그 플러그인이 딸고 오는 MCP 는 `thread/start` 순간 기동된다 —
     * 뒤의 `assertIsolated` 가 턴은 막아도 이미 뜬 프로세스는 되돌릴 수 없다. 실측 0.163.0·
     * 0.164.0·0.167.0 셋 다 이 요청을 가지므로(응답 `{marketplaces, marketplaceLoadErrors}`),
     * 실패는 "이 판이 지원하지 않는다"가 아니라 진짜 이상 상태다.
     */
    const userConfig = await rpc.request('config/read', { cwd: this.request.cwd, includeLayers: false })
      .catch(() => { throw new Error('학생 설정을 읽지 못해 담당을 안전하게 격리할 수 없어요. 이 주문은 열지 않습니다.') })
    const installed = await rpc.request('plugin/installed', {}).catch(() => {
      throw new Error('학생이 설치한 플러그인 목록을 읽지 못해 담당을 안전하게 격리할 수 없어요. 이 주문은 열지 않습니다.')
    })
    // 응답 형식도 확인한다 — `marketplaces` 가 배열이 아니면 열거가 끝났는지 알 수 없다.
    if (!Array.isArray(asRecord(installed).marketplaces)) {
      throw new Error('학생이 설치한 플러그인 목록의 형식이 예상과 달라 담당을 안전하게 격리할 수 없어요. 이 주문은 열지 않습니다.')
    }
    const lockdown = codexRelayLockdown(userConfig?.config, installed)
    const started = await rpc.request('thread/start', codexThreadParams(this.request, model, lockdown))
    const threadId = started?.thread?.id
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex가 담당 스레드를 열지 못했어요.')
    /**
     * **보낸 값만 믿지 않는다** — 사용자 설정이 심사자를 바꿔 놓으면 서버가 다른 값을 돌려준다.
     * 그 상태로 턴을 열면 승인 요청이 자동 심사 에이전트로 흘러 앱의 거절을 우회할 수 있다.
     * 그래서 돌려받은 심사자를 대조하고, 다르면 턴을 열지 않는다(검토 차단 2).
     */
    if (started.approvalsReviewer !== 'user') {
      throw new Error('Codex 담당 스레드의 승인 심사자가 앱이 정한 값과 달라요. 이 주문은 열지 않습니다.')
    }
    await this.assertIsolated(rpc, threadId, lockdown)
    this.thread = threadId
    // 순서 고정: 세션 id 가 먼저 와야 러너가 토큰 기록을 남긴다(jobs.ts `tokens`).
    events.session(threadId)
    /**
     * 실제 노력 수준은 **주문이 보낸 값**이다. `started.reasoningEffort` 는 스레드 기본값이라
     * 주문이 low 인데 서버 기본이 high 면 기록이 high 로 남는다(검토 중요 2). `turn/start.effort`
     * 는 "this turn and subsequent turns" 에 적용되므로 이 턴의 실제 값은 `request.effort` 다.
     * 모델은 서버가 돌려준 값을 그대로 쓴다(별칭→실제 id 해석은 서버 몫이다).
     */
    events.actualModel(typeof started.model === 'string' && started.model ? started.model : model, this.request.effort)
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }, { type: 'skill', name: SKILL_NAME, path: skillPath }],
        model,
        // 격리의 본체 — 이 키가 없으면 out 밖 쓰기가 통과한다(실측).
        sandboxPolicy: codexSandboxPolicy(this.request.cwd),
        ...(this.request.effort ? { effort: this.request.effort } : {})
      }).then(r => {
        if (typeof r?.turn?.id === 'string') this.turn = r.turn.id
      }).catch(error => { this.waiter = undefined; reject(error) })
    })
  }

  /**
   * 보낸 제한이 실제로 걸렸는지 **서버에 물어** 확인한다. `thread/start` 가 성공했다고 믿지 않는다
   * — 옛 판이 키를 무시하거나 사용자 설정이 나중에 이기면 도구가 그대로 살아 있다.
   *
   * 판정은 **`disabled` 만 통과**다. `mcpServerStatus` 의 다른 값(`connected`, `starting`,
   * `authenticationRequired`, `failed`, `cancelled`, `notStarted`, `null`)은 모두 "우리 설정이
   * 안 먹었다"는 뜻이라 턴을 열지 않는다 — 서버를 하나라도 놓치면 학생 도구가 담당에 붙는다
   * (실측 0.167.0 실제 설정: 제한 없이는 17개 항목 중 13 connected·2 disabled·2 failed,
   * 제한을 걸면 13개 항목 전부 disabled).
   *
   * **확인하지 못한 상태를 통과로 넘기지 않는다**(검토 중요 1). 목록은 쪽 단위로 오므로
   * ① 쪽 상한에 닿았는데 `nextCursor` 가 남아 있으면, ② 응답의 `data` 가 배열이 아니면,
   * ③ 제한을 건 이름이 하나라도 있는데 목록이 비어 있으면 — 전부 "판정 불가"라 주문을 닫는다.
   * 끝까지 읽고 전부 `disabled` 인 경우에만 통과한다.
   */
  private async assertIsolated(rpc: JsonRpcProcess, threadId: string, lockdown: RelayLockdown): Promise<void> {
    const expected = Object.keys(lockdown.mcp_servers).length
    const live: string[] = []
    let seen = 0
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const r = await rpc.request('mcpServerStatus/list',
        cursor ? { threadId, cursor, detail: 'toolsAndAuthOnly' } : { threadId, detail: 'toolsAndAuthOnly' })
      const data = asRecord(r).data
      if (!Array.isArray(data)) {
        throw new Error('Codex 담당 스레드의 MCP 상태 목록 형식이 예상과 달라 격리를 확인하지 못했어요. 이 주문은 열지 않습니다.')
      }
      for (const raw of data) {
        seen++
        const entry = asRecord(raw)
        if (entry.runtimeStatus !== 'disabled') {
          const name = typeof entry.name === 'string' && entry.name ? entry.name : '(이름 없음)'
          live.push(`${name}=${String(entry.runtimeStatus)}`)
        }
      }
      cursor = typeof asRecord(r).nextCursor === 'string' && asRecord(r).nextCursor ? asRecord(r).nextCursor as string : null
      if (!cursor) break
    }
    if (cursor) {
      throw new Error('Codex 담당 스레드의 MCP 상태 목록이 끝나지 않아 격리를 확인하지 못했어요. 이 주문은 열지 않습니다.')
    }
    // 제한을 건 이름이 있는데 목록이 통째로 비면 "꺼졌다"가 아니라 "볼 것이 없다"이다.
    if (expected > 0 && seen === 0) {
      throw new Error('Codex 담당 스레드의 MCP 상태 목록이 비어 있어 격리를 확인하지 못했어요. 이 주문은 열지 않습니다.')
    }
    if (live.length > 0) {
      throw new Error(`Codex 담당 스레드에서 MCP 서버가 꺼지지 않았어요(${live.join(', ')}). 이 주문은 열지 않습니다.`)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const rpc = this.rpc
    if (this.thread && this.turn && rpc && !rpc.closed) {
      try { await rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }) } catch { /* 프로세스 종료가 뒤따른다 */ }
    }
    this.waiter?.reject(new Error('담당이 중단됐어요.'))
    this.waiter = undefined
    await rpc?.stop(); this.rpc = undefined
  }

  private async connect(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new JobFailure('unknown', 'Codex 담당 연결이 중단됐어요.')
    const inflight = this.connecting
    if (inflight) return inflight
    if (this.rpc && !this.rpc.closed) return this.rpc
    return (this.connecting = this.open().finally(() => { this.connecting = undefined }))
  }

  /**
   * app-server 프로세스. **`spawn` cwd 도 작업 폴더**로 준다 — 서버 쪽 기본 cwd 가 남의
   * 폴더가 되면 `command/exec` 나 상대경로 해석이 그 폴더를 기준으로 움직인다(실측).
   */
  private async open(): Promise<JsonRpcProcess> {
    if (this.stopped) throw new JobFailure('unknown', 'Codex 담당 연결이 중단됐어요.')
    const rpc = this.rpc = new JsonRpcProcess(this.options.binary, this.serverArgs, this.request.cwd, this.options.env)
    rpc.onNotification = (method, p) => this.notify(method, p)
    rpc.onRequest = (id, method) => {
      // 묻는 학생이 없다. 승인 계열은 전부 거절, 인터뷰형 요청은 빈 답, 나머지는 미지원.
      if (method === 'item/tool/requestUserInput') return rpc.send({ id, result: { answers: {} } })
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        return rpc.send({ id, result: { decision: 'decline' } })
      }
      /**
       * 이 요청만 응답 모양이 다르다 — 스키마(`v2/PermissionsRequestApprovalResponse.ts`):
       * `{permissions: {network, fileSystem}, scope: 'turn'|'session'}`. 승인 계열 공통 모양
       * (`{decision:'decline'}`)을 보내면 서버 역직렬화가 실패해 턴이 중단될 수 있다(검토 중요 3).
       * **빈 허용 목록 + `turn` 범위**가 "아무것도 더 주지 않는다"는 뜻이다.
       */
      if (method === 'item/permissions/requestApproval') {
        return rpc.send({ id, result: { permissions: { network: null, fileSystem: null }, scope: 'turn' } })
      }
      if (method === 'applyPatchApproval' || method === 'execCommandApproval') return rpc.send({ id, result: { decision: 'decline' } })
      if (method === 'mcpServer/elicitation/request') return rpc.send({ id, result: { action: 'decline' } })
      return rpc.send({ id, error: { code: -32601, message: '담당 연결은 이 요청을 지원하지 않아요.' } })
    }
    rpc.onClose = () => {
      const w = this.waiter; this.waiter = undefined
      w?.reject(new JobFailure('unknown', 'Codex 담당 연결이 종료됐어요.'))
    }
    let init: { userAgent?: string } | undefined
    try {
      init = await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.7.0' }, capabilities: { experimentalApi: true } })
    } catch (error) {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      if (this.stopped) throw error
      if (!this.serverArgs.includes('--listen')) {
        this.serverArgs = [...this.serverArgs, '--listen', 'stdio://']
        return this.open()
      }
      const detail = [(error as Error)?.message, rpc.lastStderr].filter(Boolean).join(' / ')
      throw new JobFailure('unknown', 'Codex 담당 연결을 열지 못했어요.' + (detail ? ` (${detail})` : ''))
    }
    const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
    this.version = /^[^/\s]+\/([^\s]+)/.exec(ua)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(ua)?.[1] ?? null
    rpc.send({ method: 'initialized', params: {} })
    return rpc
  }

  /** 알림 한 건. 이 스레드 것만 본다 — 다른 담당·본대화 스레드는 이 클래스에 오지 않는다. */
  private notify(method: string, p: any): void {
    if (p?.threadId && this.thread && p.threadId !== this.thread) return
    if (method === 'thread/started' && typeof p?.thread?.id === 'string' && !this.thread) this.thread = p.thread.id
    if (method === 'turn/started' && typeof p?.turn?.id === 'string') this.turn = p.turn.id
    if (method === 'thread/tokenUsage/updated') {
      this.notifications++
      const usage = p?.tokenUsage
      if (usage && typeof usage === 'object') this.events?.tokens(codexTokens(usage, 1, this.notifications, this.free ? 'free' : 'codex'))
      return
    }
    if (method === 'account/rateLimits/updated') {
      // 이 알림은 단면(`rateLimits`)만 준다 — `ordinaryUsageAllowed` 가 없다. 다시 읽어 판정한다.
      if (this.free) return
      // 스키마 주석: "merge … or refetch that snapshot" — 여기서는 재조회 쪽을 고른다.
      const rpc = this.rpc
      if (!rpc || rpc.closed) return
      void this.readLimits(rpc).then(limits => this.events?.availability(limits.usage)).catch(() => {})
      return
    }
    if (method === 'turn/completed') {
      const w = this.waiter; this.waiter = undefined
      if (this.free && p?.turn?.status !== 'completed') { w?.reject(freeRelayError(p?.turn?.error)); return }
      const error = p?.turn?.error
      if (p?.turn?.status === 'completed') { w?.resolve(); return }
      if (p?.turn?.status === 'interrupted') { w?.reject(new JobFailure('unknown', '담당 턴이 중단됐어요.')); return }
      const code = typeof error?.codexErrorInfo === 'string' ? error.codexErrorInfo : ''
      if (code === 'usageLimitExceeded' || code === 'rateLimitExceeded') { w?.reject(new JobFailure('limit', error?.message ?? '한도에 걸렸어요.')); return }
      if (code === 'unauthorized') { w?.reject(new JobFailure('auth', 'ChatGPT 인증이 거절됐어요.')); return }
      w?.reject(new Error(error?.message ?? '담당 작업이 완료되지 않았어요.'))
    }
  }
}
