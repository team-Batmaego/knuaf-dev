// Node-only regressions for the 설정 확인 창 card (검토 C01). No Electron, browser, account, or provider process.
//
// C01 이 지적한 것: 설정의 [나눠 맡기기 켜기]·[추천으로 되돌리기]는 확인 창을 띄워야 하는데,
// `laneActions().settingsCard()` 가 응답 `LaneCard` 를 버리고 성공 여부만(`ask`) 돌려주면 그릴 카드가 없다.
// 계약 `lanes-ipc.ts` [F5] 가 설정 미결 카드를 `snapshot.cards` 에서 빼므로 push 로도 메울 수 없다.
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, JsxEmit, ModuleKind, ScriptTarget } from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CardAction, CardDecision, LaneCard, LaneLine } from '../src/shared/lanes-ipc'
import { LANE_ACTION, LANE_CARD, LANE_EVENT, LANE_NAME } from '../src/renderer/src/copy-lanes'
import { CHAT } from '../src/renderer/src/copy'
import { entryText, eventView } from '../src/renderer/src/laneLines'
import type { LaneEvent } from '../src/shared/lanes-ipc'

const SRC = join(__dirname, '../src/renderer/src')
const UNUSED = async () => ({ error: { code: 'internal' as const, message: 'unused' } })

/** 설정 켜기 카드 — main 이 계산해 보내는 값이라 그리기 분기에 필요한 것만 채운다. */
function settingsCard(state: LaneCard['state'] = { kind: 'open' }): LaneCard {
  return {
    cardId: 'card-settings-1',
    root: '/A',
    variant: 'settings-enable',
    baseVersion: 4,
    createdAt: '2026-11-10T12:00:00+09:00',
    reviewDue: false,
    quote: null,
    rows: [{
      lane: 'research',
      before: { company: 'claude', model: 'claude-opus-4', effort: 'high', how: 'sub' },
      after: { company: 'codex', model: 'gpt-6.1-sol', effort: 'high', how: 'sub' },
      rejected: null,
      designSwitchTo: null,
      requested: null
    }],
    fees: [],
    fastDrain: false,
    recommendedDesign: { company: 'claude', model: 'claude-opus-4', effort: 'high' },
    state
  }
}

/**
 * `store/lanes.ts` 를 Node VM 에서 그대로 돌린다 — 화면 없이 요청·응답 통로만 본다.
 * 가짜 `window.knuaf.lanes` 가 main 의 응답을 대신한다.
 */
function laneStore(api: {
  settingsCard?: (...args: never[]) => Promise<unknown>
  decideCard?: (...args: never[]) => Promise<unknown>
} = {}) {
  const knuaf = {
    lanes: {
      snapshot: UNUSED, onSnapshot: () => () => undefined,
      decideCard: api.decideCard ?? UNUSED, cardStatus: UNUSED,
      settingsCard: api.settingsCard ?? UNUSED,
      disable: UNUSED, reviewModels: UNUSED, pickReview: UNUSED, consents: UNUSED, setConsent: UNUSED,
      dismiss: UNUSED, handoffContinue: UNUSED, handoffLater: UNUSED, archives: UNUSED, archive: UNUSED
    },
    jobs: { deliveryText: async () => ({ result: { text: null } }) }
  }
  const cache = new Map<string, Record<string, unknown>>()
  const load = (file: string): Record<string, unknown> => {
    const abs = resolve(file)
    const hit = cache.get(abs)
    if (hit) return hit
    const exports: Record<string, unknown> = {}
    cache.set(abs, exports)
    const code = transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      exports, module: { exports }, Promise, crypto: globalThis.crypto,
      window: { knuaf, addEventListener: () => undefined }, location: { hash: '' },
      setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
      require: (name: string) => {
        if (!name.startsWith('.')) return require(name)
        const target = resolve(dirname(abs), name)
        return load(existsSync(target + '.ts') ? target + '.ts' : target)
      }
    })
    return exports
  }
  const store = load(join(SRC, 'store/lanes.ts'))
  const useLanes = store.useLanes as { getState: () => Record<string, unknown>; setState: (partial: unknown) => void }
  useLanes.getState().attach()
  return { useLanes, laneActions: store.laneActions as () => Record<string, (...args: never[]) => Promise<unknown>> }
}

