/**
 * figures/request-file.test.ts — 폴더의 요청 파일을 읽기만 하고, 링크·과대 파일을 거절한다 (R4-1, 계약 §3).
 *
 * `lstat` 확인과 열기 사이에 링크로 바뀌는 경쟁이 있으므로 열 때도 `O_NOFOLLOW`를 주고, 연 뒤
 * `fstat`으로 다시 본다. 이 시험은 그 두 겹을 각각 확인한다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

const requestFile = (await import(new URL('./request-file.ts', import.meta.url).href)) as typeof import('./request-file')
const contract = (await import(new URL('./contract.ts', import.meta.url).href)) as typeof import('./contract')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-request-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

const body = (id: string): string =>
  JSON.stringify({
    v: 1,
    id,
    turnId: 'turn-1',
    slot: '3.2',
    page: 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps',
    images: ['https://www.nongsaro.go.kr/ps/img/curation/a.jpg']
  })

describe('requestDir / requestFile', () => {
  it('계약 §3의 위치', () => {
    assert.equal(requestFile.requestDir('/papers/들깨'), '/papers/들깨/.knuaf-gui/figure-requests')
    assert.equal(requestFile.requestFile('/papers/들깨', 'req-abcdef12'), '/papers/들깨/.knuaf-gui/figure-requests/req-abcdef12.req.json')
  })
})

describe('readRequestFile', () => {
  it('정상 요청은 계약 모양으로 좁혀 돌려준다', async () => {
    const folder = join(root, 'ok')
    const path = requestFile.requestFile(folder, 'req-abcdef12')
    await mkdir(requestFile.requestDir(folder), { recursive: true })
    await writeFile(path, body('req-abcdef12'))
    const read = await requestFile.readRequestFile(path)
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.parse.ok, true)
    if (!read.parse.ok) return
    assert.equal(read.parse.request.slot, '3.2')
  })

  it('없으면 missing', async () => {
    assert.deepEqual(await requestFile.readRequestFile(join(root, 'none', 'a.req.json')), { ok: false, reason: 'missing' })
  })

  it('디렉터리면 not_file', async () => {
    const folder = join(root, 'dir')
    await mkdir(join(requestFile.requestDir(folder), 'x.req.json'), { recursive: true })
    assert.deepEqual(await requestFile.readRequestFile(requestFile.requestFile(folder, 'x')), {
      ok: false,
      reason: 'not_file'
    })
  })

  it('심볼릭 링크는 link', async () => {
    const folder = join(root, 'link')
    const dir = requestFile.requestDir(folder)
    await mkdir(dir, { recursive: true })
    const real = join(root, 'real.json')
    await writeFile(real, body('req-abcdef12'))
    await symlink(real, join(dir, 'req-abcdef12.req.json'))
    assert.deepEqual(await requestFile.readRequestFile(requestFile.requestFile(folder, 'req-abcdef12')), {
      ok: false,
      reason: 'link'
    })
  })

  it('64KiB를 넘으면 too_big', async () => {
    const folder = join(root, 'big')
    const path = requestFile.requestFile(folder, 'req-big00001')
    await mkdir(requestFile.requestDir(folder), { recursive: true })
    await writeFile(path, body('req-big00001').padEnd(contract.REQUEST_MAX_BYTES + 10, ' '))
    assert.deepEqual(await requestFile.readRequestFile(path), { ok: false, reason: 'too_big' })
  })

  it('내용이 계약 밖이면 parse가 거절한다(읽기는 성공)', async () => {
    const folder = join(root, 'bad')
    const path = requestFile.requestFile(folder, 'req-abcdef12')
    await mkdir(requestFile.requestDir(folder), { recursive: true })
    await writeFile(path, JSON.stringify({ v: 1, id: 'req-abcdef12' }))
    const read = await requestFile.readRequestFile(path)
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.parse.ok, false)
  })
})
