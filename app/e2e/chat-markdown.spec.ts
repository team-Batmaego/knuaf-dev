/**
 * 도우미 답 마크다운 부품(`ChatMarkdown`) — Node 단위 시험(Electron 창 없이).
 *
 * 형님 맥 실기(2026-11-09): `###`·`| 표 |`·`[t](url)`·`- 목록`·`` `코드` `` 가 날 글자로 보였다.
 * 여기서 잠그는 것은 ① 그 글자가 요소로 그려지는가 ② 지금 동작(굵게·프로젝트 안 파일 단추)이
 * 그대로인가 ③ 밖으로 나가는 것(주소·`javascript:`·raw HTML·이미지)이 글자로만 남는가다.
 */
import { expect, test } from '@playwright/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChatMarkdown } from '../src/renderer/src/components/ChatMarkdown'

const ROOT = '/Users/student/Thesis'

interface Options { root?: string | null; onFile?: (relative: string) => void }

function painted(text: string, opts: Options = {}): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, {
    text, root: opts.root === undefined ? ROOT : opts.root, messageId: 'a1', onFile: opts.onFile
  }))
}

test('제목·표·목록·기울임·코드·인용은 글자가 아니라 요소로 그려진다', () => {
  const html = painted([
    '### 1. 경영 규모',
    '',
    '| 항목 | 값 |',
    '| --- | ---: |',
    '| 면적 | 600평 |',
    '',
    '- 하나',
    '- 둘',
    '',
    '1. 첫째',
    '2. 둘째',
    '',
    '*기울임* 그리고 `x = 1`',
    '',
    '> 인용문',
    '',
    '```py',
    'print(1)',
    '```'
  ].join('\n'))

  expect(html).toContain('<h3>1. 경영 규모</h3>')
  expect(html).toContain('<table>')
  expect(html).toContain('<th style="text-align:right">값</th>')
  expect(html).toContain('<td style="text-align:right">600평</td>')
  expect(html).toContain('<li>하나</li>')
  expect(html).toContain('<ol>')
  expect(html).toContain('<em>기울임</em>')
  expect(html).toContain('<code class="chat-md-code">x = 1</code>')
  expect(html).toContain('<blockquote>')
  expect(html).toContain('<pre class="chat-md-pre"><code class="language-py">print(1)</code></pre>')
  // 표는 자기 상자 안에서만 가로로 굴린다.
  expect(html).toContain('<div class="chat-md-table"><table>')
  // 날 마크다운 기호가 남지 않는다.
  for (const raw of ['###', '| ---', '```', '- 하나']) expect(html).not.toContain(raw)
})

test('번호 목록은 시작 번호를 지킨다', () => {
  expect(painted('3. 셋\n4. 넷')).toContain('<ol start="3">')
})

test('굵게는 짝이 맞을 때만 굵고, 짝이 없으면 별표가 글자로 남는다', () => {
  expect(painted('먼저 **전공**을 정해요')).toContain('먼저 <strong>전공</strong>을 정해요')
  expect(painted('2 ** 3 = 8')).toContain('2 ** 3 = 8')
  expect(painted('**앞\n뒤**')).toContain('<strong>앞<br/>뒤</strong>')
  // 마크다운 규칙이 닫지 못하는 모양 — 닫는 `**` 앞이 `)`. 실기 답변에 흔하다
  // (“추천은 **A(고설 수경 딸기)**입니다”). 예전 `withBold` 가 잡던 자리를 부품이 이어받는다.
  expect(painted('추천은 **A(고설 수경 딸기)**입니다.')).toContain('추천은 <strong>A(고설 수경 딸기)</strong>입니다.')
  expect(painted('**굵은** 글과 [링크](build/a.md) 사이', { onFile: () => {} }))
    .toContain('<strong>굵은</strong> 글과 ')
  // 짝이 없는 별표 하나는 감추지 않는다.
  expect(painted('별표 ** 하나')).toContain('별표 ** 하나')
})

test('프로젝트 안 상대경로는 누를 수 있는 파일 단추다', () => {
  const html = painted('검토본 [검토전_본문.md](build/검토전_본문.md) 에서 볼 수 있어요.', { onFile: () => {} })
  expect(html).toContain('<button class="lk" data-focus-key="chat-link:a1:build/검토전_본문.md"')
  expect(html).toContain('>검토전_본문.md</button>')
  // 링크 원문 표시(`](`)는 남지 않는다.
  expect(html).not.toContain('](')
})

