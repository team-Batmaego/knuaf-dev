/**
 * v0-6-8 A4 — 장 0개 + 학교 차례 없음 전공의 제목줄 안내 (CONTRACT-A4 §2).
 *
 * 두 가지만 잠근다:
 *  1) 판정 함수(`shared/outline.ts`) — `no_school_toc` 이고 장이 0개일 때만 문구가 바뀐다.
 *     그 밖(`unsupported`·`not_bound`·`seeded`·`existing_manuscript`·`outline_conflict`·오류·
 *     목록을 못 읽은 `null`)은 지금 문구 그대로다.
 *  2) 스토어(`store/project.ts`) — `project.outline` 은 **장이 0개일 때만** 부르고, 실패·늦은 응답은
 *     '모른다'(null)로 접으며, 다른 폴더로 바뀐 뒤 도착한 판정은 버린다.
 *
 * 화면 없이 돈다(`playwright.node.config.ts`, `layout.spec.ts`·`edits-store.spec.ts` 방식).
 */
import { expect, test } from '@playwright/test'
import { outlineStateOf, titlebarNoteOf, type OutlineState } from '../src/shared/outline'
import { TITLEBAR } from '../src/renderer/src/copy'
import { useProject } from '../src/renderer/src/store/project'

/** 사이드카가 돌려주는 모양(CONTRACT-A4 §1) — 상태 이름만 바꿔 가며 쓴다. */
function outline(state: string, extra: Partial<OutlineState> = {}): OutlineState {
  return {
    state: state as OutlineState['state'], major_id: 'major-x', profile_id: 'profile-x', sections: 0, reason: null, ...extra
  }
}

/** 등록된 장 한 줄(`project.sections` 응답 항목). */
function sectionRow(id: string) {
  return {
    id, title: `장 ${id}`, order: 1, path: `sections/${id}.md`, status: 'drafting', revision: 1,
    draft_hash: `hash-${id}`, draft_hash_ok: true, claims: null
  }
}

// ── 판정 함수 ─────────────────────────────────────────────────────────────

test('장 0개 + no_school_toc 일 때만 문구가 바뀐다', () => {
  expect(titlebarNoteOf(0, outline('no_school_toc'))).toBe('noSchoolToc')
})

test('장이 하나라도 있으면 학교 차례 상태와 무관하게 지금 문구다', () => {
  for (const n of [1, 3, 12]) expect(titlebarNoteOf(n, outline('no_school_toc'))).toBe('paperLater')
})

test('그 밖의 상태는 지금 문구 그대로다', () => {
  // `unsupported` = 옛 규칙집 판(모듈 없음), `not_bound` = 전공 미확정. 둘 다 "차례가 없다"가 아니다.
  for (const state of ['unsupported', 'not_bound', 'seeded', 'existing_manuscript', 'outline_conflict']) {
    expect(titlebarNoteOf(0, outline(state))).toBe('paperLater')
  }
})

test('상태를 모르면(읽기 실패·아직 안 읽음) 지금 문구다', () => {
  expect(titlebarNoteOf(0, null)).toBe('paperLater')
  // 목록을 못 읽은 것(null)은 "장이 0개"가 아니라 "모른다"다 — 없는 사실을 말하지 않는다.
  expect(titlebarNoteOf(null, outline('no_school_toc'))).toBe('paperLater')
})

test('문구는 copy 한 곳에 있고 서로 다르다', () => {
  expect(TITLEBAR[titlebarNoteOf(0, outline('no_school_toc'))]).toBe(TITLEBAR.noSchoolToc)
  expect(TITLEBAR.noSchoolToc).not.toBe(TITLEBAR.paperLater)
  expect(TITLEBAR.noSchoolToc).toContain('정해진 학교 차례가 없어요')
})

test('모르는 상태·손상된 응답은 null 로 접는다', () => {
  expect(outlineStateOf({ state: 'brand_new_state' })).toBeNull()
  expect(outlineStateOf({})).toBeNull()
  expect(outlineStateOf(null)).toBeNull()
  expect(outlineStateOf('no_school_toc')).toBeNull()
  // 새 규칙집 판이 필드를 더해도 앱이 사실을 지어내지 않게 빠진 값은 null·0 으로 채운다.
  expect(outlineStateOf({ state: 'no_school_toc' })).toEqual({
    state: 'no_school_toc', major_id: null, profile_id: null, sections: 0, reason: null
  })
})

// ── 스토어 ─────────────────────────────────────────────────────────────────

/** `window.knuaf` 를 메모리 모형으로 바꾸고, 끝나면 되돌린다(`edits-store.spec.ts` 와 같은 방식). */
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

