/**
 * v0.7.3 '못 읽은 규칙집 상태는 끝까지 모름' — 1단계 시험(설계 DESIGN-v2.md v2.3 §5, 판정서 REVIEW-VERDICT-design-v23.md).
 *
 * 두 묶음이다.
 * - `EQ …`  : 읽기가 성공하는 경로. **기준판(a340264)에서 통과해야 하고 고친 뒤에도 그대로** 통과해야 한다(조건②).
 * - `R-…`   : 못 읽음 경로. **기준판에서 실패해야 한다** — 실패 자리는 각 시험의 "기준판" 주석에 적은 단언이다.
 *
 * 주입은 `skill-unknown-harness.ts`의 `node:fs` 대역(소스 무변경). 자리는 함수 이름으로 겨냥한다:
 * `store` = 서비스가 직접 부른 바깥 `SkillStore.*` 메서드, `svc` = 안쪽 `SkillUpdates.*` 메서드.
 * 고친 판이 엄격 읽기(`strict`·`effStrict`·`stateDetail`·`validStrict`·`check`)를 더해도 같은 자리를 맞히도록
 * 이름 패턴에 그 이름들을 미리 넣었다(설계 §3.2 S1~S16).
 *
 * 동시성 시험은 sleep·시간 대기 없이 문(gate)과 잠금 진입 신호로만 순서를 고정한다(설계 §5.0 H-LOCK·H-FETCH·H-RESTART).
 */
import { expect, test } from '@playwright/test'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, inject, makeDisk, makeUpdater, gate, CountingSwitch, normalize, observeDisk, outcome, realFs, skillDiag, sweep, treePrint, type Disk, type DiskSpec, type Rule } from './skill-unknown-harness'

const roots: string[] = []
const disk = (spec: DiskSpec = {}): Disk => { const d = makeDisk(spec); roots.push(d.root); return d }
let previousLog: string | undefined
test.beforeEach(() => { inject.clear(); previousLog = process.env.KNUAF_APP_LOG })
test.afterEach(() => {
  inject.clear()
  if (previousLog === undefined) delete process.env.KNUAF_APP_LOG; else process.env.KNUAF_APP_LOG = previousLog
  sweep(roots)
})

const UNKNOWN = /읽지 못/
const EPERM = 'EPERM'
const ALWAYS = Number.MAX_SAFE_INTEGER

// 바깥 store 진입점 이름 — 기준판 이름 + 고친 판이 더할 엄격 덮개 이름.
const RESOLVE = /^(resolveSkillSource|resolve|effStrict)$/
const READ_STATE = /^(state|strict|stateDetail)$/
const EFFECTIVE = /^(resolveSkillSource|resolve|effStrict|state|strict|stateDetail)$/

/** 시험이 주입한 규칙이 실제로 닿았는지 — 조용히 빗나간 주입을 통과로 치지 않는다. */
function fired(...list: Rule[]): void { for (const rule of list) expect(inject.fired(rule), `주입 규칙이 닿지 않았다: ${JSON.stringify({ ...rule, store: String(rule.store), svc: String(rule.svc) })}`).toBeGreaterThan(0) }

/** state.json 쓰기(원자 쓰기의 `.tmp` 쓰기·이름바꾸기) 수. */
const stateWrites = (): number => inject.writes().filter(line => /state\.json(\.tmp)?$/.test(line) && line.startsWith('write:')).length

function restarter(failFirst = false): { restart: () => Promise<void>; count: () => number } {
  let n = 0
  return {
    restart: async () => { ++n; if (failFirst && n === 1) throw new Error('sidecar restart failed') },
    count: () => n
  }
}

/* ═════════════════════════ EQ — 성공 경로 동등성(기준판 통과) ═════════════════════════ */

test('EQ select stored version (E1)', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter()
  const u = makeUpdater({ disk: d, restart: r.restart })
  const status = await u.updates.select('1.0.15')
  expect(d.state().active).toBe('1.0.15')
  expect(status).toMatchObject({ phase: 'ready', current: '1.0.15', bundled: false })
  expect(r.count()).toBe(1)
  expect(u.phases).toEqual(['switching', 'ready'])
})

test('EQ rollback to the lower kept (E3)', async () => {
  const d = disk()
  const r = restarter()
  const u = makeUpdater({ disk: d, restart: r.restart })
  const status = await u.updates.rollback()
  expect(d.state().active).toBe('1.0.14')
  expect(status).toMatchObject({ phase: 'ready', current: '1.0.14', bundled: false })
  expect(r.count()).toBe(1)
})

test('EQ rollback with no lower kept goes to bundle (E4)', async () => {
  const d = disk({ versions: ['1.0.14'], active: '1.0.14' })
  const u = makeUpdater({ disk: d })
  const status = await u.updates.rollback()
  expect(d.state().active).toBeNull()
  expect(d.state().kept).toHaveProperty(['1.0.14'])
  expect(status).toMatchObject({ phase: 'ready', current: '1.0.13', bundled: true })
})

test('EQ rollback with sure-invalid active goes to bundle (E5)', async () => {
  const d = disk()
  d.corrupt('1.0.15')
  const u = makeUpdater({ disk: d })
  await u.updates.rollback()
  // 화면 current는 동봉(.15가 확정 무효) → 아래 보관판 후보 없음 → null.
  expect(d.state().active).toBeNull()
})

test('EQ restart failure with sure-invalid active restores null (E9, Q7)', async () => {
  const d = disk({ active: '1.0.14' })
  d.corrupt('1.0.14')
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  await expect(u.updates.select('1.0.15')).rejects.toThrow('sidecar restart failed')
  expect(d.state().active).toBeNull()
  expect(r.count()).toBe(2)
  expect(u.phases.at(-1)).toBe('error')
})

