/**
 * figures/image-header.ts — 바이트 **머리만** 읽어 형식·크기·프레임 수를 확인한다 (설계 §4-5, C-06).
 *
 * 디코딩은 여기서 하지 않는다(디코딩은 네트워크 없는 숨김 창이 한다 — R4-5). 여기서 걸러야 하는
 * 두 가지: ① 받아들일 형식인가(JPEG·PNG·GIF만 — python-docx가 넣을 수 있는 것) ② 헤더가 주장하는
 * 화소가 상한을 넘는가(거대 캔버스로 메모리를 터뜨리는 그림 폭탄). 매직과 헤더가 서로 어긋나면
 * 거절한다 — 확장자나 Content-Type은 신뢰하지 않는다.
 */

/** 5,000만 화소 상한(설계 §4-5). */
export const MAX_PIXELS = 50_000_000

export type ImageFormat = 'jpeg' | 'png' | 'gif'

export type SniffProblem = 'format' | 'truncated' | 'pixels' | 'frames' | 'malformed'

export type SniffResult =
  | { ok: true; format: ImageFormat; width: number; height: number; frames: number }
  | { ok: false; reason: SniffProblem }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}

/** 바이트 머리에서 형식과 크기를 읽는다. 잘린 머리는 `truncated`. */
export function sniffImage(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, PNG_SIGNATURE)) return sniffPng(bytes)
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return sniffGif(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return sniffJpeg(bytes)
  return { ok: false, reason: 'format' }
}

function checkPixels(width: number, height: number, frames: number): SniffProblem | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return 'malformed'
  // 프레임을 합쳐 셈한다 — GIF를 풀면 프레임만큼 화소가 필요하다.
  if (width * height * Math.max(1, frames) > MAX_PIXELS) return 'pixels'
  return null
}

function sniffPng(bytes: Uint8Array): SniffResult {
  // IHDR는 첫 청크여야 한다: 길이(4) + 'IHDR'(4) + 폭(4) + 높이(4).
  if (bytes.length < 24) return { ok: false, reason: 'truncated' }
  if (!(bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52)) {
    return { ok: false, reason: 'malformed' }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  const problem = checkPixels(width, height, 1)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, format: 'png', width, height, frames: 1 }
}

function sniffGif(bytes: Uint8Array): SniffResult {
  if (bytes.length < 13) return { ok: false, reason: 'truncated' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (width <= 0 || height <= 0) return { ok: false, reason: 'malformed' }
  // 화소 상한은 프레임 수를 센 뒤 다시 본다.
  if (width * height > MAX_PIXELS) return { ok: false, reason: 'pixels' }
  const frames = countGifFrames(bytes)
  if (frames === null) return { ok: false, reason: 'malformed' }
  if (frames > 1) return { ok: false, reason: 'frames' }
  return { ok: true, format: 'gif', width, height, frames }
}

/**
 * GIF 구조를 걸어 이미지 서술자 수를 센다. 블록을 건너뛰며 걷다가 끝을 못 만나면 null
 * (잘렸거나 거짓 구조 — 어느 쪽이든 받지 않는다).
 */
function countGifFrames(bytes: Uint8Array): number | null {
  let offset = 13
  const header = bytes[10] as number
  if (header & 0x80) offset += 3 * 2 ** ((header & 0x07) + 1) // 전역 색표
  let frames = 0
  while (offset < bytes.length) {
    const marker = bytes[offset] as number
    if (marker === 0x3b) return frames // 꼬리표
    if (marker === 0x21) {
      // 확장 블록: 이름 1바이트 + 하위 블록들
      offset += 2
      const skipped = skipGifSubBlocks(bytes, offset)
      if (skipped === null) return null
      offset = skipped
      continue
    }
    if (marker === 0x2c) {
      // 이미지 서술자: 9바이트 + (선택) 국소 색표 + LZW 하위 블록들
      if (offset + 10 > bytes.length) return null
      frames += 1
      const flags = bytes[offset + 9] as number
      offset += 10
      if (flags & 0x80) offset += 3 * 2 ** ((flags & 0x07) + 1)
      offset = skipGifSubBlocks(bytes, offset) ?? -1
      if (offset < 0) return null
      continue
    }
    return null
  }
  return null
}

/** 길이-접두 하위 블록들을 건너뛰고 다음 블록 위치를 돌려준다. 0 길이가 끝. */
function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start
  for (;;) {
    if (offset >= bytes.length) return null
    const size = bytes[offset] as number
    offset += 1
    if (size === 0) return offset
    offset += size
  }
}

function sniffJpeg(bytes: Uint8Array): SniffResult {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return { ok: false, reason: 'malformed' }
    // 0xFF 채움 바이트는 건너뛴다.
    let marker = bytes[offset + 1] as number
    let markerAt = offset + 1
    while (marker === 0xff) {
      markerAt += 1
      marker = bytes[markerAt] as number
      if (markerAt >= bytes.length) return { ok: false, reason: 'truncated' }
    }
    offset = markerAt + 1
    // 길이 없는 표지들
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (offset + 1 >= bytes.length) return { ok: false, reason: 'truncated' }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const length = view.getUint16(offset, false)
    if (length < 2) return { ok: false, reason: 'malformed' }
    // SOF0~SOF15 중 DHT(C4)·JPG(C8)·DAC(CC)는 크기 표지가 아니다.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 7 >= bytes.length) return { ok: false, reason: 'truncated' }
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const problem = checkPixels(width, height, 1)
      if (problem) return { ok: false, reason: problem }
      return { ok: true, format: 'jpeg', width, height, frames: 1 }
    }
    offset += length
  }
  return { ok: false, reason: 'truncated' }
}
