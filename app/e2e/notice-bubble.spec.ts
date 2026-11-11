/**
 * 재무 양식 알림 말풍선 — Node 단위 시험(Electron 창 없이).
 *
 * 잠그는 것(발주 1묶음):
 * ① 견본 세 개가 그대로 그려진다 — 한 줄은 `title` **원문 그대로**(앱이 숫자를 조립하지 않는다).
 * ② 닫기 기억 — 같은 열쇠는 다시 안 뜨고, 선택을 해도 열쇠는 그대로다(견본 before/after 가 증명).
 *    새 열쇠(개정)면 다시 뜬다.
 * ③ 선택 단추는 `choices` 가 있고 `choice` 가 null 일 때만, 알림 한 건에 한 번.
 * ④ `items` 가 비면 [자세히] 자체가 없다.
 * ⑤ 폴더 밖 `receipt_path` 는 무시한다.
 * ⑥ 도우미가 쓴 글을 마크다운·링크로 해석하지 않는다(서식 없는 글자).
 * ⑦ main 쪽 읽기 — 없음·깨짐·스키마 다름은 전부 "알림 없음"이고 던지지 않는다.
 * ⑧ 훅 상태는 **알림 열쇠에 묶인다** — 같은 자리에 새 알림을 갈아 끼워도 앞 알림의 잠금·늦은 실패가
 *    새 알림에 얹히지 않는다(1심 검토 지적).
 * ⑨ 동기 throw 도 비동기 거절과 **같은 실패 경로**로 온다 — 단추가 돌아오고 실패 줄이 뜬다.
 * ⑩ 경계는 문자열이 아니라 **실제 경로**다 — 폴더 안 심볼릭 링크로 밖을 가리키는 `receipt_path` 와
 *    알림 파일 자체가 밖을 가리키는 링크는 둘 다 버린다(main 이 판정).
 */
import { expect, test } from '@playwright/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { runInNewContext } from 'node:vm'
import { readNotices, noticeFilePath } from '../src/main/notices'
import {
  firstVisible, noticeKey, noticeVisible, readNoticeDocument, receiptPathInside, type NoticeRow
} from '../src/shared/notice'

/**
 * Playwright 의 Node 변환기는 `src/**` 의 JSX 를 **시험용 런타임**(`playwright/jsx-runtime`,
 * `{ __pw_type: 'jsx' }`)으로 바꾼다. React 는 그 객체를 그리지 못하므로("Objects are not valid as a
 * React child") 이 시험은 React 런타임으로 직접 변환해 부른다 — `e2e/claude-auth.spec.ts:66` 의
 * `rowHtml` 과 같은 이유·같은 수법이다. 거기서는 JSX 를 품은 자식 부품이 없어 한 겹으로 끝났지만,
 * 말풍선은 `Icon`·`shared/notice` 를 따라가므로 `require` 까지 갈아 끼운다.
 */
const real = createRequire(__filename)
const loaded = new Map<string, Record<string, unknown>>()

