import { MODEL_SELECTION_COPY } from '../../shared/copy'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { JsonRpcProcess } from './transport'
import { applyRejection, recordRejection } from './rejectLog'
import { codexSkillConfigOverride, workFolderInstructions } from '../agent'
import { writeFileAtomic } from '../safeWrite'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'
import type { ChatModelInfo, PermissionFileChange, PermissionRequest } from '../../shared/chat'
import { isCrossProviderModelId } from '../../shared/chat'

/**
 * 메인이 스스로 하위 담당을 띄웠을 때 학생에게 하는 말(§5-7). 앱은 Codex 의 그 호출을 막을
 * 관문이 없다 — 실제로 띄웠다는 사실과 그 사용량이 한도·요금에 들어간다는 것만 알린다.
 * 담당의 중간 말은 대화에 넣지 않는다(§8).
 */
export const SUBAGENT_SPAWNED_NOTE = '본대화의 ChatGPT가 하위 담당을 스스로 띄웠어요. 앱은 그 호출을 막지 못하고 기록만 해요 — 그 사용량도 같은 한도와 요금에 들어가요. 넘길 일은 "다른 모델에게 넘겨 주세요"라고 한 번만 말해 주세요.'

/** Codex 턴이 구조화해 보낸 인증 거절. 오류 본문은 판정·저장에 쓰지 않는다. */
export class CodexAuthenticationError extends Error {}

/** 존재하면 realpath, 아니면 입력 그대로. 경로 비교는 반드시 이것을 거친다. */
export function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * `codex app-server` argv. `-c 'skills.config=…'`(전역 knuaf-dev 사본 끄기)는 subcommand
 * 앞에 온다 — codex 의 config 오버라이드는 루트 인자다. 존재하는 사본이 없으면 순수
 * `['app-server']`. 단위 테스트가 이 모양을 고정한다(e2e/agent.spec.ts).
 */
export function serverArgsFor(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = []
  const cfg = codexSkillConfigOverride(env.HOME)
  if (cfg) args.push('-c', cfg)
  // 모델·추론 강도도 같은 방식으로 이 프로세스에서만 정한다. 값이 없으면 인자를 늘리지
  // 않고 CLI 기본값(학생의 config.toml)을 그대로 쓴다.
  if (env.KNUAF_CODEX_MODEL) args.push('-c', `model=${env.KNUAF_CODEX_MODEL}`)
  if (env.KNUAF_CODEX_EFFORT) args.push('-c', `model_reasoning_effort=${env.KNUAF_CODEX_EFFORT}`)
  return [...args, 'app-server']
}
const FILE_CHANGE_UNAVAILABLE = '변경 내용을 확인하지 못했어요. 거절한 뒤 도우미에게 어떤 파일을 어떻게 바꾸는지 물어봐 주세요.'