/**
 * 실제 화면 소스를 React 로 정적 렌더한다(설계 §3-3 "대화 카드와 같은 부품").
 * `stubs` 는 store 처럼 화면 밖 상태를 읽는 모듈만 갈아 끼운다 — 그 밖의 부품·문구는 앱 그대로다.
 */
function renderWith(file: string, name: string, props: Record<string, unknown>, stubs: Record<string, unknown>): string {
  const nodeRequire = createRequire(file)
  const cache = new Map<string, Record<string, unknown>>()
  const compile = (abs: string, exports: Record<string, unknown>, extra: Record<string, unknown>): void => {
    const code = transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      exports, module: { exports }, ...extra,
      require: (spec: string) => {
        if (spec in stubs) return stubs[spec]
        if (!spec.startsWith('.')) return nodeRequire(spec)
        const resolved = resolve(dirname(abs), spec)
        const target = [resolved + '.tsx', resolved + '.ts', resolved].find((p) => existsSync(p)) ?? resolved
        const hit = cache.get(target)
        if (hit) return hit
        const child: Record<string, unknown> = {}
        cache.set(target, child)
        compile(target, child, {})
        return child
      }
    })
  }
  const exports: Record<string, unknown> = {}
  cache.set(resolve(file), exports)
  compile(resolve(file), exports, {})
  const Component = exports[name] as (p: Record<string, unknown>) => unknown
  return renderToStaticMarkup(createElement(Component, props) as never)
}

test('C01: 설정 켜기 카드는 응답 값으로 돌아온다 — 버리면 확인 창을 그릴 수 없다', async () => {
  const card = settingsCard()
  const { laneActions, useLanes } = laneStore({ settingsCard: async () => ({ result: card }) })
  const r = (await laneActions().settingsCard('/A', 'enable')) as { value?: LaneCard; error?: string }
  // `ask` 로 되돌리면 여기서 `null` 이 온다 — 그 한 줄이 C01 원문 재현이다.
  expect(r.value).toEqual(card)
  // 설정 카드는 화면 로컬 상태다 — 묶음에 섞이지 않는다(계약 §3 [F5]).
  expect(useLanes.getState().snapshot).toBeNull()
})

test('C01: 설정 카드 결정은 무효 사유까지 돌려주고 카드 id 로 적어 둔다', async () => {
  const card = settingsCard({ kind: 'invalid' })
  const decision: CardDecision = { outcome: 'invalid', reason: 'account-changed', card, boundTurn: null }
  const { laneActions, useLanes } = laneStore({ decideCard: async () => ({ result: decision }) })
  const r = (await laneActions().decideCard('/A', card.cardId, card.baseVersion, 'continue')) as CardDecision | null
  expect(r?.reason).toBe('account-changed')
  expect((useLanes.getState().invalid as Record<string, string>)[card.cardId]).toBe('account-changed')
})

/**
 * 검토 C07-① — 예전 시험은 `applied` 상태를 직접 넣어 카드만 그렸고, 승인 단추가 main 에 무엇을
 * 보내는지·두 번째 누름이 어떻게 돌아오는지는 한 번도 보지 않았다.
 *
 * 층을 나눈다: 여기(store)는 **보내는 값과 응답의 뜻**을, `C04` 시험은 **누르는 동안 단추가 잠기는지**
 * (`disabled={busy}`)를 본다. store 의 `decideCard` 자체에는 중복 호출 가드가 없다 — 그래서 이 시험은
 * "두 번 눌러도 요청이 한 건"을 주장하지 않는다. 그건 화면이 막는 것이고, 두 번째 요청이 실제로 나갔을 때
 * main 이 `already-handled` 로 돌려주는 것이 여기서 확인할 계약이다.
 */