function loadTsx(file: string): Record<string, unknown> {
  const seen = loaded.get(file)
  if (seen) return seen
  const js = transpileModule(readFileSync(file, 'utf-8'), { compilerOptions: {
    jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  const dir = dirname(file)
  const req = (name: string): unknown => {
    if (!name.startsWith('.')) return real(name)
    const base = resolve(dir, name)
    for (const ext of ['.ts', '.tsx']) if (existsSync(base + ext)) return loadTsx(base + ext)
    for (const ext of ['.ts', '.tsx']) if (existsSync(join(base, 'index' + ext))) return loadTsx(join(base, 'index' + ext))
    throw new Error('부품을 찾지 못했다: ' + base)
  }
  runInNewContext(js, { exports: mod.exports, require: req, module: mod, __filename: file, __dirname: dir })
  loaded.set(file, mod.exports)
  return mod.exports
}

function componentOf(exports: Record<string, unknown>, name: string): BubbleComponent {
  const found = exports[name]
  if (typeof found !== 'function') throw new Error(`${name} 를 부품 파일에서 찾지 못했다`)
  return found as BubbleComponent
}

const NoticeBubble = componentOf(loadTsx(resolve(__dirname, '../src/renderer/src/components/NoticeBubble.tsx')), 'NoticeBubble')

// 견본은 knuaf-doc 책임자가 만든 합성 값 그대로다(모양을 지어내지 않는다). resolveJsonModule 이
// 꺼져 있어 JSON import 대신 읽어서 파싱한다 — 스펙은 typecheck 대상이 아니지만 한 가지 경로만 쓴다.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/notices', name), 'utf-8'))
const fruit = fixture('fruit-fy1.json')
const hortBefore = fixture('hort-same-project-before.json')
const hortAfter = fixture('hort-same-project-after.json')

const ROOT = '/Users/student/논문'

function document(raw: unknown): NoticeRow[] {
  return readNoticeDocument(raw, ROOT).notices
}

function one(raw: unknown): NoticeRow {
  const rows = document(raw)
  expect(rows).toHaveLength(1)
  return rows[0]
}

interface Paint {
  onDismiss?: (key: string) => void
  onChoose?: (value: string) => void
  onFootnote?: () => void
  forceOpen?: boolean
}

/**
 * 변환해 불러온 부품의 모양. `createElement` 는 함수 컴포넌트를 받으므로 여기서만 단언한다 —
 * `runInNewContext` 로 얻은 값이라 컴파일러가 타입을 알 길이 없다.
 */
type BubbleComponent = (props: { notice: NoticeRow } & Paint) => unknown

function painted(notice: NoticeRow, props: Paint = {}): string {
  return renderToStaticMarkup(createElement(NoticeBubble, { notice, ...props }))
}

test('견본 세 개가 계약 모양대로 읽힌다', () => {
  const fruitRow = one(fruit)
  expect(fruitRow.title).toBe('학교 재무 양식의 수식 오류 21곳을 바로잡았어요')
  expect(fruitRow.items).toHaveLength(2)
  // 견본에는 선택지가 없다 — 없는 선택을 앱이 만들지 않는다.
  expect(fruitRow.choices).toEqual([])
  expect(fruitRow.choice).toBeNull()
  expect(fruitRow.receiptPath).toBe('out/receipt.json')

  const before = one(hortBefore)
  expect(before.choices.map((choice) => choice.value)).toEqual(['direct_tell', 'footnote'])
  expect(before.choices[1].label).toBe('논문에 각주로 적을게요')
  expect(before.choice).toBeNull()
  expect(before.items.length).toBeGreaterThan(10)

  const after = one(hortAfter)
  expect(after.choice).toBe('footnote')
  // 선택을 적어도 열쇠는 그대로다 — 닫기 기억이 되살아나지 않는다(계약).
  expect(after.key).toBe(before.key)
})

test('한 줄은 title 원문 그대로 — 앱이 숫자·범주를 조립하지 않는다', () => {
  const before = one(hortBefore)
  const html = painted(before)
  expect(html).toContain(`<p class="notice-title">${before.title}</p>`)
  // 견본 제목의 두 숫자와 구분 문구가 그대로 살아 있다.
  expect(html).toContain('18곳')
  expect(html).toContain('67곳')
  expect(html).toContain('계산 방식을 다르게 했어요')
  // 항목 수를 제목에 덧붙이지 않는다.
  expect(html).not.toContain(`<p class="notice-title">${before.title} (`)
})

test('선택지가 있는 알림은 두 단추를 그리고, 고른 뒤에는 묻지 않는다', () => {
  const before = one(hortBefore)
  const open = painted(before, { onChoose: () => {} })
  expect(open).toContain('교수님께 직접 말씀드릴게요')
  expect(open).toContain('논문에 각주로 적을게요')
  expect(open).toContain('<div class="notice-choice">')

  // onChoose 가 없으면 누를 곳이 아니다(기록할 곳이 없는데 단추만 두지 않는다).
  expect(painted(before)).not.toContain('<div class="notice-choice">')

  // 이미 고른 알림(견본 after)은 다시 묻지 않는다.
  const after = one(hortAfter)
  expect(painted(after, { onChoose: () => {} })).not.toContain('<div class="notice-choice">')
})

test('선택지가 없는 알림에는 선택 단추가 없다', () => {
  expect(painted(one(fruit), { onChoose: () => {} })).not.toContain('<div class="notice-choice">')
})

test('footnote 를 고른 알림에만 "각주 넣어 줘" 콜백 자리가 생긴다', () => {
  const after = one(hortAfter)
  const html = painted(after, { onFootnote: () => {} })
  expect(html).toContain('<div class="notice-foot">')
  expect(html).toContain('각주 넣어 줘')

  // 콜백이 없으면 자리도 없다(1묶음은 배선 전 — 누를 곳 없는 단추를 그리지 않는다).
  expect(painted(after)).not.toContain('각주 넣어 줘')
  // footnote 를 고르지 않은 알림에는 자리가 없다.
  expect(painted(one(hortBefore), { onFootnote: () => {} })).not.toContain('각주 넣어 줘')
  expect(painted(one(fruit), { onFootnote: () => {} })).not.toContain('각주 넣어 줘')
})

test('items 가 비면 [자세히] 가 아예 없다', () => {
  const empty: NoticeRow = { ...one(fruit), items: [], omittedItems: 0 }
  const html = painted(empty)
  expect(html).not.toContain('notice-more')
  expect(html).not.toContain('자세히')
  expect(html).toContain('학교 재무 양식의 수식 오류 21곳을 바로잡았어요')
})

test('[자세히] 는 항목과 칸 주소를 글자로 그린다', () => {
  const html = painted(one(fruit))
  expect(html).toContain('<details class="notice-more">')
  expect(html).toContain('<ul class="notice-items">')
  expect(html).toContain('9.경비계획!B12')
  expect(html).toContain('경비계획 연도칸이 2025로 박혀 있어서 창업 첫해를 보도록 고쳤어요')
})

test('닫기 단추는 닫을 수 있는 알림에만 있다', () => {
  const row = one(hortBefore)
  const html = painted(row, { onDismiss: () => {} })
  expect(html).toContain('aria-label="알림 닫기"')
  // 부르는 쪽이 없으면 누를 곳도 두지 않는다 — 닫기 기억을 저장할 곳이 없는데 X 만 두면 거짓말이 된다.
  expect(painted(row)).not.toContain('aria-label="알림 닫기"')
  // 닫기를 허용하지 않은 알림에도 X 가 없다.
  const locked: NoticeRow = { ...row, dismissible: false }
  expect(painted(locked, { onDismiss: () => {} })).not.toContain('aria-label="알림 닫기"')
})

test('닫기 기억 — 같은 열쇠는 다시 안 뜨고, 개정되면 다시 뜬다', () => {
  const before = one(hortBefore)
  expect(noticeVisible(before, [])).toBe(true)
  expect(noticeVisible(before, [before.key])).toBe(false)
  expect(firstVisible([before], [before.key])).toBeNull()

  // 선택을 적어도 열쇠는 그대로라 닫은 알림이 되살아나지 않는다(견본 after).
  const after = one(hortAfter)
  expect(noticeVisible(after, [before.key])).toBe(false)

  // 개정으로 열쇠가 바뀌면 다시 뜬다.
  const revised: NoticeRow = { ...before, key: noticeKey(before.key.slice(0, before.key.indexOf(':')), 'f'.repeat(64)) }
  expect(noticeVisible(revised, [before.key])).toBe(true)

  // SKE-09 "다시 보기"만 닫기 기억을 넘는다.
  expect(noticeVisible(before, [before.key], true)).toBe(true)
})

test('폴더 밖을 가리키는 receipt_path 는 무시한다', () => {
  expect(receiptPathInside('out/receipt.json')).toBe('out/receipt.json')
  expect(receiptPathInside('./out/./receipt.json')).toBe('out/receipt.json')
  // `..` 는 접어서 풀지 않고 통째로 버린다 — 풀어 보는 순간 판단이 한 겹 늘고 틀릴 자리가 생긴다.
  for (const outside of ['/etc/passwd', '~/비밀/key.pem', 'C:\\Users\\x\\a.json', '../../밖/receipt.json', 'out/../../밖.json', './out/../out/receipt.json', '']) {
    expect(receiptPathInside(outside), outside).toBeNull()
  }
  // 파일 안 값도 같은 규칙을 지난다.
  const poisoned = { ...(fruit as Record<string, unknown>), notices: [{ ...(fruit as { notices: unknown[] }).notices[0], receipt_path: '../../밖.json' }] }
  expect(one(poisoned).receiptPath).toBeNull()
})

test('도우미가 쓴 글을 마크다운·링크·HTML 로 해석하지 않는다', () => {
  const row: NoticeRow = {
    ...one(fruit),
    title: '**굵게** [열쇠](https://example.invalid/x) <b>태그</b>',
    items: [{ key: 'k', kind: 'typo', what: '[눌러](javascript:alert(1)) <img src=x>', cells: ['a!A1'] }]
  }
  const html = painted(row)
  expect(html).not.toContain('<strong>')
  expect(html).not.toContain('<a ')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<b>')
  expect(html).toContain('**굵게**')
  expect(html).toContain('&lt;b&gt;태그&lt;/b&gt;')
  expect(html).toContain('[눌러](javascript:alert(1))')
})

test('한 줄은 줄바꿈을 접고 상한을 넘으면 자른다', () => {
  const raw = { ...(fruit as Record<string, unknown>) }
  const base = (fruit as { notices: Record<string, unknown>[] }).notices[0]
  const long = one({ ...raw, notices: [{ ...base, title: '가'.repeat(400) }] })
  expect(long.title.length).toBe(160)
  expect(long.title.endsWith('…')).toBe(true)
  const folded = one({ ...raw, notices: [{ ...base, title: '앞줄\n뒷줄\t탭' }] })
  expect(folded.title).toBe('앞줄 뒷줄 탭')
})

test('모양이 어긋난 알림은 버리고 나머지는 살린다', () => {
  const base = (fruit as { notices: Record<string, unknown>[] }).notices[0]
  expect(document({ ...(fruit as Record<string, unknown>), schema: 'knuaf.notices/2' })).toEqual([])
  expect(document({ ...(fruit as Record<string, unknown>), notices: {} })).toEqual([])
  expect(document(null)).toEqual([])
  // 열쇠(identity/project_id)가 없으면 닫기 기억을 지킬 수 없어 띄우지 않는다.
  expect(document({ ...(fruit as Record<string, unknown>), notices: [{ ...base, notice_identity: '' }] })).toEqual([])
  // 좋은 알림 하나 + 깨진 알림 하나 → 좋은 것만.
  const mixed = document({ ...(fruit as Record<string, unknown>), notices: [{ ...base, title: '' }, base] })
  expect(mixed).toHaveLength(1)
  expect(mixed[0].title).toBe('학교 재무 양식의 수식 오류 21곳을 바로잡았어요')
})

test('main 읽기 — 없음·깨짐·스키마 다름은 "알림 없음"이고 던지지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-notice-main-'))
  mkdirSync(join(root, '논문'), { recursive: true })
  const paper = join(root, '논문')
  expect(noticeFilePath(paper)).toBe(join(paper, '.knuaf-notices.json'))
  expect(readNotices(paper)).toEqual({ notices: [] })
  expect(readNotices(join(root, '없는폴더'))).toEqual({ notices: [] })

  writeFileSync(noticeFilePath(paper), '{ 깨진 json', 'utf-8')
  expect(readNotices(paper)).toEqual({ notices: [] })

  writeFileSync(noticeFilePath(paper), JSON.stringify({ schema: 'knuaf.notices/0', notices: [] }), 'utf-8')
  expect(readNotices(paper)).toEqual({ notices: [] })

  writeFileSync(noticeFilePath(paper), JSON.stringify(fruit), 'utf-8')
  const rows = readNotices(paper).notices
  expect(rows).toHaveLength(1)
  expect(rows[0].receiptPath).toBe('out/receipt.json')
})

