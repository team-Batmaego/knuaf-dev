import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow } from './Popover'
import { MakeFeedbackLine, MakeRunningLine } from './FilesPopover'
import { MaterialsList } from './MaterialsList'
import { ArtifactsList } from './ArtifactsList'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { rpc } from '../rpc'
import { renderMarkdown } from '../markdown'
import { useMake, type MakeKind } from './useMake'
import { useStage } from './useStage'
import { newBlockIndexes, splitBlocks } from '../../../shared/paper'
import { fileStateOf, isReviewExport } from '../../../shared/files'
import { zoneOf } from '../../../shared/zone'
import { hasChange } from '../../../shared/diff'
import { baselineKey, quoteOf, useReview } from '../store/review'
import { ReviewSelectBar, type EditBlock } from './ReviewSelectBar'
import { PaperEditSlot } from './PaperEditSlot'
import { StudentEditsList } from './StudentEditsList'
import { SameWordLine, flashWord } from './SameWordLine'
import { EDIT } from '../editcopy'
import { useEdits, editsOfSection } from '../store/edits'
import { locateSelection, replaceInBlock, type SelectionInput } from '../../../shared/edit'
import { sameWordSuggestions, type BatchEdit, type Place, type SectionDraft, type Suggestion } from '../../../shared/sameword'
import { ReviewDiffBlocks } from './ReviewDiff'
import { MATERIALS, PAPER, REVIEW, fileStatusText } from '../copy'
import type { SectionRow } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'
import { joinPath } from '../paths'
import { questionSection } from './paperNavigation'

/** 절 하나의 본문. `hash` 는 정본이 말하는 본문 지문이다. */
type Doc = { title: string; draft: string; hash: string }

/**
 * 종이에서 고른 문장 — 행동 막대가 뜨는 자리와 무엇을 골랐는지.
 * 절 **제목은 담지 않는다**: 인용을 만드는 순간의 절 목록에서 읽는다(검토 MACR2-R1-01 — 제목이
 * 바뀐 뒤 옛 제목이 인용에 붙던 반례).
 */

/**
 * 저장이 끝난 뒤의 본문들 — 고친 절만 새 문단으로 갈아 끼운다(§3-4).
 *
 * 찾기는 '저장된 뒤의 본문'에서 해야 한다: 저장 전 글을 쓰면 방금 고친 자리가 '다른 곳'으로
 * 세어지고, 그 옛 문단이 묶음(`같이 고치기`)에 들어가 sidecar 가 묶음 전체를 거절한다.
 * 고친 문단이 그 글 안에서 한 번으로 특정되지 않으면 바꾸지 않는다 — 그때는 다시 읽기가
 * 정본을 채운다(제안을 만들지 않는 쪽이 안전하다).
 */
function applySavedBlock(
  docs: Record<string, Doc>, sectionId: string, before: string, after: string
): Record<string, Doc> {
  const doc = docs[sectionId]
  if (!doc) return docs
  const at = doc.draft.indexOf(before)
  if (at < 0 || doc.draft.indexOf(before, at + 1) >= 0) return docs
  const draft = doc.draft.slice(0, at) + after + doc.draft.slice(at + before.length)
  return { ...docs, [sectionId]: { ...doc, draft } }
}

type Sel = {
  text: string
  sectionId: string
  x: number
  top: number
  bottom: number
  /** 그 문단 원고 안의 구간 — 편집칸은 여기서 연다(§4-1 2·3). */
  blockIndex: number
  /** 그 `div.blk` 의 전체 글자·선택 앞부분 — `locateSelection` 의 입력(§4-1). */
  renderedBlock: string
  renderedBefore: string
}

/** 새로 저장된 문단을 칠해 두는 시간. 저장하지 않는다(IMPL-PLAN §4-2). */
const FRESH_MS = 8_000

/** 장 상태 말 — 숫자로 세지 않는다(DESIGN §2). */
function stateWord(status: string): string {
  if (status === 'empty') return PAPER.stateEmpty
  if (status === 'drafting') return PAPER.stateDraft
  return PAPER.stateDone
}


/**
 * 내 논문 칸 — 저장된 논문을 종이 그대로 보여 준다 (DESIGN §2, 시안 ④~⑦⑩⑭).
 *
 * **저장된 글만** 그린다. 답을 보냈다고 문단을 미리 그리지 않고, 빈 장은 제목만 흐리게
 * 둔다 — 없는 진척을 연출하지 않는다. 방금 저장된 문단만 옅은 파랑으로 잠깐 칠한다.
 *
 * 절 목록은 `project.sections`(등록된 절 그대로)이고 Ⅰ~Ⅶ 고정이 아니다. 본문은 절마다
 * `section.read` 로 읽는다(3-A 합류 뒤 `section.read_all` 한 번으로 줄인다 — 읽는 자리는
 * `load()` 하나뿐이다).
 */
