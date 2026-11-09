/**
 * 진행 목록 파서(`progress-list.ts`) + 고르기(`pickProgress`) — Node 단위 시험.
 *
 * IMPL-T1 §3-4 P1~P19·S1~S6. 실기록 고정 글은 `fixtures/progress-real-v061.ts`.
 * 파서는 markdown-it(`chat-md.ts`, ChatMarkdown와 같은 해석기) 톤으로 코드·인용
 * 영역을 제외한다(P13~P16).
 */
import { expect, test } from '@playwright/test'
import {
  lastValidProgress,
  mergeFoldSpans,
  parseProgress,
  pickProgress,
  progressHide,
  parseStoredProgress,
  type ProgressPick,
  type StoredProgress,
} from '../src/shared/progress-list'
import { stripLines } from '../src/shared/chat-fold'
import { REAL_STEP2, REAL_STEP4, REAL_STEP11 } from './fixtures/progress-real-v061'

const states = (text: string): string => {
  const { blocks } = parseProgress(text)
  if (blocks.length === 0) return ''
  return blocks[blocks.length - 1].steps.map((s) => (s.state === 'done' ? '✓' : s.state === 'now' ? '▶' : '○')).join('')
}

/* ------------------------------------------------------------------ P 파서 */

test('P1 실기록 #2 — 감출 구간 [3,7], 앞 줄·다음 작업 줄은 구간 밖', () => {
  const { blocks, hide } = parseProgress(REAL_STEP2)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].n).toBe(1)
  expect(blocks[0].reviewPending).toBe(true)
  expect(blocks[0].after).toBe('한글 마무리(글꼴·여백·쪽번호)·교수 승인 — 학생 몫')
  expect(blocks[0].steps[0].state).toBe('now')
  expect(blocks[0].steps[0].note).toBe('작업폴더에 정본 만들고 자료 확인 질문 보냄')
  expect(hide).toEqual([{ start: 3, end: 7 }])
  const rest = stripLines(REAL_STEP2, hide)
  expect(rest).toContain('창업논문 도우미')
  expect(rest).toContain('다음 작업')
  expect(rest).toContain('지금 확인할 것')
  expect(rest).not.toContain('창업논문 진행 목록')
})

test('P2 실기록 #4 — ▶1·▶2, 표시 n=2, reviewPending', () => {
  const { blocks, hide } = parseProgress(REAL_STEP4)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].n).toBe(2)
  expect(blocks[0].reviewPending).toBe(true)
  expect(states(REAL_STEP4)).toBe('▶▶○○○○○')
  expect(blocks[0].steps[0].note).toContain('전공 바인딩 남음')
  expect(blocks[0].steps[1].note).toContain('질문 보냄')
  expect(hide).toEqual([{ start: 0, end: 5 }])
})

test('P3 실기록 #11 — ✓1(메모 보관) ▶2, after 그대로', () => {
  const { blocks, hide } = parseProgress(REAL_STEP11)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].n).toBe(2)
  expect(states(REAL_STEP11)).toBe('✓▶○○○○○')
  expect(blocks[0].steps[0].note).toContain('바인딩 등록')
  expect(blocks[0].after).toBe('한글 마무리(글꼴·여백·쪽번호)·교수 승인 — 학생 몫')
  expect(hide).toEqual([{ start: 0, end: 5 }])
})

test('P4 실기록 12메시지 → lastValidProgress 는 #11', () => {
  const at = (n: number): string => new Date(Date.now() - 60_000 + n * 1000).toISOString()
  const messages = [
    { id: 'u0', role: 'user' as const, text: '시작하기', at: at(0) },
    { id: 'a1', role: 'assistant' as const, text: '작업 폴더를 확인하고 스킬 준비를 시작합니다.', at: at(1) },
    { id: 'm2', role: 'assistant' as const, text: REAL_STEP2, at: at(2) },
    { id: 'u1', role: 'user' as const, text: '전부 없음', at: at(3) },
    { id: 'm4', role: 'assistant' as const, text: REAL_STEP4, at: at(4) },
    { id: 'u2', role: 'user' as const, text: '전공은 원예', at: at(5) },
    { id: 'a6', role: 'assistant' as const, text: '전공을 받았습니다. 확인하겠습니다.', at: at(6) },
    { id: 'a7', role: 'assistant' as const, text: '등록했습니다. 읽겠습니다.', at: at(7) },
    { id: 'a8', role: 'assistant' as const, text: '조사로 넘어갑니다.', at: at(8) },
    { id: 'a9', role: 'assistant' as const, text: '외부 조사로 넘어갑니다.', at: at(9) },
    { id: 'a10', role: 'assistant' as const, text: '결과를 정리하겠습니다.', at: at(10) },
    { id: 'm11', role: 'assistant' as const, text: REAL_STEP11, at: at(11) },
  ]
  void messages
  const pick = lastValidProgress(messages as never, 'claude')
  expect(pick).not.toBeNull()
  expect(pick!.messageId).toBe('m11')
  expect(pick!.provider).toBe('claude')
  expect(pick!.block.n).toBe(2)
  expect(pick!.block.steps[0].state).toBe('done')
})

