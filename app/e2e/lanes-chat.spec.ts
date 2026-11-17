// Node-only regressions for 대화 칸의 작업 분담 자리 (검토 C05). No Electron, browser, account, or provider process.
//
// C05 가 지적한 것: `Chat` 이 `laneLines.length > 0` 일 때만 `LaneZone` 을 붙이면, 마지막 담당이 끝나
// 줄이 사라지는 **바로 그 순간**에 도착하는 완료 낭독(`announcement.kind:'delivered'`)을 읽을 칸이 없다.
// 낭독 칸(`#lane-say`)은 줄 수와 무관하게 늘 있어야 하고, 사건(`seq`)이 바뀔 때만 글이 갈린다.
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, JsxEmit, ModuleKind, ScriptTarget } from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LaneAnnouncement, LaneEvent, LaneLine } from '../src/shared/lanes-ipc'
import { LANE_ACTION } from '../src/renderer/src/copy-lanes'

const SRC = join(__dirname, '../src/renderer/src')

/** 진행 중 담당 줄 하나 — 낭독 칸이 "줄이 있을 때"도 하나인지 보는 데만 쓴다. */
function runningLine(): LaneLine {
  return {
    id: 'line-1',
    tier: 3,
    kind: 'progress',
    lane: 'research',
    phase: 'running',
    assignee: { company: 'codex', model: 'gpt-6.1-astra', effort: 'high', how: 'sub' },
    jobId: 'job-1',
    startedAt: new Date().toISOString(),
    waiting: 0
  } as LaneLine
}

/**
 * `Chat` 을 그대로 정적 렌더한다 — store 만 갈아 끼운다(화면 밖 상태를 읽는 유일한 통로).
 *
 * zustand 의 정적 렌더는 `getInitialState()` 를 읽으므로 `setState` 로는 값이 닿지 않는다.
 * 그래서 `useProject`·`useLanes` 는 선택자에 상태를 직접 넘기는 가짜 훅으로 바꾼다.
 */
