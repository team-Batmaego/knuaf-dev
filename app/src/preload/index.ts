import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatModels, ChatSnapshot, ModelChoice, Provider } from '../shared/chat'
import type { AppInfo, OpenProjectReply, RpcResult, RuntimeInstallReply, RuntimeStatus } from '../shared/types'
import { UPDATE_RECOVERY_COPY } from '../shared/copy'
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'repair' | 'ready' | 'needs-app' | 'downloading' | 'switching' | 'error' | 'unavailable'
  current: string; bundled: boolean; highest: string | null; available: string | null
  kept: string[]; received?: number; total?: number; message?: string
}
export interface AppUpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'preparing' | 'launching' | 'interrupted' | 'error' | 'unavailable'
  current: string; latest: string | null; page: string | null; message?: string; received?: number; total?: number
}

type UpdateReply<T> = { result: T } | { error: { code: string; message: string } }
/**
 * `shell:open`·`shell:open-link` 응답. 열지 못했으면 메인이 이미 폴더에서 보여 주고
 * `revealed: true` 를 돌려준다 — `open_failed` 는 OS 열기 실패, `extension` 은 원래 열지 않는
 * 형식이다. 어느 쪽이든 화면은 원인을 단정하지 않고 사실만 말한다.
 */
export type OpenFileReply =
  | { result: { opened: boolean; revealed: boolean; reason?: 'extension' | 'open_failed' } }
  | { error: { code: string; message: string } }

