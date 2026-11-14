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
function snapshot(root: string | null, seq: number, patch: Partial<LanesSnapshot> = {}): LanesSnapshot {
  return {
    root, seq, lines: [], cards: [], events: [], archives: [], announcement: null, stopButton: 'chat',
    settings: { mode: null, source: { kind: 'none' }, rows: [], differsFromRecommendation: false, recommended: null },
    ...patch
  } as unknown as LanesSnapshot
}

/**
 * `testHooks` 기본값 = `true`.
 *
 * 제품 실행과 같은 조건(`testHooks` 없음)은 `harness({ testHooks: false })` 로 명시한다 — preload 가
 * `KNUAF_E2E_TEST_HOOKS=1` 없이 띄운 실행에서 `knuaf.testHooks` 가 `false`(또는 없음)인 것과 같다.
 */
function harness(opts: { testHooks?: boolean } = {}) {
  const pushes: ((s: LanesSnapshot) => void)[] = []
  /** `window` 리스너 — 표적 주입 통로(`knuaf:lanes-test`)를 그대로 부르려고 모아 둔다. */
  const listeners = new Map<string, (event: unknown) => void>()
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
      window: {
        knuaf: { ...api, testHooks: opts.testHooks !== false },
        addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn) }
      }, location: { hash: '' },
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
    /** `window` 에 실제로 걸린 리스너 이름들 — 시험 통로가 등록됐는지 자체를 본다(I-01). */
    listeners,
    /** 밀려온 묶음 — 구독은 `attach` 가 붙인다(여기서는 리스너만 직접 부른다). */
    push: (s: LanesSnapshot) => { for (const fn of pushes) fn(s) },
    /** `knuaf:lanes-test` 주입 — 화면 시험이 묶음을 넣는 통로 그대로. */
    inject: (s: LanesSnapshot) => { listeners.get('knuaf:lanes-test')?.({ detail: s }) },
    /** `knuaf:lanes-test-archive`·`knuaf:lanes-seam-test` — 같은 규칙으로 걸린다(I-01). */
    fire: (type: string, detail: unknown) => { listeners.get(type)?.({ detail }) },
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

/**
 * C4 배선 뒤 회귀: 실제 이음매가 늘 있으므로 `load` 가 먼저 실제 묶음(seq 1)을 넣고,
 * 화면 시험의 주입 묶음도 seq 1부터 센다. `apply` 의 seq 가드로 주입이 깔리면 장면이 비어
 * 시험 두 개(lanes-shots 의 채팅·설정)가 기본값을 그렸다. 주입은 그 가드만 지나야 한다.
 *
 * 검토 R-01 — 이 시험이 고침 전 코드에서도 통과했던 이유를 없앤다:
 * ① 주입 묶음의 **내용**을 실제 묶음과 다르게 해서(같아서 "덮였는지"를 구별할 수 없었다)
 *    주입이 이겼음을 값으로 확인하고, ② 뒤따르는 실제 묶음은 `h.push()`(진짜 구독 경로)로 넣는다
 *    (`h.inject()` 로 넣으면 "실제 구독 경로가 회복됐는가"를 전혀 보지 않는다).
 */
test('an injected scene snapshot wins over the live snapshot that load already put in, then the real subscription recovers', async () => {
  const h = harness()
  h.answer(async () => ({ result: snapshot('/A', 1, { stopButton: 'chat' }) }))
  await h.store.getState().load('/A')
  expect(h.store.getState().snapshot?.stopButton).toBe('chat')

  // ① 같은 seq·같은 폴더지만 **내용이 다른** 장면 — 주입이 가드를 지나 상태를 갈아치운다.
  h.inject(snapshot('/A', 1, { stopButton: 'chat-and-lanes' }))
  const injected = h.store.getState()
  expect(injected.injected).toBe(true)
  expect(injected.snapshot?.seq).toBe(1)
  expect(injected.snapshot?.stopButton).toBe('chat-and-lanes')

  // ② 실제 구독 경로(`onSnapshot`)로 더 새 묶음이 오면 장면이 풀리고 실제 값이 이긴다.
  h.push(snapshot('/A', 2, { stopButton: 'chat' }))
  const recovered = h.store.getState()
  expect(recovered.injected).toBe(false)
  expect(recovered.snapshot?.seq).toBe(2)
  expect(recovered.snapshot?.stopButton).toBe('chat')
})

