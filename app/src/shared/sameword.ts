/**
 * 뷰어 직접 수정 — 같은 낱말 찾기 (설계 §3-4, 정제 2-3).
 *
 * 학생이 낱말을 바꾸거나 지우면, 앱이 **이미 읽어 둔** 전체 본문에서 같은 낱말을 찾아
 * `다른 곳에도 'OO'가 N군데 있어요` 를 띄운다. AI 호출·토큰 0. 뜻은 모른다 — 글자만 본다.
 *
 * 지켜야 하는 세 가지(정제 2-3):
 *  1. 조사만 고친 경우(`트랙터를`→`트랙터가`)는 "사라진 낱말"이 아니다 → 고친 뒤 글에 그대로
 *     남아 있는 낱말은 후보에서 뺀다.
 *  2. 코드 펜스·HTML 주석·링크/이미지 주소·수식 안은 세지도 바꾸지도 않는다.
 *  3. 남은 낱말 중 다른 곳에 1~20군데 있는 것만, 드문 것부터 최대 3개.
 *
 * 순수 함수만 둔다 — `e2e/sameword.spec.ts` 가 Node 단위로 잠근다.
 */
import { splitBlocks } from './paper'

export interface SectionDraft {
  id: string
  /** 그 절의 DRAFT 구획(`section.read`의 `draft`). */
  draft: string
  /** 장 제목 — 목록이 '어느 장인지'를 보여 준다(§4-5-8 03). 없어도 찾기·바꾸기는 된다. */
  title?: string
}

/** 사라진 낱말 하나와 그 자리에 새로 들어간 낱말(지움이면 빈 문자열). */
export interface WordPair {
  from: string
  to: string
}

/** 같은 낱말이 다른 곳에 나타난 자리 하나. */
export interface Place {
  section_id: string
  block_index: number
  before_block: string
  start: number
  end: number
  /** 목록 한 줄에 보일 앞뒤 글 — 낱말 좌우 20자. */
  context: string
}

export interface Suggestion {
  from: string
  to: string
  count: number
  places: Place[]
}

/** `section.edit_batch` 에 그대로 넣는 원소. */
export interface BatchEdit {
  section_id: string
  before_block: string
  after_block: string
}