/** `folder:open` — 화면은 경로가 아니라 이름만 준다(메인이 정한 폴더만 열린다). */
export type FolderKind = 'project' | 'logs'
const subscribe = <T>(channel: string, fn: (status: T) => void): (() => void) => {
  const listener = (_event: unknown, status: T): void => fn(status)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
// Preserve the pause code; the owning screen or poll controls any subsequent probe.
async function statusOnce(channel: string, ...args: unknown[]): Promise<unknown> {
  const reply = await ipcRenderer.invoke(channel, ...args)
  return reply?.error?.code === 'update_suspended'
    ? { error: { ...reply.error, message: UPDATE_RECOVERY_COPY } }
    : reply
}

type EventHandler = (event: string, data: unknown) => void
const handlers = new Map<string, EventHandler>()
let seq = 0

ipcRenderer.on('rpc:event', (_e, payload: { clientId: string; event: string; data: unknown }) => {
  handlers.get(payload.clientId)?.(payload.event, payload.data)
})

const api = {
  /** Platform of the main process (renderer has no Node). */
  platform: process.platform,
  /**
   * Call a sidecar method. `onEvent` receives progress/log events for this call only.
   * Pass your own `clientId` when you want to be able to `cancel(clientId)` while it runs.
   */
  call: async (method: string, params: Record<string, unknown> = {}, onEvent?: EventHandler, clientId?: string) => {
    const id = clientId ?? `c${++seq}`
    if (onEvent) handlers.set(id, onEvent)
    try { return await ipcRenderer.invoke('rpc', method, params, id) } finally { handlers.delete(id) }
  },
  /** Cancel the in-flight `call`/`depsEnsure` started with this clientId. Resolves true when something was running. */
  cancel: (clientId: string): Promise<boolean> => ipcRenderer.invoke('rpc:cancel', clientId),
  openProject: (root: string): Promise<OpenProjectReply> => ipcRenderer.invoke('project:open', root),
  peekProject: (root: string) => ipcRenderer.invoke('project:peek', root),
  /** 이 작업폴더에서는 판정 불가한 명령도 묻지 않는다(설정에서 되돌릴 수 있다). */
  trustProject: (root: string, on: boolean) => ipcRenderer.invoke('project:trust', root, on),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
  createProjectFolder: (title: string): Promise<{ result: { root: string } } | { error: { code: string; message: string } }> => ipcRenderer.invoke('project:create-folder', title),
  pickFile: (opts: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('file:pick', opts),
  /**
   * ‘폴더에서 보기’ — 메인이 지금 연 논문 폴더 안에 실제로 있는 경로인지 다시 확인한 뒤
   * 탐색기/Finder 에서 그 항목을 선택해 보여 준다. 폴더 밖·심링크로 밖을 가리키는 경로·
   * 없는 경로는 `{ error }` 로 거절한다. 앱이 파일을 실행하지는 않는다(GUI-12).
   */
  reveal: (path: string): Promise<{ result: true } | { error: { code: string; message: string } }> => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string): Promise<OpenFileReply> => ipcRenderer.invoke('shell:open', path),
  /**
   * 대화의 파일 단추 — 메인이 경로를 다시 확인한 뒤, 문서 형식이면 연결 프로그램으로 열고
   * 아니면 폴더에서 보여 준다. 폴더 밖·없는 파일은 error 로 돌아온다(화면은 결과물 시트로).
   */
  openFileLink: (path: string): Promise<OpenFileReply> => ipcRenderer.invoke('shell:open-link', path),
  /**
   * 폴더 열기 — `project`(지금 논문 폴더) 또는 `logs`(앱 로그 폴더)만. 경로를 넘기지 않으므로
   * 임의 폴더가 이 통로로 열리지 않는다. 그 폴더가 실행형 번들(`.app` 등)이면 열지 않고
   * `revealed: true` 로 보여 주기만 한다.
   */
  folderOpen: (kind: FolderKind): Promise<{ result: { revealed: boolean } } | { error: { code: string; message: string } }> => ipcRenderer.invoke('folder:open', kind),
  /** Read a previewable file (.pdf/.md/.txt) inside the project root → { result: Uint8Array } | { error }. */
  fileRead: (root: string, relPath: string) => ipcRenderer.invoke('file:read', root, relPath),
  /** Existence check inside the project root → { result: boolean }. Unlike fileRead, any extension. */
  fileExists: (root: string, relPath: string): Promise<{ result: boolean } | { error: { code: string; message: string } }> => ipcRenderer.invoke('file:exists', root, relPath),
  /** Copy a file inside the project root to a user-chosen location → { result: savedPath | null } | { error }. */
  fileSaveAs: (root: string, relPath: string) => ipcRenderer.invoke('file:save-as', root, relPath),
  windowInfo: () => ipcRenderer.invoke('window:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  sidecarInfo: () => ipcRenderer.invoke('sidecar:info'),
  sidecarRestart: () => ipcRenderer.invoke('sidecar:restart'),
  update: {
    status: (): Promise<UpdateReply<UpdateStatus>> => ipcRenderer.invoke('update:status'),
    check: (): Promise<UpdateReply<UpdateStatus>> => ipcRenderer.invoke('update:check'),
    install: (): Promise<UpdateReply<UpdateStatus>> => ipcRenderer.invoke('update:install'),
    select: (version: string | null): Promise<UpdateReply<UpdateStatus>> => ipcRenderer.invoke('update:select', version),
    rollback: (): Promise<UpdateReply<UpdateStatus>> => ipcRenderer.invoke('update:rollback'),
    cancel: (): Promise<UpdateReply<boolean>> => ipcRenderer.invoke('update:cancel'),
    onStatus: (fn: (status: UpdateStatus) => void) => subscribe('update:status', fn)
  },
  appUpdate: {
    status: (): Promise<UpdateReply<AppUpdateStatus>> => ipcRenderer.invoke('app-update:status'),
    check: (): Promise<UpdateReply<AppUpdateStatus>> => ipcRenderer.invoke('app-update:check'),
    install: (): Promise<UpdateReply<AppUpdateStatus>> => ipcRenderer.invoke('app-update:install'),
    openPage: (): Promise<UpdateReply<boolean>> => ipcRenderer.invoke('app-update:open-page'),
    cancel: (): Promise<UpdateReply<boolean>> => ipcRenderer.invoke('app-update:cancel'),
    onStatus: (fn: (status: AppUpdateStatus) => void) => subscribe('app-update:status', fn)
  },
  /** 앱 전용 Python 런타임(D7) — 상태·설치(진행 이벤트)·취소. */
  runtime: {
    status: (): Promise<{ result: RuntimeStatus }> => ipcRenderer.invoke('runtime:status'),
    install: async (onEvent?: EventHandler, clientId?: string): Promise<RpcResult<RuntimeInstallReply>> => {
      const id = clientId ?? `c${++seq}`
      if (onEvent) handlers.set(id, onEvent)
      try { return await ipcRenderer.invoke('runtime:install', id) } finally { handlers.delete(id) }
    },
    cancel: (): Promise<{ result: boolean }> => ipcRenderer.invoke('runtime:cancel')
  },
  depsEnsure: async (root: string, onEvent?: EventHandler, clientId?: string) => {
    const id = clientId ?? `c${++seq}`
    if (onEvent) handlers.set(id, onEvent)
    try { return await ipcRenderer.invoke('deps:ensure', root, id) } finally { handlers.delete(id) }
  },
  onMenu: (fn: (action: { type: string; root?: string; screen?: string }) => void) => {
    const listener = (_e: unknown, action: { type: string; root?: string; screen?: string }) => fn(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
  onAppQuitting: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('app:quitting', listener)
    return () => ipcRenderer.removeListener('app:quitting', listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  isDir: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:is-dir', p),
  agentStatus: (root: string | null) => ipcRenderer.invoke('agent:status', root),
  agentInstallSkill: (kind: 'claude' | 'codex', root: string | null) => ipcRenderer.invoke('agent:install-skill', kind, root),
  agentLaunch: (opts: { root: string; kind: 'claude' | 'codex'; revision: number | null }) => ipcRenderer.invoke('agent:launch', opts),
  /** Structured agent chat (Codex app-server). Every call resolves { result } or { error: {code,message} }. */
  chat: {
    snapshot: (root: string, provider: Provider) => ipcRenderer.invoke('chat:snapshot', root, provider),
    status: (root: string, provider: Provider) => statusOnce('chat:status', root, provider),
    draft: (root: string) => ipcRenderer.invoke('chat:draft', root),
    setDraft: (root: string, text: string, expected?: string) => ipcRenderer.invoke('chat:set-draft', root, text, expected),
    login: (root: string, provider: Provider) => ipcRenderer.invoke('chat:login', root, provider),
    send: (root: string, provider: Provider, text: string, requestId: string) => ipcRenderer.invoke('chat:send', root, provider, text, requestId),
    respond: (root: string, provider: Provider, id: string, allow: boolean) => ipcRenderer.invoke('chat:respond', root, provider, id, allow),
    stop: (root: string, provider: Provider) => ipcRenderer.invoke('chat:stop', root, provider),
    /**
     * 모델 칩의 뒷단 — 이 계정이 쓸 수 있는 모델과 지금 고른 값. 고른 값은 설정에 남고,
     * 다음 메시지의 `turn/start` 부터 같은 대화에 적용된다(같은 회사 모델끼리라 맥락이 안 끊긴다).
     */
    models: (root: string | null, provider: Provider): Promise<RpcResult<ChatModels>> => ipcRenderer.invoke('chat:models', root, provider),
    setModel: (root: string | null, provider: Provider, choice: ModelChoice | null): Promise<RpcResult<ModelChoice | null>> => ipcRenderer.invoke('chat:set-model', root, provider, choice)
  },
  /**
   * 폴더 없이 쓰는 연결 상태·로그인 — 첫 실행 화면(온보딩). 대화(root 있는 chat.*)와 달리
   * root 인자가 없다. 로그인 창을 다시 열거나 그만두는 경로도 여기에만 있다.
   */
  connect: {
    status: (provider: Provider) => statusOnce('connect:status', provider),
    login: (provider: Provider) => ipcRenderer.invoke('connect:login', provider),
    cancel: (provider: Provider) => ipcRenderer.invoke('connect:cancel', provider),
    reopen: (provider: Provider) => ipcRenderer.invoke('connect:reopen', provider)
  },
  /** Snapshot push from the main ChatService; returns an unsubscribe function. */
  onChatSnapshot: (fn: (snapshot: ChatSnapshot) => void) => {
    const listener = (_e: unknown, snapshot: ChatSnapshot) => fn(snapshot)
    ipcRenderer.on('chat:snapshot', listener)
    return () => ipcRenderer.removeListener('chat:snapshot', listener)
  },
  openGuide: (): Promise<boolean> => ipcRenderer.invoke('guide:open'),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  onSidecarLog: (fn: (entry: { stream: string; line: string }) => void) => {
    const listener = (_e: unknown, entry: { stream: string; line: string }) => fn(entry)
    ipcRenderer.on('sidecar:log', listener)
    return () => ipcRenderer.removeListener('sidecar:log', listener)
  }
}

contextBridge.exposeInMainWorld('knuaf', api)
export type KnuafApi = typeof api