/**
 * ── 훅 상태 시험 ────────────────────────────────────────────────────────────
 * 위 시험은 매번 **새 부품**을 서버 렌더한다. 그래서 1심 검토의 두 결함이 전부 빠져나갔다:
 * ① 잠금이 알림이 아니라 부품 자리에 묶여 있었다 — 같은 자리에 다른 알림을 갈아 끼우면 새 알림의
 *    선택지가 사라지고, 앞 알림의 늦은 실패가 새 알림에 얹혔다.
 * ② `Promise.resolve(onChoose?.(value))` 는 호출이 먼저라 동기 throw 가 `.catch` 를 비껴갔다.
 * 아래는 같은 뿌리에 알림을 갈아 끼우며 **실제 훅 상태**를 본다. 브라우저가 아니라 React 19
 * 클라이언트 렌더러가 요구하는 최소 DOM 만 세운다(검토자 재현 하네스와 같은 수법).
 */
class HostNode {
  nodeType: number
  nodeName: string
  tagName: string
  ownerDocument: HostNode | null
  namespaceURI: string
  nodeValue: string
  childNodes: HostNode[]
  parentNode: HostNode | null
  attrs: Record<string, string>
  style: Record<string, string>
  listeners: Record<string, Array<(...args: unknown[]) => void>>

  constructor(name: string, owner: HostNode | null, type = 1) {
    this.nodeType = type
    this.nodeName = name.toUpperCase()
    this.tagName = this.nodeName
    this.ownerDocument = owner
    this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    this.nodeValue = ''
    this.childNodes = []
    this.parentNode = null
    this.attrs = {}
    this.style = {}
    this.listeners = {}
  }

  appendChild(node: HostNode): HostNode {
    if (node.parentNode) node.parentNode.removeChild(node)
    this.childNodes.push(node)
    node.parentNode = this
    return node
  }

  insertBefore(node: HostNode, ref: HostNode): HostNode {
    if (node.parentNode) node.parentNode.removeChild(node)
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node)
    node.parentNode = this
    return node
  }

  removeChild(node: HostNode): HostNode {
    this.childNodes.splice(this.childNodes.indexOf(node), 1)
    node.parentNode = null
    return node
  }

  setAttribute(key: string, value: unknown): void { this.attrs[key] = String(value) }
  setAttributeNS(_namespace: string, key: string, value: unknown): void { this.setAttribute(key, value) }
  removeAttribute(key: string): void { delete this.attrs[key] }
  addEventListener(key: string, fn: (...args: unknown[]) => void): void { (this.listeners[key] ??= []).push(fn) }
  removeEventListener(): void { /* 이 시험은 이벤트를 걷어내지 않는다 */ }

  get className(): string { return this.attrs.class ?? '' }
  set className(value: string) { this.attrs.class = value }
  get firstChild(): HostNode | null { return this.childNodes[0] ?? null }
  get lastChild(): HostNode | null { return this.childNodes.at(-1) ?? null }
  get nextSibling(): HostNode | null {
    const list = this.parentNode?.childNodes ?? []
    return list[list.indexOf(this) + 1] ?? null
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((node) => node.textContent).join('')
  }
  set textContent(text: string) {
    this.childNodes = []
    if (text && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(text))
  }
  contains(node: HostNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node))
  }
}

interface HostDocument extends HostNode {
  createElement(name: string): HostNode
  createElementNS(namespace: string, name: string): HostNode
  createTextNode(text: string): HostNode
  createComment(text: string): HostNode
  documentElement: HostNode
  body: HostNode
  activeElement: HostNode
  defaultView: unknown
}

