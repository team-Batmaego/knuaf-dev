/**
 * 학교 재무 양식 알림(`<논문 폴더>/.knuaf-notices.json`) — 읽기와 화면 규칙.
 *
 * 정본 계약은 `knuaf.notices/1`(knuaf-doc 책임자 확정 11-11, CONTRACT-DELTA-v049). 파일은 **규칙집(도우미)이
 * 쓴다** — 앱은 읽기만 한다. 학생 선택은 `gg_notices.py choose`(sidecar `notices.choose`)가 정본에 적고
 * 알림 파일을 다시 쓴다. 앱이 정본·알림 파일을 직접 쓰지 않는다.
 *
 * 여기 있는 것은 **순수 함수뿐**이다(파일·전자·IPC 없음). 이유:
 * ① main 쪽 읽기(`main/notices.ts`)와 화면(`components/NoticeBubble.tsx`)이 **같은 해석**을 써야 한다.
 * ② Electron 창 없이 Node 단위 시험으로 잠글 수 있다(`e2e/notice-bubble.spec.ts`).
 *
 * 보수적으로 읽는다 — 모양이 조금이라도 어긋난 알림은 버린다(틀린 말풍선보다 말풍선 없음).
 * `title` 은 도구가 **완성한 문장**이므로 앱은 조립하지 않는다: 숫자·범주를 앱이 만들면 계약이 둘로 갈린다.
 */

/** 논문 폴더 바로 아래 고정 이름. 옮기거나 설정으로 바꾸지 않는다(계약). */
export const NOTICE_FILE = '.knuaf-notices.json'
export const NOTICE_SCHEMA = 'knuaf.notices/1'

/** 말풍선 한 줄의 상한. 넘으면 자른다 — 도우미가 만든 글이 화면을 잡아먹지 않게. */
export const TITLE_MAX = 160
/** [자세히] 줄 상한 — 계약의 원예 견본은 16줄, 넉넉히 50줄까지. */
export const ITEMS_MAX = 50
/** 한 줄에 붙는 칸 주소 상한(견본에는 20칸짜리 항목이 있다). */
export const CELLS_MAX = 4
export const WHAT_MAX = 240
export const LABEL_MAX = 60

export type NoticeChoiceValue = 'direct_tell' | 'footnote'
/** 계약이 허용하는 값은 둘뿐이다. sidecar 도 같은 목록으로 막는다. */
export const CHOICE_VALUES: readonly NoticeChoiceValue[] = ['direct_tell', 'footnote']

export interface NoticeChoice { value: NoticeChoiceValue; label: string }
export interface NoticeItem {
  /** 계약의 `key`(정정 묶음 식별자). 겹칠 수 있으므로 화면 key 는 순번을 붙인다. */
  key: string
  kind: 'typo' | 'method' | 'other'
  /** 무슨 자리를 어떻게 바로잡았는가 — 서식 없는 글. */
  what: string
  /** `4.투자계획!E24` 꼴의 칸 주소. 많으면 `…` 하나로 줄인다. */
  cells: string[]
  /**
   * 아래 다섯 칸은 공용 카드 계약 7판(`NOTICE-CARD-CONTRACT-DRAFT.md` §8)의 **사실 칸**이다.
   * 전부 선택이다 — 없으면 화면은 그 줄을 빼고 지금 모양(`what · cells`) 그대로 그린다.
   * 앱은 여기에 **문장을 조립하지 않는다**: 도구가 쓴 사실만 옮겨 그린다.
   */
  /** 무슨 일 — 학생이 아는 자리 이름. */
  where?: string
  /** 지금 값 — 그 자리에 들어 있던 것. */
  current?: string
  /** 왜 문제인가 — 사실에 근거한 문장. */
  basis?: string
  /** 어떻게 — 학생이 할 일 한 줄. */
  how?: string
  /** 시트 이름·칸 좌표(작은 글씨, 맨 아래). */
  whereDetail?: string
}