/** 흔한 조사 — 낱말 끝에서 떼어 본다. 긴 것부터(으로 > 로). */
const PARTICLES = ['으로', '에서', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만']

/** 낱말 양끝의 문장부호(`.`,`,`,`"`,`…`,`)` 등)를 뗀다 — 조사 떼기 전에 한 번. */
function trimEdges(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * 낱말 하나를 찾을 수 있는 형태로 — 양끝 문장부호와 흔한 조사를 뗀다.
 * `트랙터를,` → `트랙터`. 찾기·바꾸기·생존 판정이 모두 이 함수를 거친다.
 */
export function wordOf(raw: string): string {
  return stripParticle(trimEdges(raw))
}

export function stripParticle(word: string): string {
  const sorted = [...PARTICLES].sort((a, b) => b.length - a.length)
  for (const particle of sorted) {
    if (word.length > particle.length && word.endsWith(particle)) return word.slice(0, -particle.length)
  }
  return word
}

/**
 * 후보 자격: 조사를 뗀 뒤 2글자 이상이고 **숫자가 섞이지 않은** 것.
 *
 * 숫자가 들어간 낱말(`600평`, `3,000원`)은 수치라서 "같은 말"로 묶어 일괄 치환하면 값이
 * 조용히 바뀐다 — 수치 변경은 저장 판정(`needs_check`)이 따로 잡는다.
 */
export function isWordCandidate(raw: string): boolean {
  const word = wordOf(raw)
  return word.length >= 2 && !/\d/.test(word)
}

/** 앞뒤에서 겹치는 글자를 뗀 최소 치환 쌍 — `changed_chars` 계산과 같은 경계를 쓴다. */
export function changedSpans(before: string, after: string): { removed: string; added: string } {
  let head = 0
  const limit = Math.min(before.length, after.length)
  while (head < limit && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  return {
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail)
  }
}

/** 공백 기준 낱말. 문장부호는 그대로 붙은 채로 두고 조사만 뗀다(뜻을 모르기 때문). */
function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/**
 * 고치기 전·후 문단에서 **사라진 낱말**만 뽑는다.
 *
 * 조사만 바뀐 경우(`트랙터를`→`트랙터가`)는 고친 뒤 글에 `트랙터`가 남아 있으므로 빠진다.
 * 같은 낱말이 그 밖에도 남아 있는 경우도 "사라진" 것이 아니므로 빠진다 — 다른 자리를
 * 모두 고치라고 하면 이미 맞는 문장까지 건드리게 된다.
 */
export function vanishedWordPairs(beforeBlock: string, afterBlock: string): WordPair[] {
  const { removed, added } = changedSpans(beforeBlock, afterBlock)
  if (!removed.trim()) return []
  const oldWords = wordsOf(removed)
  const newWords = wordsOf(added)
  const survivors = new Set(wordsOf(afterBlock).map(wordOf))
  const out: WordPair[] = []
  oldWords.forEach((raw, i) => {
    if (!isWordCandidate(raw)) return
    const from = wordOf(raw)
    if (survivors.has(from)) return
    const replacement = newWords[i] === undefined ? '' : wordOf(newWords[i])
    if (replacement === from) return
    if (out.some((p) => p.from === from)) return
    out.push({ from, to: isWordCandidate(newWords[i] ?? '') ? replacement : '' })
  })
  return out
}

/**
 * `](` 다음의 괄호 짝이 맞는 구간 — 중첩 괄호를 세어 찾는다.
 *
 * `\(`·`\)` 는 **괄호가 아니라 글자**다(CommonMark 의 백슬래시 escape). escape 를 깊이에
 * 넣으면 주소를 일찍 닫거나 통째로 못 닫아 주소 속 낱말이 본문으로 새어 나간다(D6).
 * 짝이 안 맞으면 그 주소는 끝을 모르므로 줄 끝까지 숨긴다 — 애매하면 안 세는 쪽(§4-5-4).
 */
function linkDestinations(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const opener = /\]\(/g
  let m: RegExpExecArray | null
  while ((m = opener.exec(text)) !== null) {
    const start = m.index + 1
    let depth = 0
    let i = start
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\\') {
        i += 1 // escape 된 다음 글자는 구분자가 아니다
        continue
      }
      if (ch === '\n') break
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          out.push({ start, end: i + 1 })
          opener.lastIndex = i + 1
          break
        }
      }
    }
    if (depth !== 0) {
      out.push({ start, end: i }) // 짝이 안 맞는다 — 줄 끝까지 숨긴다
      opener.lastIndex = i
    }
  }
  return out
}

/**
 * 인라인 코드 자리 — 여는 백틱 묶음과 **길이가 정확히 같은** 묶음만 닫는다(CommonMark).
 *
 * `indexOf(fence)` 는 더 긴 묶음의 일부를 닫이로 잡는다: `` `코드 ``` 트랙터` `` 에서 세
 * 백틱의 첫 한 글자를 닫이로 보면 그 뒤가 본문으로 새어 나간다(D6). 닫이가 없으면 그 묶음은
 * 코드가 아니므로 아무것도 숨기지 않는다.
 */
function inlineCodeSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    let ticks = 0
    while (text[i + ticks] === '`') ticks += 1
    let close = -1
    let j = i + ticks
    while (j < text.length) {
      if (text[j] !== '`') {
        j += 1
        continue
      }
      let run = 0
      while (text[j + run] === '`') run += 1
      if (run === ticks) {
        close = j
        break
      }
      j += run
    }
    if (close === -1) {
      i += ticks
      continue
    }
    out.push({ start: i, end: close + ticks })
    i = close + ticks
  }
  return out
}

