import { useEffect, useState } from 'react'
import { renderAsync, type HElement } from 'docx-preview'
import { PREVIEW } from '../copy'

const TAGS: Record<string, true> = {
  div: true, p: true, span: true, table: true, thead: true, tbody: true, tr: true, td: true, th: true,
  colgroup: true, col: true, img: true, a: true, br: true, sup: true, sub: true, ol: true, ul: true,
  li: true, section: true, header: true, footer: true, article: true, style: true
}
const ATTRS: Record<string, true> = { class: true, style: true, colspan: true, rowspan: true, lang: true, id: true }
const PLACEHOLDER_TAGS: Record<string, true> = { svg: true, math: true, img: true, iframe: true, object: true, embed: true }
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
const IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i

function cleanCss(css: string): string {
  return css.replace(/@import\b[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, '').replace(/</g, '\\3c ')
}
function imageDataUrl(value: string): string | null {
  if (IMAGE.test(value)) return value
  const match = /^data:application\/octet-stream;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  if (!match) return null
  const encoded = match[1]
  const mime = encoded.startsWith('iVBORw0KGgo') ? 'image/png'
    : encoded.startsWith('/9j/') ? 'image/jpeg'
      : encoded.startsWith('R0lGOD') ? 'image/gif' : null
  return mime ? `data:${mime};base64,${encoded}` : null
}


function placeholder(doc: Document): HTMLElement {
  const node = doc.createElement('span')
  node.className = 'preview-unavailable-content'
  node.textContent = '□'
  return node
}

function sanitize(root: ParentNode, doc: Document): number {
  let unsupported = 0
  const visit = (node: Element): void => {
    for (const child of Array.from(node.children)) visit(child)
    const tag = node.tagName.toLowerCase()
    if (!TAGS[tag]) {
      if (PLACEHOLDER_TAGS[tag]) {
        node.replaceWith(placeholder(doc))
        unsupported++
      } else node.remove()
      return
    }
    if (tag === 'a') {
      const span = doc.createElement('span')
      span.className = node.getAttribute('class') ?? ''
      while (node.firstChild) span.append(node.firstChild)
      node.replaceWith(span)
      return
    }
    for (const attr of Array.from(node.attributes)) {
      const key = attr.name.toLowerCase()
      if (!ATTRS[key] && !(tag === 'img' && key === 'src')) node.removeAttribute(attr.name)
      else if (key === 'style') node.setAttribute('style', cleanCss(attr.value))
    }
    if (tag === 'style') node.textContent = cleanCss(node.textContent ?? '')
    if (tag === 'img') {
      const src = imageDataUrl(node.getAttribute('src') ?? '')
      if (src) node.setAttribute('src', src)
      else {
        node.replaceWith(placeholder(doc))
        unsupported++
      }
    }
  }
  for (const child of Array.from(root.children)) visit(child)
  return unsupported
}

function srcdocFrom(body: string, css: string): string {
  return `<!doctype html><html lang="ko"><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="UTF-8"><style>${css}</style><style>html,body{height:100%;margin:0}body{overflow:auto}.preview-unavailable-content{display:inline-block;min-width:1.5em;min-height:1.5em;text-align:center}</style></head><body>${body}</body></html>`
}

export function DocxHtmlView({ bytes, onFailed }: { bytes: Uint8Array; onFailed: (message: string) => void }) {
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  useEffect(() => {
    let dead = false
    setSrcdoc(null)
    setUnsupported(false)
    void (async () => {
      try {
        const inert = document.implementation.createHTMLDocument('DOCX preview')
        const body = inert.createElement('div')
        const styles = inert.createElement('div')
        const makeNode = (value: HElement | Node | string): Node => {
          if (typeof value === 'string') return inert.createTextNode(value)
          if (value instanceof Node) return value.ownerDocument === inert ? value : inert.importNode(value, true)
          if (value.tagName === '#fragment') {
            const fragment = inert.createDocumentFragment()
            for (const child of value.children ?? []) fragment.append(makeNode(child))
            return fragment
          }
          if (value.tagName === '#comment') return inert.createTextNode('')
          const node = value.ns && value.ns !== 'http://www.w3.org/1999/xhtml'
            ? inert.createElementNS(value.ns, value.tagName)
            : inert.createElement(value.tagName)
          if (value.className) node.setAttribute('class', value.className)
          if (typeof value.style === 'string') node.setAttribute('style', value.style)
          else if (value.style) Object.assign((node as HTMLElement).style, value.style)
          for (const [key, prop] of Object.entries(value)) {
            if (['ns', 'tagName', 'className', 'style', 'children'].includes(key) || prop == null) continue
            if (['href', 'src', 'alt', 'colSpan', 'rowSpan', 'lang', 'id'].includes(key)) node.setAttribute(key.toLowerCase(), String(prop))
          }
          for (const child of value.children ?? []) node.append(makeNode(child))
          return node
        }
        await renderAsync(bytes, body, styles, {
          inWrapper: false,
          useBase64URL: true,
          renderAltChunks: false,
          experimental: false,
          h: makeNode
        })
        let unsupportedCount = sanitize(body, inert)
        unsupportedCount += sanitize(styles, inert)
        const firstCss = Array.from(styles.querySelectorAll('style')).map((el) => cleanCss(el.textContent ?? '')).join('\n')
        const first = srcdocFrom(body.innerHTML, firstCss)
        const parsed = new DOMParser().parseFromString(first, 'text/html')
        unsupportedCount += sanitize(parsed.body, parsed)
        unsupportedCount += sanitize(parsed.head, parsed)
        const css = Array.from(parsed.head.querySelectorAll('style')).map((el) => cleanCss(el.textContent ?? '')).join('\n')
        const final = srcdocFrom(parsed.body.innerHTML, css)
        if (!dead) { setUnsupported(unsupportedCount > 0); setSrcdoc(final) }
      } catch (error) {
        if (!dead) onFailed(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { dead = true }
  }, [bytes, onFailed])

  if (!srcdoc) return <p className="caption">문서를 불러오는 중…</p>
  return (
    <div>
      <p className="caption">{PREVIEW.docxHtmlCaption}</p>
      {unsupported && <p className="caption">앱 안에서 못 보여 주는 그림·수식이 있어요. 정확한 모양은 "원래 앱으로 열기"로 보세요.</p>}
      <iframe className="docx-preview-frame" sandbox="" referrerPolicy="no-referrer" srcDoc={srcdoc} title="DOCX 미리보기" />
    </div>
  )
}