test('P5 단계 이름 틀림 — 버림, 감출 구간 없음', () => {
  const text = '**창업논문 진행 목록** · 7단계 중 1단계 진행 중\n✓ 1 자료 확인 — x\n○ 2–7단계 남음'
  const { blocks, hide } = parseProgress(text)
  expect(blocks).toEqual([])
  expect(hide).toEqual([])
})

test('P6 3 빠짐 — 버림', () => {
  const text = '창업논문 진행 목록 · 7단계 중 2단계 진행 중\n✓ 1 자료·전공 확인\n▶ 2 계획 인터뷰\n○ 4–7단계 남음'
  expect(parseProgress(text).blocks).toEqual([])
})

test('P7 제목 1–2 + ▶2만 — 제목 [2,2]와 ▶ 최소~최대 미일치로 버림', () => {
  const text = '창업논문 진행 목록 · 7단계 중 3단계 진행 중\n✓ 1 자료·전공 확인\n▶ 2 계획 인터뷰\n○ 3–7단계 남음'
  expect(parseProgress(text).blocks).toEqual([])
})

test('P8 제목 6단계 중 — 버림', () => {
  const text = '창업논문 진행 목록 · 6단계 중 1단계 진행 중\n▶ 1 자료·전공 확인\n○ 2–6단계 남음'
  expect(parseProgress(text).blocks).toEqual([])
})

test('P9 기호·말 어긋남 ✓ 3–7단계 남음 — 버림', () => {
  const text = '창업논문 진행 목록 · 7단계 중 2단계 진행 중\n✓ 1 자료·전공 확인\n▶ 2 계획 인터뷰\n✓ 3–7단계 남음'
  expect(parseProgress(text).blocks).toEqual([])
})

test('P10 접힌 끝남 + ▶4 + ⚑ + ○ 5–7 + 그 뒤 — 유효, flags 1', () => {
  const text = [
    '창업논문 진행 목록 · 7단계 중 4단계 진행 중',
    '✓ 1–3단계 끝남 — 전공·계획·근거',
    '▶ 4 본문 Ⅰ~Ⅵ 초안 — Ⅰ·Ⅱ장 끝, 이번에 Ⅲ장',
    '⚑ 온실 시공 견적서 — Ⅳ장·재무 엑셀에 필요',
    '○ 5–7단계 남음',
    '그 뒤: 한글 마무리·교수 승인 — 학생 몫',
  ].join('\n')
  const { blocks, hide } = parseProgress(text)
  expect(blocks).toHaveLength(1)
  expect(states(text)).toBe('✓✓✓▶○○○')
  expect(blocks[0].flags).toHaveLength(1)
  expect(blocks[0].flags[0]).toContain('견적서')
  expect(hide).toEqual([{ start: 0, end: 5 }])
})

test('P11 그 뒤 없음 + 빈 줄로 끝 — 유효, after null, 빈 줄 앞에서 끝', () => {
  const text = [
    '앞 안내 한 줄',
    '',
    '창업논문 진행 목록 · 7단계 중 1단계 진행 중',
    '▶ 1 자료·전공 확인 — 정본 만들고 질문 보냄',
    '○ 2–7단계 남음',
    '',
    '- **다음 작업**: 이어갑니다.',
  ].join('\n')
  const { blocks, hide } = parseProgress(text)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].after).toBeNull()
  expect(hide).toEqual([{ start: 2, end: 5 }])
})

