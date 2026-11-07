// Node-only store regressions. No Electron, browser, account, or provider process is launched.
import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { DependencyReport, Envelope } from '../src/shared/types'
import type { useProject as ProjectStore } from '../src/renderer/src/store/project'
import type { usePrep as PrepStore } from '../src/renderer/src/store/prep'
import type { useChat as ChatStore } from '../src/renderer/src/store/chat'
import type { rpc as RendererRpc } from '../src/renderer/src/rpc'

const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
const report = (ready: boolean): DependencyReport => ({
  ready, current_python: '/bundled/python', venv_python: ready ? '/project/.venv/bin/python3' : null,
  selected_python: ready ? '/project/.venv/bin/python3' : null,
  dependencies: [{ dist: 'docx', purpose: 'Word', status: ready ? 'installed' : 'missing',
    current: { imported: true, version: '1.2', version_in_range: true, status: 'installed' },
    venv: ready ? { imported: true, version: '1.2', version_in_range: true, status: 'installed' } : null }]
})
const envelope = (data: unknown): Envelope => ({ ok: true, exit: 0, data, status: null, path: null,
  block_reason: null, stdout: '', stderr: '', argv: [], python: '/bundled/python', duration_ms: 1 })

function harness() {
  const calls: string[] = [], sent: string[] = []
  let doctor: (root: string) => Promise<unknown> = async () => ({ result: envelope(report(true)) })
  let ensure: (root: string) => Promise<unknown> = async () => ({ result: envelope({ status: 'installed' }) })
  let open: (root: string) => Promise<unknown> = async () => ({ result: { hasProject: false, sidecar: { python: '/bundled/python', kind: 'bundled' } } })
  const api = {
    openProject: (root: string) => open(root),
    peekProject: async () => ({ hasProject: false }), getSettings: async () => ({}),
    sidecarInfo: async () => ({ python: '/project/.venv/bin/python3', kind: 'venv', running: true }),
    call: async (method: string, params: { root: string }) => { calls.push(method); return doctor(params.root) },
    depsEnsure: async (root: string) => { calls.push('deps.ensure'); return ensure(root) },
    cancel: async () => false,
    chat: {
      load: async () => ({ result: { messages: [], state: 'idle', provider: 'codex' } }),
      snapshot: async () => ({ result: { messages: [], state: 'idle', provider: 'codex' } }),
      draft: async () => ({ result: '' }),
      status: async () => ({ result: { connected: false, installed: false } }),
      setDraft: async () => ({ result: true }),
      send: async (_root: string, _provider: string, body: string) => { sent.push(body); return { result: { messages: [], state: 'idle' } } }
    }
  }
  const cache = new Map<string, { exports: Record<string, unknown> }>()
  const load = (file: string): Record<string, unknown> => {
    file = resolve(file)
    const cached = cache.get(file)
    if (cached) return cached.exports
    const module = { exports: {} as Record<string, unknown> }
    cache.set(file, module)
    const code = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
    runInNewContext(code, { module, exports: module.exports, Promise, crypto: globalThis.crypto,
      window: { knuaf: api, innerWidth: 1280 }, location: { hash: '' },
      setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
      require: (name: string) => {
        if (!name.startsWith('.')) return require(name)
        const target = resolve(dirname(file), name)
        return load(existsSync(target + '.ts') ? target + '.ts' : target)
      }
    })
    return module.exports
  }
  const project = load(join(__dirname, '../src/renderer/src/store/project.ts')).useProject as typeof ProjectStore
  const prep = load(join(__dirname, '../src/renderer/src/store/prep.ts')).usePrep as typeof PrepStore
  const chat = load(join(__dirname, '../src/renderer/src/store/chat.ts')).useChat as typeof ChatStore
  const rpc = load(join(__dirname, '../src/renderer/src/rpc.ts')).rpc as typeof RendererRpc
  return { project, prep, chat, rpc, api, calls, sent,
    setDoctor: (fn: typeof doctor) => { doctor = fn }, setEnsure: (fn: typeof ensure) => { ensure = fn },
    setOpen: (fn: typeof open) => { open = fn },
    async open(root = '/A') {
      await project.getState().open(root)
      await flush()
      chat.setState({ root, provider: 'codex', visit: chat.getState().visit + 1, draft: '보존할 첫 문장', busy: false })
    }
  }
}

