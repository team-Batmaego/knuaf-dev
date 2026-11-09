import { chatMd } from './chat-md'
import type { ChatMessage, Provider } from './chat'
import type { FoldSpan } from './chat-fold'

/**
 * 도우미 답 안의 "창업논문 진행 목록" 덩어리 — 제목줄 표시와 본문 감추기의 순수 함수.
 *
 * IMPL-T1 §3-2: 단계 이름은 앱 고정본(STEP_NAMES)과 같아야 하며, 어긋나면 덩어리째
 * 버린다(임의 유효 금지). 실패하면 그 답은 진행 목록이 없는 것으로 친다 —
 * 제목줄은 유지하고, 대화에는 원문이 보인다.
 */

export const STEP_NAMES: readonly string[] = [
  '자료·전공 확인',
  '계획 인터뷰',
  '조사·근거 정리',
  '본문 Ⅰ~Ⅵ 초안',
  '재무 엑셀',
  '검토·고치기',
  '워드 검토본',
]

// ---------------------------------------------------------------------------
// 정규식 — IMPL-T1 §3-2 그대로. 굵게 **·__를 걷은 줄에 적용한다.
// ---------------------------------------------------------------------------

const TITLE = /^\s*창업논문 진행 목록\s*·\s*(\d+)단계 중\s*([1-7])(?:\s*[–~-]\s*([1-7]))?단계/
// 단일 줄: 기호 번호 '단계 이름' [— 메모]   ← 실기록 "▶ 1 자료·전공 확인 — …"
const STEP_ONE = /^\s*([✓▶○])\s*([1-7])\s+([^\d—\s][^—]*?)\s*(?:—\s*(.*))?$/
// 범위 줄: 기호 a[–b]단계 [남음|끝남] [— 메모]   ← 실기록 "○ 3–7단계 남음"
const STEP_RANGE = /^\s*([✓▶○])\s*([1-7])(?:\s*[–~-]\s*([1-7]))?단계(?:\s*(남음|끝남))?\s*(?:—\s*(.*))?$/
const FLAG = /^\s*⚑\s*(.+)$/
const AFTER = /^\s*그 뒤\s*[:：]\s*(.+)$/

// "확인 필요"가 메모에 있으면 uncertain으로 적는다.
const UNCERTAIN = /확인 필요/

/** 단계 이름 비교 — 공백 무시, `–`/`-`/`~` 같게, `I`/`Ⅰ`·`VI`/`Ⅵ` 같게만 허용한다. */
function normName(s: string): string {
  // 순서가 중요: Ⅲ 같은 글자 위의 Roman을 먼저, 그 다음 I.
  return s
    .replace(/\s+/g, '')
    .replace(/[–—-]/g, '~')
    .replace(/II/g, 'Ⅱ')
    .replace(/III/g, 'Ⅲ')
    .replace(/IV/g, 'Ⅳ')
    .replace(/VI/g, 'Ⅵ')
    .replace(/I/g, 'Ⅰ')
}

export type StepState = 'done' | 'now' | 'todo'

export interface ProgressStep {
  n: number
  state: StepState
  note?: string
  uncertain?: boolean
}

export interface ProgressBlock {
  steps: ProgressStep[]
  flags: string[]
  after: string | null
  reviewPending: boolean
  /** ▶ 중 가장 큰 단계 — 표시 n. 모두 ✓이면 7. */
  n: number
}

export interface ParsedProgress {
  /** 유효 덩어리들 — 순서대로, 상태값은 마지막 덩어리. */
  blocks: ProgressBlock[]
  /** 감출 구간들 — 한 메시지의 모든 유효 덩어리. */
  hide: FoldSpan[]
}

const SYM_TO_STATE: Record<string, StepState> = { '✓': 'done', '▶': 'now', '○': 'todo' }

