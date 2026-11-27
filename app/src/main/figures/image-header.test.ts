/**
 * figures/image-header.test.ts — 머리만 보고 형식·화소·프레임을 가른다 (설계 §4-5, C-06).
 *
 * 경계 조건은 손으로 만든 헤더를, GIF 회귀는 실제 그림 바이트를 쓴다.
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
const { animatedPng, staticPng } = await import('./fixtures/png-samples')

// GIF87a: 보관된 맥 실행 자리 표본. 전역 색표, 200×120, 한 프레임.
const gif87a = Buffer.from(
  'R0lGODdhyAB4AIEAAB4eyAAAAAAAAAAAACwAAAAAyAB4AEAI+QABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPH' +
  'jyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavX' +
  'r2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPn' +
  'z6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169izaw8cEAA7',
  'base64'
)
// GIF89a: FFmpeg로 만든 8×6 단색 한 프레임. 그래픽 제어 확장과 국소 색표를 사용한다.
const gif89a = Buffer.from(
  'R0lGODlhCAAGAHAQMSH5BARkAB8ALAAAAAAIAAYAhwAAAAAA/wBVAABV/wCqAACq/wD/AAD///8AAP8A//9VAP9V//+qAP+q' +
  '////AP////4AAP4A//5VAP5V//6qAP6q//7/AP7///0AAP0A//1VAP1V//2qAP2q//3/AP3///wAAPwA//xVAPxV//yqAPyq' +
  '//z/APz///sAAPsA//tVAPtV//uqAPuq//v/APv///oAAPoA//pVAPpV//qqAPqq//r/APr///kAAPkA//lVAPlV//mqAPmq' +
  '//n/APn///gAAPgA//hVAPhV//iqAPiq//j/APj///cAAPcA//dVAPdV//eqAPeq//f/APf///YAAPYA//ZVAPZV//aqAPaq' +
  '//b/APb///UAAPUA//VVAPVV//WqAPWq//X/APX///QAAPQA//RVAPRV//SqAPSq//T/APT///MAAPMA//NVAPNV//OqAPOq' +
  '//P/APP///IAAPIA//JVAPJV//KqAPKq//L/APL///EAAPEA//FVAPFV//GqAPGq//H/APH///AAAPAA//BVAPBV//CqAPCq' +
  '//D/APD//+8AAO8A/+9VAO9V/++qAO+q/+//AO///+4AAO4A/+5VAO5V/+6qAO6q/+7/AO7//+0AAO0A/+1VAO1V/+2qAO2q' +
  '/+3/AO3//+wAAOwA/+xVAOxV/+yqAOyq/+z/AOz//+sAAOsA/+tVAOtV/+uqAOuq/+v/AOv//+oAAOoA/+pVAOpV/+qqAOqq' +
  '/+r/AOr//+kAAOkA/+lVAOlV/+mqAOmq/+n/AOn//+gAAOgA/+hVAOhV/+iqAOiq/+j/AOj//+cAAOcA/+dVAOdV/+eqAOeq' +
  '/+f/AOf//+YAAOYA/+ZVAOZV/+aqAOaq/+b/AOb//+UAAOUA/+VVAOVV/+WqAOWq/+X/AOX//+QAAOQA/+RVAORV/+SqAOSq' +
  '/+T/AOT//+MAAOMA/+NVAONV/+OqAOOq/+P/AOP//+IAAOIA/+JVAOJV/+KqAOKq/+L/AOL//+EAAOEA/+FVAOFV/+GqAOGq' +
  '/+H/AOH//wgPABEIHEiwoMGBAA4qVBgQADs=',
  'base64'
)

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

/** 논리 화면 10×10에 1×1 프레임을 반복해 애니메이션 판정을 시험한다. */
function animatedGif(frames: number): Uint8Array {
  const parts = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
  for (let i = 0; i < frames; i += 1) {
    parts.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0) // 서술자, 최소 코드 크기, LZW 데이터 블록, 종료
  }
  parts.push(0x3b)
  return Uint8Array.from(parts)
}

