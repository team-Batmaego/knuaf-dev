import { create } from 'zustand'
import { usePrep, type DependencyPreparation } from './prep'
import type { ArtifactItem, MaterialsData, ProjectPeek, SectionRow, Settings, SidecarInfo, Status } from '../../../shared/types'
import type { StageBuildTree } from '../../../shared/stage'
import type { EventHandler, ProjectLoad } from '../rpc'
import { CHAT, HELPER, describeError, type DescribedError } from '../copy'
import { rpc, RpcFailure } from '../rpc'
import { chatProvider, resolveChatMode, useChat } from './chat'
import { chosenProvider, useConnect } from './connect'
import type { Provider } from '../../../shared/chat'
import { useReview, type ReviewEdit } from './review'

export type DocReturn = { view: 'chat' | 'paper'; key: string }
export type ListIntent = { seq: number; kind: 'materials' | 'files' }
export type PaperEvent = { id: string; sectionId: string; title: string; at: string; edit: ReviewEdit | null }

/**
 * 지금 대화할 공급자 — **화면(`Chat`)이 계산하는 것과 같은 규칙**을 쓴다(store/connect 의
 * `chosenProvider` → 옛 설정 `helper_mode`).
 *
 * 왜 여기서 필요한가: 폴더를 열 때 이 store 가 `load(root)` 를 먼저 부르는데, 공급자를 넘기지
 * 않으면 스토어 기본값('codex')으로 읽고 화면이 곧바로 **다른 공급자로 한 번 더 읽어** 대화를
 * 비운다(맥 CI 에서 드러난 재마운트의 한 원인). 같은 값을 넘겨 그 두 번째 읽기를 없앤다.
 */
function chatProviderNow(): Provider {
  const settings = useProject.getState().settings
  return chosenProvider(useConnect.getState().selected, settings) ?? chatProvider(resolveChatMode(null, settings))
}

/**
 * v5에서는 **화면**이 아니라 **열린 시트**다(IMPL-PLAN §4-5). 사이드바 목적지 다섯이
 * 사라지고, 자료·결과물·점검·설정은 논문 위에 덮이는 한 장이 됐다. 대화는 언제나 깔려
 * 있으므로 "대화로 돌아가기"는 시트를 닫는 일(`closeSheet`)이다.
 */
export type Screen = 'materials' | 'artifacts' | 'checkup' | 'settings'

/**
 * 설정 화면 안에서 펼침을 열 대상 — 'tools:excel' 같은 프리셋. 실패 피드백의
 * "고급 도구에서 직접 실행"이 여기로 간다(Q2: "설정으로 가세요"가 아니라 해당 항목 직결).
 */
export type SettingsFocus = string | null
type PreviewFocusReturn = { trigger: HTMLElement | null; fallback: HTMLElement | null }

