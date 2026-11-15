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
 *  - **시스템 줄(`role: 'system'`)은 묶음의 경계다**(검토 Roh v0.6.2 권고1). 알림 하나를 사이에 두고
 *    앞말 A·뒤말 B 가 한 묶음이 되면 묶음이 A 의 시각에 서서, 펼쳤을 때 B 가 알림보다 **먼저** 보인다.
 *    화면은 묶음과 시스템 줄을 각자의 `at` 으로 정렬하므로(`Chat.tsx` `thread.sort`), 경계에서 끊기만
 *    하면 A → 알림 → B 순서가 그대로 선다.
 *  - **종이 사건 줄(`PaperEvent`)도 같은 이유로 경계다**(검토 Roh 1회째 중요2). 사건 줄은 `messages`
 *    가 아니라 `store/project.ts` 에 있어 여기서 읽을 수 없으므로, 화면이 사건들의 시각을
 *    `boundaryAts` 로 넘긴다(`Chat.tsx` 657행). 두 중간말 사이에 그 시각이 있으면(양끝 제외) 끊는다 —
 *    한 묶음이면 묶음이 앞말 시각에 서서 사건이 뒤로 밀린다.
 *
 * 경계 시각이 없으면(기본값) 시스템 줄만으로 끊는다 — 예전 호출부도 그대로 뜻이 통한다.
 */
