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
  // `reset()` 이 턴 묶음·유실 표시(모듈 전역)까지 비운다 — 시험 사이에 남지 않게 여기서 부른다.
  useEdits.getState().reset()
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

// ── 묶음 B: 메모 붙이기 · sent · answered (설계 §6-1·§6-3) ─────────────────

test('B — 보낼 본문에 확인 전 고침만 메모로 붙는다', async () => {
  useEdits.setState({ rows: [
    { ...editRow('e1', 'pending'), edits: [{ section_id: 'sec-01', before_block: '600평이다.', after_block: '700평이다.' }], section_ids: ['sec-01'] },
    editRow('e2', 'plain')
  ] as never })
  const attached = useEdits.getState().attach('확인해 줘', { 'sec-01': 'Ⅰ. 머리말' }).text
  expect(attached).toContain('확인해 줘')
  expect(attached).toContain('Ⅰ. 머리말')
  expect(attached).toContain('"600평이다." → "700평이다."')
  expect(attached.split('- ').length).toBe(2)   // 항목 한 건
})

test('B — 전달이 받아들여지면 pending → sent, 서버가 실패해도 화면은 닫힌다', async () => {
  let failed = true
  const model = {
    knuaf: {
      call: async (method: string) => {
        if (method === 'section.edits_mark' && failed) return { error: { code: 'internal', message: 'boom' } }
        return { result: null }
      }
    }
  }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending'), editRow('e2', 'pending')] as never })
    await useEdits.getState().markSent('/A', useEdits.getState().attach(''), 'turn-A')
    // 서버 실패 — 그래도 다시 보내지 않게 화면은 이미 `sent`.
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent', 'sent'])
    failed = false
  })
})

test('B — 턴이 정상으로 끝나면 sent 가 answered 가 되고, pending 은 그대로 남는다', async () => {
  const calls: string[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => { calls.push(`${method}:${JSON.stringify(p.edit_ids)}:${String(p.turn_done)}`); return { result: null } } } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending'), editRow('e2', 'pending')] as never })
    // 전송 실패 상황: markSent 를 부르지 않았다 → 둘 다 pending 이고 닫히면 안 된다.
    await useEdits.getState().markTurnDone('/A', 'turn-A')
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([false, false])
    expect(calls).toEqual([])

    await useEdits.getState().markSent('/A', useEdits.getState().attach(''), 'turn-A')
    await useEdits.getState().markTurnDone('/A', 'turn-A')
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([true, true])
    // 마지막 호출이 `turn_done:true` 를 실은 sent 표시다 — 이 두 번째 인자가 없으면 sidecar 가
    // `answered` 로 닫지 않는다(`methods_edit.py` `section_edits_mark`).
    expect(calls.at(-1)).toBe('section.edits_mark:["e1","e2"]:true')
  })
})

test('B — 이미 answered 인 건은 턴이 또 끝나도 다시 닫지 않는다', async () => {
  const calls: string[] = []
  const model = { knuaf: { call: async (method: string) => { calls.push(method); return { result: null } } } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [{ ...editRow('e1', 'pending'), answered: true }] as never })
    await useEdits.getState().markTurnDone('/A', 'turn-A')
    expect(calls).toEqual([])
  })
})

test('B — 보내는 사이 새로 저장된 고침은 sent 가 되지 않고 다음 메시지에 붙는다', async () => {
  const calls: string[][] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits_mark') calls.push((p.edit_ids as string[]) ?? [])
    return { result: null }
  } } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending'), editRow('e2', 'pending')] as never })
    // 메모를 붙이는 순간 확인 전이던 것은 e1 뿐이다.
    useEdits.setState({ rows: [editRow('e1', 'pending'), editRow('e2', 'plain')] as never })
    const sent1 = useEdits.getState().attach('첫 메시지')
    expect(sent1.ids).toEqual(['e1'])
    // 응답을 기다리는 사이 학생이 하나 더 고쳐 저장했다 — 이 건은 **메모에 안 붙었다**.
    useEdits.setState((s) => ({ rows: [...s.rows, editRow('e3', 'pending')] as never }))
    await useEdits.getState().markSent('/A', sent1, 'turn-1')
    // 붙인 것만 닫힌다. e3 는 pending 그대로 — 다음 메시지에 붙어야 한다.
    expect(useEdits.getState().rows.map((r) => [r.edit_id, r.state])).toEqual([['e1', 'sent'], ['e2', 'plain'], ['e3', 'pending']])
    expect(calls).toEqual([['e1']])
    // 다음 메시지에는 e3 가 붙는다.
    expect(useEdits.getState().attach('두 번째').ids).toEqual(['e3'])
  })
})