test('C07-①: 승인은 카드 id·판·단추를 그대로 보내고, 두 번째 응답(already-handled)은 화면 상태를 흔들지 않는다', async () => {
  const open = settingsCard({ kind: 'open' })
  const applied = settingsCard({ kind: 'applied', scope: 'continue' })
  const calls: unknown[][] = []
  const decisions: CardDecision[] = [
    { outcome: 'applied', reason: null, card: applied, boundTurn: null },
    { outcome: 'already-handled', reason: null, card: applied, boundTurn: null }
  ]
  const { laneActions, useLanes } = laneStore({
    decideCard: async (...args: never[]) => {
      calls.push(args as unknown[])
      return { result: decisions[calls.length - 1] }
    }
  })

  const first = (await laneActions().decideCard('/A', open.cardId, open.baseVersion, 'continue')) as CardDecision
  const second = (await laneActions().decideCard('/A', open.cardId, open.baseVersion, 'continue')) as CardDecision

  // 순서·값이 계약 그대로 — `baseVersion` 을 빼거나 바꾸면 main 이 옛 판 위에 적용한다.
  expect(calls[0]).toEqual(['/A', 'card-settings-1', 4, 'continue'])
  expect(first.outcome).toBe('applied')
  expect(second.outcome).toBe('already-handled')
  // 접힘이 이미 적용된 카드로 돌아온다 — 두 번째 응답도 그릴 카드를 준다(버리면 화면이 옛 카드에 멈춘다).
  expect(second.card.state).toEqual({ kind: 'applied', scope: 'continue' })
  // `already-handled` 는 무효가 아니다 — 사유를 적으면 [계정이 바뀌었어요] 줄이 거짓으로 뜬다.
  expect(second.reason).toBeNull()
  expect(useLanes.getState().invalid).toEqual({})
  // 설정 카드는 묶음에 섞이지 않는다(계약 §3 [F5]) — 요청을 두 번 보내도 push 상태는 그대로다.
  expect(useLanes.getState().snapshot).toBeNull()
})

test('C01: 설정 카드 부품은 제목·[계속]·[취소]·적용 범위를 그리고 [이번만]이 없다', () => {
  const html = renderWith(join(SRC, 'components/LanePlanCard.tsx'), 'LanePlanCard', {
    card: settingsCard(), invalidReason: null, onDecide: () => undefined, onStatus: () => undefined
  }, {})
  expect(html).toContain(LANE_CARD.title['settings-enable'])
  expect(html).toContain(LANE_CARD.act.settingsContinue)
  expect(html).toContain(LANE_CARD.act.cancel)
  expect(html).toContain(LANE_CARD.scopeSettings)
  // 카드 몸통은 main 이 보낸 바뀌는 줄을 그대로 그린다.
  expect(html).toContain(LANE_NAME.research)
  // 설정 갈래의 범위는 [계속] 하나다(설계 §3-3) — [이번만]·[나눠 맡기지 않기]가 새면 안 된다.
  expect(html).not.toContain(LANE_CARD.act.once)
  expect(html).not.toContain(LANE_CARD.act.decline)
})

test('C03: 바꾸기 카드는 설계 줄의 전·후 값을 그대로 보이고 칩 안내는 처음 카드에만 있다', () => {
  const change = settingsCard()
  change.variant = 'change'
  change.rows = [
    {
      lane: 'design',
      before: { company: 'claude', model: 'claude-opus-4', effort: 'high', how: 'main' },
      after: { company: 'codex', model: 'gpt-6.1-sol', effort: 'low', how: 'main' },
      rejected: null, designSwitchTo: 'codex', requested: null
    },
    {
      lane: 'repeat',
      before: { company: 'codex', model: 'gpt-6.1-terra', effort: null, how: 'relay' },
      after: { company: 'claude', model: null, effort: null, how: 'main' },
      rejected: null, designSwitchTo: null, requested: null
    }
  ]
  const html = renderWith(join(SRC, 'components/LanePlanCard.tsx'), 'LanePlanCard', {
    card: change, invalidReason: null, onDecide: () => undefined, onStatus: () => undefined
  }, {})
  // design 행이 사라지면 학생은 무엇이 바뀌는지 볼 수 없다(C03 원문 재현).
  expect(html).toContain(LANE_NAME.design)
  expect(html).toContain(entryText(change.rows[0].before!))
  expect(html).toContain(entryText(change.rows[0].after!))
  expect(html).toContain(LANE_CARD.designSwitch('ChatGPT'))
  // "설계는 아래 칩에서 골라요"는 처음 카드 안내다 — 바꾸기 카드에 새면 정본(D2-03)과 모순된다.
  expect(html).not.toContain(LANE_CARD.chipref(null))

  // 직접 맡기기 행은 회사·모델·깊이 대신 한 문구로 — 설정 표·접힌 줄과 같은 규칙.
  expect(html).toContain(LANE_CARD.direct)
  expect(html).not.toContain('ChatGPT · 기본 · 기본')
})

