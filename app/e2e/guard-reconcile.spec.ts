// §10-8(질의 밖/안·강제 종료·윈도우 속성), §10-9(허락 범위·루트 CLAUDE.md 예외),
// §10-11(실패해도 질의는 간다), §10-14(동시 실행 직렬화) — 실제 임시 폴더 + 실제 시간
import { test, expect } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRoot } from '../src/main/guard/scan'
import { folderHash } from '../src/main/guard/scope'
import { defaultState, getBlob, putBlob, saveState, type GuardState } from '../src/main/guard/store'
import { evaluateT0, evaluateT2 } from '../src/main/guard/reconcile'
import { busy, pendingCount, resetGuardLocks, withGuardLock } from '../src/main/guard/lock'

const made: string[] = []
test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function sandbox(): { root: string; userData: string; folder: string; key: Buffer } {
  const base = mkdtempSync(join(tmpdir(), 'kd-reconcile-'))
  made.push(base)
  const root = join(base, 'paper')
  const userData = join(base, 'userdata')
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { root, userData, folder: folderHash(root), key: Buffer.from('test-key', 'utf-8') }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

/** 지금 폴더를 처음 여는 상태(T0 첫 실행)로 만든다. */
function adopt(box: { root: string; userData: string; folder: string; key: Buffer }): GuardState {
  const scan = scanRoot({ root: box.root, userData: box.userData })
  const state = evaluateT0({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: defaultState(),
    scan
  }).state
  const { integrity: _i, ...without } = state
  saveState(box.userData, box.folder, without, box.key)
  return state
}

test('질의 밖 변경: T0는 되돌리지 않고 받아들여 보관본을 새 내용으로 바꾸고 알림을 한 번 낸다', () => {
  const box = sandbox()
  write(box.root, '.claude/settings.json', '{"v":1}')
  write(box.root, '.claude/hooks.json', '{"hooks":[]}')
  let state = adopt(box)

  // 첫 T0는 기준을 세운다(모두 "학생이 처음 연 폴더" 내용).
  expect(state.queryOpen).toBe(true)
  // T2로 질의를 닫는다.
  const t2 = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  state = t2.state
  expect(state.queryOpen).toBe(false)

  // 질의 사이에 학생이 고친다.
  write(box.root, '.claude/settings.json', '{"v":2}')

  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(t0.crashedQuery).toBe(false)
  expect(t0.reverted).toEqual([])
  expect(t0.accepted).toEqual(['.claude/settings.json'])
  expect(t0.notes.length).toBe(1)
  expect(t0.notes[0]).toContain('설정 파일(.claude/settings.json)')
  expect(t0.notes[0]).toContain('그대로 두었어요')
  // 파일은 그대로다.
  expect(read(box.root, '.claude/settings.json')).toBe('{"v":2}')
  // 보관본은 새 내용으로 바뀌었다(blob이 새 해시).
  const blob = getBlob(box.userData, box.folder, t0.state.leaves['.claude/settings.json'].hash)
  expect(blob?.toString('utf-8')).toBe('{"v":2}')

  // 질의를 닫고 다시 열어도, 그 사이 아무것도 안 바뀌었으면 알림이 없다.
  const closed = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: t0.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  const quiet = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: closed.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(quiet.notes).toEqual([])
  expect(quiet.accepted).toEqual([])
})

test('질의 안 변경: T2가 되돌리고 격리에 남기며 알림을 낸다', () => {
  const box = sandbox()
  write(box.root, '.claude/settings.json', '{"v":1}')
  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state

  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  // 질의 중 도우미가 바꾼다.
  write(box.root, '.claude/settings.json', '{"v":"eviL"}')
  write(box.root, '.claude/new.json', '{"created":true}')

  const t2 = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: t0.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(read(box.root, '.claude/settings.json')).toBe('{"v":1}')
  expect(existsSync(join(box.root, '.claude/new.json'))).toBe(false)
  expect(t2.reverted.map((entry) => entry.rel).sort()).toEqual(['.claude/new.json', '.claude/settings.json'])
  expect(t2.reverted.every((entry) => entry.quarantinePath !== null)).toBe(true)
  expect(t2.notes.length).toBe(2)
  expect(t2.notes.every((note) => note.includes('되돌렸어요'))).toBe(true)
  expect(t2.state.queryOpen).toBe(false)

  // 격리 폴더를 다시 훑어도 새 보호 항목이 없다(§10-12).
  expect(scanRoot({ root: box.root, userData: box.userData }).leaves.size).toBe(1)
})

test('T2: 카드로 허락된 경로만 남기고, 같은 질의의 다른 보호 경로는 되돌린다', () => {
  const box = sandbox()
  write(box.root, '.claude/allowed.json', '{"v":1}')
  write(box.root, '.claude/denied.json', '{"v":1}')
  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state
  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  write(box.root, '.claude/allowed.json', '{"v":2}')
  write(box.root, '.claude/denied.json', '{"v":2}')

  const t2 = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: t0.state,
    scan: scanRoot({ root: box.root, userData: box.userData }),
    trusted: (rel) => rel === '.claude/allowed.json'
  })
  expect(t2.kept).toEqual(['.claude/allowed.json'])
  expect(t2.reverted.map((entry) => entry.rel)).toEqual(['.claude/denied.json'])
  expect(read(box.root, '.claude/allowed.json')).toBe('{"v":2}')
  expect(read(box.root, '.claude/denied.json')).toBe('{"v":1}')
  // 남긴 내용이 보관본에도 올라간다 — 다음 T2가 또 되돌리지 않는다.
  expect(getBlob(box.userData, box.folder, t2.state.leaves['.claude/allowed.json'].hash)?.toString('utf-8')).toBe('{"v":2}')
})