/**
 * 시험 하나 동안만 DOM 전역을 세운다. 끝나면 **원래 값으로 되돌린다** — 같은 워커에서 도는
 * 다른 스펙(서버 렌더·스토어)이 이 전역을 보지 않게 한다.
 */
async function withHostDom(run: (hostDocument: HostDocument, act: (body: () => Promise<void> | void) => Promise<void>) => Promise<void>): Promise<void> {
  const document = new HostNode('#document', null, 9) as HostDocument
  document.ownerDocument = document
  document.createElement = (name: string) => new HostNode(name, document)
  document.createElementNS = (namespace: string, name: string) => {
    const node = new HostNode(name, document)
    node.namespaceURI = namespace
    return node
  }
  document.createTextNode = (text: string) => {
    const node = new HostNode('#text', document, 3)
    node.nodeValue = String(text)
    return node
  }
  document.createComment = (text: string) => {
    const node = new HostNode('#comment', document, 8)
    node.nodeValue = String(text)
    return node
  }
  document.documentElement = document.createElement('html')
  document.body = document.createElement('body')
  document.documentElement.appendChild(document.body)
  document.activeElement = document.body
  document.defaultView = globalThis

  const globals = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  const install = (name: string, value: unknown): void => {
    saved.set(name, globals[name])
    globals[name] = value
  }
  install('window', globalThis)
  install('document', document)
  install('HTMLElement', HostNode)
  install('HTMLIFrameElement', class {})
  install('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    const { act } = real('react') as { act: (body: () => Promise<void> | void) => Promise<void> }
    await run(document, act)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

interface BubbleRoot { render: (element: unknown) => void; unmount: () => void }
interface BubblePaint extends Paint { notice: NoticeRow }

function walk(node: HostNode, hit: (node: HostNode) => boolean, out: HostNode[] = []): HostNode[] {
  if (hit(node)) out.push(node)
  for (const child of node.childNodes) walk(child, hit, out)
  return out
}

/** 화면에 있는 선택 단추 — `.notice-choice` 안의 `button` 만. */
function visibleChoices(host: HostNode): HostNode[] {
  return walk(host, (node) => node.attrs.class === 'notice-choice').flatMap((box) => walk(box, (node) => node.tagName === 'BUTTON'))
}

/** 실패 알림 줄 — `.notice-failed`(role=alert). */
function failedLines(host: HostNode): HostNode[] {
  return walk(host, (node) => node.attrs.class === 'notice-failed')
}

function pressChoice(button: HostNode): void {
  const holder = button as unknown as Record<string, { onClick?: () => void }>
  const propKey = Object.keys(holder).find((name) => name.startsWith('__reactProps$'))
  if (!propKey) throw new Error('단추에서 React props 를 찾지 못했다')
  holder[propKey].onClick?.()
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

/** 같은 뿌리에 알림을 갈아 끼운다 — 부품 자리(마운트)는 그대로다. */
async function paintLive(
  document: HostDocument,
  act: (body: () => Promise<void> | void) => Promise<void>,
  props: BubblePaint,
  reactKey?: string
): Promise<{ host: HostNode; root: BubbleRoot; render: (next: BubblePaint, key?: string) => Promise<void> }> {
  const { createRoot } = real('react-dom/client') as { createRoot: (container: HostNode) => BubbleRoot }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = async (next: BubblePaint, key?: string): Promise<void> => {
    await act(async () => {
      root.render(createElement(NoticeBubble as unknown as (props: BubblePaint) => unknown, { ...next, ...(key ? { key } : {}) }))
    })
  }
  await render(props, reactKey)
  return { host, root, render }
}

/** 견본 before 를 같은 프로젝트의 **개정 알림**으로 — 열쇠만 다르다. */
function revisedNotice(before: NoticeRow): NoticeRow {
  const projectId = (hortBefore as { project_id: string }).project_id
  return { ...before, key: noticeKey(projectId, 'f'.repeat(64)) }
}

test('열쇠가 바뀐 알림은 앞 알림의 잠금을 물려받지 않는다', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    const next = revisedNotice(before)
    let calls = 0
    const { host, root, render } = await paintLive(document, act, { notice: before, onChoose: () => { calls += 1 } })
    await act(async () => pressChoice(visibleChoices(host)[1]))
    // 잠금 확인 — 같은 알림에서는 다시 묻지 않는다.
    expect(visibleChoices(host)).toHaveLength(0)
    await render({ notice: next, onChoose: () => { calls += 1 } })
    // 새 알림은 **같은 렌더에서** 선택지를 되찾는다(초기화 렌더 없음).
    expect(next.choice).toBeNull()
    expect(visibleChoices(host)).toHaveLength(2)
    expect(calls).toBe(1)
    await act(async () => root.unmount())
  })
})

test('동기 throw 도 비동기 거절과 같은 실패 경로로 온다', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    let thrown: string | null = null
    const { host, root } = await paintLive(document, act, {
      notice: before,
      onChoose: () => { throw new Error('sync rejection') }
    })
    await act(async () => {
      try { pressChoice(visibleChoices(host)[0]) } catch (error) { thrown = (error as Error).message }
    })
    expect(thrown).toBeNull()
    expect(visibleChoices(host)).toHaveLength(2)
    expect(failedLines(host)).toHaveLength(1)
    await act(async () => root.unmount())
  })
})

test('비동기 거절은 잠금을 풀고 실패를 알린다(대조군)', async () => {
  await withHostDom(async (document, act) => {
    const { host, root } = await paintLive(document, act, {
      notice: one(hortBefore),
      onChoose: () => Promise.reject(new Error('async rejection'))
    })
    await act(async () => pressChoice(visibleChoices(host)[0]))
    expect(visibleChoices(host)).toHaveLength(2)
    expect(failedLines(host)).toHaveLength(1)
    await act(async () => root.unmount())
  })
})

test('앞 알림의 늦은 거절은 새 알림에 실패를 적지 않는다', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    const next = revisedNotice(before)
    const pending = deferred()
    const { host, root, render } = await paintLive(document, act, { notice: before, onChoose: () => pending.promise })
    await act(async () => pressChoice(visibleChoices(host)[0]))
    await render({ notice: next, onChoose: () => {} })
    await act(async () => { pending.reject(new Error('old identity failed')) })
    expect(failedLines(host)).toHaveLength(0)
    expect(visibleChoices(host)).toHaveLength(2)
    await act(async () => root.unmount())
  })
})