/** 다른 턴의 같은 itemId와 섞이지 않도록 서버가 보내는 세 식별자를 함께 쓴다. */
function fileChangeKey(thread: unknown, turn: unknown, item: unknown): string | undefined {
  return typeof thread === 'string' && typeof turn === 'string' && typeof item === 'string'
    ? JSON.stringify([thread, turn, item]) : undefined
}

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
  /** 재개한 대화가 기본값과 다른지 한 번만 본다. */
  private resumeChecked = false
  /** 서버가 새 대화에 실제로 쓰는 기본값(계정·CLI 설정). `model/list` 나 설정을 추측하지 않는다. */
  private defaults?: { model: string; effort: string | null }
  /** 마지막 `model/list` 결과 — 고른 모델의 기본 생각 깊이를 찾는 데 쓴다. */
  private catalog?: ChatModelInfo[]
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private approvals = new Map<string, number | string>()
  private messages = new Map<string, string>()
  private fileChanges = new Map<string, PermissionFileChange[]>()
  private pendingFileApprovals = new Map<string, { key: string; reason: unknown }>()
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
  /** 학생에게 알린 spawn 호출 — 시작·완료 두 알림에 같은 호출이 와도 한 번만. */
  private announcedSubagents = new Set<string>()
  /** 실제값을 이미 기록한 담당 thread — `subAgentActivity` 가 started 로 두 번 와도 한 번만. */
  private recordedActivities = new Set<string>()
  constructor(private options: AgentOptions) {
    this.serverArgs = serverArgsFor(options.env)
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
    // 알림은 띄웠다는 사실만 말한다 — id 가 늦게 와도 학생에게 두 번 말하지 않는다.
    if (!this.announcedSubagents.has(key)) {
      this.announcedSubagents.add(key)
      this.events?.note(SUBAGENT_SPAWNED_NOTE)
    }
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
        type: `subagent-${data.event}`, provider: 'codex', at: new Date().toISOString(), ...data
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
    const rpc = this.rpc = new JsonRpcProcess(this.options.binary, this.serverArgs, this.options.root, this.options.env)
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
      }
      if (method === 'item/agentMessage/delta') {
        const text = (this.messages.get(p.itemId) ?? '') + p.delta
        this.messages.set(p.itemId, text); this.events?.message(p.itemId, text)
      } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        this.events?.message(p.item.id, p.item.text)
      } else if (method === 'turn/started') this.turn = p.turn.id
      else if (method === 'turn/completed') {
        this.fileChanges.clear(); this.pendingFileApprovals.clear()
        const w = this.waiter; this.waiter = undefined; this.turn = undefined
        if (p.turn.status === 'completed') w?.resolve()
        else if (p.turn.error?.codexErrorInfo === 'unauthorized') w?.reject(new CodexAuthenticationError('ChatGPT 인증이 거절됐어요.'))
        else w?.reject(new Error(p.turn.error?.message ?? '작업이 중단됐어요. 저장된 대화에서 이어갈 수 있어요.'))
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
      } else rpc.send({ id, error: { code: -32601, message: '이 요청은 GUI에서 지원하지 않습니다. 질문은 채팅 텍스트로 제시하세요.' } })
    }
    rpc.onClose = () => { this.waiter?.reject(new Error('Codex 연결이 종료됐어요. 답변은 자동 재전송하지 않아요.')); this.waiter = undefined }
    let init: { userAgent?: string } | undefined
    try {
      init = await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.6.1' }, capabilities: { experimentalApi: true } })
    } catch (e) {
      this.rpc = undefined
      await rpc.stop().catch(() => {})
      if (this.stopped) throw e
      if (!this.serverArgs.includes('--listen')) {
        // 평문이 안 되면 옛 인자로 한 번 더. 다음 connect() 부터는 그 인자를 쓴다.
        this.serverArgs = [...this.serverArgs, '--listen', 'stdio://']
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
  async run(text: string, sessionId: string | undefined, events: AgentEvents, replayHistory = false) {
    const rpc = await this.connect()
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
    const args = { cwd: this.options.root, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: '이 세션은 knuaf-dev 개인용 GUI입니다. 제공된 knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 같은 이름의 사용자·전역 스킬 사본이 보여도 무시하고 이 프로젝트의 스킬만 따르세요. 질문은 채팅 텍스트로 제시하세요. 인터뷰 원문과 해석은 스킬의 로그 계약대로 기록하세요. GUI의 첨부는 사용자 답변의 일부이며 현재 작성물 채택은 스킬의 확인 절차를 따르세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요.' }
    const r = sessionId ? await rpc.request('thread/resume', { ...args, threadId: sessionId }) : await rpc.request('thread/start', args)
    this.thread = r.thread.id; events.session(r.thread.id)
    this.threadModel = typeof r.model === 'string' && r.model ? r.model : null
    this.threadEffort = typeof r.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null
    if (!sessionId) { this.overridden = false; this.resumeChecked = false }
    // Replayed turns use a different id space (item-N) than the live stream (msg_*), so
    // id-dedup cannot catch them — replay only when the app snapshot has no assistant
    // history at all (e.g. snapshot file lost while the server thread survived).
    if (replayHistory) for (const turn of r.thread.turns ?? []) for (const item of turn.items ?? []) if (item.type === 'agentMessage') events.message(item.id, item.text)
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
    await new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
      rpc.request('turn/start', {
        threadId: this.thread,
        input: [{ type: 'text', text: prompt, text_elements: [] }, { type: 'skill', name: 'knuaf-dev', path: skillPath }],
        ...turnModel.params
      }).then(r => {
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
    const r = await rpc.request('thread/start', { ephemeral: true, cwd: this.options.root })
    const model = typeof r?.model === 'string' && r.model ? r.model : ''
    if (!model) throw new Error('Codex가 기본 모델을 알려 주지 않았어요.')
    this.defaults = { model, effort: typeof r?.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null }
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
  async stop() {
    this.stopped = true
    if (this.turn && this.thread && this.rpc && !this.rpc.closed) {
      try { await this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }) } catch { /* process termination below */ }
    }
    await this.rpc?.stop(); this.rpc = undefined; this.approvals.clear()
    this.fileChanges.clear(); this.pendingFileApprovals.clear()
  }
}
