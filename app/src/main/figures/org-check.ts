/** DESIGN-RDA §3: fail-closed body scope and literal organization marks. */
import { candidateTags } from './candidates'
import type { FigureRule } from './url-rules'
import { sameResource } from './verdict'

export interface BodyRegion {
  start: number
  end: number
  text: string
}

export function bodyRegion(html: string, rule: FigureRule): BodyRegion | null {
  const { bodyStart, bodyEnd } = rule
  if (!bodyStart || !bodyEnd) return null
  const start = html.indexOf(bodyStart)
  const end = html.indexOf(bodyEnd)
  if (start < 0 || end < 0 || html.indexOf(bodyStart, start + bodyStart.length) >= 0 ||
    html.indexOf(bodyEnd, end + bodyEnd.length) >= 0 || start + bodyStart.length > end) return null
  const inside = start + bodyStart.length
  return { start: inside, end, text: html.slice(inside, end) }
}

const ENTITY_NAMES = [
  'lt', 'gt', 'amp', 'quot', 'apos', 'nbsp', 'middot', 'times', 'divide', 'bull', 'hellip', 'ndash', 'mdash',
  'lsquo', 'rsquo', 'ldquo', 'rdquo', 'larr', 'rarr', 'uarr', 'darr', 'deg', 'plusmn'
]
const hangul = (code: number): boolean => code >= 0xac00 && code <= 0xd7a3
const hex = (char: string): boolean => (char >= '0' && char <= '9') ||
  (char >= 'A' && char <= 'F') || (char >= 'a' && char <= 'f')
const symbolCode = (code: number): boolean => (code >= 0xa0 && code <= 0xbf) || code === 0xd7 || code === 0xf7 ||
  (code >= 0x2010 && code <= 0x205e) || (code >= 0x2190 && code <= 0x23ff) ||
  (code >= 0x2460 && code <= 0x249b) || (code >= 0x24ea && code <= 0x24ff) ||
  (code >= 0x2500 && code <= 0x27bf) || (code >= 0x2900 && code <= 0x2bff) || (code >= 0x3000 && code <= 0x303f)
const FENCES = '"\'<>\n\r'
const URL_END = ' \t\n\r"\'<>'

/** No decoding, whitespace folding, Unicode properties, or organization-name guessing. */
export function foreignMarkIn(text: string, rule: FigureRule): boolean {
  if (!rule.orgAliases || !rule.orgTerms || !rule.creditWords || !rule.latinOk) return true
  // ① Every ampersand must begin one of the explicitly permitted symbol references.
  for (let at = text.indexOf('&'); at >= 0; at = text.indexOf('&', at + 1)) {
    if (ENTITY_NAMES.some((name) => text.startsWith(`&${name};`, at))) continue
    if (!text.startsWith('&#', at)) return true
    let end = at + 2
    let value = 0
    while (end < text.length && text[end]! >= '0' && text[end]! <= '9') {
      value = value * 10 + text.charCodeAt(end) - 48
      end += 1
      if (end - at - 2 > 7) return true
    }
    if (end === at + 2 || text[end] !== ';' || !symbolCode(value)) return true
  }
  // ② Modern decomposed Hangul only; U+119E is a permitted bullet.
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    if ((code >= 0x1100 && code <= 0x1112) || (code >= 0x1161 && code <= 0x1175) ||
      (code >= 0x11a8 && code <= 0x11c2)) return true
  }
  // ③ r1.1: erase self-credit only when the entire expression is independently fenced.
  const creditWords: readonly string[] = rule.creditWords
  for (const alias of rule.orgAliases) {
    for (const word of creditWords) {
      const phrases: string[] = [alias + word, `${alias} ${word}`, word + alias, `${word} ${alias}`,
        `${word}:${alias}`, `${word}: ${alias}`, `${word} : ${alias}`]
      for (const phrase of phrases) {
        let from = 0
        for (let at = text.indexOf(phrase, from); at >= 0; at = text.indexOf(phrase, from)) {
          const end = at + phrase.length
          if ((at === 0 || FENCES.includes(text[at - 1]!)) && (end === text.length || FENCES.includes(text[end]!))) {
            text = text.slice(0, at) + ' ' + text.slice(end)
            from = at + 1
          } else from = end
        }
      }
    }
  }
  // ④ Aliases arrive longest first, with equal-length source order preserved.
  for (const alias of rule.orgAliases) {
    let from = 0
    for (let at = text.indexOf(alias, from); at >= 0; at = text.indexOf(alias, from)) {
      if (at > 0 && hangul(text.charCodeAt(at - 1))) return true
      text = text.slice(0, at) + ' ' + text.slice(at + alias.length)
      from = at + 1
    }
  }
  // ⑤ Literal organization forms; ⑥ credits at a non-Hangul ending.
  if (rule.orgTerms.some((term) => text.includes(term))) return true
  for (const word of rule.creditWords) {
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
      if (!hangul(text.charCodeAt(at + word.length))) return true
    }
  }
  // ⑦ Only the acronym scan ignores lowercase-scheme URLs and valid percent triplets.
  let acronymText = ''
  for (let at = 0; at < text.length;) {
    if (text.startsWith('http://', at) || text.startsWith('https://', at)) {
      while (at < text.length && !URL_END.includes(text[at]!)) at += 1
      acronymText += ' '
    } else {
      acronymText += text[at]!
      at += 1
    }
  }
  text = acronymText
  acronymText = ''
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '%' && at + 2 < text.length && hex(text[at + 1]!) && hex(text[at + 2]!)) {
      acronymText += ' '
      at += 2
    } else acronymText += text[at]!
  }
  for (let at = 0; at < acronymText.length;) {
    if (acronymText[at]! < 'A' || acronymText[at]! > 'Z') { at += 1; continue }
    const start = at
    while (at < acronymText.length && acronymText[at]! >= 'A' && acronymText[at]! <= 'Z') at += 1
    if (at - start >= 2 && !rule.latinOk.has(acronymText.slice(start, at))) return true
  }
  return false
}

export function orgReading(html: string, finalImageUrl: string, pageUrl: URL, rule: FigureRule): {
  reading: 'none' | 'hit' | 'unknown'
  text: string | null
} {
  const region = bodyRegion(html, rule)
  if (!region) return { reading: 'unknown', text: null }
  let found = false
  for (const tag of candidateTags(html)) {
    const src = tag.src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
    let href: string
    try { href = new URL(src, pageUrl).href } catch { continue }
    if (!sameResource(href, finalImageUrl)) continue
    found = true
    if (tag.start < region.start || tag.end > region.end) return { reading: 'unknown', text: region.text }
  }
  return { reading: found ? (foreignMarkIn(region.text, rule) ? 'hit' : 'none') : 'unknown', text: region.text }
}