test('P12 한 메시지에 유효 덩어리 둘 + 사이 설명 문장 — 구간 둘, 사이 문장 남음, 상태는 뒤 덩어리', () => {
  const text = [
    '창업논문 진행 목록 · 7단계 중 1단계 진행 중',
    '▶ 1 자료·전공 확인 — 묻고 있다',
    '○ 2–7단계 남음',
    '그 뒤: 한글 마무리·교수 승인 — 학생 몫',
    '',
    '사이 설명 — 두 덩어리 사이 문장이다.',
    '',
    '창업논문 진행 목록 · 7단계 중 2단계 진행 중',
    '✓ 1 자료·전공 확인 — 답을 받았다',
    '▶ 2 계획 인터뷰 — 묻고 있다',
    '○ 3–7단계 남음',
  ].join('\n')
  const { blocks, hide } = parseProgress(text)
  expect(blocks).toHaveLength(2)
  expect(blocks[1].n).toBe(2)
  expect(hide).toHaveLength(2)
  const rest = stripLines(text, hide)
  expect(rest).toContain('사이 설명')
  expect(rest).not.toContain('창업논문 진행 목록')
})

test('P13 ``` 울타리 안 덩어리 — 무시', () => {
  const text = ['````', '창업논문 진행 목록 · 7단계 중 1단계 진행 중', '▶ 1 자료·전공 확인', '○ 2–7단계 남음', '````'].join('\n')
  const { blocks } = parseProgress(text)
  expect(blocks).toEqual([])
})

test('P14 ~~~ 울타리 안 덩어리 — 무시', () => {
  const text = ['~~~', '창업논문 진행 목록 · 7단계 중 1단계 진행 중', '▶ 1 자료·전공 확인', '○ 2–7단계 남음', '~~~'].join('\n')
  expect(parseProgress(text).blocks).toEqual([])
})

test('P15 빈 줄 뒤 4칸 들여쓰기 덩어리(code_block) — 무시', () => {
  // 앞 줄 + 빈 줄 뒤 4칸 들여쓰기 — markdown-it `code_block`.
  const indented = '앞 안내 한 줄이다.\n\n    창업논문 진행 목록 · 7단계 중 1단계 진행 중\n    ▶ 1 자료·전공 확인\n    ○ 2–7단계 남음\n\n그 뒤: 한글 마무리·교수 승인 — 학생 몫'
  expect(parseProgress(indented).blocks).toEqual([])
})

test('P16 > 인용 안 덩어리 — 무시', () => {
  const text = '> 창업논문 진행 목록 · 7단계 중 1단계 진행 중\n> ▶ 1 자료·전공 확인\n> ○ 2–7단계 남음'
  // 인용 줄은 `> ` 뒤가 아니므로 TITLE과 매치되지 않는다 — 덩어리 성립 안 함.
  expect(parseProgress(text).blocks).toEqual([])
})

test('P17 ▶ 메모에 "확인 필요" — uncertain true', () => {
  const text = '창업논문 진행 목록 · 7단계 중 1단계 진행 중\n▶ 1 자료·전공 확인 — 확인 필요, 자료가 많다\n○ 2–7단계 남음'
  const { blocks } = parseProgress(text)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].steps[0].uncertain).toBe(true)
})

test('P18 모두 ✓ — 유효', () => {
  const text = [
    '창업논문 진행 목록 · 7단계 중 7단계 진행 중',
    '✓ 1 자료·전공 확인',
    '✓ 2 계획 인터뷰',
    '✓ 3 조사·근거 정리',
    '✓ 4 본문 Ⅰ~Ⅵ 초안',
    '✓ 5 재무 엑셀',
    '✓ 6 검토·고치기',
    '✓ 7 워드 검토본',
    '그 뒤: 한글 마무리·교수 승인 — 학생 몫',
  ].join('\n')
  const { blocks } = parseProgress(text)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].n).toBe(7)
  expect(blocks[0].steps.every((s) => s.state === 'done')).toBe(true)
})

test('P19 카드 접기 구간과 덩어리 구간이 맞닿음 — 합친 뒤 둘 다 없음, 앞뒤 설명 남음', () => {
  const text = [
    '앞 설명 한 줄이다.',
    '창업논문 진행 목록 · 7단계 중 1단계 진행 중',
    '▶ 1 자료·전공 확인',
    '○ 2–7단계 남음',
    '[Q1] 카드 머리',
    '1. 질문 하나',
    '뒤 설명 한 줄이다.',
  ].join('\n')
  const hide = progressHide(text)
  expect(hide).toEqual([{ start: 1, end: 3 }])
  const merged = mergeFoldSpans([...hide, { start: 4, end: 5 }])
  const rest = stripLines(text, merged)
  expect(rest).toContain('앞 설명')
  expect(rest).toContain('뒤 설명')
  expect(rest).not.toContain('창업논문 진행 목록')
  expect(rest).not.toContain('[Q1]')
  expect(rest).not.toContain('1. 질문')
})

