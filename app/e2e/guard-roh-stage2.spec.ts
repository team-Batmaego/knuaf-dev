// §16.5 — Roh가 남긴 지적(C3·I1·I2)의 닫힘 시험 + 전이표 ①~⑫.
// 앞 4건은 `review-share/2026-11-10-v063-guard-stage1-fix/R2/guard-stage1-fix-evidence/closure-regression.mjs`
// 의 실패 4건을, 그 뒤 7건은 `review-share/2026-11-11-v063-guard-stage1-fix2/r3-evidence/closure-fix2.mjs`
// 를 **이름 그대로** 옮긴 것이다(§16.5.6). 마지막은 §16.5.2 표를 잎 하나짜리 표 주도 시험으로 잠근다.
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import * as S from '../src/main/guard/store'
import * as R from '../src/main/guard/rules'
import * as C from '../src/main/guard/reconcile'
import * as Scan from '../src/main/guard/scan'
import * as I from '../src/main/guard/instructions'
import { folderHash } from '../src/main/guard/scope'

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
  const base = mkdtempSync(join(tmpdir(), `kd-roh2-${name}-`))
  made.push(base)
  const rootReal = join(base, 'root')
  const userData = join(base, 'data')
  mkdirSync(rootReal, { recursive: true })
  mkdirSync(userData, { recursive: true })
  return { rootReal, userData, folderHash: folderHash(rootReal), key }
}

const scanOf = (e: Env): Scan.ScanResult => Scan.scanRoot({ root: e.rootReal, userData: e.userData })

/** Roh 스크립트의 `init` 그대로 — 잎 전부 수용, `injected` 채움, 질의 열림, 저장. */
function init(e: Env, other = false): S.GuardState {
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'APPROVED\n')
  if (other) {
    mkdirSync(join(e.rootReal, '.claude'))
    writeFileSync(join(e.rootReal, '.claude/settings.json'), 'APPROVED SETTINGS\n')
  }
  const state: S.GuardState = S.defaultState()
  state.leaves = S.adoptLeaves(e.rootReal, e.userData, e.folderHash, scanOf(e).leaves).leaves
  state.injected = state.leaves['CLAUDE.md'].hash
  state.queryOpen = true
  expect(S.saveState(e.userData, e.folderHash, state, key)).toBe(true)
  return S.loadState(e.userData, e.folderHash, key).state
}

const mutate = (baseline: string): R.UpdateResult => R.addRuleToContent(baseline, 'Use concise sentences.')

// ── Roh 보강 시험 실패 4건 (이름 그대로, §16.5.6) ─────────────────────────────

test('C3 closure: failed T2 rollback stays untrusted through the next T0', () => {
  const e = env('c3-next-t0')
  const state = init(e)
  unlinkSync(join(S.blobsDir(e.userData, e.folderHash), state.injected as string))
  writeFileSync(join(e.rootReal, '.knuaf-gui'), 'ordinary file blocks quarantine')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const t2 = C.evaluateT2({ ...e, state, scan: scanOf(e) })
  // ⑥ 실패 → H(보류). 넣는 판은 null(이전 글을 "학생 규칙"이라며 넣지 않는다).
  expect(t2.state.injected).toBe(null)
  expect(t2.reverted[0].reverted).toBe(false)
  expect(t2.state.held['CLAUDE.md']).toBeDefined()
  S.saveState(e.userData, e.folderHash, t2.state, key)
  // 다음 T0는 ⑦ — 되돌리기만 다시 시도하고 **절대 수용하지 않는다**.
  const t0 = C.evaluateT0({ ...e, state: S.loadState(e.userData, e.folderHash, key).state, scan: scanOf(e) })
  expect(t0.accepted).toEqual([])
  expect(t0.state.injected).not.toBe(S.hashContent('UNAPPROVED\n'))
})

test('I1 closure: recovery accepts only the student CLAUDE.md leaf, not other query edits', () => {
  const e = env('i1-other-leaf')
  const state = init(e, true)
  expect(
    S.writePending(
      e.userData,
      e.folderHash,
      { action: 'add', previousHash: state.injected, nextHash: S.hashContent('PENDING\n'), at: 1 },
      key
    )
  ).toBe(true)
  writeFileSync(join(e.rootReal, '.claude/settings.json'), 'UNAPPROVED SETTINGS\n')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'STUDENT AFTER CRASH\n')
  const recovery = S.recoverPending({ ...e, state })
  // 집합은 루트 CLAUDE.md 하나뿐이다. `queryOpen`은 그대로다(복구는 건드리지 않는다).
  // 수용 집합은 잎 이름 + 그때 디스크 지문 한 쌍이다(§16.5.3 '지문 필수').
  expect(recovery.accepted).toEqual([{ rel: 'CLAUDE.md', hash: S.hashContent('STUDENT AFTER CRASH\n') }])
  expect(recovery.state.queryOpen).toBe(true)
  const t0 = C.evaluateT0({ ...e, state: recovery.state, accepted: recovery.accepted, scan: scanOf(e) })
  // ④ — 학생이 고친 CLAUDE.md는 살아남는다.
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('STUDENT AFTER CRASH\n')
  // ③ — 같은 질의에서 바뀐 다른 잎은 되돌린다.
  expect(readFileSync(join(e.rootReal, '.claude/settings.json'), 'utf8')).toBe('APPROVED SETTINGS\n')
  expect(t0.reverted.map((entry) => entry.rel)).toEqual(['.claude/settings.json'])
})

