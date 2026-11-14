/**
 * figures/image-header.test.ts — 머리만 보고 형식·화소·프레임을 가른다 (설계 §4-5, C-06).
 *
 * 시험은 실제 파일이 아니라 **손으로 만든 머리 바이트**를 쓴다. 우리가 보는 것은 머리뿐이므로
 * 완전한 이미지가 필요 없고, 픽셀 폭탄·거짓 매직·잘린 머리를 만들기 쉽다.
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

const header = (await import(new URL('./image-header.ts', import.meta.url).href)) as typeof import('./image-header')

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8) // IHDR 길이
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

/** 이미지 서술자 `frames`개를 가진 GIF. 하위 블록은 1바이트 사설(garbage)로 닫는다. */
function gif(width: number, height: number, frames = 1): Uint8Array {
  const parts: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
  parts.push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x00)
  for (let i = 0; i < frames; i += 1) {
    parts.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x00) // 서술자 + 0길이 LZW
  }
  parts.push(0x3b)
  return Uint8Array.from(parts)
}

/** SOI + APP0(길이 4) + SOF0 만든 것. `width`/`height`는 SOF 안에. */
function jpeg(width: number, height: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8]
  parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00) // APP0, 길이 4
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08)
  parts.push((height >> 8) & 0xff, height & 0xff)
  parts.push((width >> 8) & 0xff, width & 0xff)
  parts.push(0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9)
  return Uint8Array.from(parts)
}

describe('sniffImage', () => {
  it('PNG·GIF·JPEG를 형식과 크기까지 읽는다', () => {
    assert.deepEqual(header.sniffImage(png(640, 480)), { ok: true, format: 'png', width: 640, height: 480, frames: 1 })
    assert.deepEqual(header.sniffImage(gif(120, 90)), { ok: true, format: 'gif', width: 120, height: 90, frames: 1 })
    assert.deepEqual(header.sniffImage(jpeg(1024, 768)), { ok: true, format: 'jpeg', width: 1024, height: 768, frames: 1 })
  })

  it('매직만 흉내 낸 다른 형식은 받지 않는다', () => {
    // webp(RIFF)·bmp·svg·빈 바이트
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    assert.deepEqual(header.sniffImage(webp), { ok: false, reason: 'format' })
    assert.deepEqual(header.sniffImage(new Uint8Array(0)), { ok: false, reason: 'format' })
    assert.deepEqual(header.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), {
      ok: false,
      reason: 'format'
    })
  })

  it('PNG 매직 뒤가 IHDR이 아니면 malformed', () => {
    const bytes = png(10, 10)
    bytes.set([0x49, 0x44, 0x41, 0x54], 12) // 'IDAT'
    assert.deepEqual(header.sniffImage(bytes), { ok: false, reason: 'malformed' })
  })

  it('잘린 머리는 truncated', () => {
    assert.deepEqual(header.sniffImage(png(10, 10).slice(0, 20)), { ok: false, reason: 'truncated' })
    assert.deepEqual(header.sniffImage(gif(10, 10).slice(0, 10)), { ok: false, reason: 'truncated' })
    assert.deepEqual(header.sniffImage(jpeg(10, 10).slice(0, 6)), { ok: false, reason: 'truncated' })
  })

  it('화소 폭탄(>5000만)은 pixels', () => {
    assert.equal(header.sniffImage(png(10_000, 10_000)).ok, false)
    assert.deepEqual(header.sniffImage(png(10_000, 10_000)), { ok: false, reason: 'pixels' })
    assert.deepEqual(header.sniffImage(png(7072, 7072)), { ok: false, reason: 'pixels' }) // 50,013,184
    assert.deepEqual(header.sniffImage(jpeg(20_000, 20_000)), { ok: false, reason: 'pixels' })
  })

  it('상한 바로 아래는 통과한다', () => {
    // 7071×7071 = 49,999,041
    assert.equal(header.sniffImage(png(7071, 7071)).ok, true)
  })

  it('여러 프레임 GIF는 frames', () => {
    assert.deepEqual(header.sniffImage(gif(10, 10, 2)), { ok: false, reason: 'frames' })
  })

  it('GIF 구조가 끝을 못 만들면 malformed', () => {
    const broken = gif(10, 10).slice(0, -1) // 꼬리표(0x3b) 제거
    assert.deepEqual(header.sniffImage(broken), { ok: false, reason: 'malformed' })
  })

  it('JPEG의 DHT 표지를 SOF로 오해하지 않는다', () => {
    const parts: number[] = [0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20]
    parts.push(0x01, 0x01, 0x11, 0x00, 0xff, 0xd9)
    assert.deepEqual(header.sniffImage(Uint8Array.from(parts)), { ok: true, format: 'jpeg', width: 32, height: 16, frames: 1 })
  })

  it('JPEG 세그먼트가 0xFF로 시작하지 않으면 malformed', () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x12, 0x00, 0x02, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00])
    assert.deepEqual(header.sniffImage(bytes), { ok: false, reason: 'malformed' })
  })
})
