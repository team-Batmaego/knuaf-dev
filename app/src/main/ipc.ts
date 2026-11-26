import { FreeRelayError, providerEnv } from './free/provider'
import { providerOf } from './lanes/providers'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, systemPreferences } from 'electron'
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
import { probeProjectWritable } from './project-write'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { insideByFileId } from './file-identity'
// progress (v0.6.4 2단계): 진행 파일 IPC — 새 폴더 `main/progress/`, 채널 접두어 `progress:`.
import { registerProgressIpc } from './progress'
// link (v0.6.4 ⑤): 대화 속 http(s) 주소 열기 — 채널 하나(`link:open`), main이 주소를 다시 본다.
import { registerLinkIpc } from './links'
import { registerReleaseNotes } from './releaseNotes'
// paper-images (v0.6.4 사진 갈래): 종이 칸 그림 — 스킴(`knuaf-img:`) 처리기 하나. electron 값 import 없음.
import { createPaperImages } from './paper-images'
import type { PaperImages } from './paper-images'
// figures (v0.7 그림 갈래): 앱 전용 저장소·요청 감시를 여는 유일한 입구. 앱 상태는 전부 인자로 준다.
import { startFigureChannel } from './figures'
import type { FigureChannel } from './figures'
import type { Sidecar } from './sidecar'
import type { DependencyReport, Envelope, PreviewPayload, ProjectPeek, RpcResult, WindowInfo } from '../shared/types'
import type { ModelChoice, Provider } from '../shared/chat'
import { canonical } from './chat/jobs/isolation'
import { agentDepsVenv, APP_ROOT, basePython, bundledPython, depsEnvKey, depsRoot, venvPython, wheelhouseDir } from './python'
import { acquireEnvLock, discardUnmarked, markReady, readMark, restoreMark, trustedEnv } from './deps-env'
import { cancelRuntimeInstall, cleanupRuntime, installRuntime, runtimeStatus } from './runtime'
import { AgentToolLockError, agentApi, findExecutable, skillSource, type AgentCtx, type AgentKind } from './agent'
import { ChatService, type HandoffSeam } from './chat/service'
import { ClaudeRelayConnection } from './chat/claude'
import { CodexRelayConnection } from './chat/codex'
import { subscriptionEnv, type AgentOptions } from './chat/contracts'
import { ConversationHandoff } from './chat/jobs/conversation'
import { laneAccountProbe, type AccountProbe } from './lanes/accounts'
import { registerLaneHandlers } from './lanes/handlers'
import { consumePendingDesign, selectDesign } from './lanes/cards'
import { LanesHub, connectChanges } from './lanes/hub'
import { LANES_PUSH } from '../shared/lanes-ipc'
import { loadGuardKey } from './guard/key'
import { runtimeFromEnsureEnvelope } from './chat/kordocMcp'
import { withManagedKordoc } from './kordocRuntime'
import { openGuide } from './menu'
import { loadSettings, rememberRecent, saveSettings } from './settings'
import { APP_NAME } from '../shared/name'
import { hideAppDirs } from './hidden'
import { projectFolderName } from '../shared/project-folder'
import { updateConfig } from './update/keys'
// 302 이동은 전송 계층이 응답으로 돌려주고 허용 검사는 `boundedFetch` 가 한다(`net.fetch` manual 은 취소한다).
import { netRequestTransport } from './update/netTransport'
import { SkillStore } from './update/store'
import { SkillUpdates } from './update/service'
import { configureSkillSource } from './update/source'
import { skillSwitch } from './update/switch'
import { agentActivity, UpdateSuspendedError } from './update/activity'
import { AppUpdates } from './update/appService'
import { AppHandoff } from './update/handoff'
import { WindowsUpdateRuntime } from './update/windows'
import { checkDocxZip } from './docx-zip'
import { ensureSectionBaseline } from './review-baseline'
import { readDismissed, readNotices, writeDismissed } from './notices'
import { CHOICE_VALUES } from '../shared/notice'
import { diag, diagEnabled } from './diagLog'
import { createCallGate, SETTINGS_GET_DIAG_CALLS } from './diagLimits'

/** V8's Error cloning does not preserve custom fields; pause codes must cross IPC plainly. */
const ipcError = (error: unknown): unknown => error instanceof UpdateSuspendedError ? { code: error.code, message: error.message } : error

/** Chrome hints the renderer uses to lay out its title bar; also used by main when creating the window. */
export function windowInfo(): WindowInfo {
  const darwin = process.platform === 'darwin'
  let reduceTransparency = false
  if (darwin) {
    try { reduceTransparency = systemPreferences.accessibilityDisplayShouldReduceTransparency } catch { /* older Electron / headless */ }
  }
  return { platform: process.platform, vibrancy: darwin && !reduceTransparency, titleBarInset: darwin, overlay: !darwin }
}

/**
 * 그림 저장소 자리를 **동기로** 미리 만든다 — `figures/storage.ts` 의 `prepareHome` 과 같은 네 폴더.
 *
 * 왜 필요한가: 통로 쪽(`figures/index.ts`)은 이제 준비 실패를 스스로 삼키지만(I-03), 그때 그림은
 * **조용히 꺼진 채** 앱이 뜬다. 저장소 자리를 여기서 먼저 만들어 두면 흔한 실패(권한·경로)를 앱 시작
 * 시점에 알아채고 통로를 아예 열지 않을 수 있다. 뒤따르는 `prepareHome` 은 사실상 no-op 이 된다
 * (같은 자리에 `mkdir recursive` 는 무해하다).
 *
 * 남는 창은 "지금 만든 폴더를 곧바로 지울 수 없게 되는" 경우뿐이다 — 그때는 통로를 열지 않고
 * 끝나며 앱은 지금처럼 뜬다(그림만 꺼짐).
 */
function prepareFigureHome(figureHome: string): void {
  mkdirSync(figureHome, { recursive: true })
  for (const dir of ['res', 'store', 'choices', 'tmp']) mkdirSync(join(figureHome, dir), { recursive: true })
  // 마지막 확인: `prepareHome` 이 하는 일이 "`tmp` 를 지우고 다시 만들기"라, 폴더가 있다는 것만으로는
  // 부족하다(읽기 전용·남의 소유 폴더). 우리가 만든 임시 파일을 지워 그 권한을 실제로 확인한다.
  const probe = join(figureHome, 'tmp', `.probe-${process.pid}`)
  writeFileSync(probe, '')
  unlinkSync(probe)
}

/**
 * 폴더 표기를 realpath 로 푼다. 못 풀면 `null` — 그림 고리는 그 경로를 **쓰지 않는다**(건너뛴다).
 * 통로 쪽 폴더 해시(`figures/turn.ts`·`storage.ts`)와 같은 값을 쓰기 위한 유일한 정규화 지점이다.
 */
function realFolder(root: string | null): string | null {
  if (!root) return null
  try { return realpathSync(root) } catch { return null }
}

/** Read `<root>/project.json` without the sidecar; never throws. */
function peekProject(root: string): ProjectPeek {
  const out: ProjectPeek = { exists: false, hasProject: false, revision: null, project_id: null, mtime: null }
  try {
    if (!root || !existsSync(root)) return out
    out.exists = true
    const file = join(root, 'project.json')
    if (!existsSync(file)) return out
    out.hasProject = true
    out.mtime = statSync(file).mtimeMs
    const p = JSON.parse(readFileSync(file, 'utf-8')) as { revision?: unknown; project_id?: unknown }
    if (typeof p.revision === 'number') out.revision = p.revision
    if (typeof p.project_id === 'string') out.project_id = p.project_id
  } catch { /* unreadable or malformed: report what we know */ }
  return out
}

/** One level down: `root/<dir>/project.json` — a helper init in a wrong subfolder. */
/** 신뢰 목록의 열쇠 — 심링크와 한글 정규화 차이로 같은 폴더가 달리 보이지 않게. */
function trustKey(root: string): string {
  try { return realpathSync(root).normalize('NFC') } catch { return resolve(root).normalize('NFC') }
}

function findNestedProject(root: string): string | null {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'backups' && existsSync(join(root, e.name, 'project.json'))) return e.name
    }
  } catch { /* unreadable root: nothing to report */ }
  return null
}

/**
 * Every renderer request goes through here; the renderer never sees Node. Returns the services so index.ts can close them on quit.
 * `images`는 스킴 처리기다 — `index.ts`만 `protocol`을 알므로 등록도 거기서 한다(ipc는 electron을 값으로 더 잡지 않는다).
 * `figures`는 그림 통로다 — 열지 못했으면 `null`(앱은 그대로 뜨고 그림만 꺼진다).
 */
