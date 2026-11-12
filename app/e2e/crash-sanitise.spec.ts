// Node-only: 오류 보고 수집기(sanitise.ts)의 허용 목록·큐 I/O·예외 경계. Electron 을 띄우지 않는다.
// 정본은 DESIGN §2-3(표·반례 6종·정규화 예)·§2-4(큐·상한)·§2-6(중복)·§4 시험 (1)(2)(3)·시나리오 E.
import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import * as sanitiseModule from '../src/main/crash/sanitise'
import type * as CrashModule from '../src/main/crash/index'
import {
  BUNDLE_FILES,
  CRASH_REASONS,
  DAILY_MAX,
  ERROR_CODES,
  ERROR_ERR,
  ERROR_ERRNO,
  ERROR_NAMES,
  MAX_AGE_DAYS,
  MAX_ATTEMPT,
  MAX_ITEM_BYTES,
  MAX_KEYS,
  MAX_QUEUE_ITEMS,
  buildRecord,
  clearQueue,
  coerceCode,
  coerceName,
  crashPaths,
  dedupeKey,
  enqueue,
  findWhere,
  localDay,
  normaliseFrame,
  readQueue,
  readState,
  reviveRecord,
  rollState,
  safely,
  setBundleAssets,
  writeQueue,
  writeState,
  type RecordContext
} from '../src/main/crash/sanitise'

const appRoot = '/opt/knuaf/resources/app.asar'
const ctx = (now = new Date('2026-11-12T08:31:02.184Z')): RecordContext => ({
  appRoot,
  version: '0.6.2',
  platform: 'darwin',
  release: '25.6.0',
  arch: 'arm64',
  now
})

function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), 'knuaf-crash-'))
}

// ── (1) §2-3 표: 아는 값만 통과, 모르는 값은 고정 분류 ─────────────────────────

test('error.name 은 고정 15종에 정확히 같을 때만 살아남는다', () => {
  expect(ERROR_NAMES).toHaveLength(15)
  for (const name of ERROR_NAMES) expect(coerceName(name)).toBe(name)
  // 목록 밖은 이벤트를 버리지 않고 'Other' 로 낮춘다.
  expect(coerceName('CustomError')).toBe('Other')
  expect(coerceName('Error ')).toBe('Other')
  expect(coerceName(undefined)).toBe('Other')
  expect(coerceName(42)).toBe('Other')
})

test('error.code 는 errno 31 + ERR_ 38 + reason 6 의 합집합에 정확히 같을 때만 살아남는다', () => {
  expect(ERROR_ERRNO).toHaveLength(31)
  expect(ERROR_ERR).toHaveLength(38)
  expect(CRASH_REASONS).toHaveLength(6)
  expect(ERROR_CODES).toHaveLength(75)
  for (const code of ERROR_CODES) expect(coerceCode(code)).toBe(code)
  expect(coerceCode('EUNKNOWN')).toBeNull()
  expect(coerceCode(null)).toBeNull()
})

test('반례 6종: 파일 이름·학번·비밀값·논문 제목이 이름/코드 자리에 와도 낮아진다', () => {
  const leaks = ['MyThesisDraft.docx', 'Student20231234', 'sk-live-test-MARKER123', 'BusanFarmProfit2026']
  for (const leak of leaks) {
    expect(coerceName(leak)).toBe('Other')
    expect(coerceCode(leak)).toBeNull()
  }
  // 모양은 `ERR_` 로 맞지만 목록 밖 — 형식 검사가 아니라 목록이라서 떨어진다(FIX2 · C-01).
  expect(coerceCode('ERR_BUSAN_FARM_PROFIT')).toBeNull()
  expect(coerceCode('ERR_SECRET_TOKEN')).toBeNull()
  expect(coerceCode('ERR_MY_CUSTOM_THING')).toBeNull()
})