test('C03: 거절된 설계 줄은 사유를 보이고, 처음 카드에는 칩 안내가 남는다', () => {
  const change = settingsCard()
  change.variant = 'change'
  change.rows = [{
    lane: 'design',
    before: { company: 'claude', model: 'claude-opus-4', effort: 'high', how: 'main' },
    after: null,
    rejected: 'effort-not-supported', designSwitchTo: null, requested: null
  }]
  const html = renderWith(join(SRC, 'components/LanePlanCard.tsx'), 'LanePlanCard', {
    card: change, invalidReason: null, onDecide: () => undefined, onStatus: () => undefined
  }, {})
  expect(html).toContain(LANE_NAME.design)
  expect(html).toContain(LANE_CARD.rowRejected)
  expect(html).toContain(LANE_CARD.reject['effort-not-supported'])

  const first = settingsCard()
  first.variant = 'first'
  first.rows = []
  const firstHtml = renderWith(join(SRC, 'components/LanePlanCard.tsx'), 'LanePlanCard', {
    card: first, invalidReason: null, onDecide: () => undefined, onStatus: () => undefined
  }, {})
  expect(firstHtml).toContain(LANE_CARD.chipref('Claude Opus'))
})


/**
 * 카드 컴포넌트를 **훅 값을 주입해** 그린다 — 10초 무응답은 실제 시계를 기다리지 않고 `slow` 로 넣는다.
 * `useState` 순서는 컴포넌트의 선언 순서(`pressed`·`slow`·`open`·`detail`·`quoteOpen`)를 그대로 따른다.
 */
function renderCardInjected(card: LaneCard, pressed: CardAction | null, slow: boolean, rest: {
  open?: boolean
  detail?: boolean
  quoteOpen?: boolean
} = {}): string {
  const realReact = createRequire(__filename)('react') as Record<string, unknown>
  const queue: unknown[] = [pressed, slow, rest.open ?? false, rest.detail ?? false, rest.quoteOpen ?? false]
  const react = {
    ...realReact,
    useState: () => [queue.shift(), () => undefined],
    useEffect: () => undefined,
    useRef: () => ({ current: null })
  }
  const file = join(SRC, 'components/LanePlanCard.tsx')
  const nodeRequire = createRequire(file)
  const cache = new Map<string, Record<string, unknown>>()
  const compile = (abs: string, exports: Record<string, unknown>, extra: Record<string, unknown>): void => {
    const code = transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      exports, module: { exports }, ...extra,
      require: (spec: string) => {
        if (spec === 'react') return react
        if (!spec.startsWith('.')) return nodeRequire(spec)
        const resolved = resolve(dirname(abs), spec)
        const target = [resolved + '.tsx', resolved + '.ts', resolved].find((p) => existsSync(p)) ?? resolved
        const hit = cache.get(target)
        if (hit) return hit
        const child: Record<string, unknown> = {}
        cache.set(target, child)
        compile(target, child, {})
        return child
      }
    })
  }
  const exports: Record<string, unknown> = {}
  cache.set(resolve(file), exports)
  compile(resolve(file), exports, {})
  const Component = exports.LanePlanCard as (p: Record<string, unknown>) => unknown
  const element = Component({ card, invalidReason: null, onDecide: () => undefined, onStatus: () => undefined })
  return renderToStaticMarkup(element as never)
}

