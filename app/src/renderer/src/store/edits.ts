import { create } from 'zustand'
import { rpc, RpcFailure } from '../rpc'
import { recheckPlan, splitRecheck, withRecheck, type RecheckPlan } from '../../../shared/recheck'
import type { EditNotice, EditResult, EditRow } from '../../../shared/types'

/**
 * 뷰어 직접 수정 — 목록·알림·저장 호출 (설계 §3-3, §4-5-3, §5).
 *
 * **되돌리기는 없다**(§4-5-6). 잘못 고쳤으면 학생이 그 문장을 다시 드래그해 고친다. 그래서
 * 이 스토어에는 `undo` 가 없고, 화면에도 되돌리기 단추를 그리지 않는다.
 *
 * 저장 자체는 `PaperPane` 이 `save()` 로 부르고, 결과는 여기 남긴다 — 종이 머리의
 * `직접 고친 곳 n`, 그 문단 옆 점, 복구 알림이 모두 이 한 곳을 본다.
 *
 * 실패 문구는 설계 §3-5 그대로다(원고는 그대로 — sidecar 가 되돌린다).
 */

/** 저장 결과를 화면이 한 줄로 말할 때 쓰는 갈래. */
export type SaveOutcome =
  | { ok: true; result: EditResult }
  | { ok: false; message: string; detail?: string; code?: string }

interface EditState {
  /** 지금 논문의 고침 목록 — `section.edits` 응답 그대로. */
  rows: EditRow[]
  /** 아직 학생이 확인하지 않은 복구·보관 알림. */
  notices: EditNotice[]
  /** 목록을 읽지 못한 이유(모르는 것과 '없음'을 구분한다). */
  error: string | null
  /** 읽는 중인가 — 종이 머리 단추를 잠깐 흐리게 둘 뿐, 저장을 막지 않는다. */
  loading: boolean
  /** 어느 논문의 목록인가. 다른 폴더의 행이 새 화면에 섞이지 않게 한다. */
  root: string | null
  /**
   * sidecar 가 `section.edit` 을 갖고 있는가 — `null` 은 아직 모른다.
   *
   * 설계 §8-1: 규칙집 공개 함수가 모자라면 sidecar 가 `section.edit` 계열을 아예 등록하지
   * 않는다. 그때 화면은 `직접 수정` 단추를 **그리지 않는다**(흐리게도 두지 않는다 — 메서드가
   * 없는 실행기에서는 눌러도 아무 일이 안 되는 단추가 남는다). 목록 첫 호출이 `not_found` 로
   * 실패하면 `false` 로 굳힌다. `methods.list` 는 메인 프로세스만 읽으므로 화면이 그 값을
   * 물어볼 길이 없다.
   */
  available: boolean | null
  /**
   * 읽기 요청 번호 — 응답이 왔을 때 **가장 최근 요청**인지 이것으로 가른다(§4-5-8 04).
   * 논문이 바뀌면(A→B 포함) `reset()` 이 번호를 올려 이전 응답을 통째로 무효로 만든다.
   */
  seq: number
  load: (root: string) => Promise<void>
  /** 저장 한 건·묶음. 성공하면 목록을 다시 읽는다. */
  save: (root: string, params: SaveParams) => Promise<SaveOutcome>
  /** 알림을 보여 준 뒤 — 그 건을 다시 싣지 않게 표시한다(§4-5-3). */
  seen: (root: string, editIds: string[]) => Promise<void>
  /**
   * 다음 메시지에 붙일 재확인 메모(§6-1). 확인 전 고침이 없으면 `null`.
   * `titles` 는 절 id → 장 제목 — 메모가 장을 이름으로 말해야 학생·도우미가 찾는다.
   */
  memo: (titles?: Record<string, string>) => string | null
  /**
   * 보낼 본문에 메모를 붙인다(§6-1) — 그리고 **메모에 실제로 실린 건의 id** 를 함께 돌려준다.
   *
   * 돌려주는 목록이 중요한 이유: 응답을 기다리는 사이 학생이 하나 더 고쳐 저장할 수 있다.
   * 그 건은 메모에 **안 붙었다** — 그러니 `sent` 로 닫으면 안 되고 다음 메시지에 붙어야 한다.
   * 「지금 pending 전부」를 닫으면 그 고침이 확인 없이 지나간다.
   */
  attach: (text: string, titles?: Record<string, string>) => RecheckPlan & { text: string }
  /**
   * 전송이 받아들여진 순간 — 붙인 건들을 그 **턴**(`turn`)에 묶어 `sent` 로 적는다(§6-3).
   *
   * - `delivery` 가 `'uncertain'`(메인이 보낸 말이 갔는지 모른다)이면 **닫지 않는다** — 설계
   *   §6-3 "불확실이면 `pending` 그대로, 두 번 가도 해가 없다".
   * - 서버로는 `plan.marks` 만 보낸다 — 기록 유실 행(원장에 없음)을 섞으면 `not_found` 로
   *   호출 전체가 거절돼 정상 건까지 `pending` 으로 남는다(검토 B-R1 차단 1).
   * - 닫은 id 는 그 턴에 기억한다. `answered` 는 **메모가 실린 그 턴**이 정상으로 끝날 때만 켠다.
   * - 턴이 끝나기를 기다리지는 않는다 — 턴 도중 앱이 꺼져도 메시지는 이미 갔다.
   */
  markSent: (root: string, plan: RecheckPlan, turn: string, delivery?: 'sent' | 'uncertain') => Promise<void>
  /** 그 턴이 실패·중단·불확실로 끝났다 — 그 턴에 묶인 건을 `pending` 으로 되돌린다. */
  turnFailed: (root: string, turn: string) => Promise<void>
  /**
   * 목록의 `다시 확인 요청` — 그 건을 `pending` 으로 되돌린다(§6-3). 다음 메시지에 다시 붙는다.
   * 이미 `answered` 였으면 그 표시도 지운다(다시 확인받아야 하므로).
   */
  askAgain: (root: string, editId: string) => Promise<void>
  /** 그 턴이 정상으로 끝났다 — **그 턴에 묶인** 건들만 `answered` 로 닫는다(§5·§6-3). */
  markTurnDone: (root: string, turn: string) => Promise<void>
  /** 폴더를 닫거나 바꾸면 비운다. */
  reset: () => void
}

