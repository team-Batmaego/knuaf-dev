// Node-only: 오류 보고 수집기(sanitise.ts)의 허용 목록·큐 I/O·예외 경계. Electron 을 띄우지 않는다.
// 정본은 DESIGN §2-3(표·반례 6종·정규화 예 7행)·§2-4(큐·상한)·§2-6(중복)·§4 시험 (1)(2)(3)·시나리오 E.
import { expect, test } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLE_FILES,
  CRASH_REASONS,
  DAILY_MAX,
  ERROR_CODES,
  ERROR_ERR,
  ERROR_ERRNO,
  ERROR_NAMES,
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

test('where.file 정규화 — §2-3 의 7행 그대로', () => {
  const rows: [string, { file: string; line: number } | null, string][] = [
    ['at f (/Applications/창업논문 도우미.app/Contents/Resources/app.asar/out/main/index.js:21741:19)', { file: 'out/main/index.js', line: 21741 }, appRoot],
    ['at g (C:\\Users\\김대욱\\AppData\\Local\\Programs\\knuaf-dev\\resources\\app.asar\\out\\main\\index.js:9021:7)', { file: 'out/main/index.js', line: 9021 }, appRoot],
    // ESM 스택의 `file://` 형태 — 개발 실행이라 앱 루트가 asar 밖이다.
    ['at h (file:///Users/nara/dev/app/out/main/index.js:431:9)', { file: 'out/main/index.js', line: 431 }, '/Users/nara/dev/app'],
    ['at i (/Users/nara/Library/pnpm/…/node-pty/lib/index.js:88:11)', null, appRoot],
    ['at j (/Users/김대욱/논문/내자료.js:1:1)', null, appRoot],
    ['at k (…/app.asar/out/main/MyThesisDraft.docx:12:3)', null, appRoot],
    ['at l (/Users/김대욱/out/main/index.js:5:1)', null, appRoot]
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

test('렌더러 해시 청크 — 실측 산출물 이름은 통과, 한 글자·길이가 다르면 null', () => {
  const pass = ['out/renderer/assets/index-D9UkElgs.js', 'out/renderer/assets/DocxHtmlView-B8MfJWQz.js']
  for (const file of pass) expect(normaliseFrame(`at f (${appRoot}/${file}:12:3)`, appRoot)).toEqual({ file, line: 12 })
  const reject = [
    'out/renderer/assets/index-D9UkElg.js', // 해시 7자
    'out/renderer/assets/index-D9UkElgsZ.js', // 해시 9자
    'out/renderer/assets/index D9UkElgs.js', // 공백 — 문자 집합 밖
    'out/renderer/assets/index-D9UkElgs.jsx',
    'out/renderer/assets/index-D9UkElgs.css',
    'out/main/MyThesisDraft.docx'
  ]
  for (const file of reject) expect(normaliseFrame(`at f (${appRoot}/${file}:12:3)`, appRoot)).toBeNull()
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

// ── (3) 시나리오 E — 수집기 예외는 종료 코드를 바꾸지 않는다(FIX2 · I-02) ─────

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