test('checking is registered before peek; checking/installing/verifying never release a send', async () => {
  const h = harness(), first = Promise.withResolvers<unknown>(), verification = Promise.withResolvers<unknown>(), installed = Promise.withResolvers<unknown>()
  let diagnosed = 0
  h.setDoctor(async () => ++diagnosed === 1 ? first.promise : verification.promise)
  h.setEnsure(async () => installed.promise)
  h.api.peekProject = async () => {
    expect(h.prep.getState().dependencies['/A'].phase).toBe('checking')
    expect(h.prep.getState().prep['/A']).toBe(1)
    return { hasProject: false }
  }
  await h.open()
  const send = h.chat.getState().send()
  await flush(); expect(h.sent).toEqual([])
  first.resolve({ result: envelope(report(false)) }); await flush()
  expect(h.prep.getState().dependencies['/A'].phase).toBe('installing'); expect(h.sent).toEqual([])
  installed.resolve({ result: envelope({ status: 'installed' }) }); await flush()
  expect(h.prep.getState().dependencies['/A'].phase).toBe('verifying'); expect(h.sent).toEqual([])
  verification.resolve({ result: envelope(report(true)) })
  expect(await send).toBe(true); expect(h.sent).toEqual(['보존할 첫 문장'])
  expect(h.prep.getState().prep).toEqual({})
})

for (const diagnosis of [{ result: envelope(null) }, { result: envelope({ ready: true, dependencies: [] }) },
  { error: { code: 'internal', message: 'injected doctor failure' } }]) {
  test(`diagnosis failure ${JSON.stringify(diagnosis)} blocks repeated sends and preserves input`, async () => {
    const h = harness(); h.setDoctor(async () => diagnosis)
    await h.open()
    expect(h.prep.getState().dependencies['/A'].phase).toBe('blocked')
    expect(await h.chat.getState().send()).toBe(false)
    h.project.getState().clearError(); h.chat.getState().clearError()
    expect(await h.chat.getState().send()).toBe(false)
    expect(h.chat.getState().draft).toBe('보존할 첫 문장')
    expect(h.chat.getState().busy).toBe(false); expect(h.chat.getState().waitingPrep).toBe(false)
    expect(h.calls.filter(x => x === 'deps.ensure')).toEqual([])
    expect(h.sent).toEqual([])
    h.setDoctor(async () => ({ result: envelope(report(true)) }))
    await h.project.getState().prepareDeps('/A')
    expect(h.sent).toEqual([]) // Retry does not resurrect a refused send.
    expect(await h.chat.getState().send()).toBe(true)
  })
}

for (const code of ['agent_busy', 'cancelled', 'deps_verify']) {
  test(`${code} ends waiting without losing the draft`, async () => {
    const h = harness(); h.setDoctor(async () => ({ result: envelope(report(false)) }))
    h.setEnsure(async () => ({ error: { code, message: code } }))
    await h.open(); expect(await h.chat.getState().send()).toBe(false)
    expect(h.chat.getState().draft).toBe('보존할 첫 문장')
    expect(h.prep.getState().dependencies['/A'].error?.code).toBe(code)
    expect(h.prep.getState().prep).toEqual({})
    expect(h.sent).toEqual([])
  })
}

test('successful ensure with a failed recheck remains blocked', async () => {
  const h = harness(); h.setDoctor(async () => ({ result: envelope(report(false)) }))
  await h.open(); expect(await h.chat.getState().send()).toBe(false)
  expect(h.prep.getState().dependencies['/A'].error?.phase).toBe('verifying')
  expect(h.chat.getState().draft).toBe('보존할 첫 문장')
  expect(h.calls.filter(x => x === 'deps.ensure')).toEqual(['deps.ensure'])
})

test('automatic/manual same-visit preparation joins one physical ensure', async () => {
  const h = harness(), install = Promise.withResolvers<unknown>(); let ready = false
  h.setDoctor(async () => ({ result: envelope(report(ready)) }))
  h.setEnsure(async () => { const result = await install.promise; ready = true; return result })
  await h.open()
  const first = h.project.getState().prepareDeps('/A'), second = h.project.getState().prepareDeps('/A')
  expect(first).toBe(second)
  install.resolve({ result: envelope({ status: 'installed' }) })
  expect((await first).phase).toBe('ready')
  expect(h.calls.filter(x => x === 'deps.ensure')).toEqual(['deps.ensure'])
  expect(h.prep.getState().prep).toEqual({})
})