/** SOI + APP0(길이 4) + SOF0 만든 것. `width`/`height`는 SOF 안에. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const parts: number[] = [0xff, 0xd8]
  parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00) // APP0, 길이 4
  parts.push(0xff, sof, 0x00, 0x11, 0x08)
  parts.push((height >> 8) & 0xff, height & 0xff)
  parts.push((width >> 8) & 0xff, width & 0xff)
  parts.push(0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9)
  return Uint8Array.from(parts)
}

describe('sniffImage', () => {
  it('PNG·JPEG를 형식과 크기까지 읽는다', () => {
    assert.deepEqual(header.sniffImage(png(640, 480)), { ok: true, format: 'png', width: 640, height: 480, frames: 1 })
    assert.deepEqual(header.sniffImage(jpeg(1024, 768)), { ok: true, format: 'jpeg', width: 1024, height: 768, frames: 1 })
  })

  for (const [version, bytes, width, height] of [
    ['GIF87a', gif87a, 200, 120],
    ['GIF89a', gif89a, 8, 6]
  ] as const) {
    it(`실제 단일 프레임 ${version}의 형식과 크기를 읽는다`, () => {
      assert.deepEqual(header.sniffImage(bytes), { ok: true, format: 'gif', width, height, frames: 1 })
    })
  }

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

  it('I-02 실제 APNG에서 선언된 애니메이션 프레임 수를 읽는다', () => {
    assert.deepEqual(header.sniffImage(animatedPng), { ok: true, format: 'png', width: 3, height: 2, frames: 2 })
  })

  it('I-02 PNG 청크 데이터 안의 acTL 텍스트는 청크가 아니다', () => {
    const comment = Buffer.from('0000000c74455874436f6d6d656e74006163544cc6ecfa0d', 'hex')
    const bytes = Buffer.concat([staticPng.subarray(0, 33), comment, staticPng.subarray(33)])
    assert.deepEqual(header.sniffImage(bytes), { ok: true, format: 'png', width: 3, height: 2, frames: 1 })
  })

  for (const [description, bytes, reason] of [
    ['프레임 수 0', Buffer.concat([animatedPng.subarray(0, 41), Buffer.alloc(4), animatedPng.subarray(45)]), 'malformed'],
    ['잘못된 청크 길이 7', Buffer.concat([animatedPng.subarray(0, 33), Buffer.from([0, 0, 0, 7]), animatedPng.subarray(37)]), 'malformed'],
    ['중복 acTL', Buffer.concat([animatedPng.subarray(0, 53), animatedPng.subarray(33, 53), animatedPng.subarray(53)]), 'malformed'],
    ['버퍼를 넘는 acTL', animatedPng.subarray(0, 52), 'truncated'],
    ['IDAT 뒤 acTL', Buffer.concat([staticPng.subarray(0, -12), animatedPng.subarray(33, 53), staticPng.subarray(-12)]), 'malformed']
  ] as const) {
    it(`I-02 APNG ${description}을 ${reason}로 거절한다`, () => {
      assert.deepEqual(header.sniffImage(bytes), { ok: false, reason })
    })
  }

  for (const length of [0, 12, 14]) {
    it(`I-03 IHDR 길이 ${length}인 PNG는 malformed`, () => {
      const bytes = Buffer.from(staticPng)
      bytes.writeUInt32BE(length, 8)
      assert.deepEqual(header.sniffImage(bytes), { ok: false, reason: 'malformed' })
    })
  }

  it('잘린 머리는 truncated', () => {
    assert.deepEqual(header.sniffImage(png(10, 10).slice(0, 20)), { ok: false, reason: 'truncated' })
    assert.deepEqual(header.sniffImage(gif87a.subarray(0, 10)), { ok: false, reason: 'truncated' })
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
    assert.deepEqual(header.sniffImage(animatedGif(2)), { ok: false, reason: 'frames' })
  })

  it('실제 GIF의 LZW 데이터 블록이 잘리면 malformed', () => {
    const broken = gif87a.subarray(0, -3) // 마지막 압축 바이트, 블록 종료 바이트, 꼬리표를 제거한다.
    assert.deepEqual(header.sniffImage(broken), { ok: false, reason: 'malformed' })
  })

  for (const [description, hex] of [
    ['첫 데이터 블록이 비어 있음', '4749463839610a000a00800000000000ffffff2c00000000010001000002003b'],
    ['LZW 최소 코드 크기 0', '4749463839610a000a00800000000000ffffff2c00000000010001000000024401003b'],
    ['LZW 최소 코드 크기 9', '4749463839610a000a00800000000000ffffff2c00000000010001000009024401003b']
  ] as const) {
    it(`I-01 GIF ${description}은 malformed`, () => {
      assert.deepEqual(header.sniffImage(Buffer.from(hex, 'hex')), { ok: false, reason: 'malformed' })
    })
  }

  it('JPEG의 DHT 표지를 SOF로 오해하지 않는다', () => {
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]
    const frame = jpeg(32, 16).subarray(8)
    const parts = [0xff, 0xd8, ...dht, ...frame]
    assert.deepEqual(header.sniffImage(Uint8Array.from(parts)), { ok: true, format: 'jpeg', width: 32, height: 16, frames: 1 })
  })

  it('JPEG 세그먼트가 0xFF로 시작하지 않으면 malformed', () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x12, 0x00, 0x02, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00])
    assert.deepEqual(header.sniffImage(bytes), { ok: false, reason: 'malformed' })
  })

  it('I-04 프로그레시브 JPEG SOF2 치수를 읽는다', () => {
    assert.deepEqual(header.sniffImage(jpeg(37, 23, 0xc2)), { ok: true, format: 'jpeg', width: 37, height: 23, frames: 1 })
  })

  for (const [description, bytes, reason] of [
    ['최소 길이보다 짧은 일반 세그먼트', Buffer.from('ffd8ffe00001ffff', 'hex'), 'malformed'],
    ['버퍼를 넘는 일반 세그먼트', Buffer.from('ffd8ffe0ffff0000', 'hex'), 'truncated'],
    ['선언 범위 밖에 치수가 있는 SOF', Buffer.from('ffd8ffc00002080017002503000000000000000000', 'hex'), 'malformed'],
    ['성분이 없는 SOF', Buffer.from('ffd8ffc00008080017002500', 'hex'), 'malformed'],
    ['선언 길이와 성분 수가 다른 SOF', Buffer.from('ffd8ffc0000b080017002503011100', 'hex'), 'malformed'],
    ['성분 목록이 잘린 SOF', jpeg(37, 23).subarray(0, -3), 'truncated']
  ] as const) {
    it(`I-04 JPEG ${description}를 ${reason}로 거절한다`, () => {
      assert.deepEqual(header.sniffImage(bytes), { ok: false, reason })
    })
  }
})