/** 코드·인용 영역에 걸친 줄 — 덩어리 제목·단계 줄로 보지 않는다. */
function excludedLines(text: string, lineCount: number): Set<number> {
  const out = new Set<number>()
  let tokens
  try {
    tokens = chatMd.parse(text, {})
  } catch {
    return out
  }
  for (const tok of tokens) {
    if (tok.map === null) continue
    const [start, end] = tok.map // [시작 줄, 끝 줄) — 0부터
    if (tok.type === 'fence' || tok.type === 'code_block' || tok.type === 'blockquote_open' || tok.type === 'blockquote_close') {
      for (let i = start; i < end && i < lineCount; i++) out.add(i)
    }
  }
  return out
}

interface OneBlockParse {
  block: ProgressBlock
  titleLine: number
  endLine: number
}

function parseOneBlock(lines: string[], t: number): OneBlockParse | null {
  const tm = lines[t].match(TITLE)
  if (!tm) return null
  if (tm[1] !== '7') return null
  const title: [number, number] = [Number(tm[2]), Number(tm[3] ?? tm[2])]
  const reviewPending = lines[t].includes('독립 내용검토 전')
  // state[n] — n 1..7 (index 0 미사용).
  const state: (StepState | undefined)[] = new Array(8)
  const notes: (string | undefined)[] = new Array(8)
  const flags: string[] = []
  let after: string | null = null
  let end = t // 마지막으로 덩어리에 포함한 줄
  let i = t + 1
  let broke = false
  for (; i < lines.length; i++) {
    const l = lines[i]
    let m: RegExpMatchArray | null
    if ((m = l.match(STEP_RANGE))) {
      const [, sym, a, b, word, note] = m
      if (word === '남음' && sym !== '○') return null
      if (word === '끝남' && sym !== '✓') return null
      const from = Number(a)
      const to = Number(b ?? a)
      if (to < from) return null
      for (let n = from; n <= to; n++) {
        if (state[n] !== undefined) return null // 겹침
        state[n] = SYM_TO_STATE[sym]
        if (note !== undefined) notes[n] = note
      }
      end = i
      continue
    }
    if ((m = l.match(STEP_ONE))) {
      const [, sym, n, name, note] = m
      const idx = Number(n)
      if (normName(name) !== normName(STEP_NAMES[idx - 1])) return null
      if (state[idx] !== undefined) return null
      state[idx] = SYM_TO_STATE[sym]
      if (note !== undefined) notes[idx] = note
      end = i
      continue
    }
    if ((m = l.match(FLAG))) {
      flags.push(m[1])
      end = i
      continue
    }
    if ((m = l.match(AFTER))) {
      after = m[1]
      end = i
      i++
      break
    }
    break // 넷 다 아닌 줄 — 그 직전에서 끝낸다.
  }
  void broke
  // 유효 조건 ①: 범위를 펼쳐 1..7이 빠짐없이 한 번씩 정해진다.
  for (let n = 1; n <= 7; n++) if (state[n] === undefined) return null
  const nowList = [1, 2, 3, 4, 5, 6, 7].filter((n) => state[n] === 'now')
  // 유효 조건 ②: ▶ 하나 이상이거나 모두 ✓.
  if (nowList.length === 0 && ![1, 2, 3, 4, 5, 6, 7].every((n) => state[n] === 'done')) return null
  // 유효 조건 ③: 제목 [a–b]가 ▶ 최소~최대와 같다(모두 ✓이면 비교하지 않음).
  if (nowList.length > 0 && (nowList[0] !== title[0] || nowList[nowList.length - 1] !== title[1])) return null
  const steps: ProgressStep[] = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const step: ProgressStep = { n, state: state[n]! }
    if (notes[n] !== undefined) step.note = notes[n]
    if (notes[n] !== undefined && UNCERTAIN.test(notes[n]!)) step.uncertain = true
    return step
  })
  const n = nowList.length ? nowList[nowList.length - 1] : 7
  return {
    block: { steps, flags, after, reviewPending, n },
    titleLine: t,
    endLine: end,
  }
}