export type SaveParams =
  | { kind: 'one'; id: string; expected_revision: number; expected_draft_hash?: string | null; before_block: string; after_block: string }
  | { kind: 'batch'; expected_revision: number; edits: { section_id: string; before_block: string; after_block: string; expected_draft_hash?: string | null }[] }

/** 설계 §3-5 — 저장이 안 됐을 때 학생에게 하는 말. 원고는 그대로다. */
export function saveFailureText(e: unknown): { message: string; detail?: string; code?: string } {
  const code = e instanceof RpcFailure ? e.code : undefined
  const detail = e instanceof Error ? e.message : String(e)
  // 서버가 이미 사람 말로 준 것(`stale_view` 등)은 그대로 쓴다 — 화면이 문구를 새로 짓지 않는다.
  const given = e instanceof RpcFailure ? e.message : ''
  if (code === 'stale_view') return { message: given || '그사이 글이 바뀌었어요. 다시 골라 주세요.', code }
  if (code === 'agent_busy') return { message: '도우미가 쓰는 중이에요. 끝난 뒤 다시 해 주세요.', code }
  if (code === 'draft_unregistered') {
    return { message: '이 장은 앱 밖에서 고친 내용이 있어요. 도우미에게 먼저 확인받아 주세요.', code }
  }
  if (code === 'ambiguous') return { message: given || '고칠 문단을 본문에서 하나로 찾지 못했어요.', code }
  if (code === 'restore_pending') {
    return { message: given || '원고를 제자리에 돌려놓지 못했어요. 앱을 다시 켜 주세요.', detail, code }
  }
  return { message: "직접 고치지 못했어요. '고쳐 달라기'를 써 주세요.", detail, code }
}

/**
 * 이번 세션에 **화면에서만** 닫은 기록 유실 id (검토 B-R1 차단 1 ③).
 *
 * 원장에 없으므로 서버에는 닫을 길이 없다. 그대로 두면 `section.edits` 를 읽을 때마다
 * 되살아나 매 메시지에 같은 메모가 되풀이된다. 그래서 앱을 켜 둔 동안만 기억해 두고,
 * 앱을 다시 켜면 서버 상태대로 한 번 더 붙게 둔다(설계 §6-3 '두 번 가도 해가 없다').
 */
const closedLost = new Set<string>()

/**
 * 닫은 id 를 **그 턴**에 묶어 둔다 — `answered` 는 메모가 실린 그 턴이 정상으로 끝날 때만
 * 켠다(설계 §5). 다음 턴이 정상으로 끝났다고 앞 턴 건을 닫으면, 도우미가 그 고침을 다시
 * 볼 기회 없이 "답했어요"가 된다(검토 B-R1 중요 1).
 */
const turnOf = new Map<string, Set<string>>()