test('A→B→A discards the old visit and diagnoses A anew before ready', async () => {
  const h = harness(), old = Promise.withResolvers<unknown>(), fresh = Promise.withResolvers<unknown>(); let a = 0
  h.setDoctor(async root => root === '/A' ? (++a === 1 ? old.promise : fresh.promise) : { result: envelope(report(true)) })
  await h.open('/A'); const oldVisit = h.prep.getState().dependencies['/A'].visit
  await h.open('/B'); await h.open('/A')
  expect(h.prep.getState().dependencies['/A'].visit).not.toBe(oldVisit)
  old.resolve({ result: envelope(report(true)) }); await flush()
  expect(h.prep.getState().dependencies['/A'].phase).toBe('checking')
  fresh.resolve({ result: envelope(report(true)) }); await flush()
  expect(h.prep.getState().dependencies['/A'].phase).toBe('ready')
  expect(a).toBe(2); expect(h.prep.getState().prep).toEqual({})
})

test('read-only diagnosis never installs an unprepared environment', async () => {
  const h = harness(); await h.open(); h.setDoctor(async () => ({ result: envelope(report(false)) }))
  const before = h.calls.filter(x => x === 'deps.ensure').length
  const result = await h.project.getState().prepareDeps('/A', { install: false })
  expect(result.phase).toBe('blocked'); expect(result.error?.code).toBe('deps_required')
  expect(h.calls.filter(x => x === 'deps.ensure').length).toBe(before)
})

test('cancellation during diagnosis prevents the following installation even without a remote ack', async () => {
  const h = harness(); await h.open()
  const diagnosis = Promise.withResolvers<unknown>()
  h.setDoctor(async () => diagnosis.promise)
  const preparation = h.project.getState().prepareDeps('/A', { clientId: 'manual-cancel' })
  expect(await h.project.getState().cancelDeps('manual-cancel')).toBe(false)
  diagnosis.resolve({ result: envelope(report(false)) })
  expect((await preparation).error?.code).toBe('cancelled')
  expect(h.calls.filter(method => method === 'deps.ensure')).toEqual([])
  expect(await h.chat.getState().send()).toBe(false)
  expect(h.chat.getState().draft).toBe('보존할 첫 문장')
})

test('an explicit prepare joining a pending read-only diagnosis still prepares once', async () => {
  const h = harness(); await h.open()
  const diagnosis = Promise.withResolvers<unknown>(); let ready = false, first = true
  h.setDoctor(async () => { if (first) { first = false; return diagnosis.promise } return { result: envelope(report(ready)) } })
  h.setEnsure(async () => { ready = true; return { result: envelope({ status: 'installed' }) } })
  const checked = h.project.getState().prepareDeps('/A', { install: false })
  const prepared = h.project.getState().prepareDeps('/A')
  diagnosis.resolve({ result: envelope(report(false)) })
  expect((await prepared).phase).toBe('ready')
  expect((await checked).phase).toBe('ready')
  expect(h.calls.filter(method => method === 'deps.ensure')).toEqual(['deps.ensure'])
})

for (const source of [undefined, '']) {
  test(`registered workbook bypasses major gate with source=${JSON.stringify(source)}`, async () => {
    const h = harness()
    h.api.call = async (method: string) => {
      if (method === 'materials.list') return { result: { current_finance: { provided: true, path: 'sources/학생 재무.xlsx' } } }
      if (method === 'excel.inspect') return { error: { code: 'read_failed', message: 'selected student workbook is corrupt' } }
      return { error: { code: 'major_required', message: 'no major selected' } }
    }
    // A broken selected file must reach inspection, not the unrelated major gate or a template fallback.
    const failure = await h.rpc.script('excel.inspect', { root: '/A', source }).catch(error => error)
    expect(failure.code).toBe('read_failed')
  })

  test(`no workbook retains major preflight with source=${JSON.stringify(source)}`, async () => {
    const h = harness()
    h.api.call = async (method: string) => method === 'materials.list'
      ? { result: { current_finance: { provided: false, path: null } } }
      : { error: { code: method === 'project.major' ? 'major_required' : 'unexpected_inspection', message: 'no major selected' } }
    const failure = await h.rpc.script('excel.inspect', { root: '/A', source }).catch(error => error)
    expect(failure.code).toBe('major_required')
  })
}