test('EQ restore of a previous that became invalid throws the baseline error (E19)', async () => {
  const d = disk({ active: '1.0.14' })
  let n = 0
  const u = makeUpdater({ disk: d, restart: async () => { if (++n === 1) { d.corrupt('1.0.14'); throw new Error('sidecar restart failed') } } })
  await expect(u.updates.select('1.0.15')).rejects.toThrow('이 보관판은 사용할 수 없어요.')
  expect(n).toBe(1)
  expect(d.state().active).toBe('1.0.15')
})

test('EQ disposition keeps active in the floor (E17)', async () => {
  const d = disk({ versions: ['1.0.14', '1.0.15'], active: '1.0.15', highest: '1.0.13' })
  const before = d.stateText()
  const u = makeUpdater({ disk: d, candidate: fixture('1.0.14') })
  const status = await u.updates.check()
  expect(status.phase).toBe('error')
  expect(status.message).toMatch(/이전 판/)
  expect(d.stateText()).toBe(before)
})

// 판정서 v2.3 '구현 발주용 실패 시험 입력' 1 — 두 읽기가 모두 **성공**하고 값만 다를 때 기준판은 첫 읽기를 쓴다.
test('EQ status with both reads succeeding keeps the first read (verdict v2.3 input 1)', () => {
  const d = disk({ active: '1.0.14', highest: '1.0.15' })
  const u = makeUpdater({ disk: d })
  const swap: Rule = { op: 'read', name: 'state.json', svc: /^status$/, store: RESOLVE, times: ALWAYS, text: t => t.replace('"active":"1.0.14"', '"active":"1.0.15"') }
  inject.set([swap])
  const status = u.updates.status()
  fired(swap)
  expect(status).toMatchObject({ current: '1.0.14', bundled: false })
})

// 판정서 v2.3 입력 2 — 동봉 manifest를 두 번 읽고, 두 번째만 끝에 공백 하나가 붙은 M′. 기준판은 해시가 달라 거절.
function bundleCandidate(): { spec: DiskSpec; candidate: ReturnType<typeof fixture> } {
  const plain = fixture('1.0.13')
  const manifestBytes = Buffer.from(JSON.stringify({ schema: 'knuaf-doc/install-manifest@1', files: plain.manifest.files }))
  const candidate = fixture('1.0.13', {}, [{ name: 'install-manifest.json', data: manifestBytes }])
  return { spec: { versions: [], kept: [], active: null, highest: null, bundleManifestFiles: plain.manifest.files }, candidate }
}

test('EQ bundle manifest match is kept (R-MB i)', async () => {
  const { spec, candidate } = bundleCandidate()
  const d = disk(spec)
  const u = makeUpdater({ disk: d, candidate })
  const status = await u.updates.check()
  expect(status).toMatchObject({ phase: 'idle', available: null })
})

test('EQ bundle manifest re-read that differs is rejected like baseline (verdict v2.3 input 2)', async () => {
  const { spec, candidate } = bundleCandidate()
  const d = disk(spec)
  const u = makeUpdater({ disk: d, candidate })
  const second: Rule = { op: 'read', name: 'install-manifest.json', skip: 1, times: ALWAYS, text: t => t + ' ', bytes: b => Buffer.concat([b, Buffer.from(' ')]) }
  inject.set([second])
  const status = await u.updates.check()
  fired(second)
  expect(status.phase).toBe('error')
  expect(status.message).toMatch(/이전 판/)
})

/* ═════════════════════════ EQ — 동시성(H-LOCK·H-FETCH·H-RESTART, 기준판 통과) ═════════════════════════ */

test('concurrency: rollback target decided before the lock wait survives an external change (R-C1)', async () => {
  const d = disk()
  const lock = new CountingSwitch()
  const r = restarter()
  const u = makeUpdater({ disk: d, lock, restart: r.restart })
  const release = lock.enter()
  const p = u.updates.rollback()
  expect(lock.switching).toBe(true)
  d.writeState({ active: '1.0.14' })
  release()
  await p
  expect(d.state().active).toBe('1.0.14')
  expect(r.count()).toBe(1)
})

test('concurrency: select previous is read after the wait (R-C3)', async () => {
  const d = disk({ active: '1.0.14' })
  const lock = new CountingSwitch()
  const r = restarter(true)
  const u = makeUpdater({ disk: d, lock, restart: r.restart })
  const release = lock.enter()
  const p = u.updates.select('1.0.15')
  expect(lock.switching).toBe(true)
  d.writeState({ active: '1.0.15' })
  release()
  await expect(p).rejects.toThrow('sidecar restart failed')
  // previous는 대기 뒤 값(.15) — 대기 전 값(.14)으로 되돌리면 앞당긴 변이다.
  expect(d.state().active).toBe('1.0.15')
  expect(r.count()).toBe(2)
})

// 판정서 v2.3 R-C4 대체 입력: 순서 기록으로 단언(lock.switch → release → publish).
test('concurrency: install lock decision is read after the download (R-C4 replacement)', async () => {
  const d = disk({ active: '1.0.14', highest: '1.0.15' })
  d.corrupt('1.0.15')
  const events: string[] = []
  const lock = new CountingSwitch(events)
  const fetchGate = gate()
  const u = makeUpdater({ disk: d, lock, events, fetchGate, candidate: d.versions.get('1.0.15')! })
  expect((await u.updates.check()).phase).toBe('repair')
  const consumer = lock.enter()
  const p = u.updates.install()
  await fetchGate.arrived
  d.writeState({ active: '1.0.15' })
  fetchGate.release()
  await lock.switched
  events.push('release')
  consumer()
  await p
  expect(events).toEqual(['lock.switch', 'release', 'publish'])
  expect(d.state().active).toBe('1.0.15')
})

