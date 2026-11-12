/**
 * 단계 3의 순수 함수 — 배치·폭 규칙과 종이 칸의 "방금 저장된 문단" 판정, 마크다운 렌더.
 *
 * 셋 다 화면 없이 판정할 수 있어야 한다: 폭 경계는 창을 띄우지 않고도 1,139/1,140/
 * 1,219/1,220 을 밟아야 하고(검토 IMPL-R1-06), "방금 칠하기"는 앱을 켠 직후 첫 읽기에서
 * 칠하지 않는 것이 틀리기 쉬운 자리다(책임자 의견 ④). e2e 는 build 뒤 창을 띄우므로
 * 여기서 먼저 잠근다 — Playwright 가 Electron 없이 도는 Node 단위 시험이다.
 */
import { expect, test } from '@playwright/test'
import { CHAT_MAX, CHAT_MIN, WIDE_MIN, chatWidthOf, layoutOf, showsToggle } from '../src/shared/layout'
import { DEFAULT_WINDOW, WINDOW_MARGIN, defaultWindowSize } from '../src/shared/window'
import { newBlockIndexes, splitBlocks } from '../src/shared/paper'
import { fileStateOf, isReviewExport, reviewBasisOf } from '../src/shared/files'
import { renderMarkdown } from '../src/renderer/src/markdown'
import { fileStatusText } from '../src/renderer/src/copy'

// ---------------------------------------------------------------- 기본 창 크기

test('기본 창은 세 칸을 담고 작은 작업 영역 안으로 줄어든다', () => {
  expect(defaultWindowSize({ width: 1728, height: 1117 })).toEqual({ width: 1440, height: 800 })
  expect(DEFAULT_WINDOW).toEqual({ width: 1440, height: 800 })
  expect(defaultWindowSize({ width: 1366, height: 768 })).toEqual({ width: 1366 - WINDOW_MARGIN, height: 768 - WINDOW_MARGIN })
  expect(defaultWindowSize({ width: 1366, height: 768 }).height).toBe(728)
  // 아주 작은 작업 영역 — 가로·세로 모두 −40 으로 줄어든다(화면 밖으로 나가지 않게).
  expect(defaultWindowSize({ width: 1000, height: 700 })).toEqual({ width: 1000 - WINDOW_MARGIN, height: 700 - WINDOW_MARGIN })
  expect(defaultWindowSize({ width: 4000, height: 3000 })).toEqual({ width: 1440, height: 800 })
})

// ------------------------------------------------------------------ 배치·폭

test('오른쪽 칸이 없으면 언제나 한 칸이다', () => {
  for (const width of [900, 1139, 1140, 1280, 1600]) {
    expect(layoutOf({ pane: false, width, closed: false }).kind).toBe('solo')
    expect(layoutOf({ pane: false, width, closed: true }).kind).toBe('solo')
  }
})

test('경계: 1,139 는 바꾸기, 1,140 은 두 칸', () => {
  expect(WIDE_MIN).toBe(1140)
  expect(layoutOf({ pane: true, width: 1139, closed: false }).kind).toBe('switch')
  expect(layoutOf({ pane: true, width: 1140, closed: false })).toEqual({ kind: 'split', chatWidth: 460 })
})

test('대화 칸은 1,219 까지 줄고 1,220 부터 540 고정이다', () => {
  expect(chatWidthOf(1219)).toBe(539)
  expect(chatWidthOf(1220)).toBe(540)
  expect(chatWidthOf(1280)).toBe(540)
  // 아주 넓어도 대화는 540 을 넘지 않는다(넘는 폭은 종이가 가져간다).
  expect(chatWidthOf(4000)).toBe(540)
  // 아주 좁아도 두 칸 판정일 때 대화는 460 아래로 내려가지 않는다.
  expect(chatWidthOf(1140)).toBe(CHAT_MIN)
  expect(chatWidthOf(1220)).toBe(CHAT_MAX)
})

test('넓은 창에서 접으면 제목줄 바꾸기 없이 접힌다', () => {
  const closed = layoutOf({ pane: true, width: 1280, closed: true })
  expect(closed.kind).toBe('folded')
  expect(showsToggle(closed)).toBe(false)
  expect(showsToggle(layoutOf({ pane: true, width: 900, closed: true }))).toBe(true)
  expect(showsToggle(layoutOf({ pane: true, width: 1280, closed: false }))).toBe(false)
  expect(showsToggle(layoutOf({ pane: false, width: 1280, closed: false }))).toBe(false)
})

// ---------------------------------------------------- 방금 저장된 문단 판정