test('I2 closure: saved rule retains selected original text and timestamp', () => {
  const e = env('i2-metadata')
  const state = init(e)
  const raw = '  Use concise sentences.  \n'
  const timestamp = 123456
  const out = S.applyRuleChange({
    ...e,
    state,
    action: 'add',
    mutate: (baseline) => R.addRuleToContent(baseline, raw, { messageId: 'msg:selected', timestamp })
  })
  expect(out.success).toBe(true)
  const saved = S.loadState(e.userData, e.folderHash, key).state
  expect(saved.rules[0].normalized).toBe('Use concise sentences.')
  expect({ message: saved.rules[0].message, timestamp: saved.rules[0].timestamp }).toEqual({ message: raw, timestamp })
  expect(saved.rules[0].messageId).toBe('msg:selected')
})

test('I2 closure: T0 accepted file and rules table describe the same version', () => {
  const e = env('i2-t0-table')
  const state = init(e)
  state.queryOpen = false
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), I.serializeRulesSection([{ normalized: 'Student rule.' }]) + '\n')
  const t0 = C.evaluateT0({ ...e, state, scan: scanOf(e) })
  expect(t0.state.injected).toBe(S.hashContent(readFileSync(join(e.rootReal, 'CLAUDE.md'))))
  expect(t0.state.rules.map((x) => x.normalized)).toEqual(['Student rule.'])
  // 파일에 직접 쓴 규칙의 출처는 `file`이다(§16.5.4 ⓒ).
  expect(t0.state.rules[0].origin).toBe('file')
})

// ── 3회째 남은 지적(C3·I1)의 닫힘 시험 (§16.5.5 9~11) ────────────────────────
// 아래 다섯 건은 `review-share/2026-11-11-v063-guard-stage1-fix2/r3-evidence/closure-fix2.mjs`
// 를 **이름 그대로** 옮긴 것이다(앞의 C3 1건은 그중 실패한 1건). 거기서 쓰던
// `acceptedLeaves` + `acceptedHashes` 꼴은 지문 필수가 아니었기에 `accepted: {rel, hash}[]`
// 하나로 바뀌었다 — 실패하던 두 건도 같은 `accepted: recovery.accepted` 꼴로 적는다.
// 뒤의 두 건(⑬)은 `applyRuleChange`가 H를 어떻게 다루는지 잠근다.

/** T2 되돌리기가 실패해 H로 남은 상태(디스크는 거절했던 글, 보관본은 F 그대로). */
function heldByFailedT2(e: Env): { state: S.GuardState; originalHash: string } {
  const state = init(e)
  const originalHash = state.injected as string
  unlinkSync(join(S.blobsDir(e.userData, e.folderHash), originalHash))
  writeFileSync(join(e.rootReal, '.knuaf-gui'), 'ordinary file blocks quarantine')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const out = C.evaluateT2({ ...e, state, scan: scanOf(e), now: 100 })
  expect(out.state.injected).toBe(null)
  expect(out.reverted[0].reverted).toBe(false)
  expect(out.state.held['CLAUDE.md']).toBeDefined()
  expect(S.saveState(e.userData, e.folderHash, out.state, key)).toBe(true)
  return { state: S.loadState(e.userData, e.folderHash, key).state, originalHash }
}

test('C3: held CLAUDE.md may not be promoted by app rule write after failed T2', () => {
  const e = env('c3-app-write')
  const { state, originalHash } = heldByFailedT2(e)
  const out = S.applyRuleChange({
    ...e,
    state,
    action: 'add',
    now: 200,
    mutate: (baseline) => R.addRuleToContent(baseline, 'Student selected rule.', { timestamp: 200, messageId: 'msg:student' })
  })
  const saved = S.loadState(e.userData, e.folderHash, key).state
  const next = C.evaluateT0({ ...e, state: saved, scan: scanOf(e), now: 300 })
  // 실패했다면 아무것도 쓰이지 않았어야 한다 — 보관본·상태·쪽지 모두 그대로.
  expect(out.success).toBe(false)
  expect(out.message).toBe('설정 파일을 아직 정리하지 못해 지금은 저장할 수 없어요.')
  expect(saved.leaves['CLAUDE.md'].hash).toBe(originalHash)
  expect(saved.injected).toBe(null)
  expect(saved.held['CLAUDE.md']).toBeDefined()
  expect(saved.rules).toEqual([])
  expect(S.getBlob(e.userData, e.folderHash, originalHash)).toBe(null)
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('UNAPPROVED\n')
  // 거절했던 글이 보관본이 되어 다음 T0의 기준이 되어서는 안 된다(3회째 C3).
  expect(next.state.injected).toBe(null)
})

