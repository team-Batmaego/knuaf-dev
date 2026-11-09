import { create } from 'zustand'
import { REVIEW } from '../copy'
import { sectionDiff } from '../../../shared/diff'

/**
 * `quote` and `showDiff` are session state. The comparison baseline lives in the
 * project folder; the last-seen body and per-save edit counts stay in memory.
 */
export type ReviewQuote = {
  /** 어느 논문에서 골랐는가 — 다른 폴더 대화에 붙지 않게 한다(QA2B-R1-01). */
  root: string
  /** 고른 문장 — 줄바꿈은 공백으로 눌러 한 줄로 둔다(우리가 보낼 인용 형식이 한 줄이다). */
  text: string
  /** 그 문장이 있던 장(절) id. */
  sectionId: string
  /** 그 장의 제목 — 인용 줄 `(…에서)` 에 쓴다. */
  sectionTitle: string
}

/** Section baseline data shared by the persisted comparison and session edit tracking. */
export type BaselineDoc = { title: string; draft: string; hash: string }
export type ReviewEdit = { kind: 'wrote' } | { kind: 'edited'; count: number | null }

interface ReviewState {
  /** 입력칸 위에 붙어 있는 인용. 없으면 null. */
  quote: ReviewQuote | null
  setQuote: (quote: ReviewQuote) => void
  clearQuote: () => void
  /** 종이 머리 "고친 부분 보기"가 켜져 있는가. */
  showDiff: boolean
  setShowDiff: (on: boolean) => void
  toggleDiff: () => void
  /** `${root}::${sectionId}` → 처음 본 본문. */
  baseline: Record<string, BaselineDoc>
  /** 처음 본 순간에만 박는다 — 이후 저장은 모두 이 기준과 견준다. */
  noteBaseline: (key: string, doc: BaselineDoc) => void
  /** Last body seen per section in this app session. */
  lastSeen: Record<string, BaselineDoc>
  /** `${root}::${sectionId}` → 이 절이 처음 받은 본문. 첫 쓰기(`wrote`) 판정은 읽기 순서가 아니라 이 본문으로 한다. */
  firstBodies: Record<string, string>
  /** Change kind/count by section and saved draft hash. */
  editCounts: Record<string, ReviewEdit>
  /** Ensure the durable comparison baseline, then record the latest body. */
  noteSeen: (root: string, sectionId: string, doc: BaselineDoc) => Promise<void>
  editOf: (root: string, sectionId: string, hash: string) => ReviewEdit | null
}

const pendingNotes = new Map<string, Promise<void>>()

/** Count changed runs separated by unchanged text, including a replacement as one run. */
function countEditedAreas(before: string, after: string): number {
  let count = 0
  let inChange = false
  for (const block of sectionDiff(before, after)) {
    if (block.kind === 'same') {
      inChange = false
    } else if (block.kind === 'segs') {
      for (const segment of block.segs) {
        if (segment.kind === 'same') inChange = false
        else if (!inChange) { count++; inChange = true }
      }
    } else if (!inChange) {
      count++
      inChange = true
    }
  }
  return count
}