test('문단 나누기 — 빈 줄이 경계이고 펜스 안 빈 줄은 경계가 아니다', () => {
  expect(splitBlocks('첫 문단\n\n둘째 문단')).toEqual(['첫 문단', '둘째 문단'])
  // 여러 빈 줄, 앞뒤 빈 줄은 문단을 만들지 않는다.
  expect(splitBlocks('\n\n가\n\n\n\n나\n\n')).toEqual(['가', '나'])
  expect(splitBlocks('   ')).toEqual([])
  const fenced = ['설명', '', '```', 'a', '', 'b', '```', '', '끝'].join('\n')
  expect(splitBlocks(fenced)).toEqual(['설명', '```\na\n\nb\n```', '끝'])
})

test('새 문단 판정 — 앞에 없던 문단만 새것이다', () => {
  // 도우미가 한 문단을 덧붙였다.
  expect(newBlockIndexes(splitBlocks('가\n\n나'), splitBlocks('가\n\n나\n\n다'))).toEqual([2])
  // 앱을 켠 직후 첫 읽기: 직전이 없으므로 전부 "새것"이다 — 화면이 이 경우를 걸러 칠하지 않는다.
  expect(newBlockIndexes([], splitBlocks('가\n\n나'))).toEqual([0, 1])
  // 바뀌지 않았으면 아무것도 아니다.
  expect(newBlockIndexes(splitBlocks('가\n\n나'), splitBlocks('가\n\n나'))).toEqual([])
})

test('같은 문장이 하나 더 들어오면 새로 온 하나만 칠한다', () => {
  const prev = splitBlocks('가')
  expect(newBlockIndexes(prev, splitBlocks('가\n\n가'))).toEqual([1])
  // 순서가 바뀐 경우: 예전 묶음에 다 있으므로 새것이 아니다.
  expect(newBlockIndexes(splitBlocks('가\n\n나'), splitBlocks('나\n\n가'))).toEqual([])
})

test('본문이 다시 쓰이면 새로 온 문단만 칠한다', () => {
  expect(newBlockIndexes(splitBlocks('가\n\n나'), splitBlocks('가\n\n바뀐 나'))).toEqual([1])
})

// ------------------------------------------------------------------ 마크다운

test('마크다운 — 표·제목·목록은 그린다', () => {
  const html = renderMarkdown('### 1. 경영 규모\n\n| 항목 | 값 |\n| --- | --- |\n| 면적 | 600평 |\n\n- 하나\n- 둘\n')
  expect(html).toContain('<h3>')
  expect(html).toContain('<table>')
  expect(html).toContain('<td>600평</td>')
  expect(html).toContain('<li>하나</li>')
})

test('마크다운 — 원문 HTML 은 글자로 남는다 (html: false)', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n본문 <b>굵게</b>')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<b>')
  expect(html).toContain('&lt;script&gt;')
})

test('마크다운 — 링크는 열지 않는다 (GUI-12). 글자만 남는다', () => {
  const html = renderMarkdown('자세히는 [학교 안내](https://example.com/a) 참고')
  expect(html).not.toContain('<a')
  expect(html).not.toContain('href')
  expect(html).toContain('학교 안내')
  // 맨 주소도 링크가 되지 않는다(linkify: false).
  expect(renderMarkdown('https://example.com')).not.toContain('<a')
})

test('마크다운 — 이미지는 그리지 않는다. 앱이 원격 주소를 부르면 안 된다', () => {
  const html = renderMarkdown('![생산량 그래프](https://example.com/x.png)')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('src=')
  expect(html).toContain('생산량 그래프')
})

// ------------------------------------------------------- 본문 속 HTML 표(병합 칸)

test('HTML 표 — 병합 칸(rowspan·colspan)을 표로 다시 짓는다', () => {
  const html = renderMarkdown(
    '표 2. 밀양시 기상 현황(2021~2025년) (출처 : 기상청)\n' +
    '<table>\n' +
    '  <caption>밀양시 기상</caption>\n' +
    '  <thead>\n' +
    '    <tr><th rowspan="2">구 분</th><th colspan="3">겨울</th></tr>\n' +
    '    <tr><th>12월</th><th>1월</th><th>2월</th></tr>\n' +
    '  </thead>\n' +
    '  <tbody>\n' +
    '    <tr><th>강우량(mm)</th><td>21.2</td><td>18.4</td><td>20.1</td></tr>\n' +
    '  </tbody>\n' +
    '</table>\n' +
    '(출처 : 기상청)\n'
  )
  expect(html).toContain('<table>')
  expect(html).toContain('<caption>밀양시 기상</caption>')
  expect(html).toContain('<th rowspan="2">구 분</th>')
  expect(html).toContain('<th colspan="3">겨울</th>')
  expect(html).toContain('<td>21.2</td>')
  // 표 앞뒤 마크다운은 그대로 남는다(제목 줄·출처 줄이 표에 먹히지 않는다).
  expect(html).toContain('표 2. 밀양시 기상 현황(2021~2025년) (출처 : 기상청)')
  expect(html).toContain('(출처 : 기상청)')
  expect(html).not.toContain('&lt;table')
})

