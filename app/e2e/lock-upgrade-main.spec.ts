// Node-only main IPC boundary for 옮긴 폴더 잠금 풀기. No Electron window, account, or real sidecar.
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { ChatService } from '../src/main/chat/service'
import type { AgentConnection } from '../src/main/chat/contracts'
import type * as IpcModule from '../src/main/ipc'

/**
 * Roh C-01(r2): `lock.upgrade_offline` 의 `offline_confirmed=true` 는 학생 확인이다. 화면(렌더러)이
 * 그 값을 만들 수 있으면 확인을 위조할 수 있다. 그래서
 *  ① 범용 `rpc` 문은 이 메서드를 거절하고(sidecar 에 닿지 않음)
 *  ② 전용 `lock:upgrade-offline` 은 폴더를 인자로 받지 않고 main 이 아는 열린 폴더만 쓰며
 *  ③ main 이 직접 띄운 확인 창에서 학생이 '잠금 풀기'를 누른 경우에만 `offline_confirmed: true` 로 부른다.
 */

const appRoot = resolve(__dirname, '..')
const file = join(appRoot, 'src/main/ipc.ts'), realRequire = createRequire(file)
const factory = new Script(`(function(require,exports){${transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: file }).runInThisContext() as (require: (name: string) => unknown, module: Partial<typeof IpcModule>) => void
const source = join(appRoot, 'resources/skill')
const RID = '0b8f8a0e-6c1e-4d3e-9f57-1c2d3e4f5a6b'

class ControlledSidecar extends EventEmitter {
  calls: { method: string; params: Record<string, unknown> }[] = []
  status() { return { python: '/bundled/python', kind: 'bundled' as const, scriptsDir: join(source, 'scripts'), running: true } }
  async configure() { return this.status() }
  isWrite(method: string) { return method === 'lock.upgrade_offline' }
  cancel() {}
  async call(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params })
    if (method === 'lock.upgrade_offline') return { recovery_id: RID, status: 'completed', commit_state: 'committed', reason: null }
    throw new Error('Unexpected method ' + method)
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-main-lock-')), root = join(dir, '합성 논문 A'), other = join(dir, '합성 논문 B')
  mkdirSync(root); mkdirSync(other)
  for (const at of [root, other]) writeFileSync(join(at, 'project.json'), JSON.stringify({ revision: 1 }), 'utf-8')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const dialogs: { message: string; detail: string; buttons: string[] }[] = []
  /** 확인 창 응답 — 시험이 갈아 끼운다. 기다리는 동안 폴더를 바꾸는 시험도 여기서 한다. */
  let answer: () => Promise<number> = async () => 0
  const settings: { first_project_permission_asked_at?: string; python_override: null } = {
    first_project_permission_asked_at: 'synthetic-consent', python_override: null
  }
  const connection: AgentConnection = { status: async () => ({ connected: true, installed: true, version: 'test', detail: '' }),
    login: async () => { throw new Error('Login is forbidden in this test') },
    run: async () => {}, respond: () => {}, stop: async () => {} }
  const showMessageBox = async (...args: unknown[]) => {
    const opts = args[args.length - 1] as { message: string; detail: string; buttons: string[] }
    dialogs.push(opts)
    return { response: await answer(), checkboxChecked: false }
  }
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getPath: () => dir, getVersion: () => '0.6.0' },
      ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
      dialog: { showMessageBox },
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
  const invoke = async (name: string, ...args: unknown[]): Promise<unknown> => handlers.get(name)!(null, ...args)
  return { dir, root, other, sidecar, dialogs, invoke,
    setAnswer: (fn: () => Promise<number>) => { answer = fn },
    upgrades: () => sidecar.calls.filter((call) => call.method === 'lock.upgrade_offline'),
    cleanup: async () => { await services.chat.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('범용 rpc 문은 lock.upgrade_offline 을 거절하고 sidecar 에 닿지 않는다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    const r = await h.invoke('rpc', 'lock.upgrade_offline', { root: h.root, offline_confirmed: true }, 'c1')
    expect(r).toMatchObject({ error: { code: 'invalid_method' } })
    expect(h.upgrades()).toEqual([])
    expect(h.dialogs).toEqual([])
  } finally { await h.cleanup() }
})

test('열린 폴더가 없으면 확인 창도 sidecar 호출도 없다', async () => {
  const h = harness()
  try {
    expect(await h.invoke('lock:upgrade-offline')).toMatchObject({ error: { code: 'project_mismatch' } })
    expect(h.dialogs).toEqual([])
    expect(h.upgrades()).toEqual([])
  } finally { await h.cleanup() }
})

test('확인 창에서 취소하면 sidecar 에 닿지 않는다(L2)', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    h.setAnswer(async () => 0)
    expect(await h.invoke('lock:upgrade-offline')).toMatchObject({ error: { code: 'cancelled' } })
    expect(h.dialogs).toHaveLength(1)
    expect(h.upgrades()).toEqual([])
  } finally { await h.cleanup() }
})

test('main 확인 창에서 "잠금 풀기"를 눌러야만, main 이 아는 열린 폴더로 offline_confirmed=true 를 보낸다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    h.setAnswer(async () => 1)
    // 화면이 다른 폴더·확인 값을 끼워 넣어도 쓰이지 않는다 — 인자는 이어 하기 ID 하나뿐이다.
    const r = await h.invoke('lock:upgrade-offline', undefined, { root: h.other, offline_confirmed: true })
    expect(r).toMatchObject({ result: { status: 'completed' } })
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0].buttons[1]).toBe('잠금 풀기')
    expect(`${h.dialogs[0].message}\n${h.dialogs[0].detail}`).toContain('합성 논문 A')
    expect(h.upgrades()).toEqual([{ method: 'lock.upgrade_offline', params: { root: h.root, offline_confirmed: true } }])
  } finally { await h.cleanup() }
})

test('이어 하기 ID 는 UUID 만, 확인 뒤 그대로 넘긴다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    h.setAnswer(async () => 1)
    for (const bad of ['', '../x', 'rid-1', 3, { id: RID }]) {
      expect(await h.invoke('lock:upgrade-offline', bad)).toMatchObject({ error: { code: 'invalid_params' } })
    }
    expect(h.dialogs).toEqual([])
    await h.invoke('lock:upgrade-offline', RID)
    expect(h.upgrades()).toEqual([{ method: 'lock.upgrade_offline', params: { root: h.root, offline_confirmed: true, resume: RID } }])
  } finally { await h.cleanup() }
})

test('확인 창이 떠 있는 동안 폴더가 바뀌면 부르지 않는다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    h.setAnswer(async () => { await h.invoke('project:open', h.other); return 1 })
    expect(await h.invoke('lock:upgrade-offline')).toMatchObject({ error: { code: 'project_mismatch' } })
    expect(h.upgrades()).toEqual([])
  } finally { await h.cleanup() }
})
