import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { diagSkill } from '../diagLog'
import { readRecoverable, writeFileAtomic, type ReadFs } from '../safeWrite'
import { compatible, compare, exact, hash, MAX_BYTES, MAX_FILES, object, sha256, SKILL_API, verifySkill, version, type VerifiedSkill } from './manifest'
import { extractSkill } from './archive'
export interface Highest { version: string; manifest: string }
export interface SkillState { active: string | null; kept: Record<string, string>; highest: Highest | null }
const empty = (): SkillState => ({ active: null, kept: {}, highest: null })

/** 진단 줄의 단계 이름(설계 §4). 호출 자리가 넘기는 진단 전용 인자다. */
export type Site = 'select' | 'rollback' | 'install' | 'restore' | 'publish' | 'cleanup' | 'rollback-target' | 'disposition' | 'check'
export type ErrnoClass = 'eperm' | 'ebusy' | 'eacces' | 'emfile' | 'enfile' | 'eio' | 'enotdir' | 'eisdir' | 'eloop' | 'other'
export type Why = 'io' | 'tmp-io' | 'corrupt'
export type Obs = { known: true } | { known: false; why: Why; errno?: ErrnoClass }

/** 접근·일시 errno — 이것만 '모름'이다. 구조 errno(ENOENT·ENOTDIR·EISDIR·ELOOP)와 errno 없는 예외는 '확정'이다. */
const ACCESS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE', 'EIO'])
const codeOfError = (e: unknown): string | undefined => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}
const accessError = (e: unknown): boolean => ACCESS.has(codeOfError(e) ?? '')
const classOf = (e: unknown): ErrnoClass => {
  const lower = (codeOfError(e) ?? '').toLowerCase()
  return (['eperm', 'ebusy', 'eacces', 'emfile', 'enfile', 'eio', 'enotdir', 'eisdir', 'eloop'] as const).find(c => c === lower) ?? 'other'
}

/**
 * 기록을 지금 읽지 못했다 — 접어서 진행하지 않고 그 자리에서 멈춘다. 진단 줄은 단계와 결과 종류만 남긴다
 * (값·경로·학생 데이터 없음). `label`은 설계 §4가 따로 정한 결과 이름이 있는 단계(disposition·check)가 쓴다.
 */
export class SkillUnknown extends Error {
  constructor(readonly site: Site, readonly why: Why, readonly errno?: ErrnoClass, label?: string) {
    super('규칙집 기록을 지금 읽지 못했어요.')
    diagSkill(site, label ?? `unknown-${why}-${errno ?? 'na'}`)
  }
}
const unknownOf = (site: Site, o: Obs, label?: string): SkillUnknown => {
  if (o.known) throw new Error('unreachable')
  return new SkillUnknown(site, o.why, o.errno, label)
}

type Out = { k: 'ok' } | { k: 'bad' } | { k: 'absent' } | { k: 'io'; errno: ErrnoClass }
interface Observed<T> { result: { value: T; from: 'file' | 'tmp' } | null; threw: boolean; error?: unknown; tmp?: Out; main?: Out }
/** `readRecoverable`을 부르되 tmp·본문 각각의 읽기 결과를 적는다. 반환·예외는 그대로 같다. */
function observe<T>(file: string, parse: (text: string) => T): Observed<T> {
  const outs = new Map<string, Out>()
  let last = ''
  const fs: ReadFs = {
    readFileSync: (path, encoding) => {
      let text: string
      try { text = readFileSync(path, encoding) } catch (e) {
        outs.set(path, codeOfError(e) === 'ENOENT' ? { k: 'absent' } : { k: 'io', errno: classOf(e) })
        throw e
      }
      last = path; outs.set(path, { k: 'ok' })
      return text
    }
  }
  const watched = (text: string): T => { try { return parse(text) } catch (e) { outs.set(last, { k: 'bad' }); throw e } }
  const tmp = `${file}.tmp`
  try {
    const result = readRecoverable(file, watched, fs)
    return { result, threw: false, tmp: outs.get(tmp), main: outs.get(file) }
  } catch (error) {
    return { result: null, threw: true, error, tmp: outs.get(tmp), main: outs.get(file) }
  }
}
/** `existsSync` 대신 — 접근 오류를 '없음'으로 접지 않는다. */
function presence(path: string): 'yes' | 'no' | { errno: ErrnoClass } {
  try { lstatSync(path); return 'yes' } catch (e) { return accessError(e) ? { errno: classOf(e) } : 'no' }
}