test('⑬ — 되돌림이 되는 H는 앱 저장이 ⑦과 같이 풀고, 거절했던 글은 규칙이 되지 않는다', () => {
  const e = env('13-release')
  const state = init(e)
  const originalHash = state.injected as string
  // T2가 되돌리지 못해 H가 된 모양을 그대로 만든다(디스크만 거절 글, 되돌릴 보관본은 있다).
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const held: S.GuardState = {
    ...state,
    injected: null,
    held: { 'CLAUDE.md': { hash: S.hashContent('UNAPPROVED\n'), since: 1, tries: 1 } }
  }
  expect(S.saveState(e.userData, e.folderHash, held, key)).toBe(true)

  const out = S.applyRuleChange({
    ...e,
    state: S.loadState(e.userData, e.folderHash, key).state,
    action: 'add',
    now: 200,
    mutate: (baseline) => R.addRuleToContent(baseline, 'Student selected rule.', { timestamp: 200, messageId: 'msg:student' })
  })
  expect(out.success).toBe(true)
  const saved = S.loadState(e.userData, e.folderHash, key).state
  // F로 되돌린 뒤 얹었다 — 거절 글은 어디에도 없다.
  expect(saved.held).toEqual({})
  expect(saved.injected).toBe(S.hashContent(out.newContent))
  expect(out.newContent).not.toContain('UNAPPROVED')
  expect(out.newContent).toContain('APPROVED')
  expect(out.newContent).toContain('Student selected rule.')
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe(out.newContent)
  expect(saved.rules.map((entry) => entry.normalized)).toEqual(['Student selected rule.'])
  expect(saved.leaves['CLAUDE.md'].hash).toBe(saved.injected)
  expect(saved.injected).not.toBe(originalHash) // F에 규칙이 얹혔으니 새 지문이다.
})

/** Roh r3 `recoveryFourth` 그대로 — 수용 집합은 학생이 고친 `CLAUDE.md` 하나뿐이어야 한다. */
function recoveryFourth(e: Env): S.RecoveryOutcome {
  const state = init(e, true)
  expect(S.writePending(e.userData, e.folderHash, { action: 'add', previousHash: state.injected, nextHash: S.hashContent('PENDING\n'), at: 1 }, key)).toBe(true)
  writeFileSync(join(e.rootReal, '.claude/settings.json'), 'UNAPPROVED SETTINGS\n')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'STUDENT AFTER CRASH\n')
  const recovery = S.recoverPending({ ...e, state })
  expect(recovery.accepted).toEqual([{ rel: 'CLAUDE.md', hash: S.hashContent('STUDENT AFTER CRASH\n') }])
  expect(recovery.state.queryOpen).toBe(true)
  return recovery
}

// Roh 원본은 이 두 건을 `acceptedLeaves`(지문 없음) 대 `acceptedLeaves`+`acceptedHashes`(지문 있음)
// 로 갈랐다. 이제 수용 항목이 지문을 **필수로** 들고 있어(`accepted: {rel, hash}[]`) 두 건의 호출
// 꼴이 같아졌다 — 남는 차이는 무엇을 함께 확인하는가다(아래 주석). 지문 없는 꼴 자체는 다음
// 시험이 타입 오류로 잠근다.
test('I1: acceptance without the recovered hash must fail closed after disk changes again', () => {
  const e = env('i1-missing-hash')
  const recovery = recoveryFourth(e)
  // 수용한 뒤 디스크가 또 바뀌었다 — 수용 당시 지문과 다르므로 ④가 아니라 ③이어야 한다.
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'SECOND UNAPPROVED CHANGE\n')
  // 「지문 없이 잎 이름만」 넘기는 꼴은 이제 타입이 막는다(아래 타입 시험). 그 꼴이 런타임에
  // 뜻했던 것 — **아무 수용 근거도 없음** — 을 그대로 넣어 확인한다: 수용 집합이 비면 ③이다.
  const t0 = C.evaluateT0({ ...e, state: recovery.state, accepted: [], scan: scanOf(e) })
  expect(t0.accepted).toEqual([])
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('APPROVED\n')
  // 되돌린 결과가 다시 F다 — 다음 T0의 기준이 거절 글에 오염되지 않는다.
  expect(t0.state.injected).toBe(S.hashContent('APPROVED\n'))
  expect(t0.reverted.map((entry) => entry.rel)).toContain('CLAUDE.md')
})

test('I1 control: recovered hash prevents a later disk change from being accepted', () => {
  const e = env('i1-with-hash')
  const recovery = recoveryFourth(e)
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'SECOND UNAPPROVED CHANGE\n')
  const t0 = C.evaluateT0({ ...e, state: recovery.state, accepted: recovery.accepted, scan: scanOf(e) })
  expect(t0.accepted).toEqual([])
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('APPROVED\n')
  // 수용 집합이 `CLAUDE.md` 하나뿐이라 다른 보호 잎은 같은 질의에서 되돌려진다(2회째 I1).
  expect(readFileSync(join(e.rootReal, '.claude/settings.json'), 'utf8')).toBe('APPROVED SETTINGS\n')
  // 디스크가 또 바뀐 `CLAUDE.md`도 함께 ③으로 되돌린다 — 되돌림 목록에 둘 다 있다.
  expect(t0.reverted.map((entry) => entry.rel).sort()).toEqual(['.claude/settings.json', 'CLAUDE.md'])
})