/** 읽어 온 행들에 이번 세션의 화면 닫힘을 입힌다 — 서버는 유실 행을 영영 `pending` 으로 준다. */
function closeLocally(rows: EditRow[]): EditRow[] {
  if (closedLost.size === 0) return rows
  return rows.map((row) => (row.lost_record === true && closedLost.has(row.edit_id) ? { ...row, state: 'sent' as const } : row))
}

export const useEdits = create<EditState>((set, get) => ({
  rows: [],
  notices: [],
  error: null,
  loading: false,
  root: null,
  available: null,
  seq: 0,

  reset: () => {
    // 다른 논문의 턴·유실 표시를 들고 가지 않는다 — 그 논문의 행에 다른 턴을 닫으려 들면
    // 엉뚱한 건이 `answered` 가 된다.
    turnOf.clear(); closedLost.clear()
    set((s) => ({
      rows: [], notices: [], error: null, loading: false, root: null, available: null,
      // 논문이 바뀌었다 — 도는 읽기의 응답은 이제 이 화면의 것이 아니다.
      seq: s.seq + 1
    }))
  },

  load: async (root) => {
    // 이 읽기가 **몇 번째**인지 적어 둔다 — 응답은 그것이 아직 최신일 때만 반영한다.
    const seq = useEdits.getState().seq + 1
    set({ loading: true, root, seq })
    const current = (): boolean => useEdits.getState().seq === seq && useEdits.getState().root === root
    try {
      const list = await rpc.edits(root)
      if (!current()) return // 논문이 바뀌었거나 더 새 읽기가 시작됐다 — 이 응답은 버린다
      set({ rows: closeLocally(list.edits), notices: list.notices, error: null, loading: false })
    } catch (e) {
      if (!current()) return
      // 메서드 자체가 없으면(§8-1) 단추를 안 그리는 쪽으로 굳힌다 — 다시 묻지 않는다.
      const missing = e instanceof RpcFailure && e.code === 'not_found'
      set({ error: saveFailureText(e).message, loading: false, available: missing ? false : useEdits.getState().available })
    }
  },

  save: async (root, params) => {
    try {
      const result = params.kind === 'one'
        ? await rpc.editSection(root, {
          id: params.id, expected_revision: params.expected_revision,
          expected_draft_hash: params.expected_draft_hash ?? null,
          before_block: params.before_block, after_block: params.after_block
        })
        : await rpc.editBatch(root, {
          expected_revision: params.expected_revision,
          edits: params.edits.map((e) => ({
            section_id: e.section_id, before_block: e.before_block, after_block: e.after_block,
            expected_draft_hash: e.expected_draft_hash ?? null
          }))
        })
      if (get().available === null) set({ available: true })
      void get().load(root)
      return { ok: true, result }
    } catch (e) {
      const missing = e instanceof RpcFailure && e.code === 'not_found'
      if (missing) set({ available: false })
      return { ok: false, ...saveFailureText(e) }
    }
  },

  memo: (titles) => recheckPlan(get().rows, titles).memo,

  attach: (text, titles) => {
    // 메모에 실릴 줄과 닫을 목록을 **한 번만** 계산한다(두 번 계산하면 그 사이 새로 저장된
    // 고침이 문구에는 빠지고 id 목록에는 들어오는 어긋남이 생긴다).
    const plan = recheckPlan(get().rows, titles)
    // 학생이 이미 메모를 품은 글을 보낼 수 있다(실패 복구 초안·`다시 보내기`). 그대로 붙이면
    // 메모가 2벌이 되고 입력칸에 전문이 드러난다(검토 B-R1 권고 3). 받은 글에서 먼저 뗀다.
    const { body } = splitRecheck(text)
    return { ...plan, text: withRecheck(body, plan.memo) }
  },

  markSent: async (root, plan, turn, delivery = 'sent') => {
    if (plan.ids.length === 0) return
    // 전달이 불확실하면 닫지 않는다 — 갔는지 모르는 말에 '전달됨'을 붙이면 학생이 다시
    // 보내지 않는다. 다음 메시지에 또 붙는 편이 안전하다(§6-3).
    if (delivery === 'uncertain') return
    // 화면부터 닫는다 — 서버가 실패해도 다음 전송에 같은 메모가 또 붙지 않게(중복 전송이 더 나쁘다).
    // `seq` 를 올려 **떠 있던 읽기**의 응답을 버린다. 안 올리면 저장 직후의 목록 읽기가 늦게
    // 돌아와 방금 닫은 건을 `pending` 으로 되돌려 놓는다(보낸 메모가 다시 붙는 원인).
    for (const id of plan.ids) {
      const set0 = turnOf.get(turn) ?? new Set<string>()
      set0.add(id); turnOf.set(turn, set0)
    }
    for (const id of plan.localOnly) closedLost.add(id)
    set((s) => ({
      rows: s.rows.map((r) => (plan.ids.includes(r.edit_id) ? { ...r, state: 'sent' as const } : r)),
      seq: s.seq + 1
    }))
    if (plan.marks.length === 0) return   // 전부 유실 행 — 서버에 보낼 것이 없다
    try {
      await rpc.editsMark(root, { edit_ids: plan.marks, state: 'sent' })
      // 서버가 받아들였으면 원장과 다시 맞춘다 — 화면과 원장이 어긋난 채로 두지 않는다.
      if (get().root === root) void get().load(root)
    } catch { /* 다음 읽기에서 다시 pending 으로 보인다 — 그때 또 붙는다 */ }
  },

  turnFailed: async (root, turn) => {
    const ids = [...(turnOf.get(turn) ?? [])]
    turnOf.delete(turn)
    if (ids.length === 0) return
    // 화면부터 되돌린다 — 다음 메시지에 같은 메모가 다시 붙어야 한다.
    set((s) => ({
      rows: s.rows.map((r) => (ids.includes(r.edit_id) ? { ...r, state: 'pending' as const, answered: false } : r)),
      seq: s.seq + 1
    }))
    // 유실 행은 서버가 모른다 — 보내면 호출 전체가 거절돼 정상 건까지 못 닫는다.
    const lostIds = ids.filter((id) => get().rows.find((r) => r.edit_id === id)?.lost_record === true)
    const marks = ids.filter((id) => !lostIds.includes(id))
    for (const id of lostIds) closedLost.delete(id)
    if (marks.length === 0) return
    try {
      await rpc.editsMark(root, { edit_ids: marks, state: 'pending' })
      if (get().root === root) void get().load(root)
    } catch { /* 다음 읽기에서 되살아난다 */ }
  },

  askAgain: async (root, editId) => {
    set((s) => ({
      rows: s.rows.map((r) => (r.edit_id === editId ? { ...r, state: 'pending' as const, answered: false } : r)),
      seq: s.seq + 1
    }))
    try {
      await rpc.editsMark(root, { edit_ids: [editId], state: 'pending' })
      if (get().root === root) void get().load(root)
    } catch { /* 다음 읽기에서 되살아난다 */ }
  },

  markTurnDone: async (root, turn) => {
    // **그 턴**에 메모가 실렸던 건만 닫는다(§5). 다른 턴이 정상으로 끝났다고 앞 턴 건을
    // 닫으면 도우미가 그 고침을 볼 기회 없이 '답했어요'가 된다(검토 B-R1 중요 1).
    const bound = turnOf.get(turn)
    if (!bound || bound.size === 0) return
    turnOf.delete(turn)
    const ids = [...bound].filter((id) => get().rows.find((row) => row.edit_id === id)?.answered !== true)
    if (ids.length === 0) return
    set((s) => ({
      rows: s.rows.map((r) => (ids.includes(r.edit_id) ? { ...r, answered: true } : r)),
      seq: s.seq + 1
    }))
    try {
      await rpc.editsMark(root, { edit_ids: ids, state: 'sent', turn_done: true })
      if (get().root === root) void get().load(root)
    } catch { /* 화면 표시만 남는다 */ }
  },

  seen: async (root, editIds) => {
    if (editIds.length === 0) return
    // 이 알림을 읽어 온 논문이 아니면 보내지 않는다(§4-5-8 04) — 다른 논문의 `edit_id` 를 섞지 않는다.
    if (useEdits.getState().root !== root) return
    // 화면에서 먼저 지운다 — 서버가 실패해도 알림이 다시 튀어나오지 않게(같은 알림을 두 번 보여 주는
    // 쪽이 더 나쁘다). 실패하면 다음 읽기에서 다시 실린다.
    set((s) => ({ notices: s.notices.filter((n) => !editIds.includes(n.edit_id)) }))
    try {
      await rpc.editsMark(root, { notices_seen: editIds })
    } catch { /* 다음 읽기에서 다시 싣는다 */ }
  }
}))

/** 확인 필요(`pending`)인 고침 수 — 종이 머리 단추·문단 점이 이 값을 본다. */
export function pendingCount(rows: EditRow[]): number {
  return rows.filter((r) => r.state === 'pending').length
}

/** 그 절에 걸린 고침들. 문단 옆 점을 그릴 자리를 정하는 데 쓴다. */
export function editsOfSection(rows: EditRow[], sectionId: string): EditRow[] {
  return rows.filter((r) => r.section_ids.includes(sectionId))
}
