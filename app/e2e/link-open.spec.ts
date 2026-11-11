/**
 * 대화 속 http(s) 링크 — Node 단위 시험(Electron 창·실제 브라우저 없이).
 *
 * 잠그는 것: ① main 검사 함수의 허용/거부 분기 ② `link:open`이 거부 시 `openExternal`을
 * **아예 부르지 않는가** ③ 렌더러가 단추를 그리고, 누르면 IPC 통로(`link.open`)로 주소를
 * 넘기는가. 실제 브라우저는 열지 않는다 — `openExternal`은 시험 안의 가짜다.
 */
import { expect, test } from '@playwright/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChatMarkdown } from '../src/renderer/src/components/ChatMarkdown'
import { openChatLink } from '../src/renderer/src/components/open-link'
import { checkExternalLink, LINK_MAX_LENGTH } from '../src/main/links/validate'
import { registerLinkIpc, type LinkIpcHost } from '../src/main/links'

const painted = (text: string): string =>
  renderToStaticMarkup(createElement(ChatMarkdown, { text, root: '/Users/student/Thesis', messageId: 'a1' }))

/** `link:open` 하나를 등록해 두고, 부른 기록과 응답을 함께 돌려준다. */
function handler(openExternal: (url: string) => Promise<unknown>) {
  const channels = new Map<string, (_e: unknown, url: unknown) => unknown>()
  const host: LinkIpcHost = { handle: (name, listener) => { channels.set(name, listener) } }
  registerLinkIpc(openExternal, host)
  const invoke = async (url: unknown): Promise<unknown> => channels.get('link:open')!(null, url)
  return { channels, invoke }
}

test('허용: http·https·한글 경로와 쿼리·대문자 스킴은 파서가 정규화한 href 로 통과한다', () => {
  expect(checkExternalLink('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
  expect(checkExternalLink('https://example.com/a?b=1#c')).toEqual({ ok: true, url: 'https://example.com/a?b=1#c' })
  expect(checkExternalLink('  https://agro.seoul.go.kr/archives/55168  '))
    .toEqual({ ok: true, url: 'https://agro.seoul.go.kr/archives/55168' })
  const korean = checkExternalLink('https://ko.wikipedia.org/wiki/딸기?q=가격')
  expect(korean.ok).toBe(true)
  expect(korean.ok && korean.url).toContain('%EB%94%B8%EA%B8%B0')
  expect(checkExternalLink('HTTPS://Example.com/A')).toEqual({ ok: true, url: 'https://example.com/A' })
})

test('거부: javascript·file·data·사용자 정보·빈 값·너무 긴 값·깨진 주소·대문자 JAVASCRIPT', () => {
  expect(checkExternalLink('javascript:alert(1)')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkExternalLink('JAVASCRIPT:alert(1)')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkExternalLink('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkExternalLink('data:text/html,<b>x</b>')).toEqual({ ok: false, reason: 'scheme' })
  // 앱 내부·우편·전화도 이 통로로는 열지 않는다.
  expect(checkExternalLink('knuaf://open?x=1')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkExternalLink('mailto:a@b.example')).toEqual({ ok: false, reason: 'scheme' })
  expect(checkExternalLink('https://user:pw@example.com')).toEqual({ ok: false, reason: 'credentials' })
  expect(checkExternalLink('https://user@example.com')).toEqual({ ok: false, reason: 'credentials' })
  expect(checkExternalLink('')).toEqual({ ok: false, reason: 'empty' })
  expect(checkExternalLink('   ')).toEqual({ ok: false, reason: 'empty' })
  expect(checkExternalLink(undefined)).toEqual({ ok: false, reason: 'empty' })
  expect(checkExternalLink(42)).toEqual({ ok: false, reason: 'empty' })
  expect(checkExternalLink(`https://example.com/${'a'.repeat(LINK_MAX_LENGTH)}`)).toEqual({ ok: false, reason: 'too_long' })
  expect(checkExternalLink('https://')).toEqual({ ok: false, reason: 'malformed' })
  expect(checkExternalLink('http://a b.example')).toEqual({ ok: false, reason: 'malformed' })
  expect(checkExternalLink('항목: 값')).toEqual({ ok: false, reason: 'malformed' })
})

test('link:open — 통과한 주소만 openExternal 로 가고, 거부는 부르지도 않는다', async () => {
  const opened: string[] = []
  const h = handler(async (url) => { opened.push(url) })

  await expect(h.invoke('https://example.com')).resolves.toEqual({ result: { opened: true } })
  expect(opened).toEqual(['https://example.com/'])

  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com', '']) {
    const before = opened.length
    const reply = await h.invoke(bad)
    expect(reply).toMatchObject({ result: { opened: false } })
    expect(opened.length).toBe(before)
  }
})

test('link:open — 열기 실패는 조용히 성공이라고 답하지 않는다', async () => {
  const h = handler(async () => { throw new Error('no browser') })
  await expect(h.invoke('https://example.com')).resolves.toEqual({ result: { opened: false, reason: 'open_failed' } })
})

test('렌더러: 답변 속 http(s) 는 누를 수 있는 단추이고 주소가 그대로 보인다', () => {
  const html = painted('출처는 [후계농 공고](https://agro.seoul.go.kr/archives/55168) 입니다.')
  expect(html).toContain('<button')
  expect(html).toContain('class="lk chat-md-link"')
  expect(html).toContain('data-focus-key="chat-url:a1:https://agro.seoul.go.kr/archives/55168"')
  expect(html).toContain('title="https://agro.seoul.go.kr/archives/55168"')
  expect(html).toContain('후계농 공고')
  expect(html).toContain('https://agro.seoul.go.kr/archives/55168')
  // 앵커·href 는 만들지 않는다(앱이 밖으로 나가는 통로는 하나뿐).
  expect(html).not.toContain('<a ')
  expect(html).not.toContain('href=')
})

test('렌더러: 라벨이 없는 주소도 단추이고, javascript·file 은 글자로만 남는다', () => {
  const bare = painted('[https://example.com/x](https://example.com/x)')
  expect(bare).toContain('class="lk chat-md-link"')
  const bad = painted('[a](javascript:alert(1)) [b](file:///etc/passwd)')
  expect(bad).not.toContain('<button')
  expect(bad).not.toContain('href=')
  expect(bad).toContain('javascript:alert(1)')
})

test('렌더러: 누르면 주소가 IPC 통로로 그대로 간다(가짜 api, 브라우저 안 엶)', async () => {
  const seen: string[] = []
  const api = { open: async (url: string) => { seen.push(url); return { result: { opened: true as const } } } }
  await expect(openChatLink('https://example.com/a', api)).resolves.toBe(true)
  expect(seen).toEqual(['https://example.com/a'])
  // main 이 거부했거나 통로가 없으면 false — 화면은 짧게 안내한다.
  await expect(openChatLink('javascript:alert(1)', { open: async () => ({ result: { opened: false as const, reason: 'scheme' as const } }) }))
    .resolves.toBe(false)
  await expect(openChatLink('https://example.com', undefined)).resolves.toBe(false)
  await expect(openChatLink('https://example.com', { open: async () => { throw new Error('ipc gone') } }))
    .resolves.toBe(false)
})