interface ProjectState {
  root: string | null
  newProjectSeq: number
  hasProject: boolean
  status: Status | null
  peek: ProjectPeek | null
  loading: boolean
  error: DescribedError | null
  /**
   * 시작 단계에서 실패한 **그 요청**의 정보(PY-D1-03). 준비 버튼의 조건과 재시도 대상 root 는
   * 오직 여기서 온다 — `sidecar` 는 성공한 프로젝트의 값이라 첫 실패·이전 프로젝트에서 틀린다.
   * 오류 카드를 닫으면(`clearError`) 같이 지운다.
   */
  openFailure: { root: string; sidecar: SidecarInfo; code: string } | null
  /**
   * 앱 전용 Python 설치 뒤 **재시도가 또 실패**했음(§7). 설치 성공을 폴더 복구 성공으로
   * 표시하지 않기 위해 결과를 컴포넌트가 아니라 store 가 보관한다 — 재시도는 `open()` 이
   * `openFailure` 를 지우며 진행되므로, 지역 상태에 두면 화면이 사라지고 결과도 사라진다.
   */
  retryFailed: { root: string } | null
  /**
   * 실패했던 폴더 열기를 다시 시도하고, 그 결과를 store 에 남긴다(설치 성공과 구분).
   * `onOpened` 는 성공했을 때만 부르고, **끝날 때까지 기다린다** — 재시도의 성공은 온보딩 기록
   * (`setSettings`)까지 끝난 뒤에 확정된다. 기다리지 않으면 화면 전환과 기록 사이에 순서가
   * 없어져, 느린 기기에서 "열렸다"는 사실만 먼저 보인다.
   */
  retryOpen: (root: string, onOpened?: (root: string) => void | Promise<void>) => Promise<boolean>
  sidecar: (SidecarInfo & { basePython?: string; wheelhouse?: string | null }) | null
  settings: Settings | null
  /** First-folder permission consent is global; the main process gates every project:open caller. */
  firstProjectGate: { root: string; kind: 'permission' | 'write-error' } | null
  sheet: Screen | null
  previewNotice: { title: string; body: string } | null
  previewFocusReturn: PreviewFocusReturn | null
  docPath: string | null
  paneTab: 'paper' | 'file'
  paneHold: boolean
  docReturn: DocReturn | null
  foldNotice: boolean
  listIntent: ListIntent | null
  quoteIntent: { seq: number } | null
  setPaneTab: (tab: 'paper' | 'file') => void
  openList: (kind: 'materials' | 'files') => void
  consumeListIntent: (seq: number) => void
  requestQuote: () => void
  consumeQuoteIntent: (seq: number) => void
  setFoldNotice: () => void
  settingsFocus: SettingsFocus
  logs: { stream: string; line: string }[]
  openSheet: (s: Screen) => void
  closeSheet: () => void
  openPreview: (path: string, fallback?: HTMLElement | null) => void
  closePreview: () => PreviewFocusReturn | null
  setPreviewNotice: (notice: { title: string; body: string } | null) => void
  /** Save the global choice before retrying the same open request. */
  chooseFirstProjectPermission: (mode: 'trust' | 'ask') => Promise<void>
  cancelFirstProjectGate: () => void
  /** Navigate to 설정 with a disclosure preset open (deep link from failure feedback). */
  openSettings: (focus?: SettingsFocus) => void
  clearSettingsFocus: () => void
  loadSettings: () => Promise<void>
  /**
   * 등록된 절 목록. 종이 칸이 이 순서대로 본문을 그리고, "본문이 있는 장이 있는가"도
   * 여기서 나온다(IMPL-PLAN §4-2). 정본 감시가 기록이 오르면 다시 읽는다.
   */
  sections: SectionRow[] | null
  loadSections: () => Promise<void>
  /**
   * 학생이 직접 고친 절을 **내가 고친 절**로 표시한다(설계 §3-3 정제 3-4).
   *
   * 다음 `loadSections` 가 그 절을 '도우미가 바뀐 절'로 세지 않게 한다 — 채팅에
   * `N곳을 고쳤어요` 줄이 생기지 않는다. 지문을 미리 적어 두는 길(`draftHash`)은 한 절일
   * 때만 쓸 수 있다: 묶음 저장의 응답 `draft_hash` 는 **첫 절 하나의 지문**이라, 둘째 장부터
   * 틀린 지문을 적으면 오히려 다음 읽기에서 이벤트 줄이 생긴다. 그래서 묶음은 절 ID 만
   * 표시하고, 그 절의 새 지문은 다음 읽기가 조용히 받아들인다.
   *
   * 메모리에만 남는다(앱을 다시 켜면 처음부터).
   */
  noteOwnEdit: (sectionIds: string | string[], draftHash?: string) => void
  /**
   * 자료·결과물 목록. 종이 머리의 "자료 N · 파일 N"과 팝오버, 그리고 시트가 **같은 것**을
   * 본다 — 화면마다 따로 읽으면 한 곳만 갱신되고 숫자가 어긋난다.
   */
  materials: MaterialsData | null
  artifacts: ArtifactItem[] | null
  /**
   * 결과물 목록을 **읽지 못한 이유**. `artifacts === null` 이 "아직 안 읽음"인지 "읽기 실패"인지
   * 화면이 구분하려면 이 값이 필요하다 — 예전에는 오류를 null 로 접어 두어 목록 실패가
   * 빈 화면(저장이 안 된 것처럼)으로 보였다(실기기 재현 2026-11-03).
   */
  artifactsError: string | null
  /** `build/` 개정 트리 — 검토본 기준 N(진행 규칙 §4-4)을 여기서 읽는다. */
  buildTree: StageBuildTree | null
  /** 정본 전체(`project.load`) — 파일 현재성은 여기 `outputs[*].stale` 뿐이다(v2 §4-1). */
  projectLoad: ProjectLoad | null
  loadLists: () => Promise<void>
  /**
   * 새로고침 횟수. 읽기(정본·자료·결과물)는 기록이 오르면 다시 하지만, **파일이 새로 생긴 것**
   * (예: 표지 입력 `paper-input.json`)은 기록을 바꾸지 않는다 — 만들기 조건이 그것을 보려면
   * 새로고침도 세어야 한다(검토 P3-R1-05).
   */
  refreshSeq: number
  /** 창 **내부** 폭 — 배치 판정(`layoutOf`)의 입력. ResizeObserver가 채운다. */
  windowWidth: number
  setWindowWidth: (w: number) => void
  /**
   * 학생이 종이 칸을 닫았는지. 배치 중 **유일하게 저장하는 값**이다(IMPL-PLAN §4-2) —
   * 닫으면 다시 저절로 열리지 않고, 앱을 다시 켜도 닫힌 채다.
   */
  paperClosed: boolean
  setPaperClosed: (closed: boolean) => void
  /**
   * 좁은 창(`switch`)에서 지금 보고 있는 칸. 배치가 두 칸이면 쓰지 않는다.
   * 저장하지 않는다 — 창을 넓히면 두 칸이 다 보이므로 기억할 것이 없다.
   */
  paneView: 'chat' | 'paper'
  setPaneView: (v: 'chat' | 'paper') => void
  /**
   * 도우미가 절을 쓴 사실 — 앱이 그리는 **대화 이벤트 줄**이다(IMPL-PLAN §3).
   * 대화 기록 파일(`chat-<provider>.json`)에는 쓰지 않는다. 절 제목은 `section.read`가 아니라
   * `project.sections`에서 가져온다(도우미 글의 머리 배너를 되뇌지 않기 위함).
   */
  events: PaperEvent[]
  /** 종이에서 어느 장으로 갈지 — 대화 이벤트 줄의 "종이에서 보기"가 세운다. */
  focusedSection: string | null
  focusSection: (id: string | null) => void
  /**
   * `local: true` — 실패를 전역 error 대신 반환값으로 돌려준다. 경로를 입력한 화면이
   * 제자리에서 알리게 하기 위함(GUI-04): 전역 error 는 Chat/Checkup 도 그리므로
   * 둘 다 세면 같은 오류가 두 화면에 뜬다.
   *
   * 기다리는 사이 다른 `open()` 이 시작되면(같은 폴더로 다시 연 경우 포함) 남은 단계를 하지 않고 null 을
   * 돌려준다 — 그 결과는 새 열기가 낸다. 떠난 열기의 실패를 지금 화면에 띄우지 않는다(검토 CI43-R1-01).
   */
  open: (root: string, opts?: { local?: boolean }) => Promise<DescribedError | null>
  /** `quiet: true` — 감시 타이머가 스스로 부르는 갱신. 스피너를 켜지 않고 한 번의 실패로 화면을 덮지 않는다. */
  refresh: (opts?: { quiet?: boolean }) => Promise<void>
  /** 정본이 생겼는지, 그리고 읽어 둔 것보다 기록이 올랐는지 — project.json 만 읽는다. */
  watchCanon: () => Promise<void>
  refreshSidecar: () => Promise<void>
  prepareDeps: (root: string, options?: { onEvent?: EventHandler; clientId?: string; install?: boolean }) => Promise<DependencyPreparation>
  cancelDeps: (operationId: string) => Promise<boolean>
  clearError: () => void
  helper: { open: boolean; status: any | null; result: { title: string; body?: string; kind: 'claude' | 'codex' } | null; error: DescribedError | null }
  openHelper: () => Promise<void>
  launchHelper: (kind: 'claude' | 'codex') => Promise<void>
  closeHelper: () => void
  pushLog: (entry: { stream: string; line: string }) => void
  clearLogs: () => void
}

