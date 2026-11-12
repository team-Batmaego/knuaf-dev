import MarkdownIt from 'markdown-it'
import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'

/**
 * 종이 칸 마크다운 렌더 (IMPL-PLAN §4-2, DESIGN §1-1).
 *
 * 재무 표가 있어 렌더러가 필요하다. 결과는 **앱이 만든 태그만** 남는다:
 * - `html: false` — 도우미가 쓴 문자열이 그대로 마크업이 되지 않는다(원문 `<script>` 등은 글자로 남는다).
 * - `linkify: false` — 맨 주소를 링크로 만들지 않는다.
 * - 링크는 **열지 않는다**(GUI-12). `[글](주소)` 는 `글` 만 남기고 앵커를 만들지 않는다.
 * - 이미지도 그리지 않는다 — 종이 칸이 원격 주소를 부르면 "앱은 그 밖 어디에도 보내지
 *   않아요"라는 안내(PRIVACY_NOTE)가 사실이 아니게 된다. alt 글자만 남긴다.
 *
 * 어디로도 이동하지 않는 정적 글이라 이 셋을 끄는 것이 기능 손실이 아니다.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false })

md.renderer.rules.link_open = () => ''
md.renderer.rules.link_close = () => ''
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content
  return alt ? `${md.utils.escapeHtml(alt)} ` : ''
}

/**
 * 본문 속 HTML 표(`<table>…</table>`) — 병합 칸(rowspan·colspan)은 마크다운 표로 못 써서
 * 원문 HTML 로 들어온다. **`html: true` 로 열지 않는다**: 표 블록만 골라 아래 허용 목록으로
 * **다시 짓는다**(원문 태그를 그대로 붙여넣는 길 없음). 허용 밖 태그·속성·주석·굽은 따옴표·
 * 짝 안 맞는 태그가 하나라도 있으면 그 블록 통째로 지금처럼 글자로 남긴다(실패 닫힘).
 */
const TABLE_TAGS: Record<string, true> = {
  table: true, caption: true, thead: true, tbody: true, tfoot: true, tr: true, th: true, td: true, br: true
}
/** 부모 → 그 안에 올 수 있는 태그. 여기 없는 조합은 실패다. */
const TABLE_KIDS: Record<string, Record<string, true>> = {
  table: { caption: true, thead: true, tbody: true, tfoot: true, tr: true },
  caption: { br: true },
  thead: { tr: true },
  tbody: { tr: true },
  tfoot: { tr: true },
  tr: { th: true, td: true },
  th: { br: true },
  td: { br: true }
}
const NO_KIDS: Record<string, true> = {}
const CELLS: Record<string, true> = { th: true, td: true }
/** 표 구조 사이의 글자는 공백뿐이어야 한다(줄바꿈·들여쓰기). 그 밖의 글자는 실패. */
const STRUCTURAL: Record<string, true> = { '': true, table: true, thead: true, tbody: true, tfoot: true, tr: true }

/**
 * `<table…>…</table>` 원문 한 덩이 → 앱이 다시 지은 표 HTML. 하나라도 허용 밖이면 `null`.
 * 칸 글자는 이스케이프만 한다 — 바꾸거나 쪼개지 않는다(뷰어 B 의 `GGEDITV…` 표식이 글자
 * 노드로 남아야 한다).
 */