/**
 * 검토 I-01 (a) — **제품 조건**(시험 신호 off)에서는 주입 통로가 아예 등록되지 않는다.
 *
 * preload 가 `KNUAF_E2E_TEST_HOOKS=1` 없이 띄운 실행과 같다. 이 시험이 고침을 빼면 실패하는 이유:
 * 고침 전 `attach()` 는 시험 여부를 보지 않고 세 리스너를 걸었으므로 세 사건 모두 상태를 바꿨다.
 */
test('with the test signal off, none of the three test channels change the rendered state', async () => {
  const h = harness({ testHooks: false })
  h.answer(async () => ({ result: snapshot('/A', 5, { stopButton: 'chat' }) }))
  await h.store.getState().load('/A')

  // 리스너가 걸리지 않았음 자체를 먼저 못 박는다 — 상태만 보면 "걸렸는데 무시"도 통과한다.
  expect([...h.listeners.keys()]).toEqual([])

  // 실제보다 큰 seq 로 덮어쓰기(회복 불가 시나리오)와 옛 seq 로 되돌리기를 둘 다 쏜다.
  h.fire('knuaf:lanes-test', snapshot('/A', 9_999, { stopButton: 'chat-and-lanes' }))
  h.fire('knuaf:lanes-test', snapshot('/A', 1, { stopButton: 'chat-and-lanes' }))
  h.fire('knuaf:lanes-test-archive', { summary: { archiveId: 'a1' }, messages: [] })
  h.fire('knuaf:lanes-seam-test', { lanes: {}, jobs: {} })

  const state = h.store.getState()
  expect(state.snapshot?.seq).toBe(5)
  expect(state.snapshot?.stopButton).toBe('chat')
  expect(state.injected).toBe(false)
  expect(state.testArchives).toEqual([])
  expect([...h.listeners.keys()]).toEqual([])

  // 뒤따르는 실제 묶음도 정상으로 붙는다 — 큰 seq 가 상태를 막지 않았다는 증거.
  h.push(snapshot('/A', 6, { stopButton: 'chat' }))
  expect(h.store.getState().snapshot?.seq).toBe(6)
})

/**
 * 검토 I-01 (b) — 시험 신호가 켜진 실행에서도 **폴더가 다른 주입은 거절**한다.
 *
 * 고침 전에는 `apply()` 를 건너뛰어 root 검사가 없었다 — B 폴더 묶음을 넣으면 화면이 B 로 바뀌었다.
 */
test('with the test signal on, an injection from another folder is still refused', async () => {
  const h = harness()
  h.answer(async () => ({ result: snapshot('/A', 3, { stopButton: 'chat' }) }))
  await h.store.getState().load('/A')
  expect(h.store.getState().root).toBe('/A')

  h.inject(snapshot('/B', 4, { stopButton: 'chat-and-lanes' }))
  const state = h.store.getState()
  expect(state.root).toBe('/A')
  expect(state.snapshot?.root).toBe('/A')
  expect(state.snapshot?.seq).toBe(3)
  expect(state.snapshot?.stopButton).toBe('chat')
  expect(state.injected).toBe(false)

  // 같은 폴더의 주입은 여전히 통한다 — 거절이 "시험 통로 전체를 죽인" 것이 아님을 보인다.
  h.inject(snapshot('/A', 4, { stopButton: 'chat-and-lanes' }))
  expect(h.store.getState().snapshot?.stopButton).toBe('chat-and-lanes')
})