test('B — 다시 확인 요청은 그 건을 pending 으로 되돌리고 answered 를 지운다 (설계 §6-3)', async () => {
  const calls: { ids: string[]; state: string }[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits_mark') calls.push({ ids: (p.edit_ids as string[]) ?? [], state: String(p.state) })
    return { result: null }
  } } }
  await withWindow(model, async () => {
    // 이미 답을 받아 `answered` 가 된 건 — 학생이 다시 확인받고 싶다.
    useEdits.setState({ rows: [{ ...editRow('e1', 'pending'), answered: true }, editRow('e2', 'plain')] as never })
    await useEdits.getState().askAgain('/A', 'e1')
    const row = useEdits.getState().rows.find((r) => r.edit_id === 'e1')!
    expect(row.state).toBe('pending')
    expect(row.answered).toBe(false)
    // 옆 건은 건드리지 않는다.
    expect(useEdits.getState().rows.find((r) => r.edit_id === 'e2')!.state).toBe('plain')
    expect(calls).toEqual([{ ids: ['e1'], state: 'pending' }])
    // 되돌린 건은 다음 메시지에 다시 실린다.
    expect(useEdits.getState().attach('다시 봐 줘').ids).toEqual(['e1'])
  })
})

test('B — 저장이 끝나며 뜬 늦은 목록 읽기가 방금 닫은 건을 pending 으로 되돌리지 않는다', async () => {
  // 실제로 깨지던 꼴: `markSent` 가 화면을 `sent` 로 닫은 직후, 저장이 부른 `load` 응답이
  // 늦게 도착해 원장의 옛 `pending` 을 그대로 덮어쓴다 → 칩이 되살아나고 메모가 또 붙는다.
  const stale = Promise.withResolvers<unknown>()
  const fresh = Promise.withResolvers<unknown>()
  let calls = 0
  const model = { knuaf: { call: async (method: string) => {
    if (method !== 'section.edits') return { result: null }
    calls += 1
    if (calls === 1) return { result: { edits: [editRow('e1', 'pending')], notices: [] } }
    // 2 = 저장이 부른 읽기(옛 원장, 늦게 온다) / 3 = markSent 뒤의 읽기(새 원장)
    return { result: calls === 2 ? stale.promise : fresh.promise }
  } } }
  await withWindow(model, async () => {
    await useEdits.getState().load('/A')
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['pending'])
    const late = useEdits.getState().load('/A')     // 저장이 부른 읽기 — 아직 응답 없음
    const plan = useEdits.getState().attach('보내기')
    await useEdits.getState().markSent('/A', plan, 'turn-A')
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent'])
    // 그제야 옛 원장(pending)이 도착한다 — 되돌리면 칩이 되살아나고 메모가 또 붙는다.
    stale.resolve({ edits: [editRow('e1', 'pending')], notices: [] })
    await late
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent'])
    // 서버를 다시 읽어 원장과 맞춘다 — 그 응답은 `sent` 다.
    fresh.resolve({ edits: [editRow('e1', 'sent')], notices: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent'])
  })
})

// ── 저장 경합: 화면의 개정이 아직 앞 저장을 못 따라왔을 때 ───────────────────

/** `section.edit`·`section.edit_batch` 응답 한 건 — 실제 `EditResult` 모양. */
function editResult(revision: number) {
  return {
    revision, draft_hash: 'h', draft_hashes: {}, needs_check: false, new_issues: [],
    reviews_staled: 0, recheck_before_submit: false, edit_id: `edit-${revision}`
  }
}

test('연속 저장 — 화면이 옛 개정을 들고 있어도 다음 저장은 앞 저장이 알려 준 개정으로 나간다', async () => {
  // 실제로 깨지던 꼴(#125 맥 e2e viewer-edit.spec.ts:279): 앞 저장(`kind:'one'`)의 응답은 이미
  // 왔는데 그 뒤의 조용한 `refresh()` 가 아직 안 돌아와 `status.revision` 이 옛 값이다. 그 40ms
  // 사이에 누른 `같이 고치기`(`kind:'batch'`)가 옛 개정으로 나가 sidecar 가 `stale_view` 로
  // 거절했다 — 원고는 안 바뀌고 "그사이 글이 바뀌었어요"만 떴다.
  const sent: number[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits') return { result: { edits: [], notices: [] } }
    if (method !== 'section.edit' && method !== 'section.edit_batch') return { result: null }
    sent.push(p.expected_revision as number)
    return { result: editResult((p.expected_revision as number) + 1) }
  } } }
  await withWindow(model, async () => {
    useEdits.getState().reset()
    // 화면이 아는 개정은 3 — 정본은 아직 3 이다.
    const one = await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 3, expected_draft_hash: 'h', before_block: '가', after_block: '나'
    })
    expect(one.ok).toBe(true)
    // 조용한 갱신이 끝나기 전에 누른 두 번째 저장 — 호출자가 넘긴 값은 여전히 옛 3 이다.
    const batch = await useEdits.getState().save('/A', {
      kind: 'batch', expected_revision: 3, edits: [{ section_id: 'sec-02', before_block: '다', after_block: '라' }]
    })
    expect(batch.ok).toBe(true)
    // 두 번째는 옛 3 이 아니라 앞 저장이 만든 4 로 나간다.
    expect(sent).toEqual([3, 4])
  })
})

