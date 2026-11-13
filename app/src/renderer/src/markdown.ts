import MarkdownIt from 'markdown-it'
import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import { encodeImageSrc, localImagePath } from '../../shared/paper-image'

/**
 * 종이 칸 마크다운 렌더 (IMPL-PLAN §4-2, DESIGN §1-1).
 *
 * 재무 표가 있어 렌더러가 필요하다. 결과는 **앱이 만든 태그만** 남는다:
 * - `html: false` — 도우미가 쓴 문자열이 그대로 마크업이 되지 않는다(원문 `<script>` 등은 글자로 남는다).
 * - `linkify: false` — 맨 주소를 링크로 만들지 않는다.
 * - 링크는 **열지 않는다**(GUI-12). `[글](주소)` 는 `글` 만 남기고 앵커를 만들지 않는다.
 * - 그림은 **논문 폴더 안 상대 경로만** 그린다. 원격·`file:`·`data:`·`//host`·절대 경로는 지금처럼
 *   alt 글자만 남긴다 — 종이 칸이 인터넷 주소를 부르면 "앱은 그 밖 어디에도 보내지 않아요"
 *   (PRIVACY_NOTE)가 사실이 아니게 된다.
 *
 * 그림 주소는 여기서 **만들기만** 한다(`knuaf-img://paper/<상대 경로>`). 실제 파일 읽기·폴더 안 판정은
 * main이 한다(`main/paper-images/`) — 렌더러는 경로를 열 수 없고, 동기 렌더 계약도 그대로다.
 *
 * 어디로도 이동하지 않는 정적 글이라 이 셋을 끄는 것이 기능 손실이 아니다.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false })

md.renderer.rules.link_open = () => ''
md.renderer.rules.link_close = () => ''
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]
  const alt = token.content
  const rel = localImagePath(token.attrGet('src'))
  // 폴더 안 상대 경로가 아니면(원격·다른 스킴·`..`·절대 경로) alt 글자만 — 지금까지의 동작 그대로.
  if (!rel) return alt ? `${md.utils.escapeHtml(alt)} ` : ''
  return `<img src="${md.utils.escapeHtml(encodeImageSrc(rel))}" alt="${md.utils.escapeHtml(alt)}">`
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

/** 칸 글자에서 되돌릴 엔티티 — kordoc 이 칸 글자를 `escapeHtml` 해 내보내기 때문이다(실측 4.17.1·4.24.66). */
const CELL_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0'
}

/**
 * 칸 글자의 정해진 엔티티만 되돌린다(`R&amp;D` → `R&D`). 여기 없는 `&…;` 는 글자 그대로 둔다.
 * 한 번만 훑으므로 `&amp;lt;` 는 `&lt;` 에서 멈춘다(두 번 풀지 않는다). 되돌린 글자는 곧바로
 * 다시 이스케이프하므로 마크업이 될 길은 없고, 영숫자 표식(`GGEDITV…`)은 애초에 해당 없다.
 */
function decodeCellEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|nbsp);/g, (all: string, name: string) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X'
      const code = parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all
      return String.fromCodePoint(code)
    }
    return CELL_ENTITIES[name] ?? all
  })
}

/**
 * `<table…>…</table>` 원문 한 덩이 → 앱이 다시 지은 표 HTML. 하나라도 허용 밖이면 `null`.
 * 칸 글자는 이스케이프만 한다 — 바꾸거나 쪼개지 않는다(뷰어 B 의 `GGEDITV…` 표식이 글자
 * 노드로 남아야 한다). 다만 kordoc 이 이미 이스케이프해 둔 엔티티는 한 번 되돌린 뒤 다시
 * 이스케이프한다(안 그러면 `R&amp;D` 가 화면에 `R&amp;D` 로 보인다).
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
      out.push(md.utils.escapeHtml(decodeCellEntities(text)))
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

/**
 * 표 후보 탐색 결과 — 닫는 줄을 찾음(`table`) / 표가 아님(`none`, 기존 문단 경로).
 * 닫는 줄을 찾았는데 다시 짓지 못하면 호출자가 그 범위를 글자 한 덩이로 소비한다.
 */
type TableSpan =
  | { kind: 'table', src: string, next: number }
  | { kind: 'none' }

/**
 * 이미 훑어 본 구간 — `from`~`until` 줄에서 시작한 탐색은 표가 아니라고 알고 있다.
 * - 닫는 줄을 못 찾고 문서 끝까지 갔으면 `until` 이 마지막 줄,
 * - 코드 펜스나 닫는 줄이 아닌 `</table` 에서 멈췄으면 `until` 이 그 줄이다. 그 줄 앞줄들은
 *   전부 계속 훑기였으므로, 그 사이 어느 줄에서 시작해도 같은 줄에서 멈춘다.
 * `endLimit` 은 그 결론을 얻은 훑기 범위의 끝이다. 더 넓은 범위(바깥 블록)에서는 닫는 줄이
 * 뒤에 있을 수 있으므로 재사용하지 않는다.
 * (검토 I-02: `<table>` 줄이 반복될 때 재탐색이 제곱으로 늘어 16,000줄이 9.5초 걸렸다.)
 * 파싱 하나가 StateBlock 하나를 쓰므로 이 기억도 파싱 하나짜리다.
 */