test('explicit workbook does not read canonical materials or major', async () => {
  const h = harness()
  h.api.call = async (method: string) => ({ error: { code: method === 'excel.inspect' ? 'read_failed' : 'project_missing', message: 'no canonical' } })
  const failure = await h.rpc.script('excel.inspect', { root: '/A', source: '학생 재무.xlsx' }).catch(error => error)
  expect(failure.code).toBe('read_failed')
})

test('cancelling registered-source lookup prevents a later inspect dispatch', async () => {
  const h = harness(), materials = Promise.withResolvers<unknown>()
  let inspected = false
  h.api.call = async (method: string) => {
    if (method === 'materials.list') return materials.promise
    inspected = true
    return { error: { code: 'major_required', message: 'unbound' } }
  }
  const pending = h.rpc.script('excel.inspect', { root: '/A', source: '' }, undefined, 'inspect-cancel').catch(error => error)
  expect(await h.rpc.cancel('inspect-cancel')).toBe(true)
  materials.resolve({ result: { current_finance: { provided: true, path: 'sources/학생 재무.xlsx' } } })
  expect((await pending).code).toBe('cancelled'); await flush()
  expect(inspected).toBe(false)
})

for (const phase of ['checking', 'installing']) {
  for (const code of ['not_found', 'sidecar_down', 'first_project_permission_required', 'folder_not_writable']) {
    test(`failed open ${code} while A is ${phase} completes A and preserves its draft`, async () => {
      const h = harness(), pending = Promise.withResolvers<unknown>()
      if (phase === 'checking') h.setDoctor(async () => pending.promise)
      else {
        let first = true
        h.setDoctor(async () => { const ready = !first; first = false; return { result: envelope(report(ready)) } })
        h.setEnsure(async () => pending.promise)
      }
      await h.open()
      expect(h.prep.getState().dependencies['/A'].phase).toBe(phase)
      const preparation = h.project.getState().prepareDeps('/A')
      h.setOpen(async () => ({ error: { code, message: 'injected folder open failure' } }))
      await h.project.getState().open('/B')
      pending.resolve({ result: envelope(report(true)) })
      await preparation; await flush()
      expect(h.project.getState().root).toBe('/A')
      expect(h.prep.getState().dependencies['/A'].phase).toBe('ready')
      expect(h.prep.getState().prep).toEqual({})
      expect(h.chat.getState().draft).toBe('보존할 첫 문장')
      expect(h.sent).toEqual([])
      expect(await h.chat.getState().send()).toBe(true)
      expect(h.sent).toEqual(['보존할 첫 문장'])
    })
  }
}

test('a newer failed open never revives an older successful open response', async () => {
  const h = harness(), old = Promise.withResolvers<unknown>()
  await h.open('/A')
  h.setOpen(async root => root === '/B' ? old.promise : { error: { code: 'not_found', message: 'missing C' } })
  const b = h.project.getState().open('/B')
  await h.project.getState().open('/C')
  old.resolve({ result: { hasProject: false, sidecar: { kind: 'bundled' } } })
  await b
  expect(h.project.getState().root).toBe('/A')
  expect(h.chat.getState().draft).toBe('보존할 첫 문장')
  expect(h.sent).toEqual([])
})

test('A preparation failure after a failed switch becomes retryable blocked, never orphaned checking', async () => {
  const h = harness(), diagnosis = Promise.withResolvers<unknown>()
  h.setDoctor(async () => diagnosis.promise)
  await h.open('/A')
  const preparation = h.project.getState().prepareDeps('/A')
  h.setOpen(async () => ({ error: { code: 'sidecar_down', message: 'B configure failed' } }))
  await h.project.getState().open('/B')
  diagnosis.resolve({ error: { code: 'sidecar_down', message: 'A diagnosis interrupted' } })
  await preparation
  expect(h.prep.getState().dependencies['/A'].phase).toBe('blocked')
  expect(h.prep.getState().prep).toEqual({})
  expect(await h.chat.getState().send()).toBe(false)
  expect(h.chat.getState().draft).toBe('보존할 첫 문장')
  h.setDoctor(async () => ({ result: envelope(report(true)) }))
  await h.project.getState().prepareDeps('/A')
  expect(h.prep.getState().dependencies['/A'].phase).toBe('ready')
  expect(h.sent).toEqual([])
  expect(await h.chat.getState().send()).toBe(true)
  expect(h.sent).toEqual(['보존할 첫 문장'])
})
