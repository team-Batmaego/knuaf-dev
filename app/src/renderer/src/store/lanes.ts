import { create } from 'zustand'
import type {
  ArchivedChat,
  ArchivedChatSummary,
  CardAction,
  CardDecision,
  CardInvalidReason,
  ConsentRow,
  LaneCard,
  LanesReply,
  LanesSnapshot,
  ReviewModelGroup
} from '../../../shared/lanes-ipc'
import type { Provider } from '../../../shared/chat'
import { LANES_TEST_EVENT } from '../copy-lanes'

/**
 * 작업 분담(단위 6) 상태 — **계산하지 않는다.**
 *
 * main 이 보낸 `LanesSnapshot` 을 그대로 담고, 늦게 도착한 묶음(`seq` 가 더 작은 것)만 버린다.
 * 줄 문구·순서·"n건 더 보기"는 `laneLines.ts` 순수 함수가, 그리기는 `LaneZone`·`LanePlanCard` 가 한다.
 *
 * preload(`preload/index.ts`)에 아직 `lanes`·`jobs` 가 없다(배선 C1 몫). 없으면 `unavailable` 로
 * 조용히 꺼 둔다 — 가짜 기본값으로 켠 척하지 않는다.
 */

type LanesApi = {
  snapshot(root: string | null): Promise<LanesReply<LanesSnapshot>>
  onSnapshot(fn: (snapshot: LanesSnapshot) => void): () => void
  decideCard(root: string, cardId: string, baseVersion: number, action: CardAction): Promise<LanesReply<CardDecision>>
  cardStatus(root: string, cardId: string): Promise<LanesReply<CardDecision>>
  settingsCard(root: string, kind: 'enable' | 'revert'): Promise<LanesReply<LaneCard>>
  disable(root: string): Promise<LanesReply<void>>
  reviewModels(root: string): Promise<LanesReply<ReviewModelGroup[]>>
  pickReview(root: string, company: Provider, model: string): Promise<LanesReply<LaneCard>>
  consents(): Promise<LanesReply<ConsentRow[]>>
  setConsent(company: Provider, accountId: string, on: boolean): Promise<LanesReply<ConsentRow>>
  dismiss(root: string, lineId: string): Promise<LanesReply<void>>
  handoffContinue(root: string, proposalId: string): Promise<LanesReply<void>>
  handoffLater(root: string, proposalId: string): Promise<LanesReply<void>>
  archives(root: string): Promise<LanesReply<ArchivedChatSummary[]>>
  archive(root: string, archiveId: string): Promise<LanesReply<ArchivedChat>>
}

type JobsApi = {
  stopOne(root: string, jobId: string): Promise<LanesReply<void>>
  continue(root: string, proposalId: string): Promise<LanesReply<void>>
  later(root: string, proposalId: string): Promise<LanesReply<void>>
  retry(root: string, jobId: string): Promise<LanesReply<void>>
  discard(root: string, jobId: string): Promise<LanesReply<void>>
  redeliver(root: string, jobId: string): Promise<LanesReply<void>>
  authLater(root: string, jobId: string): Promise<LanesReply<void>>
  /** [Roh 중요 1] 전달문 원문 — 읽기만 한다(다시 넘기지 않는다). */
  deliveryText(root: string, jobId: string): Promise<LanesReply<{ text: string | null }>>
}

/** `window.knuaf` 의 preload 타입(`preload/index.d.ts`)에 아직 없는 두 갈래 — 배선 C1이 더한다. */
type LanesWindow = { knuaf?: { lanes?: LanesApi; jobs?: JobsApi } }

/** preload 이 노출했는지만 본다. 없으면 화면은 조용히 비활성이다. */
function seam(): { lanes: LanesApi | null; jobs: JobsApi | null } {
  // preload 타이핑에 아직 lanes/jobs 가 없다(preload/index.d.ts 2행) — 캐스팅으로 확장 지점만 연다.
  const api = window as unknown as LanesWindow
  const knuaf = api.knuaf
  return { lanes: knuaf?.lanes ?? null, jobs: knuaf?.jobs ?? null }
}

/**
 * `LanesReply<T>` 는 `result`/`error` 판별 유니온이라 `'error' in r` 로 좁힌다.
 * `result?: never` 가 붙은 갈래는 `'result' in r` 검사가 `void` 응답(값 `undefined`)과 겹치므로 쓰지 않는다.
 */