/* ═════════════════════════ R — 자리 1: state()가 못 읽음을 빈 상태로 접음 ═════════════════════════ */

test('R-B1 activate: previous-read failure refuses instead of restoring null', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^activateLocked$/, store: EFFECTIVE, code: EPERM, times: 1 }
  inject.set([fault])
  inject.mark()
  const p = u.updates.select('1.0.15')
  await p.catch(() => {})
  fired(fault)
  await faultRecord('R-B1', d, { phases: u.phases, restarts: r.count(), thrown: await p.then(() => undefined, e => e) })
  // 기준판: previous를 동봉(null)으로 접어 select(.15) 쓰기 → 재시작 실패 → select(null) 쓰기 → active null.
  expect(d.state().active).toBe('1.0.14')
  expect(stateWrites()).toBe(0)
  expect(r.count()).toBe(0)
  await expect(p).rejects.toThrow(UNKNOWN)
  // 설계 S15: try 앞에서 던지므로 switching을 내보내지 않는다.
  expect(u.phases).not.toContain('switching')
})

test('R-B1b activate: previous-validity failure refuses', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: '1.0.14.json', svc: /^activateLocked$/, store: EFFECTIVE, code: EPERM, times: 1 }
  inject.set([fault])
  inject.mark()
  const p = u.updates.select('1.0.15')
  await p.catch(() => {})
  fired(fault)
  await faultRecord('R-B1b', d, { phases: u.phases, restarts: r.count(), thrown: await p.then(() => undefined, e => e) })
  // 기준판: .14 검증 I/O 실패를 확정 무효로 접어 previous=null → 결국 active null.
  expect(d.state().active).toBe('1.0.14')
  expect(stateWrites()).toBe(0)
  expect(r.count()).toBe(0)
  await expect(p).rejects.toThrow(UNKNOWN)
  // 설계 S15: try 앞에서 던지므로 switching을 내보내지 않는다.
  expect(u.phases).not.toContain('switching')
})

test('R-B1-display activate: display-read failure still restores 1.0.14 (EQ)', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^status$/, store: READ_STATE, code: EPERM, times: 1 }
  inject.set([fault])
  await expect(u.updates.select('1.0.15')).rejects.toThrow('sidecar restart failed')
  fired(fault)
  expect(d.state().active).toBe('1.0.14')
  expect(r.count()).toBe(2)
})

test('R-B2 select: persistent state failure writes nothing and ends in error', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter()
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', store: /^select$/, code: EPERM, times: ALWAYS }
  inject.set([fault])
  inject.mark()
  const p = u.updates.select('1.0.15')
  await p.catch(() => {})
  fired(fault)
  await faultRecord('R-B2', d, { phases: u.phases, restarts: r.count(), thrown: await p.then(() => undefined, e => e) })
  expect(stateWrites()).toBe(0)
  expect(r.count()).toBe(0)
  // 기준판: 빈 상태라 '사용할 수 없어요' → 되돌림도 같은 이유로 던져 phase가 switching에 멈춘다.
  await expect(p).rejects.toThrow(UNKNOWN)
  expect(u.phases.at(-1)).toBe('error')
  inject.clear()
  expect(d.state().active).toBe('1.0.14')
  expect(Object.keys(d.state().kept).sort()).toEqual(['1.0.14', '1.0.15'])
})

test('R-B2b restore: unknown at restore time keeps the requested value and still restarts', async () => {
  const d = disk({ active: '1.0.14' })
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', store: /^select$/, skip: 1, code: EPERM, times: ALWAYS }
  inject.set([fault])
  const p = u.updates.select('1.0.15')
  await p.catch(() => {})
  fired(fault)
  await faultRecord('R-B2b', d, { phases: u.phases, restarts: r.count(), thrown: await p.then(() => undefined, e => e) })
  // 기준판: 되돌림 select(.14)가 빈 상태로 '사용할 수 없어요'를 던져 원래 오류를 대신하고 두 번째 재시작이 없다.
  await expect(p).rejects.toThrow('sidecar restart failed')
  expect(r.count()).toBe(2)
  expect(u.phases.at(-1)).toBe('error')
  inject.clear()
  expect(d.state().active).toBe('1.0.15')
})

test('R-N1 select(null): unreadable state keeps kept', async () => {
  const d = disk()
  const highestBefore = readFileSync(join(d.storeDir, 'highest.json'), 'utf8')
  const u = makeUpdater({ disk: d })
  const fault: Rule = { op: 'read', name: 'state.json', store: /^select$/, code: EPERM, times: ALWAYS }
  inject.set([fault])
  inject.mark()
  await u.updates.select(null).catch(() => {})
  fired(fault)
  await faultRecord('R-N1', d, { phases: u.phases })
  expect(inject.writes()).toEqual([])
  inject.clear()
  expect(readFileSync(join(d.storeDir, 'highest.json'), 'utf8')).toBe(highestBefore)
  // 기준판: 빈 상태 위에 active=null을 써 kept·highest를 잃는다.
  expect(Object.keys(d.state().kept).sort()).toEqual(['1.0.14', '1.0.15'])
  expect(d.state().active).toBe('1.0.15')
})

test('R-N5 status: current is never null when the first read fails', async () => {
  const d = disk()
  const u = makeUpdater({ disk: d })
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^status$/, store: READ_STATE, code: EPERM, times: 1 }
  inject.set([fault])
  const status = u.updates.status()
  fired(fault)
  await faultRecord('R-N5', d, { status })
  // 기준판: 첫 읽기를 빈 상태로 접고 resolver는 .15를 골라 current = s.active! = null.
  expect(status.current).toBe('1.0.15')
  expect(status.bundled).toBe(false)
})