/**
 * 한 메시지 글에서 유효 진행 덩어리를 모두 읽는다.
 * 코드 영역(``` · ~~~ · 4칸 들여쓰기)·인용에 걸친 줄은 제외한다.
 */
export function parseProgress(text: string): ParsedProgress {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\*\*|__/g, ''))
  const excluded = excludedLines(text, lines.length)
  const blocks: ProgressBlock[] = []
  const hide: FoldSpan[] = []
  let i = 0
  while (i < lines.length) {
    if (excluded.has(i)) {
      i++
      continue
    }
    if (!TITLE.test(lines[i])) {
      i++
      continue
    }
    // 제목 줄 자체가 제외 줄이면 덩어리를 시작하지 않는다.
    const parsed = parseOneBlock(lines, i)
    if (!parsed) {
      i++
      continue
    }
    // 덩어리 줄 안에 제외 줄이 걸치면 — 덩어리는 성립하지 않는다.
    let clean = true
    for (let k = i; k <= parsed.endLine; k++) if (excluded.has(k)) { clean = false; break }
    if (!clean) {
      i++
      continue
    }
    blocks.push(parsed.block)
    const last = parsed.endLine
    const extraBlank = lines[last + 1] === '' ? 1 : 0
    hide.push({ start: parsed.titleLine, end: last + extraBlank })
    i = last + 1 + extraBlank
  }
  return { blocks, hide }
}

/** 감출 구간들만 — 대화 본문에서 진행 덩어리를 걷어 낼 때 쓴다. */
export function progressHide(text: string): FoldSpan[] {
  return parseProgress(text).hide
}

/**
 * 구간들을 원문 줄 번호 기준으로 합친다 — 겹침·맞닿음 정리.
 * `chat-fold.ts` 의 `stripLines` 입력으로 그대로 준다.
 */
export function mergeFoldSpans(spans: readonly FoldSpan[]): FoldSpan[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: FoldSpan[] = [{ ...sorted[0] }]
  for (let k = 1; k < sorted.length; k++) {
    const last = out[out.length - 1]
    const cur = sorted[k]
    if (cur.start <= last.end + 1) last.end = Math.max(last.end, cur.end)
    else out.push({ ...cur })
  }
  return out
}

export interface ProgressPick {
  block: ProgressBlock
  messageId: string
  provider: Provider
  /** 메시지의 원문 시간(ISO) — 저장값과의 새것 비교용. */
  at: string
}

/**
 * 대화 스냅샷 전체에서 마지막 유효 진행 값을 고른다.
 * 목록 없는 답은 건너뛴다(유지). 마지막 유효 덩어리 한 개만 돌려준다.
 */
export function lastValidProgress(
  messages: readonly ChatMessage[],
  provider: Provider,
): ProgressPick | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const { blocks } = parseProgress(m.text)
    if (blocks.length === 0) continue
    return { block: blocks[blocks.length - 1], messageId: m.id, provider, at: m.at }
  }
  return null
}

// ---------------------------------------------------------------------------
// 고르기 — 저장값(localStorage)과 대화 값 중 새것을 고른다(IMPL-T1 §3-3).
// `useProgress`의 순수 부분 — node 시험 S1~S6이 이 함수로 잠근다.
// ---------------------------------------------------------------------------

export interface StoredProgress extends ProgressPick {}

/** 깨진 저장값 등 — 검증 실패를 하나의 모양으로 돌려준다. */
export type PickResult =
  | { kind: 'conversation'; pick: ProgressPick }
  | { kind: 'stored'; pick: StoredProgress }
  | { kind: 'none' }

