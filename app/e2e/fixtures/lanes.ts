/**
 * 작업 분담 화면 시험 공용 — 가짜 묶음(`LanesSnapshot`), 주입 통로, 그리고 **이음매 갈아 끼우기**(검토 C07-①).
 *
 * 실제 앱에는 preload(`preload/index.ts`)가 `lanes`·`jobs` 를 아직 안 내보내므로 `store/lanes` 의
 * `seam()` 은 늘 `null` 이다. 카드 단추를 실제로 눌러 보려면 `window.knuaf` 를 바꿔야 하는데,
 * contextBridge 가 `SetReadOnlyNonConfigurable` + `DeepFreeze` 로 잠가 두어 창 안에서 교체할 수 없다.
 * store 가 `knuaf:lanes-seam-test` 로만 받는 시험 이음매(`copy-lanes.ts` `LANES_TEST_SEAM_EVENT`)를 쓴다.
 *
 * 설계 `UI-DESIGN.md:330` 이 "실 AI 호출 없음 — 가짜 store 상태로 그림·e2e" 를 이미 정본으로 두었고,
 * `knuaf:lanes-test`·`knuaf:lanes-test-archive` 와 같은 설계다. 실제 AI·IPC 는 부르지 않는다.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

export const at = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString()

/** 대화에 미리 심는 메시지 — `.chat-msg` 가 있어야 `openProject` 가 끝난다. */
export const MESSAGES = [
  { id: 'u1', role: 'user', text: '3장 시장 현황에 감초 가격 자료 좀 찾아 줘', at: at(9), delivery: 'sent' },
  { id: 'a1', role: 'assistant', text: '네, 자료 찾기 담당에게 도매·소매 가격 조사를 맡길게요. 끝나면 원문을 다시 확인해서 3장에 넣을게요.', at: at(8) }
]

/** 공통 묶음 뼈대 — 각 장면이 필요한 칸만 덮어쓴다. */
export function snapshot(root: string, seq: number, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    root,
    seq,
    lines: [],
    cards: [],
    events: [],
    settings: {
      mode: 'on',
      source: { kind: 'recommended', rowId: 'claude-high-codex-low' },
      rows: [],
      differsFromRecommendation: false,
      temporary: [],
      recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' },
      nextDesignCompany: null,
      consents: []
    },
    archives: [],
    announcement: null,
    stopButton: 'chat',
    ...patch
  }
}

export const detail = (jobId: string, task: string) => ({ jobId, status: 'running', reason: null, error: null, task })

export const progressLine = (id: string, jobId: string, lane: string, task: string, minutes: number, waiting: number, assignee: Record<string, unknown>) => ({
  kind: 'progress', tier: 3, id, at: at(minutes), dismissible: false,
  jobId, lane, detail: detail(jobId, task), assignee,
  phase: 'running', startedAt: at(minutes), waiting
})

/** 상태 주입 통로 — 설계 §7. 실제 밀려온 묶음과 같은 모양이면 store 가 그대로 받는다. */
export async function inject(page: Page, snapshotValue: Record<string, unknown>): Promise<void> {
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('knuaf:lanes-test', { detail: value }))
  }, snapshotValue)
}

/** 사진은 `KNUAF_LANES_SHOTS_DIR` 가 있을 때만 남긴다(없으면 대기만). */
export async function shoot(page: Page, name: string): Promise<void> {
  const out = process.env.KNUAF_LANES_SHOTS_DIR
  if (!out) return
  mkdirSync(out, { recursive: true })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, `${name}.png`) })
}