test('그사이 정말 바뀐 글이면 거절되고, 거절은 개정 기억을 앞세우지 않는다', async () => {
  // 저장이 알려 준 개정을 기억하는 것은 **우리가 방금 만든 개정**뿐이다. 그사이 도우미가 정말
  // 고쳤으면 정본이 더 앞서 있어 sidecar 의 `!=` 대조가 그대로 거절해야 한다 — 이 시험은 그
  // 보호가 약해지지 않았음을 잠근다(`methods_edit.py` `_commit`).
  let server = 3
  const sent: number[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits') return { result: { edits: [], notices: [] } }
    if (method !== 'section.edit' && method !== 'section.edit_batch') return { result: null }
    const expected = p.expected_revision as number
    sent.push(expected)
    if (expected !== server) return { error: { code: 'stale_view', message: '그사이 글이 바뀌었어요. 다시 골라 주세요.' } }
    server += 1
    return { result: editResult(server) }
  } } }
  await withWindow(model, async () => {
    useEdits.getState().reset()
    const one = await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 3, before_block: '가', after_block: '나'
    })
    expect(one.ok).toBe(true)   // 3 -> 4

    // 그사이 도우미가 두 번 고쳤다 — 정본은 6, 화면은 아직 3 이다.
    server = 6
    const refused = await useEdits.getState().save('/A', {
      kind: 'batch', expected_revision: 3, edits: [{ section_id: 'sec-02', before_block: '다', after_block: '라' }]
    })
    expect(refused).toMatchObject({ ok: false, code: 'stale_view' })
    // 기억은 4 그대로다 — 거절이 기억을 7 같은 값으로 올려 다음 저장을 통과시키지 않는다.
    await useEdits.getState().save('/A', {
      kind: 'batch', expected_revision: 3, edits: [{ section_id: 'sec-02', before_block: '다', after_block: '라' }]
    })
    expect(sent).toEqual([3, 4, 4])
  })
})

test('다른 논문으로 바꾸면 앞 논문의 개정 기억을 들고 가지 않는다', async () => {
  // 개정 번호는 논문마다 따로 센다. 앞 논문에서 기억한 4 를 새 논문에 쓰면 그 저장은 이유 없이
  // `stale_view` 로 거절된다 — 그 화면에는 "그사이 글이 바뀌었어요"만 뜬다.
  const sent: { root: string; revision: number }[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits') return { result: { edits: [], notices: [] } }
    if (method !== 'section.edit') return { result: null }
    sent.push({ root: String(p.root), revision: p.expected_revision as number })
    return { result: editResult((p.expected_revision as number) + 1) }
  } } }
  await withWindow(model, async () => {
    useEdits.getState().reset()
    await useEdits.getState().save('/A', { kind: 'one', id: 'sec-01', expected_revision: 3, before_block: '가', after_block: '나' })
    await useEdits.getState().save('/B', { kind: 'one', id: 'sec-01', expected_revision: 3, before_block: '가', after_block: '나' })
    expect(sent).toEqual([{ root: '/A', revision: 3 }, { root: '/B', revision: 3 }])
  })
})

