import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export type DocxZipCheck = { ok: true } | { ok: false; reason: 'format' | 'corrupt' | 'too_large' }

/** Verify the exact archive bytes the renderer will parse, bounding actual inflated output. */
export function checkDocxZip(bytes: Uint8Array, maxEntries = 500, maxTotal = 50 * 1024 * 1024): DocxZipCheck {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const min = Math.max(0, buf.length - 65_557)
  let eocd = -1
  for (let at = buf.length - 4; at >= min; at--) {
    if (buf.readUInt32LE(at) === EOCD) { eocd = at; break }
  }
  if (eocd < 0 || eocd + 22 > buf.length || eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) return { ok: false, reason: 'format' }
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const diskEntries = buf.readUInt16LE(eocd + 8)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  let offset = buf.readUInt32LE(eocd + 16)
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count || count === 0 || count === 0xffff || cdSize === 0xffffffff || offset === 0xffffffff) return { ok: false, reason: 'format' }
  if (count > maxEntries) return { ok: false, reason: 'too_large' }
  const cdEnd = offset + cdSize
  if (!Number.isSafeInteger(cdEnd) || cdEnd !== eocd || cdEnd > buf.length) return { ok: false, reason: 'corrupt' }

  let total = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > cdEnd || buf.readUInt32LE(offset) !== CENTRAL) return { ok: false, reason: 'corrupt' }
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const declaredSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > cdEnd || compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) return { ok: false, reason: 'format' }
    let at = offset + 46 + nameLength
    const centralExtraEnd = at + extraLength
    for (; at + 4 <= centralExtraEnd;) {
      const id = buf.readUInt16LE(at)
      const length = buf.readUInt16LE(at + 2)
      if (at + 4 + length > centralExtraEnd) return { ok: false, reason: 'corrupt' }
      if (id === 0x0001) return { ok: false, reason: 'format' }
      at += 4 + length
    }
    if (at !== centralExtraEnd) return { ok: false, reason: 'corrupt' }
    if (flags & ~0x080e || (method !== 0 && method !== 8)) return { ok: false, reason: 'format' }
    if (localOffset + 30 > offset || buf.readUInt32LE(localOffset) !== LOCAL) return { ok: false, reason: 'corrupt' }
    const localFlags = buf.readUInt16LE(localOffset + 6)
    const localMethod = buf.readUInt16LE(localOffset + 8)
    const localName = buf.readUInt16LE(localOffset + 26)
    const localExtra = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localName + localExtra
    const dataEnd = dataStart + compressedSize
    if (localFlags !== flags || localMethod !== method || localName !== nameLength || dataEnd > offset || !Number.isSafeInteger(dataEnd)) return { ok: false, reason: 'corrupt' }
    if (!buf.subarray(localOffset + 30, localOffset + 30 + localName).equals(buf.subarray(offset + 46, offset + 46 + nameLength))) return { ok: false, reason: 'corrupt' }
    at = localOffset + 30 + localName
    const localExtraEnd = at + localExtra
    for (; at + 4 <= localExtraEnd;) {
      const id = buf.readUInt16LE(at)
      const length = buf.readUInt16LE(at + 2)
      if (at + 4 + length > localExtraEnd) return { ok: false, reason: 'corrupt' }
      if (id === 0x0001) return { ok: false, reason: 'format' }
      at += 4 + length
    }
    if (at !== localExtraEnd) return { ok: false, reason: 'corrupt' }
    const packed = buf.subarray(dataStart, dataEnd)
    const budget = maxTotal - total
    let actual: number
    try {
      if (method === 0) actual = packed.length
      else actual = inflateRawSync(packed, { maxOutputLength: budget + 1 }).length
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, reason: 'too_large' }
      const msg = error instanceof Error ? error.message : String(error)
      if (/maxOutputLength|larger than/i.test(msg)) return { ok: false, reason: 'too_large' }
      return { ok: false, reason: 'corrupt' }
    }
    if (actual > budget) return { ok: false, reason: 'too_large' }
    if (actual !== declaredSize) return { ok: false, reason: 'corrupt' }
    total += actual
    offset = next
  }
  return offset === cdEnd ? { ok: true } : { ok: false, reason: 'corrupt' }
}