/** 본문은 active null(완성), `.tmp`는 active .14 완성본 — `.tmp`만 읽지 못한다. */
function tmpDisk(): Disk {
  const d = disk({ active: null })
  const value = { ...d.state(), active: '1.0.14' }
  // 대역 규칙이 비어 있는 동안의 파일 접근은 진짜 접근이다.
  writeFileSync(join(d.storeDir, 'state.json.tmp'), JSON.stringify(value))
  return d
}

test('R-B5a activate: unreadable newer tmp refuses', async () => {
  const d = tmpDisk()
  const tmpBefore = readFileSync(join(d.storeDir, 'state.json.tmp'), 'utf8')
  const r = restarter(true)
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json.tmp', code: EPERM, times: ALWAYS }
  inject.set([fault])
  inject.mark()
  const p = u.updates.select('1.0.15')
  await p.catch(() => {})
  fired(fault)
  await faultRecord('R-B5a', d, { phases: u.phases, restarts: r.count(), thrown: await p.then(() => undefined, e => e) })
  expect(stateWrites()).toBe(0)
  inject.clear()
  // 기준판: 본문 null을 previous로 믿고 쓰기를 진행해 `.tmp`(유일한 .14 기록)를 덮는다.
  expect(readFileSync(join(d.storeDir, 'state.json.tmp'), 'utf8')).toBe(tmpBefore)
  await expect(p).rejects.toThrow(UNKNOWN)
})

test('R-B5c cleanup never overwrites an unreadable tmp', async () => {
  const d = tmpDisk()
  const tmpBefore = readFileSync(join(d.storeDir, 'state.json.tmp'), 'utf8')
  const store = d.store()
  const treeBefore = treePrint(d.storeDir), highestBefore = readFileSync(join(d.storeDir, 'highest.json'), 'utf8'), stateBefore = d.stateText()
  const fault: Rule = { op: 'read', name: 'state.json.tmp', code: EPERM, times: ALWAYS }
  inject.set([fault])
  inject.mark()
  let thrown: unknown = null
  try { store.cleanup() } catch (e) { thrown = e }
  fired(fault)
  await faultRecord('R-B5c', d, { thrown: thrown ?? undefined })
  expect(stateWrites()).toBe(0)
  // 삭제·이름바꾸기·쓰기 0, 트리·기록 원형 그대로.
  expect(inject.writes()).toEqual([])
  inject.clear()
  expect(treePrint(d.storeDir)).toEqual(treeBefore)
  expect(d.stateText()).toBe(stateBefore)
  expect(readFileSync(join(d.storeDir, 'highest.json'), 'utf8')).toBe(highestBefore)
  expect(readFileSync(join(d.storeDir, 'state.json.tmp'), 'utf8')).toBe(tmpBefore)
  expect(String(thrown)).toMatch(UNKNOWN)
})

/* ═════════════════════════ R — 자리 2: valid()가 I/O 실패를 false로 접음 ═════════════════════════ */

test('R-N3 rollback: I/O-failed candidate is unknown, not absent', async () => {
  const d = disk()
  const lock = new CountingSwitch()
  const r = restarter()
  const u = makeUpdater({ disk: d, lock, restart: r.restart })
  const fault: Rule = { op: 'read', name: '1.0.14.json', store: /^rollbackTarget$/, code: EPERM, times: ALWAYS }
  inject.set([fault])
  let thrown: unknown = null
  try { await u.updates.rollback() } catch (e) { thrown = e }
  fired(fault)
  await faultRecord('R-N3', d, { phases: u.phases, restarts: r.count(), attempts: lock.attempts, thrown: thrown ?? undefined })
  // 기준판: .14를 '없음'으로 접어 목적지 null → 동봉으로 바꾸고 재시작 1.
  expect(d.state().active).toBe('1.0.15')
  expect(lock.attempts).toBe(0)
  expect(r.count()).toBe(0)
  expect(String(thrown)).toMatch(UNKNOWN)
})

