/**
 * 중간말 접기·형식 질문 범위 — Node 단위 시험(Playwright 가 Electron 없이 돈다).
 *
 * 형님 실기록(`chat-claude.json`)에서 확정한 두 가지를 여기서 잠근다.
 *  1. 한 턴의 마지막 assistant 말만 최종 답이다. 앞말은 접히고, 접힌 글은 사라지지 않는다.
 *  2. `[Q3]` 형식 질문은 `parseQuestion` 이 못 읽어 zone 이 `form` 이 된다 — 카드가 보여 주는
 *     번호 칸과 머리 줄만 원문에서 감추고, 카드에 없는 설명 문장은 남긴다.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { cutAtLine, formFold, progressGroups, stripLines } from '../src/shared/chat-fold'
import type { ChatMessage } from '../src/shared/chat'

const at = (n: number): string => new Date(Date.UTC(2026, 10, 9, 0, 0, n)).toISOString()
const msg = (id: string, role: ChatMessage['role'], text = id, n = 0): ChatMessage => ({ id, role, text, at: at(n) })

test('한 턴의 마지막 assistant 말만 펴고 앞말은 한 묶음으로 접는다', () => {
  const messages = [
    msg('u1', 'user', '질문', 1),
    msg('a1', 'assistant', '혼잣말 1', 2),
    msg('a2', 'assistant', '혼잣말 2', 3),
    msg('a3', 'assistant', '최종 답', 4)
  ]
  const groups = progressGroups(messages)
  expect(groups).toHaveLength(1)
  expect(groups[0].count).toBe(2)
  expect([...groups[0].ids]).toEqual(['a1', 'a2'])
  expect(groups[0].at).toBe(Date.parse(at(2)))
})

test('첫 학생 말 앞의 시작 안내는 접지 않는다', () => {
  const messages = [msg('a0', 'assistant', '시작 안내', 0), msg('u1', 'user', '시작하기', 1), msg('a1', 'assistant', '답', 2)]
  expect(progressGroups(messages)).toEqual([])
})

test('턴마다 따로 접는다', () => {
  const messages = [
    msg('u1', 'user', '', 1), msg('a1', 'assistant', '', 2), msg('a2', 'assistant', '', 3),
    msg('u2', 'user', '', 4), msg('a3', 'assistant', '', 5), msg('a4', 'assistant', '', 6), msg('a5', 'assistant', '', 7)
  ]
  const groups = progressGroups(messages)
  expect(groups.map((g) => g.count)).toEqual([1, 2])
  expect([...groups[1].ids]).toEqual(['a3', 'a4'])
})

test('학생 말 없이 이어진 대화는 아무것도 접지 않는다', () => {
  expect(progressGroups([msg('a1', 'assistant', '', 1), msg('a2', 'assistant', '', 2)])).toEqual([])
})

const FORM = `앞 설명 문장입니다.

[Q2] 기본 계획

각각 알려주세요.

1. 전공 (학과 소속)
   예: 특용작물전공
   미정이면: 학과를 알려주세요

2. 자금 (자기자본과 융자를 나눠서)
   예: 자기자본 1억
   미정이면: 표준 모델을 제시합니다

뒤 설명 문장입니다.`

test('여러 칸 질문은 머리 줄과 번호 칸만 감추고 설명 문장은 남긴다', () => {
  const fold = formFold(FORM)!
  expect(fold.count).toBe(2)
  // 머리 줄 하나 + 번호 칸 블록 하나. 그 사이 설명 문장은 남는다.
  expect(fold.spans).toEqual([{ start: 2, end: 2 }, { start: 6, end: 13 }])
  const shown = stripLines(FORM, fold.spans).split('\n')
  expect(shown[0]).toBe('앞 설명 문장입니다.')
  // 카드에 없는 문장 — 접기가 글을 버리지 않는다는 규칙.
  expect(shown).toContain('각각 알려주세요.')
  expect(shown).toContain('뒤 설명 문장입니다.')
  expect(shown.join('\n')).not.toContain('[Q2] 기본 계획')
  expect(shown.join('\n')).not.toContain('2. 자금')
})

test('형식이 어긋나면 범위를 만들지 않는다 — 카드가 뜨는 조건을 흔들지 않는다', () => {
  expect(formFold('[Q2] 하나\n1. 전공')).toBeNull()
  expect(formFold('질문만 있고 번호 칸이 없습니다')).toBeNull()
  expect(formFold(FORM.replace('2. 자금', '2) 자금'))).toBeNull()
  expect(formFold(FORM.replace('2. 자금', '3. 자금'))).toBeNull()
})

test('형님 실기록의 Q3 — 카드가 보여 주는 칸만 감춘다', () => {
  let text = ''
  try {
    const file = '/Users/nara/Desktop/v061시험/.knuaf-gui/chat-claude.json'
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as { messages: { role: string; text: string }[] }
    text = saved.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
  } catch { /* 남의 맥에 기록이 없다 — 아래 형식으로 같은 조건을 만든다 */ }
  if (!text) text = `조사 결과입니다.\n\n[Q3] 작목과 자금 방향\n1. 작목\n    예: A 고설 수경 딸기\n2. 자금 방향\n    미정이면: 검토용 가정으로 둡니다\n\n위 수치는 조사 자료입니다.`
  const fold = formFold(text)
  expect(fold, 'Q3 형식 질문을 카드 범위로 읽지 못했다').not.toBeNull()
  const shown = stripLines(text, fold!.spans)
  expect(shown).not.toContain('[Q3] 작목과 자금 방향')
  expect(shown).not.toContain('2. 자금 방향')
  // 카드에 없는 글은 남는다 — 머리 줄 앞의 본문과 칸 블록 뒤의 마무리 문단.
  const first = text.split('\n').find((line) => line.trim())!
  expect(shown).toContain(first)
})

test('긴 답은 줄 경계에서 자르고, 줄이 너무 길면 한도에서 자른다', () => {
  const body = Array.from({ length: 100 }, (_, i) => `줄 ${i} 입니다`).join('\n')
  const cut = cutAtLine(body, 200)
  expect(cut.length).toBeLessThanOrEqual(200)
  expect(body.startsWith(cut)).toBe(true)
  expect(cut.endsWith('입니다')).toBe(true)
  expect(cutAtLine('가'.repeat(300), 200)).toHaveLength(200)
  expect(cutAtLine('짧음', 200)).toBe('짧음')
})