function isStoredProgress(v: unknown): v is StoredProgress {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.messageId !== 'string' || o.messageId === '') return false
  if (o.provider !== 'codex' && o.provider !== 'claude') return false
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return false
  if (typeof o.block !== 'object' || o.block === null) return false
  const b = o.block as Record<string, unknown>
  if (typeof b.n !== 'number' || !Number.isInteger(b.n) || b.n < 1 || b.n > 7) return false
  if (!Array.isArray(b.steps) || b.steps.length !== 7) return false
  if (!Array.isArray(b.flags)) return false
  // flags 원소는 전부 글자여야 한다 — 객체가 들어가면 StageMenu 렌더에서 React 예외.
  if (!b.flags.every((f) => typeof f === 'string')) return false
  if (typeof b.reviewPending !== 'boolean') return false
  if (typeof b.after !== 'string' && b.after !== null) return false
  // n 1..7 빠짐없이 한 번씩, 오름차순으로 와야 한다.
  const seen = new Set<number>()
  for (const s of b.steps as unknown[]) {
    if (typeof s !== 'object' || s === null) return false
    const step = s as Record<string, unknown>
    if (typeof step.n !== 'number' || !Number.isInteger(step.n) || step.n < 1 || step.n > 7) return false
    if (seen.has(step.n)) return false
    seen.add(step.n)
    if (step.state !== 'done' && step.state !== 'now' && step.state !== 'todo') return false
    if (step.note !== undefined && typeof step.note !== 'string') return false
    if (step.uncertain !== undefined && typeof step.uncertain !== 'boolean') return false
  }
  for (let i = 0; i < 7; i++) {
    const step = (b.steps as Record<string, unknown>[])[i]
    if (step.n !== i + 1) return false
  }
  // ▶ 하나 이상이거나 모두 ✓, n은 ▶ 중 최대(모두 ✓이면 7)여야 한다.
  const states = (b.steps as { state: string }[]).map((s) => s.state)
  const nowList = states.map((s, i) => (s === 'now' ? i + 1 : 0)).filter((x) => x > 0)
  const allDone = states.every((s) => s === 'done')
  if (nowList.length === 0 && !allDone) return false
  const expectedN = nowList.length ? nowList[nowList.length - 1] : 7
  if (b.n !== expectedN) return false
  return true
}

/**
 * 저장값을 JSON 글자에서 읽는다. 깨졌으면 `null` — 호출자는 지우고 "시작 전"으로 간다.
 */
export function parseStoredProgress(raw: string | null): StoredProgress | null {
  if (raw === null || raw === '') return null
  try {
    const v = JSON.parse(raw)
    return isStoredProgress(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 대화 값과 저장값 중 새것을 고른다.
 * - `snapshotRoot !== root` — 스냅샷은 읽지도 저장하지도 않는다(저장값만).
 * - 대화 값이 더 늦을 때만 저장값을 덮는다(덮는 건 훅 몫 — 여기서 고른 값만 돌려준다).
 * - 시각 동률 — messageId·provider 둘 다 같을 때만 대화 값, 하나라도 다르면 저장값.
 */
export function pickProgress(
  conv: ProgressPick | null,
  stored: StoredProgress | null,
  snapshotRoot: string | null,
  root: string | null,
): PickResult {
  if (root === null || root === '') return { kind: 'none' }
  if (snapshotRoot !== root) {
    return stored ? { kind: 'stored', pick: stored } : { kind: 'none' }
  }
  if (conv === null && stored === null) return { kind: 'none' }
  if (conv === null) return { kind: 'stored', pick: stored! }
  if (stored === null) return { kind: 'conversation', pick: conv }
  const convAt = Date.parse(conv.at)
  const storedAt = Date.parse(stored.at)
  const convTime = Number.isFinite(convAt) ? convAt : 0
  const storedTime = Number.isFinite(storedAt) ? storedAt : 0
  if (convTime > storedTime) return { kind: 'conversation', pick: conv }
  if (convTime < storedTime) return { kind: 'stored', pick: stored }
  // 동률.
  if (conv.messageId === stored.messageId && conv.provider === stored.provider) {
    return { kind: 'conversation', pick: conv }
  }
  return { kind: 'stored', pick: stored }
}
