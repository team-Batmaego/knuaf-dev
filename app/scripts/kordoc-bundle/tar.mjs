// 결정적(deterministic) tar.gz — **같은 파일 트리면 어느 기계에서 만들어도 같은 바이트**.
//
// 왜 호스트 tar 를 쓰지 않는가: `tar -czf` 는 파일 mtime·uid·gid·디렉터리 읽기 순서를 그대로
// 싣고 gzip 헤더에도 mtime 과 OS 바이트를 넣는다. 같은 트리에서 두 번 만들어도, 다른 기계에서
// 만들어도 해시가 흔들린다. 그러면 "해시 고정 내려받기"가 성립하지 않는다.
//
// 규약(이 파일이 정본):
//   * 항목은 **경로 UTF-8 바이트 오름차순**. 디렉터리 항목도 넣는다(빈 디렉터리 보존).
//   * mtime = 0, uid = gid = 0, uname = gname = "" — 시각·계정 정보를 싣지 않는다.
//   * mode = 0644(일반 파일) / 0755(디렉터리). 실제 권한은 무시한다.
//   * 심볼릭 링크·장치 파일·FIFO 는 담지 않는다(윈도 설치본에서 링크는 관리자 권한과 복사 단계
//     보존 문제를 만든다 — 11-10 실측). 만나면 즉시 실패한다.
//   * ustar(prefix 155 + name 100). 255 바이트를 넘는 경로만 pax `x` 헤더로 넘긴다.
//   * gzip 은 우리가 직접 조립한다: 헤더 mtime = 0, OS = 255(unknown), XFL = 2, level 9.
//
// 남는 비결정성은 하나뿐이다 — zlib 의 deflate 출력은 **zlib 판**에 따라 달라질 수 있다.
// 그래서 산출물 명세에는 node/zlib 판을 적고, 앱은 tgz 해시가 아니라 **명세에 적힌 해시**를
// 요구한다(만든 사람과 받는 사람 사이 계약). 같은 도구 판에서 다시 만들면 바이트가 같다.
import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const BLOCK = 512
export const MODE_FILE = 0o644
export const MODE_DIR = 0o755

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------- gzip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 원본 바이트 → 결정적 gzip. 헤더에 시각·호스트 정보를 넣지 않는다. */
export function gzipDeterministic(raw) {
  const deflated = deflateRawSync(raw, { level: 9 })
  const header = Buffer.alloc(10)
  header[0] = 0x1f
  header[1] = 0x8b
  header[2] = 8 // deflate
  header[3] = 0 // flags 없음(이름·주석 없음)
  header.writeUInt32LE(0, 4) // MTIME = 0 — 시각을 싣지 않는다
  header[8] = 2 // XFL: 최대 압축
  header[9] = 255 // OS: unknown — 만든 기계가 드러나지 않게
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(raw), 0)
  trailer.writeUInt32LE(raw.length % 0x100000000, 4)
  return Buffer.concat([header, deflated, trailer])
}

/** gzip 컨테이너를 풀어 원본 tar 바이트를 돌려준다. 헤더가 gzip 이 아니면 던진다. */
export function gunzip(buffer) {
  if (buffer.length < 18 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new Error('gzip 이 아니다(매직 바이트 불일치)')
  }
  if (buffer[2] !== 8) throw new Error(`지원하지 않는 gzip 압축 방식: ${buffer[2]}`)
  if (buffer[3] !== 0) throw new Error('이름·주석이 붙은 gzip 은 받지 않는다(헤더 flags != 0)')
  const body = buffer.subarray(10, buffer.length - 8)
  const raw = inflateRawSync(body)
  const trailer = buffer.subarray(buffer.length - 8)
  if (trailer.readUInt32LE(0) !== crc32(raw)) throw new Error('gzip CRC 불일치')
  if (trailer.readUInt32LE(4) !== raw.length % 0x100000000) throw new Error('gzip 길이 불일치')
  return raw
}

// ---------------------------------------------------------------- 이름 다루기

const byteLen = (text) => Buffer.byteLength(text, 'utf8')
const cmpUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