test('HTML 표 — 칸 글자의 표식은 글자 노드로 그대로 남는다 (뷰어 B)', () => {
  const html = renderMarkdown('<table><tr><td>GGEDITV123abc</td></tr></table>')
  expect(html).toContain('<td>GGEDITV123abc</td>')
})

// kordoc 은 칸 글자를 escapeHtml 해 내보낸다(실측: 4.17.1·4.24.66 모두 `R&D` → `R&amp;D`,
// `p < 0.05` → `p &lt; 0.05`). 그 엔티티를 그대로 두면 화면에 `R&amp;D` 로 보이므로 한 번 되돌린다.
test('HTML 표 — kordoc 이 이스케이프한 칸 글자는 화면에 원래 글자로 보인다', () => {
  const html = renderMarkdown(
    '<table><tr><td>R&amp;D</td><td>a &lt; b</td><td>3&nbsp;개</td></tr></table>'
  )
  // 되돌린 뒤 곧바로 다시 이스케이프한다 — 마크업이 아니라 글자다.
  expect(html).toContain('<td>R&amp;D</td>')
  expect(html).toContain('<td>a &lt; b</td>')
  expect(html).toContain('<td>3\u00a0개</td>')
  expect(html).not.toContain('&amp;amp;')
  expect(html).not.toContain('&amp;lt;')
  expect(html).not.toContain('&amp;nbsp;')
})

test('HTML 표 — 엔티티는 한 번만 되돌린다(두 번 풀지 않는다)', () => {
  const html = renderMarkdown('<table><tr><td>&amp;lt;b&amp;gt;</td></tr></table>')
  // `&amp;lt;` → `&lt;` 에서 멈춘다. 화면에는 `&lt;b&gt;` 라는 글자가 그대로 보인다.
  expect(html).toContain('<td>&amp;lt;b&amp;gt;</td>')
})

test('HTML 표 — 정해진 엔티티 밖의 &…; 는 글자 그대로 둔다', () => {
  const html = renderMarkdown(
    '<table><tr><td>&copy;</td><td>&#65;</td><td>&#x41;</td><td>&#0;</td></tr></table>'
  )
  expect(html).toContain('<td>&amp;copy;</td>')  // 모르는 이름은 손대지 않는다
  expect(html).toContain('<td>A</td>')           // 십진·십육진 숫자 엔티티는 되돌린다
  expect(html).toContain('<td>A</td>')
  expect(html).toContain('<td>&amp;#0;</td>')    // 0 은 글자로 남긴다(빈 문자로 만들지 않는다)
})

test('HTML 표 — 표식은 엔티티 되돌리기에도 안 깨진다 (뷰어 B)', () => {
  const html = renderMarkdown('<table><tr><td>GGEDITV123abc R&amp;D</td></tr></table>')
  expect(html).toContain('<td>GGEDITV123abc R&amp;D</td>')
})

test('HTML 표 — 허용 태그 caption·thead·tbody·tfoot·br 은 그린다', () => {
  const html = renderMarkdown(
    '<table><caption>제목</caption><thead><tr><th>가</th></tr></thead>' +
    '<tbody><tr><td>나<br>다</td></tr></tbody><tfoot><tr><td>합</td></tr></tfoot></table>'
  )
  expect(html).toContain('<caption>제목</caption>')
  expect(html).toContain('<thead>')
  expect(html).toContain('<td>나<br>다</td>')
  expect(html).toContain('<tfoot>')
})