function renderChat(lines: LaneLine[], announcement: LaneAnnouncement | null, events: LaneEvent[] = []): string {
  const project = {
    root: '/A',
    newProjectSeq: 0,
    settings: null,
    status: null,
    error: null,
    openFailure: null,
    retryFailed: false,
    retryOpen: () => undefined,
    firstProjectGate: null,
    clearError: () => undefined,
    openSheet: () => undefined,
    openPreview: () => undefined,
    events: [],
    focusSection: () => undefined,
    paperClosed: false,
    setPaperClosed: () => undefined,
    setPaneView: () => undefined,
    quoteIntent: null,
    consumeQuoteIntent: () => undefined,
    setPaneTab: () => undefined,
    openSettings: () => undefined,
    requestLanesCard: () => undefined,
    lanesCardRequest: null,
    consumeLanesCardRequest: () => undefined,
    loadSettings: async () => undefined
  }
  const lanes = {
    snapshot: {
      root: '/A', seq: 4, lines, cards: [], events, archives: [], announcement,
      settings: {
        mode: 'off', source: { kind: 'none' }, rows: [], differsFromRecommendation: false,
        temporary: [], recommendedDesign: null, nextDesignCompany: null, consents: []
      },
      stopButton: 'chat'
    },
    root: '/A',
    unavailable: false,
    listening: true,
    injected: false,
    lastError: null,
    invalid: {},
    ask: async () => ({ error: { code: 'internal', message: 'unused' } }),
    attach: () => undefined,
    load: async () => undefined
  }
  const stubs: Record<string, unknown> = {
    '../store/project': {
      useProject: Object.assign((selector: (s: unknown) => unknown) => selector(project), { getState: () => project })
    },
    '../store/lanes': {
      useLanes: Object.assign((selector: (s: unknown) => unknown) => selector(lanes), { getState: () => lanes }),
      // [자세히]가 부르는 읽기 통로 — 화면은 이 함수를 넘겨받는다(검토 C06).
      laneActions: () => ({ deliveryText: async () => ({ result: { text: '전달문 원문' } }) })
    }
  }
  const file = join(SRC, 'screens/Chat.tsx')
  const nodeRequire = createRequire(file)
  const cache = new Map<string, Record<string, unknown>>()
  const compile = (abs: string, exports: Record<string, unknown>): void => {
    const code = transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: {
        jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022,
        // `markdown-it` 같은 CJS 기본 내보내기를 `esModuleInterop` 없이는 부를 수 없다(실측).
        esModuleInterop: true, allowSyntheticDefaultImports: true
      }
    }).outputText
    runInNewContext(code, {
      exports, module: { exports }, Promise, crypto: globalThis.crypto,
      console,
      window: {
        knuaf: {}, addEventListener: () => undefined, removeEventListener: () => undefined,
        setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
      },
      document: { documentElement: {}, querySelector: () => null, addEventListener: () => undefined, removeEventListener: () => undefined },
      navigator: { onLine: true },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined,
      CustomEvent: class {}, location: { hash: '' },
      require: (spec: string) => {
        if (spec in stubs) return stubs[spec]
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
  const exports: Record<string, unknown> = {}
  cache.set(resolve(file), exports)
  compile(resolve(file), exports)
  const Chat = exports.Chat as (p: Record<string, unknown>) => unknown
  return renderToStaticMarkup(createElement(Chat, {}) as never)
}

const LANE_SAY_BOX = /<div class="sr-only" role="status" aria-live="polite" aria-atomic="true" id="lane-say">/g

/*
 * 검토 C07-③ — 이 두 시험은 `renderToStaticMarkup` 한 장면만 본다. "줄이 사라져도 칸이 남는다"는
 * **전이**(줄 있음 → 줄 0개)를 실제로 겪지는 않으므로, 같은 DOM 에서 칸이 사라졌는지 여부는 잡지
 * 못한다. 전이의 보장은 코드 쪽 두 곳이다 — 마운트 조건이 `!lanesUnavailable` 뿐이고
 * (`Chat.tsx:902-905`, `laneLines.length` 를 안 본다), `#lane-say` 는 `LaneZone` 안에 상시 있다
 * (`LaneZone.tsx:52`). 화면 시험으로 잠그려면 Electron 안에서 낭독 사건을 두 번 밀어야 하는데,
 * `aria-live` 는 스크린리더 쪽 동작이라 지금 시험 환경에선 관측할 수 없다.
 * 그래서 이 시험은 **정적 렌더의 모양**까지만 증거이고, 전이 미검증은 보고서 한계 절에 적는다.
 */
test('C05: 마지막 담당 줄이 사라져도 완료 낭독을 읽을 칸이 남는다', () => {
  // 줄 0개 + 완료 낭독 — 예전 조건(`laneLines.length > 0`)이면 LaneZone 자체가 없어 칸도 없다.
  const html = renderChat([], { seq: 7, kind: 'delivered', lane: 'research', lineId: null })
  expect(html).toContain('class="chat-inner"')
  expect(html.match(LANE_SAY_BOX)).toHaveLength(1)
})

test('C05: 진행 줄이 있어도 낭독 칸은 같은 한 칸뿐이다', () => {
  const html = renderChat([runningLine()], { seq: 8, kind: 'started', lane: 'research', lineId: null })
  // 두 번 그리면 같은 사건을 두 번 읽는다 — 칸은 하나여야 한다.
  expect(html.match(LANE_SAY_BOX)).toHaveLength(1)
})

/** 55자 주문을 넘긴 기록 — 줄은 40자로 접히고 원문은 [자세히] 뒤에 있다(설계 §2-2). */
function deliveredEvent(): LaneEvent {
  return {
    id: 'ev-1',
    at: '2026-11-10T11:30:00+09:00',
    kind: 'delivered',
    jobId: 'job-1',
    lane: 'research',
    by: { company: 'claude', model: 'claude-sonnet-4', effort: 'high' },
    continued: false,
    task: '자료 찾기 담당에게 넘긴 주문 요약이 마흔 자를 넘으면 줄임표로 접히고 전체는 자세히에서만 보인다'
  }
}

test('C06: 대화 기록 줄에도 [자세히]가 붙는다 — 주문 번호를 끝까지 나른다', () => {
  // 예전에는 `Chat` 이 기록 줄에 읽기 통로를 넘기지 않아(그리고 view 가 jobId 를 버려서)
  // 학생은 넘긴 주문의 원문을 확인할 길이 없었다.
  const html = renderChat([], null, [deliveredEvent()])
  expect(html).toContain('class="chat-event"')
  expect(html).toContain(LANE_ACTION.details)
  expect(html).toContain('aria-expanded="false"')
})