/**
 * 폴더가 열려 있는 동안 도는 정본 감시 타이머. project.json 만 읽고 사이드카는
 * 띄우지 않는다.
 *
 * 정본이 "생겼는지"만 보던 때에는 점검 화면이 폴더를 연 순간의 상태를 그대로 붙들고
 * 있었다. 도우미가 스무 번을 저장해도 "고칠 곳 0"이 남아, 자동 점검 실패 60건짜리
 * 원고를 학생이 다 된 것으로 읽었다. 그래서 기록이 오른 것도 같이 본다.
 * (loginPoll 이 정리되지 않는 문제가 있었으니 폴더를 바꿀 때 반드시 끈다.)
 */
let canonPoll: ReturnType<typeof setInterval> | null = null
function stopCanonPoll(): void { if (canonPoll) { clearInterval(canonPoll); canonPoll = null } }
/**
 * 절마다 직전에 본 본문 지문(`draft_hash`). **메모리에만** 둔다 — 저장하지 않는다.
 * 이 값이 달라진 절이 "도우미가 방금 쓴 장"이다(대화 이벤트 줄). 폴더를 열면 비우므로
 * 앱을 켠 직후 첫 읽기에서는 아무 일도 알리지 않는다.
 */
let sectionHashes: Record<string, string> | null = null
/**
 * 학생이 **방금 직접 고친** 절과 그때 저장한 지문. 다음 읽기 한 번만 '바뀐 절'에서 뺀다.
 *
 * **지문이 같을 때만** 뺀다(설계 §4-5-8 05). 절 ID 만 보고 빼면, 저장 직후 도우미가 그 절을
 * 다시 쓴 경우에도 그 변경을 삼켜 버린다(그러면 채팅 알림도 접힌 종이 알림도 사라진다).
 * 지문을 모르는 절은 **빼지 않는다** — 알림이 한 번 더 뜨는 쪽이 변경을 잃는 것보다 낫다.
 */