export interface StateDetail {
  /** 기준판 `state()`와 같은 값(못 읽으면 접은 값). */
  value: SkillState
  selection: Obs
  highest: Obs
  /** 기준판 `state()`가 던졌을 오류 — `state()`·`strict()`가 그대로 던진다. */
  legacy: { error: unknown } | null
  from: 'file' | 'tmp' | 'none'
}
export type Validity = { ok: true } | { ok: false; sure: true } | { ok: false; sure: false; errno: ErrnoClass }
export interface Resolved { source: string; version: string; /** 진단 줄의 결과 이름(값·경로 없음). */ reason: string; /** 무효로 본 판(resolver가 실제로 검사한 판). 진단의 보관 목록 대조용이며 밖으로 내보내지 않는다. */ checked?: string }

function highest(v: unknown): Highest {
  const h = object(v); exact(h, ['version', 'manifest']); version(h.version); hash(h.manifest)
  return h as unknown as Highest
}
function parseState(text: string): SkillState {
  const s = object(JSON.parse(text)); exact(s, ['active', 'kept', 'highest'])
  if (s.active !== null) version(s.active)
  const kept = object(s.kept)
  for (const [v, digest] of Object.entries(kept)) { version(v); hash(digest) }
  if (s.active !== null && !Object.hasOwn(kept, String(s.active))) throw new Error('보관판 상태가 잘못됐어요.')
  if (s.highest !== null) highest(s.highest)
  return s as unknown as SkillState
}
function persist(file: string, value: unknown, complete: (text: string) => unknown): void {
  const result = writeFileAtomic(file, JSON.stringify(value), { mode: 0o600, complete: text => { try { complete(text); return true } catch { return false } } })
  if (!result.ok) throw result.error
}
export class SkillStore {
  readonly root: string
  readonly bundledVersion: string
  constructor(userData: string, readonly bundled: string, readonly appVersion: string, readonly keys: readonly string[]) {
    this.root = join(userData, 'skill-store')
    // S0 must be a composed bundle, never an inferred version for an old checkout.
    const m = object(JSON.parse(readFileSync(join(bundled, 'skill.json'), 'utf8')))
    version(m.version)
    if (m.api !== SKILL_API) throw new Error('동봉 규칙집 약속의 판이 맞지 않아요.')
    this.bundledVersion = m.version
    mkdirSync(join(this.root, 'proofs'), { recursive: true })
  }
  /** 기준판 `state()`와 같은 파일을 같은 순서로 읽고, 못 읽은 것이 있었는지 함께 돌려준다. 던지지 않는다. */
  stateDetail(): StateDetail {
    const stateFile = join(this.root, 'state.json'), highestFile = join(this.root, 'highest.json')
    let s = empty(), from: StateDetail['from'] = 'none'
    // Corrupt active state falls back to bundle; independent high-water survives.
    const a = observe(stateFile, parseState)
    if (a.result) { s = a.result.value; from = a.result.from }
    let selection: Obs = { known: true }
    if (a.tmp?.k === 'io') selection = { known: false, why: 'tmp-io', errno: a.tmp.errno }
    else if (a.threw) selection = a.main?.k === 'io' ? { known: false, why: 'io', errno: a.main.errno } : { known: false, why: 'corrupt' }
    const b = observe(highestFile, text => highest(JSON.parse(text)))
    let hi: Obs = { known: true }
    if (b.tmp?.k === 'io') hi = { known: false, why: 'tmp-io', errno: b.tmp.errno }
    else if (b.main?.k === 'io') hi = { known: false, why: 'io', errno: b.main.errno }
    let legacy: StateDetail['legacy'] = null
    const backup = b.result?.value
    if (b.threw) {
      // A malformed backup must not erase a valid state high-water mark.
      if (!s.highest && presence(highestFile) === 'yes') legacy = { error: b.error }
    }
    if (!legacy) {
      if (backup && (!s.highest || compare(backup.version, s.highest.version) > 0)) s.highest = backup
      else if (backup && s.highest && backup.version === s.highest.version && backup.manifest !== s.highest.manifest) legacy = { error: new Error('같은 판의 확인값이 달라요.') }
    }
    return { value: s, selection, highest: hi, legacy, from }
  }
  /** 표시·소비용 — 기준판과 같은 값과 같은 예외. 못 읽음은 접힌 값으로 나온다. */
  state(): SkillState {
    const d = this.stateDetail()
    if (d.legacy) throw d.legacy.error
    return d.value
  }
  /**
   * 쓰기를 결정하는 자리용 — 선택·highest를 못 읽었으면 접지 않고 던진다. 모름은 기준판이 던졌을 원시 오류(`legacy`)보다 먼저
   * 가른다: 엄격한 자리에서 경로가 든 원시 오류가 나가면 호출부가 '모름'으로 처리하지 못한다(roh293 I-01).
   * `healCorrupt`는 시작 정리만(깨진 본문은 기준판처럼 비운다).
   */
  private strictDetail(site: Site, healCorrupt: boolean): StateDetail {
    const d = this.stateDetail()
    if (!d.selection.known && !(healCorrupt && d.selection.why === 'corrupt')) throw unknownOf(site, d.selection)
    if (!d.highest.known) throw unknownOf(site, d.highest)
    if (d.legacy) throw d.legacy.error
    return d
  }
  strict(site: Site): SkillState { return this.strictDetail(site, false).value }
  /**
   * `checkNow`용 — 최고판은 본문(`state.json`)과 백업(`highest.json`) 양쪽에 있으므로 어느 쪽을 못 읽어도 모른다.
   * 본문을 못 읽으면 본문에 든 최고판도 모른다(roh293 C-01).
   */
  strictHighest(site: Site, label?: string): Highest | null {
    const d = this.stateDetail()
    if (!d.selection.known) throw unknownOf(site, d.selection, label)
    if (!d.highest.known) throw unknownOf(site, d.highest, label)
    if (d.legacy) throw d.legacy.error
    return d.value.highest
  }
  private write(s: SkillState): void {
    persist(join(this.root, 'state.json'), s, parseState)
    if (s.highest) persist(join(this.root, 'highest.json'), s.highest, text => highest(JSON.parse(text)))
  }
  proof(v: string, digest: string): VerifiedSkill {
    version(v)
    const proof = verifySkill(JSON.parse(readFileSync(join(this.root, 'proofs', `${v}.json`), 'utf8')), this.keys)
    if (proof.manifest.version !== v || proof.digest !== digest || !compatible(proof.manifest, this.appVersion)) throw new Error('보관판 정보가 맞지 않아요.')
    return proof
  }
  /** 보관판 검증 — 접근·일시 오류는 '확정 무효'가 아니라 '모름'으로 가른다. */
  check(v: string, digest: string): Validity {
    try {
      const { manifest } = this.proof(v, digest), base = join(this.root, v)
      if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return { ok: false, sure: true }
      let count = 0, total = 0
      const seen = new Set<string>()
      const walk = (dir: string, prefix: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const name = prefix + e.name, path = join(dir, e.name), st = lstatSync(path)
          if (st.isSymbolicLink()) throw new Error('link')
          if (st.isDirectory()) { walk(path, name + '/'); continue }
          if (!st.isFile() || !Object.hasOwn(manifest.files, name) || ++count > MAX_FILES || (total += st.size) > MAX_BYTES || sha256(readFileSync(path)) !== manifest.files[name]) throw new Error('file')
          seen.add(name)
        }
      }
      walk(base, '')
      if (seen.size !== Object.keys(manifest.files).length) return { ok: false, sure: true }
      const m = JSON.parse(readFileSync(join(base, 'skill.json'), 'utf8'))
      return m.version === manifest.version && m.api === manifest.api ? { ok: true } : { ok: false, sure: true }
    } catch (e) { return accessError(e) ? { ok: false, sure: false, errno: classOf(e) } : { ok: false, sure: true } }
  }
  valid(v: string, digest: string): boolean { return this.check(v, digest).ok }
  validStrict(v: string, digest: string, site: Site): boolean {
    const r = this.check(v, digest)
    if (!r.ok && !r.sure) throw new SkillUnknown(site, 'io', r.errno)
    return r.ok
  }
  /** 읽기 전용 — 기준판 resolver와 같은 소스를 고르고, 고른 이유(진단용)를 함께 돌려준다. */
  resolve(): Resolved {
    const bundle = (reason: string): Resolved => ({ source: this.bundled, version: this.bundledVersion, reason: `bundle-${reason}` })
    try {
      const d = this.stateDetail()
      if (d.legacy) throw d.legacy.error
      const s = d.value, v = s.active
      const unread = (): string => {
        const o = d.selection
        return o.known ? 'forced-state-error' : o.why === 'corrupt' ? 'forced-state-corrupt' : `forced-state-unread-${o.why}-${o.errno ?? 'na'}`
      }
      if (v && compare(v, this.bundledVersion) >= 0) {
        const c = this.check(v, s.kept[v])
        if (c.ok) return { source: join(this.root, v), version: v, reason: 'store' }
        return { ...bundle(`forced-invalid-${c.sure ? 'sure' : `io-${c.errno}`}`), checked: v }
      }
      if (!d.selection.known) return bundle(unread())
      return bundle(v ? 'chosen-newer' : `chosen-no-active-${d.from}`)
    } catch { return bundle('forced-state-error') /* Unusable store never prevents trusted bundled operation. */ }
  }
  resolveSkillSource(): string { return this.resolve().source }
  /** 쓰기를 결정하는 자리용 resolver — 모름이면 동봉으로 접지 않고 던진다. */
  effStrict(site: Site, out?: { forced: boolean }): string {
    const s = this.strict(site), v = s.active
    if (v && compare(v, this.bundledVersion) >= 0 && this.validStrict(v, s.kept[v], site)) return join(this.root, v)
    // 기록상 선택이 있는데 못 쓰는 판이라 동봉으로 내려갔다(진단 줄의 chosen/forced 구분용).
    if (out) out.forced = v !== null && compare(v, this.bundledVersion) >= 0
    return this.bundled
  }
  private matchesBundle(p: VerifiedSkill): boolean {
    const file = join(this.bundled, 'install-manifest.json')
    // 기준판처럼 두 번 읽고(단락 평가 유지) 각 읽기에서 접근·일시 오류만 '모름'으로 가른다.
    const read = (): Buffer => {
      try { return readFileSync(file) } catch (e) {
        if (accessError(e)) throw new SkillUnknown('disposition', 'io', classOf(e), 'unknown-bundle-manifest')
        throw e
      }
    }
    try {
      const manifest = object(JSON.parse(read().toString('utf8')))
      exact(manifest, ['schema', 'files'])
      if (manifest.schema !== 'knuaf-doc/install-manifest@1') return false
      const files = object(manifest.files), signedFiles = p.manifest.files
      const names = Object.keys(files)
      return Object.keys(signedFiles).length === names.length + 1 &&
        signedFiles['install-manifest.json'] === sha256(read()) &&
        names.every(name => files[name] === signedFiles[name])
    } catch (e) { if (e instanceof SkillUnknown) throw e; return false }
  }
  disposition(p: VerifiedSkill): 'new' | 'repair' | 'kept' {
    const m = p.manifest, d = this.stateDetail(), s = d.value
    if (!d.highest.known) throw unknownOf('disposition', d.highest, 'unknown-highest')
    if (d.legacy) throw d.legacy.error
    if (!compatible(m, this.appVersion)) throw new Error('이 규칙집은 앱 새 판이 필요해요.')
    if (!d.selection.known) {
      // 선택을 못 읽었다 — 어느 갈래로 가든 결과가 같을 때만 기준판 식으로 끝낸다. 갈래가 갈리면 모름이다.
      const fail = (): never => { throw unknownOf('disposition', d.selection, 'unknown-selection') }
      const floor = [this.bundledVersion, s.highest?.version].filter((v): v is string => !!v).sort(compare).at(-1)!
      if (compare(m.version, floor) > 0) fail()
      if (compare(m.version, this.bundledVersion) === 0 && (!s.highest || compare(s.highest.version, m.version) < 0) && this.matchesBundle(p)) fail()
      if (s.highest?.version === m.version && s.highest.manifest === p.digest && compare(m.version, this.bundledVersion) >= 0) fail()
      throw new Error('이전 판이거나 같은 판의 내용이 달라서 받지 않아요.')
    }
    const floor = [this.bundledVersion, s.active, s.highest?.version].filter((v): v is string => !!v).sort(compare).at(-1)!
    if (compare(m.version, floor) > 0) return 'new'
    if (compare(m.version, this.bundledVersion) === 0 && (!s.highest || compare(s.highest.version, m.version) < 0) && (!s.active || compare(s.active, m.version) < 0) && this.matchesBundle(p)) return 'kept'
    if (s.highest?.version === m.version && s.highest.manifest === p.digest && compare(m.version, this.bundledVersion) >= 0) return s.kept[m.version] === p.digest && this.validStrict(m.version, p.digest, 'disposition') ? 'kept' : 'repair'
    throw new Error('이전 판이거나 같은 판의 내용이 달라서 받지 않아요.')
  }
  publish(p: VerifiedSkill, zip: Buffer): void {
    this.disposition(p)
    const temp = mkdtempSync(join(this.root, '.stage-')), v = p.manifest.version
    try {
      extractSkill(zip, temp, p.manifest)
      persist(join(this.root, 'proofs', `${v}.json`), p.envelope, text => verifySkill(JSON.parse(text), this.keys))
      const destination = join(this.root, v)
      // Repairs replace only a verified-version store folder; never an arbitrary path.
      const there = presence(destination)
      if (typeof there === 'object') throw new SkillUnknown('publish', 'io', there.errno)
      if (there === 'yes') {
        if (this.strict('publish').active === v && this.validStrict(v, p.digest, 'publish')) throw new Error('사용 중인 정상 보관판은 바꾸지 않아요.')
        const quarantine = join(this.root, `.damaged-${v}-${Date.now()}`)
        renameSync(destination, quarantine)
      }
      renameSync(temp, destination)
      const s = this.strict('publish')
      s.kept[v] = p.digest
      s.highest = { version: v, manifest: p.digest }
      this.write(s)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  }
  select(v: string | null, site: Site = 'select'): string | null {
    const s = this.strict(site), previous = s.active
    if (v !== null) {
      version(v)
      if (compare(v, this.bundledVersion) < 0 || !Object.hasOwn(s.kept, v) || !this.validStrict(v, s.kept[v], site)) throw new Error('이 보관판은 사용할 수 없어요.')
    }
    s.active = v
    this.write(s)
    return previous
  }
  rollbackTarget(): string | null {
    const s = this.strict('rollback-target'), current = this.effStrict('rollback-target') === this.bundled ? this.bundledVersion : s.active!
    return Object.keys(s.kept).filter(v => compare(v, current) < 0 && compare(v, this.bundledVersion) >= 0 && this.validStrict(v, s.kept[v], 'rollback-target')).sort(compare).at(-1) ?? null
  }
  /**
   * 깨진 본문의 원본을 `state.json.bad`로 남긴다. 새 백업은 같은 폴더의 별도 이름에 배타 생성(`wx`, 0o600)으로 다 쓴 뒤에만
   * `rename`으로 `.bad` 자리에 올린다 — rename은 기존 `.bad`가 파일이든 링크든 그 이름만 바꿔 끼우고 링크 대상은 건드리지 않는다.
   * 쓰기·rename이 실패하면 임시 파일만 치우고 기존 `.bad`와 본문은 그대로 둔 채 던진다(호출부는 본문 정리를 하지 않는다).
   */
  private backupCorrupt(): void {
    const body = join(this.root, 'state.json'), bad = `${body}.bad`, temp = `${bad}.new-${randomBytes(6).toString('hex')}`
    const original = readFileSync(body)
    try {
      writeFileSync(temp, original, { flag: 'wx', mode: 0o600 })
      renameSync(temp, bad)
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 만들어지지 않았거나 이미 옮겨졌다 */ }
      throw error
    }
  }
  /** Startup only, before any user request can hold an old source. */
  cleanup(): void {
    const d = this.strictDetail('cleanup', true), s = d.value, versions = Object.keys(s.kept).sort(compare).reverse()
    // 깨진 본문은 기준판처럼 비운 상태로 덮되, 덮기 전에 원본을 남긴다(되짓기는 다음 판). 남기지 못하면 덮지 않는다.
    if (!d.selection.known) this.backupCorrupt()
    const retain = new Set([...new Set([s.active, s.highest?.version, ...versions].filter((v): v is string => !!v))].slice(0, 2))
    for (const v of versions) if (!retain.has(v)) {
      rmSync(join(this.root, v), { recursive: true, force: true })
      rmSync(join(this.root, 'proofs', `${v}.json`), { force: true })
      delete s.kept[v]
    }
    this.write(s)
    for (const entry of readdirSync(this.root)) {
      if (/^\.(stage|download|damaged)-/.test(entry)) rmSync(join(this.root, entry), { recursive: true, force: true })
    }
  }
}
