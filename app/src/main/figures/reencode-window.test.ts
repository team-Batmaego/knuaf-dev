import type * as reencodeTypes from './reencode-window'
/**
 * figures/reencode-window.test.ts — 재인코딩 경계 (설계 R4-5, C-06).
 *
 * Electron 창은 단위 시험에서 만들 수 없으므로 `decode` 대역으로 계약만 검사한다: 빈 바이트·디코더
 * 실패·시간 초과·빈 출력. 실제 창 경로(네트워크 차단·sandbox)는 앱 e2e에서만 확인 가능하다.
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

const reencode = (await import(new URL('./reencode-window.ts', import.meta.url).href)) as typeof import('./reencode-window')

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
const okDecoder: reencodeTypes.ImageDecoder = async () => ({ png, width: 10, height: 8 })

describe('reencodeToPng', () => {
  it('디코더 출력을 그대로 PNG로 돌려준다', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1, 2, 3]), { decode: okDecoder })
    assert.deepEqual(result, { ok: true, png, width: 10, height: 8 })
  })

  it('빈 바이트는 디코더를 부르지 않고 empty', async () => {
    let called = false
    const result = await reencode.reencodeToPng(new Uint8Array(0), {
      decode: async () => {
        called = true
        return { png, width: 1, height: 1 }
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'empty' })
    assert.equal(called, false)
  })

  it('디코더가 던지면 decode', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      decode: async () => {
        throw new Error('chromium refused')
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'decode' })
  })

  it('빈 PNG를 돌려주면 decode', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      decode: async () => ({ png: new Uint8Array(0), width: 1, height: 1 })
    })
    assert.deepEqual(result, { ok: false, reason: 'decode' })
  })

  it('시간을 넘기면 timeout — 신호를 무시하는 디코더라도 부름쪽은 풀린다', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      timeoutMs: 20,
      decode: () => new Promise(() => {})
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
  })

  // I-3: 상한이 오면 디코더에게 중단 신호가 간다 — Electron 쪽이 창과 렌더러를 정리할 수 있는 유일한 통로.
  it('상한이 오면 디코더의 신호가 abort된다', async () => {
    const seen = Promise.withResolvers<AbortSignal>()
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      timeoutMs: 20,
      decode: (_bytes, _timeoutMs, signal) => {
        if (signal) seen.resolve(signal)
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('decode aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
    assert.equal((await seen.promise).aborted, true)
  })

  it('디코더가 AbortError로 거절하면 timeout', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      decode: async () => {
        const error = new Error('renderer torn down')
        error.name = 'AbortError'
        throw error
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
  })

  it('디코더가 다른 오류로 거절하면 decode', async () => {
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      decode: async () => {
        throw new Error('render-process-gone')
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'decode' })
  })

  it('성공하면 신호를 닫고 timeout 사유로 덮어쓰지 않는다', async () => {
    // 큰 상한에서 성공한 뒤 타이머가 늦게 발화해도 결과는 성공이어야 한다(settle은 한 번만).
    let signal: AbortSignal | undefined
    const result = await reencode.reencodeToPng(Uint8Array.from([1]), {
      timeoutMs: 10_000,
      decode: async (_bytes, _timeoutMs, given) => {
        signal = given
        return { png, width: 10, height: 8 }
      }
    })
    assert.equal(result.ok, true)
    // `finally`가 신호를 닫는다 — 남은 리스너가 다음 일에 걸리지 않게.
    assert.equal(signal?.aborted, true)
  })
})
