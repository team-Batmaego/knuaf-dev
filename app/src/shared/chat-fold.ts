import type { ChatMessage } from './chat'

/**
 * 대화 화면의 **표시 전용** 접기 계산.
 *
 * 도우미는 한 턴(=학생 말 한 번 뒤 ~ 다음 학생 말 전)에 assistant 말을 여러 번 보낸다 —
 * 실기록(`chat-claude.json` 12건)에서 6~10번이 형님이 지적한 혼잣말이고 11번이 최종 답이다
 * (HANDOFF-FOLD-p80 §①). 그 앞말들을 한 줄로 접는 것이 Claude·Codex 앱과 같은 모양이다.
 *
 * 여기서는 **카드 파서(`question.ts`·`question-form.ts`)를 건드리지 않는다.** 질문 카드가 이미
 * 읽은 원문의 줄 범위만 다시 세어 표시에서 감춘다 — 파서 결과가 화면 접기 사정으로 흔들리면
 * 카드가 뜨는 조건 자체가 달라진다.
 *
 * 화면이 받는 대화 스냅샷에는 턴 id가 없다(`service.ts` 는 id가 있으면 갱신·없으면 덧붙임).
 * 그래서 턴 경계는 학생 메시지로만 잡는다 — 공급자(claude·codex)와 무관하게 같은 규칙이다.
 */

export interface ProgressGroup {
  key: string
  /** 이 묶음이 대화에서 서는 시각(첫 접힌 말). */
  at: number
  count: number
  messages: ChatMessage[]
  ids: ReadonlySet<string>
}

/**
 * 접을 중간말 묶음들. 규칙:
 *  - 학생 말 뒤에 온 assistant 말만 묶는다. 대화 첫머리(첫 학생 말 전)는 묶지 않는다 —
 *    시작 안내는 학생이 실제로 보내기 전까지 화면의 유일한 설명이다.
 *  - 그 턴의 **마지막 assistant 말은 최종 답**이라 늘 편다. 질문 카드가 읽는 말도 그 말이다
 *    (`zoneOf` 는 뒤에 학생 말이 없는 마지막 assistant 만 카드로 본다) — 그래서 카드와 겹치지 않는다.
 */
export function progressGroups(messages: readonly ChatMessage[]): ProgressGroup[] {
  const out: ProgressGroup[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role !== 'user') { i++; continue }
    let next = i + 1
    while (next < messages.length && messages[next].role !== 'user') next++
    let last = -1
    for (let k = next - 1; k > i; k--) if (messages[k].role === 'assistant') { last = k; break }
    if (last > i) {
      const hidden: ChatMessage[] = []
      for (let k = i + 1; k < last; k++) {
        const m = messages[k]
        if (m.role === 'assistant') hidden.push(m)
      }
      if (hidden.length) {
        out.push({
          key: `fold-${hidden[0].id}`, at: Date.parse(hidden[0].at) || 0,
          count: hidden.length, messages: hidden, ids: new Set(hidden.map((m) => m.id))
        })
      }
    }
    i = next
  }
  return out
}

export interface FoldSpan { start: number; end: number }
export interface FormFold { spans: FoldSpan[]; count: number }

/** `[Qn] 제목` — `question-form.ts` 가 읽는 머리 줄과 같은 모양(굵게 표시는 걷어 낸다). */
const HEADER = /^\s*\[Q\d+(?:-\d+)?\]\s*\S/
/** `question-form.ts` 와 같은 규칙 — **마침표만** 인정한다(`2)` 는 파서가 거부한다). */
const FIELD = /^\s*(\d+)\.\s*\S/

/** 이어진 줄 번호들을 `{start,end}` 구간으로 묶는다. */
function coalesce(lines: number[]): FoldSpan[] {
  const out: FoldSpan[] = []
  for (const line of lines) {
    const last = out.at(-1)
    if (last && line === last.end + 1) last.end = line
    else out.push({ start: line, end: line })
  }
  return out
}