test('부르는 쪽이 React key 를 주면 잠금도 함께 갈린다(대조군)', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    const next = revisedNotice(before)
    const { host, root, render } = await paintLive(document, act, { notice: before, onChoose: () => {} }, before.key)
    await act(async () => pressChoice(visibleChoices(host)[0]))
    await render({ notice: next, onChoose: () => {} }, next.key)
    expect(visibleChoices(host)).toHaveLength(2)
    expect(failedLines(host)).toHaveLength(0)
    await act(async () => root.unmount())
  })
})

test('논문 폴더 안 심볼릭 링크로 밖을 가리키는 receipt_path 는 main 이 버린다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-notice-link-'))
  const paper = join(root, 'paper')
  const outside = join(root, 'outside')
  mkdirSync(paper, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'receipt.json'), '{}', 'utf-8')

  const raw = JSON.parse(JSON.stringify(hortBefore)) as { notices: Record<string, unknown>[] }
  raw.notices[0].receipt_path = 'out/receipt.json'

  // 밖을 가리키는 링크 — 문자열만 보면 폴더 안이지만 실제 경로는 밖이다.
  symlinkSync(outside, join(paper, 'out'), 'dir')
  writeFileSync(noticeFilePath(paper), JSON.stringify(raw), 'utf-8')
  expect(readNotices(paper).notices[0].receiptPath).toBeNull()

  // 대조: 같은 값이라도 링크가 없으면(아직 없는 파일이어도) 폴더 안 상대 경로로 남는다.
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(noticeFilePath(plain), JSON.stringify(raw), 'utf-8')
  expect(readNotices(plain).notices[0].receiptPath).toBe('out/receipt.json')
})

test('끊긴 심볼릭 링크는 대상이 없어도 폴더 밖으로 친다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-notice-deadlink-'))
  const paper = join(root, 'paper')
  mkdirSync(paper, { recursive: true })

  const raw = JSON.parse(JSON.stringify(hortBefore)) as { notices: Record<string, unknown>[] }
  raw.notices[0].receipt_path = 'out/receipt.json'
  writeFileSync(noticeFilePath(paper), JSON.stringify(raw), 'utf-8')

  // 폴더 밖의 **아직 없는** 대상을 가리키는 링크 — existsSync 는 거짓이라 미존재 경로처럼 보인다.
  symlinkSync(join(root, 'outside', 'nope'), join(paper, 'out'), 'dir')
  expect(existsSync(join(paper, 'out'))).toBe(false) // 링크가 끊겼다는 사실을 시험이 먼저 못박는다.
  expect(readNotices(paper).notices[0].receiptPath).toBeNull()
})

test('폴더 안을 가리키는 멀쩡한 링크도 거절한다(링크면 거절)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-notice-insidelink-'))
  const paper = join(root, 'paper')
  mkdirSync(join(paper, 'real'), { recursive: true })
  writeFileSync(join(paper, 'real', 'receipt.json'), '{}', 'utf-8')

  const raw = JSON.parse(JSON.stringify(hortBefore)) as { notices: Record<string, unknown>[] }
  raw.notices[0].receipt_path = 'out/receipt.json'
  writeFileSync(noticeFilePath(paper), JSON.stringify(raw), 'utf-8')

  // 대상이 폴더 안이라 실제 경로 판정만으로는 통과한다 — 조각에 링크가 있다는 사실 자체로 거절한다.
  symlinkSync(join(paper, 'real'), join(paper, 'out'), 'dir')
  expect(existsSync(join(paper, 'out', 'receipt.json'))).toBe(true)
  expect(readNotices(paper).notices[0].receiptPath).toBeNull()

  // 대조: 링크가 아니라 진짜 폴더면 같은 경로가 그대로 남는다.
  const plain = join(root, 'plain')
  mkdirSync(join(plain, 'out'), { recursive: true })
  writeFileSync(join(plain, 'out', 'receipt.json'), '{}', 'utf-8')
  writeFileSync(noticeFilePath(plain), JSON.stringify(raw), 'utf-8')
  expect(readNotices(plain).notices[0].receiptPath).toBe('out/receipt.json')
})

test('알림 파일 자체가 밖을 가리키는 심볼릭 링크면 읽지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kd-notice-filelink-'))
  const paper = join(root, 'paper')
  const outside = join(root, 'outside')
  mkdirSync(paper, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const raw = JSON.parse(JSON.stringify(hortBefore)) as { notices: Record<string, unknown>[] }
  writeFileSync(join(outside, 'notices.json'), JSON.stringify(raw), 'utf-8')
  symlinkSync(join(outside, 'notices.json'), join(paper, '.knuaf-notices.json'), 'file')
  expect(readNotices(paper)).toEqual({ notices: [] })

  // 끊긴 링크(대상 없음)도 같은 규칙 — existsSync 로는 "파일 없음"과 구별되지 않는다.
  const dead = join(root, 'dead')
  mkdirSync(dead, { recursive: true })
  symlinkSync(join(outside, 'missing.json'), join(dead, '.knuaf-notices.json'), 'file')
  expect(existsSync(join(dead, '.knuaf-notices.json'))).toBe(false)
  expect(readNotices(dead)).toEqual({ notices: [] })
  // 대상이 나중에 밖에 생겨도 링크는 링크다 — 읽히지 않는다.
  writeFileSync(join(outside, 'missing.json'), JSON.stringify(raw), 'utf-8')
  expect(existsSync(join(dead, '.knuaf-notices.json'))).toBe(true)
  expect(readNotices(dead)).toEqual({ notices: [] })

  // 대조: 링크가 아니라 폴더 안 실제 파일이면 그대로 읽는다.
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(noticeFilePath(plain), JSON.stringify(raw), 'utf-8')
  expect(readNotices(plain).notices).toHaveLength(1)
})

/* ── 2묶음: 대화 창에 붙는 스택(NoticeStack) ─────────────────────────────────
 * 1묶음 시험은 부품(`NoticeBubble`)을 하나씩 그려 잠갔다. 스택은 그 부품을 **여러 건** 세우고,
 * 닫기 기억·선택 기록·다시 읽기·`forceOpen` 을 부품 밖에서 맡는다. 여기서는 `api` 를 갈아 끼워
 * 화면이 부른 **호출 자체**(열쇠·값)를 못박는다 — Electron 없이 Node 에서 돈다.
 */
const NoticeStack = componentOf(loadTsx(resolve(__dirname, '../src/renderer/src/components/NoticeStack.tsx')), 'NoticeStack')

interface StackApi {
  read: (root: string) => Promise<unknown>
  dismiss: (root: string, key: string) => Promise<unknown>
  choose: (root: string, identity: string, value: string) => Promise<unknown>
}