test('buildRecord — 스키마 고정, 원문 메시지·경로·인자는 어디에도 없다', () => {
  const error = Object.assign(new TypeError('내 논문 /Users/김대욱/자료.docx 의 sk-live-123'), { code: 'ENOENT' })
  error.stack = 'TypeError: boom\n    at f (' + appRoot + '/out/main/index.js:21741:19)\n    at i (/Users/nara/node-pty/lib/index.js:88:11)'
  const rec = buildRecord({ source: 'main', name: error.name, code: error.code, origin: 'uncaughtException', stack: error.stack }, ctx())
  expect(rec).not.toBeNull()
  expect(rec).toEqual({
    schema: 1,
    kind: 'crash',
    app: { version: '0.6.2' },
    os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' },
    source: 'main',
    error: { name: 'TypeError', code: 'ENOENT', origin: 'uncaughtException' },
    where: { file: 'out/main/index.js', line: 21741 },
    at: '2026-11-12T08:31:02.184Z'
  })
  const wire = JSON.stringify(rec)
  for (const leak of ['내 논문', '김대욱', '자료.docx', 'sk-live-123', 'node-pty', 'boom']) expect(wire).not.toContain(leak)
  expect(wire).not.toMatch(/"(message|stack|path)":/)
})

test('buildRecord — 표의 목록 밖 값은 고정 분류로 낮아지고 이벤트는 살아남는다', () => {
  const rec = buildRecord(
    { source: 'main', name: 'WeirdError', code: 'ERR_SECRET_TOKEN', origin: 'somethingElse', stack: null },
    { ...ctx(), version: 'not-a-version', platform: 'freebsd', release: '한글 릴리스'.repeat(20), arch: 'mips' }
  )
  expect(rec).not.toBeNull()
  expect(rec!.app.version).toBe('0.0.0')
  expect(rec!.os).toEqual({ platform: 'other', release: null, arch: 'other' })
  expect(rec!.error).toEqual({ name: 'Other', code: null })
  expect(rec!.where).toBeNull()
  // source 가 목록 밖이면 유일하게 이벤트를 버린다(Worker 의 400 조건과 같은 자리).
  expect(buildRecord({ source: 'gpu', name: 'Error', code: null }, ctx())).toBeNull()
  expect(buildRecord({ source: 42, name: 'Error', code: null }, ctx())).toBeNull()
})

test('where.file 정규화 — §2-3 의 정규화 행 그대로(행마다 자기 앱 루트)', () => {
  // 행마다 앱 루트가 다르다 — 실기기·개발 실행·설치 floor 가 각각 다른 값을 `getAppPath()` 로 준다.
  // 규칙은 "이 경로가 **그 루트로 시작**하는가" 하나뿐이므로 행마다 자기 루트를 넘긴다.
  const macApp = '/Applications/창업논문 도우미.app/Contents/Resources/app.asar'
  const winApp = 'C:\\Users\\김대욱\\AppData\\Local\\Programs\\knuaf-dev\\resources\\app.asar'
  const rows: [string, { file: string; line: number } | null, string][] = [
    ['at f (/Applications/창업논문 도우미.app/Contents/Resources/app.asar/out/main/index.js:21741:19)', { file: 'out/main/index.js', line: 21741 }, macApp],
    ['at g (C:\\Users\\김대욱\\AppData\\Local\\Programs\\knuaf-dev\\resources\\app.asar\\out\\main\\index.js:9021:7)', { file: 'out/main/index.js', line: 9021 }, winApp],
    // ESM 스택의 `file://` 형태 — 개발 실행이라 앱 루트가 asar 밖이다.
    ['at h (file:///Users/nara/dev/app/out/main/index.js:431:9)', { file: 'out/main/index.js', line: 431 }, '/Users/nara/dev/app'],
    ['at i (/Users/nara/Library/pnpm/…/node-pty/lib/index.js:88:11)', null, appRoot],
    ['at j (/Users/김대욱/논문/내자료.js:1:1)', null, appRoot],
    ['at k (…/app.asar/out/main/MyThesisDraft.docx:12:3)', null, appRoot],
    ['at l (/Users/김대욱/out/main/index.js:5:1)', null, appRoot],
    // 같은 Mac 경로라도 루트가 다르면 통과하지 않는다 — 경로 조각(`app.asar/`)이 아니라 루트 전체가 기준이다.
    ['at f (/Applications/창업논문 도우미.app/Contents/Resources/app.asar/out/main/index.js:21741:19)', null, appRoot]
  ]
  for (const [frame, want, root] of rows) expect(normaliseFrame(frame, root)).toEqual(want)
  // 앱 루트가 asar 가 아니라 풀린 디렉터리인 개발 실행도 같은 규칙을 탄다.
  expect(normaliseFrame('at f (/Users/nara/dev/app/out/preload/index.js:7:3)', '/Users/nara/dev/app')).toEqual({
    file: 'out/preload/index.js',
    line: 7
  })
  expect(BUNDLE_FILES).toEqual(['out/main/index.js', 'out/preload/index.js'])
})

