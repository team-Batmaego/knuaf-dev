import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { CHAT_IMAGE_COPY, CHAT_IMAGE_LIMITS, type ChatImageChip, type ChatImageMime, type ChatImageReceipt, type ChatImageReply, type ImageScope } from '../../shared/chat-image'
import { insideByFileId } from '../file-identity'
import { imageMagicMatches } from '../paper-images/check'
import { sniffImage } from '../figures/image-header'

export type AgentImage = { readonly mime: ChatImageMime; readonly bytes: Buffer }
export type AttachedImage = { readonly receipt: ChatImageReceipt; readonly image: AgentImage }
export type ImageBatch = {
  readonly images: readonly AttachedImage[]
  readonly accept: () => void
  readonly current: () => boolean
}
export const IMAGE_REATTACH_GUIDE = '앞서 받은 그림이 지금 보이지 않으면 추측하지 말고 다시 붙여 달라고 하세요.'
export const IMAGE_TURN_GUIDE = `첨부 그림은 보는 용도로만 전달되어 파일로 저장되어 있지 않습니다. 이 그림을 논문에 넣으려면 학생에게 논문 폴더의 figures/에 넣어 달라고 안내하세요. ${IMAGE_REATTACH_GUIDE}`

const FORMATS = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const
const IMAGE_EXTENSIONS = /^(?:\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|svg|avif))$/i
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export class ChatImageError extends Error {
  constructor(readonly code: keyof typeof CHAT_IMAGE_COPY) { super(CHAT_IMAGE_COPY[code]) }
}

function sniffImageMime(head: Buffer): ChatImageMime | null {
  for (const [ext, mime] of Object.entries(FORMATS)) {
    if (imageMagicMatches(`attached.${ext}`, head)) return mime
  }
  return null
}

function checkDimensions(bytes: Buffer, mime: ChatImageMime): void {
  let width: number
  let height: number
  if (mime === 'image/webp') {
    // The three WebP bitstreams store their dimensions in different first chunks.
    if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new ChatImageError('format')
    const chunk = bytes.toString('ascii', 12, 16)
    const size = bytes.readUInt32LE(16)
    if (20 + size + (size % 2) > bytes.length) throw new ChatImageError('format')
    if (chunk === 'VP8X' && size === 10) {
      width = bytes.readUIntLE(24, 3) + 1
      height = bytes.readUIntLE(27, 3) + 1
    } else if (chunk === 'VP8L' && size >= 5 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (chunk === 'VP8 ' && size >= 10 && bytes.readUIntBE(23, 3) === 0x9d012a) {
      width = bytes.readUInt16LE(26) & 0x3fff
      height = bytes.readUInt16LE(28) & 0x3fff
    } else {
      throw new ChatImageError('format')
    }
  } else {
    const checked = sniffImage(bytes, { maxPixels: CHAT_IMAGE_LIMITS.edge ** 2, animatedGif: true })
    if (!checked.ok) throw new ChatImageError(checked.reason === 'pixels' ? 'size' : 'format')
    width = checked.width
    height = checked.height
  }
  if (width <= 0 || height <= 0) throw new ChatImageError('format')
  if (width > CHAT_IMAGE_LIMITS.edge || height > CHAT_IMAGE_LIMITS.edge) throw new ChatImageError('size')
}

function checkedImage(bytes: Buffer, name: string): AttachedImage {
  if (bytes.length > CHAT_IMAGE_LIMITS.bytes) throw new ChatImageError('size')
  const mime = sniffImageMime(bytes)
  if (!mime) throw new ChatImageError('format')
  checkDimensions(bytes, mime)
  return { image: { mime, bytes }, receipt: { name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
}

type Source = { readonly kind: 'image'; readonly snapshot: AttachedImage } | { readonly kind: 'file'; readonly path: string }

function fileSource(root: string, path: unknown): Source {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ChatImageError('read')
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new ChatImageError('read')
  const rootReal = realpathSync(root)
  const real = realpathSync(path)
  const rel = relative(root, resolve(path))
  const looksInside = !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
  if (looksInside && !insideByFileId(rootReal, real)) throw new ChatImageError('read')
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.ino === 0n || info.dev !== before.dev || info.ino !== before.ino) throw new ChatImageError('read')
    const head = Buffer.alloc(16)
    const headLength = readSync(fd, head, 0, head.length, 0)
    const initial = head.subarray(0, headLength)
    if (!sniffImageMime(initial)) {
      if (IMAGE_EXTENSIONS.test(extname(real)) || imageMagicMatches('attached.bmp', initial)) throw new ChatImageError('format')
      return { kind: 'file', path }
    }
    const max = CHAT_IMAGE_LIMITS.bytes
    if (info.size > BigInt(max)) throw new ChatImageError('size')
    // Copy the prefix already read; the bytes checked below are exactly the ones handed to the engine.
    const buffer = Buffer.alloc(Number(info.size) + 1)
    if (headLength >= buffer.length) throw new ChatImageError('read')
    initial.copy(buffer)
    let length = headLength
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length)
      if (!n) break
      length += n
    }
    if (length > max) throw new ChatImageError('size')
    if (length !== Number(info.size)) throw new ChatImageError('read')
    return { kind: 'image', snapshot: checkedImage(buffer.subarray(0, length), basename(path)) }
  } finally { closeSync(fd) }
}

