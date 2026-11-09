import { createElement, Fragment, type ReactNode } from 'react'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * 도우미 답변의 마크다운 — 표·제목·목록·코드·인용을 글자 대신 그린다(형님 맥 2026-11-09:
 * `###`·`| 표 |`·`[t](url)`·`- 목록`·`` `코드` `` 가 날 글자로 보였다).
 *
 * 결과는 **앱이 만든 React 요소만** 남는다. `markdown.ts`(종이 칸)와 같은 안전 설정을 쓴다:
 * - `html: false` — 도우미가 쓴 문자열이 마크업이 되지 않는다(`<script>` 는 글자로 남는다).
 * - `linkify: false` — 맨 주소를 저절로 링크로 만들지 않는다.
 * - `typographer: false` — 따옴표·하이픈을 몰래 바꾸지 않는다.
 * - `breaks: true` — 답변의 줄바꿈을 그대로 살린다(지금 `.prose` 의 `pre-wrap` 과 같은 뜻).
 * - 이미지는 alt 글자만 — 앱이 원격 주소를 부르면 PRIVACY_NOTE 가 사실이 아니게 된다.
 *
 * 파일 링크는 `Chat.tsx` 의 `withLinks` 와 같은 규칙을 이 파일 안에 다시 둔다(그 파일은 다른
 * 워커 소유라 손대지 않는다). 누르면 `onFile(상대경로)` 이고, 화면 이동 표식은
 * `data-focus-key="chat-link:<messageId>:<relative>"` 로 같다.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false })

/** 프로젝트 안 상대경로처럼 생긴 것만. 주소(http:)·절대경로·.. 는 제외한다. */
const INSIDE_PATH = /^(?![/\\]|[a-zA-Z][a-zA-Z0-9+.-]*:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/

interface ParsedLink { start: number; end: number; label: string; target: string }

/** 대괄호 링크 하나를 읽는다. `<...>` 경로의 공백·괄호와 보통 괄호 안 경로를 받아들인다. */
function parseLinkAt(text: string, start: number): ParsedLink | null {
  const labelEnd = text.indexOf(']', start + 1)
  if (labelEnd < 0 || text.slice(start, labelEnd).includes('\n') || text[labelEnd + 1] !== '(') return null
  let i = labelEnd + 2
  let target = ''
  if (text[i] === '<') {
    const targetStart = ++i
    while (i < text.length && text[i] !== '>' && text[i] !== '\n') i++
    if (text[i] !== '>') return null
    target = text.slice(targetStart, i++)
    while (i < text.length && /\s/.test(text[i]) && text[i] !== '\n') i++
    if (text[i] !== ')') return null
  } else {
    const targetStart = i
    // Windows plain targets end at the first `)`. An opening `(` or trailing
    // separator makes that boundary ambiguous: preserve the source, or use `<...>`.
    const windowsAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(text.slice(i))
    let depth = 0
    let escaped = false
    while (i < text.length && text[i] !== '\n') {
      const ch = text[i]
      if (escaped) { escaped = false; i++; continue }
      if (windowsAbsolute && (ch === '(' || (ch === ')' && text[i - 1] === '\\'))) return null
      if (ch === '\\' && !windowsAbsolute) { escaped = true; i++; continue }
      if (ch === '(') { depth++; i++; continue }
      if (ch === ')') {
        if (depth === 0) break
        depth--; i++; continue
      }
      i++
    }
    if (text[i] !== ')') return null
    target = text.slice(targetStart, i)
  }
  return { start, end: i + 1, label: text.slice(start + 1, labelEnd), target }
}

function markdownLinks(text: string): ParsedLink[] {
  const links: ParsedLink[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('[', cursor)
    if (start < 0) break
    const link = parseLinkAt(text, start)
    if (link) { links.push(link); cursor = link.end }
    else cursor = start + 1
  }
  return links
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[/\\]{2}|[/\\])/.test(path)
}

function decoded(target: string): string {
  try { return decodeURIComponent(target) } catch { return target }
}

/** 프로젝트 안 절대경로만 상대경로로 바꾼다. 밖으로 빠지는 `..` 경로는 그대로 둔다. */
function relativeProjectPath(target: string, root: string | null): string | null {
  const text = decoded(target)
  if (!isAbsolutePath(text)) return INSIDE_PATH.test(text) ? text : null
  if (!root) return null
  const rootPath = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const targetPath = text.replace(/\\/g, '/')
  const insensitive = typeof window !== 'undefined' && window.knuaf?.platform === 'win32'
  const compare = (value: string): string => insensitive ? value.toLocaleLowerCase('en-US') : value
  const rootKey = compare(rootPath)
  const targetKey = compare(targetPath)
  if (targetKey === rootKey) return '.'
  if (!targetKey.startsWith(`${rootKey}/`)) return null
  const relative = targetPath.slice(rootPath.length + 1)
  const parts: string[] = []
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(segment)
  }
  return parts.join('/') || null
}