function editKey(root: string, sectionId: string, hash: string): string {
  return JSON.stringify([root, sectionId, hash])
}
export const useReview = create<ReviewState>((set, get) => ({
  quote: null,
  setQuote: (quote) => set({ quote }),
  clearQuote: () => set({ quote: null }),
  showDiff: false,
  setShowDiff: (showDiff) => set({ showDiff }),
  toggleDiff: () => set((s) => ({ showDiff: !s.showDiff })),
  baseline: {},
  lastSeen: {},
  firstBodies: {},
  editCounts: {},
  noteBaseline: (key, doc) => set((s) => (s.baseline[key] ? s : { baseline: { ...s.baseline, [key]: doc } })),
  noteSeen: (root, sectionId, doc) => {
    const key = baselineKey(root, sectionId)
    const queued = (pendingNotes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const reply = await window.knuaf.review.ensureBaseline(root, sectionId, doc.draft)
        const persistedDraft = reply.result?.draft
        if (typeof persistedDraft !== 'string') {
          throw new Error(reply.error?.message ?? '비교 기준을 불러오거나 저장하지 못했어요.')
        }
        set((state) => {
          const saved = state.baseline[key]
          const hashKey = editKey(root, sectionId, doc.hash)
          const known = state.editCounts[hashKey]
          const earlier = state.lastSeen[key]
          /**
           * 숫자의 뜻은 하나다 — **화면 "고친 부분 보기"의 `before`(persisted baseline) 대비 바뀐 곳 수**.
           * 그리고 해시마다 **한 번만** 확정한다. 이 두 규칙이 검토(REVIEW-W10-W12) 중요 1·2를 닫는다:
           *   ① 팬의 fire-and-forget 읽기와 목록 읽기가 어떤 순서로 들어와도 `before`가 baseline으로
           *      고정이므로 같은 해시는 같은 값을 낸다(직전 관측 본문에 기대지 않는다).
           *   ② 같은 해시에 다른 본문이 뒤따라 와도(옛 해시·새 본문 경합) 이미 정한 값을 덮지 않는다.
           * 첫 쓰기(`wrote`) 분류도 **읽기 순서와 무관**하다: 기준본이 비어 있고 이 본문이 그 절이 **처음 받은
           * 본문**이면 `wrote`다. 첫 본문은 해시가 아니라 **본문**으로 기억한다(`firstBodies`) — 그래서 팬이
           * 새 본문을 옛 해시로 먼저 읽어도(`('',e0)→(B,e0)→(B,e1)`), 목록이 바로 새 해시로 와도
           * (`('',e0)→(B,e1)`) 둘 다 `wrote`다. 다른 본문이면 이미 첫 쓰기를 지난 것이므로 곳 수로 센다.
           */
          const base = saved?.draft ?? persistedDraft
          const first = state.firstBodies[key] ?? (doc.draft === '' ? '' : doc.draft)
          const firstBody = base === '' && doc.draft !== '' && doc.draft === first
          let edit: ReviewEdit | null = known ?? null
          if (!known) {
            if (base !== doc.draft) {
              edit = firstBody ? { kind: 'wrote' } : { kind: 'edited', count: countEditedAreas(base, doc.draft) }
            } else if (earlier && earlier.draft !== doc.draft) {
              // 기준본으로 되돌아온 저장 — 새로 쓴 것이 아니므로 `wrote`가 아니라 0곳이다
              // (diff도 비어 있어 문구와 화면이 일치한다).
              edit = { kind: 'edited', count: 0 }
            }
          }
          return {
            baseline: {
              ...state.baseline,
              [key]: { title: saved?.title ?? doc.title, draft: persistedDraft, hash: saved?.hash ?? '' }
            },
            lastSeen: { ...state.lastSeen, [key]: doc },
            ...(state.firstBodies[key] === undefined && doc.draft !== '' ? { firstBodies: { ...state.firstBodies, [key]: doc.draft } } : {}),
            ...(known || !edit ? {} : { editCounts: { ...state.editCounts, [hashKey]: edit } })
          }
        })
      })
    pendingNotes.set(key, queued)
    void queued.then(
      () => { if (pendingNotes.get(key) === queued) pendingNotes.delete(key) },
      () => { if (pendingNotes.get(key) === queued) pendingNotes.delete(key) }
    )
    return queued
  },
  editOf: (root, sectionId, hash) => get().editCounts[editKey(root, sectionId, hash)] ?? null,
}))

/** 비교 기준의 키 — 논문과 절. */
export function baselineKey(root: string, sectionId: string): string {
  return `${root}::${sectionId}`
}

/** 고른 문장을 한 줄로 눌러 담는다 — 여러 줄 선택도 인용은 한 줄이다. */
export function quoteOf(root: string, text: string, sectionId: string, sectionTitle: string): ReviewQuote {
  return { root, text: text.replace(/\s+/g, ' ').trim(), sectionId, sectionTitle }
}

/**
 * 보낼 메시지 — 발주 §③ 형식 그대로.
 *
 * ```
 * > <선택 문장>
 * (<장 제목>에서)
 *
 * <학생 글>
 * ```
 * 학생 글이 비면 "이 부분을 고쳐 줘"를 대신 넣는다(무엇을 하려는지가 메시지에 남아야 한다).
 */
export function buildQuotedMessage(quote: ReviewQuote, text: string): string {
  const body = text.trim() || REVIEW.quoteFallback
  return `> ${quote.text}\n(${quote.sectionTitle}에서)\n\n${body}`
}
