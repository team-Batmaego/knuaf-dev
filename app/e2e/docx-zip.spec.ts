import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import { checkDocxZip } from '../src/main/docx-zip'

async function archive(entries: number, content: Uint8Array | string = ''): Promise<Uint8Array> {
  const zip = new JSZip()
  for (let i = 0; i < entries; i++) zip.file(`word/part-${i}.xml`, content)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function findSignature(bytes: Uint8Array, signature: number): number {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if ((bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24) >>> 0 === signature) return i
  }
  return -1
}
async function archiveWithSplitEocd(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('word/document.xml', 'trusted document')
  zip.file('customXml/blob.bin', 'alternate document')
  const ordinary = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  const eocd = findSignature(ordinary, 0x06054b50)
  const count = ordinary.readUInt16LE(eocd + 10)
  let offset = ordinary.readUInt32LE(eocd + 16)
  let blob: Buffer | null = null
  for (let i = 0; i < count; i++) {
    const nameLength = ordinary.readUInt16LE(offset + 28)
    const extraLength = ordinary.readUInt16LE(offset + 30)
    const commentLength = ordinary.readUInt16LE(offset + 32)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (ordinary.toString('utf8', offset + 46, offset + 46 + nameLength) === 'customXml/blob.bin') {
      blob = Buffer.from(ordinary.subarray(offset, end))
    }
    offset = end
  }
  if (!blob) throw new Error('Expected stored blob entry')
  const oldNameLength = blob.readUInt16LE(28)
  const alternate = Buffer.from('word/document.xml')
  blob.writeUInt16LE(alternate.length, 28)
  const fakeCentral = Buffer.concat([blob.subarray(0, 46), alternate, blob.subarray(46 + oldNameLength)])
  const prefix = Buffer.from(ordinary.subarray(0, eocd + 22))
  prefix.writeUInt16LE(fakeCentral.length + 23, eocd + 20)
  const fakeEocd = Buffer.alloc(22)
  fakeEocd.writeUInt32LE(0x06054b50, 0)
  fakeEocd.writeUInt16LE(1, 8)
  fakeEocd.writeUInt16LE(1, 10)
  fakeEocd.writeUInt32LE(fakeCentral.length, 12)
  fakeEocd.writeUInt32LE(prefix.length, 16)
  return Buffer.concat([prefix, fakeCentral, fakeEocd, Buffer.from([0])])
}

test('DOCX ZIP preflight rejects the last EOCD when it points at a second directory', async () => {
  const split = await archiveWithSplitEocd()
  expect(checkDocxZip(split)).toEqual({ ok: false, reason: 'format' })
  const rendererArchive = await JSZip.loadAsync(split)
  expect(rendererArchive.file('word/document.xml')).toBeNull()
  const alternate = rendererArchive.file('customXml/blob.bin')
  expect(alternate).not.toBeNull()
  expect(await alternate!.async('string')).toBe('alternate document')
})

test('DOCX ZIP preflight measures actual inflation, not only declared size', async () => {
  const inflated = new Uint8Array(50 * 1024 * 1024 + 1)
  const compressed = Buffer.from(await archive(1, inflated))
  expect(compressed.byteLength).toBeLessThan(1024 * 1024)
  expect(checkDocxZip(compressed)).toEqual({ ok: false, reason: 'too_large' })

  const understated = Buffer.from(compressed)
  const eocd = understated.length - 22
  const central = understated.readUInt32LE(eocd + 16)
  understated.writeUInt32LE(1, central + 24)
  expect(checkDocxZip(understated)).toMatchObject({ ok: false })
})

test('DOCX ZIP preflight accepts ordinary archives and enforces central entry count', async () => {
  expect(checkDocxZip(await archive(1, '<w:document/>'))).toEqual({ ok: true })
  expect(checkDocxZip(await archive(501))).toEqual({ ok: false, reason: 'too_large' })
})


test('DOCX ZIP preflight rejects encryption, Zip64 sentinels and unknown compression', async () => {
  const ordinary = Buffer.from(await archive(1, 'text'))
  const central = findSignature(ordinary, 0x02014b50)
  const eocd = findSignature(ordinary, 0x06054b50)
  expect(central).toBeGreaterThan(0)
  expect(eocd).toBeGreaterThan(central)

  const encrypted = Buffer.from(ordinary)
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6)
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8)
  expect(checkDocxZip(encrypted)).toEqual({ ok: false, reason: 'format' })

  const zip64 = Buffer.from(ordinary)
  zip64.writeUInt16LE(0xffff, eocd + 8)
  expect(checkDocxZip(zip64)).toEqual({ ok: false, reason: 'format' })

  const unknownMethod = Buffer.from(ordinary)
  unknownMethod.writeUInt16LE(99, 8)
  unknownMethod.writeUInt16LE(99, central + 10)
  expect(checkDocxZip(unknownMethod)).toEqual({ ok: false, reason: 'format' })
})