test('I1: 수용 집합에 지문이 빠진 호출은 타입 오류다', () => {
  // e2e는 `tsconfig.node.json`(`src/main`·`src/preload`·`src/shared`)도 `tsconfig.web.json`도
  // 검사하지 않는다 → `pnpm typecheck`이 이 꼴을 잡아 주지 않는다. 그래서 여기서 타입 검사기를
  // 직접 돌려 §16.5.3의 '지문 필수'가 타입으로 강제되는지 잠근다(`typescript`는 devDependency,
  // `e2e/review-baseline.spec.ts`가 이미 `ts`를 쓴다). 실제 파일은 만들지 않는다(메모리 호스트).
  const virtual = resolve('e2e/__guard-type-probe__.ts')
  const header = [
    "import * as C from '../src/main/guard/reconcile'",
    "import type { GuardState } from '../src/main/guard/store'",
    "import type { ScanResult } from '../src/main/guard/scan'",
    'declare const state: GuardState',
    'declare const scan: ScanResult',
    'declare const env: { rootReal: string; userData: string; folderHash: string }'
  ].join('\n')
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    lib: ['lib.es2024.d.ts']
  }
  const diagnose = (body: string): string[] => {
    const source = `${header}\n${body}\n`
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      resolve(name) === virtual ? ts.createSourceFile(name, source, languageVersion, true) : getSourceFile(name, languageVersion, onError, shouldCreate)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (name) => (resolve(name) === virtual ? true : fileExists(name))
    return ts
      .getPreEmitDiagnostics(ts.createProgram([virtual], options, host))
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
  }
  // 잎 이름만 넘기던 옛 꼴 — 받아들여지면 안 된다.
  const legacy = diagnose("void C.evaluateT0({ ...env, state, scan, acceptedLeaves: ['CLAUDE.md'] })")
  expect(legacy.some((message) => message.includes("'acceptedLeaves' does not exist"))).toBe(true)
  // 잎 이름이 `CLAUDE.md`가 아니어도 안 된다 — 쪽지가 생기는 잎은 하나뿐이다.
  const wrongLeaf = diagnose("void C.evaluateT0({ ...env, state, scan, accepted: [{ rel: '.claude/settings.json', hash: 'x' }] })")
  expect(wrongLeaf.some((message) => message.includes('is not assignable to type'))).toBe(true)
  // 지문이 있는 지금 꼴은 통과해야 한다(위 검사기가 실제로 이 파일을 보고 있다는 대조).
  expect(diagnose("void C.evaluateT0({ ...env, state, scan, accepted: [{ rel: 'CLAUDE.md', hash: 'x' }] })")).toEqual([])
})

test('I2: recovery ② preserves authenticated original text, message id, and timestamp', () => {
  const e = env('i2-recovery-metadata')
  const state = init(e)
  const raw = '  Keep this exact original.  \n'
  const change = R.addRuleToContent('APPROVED\n', raw, { timestamp: 123456, messageId: 'msg:original' })
  const nextHash = S.hashContent(change.newContent)
  // 쪽지에 적히는 꼴은 저장 시각이 반드시 있는 모양이다 — 좁히는 자리는 `pendingRuleFrom` 하나뿐이다.
  const note = S.pendingRuleFrom(change.rule, 789)
  expect(S.writePending(e.userData, e.folderHash, { action: 'add', previousHash: state.injected, nextHash, at: 789, ...(note ? { rule: note } : {}) }, key)).toBe(true)
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), change.newContent)
  const out = S.recoverPending({ ...e, state, now: 999 })
  expect(out.success).toBe(true)
  expect({ message: out.state.rules[0].message, messageId: out.state.rules[0].messageId, timestamp: out.state.rules[0].timestamp }).toEqual({
    message: raw,
    messageId: 'msg:original',
    timestamp: 123456
  })
  expect(out.state.injected).toBe(nextHash)
  expect(out.state.queryOpen).toBe(true)
})

test('I2: first adoption, update, preserved metadata, and deletion use the matching rules table', () => {
  const e = env('i2-t0-table-r3')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), I.serializeRulesSection([{ normalized: 'Student first rule.' }]))
  let state = C.evaluateT0({ ...e, state: S.defaultState(), scan: scanOf(e), now: 1000 }).state
  expect(state.rules.map((entry) => ({ text: entry.message, timestamp: entry.timestamp, origin: entry.origin }))).toEqual([
    { text: 'Student first rule.', timestamp: 1000, origin: 'file' }
  ])
  state.queryOpen = false
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), I.serializeRulesSection([{ normalized: 'Student first rule.' }, { normalized: 'Student second rule.' }]))
  state = C.evaluateT0({ ...e, state, scan: scanOf(e), now: 2000 }).state
  expect(state.rules.map((entry) => entry.timestamp)).toEqual([1000, 2000])
  state.queryOpen = false
  unlinkSync(join(e.rootReal, 'CLAUDE.md'))
  state = C.evaluateT0({ ...e, state, scan: scanOf(e), now: 3000 }).state
  expect(state.injected).toBe(null)
  expect(state.rules).toEqual([])
})