test('같은 장을 연달아 고치면 옛 지문이 아니라 앞 저장이 알려 준 지문으로 나간다', async () => {
  // 개정 대조를 통과해도 지문 대조가 따로 있다(`methods_edit.py:356` `_Manuscript`). 절 목록의
  // `draft_hash` 도 읽기 응답이 돌아와야 오르므로, 방금 저장한 장을 그 사이 또 고치면 옛 지문으로
  // 나가 똑같이 `stale_view` 가 된다. 지문은 **우리 저장이 만든 개정**의 것이므로 그대로 쓴다.
  const sent: { revision: number; hash: unknown }[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits') return { result: { edits: [], notices: [] } }
    if (method !== 'section.edit') return { result: null }
    sent.push({ revision: p.expected_revision as number, hash: p.expected_draft_hash })
    return { result: { ...editResult((p.expected_revision as number) + 1), draft_hash: `h${sent.length}` } }
  } } }
  await withWindow(model, async () => {
    useEdits.getState().reset()
    // 화면: 개정 3, 이 장의 지문 `h0`.
    await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 3, expected_draft_hash: 'h0', before_block: '가', after_block: '나'
    })
    // 새로 읽지 않은 채 같은 장을 또 고친다 — 화면은 여전히 개정 3, 지문 `h0`.
    await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 3, expected_draft_hash: 'h0', before_block: '나', after_block: '다'
    })
    expect(sent).toEqual([{ revision: 3, hash: 'h0' }, { revision: 4, hash: 'h1' }])
  })
})

test('그사이 남이 그 장을 다시 썼으면 우리 지문을 쓰지 않는다', async () => {
  // 화면이 든 개정이 우리가 기억한 개정보다 **앞서면** 그 장은 그사이 다시 쓰인 것이다 — 그때
  // 기억한 지문을 계속 쓰면 남의 글을 우리 지문으로 덮으려 든다. 화면 것을 그대로 넘겨 sidecar
  // 가 지문 대조로 거절하게 둔다.
  const sent: { revision: number; hash: unknown }[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits') return { result: { edits: [], notices: [] } }
    if (method !== 'section.edit') return { result: null }
    sent.push({ revision: p.expected_revision as number, hash: p.expected_draft_hash })
    return { result: { ...editResult((p.expected_revision as number) + 1), draft_hash: 'h1' } }
  } } }
  await withWindow(model, async () => {
    useEdits.getState().reset()
    await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 3, expected_draft_hash: 'h0', before_block: '가', after_block: '나'
    })
    // 화면이 다시 읽어 왔다 — 개정 9, 그 장의 지문 `hX`(남이 쓴 글).
    await useEdits.getState().save('/A', {
      kind: 'one', id: 'sec-01', expected_revision: 9, expected_draft_hash: 'hX', before_block: '마', after_block: '바'
    })
    expect(sent[1]).toEqual({ revision: 9, hash: 'hX' })
  })
})

// ── 고침1: 턴 단위 answered · uncertain → pending · 유실 행은 화면에서만 닫기 ─────

test('고침1 — 메모 실린 턴이 실패하면 그 건은 pending 으로 돌아오고 다음 턴이 정상 끝나도 answered 가 아니다', async () => {
  const marks: { ids: string[]; state: string; turn: boolean }[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits_mark') marks.push({ ids: (p.edit_ids as string[]) ?? [], state: String(p.state), turn: p.turn_done === true })
    return { result: null }
  } } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending')] as never })
    const plan = useEdits.getState().attach('메모 턴')
    const turnA = 'turn-A'
    await useEdits.getState().markSent('/A', plan, turnA)
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent'])

    // 그 턴이 실패로 끝났다 → 그 turn 에 묶인 건만 되돌린다.
    await useEdits.getState().turnFailed('/A', turnA)
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['pending'])
    expect(marks.at(-1)).toEqual({ ids: ['e1'], state: 'pending', turn: false })

    // 다음 턴이 정상으로 끝나도 **이 건은 닫히지 않는다** — 그 턴에 메모가 실리지 않았다.
    await useEdits.getState().markTurnDone('/A', 'turn-B')
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([false])
  })
})

