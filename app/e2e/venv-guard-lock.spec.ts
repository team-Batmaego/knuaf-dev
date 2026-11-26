// 검토 r2 I-01: 전환 잠금(`deps/.lock`)의 회수·해제가 다른 작업의 현재 잠금을 지우면 안 된다.
// 실제 Node 프로세스 둘 이상으로 확인한다 — 죽은 프로세스가 남긴 잠금을 동시에 회수해도 한 작업만 소유한다.
// `onStaleJudged` 는 "남긴 잠금을 죽었다고 판단한 직후"에 순서를 제어하는 시험용 고리다(운영은 안 쓴다).
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  if (pauseFile) opts.onStaleJudged = async () => { fs.writeFileSync(pauseFile, 'x'); while (!fs.existsSync(goFile)) await sleep(5) }
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
  const run = (name: string, hold: number, pause?: { pause: string; go: string }) => {
    const proc = spawn(process.execPath, [child, mod, root, name, log, pause?.pause ?? '', pause?.go ?? '', String(hold)], { stdio: 'inherit' })
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