test('C04: 결과가 확정되기 전에는 승인 단추가 잠기고 [다시 확인]이 열림·적용 중 모두에 나온다', () => {
  // 열림 + 10초 경과: 예전에는 `!slow` 때문에 단추가 다시 살아났다(같은 변경을 두 번 요청).
  const openSlow = renderCardInjected(settingsCard({ kind: 'open' }), 'continue', true)
  expect(openSlow).toContain(LANE_CARD.recheck)
  expect(openSlow).toContain(LANE_CARD.unknown)
  expect(openSlow).toContain('disabled=""')

  // 적용 중 + 10초 경과: 예전에는 복구 단추 자체가 없어 결과를 물을 길이 없었다.
  const applyingSlow = renderCardInjected(settingsCard({ kind: 'applying' }), 'continue', true)
  expect(applyingSlow).toContain(LANE_CARD.recheck)
  expect(applyingSlow).not.toContain(`<button type="button" class="primary">${LANE_CARD.act.settingsContinue}</button>`)

  // 누르기 전에는 잠기지 않는다 — 잠금은 "누른 뒤 결과를 모를 때"만이다.
  const idle = renderCardInjected(settingsCard({ kind: 'open' }), null, false)
  expect(idle).not.toContain('disabled=""')
  expect(idle).not.toContain(LANE_CARD.recheck)
})

test('C09: 학생 인용은 40자에서 접히고 [전체 보기]로만 열리며, 읽기 범위는 [자세히]로 구분된다', () => {
  const long = '자료는 Sonnet으로 찾고 검토는 이 대화에서 Opus로 하고 글쓰기는 Terra high로 맡겨 줘 그리고 반복 작업도 나눠서'
  const card: LaneCard = { ...settingsCard({ kind: 'open' }), quote: long }
  const shut = renderCardInjected(card, null, false)
  // 예전에는 80자를 넘는 인용이 카드에 그대로 다 나왔다(설계 §3 뼈대 2 위반).
  expect(shut, '인용 전문이 접히지 않고 그대로 나왔다').not.toContain(long)
  expect(shut).toContain(LANE_CARD.quote(`${long.slice(0, 39)}…`))
  expect(shut).toContain(`aria-expanded="false">${LANE_CARD.quoteMore}</button>`)
  // 읽기 범위 펼침은 인용 단추가 아니라 [자세히]다 — 이름이 뒤바뀌면 학생이 인용을 연다고 오해한다.
  expect(shut).toContain(`aria-expanded="false">${CHAT.details}</button>`)

  const openQuote = renderCardInjected(card, null, false, { quoteOpen: true })
  expect(openQuote).toContain(long)
  expect(openQuote).toContain(`aria-expanded="true">${LANE_CARD.quoteLess}</button>`)

  // 40자 이하 인용에는 단추가 붙지 않는다 — 열 것이 없는데 누르면 아무 일도 없는 단추가 된다.
  const brief: LaneCard = { ...settingsCard({ kind: 'open' }), quote: '글쓰기는 Terra로' }
  const briefHtml = renderCardInjected(brief, null, false)
  expect(briefHtml).toContain(LANE_CARD.quote('글쓰기는 Terra로'))
  expect(briefHtml, '짧은 인용에도 [전체 보기]가 붙었다').not.toContain(LANE_CARD.quoteMore)

  // 읽기 범위 [자세히]를 펼치면 설명이 나오고 인용은 그대로 접힌 채다.
  const scopeOpen = renderCardInjected(card, null, false, { detail: true })
  expect(scopeOpen).toContain(LANE_CARD.readScopeDetail)
  expect(scopeOpen).not.toContain(long)
})

/**
 * 훅 값을 주입해 **아무 부품이나** 그린다 — C06 의 [자세히]는 "펼침 + 읽은 값"에 따라 세 갈래로 갈리는데,
 * 실제로 읽으려면 IPC 가 필요하다. `queue` 는 컴포넌트의 `useState` 선언 순서대로 소비된다.
 */