/** UTF-8 경계를 깨지 않고 max 바이트까지만 자른다. */
export function truncateUtf8(text, max) {
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = byteLen(ch)
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/** ustar 이름 칸에 맞게 경로를 name/prefix 로 쪼갠다. 255 바이트를 넘으면 null. */
export function splitName(path) {
  if (byteLen(path) <= 100) return { name: path, prefix: '' }
  for (let i = 1; i < path.length; i += 1) {
    if (path[i] !== '/') continue
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (!name) continue
    if (byteLen(prefix) <= 155 && byteLen(name) <= 100) return { name, prefix }
  }
  return null
}

/**
 * tar 안의 이름 하나를 검사한다 — 절대경로·드라이브 문자·상위 이동·백슬래시·NUL 을 거부한다.
 * 푸는 쪽(앱)이 이 검사를 하지 않으면 악성 tgz 가 설치 폴더 밖에 쓸 수 있다.
 */
export function assertSafeMember(name) {
  if (!name) throw new Error('tar 항목 이름이 비었다')
  if (name.includes('\0')) throw new Error(`tar 항목 이름에 NUL: ${JSON.stringify(name)}`)
  if (name.includes('\\')) throw new Error(`tar 항목 이름에 역슬래시: ${name}`)
  if (name.startsWith('/')) throw new Error(`tar 항목이 절대경로다: ${name}`)
  if (/^[A-Za-z]:/.test(name)) throw new Error(`tar 항목에 드라이브 문자가 있다: ${name}`)
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`tar 항목 경로가 이상하다: ${name}`)
    }
  }
  return name
}

// ---------------------------------------------------------------- 쓰기

function putOctal(buf, offset, width, value) {
  const text = value.toString(8)
  if (text.length > width - 1) throw new Error(`tar 필드 넘침(${width}B): ${value}`)
  buf.write(text.padStart(width - 1, '0'), offset, 'latin1')
}

function headerBlock({ name, prefix, size, type, mode, mtime = 0 }) {
  if (byteLen(name) > 100) throw new Error(`tar name 칸(100B) 넘침: ${name}`)
  if (prefix && byteLen(prefix) > 155) throw new Error(`tar prefix 칸(155B) 넘침: ${prefix}`)
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 'utf8')
  putOctal(block, 100, 8, mode)
  putOctal(block, 108, 8, 0) // uid
  putOctal(block, 116, 8, 0) // gid
  putOctal(block, 124, 12, size)
  putOctal(block, 136, 12, mtime)
  block.write(type, 156, 'latin1')
  block.write('ustar\0', 257, 'latin1')
  block.write('00', 263, 'latin1')
  // uname/gname 는 0 으로 남긴다(이름을 싣지 않는다).
  putOctal(block, 329, 8, 0) // devmajor
  putOctal(block, 337, 8, 0) // devminor
  if (prefix) block.write(prefix, 345, 'utf8')
  block.write('        ', 148, 'latin1') // 체크섬 자리는 공백으로 두고 합을 구한다
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

function padToBlock(data) {
  const rest = data.length % BLOCK
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)])
}

/**
 * pax 레코드 한 줄 — 형식은 `"<전체 바이트 수> <키>=<값>\n"` 이다. 길이에 자기 자릿수도 들어가므로
 * 자릿수가 늘어나면 다시 계산한다(보통 1~2회로 끝난다).
 */
function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`, 'utf8')
  let total = body.length + 2
  for (;;) {
    const next = body.length + String(total).length + 1
    if (next === total) break
    total = next
  }
  return Buffer.concat([Buffer.from(`${total} `, 'latin1'), body])
}

function appendEntry(chunks, path, type, data) {
  const isDir = type === 'dir'
  const size = isDir ? 0 : data.length
  const mode = isDir ? MODE_DIR : MODE_FILE
  let split = splitName(path)
  if (!split) {
    // 255 바이트를 넘는 경로만 여기로 온다 — POSIX pax 확장 헤더.
    const record = paxRecord('path', path)
    const base = path.slice(path.lastIndexOf('/') + 1) || 'entry'
    const paxName = `PaxHeaders.0/${truncateUtf8(base, 80)}`
    chunks.push(headerBlock({ name: paxName, prefix: '', size: record.length, type: 'x', mode: MODE_FILE }))
    chunks.push(padToBlock(record))
    split = { name: truncateUtf8(path, 100), prefix: '' }
  }
  chunks.push(headerBlock({ ...split, size, type: isDir ? '5' : '0', mode }))
  if (size > 0) chunks.push(padToBlock(data))
}

/**
 * 항목 목록을 tar 바이트로. `entries` 는 이미 정렬돼 있어야 한다(호출자가 정한다 —
 * 담을 것을 고르는 화이트리스트는 bundle 쪽에 있고, 이 파일은 형식만 안다).
 */
export function packEntries(entries, readEntry) {
  const chunks = []
  for (const entry of entries) {
    const data = entry.type === 'file' ? readEntry(entry) : Buffer.alloc(0)
    if (entry.type === 'file' && entry.size !== undefined && entry.size !== data.length) {
      throw new Error(`항목 크기가 수집 시점과 다르다(만드는 중에 바뀌었다): ${entry.path}`)
    }
    appendEntry(chunks, entry.path, entry.type, data)
  }
  chunks.push(Buffer.alloc(BLOCK * 2)) // 끝 표식: 0 블록 두 개
  return Buffer.concat(chunks)
}

/**
 * 트리 하나를 담은 tar 바이트. 경로는 `root` 기준 posix 상대경로다.
 * 심볼릭 링크·특수 파일을 만나면 던진다(담지 않고 조용히 넘어가지 않는다).
 */
export const packTree = (root) =>
  packEntries(collectTree(root), (entry) => readFileSync(join(root, ...entry.path.split('/'))))

/** 트리의 모든 항목을 경로 바이트 오름차순으로 돌려준다. */
export function collectTree(root) {
  const entries = []
  const walk = (rel) => {
    const abs = rel ? join(root, ...rel.split('/')) : root
    for (const name of readdirSync(abs)) {
      const path = rel ? `${rel}/${name}` : name
      const stat = lstatSync(join(abs, name))
      if (stat.isSymbolicLink()) throw new Error(`심볼릭 링크는 담을 수 없다: ${path}`)
      if (stat.isDirectory()) {
        entries.push({ path, type: 'dir', size: 0 })
        walk(path)
      } else if (stat.isFile()) {
        entries.push({ path, type: 'file', size: stat.size })
      } else {
        throw new Error(`일반 파일·디렉터리가 아니다: ${path}`)
      }
    }
  }
  walk('')
  entries.sort((a, b) => cmpUtf8(a.path, b.path))
  // 같은 경로가 두 번 나올 수 없다(디렉터리 순회 결과는 유일하다) — 그래도 계약으로 못박는다.
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i - 1].path === entries[i].path) throw new Error(`중복 경로: ${entries[i].path}`)
  }
  return entries
}

/** tar 바이트 → gzip 바이트. */
export const packTreeGzip = (root) => gzipDeterministic(packTree(root))

// ---------------------------------------------------------------- 읽기

function parseOctal(buf, offset, width) {
  const text = buf.subarray(offset, offset + width).toString('latin1').replace(/[\0 ]+$/, '')
  if (text.trim() === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar 숫자 칸이 8진수가 아니다: ${JSON.stringify(text)}`)
  return Number.parseInt(text, 8)
}

