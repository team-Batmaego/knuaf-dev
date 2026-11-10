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
 */
import { expect, test } from '@playwright/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  const revised: NoticeRow = { ...before, key: noticeKey('760bb30514899cd1434376bfa4a21da994b6fd6b9bdabe3190f48c5d69cd9cea', 'f'.repeat(64)) }
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