function renderInjected(file: string, name: string, props: Record<string, unknown>, queue: unknown[]): string {
  const realReact = createRequire(__filename)('react') as Record<string, unknown>
  const pending = [...queue]
  const react = { ...realReact, useState: () => [pending.shift(), () => undefined] }
  const nodeRequire = createRequire(join(SRC, file))
  const cache = new Map<string, Record<string, unknown>>()
  const compile = (abs: string, exports: Record<string, unknown>): void => {
    const code = transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      exports, module: { exports },
      require: (spec: string) => {
        if (spec === 'react') return react
        if (!spec.startsWith('.')) return nodeRequire(spec)
        const resolved = resolve(dirname(abs), spec)
        const target = [resolved + '.tsx', resolved + '.ts', resolved].find((p) => existsSync(p)) ?? resolved
        const hit = cache.get(target)
        if (hit) return hit
        const child: Record<string, unknown> = {}
        cache.set(target, child)
        compile(target, child)
        return child
      }
    })
  }
  const target = resolve(SRC, file)
  const exports: Record<string, unknown> = {}
  cache.set(target, exports)
  compile(target, exports)
  const Component = exports[name] as (p: Record<string, unknown>) => unknown
  return renderToStaticMarkup(createElement(Component, props) as never)
}

/**
 * 전달문이 있는 delivered 사건(설계 §2-2). **주문과 전달문은 다른 문장이다** — 같은 문자열을 쓰면
 * "읽기 실패 뒤에도 주문이 살아남았는가"를 잴 수 없다(검토 C2-C06).
 */
const ORDER = '감초 도매·소매 가격을 3개 지역에서 조사하고 출처 링크를 함께 적어 주세요 — 표로 정리'
const DELIVERY = '조사 결과\n- 도매 1kg 8,900원 · 소매 12,400원\n- 출처: 한국약초유통협회 2026년 3분기'
const DELIVERED: LaneEvent = {
  id: 'ev-1', at: '2026-11-10T11:30:00+09:00', kind: 'delivered', jobId: 'job-1', lane: 'research',
  by: { company: 'claude', model: 'claude-sonnet-4', effort: 'null' as never }, continued: false, task: ORDER
}

test('C06: 기록 줄은 주문 번호와 주문 전문을 보존하고 [자세히]로 둘을 갈라 편다', () => {
  const view = eventView(DELIVERED)
  // 예전에는 여기서 jobId 가 사라져 화면이 전달문을 읽을 길이 없었다.
  expect(view?.jobId).toBe('job-1')
  // 원 주문은 접히지 않은 채 뷰에 남는다 — 줄의 `text` 만 40자 요약이다.
  expect(view?.task).toBe(ORDER)
  expect(view!.text).not.toContain(ORDER)
  expect(view!.text).toContain(`${ORDER.replace(/\s+/g, ' ').trim().slice(0, 39)}…`)

  const closed = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => ({ text: DELIVERY }) }, [false, { kind: 'idle' }])
  expect(closed).toContain(LANE_ACTION.details)
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).not.toContain('zline-raw')
  // 접힌 줄에는 주문 전문도 전달문도 없다.
  expect(closed).not.toContain(ORDER)
  expect(closed).not.toContain(DELIVERY)

  const opened = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => ({ text: DELIVERY }) }, [true, { kind: 'text', text: DELIVERY }])
  // 제목 아래에 주문 전문, 그 아래에 전달문 — 두 글을 갈라 읽게 한다.
  expect(opened).toContain(`<b>${LANE_EVENT.detailTitle.task}\n</b>${ORDER}`)
  expect(opened).toContain(`\n<b>${LANE_EVENT.detailTitle.delivery}\n</b>${DELIVERY}`)
  // 주문이 전달문과 같은 상자에 뭉개지지 않는다 — 순서가 주문 먼저다.
  expect(opened.indexOf(ORDER)).toBeLessThan(opened.indexOf(DELIVERY))
})