test('루트 CLAUDE.md는 카드로 허락돼도 되돌린다(§10-9 예외)', () => {
  const box = sandbox()
  write(box.root, 'CLAUDE.md', '# student\n')
  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state
  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  write(box.root, 'CLAUDE.md', '# student\n- 도우미가 넣은 규칙\n')

  const t2 = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: t0.state,
    scan: scanRoot({ root: box.root, userData: box.userData }),
    trusted: () => true
  })
  expect(t2.kept).toEqual([])
  expect(t2.reverted).toEqual([expect.objectContaining({ rel: 'CLAUDE.md', reason: 'claude-md' })])
  expect(read(box.root, 'CLAUDE.md')).toBe('# student\n')
  expect(t2.notes[0]).toContain('[규칙으로 기억]')
  expect(t2.claudeMdChanged).toBe(true)
})

test('강제 종료: queryOpen이 남아 있으면 다음 T0가 질의 안 변경으로 보고 되돌린다', () => {
  const box = sandbox()
  write(box.root, '.claude/settings.json', '{"v":1}')
  write(box.root, 'CLAUDE.md', '# student\n')

  // 질의가 열린 채 T2가 못 돌았다.
  const open: GuardState = { ...adopt(box), queryOpen: true }
  const { integrity: _i, ...without } = open
  saveState(box.userData, box.folder, without, box.key)

  write(box.root, '.claude/settings.json', '{"v":"crashed"}')
  write(box.root, 'CLAUDE.md', '# student\n- 도우미\n')

  const t0 = evaluateT0({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: open,
    scan: scanRoot({ root: box.root, userData: box.userData })
  })
  expect(t0.crashedQuery).toBe(true)
  // 질의 밖 변경으로 받아들이지 않는다.
  expect(t0.accepted).toEqual([])
  expect(t0.reverted.length).toBe(2)
  expect(read(box.root, '.claude/settings.json')).toBe('{"v":1}')
  expect(read(box.root, 'CLAUDE.md')).toBe('# student\n')
  expect(t0.notes.some((note) => note.includes('앱이 꺼져서'))).toBe(true)
  // 다음 T2가 같은 일을 반복하지 않도록 보관본이 지금 폴더와 맞는다.
  const next = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: t0.state,
    scan: scanRoot({ root: box.root, userData: box.userData })
  })
  expect(next.reverted).toEqual([])
})

test('T2: 스트림 오류로 끝난 질의도 되돌린다(질의 끝은 같다)', () => {
  const box = sandbox()
  write(box.root, '.claude/settings.json', '{"v":1}')
  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state
  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  write(box.root, '.claude/settings.json', '{"v":"after-error"}')
  // 오류로 끝나도 finally의 T2는 같은 일을 한다(여기서는 T2 호출 자체가 그 사실을 잠근다).
  const t2 = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: t0.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(read(box.root, '.claude/settings.json')).toBe('{"v":1}')
  expect(t2.reverted.map((entry) => entry.rel)).toEqual(['.claude/settings.json'])
})

test('읽을 수 없는 폴더(권한 000)가 있어도 T0는 던지지 않고 질의를 시작하게 한다', () => {
  if (process.platform === 'win32') return
  const box = sandbox()
  write(box.root, '.claude/ok.json', '{}')
  write(box.root, '.claude/locked/secret.json', '{}')
  const state = adopt(box)
  chmodSync(join(box.root, '.claude/locked'), 0o000)
  try {
    const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })
    expect(t0.proceed).toBe(true)
  } finally {
    chmodSync(join(box.root, '.claude/locked'), 0o755)
  }
})