test('HTML 표 — 허용 밖이 하나라도 있으면 블록 통째로 글자 (실패 닫힘)', () => {
  const attacks = [
    // 이벤트 속성·style·그 밖의 속성
    '<table><tr><td onclick="alert(1)">x</td></tr></table>',
    '<table><tr><td style="color:red">x</td></tr></table>',
    '<table class="a"><tr><td>x</td></tr></table>',
    // 스크립트·이미지·링크·허용 밖 태그
    '<table><tr><td><script>alert(1)</script></td></tr></table>',
    '<table><tr><td><img src="https://example.com/x.png"></td></tr></table>',
    '<table><tr><td><a href="https://example.com">x</a></td></tr></table>',
    '<table><tr><td><div>x</div></td></tr></table>',
    // 주석
    '<table><!-- x --><tr><td>x</td></tr></table>',
    // 병합 칸 값 경계
    '<table><tr><td colspan="0">x</td></tr></table>',
    '<table><tr><td colspan="1000">x</td></tr></table>',
    // 굽은 따옴표 속성값(복사 과정에서 생길 수 있다) — 허용하지 않는다.
    '<table><tr><td rowspan=“2”>x</td></tr></table>',
    // 짝이 안 맞는 태그
    '<table><tr><td>x</td></tr>',
    '<table><tr><td>x</table>'
  ]
  for (const src of attacks) {
    const html = renderMarkdown(src)
    expect(html, src).not.toContain('<table')
    expect(html, src).not.toContain('<td')
    expect(html, src).toContain('&lt;table')
  }
})

// ------------------------------------------------------------------ 파일 현재성

test('파일 현재성 — 등록된 것만 말하고, 판정은 stale 하나로 한다', () => {
  const load = { project: { outputs: {
    'out-docx': { path: 'build/검토전_논문.docx', revision: 3, stale: false },
    'build/재무.xlsx': { stale: true }
  } } }
  // 값 안의 path 로도, 키 그대로도 찾는다(outputs 의 키는 출력 id 다).
  expect(fileStateOf('build/검토전_논문.docx', load)).toBe('same')
  expect(fileStateOf('build/재무.xlsx', load)).toBe('stale')
  // 등록되지 않은 파일은 "앱이 몰라요"다 — 기록 번호를 비교해 짐작하지 않는다.
  expect(fileStateOf('build/모르는.md', load)).toBe('unknown')
  expect(fileStateOf('build/모르는.md', null)).toBe('unknown')
  // stale 이 없는 항목은 오래되지 않은 것으로 읽는다(등록은 됐다).
  expect(fileStateOf('a', { project: { outputs: { a: { path: 'a' } } } })).toBe('same')
  // outputs 가 비어 있어도 던지지 않는다.
  expect(fileStateOf('a', { project: {} })).toBe('unknown')
})

test('검토본 파일은 개정 번호로만 말한다 — outputs 에 등록되지 않는다', () => {
  expect(isReviewExport('build/14/review/검토용.md')).toBe(true)
  expect(isReviewExport('build/검토전_본문.md')).toBe(false)
  expect(isReviewExport('build/14/docx/검토용.md')).toBe(false)
  // 사이드카는 `build/<개정>/review/<파일>.md` 한 겹으로만 만든다 — 그 아래 더 들어간
  // 파일은 검토본으로 보지 않는다(결과물 화면이 쓰던 규칙 그대로다).
  expect(isReviewExport('build/14/review/하위/검토용.md')).toBe(false)
})

test('검토본 기준은 그 파일의 개정에서 읽는다 (P3-R1-03)', () => {
  // 진행 판정의 최대 N(`reviewExport`)과 파일 하나의 기준은 다른 사실이다.
  expect(reviewBasisOf('build/1/review/검토용.md')).toBe(1)
  expect(reviewBasisOf('build/2/review/검토용.md')).toBe(2)
  expect(reviewBasisOf('build/14/review/검토용.md')).toBe(14)
  expect(reviewBasisOf('build/검토전_본문.md')).toBeNull()
  expect(reviewBasisOf('build/14/docx/검토용.md')).toBeNull()
  expect(reviewBasisOf('build/14/review/하위/검토용.md')).toBeNull()
  expect(isReviewExport('build/2/review/검토용.md')).toBe(true)
})

test('파일 현재성 문구 — 검토본은 자기 개정, 나머지는 stale, 근거 없으면 모름 (P3-R1-03·06)', () => {
  const load = { project: { outputs: { 'build/known.docx': { path: 'build/known.docx', stale: true } } } }
  // 검토본 둘이 각자 자기 기준을 말한다(둘 다 최신 N 을 붙이면 여기서 걸린다).
  expect(fileStatusText('build/2/review/검토용.md', load)).not.toBe(fileStatusText('build/1/review/검토용.md', load))
  expect(fileStatusText('build/2/review/검토용.md', load)).toContain('2')
  expect(fileStatusText('build/1/review/검토용.md', load)).toContain('1')
  expect(fileStatusText('build/known.docx', load)).toContain('빠져')
  expect(fileStatusText('build/모르는.docx', load)).toContain('몰라요')
})

test('마크다운 — 빈 원문은 빈 문자열', () => {
  expect(renderMarkdown('   \n  ')).toBe('')
})