test('C06: 펼친 본문은 줄 **아래** 독립 블록이다 — flex 줄 안에 갇히지 않는다', () => {
  const view = eventView(DELIVERED)
  const opened = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => ({ text: DELIVERY }) }, [true, { kind: 'text', text: DELIVERY }])
  /*
   * 예전 모양은 `<div class="chat-event">… <code class="zline-raw">` 로 본문이 flex 줄의 마지막
   * 자식이었다 — 남은 폭(오른쪽 좁은 상자)으로 밀려 긴 한국어 줄이 잘렸다(검토 C2-C06 ⑤).
   * 이제 본문은 줄을 닫은 **뒤** 형제다.
   */
  expect(opened).toContain('</div><code class="zline-raw">')
  expect(opened.indexOf('chat-event-wrap')).toBeLessThan(opened.indexOf('class="chat-event"'))
  // 줄(`.chat-event`)은 본문을 품지 않는다.
  const row = opened.slice(opened.indexOf('class="chat-event"'), opened.indexOf('</div><code'))
  expect(row).not.toContain('zline-raw')
})

test('C06: 전달문이 없거나 읽지 못해도 주문 전문은 그대로 남는다', () => {
  const view = eventView(DELIVERED)
  const missing = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => ({ text: null }) }, [true, { kind: 'text', text: null }])
  expect(missing).toContain(LANE_EVENT.deliveryTextMissing)
  expect(missing).toContain(ORDER)
  expect(missing).toContain(`<b>${LANE_EVENT.detailTitle.task}\n</b>`)

  const failed = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => null }, [true, { kind: 'failed' }])
  expect(failed).toContain(LANE_EVENT.deliveryTextFailed)
  // 읽기 실패가 주문을 지우지 않는다 — 이것이 C06 의 핵심 반례다.
  expect(failed).toContain(ORDER)
  expect(failed).toContain(`<b>${LANE_EVENT.detailTitle.delivery}\n</b>${LANE_EVENT.deliveryTextFailed}`)

  // 아직 읽지 않은(펼침 직후) 순간에도 주문은 보이고 전달문 자리는 비어 있다.
  const idle = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine',
    { view, root: '/A', onDeliveryText: async () => ({ text: DELIVERY }) }, [true, { kind: 'idle' }])
  expect(idle).toContain(ORDER)
  expect(idle).not.toContain(LANE_EVENT.detailTitle.delivery)
})

test('C06: 주문이 있으면 읽기 통로가 없어도 [자세히]가 열리고, 주문도 없으면 단추를 두지 않는다', () => {
  const view = eventView(DELIVERED)
  // 폴더·통로가 없어도 주문은 볼 수 있어야 한다 — 예전에는 통로가 없으면 단추 자체가 사라졌다.
  for (const props of [
    { view: { ...view!, jobId: undefined }, root: '/A', onDeliveryText: async () => ({ text: 'x' }) },
    { view, onDeliveryText: async () => ({ text: 'x' }) },
    { view, root: '/A' }
  ]) {
    const html = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine', props, [true, { kind: 'idle' }])
    expect(html).toContain(LANE_ACTION.details)
    expect(html).toContain(ORDER)
    // 읽을 길이 없으므로 전달문 자리는 그리지 않는다.
    expect(html).not.toContain(LANE_EVENT.detailTitle.delivery)
  }

  // 주문도 읽기 통로도 없는 줄(검토 안내·자기 호출 등)에는 단추를 두지 않는다 — 누를 수 없는 단추는 없다.
  const bare = eventView({ id: 'ev-2', at: DELIVERED.at, kind: 'review-skipped', reason: 'lanes-off' })
  const html = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine', { view: bare }, [false, { kind: 'idle' }])
  expect(html).not.toContain(LANE_ACTION.details)
  expect(html).not.toContain('aria-expanded')
})

