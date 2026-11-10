// §16.5 — Roh 2회째 남은 지적(C3·I1·I2)의 닫힘 시험 + 전이표 ①~⑫.
// 앞 4건은 `review-share/2026-11-10-v063-guard-stage1-fix/R2/guard-stage1-fix-evidence/closure-regression.mjs`
// 의 실패 4건을 **이름 그대로** 옮긴 것이다(§16.5.6). 뒤는 §16.5.2 표를 잎 하나짜리 표 주도 시험으로 잠근다.
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  expect(recovery.acceptedLeaves).toEqual(['CLAUDE.md'])
  expect(recovery.state.queryOpen).toBe(true)
  const t0 = C.evaluateT0({ ...e, state: recovery.state, acceptedLeaves: recovery.acceptedLeaves, scan: scanOf(e) })
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

    const acceptedHashes: Record<string, string> | undefined = row.accepted
      ? { [leaf]: row.acceptedHashMismatch ? S.hashContent('SOMETHING ELSE\n') : (box.diskHash as string) }
      : undefined
    const acceptedLeaves = row.accepted ? [leaf] : []

    const result =
      row.phase === 'T0'
        ? C.evaluateT0({
            rootReal: box.rootReal,
            userData: box.userData,
            folderHash: box.folderHash,
            state: box.state,
            scan,
            acceptedLeaves,
            ...(acceptedHashes ? { acceptedHashes } : {}),
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
    leaves: { [leaf]: { kind: 'file', hash: storedHash } },
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