interface StackProps {
  root: string | null
  reloadKey?: number
  forceOpenKeys?: readonly string[]
  onFootnote?: () => void
  onWriteTalk?: (text: string) => void
  api: StackApi
}

/** 기본은 "알림 없음" — 각 시험이 필요한 길만 갈아 끼운다. */
function stackApi(over: Partial<StackApi> = {}): StackApi {
  return {
    read: async () => ({ result: { notices: [], dismissed: [] } }),
    dismiss: async () => ({ result: [] }),
    choose: async () => ({ result: { ok: true, exit: 0, status: 'chosen' } }),
    ...over
  }
}

function byClass(host: HostNode, name: string): HostNode[] {
  return walk(host, (node) => node.attrs.class === name)
}

/** 스택 마운트 — `render` 로 prop 을 갈아 끼운다(다시 읽기 신호 시험). 첫 렌더는 빈 상태다. */
interface StackMount { host: HostNode; root: BubbleRoot; render: (next: StackProps) => Promise<void> }

async function paintStack(
  document: HostDocument,
  act: (body: () => Promise<void> | void) => Promise<void>,
  props: StackProps
): Promise<StackMount> {
  const { createRoot } = real('react-dom/client') as { createRoot: (container: HostNode) => BubbleRoot }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = async (next: StackProps): Promise<void> => {
    await act(async () => { root.render(createElement(NoticeStack as unknown as (p: StackProps) => unknown, next)) })
    await act(async () => { /* 읽기 프라미스 반영 */ })
  }
  await render(props)
  return { host, root, render }
}

test('각주 알림의 [각주 넣어 줘] 는 초점 콜백과 함께 그 문장을 입력칸에 넘긴다', async () => {
  await withHostDom(async (document, act) => {
    const row = one(hortAfter)
    let focused = 0
    const written: string[] = []
    const { host, root } = await paintStack(document, act, {
      root: ROOT,
      api: stackApi({ read: async () => ({ result: { notices: [row], dismissed: [] } }) }),
      onFootnote: () => { focused += 1 },
      onWriteTalk: (text) => { written.push(text) }
    })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    const foot = byClass(host, 'notice-foot')[0]
    expect(foot).toBeTruthy()
    await act(async () => pressChoice(walk(foot, (node) => node.tagName === 'BUTTON')[0]))
    expect(focused).toBe(1)
    // 채우는 문장은 **단추 이름 그대로** — 알림 파일에 각주 문장 칸이 없으므로 앱이 조립하지 않는다.
    expect(written).toEqual(['각주 넣어 줘'])
    await act(async () => root.unmount())
  })
})

test('X 는 project_id:notice_identity 열쇠로 닫기를 저장하고 화면에서 먼저 지운다', async () => {
  await withHostDom(async (document, act) => {
    const row = one(hortBefore)
    const saved = deferred()
    const calls: Array<[string, string]> = []
    const { host, root } = await paintStack(document, act, {
      root: ROOT,
      api: stackApi({
        read: async () => ({ result: { notices: [row], dismissed: [] } }),
        dismiss: async (at, key) => { calls.push([at, key]); await saved.promise; return { result: [key] } }
      })
    })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    await act(async () => pressChoice(byClass(host, 'notice-x')[0]))
    // 저장이 끝나기 전에 이미 사라진다 — 저장 실패로 카드가 되살아나지 않는다.
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    const fixture = hortBefore as { project_id: string; notices: Array<{ notice_identity: string }> }
    expect(calls).toEqual([[ROOT, `${fixture.project_id}:${fixture.notices[0].notice_identity}`]])
    // 이 견본의 열쇠는 계약 그대로 `project_id:notice_identity` 다(둘 다 hex — `:` 는 하나).
    expect(row.key).toBe(calls[0][1])
    await act(async () => { saved.resolve() })
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    await act(async () => root.unmount())
  })
})

/**
 * 저장 판정(판정 중요1 · 규칙집 v0.4.11 계약): `ok:true` + `status:'chosen'` 만 "저장됨"이다.
 * 옛 `chosen_notice_failed`(v0.4.10, `ok:false` exit 3)만 호환으로 받는다. `failed`
 * (`notice_rows_unavailable`)·정상 거절·`status:null`·모르는 봉투는 **실패**다 — 저장된 척하면
 * 카드가 사라지고 학생은 골랐다고 믿는데 정본에는 안 적힌 채다.
 */
test('선택 저장은 ok:true + chosen 만 인정한다 — failed·null·rejected 는 실패 줄과 다시 열린 단추', async () => {
  const branches: Array<{ name: string; envelope: Record<string, unknown>; saved: boolean }> = [
    { name: 'chosen', envelope: { ok: true, exit: 0, status: 'chosen' }, saved: true },
    { name: 'chosen_notice_failed(v0.4.10 호환)', envelope: { ok: false, exit: 3, status: 'chosen_notice_failed' }, saved: true },
    { name: 'failed', envelope: { ok: false, exit: 1, status: 'failed', block_reason: null }, saved: false },
    { name: 'ok:false + status:null + data:null', envelope: { ok: false, exit: 1, status: null, data: null }, saved: false },
    { name: 'rejected', envelope: { ok: false, exit: 2, status: 'rejected', block_reason: '이미 골랐어요' }, saved: false }
  ]
  for (const branch of branches) {
    await withHostDom(async (document, act) => {
      const before = one(hortBefore)
      let reads = 0
      const { host, root } = await paintStack(document, act, {
        root: ROOT,
        api: stackApi({
          // 규칙집 v0.4.11 은 선택이 적히면 알림 파일에서 그 알림을 지운다 — 저장된 갈래는 "파일 없음".
          read: async () => { reads += 1; return { result: { notices: reads === 1 ? [before] : [], dismissed: [] } } },
          choose: async () => ({ result: branch.envelope })
        })
      })
      expect(visibleChoices(host), branch.name).toHaveLength(2)
      await act(async () => pressChoice(visibleChoices(host)[1]))
      if (branch.saved) {
        // 저장됨 — 단추가 다시 열리지 않고, 재읽기에서 파일이 없으면 조용히 닫힌다(실패 줄 없음).
        expect(failedLines(host), branch.name).toHaveLength(0)
        expect(byClass(host, 'notice-card'), branch.name).toHaveLength(0)
        expect(reads, branch.name).toBe(2)
      } else {
        // 실패 — 카드는 남고, 실패 줄이 뜨고, 잠금이 풀려 다시 고를 수 있다.
        expect(failedLines(host), branch.name).toHaveLength(1)
        expect(byClass(host, 'notice-card'), branch.name).toHaveLength(1)
        expect(visibleChoices(host), branch.name).toHaveLength(2)
        expect(reads, branch.name).toBe(1)
      }
      await act(async () => root.unmount())
    })
  }
})