export function PaperPane({ overlay }: { overlay?: ReactNode }) {
  const { root, sections, revision, focusedSection, focusSection, requestQuote, listIntent, consumeListIntent } = useProject(useShallow((s) => ({
    root: s.root, sections: s.sections, revision: s.status?.revision ?? s.peek?.revision ?? null,
    focusedSection: s.focusedSection, focusSection: s.focusSection, requestQuote: s.requestQuote, listIntent: s.listIntent, consumeListIntent: s.consumeListIntent
  })))
  const { snapshot, status } = useChat(useShallow((s) => ({ snapshot: s.snapshot, status: s.status })))
  const pStatus = useProject((s) => s.status)
  const projectLoad = useProject((s) => s.projectLoad)
  const openSheet = useProject((s) => s.openSheet)
  const materials = useProject((s) => s.materials)
  const artifacts = useProject((s) => s.artifacts)
  const artifactsError = useProject((s) => s.artifactsError)
  const hasProject = useProject((s) => s.hasProject)
  const previewNotice = useProject((s) => s.previewNotice)
  const openPreview = useProject((s) => s.openPreview)
  const loadLists = useProject((s) => s.loadLists)
  const insertPath = useChat((s) => s.insertPath)
  const make = useMake()
  const { derived, action } = useStage()
  /** sidecar 가 `section.edit` 을 등록했는가 — 없으면 `직접 수정` 단추를 아예 안 그린다(§8-1). */
  const editRows = useEdits((s) => s.rows)
  const editNotices = useEdits((s) => s.notices)
  const loadEdits = useEdits((s) => s.load)
  const saveEdit = useEdits((s) => s.save)
  const markSeen = useEdits((s) => s.seen)
  const resetEdits = useEdits((s) => s.reset)
  /** 고침 스토어가 지금 가리키는 논문 — 논문이 바뀌면 먼저 비운다(§4-5-8 04). */
  const editsRoot = useEdits((s) => s.root)
  const editAvailable = useEdits((s) => s.available)
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [fresh, setFresh] = useState<Record<string, number[]>>({})
  const [toc, setToc] = useState(false)
  /** 파일 팝오버 — 실행 결과를 어디에 그릴지 정하려고 여기서 소유한다(검토 P3-R1-01). */
  const [filesOpen, setFilesOpen] = useState(false)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  /**
   * 절마다 **직전에 본 본문**. 메모리에만 둔다 — 저장하지 않는다. 그래서 앱을 켠 직후
   * 첫 읽기에는 비교할 것이 없고, 아무것도 칠하지 않는다.
   */
  const prevDocs = useRef<Record<string, Doc>>({})
  /** 늦게 온 읽기가 그사이 바뀐 목록을 되돌리지 않게 하는 기준. */
  const sects = useRef<SectionRow[] | null>(sections)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const desk = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  /** 편집칸이 열려 있는가 — 폴링 재그리기를 잠깐 멈추는 판정(`load` 안에서 본다). */
  const slotRef = useRef<unknown>(null)
  /** 편집 중에 갱신을 건너뛰었는가 — 닫을 때 다시 읽어 따라잡는다(§4-5-8 06). */
  const skippedWhileEditing = useRef(false)
  sects.current = sections
  /** 종이에서 고른 문장 — 행동 막대가 뜰 자리와 무엇을 골랐는지(N-I03). */
  const [sel, setSel] = useState<Sel | null>(null)
  /**
   * 절마다 **이번 실행에서 처음 본 본문** — "고친 부분 보기"의 기준(N-I04). store 에 둔다
   * (검토 QA2B-R1-03): 여기 지역 상태였을 때 종이 칸을 닫았다 열면 컴포넌트가 새로 만들어져
   * 기준이 사라졌다. 논문(root)+절로 키를 잡아 화면 조각의 수명과 분리한다. 정본 폴더에는
   * 쓰지 않는다 — 앱을 다시 켜면 초기화된다.
   */
  const baseline = useReview((s) => s.baseline)
  const noteSeen = useReview((s) => s.noteSeen)
  const showDiff = useReview((s) => s.showDiff)
  const toggleDiff = useReview((s) => s.toggleDiff)
  const setQuote = useReview((s) => s.setQuote)
  const card = zoneOf(snapshot, status, pStatus)
  /** 행동 막대는 아래 칸이 **입력칸**일 때만 — 질문·허락 카드가 그 자리를 차지한다(발주 §③). */
  const canQuote = card.kind !== 'permission' && card.kind !== 'disconnected'

  const load = useCallback(async () => {
    if (!root || !sections) { setDocs({}); return }
    // 편집칸이 열려 있으면 다시 그리지 않는다 — 입력 중인 문단이 사라지면 안 된다(§3-2).
    // 건너뛴 사실을 적어 두고, 편집칸이 닫힐 때 한 번 다시 읽는다(§4-5-8 06).
    if (slotRef.current) { skippedWhileEditing.current = true; return }
    // 3-A 의 `section.read_all` — 등록 순서대로 **한 번에** 읽는다(IMPL-PLAN §4-2 권장).
    // 절마다 `section.read` 를 부르던 자리이고, 읽는 곳은 여기 하나뿐이다.
    let rows: { id: string; title: string; draft: string }[]
    try {
      rows = await rpc.readAllSections(root)
    } catch {
      return   // 못 읽은 절은 이전 모습 그대로 둔다
    }
    const freshNow: Record<string, number[]> = {}
    /** 이번 읽기에서 **본문이 실제로 바뀐** 절이 있었는가 — 종이가 다시 그려진다. */
    let contentChanged = false
    for (const r of rows) {
      const sec = sections.find((s) => s.id === r.id)
      if (!sec) continue
      void noteSeen(root, r.id, { title: r.title, draft: r.draft, hash: sec.draft_hash }).catch(() => {})
      const before = prevDocs.current[r.id]
      // 지문이 같으면 다시 그리지 않는다 — 같은 글이고 칠할 것도 없다.
      if (before && before.hash === sec.draft_hash) continue
      prevDocs.current[r.id] = { title: r.title, draft: r.draft, hash: sec.draft_hash }
      // 처음 보는 절이면 칠하지 않는다(앱을 켠 직후·폴더를 연 직후).
      if (before) {
        contentChanged = true
        const idx = newBlockIndexes(splitBlocks(before.draft), splitBlocks(r.draft))
        if (idx.length) freshNow[r.id] = idx
      }
    }
    if (sects.current !== sections) return
    const next: Record<string, Doc> = {}
    for (const s of sections) { const d = prevDocs.current[s.id]; if (d) next[s.id] = d }
    setDocs(next)
    // 본문이 실제로 바뀌면(저장·절 교체) 종이의 DOM 이 다시 그려진다 — 그때 담아 둔 선택은
    // 더 이상 그 글자가 아니다. 묵은 막대가 엉뚱한 자리에 뜨지 않게 지운다.
    if (contentChanged) setSel(null)
    if (Object.keys(freshNow).length) {
      setFresh(freshNow)
      timers.current.forEach(clearTimeout)
      timers.current = [setTimeout(() => setFresh({}), FRESH_MS)]
    }
  }, [root, sections, noteSeen])

  // 폴더가 바뀌면 직전 본문을 들고 가지 않는다 — 다른 논문에 칠할 것은 없다.
  // 비교 기준(store)은 논문별 키라 건드리지 않는다 — 같은 논문을 다시 열면 이어진다.
  useEffect(() => { prevDocs.current = {}; setDocs({}); setFresh({}); setSel(null); return () => { timers.current.forEach(clearTimeout); timers.current = [] } }, [root])
  // 기록이 오르면 다시 읽는다(사이드바 차례와 같은 기준, IMPL-PLAN §4-2).
  useEffect(() => { void load() }, [load, revision])
  // 고침 목록·복구 알림은 폴더가 열리면 읽고, 폴더가 바뀌면 비운다.
  useEffect(() => {
    if (!root) { resetEdits(); return }
    // 논문이 바뀌면 **먼저 비운다**(§4-5-8 04) — A→B 전환은 root 를 null 로 만들지 않으므로
    // '없음→있음'만 보면 A 의 목록·알림이 B 화면에 남는다. 지금 스토어가 다른 논문 것이면 비운다.
    if (editsRoot !== root) resetEdits()
    void loadEdits(root)
  }, [root, revision, editsRoot, loadEdits, resetEdits])
  useEffect(() => {
    if ((listIntent || filesOpen) && root) void loadLists()
  }, [listIntent, filesOpen, root, loadLists])

  // 대화 이벤트 줄의 "종이에서 보기" — 그 장으로 간다.
  useEffect(() => {
    if (!focusedSection) return
    desk.current?.querySelector(`#sec-${CSS.escape(focusedSection)}`)?.scrollIntoView({ block: 'start' })
    focusSection(null)
  }, [focusedSection, focusSection])

  /**
   * 마우스를 떼면 고른 문장을 읽는다(N-I03). 선택이 **종이 안**이고 **한 장 안**일 때만 담는다 —
   * 어느 장의 문장인지 말할 수 없으면 인용 형식도 만들 수 없다.
   *
   * 아래 칸이 입력칸이 아니어도(**작업 중·질문 카드·허락 카드**) 선택을 **버리지 않는다**.
   * 막대는 그동안 숨기기만 하고(렌더의 `canQuote`), 입력칸이 돌아오면 그 선택 위에 다시 뜬다.
   * 예전에는 그 자리에서 `setSel(null)` 로 버려서 — 맥 CI 처럼 작업이 아직 도는 동안 고르면 —
   * 작업이 끝난 뒤 학생이 **처음부터 다시 골라야** 막대가 떴다(FIX-CI-MAC-R2 실패 1).
   *
   * 다만 **담아 둔 선택은 영원하지 않다.** 그 글자가 지금 화면에 그대로 골라져 있을 때만 유효하고,
   * 막대가 다시 보이는 순간과 인용·복사를 만드는 순간에 살아 있는 선택과 대조한다(아래
   * `liveSelection`·검증 effect·`quoteCurrent` — 검토 MACR2-R1-01).
   */
  const liveSelection = useCallback((): Sel | null => {
    const s = window.getSelection()
    const el = desk.current?.querySelector('.sheet')
    const host = pane.current
    if (!s || s.isCollapsed || s.rangeCount === 0 || !el || !host) return null
    const range = s.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return null
    const text = s.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null
    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
    const secEl = node?.closest('[id^="sec-"]') ?? null
    const section = secEl ? (sections ?? []).find((x) => `sec-${x.id}` === secEl.id) ?? null : null
    if (!section) return null
    const r = range.getBoundingClientRect()
    const pr = host.getBoundingClientRect()
    // 어느 문단인가 — 선택이 시작한 글자 노드에서 가장 가까운 `div.blk`.
    const blkEl = (node as Element | null)?.closest('.blk') ?? null
    const blocks = Array.from(secEl?.querySelectorAll('.blk') ?? [])
    const blockIndex = blkEl ? blocks.indexOf(blkEl) : -1
    // `div.blk` 전체 글자와, 그 시작부터 선택 시작까지 — 원고 구간을 여기서 정한다(§4-1 3).
    const renderedBlock = blkEl?.textContent ?? ''
    let renderedBefore = ''
    if (blkEl) {
      const before = document.createRange()
      before.selectNodeContents(blkEl)
      before.setEnd(range.startContainer, range.startOffset)
      renderedBefore = before.toString()
    }
    return {
      text, sectionId: section.id, x: r.left + r.width / 2 - pr.left, top: r.top - pr.top, bottom: r.bottom - pr.top,
      blockIndex, renderedBlock, renderedBefore
    }
  }, [sections])

  const readSelection = useCallback(() => { setSel(liveSelection()) }, [liveSelection])

  // ── 뷰어 직접 수정 (설계 §3, §4-1) ──────────────────────────────────────────
  /** 지금 열린 편집칸 — 어느 절·문단의 어느 구간을 고치는가. */
  const [slot, setSlot] = useState<{
    sectionId: string
    blockIndex: number
    start: number
    end: number
    block: string
    /** 그대로 `replaceInBlock` 에 넘길 입력 — 위치를 두 번 계산하지 않는다. */
    input: SelectionInput
    value: string
  } | null>(null)
  /** 저장 뒤 한 줄 — 무엇을 말할지. 8초 뒤 사라지지 않는다(학생이 볼 때까지 남는다). */
  const [savedLine, setSavedLine] = useState<{ editId: string; needsCheck: boolean; recheck: boolean } | null>(null)
  /** 저장 실패 한 줄 — 원고는 그대로다(§3-5). */
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const [failureOpen, setFailureOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  /** 같은 낱말 제안 — 저장 결과에서 뽑는다(§3-4). */
  const [sameword, setSameword] = useState<Suggestion[]>([])
  const noteOwnEdit = useProject((s) => s.noteOwnEdit)
  const refreshProject = useProject((s) => s.refresh)

  /** 이 선택을 지금 원고에서 고칠 수 있는가 — 못 하면 그 이유(§3-1). */
  const editProblem = useCallback((live: Sel): EditBlock => {
    const doc = docs[live.sectionId]
    const row = (sections ?? []).find((x) => x.id === live.sectionId)
    if (!doc || !row) return 'notRegistered'
    if (!row.draft_hash_ok) return 'notRegistered'
    if (showDiff) return 'comparing'
    if (snapshot?.state === 'running') return 'agentBusy'
    const found = locateSelection({
      draft: doc.draft, blockIndex: live.blockIndex,
      renderedBlock: live.renderedBlock, renderedBefore: live.renderedBefore, selectionText: live.text
    }, renderMarkdown)
    if (!found.ok) return found.reason === 'block_missing' ? 'oneBlock' : 'needsQuote'
    return null
  }, [docs, sections, showDiff, snapshot])

  /** `직접 수정` — 편집칸을 드래그한 글자 자리에 연다(§3-2). */
  const openEdit = useCallback(() => {
    const live = liveSelection()
    if (!live) { setSel(null); return }
    if (editProblem(live)) return
    const doc = docs[live.sectionId]
    if (!doc) return
    const found = locateSelection({
      draft: doc.draft, blockIndex: live.blockIndex,
      renderedBlock: live.renderedBlock, renderedBefore: live.renderedBefore, selectionText: live.text
    }, renderMarkdown)
    if (!found.ok) return
    setSlot({
      sectionId: live.sectionId, blockIndex: live.blockIndex,
      start: found.start, end: found.end, block: found.before_block,
      input: {
        draft: doc.draft, blockIndex: live.blockIndex, renderedBlock: live.renderedBlock,
        renderedBefore: live.renderedBefore, selectionText: live.text
      },
      value: found.before_block.slice(found.start, found.end)
    })
    setSel(null)
    setFailure(null)
    // 새 고침을 시작하면 지난 저장 한 줄·같은 낱말 제안은 지금 고침의 말이 아니다.
    setSavedLine(null)
    setSameword([])
    window.getSelection()?.removeAllRanges()
  }, [docs, editProblem, liveSelection])

  /**
   * 편집칸을 닫는다 — 닫을 때 본문을 한 번 다시 읽는다(§4-5-8 06).
   *
   * 편집 중에는 폴링 재그리드를 멈추므로(`load` 첫 줄) 그동안 온 갱신은 버려졌다. 닫힘 자체가
   * 재조회 계기가 아니면 다음 개정·수동 새로고침 전까지 종이에 옛 본문이 남는다.
   */
  const closeEdit = useCallback(() => {
    setSlot(null)
    // `slotRef` 는 effect 에서 따라오므로 여기서 **먼저** 비운다 — 그러지 않으면 바로 아래
    // `load()` 가 '편집 중'으로 보고 그냥 돌아가, 취소해도 옛 본문이 남는다(§4-5-8 06).
    slotRef.current = null
    skippedWhileEditing.current = false
    void load()
  }, [load])

  // 폴링 재그리드가 편집 중인 문단을 건드리지 않게 — `load` 가 이 값을 먼저 본다.
  useEffect(() => { slotRef.current = slot }, [slot])

  /**
   * 저장 — 문단 전체의 전·후를 보낸다(§4-1 5). 화면이 위치를 다시 계산하지 않게 한다.
   * 성공하면 즉시 다시 읽고(§3-3), 그 지문을 미리 적어 채팅 이벤트 줄을 만들지 않는다.
   */
  const saveSlot = useCallback(async () => {
    const now = slot
    const rootNow = root
    if (!now || !rootNow) return
    const row = (sections ?? []).find((x) => x.id === now.sectionId)
    const live = pStatus
    if (!row || !live) return
    // 문단 전·후는 검증된 순수 함수로 만든다 — 위치 찾기를 다시 하지 않고, 표 `|`·줄바꿈·
    // 빈 문단 거절도 같은 규칙을 쓴다(§4-1 4, §3-2).
    const built = replaceInBlock({ ...now.input, replacement: now.value }, renderMarkdown)
    if (!built.ok) {
      setFailure({ message: EDIT.blocked.needsQuote, detail: built.reason })
      return
    }
    const outcome = await saveEdit(rootNow, {
      kind: 'one', id: now.sectionId, expected_revision: live.revision,
      expected_draft_hash: row.draft_hash, before_block: built.before_block, after_block: built.after_block
    })
    if (!outcome.ok) { setFailure({ message: outcome.message, detail: outcome.detail }); return }
    // 채팅 이벤트 줄 억제 + 즉시 다시 읽기(§3-3).
    noteOwnEdit(now.sectionId, outcome.result.draft_hash)
    setSlot(null)
    slotRef.current = null
    setFailure(null)
    setSavedLine({
      editId: outcome.result.edit_id,
      needsCheck: outcome.result.needs_check,
      // 제출 전 점검이 필요한 가벼운 고침도 있다(§4-5-8 07) — 화면이 그 사실을 말해야 한다.
      recheck: outcome.result.recheck_before_submit
    })
    // 같은 낱말은 **저장된 뒤의 본문**에서 찾는다(§3-4). `docs` 는 아직 저장 전 글이므로 그대로
    // 넘기면 방금 고친 자리를 '다른 곳'으로 세고, 그 옛 문단이 묶음에 들어가 sidecar 가 거절한다.
    const afterDocs = applySavedBlock(docs, now.sectionId, now.block, built.after_block)
    setDocs(afterDocs)
    const postDrafts: SectionDraft[] = Object.entries(afterDocs).map(([id, d]) => ({ id, draft: d.draft }))
    const suggestions = sameWordSuggestions(postDrafts, now.block, built.after_block)
    setSameword(suggestions)
    await refreshProject({ quiet: true })
  }, [slot, root, sections, pStatus, docs, saveEdit, noteOwnEdit, refreshProject])

  /** `같이 고치기` — 한 개정에 묶음 저장(§3-4). */
  const saveBatch = useCallback(async (edits: BatchEdit[]) => {
    const rootNow = root
    const live = pStatus
    if (!rootNow || !live || edits.length === 0) return
    const payload = edits.map((e) => ({ section_id: e.section_id, before_block: e.before_block, after_block: e.after_block }))
    const outcome = await saveEdit(rootNow, { kind: 'batch', expected_revision: live.revision, edits: payload })
    if (!outcome.ok) { setFailure({ message: outcome.message, detail: outcome.detail }); return }
    // 묶음은 절마다 정확한 지문이 필요하다 — sidecar 가 더한 `draft_hashes` 를 쓴다(§4-5-8 05).
    // 그것이 없는 응답(옛 sidecar)이면 **기억하지 않는다** — 절 ID 만으로 빼면 도우미 변경을 삼킨다.
    for (const [sid, hash] of Object.entries(outcome.result.draft_hashes ?? {})) noteOwnEdit(sid, hash)
    setSameword([])
    await refreshProject({ quiet: true })
  }, [root, pStatus, saveEdit, noteOwnEdit, refreshProject])

  /**
   * 막대가 다시 보이는 순간(아래 칸이 입력칸일 때) 담아 둔 선택을 **살아 있는 선택과 대조**한다.
   * 비교 모드를 끄면 종이가 다시 그려져 살아 있는 선택이 사라지는데, 그때는 화면에 없는 지운
   * 문장이 막대·인용으로 남았다(반례 A). 글자나 절이 어긋나면 버린다 — 본문이 그대로인 상태
   * 전환(작업 → 입력칸)에서는 선택이 그대로 살아 있으므로 지키고, 다시 고르지 않아도 막대가 뜬다.
   *
   * 좌표는 **지금 것**으로 갱신한다(절 제목이 길어져 문단이 밀렸을 수 있다). 의존성에 좌표를 넣지
   * 않는 이유: 갱신이 다시 이 effect 를 부르면 레이아웃이 흔들릴 때 고리가 될 수 있다.
   */
  const selKey = sel ? `${sel.sectionId}\u0000${sel.text}\u0000${sel.blockIndex}` : ''
  useEffect(() => {
    if (!sel || !canQuote) return
    const live = liveSelection()
    if (!live || live.text !== sel.text || live.sectionId !== sel.sectionId) { setSel(null); return }
    if (live.x !== sel.x || live.top !== sel.top || live.bottom !== sel.bottom) setSel(live)
    // sel 의 좌표는 일부러 의존성에서 뺀다(위 주석) — 글자·절·구역이 바뀔 때만 다시 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQuote, selKey, liveSelection])

  // 비교 모드를 켜고 끄면 종이가 다시 그려진다(지운/새 문장이 나타났다 사라진다) —
  // 그때 담아 둔 선택은 지금 화면의 글자가 아니다.
  useEffect(() => { setSel(null) }, [showDiff])

  /**
   * 인용을 만든다 — **반드시 살아 있는 선택**과 **지금의 절 목록**으로. 담아 둔 값을 그대로 쓰면
   * 제목이 바뀐 뒤 옛 제목이 붙는다(반례 B). 살아 있는 선택이 없으면 막대를 버린다.
   */
  const quoteCurrent = (): void => {
    const live = liveSelection()
    const section = live ? (sections ?? []).find((x) => x.id === live.sectionId) ?? null : null
    if (!live || !section || !root) { setSel(null); return }
    setQuote(quoteOf(root, live.text, section.id, section.title))
    requestQuote()
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  /** 복사도 같은 규칙 — 살아 있는 선택의 글자를 복사한다(화면에서 사라진 글자를 복사하지 않는다). */
  const copyCurrent = (): void => {
    const live = liveSelection()
    if (!live) { setSel(null); return }
    void navigator.clipboard?.writeText(live.text)
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  if (!root) return null
  const materialItem = (path: string | null | undefined) => path
    ? { path: joinPath(root, path), name: path.split(/[\\/]/).pop() ?? path }
    : null
  /**
   * 제출 전 점검이 필요한 장(§4-5-8 07). 원장이 그 건을 `recheck_before_submit` 으로 적었고,
   * 그 장이 아직 '검토 준비 완료'가 아니면 목록 머리에 남는다 — 검토가 다시 유효해지면
   * (`status === 'review_ready'`) 사라진다.
   */
  const recheckSections = [...new Set(
    editRows
      .filter((r) => r.recheck_before_submit)
      .flatMap((r) => r.section_ids)
      .filter((id) => (sections ?? []).find((x) => x.id === id)?.status !== 'review_ready')
  )]
  /** 지금 읽어 둔 절 본문들 — 같은 낱말 찾기의 대상(새로 읽지 않는다, §3-4). */
  const draftsNow: SectionDraft[] = Object.entries(docs).map(([id, d]) => ({ id, draft: d.draft }))
  const slotSection = questionSection(card, sections)?.id ?? null
  const writing = sections?.find((s) => s.status === 'drafting') ?? null
  /** 바뀐 절이 하나라도 있어야 "고친 부분 보기"가 켜진다(발주 §③). */
  const changed = (sections ?? []).some((s) => {
    const d = docs[s.id]
    const base = baseline[baselineKey(root, s.id)]
    return !!d && !!base && hasChange(base.draft, d.draft)
  })

  return (
    <section className="paperpane" aria-label={PAPER.paneLabel} ref={pane} style={{ flex: 1, minHeight: 0 }}>
      <div className="paper-head">
        <div className="pop-host">
          <button className="chap" aria-expanded={toc} onClick={() => setToc(!toc)}>
            <span className="n">{writing?.title ?? sections?.[0]?.title ?? PAPER.empty}</span>
            {(writing || sections?.length) && <span className="w">{writing ? stateWord(writing.status) : PAPER.stateEmpty}</span>}
            <Icon name="chevronDown" size={14} />
          </button>
          <Popover open={toc} onClose={() => setToc(false)} label={PAPER.tocTitle} width={300}>
            <PopHead>{PAPER.tocTitle}</PopHead>
            {(sections ?? []).map((s) => (
              <PopRow key={s.id} icon={<span className="rn">{s.order}</span>} current={writing?.id === s.id}
                onClick={() => { setToc(false); desk.current?.querySelector(`#sec-${CSS.escape(s.id)}`)?.scrollIntoView({ block: 'start' }) }}
                meta={stateWord(s.status)}>
                {s.title}
              </PopRow>
            ))}
          </Popover>
        </div>
        <span className="sp" />
        {snapshot?.state === 'running' && <span className="paper-live" role="status"><span className="dot" aria-hidden="true" />{PAPER.assistantRunning}</span>}
        {/* 고친 부분 보기 — 바뀐 절이 있을 때만 보인다(발주 §③ N-I04). 켜면 지운/새 문장이 색으로 갈린다. */}
        {changed && (
          <button className={`lnk review-toggle${showDiff ? ' on' : ''}`} aria-pressed={showDiff} title={REVIEW.diffToggleHint} onClick={toggleDiff}>
            <Icon name="check" size={14} />{REVIEW.diffToggle}
          </button>
        )}
        <MaterialsList open={materialsOpen} onOpenChange={setMaterialsOpen} listIntent={listIntent} consumeListIntent={consumeListIntent}
          count={materials?.files.length ?? 0}
          current={[{ label: MATERIALS.manuscriptLabel, file: materialItem(materials?.current_manuscript.path) }, { label: MATERIALS.financeLabel, file: materialItem(materials?.current_finance.path) }]}
          references={(materials?.files ?? []).filter((file) => file.role === 'reference').map((file) => materialItem(file.path)!)}
          onOpenFile={openPreview} onAttach={(path) => { insertPath(path); useProject.getState().setPaneView('chat') }}
          onAddMaterial={() => { void window.knuaf.pickFile({ title: MATERIALS.attach }).then((path) => { if (path) { insertPath(path); useProject.getState().setPaneView('chat') } }) }} />
        <ArtifactsList open={filesOpen} onOpenChange={setFilesOpen} listIntent={listIntent} consumeListIntent={consumeListIntent}
          items={(artifacts ?? []).map((file) => ({ name: file.name, path: joinPath(root, file.path), status: fileStatusText(file.path, projectLoad) }))}
          actions={make.rows.map((row) => ({ id: row.kind, label: row.label, description: row.body, disabled: !row.enabled || make.making !== null,
            feedback: make.making === row.kind ? <MakeRunningLine make={make} fb={make.feedbackKind === row.kind ? make.feedback : null} compact /> : make.feedbackKind === row.kind && make.feedback ? <MakeFeedbackLine fb={make.feedback} compact submission={row.kind === 'submission_candidate'} gate={pStatus?.gate} /> : undefined }))}
          blocked={make.blocked} hasProject={hasProject} stale={derived.stale} notice={previewNotice} error={artifactsError} loading={artifacts === null && !artifactsError}
          onOpenFile={openPreview} onMake={(id) => void make.run(id as MakeKind)} onRetry={() => void loadLists()} onReveal={() => void window.knuaf.folderOpen('project')} />
        {/* 직접 고친 곳 — 고침이 있을 때만 보인다. 고치지 않는 학생의 화면은 달라지지 않는다(§3-3). */}
        {editRows.length > 0 && (
          <StudentEditsList open={listOpen} onOpenChange={setListOpen} rows={editRows}
            titles={Object.fromEntries((sections ?? []).map((x) => [x.id, x.title]))}
            recheckSections={recheckSections} />
        )}
        {/* 권하는 단추 **하나** — "지금"이 고른 행동이다(1·2단계는 없다: 대화가 이끈다).
            만들기 자체는 "파일" 팝오버에서 언제든 되지만, 화면에 권하는 것은 이 하나뿐이다. */}
        {action && (
          <button className="primary" data-focus-key="head-action" title={action.hint}
            onClick={() => {
              if (action.stage === 3) void make.run('review')
              else if (action.stage === 4) void make.run('docx')
              else openSheet('checkup')
            }}>{action.label}</button>
        )}
      </div>

      {/* 팝오버를 닫아도 결과를 잃지 않는다 — 권하는 단추로 만들었거나 팝오버를 닫았으면
          종이 머리 아래 한 줄로 진행·고지·결과·실패가 보인다(검토 P3-R1-01). */}
      {/* 복구·보관 알림 — 문구는 sidecar 가 준 그대로, `확인` 을 누를 때까지 남는다(§4-5-6). */}
      {editNotices.length > 0 && (
        <div className="paper-fb edit-notices" role="status">
          {editNotices.map((notice) => (
            <div className="edit-notice" key={`${notice.kind}:${notice.edit_id}`}>
              <Icon name={notice.kind === 'restore_pending' ? 'warn' : 'info'} size={14} />
              <span>
                {notice.message}
                {notice.path && <><br /><span className="path">{EDIT.noticePath(notice.path)}</span></>}
              </span>
              <span className="actions">
                {notice.kind !== 'restore_pending' && (
                  <button type="button" className="lnk" onClick={() => { if (root) void markSeen(root, [notice.edit_id]) }}>{EDIT.noticeConfirm}</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {savedLine && (
        <div className={`paper-fb edit-line${savedLine.needsCheck ? ' needs' : ''}`} role="status">
          <span className="dot" aria-hidden="true" />
          <span>{savedLine.needsCheck ? EDIT.savedNeedsCheck : EDIT.saved}</span>
          {savedLine.recheck && <span className="recheck">{EDIT.saveRecheck}</span>}
        </div>
      )}
      {sameword.length > 0 && root && (
        <div className="paper-fb">
          {sameword.map((suggestion) => (
            <SameWordLine key={suggestion.from} suggestion={suggestion} sections={draftsNow} busy={snapshot?.state === 'running'}
              onBatch={(edits) => void saveBatch(edits)}
              onShowPlace={(place: Place) => {
                // 그 자리로 가서 낱말을 잠깐 칠한다(§3-4 `모두 보기`). 요소를 고르는 것까지는
                // 하지 않는다 — 이어서 드래그하는 것은 학생 몫이다.
                const sec = desk.current?.querySelector(`#sec-${CSS.escape(place.section_id)}`)
                const block = sec?.querySelectorAll('.blk')[place.block_index] as HTMLElement | undefined
                if (!block) { sec?.scrollIntoView({ block: 'start' }); return }
                flashWord(block, place.before_block, place.start, place.end)
              }}
              onAskHelper={(draft) => { useChat.getState().insertPath(draft); useProject.getState().setPaneView('chat') }}
              onDismiss={() => setSameword((rows) => rows.filter((r) => r.from !== suggestion.from))} />
          ))}
        </div>
      )}
      {failure && (
        <div className="paper-fb edit-line" role="alert">
          <Icon name="warn" size={14} />
          <span>{failure.message}</span>
          {failure.detail && (
            <button type="button" className="lnk" aria-expanded={failureOpen} onClick={() => setFailureOpen((v) => !v)}>
              {EDIT.failureMore}
            </button>
          )}
          {failureOpen && failure.detail && <span className="path">{failure.detail}</span>}
        </div>
      )}
      {!filesOpen && (make.making !== null || make.feedback) && (
        <div className="paper-fb">
          {make.making !== null
            ? <MakeRunningLine make={make} fb={make.feedback} compact />
            : make.feedback && <MakeFeedbackLine fb={make.feedback} compact submission={make.feedbackKind === 'submission_candidate'} gate={pStatus?.gate} />}
        </div>
      )}

      <div className="desk" ref={desk} data-editing={slot ? '1' : undefined}
        onMouseUp={() => { if (!slot) readSelection() }}
        onMouseDown={() => { if (!slot) setSel(null) }} onScroll={() => setSel(null)}>
        <div className="sheet">
          {(sections ?? []).length === 0
            ? <div className="paper-empty"><p className="doc-s">{PAPER.empty}</p><p className="ln">{PAPER.emptyBody}</p></div>
            : (sections ?? []).map((s) => {
              const doc = docs[s.id]
              const base = baseline[baselineKey(root, s.id)]
              const blocks = doc ? splitBlocks(doc.draft) : []
              const mark = new Set(fresh[s.id] ?? [])
              return (
                <div key={s.id} id={`sec-${s.id}`} className={blocks.length === 0 ? 'paper-empty' : undefined}>
                  <h2>{s.title}{s.status === 'drafting' && <span className="tag">{PAPER.stateDraft}</span>}
                    {/* 확인 전 — 그 문단 옆 작은 점(§3-3 ①). 근거·숫자를 건드린 고침만 여기 붙는다. */}
                    {editsOfSection(editRows, s.id).some((r) => r.state === 'pending') && (
                      <span className="blk-flag" title={EDIT.dotHint}><span className="dot" aria-hidden="true" />{EDIT.listState.pending}</span>
                    )}
                  </h2>
                  {/* "고친 부분 보기"가 켜져 있고 이 절이 실제로 바뀌었으면 비교를, 아니면 지금 본문을 그린다. */}
                  {showDiff && doc && base && hasChange(base.draft, doc.draft)
                    ? <ReviewDiffBlocks before={base.draft} after={doc.draft} />
                    : <>
                        {blocks.length === 0 && <p className="ln">{PAPER.emptyLine}</p>}
                        {/* markdown-it 이 html:false 로 만든 태그만 들어온다 — 링크·이미지는 렌더 단계에서
                            지운다(markdown.ts). 도우미가 쓴 글자가 곧 마크업이 되는 경로는 없다. */}
                        {blocks.map((b, i) => (
                          slot && slot.sectionId === s.id && slot.blockIndex === i
                            ? <PaperEditSlot key={i} block={slot.block} start={slot.start} end={slot.end}
                                value={slot.value}
                                onChange={(value) => setSlot((cur) => (cur ? { ...cur, value } : cur))}
                                onSave={() => void saveSlot()} onCancel={closeEdit} />
                            : <div key={i} className={mark.has(i) ? 'blk new' : 'blk'} dangerouslySetInnerHTML={{ __html: renderMarkdown(b) }} />
                        ))}
                      </>}
                  {slotSection === s.id && <div className="slot"><Icon name="info" size={14} /><span>{PAPER.questionSlot}</span></div>}
                </div>
              )
            })}
        </div>
      </div>
      {/* 고른 문장 위에 뜨는 행동 막대(N-I03) — 좁아지면 선택 아래로 뒤집는다. */}
      {sel && canQuote && (
        <ReviewSelectBar x={sel.x} top={sel.top} bottom={sel.bottom} paneWidth={pane.current?.clientWidth ?? 0}
          onQuote={quoteCurrent} onCopy={copyCurrent}
          onEdit={editAvailable === false ? undefined : openEdit}
          editBlock={sel ? editProblem(sel) : null} />
      )}
      {/* 점검 한 장이 논문 칸을 덮는다(시안 ⑫) — 내용은 Checkup 하나뿐이다. */}
      {overlay}
    </section>
  )
}
