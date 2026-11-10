// §16.4 — Roh 1단계 반례 17건(이름 그대로). 원본: review-share/2026-11-10-v063-guard-stage1/evidence/guard-stage1-independent.mjs
import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as S from '../src/main/guard/store'
import * as R from '../src/main/guard/rules'
import * as C from '../src/main/guard/reconcile'
import * as Scan from '../src/main/guard/scan'
import * as I from '../src/main/guard/instructions'
import * as Scope from '../src/main/guard/scope'
import type { GuardState } from '../src/main/guard/store'

const made: string[] = []
test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const key = Buffer.alloc(32, 1) // 시험용 열쇠

interface Env {
  rootReal: string
  userData: string
  folderHash: string
  key: Buffer
}

function env(name: string): Env {
  const base = mkdtempSync(join(tmpdir(), `kd-roh-${name}-`))
  made.push(base)
  const rootReal = join(base, 'root')
  const userData = join(base, 'data')
  mkdirSync(rootReal, { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { rootReal, userData, folderHash: 'folder', key }
}

function init(e: Env, text: string | Buffer = 'APPROVED\n'): GuardState {
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), text)
  const state: GuardState = S.defaultState()
  state.leaves = S.adoptLeaves(
    e.rootReal,
    e.userData,
    e.folderHash,
    Scan.scanRoot({ root: e.rootReal, userData: e.userData }).leaves
  ).leaves
  state.injected = state.leaves['CLAUDE.md'].hash
  state.queryOpen = true
  const { integrity: _i, ...without } = state
  S.saveState(e.userData, e.folderHash, without, e.key)
  return S.loadState(e.userData, e.folderHash, e.key).state
}

const mutate = (baseline: string): R.UpdateResult => R.addRuleToContent(baseline, 'Use concise sentences.')

test('C1a: absent baseline must not promote live query-time file', () => {
  const e = env('absent')
  const state: GuardState = { ...S.defaultState(), queryOpen: true }
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const result = S.applyRuleChange({ ...e, state, action: 'add', mutate })
  expect(result.newContent.includes('UNAPPROVED')).toBe(false)
})

test('C1b: missing blob must fail closed, not fall back to live file', () => {
  const e = env('missing')
  const state = init(e)
  unlinkSync(join(S.blobsDir(e.userData, e.folderHash), state.injected as string))
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const result = S.applyRuleChange({ ...e, state, action: 'add', mutate })
  expect(result.success).toBe(false)
})

test('C2: signed reference must not authenticate changed blob bytes', () => {
  const e = env('blob')
  const state = init(e)
  writeFileSync(join(S.blobsDir(e.userData, e.folderHash), state.injected as string), 'UNAPPROVED\n')
  expect(S.loadState(e.userData, e.folderHash, key).integrity).toBe('ok')
  expect(S.injectedClaudeMd(state, e.userData, e.folderHash)).toBeNull()
})

for (const phase of ['T0', 'T2'] as const) {
  test(`C3: ${phase} failed rollback must not adopt rejected contents`, () => {
    const e = env(`rollback-${phase}`)
    const state = init(e)
    unlinkSync(join(S.blobsDir(e.userData, e.folderHash), state.injected as string))
    writeFileSync(join(e.rootReal, '.knuaf-gui'), 'ordinary file blocks quarantine')
    writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
    const scan = Scan.scanRoot({ root: e.rootReal, userData: e.userData })
    const result = phase === 'T0'
      ? C.evaluateT0({ ...e, state, scan })
      : C.evaluateT2({ ...e, state, scan })
    expect(result.reverted[0].restoredFromStore).toBe(false)
    expect(result.state.injected).not.toBe(S.hashContent('UNAPPROVED\n'))
  })
}

test('C4: first run without safeStorage key must be disabled', () => {
  const e = env('no-key')
  const loaded = S.loadState(e.userData, e.folderHash, null)
  const ledger = S.readSentLog(e.userData, e.folderHash, null)
  expect(S.injectionsEnabled(loaded.integrity, ledger.integrityOk)).toBe(false)
})

test('C5: unsigned pending note must not authorize a new injected state', () => {
  const e = env('pending-forgery')
  const state = init(e)
  const text = 'UNAPPROVED\n'
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), text)
  const next = S.putBlob(e.userData, e.folderHash, text)
  S.writePending(e.userData, e.folderHash, { action: 'add', previousHash: state.injected as string, nextHash: next, at: 1 })
  const result = S.recoverPending({ ...e, state })
  expect(result.success).toBe(false)
})

test('C5: forged note on disk must be rejected and removed', () => {
  const e = env('pending-forged-disk')
  const state = init(e)
  const next = S.putBlob(e.userData, e.folderHash, 'UNAPPROVED\n')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  // 열쇠 없이 손으로 만든 쪽지 — 표식이 없으니 복구 근거가 못 된다.
  writeFileSync(
    S.pendingPath(e.userData, e.folderHash),
    JSON.stringify({ action: 'add', previousHash: state.injected as string, nextHash: next, at: 1 })
  )
  const result = S.recoverPending({ ...e, state })
  expect(result.success).toBe(false)
  expect(result.state.injected).toBe(state.injected)
  expect(S.readPending(e.userData, e.folderHash, e.key)).toBeNull()
})