type Ticket = { readonly scope: ImageScope; readonly snapshot: AttachedImage; readonly timer: NodeJS.Timeout }

function sameImageScope(current: ImageScope | null, want: unknown): want is ImageScope {
  return current !== null && typeof want === 'object' && want !== null &&
    'root' in want && want.root === current.root && 'visit' in want && want.visit === current.visit
}

/** One bounded table for the open project. No stored entry contains a file path. */
export class ChatImages {
  private readonly tickets = new Map<string, Ticket>()
  private generation = 0
  private pending = false

  constructor(
    private readonly scope: () => ImageScope | null,
    private readonly preview: (image: AgentImage) => Promise<string | null>
  ) {}
  clear(root?: string): void {
    if (root !== undefined && this.scope()?.root !== root) return
    this.generation += 1
    for (const id of this.tickets.keys()) this.drop(id)
  }

  drop(id: unknown): void {
    if (typeof id !== 'string') return
    const ticket = this.tickets.get(id)
    if (!ticket) return
    clearTimeout(ticket.timer)
    this.tickets.delete(id)
  }

  private async issue(want: unknown, source: () => Source | Promise<Source | null>): Promise<ChatImageReply> {
    if (!sameImageScope(this.scope(), want)) return { kind: 'error', message: CHAT_IMAGE_COPY.changed }
    if (this.pending) return { kind: 'error', message: CHAT_IMAGE_COPY.busy }
    const generation = this.generation
    const current = () => generation === this.generation && sameImageScope(this.scope(), want)
    this.pending = true
    try {
      const result = await source()
      if (!current()) throw new ChatImageError('changed')
      if (result === null) return { kind: 'canceled' }
      if (result.kind === 'file') return result
      if (this.tickets.size >= CHAT_IMAGE_LIMITS.count) throw new ChatImageError('count')
      const { snapshot } = result
      const preview = await this.preview(snapshot.image)
      if (!current()) throw new ChatImageError('changed')
      if (!preview) throw new ChatImageError('format')
      const id = randomUUID()
      const chip: ChatImageChip = { id, name: snapshot.receipt.name, preview, expiresAt: Date.now() + CHAT_IMAGE_LIMITS.idleMs }
      const timer = setTimeout(() => this.drop(id), CHAT_IMAGE_LIMITS.idleMs)
      timer.unref()
      this.tickets.set(id, { scope: want, snapshot, timer })
      return { kind: 'image', chip }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return { kind: 'error', message: error instanceof ChatImageError ? error.message : CHAT_IMAGE_COPY.read }
    } finally { this.pending = false }
  }

  fromDrop(want: unknown, path: unknown): Promise<ChatImageReply> {
    return this.issue(want, () => fileSource(this.scope()?.root ?? '', path))
  }

  fromPaste(want: unknown, bytes: unknown): Promise<ChatImageReply> {
    return this.issue(want, () => {
      if (!(bytes instanceof Uint8Array)) throw new ChatImageError('format')
      if (bytes.length > CHAT_IMAGE_LIMITS.bytes) throw new ChatImageError('size')
      return { kind: 'image', snapshot: checkedImage(Buffer.from(bytes), '붙여 넣은 그림') }
    })
  }

  fromPicker(want: unknown, pick: () => Promise<string | null>): Promise<ChatImageReply> {
    return this.issue(want, async () => {
      const generation = this.generation
      const path = await pick()
      if (generation !== this.generation || !sameImageScope(this.scope(), want)) throw new ChatImageError('changed')
      return path === null ? null : fileSource(want.root, path)
    })
  }

  /** Reject the whole batch before setup; check the same tickets again just before launching the turn. */
  resolve(root: string, ids: unknown): ImageBatch {
    if (!Array.isArray(ids) || ids.length > CHAT_IMAGE_LIMITS.count) throw new ChatImageError('count')
    if (!ids.length || new Set(ids).size !== ids.length) throw new ChatImageError('reattach')
    const scope = this.scope()
    if (!scope || scope.root !== root) throw new ChatImageError('changed')
    const entries = ids.map((id: unknown) => {
      const found = typeof id === 'string' && ID.test(id) ? this.tickets.get(id) : undefined
      if (typeof id !== 'string' || !found || !sameImageScope(scope, found.scope)) throw new ChatImageError('reattach')
      return { id, found }
    })
    const generation = this.generation
    const current = () => generation === this.generation && sameImageScope(this.scope(), scope)
    return {
      images: entries.map(entry => entry.found.snapshot),
      current,
      accept: () => {
        if (!current()) throw new ChatImageError('changed')
        if (entries.some(({ id, found }) => this.tickets.get(id) !== found)) throw new ChatImageError('reattach')
        for (const { id } of entries) this.drop(id)
      }
    }
  }
}
