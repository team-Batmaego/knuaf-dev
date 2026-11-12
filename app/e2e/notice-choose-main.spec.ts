// Node-only main IPC boundary for notice choice/dismiss. No Electron window, account, or real sidecar.
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { ChatService } from '../src/main/chat/service'
import type { AgentConnection } from '../src/main/chat/contracts'
import type * as IpcModule from '../src/main/ipc'
import type { Envelope } from '../src/shared/types'

/**
 * 선택은 **정본 쓰기**다(규칙집이 `project.json`·알림 파일을 다시 쓴다). 그래서 화면이 보낸
 * `(root, identity, value)` 를 메인이 다시 검사한다:
 * ① 열린 폴더여야 하고 ② 그 `identity` 가 지금 알림 파일의 유효 알림이어야 하며 ③ 값은 계약의 둘뿐이다.
 * 여기서는 그 문 하나를 잠근다 — 통과하지 못한 요청은 sidecar 에 **닿지 않아야** 한다.
 * 닫기 기억도 같은 경계다: 이 폴더의 `project_id:` 접두를 가진 열쇠만 저장한다.
 */

const appRoot = resolve(__dirname, '..')
const file = join(appRoot, 'src/main/ipc.ts'), realRequire = createRequire(file)
const factory = new Script(`(function(require,exports){${transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: file }).runInThisContext() as (require: (name: string) => unknown, module: Partial<typeof IpcModule>) => void
const source = join(appRoot, 'resources/skill')

const PROJECT_ID = 'a'.repeat(64)
const IDENTITY = 'b'.repeat(64)

function envelope(status: string, ok = true, exit = 0): Envelope {
  return {
    ok, exit, status, data: null, path: null, block_reason: null,
    stdout: '', stderr: '', argv: [], python: '/bundled/python', duration_ms: 1
  }
}

class ControlledSidecar extends EventEmitter {
  configured: string[] = []
  calls: { method: string; params: Record<string, unknown> }[] = []
  /** `notices.choose` 응답 — 시험이 갈아 끼운다. */
  choose: () => Envelope = () => envelope('chosen')
  status() { return { python: '/bundled/python', kind: 'bundled' as const, scriptsDir: join(source, 'scripts'), running: true } }
  async configure(root: string) { this.configured.push(root); return this.status() }
  isWrite(method: string) { return method === 'notices.choose' }
  cancel() {}
  async call(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params })
    if (method === 'notices.choose') return this.choose()
    throw new Error('Unexpected method ' + method)
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-main-notice-')), root = join(dir, '합성 논문 A'), other = join(dir, '합성 논문 B')
  mkdirSync(root); mkdirSync(other)
  // 알림 파일은 규칙집이 쓴다 — 여기서는 그 모양 그대로 직접 둔다(앱은 읽기만 한다).
  for (const [at, projectId] of [[root, PROJECT_ID], [other, 'c'.repeat(64)]] as const) {
    writeFileSync(join(at, 'project.json'), JSON.stringify({ revision: 1, project_id: projectId }), 'utf-8')
    writeFileSync(join(at, '.knuaf-notices.json'), JSON.stringify({
      schema: 'knuaf.notices/1', project_id: projectId,
      notices: [{
        title: '학교 재무 양식의 수식 오류 3곳을 바로잡았어요', notice_identity: IDENTITY, project_id: projectId,
        dismissible: true, choices: [{ value: 'direct_tell', label: '교수님께 직접 말할게요' }, { value: 'footnote', label: '논문에 각주로 적을게요' }],
        choice: null, items: [{ key: 'k1', kind: 'typo', what: '수식 오류', cells: ['4.투자계획!E24'] }]
      }]
    }), 'utf-8')
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const settings: { first_project_permission_asked_at?: string; python_override: null } = {
    first_project_permission_asked_at: 'synthetic-consent', python_override: null
  }
  const connection: AgentConnection = { status: async () => ({ connected: true, installed: true, version: 'test', detail: '' }),
    login: async () => { throw new Error('Login is forbidden in this test') },
    run: async () => {}, respond: () => {}, stop: async () => {} }
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getPath: () => dir, getVersion: () => '0.6.0' },
      ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
      net: { fetch: async () => { throw new Error('Network forbidden') } }, shell: { openExternal: async () => {} } },
    './python': { APP_ROOT: appRoot, basePython: () => '/bundled/python', bundledPython: () => null, venvPython: () => null, wheelhouseDir: () => '/offline/wheels' },
    './settings': { loadSettings: () => settings, rememberRecent: () => {}, saveSettings: () => {} },
    './menu': { openGuide: () => {} },
    './agent': { ...realRequire('./agent'), skillSource: () => source },
    './chat/service': { ChatService: class extends ChatService {
      constructor(options: ConstructorParameters<typeof ChatService>[0]) { super({ ...options, connectionFactory: () => connection }) }
    } }
  }
  const module: Partial<typeof IpcModule> = {}
  factory(name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module)
  const sidecar = new ControlledSidecar()
  const services = module.registerIpc!(sidecar as unknown as Parameters<typeof IpcModule.registerIpc>[0], () => null)
  return { dir, root, other, sidecar,
    invoke: async (name: string, ...args: unknown[]): Promise<unknown> => handlers.get(name)!(null, ...args),
    cleanup: async () => { await services.chat.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const chooseCalls = (h: ReturnType<typeof harness>): unknown[] => h.sidecar.calls.filter((call) => call.method === 'notices.choose')

test('선택은 열린 폴더·지금 알림·계약 값 셋을 통과할 때만 sidecar 에 닿는다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    expect(chooseCalls(h)).toEqual([])

    // ① 다른 폴더 — 열린 폴더는 A 다.
    expect(await h.invoke('notices:choose', h.other, IDENTITY, 'footnote')).toMatchObject({ error: { code: 'project_mismatch' } })
    // ② 이 폴더에 없는 알림 identity(모양은 hex 64자).
    expect(await h.invoke('notices:choose', h.root, 'd'.repeat(64), 'footnote')).toMatchObject({ error: { code: 'notice_unknown' } })
    // ③ 계약 밖 값.
    expect(await h.invoke('notices:choose', h.root, IDENTITY, 'overwrite_all')).toMatchObject({ error: { code: 'invalid_params' } })
    // 빈 identity 도 같은 문에서 막힌다.
    expect(await h.invoke('notices:choose', h.root, '  ', 'footnote')).toMatchObject({ error: { code: 'invalid_params' } })
    expect(chooseCalls(h)).toEqual([])

    // 통과 — 열쇠 그대로 넘긴다(값·폴더 변형 없음).
    h.sidecar.choose = () => envelope('chosen')
    expect(await h.invoke('notices:choose', h.root, IDENTITY, 'direct_tell')).toMatchObject({ result: { ok: true, status: 'chosen' } })
    expect(chooseCalls(h)).toEqual([{ method: 'notices.choose', params: { root: h.root, identity: IDENTITY, value: 'direct_tell' } }])
  } finally { await h.cleanup() }
})

test('generic rpc 로는 notices.choose 를 부를 수 없다 — sidecar 에 닿지 않는다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    expect(await h.invoke('rpc', 'notices.choose', { root: h.other, identity: IDENTITY, value: 'footnote' }, 'c1'))
      .toMatchObject({ error: { code: 'invalid_method' } })
    // 열린 폴더를 그대로 실어 보내도 마찬가지다 — 좁은 문(`notices:choose`) 하나뿐이다.
    expect(await h.invoke('rpc', 'notices.choose', { root: h.root, identity: IDENTITY, value: 'footnote' }, 'c2'))
      .toMatchObject({ error: { code: 'invalid_method' } })
    expect(chooseCalls(h)).toEqual([])
  } finally { await h.cleanup() }
})

test('닫기 기억은 이 프로젝트 열쇠만 저장한다 — 다른 프로젝트 key 는 전역 파일에 남지 않는다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    const stored = (): string[] => {
      const at = join(h.dir, 'notices-dismissed.json')
      return existsSync(at) ? JSON.parse(readFileSync(at, 'utf-8')) as string[] : []
    }
    const foreign = `${'c'.repeat(64)}:${IDENTITY}`
    expect(await h.invoke('notices:dismiss', h.root, foreign)).toMatchObject({ error: { code: 'project_mismatch' } })
    expect(stored()).toEqual([])

    const own = `${PROJECT_ID}:${IDENTITY}`
    expect(await h.invoke('notices:dismiss', h.root, own)).toMatchObject({ result: [own] })
    expect(stored()).toEqual([own])
  } finally { await h.cleanup() }
})