// ── 전이표 ①~⑫ (잎 하나) ────────────────────────────────────────────────────

/** 기대하는 넣는 판 — `stored`/`disk`는 그 글자의 지문, `null`은 넣지 않음. */
type Injected = 'stored' | 'disk' | null

interface Row {
  n: string
  title: string
  /** 보호 잎의 상대 경로 */
  leaf?: string
  /** 보관본 F — null이면 "항목 없음" */
  stored: string | null
  /** 지금 디스크 — null이면 "없음" */
  disk: string | null
  /** 처리 전에 H였는가 */
  held?: boolean
  queryOpen: boolean
  phase: 'T0' | 'T2'
  trusted?: boolean
  /** 복구 ④의 수용 집합에 넣는가 */
  accepted?: boolean
  /** 수용 집합의 지문을 일부러 틀리게 넘기는가 */
  acceptedHashMismatch?: boolean
  /** 되돌리기가 실패하도록 F의 blob을 지운다 */
  revertFails?: boolean
  /** 격리도 막는다(`.knuaf-gui`를 일반 파일로) — Roh 재현 A와 같은 조건 */
  blockQuarantine?: boolean
  integrity?: 'mismatch' | 'no-key'
  /** 상태 파일 없이(defaultState) 시작하는가 — ⑫ */
  fresh?: boolean
  expect: {
    /** S = 보관본 항목이 F(또는 항목 유지), H = held에 남음 */
    state: 'S' | 'H'
    disk: string | null
    injected: Injected
    accepted?: string[]
    kept?: string[]
    reverted: number
    /** `CLAUDE.md`가 아니면 항상 null */
    rulesEmpty?: boolean
    /** H로 남았을 때의 시도 횟수 */
    tries?: number
  }
}

const DEFAULT_LEAF = 'CLAUDE.md'

