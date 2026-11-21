/**
 * v0.7.3 `못 읽은 규칙집 상태` 반례 시험의 공용 대역.
 *
 * ## 주입은 왜 `node:fs` 한 겹인가
 * 소스에 주입 지점(훅·꼬리표)이 아직 없다(설계 §6: 꼬리표는 2단계 산물). 그래서 이 대역은
 * **소스를 고치지 않고** `node:fs`의 속성만 바꾼다. `store.ts`·`service.ts`·`safeWrite.ts`는
 * `import { x } from 'node:fs'` → TS/CJS 변환에서 `node_fs_1.x(...)` 즉 **호출 시점 속성 조회**가
 * 되므로, `require('node:fs')`의 속성을 바꾸면 두 나무(기준판·고친 판)에 같은 주입이 들어간다.
 *
 * ## 자리는 호출 스택의 함수 이름으로 겨냥한다(현행)
 * 규칙의 `store`(가장 바깥 `SkillStore.*` 메서드)·`svc`(가장 안쪽 `SkillUpdates.*` 메서드)·`name`(파일 이름)으로
 * 겨냥한다. 줄 번호를 쓰지 않으므로 2단계가 줄을 밀어도 같은 자리를 맞힌다. `site()`·`at`(소스 스니펫 → 줄)은
 * 예비 도구로만 남겨 두었고 지금 시험은 쓰지 않는다.
 *
 * ## 발동 증명
 * `inject.fired(rule)`은 **실제로 오류를 던지거나 값을 바꾼 횟수**다(조건만 맞고 `skip`에 걸린 호출은 세지 않는다).
 *
 * ## `existsSync` 대역의 한계
 * Node의 `existsSync`는 내부에서 `access`(윈도는 추가 `stat`)를 부르고 오류면 false를 낸다. 이 대역은 그것을
 * "같은 경로의 `lstat` 규칙이 errno면 false"로 **모형화**한 것이지 Node 내부 호출을 재현한 것이 아니다.
 * 고친 판은 `lstat` 분류를 쓰므로 같은 규칙이 실제 EPERM을 던진다.
 *
 * ## 대역 밖으로 새지 않게
 * 이 파일 자신의 파일 접근은 **원본 함수**(`real.*`)만 쓴다. 패치된 함수를 쓰면 주입이 시험
 * 도우미의 디스크 준비·대조까지 오염된다.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ASSET_PREFIX, CHANNEL_URL, verifySkill, type SkillManifest } from '../src/main/update/manifest'
import { updateConfig } from '../src/main/update/keys'
import { SkillStore } from '../src/main/update/store'
import { SkillSwitch } from '../src/main/update/switch'
import { SkillUpdates } from '../src/main/update/service'

/** 진짜 `node:fs` 모듈 객체 — 여기의 속성을 바꾸면 앱 코드가 부르는 함수가 바뀐다. */
const fs = createRequire(__filename)('node:fs') as typeof import('node:fs')

/**
 * `rmSync` 안에서 일어나는 하위 호출 깊이. 윈도 Node의 `rmSync`(recursive)는 폴더를 지울 때 안에서 `fs.unlinkSync`·`lstatSync`·
 * `readdirSync`를 **공개 fs 객체를 통해** 부르므로 이 대역이 그것까지 기록·주입에 걸었다(맥은 안 걸린다). 하위 호출은 기록도
 * 주입도 하지 않고, 앱이 부른 `rmSync` 한 줄(`rm:<경로>`)만 남긴다 — 앱이 `rmSync` 밖에서 직접 부른 호출은 그대로 기록된다.
 */
let inRm = 0
const originalRm = fs.rmSync
const rmDeep = (path: Parameters<typeof originalRm>[0], opts?: Parameters<typeof originalRm>[1]): void => {
  inRm++
  try { originalRm(path, opts) } finally { inRm-- }
}

/** 대역이 설치되기 **전** 원본들. 이 파일의 모든 파일 접근은 이것만 쓴다. */
const real = {
  readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, lstatSync: fs.lstatSync,
  statSync: fs.statSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync, rmSync: rmDeep as typeof fs.rmSync, mkdtempSync: fs.mkdtempSync,
  mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, copyFileSync: fs.copyFileSync
}

const SRC_MAIN = join(__dirname, '..', 'src', 'main')

/** 원본 fs — 시험 파일이 골든 읽기·쓰기처럼 기록에 섞이면 안 되는 접근에 쓴다. */
export const realFs = real

/* ────────────────────────── 서명 열쇠·묶음 ────────────────────────── */

const pair = generateKeyPairSync('ed25519')
export const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
export const keys = [publicKey]
export const config = (): ReturnType<typeof updateConfig> => updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })

const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

