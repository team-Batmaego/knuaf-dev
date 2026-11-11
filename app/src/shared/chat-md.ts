import MarkdownIt from 'markdown-it'

/**
 * 도우미 답변 마크다운 해석기 하나 — `ChatMarkdown` 화면과 진행 목록
 * 파서(`progress-list.ts`)가 **같은 해석기**를 쓴다.
 * (IMPL-T1 §3-2 중요 4 — 화면이 코드·인용으로 그리는 기준과 파서의 제외 영역이 어긋나지 않게.)
 *
 * - `html: false` — 도우미 문자열이 마크업이 되지 않는다.
 * - `linkify: false` — 맨 주소를 저절로 링크로 만들지 않는다.
 * - `typographer: false` — 따옴표·하이픈을 몰래 바꾸지 않는다.
 * - `breaks: true` — 답변 줄바꿈을 그대로 살린다.
 * - `link`·`escape` 규칙 끔 — 윈도우 경로 `\`가 마크다운 이스케이프에 먹이지 않게
 *   (`[라벨](대상)`은 각자 해석한다).
 */
export const chatMd = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false })
chatMd.disable(['link', 'escape'])
