/**
 * figures/storage.test.ts — 앱 전용 저장소의 경로·원자적 쓰기·계수 (설계 R4-1, 계약 §2).
 *
 * 원자적 쓰기가 중요한 이유: 파이썬 도우미가 결과 JSON을 읽는 순간 반쯤 쓴 파일이면 "형식 깨짐"으로
 * 요청이 사라진다. 그래서 `tmp/… → rename`이고, 실패하면 임시 파일이 남지 않아야 한다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})

const storage = (await import(new URL('./storage.ts', import.meta.url).href)) as typeof import('./storage')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-figures-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('figurePaths / folderHash', () => {
  it('계약 §2의 이름을 쓴다', () => {
    const paths = storage.figurePaths('/home/u/figures')
    assert.equal(paths.channel, '/home/u/figures/figure-channel.json')
    assert.equal(paths.turn, '/home/u/figures/turn.json')
    assert.equal(paths.receipts, '/home/u/figures/receipts.jsonl')
    assert.equal(paths.counters, '/home/u/figures/counters.json')
    assert.equal(paths.res, '/home/u/figures/res')
  })

  it('폴더 해시는 sha256 앞 16자', () => {
    const hash = storage.folderHash('/home/u/논문/들깨')
    assert.match(hash, /^[0-9a-f]{16}$/)
    assert.equal(hash, storage.folderHash('/home/u/논문/들깨'))
    assert.notEqual(hash, storage.folderHash('/home/u/논문/참깨'))
  })

  it('sha256Hex는 64자 hex', () => {
    assert.equal(storage.sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('prepareHome', () => {
  it('디렉터리를 만들고 tmp를 비운다', async () => {
    const paths = storage.figurePaths(join(root, 'home'))
    await storage.prepareHome(paths)
    const entries = (await readdir(paths.home)).sort()
    assert.deepEqual(entries, ['choices', 'res', 'store', 'tmp'])
    await storage.writeAtomic(join(paths.tmp, 'left.bin'), Buffer.from('x'))
    await storage.prepareHome(paths)
    assert.deepEqual(await readdir(paths.tmp), [])
  })
})

describe('writeAtomic / writeJson / appendLine', () => {
  it('원자적으로 쓰고 임시 파일을 남기지 않는다', async () => {
    const paths = storage.figurePaths(join(root, 'atomic'))
    await storage.prepareHome(paths)
    const target = join(paths.res, 'a.res.json')
    await storage.writeJson(target, { v: 1, id: 'a' })
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { v: 1, id: 'a' })
    assert.deepEqual((await readdir(paths.res)).filter((name) => name.endsWith('.tmp')), [])
  })

  it('쓰는 파일 모드는 0600', async () => {
    const paths = storage.figurePaths(join(root, 'mode'))
    await storage.prepareHome(paths)
    const target = join(paths.res, 'b.json')
    await storage.writeAtomic(target, '{}')
    const info = await stat(target)
    assert.equal(info.mode & 0o777, 0o600)
  })

  it('덧붙이기는 줄을 더한다(반쪽 줄 없음)', async () => {
    const path = join(root, 'receipts.jsonl')
    await storage.appendLine(path, { n: 1 })
    await storage.appendLine(path, { n: 2 })
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ n: 1 }, { n: 2 }])
  })

  it('readJson은 깨진 JSON에 null', async () => {
    const path = join(root, 'broken.json')
    await storage.writeAtomic(path, '{oops')
    assert.equal(await storage.readJson(path), null)
    assert.equal(await storage.readJson(join(root, 'nope.json')), null)
  })
})

describe('계수와 상한', () => {
  it('빈 계수는 오늘 날짜·0', () => {
    assert.deepEqual(storage.emptyCounters('2026-11-11'), { v: 1, day: '2026-11-11', filesToday: 0, folders: {} })
    assert.equal(storage.utcDay(Date.UTC(2026, 10, 11, 23, 59)), '2026-11-11')
  })

  it('날짜가 바뀌면 하루 파일 수만 0으로 시작하고 폴더 누계는 남는다', async () => {
    const path = join(root, 'counters.json')
    await storage.writeJson(path, { v: 1, day: '2026-11-10', filesToday: 199, folders: { abc: 1024 } })
    const next = await storage.loadCounters(path, Date.UTC(2026, 10, 11, 1))
    assert.equal(next.filesToday, 0)
    assert.equal(next.folders.abc, 1024)
    const same = await storage.loadCounters(path, Date.UTC(2026, 10, 10, 23))
    assert.equal(same.filesToday, 199)
  })

  it('깨진 계수는 빈 계수로 떨어진다', async () => {
    const path = join(root, 'counters-broken.json')
    await storage.writeAtomic(path, JSON.stringify({ v: 2, day: 5 }))
    assert.equal((await storage.loadCounters(path, 0)).filesToday, 0)
  })

  it('하루 200파일에서 막는다', () => {
    const counters = { ...storage.emptyCounters('2026-11-11'), filesToday: storage.DAILY_FILE_LIMIT }
    assert.equal(storage.checkQuota(counters, 'abc', 10), 'daily_files')
    assert.equal(storage.checkQuota({ ...counters, filesToday: storage.DAILY_FILE_LIMIT - 1 }, 'abc', 10), null)
  })

  it('폴더 200MiB에서 막는다', () => {
    const counters = { ...storage.emptyCounters('2026-11-11'), folders: { abc: storage.FOLDER_BYTE_LIMIT - 5 } }
    assert.equal(storage.checkQuota(counters, 'abc', 6), 'folder_bytes')
    assert.equal(storage.checkQuota(counters, 'abc', 5), null)
    // 다른 폴더는 각자 센다.
    assert.equal(storage.checkQuota(counters, 'def', 5), null)
  })

  it('저장 성공 뒤에만 계수를 올린다', () => {
    const charged = storage.chargeQuota({ ...storage.emptyCounters('2026-11-11'), folders: { abc: 100 } }, 'abc', 50)
    assert.equal(charged.filesToday, 1)
    assert.equal(charged.folders.abc, 150)
  })
})
