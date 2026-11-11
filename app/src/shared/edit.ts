/**
 * 뷰어 직접 수정 — 화면 선택 → 원고 문단 전·후 (설계 §4-1).
 *
 * 화면의 선택은 **렌더된** 글자이고 원고는 마크다운이다. 굵게·링크·표 칸 경계를 넘는
 * 선택은 원고 글자와 1:1로 맞지 않으므로, 추측해서 맞추지 않고 **특정 못 하면 거절**한다.
 * 거절은 화면이 `직접 수정` 단추를 흐리게 두는 근거가 된다(설계 §3-1).
 *
 * 순수 함수만 둔다 — `e2e/edit.spec.ts` 가 Node 단위로 잠근다. 화면·IPC 를 모른다.
 */
import { splitBlocks } from './paper'

/** 거절 사유 — 문구는 `copy.ts`(화면 묶음)가 정한다. 여기서는 코드만 낸다. */
export type EditReject =
  /** 선택이 문단 하나를 벗어났거나 문단 번호가 원고와 맞지 않음. */
  | 'block_missing'
  /** 선택 글자가 그 문단의 원고 글자 안에서 한 곳으로 특정되지 않음(굵게·링크·표 경계). */
  | 'not_located'
  /** 같은 글자가 여러 번이라 위치를 하나로 못 정함(렌더 글자 수와 원고 일치 수가 다름). */
  | 'ambiguous'
  /** 고친 글자에 줄바꿈·DRAFT 마커가 들어감. */
  | 'invalid_replacement'
  /** 표 문단인데 고친 글자에 `|` 가 들어감. */
  | 'table_pipe'
  /** 고친 결과 문단이 비었음(설계 §3-2: 결과 문단이 비면 저장 불가). */
  | 'empty_block'
  /** 줄바꿈이 낀 선택인데 그 문단이 순수 문단이 아님(표·목록). */
  | 'multiline_block'

export interface SelectionInput {
  /** 그 절의 DRAFT 구획(`section.read`의 `draft`). */
  draft: string
  /** 선택이 속한 `div.blk` 의 차례(0-based). */
  blockIndex: number
  /** 그 `div.blk` 의 전체 글자(`textContent`). */
  renderedBlock: string
  /** `div.blk` 시작부터 선택 시작까지의 글자(`Range.toString()`). */
  renderedBefore: string
  /** 선택 글자(`Selection.toString()`, 앞뒤 공백은 떼고 쓴다). */
  selectionText: string
}

export type Located = { before_block: string; start: number; end: number; occurrence: number }

type Result<T> = ({ ok: true } & T) | { ok: false; reason: EditReject }

/**
 * 선택 글자를 원고에서 찾는 패턴. **공백 한 덩어리 = 공백류 한 덩어리**로 본다 —
 * 화면의 빈칸 하나가 원고에서는 줄바꿈일 수 있기 때문이다(설계 §4-1 2).
 */
function patternOf(text: string): RegExp {
  const parts = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(parts.join('\\s+'), 'g')
}

/**
 * 겹치는 자리까지 센다 — `가가가` 에서 `가가` 는 0·1 두 자리다.
 *
 * 겹치지 않게 세면(`exec` 반복) 화면에서 두 번째 `가가` 를 골라도 횟수가 0이라 엉뚱한
 * 자리를 고친다(Roh 1회째 중요 6). 찾은 구간 길이는 패턴이 잰 것과 같다.
 */
