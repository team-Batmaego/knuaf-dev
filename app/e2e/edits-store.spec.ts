/**
 * 화면 묶음 A 고침 1 — Roh 04·05를 **Node 스토어 시험**으로 잠근다 (설계 §4-5-8).
 *
 * Electron 없이 실제 스토어 함수를 돌리고 RPC·Zustand 저장 부분만 메모리 모형으로 바꾼다 —
 * Roh 판정서의 재현 방식과 같다. 무거운 화면 시험이 아니라 `playwright.node.config.ts` 로 돈다.
 */
import { expect, test } from '@playwright/test'
import { useEdits } from '../src/renderer/src/store/edits'
import { useProject } from '../src/renderer/src/store/project'

/** `window.knuaf` 를 메모리 모형으로 바꾸고, 끝나면 되돌린다. */
async function withWindow<T>(model: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  // Node 에는 `window` 가 없다 — 스토어가 부르는 `window.knuaf.call` 만 메모리 모형으로 심는다.
  const holder: { window?: unknown } = globalThis
  const oldWindow = holder.window
  Object.assign(globalThis, { window: model })
  try {
    return await run()
  } finally {
    Object.assign(globalThis, { window: oldWindow })
  }
}

/** `section.edits` 응답 한 건. */
function editRow(editId: string, state: 'plain' | 'pending' = 'plain') {
  return {
    edit_id: editId, at: '2026-11-11T00:00:00+00:00', state, revision_before: 1, revision_after: 2,
    edits: [{ section_id: 'sec-01', before_block: '가', after_block: '나' }], section_ids: ['sec-01'],
    needs_check: false, new_issues: [], remaining_issues: [], answered: false
  }
}

/** 매 호출을 기록하고, `section.edits` 는 주어진 응답을 차례로 돌려주는 RPC 모형. */
function rpcModel(script: { edits?: (root: string) => Promise<unknown> | unknown; calls?: string[] }) {
  const calls = script.calls ?? []
  return {
    knuaf: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push(`${method}:${String(params.root ?? '')}`)
        if (method === 'section.edits' && script.edits) {
          return { result: await script.edits(String(params.root ?? '')) }
        }
        return { result: null }
      }
    }
  }
}

test.beforeEach(() => {
  useEdits.setState({ rows: [], notices: [], error: null, loading: false, root: null, available: null, seq: 0 })
})

// ── Roh 04: 논문 전환·늦게 온 응답 ─────────────────────────────────────────

test('Roh 04 — A 의 목록은 B 로 바꾸면 남지 않는다 (A→B)', async () => {
  const model = rpcModel({
    edits: (root) => root === '/A'
      ? { edits: [editRow('edit-A')], notices: [{ kind: 'restored', message: 'A 알림', edit_id: 'edit-A' }] }
      : { edits: [editRow('edit-B')], notices: [] }
  })
  await withWindow(model, async () => {
    await useEdits.getState().load('/A')
    expect(useEdits.getState().rows.map((r) => r.edit_id)).toEqual(['edit-A'])
    // 다른 논문으로 바뀌었다 — 화면(PaperPane)이 먼저 비운다(§4-5-8 04).
    useEdits.getState().reset()
    expect(useEdits.getState().rows).toEqual([])
    expect(useEdits.getState().notices).toEqual([])
    await useEdits.getState().load('/B')
    expect(useEdits.getState().rows.map((r) => r.edit_id)).toEqual(['edit-B'])
    expect(useEdits.getState().root).toBe('/B')
  })
})

test('Roh 04 — A→B→A 에서도 마지막 논문의 것만 남는다', async () => {
  const model = rpcModel({
    edits: (root) => ({ edits: [editRow(`edit-${root.slice(1)}`)], notices: [] })
  })
  await withWindow(model, async () => {
    await useEdits.getState().load('/A')
    useEdits.getState().reset()
    await useEdits.getState().load('/B')
    useEdits.getState().reset()
    await useEdits.getState().load('/A')
    expect(useEdits.getState().rows.map((r) => r.edit_id)).toEqual(['edit-A'])
  })
})

