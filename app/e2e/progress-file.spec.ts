/**
 * 진행 파일(`.knuaf-progress.json`) — Node 단위 시험. IMPL-T1 §4-4 F1~F9 + "파일 없음" 유지.
 *
 * electron을 띄우지 않는다. `main/progress/watch.ts`(읽기·감시)와 `shared/progress-file.ts`
 * (형식·고르기), `main/progress/index.ts`(follow 전환)를 직접 import한다. `index.ts`는
 * electron을 **타입으로만** import하므로 여기서 그대로 불려도 electron이 필요 없다.
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProgressFile, watchProgressFile } from '../src/main/progress/watch'
import { registerProgressIpc, type ProgressChanged } from '../src/main/progress/index'
import { createProgressFeed, type ProgressIo } from '../src/renderer/src/components/useProgress'
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

/* ------------------------------------------- Roh 1회째 [차단] 확인↔열기 교체 */

/**
 * 시험이 `read` 훅으로 감싸 쓸 실제 읽기. 제품 경로의 `readBounded`와 같은 일을 하지만
 * main 모듈이 그 함수를 내보내지 않으므로 시험 쪽에 최소판을 둔다(검증 통과 뒤에만 불린다).
 */
function readBoundedForTest(fd: number): string | null {
  const buffer = Buffer.alloc(4096)
  const chunks: Buffer[] = []
  let total = 0
  while (total <= 64 * 1024) {
    const read = readSync(fd, buffer, 0, buffer.length, null)
    if (read === 0) break
    total += read
    if (total > 64 * 1024) return null
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * 책임자 지적의 ABA 순서를 그대로 재현한다. 옛 구조는 이 순서에 뚫렸다:
 *   ⓪ 조상 폴더를 바깥으로 바꿔치기 ① open(fd = 바깥 파일) ② `lstat(경로)`도 바뀐 상태라
 *   fd와 일치 ③ 원복 ④ `realpath`·root 신원 재확인도 원래대로라 통과 ⑤ 바깥 바이트 read.
 * 지금은 **폴더 객체를 붙잡아**(chdir) 열기·검사·읽기가 모두 그 안에서만 일어나므로, 조상이
 * 무엇으로 바뀌든 ①의 open이 바깥을 가리킬 수 없다. 기준은 `reads === 0`이 아니라
 * **`reads === 0`이고 값이 바깥 것이 아님**이다 — 붙잡은 폴더가 정상이면 읽어도 안전하다.
 * 폴더 이름 바꾸기는 POSIX에서만 안전하다(윈도우는 열린 파일이 든 폴더 이름을 못 바꾼다).
 */
test('F10 확인↔열기 사이 폴더 교체 — 폴더 밖 값을 읽지도 않는다(읽기 0회)', () => {
  test.skip(process.platform === 'win32', '폴더 이름 바꾸기 반례는 POSIX 시험')
  const root = scratch()
  const outside = scratch()
  /** 읽기 전 옮긴 cwd가 끝나고 원래대로 돌아오는지 단언할 기준값. */
  const originalCwd = process.cwd()
  try {
    const secret = join(outside, 'secret.json')
    const outsidePayload = fileJson({ revision: 77, next: 'OUTSIDE_SECRET_20261111'.repeat(12) })
    writeFileSync(secret, JSON.stringify(outsidePayload))

    /** 조상을 바꿔치기하고(되돌리지 않은 채) 바깥 값을 심는다 — 반례를 만드는 기본 동작. */
    const swapAncestor = (): string => {
      const moved = `${root}.real`
      renameSync(root, moved)
      mkdirSync(root)
      // 링크가 아니라 **복사본**을 둔다 — O_NOFOLLOW로 걸리지 않는 가장 센 반례.
      writeFileSync(join(root, PROGRESS_FILE_NAME), JSON.stringify(outsidePayload))
      return moved
    }

    /**
     * 바꿔치기했다가 **곧바로 원복**하는 변형(ABA — 경로 문자열이 같아진다).
     * 읽기 호출 횟수를 세고, 읽는 동안의 cwd도 남긴다(cwd 고정 단언용).
     */
    const attempt = (
      when: 'beforeChdir' | 'beforeOpen' | 'afterOpen'
    ): { result: ProgressFile | null; reads: number; cwdDuringRead: string | null } => {
      writeFile(root, fileJson({ revision: 1 }))
      let reads = 0
      let cwdDuringRead: string | null = null
      const swapAndUndo = (): void => {
        const moved = swapAncestor()
        rmSync(root, { recursive: true, force: true })
        renameSync(moved, root)
      }

      const result = readProgressFile(root, {
        beforeChdir: when === 'beforeChdir' ? swapAndUndo : undefined,
        beforeOpen: when === 'beforeOpen' ? swapAndUndo : undefined,
        afterOpen: when === 'afterOpen' ? swapAndUndo : undefined,
        read: (fd) => {
          reads += 1
          cwdDuringRead = process.cwd()
          return readBoundedForTest(fd)
        }
      })
      return { result, reads, cwdDuringRead }
    }

    /** 원복하지 않은 변형 — swap 결과를 정리해야 한다. */
    const attemptKeptSwap = (
      when: 'beforeChdir' | 'beforeOpen' | 'afterOpen'
    ): { result: ProgressFile | null; reads: number; cwdAfter: string } => {
      writeFile(root, fileJson({ revision: 1 }))
      let reads = 0
      let moved: string | null = null
      const swap = (): void => {
        moved = swapAncestor()
      }
      const result = readProgressFile(root, {
        beforeChdir: when === 'beforeChdir' ? swap : undefined,
        beforeOpen: when === 'beforeOpen' ? swap : undefined,
        afterOpen: when === 'afterOpen' ? swap : undefined,
        read: (fd) => { reads += 1; return readBoundedForTest(fd) }
      })
      if (moved !== null) {
        rmSync(root, { recursive: true, force: true })
        renameSync(moved, root)
      }
      return { result, reads, cwdAfter: process.cwd() }
    }

    // ① chdir **전** 조상 교체(그대로 둠) — chdir이 바뀐 곳으로 들어가므로 `lstat('.')` 대조에서 걸린다.
    const chdirKept = attemptKeptSwap('beforeChdir')
    expect(chdirKept.result, 'chdir 전 교체(유지): 값이 없다').toBeNull()
    expect(chdirKept.reads, 'chdir 전 교체(유지): 읽기 0회').toBe(0)
    expect(chdirKept.cwdAfter, 'cwd는 원래대로 돌아온다').toBe(originalCwd)

    // ② chdir **전** 교체 후 곧바로 원복 — 들어간 폴더는 원래 그 폴더다. 정상 값을 읽는다.
    const chdirRestored = attempt('beforeChdir')
    expect(chdirRestored.result?.revision, 'chdir 전 교체 후 원복: 붙잡은 폴더 값').toBe(1)
    expect(chdirRestored.reads, '원복 뒤에는 정상 폴더를 읽는다').toBe(1)
    expect(process.cwd(), 'cwd 원복').toBe(originalCwd)

    // ③ chdir 뒤·열기 전 교체(그대로 둠) — 고정된 cwd 안에서 열리므로 값은 원래 폴더 것이고,
    //    읽기 직전 경로 재확인이 조상 불일치를 잡아 읽지도 않는다.
    const beforeOpenKept = attemptKeptSwap('beforeOpen')
    expect(beforeOpenKept.result, '열기 전 교체(유지): 값이 없다').toBeNull()
    expect(beforeOpenKept.reads, '열기 전 교체(유지): 읽기 0회').toBe(0)
    expect(beforeOpenKept.cwdAfter, 'cwd 원복').toBe(originalCwd)

    // ④ **책임자의 ABA 순서**: 열기 전 교체 → 열기 → 검사도 바뀐 상태라 일치 → 원복 → 재확인 통과.
    //    붙잡은 폴더가 정상이므로 읽는 값은 정상 값이어야 한다(바깥 payload가 절대 아니다).
    const aba = attempt('beforeOpen')
    expect(aba.result?.revision, 'ABA: 바깥 값이 아니라 붙잡은 폴더 값').not.toBe(77)
    expect(aba.cwdDuringRead, '읽는 동안 cwd는 논문 폴더').toBe(realpathSync(root))
    expect(process.cwd(), 'cwd 원복').toBe(originalCwd)

    // ⑤ 열린 직후 교체(그대로 둠) — 열기·검사·읽기 모두 붙잡은 폴더 안. 바깥 값은 안 나온다.
    const afterOpenKept = attemptKeptSwap('afterOpen')
    if (afterOpenKept.result !== null) {
      expect(afterOpenKept.result.revision, '열린 뒤 교체: 바깥 값이 아니다').not.toBe(77)
    }
    expect(afterOpenKept.cwdAfter, 'cwd 원복').toBe(originalCwd)

    // 원래 파일은 멀쩡하다 — 거절·교체가 원본을 망가뜨리지 않는다.
    expect(readProgressFile(root)?.revision).toBe(1)

    // ⑥ 조상이 감시 시작 뒤 바뀐 경우 — 감시가 기억한 신원과 달라 걸린다(감시 경로).
    const anchorStat = lstatSync(root)
    const movedAgain = `${root}.real2`
    renameSync(root, movedAgain)
    mkdirSync(root)
    writeFileSync(join(root, PROGRESS_FILE_NAME), JSON.stringify(outsidePayload))
    let watchedReads = 0
    expect(readProgressFile(root, {
      rootIdentity: { dev: anchorStat.dev, ino: anchorStat.ino },
      read: (fd) => { watchedReads += 1; return readBoundedForTest(fd) }
    }), '조상이 바뀌면 감시 쪽 읽기도 거절').toBeNull()
    expect(watchedReads, '감시 쪽도 읽기 0회').toBe(0)
    rmSync(root, { recursive: true, force: true })
    renameSync(movedAgain, root)

    // ⑦ 폴더 대신 파일 자리에 심볼릭 링크 — O_NOFOLLOW가 열기 자체를 막는다.
    rmSync(join(root, PROGRESS_FILE_NAME))
    symlinkSync(secret, join(root, PROGRESS_FILE_NAME))
    let linkReads = 0
    const linked = readProgressFile(root, {
      read: (fd) => { linkReads += 1; return readBoundedForTest(fd) }
    })
    expect(linked).toBeNull()
    expect(linkReads, '심볼릭 링크도 읽지 않는다').toBe(0)

    // ⑧ 폴더 밖 파일로의 **하드 링크** — 이름이 둘이므로(nlink > 1) 읽지 않고 거절.
    rmSync(join(root, PROGRESS_FILE_NAME))
    const hard = join(outside, 'hard.json')
    writeFileSync(hard, JSON.stringify(fileJson({ revision: 78 })))
    try {
      linkSync(hard, join(root, PROGRESS_FILE_NAME))
      let hardReads = 0
      expect(readProgressFile(root, {
        read: (fd) => { hardReads += 1; return readBoundedForTest(fd) }
      })).toBeNull()
      expect(hardReads, '하드 링크도 읽지 않는다').toBe(0)
    } catch {
      // 파일시스템이 하드 링크를 막으면(권한·네트워크) 이 갈래는 건너뛴다.
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    for (const suffix of ['.real', '.real2', '.moved']) {
      rmSync(`${root}${suffix}`, { recursive: true, force: true })
    }
    rmSync(outside, { recursive: true, force: true })
  }
})

/* --------------------------------------- Roh 1회째 [중요] FIFO·소켓에서 멈추지 않는다 */

function fifoAt(path: string): boolean {
  // FIFO는 POSIX에만 있다(윈도우 없음). 맥·리눅스의 `mkfifo`를 쓴다.
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8' })
  return made.status === 0
}

test('F11 진행 파일 자리에 FIFO — 읽기가 멈추지 않고 즉시 null(2.5초 제한)', () => {
  test.skip(process.platform === 'win32', 'POSIX FIFO')
  const root = scratch()
  try {
    expect(fifoAt(join(root, PROGRESS_FILE_NAME))).toBe(true)
    const started = Date.now()
    expect(readProgressFile(root)).toBeNull()
    // Roh 반례는 2.5초 안에 안 돌아왔다. 지금은 O_NONBLOCK이라 fstat에서 바로 걸린다.
    expect(Date.now() - started).toBeLessThan(1_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('F11b 진행 파일 자리에 유닉스 소켓 — 즉시 null(감시·읽기 모두 안 멈춘다)', async () => {
  test.skip(process.platform === 'win32', '유닉스 도메인 소켓 경로')
  // 맥 유닉스 소켓 경로 상한(104바이트) — 기본 임시 폴더(`/var/folders/…`) 아래는 넘는다. 짧은 뿌리를 쓴다.
  let root: string
  try {
    root = mkdtempSync(join('/tmp', 'kp-'))
  } catch {
    root = mkdtempSync(join(tmpdir(), 'kp-'))
  }
  const path = join(root, PROGRESS_FILE_NAME)
  test.skip(Buffer.byteLength(path) > 100, `소켓 경로 상한 초과(${Buffer.byteLength(path)}바이트)`)
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    const started = Date.now()
    expect(readProgressFile(root)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('F11c 폴더·링크·없는 파일 — 여전히 null(회귀)', () => {
  const root = scratch()
  try {
    expect(readProgressFile(root)).toBeNull()
    mkdirSync(join(root, PROGRESS_FILE_NAME))
    expect(readProgressFile(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------- Roh 1회째 [중요] 늦은 재조회·늦은 push (세대 규칙) */

/** 가짜 `progress:get`/`onChanged` — 어느 요청의 응답이 먼저 도착할지 시험이 정한다. */
function fakeIo(): {
  io: ProgressIo
  reply: (index: number, file: ProgressFile | null) => void
  push: (root: string, file: ProgressFile | null) => void
  gets: number
} {
  const pending = new Map<number, (f: ProgressFile | null) => void>()
  let listening: ((p: { root: string; progress: ProgressFile | null }) => void) | null = null
  let gets = 0
  return {
    get gets() { return gets },
    io: {
      get: () => {
        const index = gets++
        return new Promise<{ result: ProgressFile | null }>((resolve) => {
          pending.set(index, (f) => resolve({ result: f }))
        })
      },
      onChanged: (fn) => {
        listening = fn
        return () => { listening = null }
      }
    },
    reply: (index, file) => {
      const settle = pending.get(index)
      if (!settle) throw new Error(`요청 #${index}이 없다`)
      pending.delete(index)
      settle(file)
    },
    push: (root, file) => {
      if (!listening) throw new Error('구독이 없다')
      listening({ root, progress: file })
    }
  }
}

const rev = (n: number): ProgressFile => parseProgressFile(fileJson({ revision: n }))!

test('F12 논문 A → B 전환 — 늦은 A 응답(6/7)이 B(2/7)를 덮지 않는다', async () => {
  const t = fakeIo()
  const seen: (number | null)[] = []
  const feed = createProgressFeed(t.io, (f) => seen.push(f ? f.revision : null))

  feed.setRoot('/papers/a')
  const aReq = t.gets
  feed.setRoot('/papers/b')           // A 응답 전에 B로 전환(사용자가 폴더를 바꿈)
  expect(t.gets).toBe(aReq + 1)

  t.reply(1, rev(2))                  // B 2/7 도착
  await new Promise((r) => setTimeout(r, 0))
  t.reply(0, rev(6))                  // 그 뒤 A 6/7 도착 — 버려져야 한다
  await new Promise((r) => setTimeout(r, 0))

  expect(seen.filter((x) => x !== null)).toEqual([2])

  // push도 같은 규칙: 옛 A push는 지금 B 화면에 못 들어간다.
  t.push('/papers/a', rev(6))
  expect(seen.filter((x) => x !== null)).toEqual([2])
  t.push('/papers/b', rev(3))
  expect(seen.filter((x) => x !== null)).toEqual([2, 3])
  feed.dispose()
})

test('F12b A → B → A로 되돌아와도 첫 A의 늦은 응답은 버린다(지금 A 응답은 받는다)', async () => {
  const t = fakeIo()
  const seen: (number | null)[] = []
  const feed = createProgressFeed(t.io, (f) => seen.push(f ? f.revision : null))

  feed.setRoot('/papers/a')   // 요청 0
  feed.setRoot('/papers/b')   // 요청 1
  feed.setRoot('/papers/a')   // 요청 2 — root 문자열은 0번과 같다(문자열 비교로는 못 가른다)

  t.reply(2, rev(1))          // 지금 A의 새 응답 — 받는다
  await new Promise((r) => setTimeout(r, 0))
  t.reply(0, rev(9))          // 첫 A의 늦은 응답 — 버린다
  await new Promise((r) => setTimeout(r, 0))

  expect(seen.filter((x) => x !== null)).toEqual([1])

  // push 쪽 세대 판정은 main 몫이다(F13) — main이 이미 보내지 않았으므로 렌더러는 root만 본다.
  // 지금 구독에 온 정상 A push는 받는다.
  t.push('/papers/a', rev(3))
  expect(seen.filter((x) => x !== null)).toEqual([1, 3])
  feed.dispose()
})

test('F12c running → idle 재조회도 늦으면 버린다(같은 root, 다른 세대)', async () => {
  const t = fakeIo()
  const seen: (number | null)[] = []
  const feed = createProgressFeed(t.io, (f) => seen.push(f ? f.revision : null))
  feed.setRoot('/papers/a')
  feed.reread()                    // 재조회 1
  feed.setRoot('/papers/b')        // 그사이 전환
  feed.setRoot('/papers/a')        // 되돌아옴
  t.reply(3, rev(4))               // 지금 세대 응답
  await new Promise((r) => setTimeout(r, 0))
  t.reply(1, rev(5))               // 늦은 재조회 응답 — 버린다
  await new Promise((r) => setTimeout(r, 0))
  expect(seen.filter((x) => x !== null)).toEqual([4])
  feed.dispose()
})

test('F13 main push도 A → B → A 뒤 옛 A 감시 이벤트를 버린다', () => {
  const sent: ProgressChanged[] = []
  const handlers = new Map<string, () => unknown>()
  const fakeWin = { webContents: { send: (_c: string, p: ProgressChanged) => sent.push(p) } } as unknown as BrowserWindow
  // follow마다 감시 하나씩 — onChange를 잡아 두고 시험이 늦은 이벤트를 직접 민다.
  const watches: { root: string; onChange: (p: ProgressFile | null) => void; stopped: boolean }[] = []
  const ipc = registerProgressIpc(
    () => null,
    () => fakeWin,
    { handle: (ch, fn) => handlers.set(ch, fn) },
    ({ root, onChange }) => {
      const entry = { root, onChange, stopped: false }
      watches.push(entry)
      return () => { entry.stopped = true }
    },
  )
  ipc.follow('/papers/a')
  ipc.follow('/papers/b')
  ipc.follow('/papers/a')
  expect(watches.map((w) => w.root)).toEqual(['/papers/a', '/papers/b', '/papers/a'])
  expect(watches[0]!.stopped).toBe(true)

  watches[0]!.onChange(rev(9)) // 첫 A 감시의 늦은 이벤트 — 세대가 다르다
  expect(sent).toEqual([])
  watches[2]!.onChange(rev(4)) // 지금 A 감시
  expect(sent.map((p) => p.root + ':' + String(p.progress?.revision))).toEqual(['/papers/a:4'])
})

/* ------------------------------------------- Roh 1회째 [중요] written_at 시간대 */

test('F14 written_at — 끝이 Z 또는 ±hh:mm인 ISO만 유효', () => {
  const ok = [
    '2026-11-09T06:12:00Z',
    '2026-11-09T06:12:00+09:00',
    '2026-11-09T06:12:00-05:00',
    '2026-11-09T06:12:00.123Z',
    '2026-11-09T06:12Z',
  ]
  const bad = [
    '2026-11-09T06:12:00',      // 시간대 없음
    '2026-11-09T06:12:00+0900', // 콜론 없는 오프셋
    '2026-11-09',               // 날짜만
    '2026-11-09 06:12:00Z',     // `T` 대신 공백
    '2026-11-09T06:12:00Zjunk',
    '',
  ]
  for (const w of ok) expect(parseProgressFile(fileJson({ written_at: w })), w).not.toBeNull()
  for (const w of bad) expect(parseProgressFile(fileJson({ written_at: w })), w).toBeNull()
})