const exhaustedSearch = new WeakMap<StateBlock, { from: number, until: number, endLimit: number }>()

/**
 * `<table` 로 시작한 줄부터 그 표를 닫는 줄까지. 닫는 줄 뒤에 다른 글이 있으면 표가 아니다.
 * 후보 안에 코드 펜스 시작 줄이 있으면 표가 아니다 — 펜스 안의 `</table>` 를 표 끝으로 쓰지
 * 않는다(검토 R-01). 찾은 범위를 다시 짓는 일은 호출자가 한다.
 *
 * `silent`(문단 종료 판정)에서도 같은 탐색을 한다 — 그 반복이 곧 재탐색이므로 기억을 쓴다.
 */
function tableSource(state: StateBlock, startLine: number, endLine: number): TableSpan {
  const seen = exhaustedSearch.get(state)
  if (seen && startLine >= seen.from && startLine <= seen.until && endLine <= seen.endLimit) return { kind: 'none' }
  for (let line = startLine; line < endLine; line++) {
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
    if (/^(`{3,}|~{3,})/.test(text)) return giveUp(state, startLine, line, endLine)
    const at = text.toLowerCase().indexOf('</table')
    if (at < 0) continue
    if (!/^<\/table\s*>\s*$/i.test(text.slice(at))) return giveUp(state, startLine, line, endLine)
    return { kind: 'table', src: state.getLines(startLine, line + 1, state.blkIndent, false), next: line + 1 }
  }
  // 여기까지 왔으면 이 시작 줄 뒤에는 닫는 줄이 없다 — 뒤 시작 줄도 마찬가지다.
  return giveUp(state, startLine, endLine - 1, endLine)
}

/** `from`~`until` 줄에서 시작하면 표가 아니라는 사실을 기억하고 표 아님을 돌려준다. */
function giveUp(state: StateBlock, from: number, until: number, endLimit: number): TableSpan {
  const seen = exhaustedSearch.get(state)
  const joins = seen !== undefined && endLimit <= seen.endLimit && from <= seen.until + 1 && until >= seen.from
  exhaustedSearch.set(state, joins
    ? { from: Math.min(from, seen.from), until: Math.max(until, seen.until), endLimit: seen.endLimit }
    : { from, until, endLimit })
  return { kind: 'none' }
}

/**
 * 다시 짓지 못한 표 후보 한 덩이 → 글자 한 덩이. 안쪽 줄을 다시 표 후보로 해석하지 않는다
 * (검토 I-01: 여러 줄 중첩 표의 안쪽 표가 실제 표로 살아남았다).
 *
 * 문단 경로와 같은 인라인 규칙을 쓴다 — `R&amp;D`·`*강조*`·`[링크](…)` 가 기준(81458e3)과
 * 똑같이 보이고, 링크·이미지는 이미 앱 규칙이 글자만 남긴다.
 */
function textBlock(src: string): string {
  return `<p>${md.renderInline(src)}</p>\n`
}

/**
 * 표 블록 규칙 — 문단보다 먼저 돈다. `rebuildTable` 이 성공하면 표 HTML 을 낸다.
 *
 * 표 후보 범위(`<table` ~ `</table>`)를 찾았는데 다시 짓지 못하면 **그 범위 전체를 이스케이프한
 * 글자 한 덩이로 소비**한다 — 실패 닫힘이면서 안쪽 줄이 다시 표 후보로 해석되지 않는다
 * (검토 I-01: 여러 줄 중첩 표의 안쪽 표가 실제 표로 살아남았다). 닫는 줄이 아예 없거나 후보
 * 안에 코드 펜스가 있으면 표가 아니므로 `false` — 기존 문단·글자 경로가 그린다(검토 R-01).
 * `silent`(문단 종료 판정)에는 토큰을 넣지 않고 블록 시작 여부만 알린다.
 */
const paperHtmlTable: RuleBlock = (state, startLine, endLine, silent) => {
  const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine])
  if (!/^<table(?=[\s>])/i.test(first)) return false
  const found = tableSource(state, startLine, endLine)
  if (found.kind === 'none') return false
  const html = rebuildTable(found.src)
  if (silent) return true
  const token = state.push('paper_html_table', '', 0)
  token.map = [startLine, found.next]
  token.content = html ?? textBlock(found.src)
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