test('Roh 04 — A 요청이 떠 있는 사이 B 를 읽고, 늦게 온 A 성공 응답은 버린다', async () => {
  // A→B→A 에서 실제로 깨지던 꼴: A 요청이 떠 있고, 그사이 reset 뒤 B 를 읽어 root=B 가 되고,
  // 그 다음 늦은 A 응답이 온다. b067ecd 는 root 가 비어 있지 않고 A 와 다르면 버렸지만,
  // **reset 중**에 도착하면(=root 가 null 인 순간) A 데이터를 다시 게시했다.
  const slow = Promise.withResolvers<unknown>()
  const model = rpcModel({
    edits: (root) => root === '/A' ? slow.promise : { edits: [editRow('edit-B')], notices: [] }
  })
  await withWindow(model, async () => {
    const first = useEdits.getState().load('/A')
    useEdits.getState().reset()
    await useEdits.getState().load('/B')
    slow.resolve({ edits: [editRow('edit-A')], notices: [{ kind: 'restored', message: 'A 알림', edit_id: 'edit-A' }] })
    await first
    expect(useEdits.getState().rows.map((r) => r.edit_id)).toEqual(['edit-B'])
    expect(useEdits.getState().notices).toEqual([])
    expect(useEdits.getState().root).toBe('/B')
  })
})

test('Roh 04 — reset 만 하고 새 읽기 전에 늦은 A 응답이 와도 A 를 다시 게시하지 않는다', async () => {
  const slow = Promise.withResolvers<unknown>()
  const model = rpcModel({ edits: () => slow.promise })
  await withWindow(model, async () => {
    const first = useEdits.getState().load('/A')
    useEdits.getState().reset() // 새 논문으로 넘어가는 중 — 아직 읽기 전
    slow.resolve({ edits: [editRow('edit-A')], notices: [] })
    await first
    // reset 이전에 시작한 읽기의 응답은 버린다 — A 의 고침이 빈 화면에 되살아나면 안 된다.
    expect(useEdits.getState().rows).toEqual([])
  })
})

test('Roh 04 — 늦게 온 앞 요청의 실패는 뒤 요청 결과를 덮지 않는다', async () => {
  const slow = Promise.withResolvers<unknown>()
  const model = rpcModel({
    edits: (root) => root === '/A' ? slow.promise : { edits: [editRow('edit-B')], notices: [] }
  })
  await withWindow(model, async () => {
    const first = useEdits.getState().load('/A')
    useEdits.getState().reset()
    await useEdits.getState().load('/B')
    slow.reject(new Error('A 읽기 실패'))
    await first.catch(() => {})
    // 늦은 실패가 B 화면에 오류를 띄우지 않는다.
    expect(useEdits.getState().error).toBeNull()
    expect(useEdits.getState().rows.map((r) => r.edit_id)).toEqual(['edit-B'])
  })
})

test('Roh 04 — 확인(notices_seen)은 그 알림을 읽어 온 논문으로만 보낸다', async () => {
  const calls: string[] = []
  const model = rpcModel({ edits: () => ({ edits: [], notices: [{ kind: 'restored', message: 'A 알림', edit_id: 'edit-A' }] }), calls })
  await withWindow(model, async () => {
    await useEdits.getState().load('/A')
    expect(useEdits.getState().notices).toHaveLength(1)
    // 다른 논문의 화면에서 누른 확인은 보내지 않는다.
    await useEdits.getState().seen('/B', ['edit-A'])
    expect(calls.filter((c) => c.startsWith('section.edits_mark'))).toEqual([])
    // 읽어 온 논문에서는 보낸다.
    await useEdits.getState().seen('/A', ['edit-A'])
    expect(calls.filter((c) => c.startsWith('section.edits_mark'))).toHaveLength(1)
  })
})

// ── Roh 05: 학생 고침 억제는 그 지문과 같을 때만 ───────────────────────────

/** `project.sections` 응답 한 줄 — 화면이 '바뀐 절'을 세는 기준. */
function sectionRow(id: string, draftHash: string) {
  return {
    id, title: id, order: 1, path: `sections/${id}.md`, status: 'drafting', revision: 2,
    draft_hash: draftHash, draft_hash_ok: true, claims: null
  }
}

/** `loadSections` 가 부르는 RPC 를 메모리 모형으로 — `project.sections` 만 응답한다. */
function sectionsModel(rows: () => unknown[], reader: { bodies?: Record<string, string> } = {}) {
  const bodies = reader.bodies ?? {}
  return {
    knuaf: {
      call: async (method: string) => {
        if (method === 'project.sections') return { result: rows() }
        if (method === 'section.read_all') {
          return { result: Object.entries(bodies).map(([id, draft]) => ({ id, title: id, path: `sections/${id}.md`, draft })) }
        }
        return { result: null }
      }
    }
  }
}

