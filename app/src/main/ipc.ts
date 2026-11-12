import { app, BrowserWindow, dialog, ipcMain, net, shell, systemPreferences } from 'electron'
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, readSync, statSync } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
import { probeProjectWritable } from './project-write'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { insideByFileId } from './file-identity'
import type { Sidecar } from './sidecar'
import type { DependencyReport, Envelope, PreviewPayload, ProjectPeek, RpcResult, WindowInfo } from '../shared/types'
import type { ModelChoice, Provider } from '../shared/chat'
import { canonical } from './chat/jobs/isolation'
import { APP_ROOT, basePython, bundledPython, venvPython, wheelhouseDir } from './python'
import { cancelRuntimeInstall, cleanupRuntime, installRuntime, runtimeStatus } from './runtime'
import { agentApi, findExecutable, skillSource, type AgentCtx, type AgentKind } from './agent'
import { ChatService, type HandoffSeam } from './chat/service'
import { ClaudeRelayConnection } from './chat/claude'
import { CodexRelayConnection } from './chat/codex'
import { subscriptionEnv, type AgentOptions } from './chat/contracts'
import { ConversationHandoff } from './chat/jobs/conversation'
import { laneAccountProbe } from './lanes/accounts'
import { registerLaneHandlers } from './lanes/handlers'
import { LanesHub, connectChanges } from './lanes/hub'
import { LANES_PUSH } from '../shared/lanes-ipc'
import { openGuide } from './menu'
import { loadSettings, rememberRecent, saveSettings } from './settings'
import { APP_NAME } from '../shared/name'
import { hideAppDirs } from './hidden'
import { projectFolderName } from '../shared/project-folder'
import { updateConfig } from './update/keys'
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