export async function laneCall<T>(call: () => Promise<LanesReply<T>>): Promise<{ value: T } | { error: string }> {
  try {
    const r = await call()
    if ('error' in r && r.error) return { error: r.error.code }
    return { value: r.result as T }
  } catch {
    return { error: 'internal' }
  }
}

interface LanesState {
  /** 마지막으로 받은 묶음. 폴더가 바뀌면 null 로 비운다. */
  snapshot: LanesSnapshot | null
  /** 이 묶음이 어느 폴더의 것인가 — 폴더를 옮기는 사이 늦게 온 묶음을 버린다. */
  root: string | null
  /** 이음매가 없거나(배선 전) snapshot 요청이 실패했는가. */
  unavailable: boolean
  /** 구독을 붙였는가 — 이중 마운트에서 두 번 붙이지 않는다. */
  listening: boolean
  /** `knuaf:lanes-test` 로 넣은 시험 묶음인가 — 실제 밀려온 묶음이 오면 풀린다. */
  injected: boolean
  /** 마지막 요청의 오류 코드(화면은 [다시 확인] 안내에만 쓴다). */
  lastError: string | null
  /**
   * 카드별 무효 사유 — 계약 `CardDecision.reason` 은 응답에만 실리고 카드 저장에는 없다.
   * 접힌 줄이 `account-changed` 만 다른 문구를 쓰므로(설계 §3-5 [r3c C0]) 응답에서 받아 여기 둔다.
   */
  invalid: Record<string, CardInvalidReason>

  attach: () => void
  detach: () => void
  load: (root: string | null) => Promise<void>
  /** main 이 밀어 준 묶음. `seq` 가 더 작으면 버린다. */
  apply: (snapshot: LanesSnapshot) => void
  clear: () => void
  /** 응답을 기다리지 않는 요청 — 화면은 밀려온 묶음으로 다시 그린다. 실패하면 오류 코드를 돌려준다. */
  ask: (call: (api: { lanes: LanesApi; jobs: JobsApi }) => Promise<LanesReply<unknown>>) => Promise<string | null>
  /** 응답 **값**이 필요한 요청 — 보관 대화 열기, 카드 무효 사유처럼 묶음 밖의 답을 쓴다. */
  callValue: <T>(call: (api: { lanes: LanesApi; jobs: JobsApi }) => Promise<LanesReply<T>>) => Promise<{ value: T } | { error: string }>
}

/** 리스너를 한 번만 거는 표시 — `attach` 는 화면을 오갈 때마다 다시 불린다. */
const bound = { snapshot: false, test: false }

export const useLanes = create<LanesState>((set, get) => ({
  snapshot: null,
  root: null,
  unavailable: false,
  listening: false,
  injected: false,
  lastError: null,
  invalid: {},

  attach: () => {
    const { lanes } = seam()
    set({ listening: true, unavailable: lanes === null })
    // 이 부품은 화면을 오갈 때마다 다시 붙는다 — `window` 리스너는 한 번만 건다.
    if (lanes && !bound.snapshot) {
      bound.snapshot = true
      lanes.onSnapshot((snapshot) => {
        set({ injected: false })
        get().apply(snapshot)
      })
    }
    // 시험·개발용 주입 통로 — preload 배선 전에 실제 화면을 그려 보기 위한 것(설계 §7).
    if (!bound.test) {
      bound.test = true
      window.addEventListener(LANES_TEST_EVENT, ((event: Event) => {
        const detail = (event as CustomEvent<LanesSnapshot>).detail
        if (detail && typeof detail.seq === 'number') {
          set({ injected: true, unavailable: false })
          get().apply(detail)
        }
      }) as EventListener)
    }
  },

  detach: () => set({ listening: false }),

  load: async (root) => {
    const { lanes } = seam()
    if (!lanes) {
      set({ unavailable: true, snapshot: null, root })
      return
    }
    set({ unavailable: false, root })
    // 폴더를 옮기는 중 늦게 온 응답을 새 폴더 묶음으로 붙이지 않는다.
    const mine = (): boolean => get().root === root
    const r = await laneCall(() => lanes.snapshot(root))
    if (!mine()) return
    if ('error' in r) set({ unavailable: true, lastError: r.error })
    else set({ snapshot: r.value, lastError: null })
  },

  apply: (snapshot) => {
    const current = get().snapshot
    // 밀려온 묶음은 항상 최신이지만, 구독과 응답이 엇갈려 옛 것이 마지막에 닿을 수 있다.
    if (current && snapshot.seq <= current.seq) return
    set({ snapshot, unavailable: false })
  },

  clear: () => set({ snapshot: null, root: null }),

  ask: async (call) => {
    const { lanes, jobs } = seam()
    if (!lanes || !jobs) {
      set({ unavailable: true })
      return 'unavailable'
    }
    const r = await laneCall(() => call({ lanes, jobs }))
    if ('error' in r) {
      set({ lastError: r.error })
      return r.error
    }
    set({ lastError: null })
    return null
  },

  callValue: async <T,>(call: (api: { lanes: LanesApi; jobs: JobsApi }) => Promise<LanesReply<T>>) => {
    const { lanes, jobs } = seam()
    if (!lanes || !jobs) {
      set({ unavailable: true })
      return { error: 'unavailable' } as const
    }
    const r = await laneCall(() => call({ lanes, jobs }))
    if ('error' in r) set({ lastError: r.error })
    else set({ lastError: null })
    return r
  }
}))

