import type * as turnTypes from './turn'
/**
 * figures/turn.test.ts — 턴 고정과 대기 요청의 운명 (설계 R4-6, I-01).
 *
 * 이 시험이 잠그는 판단: 턴 파일이 **없으면** `cancelled`(앱이 안 받는 상태), 있고 turnId가 다르면
 * `stale`(지난 턴·다른 폴더). 둘을 구분해야 학생 알림 문구와 증명 사유가 갈린다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

const turn = (await import(new URL('./turn.ts', import.meta.url).href)) as typeof import('./turn')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-turn-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('turn.json', () => {
  it('시작·읽기·끝', async () => {
    const path = join(root, 'turn.json')
    await turn.beginTurn(path, 'turn-1', '/papers/들깨', 1_700_000_000_000)
    assert.deepEqual(await turn.readTurn(path), {
      v: 1,
      turnId: 'turn-1',
      folder: '/papers/들깨',
      startedAt: 1_700_000_000_000
    })
    await turn.endTurn(path)
    assert.equal(await turn.readTurn(path), null)
  })

  it('없는 파일을 지우는 것도 정상', async () => {
    await turn.endTurn(join(root, 'missing.json'))
  })

  it('모양이 깨진 턴 파일은 없는 것으로 본다', async () => {
    const path = join(root, 'broken.json')
    await turn.beginTurn(path, '', '/papers/x', 1)
    assert.equal(await turn.readTurn(path), null)
  })
})

describe('checkTurn', () => {
  const record: turnTypes.TurnRecord = { v: 1, turnId: 'turn-1', folder: '/papers/들깨', startedAt: 1 }

  it('턴이 없으면 cancelled', () => {
    assert.deepEqual(turn.checkTurn(null, 'turn-1'), { ok: false, reason: 'cancelled' })
  })

  it('turnId가 다르면 stale', () => {
    assert.deepEqual(turn.checkTurn(record, 'turn-0'), { ok: false, reason: 'stale' })
  })

  it('같으면 통과', () => {
    assert.deepEqual(turn.checkTurn(record, 'turn-1'), { ok: true })
  })
})