interface Context { root: string | null; messageId: string; onFile?: (relative: string) => void; keys: { n: number } }

/** 같은 부모 안에서 자리 키가 겹치지 않게 — 같은 글 토큰 여럿이 링크를 하나씩 가질 수 있다. */
const nextKey = (ctx: Context, prefix: string): string => `${prefix}${ctx.keys.n++}`

function basename(relative: string): string {
  return relative.split('/').at(-1) || relative
}

/** 링크 하나 → 파일 단추(프로젝트 안 경로) 또는 `null`(그 밖). */
function fileLinkNode(link: ParsedLink, ctx: Context, key: string): ReactNode {
  const relative = relativeProjectPath(link.target, ctx.root)
  if (relative === null) return null
  const base = basename(relative)
  const label = isAbsolutePath(link.label) ? base : (link.label || base || relative)
  if (!ctx.onFile) return label
  return createElement('button', {
    key,
    className: 'lk',
    'data-focus-key': `chat-link:${ctx.messageId}:${relative}`,
    title: isAbsolutePath(link.target) ? decoded(link.target) : undefined,
    onClick: () => ctx.onFile?.(relative)
  }, label)
}

/** 마크다운 파서가 놓친 파일 링크(경로에 빈칸이 있는 보통 괄호 형태)를 글자 토큰에서 줍는다. */
function pushText(out: ReactNode[], text: string, ctx: Context): void {
  if (!text) return
  const links = markdownLinks(text)
  if (!links.length) { out.push(text); return }
  let last = 0
  for (const link of links) {
    const node = fileLinkNode(link, ctx, nextKey(ctx, 'f'))
    if (node === null) continue
    out.push(text.slice(last, link.start), node)
    last = link.end
  }
  out.push(text.slice(last))
}

/** 열린 토큰과 짝이 맞는 닫는 토큰의 위치. truncate 된 원문이면 끝까지를 안쪽으로 본다. */
function groupEnd(tokens: Token[], i: number): number {
  const open = tokens[i].type
  const close = `${open.slice(0, -'_open'.length)}_close`
  let depth = 0
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].type === open) depth++
    else if (tokens[j].type === close) {
      depth--
      if (depth === 0) return j
    }
  }
  return tokens.length - 1
}

function textOf(tokens: Token[]): string {
  let out = ''
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') out += token.content
    else if (token.children) out += textOf(token.children)
  }
  return out
}

/**
 * 링크 하나를 그린다.
 * - 프로젝트 안 파일: 누를 수 있는 단추(파일 이름).
 * - http/https: 앱에 외부 브라우저 통로가 아직 없어 앵커를 만들지 않는다. 주소는 **지우지 않고**
 *   `글 (주소)` 로 남긴다 — 학생이 무엇을 눌렀어야 하는지 볼 수 있어야 한다(GUI-12).
 * - 그 밖(javascript: 등): 링크 없이 글자만.
 */
