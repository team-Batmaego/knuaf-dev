/**
 * figures/contract.test.ts — 요청 모양 검사(계약 §3).
 *
 * 실행: `node --test src/main/figures/*.test.ts`
 *
 * 왜 `registerHooks`인가: 앱의 tsconfig는 `moduleResolution: bundler`라 소스는 확장자 없이 `./x`로
 * 쓴다. Node는 확장자 없는 ESM 상대 경로를 못 풀고, `./x.ts`를 쓰면 tsc가 TS5097로 막는다. 그래서
 * 시험 프로세스에만 확장자 보충 훅을 건다(앱 코드·빌드에는 영향 없음).
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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

const contract = (await import(new URL('./contract.ts', import.meta.url).href)) as typeof import('./contract')

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    id: 'req-abcdef12',
    turnId: 'turn-1',
    slot: '3.2',
    page: 'https://www.nongsaro.go.kr/portal/ps/psv/psvr/psvre/curationDtl.ps',
    images: ['https://www.nongsaro.go.kr/ps/img/curation/a.jpg'],
    ...over
  })

describe('parseFigureRequest', () => {
  it('계약 모양을 그대로 받는다', () => {
    const parsed = contract.parseFigureRequest(body())
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.request.slot, '3.2')
    assert.equal(parsed.request.images.length, 1)
  })

  it('모르는 필드가 하나라도 있으면 거절한다', () => {
    const parsed = contract.parseFigureRequest(body({ extra: 1 }))
    assert.deepEqual(parsed, { ok: false, reason: 'shape' })
  })

  it('필드가 빠져도 거절한다', () => {
    const raw = JSON.parse(body()) as Record<string, unknown>
    delete raw.turnId
    assert.deepEqual(contract.parseFigureRequest(JSON.stringify(raw)), { ok: false, reason: 'shape' })
  })

  it('JSON이 아니면 json', () => {
    assert.deepEqual(contract.parseFigureRequest('not json'), { ok: false, reason: 'json' })
    assert.deepEqual(contract.parseFigureRequest('[]'), { ok: false, reason: 'shape' })
  })

  it('판이 다르면 version', () => {
    assert.deepEqual(contract.parseFigureRequest(body({ v: 2 })), { ok: false, reason: 'version' })
  })

  it('id 정규식 — 8~64자 영숫자·_·-', () => {
    assert.equal(contract.parseFigureRequest(body({ id: 'short' })).ok, false)
    assert.equal(contract.parseFigureRequest(body({ id: 'a'.repeat(65) })).ok, false)
    assert.equal(contract.parseFigureRequest(body({ id: '../escape01' })).ok, false)
    assert.equal(contract.parseFigureRequest(body({ id: 'a'.repeat(64) })).ok, true)
  })

  it('slot은 경로 문자를 허용하지 않는다', () => {
    assert.deepEqual(contract.parseFigureRequest(body({ slot: '..' })), { ok: false, reason: 'slot' })
    assert.deepEqual(contract.parseFigureRequest(body({ slot: 'a/b' })), { ok: false, reason: 'slot' })
    assert.equal(contract.parseFigureRequest(body({ slot: 'sec-1.a_b' })).ok, true)
  })

  it('그림은 1~3장', () => {
    assert.deepEqual(contract.parseFigureRequest(body({ images: [] })), { ok: false, reason: 'images' })
    assert.deepEqual(
      contract.parseFigureRequest(body({ images: ['https://a.example/1.jpg', 'https://a.example/2.jpg', 'https://a.example/3.jpg', 'https://a.example/4.jpg'] })),
      { ok: false, reason: 'images' }
    )
    assert.equal(contract.parseFigureRequest(body({ images: ['https://a.example/1.jpg', '', ''] })).ok, false)
  })

  it('승인 토큰은 앱이 붙이는 이름 하나', () => {
    assert.equal(contract.figureToken('ab'.repeat(32)), `app-figure:${'ab'.repeat(32)}`)
  })
})