test('R-B9 rollback: target-read failure refuses before the lock', async () => {
  const d = disk()
  const lock = new CountingSwitch()
  const r = restarter()
  const u = makeUpdater({ disk: d, lock, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', store: /^rollbackTarget$/, code: EPERM, times: 1 }
  inject.set([fault])
  let thrown: unknown = null
  try { await u.updates.rollback() } catch (e) { thrown = e }
  fired(fault)
  await faultRecord('R-B9', d, { phases: u.phases, restarts: r.count(), attempts: lock.attempts, thrown: thrown ?? undefined })
  // 기준판: 빈 상태 → 목적지 null → 동봉, 잠금 1, 재시작 1.
  expect(d.state().active).toBe('1.0.15')
  expect(lock.attempts).toBe(0)
  expect(r.count()).toBe(0)
  expect(String(thrown)).toMatch(UNKNOWN)
})

test('R-B9-display rollback: display-read failure still goes to 1.0.14 (EQ)', async () => {
  const d = disk()
  const r = restarter()
  const u = makeUpdater({ disk: d, restart: r.restart })
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^status$/, store: READ_STATE, code: EPERM, times: 1 }
  inject.set([fault])
  await u.updates.rollback()
  fired(fault)
  expect(d.state().active).toBe('1.0.14')
  expect(r.count()).toBe(1)
})

/* ═════════════════════════ R — 자리 3: existsSync가 접근 오류를 '없음'으로 접음 ═════════════════════════ */

test('R-N4 existence checks treat EPERM as unknown: unreadable highest backup blocks a below-high-water install', async () => {
  // state.highest는 null이고 highest.json(.16)만 높은 물높이를 기억한다. 읽기·존재 확인이 모두 EPERM.
  const d = disk({ versions: ['1.0.14'], active: '1.0.14', highest: null })
  writeFileSync(join(d.storeDir, 'highest.json'), JSON.stringify({ version: '1.0.16', manifest: 'c'.repeat(64) }))
  const u = makeUpdater({ disk: d, candidate: fixture('1.0.15') })
  const read: Rule = { op: 'read', name: 'highest.json', code: EPERM, times: ALWAYS }
  const exists: Rule = { op: 'lstat', name: 'highest.json', code: EPERM, times: ALWAYS }
  inject.set([read, exists])
  // 표시(읽기 전용)는 기준판과 같은 값.
  expect(u.updates.status()).toMatchObject({ current: '1.0.14', highest: null })
  const status = await u.updates.check()
  fired(read, exists)
  await faultRecord('R-N4', d, { phases: u.phases, status })
  // 기준판: highest.json을 '없음'으로 접어 .15를 새 판(available)으로 낸다 — 물높이 .16 아래로 내려간다.
  expect(status.phase).toBe('error')
  expect(status.message).toMatch(UNKNOWN)
})

/* ═════════════════════════ R — 자리 4: matchesBundle()이 I/O 실패를 false로 접음 ═════════════════════════ */

test('R-MB iii disposition: unreadable bundle manifest is unknown, not a mismatch', async () => {
  const { spec, candidate } = bundleCandidate()
  const d = disk(spec)
  const u = makeUpdater({ disk: d, candidate })
  const fault: Rule = { op: 'read', name: 'install-manifest.json', code: EPERM, times: 1 }
  inject.set([fault])
  const status = await u.updates.check()
  fired(fault)
  await faultRecord('R-MB-iii', d, { phases: u.phases, status })
  // 기준판: '이전 판이거나 같은 판의 내용이 달라서' — 못 읽음을 불일치로 접는다.
  expect(status.phase).toBe('error')
  expect(status.message).toMatch(UNKNOWN)
})

/* ═════════════════════════ R — 쓰기 결정 자리의 못 읽음(판정서 tests (f) 우선 보강) ═════════════════════════ */

test('R-N2 install: lock-decision failure never quarantines the active without the lock', async () => {
  // 활성 .15가 손상, 같은 digest로 수리 — 기준판은 :97의 state()로 잠금 갈래를 정한다.
  const d = disk()
  d.corrupt('1.0.15')
  const lock = new CountingSwitch()
  const u = makeUpdater({ disk: d, lock, candidate: d.versions.get('1.0.15')! })
  expect((await u.updates.check()).phase).toBe('repair')
  // 소비자를 잡지 않는다 — 기준판은 잠금 없이 격리한 뒤 activate의 잠금에서 기다리므로, 잡으면 시간 제한까지 멈춘다.
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^install$/, store: READ_STATE, code: EPERM, times: 1 }
  inject.set([fault])
  inject.mark()
  const p = u.updates.install()
  let thrown: unknown = null
  try { await p } catch (e) { thrown = e }
  fired(fault)
  await faultRecord('R-N2', d, { phases: u.phases, attempts: lock.attempts, thrown: thrown ?? undefined })
  // 기준판: 빈 상태로 접어 '활성 아님' → 잠금 없이 publish → 활성 폴더를 격리(.damaged-).
  expect(inject.writes().filter(line => line.includes('.damaged-'))).toEqual([])
  expect(lock.attempts).toBe(0)
  expect(readFileSync(join(d.storeDir, '1.0.15', 'SKILL.md'), 'utf8')).toBe('# damaged 1.0.15')
  expect(String(thrown)).toMatch(UNKNOWN)
})

test('R-N6 check: unknown highest is error, not latest', async () => {
  // 동봉 .15, 채널 .14. 기록 highest는 `.tmp`(.16)에만 있고 그 `.tmp`를 읽지 못한다.
  const d = disk({ bundledVersion: '1.0.15', versions: [], kept: [], active: null, highest: null })
  writeFileSync(join(d.storeDir, 'highest.json.tmp'), JSON.stringify({ version: '1.0.16', manifest: 'c'.repeat(64) }))
  const u = makeUpdater({ disk: d, candidate: fixture('1.0.14') })
  const fault: Rule = { op: 'read', name: 'highest.json.tmp', code: EPERM, times: ALWAYS }
  inject.set([fault])
  const status = await u.updates.check()
  fired(fault)
  await faultRecord('R-N6', d, { phases: u.phases, status })
  // 기준판: highest를 '없음'으로 접어 조기 idle.
  expect(status.phase).toBe('error')
  expect(status.message).toMatch(UNKNOWN)
})

test('R-B10 publish: state read after rename failing keeps selection and kept', async () => {
  const d = disk({ versions: ['1.0.14'], active: '1.0.14' })
  const before = d.state()
  const u = makeUpdater({ disk: d, candidate: fixture('1.0.15') })
  await u.updates.check()
  // publish 안의 state() 읽기: 1번째 = disposition, 2번째 = rename 뒤(:125).
  const fault: Rule = { op: 'read', name: 'state.json', store: /^publish$/, skip: 1, code: EPERM, times: 1 }
  inject.set([fault])
  let thrown: unknown = null
  try { await u.updates.install() } catch (e) { thrown = e }
  fired(fault)
  await faultRecord('R-B10', d, { phases: u.phases, thrown: thrown ?? undefined })
  inject.clear()
  // 기준판: 빈 상태 위에 kept={.15}·active=null을 써서 선택과 .14 기록을 잃는다.
  expect(d.state().active).toBe('1.0.14')
  expect(d.state().kept).toEqual(before.kept)
  expect(d.state().highest).toEqual(before.highest)
  expect(String(thrown)).toMatch(UNKNOWN)
  expect(u.phases.at(-1)).toBe('error')
})

