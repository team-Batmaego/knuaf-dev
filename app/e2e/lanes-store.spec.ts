// Node-only store regressions for `store/lanes.ts`. No Electron, browser, account, or provider process.
import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { LanesReply, LanesSnapshot } from '../src/shared/lanes-ipc'
import type { useLanes as LanesStore } from '../src/renderer/src/store/lanes'

const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }

/** 묶음은 화면이 계산하지 않는 값 묶음이라, 가드가 보는 `root`·`seq` 만 채운다. */
function snapshot(root: string | null, seq: number): LanesSnapshot {
  return {
    root, seq, lines: [], cards: [], events: [], archives: [], announcement: null, stopButton: 'chat',
    settings: { mode: null, source: { kind: 'none' }, rows: [], differsFromRecommendation: false, recommended: null }
  } as unknown as LanesSnapshot
}

function harness() {
  const pushes: ((s: LanesSnapshot) => void)[] = []
  let snapshotCall: (root: string | null) => Promise<LanesReply<LanesSnapshot>> =
    async () => ({ error: { code: 'internal', message: 'unset' } })
  const api = {
    lanes: {
      snapshot: (root: string | null) => snapshotCall(root),
      onSnapshot: (fn: (s: LanesSnapshot) => void) => { pushes.push(fn); return () => undefined },
      decideCard: async () => ({ error: { code: 'internal', message: 'unused' } }),
      cardStatus: async () => ({ error: { code: 'internal', message: 'unused' } }),
      settingsCard: async () => ({ error: { code: 'internal', message: 'unused' } }),
      disable: async () => ({ error: { code: 'internal', message: 'unused' } }),
      reviewModels: async () => ({ error: { code: 'internal', message: 'unused' } }),
      pickReview: async () => ({ error: { code: 'internal', message: 'unused' } }),
      consents: async () => ({ error: { code: 'internal', message: 'unused' } }),
      setConsent: async () => ({ error: { code: 'internal', message: 'unused' } }),
      dismiss: async () => ({ error: { code: 'internal', message: 'unused' } }),
      handoffContinue: async () => ({ error: { code: 'internal', message: 'unused' } }),
      handoffLater: async () => ({ error: { code: 'internal', message: 'unused' } }),
      archives: async () => ({ error: { code: 'internal', message: 'unused' } }),
      archive: async () => ({ error: { code: 'internal', message: 'unused' } })
    },
    jobs: {
      stopOne: async () => ({ error: { code: 'internal', message: 'unused' } }),
      continue: async () => ({ error: { code: 'internal', message: 'unused' } }),
      later: async () => ({ error: { code: 'internal', message: 'unused' } }),
      retry: async () => ({ error: { code: 'internal', message: 'unused' } }),
      discard: async () => ({ error: { code: 'internal', message: 'unused' } }),
      redeliver: async () => ({ error: { code: 'internal', message: 'unused' } }),
      authLater: async () => ({ error: { code: 'internal', message: 'unused' } }),
      deliveryText: async () => ({ result: { text: null } })
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
    runInNewContext(code, {
      module, exports: module.exports, Promise, crypto: globalThis.crypto,
      window: { knuaf: api, addEventListener: () => undefined }, location: { hash: '' },
      setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
      require: (name: string) => {
        if (!name.startsWith('.')) return require(name)
        const target = resolve(dirname(file), name)
        return load(existsSync(target + '.ts') ? target + '.ts' : target)
      }
    })
    return module.exports
  }
  const useLanes = load(join(__dirname, '../src/renderer/src/store/lanes.ts')).useLanes as typeof LanesStore
  // 구독 리스너를 실제로 붙인다 — 밀려온 묶음은 이 통로로만 온다.
  useLanes.getState().attach()
  return {
    store: useLanes,
    /** 밀려온 묶음 — 구독은 `attach` 가 붙인다(여기서는 리스너만 직접 부른다). */
    push: (s: LanesSnapshot) => { for (const fn of pushes) fn(s) },
    answer: (fn: (root: string | null) => Promise<LanesReply<LanesSnapshot>>) => { snapshotCall = fn }
  }
}

test('a late response from the same folder never rolls the snapshot back', async () => {
  const h = harness()
  const response = Promise.withResolvers<LanesReply<LanesSnapshot>>()
  h.answer(() => response.promise)
  const loading = h.store.getState().load('/A')
  await flush()
  // 응답이 오기 전에 더 새 묶음이 밀려왔다 — 같은 폴더.
  h.push(snapshot('/A', 11))
  expect(h.store.getState().snapshot?.seq).toBe(11)
  response.resolve({ result: snapshot('/A', 10) })
  await loading
  const state = h.store.getState()
  expect(state.snapshot?.seq).toBe(11)
  expect(state.root).toBe('/A')
})

test('a push from another folder is dropped and the active folder stays', async () => {
  const h = harness()
  h.answer(async () => ({ result: snapshot('/B', 20) }))
  await h.store.getState().load('/B')
  expect(h.store.getState().snapshot?.seq).toBe(20)
  // 폴더를 옮긴 뒤 늦게 닿은 옛 폴더 묶음 — seq 는 더 크지만 다른 폴더다.
  h.push(snapshot('/A', 21))
  const state = h.store.getState()
  expect(state.root).toBe('/B')
  expect(state.snapshot?.root).toBe('/B')
  expect(state.snapshot?.seq).toBe(20)
})

test('going A → B → A does not let the first, slower A response overwrite the second A load', async () => {
  const h = harness()
  const firstA = Promise.withResolvers<LanesReply<LanesSnapshot>>()
  let call = 0
  h.answer(async (root) => {
    call += 1
    if (root === '/A' && call === 1) return firstA.promise
    if (root === '/B') return { result: snapshot('/B', 20) }
    return { result: snapshot('/A', 21) }
  })
  const slow = h.store.getState().load('/A')
  await flush()
  await h.store.getState().load('/B')
  await h.store.getState().load('/A')
  expect(h.store.getState().snapshot?.seq).toBe(21)
  firstA.resolve({ result: snapshot('/A', 5) })
  await slow
  const state = h.store.getState()
  expect(state.root).toBe('/A')
  expect(state.snapshot?.seq).toBe(21)
})

test('settings opened without a folder adopts the first snapshot root, then keeps only that folder', async () => {
  const h = harness()
  h.store.getState().apply(snapshot('/A', 3))
  expect(h.store.getState().root).toBe('/A')
  h.store.getState().apply(snapshot('/B', 9))
  expect(h.store.getState().snapshot?.seq).toBe(3)
  expect(h.store.getState().snapshot?.root).toBe('/A')
})