/**
 * 본문 글자만 표시한 마스크. `true` 인 자리에서만 낱말을 세고 바꾼다.
 *
 * 마스크 대상: 코드 펜스(``` ~~~)와 인라인 코드(`` `…` ``), HTML 주석, 링크·이미지의 괄호 안
 * 주소, 수식(`$…$`, `$$…$$`).
 */
export function bodyMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true)
  const hide = (start: number, end: number): void => {
    for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) mask[i] = false
  }
  // 코드 펜스 — 여는 줄부터 닫는 줄까지(줄 단위로 통째로).
  let offset = 0
  let fence: string | null = null
  let fenceStart = 0
  for (const line of text.split('\n')) {
    const m = /^\s*(```|~~~)/.exec(line)
    if (m) {
      if (fence === null) {
        fence = m[1]
        fenceStart = offset
      } else if (m[1] === fence) {
        hide(fenceStart, offset + line.length)
        fence = null
      }
    }
    offset += line.length + 1
  }
  if (fence !== null) hide(fenceStart, text.length)
  // 인라인 코드 — 펜스 밖의 `` `…` ``.
  for (const span of inlineCodeSpans(text)) {
    if (mask[span.start]) hide(span.start, span.end)
  }
  // HTML 주석.
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) hide(m.index, m.index + m[0].length)
  // 링크·이미지의 괄호 안 주소: 괄호 짝을 세어 끝을 찾는다 — 주소 안의 `(x)` 같은 괄호에서
  // 멈추면 그 뒤 주소 글자가 본문으로 새어 나온다(Roh 1회째 중요 7).
  for (const at of linkDestinations(text)) hide(at.start, at.end)
  // 수식 — `$$…$$` 를 먼저 지우고 남은 `$…$` 를 지운다.
  const math = /(\$\$[\s\S]*?\$\$)|(\$[^$\n]*\$)/g
  for (const m of text.matchAll(math)) hide(m.index, m.index + m[0].length)
  return mask
}

/** 본문 구간에서만 낱말이 나타난 자리를 센다. 겹치는 자리는 세지 않는다(앞에서부터). */
export function findPlaces(sections: SectionDraft[], word: string): Place[] {
  const out: Place[] = []
  if (!word) return out
  for (const section of sections) {
    splitBlocks(section.draft).forEach((block, blockIndex) => {
      const mask = bodyMask(block)
      for (let i = 0; i + word.length <= block.length; i++) {
        if (block.startsWith(word, i) && mask[i] && mask[i + word.length - 1]) {
          out.push({
            section_id: section.id,
            block_index: blockIndex,
            before_block: block,
            start: i,
            end: i + word.length,
            context: contextOf(block, i, i + word.length)
          })
          i += word.length - 1
        }
      }
    })
  }
  return out
}

function contextOf(block: string, start: number, end: number): string {
  const left = block.slice(Math.max(0, start - 20), start).replace(/\s+/g, ' ')
  const right = block.slice(end, end + 21).replace(/\s+/g, ' ')
  return (left + block.slice(start, end) + right).trim()
}

/**
 * 저장 직후 띄울 후보 — 드문 것부터 최대 3개. 다른 곳에 1곳도 없거나 20곳을 넘으면 뺀다.
 * 순서는 (군데 수, 먼저 나온 자리) 로 고정해 같은 본문이면 늘 같은 줄이 뜬다.
 */
export function sameWordSuggestions(
  sections: SectionDraft[],
  beforeBlock: string,
  afterBlock: string,
  max = 3
): Suggestion[] {
  const rows: Suggestion[] = []
  for (const pair of vanishedWordPairs(beforeBlock, afterBlock)) {
    const places = findPlaces(sections, pair.from)
    if (places.length < 1 || places.length > 20) continue
    rows.push({ from: pair.from, to: pair.to, count: places.length, places })
  }
  return rows.sort((a, b) => a.count - b.count).slice(0, max)
}

/**
 * 체크된 자리들을 `section.edit_batch` 원소로 만든다.
 *
 * 한 문단 안에서 둘 이상을 체크하면 **그 문단의 전·후 한 건으로 합친다**(정제 2-2) —
 * 따로 보내면 첫 치환 뒤 둘째 건의 '고치기 전 문단'이 본문에서 사라져 sidecar 가 거절한다.
 * 치환은 뒤에서부터 해야 앞쪽 자리 색인이 흔들리지 않는다.
 */
export function mergeSameWordPicks(picks: Place[], to: string): BatchEdit[] {
  const groups = new Map<string, Place[]>()
  for (const pick of picks) {
    const key = `${pick.section_id}\u0000${pick.block_index}`
    const list = groups.get(key) ?? []
    list.push(pick)
    groups.set(key, list)
  }
  const out: BatchEdit[] = []
  for (const list of groups.values()) {
    const before = list[0].before_block
    let after = before
    for (const pick of [...list].sort((a, b) => b.start - a.start)) after = after.slice(0, pick.start) + to + after.slice(pick.end)
    out.push({ section_id: list[0].section_id, before_block: before, after_block: after })
  }
  return out
}

/** 전→후 한 줄 미리보기 — 바뀐 가운데와 그 앞뒤 문맥. */
export interface EditPreview {
  /** 바뀐 곳 앞의 같은 글자(잘랐으면 앞에 `…`). */
  lead: string
  removed: string
  added: string
  /** 바뀐 곳 뒤의 같은 글자(잘랐으면 뒤에 `…`). */
  trail: string
}

/**
 * `직접 고친 곳` 목록의 전→후 한 줄 (설계 §3-3, ADD4 1번).
 *
 * 문단 전체를 보여 주면 무엇이 바뀌었는지 학생이 찾아야 한다. 앞뒤에서 같은 글자를 떼어
 * **바뀐 가운데만** 남기고 그 앞뒤로 문맥을 조금만 붙인다.
 *
 * 깨지지 않아야 하는 경우:
 * - 바뀐 곳이 없으면(같은 글) `removed`·`added` 가 비고 문맥만 남는다.
 * - 문단이 통째로 바뀌면 문맥이 비고 전체가 바뀐 글이 된다.
 * - 두 글자 열이 아주 길면 문맥만 `context` 자로 자르고 `…` 를 붙인다.
 */
export function editPreview(before: string, after: string, context = 12): EditPreview {
  // 앞에서 같은 글자 수 — `changedSpans` 와 같은 규칙(공통 접두·접미)이되 자리도 돌려준다.
  const limit = Math.min(before.length, after.length)
  let head = 0
  while (head < limit && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  // 바뀐 **낱말**을 보여 준다 — `600`→`700` 이 `6`→`7` 로 보이면 `6700` 처럼 읽힌다.
  // 바뀐 글자와 **같은 종류**(숫자/글자)인 바로 뒤 글자까지 바뀐 쪽에 넣어 낱말을 통째로 보여
  // 주고, 다른 종류(공백·문장부호·한글↔숫자)에서 멈춘다.
  const kind = (ch: string | undefined): 'd' | 'l' | null =>
    !ch ? null : /[0-9]/.test(ch) ? 'd' : /[A-Za-z가-힣]/.test(ch) ? 'l' : null
  const changedKind = kind(before[head]) ?? kind(after[head])
  let tail2 = tail
  while (tail2 > 0 && changedKind && kind(before[before.length - tail2]) === changedKind) tail2 -= 1
  const removed = before.slice(head, before.length - tail2)
  const added = after.slice(head, after.length - tail2)
  const leadFull = before.slice(0, head)
  const trailFull = before.slice(before.length - tail2)
  return {
    lead: leadFull.length > context ? '…' + leadFull.slice(-context) : leadFull,
    removed,
    added,
    trail: trailFull.length > context ? trailFull.slice(0, context) + '…' : trailFull
  }
}