test('링크: 대상 문자열만 되돌리고 링크 너머 파일은 건드리지 않는다', () => {
  const box = sandbox()
  const outsideDir = join(box.userData, 'outside')
  mkdirSync(outsideDir, { recursive: true })
  const target = join(outsideDir, 'target.json')
  writeFileSync(target, 'v1')
  symlinkSync(target, join(box.root, '.claude', 'link.json'))

  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state
  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  // 링크 너머 내용 변경 — 되돌리지 않는다.
  writeFileSync(target, 'v2')
  const untouched = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: t0.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(untouched.reverted).toEqual([])
  expect(readFileSync(target, 'utf-8')).toBe('v2')

  // 링크 대상 문자열 변경 — 되돌린다.
  unlinkSync(join(box.root, '.claude', 'link.json'))
  symlinkSync('/elsewhere/x.json', join(box.root, '.claude', 'link.json'))
  const reverted = evaluateT2({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state: untouched.state, scan: scanRoot({ root: box.root, userData: box.userData }) })
  expect(reverted.reverted.map((entry) => entry.rel)).toEqual(['.claude/link.json'])
})

test('T0 뒤에 폴더를 바꿔도 보관본 blob은 T0 때 내용이다(주입은 디스크가 아니라 보관본에서 읽는다)', () => {
  const box = sandbox()
  write(box.root, 'CLAUDE.md', '# T0 content\n')
  const state = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: adopt(box),
    scan: scanRoot({ root: box.root, userData: box.userData })
  }).state
  const t0 = evaluateT0({ rootReal: box.root, userData: box.userData, folderHash: box.folder, state, scan: scanRoot({ root: box.root, userData: box.userData }) })

  const storedHash = t0.state.leaves['CLAUDE.md'].hash
  write(box.root, 'CLAUDE.md', '# changed after T0\n')

  expect(getBlob(box.userData, box.folder, storedHash)?.toString('utf-8')).toBe('# T0 content\n')
  expect(scanRoot({ root: box.root, userData: box.userData }).leaves.get('CLAUDE.md')!.hash).not.toBe(storedHash)
})

test('동시 실행: 같은 폴더의 지킴이 작업은 한 번에 하나만 돈다(기다린다, 던지지 않는다)', async () => {
  resetGuardLocks()
  const root = '/paper-concurrent'
  const order: string[] = []
  let running = 0
  let maxRunning = 0

  const work = (name: string, delay: number): Promise<void> =>
    withGuardLock(root, async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      order.push(`start:${name}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      order.push(`end:${name}`)
      running--
    })

  await Promise.all([work('a', 20), work('b', 5), work('c', 1)])
  expect(maxRunning).toBe(1)
  expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  expect(busy(root)).toBe(false)
  expect(pendingCount(root)).toBe(0)
})

test('동시 실행: 다른 폴더는 서로를 기다리지 않는다', async () => {
  resetGuardLocks()
  const started: string[] = []
  const gate = Promise.withResolvers<void>()
  const first = withGuardLock('/paper-a', async () => {
    started.push('a')
    await gate.promise
  })
  const second = withGuardLock('/paper-b', async () => {
    started.push('b')
  })
  await second
  expect(started).toEqual(['a', 'b'])
  gate.resolve()
  await first
})

test('잠금 재진입: 같은 비동기 문맥 안에서 다시 불러도 교착되지 않는다', async () => {
  resetGuardLocks()
  const result = await withGuardLock('/paper-reentrant', async () => withGuardLock('/paper-reentrant', async () => 42))
  expect(result).toBe(42)
})

test('잠금: fn이 던져도 잠금은 풀린다', async () => {
  resetGuardLocks()
  const root = '/paper-throw'
  await expect(withGuardLock(root, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(busy(root)).toBe(false)
  expect(await withGuardLock(root, async () => 'ok')).toBe('ok')
})

test('같은 비동기 문맥의 안쪽 부름은 대기자로 세지 않는다(대기자 수 단조)', async () => {
  resetGuardLocks()
  const root = '/paper-count'
  const seen: number[] = []
  await withGuardLock(root, async () => {
    seen.push(pendingCount(root))
    await withGuardLock(root, async () => seen.push(pendingCount(root)))
  })
  expect(seen).toEqual([1, 1])
})