type Entry = { name: string; data: Buffer; method?: number }

function zipEntries(entries: Entry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.method === 8 ? deflateRawSync(e.data) : e.data
    const local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(e.method ?? 0, 10)
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(e.data.length, 24); record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE((0x81a4 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    locals.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function envelope(m: object) {
  const bytes = Buffer.from(JSON.stringify(m))
  return { manifest: bytes.toString('base64'), sig: sign(null, bytes, pair.privateKey).toString('base64') }
}

/**
 * 판 묶음 하나. `extra`로 `install-manifest.json` 같은 덧붙임 파일을 넣는다.
 * `changes.files`로 서명된 파일 목록만 따로 덮을 수 있다(동봉 manifest 실험용).
 */
export function fixture(v: string, changes: Partial<SkillManifest> = {}, extra: Entry[] = []) {
  const entries: Entry[] = [
    { name: 'SKILL.md', data: Buffer.from(`# skill ${v}`), method: 8 },
    { name: 'skill.json', data: Buffer.from(JSON.stringify({ version: v, api: 1, source: { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }, overlay: 'b'.repeat(64) })) },
    { name: 'scripts/example.py', data: Buffer.from(`print('${v}')\n`) },
    ...extra
  ]
  const zip = zipEntries(entries)
  const manifest: SkillManifest = {
    schema: 1, name: 'knuaf-dev', version: v, api: 1, minApp: '0.5.1',
    url: `${ASSET_PREFIX}skill-v${v}/knuaf-dev-skill-${v}.zip`, size: zip.length, sha256: sha256Of(zip),
    files: Object.fromEntries(entries.map(e => [e.name, sha256Of(e.data)])), ...changes
  }
  const signed = envelope(manifest)
  const made = { entries, zip, manifest, signed, verified: () => verifySkill(signed, keys) }
  registry.push(made)
  return made
}
/** 이 프로세스에서 만든 묶음 — 골든 정규화가 실행마다 바뀌는 서명·digest를 판 이름으로 바꿀 때 쓴다. */
const registry: { manifest: SkillManifest; zip: Buffer; verified: () => { digest: string } }[] = []
export type Fixture = ReturnType<typeof fixture>

/* ────────────────────────── 자리(site) ────────────────────────── */

export type Site = { file: string; line: number }

const siteCache = new Map<string, number>()

/**
 * 소스의 **고유 스니펫**에서 줄 번호를 계산한다. 손으로 적은 줄 번호는 2단계에서 밀린다.
 * `nth`는 같은 스니펫이 여러 번 나올 때의 순번(0부터)이다. `exact`면 줄 앞뒤 공백을 뺀
 * 전체가 스니펫과 같아야 한다 — `const s = this.state()` 처럼 더 긴 줄의 앞부분인 경우를 가른다.
 */
export function site(file: string, snippet: string, nth = 0, exact = false): Site {
  const key = `${file}::${snippet}::${nth}::${exact}`
  const cached = siteCache.get(key)
  if (cached !== undefined) return { file, line: cached }
  const lines = real.readFileSync(join(SRC_MAIN, file), 'utf8').split('\n')
  const hits = lines.map((line, index) => ((exact ? line.trim() === snippet : line.includes(snippet)) ? index + 1 : 0)).filter(line => line > 0)
  const line = hits[nth]
  if (line === undefined) throw new Error(`주입 지점이 사라졌다: ${file} 에 ${JSON.stringify(snippet)}[${nth}] 가 ${hits.length}개뿐이다`)
  siteCache.set(key, line)
  return { file, line }
}

/** 지금 스택의 (파일, 줄, 함수 이름) — 자리 대조에 쓴다. 안쪽 프레임이 앞이다. */
export type Frame = Site & { fn: string }
export function framesOf(): Frame[] {
  const out: Frame[] = []
  for (const raw of (new Error().stack ?? '').split('\n').slice(2)) {
    const line = raw.trim()
    const named = /^at (?:async )?(?:new )?(.+?) \((.+):(\d+):(\d+)\)$/.exec(line)
    if (named) { out.push({ fn: named[1], file: named[2], line: Number(named[3]) }); continue }
    const bare = /^at (?:async )?(.+):(\d+):(\d+)$/.exec(line)
    if (bare) out.push({ fn: '', file: bare[1], line: Number(bare[2]) })
  }
  return out
}

/**
 * 함수 이름으로 겨냥한다 — 2단계가 줄·스니펫을 바꿔도 같은 자리를 겨냥하게.
 * `store`: 스택에서 **가장 바깥** `SkillStore.*` 메서드(서비스가 직접 부른 store 진입점).
 * `svc`: 스택에서 **가장 안쪽** `SkillUpdates.*` 메서드.
 */
const methodOf = (fn: string, cls: string): string | null => fn.startsWith(`${cls}.`) ? fn.slice(cls.length + 1) : null
export function outerStore(frames: Frame[]): string | null {
  let found: string | null = null
  for (const f of frames) { const m = methodOf(f.fn, 'SkillStore'); if (m) found = m }
  return found
}
export function innerService(frames: Frame[]): string | null {
  for (const f of frames) { const m = methodOf(f.fn, 'SkillUpdates'); if (m) return m }
  return null
}

/* ────────────────────────── 주입기 ────────────────────────── */

export type Op = 'read' | 'readdir' | 'lstat' | 'stat' | 'write' | 'rename' | 'unlink' | 'rm' | 'mkdtemp' | 'mkdir'

/**
 * 규칙 하나. `at`(자리)으로 겨냥하고, `name`(파일 이름 꼬리)으로 좁히고, `skip`/`times`로
 * "여기서부터 계속"·"이 호출만"을 가른다. `code`면 errno를 던지고, `text`/`bytes`면 값을 바꾼다.
 */
export type Rule = {
  op: Op
  at?: Site
  /** 가장 바깥 `SkillStore.*` 메서드 이름이 맞아야 발동. */
  store?: RegExp
  /** 가장 안쪽 `SkillUpdates.*` 메서드 이름이 맞아야 발동. */
  svc?: RegExp
  name?: string
  /** 파일 이름이 이 접두로 시작해야 발동. */
  namePrefix?: string
  /**
   * 쓰기 내용으로 겨냥한다 — `data`는 writeFileSync가 쓰는 값, `src`는 copyFileSync의 원본 경로.
   * 구현이 임시 이름을 자유롭게 고르는 자리(백업 등)를 이름이 아니라 '무엇을 쓰는가'로 겨냥할 때(판정서 tests r12 I-01).
   */
  when?: (info: { data?: unknown; src?: string }) => boolean
  skip?: number
  times?: number
  code?: string
  text?: (s: string) => string
  bytes?: (b: Buffer) => Buffer
}

const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

const tally = new Map<Rule, number>()
/** 진단 전용(동작 무관): 규칙의 op·name에 맞은 호출이 왜 발동하지 않았는지 — `explain()`이 실패 문구에 싣는다. */
const trace = new Map<Rule, string[]>()
const traced = new Map<Rule, number>()
const applied = new Map<Rule, number>()
let rules: Rule[] = []
let ops: string[] = []

const nameOf = (path: string): string => path.slice(path.lastIndexOf(sep) + 1)
/** 기록에 남기는 경로 — 구분자만 `/`로(윈도 `\`). 맥·리눅스는 그대로다. 규칙 대조(`match`)는 원래 경로를 쓴다. */
const recorded = (path: string): string => sep === '/' ? path : path.split(sep).join('/')

/** 규칙 대조만 — 기록하지 않는다. 발동하면 `applied`를 올린다. */
const match = (op: Op, path: string, info: { data?: unknown; src?: string } = {}): Rule | null => {
  if (!rules.length) return null
  let frames: Frame[] | null = null
  const name = nameOf(path)
  // 진단 기록만 한다 — 규칙 대조의 순서·조건·`tally`는 건드리지 않는다.
  const note = (rule: Rule, verdict: string): void => {
    frames ??= framesOf()
    traced.set(rule, (traced.get(rule) ?? 0) + 1)
    const list = trace.get(rule) ?? []
    trace.set(rule, list)
    if (list.length < 24) list.push(`${op}:${name} 바깥store=${outerStore(frames) ?? '-'} 안쪽svc=${innerService(frames) ?? '-'} 프레임=${frames.length} → ${verdict}`)
  }
  for (const rule of rules) {
    if (rule.op !== op) continue
    if (rule.name !== undefined && rule.name !== name) continue
    if (rule.namePrefix !== undefined && !name.startsWith(rule.namePrefix)) continue
    if (rule.when && !rule.when(info)) continue
    if (rule.at) {
      frames ??= framesOf()
      if (!frames.some(frame => basename(frame.file) === basename(rule.at!.file) && frame.line === rule.at!.line)) { note(rule, 'at 불일치'); continue }
    }
    if (rule.store || rule.svc) {
      frames ??= framesOf()
      if (rule.store && !rule.store.test(outerStore(frames) ?? '')) { note(rule, 'store 불일치'); continue }
      if (rule.svc && !rule.svc.test(innerService(frames) ?? '')) { note(rule, 'svc 불일치'); continue }
    }
    const n = (tally.get(rule) ?? 0) + 1
    tally.set(rule, n)
    const skip = rule.skip ?? 0, times = rule.times ?? 1
    note(rule, `조건 일치 n=${n} ${n <= skip ? 'skip 소비' : n <= skip + times ? '발동 대상' : 'times 소진'}`)
    if (n > skip && n <= skip + times) return rule
  }
  return null
}

/** 실제로 오류를 던지거나 값을 바꾼 순간에만 부른다. */
const applyOnce = (rule: Rule): void => { applied.set(rule, (applied.get(rule) ?? 0) + 1) }
/** errno 규칙이면 적용으로 세고 던진다. */
const raise = (rule: Rule | null): void => { if (rule?.code) { applyOnce(rule); throw errno(rule.code) } }

/** 호출 하나 = 기록 하나. */
const hit = (op: Op, path: string, info: { data?: unknown; src?: string } = {}): Rule | null => {
  if (inRm > 0) return null // `rmSync` 안의 하위 호출 — 기록·주입 없음(위 inRm 설명)
  ops.push(`${op}:${recorded(path)}`)
  return match(op, path, info)
}

const patched = {
  readFileSync: (path: string, opts?: unknown): unknown => {
    const rule = hit('read', String(path))
    raise(rule)
    const got = real.readFileSync(path as never, opts as never) as unknown
    if (!rule) return got
    if (typeof got === 'string') { if (!rule.text) return got; const out = rule.text(got); if (out !== got) applyOnce(rule); return out }
    if (!rule.bytes) return got
    const out = rule.bytes(got as Buffer)
    if (!Buffer.isBuffer(out) || !out.equals(got as Buffer)) applyOnce(rule)
    return out
  },
  readdirSync: (path: string, opts?: unknown): unknown => {
    const rule = hit('readdir', String(path))
    raise(rule)
    return real.readdirSync(path as never, opts as never)
  },
  lstatSync: (path: string, opts?: unknown): unknown => {
    const rule = hit('lstat', String(path))
    raise(rule)
    return real.lstatSync(path as never, opts as never)
  },
  statSync: (path: string, opts?: unknown): unknown => {
    const rule = hit('stat', String(path))
    raise(rule)
    return real.statSync(path as never, opts as never)
  },
  writeFileSync: (path: string, data: unknown, opts?: unknown): void => {
    const rule = hit('write', String(path), { data })
    raise(rule)
    real.writeFileSync(path as never, data as never, opts as never)
  },
  renameSync: (from: string, to: string): void => {
    ops.push(`rename:${recorded(String(from))} -> ${recorded(String(to))}`)
    const rule = match('rename', String(to)) ?? match('rename', String(from))
    raise(rule)
    real.renameSync(from, to)
  },
  unlinkSync: (path: string): void => {
    const rule = hit('unlink', String(path))
    raise(rule)
    real.unlinkSync(path)
  },
  rmSync: (path: string, opts?: unknown): void => {
    const rule = hit('rm', String(path))
    raise(rule)
    rmDeep(path as never, opts as never)
  },
  mkdtempSync: (prefix: string, opts?: unknown): string => {
    const rule = hit('mkdtemp', String(prefix))
    raise(rule)
    return real.mkdtempSync(prefix as never, opts as never)
  },
  /** 복사는 대상 파일 쓰기로 본다(백업을 copyFileSync로 만드는 구현도 같은 규칙으로 겨냥 — 판정서 tests r11 I-01). */
  copyFileSync: (src: string, dest: string, mode?: number): void => {
    const rule = hit('write', String(dest), { src: String(src) })
    raise(rule)
    real.copyFileSync(src as never, dest as never, mode as never)
  },
  /** 실제 `existsSync`는 접근 오류(EPERM 등)를 삼키고 false를 낸다 — 같은 경로의 `lstat` 규칙이 errno면 false. */
  existsSync: (path: string): boolean => {
    const rule = hit('lstat', String(path))
    if (rule?.code) { applyOnce(rule); return false }
    return real.existsSync(path as never)
  },
  mkdirSync: (path: string, opts?: unknown): unknown => {
    const rule = hit('mkdir', String(path))
    raise(rule)
    return real.mkdirSync(path as never, opts as never)
  }
}

Object.assign(fs, patched)

export const inject = {
  /** 규칙을 갈아 끼운다 — 시험마다 `clear()` 뒤 새로 넣는다. */
  set(list: Rule[]): void { rules = list.slice(); tally.clear(); applied.clear(); trace.clear(); traced.clear() },
  /** 규칙과 기록을 모두 비운다(대역 해제). */
  clear(): void { rules = []; tally.clear(); applied.clear(); trace.clear(); traced.clear(); ops = [] },
  /** 호출 기록만 비운다 — 시험의 조작 구간만 세고 싶을 때. */
  mark(): void { ops = [] },
  /** 모든 파일 접근 기록(`op:절대경로`). */
  ops(): string[] { return ops.slice() },
  /** 쓰기·이름바꾸기·삭제만 — 설계 §5.0 '쓰기·rename·삭제 호출 순서'. */
  writes(): string[] { return ops.filter(line => /^(write|rename|unlink|rm|mkdtemp|mkdir):/.test(line)) },
  /** (연산, 파일 이름) 호출 수. */
  count(op: Op, name: string): number {
    const tail = `:/${name}`
    return ops.filter(line => line.startsWith(`${op}:`) && (line.endsWith(tail) || line.endsWith(`:${name}`))).length
  },
  /** 규칙이 실제로 오류를 던지거나 값을 바꾼 횟수 — "주입이 안 닿았다"를 조용히 넘기지 않게. */
  fired(rule: Rule): number { return applied.get(rule) ?? 0 },
  /**
   * 규칙이 닿지 않았을 때 실패 문구에 싣는 진단 — 규칙의 op·name에 맞은 호출마다 바깥 store·안쪽 svc 이름과 판정을 적는다.
   * 동작·단언과 무관하다(읽기만 한다).
   */
  explain(rule: Rule): string {
    const list = trace.get(rule) ?? []
    const total = traced.get(rule) ?? 0
    return `op·name이 맞은 호출 ${total}회${total > list.length ? `(앞 ${list.length}회만 적음)` : ''} · 조건까지 맞음 ${tally.get(rule) ?? 0}회 · 적용 ${applied.get(rule) ?? 0}회 · stackTraceLimit=${Error.stackTraceLimit} · 호출: ${list.length ? list.join(' | ') : '없음 — 그 읽기가 일어나지 않았다'}`
  },
  /** 규칙 조건이 맞은 호출 수(`skip` 포함). */
  matched(rule: Rule): number { return tally.get(rule) ?? 0 },
  /** 경로가 들어간 호출 기록. */
  paths(op: Op): string[] { return ops.filter(line => line.startsWith(`${op}:`)).map(line => line.slice(op.length + 1)) }
}

/* ────────────────────────── 디스크 ────────────────────────── */

/** 기준판 `state()`가 요구하는 모양(64자 해시)을 맞추는 자리 — '기록만 있는' highest. */
export const wrapDigest = (v: string): string => sha256Of(Buffer.from(`digest-${v}`))

export type DiskState = { active: string | null; kept: Record<string, string>; highest: { version: string; manifest: string } | null }

export type Disk = {
  root: string
  bundled: string
  storeDir: string
  versions: Map<string, Fixture>
  log: string
  state(): DiskState
  stateText(): string
  writeState(next: Partial<DiskState>): void
  /** 파일 하나를 망가뜨린다(해시 불일치) — 확정 무효 입력. */
  corrupt(version: string): void
  store(): SkillStore
}

export type DiskSpec = {
  bundledVersion?: string
  versions?: string[]
  active?: string | null
  highest?: string | null
  kept?: string[]
  /** `false`면 state.json을 만들지 않는다(처음 설치). */
  state?: boolean
  /** 동봉 `install-manifest.json`을 만들 때 쓰는 판(서명 파일 목록이 곧 동봉 목록). */
  bundleManifestFrom?: Fixture
  /** 동봉 `install-manifest.json` 본문을 직접 준다. */
  bundleManifestFiles?: Record<string, string>
  /** 기본 `fixture()` 대신 쓸 묶음 — 동봉 manifest 비교(R-MB)처럼 파일 목록을 직접 맞출 때. */
  fixtures?: Fixture[]
}

export function temporary(): string { return real.mkdtempSync(join(tmpdir(), 'knuaf-unknown-')) }

export function makeDisk(spec: DiskSpec = {}): Disk {
  const root = temporary(), bundled = join(root, 'bundled'), storeDir = join(root, 'skill-store'), log = join(root, 'app.log')
  const bundledVersion = spec.bundledVersion ?? '1.0.13'
  const versions = (spec.versions ?? ['1.0.14', '1.0.15']).map(v => fixture(v))
  real.mkdirSync(join(bundled, 'scripts'), { recursive: true })
  real.writeFileSync(join(bundled, 'SKILL.md'), `# bundle ${bundledVersion}`)
  real.writeFileSync(join(bundled, 'scripts', 'example.py'), `print('${bundledVersion}')\n`)
  real.writeFileSync(join(bundled, 'skill.json'), JSON.stringify({ version: bundledVersion, api: 1 }))
  const manifestFiles = spec.bundleManifestFiles ?? spec.bundleManifestFrom?.manifest.files
  if (manifestFiles) {
    real.writeFileSync(join(bundled, 'install-manifest.json'), JSON.stringify({ schema: 'knuaf-doc/install-manifest@1', files: manifestFiles }))
  }
  real.mkdirSync(join(storeDir, 'proofs'), { recursive: true })
  const map = new Map<string, Fixture>()
  for (const f of versions) {
    map.set(f.manifest.version, f)
    const dir = join(storeDir, f.manifest.version)
    for (const e of f.entries) {
      real.mkdirSync(dirname(join(dir, e.name)), { recursive: true })
      real.writeFileSync(join(dir, e.name), e.data)
    }
    real.writeFileSync(join(storeDir, 'proofs', `${f.manifest.version}.json`), JSON.stringify(f.signed))
  }
  const keptVersions = spec.kept ?? [...map.keys()]
  const kept = Object.fromEntries(keptVersions.filter(v => map.has(v)).map(v => [v, map.get(v)!.verified().digest]))
  const active = spec.active === undefined ? keptVersions.at(-1) ?? null : spec.active
  const highestVersion = spec.highest === undefined ? keptVersions.at(-1) ?? null : spec.highest
  const value: DiskState = {
    active,
    kept,
    highest: highestVersion === null ? null : { version: highestVersion, manifest: map.get(highestVersion)?.verified().digest ?? wrapDigest(highestVersion) }
  }
  const stateFile = join(storeDir, 'state.json')
  if (spec.state !== false) {
    real.writeFileSync(stateFile, JSON.stringify(value))
    if (value.highest) real.writeFileSync(join(storeDir, 'highest.json'), JSON.stringify(value.highest))
  }
  return {
    root, bundled, storeDir, versions: map, log,
    state: () => JSON.parse(real.readFileSync(stateFile, 'utf8')) as DiskState,
    stateText: () => real.readFileSync(stateFile, 'utf8'),
    writeState(next: Partial<DiskState>) {
      const current = JSON.parse(real.readFileSync(stateFile, 'utf8')) as DiskState
      const merged = { ...current, ...next }
      if ('highest' in next) {
        if (next.highest) real.writeFileSync(join(storeDir, 'highest.json'), JSON.stringify(next.highest))
        else real.rmSync(join(storeDir, 'highest.json'), { force: true })
      }
      real.writeFileSync(stateFile, JSON.stringify(merged))
    },
    corrupt(version: string) {
      const dir = join(storeDir, version)
      real.writeFileSync(join(dir, 'SKILL.md'), `# damaged ${version}`)
    },
    store: () => new SkillStore(root, bundled, '0.5.1', keys)
  }
}

/* ────────────────────────── 갈래 대역 ────────────────────────── */

/**
 * 시간 대기 없이 순서를 고정하는 문. `arrived`는 상대가 문에 닿으면 풀리고,
 * 상대는 시험이 `release()`할 때까지 `reached`에서 멈춘다.
 */
export type Gate = { arrived: Promise<void>; arrive: () => void; reached: Promise<void>; release: () => void }
export function gate(): Gate {
  const a = Promise.withResolvers<void>(), r = Promise.withResolvers<void>()
  return { arrived: a.promise, arrive: a.resolve, reached: r.promise, release: r.resolve }
}

/** 잠금 시도 수와 진입 순서를 세는 스위치 — 설계 §5.0 '잠금 시도 수', 판정서 R-C4 순서 기록. */
export class CountingSwitch extends SkillSwitch {
  attempts = 0
  private entered = Promise.withResolvers<void>()
  /** 첫 `switch()` 진입에서 풀린다(H-LOCK 순서 관찰). */
  readonly switched = this.entered.promise
  /** 진입 순서 기록 — 따로 넘기지 않으면 자기 배열을 쓰고, `makeUpdater`가 그 배열을 `events`로 이어 받는다. */
  constructor(readonly log: string[] = []) { super() }
  override async switch<T>(work: () => Promise<T>, timeout?: number): Promise<T> {
    ++this.attempts
    this.log.push('lock.switch')
    this.entered.resolve()
    return super.switch(work, timeout)
  }
}

export type UpdaterOptions = {
  disk: Disk
  lock?: CountingSwitch
  /** 채널 응답을 붙잡는 자리(H-FETCH). */
  channelGate?: Gate
  /** zip 응답을 붙잡는 자리(H-FETCH). */
  fetchGate?: Gate
  /** 채널이 내미는 후보. 없으면 disk 의 최신 판. */
  candidate?: Fixture
  /** 채널 본문을 직접 준다(후보 없음·형식 오류 실험). */
  channel?: () => unknown
  restart?: () => Promise<unknown>
  /** 잠금 진입·publish 진입 순서 — 판정서 R-C4가 본다. */
  events?: string[]
}

export type Updater = {
  /** 재시작 대역이 불린 횟수(던졌든 아니든). */
  restarts: () => number
  updates: SkillUpdates
  switch: CountingSwitch
  phases: string[]
  requests: string[]
  events: string[]
  store: SkillStore
}

export function makeUpdater(opts: UpdaterOptions): Updater {
  // 맞춤 잠금만 넘겨도 그 잠금의 진입 기록과 publish 기록이 한 배열에 모인다(판정서 tests r4 C-01).
  const events = opts.events ?? opts.lock?.log ?? []
  const f = opts.candidate ?? fixture('1.0.15')
  const lock = opts.lock ?? new CountingSwitch(events)
  const phases: string[] = [], requests: string[] = []
  let restartCount = 0
  const store = opts.disk.store()
  const publish = store.publish.bind(store)
  ;(store as unknown as { publish: unknown }).publish = (p: unknown, zip: Buffer): void => {
    events.push('publish')
    return (publish as (p: unknown, z: Buffer) => void)(p, zip)
  }
  const channelBody = opts.channel ?? (() => ({ schema: 1, skill: { ...f.signed, version: f.manifest.version, api: f.manifest.api, minApp: f.manifest.minApp, url: f.manifest.url } }))
  const updates = new SkillUpdates(store, {
    config: config(),
    lock,
    emit: status => { phases.push(status.phase) },
    restartSidecar: async () => { ++restartCount; return (opts.restart ?? (async () => {}))() },
    fetch: async (url: string) => {
      requests.push(url)
      if (url === CHANNEL_URL) {
        if (opts.channelGate) { opts.channelGate.arrive(); await opts.channelGate.reached }
        return new Response(JSON.stringify(channelBody()))
      }
      if (opts.fetchGate) { opts.fetchGate.arrive(); await opts.fetchGate.reached }
      return new Response(f.zip)
    }
  })
  return { updates, switch: lock, phases, requests, events, store, restarts: () => restartCount }
}

/* ────────────────────────── 대조 도구 ────────────────────────── */

/** 진단 줄 — 시각 머리만 떼고 본문을 남긴다(설계 §4 형식 `<시각> skill:<단계> <결과>`). */
export function diagLines(file: string): string[] {
  try {
    return real.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => line.replace(/^\d+ /, ''))
  } catch { return [] }
}

/** `skill` 진단 줄만. */
export function skillDiag(file: string): string[] {
  return diagLines(file).filter(line => line.startsWith('skill:'))
}

/**
 * `skill-store` 트리 지문 — 경로·해시. 시각이 든 이름은 정규화한다(설계 §5.0 '대조 필드').
 */
export function treePrint(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let entries: string[]
    try { entries = real.readdirSync(current) } catch { return }
    for (const name of entries.sort()) {
      const path = join(current, name)
      const shown = relative(dir, path).split(sep).join('/')
        .replace(/^\.damaged-([^/]+)-\d+$/, '.damaged-$1-T')
        .replace(/^\.(stage|download)-[A-Za-z0-9]+$/, '.$1-T')
      let st
      try { st = real.statSync(path) } catch { continue }
      if (st.isDirectory()) { out.push(`${shown}/`); walk(path) } else out.push(`${shown} ${sha256Of(real.readFileSync(path))}`)
    }
  }
  walk(dir)
  return out
}

/** 시험 사이 임시 폴더 정리. */
export function sweep(roots: string[]): void {
  for (const root of roots.splice(0)) { try { real.rmSync(root, { recursive: true, force: true }) } catch { /* 이미 없다 */ } }
}

/* ────────────────────────── 골든 관측(설계 §5.0 '대조 필드') ────────────────────────── */

/** 실행마다 바뀌는 값(임시 뿌리·서명 digest·zip 해시·임시 폴더 이름)을 고정 이름으로 바꾼다. */
export function normalize(text: string, root: string): string {
  // 기록은 경로 구분자를 `/`로 남기므로(윈도 `\`→`/`) 뿌리도 두 모양을 모두 바꾼다. 맥·리눅스는 두 모양이 같다.
  let out = text.split(root).join('<root>').split(root.split(sep).join('/')).join('<root>')
  for (const f of registry) {
    const v = f.manifest.version
    out = out.split(f.verified().digest).join(`D(${v})`).split(f.manifest.sha256).join(`Z(${v})`)
  }
  // 기록만 있는 highest(`wrapDigest`)는 묶음 등록과 무관하게 고정 판 범위로 바꾼다 — 등록 목록은 Playwright가
  // 시험 실패 뒤 워커를 다시 띄우면 비므로, 등록에 기대면 같은 디스크가 실행마다 다르게 정규화된다(판정 뒤 2단계 실행에서 실측).
  for (const v of WRAP_VERSIONS) out = out.split(wrapDigest(v)).join(`W(${v})`)
  return pathTails(out
    .replace(/\.(stage|download)-[A-Za-z0-9]{6}/g, '.$1-T')
    .replace(/\.damaged-([0-9.]+)-\d+/g, '.damaged-$1-T'))
}

/**
 * 윈도: `<root>` 로 시작하는 **경로 낱말** 안의 `\`만 `/`로 바꾼다(`<root>\bundled` → `<root>/bundled`). 앱이 돌려준 경로·던진 오류 문구에
 * 든 경로가 기록(`/`)과 같은 모양이 되게 한다. 낱말은 공백·따옴표·쉼표·세미콜론·괄호에서 끝나므로 문장 전체 치환이 아니다.
 * 맥·리눅스는 `\`가 경로 구분자가 아니므로 그대로 둔다.
 */
function pathTails(text: string): string {
  if (sep === '/') return text
  return text.replace(/<root>[^\s"'`,;()<>|*?]*/g, word => word.split('\\').join('/'))
}

/** 값 안의 문자열(키 포함)만 정규화한다 — `JSON.stringify` 뒤 문자열 전체를 바꾸면 JSON 탈출(`\\`)과 엉킨다. */
function normalizeDeep(value: unknown, root: string): unknown {
  if (typeof value === 'string') return normalize(value, root)
  if (Array.isArray(value)) return value.map(item => normalizeDeep(item, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [normalize(k, root), normalizeDeep(v, root)]))
  return value
}

/**
 * 서명 파일 지문 — 파일 원문 그대로 남기되, 실행마다 바뀌는 칸(서명 값: 시험 키가 프로세스마다 새로 생긴다)만
 * `S`로 바꾸고 검증 결과(`sig-ok`/`sig-bad`)를 붙인다. 키 순서·공백·줄바꿈 같은 직렬화 차이도 그대로 드러난다.
 */
function proofPrint(path: string, root: string): string {
  const text = real.readFileSync(path, 'utf8') as string
  let sig = 'sig-bad', masked = text
  try {
    const env = JSON.parse(text) as { manifest: string; sig: string }
    if (typeof env.sig === 'string' && env.sig) masked = text.split(env.sig).join('S')
    try { verifySkill(env, keys); sig = 'sig-ok' } catch { /* 확정 무효 */ }
  } catch { sig = 'unparsable' }
  return `${JSON.stringify(normalize(masked, root))} ${sig}`
}

const WRAP_VERSIONS = Array.from({ length: 41 }, (_, i) => `1.0.${i}`)

const readOr = (path: string): string => { try { return real.readFileSync(path, 'utf8') } catch (e) { return `<${(e as { code?: string }).code ?? 'error'}>` } }

/** 상태 전부 — 기록 파일 4개 원문(정규화), 트리(서명·기록 파일 해시는 뺌), 쓰기·rename·삭제 순서. */
export function observeDisk(d: Disk): Record<string, unknown> {
  const n = (t: string): string => normalize(t, d.root)
  const tree = treePrint(d.storeDir).map(line => {
    const proof = /^(proofs\/[^ ]+\.json) [0-9a-f]{64}$/.exec(line)
    if (proof) return `${proof[1]} ${proofPrint(join(d.storeDir, proof[1]), d.root)}`
    // 기록 파일은 원문을 따로 남기므로 트리에는 이름만(digest가 실행마다 바뀐다).
    if (/^(state\.json(\.tmp|\.bad)?|highest\.json(\.tmp)?) /.test(line)) return line.replace(/ [0-9a-f]{64}$/, '')
    return normalize(line, d.root)
  })
  return {
    state: n(readOr(join(d.storeDir, 'state.json'))),
    stateTmp: n(readOr(join(d.storeDir, 'state.json.tmp'))),
    highest: n(readOr(join(d.storeDir, 'highest.json'))),
    highestTmp: n(readOr(join(d.storeDir, 'highest.json.tmp'))),
    tree,
    writes: inject.writes().map(line => n(line))
  }
}

/** 상태 표시에서 실행마다 바뀌는 칸(받은 바이트)은 뺀다. */
export function shownStatus(status: unknown): unknown {
  if (!status || typeof status !== 'object') return status
  const { received: _r, total: _t, ...rest } = status as Record<string, unknown>
  return rest
}

/** 한 조작의 결과 — 반환값(정규화) 또는 던진 문구. */
export async function outcome(d: Disk, work: () => unknown): Promise<unknown> {
  try { const got = await work(); return { ok: normalizeDeep(JSON.parse(JSON.stringify(shownStatus(got) ?? null)), d.root) } } catch (e) { return { threw: normalize(e instanceof Error ? e.message : String(e), d.root) } }
}