test('고침1 — 정상으로 끝난 그 턴에만 answered 가 켜진다', async () => {
  const model = { knuaf: { call: async () => ({ result: null }) } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending'), editRow('e2', 'pending')] as never })
    // A 턴에는 e1 만 메모에 실린다(둘 다 pending 이지만 e2 는 그 뒤에 저장된 것으로 둔다).
    const planA = { ids: ['e1'], marks: ['e1'], localOnly: [], memo: null }
    await useEdits.getState().markSent('/A', planA, 'turn-A')
    const planB = { ids: ['e2'], marks: ['e2'], localOnly: [], memo: null }
    await useEdits.getState().markSent('/A', planB, 'turn-B')
    // A 턴이 정상 종료 → e1 만 answered.
    await useEdits.getState().markTurnDone('/A', 'turn-A')
    expect(useEdits.getState().rows.map((r) => [r.edit_id, r.answered])).toEqual([['e1', true], ['e2', false]])
    // B 턴이 정상 종료 → e2 answered.
    await useEdits.getState().markTurnDone('/A', 'turn-B')
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([true, true])
  })
})

test('고침1 — 전달이 uncertain 이면 sent 로 닫지 않고 pending 그대로 둔다 (§6-3)', async () => {
  const model = { knuaf: { call: async () => ({ result: null }) } }
  await withWindow(model, async () => {
    useEdits.setState({ rows: [editRow('e1', 'pending')] as never })
    const plan = useEdits.getState().attach('불확실')
    await useEdits.getState().markSent('/A', plan, 'turn-A', 'uncertain')
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['pending'])
  })
})

test('고침1 — 유실 행은 서버로 안 보내고 화면에서만 닫으며, 다시 읽어도 같은 세션에 되살아나지 않는다', async () => {
  const lost: never = { ...editRow('app:student-edit:sec-02:xyz', 'pending'), edits: [], section_ids: ['sec-02'], lost_record: true } as never
  const marks: string[][] = []
  const calls: string[] = []
  const model = { knuaf: { call: async (method: string, p: Record<string, unknown>) => {
    if (method === 'section.edits_mark') { marks.push((p.edit_ids as string[]) ?? []); calls.push(String(p.state)) }
    // `section.edits` 는 서버 상태대로 유실 행 + 정상 행을 계속 돌려준다(원장에 유실 행이 없다).
    // `edits_mark` 가 오면 서버 상태가 바뀐 것처럼 다음 읽기에 반영한다(실제 원장 동작).
    if (method === 'section.edits') {
      const e1State = marks.flat().includes('e1') && calls.some((c) => c === 'sent') ? 'sent' : 'pending'
      return { result: { edits: [lost, editRow('e1', e1State)], notices: [] } }
    }
    return { result: null }
  } } }
  await withWindow(model, async () => {
    await useEdits.getState().load('/A')
    const plan = useEdits.getState().attach('유실 + 정상')
    expect(plan.ids).toHaveLength(2)
    await useEdits.getState().markSent('/A', plan, 'turn-A')
    // 서버에는 정상 건만 — 유실 id 를 섞으면 `not_found` 로 호출 전체가 거절된다.
    expect(marks).toEqual([['e1']])
    // 화면에서는 둘 다 닫힌다 — 유실 행을 그대로 두면 매 메시지에 같은 메모가 되풀이된다.
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent', 'sent'])

    // 같은 세션에서 다시 읽어도 유실 행은 되살아나지 않는다(이번 세션에 이미 메모에 실었다).
    await useEdits.getState().load('/A')
    expect(useEdits.getState().rows.map((r) => [r.edit_id, r.state])).toEqual([['app:student-edit:sec-02:xyz', 'sent'], ['e1', 'sent']])
  })
})

// ── 중요 1(2회째): onSnapshot 배선을 지나는 턴 종료 처리 ─────────────────────

/** `onSnapshot` 이 읽는 필드만 갖춘 스냅샷. */
function snap(root: string, state: 'idle' | 'running' | 'permission' | 'error' | 'stopped' | 'interrupted', turn?: string, delivery?: 'sent' | 'uncertain') {
  return {
    root, provider: 'codex' as const, state,
    messages: turn ? [{ id: turn, role: 'user' as const, text: '보낸 글', at: '2026-11-11T00:00:00+00:00', delivery }] : []
  }
}