function rebuildTable(src: string): string | null {
  const out: string[] = []
  const stack: string[] = []
  const parentOf = (): string => (stack.length ? stack[stack.length - 1] : '')
  const pushText = (text: string): boolean => {
    const parent = parentOf()
    if (STRUCTURAL[parent] === true) {
      if (text.trim() !== '') return false
      out.push(text)
    } else {
      out.push(md.utils.escapeHtml(text))
    }
    return true
  }

  let i = 0
  let sawTable = false
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) return pushText(src.slice(i)) ? out.join('') : null
    if (lt > i && !pushText(src.slice(i, lt))) return null
    const rest = src.slice(lt)
    // 주석·선언·처리 지시는 쓰지 않는다.
    if (rest.startsWith('<!') || rest.startsWith('<?')) return null

    const end = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/.exec(rest)
    if (end) {
      const name = end[1].toLowerCase()
      if (name === 'br' || stack[stack.length - 1] !== name) return null
      stack.pop()
      out.push(`</${name}>`)
      i = lt + end[0].length
      continue
    }

    const start = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(rest)
    if (!start) return null
    const name = start[1].toLowerCase()
    if (TABLE_TAGS[name] !== true) return null

    let j = start[0].length
    let selfClosing = false
    const attrs: Array<[string, string]> = []
    for (;;) {
      while (j < rest.length && /\s/.test(rest[j])) j++
      if (j >= rest.length) return null
      if (rest[j] === '>') { j++; break }
      if (rest[j] === '/' && rest[j + 1] === '>') { selfClosing = true; j += 2; break }
      // 속성은 th·td 의 rowspan·colspan 만, 곧은 따옴표(또는 따옴표 없음) 1~99 정수.
      if (CELLS[name] !== true) return null
      const attr = /^(rowspan|colspan)=("?)(\d{1,2})\2/.exec(rest.slice(j))
      if (!attr) return null
      const key = attr[1].toLowerCase()
      const value = Number(attr[3])
      if (attrs.some(([k]) => k === key) || value < 1 || value > 99) return null
      attrs.push([key, String(value)])
      j += attr[0].length
    }
    if (name === 'br') {
      if ((TABLE_KIDS[parentOf()] ?? NO_KIDS)['br'] !== true) return null
      out.push('<br>')
      i = lt + j
      continue
    }
    if (selfClosing) return null
    if (name === 'table') {
      if (parentOf() !== '' || sawTable) return null
      sawTable = true
    } else if ((TABLE_KIDS[parentOf()] ?? NO_KIDS)[name] !== true) {
      return null
    }
    out.push(`<${name}${attrs.map(([k, v]) => ` ${k}="${v}"`).join('')}>`)
    stack.push(name)
    i = lt + j
  }
  return sawTable && stack.length === 0 ? out.join('') : null
}

/** `<table` 로 시작한 줄부터 그 표를 닫는 줄까지. 닫는 줄 뒤에 다른 글이 있으면 표가 아니다. */
function tableSource(state: StateBlock, startLine: number, endLine: number): { src: string, next: number } | null {
  for (let line = startLine; line < endLine; line++) {
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
    const at = text.toLowerCase().indexOf('</table')
    if (at < 0) continue
    if (!/^<\/table\s*>\s*$/i.test(text.slice(at))) return null
    return { src: state.getLines(startLine, line + 1, state.blkIndent, false), next: line + 1 }
  }
  return null
}

/**
 * 표 블록 규칙 — 문단보다 먼저 돈다. 다시 짓지 못하면 `false` 를 돌려주고, 그러면 문단·글자
 * 경로가 지금처럼 원문을 이스케이프해 그린다(실패 닫힘). `silent`(문단 종료 판정)에는
 * 토큰을 넣지 않고 표 시작 여부만 알린다.
 */
const paperHtmlTable: RuleBlock = (state, startLine, endLine, silent) => {
  const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine])
  if (!/^<table(?=[\s>])/i.test(first)) return false
  const found = tableSource(state, startLine, endLine)
  const html = found ? rebuildTable(found.src) : null
  if (!found || html === null) return false
  if (silent) return true
  const token = state.push('paper_html_table', '', 0)
  token.map = [startLine, found.next]
  token.content = html
  state.line = found.next
  return true
}

md.block.ruler.before('paragraph', 'paper_html_table', paperHtmlTable, {
  alt: ['paragraph', 'reference', 'blockquote']
})
md.renderer.rules.paper_html_table = (tokens, idx) => tokens[idx].content

/** 마크다운 원문 → 앱이 만든 태그. 빈 원문은 빈 문자열. */
export function renderMarkdown(text: string): string {
  return text.trim() ? md.render(text) : ''
}