/** 매 호출을 기록하고, `project.sections`·`project.outline`·`section.read_all` 만 응답하는 RPC 모형. */
function rpcModel(script: {
  calls?: string[]
  sections?: (root: string) => Promise<unknown> | unknown
  outline?: (root: string) => Promise<unknown> | unknown
}) {
  const calls = script.calls ?? []
  return {
    knuaf: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push(`${method}:${String(params.root ?? '')}`)
        const root = String(params.root ?? '')
        if (method === 'project.sections' && script.sections) return { result: await script.sections(root) }
        if (method === 'project.outline' && script.outline) return { result: await script.outline(root) }
        if (method === 'section.read_all') return { result: [] }
        return { result: null }
      }
    },
    calls
  }
}

/** 조건이 참이 될 때까지 한 틱씩 기다린다(늦은 응답 순서를 시험에서 정할 때만 쓴다). */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 1)
  return promise
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await tick()
  if (!condition()) throw new Error('조건이 시간 안에 참이 되지 않았다')
}

test.beforeEach(() => {
  useProject.setState({ root: null, sections: null, outline: null, error: null })
})

test('장이 0개면 project.outline 을 묻고 판정을 담는다', async () => {
  const model = rpcModel({ sections: () => [], outline: () => outline('no_school_toc') })
  await withWindow(model, async () => {
    useProject.setState({ root: '/A' })
    await useProject.getState().loadSections()
    expect(model.calls).toContain('project.outline:/A')
    const state = useProject.getState()
    expect(state.outline?.state).toBe('no_school_toc')
    expect(titlebarNoteOf(state.sections?.length ?? null, state.outline)).toBe('noSchoolToc')
  })
})

test('장이 있으면 project.outline 을 묻지 않고 옛 판정을 지운다', async () => {
  const model = rpcModel({
    sections: () => [sectionRow('sec-01')],
    outline: () => outline('no_school_toc')
  })
  await withWindow(model, async () => {
    // 앞선 폴더의 판정이 남아 있는 상태에서 시작한다.
    useProject.setState({ root: '/A', outline: outline('no_school_toc') })
    await useProject.getState().loadSections()
    expect(model.calls.filter((c) => c.startsWith('project.outline'))).toEqual([])
    expect(useProject.getState().sections).toHaveLength(1)
    expect(useProject.getState().outline).toBeNull()
  })
})

test('outline 조회 실패는 오류가 아니라 "모른다"다', async () => {
  const model = rpcModel({
    sections: () => [],
    // 사이드카가 아직 `project.outline` 을 모르는 경우(옛 실행기)와 같은 꼴.
    outline: () => { throw new Error('not_found') }
  })
  await withWindow(model, async () => {
    useProject.setState({ root: '/A' })
    await useProject.getState().loadSections()
    expect(useProject.getState().sections).toEqual([])
    expect(useProject.getState().outline).toBeNull()
    expect(useProject.getState().error).toBeNull()
  })
})

test('모르는 상태가 오면 판정하지 않는다', async () => {
  const model = rpcModel({ sections: () => [], outline: () => ({ state: 'brand_new_state' }) })
  await withWindow(model, async () => {
    useProject.setState({ root: '/A' })
    await useProject.getState().loadSections()
    expect(useProject.getState().outline).toBeNull()
    expect(titlebarNoteOf(0, useProject.getState().outline)).toBe('paperLater')
  })
})

test('장 목록을 못 읽으면 null 이고 판정하지 않는다', async () => {
  const model = rpcModel({
    sections: () => { throw new Error('sidecar_down') },
    outline: () => outline('no_school_toc')
  })
  await withWindow(model, async () => {
    useProject.setState({ root: '/A' })
    await useProject.getState().loadSections()
    expect(useProject.getState().sections).toBeNull()
    expect(useProject.getState().outline).toBeNull()
    expect(model.calls.filter((c) => c.startsWith('project.outline'))).toEqual([])
  })
})

test('다른 폴더로 바뀐 뒤 늦게 온 판정은 버린다', async () => {
  const slow = Promise.withResolvers<unknown>()
  const model = rpcModel({
    sections: () => [],
    // A 의 outline 은 늦게 온다 — 그사이 폴더가 B 로 바뀐다.
    outline: (root) => root === '/A' ? slow.promise : outline('seeded')
  })
  await withWindow(model, async () => {
    useProject.setState({ root: '/A' })
    const first = useProject.getState().loadSections()
    await until(() => model.calls.includes('project.outline:/A'))
    useProject.setState({ root: '/B' })
    await useProject.getState().loadSections()
    slow.resolve(outline('no_school_toc'))
    await first
    // B 의 판정이 남아야 한다 — A 의 `no_school_toc` 이 제목줄을 덮으면 안 된다.
    expect(useProject.getState().outline?.state).toBe('seeded')
    expect(titlebarNoteOf(useProject.getState().sections?.length ?? null, useProject.getState().outline)).toBe('paperLater')
  })
})