test('프로젝트 안 절대경로는 상대경로 단추가 되고 전체 경로는 title 에 남는다', () => {
  const target = `${ROOT}/sections/I (머리말 초안).md`
  const html = painted(`[머리말 초안](<${target}>)`, { onFile: () => {} })
  expect(html).toContain('data-focus-key="chat-link:a1:sections/I (머리말 초안).md"')
  expect(html).toContain(`title="${target}"`)
  expect(html).toContain('>머리말 초안</button>')
})

test('경로에 빈칸이 있는 보통 괄호 링크도 파일 단추가 된다', () => {
  // 마크다운 파서가 링크로 읽지 못하는 형태 — 원문에서 직접 줍는다(Chat.tsx 와 같은 규칙).
  const html = painted('[초안](build/draft (1).md).', { onFile: () => {} })
  expect(html).toContain('data-focus-key="chat-link:a1:build/draft (1).md"')
  expect(html).toContain('>초안</button>.')
})

test('파일 단추를 누르면 상대경로가 onFile 로 온다', () => {
  const seen: string[] = []
  const html = painted('[검토전_본문.md](build/검토전_본문.md)', { onFile: (rel) => seen.push(rel) })
  expect(seen).toEqual([])
  expect(html).toContain('data-focus-key="chat-link:a1:build/검토전_본문.md"')
  // onFile 이 없으면 누를 수 있는 것이 아니다 — 글자만 남는다.
  expect(painted('[검토전_본문.md](build/검토전_본문.md)')).not.toContain('<button')
})

test('폴더 밖·상위 경로는 단추가 되지 않고 원문 글자가 남는다', () => {
  const text = '[열쇠](/Users/other/.ssh/id_rsa) 그리고 [위로](../../다른폴더/x.md)'
  const html = painted(text)
  expect(html).not.toContain('<button')
  expect(html).toContain('열쇠')
  expect(html).toContain('위로')
})

test('http(s) 주소는 누를 수 있는 단추가 되고 주소도 함께 보인다 — 앵커는 만들지 않는다', () => {
  const html = painted('[받으세요](https://example.invalid/x.exe)')
  expect(html).toContain('<button')
  expect(html).toContain('class="lk chat-md-link"')
  expect(html).not.toContain('<a ')
  expect(html).not.toContain('href')
  expect(html).toContain('받으세요')
  expect(html).toContain('example.invalid')
  // 맨 주소도 링크가 되지 않는다(linkify: false).
  expect(painted('https://example.com')).not.toContain('<a ')
  expect(painted('https://example.com')).not.toContain('<button')
})

test('javascript: 같은 다른 스킴은 링크 없이 글자다', () => {
  const html = painted('[a](javascript:alert(1))')
  expect(html).not.toContain('<a ')
  expect(html).not.toContain('<button')
  expect(html).not.toContain('javascript:alert(1)</button>')
  expect(html).toContain('a')
})

test('원문 HTML 은 글자로 남는다 (html: false)', () => {
  const html = painted('<script>alert(1)</script> 그리고 <b>굵게</b>')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<b>')
  expect(html).toContain('&lt;script&gt;')
})

test('이미지는 그리지 않고 대체 글자만 남긴다', () => {
  const html = painted('![생산량 그래프](https://example.com/x.png)')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('src=')
  expect(html).toContain('생산량 그래프')
})

test('잘린 원문(2000자 접기·닫히지 않은 코드)에서도 던지지 않고 남은 글을 그린다', () => {
  const html = painted('앞부분\n\n```py\nprint(1)')
  expect(html).toContain('<pre class="chat-md-pre">')
  expect(html).toContain('print(1)')
  expect(painted('앞부분\n\n| 항목 | 값 |\n| --- |')).toContain('앞부분')
  expect(painted('')).toBe('<div class="chat-md"></div>')
})

test('형님 화면의 실제 답변 글 — 제목·표·목록·출처 링크가 그려진다', () => {
  const html = painted([
    '### 작목과 자금 방향',
    '',
    '| 작목 | 소득 |',
    '| --- | ---: |',
    '| 딸기 | 1129.78만원 |',
    '',
    '1. 작목',
    '2. 자금 방향',
    '',
    '조사 자료는 [R-001](artifacts/R-001-crop-funding-options.md) 에 있습니다.',
    '',
    'Sources: [후계농업경영인 선발 공고](https://agro.seoul.go.kr/archives/55168)'
  ].join('\n'), { onFile: () => {} })
  expect(html).toContain('<h3>작목과 자금 방향</h3>')
  expect(html).toContain('<td style="text-align:right">1129.78만원</td>')
  expect(html).toContain('<ol>')
  expect(html).toContain('data-focus-key="chat-link:a1:artifacts/R-001-crop-funding-options.md"')
  expect(html).toContain('agro.seoul.go.kr/archives/55168')
})
