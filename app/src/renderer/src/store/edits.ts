import { create } from 'zustand'
import { rpc, RpcFailure } from '../rpc'
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
  load: (root: string) => Promise<void>
  /** 저장 한 건·묶음. 성공하면 목록을 다시 읽는다. */
  save: (root: string, params: SaveParams) => Promise<SaveOutcome>
  /** 알림을 보여 준 뒤 — 그 건을 다시 싣지 않게 표시한다(§4-5-3). */
  seen: (root: string, editIds: string[]) => Promise<void>
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

export const useEdits = create<EditState>((set, get) => ({
  rows: [],
  notices: [],
  error: null,
  loading: false,
  root: null,
  available: null,

  reset: () => set({ rows: [], notices: [], error: null, loading: false, root: null, available: null }),

  load: async (root) => {
    set({ loading: true })
    try {
      const list = await rpc.edits(root)
      // 읽는 사이 폴더가 바뀌었으면 버린다 — 다른 논문의 고침이 새 화면에 붙으면 안 된다.
      if (useEdits.getState().root !== null && useEdits.getState().root !== root) return
      set({ rows: list.edits, notices: list.notices, error: null, loading: false, root })
    } catch (e) {
      // 메서드 자체가 없으면(§8-1) 단추를 안 그리는 쪽으로 굳힌다 — 다시 묻지 않는다.
      const missing = e instanceof RpcFailure && e.code === 'not_found'
      set({ error: saveFailureText(e).message, loading: false, root, available: missing ? false : useEdits.getState().available })
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

  seen: async (root, editIds) => {
    if (editIds.length === 0) return
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