/** Every renderer request goes through here; the renderer never sees Node. Returns the services so index.ts can close them on quit. */
export function registerIpc(sidecar: Sidecar, win: () => BrowserWindow | null, onRecentsChanged: () => void = () => {}): { chat: ChatService } {
  let currentRoot: string | null = null
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
  const updates = new SkillUpdates(store, {
    config, fetch: (url, init) => net.fetch(url, init),
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
  const EXECUTABLE_PARAMS = ['base_python', 'node', 'pnpm', 'kordoc'] as const
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

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch) => { const s = saveSettings(patch); onRecentsChanged(); return s })
  const agentCtx = (): AgentCtx => ({
    home: app.getPath('home'), appRoot: APP_ROOT, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    supportDir: join(app.getPath('userData'), 'launch'), dryRun: process.env.KNUAF_DRY_LAUNCH === '1',
    open: (p) => shell.openPath(p), venvPython, bundledPython
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
    } catch (error) { return { error: { code: error instanceof UpdateSuspendedError ? error.code : 'internal', message: String(error) } } }
  })

  /**
   * 담당(relay) 연결의 엔진 옵션 — 본대화 연결과 **같은 환경·실행 파일**을 쓰고, 스킬 경로만
   * 주문서가 준 폴더다(엔진이 `SKILL.md` 를 붙인다). 격리 판정은 `request.isolation` 이 정본이다.
   */
  const relayOptions = (company: Provider, root: string): AgentOptions => {
    const binary = findExecutable(company)
    if (!binary) throw new Error(`${company === 'codex' ? 'Codex' : 'Claude Code'} 설치가 필요해요. 설치 안내를 열어 주세요.`)
    // 본대화와 같은 PATH 앞자리(프로젝트 .venv → 번들 CPython) — 담당이 도우미와 같은
    // 인터프리터를 찾아야 스킬 스크립트가 같은 결과를 낸다.
    const python = venvPython(currentRoot) ?? bundledPython()
    return {
      binary,
      root,
      skill: '',
      env: subscriptionEnv(python ? [dirname(python)] : []),
      openExternal: (url) => shell.openExternal(url)
    }
  }
  // 계정 값은 엔진과 같은 생산자로 읽는다 — 추측값을 만들면 러너의 지문 대조에서 모든 주문이
  // `rejected` 로 닫힌다. 모델 호출은 없다(초기화 왕복 한 번).
  const probeAccount = laneAccountProbe({
    appDir: join(app.getPath('userData'), 'relay'),
    env: () => subscriptionEnv(),
    openExternal: (url) => shell.openExternal(url),
    binary: company => findExecutable(company)
  })
  /**
   * §4 본대화 인계 — 앱이 쥔 `ConversationHandoff` 하나. 새 대화 열기·닫기는 `chat` 이 알고
   * (그 폴더·회사의 대화 칸을 실제로 비우고 첫 차례를 보낸다), 묶음을 짓는 일은 인계 인스턴스가 한다.
   */
  const handoffSeam: HandoffSeam = new ConversationHandoff({
    stateDir: join(app.getPath('userData'), 'handoff'),
    // 앱이 만드는 묶음의 상한 — 넘치면 정해진 순서로 줄이고 `trimmed` 로 알린다.
    maxBytes: 24_000,
    account: company => probeAccount(company),
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
  /** `lanes:changed` 송신기 — `chat` 이 선 뒤에 만든다(저장소·러너를 그때 읽는다). */
  let lanesHub: LanesHub | null = null

  const chat = new ChatService({
    skillSource: () => skillSource(APP_ROOT, app.isPackaged, process.resourcesPath),
    userData: app.getPath('userData'),
    emit: (s) => win()?.webContents.send('chat:snapshot', s),
    openExternal: (url) => shell.openExternal(url),
    // The reverse gate: while the app holds a write transaction, agent sends must wait.
    sidecarBusy: () => {
      if ((dependencyGate?.root === currentRoot && dependencyGate.phase !== 'ready') || dependencyFlights.size > 0) return true
      for (const diagnosis of dependencyDiagnoses.values()) if (diagnosis.gate === dependencyGate) return true
      for (const entry of inflight.values()) if (sidecar.isWrite(entry.method)) return true
      return false
    },
    // 도우미에게도 프로젝트 .venv 와 번들 인터프리터를 건넨다 — Homebrew 없는 맥에서 막히지 않게.
    venvPython,
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
    jobAccount: (company, options) => probeAccount(company, options),
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
    // 본대화 회사 — 학생이 고른 대화 공급자. 고른 적이 없으면 설계 차선은 Claude 로 고정된다.
    mainCompany: loadSettings().provider_choice?.provider ?? 'claude',
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
    freshAccount: company => chat.laneAccount(company, { fresh: true }),
    // [C1-08] 화면이 보낸 폴더가 아니라 **main 이 열어 둔 폴더**만 통과시킨다.
    allowed: folder => {
      if (!currentRoot) return false
      try { return canonical(currentRoot) === folder } catch { return false }
    },
    mainCompany: loadSettings().provider_choice?.provider ?? 'claude',
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
    config, fetch: (url, init) => net.fetch(url, init), handoff,
    startInstaller: request => windows.startInstaller(request), quit: () => app.quit(),
    openExternal: url => shell.openExternal(url),
    emit: status => win()?.webContents.send('app-update:status', status)
  })
  ipcMain.handle('app-update:status', async () => { await appUpdates.ready; return { result: appUpdates.status() } })
  ipcMain.handle('app-update:check', async () => ({ result: await appUpdates.check() }))
  ipcMain.handle('app-update:install', () => updateResult(async () => { await appUpdates.install(); return appUpdates.status() }))
  ipcMain.handle('app-update:open-page', () => updateResult(async () => { await appUpdates.openPage(); return true }))
  ipcMain.handle('app-update:cancel', () => ({ result: appUpdates.cancel() }))
  void appUpdates.check()
  const chatFail = (e: unknown): { error: { code: string; message: string } } => ({ error: { code: e instanceof UpdateSuspendedError ? e.code : 'chat', message: e instanceof Error ? e.message : String(e) } })
  ipcMain.handle('chat:snapshot', (_e, root: string, provider: Provider) => { try { return { result: chat.snapshot(root, provider) } } catch (e) { return chatFail(e) } })
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
    try { return { result: await chat.setModel(root, provider, choice) } } catch (e) { return chatFail(e) }
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
      const params: Record<string, unknown> = { root, base_python: basePython(loadSettings().python_override) }
      const wheels = wheelhouseDir()
      if (wheels) { params.find_links = wheels; params.no_index = true }
      let phase: 'checking' | 'installing' | 'verifying' = 'checking'
      try {
        live()
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
        phase = 'installing'
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
          await sidecar.configure(root, loadSettings().python_override)
          live()
          const checked = await sidecar.call<Envelope>('deps.doctor', { root }, onEvent, onId)
          live()
          if (!checked.ok || (checked.data as DependencyReport | null)?.ready !== true) {
            throw { code: 'deps_verify', message: '설치 뒤 프로젝트 .venv 준비 확인에 실패했어요.', data: { installation: result, diagnosis: checked } }
          }
          if (dependencyGate && mine()) dependencyGate.phase = 'ready'
        } else if (dependencyGate && mine()) dependencyGate.phase = 'blocked'
        hideAppDirs(root)
        return { result }
      } catch (error) {
        if (dependencyGate && mine()) dependencyGate.phase = 'blocked'
        const failure = ipcError(error) as NonNullable<RpcResult['error']>
        return { error: { code: failure.code ?? 'deps_ensure', message: failure.message ?? String(error),
          data: { phase, detail: failure.data } } }
      } finally {
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

  sidecar.on('log', (entry) => win()?.webContents.send('sidecar:log', entry))
  sidecar.on('exit', (entry) => win()?.webContents.send('sidecar:exit', entry))
  return { chat }
}