test('Roh 05 — 저장 지문과 다음 읽기 지문이 같으면 도우미 알림을 만들지 않는다', async () => {
  const model = sectionsModel(() => [sectionRow('sec-01', 'student-hash')], { bodies: { 'sec-01': '가' } })
  await withWindow(model, async () => {
    useProject.setState({ root: '/paper', sections: null, events: [] })
    // 첫 읽기 — 비교할 직전이 없으므로 알림이 없다.
    await useProject.getState().loadSections()
    expect(useProject.getState().events).toEqual([])
    // 학생이 그 절을 저장하고 결과 지문을 알린다.
    useProject.getState().noteOwnEdit('sec-01', 'student-hash')
    await useProject.getState().loadSections()
    expect(useProject.getState().events).toEqual([]) // 내 변경은 알림이 아니다
  })
})

test('Roh 05 — 그사이 도우미가 다시 썼으면(지문 다름) 알림이 생긴다', async () => {
  const model = sectionsModel(() => [sectionRow('sec-01', 'assistant-hash')], { bodies: { 'sec-01': '나' } })
  await withWindow(model, async () => {
    useProject.setState({ root: '/paper', sections: null, events: [] })
    await useProject.getState().loadSections()
    // 학생이 저장했지만, 그사이 도우미가 그 절을 다시 썼다 — 지문이 다르다.
    useProject.getState().noteOwnEdit('sec-01', 'student-hash')
    const before = useProject.getState().events.length
    await useProject.getState().loadSections()
    // 이번 읽기가 **새로** 만든 알림만 센다(이벤트 줄은 덧붙는다).
    expect(useProject.getState().events.slice(before).map((e) => e.sectionId)).toEqual(['sec-01'])
  })
})

test('Roh 05 — 묶음에서 한 절만 도우미가 바꿨으면 그 절만 알림이 생긴다', async () => {
  const state = { hashes: { 'sec-01': 'mine-1', 'sec-02': 'mine-2' } }
  const model = sectionsModel(() => [sectionRow('sec-01', state.hashes['sec-01']), sectionRow('sec-02', state.hashes['sec-02'])],
    { bodies: { 'sec-01': '가', 'sec-02': '나' } })
  await withWindow(model, async () => {
    useProject.setState({ root: '/paper', sections: null, events: [] })
    await useProject.getState().loadSections()
    // 묶음 저장 — 절마다 정확한 지문(§4-5-8 05 의 `draft_hashes`).
    useProject.getState().noteOwnEdit('sec-01', 'mine-1')
    useProject.getState().noteOwnEdit('sec-02', 'mine-2')
    // 그사이 도우미가 둘째 절만 다시 썼다.
    state.hashes['sec-02'] = 'assistant-2'
    const before = useProject.getState().events.length
    await useProject.getState().loadSections()
    expect(useProject.getState().events.slice(before).map((e) => e.sectionId)).toEqual(['sec-02'])
  })
})

test('Roh 05 — 지문을 모르는 알림은 억제하지 않는다(절 ID 만으로는 빼지 않는다)', async () => {
  // 처음엔 지문 A, 다음 읽기에서 지문 B. 지문 없이 절 ID 만 알린 경우(`noteOwnEdit(['sec-01'])`)
  // 그 절은 **여전히 바뀐 절**로 세어져야 한다 — ID 만 보고 빼면 도우미 변경을 삼킨다.
  const state = { hash: 'hash-A' }
  const model = sectionsModel(() => [sectionRow('sec-01', state.hash)], { bodies: { 'sec-01': '나' } })
  await withWindow(model, async () => {
    useProject.setState({ root: '/paper', sections: null, events: [] })
    await useProject.getState().loadSections()
    state.hash = 'hash-B'
    useProject.getState().noteOwnEdit(['sec-01']) // 지문 없음 — 기억하지 않는다
    const before = useProject.getState().events.length
    await useProject.getState().loadSections()
    expect(useProject.getState().events.slice(before).map((e) => e.sectionId)).toEqual(['sec-01'])
  })
})