const ownEdited = new Map<string, string>()
let sectionRequest = 0
let listRequest = 0
/** 읽는 중에 또 읽지 않는다 — 감시 타이머가 사이드카를 겹쳐 띄우지 않게. */
let statusInFlight = false
/** 조용한 갱신이 잇따라 실패하면 그때는 말한다 — 한 번은 도우미가 쓰는 중일 수 있다. */
let quietFailures = 0
/**
 * 열기 요청 세대와 실제 게시된 방문은 구별한다. 실패한 열기는 화면에 남은 폴더의 준비·조회 소유권을
 * 빼앗지 않는다. 요청 세대는 단조 증가시켜 더 오래된 성공 응답을 계속 거절한다.
 * 성공한 A→B→A 는 방문도 달라지므로 첫 A의 늦은 응답이 새 A를 덮을 수 없다.
 */
let openSeq = 0
let intentSeq = 0
let currentVisit = 0
const dependencyRuns = new Map<string, { visit: number; operationId: string; cancelled: boolean; installRequested: boolean; promise: Promise<DependencyPreparation> }>()
/**
 * 지금 시작하는 비동기 단계의 소유자 확인. 시작 시점의 방문과 폴더를 잡아 두고, 응답 뒤에 둘 다 그대로인지
 * 돌려준다 — 열기·갱신·감시·목록 읽기·준비가 모두 **같은 기준**을 쓴다.
 */
function visitOf(root: string): () => boolean {
  const visit = currentVisit
  return () => currentVisit === visit && useProject.getState().root === root
}

