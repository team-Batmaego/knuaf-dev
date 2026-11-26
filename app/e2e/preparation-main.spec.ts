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
import { consumePendingDesign } from '../src/main/lanes/cards'
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
  up = true
  /** 사이드카가 지금 쓰는 앱 의존성 환경(빈 문자열 = 기본 실행기). configure 가 `configureTo()` 로 정한다. */
  activeDeps = ''
  configureTo: () => string = () => ''
  diagnose: () => Promise<Envelope> = async () => env(this.ready)
  install: () => Promise<Envelope> = async () => { this.ready = true; return env(true) }
  status(): SidecarInfo { return { python: '/bundled/python', kind: 'bundled', scriptsDir: join(source, 'scripts'), running: this.up, depsVenv: this.activeDeps } }
  async configure(root: string) { this.configured.push(root); this.up = true; this.activeDeps = this.configureTo(); return this.status() }
  isWrite(method: string) { return method === 'deps.ensure' }
  cancel(id: string) { this.cancelled.push(id) }
  async call(method: string, params: Record<string, unknown>, _onEvent: unknown, onId?: (id: string) => void) {
    if (!this.up) throw { code: 'sidecar_down', message: 'Python 사이드카가 실행 중이 아님' }
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
  const marked: string[] = [], discarded: string[] = [], restored: (string | null)[] = [], events: string[] = []
  let prior: string | null = null, trusted = '', lockHeld = false
  /** 12단계 I-01: 환경 자리 검사 대역 — (논문 폴더, 호출 순번) → 문제 또는 null. */
  let placement: (call: number) => string | null = () => null
  const placementRoots: unknown[] = []
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
    './python': { APP_ROOT: appRoot, basePython: () => '/bundled/python', bundledPython: () => null, venvPython: () => null, wheelhouseDir: () => '/offline/wheels',
      depsRoot: () => join(dir, 'deps'), depsEnvKey: () => 'k0' },
    // S-01 I-01: 표식 쓰기·잔해 폐기는 기록만 한다(대역 사이드카는 실제 환경을 만들지 않는다).
    './deps-env': { markReady: (root: string, key: string) => { marked.push(join(root, key)); events.push('mark'); return join(root, key) },
      discardUnmarked: (root: string, key: string) => { discarded.push(join(root, key)); events.push('discard'); return false },
      // I-03: 이번 작업 전의 표식(있으면 문자열)을 읽어 두고, 실패·취소 때 그것으로 되돌린다(없었으면 null → 표식 제거).
      trustedEnv: () => trusted,
      envPlacement: (_root: string, _key: string, project: unknown) => { placementRoots.push(project); return placement(placementRoots.length) },
      readMark: () => prior,
      restoreMark: (_root: string, _key: string, before: string | null) => { restored.push(before); events.push('restore') },
      // I-01: 공유 환경 전환 잠금 — 한 번에 한 작업. 기다리는 동안 취소·방문 변경이면 null.
      acquireEnvLock: async (_root: string, opts?: { isCancelled?: () => boolean }) => {
        while (lockHeld) { if (opts?.isCancelled?.()) return null; await new Promise(r => setTimeout(r, 5)) }
        lockHeld = true; events.push('lock')
        return () => { lockHeld = false; events.push('unlock') }
      } },
    './settings': { loadSettings: () => settings, rememberRecent: () => {}, saveSettings: () => {} },
    './menu': { openGuide: () => {} },
    './agent': { ...realRequire('./agent'), skillSource: () => source },
    './chat/service': { ChatService: class extends ChatService {
      constructor(options: ConstructorParameters<typeof ChatService>[0]) { super({ ...options, connectionFactory: () => connection }) }
    } }
  }
  const module: Partial<typeof IpcModule> = {}
  factory(name => Object.hasOwn(dependencies,name) ? dependencies[name] : realRequire(name), module)
  sidecar.configureTo = () => marked.at(-1) ?? '' // 표식을 쓴 뒤의 재시작은 목표 환경으로 뜬다(정상)
  const services = module.registerIpc!(sidecar as unknown as Parameters<typeof IpcModule.registerIpc>[0], () => null)
  return { root, other, sidecar, settings, sent, marked, discarded, restored, events,
    placementRoots, setPlacement: (f: (call: number) => string | null) => { placement = f },
    setPrior: (v: string | null) => { prior = v }, setTrusted: (v: string) => { trusted = v }, chat: services.chat,
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
    // S-01 I-01: 설치·검증은 앱 데이터 대상 경로로, 표식은 검증 뒤 한 번, 그다음 재구성.
    const target = h.marked[0]
    expect(h.marked).toEqual([target]); expect(target.endsWith(join('deps', 'k0'))).toBe(true)
    expect(h.sidecar.calls.find(call => call.method === 'deps.ensure')!.params.deps_venv).toBe(target)
    expect(h.sidecar.calls.filter(call => call.method === 'deps.doctor').at(-1)!.params.deps_venv).toBe(target)
    expect(h.discarded).toEqual([target]) // 설치 직전 표식 없는 잔해 정리 한 번(표식 있는 환경은 함수가 건드리지 않음)
    expect(h.sidecar.configured.at(-1)).toBe(h.root)
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
    expect(h.marked).toEqual([]) // S-01 I-01: 취소 → 신뢰 표식 없음, 만들다 만 환경은 폐기
    expect(h.discarded.length).toBeGreaterThanOrEqual(2)
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
    expect(h.marked).toEqual([]) // S-01 I-01: 실패 → 표식 없음
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

test('R272-01 folder switch while reservation waits never applies or consumes the old folder choice', async () => {
  const h = harness()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await h.invoke('project:open', h.root)
    const store = h.chat.lanesStore()
    const pending = { company: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', how: 'main' as const }
    store.setPendingDesign(h.root, pending)
    const held = consumePendingDesign(store, h.root, 'codex', async () => {
      entered.resolve(); await release.promise; throw new Error('release lock without consumption')
    }).catch(() => {})
    await entered.promise
    const appliedRoots: (string | null)[] = []
    h.chat.setModel = async (root, _provider, choice) => { appliedRoots.push(root); return choice }
    const switching = h.invoke('settings:set', { provider_choice: { provider: 'codex', at: 'synthetic' } })
      .then(value => ({ value }), error => ({ error }))
    await h.invoke('project:open', h.other)
    release.resolve(); await held
    const result = await switching
    expect(appliedRoots).toEqual([])
    expect(store.pendingDesign(h.root)).toEqual(pending)
    expect(store.pendingDesign(h.other)).toBeNull()
    expect(result).toHaveProperty('error')
  } finally { release.resolve(); await h.cleanup() }
})

test('R272-01 folder switch during model lookup preserves the reservation', async () => {
  const h = harness()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await h.invoke('project:open', h.root)
    const store = h.chat.lanesStore()
    const pending = { company: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', how: 'main' as const }
    store.setPendingDesign(h.root, pending)
    const lookupRoots: (string | null)[] = []
    h.chat.models = async (root, provider) => {
      lookupRoots.push(root); entered.resolve(); await release.promise
      return { provider, supported: true, selected: null, models: [{
        model: pending.model, name: 'Sol', description: '', efforts: ['high'], defaultEffort: null, isDefault: false
      }] }
    }
    const switching = h.invoke('settings:set', { provider_choice: { provider: 'codex', at: 'synthetic' } })
      .then(value => ({ value }), error => ({ error }))
    await entered.promise
    await h.invoke('project:open', h.other)
    release.resolve()
    expect(await switching).toHaveProperty('error')
    expect(lookupRoots).toEqual([h.root])
    expect(store.pendingDesign(h.root)).toEqual(pending)
    expect(store.pendingDesign(h.other)).toBeNull()
  } finally { release.resolve(); await h.cleanup() }
})


// 검토 r1 I-01: 폴더(root)별 flight 는 합쳐도 설치 대상은 PC 하나(deps/<키>)다 — 다른 폴더의 준비가 진행 중인 설치 환경을
// 잔해로 알고 지우면 안 된다. 잔해 정리~설치~검증~표식~재시작~실패 정리까지 한 작업이 전환 잠금을 쥔다.
test('S-01 I-01: 다른 폴더의 준비는 공유 환경 설치가 끝날 때까지 잔해 정리·설치를 시작하지 않는다', async () => {
  const h = harness(), installA = Promise.withResolvers<Envelope>()
  let ensures = 0
  h.sidecar.install = async () => { events(); return ensures === 1 ? installA.promise : env(true) }
  const events = () => { ensures++; h.events.push('ensure#' + ensures) }
  try {
    await h.invoke('project:open', h.root)
    const a = h.invoke('deps:ensure', h.root, 'A'); await flush()
    expect(ensures).toBe(1)
    await h.invoke('project:open', h.other)
    const b = h.invoke('deps:ensure', h.other, 'B'); await flush()
    await new Promise(r => setTimeout(r, 40)) // B 는 잠금을 기다린다
    expect(ensures).toBe(1)
    expect(h.events.filter(e => e === 'discard')).toHaveLength(1) // A 의 설치 전 정리 하나뿐 — B 가 A 의 환경을 못 지움
    h.sidecar.ready = true
    installA.resolve(env(true))
    expect(await a).toMatchObject({ error: { code: 'project_changed' } })
    expect(await b).toMatchObject({ result: { ok: true } })
    // A 의 설치·정리·잠금 반납이 모두 끝난 뒤에야 B 가 정리·설치한다.
    const order = h.events.join(',')
    expect(order.indexOf('unlock')).toBeLessThan(order.lastIndexOf('lock'))
    expect(h.events.indexOf('ensure#2')).toBeGreaterThan(h.events.indexOf('unlock'))
    expect(h.events.filter(e => e === 'lock')).toHaveLength(2)
    expect(h.events.filter(e => e === 'unlock')).toHaveLength(2)
  } finally { await h.cleanup() }
})

test('S-01 I-01: 잠금을 기다리다 취소하면 정리·설치 없이 cancelled 로 닫고 남의 환경은 안 건드린다', async () => {
  const h = harness(), installA = Promise.withResolvers<Envelope>()
  h.sidecar.install = async () => installA.promise
  try {
    await h.invoke('project:open', h.root)
    const a = h.invoke('deps:ensure', h.root, 'A'); await flush()
    await h.invoke('project:open', h.other)
    const b = h.invoke('deps:ensure', h.other, 'B'); await flush()
    await h.invoke('rpc:cancel', 'B')
    expect(await b).toMatchObject({ error: { code: 'cancelled' } })
    expect(h.events.filter(e => e === 'discard')).toHaveLength(1) // A 의 것뿐
    expect(h.sidecar.calls.filter(c => c.method === 'deps.ensure')).toHaveLength(1)
    installA.resolve(env(true)); await a
  } finally { await h.cleanup() }
})

// 검토 r1 I-03: 표식을 쓴 뒤 재시작 대기 중 취소·실패하면 신뢰 표식이 남아 다음 실행이 반쯤 전환된 환경을 신뢰한다.
test('S-01 I-03: 표식 뒤 재시작 대기 중 취소 — 이번 작업의 표식을 회수하고 사이드카 상태를 되맞춘다', async () => {
  const h = harness(), hold = Promise.withResolvers<void>()
  h.sidecar.configure = async function (this: ControlledSidecar, root: string) {
    this.configured.push(root)
    if (h.marked.length && !h.restored.length) await hold.promise
    return this.status()
  }
  try {
    await h.invoke('project:open', h.root)
    const pending = h.invoke('deps:ensure', h.root, 'owner'); await flush()
    expect(h.marked).toHaveLength(1)
    await h.invoke('rpc:cancel', 'owner')
    hold.resolve()
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    expect(h.restored).toEqual([null]) // 이전에 표식이 없었으니 제거
    expect(h.events.at(-1)).toBe('unlock')
    expect(h.events.slice(h.events.indexOf('restore'))).toEqual(['restore', 'discard', 'unlock']) // 표식 회수 뒤 잔해 폐기
    expect(h.sidecar.configured.length).toBeGreaterThanOrEqual(3) // 열기·전환·되맞춤
  } finally { await h.cleanup() }
})

test('S-01 I-03: 재시작이 실패해도 표식을 회수한다', async () => {
  const h = harness()
  let fail = false
  h.sidecar.configure = async function (this: ControlledSidecar, root: string) {
    this.configured.push(root)
    if (fail && h.marked.length && !h.restored.length) throw { code: 'sidecar_exited', message: 'boom' }
    return this.status()
  }
  try {
    await h.invoke('project:open', h.root)
    fail = true
    const result = await h.invoke('deps:ensure', h.root, 'owner')
    expect(result).toMatchObject({ error: { code: 'sidecar_exited' } })
    expect(h.restored).toEqual([null])
  } finally { await h.cleanup() }
})

test('S-01 I-03: 이전에 정상이던 환경이었다면 회수가 아니라 이전 표식 그대로 되돌린다(폐기하지 않음)', async () => {
  const h = harness(), hold = Promise.withResolvers<void>()
  h.setPrior('{"key":"k0"}')
  h.sidecar.configure = async function (this: ControlledSidecar, root: string) {
    this.configured.push(root)
    if (h.marked.length && !h.restored.length) await hold.promise
    return this.status()
  }
  try {
    await h.invoke('project:open', h.root)
    const pending = h.invoke('deps:ensure', h.root, 'owner'); await flush()
    await h.invoke('rpc:cancel', 'owner'); hold.resolve()
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    expect(h.restored).toEqual(['{"key":"k0"}'])
    expect(h.events.slice(h.events.indexOf('restore'))).toEqual(['restore', 'unlock']) // 이전 환경은 지우지 않는다
  } finally { await h.cleanup() }
})


// 검토 r1 I-04: 이미 열린 폴더에서 사이드카가 내려가 있으면 준비가 deps.doctor 부터 sidecar_down 으로 끝났다.
test('S-01 I-04: 사이드카가 내려가 있으면 준비가 먼저 다시 띄우고(고장 환경이면 기본 실행기로) 진행한다', async () => {
  const h = harness()
  try {
    await h.invoke('project:open', h.root)
    h.sidecar.up = false
    const opened = h.sidecar.configured.length
    const result = await h.invoke('deps:ensure', h.root, 'owner')
    expect(result).toMatchObject({ result: { ok: true } })
    expect(h.sidecar.configured.length).toBeGreaterThan(opened)
    expect(h.sidecar.calls[0].method).toBe('deps.doctor')
  } finally { await h.cleanup() }
})


// 검토 r2 I-04: 새 환경으로 재시작이 실패해 기본 실행기로 복구되면(configure 는 정상 반환) 준비는 성공이 아니다.
test('S-01 I-04 r2: 목표 환경으로 전환하지 못하고 기본 실행기로 복구되면 준비는 실패로 닫고 표식·환경을 정리한다', async () => {
  const h = harness()
  h.sidecar.configureTo = () => '' // 새 환경 기동 실패 → 신뢰 철회 → 기본 실행기(depsVenv 비어 있음)
  try {
    await h.invoke('project:open', h.root)
    const result = await h.invoke('deps:ensure', h.root, 'owner')
    expect(result).toMatchObject({ error: { code: 'deps_activate_failed' } })
    expect(h.restored).toEqual([null]) // 이번 작업의 표식 회수(처음이었으니 제거) + 잔해 폐기
    expect(h.events.slice(h.events.indexOf('restore'))).toEqual(['restore', 'discard', 'unlock'])
    await expect(h.chat.send(h.root, 'codex', 'not ready', 'blocked')).rejects.toThrow() // main 은 ready 가 아니다
    expect(h.sent).toEqual([])
  } finally { await h.cleanup() }
})

// 12단계 I-01(격리 계약 2판 전제 ①②): 환경 자리가 논문 폴더와 겹치거나 앱 데이터 밖이면 준비 버튼이 아무것도 건드리지 않고 거부한다.
for (const problem of ['overlaps_project', 'outside_app_data']) {
  test(`S-01 12단계 I-01: 환경 자리 ${problem} 이면 준비는 진단·잠금·폐기·설치 전에 deps_env_placement 로 닫는다`, async () => {
    const h = harness()
    h.setPlacement(() => problem)
    try {
      await h.invoke('project:open', h.root)
      const result = await h.invoke('deps:ensure', h.root, 'owner')
      expect(result).toMatchObject({ error: { code: 'deps_env_placement', data: { phase: 'checking', detail: { problem } } } })
      expect(h.placementRoots[0]).toBe(h.root)
      expect(h.sidecar.calls).toEqual([])
      expect(h.events).toEqual([])
      expect(h.marked).toEqual([])
    } finally { await h.cleanup() }
  })
}

test('S-01 12단계 I-01: 설치 뒤에 자리가 어긋났으면(링크로 바뀜) 표식을 쓰지 않고, 폐기도 하지 않고 닫는다', async () => {
  const h = harness()
  let installed = false
  h.sidecar.install = async () => { installed = true; h.sidecar.ready = true; return env(true) }
  h.setPlacement(() => installed ? 'outside_app_data' : null)
  try {
    await h.invoke('project:open', h.root)
    const result = await h.invoke('deps:ensure', h.root, 'owner')
    expect(result).toMatchObject({ error: { code: 'deps_env_placement' } })
    expect(h.marked).toEqual([])
    // 설치 전 폐기 + 실패 정리의 폐기 호출. 실제 discardUnmarked 는 어긋난 자리를 지우지 않는다(venv-guard.spec 가 잠근다).
    expect(h.events.slice(h.events.indexOf('lock'))).toEqual(['lock', 'discard', 'discard', 'unlock'])
  } finally { await h.cleanup() }
})