/** §3-1 처음 분담 — 네 역할 모두 새 대화. */
export const CARD_ROWS = [
  { lane: 'research', before: null, after: { company: 'codex', model: 'astra', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'writing', before: null, after: { company: 'codex', model: 'sol', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'repeat', before: null, after: { company: 'codex', model: 'terra', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'review', before: null, after: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }, rejected: null, designSwitchTo: null, requested: null }
]

export function firstCard(cardId: string, state: Record<string, unknown>, createdAt: string): Record<string, unknown> {
  return {
    cardId, root: '', variant: 'first', baseVersion: 1, createdAt, reviewDue: false, quote: null,
    rows: CARD_ROWS,
    fees: [{ company: 'codex', accountLabel: 'a…@gmail.com', consented: false }],
    fastDrain: false, recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' }, state
  }
}

/** §3-3 설정 확인 창 — 켜기. 범위는 [계속]만이라 `settings-enable` 이다. */
export function settingsCard(state: Record<string, unknown>, createdAt = at(1)): Record<string, unknown> {
  return {
    cardId: 'card-settings-1', root: '', variant: 'settings-enable', baseVersion: 4, createdAt,
    reviewDue: false, quote: null, rows: CARD_ROWS,
    fees: [{ company: 'codex', accountLabel: 'a…@gmail.com', consented: false }],
    fastDrain: false, recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' }, state
  }
}

/** §3-2 배치 바꾸기 — 한 줄은 구독 아님으로 거절, 셋은 적용. */
export function changeCard(cardId: string, state: Record<string, unknown>, createdAt: string): Record<string, unknown> {
  return {
    cardId, root: '', variant: 'change', baseVersion: 3, createdAt, reviewDue: false,
    quote: '자료는 Sonnet으로 하고 검토는 그대로 둬',
    rows: [
      { lane: 'research', before: { company: 'codex', model: 'astra', effort: null, how: 'relay' }, after: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
      { lane: 'writing', before: { company: 'codex', model: 'sol', effort: null, how: 'relay' }, after: { company: 'codex', model: 'terra', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
      { lane: 'repeat', before: { company: 'codex', model: 'terra', effort: null, how: 'relay' }, after: null, rejected: 'not-subscribed', designSwitchTo: null, requested: { main: false, model: 'luna', effort: null } },
      { lane: 'review', before: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }, after: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }, rejected: null, designSwitchTo: null, requested: null }
    ],
    fees: [{ company: 'claude', accountLabel: 'b…@naver.com', consented: true }],
    fastDrain: false, recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' }, state
  }
}

/**
 * 이음매 갈아 끼우기(검토 C07-①).
 *
 * - `decideCard` 는 **미해결 Promise** 다. 바로 답하면 카드가 접혀 "누른 뒤 잠김"을 잡을 수 없다.
 *   `releaseCardDecision` 으로 답한다.
 * - `settingsCard` 는 준 카드 객체를 그대로 돌려준다(계약 §3 [F5]: 설정 카드는 묶음에 오지 않는다).
 * - 나머지 갈래는 호출을 기록하고 `internal` 오류를 돌려준다 — 이 시험이 안 쓰는 길이 열리면 드러난다.
 *
 * **부르는 때**: `attach()` 가 이미 불려 리스너가 걸려 있어야 한다(Chat·LanesSettings 가 마운트에서 부른다).
 * `testSeam` 은 모듈 전역이라 `page.reload()` 하면 사라진다 — 장면 안에서 새로 고치지 않는다.
 */
export async function installLanesSeam(
  page: Page,
  opts: {
    card: Record<string, unknown>
    snapshot?: Record<string, unknown> | null
    /** `jobs.deliveryText` 가 돌려줄 원문 — 없으면 `{ text: null }`(계약: 전달문 아직 없음). */
    deliveryText?: string | null
  }
): Promise<void> {
  await page.evaluate(({ card, snapshot: snap, deliveryText }) => {
    const w = window as unknown as Record<string, unknown>
    const calls: unknown[][] = []
    w.__lanesCalls = calls
    w.__lanesRelease = null
    w.__seamSnapshot = snap
    const record = (name: string, args: unknown[]): void => { calls.push([name, ...args]) }
    const unused = async (name: string, ...args: unknown[]) => {
      record(name, args)
      return { error: { code: 'internal', message: 'unused' } }
    }
    const lanes = {
      // 빈 값으로 답하면 `apply(null)` 이 터진다 — 묶음이 없으면 오류로 답한다.
      snapshot: async (root: string | null) => {
        record('snapshot', [root])
        return w.__seamSnapshot
          ? { result: w.__seamSnapshot }
          : { error: { code: 'internal', message: 'no snapshot' } }
      },
      onSnapshot: () => () => undefined,
      decideCard: (root: string, cardId: string, baseVersion: number, action: string) => {
        record('decideCard', [root, cardId, baseVersion, action])
        const { promise, resolve } = Promise.withResolvers<unknown>()
        w.__lanesRelease = resolve
        return promise
      },
      cardStatus: async (root: string, cardId: string) => {
        record('cardStatus', [root, cardId])
        return { result: { outcome: 'open', reason: null, card, boundTurn: null } }
      },
      settingsCard: async (root: string, kind: string) => {
        record('settingsCard', [root, kind])
        return { result: card }
      },
      consents: async () => ({ result: [] }),
      disable: async (...args: unknown[]) => unused('disable', ...args),
      reviewModels: async (...args: unknown[]) => unused('reviewModels', ...args),
      pickReview: async (...args: unknown[]) => unused('pickReview', ...args),
      setConsent: async (...args: unknown[]) => unused('setConsent', ...args),
      dismiss: async (...args: unknown[]) => unused('dismiss', ...args),
      handoffContinue: async (...args: unknown[]) => unused('handoffContinue', ...args),
      handoffLater: async (...args: unknown[]) => unused('handoffLater', ...args),
      archives: async (...args: unknown[]) => unused('archives', ...args),
      archive: async (...args: unknown[]) => unused('archive', ...args)
    }
    const jobs = {
      stopOne: async (...args: unknown[]) => unused('stopOne', ...args),
      continue: async (...args: unknown[]) => unused('jobs.continue', ...args),
      later: async (...args: unknown[]) => unused('jobs.later', ...args),
      retry: async (...args: unknown[]) => unused('retry', ...args),
      discard: async (...args: unknown[]) => unused('discard', ...args),
      redeliver: async (...args: unknown[]) => unused('redeliver', ...args),
      authLater: async (...args: unknown[]) => unused('authLater', ...args),
      deliveryText: async (root: string, jobId: string) => {
        record('deliveryText', [root, jobId])
        return { result: { text: deliveryText } }
      }
    }
    window.dispatchEvent(new CustomEvent('knuaf:lanes-seam-test', { detail: { lanes, jobs } }))
  }, { card: opts.card, snapshot: opts.snapshot ?? null, deliveryText: opts.deliveryText ?? null })
}

/** 미해결 `decideCard` 에 답한다 — `CardDecision` 모양 그대로. */
export async function releaseCardDecision(page: Page, decision: Record<string, unknown>): Promise<void> {
  await page.evaluate((value) => {
    const w = window as unknown as { __lanesRelease?: (v: unknown) => void }
    w.__lanesRelease?.(value)
  }, decision)
}

/** 이음매가 받은 호출 — `[이름, ...인자]`. */
export async function laneCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as { __lanesCalls?: unknown[][] }).__lanesCalls ?? [])
}