const rows: Row[] = [
  {
    n: '①',
    title: 'S·디스크 = F → 아무것도 하지 않는다',
    stored: 'A\n',
    disk: 'A\n',
    queryOpen: false,
    phase: 'T0',
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 0 }
  },
  {
    n: '②',
    title: 'S·디스크 ≠ F·질의 밖 → 수용하고 보관본에 올린다',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: false,
    phase: 'T0',
    expect: { state: 'S', disk: 'B\n', injected: 'disk', accepted: ['CLAUDE.md'], reverted: 0 }
  },
  {
    n: '③',
    title: 'S·디스크 ≠ F·질의 열림·수용 집합 아님 → 되돌린다',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: true,
    phase: 'T0',
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 1 }
  },
  {
    n: '④',
    title: 'S·질의 열림·수용 집합이고 지문 일치 → ②와 같이 수용',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: true,
    phase: 'T0',
    accepted: true,
    expect: { state: 'S', disk: 'B\n', injected: 'disk', accepted: ['CLAUDE.md'], reverted: 0 }
  },
  {
    n: '④-지문불일치',
    title: 'S·수용 집합이지만 지문이 다르면 ④가 아니라 ③',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: true,
    phase: 'T0',
    accepted: true,
    acceptedHashMismatch: true,
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 1 }
  },
  {
    n: '⑤',
    title: 'S·카드로 허락된 질의 안 변경(T2) → 수용',
    leaf: '.claude/settings.json',
    stored: '{"v":1}',
    disk: '{"v":2}',
    queryOpen: true,
    phase: 'T2',
    trusted: true,
    expect: { state: 'S', disk: '{"v":2}', injected: null, accepted: [], kept: ['.claude/settings.json'], reverted: 0 }
  },
  {
    n: '⑥',
    title: 'S·허락 안 된 질의 안 변경(T2) → 되돌린다',
    leaf: '.claude/settings.json',
    stored: '{"v":1}',
    disk: '{"v":2}',
    queryOpen: true,
    phase: 'T2',
    expect: { state: 'S', disk: '{"v":1}', injected: null, accepted: [], kept: [], reverted: 1 }
  },
  {
    n: '⑥-루트CLAUDE.md',
    title: '루트 CLAUDE.md는 카드로 허락돼도 T2가 되돌린다',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: true,
    phase: 'T2',
    trusted: true,
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], kept: [], reverted: 1 }
  },
  {
    n: '⑦',
    title: 'H는 카드 허락·수용 집합·질의 열림과 무관하게 되돌리기만 다시 한다',
    stored: 'A\n',
    disk: 'B\n',
    held: true,
    queryOpen: true,
    phase: 'T2',
    trusted: true,
    accepted: true,
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], kept: [], reverted: 1 }
  },
  {
    n: '⑦-실패',
    title: 'H의 재시도도 실패하면 H 유지·시도 횟수 +1',
    stored: 'A\n',
    disk: 'B\n',
    held: true,
    queryOpen: true,
    phase: 'T0',
    revertFails: true,
    blockQuarantine: true,
    expect: { state: 'H', disk: 'B\n', injected: null, accepted: [], reverted: 1, tries: 2 }
  },
  {
    n: '⑦-질의밖',
    title: 'H는 질의 밖 변경에서도 ②로 수용하지 않고 되돌리기만 한다',
    stored: 'A\n',
    disk: 'B\n',
    held: true,
    queryOpen: false,
    phase: 'T0',
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 1 }
  },
  {
    n: '⑦-수용집합',
    title: 'H는 복구 수용 집합에 들어 있어도 ④로 수용하지 않는다',
    stored: 'A\n',
    disk: 'B\n',
    held: true,
    queryOpen: true,
    phase: 'T0',
    accepted: true,
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 1 }
  },
  {
    n: '⑧',
    title: 'H인데 디스크가 이미 F → 되돌릴 것 없이 보류 해제',
    stored: 'A\n',
    disk: 'A\n',
    held: true,
    queryOpen: true,
    phase: 'T0',
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], reverted: 0 }
  },
  {
    n: '⑨',
    title: '보관본에 항목 없음·디스크 있음(T0 질의 밖) → F="없음"으로 놓고 수용',
    leaf: '.claude/settings.json',
    stored: null,
    disk: '{"v":9}',
    queryOpen: false,
    phase: 'T0',
    expect: { state: 'S', disk: '{"v":9}', injected: null, accepted: ['.claude/settings.json'], reverted: 0 }
  },
  {
    n: '⑨-되돌림',
    title: '보관본에 항목 없음·디스크 있음(T2 허락 없음) → F="없음"이므로 지운다',
    leaf: '.claude/settings.json',
    stored: null,
    disk: '{"v":9}',
    queryOpen: true,
    phase: 'T2',
    expect: { state: 'S', disk: null, injected: null, accepted: [], kept: [], reverted: 1 }
  },
  {
    n: '⑩-수용',
    title: 'S·디스크에 없음(T0 질의 밖) → 삭제를 수용하고 CLAUDE.md면 규칙 표도 빈다',
    stored: 'A\n',
    disk: null,
    queryOpen: false,
    phase: 'T0',
    expect: { state: 'S', disk: null, injected: null, accepted: ['CLAUDE.md'], reverted: 0, rulesEmpty: true }
  },
  {
    n: '⑩-되돌림',
    title: 'S·디스크에 없음(T2 허락 없음) → F를 복원한다',
    stored: 'A\n',
    disk: null,
    queryOpen: true,
    phase: 'T2',
    expect: { state: 'S', disk: 'A\n', injected: 'stored', accepted: [], kept: [], reverted: 1 }
  },
  {
    n: '⑪',
    title: '무결성 불일치 → 전이 없음, 아무것도 쓰지 않는다',
    stored: 'A\n',
    disk: 'B\n',
    queryOpen: false,
    phase: 'T0',
    integrity: 'mismatch',
    expect: { state: 'S', disk: 'B\n', injected: 'stored', accepted: [], reverted: 0 }
  },
  {
    n: '⑫',
    title: '상태 파일 없음·열쇠 있음·첫 열기(T0) → 있는 잎 전부 수용, 질의 열림',
    stored: null,
    disk: 'B\n',
    queryOpen: false,
    phase: 'T0',
    fresh: true,
    expect: { state: 'S', disk: 'B\n', injected: 'disk', accepted: ['CLAUDE.md'], reverted: 0 }
  }
]

interface RowBox extends Env {
  leaf: string
  state: S.GuardState
  storedHash: string | null
  storedPrint: Scan.LeafFingerprint | null
  diskHash: string | null
}

function buildBox(row: Row): RowBox {
  const e = env(`table-${row.n}`)
  const leaf = row.leaf ?? DEFAULT_LEAF
  const abs = join(e.rootReal, leaf)
  mkdirSync(join(abs, '..'), { recursive: true })

  // 디스크에 F를 먼저 쓰고 보관본에 올린다(항목이 "있는" 상태를 만들려면 그것이 필요하다).
  let storedHash: string | null = null
  let storedPrint: Scan.LeafFingerprint | null = null
  if (row.stored !== null) {
    writeFileSync(abs, row.stored)
    const adopted = S.adoptLeaves(e.rootReal, e.userData, e.folderHash, scanOf(e).leaves)
    storedPrint = adopted.leaves[leaf]
    storedHash = storedPrint.hash
    if (row.revertFails) unlinkSync(join(S.blobsDir(e.userData, e.folderHash), storedHash))
  }

  if (row.blockQuarantine) writeFileSync(join(e.rootReal, '.knuaf-gui'), 'ordinary file blocks quarantine')

  // 지금 디스크.
  if (row.disk === null) {
    try { unlinkSync(abs) } catch { /* 이미 없음 */ }
  } else {
    writeFileSync(abs, row.disk)
  }

  let state = S.defaultState()
  if (!row.fresh) {
    state.leaves = storedPrint === null ? {} : { [leaf]: storedPrint }
    state.injected = leaf === DEFAULT_LEAF && storedPrint !== null ? storedHash : null
    state.queryOpen = row.queryOpen
    if (row.held) state.held = { [leaf]: { hash: S.hashContent(row.disk ?? ''), since: 1, tries: 1 } }
    expect(S.saveState(e.userData, e.folderHash, state, key)).toBe(true)
    state = S.loadState(e.userData, e.folderHash, key).state
  }

  return {
    ...e,
    leaf,
    state,
    storedHash,
    storedPrint,
    diskHash: row.disk === null ? null : S.hashContent(row.disk)
  }
}