test('실패한 선택은 잠금이 풀려 다시 누르면 저장된다', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    let reads = 0
    let calls = 0
    const { host, root } = await paintStack(document, act, {
      root: ROOT,
      api: stackApi({
        read: async () => { reads += 1; return { result: { notices: reads === 1 ? [before] : [], dismissed: [] } } },
        choose: async () => {
          calls += 1
          // 첫 번째는 규칙집이 알림 파일을 다시 쓰지 못한 경우(v0.4.11 `failed`), 두 번째는 정상.
          return { result: calls === 1 ? { ok: false, exit: 1, status: 'failed' } : { ok: true, exit: 0, status: 'chosen' } }
        }
      })
    })
    await act(async () => pressChoice(visibleChoices(host)[1]))
    expect(failedLines(host)).toHaveLength(1)
    await act(async () => pressChoice(visibleChoices(host)[1]))
    expect(calls).toBe(2)
    expect(failedLines(host)).toHaveLength(0)
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    await act(async () => root.unmount())
  })
})

test('알림 두 건은 한 스택에 차례로 쌓인다', async () => {
  await withHostDom(async (document, act) => {
    const first = one(hortBefore)
    const second = revisedNotice({ ...first, title: '다른 곳도 바로잡았어요' })
    const { host, root } = await paintStack(document, act, {
      root: ROOT,
      api: stackApi({ read: async () => ({ result: { notices: [first, second], dismissed: [] } }) })
    })
    expect(byClass(host, 'notice-card')).toHaveLength(2)
    expect(byClass(host, 'notice-zone')).toHaveLength(1)
    await act(async () => root.unmount())
  })
})

