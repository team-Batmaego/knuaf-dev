/**
 * 진행 파일(`.knuaf-progress.json`) — Node 단위 시험. IMPL-T1 §4-4 F1~F9 + "파일 없음" 유지.
 *
 * electron을 띄우지 않는다. `main/progress/watch.ts`(읽기·감시)와 `shared/progress-file.ts`
 * (형식·고르기), `main/progress/index.ts`(follow 전환)를 직접 import한다. `index.ts`는
 * electron을 **타입으로만** import하므로 여기서 그대로 불려도 electron이 필요 없다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProgressFile, watchProgressFile } from '../src/main/progress/watch'
import { registerProgressIpc, type ProgressChanged } from '../src/main/progress/index'
import type { BrowserWindow } from 'electron'
import {
  chooseProgress,
  parseProgressFile,
  progressBlockOf,
  PROGRESS_FILE_NAME,
  PROGRESS_SCHEMA,
  UNCERTAIN_NOTE,
  type ProgressFile,
} from '../src/shared/progress-file'
import type { ProgressPick, StoredProgress } from '../src/shared/progress-list'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'knuaf-progress-file-'))

type RawStep = { n: number; state: string; note?: string }

/** ▶ 하나 + 나머지 ✓/○ — 정상 모양의 기본값. F5는 이걸 한 군데만 어긋나게 만든다. */
const stepsOf = (now = 2): RawStep[] =>
  Array.from({ length: 7 }, (_, i) => ({ n: i + 1, state: i + 1 < now ? 'done' : i + 1 === now ? 'now' : 'todo' }))

const fileJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: PROGRESS_SCHEMA,
  written_at: '2026-11-09T06:12:00Z',
  revision: 13,
  skill_version: '0.4.9',
  review_pending: true,
  steps: stepsOf(2),
  flags: [{ text: '온실 시공 견적서', needed_for: 5 }],
  after: { text: '한글 마무리(글꼴·여백·쪽번호)·교수 승인', owner: 'student' },
  next: '작목과 자금 방향을 고르면 면적·시설 질문을 이어가요',
  ask: '작목과 자금 방향 두 가지를 골라 주세요',
  ...over
})

const writeFile = (root: string, value: unknown): void => {
  writeFileSync(join(root, PROGRESS_FILE_NAME), typeof value === 'string' ? value : JSON.stringify(value))
}

/** 임시 파일 → 이름 바꾸기(스킬이 쓰는 방식과 같은 교체). 감시가 끊기지 않는지 본다. */
const replaceFile = (root: string, value: unknown): void => {
  const tmp = join(root, `${PROGRESS_FILE_NAME}.tmp`)
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, join(root, PROGRESS_FILE_NAME))
}

const pickAt = (n: number, at: string, id: string): ProgressPick => ({
  block: {
    steps: Array.from({ length: 7 }, (_, i) => ({
      n: i + 1,
      state: (i + 1 < n ? 'done' : i + 1 === n ? 'now' : 'todo') as 'done' | 'now' | 'todo'
    })),
    flags: [],
    after: null,
    reviewPending: false,
    n
  },
  messageId: id,
  provider: 'claude',
  at
})

/* ------------------------------------------------------------- 읽기 안전 */