export function progressGroups(messages: readonly ChatMessage[], boundaryAts: readonly number[] = []): ProgressGroup[] {
  const out: ProgressGroup[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role !== 'user') { i++; continue }
    let next = i + 1
    while (next < messages.length && messages[next].role !== 'user') next++
    let last = -1
    for (let k = next - 1; k > i; k--) if (messages[k].role === 'assistant') { last = k; break }
    if (last > i) {
      // 턴 안을 시스템 줄로 끊어 구간마다 따로 묶는다. 턴의 최종 답(`last`) 앞에 있는 assistant 말은
      // 구간의 마지막 말이라도 중간말이므로 접는다 — 뒤에 시스템 알림이든 더 할 말이 있든 그 말은 답이 아니다.
      let hidden: ChatMessage[] = []
      const flush = (): void => {
        if (!hidden.length) return
        out.push({
          key: `fold-${hidden[0].id}`, at: Date.parse(hidden[0].at) || 0,
          count: hidden.length, messages: hidden, ids: new Set(hidden.map((m) => m.id))
        })
        hidden = []
      }
      for (let k = i + 1; k < last; k++) {
        const m = messages[k]
        if (m.role === 'system') { flush(); continue }
        if (m.role !== 'assistant') continue
        // 바로 앞 대화 줄과 이 중간말 **사이**(양끝 제외)에 사건 시각이 있으면 여기서 끊는다.
        const from = Date.parse(messages[k - 1].at) || 0
        const to = Date.parse(m.at) || 0
        if (boundaryAts.some((b) => b > from && b < to)) flush()
        hidden.push(m)
      }
      flush()
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

/** 잘린 코드 블록 끝에 붙는 표시 — 잘린 조각이 완성된 명령처럼 보이지 않게 한다. */
const MORE = '… 코드가 더 있어요'

/**
 * 여는 펜스 — 앞 들여쓰기 0~3칸, 백틱 3개 이상 또는 물결표 3개 이상.
 * 백틱 펜스의 정보 문자열(` ```bash `)에는 백틱이 올 수 없다(CommonMark).
 */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
/** 닫는 펜스 — 같은 문자, 여는 펜스 **길이 이상**, 뒤에는 공백·탭만(CommonMark). */
const FENCE_CLOSE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/

interface Fence { ch: string; len: number; mark: string; start: number }

/** 이 줄이 여는 펜스면 펜스 문자열을, 아니면 `null`. */
function openFence(row: string): string | null {
  const m = FENCE_OPEN.exec(row)
  if (!m) return null
  if (m[2][0] === '`' && m[3].includes('`')) return null
  return m[2]
}

/** 이 줄이 지금 열린 펜스를 닫는지 — 네 글자 펜스 안의 세 글자 펜스는 닫지 못한다. */
function closesFence(f: Fence, row: string): boolean {
  const m = FENCE_CLOSE.exec(row)
  return !!m && m[2][0] === f.ch && m[2].length >= f.len
}

/**
 * 자른 조각이 원문에서 실제로 덮는 글자 수 — 붙인 표시(`MORE`)와 닫는 펜스는 원문 글자가 아니다.
 * 화면 글은 **원문 접두 + 합성 꼬리**이므로, 접두가 맞을 때까지 꼬리 줄을 덜어 낸다.
 */
function keptChars(text: string, shown: string): number {
  let body = shown.endsWith(MORE) ? shown.slice(0, shown.length - MORE.length) : shown
  while (body && !text.startsWith(body)) body = body.slice(0, Math.max(0, body.lastIndexOf('\n')))
  return body.length
}

/**
 * "N자 더 보기"의 N — **원문 기준** 남은 글자 수(검토 Roh 1회째 권고1). 화면에 붙인 표시는 세지 않는다.
 * 예전에는 `text.length - shown.length` 로 세서, 닫는 펜스·표시를 붙인 만큼 N 이 작게 나왔다.
 */
export function hiddenChars(text: string, shown: string): number {
  return Math.max(0, text.length - keptChars(text, shown))
}

/**
 * 긴 답을 자를 자리 — 2,000자 한도가 표·문단 한가운데를 가르지 않게 **블록 경계**에서 자른다.
 *
 * 후보는 셋이다: ① 빈 줄(문단 사이) ② 표 밖 줄 끝 ③ **표의 완전한 행 끝**. 그중 한도에 가장 가까운
 * 것을 쓴다. ③ 이 필요한 이유: 한도가 표 한가운데에 걸리면 ①②는 표 **앞**에 있어 답의 대부분을
 * 잃는데, 행 끝에서 자르면 머리 줄·구분 줄이 살아 표가 온전히 그려지고 나머지는 "더 보기"에 있다.
 * 후보가 모두 한도의 60%보다 앞이면(블록 하나가 통째로 길다) 한도에서 자른다.
 *
 * 한도가 **펜스(```, ~~~) 안**에 걸리면 한도에서 그냥 자르지 않는다(검토 Roh v0.6.2 권고2) — 그러면
 * 코드 줄이 명령 한가운데서 끊겨 잘린 조각이 멀쩡한 명령처럼 보인다. 대신 펜스 안에서 한도에 맞는
 * **마지막 완전한 코드 줄**까지 남기고, 닫는 펜스와 `… 코드가 더 있어요` 표시를 붙여 잘렸음을 밝힌다.
 * 붙이는 글자까지 한도 안에 들어간다. 한도가 여는 펜스 줄 자체를 가르면(남길 코드 줄이 없다) 펜스
 * 앞에서 자른다 — 반쪽짜리 펜스 줄을 내보내지 않는다. 한도가 코드 줄 경계나 닫는 펜스 줄에 **딱**
 * 닿아도 열린 펜스를 남기지 않는다(닫지 않으면 잘린 조각이 뒤따르는 글로 번진다).
 *
 * 펜스 판정은 CommonMark 규칙 그대로다(검토 Roh 1회째 중요1) — 닫는 펜스는 여는 펜스와 **같은 문자**로
 * **같은 길이 이상**, 뒤에는 공백만. 그래서 네 글자 펜스(````) 안의 세 글자 펜스(```)는 코드일 뿐
 * 닫는 펜스가 아니다. 남길 코드 줄이 **내용 줄**(빈 줄 아님) 하나도 없으면 빈 코드 상자를 만들지 않고
 * 펜스 앞에서 자른다(검토 Roh 1회째 권고2).
 */
export function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text
  const floor = Math.floor(limit * 0.6)
  const rows = text.split('\n')
  let fence: Fence | null = null
  let pos = 0
  let blank = -1
  let line = -1
  let rowEnd = -1
  let cutFence: { mark: string; start: number } | null = null
  let cutFenceRow = -1
  /** 한도가 놓인 자리에서 **열려 있던** 펜스(닫는 펜스 줄에 딱 닿은 경우도 여기로 온다). */
  let fenceAtLimit: { mark: string; start: number } | null = null
  const codeEnds: { end: number; fenceStart: number }[] = []
  for (const [i, row] of rows.entries()) {
    if (pos > limit) break
    const next = pos + row.length
    const open: string | null = fence === null ? openFence(row) : null
    const closes = fence !== null && closesFence(fence, row)
    if (pos < limit && limit < next) {
      if (fence !== null) cutFence = { mark: fence.mark, start: fence.start }
      else if (open) cutFenceRow = pos
    }
    if (open) fence = { ch: open[0], len: open.length, mark: open, start: pos }
    else if (closes) fence = null
    const tableRow = fence === null && /^\s*\|/.test(row)
    if (next <= limit) {
      if (open || closes) { /* 펜스 줄 자체는 자를 자리가 아니다 */ }
      else if (fence !== null) { if (row.trim()) codeEnds.push({ end: next, fenceStart: fence.start }) }
      else if (tableRow) rowEnd = next
      else if (!row.trim()) blank = pos
      else line = next
    }
    pos = next + (i < rows.length - 1 ? 1 : 0)
    if (pos >= limit && fence !== null && !fenceAtLimit) fenceAtLimit = { mark: fence.mark, start: fence.start }
  }
  // 한도가 코드 줄 경계나 닫는 펜스 줄에 **딱** 맞아 위 조건이 안 걸려도, 자른 글이 열린 펜스로
  // 끝나면 안 된다 — 닫지 않으면 잘린 조각이 뒤따르는 글로 번진다.
  if (!cutFence && cutFenceRow < 0 && fenceAtLimit) cutFence = fenceAtLimit
  const at = Math.max(blank, line, rowEnd)
  if (at >= floor) return text.slice(0, at)
  if (cutFence) {
    const suffix = `\n${cutFence.mark}\n${MORE}`
    const budget = limit - suffix.length
    let best = -1
    for (const e of codeEnds) if (e.fenceStart === cutFence.start && e.end <= budget) best = e.end
    if (best > 0) return text.slice(0, best) + suffix
    // 내용 줄이 한 줄도 안 들어간다(코드 한 줄이 한도보다 길거나 첫 줄이 빈 줄이다) — 반쪽 코드 줄도,
    // 빈 펜스도 내보내지 않고 블록 앞까지만 남긴 뒤 잘렸음을 밝힌다.
    const head = text.slice(0, cutFence.start).trimEnd()
    const marked = head ? head + `\n${MORE}` : MORE
    return marked.length <= limit ? marked : head
  }
  if (cutFenceRow >= 0) return text.slice(0, cutFenceRow).trimEnd()
  return text.slice(0, limit)
}