function readCString(buf, offset, width) {
  const slice = buf.subarray(offset, offset + width)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function parsePax(data) {
  const out = {}
  let off = 0
  while (off < data.length) {
    const space = data.indexOf(0x20, off)
    if (space === -1) break
    const len = Number(data.subarray(off, space).toString('latin1'))
    if (!Number.isInteger(len) || len <= 0) throw new Error('pax 레코드 길이가 이상하다')
    const end = off + len
    if (end > data.length) throw new Error('pax 레코드가 데이터를 넘어간다')
    const text = data.subarray(space + 1, end - 1).toString('utf8')
    const eq = text.indexOf('=')
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1)
    off = end
  }
  return out
}

function verifyChecksum(block) {
  const stored = parseOctal(block, 148, 8)
  const zeroed = Buffer.from(block)
  zeroed.write('        ', 148, 'latin1')
  let sum = 0
  for (const byte of zeroed) sum += byte
  if (sum !== stored) throw new Error(`tar 헤더 체크섬 불일치(저장 ${stored}, 계산 ${sum})`)
}

/**
 * tar 바이트 → 항목 목록. 링크·특수 파일·이상한 경로는 **던진다**(조용히 건너뛰지 않는다).
 * @returns {{path: string, type: 'file'|'dir', size: number, sha256: string, data: Buffer}[]}
 */
export function readTar(buffer) {
  const entries = []
  let off = 0
  let paxPath = null
  let longName = null
  while (off + BLOCK <= buffer.length) {
    const header = buffer.subarray(off, off + BLOCK)
    if (header.every((byte) => byte === 0)) break
    verifyChecksum(header)
    const type = String.fromCharCode(header[156]) || '0'
    const size = parseOctal(header, 124, 12)
    const dataStart = off + BLOCK
    if (dataStart + size > buffer.length) throw new Error('tar 항목이 파일 끝을 넘어간다')
    const data = buffer.subarray(dataStart, dataStart + size)
    if (type === 'x') {
      const record = parsePax(data)
      if (record.path) paxPath = record.path
    } else if (type === 'L') {
      longName = readCString(data, 0, data.length)
    } else if (type === '0' || type === '\0' || type === '5') {
      const prefix = readCString(header, 345, 155)
      const name = readCString(header, 0, 100)
      const declared = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)
      const path = assertSafeMember(declared)
      const isDir = type === '5'
      entries.push({
        path,
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : size,
        sha256: isDir ? sha256Hex(Buffer.alloc(0)) : sha256Hex(data),
        data: isDir ? Buffer.alloc(0) : data,
      })
      paxPath = null
      longName = null
    } else {
      throw new Error(`담을 수 없는 tar 항목 종류: ${JSON.stringify(type)}`)
    }
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

/** gzip 바이트 → 항목 목록. */
export const readTarGz = (buffer) => readTar(gunzip(buffer))
