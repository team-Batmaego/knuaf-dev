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

function allMatches(re: RegExp, text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length })
    if (m[0] === '') re.lastIndex += 1
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

/**
 * 선택 글자 → 그 문단 원고 안의 구간. 여러 번 맞으면 `renderedBefore` 에서 센 횟수로
 * k번째를 고른다(설계 §4-1 3). 렌더 글자와 원고에서 맞는 총 횟수가 다르면 거절한다.
 */
export function locateSelection(input: SelectionInput): Result<Located> {
  const blocks = splitBlocks(input.draft)
  const block = blocks[input.blockIndex]
  if (block === undefined) return { ok: false, reason: 'block_missing' }
  const text = input.selectionText.trim()
  if (!text) return { ok: false, reason: 'not_located' }
  const re = patternOf(text)
  const here = allMatches(re, block)
  if (here.length === 0) return { ok: false, reason: 'not_located' }
  const rendered = allMatches(re, input.renderedBlock)
  if (rendered.length !== here.length) return { ok: false, reason: 'ambiguous' }
  const occurrence = allMatches(re, input.renderedBefore).length
  const hit = here[occurrence]
  if (hit === undefined) return { ok: false, reason: 'ambiguous' }
  return { ok: true, before_block: block, start: hit.start, end: hit.end, occurrence }
}

/**
 * 선택 구간을 고친 글자로 바꾼 **문단 전체의 전·후**. 화면은 이 둘만 보낸다 —
 * sidecar 가 위치를 다시 계산하지 않게 한다(설계 §4-1 5).
 */
export function replaceInBlock(input: SelectionInput & { replacement: string }): Result<{ before_block: string; after_block: string }> {
  const found = locateSelection(input)
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
