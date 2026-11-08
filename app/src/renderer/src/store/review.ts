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

/** Count changed places between two bodies; first writing counts as `wrote`, not a place count. */
function editBetween(before: string, after: string): ReviewEdit {
  return before.length === 0 && after.length > 0
    ? { kind: 'wrote' }
    : { kind: 'edited', count: countEditedAreas(before, after) }
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
          const previous = state.lastSeen[key]
          const saved = state.baseline[key]
          const known = state.editCounts[editKey(root, sectionId, doc.hash)]
          /**
           * Count **bodies**, not hashes. PaperPane's fire-and-forget read and the section list
           * are two independent readers: the pane can report the saved body first (recorded
           * under the old hash), then the list reports the same body under the new hash. A hash
           * check alone then compares the body with itself and tells the student "0곳" while the
           * diff shows real changes. So:
           *   - a genuinely newer body (this save) counts against the body seen just before it;
           *   - the same body under a new hash (the race) counts against the persisted baseline —
           *     the same `before` that "고친 부분 보기" draws;
           *   - an already-counted hash keeps its first count (events are fixed when created).
           */
          let edit: ReviewEdit | null = null
          if (previous && previous.draft !== doc.draft) edit = editBetween(previous.draft, doc.draft)
          // A zero count must not stand next to a non-empty "고친 부분 보기" diff: the counter
          // and the rendered diff share the persisted baseline as their `before`. A hash that
          // already has a fixed count is never recomputed (a second read of the same save must
          // not overwrite it with a different basis).
          const weak = !edit || (edit.kind === 'edited' && edit.count === 0)
          if (weak && !known && previous && saved && saved.draft !== doc.draft) {
            edit = editBetween(saved.draft, doc.draft)
          }
          return {
            baseline: {
              ...state.baseline,
              [key]: { title: saved?.title ?? doc.title, draft: persistedDraft, hash: saved?.hash ?? '' }
            },
            lastSeen: { ...state.lastSeen, [key]: doc },
            ...(edit ? { editCounts: { ...state.editCounts, [editKey(root, sectionId, doc.hash)]: edit } } : {})
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