function linkNode(token: Token, inner: Token[], ctx: Context, key: string): ReactNode {
  const href = token.attrGet('href') ?? ''
  const target = decoded(href)
  const relative = relativeProjectPath(href, ctx.root)
  if (relative !== null) {
    const labelText = textOf(inner)
    const base = basename(relative)
    const label = isAbsolutePath(labelText) ? base : (labelText || base || relative)
    if (!ctx.onFile) return createElement(Fragment, { key }, ...renderInline(inner, ctx))
    return createElement('button', {
      key,
      className: 'lk',
      'data-focus-key': `chat-link:${ctx.messageId}:${relative}`,
      title: isAbsolutePath(target) ? target : undefined,
      onClick: () => ctx.onFile?.(relative)
    }, label)
  }
  const nodes = renderInline(inner, ctx)
  if (/^https?:\/\//i.test(target) && textOf(inner) !== target)
    nodes.push(' ', createElement('span', { key: `${key}-url`, className: 'chat-md-url' }, target))
  return createElement(Fragment, { key }, ...nodes)
}

function renderInline(tokens: Token[], ctx: Context): ReactNode[] {
  const out: ReactNode[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    switch (token.type) {
      case 'text': pushText(out, token.content, ctx); break
      case 'softbreak':
      case 'hardbreak': out.push(createElement('br', { key: `br${i}` })); break
      case 'code_inline': out.push(createElement('code', { key: `c${i}`, className: 'chat-md-code' }, token.content)); break
      case 'image': out.push(createElement('span', { key: `i${i}`, className: 'chat-md-alt' }, token.content)); break
      case 'strong_open':
      case 'em_open':
      case 's_open': {
        const end = groupEnd(tokens, i)
        const tag = token.type === 'strong_open' ? 'strong' : token.type === 'em_open' ? 'em' : 'del'
        out.push(createElement(tag, { key: `e${i}` }, ...renderInline(tokens.slice(i + 1, end), ctx)))
        i = end
        break
      }
      case 'link_open': {
        const end = groupEnd(tokens, i)
        out.push(linkNode(token, tokens.slice(i + 1, end), ctx, `l${i}`))
        i = end
        break
      }
      default: break
    }
  }
  return out
}

interface Frame { tag: string | null; props: Record<string, unknown>; children: ReactNode[] }

function alignProps(token: Token): Record<string, unknown> {
  const style = token.attrGet('style')
  const align = style ? /text-align:\s*(left|right|center)/.exec(style)?.[1] : undefined
  return align ? { style: { textAlign: align } } : {}
}

function fenceNode(token: Token, key: string): ReactNode {
  const lang = (token.info ?? '').trim().split(/\s+/)[0]
  return createElement('pre', { key, className: 'chat-md-pre' },
    createElement('code', lang ? { className: `language-${lang}` } : null, token.content.replace(/\n$/, '')))
}

function renderBlocks(tokens: Token[], ctx: Context): ReactNode[] {
  const root: ReactNode[] = []
  const stack: Frame[] = [{ tag: null, props: {}, children: root }]
  let seq = 0
  const top = (): Frame => stack[stack.length - 1]
  const add = (node: ReactNode): void => { top().children.push(node) }
  const open = (tag: string | null, props: Record<string, unknown> = {}): void => { stack.push({ tag, props, children: [] }) }
  const close = (): void => {
    const frame = stack.pop() ?? { tag: null, props: {}, children: [] }
    if (frame.tag === null) top().children.push(...frame.children)
    else top().children.push(createElement(frame.tag, { ...frame.props, key: `b${seq++}` }, ...frame.children))
  }

  for (const token of tokens) {
    switch (token.type) {
      // List items and tight paragraphs carry the same text; a hidden paragraph must not add a block.
      case 'paragraph_open': open(token.hidden ? null : 'p'); break
      case 'heading_open': open(token.tag || 'p'); break
      case 'bullet_list_open': open('ul'); break
      case 'ordered_list_open': {
        const start = Number(token.attrGet('start') ?? '1')
        open('ol', start > 1 ? { start } : {})
        break
      }
      case 'list_item_open': open('li'); break
      case 'blockquote_open': open('blockquote'); break
      case 'table_open': open('div', { className: 'chat-md-table' }); open('table'); break
      case 'thead_open': open('thead'); break
      case 'tbody_open': open('tbody'); break
      case 'tr_open': open('tr'); break
      case 'th_open': open('th', alignProps(token)); break
      case 'td_open': open('td', alignProps(token)); break
      case 'inline': for (const node of renderInline(token.children ?? [], ctx)) add(node); break
      case 'fence': case 'code_block': add(fenceNode(token, `b${seq++}`)); break
      case 'hr': add(createElement('hr', { key: `b${seq++}` })); break
      case 'paragraph_close':
      case 'heading_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'blockquote_close':
      case 'thead_close':
      case 'tbody_close':
      case 'tr_close':
      case 'th_close':
      case 'td_close': close(); break
      case 'table_close': close(); close(); break
      default: break
    }
  }
  // 잘린 원문(2000자 접기·접힌 줄)에서 열린 채 끝났으면 그 안까지는 그린다.
  while (stack.length > 1) close()
  return root
}

/** 도우미 답변 마크다운 → React 요소. 발주서의 부품 인터페이스 그대로다. */
export function ChatMarkdown(props: { text: string; root: string | null; messageId: string; onFile?: (relative: string) => void }): ReactNode {
  const tokens = props.text.trim() ? md.parse(props.text, {}) : []
  const ctx: Context = { root: props.root, messageId: props.messageId, onFile: props.onFile, keys: { n: 0 } }
  return createElement('div', { className: 'chat-md' }, ...renderBlocks(tokens, ctx))
}