test('I1: post-crash student edit must survive recovery then T0', () => {
  const e = env('recovery')
  const state = init(e)
  S.writePending(e.userData, e.folderHash, {
    action: 'add',
    previousHash: state.injected as string,
    nextHash: S.hashContent('PENDING\n'),
    at: 1
  }, e.key)
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'STUDENT AFTER CRASH\n')
  const recovery = S.recoverPending({ ...e, state })
  C.evaluateT0({
    ...e,
    state: recovery.state,
    scan: Scan.scanRoot({ root: e.rootReal, userData: e.userData })
  })
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('STUDENT AFTER CRASH\n')
})

test('I2: committed rules table must match committed file', () => {
  const e = env('table')
  const state = init(e)
  const result = S.applyRuleChange({ ...e, state, action: 'add', mutate })
  expect(result.success).toBe(true)
  expect(result.state.rules.map((x) => x.normalized)).toEqual(['Use concise sentences.'])
})

test('I3: pending-note failure must stop before file replacement', () => {
  const e = env('pending-failure')
  const state = init(e)
  mkdirSync(S.pendingPath(e.userData, e.folderHash))
  const result = S.applyRuleChange({ ...e, state, action: 'add', mutate })
  expect(result.success).toBe(false)
})

test('I4: last rule removal must preserve outside bytes', () => {
  const before = 'before  \n\n'
  const after = '\n  indented after\n'
  const block = I.serializeRulesSection([{ normalized: 'rule' }])
  expect(R.removeRuleFromContent(before + block + after, 'rule').newContent).toBe(before + after)
})

test('I5: non-UTF8 source file must be refused, not replacement-decoded', () => {
  const e = env('bad-utf8')
  const state = init(e, Buffer.from([0xff, 0xfe]))
  state.queryOpen = false
  const result = S.applyRuleChange({ ...e, state, action: 'add', mutate })
  expect(result.success).toBe(false)
})

test('I6: merged file rule IDs must be unique across retained and new entries', () => {
  const before = R.mergeRules(I.serializeRulesSection([{ normalized: 'abcdefgh OLD' }]), [])
  const after = R.mergeRules(
    I.serializeRulesSection([{ normalized: 'abcdefgh OLD' }, { normalized: 'abcdefgh NEW' }]),
    before
  )
  expect(new Set(after.map((x) => x.id)).size).toBe(after.length)
})

test('I7: ordinary object-property filenames must not become protected', () => {
  expect(Scope.isProtectedPath('/paper/toString', '/paper')).toBe(false)
})

test('I7: ordinary object-property rules must not look duplicated', () => {
  expect(R.addRuleToContent('', 'toString').success).toBe(true)
})

test('Control: NFC decomposition is refused for remembered rule', () => {
  expect(I.validateRuleText('가'.normalize('NFD')).ok).toBe(false)
})

test('Control: fixed app preamble and exact student round-trip', () => {
  const nonce = 'fixed-test-nonce'
  const text = 'rule\n\nsecond'
  const assembled = I.assembleStudentInstructions({ appGuide: 'APP', injectedText: text, nonce })
  expect(assembled.startsWith('APP\n\n' + I.STUDENT_CLAUDE_HEADNOTE)).toBe(true)
  expect(I.extractStudentSection(assembled, nonce)).toBe(text)
})

// ── §16.2·§16.4 설계가 더한 시험 ──────────────────────────────────────────

test('16.2: case-variant .CLAUDE/ and claude.md are protected', () => {
  expect(Scope.isProtectedPath('/paper/.CLAUDE/settings.json', '/paper')).toBe(true)
  expect(Scope.isProtectedPath('/paper/claude.md', '/paper')).toBe(true)
  expect(Scope.isProtectedPath('/paper/CLAUDE.MD', '/paper')).toBe(true)
  // 평범한 파일은 그대로 아니다.
  expect(Scope.isProtectedPath('/paper/notes.md', '/paper')).toBe(false)
})

test('16.4: recovery ② must fail when the new blob fingerprint does not match', () => {
  const e = env('recovery-blob')
  const state = init(e)
  const nextHash = S.putBlob(e.userData, e.folderHash, 'PENDING\n')
  S.writePending(e.userData, e.folderHash, {
    action: 'add',
    previousHash: state.injected as string,
    nextHash,
    at: 1
  }, e.key)
  // 디스크는 새 지문과 같지만 blob 글자를 바꿔 둔다(이름만 맞는 변조).
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'PENDING\n')
  writeFileSync(join(S.blobsDir(e.userData, e.folderHash), nextHash), 'UNAPPROVED\n')
  const recovery = S.recoverPending({ ...e, state })
  expect(recovery.success).toBe(false)
  expect(recovery.acceptedLeaves).toEqual([])
})

test('16.4: state file with empty integrity is reported as mismatch', () => {
  const e = env('integrity-empty')
  const state = init(e)
  const path = S.statePath(e.userData, e.folderHash)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  raw.integrity = ''
  writeFileSync(path, JSON.stringify(raw))
  expect(S.loadState(e.userData, e.folderHash, e.key).integrity).toBe('mismatch')
  expect(state.injected).not.toBeNull()
})