export function registerIpc(
  sidecar: Sidecar,
  win: () => BrowserWindow | null,
  onRecentsChanged: () => void = () => {},
  /**
   * 그림 통로를 열 것인가. **`index.ts`(앱 생명주기 소유자)만 `true` 를 준다.**
   *
   * 통로는 타이머(하트비트·폴더 확인)를 가진 서비스라, 열었으면 반드시 `stop()` 해야 한다. 그
   * 의무는 앱 종료 경로(`index.ts` 의 `figures.stop`)에 있다. 반면 대역 등록(단위 시험의 IPC
   * 하네스)은 종료 경로가 없어 `stop()` 을 부르지 않으므로, 여기서 통로를 열면 시험이 자기 임시
   * 폴더를 지운 뒤에도 타이머가 계속 돌아 **거절이 프로세스로 새어 나간다**. 그래서 기본값은
   * "열지 않음"이고, 여는 쪽이 자기 정리 의무를 명시한다.
   */
  runFigures = false
): { chat: ChatService; images: PaperImages; figures: FigureChannel | null; probe: AccountProbe } {
  let currentRoot: string | null = null
  // progress (v0.6.4 2단계): 진행 파일 IPC 등록 — main이 아는 `currentRoot`만 읽고 감시한다.
  const progress = registerProgressIpc(() => currentRoot, win, ipcMain)
  // link (v0.6.4 ⑤): 대화의 http(s) 주소 하나를 기본 브라우저로. 검사는 이 모듈 안에서 다시 한다.
  registerLinkIpc((url) => shell.openExternal(url), ipcMain)
  // paper-images (v0.6.4 사진 갈래): 그림 하나를 읽어 응답한다. 폴더 안 판정은 이 모듈이 다시 한다.
  const images = createPaperImages(() => currentRoot)
  /** `project:open` 요청 세대 — 늦게 성공한 옛 요청이 허용 기준을 되돌리지 않게. */
  let openSeq = 0
  /** Published visit survives failed open attempts; openSeq still rejects stale successes. */
  let currentVisit = 0
  /** renderer clientId → in-flight sidecar request, for `rpc:cancel` and the agent-busy gate. */
  const inflight = new Map<string, { id: string; method: string }>()
  const dependencyFlights = new Map<string, { clientId: string; cancelled: boolean; promise: Promise<RpcResult<Envelope>> }>()
  type DependencyGate = { root: string; visit: number; phase: 'checking' | 'ready' | 'blocked' }
  let dependencyGate: DependencyGate | null = null
  type DependencyDiagnosis = { gate: DependencyGate; cancelled: boolean }
  const dependencyDiagnoses = new Map<string, DependencyDiagnosis>()
  let latestDependencyCheck: DependencyDiagnosis | null = null
  const config = updateConfig(app.isPackaged)
  const store = new SkillStore(app.getPath('userData'), skillSource(APP_ROOT, app.isPackaged, process.resourcesPath), app.getVersion(), config.keys)
  try { store.cleanup() } catch (error) { console.error('[knuaf] 규칙집 보관 정리 실패', error) }
  configureSkillSource(() => store.resolveSkillSource())
  registerReleaseNotes(() => store.resolveSkillSource(), APP_ROOT, ipcMain, () => app.getVersion(), app.isPackaged)
  /**
   * figures (v0.7 그림 갈래): 그림 통로. `index.ts` 가 앱 시작에 한 번 열고 종료에 닫는다.
   *
   * 여기서 하는 일은 셋뿐이다 — 저장소 자리(`<userData>/figures`)를 만들고, 앱 상태를 **인자로**
   * 넘기고(`getFolder`·`resolveSkillSource`), 실패하면 통로를 **아예 만들지 않는다**. 마지막이
   * 요점이다: 그림은 대화의 조건이 아니므로, 열지 못하면 그림만 꺼지고 앱은 지금처럼 뜬다
   * (학생 화면에 오류·알림 없음). 자리 만들기를 먼저 하는 이유도 같다 — 저장소를 못 만들면
   * 통로를 열지 않고 끝나므로, 뒤늦게 터지는 쓰기 실패가 앱 시작 경로로 새지 않는다.
   */
  const figureHome = join(app.getPath('userData'), 'figures')
  const figures: FigureChannel | null = ((): FigureChannel | null => {
    if (!runFigures) return null
    try {
      prepareFigureHome(figureHome)
      return startFigureChannel({
        figureHome,
        /**
         * 계약은 **논문 폴더 realpath**다. `currentRoot` 는 `project:open` 이 받은 경로 그대로라
         * 심링크일 수 있으므로 여기서 푼다 — 못 풀면(열린 채 지워진 폴더) 그 경로를 그대로 주지 않고
         * `null` 을 돌려 통로를 닫는다. 폴더가 없으면 요청을 집을 곳도 없다.
         */
        getFolder: () => realFolder(currentRoot),
        resolveSkillSource: () => store.resolveSkillSource()
      })
    } catch (error) {
      // 규칙집 보관 정리 실패와 같은 모양으로 남긴다 — 앱은 계속 뜬다(그림만 꺼짐).
      console.error('[knuaf] 그림 통로를 열지 못했어요', error)
      return null
    }
  })()
  const updates = new SkillUpdates(store, {
    config, fetch: netRequestTransport,
    restartSidecar: () => sidecar.restart(),
    emit: status => win()?.webContents.send('update:status', status)
  })
  ipcMain.handle('update:status', () => ({ result: updates.status() }))
  ipcMain.handle('update:check', async () => ({ result: await updates.check() }))
  const updateResult = async (operation: () => Promise<unknown>): Promise<unknown> => {
    try { return { result: await operation() } }
    catch (error) { return { error: { code: 'update', message: error instanceof Error ? error.message : String(error) } } }
  }
  ipcMain.handle('update:install', () => updateResult(() => updates.install()))
  ipcMain.handle('update:select', (_e, version: string | null) => updateResult(() => updates.select(version)))
  ipcMain.handle('update:rollback', () => updateResult(() => updates.rollback()))
  ipcMain.handle('update:cancel', () => ({ result: updates.cancel() }))
  void updates.check()

  /**
   * The generic `rpc` channel forwards a method name and a params object straight
   * to the sidecar, so it is the one wide spot in an otherwise narrow preload API.
   * Params that name a program to execute are decided by main (see `deps:ensure`,
   * which calls the sidecar directly and is unaffected); a renderer value for them
   * is dropped rather than passed through as argv[0]. `timeout` is clamped so a
   * huge value cannot disable the sidecar's wall-clock kill.
   */
  // deps_venv: 실행할 의존성 환경(S-01) — main(Sidecar.call)만 정한다.
  const EXECUTABLE_PARAMS = ['base_python', 'node', 'pnpm', 'kordoc', 'deps_venv'] as const
  const MAX_TIMEOUT_SECONDS = 1800
  function sanitiseRpcParams(params: Record<string, unknown>): Record<string, unknown> {
    const out = { ...(params ?? {}) }
    for (const key of EXECUTABLE_PARAMS) delete out[key]
    if ('timeout' in out) {
      const n = Number(out.timeout)
      if (!Number.isFinite(n) || n <= 0) delete out.timeout
      else out.timeout = Math.min(n, MAX_TIMEOUT_SECONDS)
    }
    return out
  }

  const AGENT_BUSY_MESSAGE = 'AI 도우미가 작업 중이에요. 답변이 끝난 뒤 다시 시도해 주세요.'
  // chat is created below; handlers only run after registerIpc returns, so the closure is safe.
  const agentBusy = (root: string | null): boolean => !!root && chat.busy(root)

  ipcMain.handle('rpc', async (_e, method: string, rawParams: Record<string, unknown>, clientId: string) => {
    if (method === 'artifact.preview') return { error: { code: 'invalid_method', message: '미리보기는 preview:read 경로만 사용할 수 있어요.' } }
    // 선택은 `notices:choose` 만 — generic RPC 는 `params.root` 를 그대로 넘기므로(아래 `root`)
    // 화면이 고른 폴더와 다른 폴더에 학생 선택을 적을 수 있다. 그 문을 닫는다.
    // 확인(`notices.confirm`)도 정본 쓰기라 같은 좁은 문 하나뿐이다.
    if (method === 'notices.choose') return { error: { code: 'invalid_method', message: '알림 선택은 notices:choose 경로만 사용할 수 있어요.' } }
    if (method === 'notices.confirm') return { error: { code: 'invalid_method', message: '알림 확인은 notices:confirm 경로만 사용할 수 있어요.' } }
    const w = win()
    const params = sanitiseRpcParams(rawParams)
    const root = typeof params.root === 'string' ? params.root : currentRoot
    if (sidecar.isWrite(method) && agentBusy(root)) return { error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } }
    const diagnosis: DependencyDiagnosis | null = method === 'deps.doctor' && dependencyGate?.root === root
      ? { gate: dependencyGate, cancelled: false } : null
    let diagnosedPhase: 'ready' | 'blocked' = 'blocked'
    if (diagnosis) {
      dependencyDiagnoses.set(clientId, diagnosis)
      diagnosis.gate.phase = 'checking'
      // An install owns its whole check/install/recheck transaction, including concurrent reads.
      if (!dependencyFlights.has(root!)) latestDependencyCheck = diagnosis
    }
    try {
      const result = await sidecar.call(method, params, (event, data) => w?.webContents.send('rpc:event', { clientId, event, data }), (id) => {
        inflight.set(clientId, { id, method })
        if (diagnosis?.cancelled) sidecar.cancel(id)
      })
      if (diagnosis?.cancelled) throw { code: 'cancelled', message: '준비 상태 확인을 취소했어요.' }
      if (diagnosis) {
        const env = result as Envelope
        diagnosedPhase = env.ok && (env.data as DependencyReport | null)?.ready === true ? 'ready' : 'blocked'
      }
      return { result }
    } catch (error) {
      return { error: ipcError(error) }
    } finally {
      if (diagnosis) {
        if (dependencyDiagnoses.get(clientId) === diagnosis) dependencyDiagnoses.delete(clientId)
        if (dependencyGate && dependencyGate === diagnosis.gate && latestDependencyCheck === diagnosis && !dependencyFlights.has(root!)) {
          dependencyGate.phase = diagnosedPhase
        }
      }
      inflight.delete(clientId)
    }
  })

  ipcMain.handle('rpc:cancel', (_e, clientId: string) => {
    for (const flight of dependencyFlights.values()) if (flight.clientId === clientId) flight.cancelled = true
    const diagnosis = dependencyDiagnoses.get(clientId)
    if (diagnosis) diagnosis.cancelled = true
    const entry = inflight.get(clientId)
    if (entry) sidecar.cancel(entry.id)
    return !!entry || !!diagnosis
  })

  ipcMain.handle('project:open', async (_e, root: string) => {
    // 세대는 **요청이 도착한 순간** 올린다 — 존재 확인 실패로 일찍 돌아가는 요청도 renderer 의
    // 세대를 올리기 때문이다. 여기서 먼저 올리지 않으면, 늦게 성공한 앞 요청이 지금 화면의
    // 폴더와 다른 폴더를 허용 기준으로 삼는다(검토 ATTACH-R1-05 2차: B 진행 중 + 없는 C).
    const seq = ++openSeq
    if (!existsSync(root)) return { error: { code: 'not_found', message: '폴더가 없음: ' + root } }
    const settings = loadSettings()
    if (!settings.first_project_permission_asked_at) {
      if (process.platform === 'win32') {
        try { await probeProjectWritable(root) }
        catch (error) { return { error: { code: 'folder_not_writable', message: String(error) } } }
      }
      return { error: { code: 'first_project_permission_required', message: '첫 논문 폴더의 전역 권한 방식을 골라 주세요.' } }
    }
    try {
      const info = await sidecar.configure(root, settings.python_override)
      // 성공한 전환만 허용 기준을 바꾼다(검토 ATTACH-R1-05). 실패하면 이전 폴더가 그대로
      // 남아야 메인의 파일 검사 기준과 화면의 현재 폴더가 어긋나지 않는다. 늦게 성공한 옛
      // 요청(그사이 다른 열기가 시작됨)도 기준을 되돌리지 않는다.
      if (seq === openSeq) { currentRoot = root; currentVisit = seq; dependencyGate = { root, visit: seq, phase: 'checking' } }
      // progress (v0.6.4 2단계): 성공한 전환만 감시 대상을 바꾼다(이전 감시는 닫힌다).
      if (seq === openSeq) progress.follow(root)
      rememberRecent(root)
      onRecentsChanged()
      // 앱이 만든 작업 폴더는 윈도우 탐색기에서 숨긴다 — 학생에게는 자기 자료만 보이게(hidden.ts).
      hideAppDirs(root)
      const w = win()
      // 늦게 성공한 옛 요청은 창 제목도 바꾸지 않는다 — 화면(renderer)이 이미 버린 전환이다.
      if (w && seq === openSeq) {
        const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
        w.setTitle(`${name} — ${APP_NAME}`)
        if (process.platform === 'darwin') w.setRepresentedFilename(root)
      }
      const hasProject = existsSync(join(root, 'project.json'))
      // 도우미가 하위 폴더를 만들어 거기 init한 경우(knuaf-work 등): 조용히 빈 화면을
      // 보여 주는 대신 어디에 만들었는지 알려 준다.
      const nestedProject = hasProject ? null : findNestedProject(root)
      return { result: { root, hasProject, nestedProject, sidecar: info } }
    } catch (error) {
      // 실패한 **이 선택**의 python·kind 를 같이 돌려준다(PY-D1-03). renderer 의 store.sidecar 는
      // 성공 분기에서만 갱신되므로, 첫 실패에서 이전 프로젝트의 값으로 버튼을 판단하면 안 된다.
      return { error: ipcError(error), sidecar: sidecar.status(), startupFailed: true }
    }
  })

  ipcMain.handle('project:peek', (_e, root: string) => peekProject(root))

  ipcMain.handle('project:pick', async () => {
    const w = win()
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'], title: '논문 작업 폴더 선택' })
    if (r.canceled || r.filePaths.length === 0) return null
    const root = r.filePaths[0]
    return root
  })

  ipcMain.handle('file:pick', async (_e, opts: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => {
    const w = win()
    const r = await dialog.showOpenDialog(w!, { properties: ['openFile'], title: opts.title, filters: opts.filters, defaultPath: opts.defaultPath ?? currentRoot ?? undefined })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  /**
   * 학생이 누른 파일 링크·결과물 단추가 여는 **문서 형식** 목록(형님 확정 2026-11-03).
   * 확장자 하나로 판정하는 곳은 이 상수뿐이고, 판정은 **realpath 를 푼 실제 경로의 마지막
   * 확장자**로 한다. 이중 확장자는 마지막 것만 본다(`a.txt.exe` → 열지 않음, `a.exe.txt` →
   * 텍스트로 엶). PDF·이미지·텍스트는 읽기 전용 뷰어, DOCX/XLSX/HWPX/HWP 는 오피스 문서다.
   * 실행 파일·스크립트·바로가기는 여기에 넣지 않는다. **폴더는 여기로 열지 않는다** —
   * macOS 의 `.app` 처럼 디렉터리이면서 실행 번들인 것을 `openPath` 에 넘기면 실행 통로가
   * 된다(검토 ATTACH-R1-01). 폴더는 `folder:open` 의 메인 지정 경로로만 연다.
   */
  const OPENABLE_EXTS: Record<string, true> = {
    '.docx': true, '.xlsx': true, '.pdf': true, '.hwpx': true, '.hwp': true,
    '.md': true, '.txt': true, '.csv': true, '.png': true, '.jpg': true
  }

  /**
   * 파일을 열거나 보여 주기 전의 **마지막 관문**. 화면이 준 경로를 그대로 믿지 않는다 —
   * 대화 속 링크·도우미 출력에서 온 문자열이므로, 지금 열린 논문 폴더 안에 실제로 있는
   * 경로인지 메인에서 다시 확인한다.
   *
   * ① realpath 로 심링크·정션을 풀고 (없는 경로는 여기서 throw)
   * ② 포함 관계는 **파일 시스템 신원**(볼륨+파일 ID)으로 판정한다 — 경로 문자열을 NFC/소문자로
   *    정규화하지 않는다. 서로 다른 이름을 같은 이름으로 합치면 폴더 밖이 통과한다
   *    (검토 ATTACH-R1-02: 윈도우 `가` vs `가`, 대소문자 구분 디렉터리의 `proj` vs `PROJ`).
   * `..`·절대경로·다른 드라이브로 폴더 밖을 가리키는 경우는 realpath 결과가 밖이므로 거절된다.
   */
  const insideProject = (target: string): string | null => {
    if (!currentRoot || typeof target !== 'string' || !target) return null
    try {
      const rootReal = realpathSync(resolve(currentRoot))
      // 절대경로는 이 기준으로 다시 푼다 — base 가 심링크(/var → /private/var)여도 같은 규칙을 쓴다.
      const real = realpathSync(resolve(rootReal, target))
      return insideByFileId(rootReal, real) ? real : null
    } catch { return null }
  }
  /** Explain a rejected link without weakening the realpath + file-identity read gate. */
  const outsideProjectTarget = (target: string): boolean => {
    if (!currentRoot || typeof target !== 'string' || !target) return false
    let root: string
    try { root = realpathSync(resolve(currentRoot)) } catch { return false }
    let candidate = resolve(root, target)
    while (true) {
      try { return !insideByFileId(root, realpathSync(candidate)) }
      catch {
        const parent = dirname(candidate)
        if (parent === candidate) return false
        candidate = parent
      }
    }
  }

  /** 열어도 되는 **문서**인가 — 실제 파일이고 확장자가 위 목록에 있는지만 본다. */
  const openableDocument = (real: string): boolean => {
    try { return statSync(real).isFile() && OPENABLE_EXTS[extname(real).toLowerCase()] === true } catch { return false }
  }

  /**
   * 열기 응답을 기다린 **뒤** 대체 표시 직전의 재검사(검토 ATTACH-R1-03). 그사이 폴더가
   * 바뀌거나 파일이 교체됐으면 처음 검사한 경로와 달라진다 — 그러면 대체 표시도 하지 않는다.
   */
  const recheckOpen = (target: string, opened: string): string | null => {
    const again = insideProject(target)
    return again !== null && again === opened ? again : null
  }

  const changedError = { error: { code: 'changed', message: '파일 위치가 그사이 바뀌어 열지 않았어요.' } }

  /** 폴더에서 그 항목을 선택해 보여 주기만 한다 — 파일을 실행하지 않는다. */
  ipcMain.handle('shell:reveal', (_e, target: string) => {
    const real = insideProject(target)
    if (!real) return { error: { code: 'invalid_params', message: '논문 폴더 안에 실제로 있는 파일만 폴더에서 보여 줄 수 있어요.' } }
    shell.showItemInFolder(real)
    return { result: true }
  })

  /**
   * 연결 프로그램으로 열기(문서만). `openPath` 가 오류 문자열을 돌려주면 **재검사 뒤**
   * 폴더에서 보기로 대신하고 `reason:'open_failed'` 를 담는다. 그 문자열은 연결 프로그램
   * 부재만 뜻하지 않으므로(검토 ATTACH-R1-07) 화면은 원인을 단정하지 않는다.
   *
   * `reason:'extension'` 은 원래 열지 않는 형식. 폴더는 `not_openable` 오류다.
   */
  ipcMain.handle('shell:open', async (_e, target: string) => {
    const real = insideProject(target)
    if (!real) return { error: { code: 'invalid_params', message: '논문 폴더 안에 실제로 있는 파일만 열 수 있어요.' } }
    if (!openableDocument(real)) return { error: { code: 'not_openable', message: '앱에서 열지 않는 형식이에요. 폴더에서 볼 수 있어요.' } }
    const failure = await shell.openPath(real)
    if (!failure) return { result: { opened: true, revealed: false } }
    const again = recheckOpen(target, real)
    if (!again) return changedError
    shell.showItemInFolder(again)
    return { result: { opened: false, revealed: true, reason: 'open_failed' } }
  })

  /**
   * 대화의 파일 단추 — 열 수 있는 문서면 열고, 아니면(다른 확장자·폴더) 폴더에서 보여 준다.
   * 화면이 확장자로 판단하지 않는다(판단이 두 곳에 있으면 한 곳만 고쳐진다). 폴더 밖·없는
   * 파일은 error 로 돌려주고 화면은 결과물 시트로 간다.
   */
  ipcMain.handle('shell:open-link', async (_e, target: string) => {
    const real = insideProject(target)
    if (!real) return { error: { code: 'invalid_params', message: '논문 폴더 안에 실제로 있는 파일만 열 수 있어요.' } }
    if (!openableDocument(real)) {
      shell.showItemInFolder(real)
      return { result: { opened: false, revealed: true, reason: 'extension' } }
    }
    const failure = await shell.openPath(real)
    if (!failure) return { result: { opened: true, revealed: false } }
    const again = recheckOpen(target, real)
    if (!again) return changedError
    shell.showItemInFolder(again)
    return { result: { opened: false, revealed: true, reason: 'open_failed' } }
  })

  /**
   * 실행형 번들인가 — macOS 앱 번들은 파일 시스템에서 **디렉터리**이고, `openPath` 에 넘기면
   * LaunchServices 가 실행할 수 있다. 확장자뿐 아니라 `Contents/Info.plist` 구조도 본다
   * (번들 구조를 다른 이름으로 둔 경우). 이 판정은 폴더 열기 통로에서만 쓴다.
   */
  const executableBundle = (real: string): boolean => {
    if (/\.app$/i.test(real)) return true
    try { return existsSync(join(real, 'Contents', 'Info.plist')) } catch { return false }
  }

  /**
   * 폴더 열기 — **메인이 정한 폴더만**. 화면은 경로를 주지 않고 이름만 준다. 임의 외부 경로가
   * 이 통로로 들어올 수는 없지만, 그 폴더 자체가 실행형 번들일 수는 있다(사용자가 `.app` 을
   * 논문 폴더로 고른 경우). 그래서 열기 전에 번들인지 보고, 번들이면 `openPath` 대신
   * `showItemInFolder` 로 보여 주기만 한다(ATTACH-R1-01 2차).
   * `project`: 지금 열린 논문 폴더(내용이 열린다 — ATTACH-R1-06). `logs`: 앱 로그 폴더.
   */
  ipcMain.handle('folder:open', async (_e, kind: string) => {
    const target = kind === 'project' ? currentRoot : kind === 'logs' ? app.getPath('logs') : null
    if (!target) return { error: { code: 'not_found', message: '열 폴더가 없어요. 논문을 먼저 열어 주세요.' } }
    try {
      // 로그 폴더는 앱이 만든다 — 처음 열 때 없을 수 있다.
      mkdirSync(target, { recursive: true })
      const real = realpathSync(target)
      if (!statSync(real).isDirectory()) return { error: { code: 'not_found', message: '폴더가 아니에요.' } }
      if (executableBundle(real)) {
        shell.showItemInFolder(real)
        return { result: { revealed: true } }
      }
      const failure = await shell.openPath(real)
      return failure ? { error: { code: 'open_failed', message: failure } } : { result: { revealed: false } }
    } catch (error) {
      return { error: { code: 'not_found', message: String(error instanceof Error ? error.message : error) } }
    }
  })

  /** Resolve relPath inside root; anything escaping the project folder is refused. */
  const insideRoot = (root: string, relPath: string): string | null => {
    if (typeof root !== 'string' || !root || typeof relPath !== 'string' || !relPath) return null
    const base = resolve(root)
    const p = resolve(base, relPath)
    // NFC/NFD: macOS 는 파일명을 NFD 로 주고 사람·모델이 쓴 경로는 NFC 다.
    // 정규화하지 않으면 폴더 안의 한글 경로가 거부된다(claude.ts outsideRoot 와 같은 이유).
    const n = (x: string) => x.normalize('NFC')
    if (n(p) !== n(base) && !n(p).startsWith(n(base) + sep)) return null
    return p
  }

  // Match a requested path against its supplied project root before exposing existence.
  ipcMain.handle('file:exists', (_e, root: string, relPath: string) => {
    const p = insideRoot(root, relPath)
    return { result: !!p && existsSync(p) }
  })
  ipcMain.handle('review:ensure-baseline', (_e, root: unknown, sectionId: unknown, draft: unknown) => {
    if (typeof root !== 'string' || root !== currentRoot) {
      return { error: { code: 'project_mismatch', message: '열린 논문 폴더가 바뀌었어요.' } }
    }
    if (typeof sectionId !== 'string' || typeof draft !== 'string') {
      return { error: { code: 'invalid_params', message: '비교 기준 인자가 올바르지 않습니다.' } }
    }
    try {
      return { result: ensureSectionBaseline(root, sectionId, draft) }
    } catch (error) {
      return { error: { code: 'review_baseline', message: error instanceof Error ? error.message : String(error) } }
    }
  })
  const PREVIEW_TEXT_MAX = 200 * 1024
  const PREVIEW_PDF_MAX = 50 * 1024 * 1024
  const PREVIEW_IMAGE_MAX = 20 * 1024 * 1024
  const PREVIEW_DOCX_MAX = 15 * 1024 * 1024
  const readPreviewFile = (path: string, limit: number, truncate = false): { size: number; bytes: Buffer } => {
    const fd = openSync(path, 'r')
    try {
      const opened = fstatSync(fd)
      const current = statSync(path)
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('Preview target changed while opening')
      const size = opened.size
      if (size > limit && !truncate) return { size, bytes: Buffer.alloc(0) }
      const amount = Math.min(size, limit)
      const bytes = Buffer.allocUnsafe(amount)
      let read = 0
      while (read < amount) {
        const n = readSync(fd, bytes, read, amount - read, read)
        if (n === 0) break
        read += n
      }
      return { size, bytes: bytes.subarray(0, read) }
    } finally { closeSync(fd) }
  }

  ipcMain.handle('preview:read', async (_e, target: string): Promise<{ result: PreviewPayload } | { error: { code: string; message: string } }> => {
    const rootAtStart = currentRoot
    const real = insideProject(target)
    if (!real) return outsideProjectTarget(target)
      ? { error: { code: 'outside_project', message: '이 논문 폴더 밖의 파일은 열 수 없어요.' } }
      : { error: { code: 'not_found', message: '파일을 찾지 못했어요.' } }
    const name = basename(real)
    if (!openableDocument(real)) {
      const ext = extname(real).toLowerCase()
      try {
        if (!statSync(real).isFile()) return { error: { code: 'not_openable', message: '폴더는 미리볼 수 없어요.' } }
      } catch { return { error: { code: 'not_found', message: '파일을 찾지 못했어요.' } } }
      return { result: { kind: 'unsupported', name, ext: extname(real).toLowerCase(), openable: false } }
    }
    const ext = extname(real).toLowerCase()
    let size: number
    try { size = statSync(real).size } catch { return { error: { code: 'not_found', message: '파일을 찾지 못했어요.' } } }
    const tooLarge = (limit: number, actualSize = size): { result: PreviewPayload } => ({ result: { kind: 'too_large', name, ext, bytes: actualSize, limit } })
    let result: PreviewPayload
    try {
      if (ext === '.hwpx' || ext === '.hwp') result = { kind: 'unsupported', name, ext, openable: true }
      else if (ext === '.md' || ext === '.txt' || ext === '.csv') {
        const input = readPreviewFile(real, PREVIEW_TEXT_MAX, true)
        const text = new TextDecoder('utf-8').decode(input.bytes, { stream: input.size > input.bytes.length })
        result = input.size === 0 ? { kind: 'empty', name } : { kind: 'text', name, ext, text, truncated: input.size > input.bytes.length }
      } else if (ext === '.xlsx') {
        const input = readPreviewFile(real, PREVIEW_PDF_MAX)
        if (input.size > PREVIEW_PDF_MAX) return tooLarge(PREVIEW_PDF_MAX, input.size)
        const checked = checkDocxZip(input.bytes)
        if (!checked.ok) result = { kind: 'preview_error', name, ext, reason: checked.reason }
        else {
          const root = rootAtStart
          if (!root) return { error: { code: 'not_found', message: '열린 논문 폴더가 없어요.' } }
          const rootReal = realpathSync(root)
          const rel = relative(rootReal, real)
          const preview = await sidecar.call<Omit<Extract<PreviewPayload, { kind: 'xlsx' }>, 'name'> | Omit<Extract<PreviewPayload, { kind: 'unavailable' }>, 'name'>>('artifact.preview', { root: rootReal, path: rel })
          if (currentRoot !== rootAtStart || !recheckOpen(target, real)) return changedError
          result = { ...preview, name }
        }
      } else if (ext === '.pdf') {
        const input = readPreviewFile(real, PREVIEW_PDF_MAX)
        if (input.size > PREVIEW_PDF_MAX) return tooLarge(PREVIEW_PDF_MAX, input.size)
        result = { kind: 'pdf', name, bytes: input.bytes }
      } else if (ext === '.png' || ext === '.jpg') {
        const input = readPreviewFile(real, PREVIEW_IMAGE_MAX)
        if (input.size > PREVIEW_IMAGE_MAX) return tooLarge(PREVIEW_IMAGE_MAX, input.size)
        if (input.size === 0) result = { kind: 'empty', name }
        else {
          const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
          result = { kind: 'image', name, mime, dataUrl: `data:${mime};base64,${input.bytes.toString('base64')}` }
        }
      } else if (ext === '.docx') {
        const input = readPreviewFile(real, PREVIEW_DOCX_MAX)
        if (input.size === 0) result = { kind: 'empty', name }
        else if (input.size > PREVIEW_DOCX_MAX) return tooLarge(PREVIEW_DOCX_MAX, input.size)
        else {
          const checked = checkDocxZip(input.bytes)
          if (!checked.ok) result = { kind: 'preview_error', name, ext, reason: checked.reason }
          else result = { kind: 'docx', name, bytes: input.bytes }
        }
      } else result = { kind: 'unsupported', name, ext, openable: false }
    } catch (error) {
      return { error: { code: 'preview_read', message: String(error instanceof Error ? error.message : error) } }
    }
    if (currentRoot !== rootAtStart || !recheckOpen(target, real)) return changedError
    return { result }
  })


  ipcMain.handle('file:save-as', async (_e, root: string, relPath: string) => {
    const p = insideRoot(root, relPath)
    if (!p) return { error: { code: 'invalid_params', message: '작업 폴더 밖 경로는 저장할 수 없어요: ' + String(relPath) } }
    const w = win()
    const r = await dialog.showSaveDialog(w!, { defaultPath: basename(p), title: '다른 이름으로 저장' })
    if (r.canceled || !r.filePath) return { result: null }
    try {
      copyFileSync(p, r.filePath)
      return { result: r.filePath }
    } catch (error) {
      return { error: { code: 'internal', message: String(error instanceof Error ? error.message : error) } }
    }
  })

  ipcMain.handle('window:info', () => windowInfo())

  // 설정 읽기 진단은 **첫 몇 번만** 남긴다(검토 I-01) — 설정 화면은 이 핸들러를 여러 번 부르고,
  // 그때마다 같은 줄을 동기로 쓰면 이득 없이 main 스레드만 막는다.
  const settingsGetDiag = createCallGate(SETTINGS_GET_DIAG_CALLS)
  ipcMain.handle('settings:get', () => {
    if (!diagEnabled() || !settingsGetDiag()) return loadSettings()
    const started = Date.now()
    diag('startup:settings-get:start')
    try {
      const settings = loadSettings()
      diag(`startup:settings-get:done elapsed=${Date.now() - started}ms`)
      return settings
    } catch (error) {
      diag(`startup:settings-get:error elapsed=${Date.now() - started}ms`)
      throw error
    }
  })
  ipcMain.handle('settings:set', async (_e, patch) => {
    const provider = patch?.provider_choice?.provider
    const root = currentRoot
    const visit = currentVisit
    const assertCurrent = (): void => {
      if (currentRoot !== root || currentVisit !== visit) throw new Error('논문 폴더가 바뀌어 주 모델을 바꾸지 않았어요.')
    }
    if (root && provider && provider !== loadSettings().provider_choice?.provider) {
      await consumePendingDesign(chat.lanesStore(), root, provider, async pending => {
        assertCurrent()
        if (!pending.model) throw new Error('예약 모델이 없어요.')
        await chat.setModel(root, provider, { model: pending.model, effort: pending.effort }, assertCurrent)
        assertCurrent()
      })
      assertCurrent()
    }
    const s = saveSettings(patch); onRecentsChanged(); return s
  })
  const agentCtx = (): AgentCtx => ({
    home: app.getPath('home'), appRoot: APP_ROOT, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    supportDir: join(app.getPath('userData'), 'launch'), userData: app.getPath('userData'),
    dryRun: process.env.KNUAF_DRY_LAUNCH === '1',
    open: (p) => shell.openPath(p), venvPython, depsVenv: agentDepsVenv, bundledPython
  })
  ipcMain.handle('agent:status', async (_e, root: string | null) => { try { return { result: await agentApi.status(agentCtx(), root ?? currentRoot) } } catch (error) { return { error: { code: error instanceof UpdateSuspendedError ? error.code : 'internal', message: String(error) } } } })
  ipcMain.handle('agent:install-skill', (_e, kind: AgentKind, root: string | null) => {
    let release: (() => void) | undefined
    try { agentActivity.ensureActive(); release = skillSwitch.enter(); return { result: agentApi.installSkill(agentCtx(), kind, root ?? currentRoot) } }
    catch (error) { return { error: { code: error instanceof UpdateSuspendedError ? error.code : 'internal', message: String(error) } } }
    finally { release?.() }
  })
  ipcMain.handle('agent:launch', async (_e, opts: { root: string; kind: AgentKind; revision: number | null }) => {
    try {
      agentActivity.ensureActive()
      const { install, launched } = await skillSwitch.run(async () => {
        const install = agentApi.installSkill(agentCtx(), opts.kind, opts.root ?? currentRoot)
        const launched = await agentApi.launch(agentCtx(), opts)
        return { install, launched }
      })
      return { result: { ...launched, install } }
    } catch (error) {
      // 거부 글은 학생에게 그대로 보이는 문장이다 — `Error: ` 접두사를 붙이지 않는다.
      if (error instanceof AgentToolLockError) return { error: { code: error.code, message: error.message } }
      const code = error instanceof UpdateSuspendedError ? error.code : 'internal'
      return { error: { code, message: String(error) } }
    }
  })

  /**
   * 담당(relay) 연결의 엔진 옵션 — 본대화 연결과 **같은 환경·실행 파일**을 쓰고, 스킬 경로만
   * 주문서가 준 폴더다(엔진이 `SKILL.md` 를 붙인다). 격리 판정은 `request.isolation` 이 정본이다.
   */
  const relayOptions = (company: Provider, root: string): AgentOptions => {
    providerOf(company)
    const binary = findExecutable(company === 'free' ? 'codex' : company)
    if (!binary) throw new Error(`${company !== 'claude' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 설치 안내를 열어 주세요.`)
    // 본대화와 같은 PATH 앞자리(앱 데이터 의존성 환경 → 번들 CPython) — 담당이 도우미와 같은
    // 인터프리터를 찾아야 스킬 스크립트가 같은 결과를 낸다.
    const python = venvPython(currentRoot) ?? bundledPython()
    return {
      binary,
      root,
      skill: '',
      env: providerEnv(company, subscriptionEnv(python ? [dirname(python)] : [], agentDepsVenv())),
      openExternal: (url) => shell.openExternal(url)
    }
  }
  // 계정 값은 엔진과 같은 생산자로 읽는다 — 추측값을 만들면 러너의 지문 대조에서 모든 주문이
  // `rejected` 로 닫힌다. 모델 호출은 없다(초기화 왕복 한 번).
  const probeAccount = laneAccountProbe({
    appDir: join(app.getPath('userData'), 'relay'),
    env: () => subscriptionEnv(),
    openExternal: (url) => shell.openExternal(url),
    binary: company => findExecutable(providerOf(company) === 'free' ? 'codex' : company)
  })
  /**
   * §4 본대화 인계 — 앱이 쥔 `ConversationHandoff` 하나. 새 대화 열기·닫기는 `chat` 이 알고
   * (그 폴더·회사의 대화 칸을 실제로 비우고 첫 차례를 보낸다), 묶음을 짓는 일은 인계 인스턴스가 한다.
   */
  const handoffSeam: HandoffSeam = new ConversationHandoff({
    stateDir: join(app.getPath('userData'), 'handoff'),
    // 앱이 만드는 묶음의 상한 — 넘치면 정해진 순서로 줄이고 `trimmed` 로 알린다.
    maxBytes: 24_000,
    // §0-5 4번 — 누르기 **전** 제안 판정은 실행당 회사당 1회만 읽는다(§5). `chat` 은 이 줄보다
    // 뒤에 서므로 콜백 안에서 늦게 부른다(호출 시점엔 이미 서 있다).
    // 누르는 순간은 다르다 — 그때는 **매번 새로** 읽어야 같은 세대의 계정 교체를 잡는다(REVIEW-C4 I-01).
    account: {
      propose: company => chat.laneAccount(company, { once: true }),
      click: company => chat.laneAccount(company, { fresh: true })
    },
    // §1-4 ① — `usage:'unknown'` 이어도 넘겨 볼 대상. 앱의 담당 연결 중 첫 턴 안 확인을
    // 실제로 하는 것은 Claude 쪽뿐이다(`claude.ts` `ClaudeRelayConnection.gateInTurn`) —
    // Codex 는 그 선언이 없어 `unknown` 이면 단추를 띄우지 않는다(안전 기본값).
    gateInTurn: company => company === 'claude',
    open: request => chat.openHandoff(request),
    close: owner => chat.closeHandoff(owner),
    prepareActivation: async (_old, _owner) => () => {},
    beginTransition: root => chat.beginOwnerTransition(root),
    audit: record => console.error('[knuaf] handoff', JSON.stringify(record)),
    // 앱의 대화 정체성은 (폴더, 회사) 하나다 — 넘겨받는 대화 id 도 같은 규칙으로 짓는다.
    mintId: (root, company) => `${company}\0${root}`
  })
  let activeMainCompany: Provider = loadSettings().provider_choice?.provider ?? (loadSettings().helper_mode === 'codex-chat' ? 'codex' : 'claude')
  /** `lanes:changed` 송신기 — `chat` 이 선 뒤에 만든다(저장소·러너를 그때 읽는다). */
  let lanesHub: LanesHub | null = null

  const chat = new ChatService({
    skillSource: () => skillSource(APP_ROOT, app.isPackaged, process.resourcesPath),
    userData: app.getPath('userData'),
    /**
     * figures (v0.7 그림 갈래): 통로의 고리 넷을 그대로 넘긴다. 통로를 못 열었으면 `undefined` —
     * 그러면 `ChatService` 는 지금까지와 같은 객체를 쓰고 env 도 손대지 않는다(바이트까지 동일).
     *
     * `env` 는 규칙집이 읽는 이름 **둘뿐**이다(`CONTRACT.md` §1). `KNUAF_GUI` 는 앱 밖과 앱 안의
     * 선택 규칙이 다르기 때문에 필요하고(§4: 앱 안은 앱 기록 학생 메시지가 정확히 X 여야 한다),
     * `KNUAF_FIGURE_HOME` 은 저장소 자리다. 지금 판(규칙집 v0.4.10)에는 이 이름을 읽는 코드도
     * 그림 명령도 없으므로, 이 두 값은 그냥 환경에 얹혀 아무 일도 일으키지 않는다.
     */
    figures: figures ? {
      env: { KNUAF_GUI: '1', KNUAF_FIGURE_HOME: figureHome },
      /**
       * `ChatService` 가 넘기는 `root` 는 `send` 의 인자 = `currentRoot` 그대로라 **심링크일 수 있다**.
       * 반면 통로의 `getFolder` 는 realpath 를 주고, 감시자·후보표는 그 값으로 폴더를 가른다
       * (`turn.json` 의 `folder`, `choices/<해시>`). 여기서 풀지 않으면 턴 파일과 감시자가 다른 폴더를
       * 가리켜, 방금 연 턴의 요청이 전부 `stale` 이 된다. 그래서 고리에 넘기기 전에 풀고,
       * 못 풀면(열린 채 지워진 폴더) 그 고리는 **건너뛴다** — 없는 폴더로 턴을 열지 않는다.
       */
      beginTurn: (root, turnId) => {
        const real = realFolder(root)
        return real === null ? Promise.resolve() : figures.beginTurn(real, turnId)
      },
      endTurn: (turnId) => figures.endTurn(turnId),
      recordStudentMessage: (root, text) => {
        const real = realFolder(root)
        return real === null ? Promise.resolve(0) : figures.recordStudentMessage(real, text)
      }
    } : undefined,
    // 지킴이 무결성 열쇠(§4.3). OS 보관소(`safeStorage`)를 못 쓰면 `null` — 지킴이는 꺼지고
    // Codex 연결은 종전 경로 그대로 돈다. 열쇠를 꺼내는 일은 앱 시작 때 한 번뿐이다.
    guardKey: loadGuardKey(app.getPath('userData'), safeStorage),
    emit: (s) => win()?.webContents.send('chat:snapshot', s),
    openExternal: (url) => shell.openExternal(url),
    // The reverse gate: while the app holds a write transaction, agent sends must wait.
    sidecarBusy: () => {
      if ((dependencyGate?.root === currentRoot && dependencyGate.phase !== 'ready') || dependencyFlights.size > 0) return true
      for (const diagnosis of dependencyDiagnoses.values()) if (diagnosis.gate === dependencyGate) return true
      for (const entry of inflight.values()) if (sidecar.isWrite(entry.method)) return true
      return false
    },
    // 폴더의 첫 전송에서만 kordoc 런타임을 확인한다(설계 §3.2). 앱이 직접 받아 둔 덩어리
    // (`kordocRuntime.ts`)가 있으면 그 실행 사양을 쓰고, 사이드카는 부르지 않는다.
    // 명세가 이 PC의 대상을 열거하지 않았을 때(윈도 ARM 등)만 옛 길(`kordoc.ensure`)로 간다 —
    // 거기서 `node_path` 가 없으면 추측하지 않고 미부착(null)이고, 대화는 MCP 없이 그대로 간다.
    // 명세 자체가 깨졌으면 옛 길도 열지 않는다(해시 고정 없는 길을 조용히 만들지 않으려는 것, §5.2).
    ensureKordoc: withManagedKordoc(async (root) => {
      const envelope = await sidecar.call<Envelope>('kordoc.ensure', { root })
      const node = (envelope.data as { node_path?: unknown } | null | undefined)?.node_path
      return typeof node === 'string' && node ? runtimeFromEnsureEnvelope(envelope, node) : null
    }),
    // 도우미에게도 앱 데이터 의존성 환경과 번들 인터프리터를 건넨다 — Homebrew 없는 맥에서 막히지 않게.
    venvPython,
    depsVenv: agentDepsVenv,
    bundledPython,
    // 전역 기본이 '묻지 않기'면 폴더를 가리지 않는다. 'ask' 로 되돌려도 학생이 권한 카드에서
    // 직접 "이 폴더에서는 계속 허용"을 누른 폴더는 그대로 산다 — 받은 답을 무르지 않는다.
    // loadSettings 를 호출할 때마다 새로 읽으므로 설정을 바꾸면 다음 도구 호출부터 반영된다.
    isTrusted: (root) => {
      const s = loadSettings()
      return s.permission_mode === 'trust' || (s.trusted_roots ?? []).includes(trustKey(root))
    },
    // 고른 모델은 설정에 남는다(대화 파일 형식은 그대로). 전송할 때마다 새로 읽으므로
    // 칩에서 바꾼 값이 다음 메시지부터 적용된다.
    modelChoice: (provider) => loadSettings().chat_models?.[provider] ?? null,
    // "고른 적 있음"은 설정에 그 공급자 키가 있는지로 판정한다. 키가 없으면(처음부터 안 고름)
    // 기본값 조회·복귀 확인을 하지 않아, 요청이 지금까지와 똑같이 나간다(검토 L-02).
    modelChosen: (provider) => {
      const m = loadSettings().chat_models
      return !!m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, provider)
    },
    // 고른 값은 설정에 남는다(대화 파일 형식은 그대로). 저장 위치를 서비스가 정하는 이유는
    // 선택의 선후를 한 곳에서 지키기 위해서다(검토 MC1-03).
    storeModelChoice: (provider, choice) => {
      saveSettings({ chat_models: { ...(loadSettings().chat_models ?? {}), [provider]: choice } })
    },
    // ---- 배선 C: 담당(relay) 이음매 -------------------------------------------------
    //
    // 이 넷이 없으면 `runnerFor()` 가 `undefined` 라 담당이 **아예 돌지 않는다**(배선 B 가
    // 남긴 구멍). 격리·격리 확인은 엔진(C3)이 하고, 여기서는 실제 연결만 고른다.
    jobConnectionFactory: request => request.company === 'claude'
      ? new ClaudeRelayConnection(
        relayOptions(request.company, request.cwd), request, join(app.getPath('userData'), 'relay')
      )
      : new CodexRelayConnection(relayOptions(request.company, request.cwd), request),
    // 앱 값과 엔진 `availability()` 의 지문이 같아야 주문이 열린다 — 계정은 엔진과 같은
    // 생산자(`lanes/accounts.ts`)로 읽고, 동의만 앱 저장소 값으로 덮는다(service 가 한다).
    jobAccount: (company, options) => options?.once
      ? probeAccount.once(company, options.once.epoch)
      : probeAccount(company, options),
    // 셸 격리는 OS 샌드박스를 실제로 걸 수 있는 플랫폼만 — 맥·리눅스. 윈도우는 아직 검증이
    // 없으므로 Bash 를 빼는 쪽(보수적)이다(발주 §③ "실기기 검증 없음").
    jobShellSandboxAvailable: process.platform !== 'win32',
    // [C1-10] 중단·전환은 **실제 인계 제안**을 무효화해야 한다 — 묶음 다시 짓기만으로는
    // 열린 제안·진행 예약이 살아 있다. 보관된 대화(`consumed`)는 그대로 둔다.
    invalidateHandoff: root => { handoffSeam.invalidateRoot(canonical(root)); lanesHub?.touch(root) },
    handoff: handoffSeam
  })
  lanesHub = new LanesHub({
    store: chat.lanesStore(),
    // 러너 이음매가 없으면(담당 기능이 꺼져 있으면) 줄 집합도 비운다.
    runner: chat.lanesRunner(),
    // 설정 변경 뒤에도 설계는 현재 본대화 회사를 읽는다.
    get mainCompany() { return loadSettings().provider_choice?.provider ?? activeMainCompany },
    designChoice: () => loadSettings().chat_models?.[loadSettings().provider_choice?.provider ?? activeMainCompany] ?? { model: null, effort: null },
    account: company => chat.laneAccount(company),
    archives: root => chat.handoffArchives(root),
    extraLines: root => chat.handoffLines(root)
  }, snapshot => win()?.webContents.send(LANES_PUSH.snapshot, snapshot),
  record => console.error('[knuaf] lanes', JSON.stringify(record)))
  // [C1-14] 저장소·러너의 **실제** 변경(비동기 완료·한도·전달·기록 줄)이 화면 묶음으로 간다.
  // 지금은 IPC 요청 반환에서만 밀어 보내서, 이어 하기·재시도 뒤의 결과가 저절로 안 떴다.
  connectChanges(lanesHub, [chat.lanesStore(), ...(chat.lanesRunner() ? [chat.lanesRunner()!] : [])])
  /**
   * §3·§4·§5 화면 요청 22개 — 계약 채널 이름 그대로. 상태를 바꾼 요청은 끝나면 묶음을 다시 민다.
   * 설계 회사 전환(`applyDesign`)은 앱의 **모델 칩**을 다시 쓴다(정본 §3.1 D2-03, DESIGN:502) —
   * 칩이 실제로 바뀌었을 때만 `true` 를 돌려주므로 "바뀌지 않았는데 적용됨" 이 나오지 않는다.
   */
  registerLaneHandlers({
    ipc: ipcMain,
    hub: lanesHub,
    store: chat.lanesStore(),
    runner: chat.lanesRunner(),
    account: company => chat.laneAccount(company),
    // [C1-06] 적용 직전 대조는 캐시를 건너뛴 관측 — 15초 전 값이면 계정이 바뀐 걸 못 본다.
    // 배치 저장도 대화 넘기기와 같은 사용량 관문 — Claude 는 턴 밖 사용량을 못 읽어 늘 unknown 이다.
    gateInTurn: company => company === 'claude',
    freshAccount: company => chat.laneAccount(company, { fresh: true }),
    // [C1-08] 화면이 보낸 폴더가 아니라 **main 이 열어 둔 폴더**만 통과시킨다.
    allowed: folder => {
      if (!currentRoot) return false
      try { return canonical(currentRoot) === folder } catch { return false }
    },
    get mainCompany() { return loadSettings().provider_choice?.provider ?? activeMainCompany },
    designChoice: () => loadSettings().chat_models?.[loadSettings().provider_choice?.provider ?? activeMainCompany] ?? { model: null, effort: null },
    applyDesign: async (root, design) => {
      const before = loadSettings().chat_models?.[design.company] ?? null
      if (!design.model) return false
      await chat.setModel(root, design.company, { model: design.model, effort: design.effort })
      const after = loadSettings().chat_models?.[design.company] ?? null
      return Boolean(after && after.model === design.model)
        && !(before && before.model === design.model && before.effort === design.effort)
    },
    setConsent: (company, accountId, on) => chat.setConsent(company, accountId, on),
    handoff: {
      continue: (root, proposalId) => chat.handoffContinue(root, proposalId),
      later: (root, proposalId) => chat.handoffLater(root, proposalId),
      archives: root => chat.handoffArchives(root),
      archive: (root, archiveId) => chat.handoffArchive(root, archiveId)
    },
    jobs: {
      stopOne: (root, jobId) => chat.stopJob(root, jobId),
      continue: (root, proposalId) => chat.continueProposal(root, proposalId),
      later: (root, proposalId) => chat.laterProposal(root, proposalId),
      retry: (root, jobId) => chat.retryJob(root, jobId),
      discard: (root, jobId) => chat.discardJob(root, jobId),
      redeliver: (root, jobId) => chat.redeliver(root, jobId),
      authLater: (root, jobId) => chat.authLater(root, jobId),
      deliveryText: (root, jobId) => chat.deliveryTextOf(root, jobId)
    },
    diagnostic: record => console.error('[knuaf] lanes', JSON.stringify(record))
  })
  const windows = new WindowsUpdateRuntime(process.resourcesPath, process.execPath)
  const handoff = new AppHandoff({ chat, sidecar, windows })
  const appUpdates = new AppUpdates({
    userData: app.getPath('userData'), current: app.getVersion(), platform: process.platform, arch: process.arch,
    config, fetch: netRequestTransport, handoff,
    startInstaller: request => windows.startInstaller(request), quit: () => app.quit(),
    openExternal: url => shell.openExternal(url),
    emit: status => win()?.webContents.send('app-update:status', status)
  })
  ipcMain.handle('app-update:status', async () => { await appUpdates.ready; return { result: appUpdates.status() } })
  ipcMain.handle('app-update:check', async () => ({ result: await appUpdates.check() }))
  ipcMain.handle('app-update:install', () => updateResult(async () => { await appUpdates.install(); return appUpdates.status() }))
  ipcMain.handle('app-update:open-page', () => updateResult(async () => { await appUpdates.openPage(); return true }))
  ipcMain.handle('app-update:cancel', () => ({ result: appUpdates.cancel() }))
  // 켜 둔 채 쓰는 학생에게 새 판을 알린다(A1-3) — 켤 때 확인은 아래 한 번, 이후는 30분마다 조용히.
  appUpdates.startRecheck()
  void appUpdates.check()
  const chatFail = (e: unknown): { error: { code: string; message: string } } => ({ error: { code: e instanceof FreeRelayError ? e.kind : e instanceof UpdateSuspendedError ? e.code : 'chat', message: e instanceof Error ? e.message : String(e) } })
  ipcMain.handle('chat:snapshot', (_e, root: string, provider: Provider) => { try { activeMainCompany = providerOf(provider); return { result: chat.snapshot(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:draft', (_e, root: string) => { try { return { result: chat.draft(root) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:set-draft', (_e, root: string, text: string, expected?: string) => { try { return { result: chat.setDraft(root, text, expected) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:status', async (_e, root: string, provider: Provider) => { try { return { result: await chat.status(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:login', async (_e, root: string, provider: Provider) => { try { await chat.login(root, provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:send', async (_e, root: string, provider: Provider, text: string, requestId: string) => {
    try {
      const result = await chat.send(root, provider, text, requestId)
      hideAppDirs(root)   // 첫 전송이 규칙집(.agents·.claude)과 대화 기록(.knuaf-gui)을 만든다
      return { result }
    } catch (e) { return chatFail(e) }
  })
  ipcMain.handle('project:trust', (_e, root: string, on: boolean) => {
    const key = trustKey(root)
    const cur = new Set(loadSettings().trusted_roots ?? [])
    on ? cur.add(key) : cur.delete(key)
    saveSettings({ trusted_roots: [...cur] })
    return { result: [...cur] }
  })
  ipcMain.handle('chat:respond', (_e, root: string, provider: Provider, id: string, allow: boolean) => { try { chat.respond(root, provider, id, allow); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:stop', async (_e, root: string, provider: Provider) => { try { await chat.stop(root, provider); return { result: true } } catch (e) { return chatFail(e) } })
  /**
   * 모델 칩의 뒷단. 목록은 계정에 묻고(`model/list`), 고른 값은 **설정에** 남긴다 —
   * `.knuaf-gui/chat-*.json` 저장 형식은 이번 판에서 건드리지 않는다.
   */
  ipcMain.handle('chat:models', async (_e, root: string | null, provider: Provider) => { try { return { result: await chat.models(root, provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('chat:set-model', async (_e, root: string | null, provider: Provider, choice: ModelChoice | null) => {
    // 저장·순서는 ChatService 가 맡는다(목록 검증과 저장 사이에 새 선택이 끼어드는 경합).
    try {
      if (root && choice) {
        const folder = canonical(root)
        if (!currentRoot || canonical(currentRoot) !== folder) throw new Error('지금 열린 논문 폴더가 아니에요.')
        await selectDesign({
          store: chat.lanesStore(), account: company => chat.laneAccount(company),
          freshAccount: company => chat.laneAccount(company, { fresh: true }),
          mainCompany: loadSettings().provider_choice?.provider ?? activeMainCompany,
          applyDesign: async (_root, entry) => {
            await chat.setModel(folder, entry.company, { model: entry.model!, effort: entry.effort })
            return true
          }
        }, folder, { company: providerOf(provider), model: choice.model, effort: choice.effort, how: 'main' })
        lanesHub.touch(folder)
        return { result: choice }
      }
      return { result: await chat.setModel(root, provider, choice) }
    } catch (e) { return chatFail(e) }
  })

  // 폴더 없이 쓰는 연결 — 첫 실행 화면(온보딩)이 폴더를 고르기 전에 쓴다. root 인자가 없다.
  // 대화·스킬 계약은 그대로다: 이 연결로는 아무것도 보낼 수 없다(service.ts 전역 연결 주석).
  ipcMain.handle('connect:status', async (_e, provider: Provider) => { try { return { result: await chat.globalStatus(provider) } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:login', async (_e, provider: Provider) => { try { await chat.globalLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:cancel', async (_e, provider: Provider) => { try { await chat.cancelLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })
  ipcMain.handle('connect:reopen', async (_e, provider: Provider) => { try { await chat.reopenLogin(provider); return { result: true } } catch (e) { return chatFail(e) } })

  ipcMain.handle('guide:open', () => { openGuide(); return true })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, logs: app.getPath('logs'), userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node, buildDate: __APP_BUILD_DATE__, buildCommit: __APP_BUILD_COMMIT__ }))
  ipcMain.handle('fs:is-dir', (_e, p: string) => { try { return statSync(p).isDirectory() } catch { return false } })

  ipcMain.handle('sidecar:info', () => ({ ...sidecar.status(), basePython: basePython(loadSettings().python_override), wheelhouse: wheelhouseDir() }))
  ipcMain.handle('sidecar:restart', async () => {
    try { return { result: await agentActivity.run(() => skillSwitch.run(() => sidecar.restart())) } } catch (error) { return { error: ipcError(error) } }
  })
  /**
   * 앱 전용 Python 런타임(D7). 진행 이벤트는 기존 `rpc:event` 채널로 clientId 에만 보낸다.
   * 설치는 프로세스 전역 1건 — 진행 중 재요청은 main 이 같은 약속에 합류시킨다.
   */
  ipcMain.handle('runtime:status', () => ({ result: runtimeStatus() }))
  ipcMain.handle('runtime:install', async (_e, clientId: string) => {
    const w = win()
    try {
      await installRuntime((event) => w?.webContents.send('rpc:event', { clientId, event: 'progress', data: event }))
      // 교체가 아니라 새 폴더 게시이므로 사이드카만 새 선택으로 다시 띄운다. 실패는 무시하고
      // 지금 상태를 돌려준다 — 설치 성공을 폴더 복구 성공으로 표시하지 않는다.
      let info = sidecar.status()
      try { info = await agentActivity.run(() => skillSwitch.run(() => sidecar.restart())) } catch { /* 재시작 실패는 호출자가 재시도로 다룬다 */ }
      cleanupRuntime()
      return { result: { installed: true, sidecar: info } }
    } catch (error) {
      return { error }
    }
  })
  ipcMain.handle('runtime:cancel', () => ({ result: cancelRuntimeInstall() }))
  ipcMain.handle('deps:ensure', (_e, root: string, clientId: string): Promise<RpcResult<Envelope>> => {
    if (root !== currentRoot) return Promise.resolve({ error: { code: 'project_changed', message: '현재 열린 논문 폴더가 아니에요.' } })
    const existing = dependencyFlights.get(root)
    if (existing) return existing.promise // Only the original client owns cancellation.
    if (agentBusy(root)) return Promise.resolve({ error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } })
    const visit = currentVisit
    latestDependencyCheck = null
    if (dependencyGate) dependencyGate.phase = 'checking'
    const { promise, resolve: finish } = Promise.withResolvers<RpcResult<Envelope>>()
    const flight = { clientId, cancelled: false, promise }
    const mine = (): boolean => visit === currentVisit && currentRoot === root
    const live = (): void => {
      if (flight.cancelled) throw { code: 'cancelled', message: '준비를 취소했어요.' }
      if (!mine()) throw { code: 'project_changed', message: '논문 폴더 방문이 바뀌어 준비를 중단했어요.' }
    }
    const onEvent = (event: string, data: unknown): void => win()?.webContents.send('rpc:event', { clientId, event, data })
    const onId = (id: string): void => {
      inflight.set(clientId, { id, method: 'deps.ensure' })
      if (flight.cancelled) sidecar.cancel(id)
    }
    const operation = async (): Promise<RpcResult<Envelope>> => {
      // S-01 §3.2 I-01: 의존성은 앱 데이터 deps/<키>/ 에만 설치한다. 이 경로를 실행에 쓰는 것은 이번 준비 건에
      // 한정되고, 진단까지 통과한 뒤에야 main 이 표식을 써서 신뢰로 바꾼다. 실패·취소면 표식 없는 그 폴더를 버린다.
      // 폴더의 옛 .venv 는 보지도 승격하지도 않는다(D1: 준비 카드가 안내만 한다). 앱이 단일 인스턴스라 다른 창과의
      // 동시 준비는 없고, 같은 창 안에서는 dependencyFlights 가 묶는다.
      const override = loadSettings().python_override
      const envRoot = depsRoot(), envKey = depsEnvKey(override), target = join(envRoot, envKey)
      const params: Record<string, unknown> = { root, base_python: basePython(override), deps_venv: target }
      const wheels = wheelhouseDir()
      if (wheels) { params.find_links = wheels; params.no_index = true }
      let phase: 'checking' | 'installing' | 'verifying' = 'checking'
      // I-01: 공유 환경을 건드리는 구간(잔해 정리~설치~검증~표식~재시작~실패 정리)은 잠금 하나로 이어진다.
      // I-03: 이번 작업이 쓴 표식만 회수한다 — 작업 전 표식 원문을 쥐고 있다가 실패·취소 때 그것으로 되돌린다.
      let release: (() => void) | null = null
      let priorMark: string | null = null
      let wroteMark = false
      try {
        live()
        // I-04: 이미 열린 폴더에서 사이드카가 내려가 있으면(고장 환경 등) 진단이 sidecar_down 으로 끝나 복구에 닿지 못한다 —
        // 먼저 다시 띄운다. 고장 난 앱 환경이면 configure 가 신뢰를 철회하고 기본 실행기로 뜬다.
        if (!sidecar.status().running) { await sidecar.configure(root, override); live() }
        const before = await sidecar.call<Envelope>('deps.doctor', { root }, onEvent, onId)
        live()
        const report = before.data as DependencyReport | null
        if (!before.ok || !report || typeof report.ready !== 'boolean' || !Array.isArray(report.dependencies) || !report.dependencies.length) {
          throw { code: 'deps_doctor', message: '준비 상태를 확인하지 못했어요.', data: before }
        }
        if (report.ready) {
          if (dependencyGate && mine()) dependencyGate.phase = 'ready'
          return { result: before }
        }
        release = await acquireEnvLock(envRoot, { isCancelled: () => flight.cancelled || !mine() })
        live() // 기다리다 취소·방문 변경이면 여기서 닫힌다(release 는 null — 정리할 것 없음)
        // 기다리는 사이 다른 폴더의 준비가 같은 환경을 끝냈을 수 있다 — 신뢰 환경이 생겼으면 사이드카를 맞추고 다시 진단한다.
        if (trustedEnv(envRoot, envKey)) {
          await sidecar.configure(root, override)
          live()
          const again = await sidecar.call<Envelope>('deps.doctor', { root }, onEvent, onId)
          live()
          if (again.ok && (again.data as DependencyReport | null)?.ready === true) {
            if (dependencyGate && mine()) dependencyGate.phase = 'ready'
            return { result: again }
          }
        }
        phase = 'installing'
        priorMark = readMark(envRoot, envKey)
        discardUnmarked(envRoot, envKey)
        let result = await sidecar.call<Envelope>('deps.ensure', params, onEvent, onId)
        live()
        const offline = wheels ? result : undefined
        if (wheels && !result.ok) {
          delete params.find_links; delete params.no_index
          result = await sidecar.call<Envelope>('deps.ensure', params, onEvent, onId)
          live()
          result = { ...result, attempts: { offline, online: result } }
        }
        if (result.ok) {
          phase = 'verifying'
          onEvent('progress', { phase: 'verifying' })
          const checked = await sidecar.call<Envelope>('deps.doctor', { root, deps_venv: target }, onEvent, onId)
          live()
          if (!checked.ok || (checked.data as DependencyReport | null)?.ready !== true) {
            throw { code: 'deps_verify', message: '설치 뒤 의존성 환경 준비 확인에 실패했어요.', data: { installation: result, diagnosis: checked } }
          }
          try {
            markReady(envRoot, envKey, { app: app.getVersion() })
            wroteMark = true
          } catch (error) {
            // 고정 스킬이 KNUAF_DEPS_VENV 를 따르지 않으면(TODO(D-U)) 앱 자리에 환경이 안 생긴다 — 신뢰하지 않고 닫는다.
            throw { code: 'deps_env_missing', message: '의존성 환경을 앱 자리에 만들지 못했어요.', data: { installation: result, detail: String(error) } }
          }
          await sidecar.configure(root, override) // depsVenv 가 바뀌었으므로 사이드카를 다시 띄운다(§3.3-3)
          live()
          if (dependencyGate && mine()) dependencyGate.phase = 'ready'
        } else {
          discardUnmarked(envRoot, envKey)
          if (dependencyGate && mine()) dependencyGate.phase = 'blocked'
        }
        hideAppDirs(root)
        return { result }
      } catch (error) {
        if (wroteMark) {
          // I-03: 표식 뒤(재시작 대기·재시작 실패·취소)의 실패 — 이번 작업의 표식을 이전 상태로 되돌리고(처음이면 제거 →
          // 잔해로 폐기), 사이드카가 반쯤 전환된 채 남지 않게 지금 상태로 다시 맞춘다. 이전 정상 환경은 지우지 않는다.
          restoreMark(envRoot, envKey, priorMark)
          if (priorMark === null) discardUnmarked(envRoot, envKey)
          try { await sidecar.configure(currentRoot, override) } catch { /* 되맞춤 실패는 다음 열기·재시도가 다룬다 */ }
        } else if (phase !== 'checking') discardUnmarked(envRoot, envKey)
        if (dependencyGate && mine()) dependencyGate.phase = 'blocked'
        const failure = ipcError(error) as NonNullable<RpcResult['error']>
        return { error: { code: failure.code ?? 'deps_ensure', message: failure.message ?? String(error),
          data: { phase, detail: failure.data } } }
      } finally {
        release?.()
        inflight.delete(clientId)
        if (dependencyFlights.get(root) === flight) dependencyFlights.delete(root)
      }
    }
    // Reserve the physical operation before any await; keep source/activity ownership through verification.
    dependencyFlights.set(root, flight)
    void agentActivity.run(() => skillSwitch.run(operation)).then(finish, error => {
      dependencyFlights.delete(root)
      if (dependencyGate && mine()) dependencyGate.phase = 'blocked'
      finish({ error: ipcError(error) as NonNullable<RpcResult['error']> })
    })
    return flight.promise
  })
  ipcMain.handle('project:create-folder', async (_e, title: unknown) => {
    if (typeof title !== 'string') return { error: { code: 'invalid_name', message: '논문 이름을 확인해 주세요.' } }
    const parent = join(app.getPath('documents'), 'knuaf-dev')
    try {
      await mkdir(parent, { recursive: true })
      if (!(await lstat(parent)).isDirectory()) throw new Error('논문 폴더 위치가 실제 폴더가 아닙니다.')
      const name = projectFolderName(title)
      for (let n = 1; n <= 10000; n++) {
        const root = join(parent, n === 1 ? name : `${name} (${n})`)
        try {
          await mkdir(root)
          return { result: { root } }
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      throw new Error('같은 이름의 폴더가 너무 많아요.')
    } catch (error) {
      return { error: { code: 'create_folder_failed', message: String(error) } }
    }
  })

  // 학교 재무 양식 알림 — 읽기·닫기 기억. 알림 파일은 규칙집이 쓰고 앱은 읽기만 한다.
  // `root` 는 화면이 들고 있는 그 논문 폴더여야 한다(다른 폴더의 알림을 이 화면에 섞지 않는다).
  ipcMain.handle('notices:read', (_e, root: unknown) => {
    if (typeof root !== 'string' || root !== currentRoot) {
      return { error: { code: 'project_mismatch', message: '열린 논문 폴더가 바뀌었어요.' } }
    }
    try {
      return { result: { notices: readNotices(root).notices, dismissed: readDismissed(app.getPath('userData')) } }
    } catch (error) {
      return { error: { code: 'notices_read', message: error instanceof Error ? error.message : String(error) } }
    }
  })
  ipcMain.handle('notices:dismiss', (_e, root: unknown, key: unknown) => {
    if (typeof root !== 'string' || root !== currentRoot) {
      return { error: { code: 'project_mismatch', message: '열린 논문 폴더가 바뀌었어요.' } }
    }
    if (typeof key !== 'string' || !key) return { error: { code: 'invalid_params', message: '알림 열쇠가 올바르지 않습니다.' } }
    // 열쇠는 `project_id:notice_identity` 다 — 이 폴더의 열쇠만 닫힌다. 접두를 안 보면 화면(또는
    // 그 화면을 흉내 내는 쪽)이 다른 논문의 알림을 이 앱의 닫기 기억에 넣어 둘 수 있다.
    const projectId = peekProject(root).project_id
    if (!projectId || !key.startsWith(`${projectId}:`)) {
      return { error: { code: 'project_mismatch', message: '다른 논문의 알림은 닫을 수 없어요.' } }
    }
    try {
      return { result: writeDismissed(app.getPath('userData'), key) }
    } catch (error) {
      return { error: { code: 'notices_dismiss', message: error instanceof Error ? error.message : String(error) } }
    }
  })
  /**
   * 선택 기록 — 화면이 보낸 `(root, identity, value)` 를 **메인이 다시 검사**한 뒤 sidecar 에 넘긴다.
   * ① 열린 폴더여야 하고 ② 그 `identity` 가 지금 알림 파일의 유효 알림이어야 하며 ③ 값은 계약의 둘뿐이다.
   * 이 셋을 안 보면 화면이 임의의 identity·폴더로 정본을 고칠 수 있다(선택은 정본 쓰기다).
   */
  ipcMain.handle('notices:choose', async (_e, root: unknown, identity: unknown, value: unknown) => {
    if (typeof root !== 'string' || root !== currentRoot) {
      return { error: { code: 'project_mismatch', message: '열린 논문 폴더가 바뀌었어요.' } }
    }
    if (typeof identity !== 'string' || !identity.trim()) {
      return { error: { code: 'invalid_params', message: '알림 식별자가 올바르지 않습니다.' } }
    }
    if (!CHOICE_VALUES.includes(value as (typeof CHOICE_VALUES)[number])) {
      return { error: { code: 'invalid_params', message: '알림 선택 값이 올바르지 않습니다.' } }
    }
    // 알림 파일은 규칙집이 쓴다 — 그 파일이 말하는 알림만 선택할 수 있다.
    let known = false
    try {
      known = readNotices(root).notices.some((notice) => notice.key.slice(notice.key.indexOf(':') + 1) === identity)
    } catch (error) {
      return { error: { code: 'notices_read', message: error instanceof Error ? error.message : String(error) } }
    }
    if (!known) return { error: { code: 'notice_unknown', message: '그 알림을 이 폴더에서 찾지 못했어요.' } }
    if (agentBusy(root)) return { error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } }
    try {
      // 정본·알림 파일 다시 쓰기는 sidecar(규칙집) 몫이다. 앱은 결과 봉투만 그대로 돌려준다.
      return { result: await sidecar.call('notices.choose', { root, identity, value }) }
    } catch (error) {
      return { error: ipcError(error) }
    }
  })

  /** 확인은 열린 폴더와 알림을 다시 검사하고, 전달받은 답이 있으면 출처를 보존한다. */
  ipcMain.handle('notices:confirm', async (_e, root: unknown, identity: unknown, quote: unknown) => {
    if (typeof root !== 'string' || root !== currentRoot) {
      return { error: { code: 'project_mismatch', message: '열린 논문 폴더가 바뀌었어요.' } }
    }
    if (typeof identity !== 'string' || !identity.trim()) {
      return { error: { code: 'invalid_params', message: '알림 식별자가 올바르지 않습니다.' } }
    }
    if (quote !== undefined && (typeof quote !== 'string' || !quote.trim())) {
      return { error: { code: 'invalid_params', message: '전달한 답이 올바르지 않습니다.' } }
    }
    // 알림 파일은 규칙집이 쓴다 — 그 파일이 말하는 알림만 확인할 수 있다.
    let known = false
    try {
      known = readNotices(root).notices.some((notice) => notice.key.slice(notice.key.indexOf(':') + 1) === identity)
    } catch (error) {
      return { error: { code: 'notices_read', message: error instanceof Error ? error.message : String(error) } }
    }
    if (!known) return { error: { code: 'notice_unknown', message: '그 알림을 이 폴더에서 찾지 못했어요.' } }
    if (agentBusy(root)) return { error: { code: 'agent_busy', message: AGENT_BUSY_MESSAGE } }
    try {
      return { result: await sidecar.call('notices.confirm', { root, identity, ...(typeof quote === 'string' ? { relayed_quote: quote.trim() } : {}) }) }
    } catch (error) {
      return { error: ipcError(error) }
    }
  })

  sidecar.on('log', (entry) => win()?.webContents.send('sidecar:log', entry))
  sidecar.on('exit', (entry) => win()?.webContents.send('sidecar:exit', entry))
  // figures (v0.7 그림 갈래): 통로는 `index.ts` 가 종료에 닫는다(창·IPC 는 이 값을 모른다).
  return { chat, images, figures, probe: probeAccount }
}