/* ═════════════════════════ 진단 줄(조건③) ═════════════════════════ */

test('R-D5 diag: an unknown read leaves one skill line with stage and kind only', async () => {
  const log = join(disk().root, 'app.log')
  process.env.KNUAF_APP_LOG = log
  const d = disk({ active: '1.0.14' })
  const u = makeUpdater({ disk: d, restart: restarter(true).restart })
  const fault: Rule = { op: 'read', name: 'state.json', svc: /^activateLocked$/, store: EFFECTIVE, code: EPERM, times: 1 }
  inject.set([fault])
  await u.updates.select('1.0.15').catch(() => {})
  fired(fault)
  await faultRecord('R-D5', d, { phases: u.phases })
  inject.clear()
  const lines = skillDiag(log)
  // 기준판: skill 진단 줄이 없다.
  // 판정서 tests I-04: 전체 skill 줄을 본다. 설계 §4는 set()마다 `status.<phase>` 줄을 허용하므로
  // 그 줄만 빼고, 나머지 skill 줄 전체가 정확히 이 한 줄이어야 한다. 모든 줄은 §4 문법(단계·결과, 숫자·경로 없음).
  const GRAMMAR = /^skill:(status\.[a-z]+|use\.[a-z-]+|rollback-target|select|rollback|install|restore|publish|cleanup|rebuild|confirm|disposition|check) [a-z-]+$/
  for (const line of lines) expect(line).toMatch(GRAMMAR)
  expect(lines.filter(line => !line.startsWith('skill:status.'))).toEqual(['skill:select unknown-io-eperm'])
})

/* ═════════════════════════ GOLD — 기준판 골든 대조(설계 §5.0·§5.1, 판정서 tests C-01) ═════════════════════════
 * 각 시나리오의 대조 필드 전부(반환/던진 문구, state·highest 원문과 .tmp, 트리 지문, 쓰기·rename·삭제 순서,
 * 재시작 수, phase 순서, 잠금 시도 수, 잠금·publish 순서)를 `fixtures/skill-baseline-ok.json`과 비교한다.
 * 골든은 **기준판 a340264에서** `KNUAF_GOLDEN_WRITE=1`로 한 번 채집해 동결했다(파일 머리 `_made`).
 * 2단계 PR에서 이 파일의 diff는 0이어야 한다.
 */
const GOLDEN_FILE = join(__dirname, 'fixtures', 'skill-baseline-ok.json')
const GOLDEN_WRITE = process.env.KNUAF_GOLDEN_WRITE === '1'

