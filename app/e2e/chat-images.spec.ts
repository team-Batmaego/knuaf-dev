import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mock } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatImages } from '../src/main/chat/images'
import { animatedPng } from '../src/main/figures/fixtures/png-samples'
import { CHAT_IMAGE_COPY, CHAT_IMAGE_LIMITS, type ChatImageReply } from '../src/shared/chat-image'

const first = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=', 'base64')
const second = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function idOf(reply: ChatImageReply): string {
  expect(reply.kind).toBe('image')
  if (reply.kind !== 'image') throw new TypeError(`Expected an image chip, got ${reply.kind}`)
  return reply.chip.id
}

for (const change of ['contents', 'parent', 'deleted'] as const) {
  test(`T-${{ contents: 1, parent: 2, deleted: 3 }[change]} snapshot survives ${change} after attachment`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'chat-image-'))
    const scope = { root, visit: 1 }
    const images = new ChatImages(() => scope, async () => 'data:image/png;base64,preview')
    const folder = join(root, 'picked')
    const other = join(root, 'other')
    const path = join(folder, 'capture.png')
    const expected = createHash('sha256').update(first).digest('hex')
    try {
      fs.mkdirSync(folder)
      fs.writeFileSync(path, first)
      const id = idOf(await images.fromDrop(scope, path))
      if (change === 'contents') fs.writeFileSync(path, second)
      if (change === 'parent') {
        fs.mkdirSync(other)
        fs.writeFileSync(join(other, 'capture.png'), second)
        fs.renameSync(folder, join(root, 'former'))
        fs.symlinkSync(other, folder, 'junction')
      }
      if (change === 'deleted') fs.unlinkSync(path)
      else {
        // Control: reading that path at send time really would supply different bytes.
        const reopened = fs.readFileSync(path)
        expect(reopened).toEqual(second)
        expect(createHash('sha256').update(reopened).digest('hex')).not.toBe(expected)
      }
      const batch = images.resolve(root, [id])
      batch.accept()
      expect(createHash('sha256').update(batch.images[0].image.bytes).digest('hex')).toBe(expected)
      expect(batch.images[0].receipt).toEqual({ name: 'capture.png', mime: 'image/png', size: first.length, sha256: expected })
    } finally {
      images.clear()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('T-4 resolving and accepting a ticket opens and reads no files', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'chat-no-reread-'))
  const scope = { root, visit: 1 }
  const images = new ChatImages(() => scope, async () => 'data:image/png;base64,preview')
  try {
    const path = join(root, 'capture.png')
    fs.writeFileSync(path, first)
    const id = idOf(await images.fromDrop(scope, path))
    const counters = [mock.method(fs, 'openSync'), mock.method(fs, 'readFileSync'), mock.method(fs, 'readSync'),
      mock.method(fs.promises, 'open'), mock.method(fs.promises, 'readFile')]
    let reads: number
    try {
      const batch = images.resolve(root, [id])
      batch.accept()
      reads = counters.reduce((total, fn) => total + fn.mock.callCount(), 0)
    } finally { mock.restoreAll() }
    expect(reads).toBe(0)
  } finally {
    images.clear()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('T-6 rejects unissued, path, duplicate, stale, expired and excessive tickets', async () => {
  let scope = { root: '/paper', visit: 1 }
  const images = new ChatImages(() => scope, async () => 'data:image/png;base64,preview')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const id = idOf(await images.fromPaste(scope, first))
    for (const ids of [[crypto.randomUUID()], ['/outside/capture.png'], [id, id], Array(5).fill(id)]) {
      expect(() => images.resolve(scope.root, ids)).toThrow()
    }
    const pending = images.resolve(scope.root, [id])
    scope = { root: scope.root, visit: 2 }
    expect(() => pending.accept()).toThrow(CHAT_IMAGE_COPY.changed)
    expect(() => images.resolve(scope.root, [id])).toThrow(CHAT_IMAGE_COPY.reattach)
    const fresh = idOf(await images.fromPaste(scope, first))
    const waiting = images.resolve(scope.root, [fresh])
    mock.timers.tick(CHAT_IMAGE_LIMITS.idleMs)
    expect(() => images.resolve(scope.root, [fresh])).toThrow(CHAT_IMAGE_COPY.reattach)
    expect(() => waiting.accept()).toThrow(CHAT_IMAGE_COPY.reattach)
  } finally {
    images.clear()
    mock.timers.reset()
  }
})

test('T-6 only valid images get tickets and the draft is bounded to four', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'chat-image-limits-'))
  const scope = { root, visit: 1 }
  const images = new ChatImages(() => scope, async () => 'data:image/png;base64,preview')
  try {
    const file = join(root, '논문.hwpx')
    fs.writeFileSync(file, 'not an image')
    expect(await images.fromDrop(scope, file)).toEqual({ kind: 'file', path: file })
    const huge = Buffer.alloc(CHAT_IMAGE_LIMITS.bytes + 1)
    first.copy(huge)
    const hugePath = join(root, 'large.png')
    fs.writeFileSync(hugePath, huge)
    const wide = Buffer.from(first)
    wide.writeUInt32BE(8001, 16)
    expect(await images.fromDrop(scope, hugePath)).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.size })
    expect(await images.fromPaste(scope, huge)).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.size })
    expect(await images.fromPaste(scope, wide)).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.size })
    expect(await images.fromPaste(scope, Buffer.from('not an image'))).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.format })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(idOf(await images.fromPaste(scope, first)))
    expect(await images.fromPaste(scope, first)).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.count })
    const batch = images.resolve(scope.root, ids)
    batch.accept()
    expect(() => images.resolve(scope.root, ids)).toThrow(CHAT_IMAGE_COPY.reattach)
  } finally {
    images.clear()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('I-02 chat accepts the original APNG while using a still preview', async () => {
  const scope = { root: '/paper', visit: 1 }
  const images = new ChatImages(() => scope, async () => 'data:image/png;base64,preview')
  try {
    const chipId = idOf(await images.fromPaste(scope, animatedPng))
    const { image } = images.resolve(scope.root, [chipId]).images[0]
    expect(image).toEqual({ mime: 'image/png', bytes: animatedPng })
  } finally {
    images.clear()
  }
})

test('a file picker returning to a different visit never previews or issues the selection', async () => {
  const scope = { root: '/paper', visit: 1 }
  let now = scope
  const images = new ChatImages(() => now, async () => { throw new Error('stale preview') })
  const picked = Promise.withResolvers<string>()
  const result = images.fromPicker(scope, () => picked.promise)
  now = { ...scope, visit: 2 }
  picked.resolve('/paper/capture.png')
  expect(await result).toEqual({ kind: 'error', message: CHAT_IMAGE_COPY.changed })
})