function expectedInjected(box: RowBox, row: Row): string | null {
  if (row.expect.injected === 'stored') return box.storedHash
  if (row.expect.injected === 'disk') return box.diskHash
  return null
}

for (const row of rows) {
  test(`전이표 ${row.n}: ${row.title}`, () => {
    const box = buildBox(row)
    const scan = scanOf(box)
    const leaf = box.leaf

    // 지문은 수용 항목의 **필수** 짝이다(§16.5.3) — 잎 이름만 넘기는 옛 꼴은 타입에서 없다.
    const accepted: S.AcceptedLeaf[] | undefined = row.accepted
      ? [{
          rel: 'CLAUDE.md',
          hash: row.acceptedHashMismatch ? S.hashContent('SOMETHING ELSE\n') : (box.diskHash as string)
        }]
      : undefined

    const result =
      row.phase === 'T0'
        ? C.evaluateT0({
            rootReal: box.rootReal,
            userData: box.userData,
            folderHash: box.folderHash,
            state: box.state,
            scan,
            ...(accepted ? { accepted } : {}),
            ...(row.integrity ? { integrity: row.integrity } : {})
          })
        : C.evaluateT2({
            rootReal: box.rootReal,
            userData: box.userData,
            folderHash: box.folderHash,
            state: box.state,
            scan,
            trusted: () => row.trusted === true,
            ...(row.integrity ? { integrity: row.integrity } : {})
          })

    // 다음 상태.
    expect(Boolean(result.state.held[leaf])).toBe(row.expect.state === 'H')
    if (row.expect.tries !== undefined) expect(result.state.held[leaf]?.tries).toBe(row.expect.tries)
    // 디스크.
    const diskNow = existsSync(join(box.rootReal, leaf)) ? readFileSync(join(box.rootReal, leaf), 'utf8') : null
    expect(diskNow).toBe(row.expect.disk)
    // 넣는 판.
    expect(result.state.injected).toBe(expectedInjected(box, row))
    // 규칙 표.
    if (row.expect.rulesEmpty) expect(result.state.rules).toEqual([])

    if (row.phase === 'T0') {
      const t0 = result as C.T0Result
      expect(t0.accepted).toEqual(row.expect.accepted ?? [])
      expect(t0.reverted.length).toBe(row.expect.reverted)
      // ⑫ — 첫 열기는 질의를 연다. ⑪은 상태를 그대로 둔다(질의 표식도 건드리지 않는다).
      if (row.n === '⑫') expect(t0.state.queryOpen).toBe(true)
      if (row.integrity) {
        // ⑪ — 아무것도 쓰지 않는다: 상태가 호출 전과 같다.
        expect(t0.state.leaves).toEqual(box.state.leaves)
        expect(t0.state.held).toEqual(box.state.held)
      }
    } else {
      const t2 = result as C.T2Result
      expect(t2.kept).toEqual(row.expect.kept ?? [])
      expect(t2.reverted.length).toBe(row.expect.reverted)
      // T2는 언제나 질의를 닫는다(⑪ 제외).
      if (!row.integrity) expect(t2.state.queryOpen).toBe(false)
    }
  })
}

test('전이표 ⑪: 열쇠가 없으면 T0도 T2도 전이하지 않는다', () => {
  const e = env('table-no-key')
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'APPROVED\n')
  const state: S.GuardState = { ...S.defaultState(), queryOpen: false }
  writeFileSync(join(e.rootReal, 'CLAUDE.md'), 'UNAPPROVED\n')
  const t0 = C.evaluateT0({ ...e, state, scan: scanOf(e), integrity: 'no-key' })
  expect(t0.accepted).toEqual([])
  expect(t0.reverted).toEqual([])
  expect(t0.state.leaves).toEqual({})
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('UNAPPROVED\n')
  const t2 = C.evaluateT2({ ...e, state, scan: scanOf(e), integrity: 'no-key' })
  expect(t2.kept).toEqual([])
  expect(t2.reverted).toEqual([])
  expect(readFileSync(join(e.rootReal, 'CLAUDE.md'), 'utf8')).toBe('UNAPPROVED\n')
})