function golden(name: string, record: unknown): void {
  const json = JSON.parse(JSON.stringify(record)) as unknown
  if (GOLDEN_WRITE) {
    let all: Record<string, unknown> = {}
    try { all = JSON.parse(realFs.readFileSync(GOLDEN_FILE, 'utf8') as string) as Record<string, unknown> } catch { /* 처음 */ }
    all._made = process.env.KNUAF_GOLDEN_MADE ?? 'unknown'
    all[name] = json
    realFs.mkdirSync(join(__dirname, 'fixtures'), { recursive: true })
    realFs.writeFileSync(GOLDEN_FILE, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n')
    return
  }
  const all = JSON.parse(realFs.readFileSync(GOLDEN_FILE, 'utf8') as string) as Record<string, unknown>
  expect(all[name], `골든 없음: ${name}`).toBeDefined()
  expect(json).toEqual(all[name])
}

/**
 * 기준판 실패 경로 골든(설계 §5.0 `skill-baseline-fault.json`, 판정서 tests r2 C-01) — R 시험이 **지금 코드가 이렇게
 * 틀린다**는 관측을 단언 전에 남긴다. 채집 모드에서만 쓰고, 대조는 하지 않는다(2단계에서 R 동작이 바뀌는 것이 목적).
 * 2단계 PR에서 이 파일의 diff는 0이어야 한다.
 */
const FAULT_FILE = join(__dirname, 'fixtures', 'skill-baseline-fault.json')
async function faultRecord(name: string, d: Disk, extra: { phases?: string[]; restarts?: number; attempts?: number; thrown?: unknown; status?: unknown } = {}): Promise<void> {
  if (!GOLDEN_WRITE) return
  const thrown = extra.thrown === undefined ? undefined : normalize(extra.thrown instanceof Error ? extra.thrown.message : String(extra.thrown), d.root)
  const record = JSON.parse(JSON.stringify({ disk: observeDisk(d), phases: extra.phases, restarts: extra.restarts, attempts: extra.attempts, thrown, status: extra.status === undefined ? undefined : JSON.parse(normalize(JSON.stringify(extra.status), d.root)) })) as unknown
  let all: Record<string, unknown> = {}
  try { all = JSON.parse(realFs.readFileSync(FAULT_FILE, 'utf8') as string) as Record<string, unknown> } catch { /* 처음 */ }
  all._made = process.env.KNUAF_GOLDEN_MADE ?? 'unknown'
  all[name] = record
  realFs.writeFileSync(FAULT_FILE, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n')
}

type Case = {
  d: Disk
  u: ReturnType<typeof makeUpdater>
  r: ReturnType<typeof restarter>
  lock: CountingSwitch
  events: string[]
  step: (label: string, work: () => unknown) => Promise<void>
}
type CaseSpec = {
  spec?: DiskSpec
  prep?: (d: Disk) => void
  failFirstRestart?: boolean
  restart?: (d: Disk, n: number) => Promise<void>
  candidate?: (d: Disk) => ReturnType<typeof fixture>
  fetchGate?: ReturnType<typeof gate>
}

async function gold(name: string, cs: CaseSpec, body: (c: Case) => Promise<void>): Promise<void> {
  const d = disk(cs.spec ?? {})
  cs.prep?.(d)
  const events: string[] = []
  const lock = new CountingSwitch(events)
  const r = restarter(cs.failFirstRestart)
  let n = 0
  const restart = cs.restart ? async () => { ++n; await cs.restart!(d, n) } : r.restart
  const u = makeUpdater({ disk: d, lock, events, restart, candidate: cs.candidate?.(d), fetchGate: cs.fetchGate })
  const steps: [string, unknown][] = []
  inject.mark()
  await body({ d, u, r, lock, events, step: async (label, work) => { steps.push([label, await outcome(d, work)]) } })
  golden(name, { steps, disk: observeDisk(d), restarts: cs.restart ? n : r.count(), phases: u.phases, attempts: lock.attempts, events })
}

const D0: DiskSpec = {}

test('GOLD E1 select stored version', () => gold('E1', { spec: { active: '1.0.14' } }, async c => { await c.step('select .15', () => c.u.updates.select('1.0.15')) }))
test('GOLD E2 select null', () => gold('E2', { spec: D0 }, async c => { await c.step('select null', () => c.u.updates.select(null)) }))
test('GOLD E3 rollback to the lower kept', () => gold('E3', { spec: D0 }, async c => { await c.step('rollback', () => c.u.updates.rollback()) }))
test('GOLD E4 rollback with no lower kept goes to bundle', () => gold('E4', { spec: { versions: ['1.0.14'], active: '1.0.14' } }, async c => { await c.step('rollback', () => c.u.updates.rollback()) }))
test('GOLD E5 rollback with sure-invalid active', () => gold('E5', { spec: D0, prep: d => d.corrupt('1.0.15') }, async c => { await c.step('rollback', () => c.u.updates.rollback()) }))
test('GOLD E6 rollback skips a sure-invalid lower candidate', () => gold('E6', { spec: D0, prep: d => d.corrupt('1.0.14') }, async c => { await c.step('rollback', () => c.u.updates.rollback()) }))
test('GOLD E7 install new version', () => gold('E7', { spec: { versions: ['1.0.14'], active: '1.0.14' }, candidate: () => fixture('1.0.15') }, async c => {
  await c.step('check', () => c.u.updates.check())
  await c.step('install', () => c.u.updates.install())
}))
test('GOLD E8+E10 restart failure restores previous, then kept reuse', () => gold('E8', { spec: { versions: ['1.0.14'], active: '1.0.14' }, failFirstRestart: true, candidate: () => fixture('1.0.15') }, async c => {
  await c.step('check', () => c.u.updates.check())
  await c.step('install (restart fails)', () => c.u.updates.install())
  await c.step('install again (kept reuse)', () => c.u.updates.install())
  await c.step('requests', () => c.u.requests.length)
}))
test('GOLD E9 restart failure with sure-invalid active restores null', () => gold('E9', { spec: { active: '1.0.14' }, prep: d => d.corrupt('1.0.14'), failFirstRestart: true }, async c => { await c.step('select .15', () => c.u.updates.select('1.0.15')) }))
test('GOLD E11 repair of a non-active kept', () => gold('E11', { spec: { active: '1.0.14' }, prep: d => d.corrupt('1.0.15'), candidate: d => d.versions.get('1.0.15')! }, async c => {
  await c.step('check', () => c.u.updates.check())
  await c.step('install', () => c.u.updates.install())
}))
test('GOLD E12 repair of the active waits for consumers', () => gold('E12', { spec: D0, prep: d => d.corrupt('1.0.15'), candidate: d => d.versions.get('1.0.15')! }, async c => {
  await c.step('check', () => c.u.updates.check())
  const consumer = c.lock.enter()
  const p = c.u.updates.install()
  await c.lock.switched
  c.events.push('release')
  consumer()
  await c.step('install', () => p)
}))
test('GOLD E13 direct publish of the valid active throws after proof write', () => gold('E13', { spec: D0 }, async c => {
  const f = c.d.versions.get('1.0.15')!
  await c.step('publish', () => { c.u.store.publish(f.verified(), f.zip); return null })
}))
test('GOLD E14 cleanup retention and debris', () => gold('E14', { spec: { versions: ['1.0.14', '1.0.15', '1.0.16'], active: '1.0.16' }, prep: d => { for (const n of ['.stage-interrupted', '.download-interrupted', '.damaged-1.0.14-1000']) realFs.mkdirSync(join(d.storeDir, n)) } }, async c => {
  await c.step('cleanup', () => { c.d.store().cleanup(); return null })
}))

// E15·E16: 디스크별 status·check·소비 소스.
const surface = async (c: Case): Promise<void> => {
  await c.step('status', () => c.u.updates.status())
  await c.step('source', () => normalize(c.u.store.resolveSkillSource(), c.d.root))
  await c.step('check', () => c.u.updates.check())
}
test('GOLD E15a bundle newer', () => gold('E15a', { spec: { bundledVersion: '1.0.16' }, candidate: () => fixture('1.0.15') }, surface))
test('GOLD E15b same version as bundle passes', () => gold('E15b', { spec: { bundledVersion: '1.0.15' }, candidate: () => fixture('1.0.16') }, surface))
test('GOLD E15c same version as bundle with bad hash', () => gold('E15c', { spec: { bundledVersion: '1.0.15' }, prep: d => d.corrupt('1.0.15'), candidate: () => fixture('1.0.16') }, surface))
test('GOLD E15d first install', () => gold('E15d', { spec: { versions: [], kept: [], state: false }, candidate: () => fixture('1.0.15') }, surface))
test('GOLD E15e half tmp', () => gold('E15e', { spec: D0, prep: d => realFs.writeFileSync(join(d.storeDir, 'state.json.tmp'), '{"active"'), candidate: () => fixture('1.0.16') }, surface))
test('GOLD E15f channel behind bundle', () => gold('E15f', { spec: { versions: [], kept: [], active: null, highest: null, bundledVersion: '1.0.16' }, candidate: () => fixture('1.0.15') }, surface))

test('GOLD E17 disposition keeps active in the floor', () => gold('E17', { spec: { active: '1.0.15', highest: '1.0.13' }, candidate: () => fixture('1.0.14') }, async c => {
  await c.step('check .14', () => c.u.updates.check())
  await c.step('install .14', () => c.u.updates.install())
  await c.step('disposition .16', () => c.u.store.disposition(fixture('1.0.16').verified()))
}))
test('GOLD E18 unusable well-formed selection restores and restarts', () => gold('E18', { spec: { active: '1.0.14' }, prep: d => d.corrupt('1.0.15') }, async c => {
  await c.step('select 1.0.9', () => c.u.updates.select('1.0.9'))
  await c.step('select .15 (bad hash)', () => c.u.updates.select('1.0.15'))
}))
test('GOLD E19 restore of a previous that became invalid', () => gold('E19', { spec: { active: '1.0.14' }, restart: async (d, n) => { if (n === 1) { d.corrupt('1.0.14'); throw new Error('sidecar restart failed') } } }, async c => {
  await c.step('select .15', () => c.u.updates.select('1.0.15'))
}))

// E20: 기준판 reader가 받아들이는 비정형 상태들.
const reader = async (c: Case): Promise<void> => {
  await c.step('status', () => c.u.updates.status())
  await c.step('check', () => c.u.updates.check())
  await c.step('rollback', () => c.u.updates.rollback())
  await c.step('cleanup', () => { c.d.store().cleanup(); return null })
}
test('GOLD E20a active above highest', () => gold('E20a', { spec: { active: '1.0.15', highest: '1.0.14' }, candidate: () => fixture('1.0.16') }, reader))
test('GOLD E20b highest null with active', () => gold('E20b', { spec: { active: '1.0.15', highest: null }, candidate: () => fixture('1.0.14') }, reader))
test('GOLD E20c kept above highest', () => gold('E20c', { spec: { versions: ['1.0.14', '1.0.15', '1.0.16'], active: '1.0.14', highest: '1.0.15' }, candidate: () => fixture('1.0.15') }, reader))
test('GOLD E20d bundle above highest above active', () => gold('E20d', { spec: { versions: ['1.0.12', '1.0.14'], active: '1.0.12', highest: '1.0.14', bundledVersion: '1.0.15' }, candidate: () => fixture('1.0.14') }, reader))

// E-STRUCT: 구조 errno는 확정 무효(모름 아님).
const structural = async (c: Case): Promise<void> => {
  await c.step('status', () => c.u.updates.status())
  await c.step('select .14', () => c.u.updates.select('1.0.14'))
  await c.step('rollback', () => c.u.updates.rollback())
}
test('GOLD E-STRUCT file in place of the folder', () => gold('ESTRUCT-file', { spec: D0, prep: d => { realFs.rmSync(join(d.storeDir, '1.0.14'), { recursive: true, force: true }); realFs.writeFileSync(join(d.storeDir, '1.0.14'), 'x') } }, structural))
test('GOLD E-STRUCT folder in place of a file', () => gold('ESTRUCT-dir', { spec: D0, prep: d => { realFs.rmSync(join(d.storeDir, '1.0.14', 'SKILL.md'), { force: true }); realFs.mkdirSync(join(d.storeDir, '1.0.14', 'SKILL.md')) } }, structural))
test('GOLD E-STRUCT symlink folder', () => gold('ESTRUCT-link', { spec: D0, prep: d => { realFs.renameSync(join(d.storeDir, '1.0.14'), join(d.root, 'elsewhere-14')); symlinkSync(join(d.root, 'elsewhere-14'), join(d.storeDir, '1.0.14')) } }, structural))

// 판정서 v2.3 입력 1·2와 동시성 EQ도 골든에 담는다.
test('GOLD status with both reads succeeding', () => gold('V1-status-two-reads', { spec: { active: '1.0.14', highest: '1.0.15' } }, async c => {
  inject.set([{ op: 'read', name: 'state.json', svc: /^status$/, store: RESOLVE, times: ALWAYS, text: t => t.replace('"active":"1.0.14"', '"active":"1.0.15"') }])
  await c.step('status', () => c.u.updates.status())
}))
test('GOLD bundle manifest re-read differs', () => {
  const { spec, candidate } = bundleCandidate()
  return gold('V2-manifest-reread', { spec, candidate: () => candidate }, async c => {
    inject.set([{ op: 'read', name: 'install-manifest.json', skip: 1, times: ALWAYS, text: t => t + ' ', bytes: b => Buffer.concat([b, Buffer.from(' ')]) }])
    await c.step('check', () => c.u.updates.check())
  })
})
test('GOLD R-C1 rollback target before the lock wait', () => gold('RC1', { spec: D0 }, async c => {
  const release = c.lock.enter()
  const p = c.u.updates.rollback()
  c.d.writeState({ active: '1.0.14' })
  release()
  await c.step('rollback', () => p)
}))
test('GOLD R-C3 select previous after the wait', () => gold('RC3', { spec: { active: '1.0.14' }, failFirstRestart: true }, async c => {
  const release = c.lock.enter()
  const p = c.u.updates.select('1.0.15')
  c.d.writeState({ active: '1.0.15' })
  release()
  await c.step('select', () => p)
}))