test('findWhere 는 Node 내부 프레임이 앞에 와도 앱 묶음 첫 프레임을 고른다', () => {
  const stack = ['Error: x', '    at processTicksAndRejections (node:internal/process/task_queues:95:5)', '    at f (/Users/nara/dev/app/out/main/index.js:431:9)'].join('\n')
  expect(findWhere(stack, '/Users/nara/dev/app')).toEqual({ file: 'out/main/index.js', line: 431 })
  expect(findWhere('', appRoot)).toBeNull()
  expect(findWhere(undefined, appRoot)).toBeNull()
  // 줄 번호 상한 밖이면 위치 없이 이벤트만 남는다.
  expect(normaliseFrame('at f (' + appRoot + '/out/main/index.js:1000001:1)', appRoot)).toBeNull()
})

test('렌더러 청크 — 실제 산출물 목록에 정확히 있는 이름만 통과한다(C-01)', () => {
  // 목록은 시작 때 `out/renderer/assets` 를 읽어 채운다 — 여기서는 그 실측 이름 둘을 심는다.
  const pass = ['index-D9UkElgs.js', 'DocxHtmlView-B8MfJWQz.js']
  setBundleAssets(pass)
  try {
    for (const name of pass) {
      const file = `out/renderer/assets/${name}`
      expect(normaliseFrame(`at f (${appRoot}/${file}:12:3)`, appRoot)).toEqual({ file, line: 12 })
    }
    const reject = [
      'out/renderer/assets/index-D9UkElg.js', // 해시 7자 — 목록 밖
      'out/renderer/assets/index-D9UkElgsZ.js', // 해시 9자
      'out/renderer/assets/index D9UkElgs.js', // 공백
      'out/renderer/assets/index-D9UkElgs.jsx',
      'out/renderer/assets/index-D9UkElgs.css',
      'out/renderer/assets/Student20231234-AbCd1234.js', // 학번형 — 모양은 청크와 같다
      'out/main/MyThesisDraft.docx'
    ]
    for (const file of reject) expect(normaliseFrame(`at f (${appRoot}/${file}:12:3)`, appRoot)).toBeNull()
  } finally {
    // 목록은 모듈 전역 상태 — 다른 시험이 이 시험의 순서에 기대지 않도록 비운다(빈 목록 = 실패 폐쇄).
    setBundleAssets([])
  }
})

