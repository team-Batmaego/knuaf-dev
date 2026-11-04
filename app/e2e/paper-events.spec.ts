import { expect, test } from '@playwright/test'
import { useProject } from '../src/renderer/src/store/project'
import { useReview } from '../src/renderer/src/store/review'
import { rpc } from '../src/renderer/src/rpc'
import type { SectionRow } from '../src/shared/types'
import { hasPaneOf } from '../src/renderer/src/components/useLayout'

test('저장 사건은 본문 확인과 noteSeen 완료 뒤 결과를 고정한다', async () => {
  const oldSections = rpc.sections, oldRead = rpc.readAllSections
  const oldNote = useReview.getState().noteSeen, oldEdit = useReview.getState().editOf
  const row: SectionRow = { id: 'sec', title: '첫 장', order: 1, path: 'sec.md', status: 'drafting', revision: 1, draft_hash: 'a', draft_hash_ok: true, draft_chars: 1, claims: 0 }
  let current = { ...row }
  let hold = false
  const gate = Promise.withResolvers<void>()
  const calls: string[] = []
  rpc.sections = async () => [current]
  rpc.readAllSections = async () => [{ id: 'sec', title: '첫 장', path: 'sec.md', draft: current.draft_hash }]
  useReview.setState({
    noteSeen: async (_root, _id, doc) => { calls.push(`start:${doc.hash}`); if (hold) await gate.promise; calls.push(`end:${doc.hash}`) },
    editOf: (_root, _id, hash) => { calls.push(`edit:${hash}`); return { kind: 'edited', count: 2 } }
  })
  useProject.setState({ root: '/paper', events: [], sections: null, paperClosed: false })
  try {
    await useProject.getState().loadSections()
    current = { ...row, revision: 2, draft_hash: 'b' }; hold = true
    const loading = useProject.getState().loadSections()
    await expect.poll(() => calls.includes('start:b')).toBe(true)
    expect(useProject.getState().events).toEqual([])
    gate.resolve()
    await loading
    expect(calls.slice(-3)).toEqual(['start:b', 'end:b', 'edit:b'])
    expect(useProject.getState().events[0]).toMatchObject({ id: 'sec:2', edit: { kind: 'edited', count: 2 } })
    useReview.setState({ editOf: () => ({ kind: 'wrote' }) })
    expect(useProject.getState().events[0].edit).toEqual({ kind: 'edited', count: 2 })
    current = { ...row, revision: 3, draft_hash: 'a' }; hold = false
    await useProject.getState().loadSections()
    expect(useProject.getState().events.map((event) => [event.id, event.edit])).toEqual([
      ['sec:2', { kind: 'edited', count: 2 }],
      ['sec:3', { kind: 'wrote' }]
    ])
    const delayed = Promise.withResolvers<SectionRow[]>()
    rpc.sections = () => delayed.promise
    const older = useProject.getState().loadSections()
    rpc.sections = async () => [{ ...row, revision: 4, draft_hash: 'c' }]
    await useProject.getState().loadSections()
    delayed.resolve([{ ...row, revision: 3, draft_hash: 'a' }])
    await older
    expect(useProject.getState().sections?.[0].revision).toBe(4)
  } finally {
    rpc.sections = oldSections; rpc.readAllSections = oldRead
    useReview.setState({ noteSeen: oldNote, editOf: oldEdit })
    useProject.setState({ root: null, sections: null, events: [] })
  }
})

test('등록 장 또는 paneHold가 있으면 본문 유무와 관계없이 칸이 있다', () => {
  const section = { id: 'empty', draft_chars: 0 } as SectionRow
  expect(hasPaneOf([], false)).toBe(false)
  expect(hasPaneOf([], true)).toBe(true)
  expect(hasPaneOf([section], false)).toBe(true)
})

test('장 없는 논문에서 문서와 목록을 열면 칸을 세우고 문서 닫기는 대화로 돌아간다', () => {
  useProject.setState({ root: '/paper', sections: [], paperClosed: false, paneHold: false, paneView: 'chat', docPath: null, paneTab: 'paper' })
  try {
    useProject.getState().openPreview('/paper/a.pdf')
    expect(useProject.getState()).toMatchObject({ paneHold: true, paneView: 'paper', paneTab: 'file', docPath: '/paper/a.pdf' })
    useProject.getState().setPaneTab('paper')
    useProject.getState().setPaneTab('file')
    expect(useProject.getState().docPath).toBe('/paper/a.pdf')
    useProject.getState().closePreview()
    expect(useProject.getState()).toMatchObject({ paneHold: false, paneView: 'chat', paneTab: 'paper', docPath: null })
    useProject.getState().openList('materials')
    const intent = useProject.getState().listIntent!
    expect(useProject.getState()).toMatchObject({ paneHold: true, paneView: 'paper', paneTab: 'paper', listIntent: { kind: 'materials' } })
    useProject.getState().consumeListIntent(intent.seq - 1)
    expect(useProject.getState().listIntent).toEqual(intent)
    useProject.getState().consumeListIntent(intent.seq)
    expect(useProject.getState().listIntent).toBeNull()
  } finally {
    useProject.setState({ root: null, sections: null, paneHold: false, listIntent: null, docPath: null })
  }
})