test('전이표 ⑦: 보류 알림은 앱 실행마다 한 번만 난다', () => {
  const e = env('table-held-note')
  const leaf = '.claude/settings.json'
  mkdirSync(join(e.rootReal, '.claude'))
  writeFileSync(join(e.rootReal, leaf), '{"v":1}')
  const adopted = S.adoptLeaves(e.rootReal, e.userData, e.folderHash, scanOf(e).leaves)
  const storedHash = adopted.leaves[leaf].hash
  unlinkSync(join(S.blobsDir(e.userData, e.folderHash), storedHash))
  const state: S.GuardState = {
    ...S.defaultState(),
    leaves: { [leaf]: { kind: 'file', hash: storedHash, executable: false } },
    queryOpen: true,
    held: { [leaf]: { hash: S.hashContent('{"v":2}'), since: 777, tries: 1 } }
  }
  writeFileSync(join(e.rootReal, leaf), '{"v":2}')

  const first = C.evaluateT2({ rootReal: e.rootReal, userData: e.userData, folderHash: e.folderHash, state, scan: scanOf(e) })
  const second = C.evaluateT2({ rootReal: e.rootReal, userData: e.userData, folderHash: e.folderHash, state: first.state, scan: scanOf(e) })
  const heldNotes = (notes: string[]): string[] => notes.filter((note) => note.includes('아직 정리하지 못했어요'))
  expect(heldNotes(first.notes).length).toBe(1)
  expect(heldNotes(second.notes).length).toBe(0)
  // 두 번째도 되돌리기 재시도는 한다(시도 횟수 +1).
  expect(second.state.held[leaf].tries).toBe(3)
})

// ── 상태 파일 판 올리기(v1 → v2, §4.3) ───────────────────────────────────────
// v2에서 상태 파일에 `codexThreads`가 들어왔고 표식이 그 칸까지 덮는다.
// 옛 파일은 그 칸 없이 서명됐으므로, 표식을 그대로 대조하면 **모든 옛 보관본이 '불일치'**가 되어
// 지킴이가 조용히 꺼진다. 그래서 없는 칸만 빼고 다시 대조하는 길을 두되, 칸을 얹은 파일은 거절한다.

/** v1 파일 그대로 — `codexThreads` 칸이 없고 표식도 그 칸을 모른 채 계산됐다. */
function writeV1State(e: Env, graftThreads: boolean): void {
  const body: Record<string, unknown> = {
    version: 1, leaves: {}, injected: null, rules: [], queryOpen: false, held: {}
  }
  const hmac = S.computeIntegrity(body as Omit<S.GuardState, 'integrity'>, e.key)
  // 칸을 얹는 판은 표식을 **v1 방식으로** 계산한다 — 즉 얹은 칸은 서명 밖이다.
  if (graftThreads) body.codexThreads = { sneaked: { fingerprint: 'forged', turns: [] } }
  body.integrity = hmac
  mkdirSync(S.guardDir(e.userData, e.folderHash), { recursive: true })
  writeFileSync(S.statePath(e.userData, e.folderHash), JSON.stringify(body, null, 2))
}

test('상태 판 올림: 옛 v1 파일은 표식이 맞으면 지금 판으로 읽고, 장부는 빈 채로 시작한다', () => {
  const e = env('state-v1')
  writeV1State(e, false)
  const loaded = S.loadState(e.userData, e.folderHash, e.key)
  // 표식이 살아 있어야 지킴이가 켜진 채로 올라온다(불일치면 주입이 꺼진다).
  expect(loaded.integrity).toBe('ok')
  expect(loaded.state.version).toBe(S.STATE_VERSION)
  expect(loaded.state.codexThreads).toEqual({})
  expect(S.injectionsEnabled(loaded.integrity, true)).toBe(true)
})

test('상태 판 올림: 옛 파일을 올린 뒤 저장한 장부 줄은 다시 읽힌다', () => {
  const e = env('state-v1-roundtrip')
  writeV1State(e, false)
  const store: S.ThreadStore = { userData: e.userData, folderHash: e.folderHash, key: e.key }
  expect(S.saveCodexThreads(store, () => ({ 'th-1': S.codexThreadRow('fp-1', ['t-2', 't-1', 't-2']) }))).toBe(true)
  // 파일 자체도 지금 판이 됐다 — 다음 실행은 옛 판 길을 다시 탈 필요가 없다.
  const onDisk = JSON.parse(readFileSync(S.statePath(e.userData, e.folderHash), 'utf-8')) as { version: number }
  expect(onDisk.version).toBe(S.STATE_VERSION)
  expect(S.loadCodexThreads(store)).toEqual({ 'th-1': { fingerprint: 'fp-1', turns: ['t-1', 't-2'] } })
})

test('상태 판 올림: 판만 1로 적고 장부 칸을 얹은 파일은 서명 밖이므로 불일치로 읽는다', () => {
  const e = env('state-v1-grafted')
  writeV1State(e, true)
  const loaded = S.loadState(e.userData, e.folderHash, e.key)
  expect(loaded.integrity).toBe('mismatch')
  expect(S.loadCodexThreads({ userData: e.userData, folderHash: e.folderHash, key: e.key })).toEqual({})
})