export interface NoticeRow {
  /** 닫기 기억의 키 = `project_id:notice_identity`. 둘 다 sha256 hex 라 `:` 가 값 안에 없다. */
  key: string
  /** 도구가 완성한 한 줄 — 그대로 그린다. */
  title: string
  items: NoticeItem[]
  /** 상한을 넘겨 자른 줄 수(0 이면 전부 보임). */
  omittedItems: number
  /** 논문 폴더 안 상대 경로만. 밖을 가리키면 null. */
  receiptPath: string | null
  /** 선택지(계약이 없으면 빈 배열). */
  choices: NoticeChoice[]
  /** 이미 기록된 선택(없으면 null). */
  choice: NoticeChoiceValue | null
  /** 도구가 닫기를 허용했는가 — 기본 true. */
  dismissible: boolean
}

export interface NoticeDocument { notices: NoticeRow[] }

/** 파일이 없거나 깨졌을 때 쓰는 값 — "알림 없음". */
export function emptyNotices(): NoticeDocument {
  return { notices: [] }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * 한 줄 글자로 정리한다 — 제어문자·줄바꿈을 공백으로 접고, 앞뒤를 자르고, 길면 `…`.
 * 도우미가 만든 글은 서식 없는 텍스트로만 그린다(마크다운·링크 해석 금지) — 해석은 화면이 하지 않는다.
 */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** 한 줄 = `title` 그대로. 앱은 숫자를 넣지 않는다. */
export function titleLine(text: unknown): string {
  return oneLine(text, TITLE_MAX)
}

function choiceValue(value: unknown): NoticeChoiceValue | null {
  return value === 'direct_tell' || value === 'footnote' ? value : null
}

/**
 * `receipt_path` 는 **논문 폴더 안 상대 경로**만 인정한다.
 * 절대 경로·드라이브 문자·`~`·`..` 가 하나라도 있으면 null(무시) — 도우미가 흉내 낼 수 있는 값이라
 * 화면이 그 경로로 무엇이든 열게 두면 폴더 밖을 가리키게 된다.
 */
export function receiptPathInside(receipt: unknown): string | null {
  if (typeof receipt !== 'string') return null
  const raw = receipt.trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:/.test(raw)) return null
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

function readItems(raw: unknown): { items: NoticeItem[]; omitted: number } {
  if (!Array.isArray(raw)) return { items: [], omitted: 0 }
  const items: NoticeItem[] = []
  for (const entry of raw) {
    const item = record(entry)
    if (!item) continue
    const what = oneLine(item.what, WHAT_MAX)
    if (!what) continue // 무엇을 고쳤는지 없는 줄은 보여 줄 것이 없다.
    const cells: string[] = []
    let more = false
    if (Array.isArray(item.cells)) {
      for (const cell of item.cells) {
        const text = oneLine(cell, 80)
        if (!text) continue
        if (cells.length >= CELLS_MAX) { more = true; break }
        cells.push(text)
      }
    }
    if (more) cells.push('…')
    // 사실 칸 — 없거나 빈 값이면 **키 자체를 넣지 않는다**(화면은 `undefined` 를 "그 줄 없음"으로 읽는다).
    const item2: NoticeItem = {
      key: typeof item.key === 'string' ? item.key : '',
      kind: item.kind === 'typo' || item.kind === 'method' ? item.kind : 'other',
      what,
      cells
    }
    const facts: Array<['where' | 'current' | 'basis' | 'how' | 'whereDetail', string]> = [
      ['where', 'where'], ['current', 'current'], ['basis', 'basis'], ['how', 'how'], ['whereDetail', 'where_detail']
    ]
    for (const [target, source] of facts) {
      const text = oneLine(item[source], WHAT_MAX)
      if (text) item2[target] = text
    }
    items.push(item2)
  }
  return { items: items.slice(0, ITEMS_MAX), omitted: Math.max(0, items.length - ITEMS_MAX) }
}

function readChoices(raw: unknown): NoticeChoice[] {
  if (!Array.isArray(raw)) return []
  const out: NoticeChoice[] = []
  for (const entry of raw) {
    const choice = record(entry)
    const value = choice ? choiceValue(choice.value) : null
    if (!choice || !value) continue // 모르는 값은 그리지 않는다 — 누르면 무엇이 기록될지 말할 수 없다.
    if (out.some((c) => c.value === value)) continue
    out.push({ value, label: oneLine(choice.label, LABEL_MAX) || value })
  }
  return out
}

function readNotice(raw: unknown, documentProjectId: string): NoticeRow | null {
  const notice = record(raw)
  if (!notice) return null
  const title = titleLine(notice.title)
  const identity = typeof notice.notice_identity === 'string' ? notice.notice_identity.trim() : ''
  const projectId = (typeof notice.project_id === 'string' && notice.project_id.trim()) || documentProjectId
  // 열쇠가 없으면 "닫으면 다시 안 뜸"을 지킬 수 없다 — 그런 알림은 띄우지 않는다.
  if (!title || !identity || !projectId) return null
  const { items, omitted } = readItems(notice.items)
  return {
    key: noticeKey(projectId, identity),
    title,
    items,
    omittedItems: omitted,
    receiptPath: receiptPathInside(notice.receipt_path),
    choices: readChoices(notice.choices),
    choice: choiceValue(notice.choice),
    dismissible: notice.dismissible !== false
  }
}

/** 닫기 기억의 키 — `project_id + notice_identity`. **선택은 이 값을 바꾸지 않는다**(계약). */
export function noticeKey(projectId: string, identity: string): string {
  return `${projectId}:${identity}`
}

/**
 * 파일 전체 해석. `schema` 가 다르거나 `notices` 가 배열이 아니면 **알림 없음**이다.
 * 한 알림이 깨져도 나머지는 살린다(알림 하나 때문에 전부 감추지 않는다).
 */
export function readNoticeDocument(raw: unknown, root: string): NoticeDocument {
  if (!root) return emptyNotices()
  const document = record(raw)
  if (!document || document.schema !== NOTICE_SCHEMA) return emptyNotices()
  if (!Array.isArray(document.notices)) return emptyNotices()
  const documentProjectId = typeof document.project_id === 'string' ? document.project_id.trim() : ''
  const notices: NoticeRow[] = []
  for (const row of document.notices) {
    const notice = readNotice(row, documentProjectId)
    if (notice) notices.push(notice)
  }
  return { notices }
}

/**
 * 말풍선을 띄울까. 닫은 키는 다시 안 띄운다 — `forceOpen`(SKE-09 "다시 보기")만 예외다.
 * 닫기 기억은 부르는 쪽이 들고 있는다(이번 묶음은 부품만 — 저장은 2묶음).
 */
export function noticeVisible(notice: NoticeRow, dismissed: readonly string[] = [], forceOpen = false): boolean {
  if (forceOpen) return true
  return !dismissed.includes(notice.key)
}

/** 띄울 알림 하나 — 이미 닫은 것은 건너뛴다. */
export function firstVisible(notices: readonly NoticeRow[], dismissed: readonly string[] = [], forceOpen = false): NoticeRow | null {
  return notices.find((notice) => noticeVisible(notice, dismissed, forceOpen)) ?? null
}

/**
 * 선택 단추를 그릴까 — `choices` 가 있고 아직 `choice` 가 null 일 때만, 알림 한 건에 한 번.
 * `picked` 는 화면이 방금 누른 값(기록이 끝나기 전 잠금). 이미 고른 알림은 다시 묻지 않는다.
 */
export function choiceOpen(notice: NoticeRow, picked: NoticeChoiceValue | null = null): boolean {
  return notice.choices.length > 0 && notice.choice === null && picked === null
}

/** [자세히] 를 그릴까 — 보여 줄 줄이 없으면 단추도 없다. */
export function hasDetail(notice: NoticeRow): boolean {
  return notice.items.length > 0
}