/**
 * 여러 칸 질문 카드가 이미 아래 칸에 보여 주는 원문 줄 — **머리 줄과 번호 칸 블록만**.
 *
 * 카드(`QuestionForm`)는 제목·칸 이름·설명·예시·미정 안내를 그린다. 그래서 원문에서는 그
 * 칸 블록(`1. …` + 들여 쓴 딸린 줄)만 감춘다. 머리 줄 앞뒤의 설명 문장은 카드에 없으므로
 * **남긴다** — 접기가 글을 버리지 않는다는 규칙이 여기에도 걸린다.
 *
 * `parseQuestionForm` 이 읽는 형식(연속 번호 + 들여쓴 딸린 줄)과 같은 규칙만 인정하고, 어긋나면
 * `null` — 카드가 뜨지 않는 원문에서는 부르지 않는다.
 */
export function formFold(text: string): FormFold | null {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\*\*|__/g, ''))
  let header = -1
  for (let i = lines.length - 1; i >= 0; i--) if (HEADER.test(lines[i])) { header = i; break }
  if (header < 0) return null
  const hide: number[] = [header]
  let fields = 0
  let inField = false
  let ended = false
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]
    if (HEADER.test(line)) return null
    const numbered = line.match(FIELD)
    if (numbered) {
      if (ended || numbered[1] !== String(fields + 1) || fields === 6) return null
      fields++
      inField = true
      hide.push(i)
      continue
    }
    if (!line.trim()) {
      // 빈 줄은 칸 블록 안이면 함께 감추고, 블록이 끝난 뒤면 남긴다.
      if (inField) hide.push(i)
      continue
    }
    // 번호 칸이 아직 시작되지 않았으면 들여쓰기 없는 줄은 머리 줄 설명이다 — 남긴다.
    if (!/^\s/.test(line)) { if (fields) { ended = true; inField = false } continue }
    if (!inField || ended) continue
    hide.push(i)
  }
  return fields >= 2 ? { spans: coalesce(hide), count: fields } : null
}

/** 접을 구간들을 원문에서 걷어 낸 글. 구간은 0부터 세는 줄 번호다. */
export function stripLines(text: string, spans: readonly FoldSpan[]): string {
  if (!spans.length) return text
  const drop = new Set<number>()
  for (const s of spans) for (let i = s.start; i <= s.end; i++) drop.add(i)
  return text.split('\n').filter((_, i) => !drop.has(i)).join('\n')
}

/**
 * 긴 답을 자를 자리 — 2,000자 한도가 표·문단 한가운데를 가르지 않게 **블록 경계**에서 자른다.
 *
 * 후보는 셋이다: ① 빈 줄(문단 사이) ② 표 밖 줄 끝 ③ **표의 완전한 행 끝**. 그중 한도에 가장 가까운
 * 것을 쓴다. ③ 이 필요한 이유: 한도가 표 한가운데에 걸리면 ①②는 표 **앞**에 있어 답의 대부분을
 * 잃는데, 행 끝에서 자르면 머리 줄·구분 줄이 살아 표가 온전히 그려지고 나머지는 "더 보기"에 있다.
 * 후보가 모두 한도의 60%보다 앞이면(블록 하나가 통째로 길다) 한도에서 자른다.
 */
export function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text
  const floor = Math.floor(limit * 0.6)
  const rows = text.split('\n')
  let fence: string | null = null
  let pos = 0
  let blank = -1
  let line = -1
  let rowEnd = -1
  for (const [i, row] of rows.entries()) {
    const next = pos + row.length
    const marker = /^\s*(`{3,}|~{3,})/.exec(row)?.[1]
    const fenced = fence !== null
    if (marker) {
      if (fence === null) fence = marker[0]
      else if (marker[0] === fence) fence = null
    }
    const inFence = fenced || fence !== null
    const tableRow = !inFence && /^\s*\|/.test(row)
    if (pos > limit) break
    if (next <= limit) {
      if (tableRow) rowEnd = next
      else if (inFence) { /* 펜스 안쪽은 자를 자리가 아니다 */ }
      else if (!row.trim()) blank = pos
      else line = next
    }
    pos = next + (i < rows.length - 1 ? 1 : 0)
  }
  const at = Math.max(blank, line, rowEnd)
  return text.slice(0, at >= floor ? at : limit)
}