export const useProject = create<ProjectState>((set, get) => ({
  root: null,
  newProjectSeq: 0,
  hasProject: false,
  status: null,
  peek: null,
  loading: false,
  error: null,
  openFailure: null,
  retryFailed: null,
  firstProjectGate: null,
  sidecar: null,
  settings: null,
  sheet: null,
  previewNotice: null,
  previewFocusReturn: null,
  docPath: null,
  paneTab: 'paper',
  paneHold: false,
  docReturn: null,
  foldNotice: false,
  listIntent: null,
  quoteIntent: null,
  setPaneTab: (paneTab) => set({ paneTab: paneTab === 'file' && !get().docPath ? 'paper' : paneTab }),
  openList: (kind) => {
    if (get().sheet) get().closeSheet()
    if (get().paperClosed) get().setPaperClosed(false)
    set({ paneHold: true, paneTab: 'paper', paneView: 'paper', listIntent: { seq: ++intentSeq, kind } })
  },
  consumeListIntent: (seq) => set((s) => s.listIntent?.seq === seq ? { listIntent: null } : s),
  requestQuote: () => set({ paneView: 'chat', quoteIntent: { seq: ++intentSeq } }),
  consumeQuoteIntent: (seq) => set((s) => s.quoteIntent?.seq === seq ? { quoteIntent: null } : s),
  setFoldNotice: () => { if (get().paperClosed) set({ foldNotice: true }) },
  settingsFocus: null,
  logs: [],
  sections: null,
  materials: null,
  artifacts: null,
  artifactsError: null,
  buildTree: null,
  projectLoad: null,
  refreshSeq: 0,
  windowWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
  paperClosed: false,
  paneView: 'chat',
  events: [],
  focusedSection: null,
  openSheet: (sheet) => { set({ sheet, ...(sheet === 'checkup' ? { paneTab: 'paper' as const } : {}), ...(sheet === 'settings' ? {} : { settingsFocus: null }) }); location.hash = sheet },
  closeSheet: () => { set({ sheet: null, settingsFocus: null }); location.hash = '' },
  openPreview: (path, fallback = null) => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const trigger = typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active !== document.body ? active : null
    const keyed = trigger?.closest<HTMLElement>('[data-focus-key]')
    const returnTo: DocReturn = keyed?.dataset.focusKey
      ? { view: keyed.closest('.paperpane') ? 'paper' : 'chat', key: keyed.dataset.focusKey }
      : { view: get().sheet === 'checkup' || !!fallback ? 'paper' : 'chat', key: get().sheet === 'checkup' ? 'head-action' : fallback?.dataset.focusKey ?? '' }
    if (get().paperClosed) get().setPaperClosed(false)
    set({ docPath: path, paneTab: 'file', paneHold: true, paneView: 'paper', docReturn: returnTo, sheet: null, previewNotice: null, previewFocusReturn: { trigger, fallback } })
  },
  closePreview: () => {
    const focusReturn = get().previewFocusReturn
    const hasSections = !!get().sections?.length
    const view = hasSections ? get().docReturn?.view ?? 'paper' : 'chat'
    set({ docPath: null, paneTab: 'paper', paneHold: hasSections && get().paneHold, paneView: view, docReturn: null, previewNotice: null, previewFocusReturn: null })
    return focusReturn
  },
  setPreviewNotice: (previewNotice) => set({ previewNotice }),
  openSettings: (focus = null) => { set({ sheet: 'settings', settingsFocus: focus }); location.hash = 'settings' },
  clearSettingsFocus: () => set({ settingsFocus: null }),
  loadSettings: async () => {
    const settings = await window.knuaf.getSettings()
    const root = get().root
    // 종이 닫힘도 설정에서 읽는다 — 앱을 다시 켜도 학생이 닫아 둔 것은 닫힌 채다.
    set({ settings, ...(root ? { paperClosed: settings?.ui_prefs?.[root]?.paperClosed === true } : {}) })
  },
  chooseFirstProjectPermission: async (mode) => {
    const gate = get().firstProjectGate
    if (!gate || gate.kind !== 'permission') return
    await window.knuaf.setSettings({
      permission_mode: mode,
      ...(mode === 'ask' ? { trusted_roots: [] } : {}),
      first_project_permission_asked_at: new Date().toISOString()
    })
    await get().loadSettings()
    await get().open(gate.root)
  },
  cancelFirstProjectGate: () => set({ firstProjectGate: null, loading: false }),
  noteOwnEdit: (sectionIds, draftHash) => {
    const ids = typeof sectionIds === 'string' ? [sectionIds] : sectionIds
    if (ids.length === 0) return
    // 한 절이고 그 절의 지문을 받았으면 그 지문으로 기억한다(가장 정확한 기준).
    if (draftHash && ids.length === 1) {
      ownEdited.set(ids[0], draftHash)
      if (sectionHashes !== null) sectionHashes = { ...sectionHashes, [ids[0]]: draftHash }
      return
    }
    // 지문을 모르면(묶음 응답의 `draft_hash` 는 첫 절 것뿐) **기억하지 않는다** — 절 ID 만으로
    // 빼면 도우미 변경을 삼킨다. 알림이 한 번 더 뜨는 것이 안전한 쪽이다.
  },
  loadSections: async () => {
    const root = get().root
    if (!root) { set({ sections: null }); return }
    // 이 읽기를 시작한 방문. A→B→A 에서 첫 A 방문의 늦은 응답은 root 가 같아도 지금 방문의 것이 아니다 —
    // 옛 목록으로 덮으면 지금 방문의 status 는 이미 최신 개정이라 주기 감시가 다시 읽지 않는다(검토 OPEN-STALE-R1-01).
    const visit = visitOf(root)
    const request = ++sectionRequest
    const mine = () => visit() && request === sectionRequest
    try {
      const rows = await rpc.sections(root)
      if (!mine()) return
      const prev = sectionHashes
      // 내가 방금 고친 절은 이번 읽기에서 '도우미가 바꾼 절'이 아니다 — 한 번만 건너뛴다.
      // 내가 저장한 그 지문과 **같을 때만** '내 변경'이다 — 다르면 도우미가 그사이 다시 썼다.
      const justMine = new Map(ownEdited)
      ownEdited.clear()
      const changed = rows.filter((r) => (
        justMine.get(r.id) !== r.draft_hash && (!prev || prev[r.id] !== r.draft_hash)
      ))
      const events: PaperEvent[] = []
      if (changed.length) {
        const bodies = await rpc.readAllSections(root).catch(() => [])
        if (!mine()) return
        for (const row of changed) {
          const body = bodies.find((item) => item.id === row.id)
          let edit: ReviewEdit | null = null
          if (body) {
            try {
              await useReview.getState().noteSeen(root, row.id, { title: body.title, draft: body.draft, hash: row.draft_hash })
              if (!mine()) return
              edit = useReview.getState().editOf(root, row.id, row.draft_hash)
            } catch { /* The save still happened even if the comparison baseline could not be read. */ }
          }
          if (prev && (prev[row.id] !== undefined || (row.draft_chars ?? body?.draft.length ?? 0) > 0)) {
            events.push({ id: `${row.id}:${row.revision}`, sectionId: row.id, title: row.title, at: new Date().toISOString(), edit })
          }
        }
      }
      if (!mine()) return
      sectionHashes = Object.fromEntries(rows.map((r) => [r.id, r.draft_hash]))
      set((s) => ({ sections: rows, events: [...s.events, ...events].slice(-20), foldNotice: s.foldNotice || (s.paperClosed && events.length > 0) }))
    } catch {
      // 읽지 못한 것을 "등록된 절이 없다"로 꾸미지 않는다 — null 은 모른다는 뜻이다.
      if (mine()) set({ sections: null })
    }
  },
  setWindowWidth: (windowWidth) => set({ windowWidth }),
  loadLists: async () => {
    const root = get().root
    if (!root) { set({ materials: null, artifacts: null, artifactsError: null, buildTree: null, projectLoad: null }); return }
    const request = ++listRequest
    const mine = visitOf(root)
    const [m, a, tree, load] = await Promise.all([
      rpc.materials(root).catch(() => null),
      // 목록 실패를 빈 목록과 구분해 남긴다 — 화면이 "저장이 안 됐다"와 "읽지 못했다"를
      // 같은 공백으로 보여 주면 학생은 파일이 사라졌다고 읽는다(실기기 재현 2026-11-03).
      rpc.artifacts(root).then((v) => ({ v })).catch((e: unknown) => ({ e })),
      rpc.buildTree(root).catch(() => null),
      rpc.load(root).catch(() => null)
    ])
    if (!mine() || request !== listRequest) return
    set({
      materials: m,
      artifacts: 'v' in a ? a.v.items : null,
      artifactsError: 'e' in a ? (a.e instanceof Error ? a.e.message : String(a.e)) : null,
      buildTree: tree, projectLoad: load
    })
  },
  setPaneView: (paneView) => set({ paneView }),
  focusSection: (focusedSection) => set({ focusedSection }),
  setPaperClosed: (closed) => {
    const root = get().root
    set({ paperClosed: closed, ...(!closed ? { foldNotice: false } : {}) })
    if (!root) return
    const prefs = { ...(get().settings?.ui_prefs ?? {}) }
    prefs[root] = { ...prefs[root], paperClosed: closed }
    // 정본 폴더에는 쓰지 않는다 — 앱 설정에만 남긴다(IMPL-PLAN §4-2).
    void window.knuaf.setSettings({ ui_prefs: prefs }).then(() => get().loadSettings())
  },
  open: async (root, opts) => {
    const seq = ++openSeq
    // 그 사이 다른 열기가 시작됐으면(같은 폴더로 다시 연 경우 포함) 이 열기의 남은 단계는 지금 화면의 것이 아니다.
    const superseded = (): boolean => openSeq !== seq
    set({ loading: true, error: null, openFailure: null, retryFailed: null })
    const r = await window.knuaf.openProject(root)
    if (superseded()) return null
    if (r.error) {
      if (r.error.code === 'first_project_permission_required' || r.error.code === 'folder_not_writable') {
        set({ loading: false, firstProjectGate: { root, kind: r.error.code === 'folder_not_writable' ? 'write-error' : 'permission' } })
        return null
      }
      const d = describeError(r.error)
      if (!opts?.local) set({ error: d })
      // 실패한 그 선택의 python·kind 와 재시도 대상 root 를 오류와 함께 보관한다(PY-D1-03).
      // 이전 프로젝트의 store.sidecar 로 판단하면 첫 실패에서 버튼이 서지 않고, 다른 논문을
      // 열었던 세션에서는 틀린 kind 로 판단한다.
      set({ loading: false, firstProjectGate: null, openFailure: r.startupFailed && r.sidecar ? { root, sidecar: r.sidecar, code: r.error.code } : null })
      return d
    }
    // 위에서 error 분기를 돌려보냈으므로 result 는 반드시 있다 — 없으면 계약 위반이므로
    // 빈 폴더처럼 다루지 않고 명시적으로 실패한다.
    if (!r.result) {
      const d = describeError({ code: 'internal', message: 'project:open 응답에 result 가 없음' })
      set({ loading: false, error: d })
      return d
    }
    const opened = r.result
    // Publish this visit and register checking before the first follow-up await.
    const settings = get().settings
    currentVisit = seq
    set({
      root, hasProject: opened.hasProject, sidecar: opened.sidecar, status: null, peek: null, firstProjectGate: null,
      // 폴더마다 다른 취향이므로 폴더가 바뀌면 여기서 다시 읽는다(전역 settings 는 그대로).
      paperClosed: settings?.ui_prefs?.[root]?.paperClosed === true
    })
    void get().prepareDeps(root)
    const peek = await window.knuaf.peekProject(root)
    if (superseded()) return null
    set({ peek })
    // 시트는 폴더가 바뀌면 닫는다 — 다른 논문의 점검·자료가 떠 있으면 안 된다.
    // 이동은 성공이 확정된 여기서 한다 — 아래 refresh() 는 파이썬 스폰이라 몇 초
    // 걸리는데, 그 사이 학생이 다른 것을 열면 늦게 온 이동이 되돌려 버렸다.
    get().closeSheet()
    get().closePreview()
    stopCanonPoll()
    quietFailures = 0
    // 다른 논문의 이벤트 줄·직전 지문을 들고 가지 않는다.
    sectionHashes = null
    set({ events: [], sections: null, materials: null, artifacts: null, artifactsError: null, buildTree: null, projectLoad: null, focusedSection: null, paneView: 'chat', paneHold: false, docReturn: null, foldNotice: false, listIntent: null, quoteIntent: null, paneTab: 'paper', docPath: null })
    canonPoll = setInterval(() => { void get().watchCanon() }, 2000)
    // 도우미가 하위 폴더에 init한 경우 — 빈 화면으로 두지 않고 어디에 만들었는지 알린다.
    const nested = opened.nestedProject
    if (nested) set({ error: { kind: 'warning', title: '도우미가 다른 폴더에 논문을 만들었어요.', action: `"${nested}" 폴더 안에 논문 데이터가 있어요. 그 폴더를 열거나, 이 폴더가 맞으면 도우미에게 이 폴더에서 작업하라고 알려 주세요.`, code: 'nested_project', raw: `${nested}/project.json` } })
    await get().loadSettings()
    if (superseded()) return null
    if (opened.hasProject) await get().refresh()
    else { set({ loading: false }); set({ sections: null }) }
    // 학생이 그 사이 다른 폴더를 눌렀다 — 준비·대화 읽기는 새 열기가 한다. 여기서 이전 폴더로 대화를 읽기
    // 시작하면 지금 폴더의 대화·오류 줄이 잠깐 비고, 그 틈에 누른 닫기가 사라진다(검토 CI43-R1-01).
    if (superseded()) return null
    // 화면이 쓸 공급자를 **같이 넘긴다** — 안 넘기면 화면이 곧바로 다른 공급자로 다시 읽어
    // 대화를 한 번 비운다(위 chatProviderNow 주석).
    void useChat.getState().load(root, chatProviderNow())
    return null
  },
  prepareDeps: (root, options) => {
    const visit = currentVisit
    const previous = dependencyRuns.get(root)
    if (previous?.visit === visit) {
      if (options?.install !== false) previous.installRequested = true
      return previous.promise
    }
    const mine = visitOf(root)
    const operationId = options?.clientId ?? rpc.newClientId()
    const prep = usePrep.getState()
    prep.startDependency(root, visit, operationId)
    prep.begin(root)
    const promise = (async (): Promise<DependencyPreparation> => {
      let phase: 'checking' | 'installing' | 'verifying' = 'checking'
      let result: DependencyPreparation = { visit, operationId, phase: 'blocked' }
      const live = (): void => {
        const active = dependencyRuns.get(root)
        if (active?.operationId === operationId && active.cancelled) throw new RpcFailure({ code: 'cancelled', message: '준비를 취소했어요.' })
        if (!mine()) throw new RpcFailure({ code: 'cancelled', message: '다른 폴더 방문으로 준비를 중단했어요.' })
      }
      try {
        // A→B→A joins the old physical operation, then diagnoses its own visit.
        if (previous) await previous.promise
        live()
        let report = await rpc.depsDoctor(root, operationId, options?.onEvent)
        live()
        prep.updateDependency(root, operationId, { report })
        if (!report.ready) {
          if (options?.install === false && !dependencyRuns.get(root)?.installRequested) throw new RpcFailure({ code: 'deps_required', message: '프로젝트 .venv를 준비해야 해요.' })
          phase = 'installing'
          prep.updateDependency(root, operationId, { phase, report })
          const reply = await window.knuaf.depsEnsure(root, options?.onEvent, operationId)
          live()
          if (reply.error) throw new RpcFailure(reply.error)
          if (!reply.result?.ok) throw new RpcFailure({
            code: 'deps_ensure', message: reply.result?.block_reason || reply.result?.stderr || '패키지 설치 실패', data: reply.result
          })
          phase = 'verifying'
          prep.updateDependency(root, operationId, { phase })
          await get().refreshSidecar()
          live()
          report = await rpc.depsDoctor(root, operationId, options?.onEvent)
          live()
          if (!report.ready) throw new RpcFailure({ code: 'deps_verify', message: '프로젝트 .venv의 import·버전 확인을 통과하지 못했어요.', data: report })
        }
        result = { visit, operationId, phase: 'ready', report }
      } catch (error) {
        const failure = error as { code?: string; message?: string; data?: unknown }
        if (failure.code === 'deps_verify' || (failure.data && typeof failure.data === 'object' && 'phase' in failure.data && failure.data.phase === 'verifying')) phase = 'verifying'
        result = { visit, operationId, phase: 'blocked', error: {
          code: failure.code ?? 'deps_doctor', phase,
          message: (failure.message ?? String(error)) + (failure.data ? '\n' + JSON.stringify(failure.data) : '')
        } }
      } finally {
        if (mine()) prep.updateDependency(root, operationId, result)
        prep.end(root)
        if (dependencyRuns.get(root)?.visit === visit) dependencyRuns.delete(root)
      }
      return result
    })()
    dependencyRuns.set(root, { visit, operationId, cancelled: false, installRequested: options?.install !== false, promise })
    return promise
  },
  cancelDeps: async (operationId) => {
    for (const active of dependencyRuns.values()) if (active.operationId === operationId) active.cancelled = true
    return rpc.cancel(operationId)
  },
  /**
   * hasProject 와 status 는 폴더를 열 때 한 번 정해진다. 도우미가 그 뒤에 정본을
   * 만들면 앱은 모른 채 왼쪽 메뉴를 잠가 두었고(GUI 감사 GUI-02), 정본을 고쳐도
   * 점검 화면은 옛 숫자를 계속 내보였다.
   *
   * 채팅 스냅샷에 매달지 않는 이유: 정본을 바꾸는 길이 앱 안 채팅만은 아니다. 학생이
   * 외부 터미널에서 스킬을 돌려도 정본은 바뀌고, 그때는 스냅샷이 오지 않는다.
   * 그래서 "누가 바꿨는지"를 묻지 않고 파일만 본다.
   *
   * refresh() 를 바로 부르지 않는 이유: 정본이 없는 폴더에서는 status 가 실패해
   * 일어나지도 않은 오류를 띄운다. 존재를 먼저 보고, 바뀌었을 때만 제대로 읽는다.
   */
  watchCanon: async () => {
    const root = get().root
    if (!root) { stopCanonPoll(); return }
    const mine = visitOf(root)
    const peek = await window.knuaf.peekProject(root)
    if (!mine()) return
    set({ peek })
    // 두 번 잇따라 실패해 화면에 오류가 떠 있으면 되풀이하지 않는다. 학생이 새로고침을
    // 누르면 다시 센다 — 읽히지 않는 정본으로 2초마다 사이드카를 띄우지 않기 위함이다.
    if (!peek.hasProject || statusInFlight || quietFailures >= 2) return
    // 정본이 처음 보이면 한 번 읽는다. 그 뒤로는 개정 번호가 달라졌을 때만 읽는다 —
    // 번호를 못 읽으면(깨진 파일) 바뀐 줄 알 길이 없으니 되풀이하지 않는다.
    const moved = peek.revision != null && peek.revision !== get().status?.revision
    if (get().hasProject && !moved) return
    await get().refresh({ quiet: true })
  },
  refresh: async (opts) => {
    const root = get().root
    if (!root) return
    // 이 갱신을 시작한 방문. 응답을 기다리는 사이 새 열기가 시작되면(같은 폴더 포함) 이 결과는 버린다.
    const mine = visitOf(root)
    // 학생이 직접 누른 새로고침은 감시 타이머의 실패 횟수도 다시 센다(위 물러섬 해제).
    if (!opts?.quiet) { quietFailures = 0; set({ loading: true, error: null }) }
    statusInFlight = true
    try {
      const status = await rpc.status(root)
      const peek = await window.knuaf.peekProject(root)
      if (!mine()) return
      quietFailures = 0
      set({ status, peek, hasProject: true, loading: false, refreshSeq: get().refreshSeq + 1 })
      // 종이 칸·머리가 같은 목록을 본다 — 화면마다 따로 읽으면 한 곳만 갱신된다.
      void get().loadSections()
      void get().loadLists()
    } catch (e) {
      // 떠난 방문의 실패는 지금 화면에 띄우지 않는다.
      if (!mine()) return
      // 조용한 갱신의 첫 실패는 삼킨다 — 도우미가 쓰는 중이면 곧 풀린다. 두 번째부터는
      // 말한다: 화면의 숫자가 디스크의 정본보다 뒤처진 채 조용히 남는 것이 가장 나쁘다.
      if (opts?.quiet && ++quietFailures < 2) return
      set({ error: describeError(e), loading: false })
    } finally { statusInFlight = false }
  },
  retryOpen: async (root, onOpened) => {
    const err = await get().open(root, { local: true })
    if (!err) { await onOpened?.(root); return true }
    // 새 오류는 전역 error 로 올려 화면이 그대로 보여 준다. 설치 성공과 복구 실패를 함께
    // 말하는 문구는 retryFailed 가 맡는다 — 이 값은 컴포넌트가 아니라 store 에 산다.
    set({ error: err, retryFailed: { root } })
    return false
  },
  refreshSidecar: async () => {
    const root = get().root
    if (!root) return
    const mine = visitOf(root)
    const sidecar = await window.knuaf.sidecarInfo()
    if (mine()) set({ sidecar })
  },
  // 오류 카드를 닫으면 그 요청의 실패 정보·복구 실패 표시도 같이 지운다 — 버튼이 사라진 뒤
  // 재시도 대상만 남지 않게.
  clearError: () => set({ error: null, openFailure: null, retryFailed: null }),
  helper: { open: false, status: null, result: null, error: null },
  openHelper: async () => {
    set({ helper: { open: true, status: null, result: null, error: null } })
    const r = await window.knuaf.agentStatus(get().root)
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, status: r.result } }))
    const st = r.result
    if (st.claude.found && !st.codex.found) await get().launchHelper('claude')
    else if (!st.claude.found && st.codex.found) await get().launchHelper('codex')
  },
  launchHelper: async (kind) => {
    const { root, status, peek } = get()
    if (!root) { set((s) => ({ helper: { ...s.helper, error: describeError({ code: 'not_found', message: '먼저 폴더를 열어 주세요' }) } })); return }
    const r = await window.knuaf.agentLaunch({ root, kind, revision: status?.revision ?? peek?.revision ?? null })
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, result: { title: HELPER.launchedTitle, body: undefined, kind } } }))
  },
  closeHelper: () => set((s) => ({ helper: { ...s.helper, open: false } })),
  pushLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  clearLogs: () => set({ logs: [] })
}))