/* ------------------------------------------------------------------ S 고르기 */

const pickAt = (n: number, at: string, id: string, provider: 'codex' | 'claude' = 'claude'): ProgressPick => {
  const steps = Array.from({ length: 7 }, (_, i) => {
    const s = i + 1
    return {
      n: s,
      state: (s < n ? 'done' : s === n ? 'now' : 'todo') as 'done' | 'now' | 'todo',
    }
  })
  return {
    block: { steps, flags: [], after: null, reviewPending: false, n },
    messageId: id,
    provider,
    at,
  }
}

test('S1 저장 Claude 14:00 4단계, 지금 Codex 대화 11:00 2단계 → 4단계, 저장값 그대로', () => {
  const conv = pickAt(2, '2026-11-09T11:00:00Z', 'c2', 'codex')
  const stored = pickAt(4, '2026-11-09T14:00:00Z', 'cl4', 'claude') as StoredProgress
  const r = pickProgress(conv, stored, '/papers/a', '/papers/a')
  expect(r.kind).toBe('stored')
  if (r.kind === 'stored') expect(r.pick.block.n).toBe(4)
})

test('S2 저장 11:00 2단계, 대화 14:00 4단계 → 4단계, 저장값 갱신(대화 값으로)', () => {
  const conv = pickAt(4, '2026-11-09T14:00:00Z', 'c4', 'codex')
  const stored = pickAt(2, '2026-11-09T11:00:00Z', 'cl2', 'claude') as StoredProgress
  const r = pickProgress(conv, stored, '/papers/a', '/papers/a')
  expect(r.kind).toBe('conversation')
  if (r.kind === 'conversation') expect(r.pick.block.n).toBe(4)
})

test('S3 같은 공급자 재진입(대화 ▶2가 저장 ▶4보다 늦음) → 2단계', () => {
  const conv = pickAt(2, '2026-11-09T14:00:00Z', 'c2', 'codex')
  const stored = pickAt(4, '2026-11-09T11:00:00Z', 'c4', 'codex') as StoredProgress
  const r = pickProgress(conv, stored, '/papers/a', '/papers/a')
  expect(r.kind).toBe('conversation')
  if (r.kind === 'conversation') expect(r.pick.block.n).toBe(2)
})

test('S4 snapshotRoot ≠ root → 대화 무시, 저장값(그 root)만', () => {
  const conv = pickAt(2, '2026-11-09T14:00:00Z', 'c2', 'codex')
  const stored = pickAt(4, '2026-11-09T11:00:00Z', 'c4', 'codex') as StoredProgress
  const r = pickProgress(conv, stored, '/papers/b', '/papers/a')
  expect(r.kind).toBe('stored')
  if (r.kind === 'stored') expect(r.pick.block.n).toBe(4)
})

test('S5 저장값 JSON 깨짐 — pickProgress는 저장값 null로 받음, parseStoredProgress는 null', () => {
  expect(parseStoredProgress('{broken')).toBeNull()
  expect(parseStoredProgress('')).toBeNull()
  expect(parseStoredProgress(null)).toBeNull()
  const r = pickProgress(pickAt(2, '2026-11-09T14:00:00Z', 'c2'), parseStoredProgress('{broken'), '/papers/a', '/papers/a')
  expect(r.kind).toBe('conversation')
})

test('S6 동률 — (가) id·provider 같음 → 대화 값 / (나) provider만 다름·(다) id만 다름 → 저장값 유지', () => {
  const at = '2026-11-09T14:00:00Z'
  const same = pickProgress(pickAt(2, at, 'same', 'claude'), pickAt(4, at, 'same', 'claude') as StoredProgress, '/papers/a', '/papers/a')
  expect(same.kind).toBe('conversation')
  const diffProvider = pickProgress(pickAt(2, at, 'same', 'codex'), pickAt(4, at, 'same', 'claude') as StoredProgress, '/papers/a', '/papers/a')
  expect(diffProvider.kind).toBe('stored')
  const diffId = pickProgress(pickAt(2, at, 'other', 'claude'), pickAt(4, at, 'cl4', 'claude') as StoredProgress, '/papers/a', '/papers/a')
  expect(diffId.kind).toBe('stored')
})