test('forceOpenKeys 는 닫은 알림을 다시 그린다 — 목록에 없으면 그대로 닫혀 있다', async () => {
  const row = one(hortBefore)
  const api = stackApi({ read: async () => ({ result: { notices: [row], dismissed: [row.key] } }) })
  await withHostDom(async (document, act) => {
    const shut = await paintStack(document, act, { root: ROOT, api })
    expect(byClass(shut.host, 'notice-card')).toHaveLength(0)
    await act(async () => shut.root.unmount())
  })
  await withHostDom(async (document, act) => {
    const open = await paintStack(document, act, { root: ROOT, api, forceOpenKeys: [row.key] })
    const cards = byClass(open.host, 'notice-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].attrs['data-force-open']).toBe('true')
    await act(async () => open.root.unmount())
  })
})

/**
 * forceOpen 소비(판정 중요4) — `consumed` 는 **그 다시 보기 요청**에만 묶인다.
 * 요청의 경계는 "열쇠가 `forceOpenKeys` 에 없다가 새로 들어옴"이다. 그래서 일반 카드의 X 는
 * 나중에 올 다시 보기 요청을 미리 먹지 않고, 요청을 한 번 닫아도 같은 열쇠가 다시 들어오면
 * 새 요청으로 다시 열린다. 같은 props 를 계속 유지하는 동안에는 다시 뜨지 않는다.
 * 두 시험 모두 **한 마운트**에서 props 만 갈아 끼운다(부품을 다시 만들지 않는다).
 */
test('일반 카드의 X 는 뒤에 오는 다시 보기 요청을 소비하지 않는다 — X → forceOpenKeys 추가 → 카드 보임', async () => {
  await withHostDom(async (document, act) => {
    const row = one(hortBefore)
    const props: StackProps = {
      root: ROOT,
      forceOpenKeys: [],
      api: stackApi({
        // 닫기 기억에는 아직 없다 — 지금 보이는 카드는 일반 카드다.
        read: async () => ({ result: { notices: [row], dismissed: [] } }),
        dismiss: async (_root, key) => ({ result: [key] })
      })
    }
    const { host, root, render } = await paintStack(document, act, props)
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    await act(async () => pressChoice(byClass(host, 'notice-x')[0]))
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    // 같은 props 유지 — 닫기 기억으로 숨은 채다.
    await render(props)
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    // 이제 오른쪽 창이 "다시 보기"를 누른다 — 새 요청이므로 그 열쇠는 소비 상태가 아니다.
    await render({ ...props, forceOpenKeys: [row.key] })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    expect(byClass(host, 'notice-card')[0].attrs['data-force-open']).toBe('true')
    await act(async () => root.unmount())
  })
})

test('다시 보기를 닫아도 같은 열쇠의 새 요청은 다시 연다 — 닫기 → 다시 보기 → X → 다시 보기 → X', async () => {
  await withHostDom(async (document, act) => {
    const row = one(hortBefore)
    const props: StackProps = {
      root: ROOT,
      forceOpenKeys: [row.key],
      api: stackApi({
        // 닫기 기억에 이미 있는 알림 — 이 카드는 다시 보기로만 뜬다.
        read: async () => ({ result: { notices: [row], dismissed: [row.key] } }),
        dismiss: async (_root, key) => ({ result: [key] })
      })
    }
    const { host, root, render } = await paintStack(document, act, props)
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    await act(async () => pressChoice(byClass(host, 'notice-x')[0]))
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    // 같은 열쇠가 그대로 남아 있는 "다시 보기" 목록 — 이 요청은 소비됐으므로 다시 그리지 않는다.
    await render(props)
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    // 오른쪽 창이 목록에서 뺐다가 다시 넣는다 = 새 요청.
    await render({ ...props, forceOpenKeys: [] })
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    await render({ ...props, forceOpenKeys: [row.key] })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    // 새 요청도 X 로 끝난다 — 그리고 그 뒤 같은 props 로는 다시 뜨지 않는다.
    await act(async () => pressChoice(byClass(host, 'notice-x')[0]))
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    await render({ ...props, forceOpenKeys: [row.key] })
    expect(byClass(host, 'notice-card')).toHaveLength(0)
    await act(async () => root.unmount())
  })
})

/**
 * 재읽기(판정 중요2) — 도우미 턴이 끝날 때 `reloadKey` 가 올라가면 알림 파일을 다시 읽는다:
 * 없음 → 생김 → 갱신(선택 채워짐·단추 없음) → 새 identity(새 알림, 단추 다시 열림).
 */
test('reloadKey 가 오르면 알림 파일을 다시 읽는다 — 없음 → 생김 → 갱신 → 새 identity', async () => {
  await withHostDom(async (document, act) => {
    const before = one(hortBefore)
    const resolved = { ...before, choice: 'footnote' as const }
    const fresh = revisedNotice(before)
    let reads = 0
    const api = stackApi({
      read: async () => {
        reads += 1
        const notices = reads === 1 ? [] : reads === 2 ? [before] : reads === 3 ? [resolved] : [fresh]
        return { result: { notices, dismissed: [] } }
      }
    })
    const { host, root, render } = await paintStack(document, act, { root: ROOT, reloadKey: 0, api })
    expect(byClass(host, 'notice-card')).toHaveLength(0)

    await render({ root: ROOT, reloadKey: 1, api })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    expect(visibleChoices(host)).toHaveLength(2)

    await render({ root: ROOT, reloadKey: 2, api })
    expect(visibleChoices(host)).toHaveLength(0)
    expect(byClass(host, 'notice-foot')).toHaveLength(1)

    await render({ root: ROOT, reloadKey: 3, api })
    expect(byClass(host, 'notice-card')).toHaveLength(1)
    expect(visibleChoices(host)).toHaveLength(2)
    expect(reads).toBe(4)
    await act(async () => root.unmount())
  })
})

/**
 * 로컬 선택 우선(판정 중요5) — 저장이 확인된 선택은 화면이 기억한다. 알림 파일이 아직 옛 모양
 * (`choice:null`)이어도 단추를 되살리지 않고, 각주를 골랐으면 [각주 넣어 줘] 줄이 보인다.
 * 파일이 갱신돼 `choice` 가 채워지면 그때는 파일이 진실이고, 파일에서 사라졌으면 카드가 없다.
 */
test('저장된 선택은 옛 파일의 choice:null 을 이긴다 — 갱신 파일·파일 없음도 각각 맞게 그린다', async () => {
  const cases: Array<{ name: string; after: (row: NoticeRow) => NoticeRow[]; cards: number; choices: number; foot: number }> = [
    // 옛 파일 — 다시 읽어도 `choice:null` 이다. 화면 기억이 단추를 닫고 각주 줄을 연다.
    { name: '옛 파일(choice:null)', after: (row) => [row], cards: 1, choices: 0, foot: 1 },
    // 갱신 파일 — 규칙집이 `choice` 를 채워 다시 썼다.
    { name: '갱신 파일', after: (row) => [{ ...row, choice: 'footnote' }], cards: 1, choices: 0, foot: 1 },
    // v0.4.11 — 선택이 적히면 알림 자체가 파일에서 사라진다. 카드도 없다(실패 줄 없음).
    { name: '파일 없음', after: () => [], cards: 0, choices: 0, foot: 0 }
  ]
  for (const item of cases) {
    await withHostDom(async (document, act) => {
      const before = one(hortBefore)
      let reads = 0
      const { host, root } = await paintStack(document, act, {
        root: ROOT,
        api: stackApi({
          read: async () => { reads += 1; return { result: { notices: reads === 1 ? [before] : item.after(before), dismissed: [] } } },
          choose: async () => ({ result: { ok: true, exit: 0, status: 'chosen' } })
        })
      })
      await act(async () => pressChoice(visibleChoices(host)[1]))
      expect(reads, item.name).toBe(2)
      expect(byClass(host, 'notice-card'), item.name).toHaveLength(item.cards)
      expect(visibleChoices(host), item.name).toHaveLength(item.choices)
      expect(byClass(host, 'notice-foot'), item.name).toHaveLength(item.foot)
      expect(failedLines(host), item.name).toHaveLength(0)
      // 마운트를 새로 해도(부품 상태 초기화) 파일이 옛 모양이면 화면은 서버 진실을 따른다 — 단추가 다시 열린다.
      await act(async () => root.unmount())
    })
  }
})

/* ── 03b: [자세히] 쉬운 세 줄(사실 칸이 있을 때만) ─────────────────────────── */
test('사실 칸이 있으면 세 줄 + 칸 주소를 맨 아래에 그리고, 없으면 옛 한 줄이다', () => {
  const base = one(hortBefore)
  const three = painted({
    ...base,
    items: [{
      key: 'k1', kind: 'typo', what: '수식을 바로잡았어요', cells: ['9.경비계획!B12'],
      where: '경비계획 시트의 12번째 줄', current: '값이 두 번 더해져 있었어요',
      basis: '같은 칸이 합계에 두 번 들어가면 총액이 커져요',
      how: '합계 범위에서 그 칸을 빼 주세요', whereDetail: '9.경비계획!B12'
    }]
  })
  expect(three).toContain('class="notice-easy"')
  expect(three).toContain('<p class="w">')
  expect(three).toContain('<p class="why">')
  expect(three).toContain('<p class="fix">')
  expect(three).toContain('<p class="ref">')
  // 순서 = 무슨 일 → 왜 → 어떻게 → 칸 주소(맨 아래 작게).
  expect(three.indexOf('class="w"')).toBeLessThan(three.indexOf('class="why"'))
  expect(three.indexOf('class="why"')).toBeLessThan(three.indexOf('class="fix"'))
  expect(three.indexOf('class="fix"')).toBeLessThan(three.indexOf('class="ref"'))
  // 칸 주소는 `whereDetail` 우선 — 없으면 `cells` 로 떨어진다.
  expect(three).toContain('9.경비계획!B12')

  // 사실이 `where` 하나뿐이면 '왜' 줄을 빼고 두 줄 — 없는 이유를 앱이 지어내지 않는다.
  const two = painted({ ...base, items: [{ key: 'k2', kind: 'typo', what: 'x', cells: [], where: '어느 자리' }] })
  expect(two).toContain('class="notice-easy"')
  expect(two).toContain('<p class="w">어느 자리</p>')
  expect(two).not.toContain('class="why"')
  expect(two).not.toContain('class="fix"')
  // `how` 없이 칸 주소만 있어도 주소는 맨 아래에 남는다.
  const bare = painted({ ...base, items: [{ key: 'k3', kind: 'typo', what: 'x', cells: [], where: '어느 자리', whereDetail: '4.투자계획!E24' }] })
  expect(bare).toContain('<p class="ref">4.투자계획!E24</p>')
  expect(bare).not.toContain('class="fix"')

  // 사실 칸이 전혀 없으면 옛 모양 그대로 — `what · cells` 한 줄.
  const legacy = painted({ ...base, items: [{ key: 'k4', kind: 'typo', what: '바로잡았어요', cells: ['9.경비계획!B12'] }] })
  expect(legacy).toContain('class="notice-items"')
  expect(legacy).not.toContain('class="notice-easy"')
  expect(legacy).toContain('바로잡았어요 · 9.경비계획!B12')
})
