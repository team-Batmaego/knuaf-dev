// Node-only registered IPC/ChatService regressions. No Electron or account process is launched.
import { test, expect } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { ChatService } from '../src/main/chat/service'
import type { AgentConnection } from '../src/main/chat/contracts'
import type * as IpcModule from '../src/main/ipc'
import type { DependencyReport, Envelope, SidecarInfo } from '../src/shared/types'

const appRoot = resolve(__dirname, '..')
const source = process.env.KNUAF_TEST_SCRIPTS_DIR ? resolve(process.env.KNUAF_TEST_SCRIPTS_DIR, '..') : join(appRoot, 'resources/skill')
const file = join(appRoot, 'src/main/ipc.ts'), realRequire = createRequire(file)
const factory = new Script(`(function(require,exports){${transpileModule(readFileSync(file,'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: file }).runInThisContext() as (require: (name: string) => unknown, module: Partial<typeof IpcModule>) => void
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function env(ready: boolean): Envelope {
  const data: DependencyReport = { ready, current_python: '/bundled/python', venv_python: ready ? '/project/.venv/python' : null,
    selected_python: ready ? '/project/.venv/python' : null,
    dependencies: [{ dist: 'docx', purpose: 'Word', status: ready ? 'installed' : 'missing',
      current: { imported: false, version: null, version_in_range: null, status: 'missing' },
      venv: ready ? { imported: true, version: '1.2', version_in_range: true, status: 'installed' } : null }] }
  return { ok: true, exit: 0, data, status: null, path: null, block_reason: null, stdout: '', stderr: '', argv: [], python: '/bundled/python', duration_ms: 1 }
}
class ControlledSidecar extends EventEmitter {
  configured: string[] = []
  calls: { method: string; params: Record<string, unknown> }[] = []
  cancelled: string[] = []
  ready = false
  diagnose: () => Promise<Envelope> = async () => env(this.ready)
  install: () => Promise<Envelope> = async () => { this.ready = true; return env(true) }
  status(): SidecarInfo { return { python: '/bundled/python', kind: 'bundled', scriptsDir: join(source, 'scripts'), running: true } }
  async configure(root: string) { this.configured.push(root); return this.status() }
  isWrite(method: string) { return method === 'deps.ensure' }
  cancel(id: string) { this.cancelled.push(id) }
  async call(method: string, params: Record<string, unknown>, _onEvent: unknown, onId?: (id: string) => void) {
    this.calls.push({ method, params }); onId?.(`m${this.calls.length}`)
    if (method === 'deps.doctor') return this.diagnose()
    if (method === 'deps.ensure') return this.install()
    throw new Error('Unexpected method ' + method)
  }
}
function harness(sidecar = new ControlledSidecar()) {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-main-prep-')), root = join(dir, '합성 논문 A'), other = join(dir, '합성 논문 B')
  mkdirSync(root); mkdirSync(other)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(), sent: string[] = []
  const settings: { first_project_permission_asked_at?: string; python_override: null } = {
    first_project_permission_asked_at: 'synthetic-consent', python_override: null
  }
  const connection: AgentConnection = { status: async () => ({ connected: true, installed: true, version: 'test', detail: '' }),
    login: async () => { throw new Error('Login is forbidden in this test') },
    run: async body => { sent.push(body) }, respond: () => {}, stop: async () => {} }
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
  factory(name => Object.hasOwn(dependencies,name) ? dependencies[name] : realRequire(name), module)
  const services = module.registerIpc!(sidecar as unknown as Parameters<typeof IpcModule.registerIpc>[0], () => null)
  return { root, other, sidecar, settings, sent, chat: services.chat,
    invoke: async (name: string, ...args: unknown[]): Promise<unknown> => handlers.get(name)!(null, ...args),
    cleanup: async () => { await services.chat.close(); rmSync(dir, { recursive: true, force: true }) }
  }
}

test('main coalesces automatic/manual installation and holds chat through reconfiguration/recheck', async () => {
  const h = harness(), install = Promise.withResolvers<Envelope>(), verify = Promise.withResolvers<Envelope>()
  let checks = 0
  h.sidecar.diagnose = async () => ++checks === 1 ? env(false) : verify.promise
  h.sidecar.install = async () => install.promise
  try {
    await h.invoke('project:open',h.root)
    const a = h.invoke('deps:ensure',h.root,'owner'), b = h.invoke('deps:ensure',h.root,'joiner')
    await flush()
    await expect(h.chat.send(h.root,'codex','must wait','pending-install')).rejects.toThrow()
    expect(h.chat.snapshot(h.root,'codex').messages).toEqual([])
    install.resolve(env(true)); await flush()
    await expect(h.chat.send(h.root,'codex','still wait','pending-verify')).rejects.toThrow()
    expect(h.sent).toEqual([])
    verify.resolve(env(true)); expect(await a).toMatchObject({ result: { ok: true } }); await b
    expect(h.sidecar.calls.filter(call => call.method === 'deps.ensure')).toHaveLength(1)
    await h.chat.send(h.root,'codex','verified only','accepted'); await flush()
    expect(h.sent).toEqual(['verified only'])
  } finally { await h.cleanup() }
})

test('old A completion cannot reconfigure B or a new A visit', async () => {
  const h = harness(), install = Promise.withResolvers<Envelope>()
  h.sidecar.install = async () => install.promise
  try {
    await h.invoke('project:open',h.root)
    const old = h.invoke('deps:ensure',h.root,'old-A'); await flush()
    await h.invoke('project:open',h.other); await h.invoke('project:open',h.root)
    const configurations = [...h.sidecar.configured]
    install.resolve(env(true))
    expect(await old).toMatchObject({ error: { code: 'project_changed' } })
    expect(h.sidecar.configured).toEqual(configurations)
    await expect(h.chat.send(h.root,'codex','not verified','stale')).rejects.toThrow()
    expect(h.sent).toEqual([])
  } finally { await h.cleanup() }
})

test('cancellation between offline failure and fallback never starts online pip', async () => {
  const h = harness(), offline = Promise.withResolvers<Envelope>()
  h.sidecar.install = async () => offline.promise
  try {
    await h.invoke('project:open',h.root)
    const pending = h.invoke('deps:ensure',h.root,'owner'); await flush()
    await h.invoke('rpc:cancel','owner')
    offline.resolve({ ...env(false), ok: false, stderr: 'offline failed' })
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    expect(h.sidecar.calls.filter(call => call.method === 'deps.ensure')).toHaveLength(1)
    expect(h.sidecar.cancelled).toHaveLength(1)
    await expect(h.chat.send(h.root,'codex','blocked','cancelled')).rejects.toThrow()
  } finally { await h.cleanup() }
})

test('both install failures retain offline/online causes and cannot release chat', async () => {
  const h = harness(); let attempt = 0
  h.sidecar.install = async () => ({ ...env(false), ok: false, stderr: ++attempt === 1 ? 'offline wheel corruption' : 'online unavailable' })
  try {
    await h.invoke('project:open',h.root)
    expect(await h.invoke('deps:ensure',h.root,'failure')).toMatchObject({ result: { ok: false,
      attempts: { offline: { stderr: 'offline wheel corruption' }, online: { stderr: 'online unavailable' } } } })
    await expect(h.chat.send(h.root,'codex','blocked','failed')).rejects.toThrow()
    expect(h.sent).toEqual([])
  } finally { await h.cleanup() }
})

test('diagnosis errors never call ensure even through direct main IPC', async () => {
  const h = harness(); h.sidecar.diagnose = async () => { throw { code: 'deps_doctor', message: 'injected failure' } }
  try {
    await h.invoke('project:open',h.root)
    expect(await h.invoke('deps:ensure',h.root,'failure')).toMatchObject({ error: { code: 'deps_doctor' } })
    expect(h.sidecar.calls.filter(call => call.method === 'deps.ensure')).toEqual([])
    await expect(h.chat.send(h.root,'codex','blocked','failed')).rejects.toThrow()
  } finally { await h.cleanup() }
})

test('install success followed by verification failure remains blocked with its original cause', async () => {
  const h = harness(); let checks = 0
  h.sidecar.diagnose = async () => ++checks === 1 ? env(false) : { ...env(false), ok: false, stderr: 'venv import failed' }
  try {
    await h.invoke('project:open',h.root)
    expect(await h.invoke('deps:ensure',h.root,'failure')).toMatchObject({
      error: { code: 'deps_verify', data: { phase: 'verifying', detail: { diagnosis: { stderr: 'venv import failed' } } } }
    })
    await expect(h.chat.send(h.root,'codex','blocked','verify-failed')).rejects.toThrow()
    expect(h.sent).toEqual([])
  } finally { await h.cleanup() }
})

for (const phase of ['checking', 'installing']) {
  for (const failure of ['not_found', 'configure', 'permission']) {
    test(`main retains A preparation after ${failure} open failure during ${phase}`, async () => {
      const h = harness(), pending = Promise.withResolvers<Envelope>()
      if (phase === 'checking') h.sidecar.diagnose = async () => pending.promise
      else h.sidecar.install = async () => { const result = await pending.promise; h.sidecar.ready = true; return result }
      try {
        await h.invoke('project:open', h.root)
        h.chat.setDraft(h.root, '보존할 첫 문장')
        const preparation = phase === 'checking'
          ? h.invoke('rpc', 'deps.doctor', { root: h.root }, 'original-doctor')
          : h.invoke('deps:ensure', h.root, 'original-install')
        await flush()
        if (failure === 'configure') {
          const configure = h.sidecar.configure.bind(h.sidecar)
          h.sidecar.configure = async root => {
            if (root === h.other) throw { code: 'sidecar_down', message: 'injected configure failure' }
            return configure(root)
          }
        }
        if (failure === 'permission') delete h.settings.first_project_permission_asked_at
        expect(await h.invoke('project:open', failure === 'not_found' ? join(h.other, 'missing') : h.other)).toMatchObject({ error: {
          code: failure === 'not_found' ? 'not_found' : failure === 'configure' ? 'sidecar_down' : 'first_project_permission_required'
        } })
        pending.resolve(env(true))
        expect(await preparation).toMatchObject({ result: { ok: true } })
        expect(h.chat.draft(h.root)).toBe('보존할 첫 문장')
        expect(h.sent).toEqual([])
        await h.chat.send(h.root, 'codex', '보존할 첫 문장', 'after-failed-open'); await flush()
        expect(h.sent).toEqual(['보존할 첫 문장'])
      } finally { pending.resolve(env(true)); await h.cleanup() }
    })
  }
}

for (const outcome of ['ready', 'not-ready', 'error', 'cancelled']) {
  test(`manual main diagnosis holds sends until its ${outcome} outcome`, async () => {
    const h = harness(), pending = Promise.withResolvers<Envelope>()
    try {
      h.sidecar.ready = true
      await h.invoke('project:open', h.root)
      await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'initial')
      h.chat.setDraft(h.root, '보존할 재진단 초안')
      h.sidecar.diagnose = async () => pending.promise
      const diagnosis = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'manual')
      await expect(h.chat.send(h.root, 'codex', 'must wait', 'while-checking')).rejects.toThrow()
      expect(h.sent).toEqual([])
      if (outcome === 'cancelled') await h.invoke('rpc:cancel', 'manual')
      if (outcome === 'error') pending.reject({ code: 'deps_doctor', message: 'injected diagnosis failure' })
      else pending.resolve(env(outcome !== 'not-ready'))
      await diagnosis
      expect(h.chat.draft(h.root)).toBe('보존할 재진단 초안')
      if (outcome === 'ready') {
        await h.chat.send(h.root, 'codex', 'verified exactly once', 'after-checking'); await flush()
        expect(h.sent).toEqual(['verified exactly once'])
      } else {
        await expect(h.chat.send(h.root, 'codex', 'must stay blocked', 'after-failure')).rejects.toThrow()
        expect(h.sent).toEqual([])
      }
    } finally { pending.resolve(env(false)); await h.cleanup() }
  })
}

for (const order of ['old-first', 'new-first']) {
  test(`overlapping main diagnoses cannot publish stale ready: ${order}`, async () => {
    const h = harness(), old = Promise.withResolvers<Envelope>(), fresh = Promise.withResolvers<Envelope>()
    try {
      h.sidecar.ready = true
      await h.invoke('project:open', h.root)
      await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'initial')
      let checks = 0
      h.sidecar.diagnose = async () => ++checks === 1 ? old.promise : fresh.promise
      const first = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'old')
      const second = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'fresh')
      if (order === 'old-first') {
        old.resolve(env(true)); await first
        await expect(h.chat.send(h.root, 'codex', 'newer still checking', 'between')).rejects.toThrow()
        fresh.resolve(env(false)); await second
      } else {
        fresh.resolve(env(false)); await second
        old.resolve(env(true)); await first
      }
      await expect(h.chat.send(h.root, 'codex', 'newer blocked', 'after')).rejects.toThrow()
      expect(h.sent).toEqual([])
    } finally { old.resolve(env(false)); fresh.resolve(env(false)); await h.cleanup() }
  })
}

test('an earlier diagnosis still in flight holds chat even after a newer ready result', async () => {
  const h = harness(), old = Promise.withResolvers<Envelope>()
  try {
    h.sidecar.ready = true
    await h.invoke('project:open', h.root)
    await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'initial')
    h.sidecar.diagnose = async () => old.promise
    const pending = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'older')
    h.sidecar.diagnose = async () => env(true)
    await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'newer')
    await expect(h.chat.send(h.root, 'codex', 'older pending', 'pending')).rejects.toThrow()
    old.resolve(env(false)); await pending
    await h.chat.send(h.root, 'codex', 'latest ready', 'ready'); await flush()
    expect(h.sent).toEqual(['latest ready'])
  } finally { old.resolve(env(false)); await h.cleanup() }
})

test('an old A diagnosis cannot overwrite a new A visit after A→B→A', async () => {
  const h = harness(), old = Promise.withResolvers<Envelope>()
  try {
    await h.invoke('project:open', h.root)
    h.sidecar.diagnose = async () => old.promise
    const pending = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'old-A')
    await h.invoke('project:open', h.other); await h.invoke('project:open', h.root)
    h.sidecar.diagnose = async () => env(false)
    await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'new-A')
    old.resolve(env(true)); await pending
    await expect(h.chat.send(h.root, 'codex', 'unprepared new A', 'new-A')).rejects.toThrow()
    expect(h.sent).toEqual([])
  } finally { old.resolve(env(false)); await h.cleanup() }
})

test('a failed newer open cannot revive an older successful main open', async () => {
  const h = harness(), old = Promise.withResolvers<SidecarInfo>()
  try {
    await h.invoke('project:open', h.root)
    h.sidecar.configure = async () => old.promise
    const b = h.invoke('project:open', h.other)
    await h.invoke('project:open', join(h.other, 'missing'))
    old.resolve(h.sidecar.status()); await b
    h.sidecar.ready = true
    await h.invoke('rpc', 'deps.doctor', { root: h.root }, 'retained-A')
    expect(await h.invoke('deps:ensure', h.other, 'rejected-B')).toMatchObject({ error: { code: 'project_changed' } })
    await h.chat.send(h.root, 'codex', 'A remains current', 'still-A'); await flush()
    expect(h.sent).toEqual(['A remains current'])
  } finally { old.resolve(h.sidecar.status()); await h.cleanup() }
})

for (const installed of [false, true]) {
  test(`installation outcome ${installed} owns the gate over an older diagnosis`, async () => {
    const h = harness(), old = Promise.withResolvers<Envelope>()
    try {
      await h.invoke('project:open', h.root)
      h.sidecar.diagnose = async () => old.promise
      const diagnosis = h.invoke('rpc', 'deps.doctor', { root: h.root }, 'old-doctor')
      h.sidecar.diagnose = async () => env(h.sidecar.ready)
      h.sidecar.install = async () => { h.sidecar.ready = installed; return { ...env(installed), ok: installed } }
      await h.invoke('deps:ensure', h.root, 'new-install')
      old.resolve(env(!installed)); await diagnosis
      if (installed) {
        await h.chat.send(h.root, 'codex', 'verified installation', 'installed'); await flush()
        expect(h.sent).toEqual(['verified installation'])
      } else {
        await expect(h.chat.send(h.root, 'codex', 'failed installation', 'failed')).rejects.toThrow()
        expect(h.sent).toEqual([])
      }
    } finally { old.resolve(env(false)); await h.cleanup() }
  })
}