function allMatches(re: RegExp, text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const scan = new RegExp(re.source, 'g')
  let m: RegExpExecArray | null
  while ((m = scan.exec(text)) !== null) {
    if (m[0] === '') {
      scan.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
    scan.lastIndex = m.index + 1
  }
  return out
}

/** 어느 줄도 `|`·`-`·`*`·`+`·`#`·`>`·`숫자.` 로 시작하지 않는 문단 = 순수 문단. */
export function isPlainParagraph(block: string): boolean {
  return block.split('\n').every((line) => !/^\s*(\||[-*+#>]|\d+\.)/.test(line))
}

/** 한 줄이라도 `|` 로 시작하면 표 문단. */
export function isTableParagraph(block: string): boolean {
  return block.split('\n').some((line) => /^\s*\|/.test(line))
}

/** 고친 글자에 넣을 수 없는 것: 줄바꿈(설계 §3-2), DRAFT 마커(설계 §4-1 4). */
export function replacementViolation(text: string): 'newline' | 'marker' | null {
  if (/[\r\n]/.test(text)) return 'newline'
  if (text.includes('<!-- gg:draft')) return 'marker'
  return null
}

/** 마크다운 블록 → 그려진 HTML. 앱은 `renderMarkdown`, 시험도 같은 것을 넘긴다. */
export type RenderHtml = (markdown: string) => string

/** 그려진 HTML 의 **화면 글자** — `div.blk` 의 `textContent` 와 같은 규칙(태그 없이, 엔티티는 글자로). */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 공백을 전부 뺀 글자 — 표 칸 사이 빈 글자는 브라우저가 버리므로 화면 글자와 원고의 자리가
 * 어긋난다. 공백을 지우면 그 차이만 사라지고 글자 차례는 그대로다(§4-5-8 01, ADD1).
 */
export function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 공백 덩어리를 하나로 — 화면의 빈칸 하나와 원고의 줄바꿈 하나를 같은 것으로 본다(§4-1 2).
 * **앞뒤 공백을 떼지 않는다** — 선택 앞부분(`renderedBefore`)이 빈칸으로 끝나는 것이 곧
 * '낱말 경계에서 골랐다'는 뜻이라, 떼면 경계 비교가 어긋난다.
 */
export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * 후보 구간 하나를 **다시 그려서** 화면 선택과 대응하는지 확인한다(설계 §4-5-8 01).
 *
 * 원고에서 이어진 글자 수와 화면에서 보이는 횟수가 같다는 것만으로는 위치가 맞지 않는다
 * (`가**나** 가나 [x](가나)` — 화면 `가나 가나 x`). 그래서 후보마다 그 구간을 표식 글자로
 * 바꿔 **같은 렌더러로 다시 그리고**, 셋을 모두 만족할 때만 그 후보를 인정한다:
 * ① 표식이 그려진 글자에 정확히 한 번 ② 표식 앞 글자 = 화면 선택의 앞 글자
 * ③ 표식을 선택 글자로 되돌리면 화면 문단 전체와 같다.
 */
/**
 * 표 문단은 다시 그린 글자에 `|` 가 없다(칸으로 나뉜다). 그래서 표는 '칸 경계를 넘지
 * 않았는가'만 본다 — 고른 구간이 한 줄 안이고 그 줄의 `|` 를 건드리지 않으면 인정한다(§4-1 4).
 */
function tableCandidateOk(block: string, hit: { start: number; end: number }): boolean {
  // 그 구간이 속한 줄의 시작·끝.
  const before = block.slice(0, hit.start)
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = block.indexOf('\n', hit.start)
  const end = lineEnd < 0 ? block.length : lineEnd
  if (hit.end > end) return false
  // 줄 안의 `|` 개수를 세어, 고른 구간이 그 `|` 를 포함하지 않는지 본다.
  const line = block.slice(lineStart, end)
  const bars = [...line].map((ch, i) => (ch === '|' ? lineStart + i : -1)).filter((i) => i >= 0)
  return !bars.some((i) => i >= hit.start && i < hit.end)
}

/** 화면 글자 비교에 쓰는 '한 문단' — 표·그림 같은 구조가 있으면 비교를 접는다. */
function candidateMatches(block: string, hit: { start: number; end: number }, input: SelectionInput,
  text: string, marker: string, render: RenderHtml): boolean {
  const marked = block.slice(0, hit.start) + marker + block.slice(hit.end)
  const shown = collapseSpace(htmlToText(render(marked)))
  const at = shown.indexOf(marker)
  if (at < 0) return false
  if (shown.indexOf(marker, at + 1) >= 0) return false // 표식이 둘 이상 — 어느 자리인지 모른다
  // 화면 글자와 견줄 때 **공백을 전부 뺀다.** 마크다운 기호가 빠진 만큼 공백이 접히고, 표는
  // 칸 사이 빈 글자를 브라우저가 버려 원고와 자리가 어긋난다 — 공백을 지우면 그 차이가 사라진다.
  if (squash(shown.slice(0, at)) !== squash(input.renderedBefore)) return false
  const rebuilt = squash(shown.slice(0, at) + text + shown.slice(at + marker.length))
  return rebuilt === squash(input.renderedBlock)
}

/**
 * 선택 글자 → 그 문단 원고 안의 구간. **후보를 다시 그려 확인**한 뒤 정확히 하나일 때만 인정한다
 * (설계 §4-1 3 + §4-5-8 01). 0개(서식·링크 경계를 넘음)나 2개 이상(같은 글자가 여럿)이면 거절한다 —
 * 추측해서 고르면 학생이 고르지 않은 자리가 바뀐다.
 */
export function locateSelection(input: SelectionInput, render: RenderHtml): Result<Located> {
  const blocks = splitBlocks(input.draft)
  const block = blocks[input.blockIndex]
  if (block === undefined) return { ok: false, reason: 'block_missing' }
  const text = input.selectionText.trim()
  if (!text) return { ok: false, reason: 'not_located' }
  const re = patternOf(text)
  const here = allMatches(re, block)
  if (here.length === 0) return { ok: false, reason: 'not_located' }
  // 표식은 마크다운이 건드리지 않는 글자만(영숫자). 원고에 우연히 같은 글자가 있으면 한 번 바꾼다.
  let marker = `GGEDITV${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  while (block.includes(marker)) marker = `GGEDITV${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  // 표도 **다시 그려 확인**을 반드시 거친다(§4-5-8 01 — 표를 예외로 두지 않는다).
  // `tableCandidateOk` 는 그 위에 더하는 조건이다(칸 경계·`|` 를 건드리지 않았는가).
  const accepted = here.filter((hit) => (
    candidateMatches(block, hit, input, text, marker, render)
    && (!isTableParagraph(block) || tableCandidateOk(block, hit))
  ))
  if (accepted.length !== 1) {
    return { ok: false, reason: accepted.length === 0 ? 'not_located' : 'ambiguous' }
  }
  const hit = accepted[0]
  return { ok: true, before_block: block, start: hit.start, end: hit.end, occurrence: here.indexOf(hit) }
}

/**
 * 선택 구간을 고친 글자로 바꾼 **문단 전체의 전·후**. 화면은 이 둘만 보낸다 —
 * sidecar 가 위치를 다시 계산하지 않게 한다(설계 §4-1 5).
 */
export function replaceInBlock(
  input: SelectionInput & { replacement: string }, render: RenderHtml
): Result<{ before_block: string; after_block: string }> {
  const found = locateSelection(input, render)
  if (!found.ok) return found
  const violation = replacementViolation(input.replacement)
  if (violation) return { ok: false, reason: 'invalid_replacement' }
  const span = found.before_block.slice(found.start, found.end)
  const multiline = /[\r\n]/.test(span)
  if (multiline && !isPlainParagraph(found.before_block)) return { ok: false, reason: 'multiline_block' }
  if (isTableParagraph(found.before_block) && input.replacement.includes('|')) return { ok: false, reason: 'table_pipe' }
  const after = found.before_block.slice(0, found.start) + input.replacement + found.before_block.slice(found.end)
  if (!after.trim()) return { ok: false, reason: 'empty_block' }
  return { ok: true, before_block: found.before_block, after_block: after }
}