test('F1 임시 파일 → 이름 바꾸기 5번 연속 — 마지막 내용이 오고 감시가 안 끊긴다', async () => {
  const root = scratch()
  try {
    const seen: ProgressFile[] = []
    const stop = watchProgressFile({ root, onChange: (p) => { if (p) seen.push(p) } })
    try {
      // `fs.watch` 등록은 커널에서 조금 늦게 산다 — 등록 전에 쓴 한 번은 놓칠 수 있다(실측).
      // 300ms 모음보다 긴 간격(500ms)으로 다시 써서 감시가 살아난 것을 확인한 뒤에 잰다.
      const warmup = Date.now() + 8_000
      while (seen.length === 0 && Date.now() < warmup) {
        replaceFile(root, fileJson({ revision: 0 }))
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(seen.length).toBeGreaterThan(0)
      for (let i = 1; i <= 5; i++) {
        replaceFile(root, fileJson({ revision: i }))
        // 한 번에 몰아 쓰지 않고 이벤트를 받아 가며(실제 스킬 호출 간격과 비슷하게) 쓴다.
        await expect.poll(() => seen.length > 0 && seen[seen.length - 1].revision >= i, { timeout: 5_000 }).toBe(true)
      }
      expect(seen[seen.length - 1].revision).toBe(5)
      // 이름 바꾸기 교체 뒤에도 감시가 살아 있다: 한 번 더 쓰면 또 온다.
      replaceFile(root, fileJson({ revision: 6 }))
      await expect.poll(() => seen[seen.length - 1].revision, { timeout: 5_000 }).toBe(6)
    } finally {
      stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('F2 `.knuaf-progress.json`이 심볼릭 링크 — 거부(null)', () => {
  const root = scratch()
  const outside = scratch()
  try {
    const real = join(outside, 'real.json')
    writeFileSync(real, JSON.stringify(fileJson()))
    symlinkSync(real, join(root, PROGRESS_FILE_NAME))
    expect(readProgressFile(root)).toBeNull()
    // 링크가 아니라 **폴더**여도 거부(fstat 일반 파일 아님).
    const dirRoot = scratch()
    try {
      mkdirSync(join(dirRoot, PROGRESS_FILE_NAME))
      expect(readProgressFile(dirRoot)).toBeNull()
    } finally {
      rmSync(dirRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('F3 파일 크기 100KB — 읽기 전 거부(null)', () => {
  const root = scratch()
  try {
    const big = { ...fileJson(), padding: 'x'.repeat(100 * 1024) }
    writeFile(root, big)
    expect(readProgressFile(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('F4 감시 중 논문 A → B — A 감시 닫힘, 뒤늦은 A 이벤트는 push되지 않는다', async () => {
  const a = scratch()
  const b = scratch()
  try {
    writeFile(a, fileJson({ revision: 1 }))
    writeFile(b, fileJson({ revision: 2 }))
    const sent: ProgressChanged[] = []
    const handlers = new Map<string, () => unknown>()
    // `BrowserWindow` 전체는 필요 없다 — `webContents.send` 하나만 쓰는 시험 대역.
    const fakeWin = { webContents: { send: (_ch: string, payload: ProgressChanged) => { sent.push(payload) } } } as unknown as BrowserWindow
    const ipc = registerProgressIpc(() => b, () => fakeWin, {
      handle: (channel, listener) => handlers.set(channel, listener)
    })
    {
      expect(handlers.has('progress:get')).toBe(true)
      expect(await handlers.get('progress:get')!()).toEqual({ result: expect.objectContaining({ revision: 2 }) })
      ipc.follow(a)
      ipc.follow(b)
      // 전환 직후 A에 써도 A 값은 오지 않는다(감시가 닫혔거나 root 대조에서 버려짐).
      replaceFile(a, fileJson({ revision: 9 }))
      const late = Promise.withResolvers<void>()
      setTimeout(late.resolve, 700)
      await late.promise
      expect(sent.filter((p) => p.root === a)).toEqual([])
      // B에 쓰면 B 값이 온다.
      replaceFile(b, fileJson({ revision: 3 }))
      await expect.poll(() => sent.some((p) => p.root === b && p.progress?.revision === 3), { timeout: 5_000 }).toBe(true)
    }
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('F9 열기 직전 바꿔치기 — 폴더 밖 링크·같은 이름 폴더·큰 파일 셋 다 거부, 내용은 안 읽힌다', () => {
  const root = scratch()
  const outside = scratch()
  try {
    const secret = join(outside, 'secret.json')
    // 밖 파일은 **유효한 진행 파일**이다 — 링크를 따라가면 값이 보이게 된다.
    writeFileSync(secret, JSON.stringify(fileJson({ revision: 77 })))
    symlinkSync(secret, join(root, PROGRESS_FILE_NAME))
    expect(readProgressFile(root)).toBeNull()

    rmSync(join(root, PROGRESS_FILE_NAME))
    mkdirSync(join(root, PROGRESS_FILE_NAME))
    expect(readProgressFile(root)).toBeNull()
    rmSync(join(root, PROGRESS_FILE_NAME), { recursive: true })

    writeFile(root, { ...fileJson(), padding: 'x'.repeat(100 * 1024) })
    expect(readProgressFile(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- 형식 */

test('F5 steps 6개 / n 중복 / now 없음+todo 섞임 / 모르는 state / 상한 초과 — 무효', () => {
  expect(parseProgressFile(fileJson())).not.toBeNull()
  expect(parseProgressFile(fileJson({ steps: stepsOf(2).slice(0, 6) }))).toBeNull()
  const dup: RawStep[] = stepsOf(2)
  dup[6] = { n: 6, state: 'todo' }
  expect(parseProgressFile(fileJson({ steps: dup }))).toBeNull()
  const allTodo: RawStep[] = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, state: 'todo' }))
  expect(parseProgressFile(fileJson({ steps: allTodo }))).toBeNull()
  const unknownState: RawStep[] = stepsOf(2)
  unknownState[2] = { n: 3, state: 'paused' }
  expect(parseProgressFile(fileJson({ steps: unknownState }))).toBeNull()
  expect(parseProgressFile(fileJson({ written_at: 'yesterday' }))).toBeNull()
  expect(parseProgressFile(fileJson({ schema: 'knuaf.progress/2' }))).toBeNull()
  expect(parseProgressFile(fileJson({ flags: [{ text: 'x', needed_for: 'step5' }] }))).toBeNull()
  expect(parseProgressFile(fileJson({ after: { text: 'x' } }))).toBeNull()
  expect(parseProgressFile(fileJson({ next: 'y'.repeat(501) }))).toBeNull()
  expect(parseProgressFile('{broken')).toBeNull()
  expect(parseProgressFile('null')).toBeNull()
  // 모두 done이면 now 없이도 유효.
  const allDone: RawStep[] = allTodo.map((s) => ({ ...s, state: 'done' }))
  expect(parseProgressFile(fileJson({ steps: allDone }))).not.toBeNull()
})

test('F5b ▶ 없이 ✓·unknown 섞임 — 유효, ○가 섞이면 무효(규칙집 요청)', () => {
  // 1~3 ✓, 4~7 unknown — ▶ 없음, ○ 없음 → 유효.
  const settled: RawStep[] = stepsOf(1).map((s, i) => (i < 3 ? { n: s.n, state: 'done' } : { n: s.n, state: 'unknown' }))
  const file = parseProgressFile(fileJson({ steps: settled }))
  expect(file).not.toBeNull()
  // 표시 n = 가장 큰 ✓(▶가 없으므로).
  expect(progressBlockOf(file!).n).toBe(3)
  // 전부 unknown — ✓가 하나도 없으니 1단계.
  const allUnknown: RawStep[] = stepsOf(1).map((s) => ({ n: s.n, state: 'unknown' }))
  const unknownFile = parseProgressFile(fileJson({ steps: allUnknown }))
  expect(unknownFile).not.toBeNull()
  expect(progressBlockOf(unknownFile!).n).toBe(1)
  // ○(todo)가 있는데 ▶가 하나도 없으면 여전히 무효.
  const withTodo: RawStep[] = stepsOf(1).map((s, i) =>
    i < 2 ? { n: s.n, state: 'done' } : i === 2 ? { n: s.n, state: 'unknown' } : { n: s.n, state: 'todo' },
  )
  expect(parseProgressFile(fileJson({ steps: withTodo }))).toBeNull()
  // 전부 ✓는 지금처럼 7단계.
  const doneFile = parseProgressFile(fileJson({ steps: stepsOf(1).map((s) => ({ n: s.n, state: 'done' })) }))
  expect(progressBlockOf(doneFile!).n).toBe(7)
})

test('F6 `unknown` 단계 하나 + now 하나 — 유효, 그 단계만 "확인 필요"', () => {
  const steps: RawStep[] = stepsOf(4)
  steps[1] = { n: 2, state: 'unknown' }
  const file = parseProgressFile(fileJson({ steps }))
  expect(file).not.toBeNull()
  const block = progressBlockOf(file!)
  expect(block.n).toBe(4)
  expect(block.steps[1]).toEqual({ n: 2, state: 'unknown', note: UNCERTAIN_NOTE })
  // 메모가 있으면 메모만 그린다 — `uncertain`을 세우면 StageMenu가 " · 확인 필요"를 덧붙인다.
  steps[1] = { n: 2, state: 'unknown', note: '자료 확인 중' }
  const withNote = parseProgressFile(fileJson({ steps }))
  expect(progressBlockOf(withNote!).steps[1]).toEqual({ n: 2, state: 'unknown', note: '자료 확인 중' })
})

/* ------------------------------------------------------------- 고르기 */

test('F7 파일 유효 + 대화 덩어리 다른 단계 — 파일 값이 이긴다(시각 비교 없음)', () => {
  const file = parseProgressFile(fileJson({ steps: stepsOf(6) }))
  const conv = pickAt(2, '2026-11-09T23:59:00Z', 'newest')
  const r = chooseProgress(file, 'codex', conv, null, '/papers/a', '/papers/a')
  expect(r.kind).toBe('file')
  expect(r.pick?.block.n).toBe(6)
  expect(r.pick?.messageId).toBe('file:2026-11-09T06:12:00Z')
})

test('F8 파일 무효 + 대화 덩어리 유효 — 파서 값', () => {
  const conv = pickAt(2, '2026-11-09T14:00:00Z', 'c2')
  const r = chooseProgress(null, 'claude', conv, null, '/papers/a', '/papers/a')
  expect(r.kind).toBe('conversation')
  expect(r.pick?.block.n).toBe(2)
})

test('파일 없음 — 1단계 그대로: 대화 없으면 저장값, 저장값도 없으면 "시작 전"', () => {
  const stored: StoredProgress = pickAt(4, '2026-11-09T11:00:00Z', 'cl4')
  const withStored = chooseProgress(null, 'claude', null, stored, '/papers/a', '/papers/a')
  expect(withStored.kind).toBe('stored')
  expect(withStored.pick?.block.n).toBe(4)
  const none = chooseProgress(null, 'claude', null, null, '/papers/a', '/papers/a')
  expect(none.kind).toBe('none')
  expect(none.pick).toBeNull()
  // 논문이 없으면 파일이 있어도 그리지 않는다.
  expect(chooseProgress(parseProgressFile(fileJson()), 'claude', null, null, null, null).kind).toBe('none')
  // 무효 파일을 읽으면 `null`이 온다 — 그대로 F8 경로로 떨어진다.
  const root = scratch()
  try {
    writeFile(root, fileJson({ steps: stepsOf(2).slice(0, 3) }))
    expect(readProgressFile(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