test('C06: 실행되지 못한 줄도 주문 전문을 남긴다', () => {
  const notRun: LaneEvent = {
    id: 'ev-3', at: DELIVERED.at, kind: 'not-run', jobId: 'job-3', lane: 'writing', reason: 'limit', task: ORDER
  }
  const view = eventView(notRun)
  expect(view?.task).toBe(ORDER)
  const html = renderInjected('components/LaneEventLine.tsx', 'LaneEventLine', { view, root: '/A' }, [true, { kind: 'idle' }])
  expect(html).toContain(ORDER)
  expect(html).toContain(LANE_EVENT.notRun(LANE_NAME.writing, 'limit'))
})

test('C06: 작업 분담 줄의 [자세히]는 상태 원문과 전달문을 한 단추로 함께 편다', () => {
  const base = { tone: 'bad' as const, title: '보관된 결과가 있어요', raw: '오류 · violation\nboom', role: 'none' as const }

  // 1) 원문만 있는 줄(다른 5곳 호출부)은 그대로 — 전달문 없이 원문만 편다.
  const rawOnly = renderInjected('components/ZoneLine.tsx', 'ZoneLine', base, [false, { kind: 'idle' }])
  expect(rawOnly).toContain(`>${'자세히'}</button>`)
  const rawOnlyOpen = renderInjected('components/ZoneLine.tsx', 'ZoneLine', base, [true, { kind: 'idle' }])
  expect(rawOnlyOpen).toContain('zline-raw')
  expect(rawOnlyOpen).not.toContain(LANE_EVENT.deliveryTextMissing)

  // 2) 주문이 붙으면 같은 단추가 원문 **뒤에** 전달문을 덧붙인다(설계 §2-1).
  const both = renderInjected('components/ZoneLine.tsx', 'ZoneLine',
    { ...base, rawTitle: '보관된 결과가 있어요', root: '/A', jobId: 'job-1', onDeliveryText: async () => ({ text: '전달문 원문' }) },
    [true, { kind: 'text', text: '전달문 원문' }])
  expect(both).toContain('zline-raw')
  expect(both).toContain('<b>보관된 결과가 있어요\n</b>')
  expect(both).toContain('오류 · violation\nboom\n전달문 원문')
  // 단추는 하나뿐이다 — 둘로 나누면 학생이 어느 것을 눌러야 하는지 모른다.
  expect(both.match(/>자세히<\/button>/g)).toHaveLength(1)

  // 3) 읽지 못하면 원문은 그대로 두고 전달문 자리만 실패 문구로 바꾼다.
  const failed = renderInjected('components/ZoneLine.tsx', 'ZoneLine',
    { ...base, root: '/A', jobId: 'job-1', onDeliveryText: async () => null }, [true, { kind: 'failed' }])
  expect(failed).toContain('오류 · violation\nboom\n' + LANE_EVENT.deliveryTextFailed)
})

test('C06: 작업 분담 칸은 줄마다 주문 번호와 읽기 통로를 내려보낸다', () => {
  // `LaneZone` 이 `jobId`·`onDeliveryText` 를 빼면 `ZoneLine` 은 [자세히]를 붙일 수 없다.
  const changed = {
    id: 'line-changed', tier: 1, kind: 'folder-changed', at: '2026-11-10T11:30:00+09:00',
    dismissible: true, jobId: 'job-1', lane: 'research',
    assignee: { company: 'claude', model: 'claude-sonnet-4', effort: 'default' },
    detail: { jobId: 'job-1', status: 'error', reason: 'violation', error: 'boom', task: '요약' }
  } as unknown as LaneLine
  // 펼친 상태로 그린다 — 주문 번호·통로가 줄까지 닿지 않으면 전달문이 아니라 `null` 이 보인다.
  const html = renderInjected('components/LaneZone.tsx', 'LaneZone', {
    lines: [changed], announcement: null, onAction: () => undefined, onShowCard: () => undefined,
    root: '/A', delivery: async () => ({ text: '전달문 원문' })
  }, [{}, Date.parse('2026-11-10T12:00:00+09:00'), '', true, { kind: 'text', text: '전달문 원문' }])
  expect(html).toContain('zline bad')
  expect(html).toContain('>자세히</button>')
  expect(html).toContain('오류 · violation')
  expect(html).toContain('전달문 원문')
})