test('C-01 — 앱 루트 밖 경로·UNC·논문 제목형 이름은 큐와 POST 본문에 남지 않는다', () => {
  const asset = 'out/renderer/assets/Student20231234-AbCd1234.js'
  setBundleAssets(['Student20231234-AbCd1234.js'])
  try {
    // Roh 반례 그대로: 루트가 `/opt/…/app.asar` 인데 경로는 `notapp.asar` — 부분문자열 신뢰가 뚫렸다.
    // 두 번째 행이 가장 날카롭다: 이름은 **허용 목록에 있는** `out/main/index.js` 지만 루트가 남의 것이다.
    const frames = [
      `/Users/student/notapp.asar/${asset}`,
      '/Users/student/notapp.asar/out/main/index.js',
      '/Users/student/notapp.asar/out/main/MyThesisDraft.docx',
      '\\\\server\\share\\BusanFarmProfit2026\\out\\renderer\\assets\\Student20231234-AbCd1234.js',
      '/Users/김대욱/out/main/index.js'
    ]
    for (const path of frames) {
      const stack = `Error: x\n    at f (${path}:4:2)`
      const rec = buildRecord({ source: 'main', name: 'TypeError', code: null, origin: 'uncaughtException', stack }, ctx())
      expect(rec).not.toBeNull()
      expect(rec!.where).toBeNull()
      // 같은 규칙이 디스크 경계에도 걸린다 — 변조된 큐 항목이 그대로 POST 로 나가면 안 된다.
      const revived = reviveRecord({ ...rec, where: { file: 'Student20231234-AbCd1234.js', line: 4 } }, ctx().now)
      expect(revived!.where).toBeNull()
      expect(JSON.stringify(rec)).not.toMatch(/Student20231234|MyThesisDraft|BusanFarmProfit|김대욱|notapp/)
    }
  } finally {
    setBundleAssets([])
  }
  // 루트 안의 진짜 산출물은 계속 통과한다 — 조이면서 진단을 잃지 않았다.
  const ok = buildRecord({ source: 'main', name: 'TypeError', code: null, origin: 'uncaughtException', stack: `at f (${appRoot}/out/main/index.js:7:1)` }, ctx())
  expect(ok!.where).toEqual({ file: 'out/main/index.js', line: 7 })
})

// ── (2) 큐·상태 — 상한·중복·날짜 리셋 ──────────────────────────────────────────

const rec = (over: Partial<Parameters<typeof buildRecord>[0]> = {}) =>
  buildRecord({ source: 'main', name: 'TypeError', code: 'ENOENT', origin: 'uncaughtException', stack: null, ...over }, ctx())!

test('항목 상한 — 필드를 꽉 채운 레코드도 1KB 안에 들어간다', () => {
  const full = rec({ name: 'AggregateError', code: 'ERR_INVALID_RETURN_VALUE' })
  full.app.version = '999.999.999-abcdefghijklmnop'
  full.os.release = 'a'.repeat(64)
  const bytes = Buffer.byteLength(JSON.stringify({ rec: full, attempt: MAX_ATTEMPT, first_seen: full.at }), 'utf8')
  expect(bytes).toBeLessThanOrEqual(MAX_ITEM_BYTES)
})

