/**
 * 발주 QA2-B 순수 함수 — 고친 부분 비교(`shared/diff`)와 보낼 인용 메시지(`store/review`).
 *
 * 화면 없이 판정할 수 있어야 한다: 문장 자르기·문단 짝짓기·인용 형식은 틀리기 쉬운 자리라
 * Node 단위로 먼저 잠근다(Playwright 가 Electron 없이 도는 시험이다 — layout.spec.ts 와 같다).
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffSentences, hasChange, sectionDiff, splitSentences } from '../src/shared/diff'
import { baselineKey, buildQuotedMessage, quoteOf, useReview } from '../src/renderer/src/store/review'
import { CHAT_EVENT } from '../src/renderer/src/copy'
import { ensureSectionBaseline } from '../src/main/review-baseline'

// ---------------------------------------------------------------- 문장 자르기

test('문장 자르기 — 종결부호 뒤에서만 자르고 소수는 자르지 않는다', () => {
  expect(splitSentences('가. 나! 다?')).toEqual(['가.', '나!', '다?'])
  // 소수점·줄임표 뒤에는 공백이 없으므로 문장이 갈라지지 않는다.
  expect(splitSentences('면적은 2.4톤이다')).toEqual(['면적은 2.4톤이다'])
  // 종결부호가 없으면 꼬리 전체가 한 문장이다.
  expect(splitSentences('아직 안 끝난 문장')).toEqual(['아직 안 끝난 문장'])
})

// ---------------------------------------------------------------- 문장 비교

test('문장 비교 — 600평→800평은 지움 1·새것 1, 나머지 문장은 그대로', () => {
  const before = '농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const after = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const segs = diffSentences(before, after)
  expect(segs.filter((s) => s.kind === 'del')).toEqual([{ kind: 'del', text: '농장A의 재배 면적은 600평이다.' }])
  expect(segs.filter((s) => s.kind === 'ins')).toEqual([{ kind: 'ins', text: '농장A의 재배 면적은 800평이다.' }])
  expect(segs.some((s) => s.kind === 'same' && s.text.includes('정읍'))).toBe(true)
})

test('문장 비교 — 같은 글은 전부 same 하나로 합쳐진다', () => {
  const same = '가. 나.'
  expect(diffSentences(same, same)).toEqual([{ kind: 'same', text: '가. 나.' }])
})

// ---------------------------------------------------------------- 문단 비교

test('문단이 하나 바뀌면 문장 단위로 갈라진다', () => {
  const before = '농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const after = '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.'
  const blocks = sectionDiff(before, after)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].kind).toBe('segs')
})

test('문단이 통째로 늘거나 줄면 문단 단위 ins·del 로 낸다', () => {
  const added = sectionDiff('가', '가\n\n나')
  expect(added.map((b) => b.kind)).toEqual(['same', 'ins'])
  const removed = sectionDiff('가\n\n나', '가')
  expect(removed.map((b) => b.kind)).toEqual(['same', 'del'])
})

test('같은 글은 표시할 것이 없다 — hasChange 가 거짓', () => {
  expect(hasChange('가\n\n나', '가\n\n나')).toBe(false)
  expect(hasChange('가\n\n나', '가\n\n다')).toBe(true)
  expect(sectionDiff('가\n\n나', '가\n\n나').every((b) => b.kind === 'same')).toBe(true)
})

// ---------------------------------------------------------------- 보낼 메시지

const quote = quoteOf('/tmp/논문A', '농장A의 재배 면적은 600평이다.', 'sec-01', 'Ⅰ. 머리말')

test('인용 메시지 형식 — `> 문장` · `(장에서)` · 빈 줄 · 학생 글', () => {
  expect(buildQuotedMessage(quote, '단위를 kg으로 바꿔 줘'))
    .toBe('> 농장A의 재배 면적은 600평이다.\n(Ⅰ. 머리말에서)\n\n단위를 kg으로 바꿔 줘')
})

test('학생 글이 비면 "이 부분을 고쳐 줘"가 대신 들어간다', () => {
  expect(buildQuotedMessage(quote, '   ')).toBe('> 농장A의 재배 면적은 600평이다.\n(Ⅰ. 머리말에서)\n\n이 부분을 고쳐 줘')
})

test('여러 줄을 골라도 인용은 한 줄로 눌린다', () => {
  const multi = quoteOf('/tmp/논문A', '첫 줄\n둘째   줄', 'sec-01', 'Ⅰ. 머리말')
  expect(multi.text).toBe('첫 줄 둘째 줄')
})

test('비교 기준은 .knuaf-gui/section-before에 한 번만 저장한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-review-baseline-'))
  try {
    const file = join(root, '.knuaf-gui', 'section-before', 'sec-01.txt')
    expect(ensureSectionBaseline(root, 'sec-01', '처음 본 본문')).toEqual({ draft: '처음 본 본문' })
    expect(readFileSync(file, 'utf8')).toBe('처음 본 본문')
    expect(ensureSectionBaseline(root, 'sec-01', '다음 저장 본문')).toEqual({ draft: '처음 본 본문' })
    expect(readFileSync(file, 'utf8')).toBe('처음 본 본문')
    expect(existsSync(join(root, 'sec-01.txt'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('비교 기준 저장은 경로 탈출과 앱 폴더 심링크를 거부한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-review-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'knuaf-review-outside-'))
  const fileRoot = mkdtempSync(join(tmpdir(), 'knuaf-review-file-root-'))
  const outsideFile = join(outside, 'keep.txt')
  try {
    expect(() => ensureSectionBaseline(root, '../escape', '본문')).toThrow()
    symlinkSync(outside, join(root, '.knuaf-gui'), 'dir')
    expect(() => ensureSectionBaseline(root, 'sec-01', '본문')).toThrow()
    expect(existsSync(join(outside, 'section-before'))).toBe(false)
    mkdirSync(join(fileRoot, '.knuaf-gui', 'section-before'), { recursive: true })
    writeFileSync(outsideFile, 'unchanged')
    symlinkSync(outsideFile, join(fileRoot, '.knuaf-gui', 'section-before', 'sec-01.txt'), 'file')
    expect(() => ensureSectionBaseline(fileRoot, 'sec-01', '본문')).toThrow()
    expect(readFileSync(outsideFile, 'utf8')).toBe('unchanged')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(fileRoot, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('noteSeen counts against the comparison baseline and editOf is scoped by root, section, and hash', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const saved = new Map<string, string>()
  useReview.setState({ baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      knuaf: {
        review: {
          ensureBaseline: async (root: string, sectionId: string, draft: string) => {
            const key = JSON.stringify([root, sectionId])
            if (!saved.has(key)) saved.set(key, draft)
            return { result: { draft: saved.get(key) ?? '' } }
          }
        }
      }
    }
  })
  try {
    const root = '/tmp/review-project'
    const sectionId = 'sec-01'
    const noteSeen = useReview.getState().noteSeen
    // 빈 절을 먼저 본 뒤 첫 본문을 받으면 `wrote` — 이 절의 기준본은 계속 빈 문자열이다.
    await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft: '', hash: 'h0' })
    await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft: '가. 나. 다.', hash: 'h1' })
    expect(useReview.getState().editOf(root, sectionId, 'h1')).toEqual({ kind: 'wrote' })
    // 기준본이 빈 절의 다음 저장도 `wrote`로 되돌아가지 않고, 화면 diff와 같은 기준으로 센다.
    await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft: '가. 바. 다. 라.', hash: 'h2' })
    expect(useReview.getState().editOf(root, sectionId, 'h2')).toEqual({ kind: 'edited', count: 1 })
    expect(useReview.getState().editOf('/tmp/other-project', sectionId, 'h2')).toBeNull()
    expect(useReview.getState().baseline[baselineKey(root, sectionId)].draft).toBe('')
  } finally {
    useReview.setState({ quote: null, showDiff: false, baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('noteSeen counts against the visible diff baseline when the pane already saw the saved body', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const root = '/tmp/review-race'
  const sectionId = 'sec-01'
  const key = baselineKey(root, sectionId)
  const saved = new Map([[JSON.stringify([root, sectionId]), '가. 나. 다.']])
  useReview.setState({ baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      knuaf: {
        review: {
          ensureBaseline: async (root: string, sectionId: string) => ({
            result: { draft: saved.get(JSON.stringify([root, sectionId])) ?? '' }
          })
        }
      }
    }
  })
  try {
    const noteSeen = useReview.getState().noteSeen
    // PaperPane's fire-and-forget read raced ahead: new body under the section list's old hash.
    useReview.setState({
      baseline: { [key]: { title: 'Ⅰ. 장', draft: '가. 나. 다.', hash: '' } },
      lastSeen: { [key]: { title: 'Ⅰ. 장', draft: '가. 바. 다. 라.', hash: 'h1' } }
    })
    await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft: '가. 바. 다. 라.', hash: 'h2' })
    expect(useReview.getState().editOf(root, sectionId, 'h2')).toEqual({ kind: 'edited', count: 2 })
    // A later no-op read must not replace the fixed event count with 0.
    await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft: '가. 바. 다. 라.', hash: 'h2' })
    expect(useReview.getState().editOf(root, sectionId, 'h2')).toEqual({ kind: 'edited', count: 2 })
  } finally {
    useReview.setState({ quote: null, showDiff: false, baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('event line wording: N places, a replacement counts once, and zero has its own sentence', () => {
  expect(CHAT_EVENT.edited('Ⅰ. 장', 2)).toBe('Ⅰ. 장에서 2곳을 고쳤어요')
  expect(CHAT_EVENT.edited('Ⅰ. 장', 1)).toBe('Ⅰ. 장에서 1곳을 고쳤어요')
  expect(CHAT_EVENT.edited('Ⅰ. 장', 0)).toBe('Ⅰ. 장에서 고친 곳을 찾지 못했어요')
  expect(CHAT_EVENT.edited('Ⅰ. 서론', null)).toBe('Ⅰ. 서론을 고쳤어요')
})

test('each separated changed place counts once, and a replacement is one place', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const root = '/tmp/review-places'
  const sectionId = 'sec-02'
  const saved = new Map([[JSON.stringify([root, sectionId]), '하나. 둘. 셋. 넷. 다섯. 여섯.']])
  useReview.setState({ baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      knuaf: {
        review: {
          ensureBaseline: async (root: string, sectionId: string) => ({
            result: { draft: saved.get(JSON.stringify([root, sectionId])) ?? '' }
          })
        }
      }
    }
  })
  try {
    await useReview.getState().noteSeen(root, sectionId, {
      title: 'Ⅱ. 장', draft: '하나. 둘. 셋. 넷. 다섯. 여섯.', hash: 'p0'
    })
    await useReview.getState().noteSeen(root, sectionId, {
      title: 'Ⅱ. 장', draft: '하나. 둘X. 셋. 넷Y. 다섯. 여섯Z.', hash: 'p1'
    })
    expect(useReview.getState().editOf(root, sectionId, 'p1')).toEqual({ kind: 'edited', count: 3 })
  } finally {
    useReview.setState({ quote: null, showDiff: false, baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

/**
 * 검토(REVIEW-W10-W12) 중요 1·2 — 두 번째 저장의 카운트가 읽기 순서에 따라 1↔2로 달라지고,
 * 같은 해시에 다른 본문이 들어오면 캐시 값이 2→1로 덮였다. 숫자의 의미를 하나로 못박는다:
 * **persisted baseline(화면 "고친 부분 보기"의 before) 대비 변경 run 수**를, 해시마다 **한 번만**
 * 확정한다. 그래서 같은 저장을 어느 읽기 순서로 관측해도 같은 해시는 같은 값을 낸다.
 */