/** 화면이 쓰는 요청 묶음. 실패는 오류 코드로만 돌아온다(그리기는 밀려온 묶음이 한다). */
export function laneActions() {
  const ask = useLanes.getState().ask
  return {
    /**
     * 카드 승인. 응답의 `reason` 은 묶음에 실리지 않으므로 여기서 `invalid` 에 적어 둔다 —
     * 접힌 줄이 `account-changed` 만 다른 문구를 쓰기 때문이다(설계 §3-5 [r3c C0]).
     */
    decideCard: async (root: string, cardId: string, baseVersion: number, action: CardAction): Promise<string | null> => {
      const r = await useLanes.getState().callValue(({ lanes }) => lanes.decideCard(root, cardId, baseVersion, action))
      if ('error' in r) return r.error
      const reason = r.value.outcome === 'invalid' ? r.value.reason : null
      if (reason) useLanes.setState((state) => ({ invalid: { ...state.invalid, [cardId]: reason } }))
      return null
    },
    cardStatus: async (root: string, cardId: string): Promise<string | null> => {
      const r = await useLanes.getState().callValue(({ lanes }) => lanes.cardStatus(root, cardId))
      if ('error' in r) return r.error
      if (r.value.outcome === 'invalid' && r.value.reason) {
        const reason = r.value.reason
        useLanes.setState((state) => ({ invalid: { ...state.invalid, [cardId]: reason } }))
      }
      return null
    },
    settingsCard: (root: string, kind: 'enable' | 'revert') => ask(({ lanes }) => lanes.settingsCard(root, kind)),
    disable: (root: string) => ask(({ lanes }) => lanes.disable(root)),
    dismiss: (root: string, lineId: string) => ask(({ lanes }) => lanes.dismiss(root, lineId)),
    handoffContinue: (root: string, proposalId: string) => ask(({ lanes }) => lanes.handoffContinue(root, proposalId)),
    handoffLater: (root: string, proposalId: string) => ask(({ lanes }) => lanes.handoffLater(root, proposalId)),
    stopOne: (root: string, jobId: string) => ask(({ jobs }) => jobs.stopOne(root, jobId)),
    continueJob: (root: string, proposalId: string) => ask(({ jobs }) => jobs.continue(root, proposalId)),
    later: (root: string, proposalId: string) => ask(({ jobs }) => jobs.later(root, proposalId)),
    retry: (root: string, jobId: string) => ask(({ jobs }) => jobs.retry(root, jobId)),
    discard: (root: string, jobId: string) => ask(({ jobs }) => jobs.discard(root, jobId)),
    redeliver: (root: string, jobId: string) => ask(({ jobs }) => jobs.redeliver(root, jobId)),
    authLater: (root: string, jobId: string) => ask(({ jobs }) => jobs.authLater(root, jobId)),
    archives: (root: string) => ask(({ lanes }) => lanes.archives(root)),
    archive: (root: string, archiveId: string) => ask(({ lanes }) => lanes.archive(root, archiveId)),
    pickReview: (root: string, company: Provider, model: string) =>
      ask(({ lanes }) => lanes.pickReview(root, company, model)),
    setConsent: (company: Provider, accountId: string, on: boolean) =>
      ask(({ lanes }) => lanes.setConsent(company, accountId, on))
  }
}