test('enqueue — 같은 날 같은 오류는 한 번만, 큐는 3건에서 멈춘다', () => {
  const dir = tempUserData()
  try {
    const now = new Date('2026-11-12T09:00:00.000Z')
    const first = rec()
    enqueue(dir, first, now)
    enqueue(dir, { ...first }, now)
    expect(readQueue(dir, now)).toHaveLength(1)
    enqueue(dir, rec({ code: 'EACCES' }), now)
    enqueue(dir, rec({ code: 'EPERM' }), now)
    enqueue(dir, rec({ code: 'EISDIR' }), now)
    expect(readQueue(dir, now)).toHaveLength(MAX_QUEUE_ITEMS)
    // 큐가 꽉 차면 넣지 않고, dedupe 키도 기록하지 않는다 — 다음 날 그 오류를 막지 않는다.
    expect(readState(dir, now).keys).toHaveLength(MAX_QUEUE_ITEMS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueue — 손상·상한 초과·모양 위반 항목은 버리고 남은 것만 돌려준다', () => {
  const dir = tempUserData()
  try {
    const paths = crashPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    const good = rec()
    writeFileSync(paths.queue, JSON.stringify({ schema: 1, items: [
      { rec: good, attempt: 0, first_seen: good.at },
      { rec: { ...good, source: 'gpu' }, attempt: 0, first_seen: good.at },
      { rec: good, attempt: -1, first_seen: 'nope' }
    ] }), 'utf8')
    const items = readQueue(dir)
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.attempt)).toEqual([0, 0])
    expect(items[1].first_seen).toBe(good.at)
    // 깨진 JSON·4KB 초과·모양 위반은 빈 큐로 접힌다(예외 없음).
    writeFileSync(paths.queue, '{not json', 'utf8')
    expect(readQueue(dir)).toEqual([])
    writeFileSync(paths.queue, JSON.stringify({ items: 'nope' }), 'utf8')
    expect(readQueue(dir)).toEqual([])
    writeFileSync(paths.queue, 'x'.repeat(4097), 'utf8')
    expect(readQueue(dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueue — first_seen 이 30일 지난 항목은 읽을 때 버린다(I-01)', () => {
  const dir = tempUserData()
  try {
    const paths = crashPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    const now = new Date('2026-11-12T08:31:02.184Z')
    const old = { ...rec(), at: '2020-01-01T00:00:00.000Z' }
    const fresh = rec()
    writeFileSync(paths.queue, JSON.stringify({ schema: 1, items: [
      { rec: old, attempt: 0, first_seen: '2020-01-01T00:00:00.000Z' },
      // 형식만 맞는 `first_seen` 은 레코드 시각으로 대신 판정한다.
      { rec: fresh, attempt: 0, first_seen: 'nope' },
      { rec: { ...fresh, error: { ...fresh.error, code: 'EACCES' } }, attempt: 0, first_seen: '2021-06-01T00:00:00.000Z' }
    ] }), 'utf8')
    const items = readQueue(dir, now)
    expect(items).toHaveLength(1)
    expect(items[0].first_seen).toBe(fresh.at)
    // 경계 — 정확히 30일이면 살아 있고(초과만 폐기), 하루 더 지나면 사라진다.
    const edge = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    writeFileSync(paths.queue, JSON.stringify({ schema: 1, items: [
      { rec: fresh, attempt: 0, first_seen: edge.toISOString() }
    ] }), 'utf8')
    expect(readQueue(dir, now)).toHaveLength(1)
    writeFileSync(paths.queue, JSON.stringify({ schema: 1, items: [
      { rec: fresh, attempt: 0, first_seen: new Date(edge.getTime() - 1000).toISOString() }
    ] }), 'utf8')
    expect(readQueue(dir, now)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reviveRecord — 디스크 변조값도 같은 허용 목록으로 다시 낮춘다', () => {
  const raw = { schema: 9, kind: 'crash', app: { version: '0.6.2' }, os: { platform: 'linux', arch: 'x64' },
    source: 'renderer', error: { name: 'MyThesisDraft.docx', code: 'sk-live-test-MARKER123' },
    where: { file: 'out/main/MyThesisDraft.docx', line: 3 }, at: '2026-11-12T08:31:02.184Z' }
  const revived = reviveRecord(raw, new Date('2026-11-12T08:31:02.184Z'))
  expect(revived).not.toBeNull()
  expect(revived!.schema).toBe(1)
  expect(revived!.error).toEqual({ name: 'Other', code: null })
  expect(revived!.where).toBeNull()
  expect(revived!.os.release).toBeNull()
  expect(reviveRecord([], new Date())).toBeNull()
  expect(reviveRecord('x', new Date())).toBeNull()
})

test('dedupeKey 는 source·name·code·file·line·version 조합이고 날짜가 바뀌면 상태가 리셋된다', () => {
  const a = rec()
  expect(dedupeKey(a)).toBe('main|TypeError|ENOENT|-|-|0.6.2')
  a.where = { file: 'out/main/index.js', line: 7 }
  expect(dedupeKey(a)).toBe('main|TypeError|ENOENT|out/main/index.js|7|0.6.2')
  const day = new Date('2026-11-12T12:00:00.000Z')
  const state = { schema: 1 as const, day: localDay(day), sent: DAILY_MAX, keys: ['k'] }
  expect(rollState(state, day)).toBe(state)
  const next = rollState(state, new Date('2026-11-13T12:00:00.000Z'))
  expect(next).toEqual({ schema: 1, day: '2026-11-13', sent: 0, keys: [] })
  // state.keys 길이 상한 — 넘으면 오래된 것부터 버린다.
  const dir = tempUserData()
  try {
    const long = { schema: 1 as const, day: localDay(day), sent: 0, keys: Array.from({ length: MAX_KEYS + 5 }, (_, i) => `k${i}`) }
    writeState(dir, long)
    const back = readState(dir, day)
    expect(back.keys).toHaveLength(MAX_KEYS)
    expect(back.keys[0]).toBe('k5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearQueue 는 빈 큐를 남기고, 큐·상태는 서로 다른 파일이다', () => {
  const dir = tempUserData()
  try {
    const now = new Date('2026-11-12T09:00:00.000Z')
    enqueue(dir, rec(), now)
    expect(readQueue(dir, now)).toHaveLength(1)
    clearQueue(dir)
    expect(readQueue(dir, now)).toEqual([])
    const paths = crashPaths(dir)
    expect(paths.queue).not.toBe(paths.state)
    expect(JSON.parse(readFileSync(paths.queue, 'utf8'))).toEqual({ schema: 1, items: [] })
    writeQueue(dir, [])
    writeQueue(dir, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── (3) 전송 경계 — 3xx 재전송 금지(I-02)·429 중단 유지(R-01) ─────────────────
//
// `crash/index.ts` 는 `electron` 을 import 하므로 Node 시험에서 그대로 못 쓴다. Electron 대신
// 가짜 `app` 을 주입하고(같은 파일을 `transpileModule` 로 CJS 화해 평가) 실제 `fetch`·실제 큐
// 파일·127.0.0.1 서버만 쓴다 — 운영 Worker 로 나가는 경로는 이 파일에도 없다.

const crashFile = resolve(__dirname, '..', 'src/main/crash/index.ts')
const crashRequire = createRequire(crashFile)
const crashFactory = new Script(`(function(require,exports){${transpileModule(readFileSync(crashFile, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: crashFile }).runInThisContext() as (require: (name: string) => unknown, module: Partial<typeof CrashModule>) => void

interface Transport {
  dir: string
  crash: typeof CrashModule
  settings: { report_consent: 'on' | 'off' | 'unset' }
  queue: () => unknown[]
  cleanup: () => void
}

/** 가짜 Electron 앱 + 실제 `sanitise` 모듈(허용 목록 상태 공유)으로 `crash/index.ts` 한 벌을 만든다.
 *  `assets` 는 `app.getAppPath()` 아래 `out/renderer/assets` 에 실제로 만들 파일 이름이다 — 설치
 *  경로가 그 목록을 읽어 허용 목록을 채우는지 시험하려면 진짜 파일이 있어야 한다. */
function transport(url: string, assets: readonly string[] | null = []): Transport {
  const dir = tempUserData()
  // `null` = `out/renderer/assets` 를 아예 만들지 않는다(읽기 실패 → 빈 목록 경로).
  if (assets) {
    const assetDir = join(dir, 'out', 'renderer', 'assets')
    // `nested` 는 평범한 하위 디렉터리, `index-ZZZZZZZZ.js` 는 **청크 이름과 똑같은 디렉터리**다 —
    // `isFile()` 필터가 없으면 이 이름이 허용 목록에 끼어 경로가 아닌 것을 파일로 인정한다.
    mkdirSync(join(assetDir, 'nested'), { recursive: true })
    mkdirSync(join(assetDir, 'index-ZZZZZZZZ.js'), { recursive: true })
    for (const name of assets) writeFileSync(join(assetDir, name), '')
  }
  const settings: { report_consent: 'on' | 'off' | 'unset' } = { report_consent: 'on' }
  const dependencies: Record<string, unknown> = {
    electron: { app: {
      isPackaged: false,
      getPath: () => dir,
      getAppPath: () => dir,
      getVersion: () => '0.6.2',
      on: () => {}
    } },
    '../settings': { loadSettings: () => settings, saveSettings: (patch: object) => Object.assign(settings, patch) },
    './sanitise': sanitiseModule
  }
  const module: Partial<typeof CrashModule> = {}
  crashFactory((name) => Object.hasOwn(dependencies, name) ? dependencies[name] : crashRequire(name), module)
  // 주소는 환경 변수로만 들어간다(`resolveReportUrl`) — 루프백이 아니면 이 시험은 성립하지 않는다.
  const before = process.env.KNUAF_CRASH_URL
  process.env.KNUAF_CRASH_URL = url
  const watched = process.listeners('uncaughtExceptionMonitor')
  try {
    module.installCrashHooks!()
  } finally {
    if (before === undefined) delete process.env.KNUAF_CRASH_URL
    else process.env.KNUAF_CRASH_URL = before
    // 설치가 건 monitor 리스너는 이 시험이 만든 것뿐이다 — 프로세스에 남기지 않는다.
    for (const listener of process.listeners('uncaughtExceptionMonitor')) {
      if (!watched.includes(listener)) process.removeListener('uncaughtExceptionMonitor', listener)
    }
  }
  return { dir, crash: module as typeof CrashModule, settings, queue: () => readQueue(dir, new Date()), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function seedOne(dir: string): void {
  const rec = buildRecord({ source: 'main', name: 'TypeError', code: null, origin: 'uncaughtException', stack: null },
    { appRoot: dir, version: '0.6.2', platform: 'darwin', release: '25.6.0', arch: 'arm64', now: new Date() })
  if (!rec) throw new Error('seed record rejected by buildRecord')
  writeQueue(dir, [{ rec, attempt: 0, first_seen: rec.at }])
}

/** 응답 코드를 정해 돌려주는 127.0.0.1 서버. 받은 POST 수를 센다. */
async function counter(status: number, location?: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0
  const server: Server = createServer((req, res) => {
    hits += 1
    req.resume()
    req.on('end', () => {
      res.writeHead(status, location ? { location } : {})
      res.end('{}')
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/report`,
    hits: () => hits,
    close: () => {
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      return closed.promise
    }
  }
}

test('I-02 — 3xx 는 따라가지 않고 폐기한다(두 번째 수신지 POST 0)', async () => {
  const second = await counter(201)
  const first = await counter(307, second.url)
  const t = transport(first.url)
  const originalError = console.error
  console.error = () => {}
  try {
    seedOne(t.dir)
    await t.crash.flush()
    expect(first.hits()).toBe(1)
    // 기본 fetch 는 307 을 따라가 본문을 다른 곳에 다시 보낸다 — manual 이면 여기가 0 이다.
    expect(second.hits()).toBe(0)
    // 3xx 는 폐기 — 큐에 남겨 재시도하지 않고, 보낸 것으로 세지도 않는다.
    expect(t.queue()).toEqual([])
    expect(readState(t.dir, new Date()).sent).toBe(0)
  } finally {
    console.error = originalError
    t.cleanup()
    await first.close()
    await second.close()
  }
})

test('R-01 — 429 를 받으면 이번 실행 동안 더 보내지 않는다(flush 2회 → POST 1회)', async () => {
  const t = transport('https://127.0.0.1:1/report')
  const originalFetch = globalThis.fetch
  const originalError = console.error
  let posts = 0
  console.error = () => {}
  // 실 서버 대신 429 만 돌려준다 — 주소는 `https` 라 `resolveReportUrl` 검증만 통과하면 된다.
  globalThis.fetch = (async () => { posts += 1; return new Response('{}', { status: 429 }) }) as typeof fetch
  try {
    seedOne(t.dir)
    await t.crash.flush()
    expect(posts).toBe(1)
    // 첫 flush 의 finally 는 `inflight` 만 비운다 — `throttled` 가 풀리면 여기서 2회가 된다.
    await t.crash.flush()
    expect(posts).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    t.cleanup()
  }
})

test('C-01 — 시작 때 실제 `out/renderer/assets` 파일만 허용 목록이 된다(디렉터리·다른 경로 제외)', () => {
  const t = transport('https://127.0.0.1:1/report', ['index-D9UkElgs.js', 'DocxHtmlView-B8MfJWQz.js'])
  try {
    // 설치 경로가 읽은 목록이 실제로 `sanitise` 모듈 상태에 들어갔는지 — 그 모듈 인스턴스를 공유한다.
    const inBundle = `at f (${t.dir}/out/renderer/assets/index-D9UkElgs.js:12:3)`
    expect(sanitiseModule.normaliseFrame(inBundle, t.dir)).toEqual({ file: 'out/renderer/assets/index-D9UkElgs.js', line: 12 })
    // 하위 디렉터리는 파일이 아니다 — 목록에 끼지 않는다. 둘째 줄은 청크 이름과 똑같은 디렉터리다.
    expect(sanitiseModule.normaliseFrame(`at f (${t.dir}/out/renderer/assets/nested/x.js:1:1)`, t.dir)).toBeNull()
    expect(sanitiseModule.normaliseFrame(`at f (${t.dir}/out/renderer/assets/index-ZZZZZZZZ.js:1:1)`, t.dir)).toBeNull()
    expect(sanitiseModule.normaliseFrame(`at f (${t.dir}/out/renderer/assets/Student20231234-AbCd1234.js:1:1)`, t.dir)).toBeNull()
  } finally {
    sanitiseModule.setBundleAssets([])
    t.cleanup()
  }
  // 산출물 디렉터리가 없는 개발/시험 실행 — 설치가 던지지 않고 빈 목록으로 접힌다.
  const bare = transport('https://127.0.0.1:1/report', null)
  try {
    expect(sanitiseModule.normaliseFrame(`at f (${bare.dir}/out/renderer/assets/index-D9UkElgs.js:12:3)`, bare.dir)).toBeNull()
    expect(sanitiseModule.normaliseFrame(`at f (${bare.dir}/out/main/index.js:1:1)`, bare.dir)).toEqual({ file: 'out/main/index.js', line: 1 })
  } finally {
    sanitiseModule.setBundleAssets([])
    bare.cleanup()
  }
})

// ── (4) 시나리오 E — 수집기 예외는 종료 코드를 바꾸지 않는다(FIX2 · I-02) ─────

test('safely — 내부 throw 와 로그 throw 둘 다 밖으로 나오지 않고 exitCode 도 그대로다', () => {
  const before = process.exitCode
  const originalError = console.error
  try {
    expect(() => safely(() => { throw new Error('수집기 폭발') })).not.toThrow()
    // catch 안의 로그가 터지는 경우가 FIX2 재지적의 직접 반례다.
    console.error = () => { throw new Error('로그도 폭발') }
    expect(() => safely(() => { throw new Error('수집기 폭발') })).not.toThrow()
    expect(() => safely(() => {})).not.toThrow()
  } finally {
    console.error = originalError
  }
  expect(process.exitCode).toBe(before)
})

test('디스크 실패 — 깨진 큐·4KB 초과·쓰기 거절 디렉터리에서도 예외가 밖으로 안 나온다', () => {
  const dir = tempUserData()
  const originalError = console.error
  const before = process.exitCode
  console.error = () => {}
  try {
    const paths = crashPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    const now = new Date('2026-11-12T09:00:00.000Z')
    // ①깨진 JSON — 읽기는 빈 큐로 접히고 쓰기는 새 파일로 복구한다.
    writeFileSync(paths.queue, '{{{', 'utf8')
    expect(() => safely(() => enqueue(dir, rec(), now))).not.toThrow()
    expect(readQueue(dir, now)).toHaveLength(1)
    // ②4KB 초과 상태 파일 — 읽지 않고 빈 상태로 시작한다.
    writeFileSync(paths.state, 'x'.repeat(4097), 'utf8')
    expect(readState(dir, now)).toEqual({ schema: 1, day: localDay(now), sent: 0, keys: [] })
    // ③쓰기 거절 디렉터리(0o500) — writeQueue 가 던지지만 safely 가 삼킨다.
    chmodSync(paths.dir, 0o500)
    expect(() => safely(() => writeQueue(dir, []))).not.toThrow()
    expect(() => safely(() => clearQueue(dir))).not.toThrow()
    chmodSync(paths.dir, 0o700)
  } finally {
    console.error = originalError
    try { chmodSync(crashPaths(dir).dir, 0o700) } catch { /* 이미 지워졌거나 권한이 없다 */ }
    rmSync(dir, { recursive: true, force: true })
  }
  expect(process.exitCode).toBe(before)
})