test('second save counts the same however the two readers interleave', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const A = '하나. 둘. 셋. 넷. 다섯.'
  const B = '하나. 둘X. 셋. 넷. 다섯.'
  const C = '하나. 둘X. 셋. 넷Y. 다섯.'
  const install = (draft: string) => {
    useReview.setState({ baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        knuaf: {
          review: { ensureBaseline: async () => ({ result: { draft } }) }
        }
      }
    })
  }
  try {
    // 판정 파일 순서 ①: noteSeen(A,a) → (B,b) → (C,b) → (C,c). 기준본은 A.
    install(A)
    const noteSeen = useReview.getState().noteSeen
    const root = '/tmp/review-order-1'
    const sectionId = 'sec-01'
    for (const [draft, hash] of [[A, 'a'], [B, 'b'], [C, 'b'], [C, 'c']] as const) {
      await noteSeen(root, sectionId, { title: 'Ⅰ. 장', draft, hash })
    }
    expect(useReview.getState().editOf(root, sectionId, 'b')).toEqual({ kind: 'edited', count: 1 })
    expect(useReview.getState().editOf(root, sectionId, 'c')).toEqual({ kind: 'edited', count: 2 })

    // 판정 파일 순서 ②: noteSeen(A,a) → (C,c) → (B,c). 같은 해시 c는 같은 값이어야 한다.
    install(A)
    const second = '/tmp/review-order-2'
    for (const [draft, hash] of [[A, 'a'], [C, 'c'], [B, 'c']] as const) {
      await noteSeen(second, sectionId, { title: 'Ⅰ. 장', draft, hash })
    }
    expect(useReview.getState().editOf(second, sectionId, 'c')).toEqual({ kind: 'edited', count: 2 })

    // 빈 기준본에서 두 번째 저장이 wrote로 되돌아가지 않는다.
    install('')
    const third = '/tmp/review-order-3'
    for (const [draft, hash] of [['', 'e0'], [B, 'e1'], [C, 'e1'], [C, 'e2']] as const) {
      await noteSeen(third, sectionId, { title: 'Ⅰ. 장', draft, hash })
    }
    expect(useReview.getState().editOf(third, sectionId, 'e1')).toEqual({ kind: 'wrote' })
    expect(useReview.getState().editOf(third, sectionId, 'e2')).toEqual({ kind: 'edited', count: 1 })

    // 되돌린 저장 — diff가 비므로 `wrote`가 아니라 0곳이다(문구와 화면이 일치).
    await noteSeen(third, sectionId, { title: 'Ⅰ. 장', draft: '', hash: 'e3' })
    expect(useReview.getState().editOf(third, sectionId, 'e3')).toEqual({ kind: 'edited', count: 0 })

    // 첫 쓰기 분류도 읽기 순서에 기대지 않는다(검토 확인 절). 같은 첫 본문 B를 팬이 옛 해시 e0로
    // 먼저 읽어도, 실제 새 해시 e1은 `wrote`다 — ('',e0)→(B,e0)→(B,e1) vs ('',e0)→(B,e1).
    install('')
    const fourth = '/tmp/review-order-4'
    const fifth = '/tmp/review-order-5'
    for (const [rootKey, seq] of [
      [fourth, [['', 'e0'], [B, 'e0'], [B, 'e1']]],
      [fifth, [['', 'e0'], [B, 'e1']]]
    ] as const) {
      for (const [draft, hash] of seq) await noteSeen(rootKey, sectionId, { title: 'Ⅰ. 장', draft, hash })
      expect(useReview.getState().editOf(rootKey, sectionId, 'e1'), rootKey).toEqual({ kind: 'wrote' })
    }

    // 불변식: 숫자가 0곳이면 화면 diff도 비어 있어야 한다(문구가 어긋나지 않는다).
    const runs = (before: string, after: string): number => sectionDiff(before, after)
      .reduce((n, block) => n + (block.kind === 'same' ? 0
        : block.kind === 'segs' ? block.segs.filter((seg) => seg.kind !== 'same').length : 1), 0)
    for (const draft of [A, B, C]) {
      expect(runs(A, draft) > 0).toBe(hasChange(A, draft))
    }
  } finally {
    useReview.setState({ quote: null, showDiff: false, baseline: {}, lastSeen: {}, firstBodies: {}, editCounts: {} })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
