// §10-5·6·7·10·11·12 (스캔·보관본·격리·실패 허용), §11.8-13(죽은 뒤 복구) — 실제 임시 폴더
import { test, expect } from '@playwright/test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { scanRoot, diffLeaves, leavesEqual, type LeafFingerprint } from '../src/main/guard/scan'
import {
  appendSentLog,
  applyRuleChange,
  blobsDir,
  cleanupEmptyClaudeDirs,
  defaultState,
  getBlob,
  guardDir,
  hashContent,
  loadState,
  putBlob,
  quarantineLeaf,
  readClaudeMd,
  readPending,
  readSentLog,
  recoverPending,
  removeLeaf,
  restoreLeaf,
  saveState,
  sentPath,
  statePath,
  writeClaudeMd,
  writePending,
  type GuardState
} from '../src/main/guard/store'
import { folderHash } from '../src/main/guard/scope'

/** 시험용 HMAC 열쇠. 실제 앱은 `safeStorage`에서 꺼낸 값을 넘긴다. */
const keyOf = (): Buffer => Buffer.from('test-key-do-not-use-in-app', 'utf-8')

const made: string[] = []
function tmpTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-store-'))
  made.push(dir)
  return dir
}

test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** 논문 폴더 하나 + userData 보관본 하나. */
function sandbox(): { root: string; userData: string; folder: string; key: Buffer } {
  const base = tmpTree()
  const root = join(base, 'paper')
  const userData = join(base, 'userdata')
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { root, userData, folder: folderHash(root), key: keyOf() }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function readBlob(userData: string, folder: string, hash: string): string | null {
  const buf = getBlob(userData, folder, hash)
  return buf ? buf.toString('utf-8') : null
}

test('스캔은 lstat 잎만 모으고 내용·링크 대상·실행 비트를 지문으로 쓴다', () => {
  const { root } = sandbox()
  write(root, '.claude/settings.json', '{"a":1}')
  write(root, 'CLAUDE.md', '# student')
  write(root, 'chapters/chapter1.docx', 'docx-bytes')
  write(root, 'notes.md', 'not protected')
  symlinkSync('/somewhere/else.json', join(root, '.mcp.json'))

  const scan = scanRoot({ root })
  expect([...scan.leaves.keys()].sort()).toEqual(['.claude/settings.json', '.mcp.json', 'CLAUDE.md'])
  const settings = scan.leaves.get('.claude/settings.json')!
  expect(settings.kind).toBe('file')
  expect(settings.hash).toBe(hashContent('{"a":1}'))
  const link = scan.leaves.get('.mcp.json')!
  expect(link.kind).toBe('link')
  expect(link.linkTarget).toBe('/somewhere/else.json')
  expect(link.executable).toBe(false)
})

test('Roh 재현: 기존 파일이 있는 .claude에 새 파일·깊은 CLAUDE.md·pyc·끊어진 링크·200KB 덮어쓰기', () => {
  const { root } = sandbox()
  write(root, '.claude/settings.json', '{}')
  write(root, '.claude/x.pyc', 'pyc')
  write(root, 'a/b/c/d/e/CLAUDE.md', 'deep')
  symlinkSync('/nonexistent/target.json', join(root, '.mcp.json'))
  write(root, '.claude/big.txt', 'x'.repeat(200_000))

  const scan = scanRoot({ root })
  expect([...scan.leaves.keys()].sort()).toEqual([
    '.claude/big.txt',
    '.claude/settings.json',
    '.claude/x.pyc',
    '.mcp.json',
    'a/b/c/d/e/CLAUDE.md'
  ])

  const before = scan.leaves.get('.claude/big.txt')!
  write(root, '.claude/big.txt', 'y'.repeat(200_000))
  const rescanned = scanRoot({ root })
  const after = rescanned.leaves.get('.claude/big.txt')!
  expect(after.hash).not.toBe(before.hash)
  expect(diffLeaves(scan.leaves, rescanned.leaves)).toEqual(['.claude/big.txt'])
})

test('파일↔폴더 교체·삭제·하드링크 쓰기는 잎 차이로 드러난다', () => {
  const { root } = sandbox()
  write(root, '.claude/target', 'file-content')
  const first = scanRoot({ root })

  // 파일 → 폴더 교체
  unlinkSync(join(root, '.claude/target'))
  write(root, '.claude/target/inner.json', '{}')
  const second = scanRoot({ root })
  expect(diffLeaves(first.leaves, second.leaves).sort()).toEqual(['.claude/target', '.claude/target/inner.json'])

  // 폴더 → 파일 교체
  rmSync(join(root, '.claude/target'), { recursive: true, force: true })
  write(root, '.claude/target', 'file-again')
  const third = scanRoot({ root })
  expect(diffLeaves(second.leaves, third.leaves).sort()).toEqual(['.claude/target', '.claude/target/inner.json'])

  // 하드링크로 내용 쓰기
  write(root, '.claude/linked.json', 'v1')
  const before = scanRoot({ root })
  write(root, '.claude/linked.json', 'v2')
  expect(leavesEqual(before.leaves, scanRoot({ root }).leaves)).toBe(false)
})

test('링크: 대상 문자열 변경은 차이, 대상 파일 내용 변경은 차이가 아니다', () => {
  const { root } = sandbox()
  const outside = join(tmpTree(), 'target.json')
  writeFileSync(outside, 'v1')
  symlinkSync(outside, join(root, '.claude', 'link.json'))
  const before = scanRoot({ root })

  // 대상 파일 내용 변경 — 지킴이는 따라가지 않는다(§10-7).
  writeFileSync(outside, 'v2')
  const afterContent = scanRoot({ root })
  expect(leavesEqual(before.leaves, afterContent.leaves)).toBe(true)

  // 링크 문자열 변경 — 되돌림 대상이다.
  unlinkSync(join(root, '.claude', 'link.json'))
  symlinkSync(outside + '.other', join(root, '.claude', 'link.json'))
  const afterTarget = scanRoot({ root })
  expect(leavesEqual(afterContent.leaves, afterTarget.leaves)).toBe(false)
  expect(diffLeaves(afterContent.leaves, afterTarget.leaves)).toEqual(['.claude/link.json'])
})

test('실행 권한만 바뀐 것은 유닉스에서 차이, 윈도우 규칙에서는 차이가 아니다', () => {
  const { root } = sandbox()
  write(root, '.claude/hook.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(root, '.claude', 'hook.sh'), 0o644)
  const before = scanRoot({ root }).leaves.get('.claude/hook.sh')!

  chmodSync(join(root, '.claude', 'hook.sh'), 0o755)
  const after = scanRoot({ root }).leaves.get('.claude/hook.sh')!

  expect(after.hash).toBe(before.hash)
  if (process.platform === 'win32') {
    expect(before.executable).toBe(false)
    expect(after.executable).toBe(false)
  } else {
    expect(before.executable).toBe(false)
    expect(after.executable).toBe(true)
    expect(diffLeaves(new Map([['.claude/hook.sh', before]]), new Map([['.claude/hook.sh', after]]))).toEqual(['.claude/hook.sh'])
  }
})

test('보호 대상이 아닌 파일은 내용·수정시각이 그대로다', () => {
  const { root } = sandbox()
  write(root, 'chapters/chapter1.docx', 'original-docx')
  const abs = join(root, 'chapters/chapter1.docx')
  const past = new Date('2026-01-02T03:04:05Z')
  utimesSync(abs, past, past)
  const mtimeBefore = statSync(abs).mtimeMs

  scanRoot({ root })
  write(root, 'chapters/CLAUDE.md', 'nested rule')
  const scan = scanRoot({ root })
  expect(scan.leaves.has('chapters/CLAUDE.md')).toBe(true)

  expect(readFileSync(abs, 'utf-8')).toBe('original-docx')
  expect(statSync(abs).mtimeMs).toBe(mtimeBefore)
})

test('보관본: 상태 파일 하나를 원자 교체하고, 표식이 안 맞으면 알린다', () => {
  const { userData, folder, key } = sandbox()
  expect(loadState(userData, folder, key).integrity).toBe('missing')

  const state: GuardState = { ...defaultState(), injected: 'abc', queryOpen: true }
  const { integrity: _drop, ...without } = state
  expect(saveState(userData, folder, without, key)).toBe(true)
  const loaded = loadState(userData, folder, key)
  expect(loaded.integrity).toBe('ok')
  expect(loaded.state.injected).toBe('abc')
  expect(loaded.state.queryOpen).toBe(true)

  // 손으로 고친 상태는 걸린다.
  const raw = JSON.parse(readFileSync(statePath(userData, folder), 'utf-8')) as GuardState
  raw.injected = 'tampered'
  writeFileSync(statePath(userData, folder), JSON.stringify(raw))
  expect(loadState(userData, folder, key).integrity).toBe('mismatch')

  // 열쇠가 없으면 표식 없이 가지 않는다.
  expect(loadState(userData, folder, null).integrity).toBe('no-key')
  expect(existsSync(statePath(userData, folder))).toBe(true)
})

test('blob은 내용 주소이고 링크는 대상 문자열로 보관한다', () => {
  const { userData, folder } = sandbox()
  const hash = putBlob(userData, folder, 'content-1')
  expect(putBlob(userData, folder, 'content-1')).toBe(hash)
  expect(readBlob(userData, folder, hash)).toBe('content-1')
  expect(readBlob(userData, folder, 'nope')).toBeNull()
  expect(existsSync(join(blobsDir(userData, folder), hash))).toBe(true)
})

test('복원: 파일 내용·실행 비트와 링크 문자열을 되살리고, 새 잎은 지운다', () => {
  const { root, userData, folder } = sandbox()
  write(root, '.claude/settings.json', '{"v":1}')
  if (process.platform !== 'win32') chmodSync(join(root, '.claude/settings.json'), 0o755)
  symlinkSync('/old/target.json', join(root, '.claude', 'link.json'))
  const scan = scanRoot({ root })

  // 보관본에 올린다.
  const stored: Record<string, LeafFingerprint> = {}
  for (const [rel, fingerprint] of scan.leaves) {
    const abs = join(root, rel)
    const content = fingerprint.kind === 'link' ? Buffer.from('link:' + (fingerprint.linkTarget ?? '')) : readFileSync(abs)
    stored[rel] = { ...fingerprint, hash: putBlob(userData, folder, content) }
  }

  // 도우미가 바꾼다.
  write(root, '.claude/settings.json', '{"v":2}')
  unlinkSync(join(root, '.claude', 'link.json'))
  symlinkSync('/new/target.json', join(root, '.claude', 'link.json'))
  write(root, '.claude/new-file.json', '{"new":true}')

  expect(restoreLeaf(root, userData, folder, '.claude/settings.json', stored['.claude/settings.json'])).toBe(true)
  expect(readFileSync(join(root, '.claude/settings.json'), 'utf-8')).toBe('{"v":1}')
  if (process.platform !== 'win32') expect(statSync(join(root, '.claude/settings.json')).mode & 0o777).toBe(0o755)

  expect(restoreLeaf(root, userData, folder, '.claude/link.json', stored['.claude/link.json'])).toBe(true)
  expect(lstatSync(join(root, '.claude/link.json')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(root, '.claude/link.json'))).toBe('/old/target.json')

  expect(removeLeaf(root, '.claude/new-file.json')).toBe(true)
  expect(existsSync(join(root, '.claude/new-file.json'))).toBe(false)
})

test('격리: 이름을 지우고 보관하며, 격리 폴더를 다시 훑어도 새 보호 항목이 없다', () => {
  const { root } = sandbox()
  write(root, '.claude/settings.json', '{"evil":true}')
  const timestamp = 1_762_000_000_000
  const stored = quarantineLeaf(root, '.claude/settings.json', timestamp)

  expect(stored).not.toBeNull()
  expect(existsSync(join(root, '.claude/settings.json'))).toBe(false)
  const indexPath = join(root, '.knuaf-gui', 'quarantine', String(timestamp), 'index.json')
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{ originalPath: string; blobHash: string }>
  expect(index).toEqual([{ originalPath: '.claude/settings.json', blobHash: expect.any(String), kind: 'file' }])
  expect(readFileSync(stored!, 'utf-8')).toBe('{"evil":true}')

  const rescan = scanRoot({ root })
  expect(rescan.leaves.size).toBe(0)
})

test('격리: 이름 바꾸기가 안 되면(다른 볼륨) 복사·확인 뒤 원본을 지운다', () => {
  const { root } = sandbox()
  write(root, '.claude/settings.json', '{"evil":true}')
  const timestamp = 1_762_000_000_001
  let attempts = 0
  const exdev = (): never => {
    attempts += 1
    const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
    error.code = 'EXDEV'
    throw error
  }
  const stored = quarantineLeaf(root, '.claude/settings.json', timestamp, exdev)

  // 이름 바꾸기는 한 번만 시도하고 곧장 복사 길로 간다.
  expect(attempts).toBe(1)
  expect(stored).not.toBeNull()
  // 확인을 마친 뒤에만 원본을 지운다.
  expect(existsSync(join(root, '.claude/settings.json'))).toBe(false)
  expect(readFileSync(stored!, 'utf-8')).toBe('{"evil":true}')
  const indexPath = join(root, '.knuaf-gui', 'quarantine', String(timestamp), 'index.json')
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{ originalPath: string; blobHash: string }>
  expect(index).toEqual([{ originalPath: '.claude/settings.json', blobHash: expect.any(String), kind: 'file' }])
  // 복사에 쓴 임시 파일이 격리 폴더에 남지 않는다.
  const blobs = readdirSync(join(root, '.knuaf-gui', 'quarantine', String(timestamp), 'blobs'))
  expect(blobs).toEqual([stored!.split(sep).pop()])
})

test('빈 .claude 하위 폴더만 정리하고 루트 .claude는 남긴다', () => {
  const { root } = sandbox()
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(root, '.claude', 'commands', 'nested'), { recursive: true })
  write(root, '.claude/commands/keep.md', 'keep')

  const cleaned = cleanupEmptyClaudeDirs(root)
  expect(existsSync(join(root, '.claude'))).toBe(true)
  expect(existsSync(join(root, '.claude', 'agents'))).toBe(false)
  expect(existsSync(join(root, '.claude', 'commands', 'nested'))).toBe(false)
  expect(existsSync(join(root, '.claude', 'commands', 'keep.md'))).toBe(true)
  expect(cleaned.length).toBeGreaterThan(0)
})

test('읽을 수 없는 보호 폴더(권한 000)에서도 스캔이 던지지 않는다', () => {
  const { root } = sandbox()
  write(root, '.claude/locked/inside.json', '{}')
  const locked = join(root, '.claude', 'locked')

  if (process.platform === 'win32') {
    // 윈도우에서는 같은 시험을 흉내 낼 수 없다 — 스캔이 조용히 건너뛰는지만 본다.
    rmSync(locked, { recursive: true, force: true })
    expect(() => scanRoot({ root })).not.toThrow()
    return
  }
  chmodSync(locked, 0o000)
  try {
    expect(() => scanRoot({ root })).not.toThrow()
    const scan = scanRoot({ root })
    expect(scan.leaves.size).toBe(0)
  } finally {
    chmodSync(locked, 0o755)
  }
})

test('전송 장부: 덧붙이기만 하고, 손으로 고친 줄은 읽지 않는다', () => {
  const { userData, folder, key } = sandbox()
  appendSentLog(userData, folder, { id: 'm1', folder: '/paper', provider: 'claude', convId: 'c1', text: '규칙: 숨체' }, key)
  appendSentLog(userData, folder, { id: 'm2', folder: '/paper', provider: 'codex', convId: 'c2', text: 'second', timestamp: 42 }, key)

  const ledger = readSentLog(userData, folder, key)
  expect(ledger.integrityOk).toBe(true)
  expect(ledger.entries.map((entry) => entry.id)).toEqual(['m1', 'm2'])
  expect(ledger.entries[1].timestamp).toBe(42)

  // 한 줄을 손으로 고치면 그 줄은 버리고 기능을 끈다.
  const text = readFileSync(sentPath(userData, folder), 'utf-8')
  writeFileSync(sentPath(userData, folder), text.replace('second', 'forged'))
  const tampered = readSentLog(userData, folder, key)
  expect(tampered.integrityOk).toBe(false)
  expect(tampered.entries.map((entry) => entry.id)).toEqual(['m1'])
})

test('앱이 쓰는 순서: 보관본 내용에 변경 하나만 얹고, 성공 시점은 상태 파일 교체다', () => {
  const { root, userData, folder, key } = sandbox()
  write(root, 'CLAUDE.md', '# student direct\n')

  const t0State: GuardState = {
    ...defaultState(),
    leaves: { 'CLAUDE.md': { kind: 'file', hash: hashContent('# student direct\n'), executable: false } },
    injected: putBlob(userData, folder, '# student direct\n')
  }
  const { integrity: _i, ...without } = t0State
  saveState(userData, folder, without, key)

  const outcome = applyRuleChange({
    rootReal: root,
    userData,
    folderHash: folder,
    key,
    state: t0State,
    action: 'add',
    mutate: (baseline) => ({
      success: true,
      newContent: baseline + '\n- 숨체로 써 줘.\n',
      message: '규칙을 저장했어요.',
      sectionCreated: true,
      errors: []
    })
  })

  expect(outcome.success).toBe(true)
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe('# student direct\n\n- 숨체로 써 줘.\n')
  const after = loadState(userData, folder, key)
  expect(after.integrity).toBe('ok')
  expect(readBlob(userData, folder, after.state.injected!)).toBe('# student direct\n\n- 숨체로 써 줘.\n')
  expect(readPending(userData, folder, key)).toBeNull()
})

test('앱이 쓰는 순서: 질의 중이면 도우미가 고친 파일을 먼저 되돌린 뒤 저장한다', () => {
  const { root, userData, folder, key } = sandbox()
  write(root, 'CLAUDE.md', '# student\n')
  const state: GuardState = {
    ...defaultState(),
    queryOpen: true,
    leaves: { 'CLAUDE.md': { kind: 'file', hash: hashContent('# student\n'), executable: false } },
    injected: putBlob(userData, folder, '# student\n')
  }
  const { integrity: _i, ...without } = state
  saveState(userData, folder, without, key)

  // 도우미가 몰래 줄을 넣어 뒀다.
  write(root, 'CLAUDE.md', '# student\n- 도우미가 넣은 줄\n')

  const outcome = applyRuleChange({
    rootReal: root,
    userData,
    folderHash: folder,
    key,
    state,
    action: 'add',
    mutate: (baseline) => ({ success: true, newContent: baseline + '- 학생 규칙\n', message: 'ok', sectionCreated: false, errors: [] })
  })

  expect(outcome.success).toBe(true)
  expect(outcome.cleanedDisk).toBe(true)
  const disk = readFileSync(join(root, 'CLAUDE.md'), 'utf-8')
  expect(disk).toBe('# student\n- 학생 규칙\n')
  expect(disk).not.toContain('도우미가 넣은 줄')

  // 도우미가 넣은 줄은 격리에 남아 있다.
  const quarantineRoot = join(root, '.knuaf-gui', 'quarantine')
  expect(existsSync(quarantineRoot)).toBe(true)
})

test('앱이 쓰는 순서: 링크 파일에는 저장하지 않는다', () => {
  const { root, userData, folder, key } = sandbox()
  const target = join(tmpTree(), 'real.md')
  writeFileSync(target, '# linked')
  symlinkSync(target, join(root, 'CLAUDE.md'))

  const outcome = applyRuleChange({
    rootReal: root,
    userData,
    folderHash: folder,
    key,
    state: defaultState(),
    action: 'add',
    mutate: (baseline) => ({ success: true, newContent: baseline + 'x', message: 'ok', sectionCreated: false, errors: [] })
  })
  expect(outcome.success).toBe(false)
  expect(outcome.message).toContain('링크')
  expect(readFileSync(target, 'utf-8')).toBe('# linked')
})

test('죽은 뒤 복구 네 갈래', () => {
  const setup = (): { root: string; userData: string; folder: string; key: Buffer; state: GuardState } => {
    const box = sandbox()
    write(box.root, 'CLAUDE.md', 'old\n')
    const state: GuardState = { ...defaultState(), injected: putBlob(box.userData, box.folder, 'old\n') }
    const { integrity: _i, ...without } = state
    saveState(box.userData, box.folder, without, box.key)
    return { ...box, state }
  }

  // ① 상태 파일이 이미 새 지문 — 쪽지만 지운다.
  {
    const { root, userData, folder, key } = setup()
    const nextHash = putBlob(userData, folder, 'new\n')
    writePending(userData, folder, { action: 'add', previousHash: hashContent('old\n'), nextHash, at: 1 }, key)
    const current = loadState(userData, folder, key).state
    const withNew: GuardState = { ...current, injected: nextHash }
    const { integrity: _x, ...withoutNew } = withNew
    saveState(userData, folder, withoutNew, key)

    const recovery = recoverPending({ rootReal: root, userData, folderHash: folder, key, state: withNew })
    expect(recovery).toMatchObject({ hadPending: true, success: true })
    expect(readPending(userData, folder, key)).toBeNull()
  }

  // ② 디스크가 새 지문 — 7번을 마저 한다.
  {
    const { root, userData, folder, key, state } = setup()
    const nextHash = putBlob(userData, folder, 'new\n')
    writePending(userData, folder, { action: 'add', previousHash: hashContent('old\n'), nextHash, at: 1 }, key)
    writeClaudeMd(root, 'new\n')

    const recovery = recoverPending({ rootReal: root, userData, folderHash: folder, key, state })
    expect(recovery).toMatchObject({ hadPending: true, success: true })
    expect(loadState(userData, folder, key).state.injected).toBe(nextHash)
    expect(readPending(userData, folder, key)).toBeNull()
  }

  // ③ 디스크가 이전 지문 — 저장 안 된 것으로 닫는다.
  {
    const { root, userData, folder, key, state } = setup()
    const nextHash = putBlob(userData, folder, 'new\n')
    writePending(userData, folder, { action: 'add', previousHash: hashContent('old\n'), nextHash, at: 1 }, key)

    const recovery = recoverPending({ rootReal: root, userData, folderHash: folder, key, state })
    expect(recovery.hadPending).toBe(true)
    expect(recovery.success).toBe(false)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe('old\n')
    expect(readPending(userData, folder, key)).toBeNull()
  }

  // ④ 디스크가 둘 다 아님 — 덮어쓰지 않는다.
  {
    const { root, userData, folder, key, state } = setup()
    const nextHash = putBlob(userData, folder, 'new\n')
    writePending(userData, folder, { action: 'add', previousHash: hashContent('old\n'), nextHash, at: 1 }, key)
    writeClaudeMd(root, 'student typed this\n')

    const recovery = recoverPending({ rootReal: root, userData, folderHash: folder, key, state })
    expect(recovery.hadPending).toBe(true)
    expect(recovery.success).toBe(false)
    expect(recovery.message).toContain('다시 눌러')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe('student typed this\n')
  }
})

test('보관본 자리는 스캔에서 빠진다(도우미 보관본이 보호 항목을 만들지 않는다)', () => {
  const { root, userData } = sandbox()
  write(root, '.claude/settings.json', '{}')
  mkdirSync(join(userData, 'guard', randomBytes(4).toString('hex')), { recursive: true })

  const scan = scanRoot({ root, userData })
  expect([...scan.leaves.keys()]).toEqual(['.claude/settings.json'])
  expect(readClaudeMd(root).state).toBe('missing')
  expect(guardDir(userData, 'abc')).toBe(join(userData, 'guard', 'abc'))
})