/** `void` 로 띄운 저장 작업이 끝날 때까지 한 바퀴 돌린다. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('중요1(배선) — running→idle 이면 그 턴에 묶인 건이 answered 가 된다', async () => {
  const model = { knuaf: { call: async () => ({ result: null }) } }
  await withWindow(model, async () => {
    const { useChat } = await import('../src/renderer/src/store/chat')
    useChat.setState({ root: '/A', snapshot: undefined as never })
    useEdits.getState().reset()
    useEdits.setState({ rows: [editRow('e1', 'pending')], root: '/A' } as never)
    await useEdits.getState().markSent('/A', useEdits.getState().attach(''), 'turn-A')
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['sent'])

    // 진행 중 → 정상 종료. 배선이 살아 있어야 여기서 answered 가 켜진다.
    useChat.getState().onSnapshot(snap('/A', 'running', 'turn-A', 'sent') as never)
    useChat.getState().onSnapshot(snap('/A', 'idle', 'turn-A', 'sent') as never)
    await flush()
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([true])
  })
})

test('중요1(배선) — running→error 면 그 건이 pending 으로 돌아와 다음 메시지에 다시 붙는다', async () => {
  const model = { knuaf: { call: async () => ({ result: null }) } }
  await withWindow(model, async () => {
    const { useChat } = await import('../src/renderer/src/store/chat')
    useChat.setState({ root: '/A', snapshot: undefined as never })
    useEdits.getState().reset()
    useEdits.setState({ rows: [editRow('e1', 'pending')], root: '/A' } as never)
    await useEdits.getState().markSent('/A', useEdits.getState().attach(''), 'turn-A')

    useChat.getState().onSnapshot(snap('/A', 'running', 'turn-A', 'sent') as never)
    useChat.getState().onSnapshot(snap('/A', 'error', 'turn-A', 'sent') as never)
    await flush()
    expect(useEdits.getState().rows.map((r) => r.state)).toEqual(['pending'])
    expect(useEdits.getState().rows.map((r) => r.answered)).toEqual([false])
    // 다음 메시지에 다시 실린다.
    expect(useEdits.getState().attach('다시').ids).toEqual(['e1'])
  })
})

/**
 * 이 파일은 `useProject.loadSections()` 를 직접 불러 **모듈 변수** `sectionHashes`(절마다 직전에 본
 * 지문)를 채운다. 그 값은 폴더를 열 때만(`store/project.ts:470`) 비워지므로, 같은 워커에서 이어
 * 도는 다음 파일(`paper-events.spec.ts`)이 '앱 켠 직후 첫 읽기'를 기대하면 이미 있던 절이
 * '도우미가 바꾼 절'로 보인다(맥 CI 1 failed). 상태만 `setState` 해서는 그 변수에 닿지 않으므로,
 * 실제 폴더 전환과 **같은 길**(`open()`)로 되돌린다.
 */
test.afterAll(async () => {
  /**
   * Node 에는 `window`·`location` 이 없다. 있는지만 되돌리면 값이 `undefined` 로 남아
   * `typeof window` 검사가 통과하고 `window.knuaf` 가 다른 오류를 낸다 — 원래 없던 것은 지운다.
   */
  const had = { window: 'window' in globalThis, location: 'location' in globalThis }
  const holder = globalThis as { window?: unknown; location?: unknown }
  const oldWindow = holder.window, oldLocation = holder.location
  // `open()` 이 부르는 것만 답하는 최소 모형 — 준비(`deps.doctor`)는 실패해도 스스로 삼킨다.
  const model = {
    knuaf: {
      openProject: async () => ({ result: { hasProject: false, sidecar: { python: '/bundled/python', kind: 'bundled' } } }),
      peekProject: async () => ({ hasProject: false }),
      getSettings: async () => ({}),
      sidecarInfo: async () => ({ python: '/bundled/python', kind: 'bundled', running: false }),
      call: async () => ({ result: null }),
      depsEnsure: async () => ({ result: { ok: true } }),
      cancel: async () => false,
      chat: {
        snapshot: async () => ({ result: { messages: [], state: 'idle', provider: 'codex' } }),
        status: async () => ({ result: { connected: false, installed: false } }),
        draft: async () => ({ result: '' })
      }
    }
  }
  // `closeSheet()` 이 `location.hash` 를 쓴다(Node 에는 `location` 이 없다).
  Object.assign(globalThis, { window: model, location: { hash: '' } })
  try {
    await useProject.getState().open('/edits-store/reset', { local: true })
  } finally {
    // `open()` 이 건 2초 정본 감시 타이머는 폴더가 없을 때만 서므로, 여기서 끈다.
    useProject.setState({ root: null, sections: null, events: [] })
    await useProject.getState().watchCanon()
    if (had.window) holder.window = oldWindow
    else delete holder.window
    if (had.location) holder.location = oldLocation
    else delete holder.location
  }
})
