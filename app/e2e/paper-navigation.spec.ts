import { expect, test } from '@playwright/test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { parseQuestion } from '../src/shared/question'
import type { Zone } from '../src/shared/zone'
import type { SectionRow } from '../src/shared/types'
import { useProject } from '../src/renderer/src/store/project'
import { closesPaperOverlay, firstVisibleFocus, foldedQuestionTarget, questionSection } from '../src/renderer/src/components/paperNavigation'
import { PAPER_PANE_COPY } from '../src/renderer/src/copy-paper'

const section = (id: string, title: string, order: number): SectionRow => ({ id, title, order, path: id, status: 'empty', revision: 1, draft_hash: '', draft_hash_ok: true, claims: 0 })
const question = (text: string): Zone => {
  const card = parseQuestion(text)
  if (!card) throw new Error('question fixture did not parse')
  return { kind: 'question', card, messageId: 'q' }
}

test('질문 제목의 장을 제목 접두어 우선으로 찾고 미등록 장은 찾지 않는다', () => {
  const rows = [section('finance', 'Ⅳ. 재무 계획', 1), section('intro', 'Ⅰ. 개요', 4)]
  const zone = question('Ⅲ장 작성을 마쳤어요.\n\n[Q4-1] IV장에 쓰여요\n\n어느 쪽인가요?\n\n1) 하나\n2) 둘')
  expect(questionSection(zone, rows)?.id).toBe('finance')
  expect(questionSection(question('[Q4-1] IV장에 쓰여요\n\n어느 쪽인가요?\n\n1) 하나\n2) 둘'), [section('fallback', '재무 계획', 4)])?.id).toBe('fallback')
  expect(questionSection(zone, [section('other', 'Ⅲ. 개요', 3)])).toBeNull()
  expect(questionSection({ kind: 'composer' }, rows)).toBeNull()
})

test('접힌 칸에 새 질문이 나타나면 그 등록 장을 펼침 스크롤 대상으로 남긴다', () => {
  const zone = question('[Q4-1] IV장에 쓰여요\n\n어느 쪽인가요?\n\n1) 하나\n2) 둘')
  const rows = [section('target', 'Ⅳ. 재무 계획', 1), section('other', 'Ⅰ. 개요', 4)]
  const target = foldedQuestionTarget(zone, rows, '/paper', true, null)
  expect(target.sectionId).toBe('target')
  useProject.setState({ focusedSection: null, paperClosed: true, foldNotice: false })
  useProject.getState().setFoldNotice()
  useProject.getState().focusSection(target.sectionId)
  expect(useProject.getState()).toMatchObject({ focusedSection: 'target', foldNotice: true, paperClosed: true })
  expect(foldedQuestionTarget(zone, rows, '/paper', true, target.key).sectionId).toBeNull()
  expect(foldedQuestionTarget(zone, [], '/paper', true, null).sectionId).toBeNull()
  useProject.setState({ focusedSection: null, paperClosed: false, foldNotice: false })
})

test('점검·설정에서 자료·파일 목록을 열면 화면을 닫고 선택한 목록으로 이동한다', async () => {
  const previous = globalThis.location
  const oldWindow = globalThis.window
  Object.assign(globalThis, { location: { hash: '#settings' }, window: { knuaf: { setSettings: async () => {}, getSettings: async () => ({ ui_prefs: {} }) } } })
  try {
    for (const width of [900, 1400]) for (const sheet of ['settings', 'checkup'] as const) for (const kind of ['materials', 'files'] as const) {
      useProject.setState({ root: '/paper', sections: [], windowWidth: width, sheet, settingsFocus: 'tools:excel', paperClosed: true, paneTab: 'file', paneView: 'chat' })
      useProject.getState().openList(kind)
      await nextTurn()
      expect(useProject.getState()).toMatchObject({ sheet: null, settingsFocus: null, paperClosed: false, paneTab: 'paper', paneView: 'paper', paneHold: true, listIntent: { kind } })
      expect(globalThis.location.hash).toBe('')
    }
  } finally { Object.assign(globalThis, { location: previous, window: oldWindow }); useProject.setState({ root: null, sheet: null, listIntent: null, paneHold: false }) }
})

test('파일 탭을 보관한 종이 점검의 Escape는 점검만 닫는다', () => {
  const previous = globalThis.location
  Object.assign(globalThis, { location: { hash: '#checkup' } })
  try {
    useProject.setState({ root: '/paper', docPath: '/paper/a.pdf', paneTab: 'paper', sheet: 'checkup' })
    const state = useProject.getState()
    expect(closesPaperOverlay('Escape', state.sheet, state.paneTab)).toBe(true)
    if (closesPaperOverlay('Escape', state.sheet, state.paneTab)) state.closeSheet()
    expect(useProject.getState()).toMatchObject({ sheet: null, docPath: '/paper/a.pdf' })
    expect(closesPaperOverlay('Escape', 'checkup', 'file')).toBe(false)
    expect(closesPaperOverlay('Enter', 'checkup', 'paper')).toBe(false)
  } finally { Object.assign(globalThis, { location: previous }); useProject.setState({ root: null, sheet: null, docPath: null }) }
})

test('초점 복귀 후보에서 숨김·분리된 요소를 건너뛴다', () => {
  const hidden = { isConnected: true, offsetParent: null } as HTMLElement
  const detached = { isConnected: false, offsetParent: {} } as unknown as HTMLElement
  const visible = { isConnected: true, offsetParent: {} } as unknown as HTMLElement
  expect(firstVisibleFocus([hidden, detached, visible])).toBe(visible)
  expect(firstVisibleFocus([hidden, detached])).toBeNull()
})

test('파일 종류는 확장자에 따라 읽기 전용 미리보기로 표시한다', () => {
  expect(PAPER_PANE_COPY.fileType('/paper/a.DOCX')).toBe('워드')
  expect(PAPER_PANE_COPY.fileType('/paper/a.xlsx')).toBe('엑셀')
  expect(PAPER_PANE_COPY.fileType('/paper/a.pdf')).toBe('PDF')
  expect(PAPER_PANE_COPY.fileType('/paper/a.png')).toBe('그림')
  expect(PAPER_PANE_COPY.readOnly).toBe('읽기 전용 미리보기')
})
