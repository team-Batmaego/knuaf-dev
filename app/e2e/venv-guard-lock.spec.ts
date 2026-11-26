// 검토 r2 I-01: 전환 잠금(`deps/.lock`)의 회수·해제가 다른 작업의 현재 잠금을 지우면 안 된다.
// 실제 Node 프로세스 둘 이상으로 확인한다 — 죽은 프로세스가 남긴 잠금을 동시에 회수해도 한 작업만 소유한다.
// `onStaleJudged` 는 "남긴 잠금을 죽었다고 판단한 직후"에 순서를 제어하는 시험용 고리다(운영은 안 쓴다).
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

const DEAD_PID = 2 ** 22 + 12345
const src = join(resolve(__dirname, '..'), 'src/main/deps-env.ts')

const CHILD = `
const fs = require('fs')
const { acquireEnvLock } = require(process.argv[2])
const [,, , root, name, logFile, pauseFile, goFile, holdMs] = process.argv
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (e) => fs.appendFileSync(logFile, name + ' ' + e + ' ' + Date.now() + '\\n')
;(async () => {
  const opts = { pollMs: 5 }
  const pause = async () => { fs.writeFileSync(pauseFile, 'x'); while (!fs.existsSync(goFile)) await sleep(5) }
  if (pauseFile && process.env.PAUSE_AT === 'held') opts.onReclaimHeld = pause
  else if (pauseFile && process.env.PAUSE_AT === 'guard') { opts.onGuardJudged = pause; opts.onStaleJudged = async () => {} } // 옛 판(보호 파일) 전용
  else if (pauseFile) opts.onStaleJudged = pause
  const release = await acquireEnvLock(root, opts)
  log('acquired'); await sleep(Number(holdMs)); log('release'); release()
})()
`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-lock-')), root = join(dir, 'deps')
  mkdirSync(root)
  const mod = join(dir, 'deps-env.cjs')
  writeFileSync(mod, transpileModule(readFileSync(src, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)
  const child = join(dir, 'child.cjs'); writeFileSync(child, CHILD)
  const log = join(dir, 'log.txt'); writeFileSync(log, '')
  const run = (name: string, hold: number, pause?: { pause: string; go: string; at?: 'held' | 'guard' | 'judged' }) => {
    const proc = spawn(process.execPath, [child, mod, root, name, log, pause?.pause ?? '', pause?.go ?? '', String(hold)], { stdio: 'inherit', env: { ...process.env, PAUSE_AT: pause?.at ?? '' } })
    return new Promise<number | null>((res) => proc.on('exit', res))
  }
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [name, event, at] = l.split(' '); return { name, event, at: Number(at) } })
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)) } }
  return { dir, root, run, events, waitFor, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function overlaps(events: { name: string; event: string; at: number }[]): boolean {
  const spans = new Map<string, { a?: number; r?: number }>()
  for (const e of events) { const s = spans.get(e.name) ?? {}; if (e.event === 'acquired') s.a = e.at; else s.r = e.at; spans.set(e.name, s) }
  const list = [...spans.values()].filter((s) => s.a !== undefined && s.r !== undefined) as { a: number; r: number }[]
  return list.some((x, i) => list.some((y, j) => i < j && x.a < y.r && y.a < x.r))
}

test('I-01 r2: 죽은 프로세스의 잠금을 한쪽이 판단한 사이 다른 프로세스가 회수·획득해도 둘이 동시에 소유하지 않는다', async () => {
  const h = setup()
  try {
    writeFileSync(join(h.root, '.lock'), JSON.stringify({ pid: DEAD_PID, at: 'x' }))
    const pause = join(h.dir, 'a-paused'), go = join(h.dir, 'go')
    const a = h.run('A', 300, { pause, go })
    await h.waitFor(() => existsSync(pause)) // A: 죽은 소유자로 판단하고 멈춤
    const b = h.run('B', 600)
    await h.waitFor(() => h.events().some((e) => e.name === 'B' && e.event === 'acquired')) // B 가 회수하고 새 잠금을 쥠
    writeFileSync(go, 'go') // A 재개 — 옛 판단대로 B 의 현재 잠금을 지우면 안 된다
    expect(await Promise.all([a, b])).toEqual([0, 0])
    const events = h.events()
    expect(events.filter((e) => e.event === 'acquired').map((e) => e.name).sort()).toEqual(['A', 'B'])
    expect(overlaps(events)).toBe(false)
    expect(existsSync(join(h.root, '.lock'))).toBe(false)
  } finally { h.cleanup() }
})

test('I-01 r2: 여러 프로세스가 같은 죽은 잠금을 한꺼번에 회수해도 한 번에 하나만 소유한다', async () => {
  const h = setup()
  try {
    for (let round = 0; round < 3; round++) {
      writeFileSync(join(h.root, '.lock'), JSON.stringify({ pid: DEAD_PID, at: 'x' }))
      const codes = await Promise.all(['P1', 'P2', 'P3', 'P4'].map((n) => h.run(`${n}-${round}`, 40)))
      expect(codes).toEqual([0, 0, 0, 0])
    }
    const events = h.events()
    expect(events.filter((e) => e.event === 'acquired')).toHaveLength(12)
    expect(overlaps(events)).toBe(false)
  } finally { h.cleanup() }
})

test('I-01 r2: 해제는 자기 잠금일 때만 지운다 — 남이 쥔 현재 잠금은 그대로', async () => {
  const h = setup()
  try {
    const { acquireEnvLock } = await import(join(h.dir, 'deps-env.cjs')) as { acquireEnvLock: (root: string, o?: object) => Promise<(() => void) | null> }
    const release = await acquireEnvLock(h.root, { pollMs: 5 })
    const foreign = JSON.stringify({ pid: process.ppid, token: 'someone-else', at: 'now' })
    writeFileSync(join(h.root, '.lock'), foreign) // 내 잠금이 (잘못) 회수되어 남이 쥔 상황
    release!()
    expect(readFileSync(join(h.root, '.lock'), 'utf8')).toBe(foreign)
  } finally { h.cleanup() }
})


// 검토 r3 I-01: 크래시가 없어도 — 회수 보호를 쥔 살아 있는 프로세스 A 가 10초 넘게 멈추면 B 가 보호를 나이만으로
// 빼앗아 이전 잠금을 지우고 새 잠금을 쥐고, 재개한 A 가 B 의 현재 잠금을 지워 둘 다 소유했다.
test('I-01 r3: 살아 있는 회수자가 10초 넘게 멈춰도 보호·잠금을 나이만으로 빼앗지 않는다', async () => {
  test.setTimeout(60_000)
  const h = setup()
  try {
    writeFileSync(join(h.root, '.lock'), JSON.stringify({ pid: DEAD_PID, at: 'x' }))
    const pause = join(h.dir, 'a-held'), go = join(h.dir, 'go')
    const a = h.run('A', 300, { pause, go, at: 'held' })
    await h.waitFor(() => existsSync(pause)) // A: 보호를 쥐고 주 잠금 원문을 확인한 채 멈춤(살아 있음)
    await new Promise((r) => setTimeout(r, 10_500)) // 보호 파일이 10초보다 낡아진다
    const b = h.run('B', 3000)
    await new Promise((r) => setTimeout(r, 700)) // B 가 (빼앗을 수 있다면) 빼앗아 획득하고 아직 쥐고 있는 동안
    writeFileSync(go, 'go')
    expect(await Promise.all([a, b])).toEqual([0, 0])
    const events = h.events()
    expect(events.filter((e) => e.event === 'acquired').map((e) => e.name).sort()).toEqual(['A', 'B'])
    expect(overlaps(events)).toBe(false)
    expect(existsSync(join(h.root, '.lock'))).toBe(false)
    expect(existsSync(join(h.root, '.lock.reclaim'))).toBe(false)
  } finally { h.cleanup() }
})

test('I-01 r3: 회수 도중 죽은 청구자의 청구 파일은 PID 사망으로 건너뛰고 다음 번호로 회수를 이어 간다', async () => {
  const h = setup()
  try {
    const raw = JSON.stringify({ pid: DEAD_PID, at: 'x' })
    writeFileSync(join(h.root, '.lock'), raw)
    const key = createHash('sha256').update(raw).digest('hex').slice(0, 16)
    writeFileSync(join(h.root, `.lock.claim.${key}.0`), JSON.stringify({ pid: DEAD_PID + 1, token: 't' })) // 회수 도중 죽은 청구자
    expect(await h.run('C', 20)).toBe(0)
    expect(h.events().map((e) => e.event)).toEqual(['acquired', 'release'])
    expect(readdirSync(h.root).filter((n) => n.startsWith('.lock.claim.'))).toEqual([]) // 끝나면 치운다
  } finally { h.cleanup() }
})

// Roh r1 I-01: 죽은 **보호 파일**을 두 프로세스가 동시에 치우는 순서 — 확인(원문 읽기)과 삭제가 별도 연산이라, A 가 죽은
// 보호를 확인한 뒤 삭제 직전에 멈춘 사이 B 가 그것을 치우고 새 보호를 잡아 멈추면, 재개한 A 가 B 의 새 보호를 지우고
// 회수·주 잠금을 얻고, 재개한 B 는 (자기 보호가 지워진 줄 모른 채) 주 잠금을 지워 A 의 활성 잠금을 없앤다.
test('I-01 roh: 죽은 보호 파일을 두 프로세스가 동시에 치워도 둘이 동시에 소유하지 않는다 (판정 순서 그대로)', async () => {
  test.setTimeout(60_000)
  const h = setup()
  try {
    writeFileSync(join(h.root, '.lock'), JSON.stringify({ pid: DEAD_PID, at: 'x' }))
    writeFileSync(join(h.root, '.lock.reclaim'), JSON.stringify({ pid: DEAD_PID + 1, token: 'dead-guard' })) // 죽은 보호(옛 판이 남긴 것)
    const pa = join(h.dir, 'a-paused'), ga = join(h.dir, 'go-a'), pb = join(h.dir, 'b-paused'), gb = join(h.dir, 'go-b')
    const a = h.run('A', 3000, { pause: pa, go: ga, at: process.env.ROH_A_AT as 'guard' | 'judged' ?? 'judged' })
    await h.waitFor(() => existsSync(pa)) // A: 죽은 것을 확인했고 치우기 직전에 멈춤
    const b = h.run('B', 3000, { pause: pb, go: gb, at: 'held' }) // B: 같은 죽은 것을 치우고 새 보호를 잡은 채 멈춤
    await h.waitFor(() => existsSync(pb))
    writeFileSync(ga, 'go') // A 재개 → 회수·획득
    await h.waitFor(() => h.events().some((e) => e.name === 'A' && e.event === 'acquired'), 6000).catch(() => {})
    writeFileSync(gb, 'go') // B 재개 — 옛 판단으로 A 의 활성 잠금을 지우면 안 된다
    expect(await Promise.all([a, b])).toEqual([0, 0])
    const events = h.events()
    expect(events.filter((e) => e.event === 'acquired').map((e) => e.name).sort()).toEqual(['A', 'B'])
    expect(overlaps(events)).toBe(false)
  } finally { h.cleanup() }
})

test('I-01 roh: 여러 프로세스×여러 바퀴 — 죽은 잠금·죽은 보호/청구를 동시에 회수해도 동시 소유 0', async () => {
  test.setTimeout(90_000)
  const h = setup()
  try {
    for (let round = 0; round < 5; round++) {
      writeFileSync(join(h.root, '.lock'), JSON.stringify({ pid: DEAD_PID, at: 'x' + round }))
      if (round % 2) writeFileSync(join(h.root, '.lock.reclaim'), JSON.stringify({ pid: DEAD_PID + 1, token: 't' + round }))
      const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => h.run(`R${round}-${i}`, 30)))
      expect(codes).toEqual([0, 0, 0, 0, 0, 0])
    }
    const events = h.events()
    expect(events.filter((e) => e.event === 'acquired')).toHaveLength(30)
    expect(overlaps(events)).toBe(false)
  } finally { h.cleanup() }
})
