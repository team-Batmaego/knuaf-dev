// kordoc 덩어리 회귀 시험 — 설계 r3 §10 표(B2a 부분).
//
// Electron 없이 도는 순수 코어(`src/main/kordocRuntimeCore.ts`)를 그대로 import 하고,
// 경로·시계·내려받기·압축 풀기·돌려 보기·여유 공간은 모두 인자로 갈아 끼운다.
// Electron 다리도 같은 VM 로더로 호출한다. 네트워크·자식은 격리하되 시작 작업과 종료 순서는 실제 코드를 쓴다.
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Script } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import {
  LOCK_BEAT_MS,
  RETIRED,
  SHIM_CONTENT,
  SHIM_NAME,
  acquireLock,
  checkArchive,
  cleanupKordocAt,
  createRetryGate,
  createVerifyLedger,
  installDirName,
  installKordoc,
  isLockStale,
  lockHeld,
  makeKordocSelector,
  mcpSibling,
  parseKordocSpec,
  readSpecState,
  readyKordocDir,
  releaseLock,
  usableDir,
  usableKordocDir,
  verifyKordocDir,
  type InstallDeps,
  type KordocSpec,
  type KordocTarget,
  type VerifyDeps,
  type VerifyLedger
} from '../src/main/kordocRuntimeCore'

const TARGET_KEY = 'aarch64-apple-darwin'
const CLI = 'node_modules/kordoc/dist/cli.js'
const MCP = 'node_modules/kordoc/dist/mcp.js'
const CLI_BODY = '// cli\n'
const MCP_BODY = '// mcp\n'
const TARGET_SHA = 'b'.repeat(64)
const NOW = 1_000_000

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 명세 JSON 초안 — 값 검사(`parseKordocSpec`)를 통과하는 모양. */
function rawSpec(over: Record<string, unknown> = {}, targetOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    release: 'kordoc-bundle-1',
    version: '4.17.1',
    cli: CLI,
    cliSha256: sha(CLI_BODY),
    mcpSha256: sha(MCP_BODY),
    targets: {
      [TARGET_KEY]: { file: 'kordoc-darwin-arm64.tgz', sha256: TARGET_SHA, size: 1000, unpackedSize: 2000, ...targetOver }
    },
    ...over
  }
}

const specOf = (over: Record<string, unknown> = {}, targetOver: Record<string, unknown> = {}): KordocSpec =>
  parseKordocSpec(rawSpec(over, targetOver))

function targetOf(spec: KordocSpec): KordocTarget {
  const target = spec.targets[TARGET_KEY]
  if (!target) throw new Error('대상이 없음')
  return target
}

function tmpRoot(prefix = 'kd-kordoc-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 도장 있는 설치 폴더 하나. `mutate` 로 파일을 일부러 망가뜨린다. */
function makeInstall(root: string, name: string, spec: KordocSpec, mutate?: (dir: string) => void): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'node_modules/kordoc/dist'), { recursive: true })
  writeFileSync(join(dir, CLI), CLI_BODY, 'utf-8')
  writeFileSync(join(dir, MCP), MCP_BODY, 'utf-8')
  writeFileSync(join(dir, SHIM_NAME), SHIM_CONTENT, 'utf-8')
  writeFileSync(
    join(dir, '.knuaf-runtime.json'),
    JSON.stringify({ version: spec.version, release: spec.release, target: TARGET_KEY, sha256: targetOf(spec).sha256 }),
    'utf-8'
  )
  mutate?.(dir)
  return dir
}

/** 꼼꼼한 확인 다리 — `smoke` 호출을 세고, 원하면 늦게 끝나거나 실패한다. */
function verifyDeps(
  root: string,
  spec: KordocSpec,
  ledger: VerifyLedger,
  over: { smokeDelayMs?: number; smokeFails?: boolean } = {}
): VerifyDeps & { root: string; smokeCalls: Array<[string, string, string]> } {
  const smokeCalls: Array<[string, string, string]> = []
  return {
    dir: root,
    root,
    spec,
    targetKey: TARGET_KEY,
    target: targetOf(spec),
    execPath: '/fake/electron',
    ledger,
    now: () => NOW,
    smokeCalls,
    smoke: async (execPath: string, dir: string, cli: string) => {
      smokeCalls.push([execPath, dir, cli])
      if (over.smokeDelayMs) {
        const delay = Promise.withResolvers<void>()
        setTimeout(delay.resolve, over.smokeDelayMs)
        await delay.promise
      }
      if (over.smokeFails) throw new Error('generate 실패')
    }
  }
}

interface InstallHarness {
  deps: InstallDeps
  calls: { download: number; extract: number; strip: number[]; smoke: number; list: number }
}

/** 설치 다리 — 가짜 받기·가짜 풀기. 풀기는 cli.js·mcp.js 를 만든다(내용은 명세 해시와 짝). */
function installDeps(
  root: string,
  spec: KordocSpec,
  ledger: VerifyLedger,
  over: {
    archiveNames?: string[]
    archiveVerbose?: string[]
    free?: number
    cliBody?: string
    mcpBody?: string
    smokeFails?: boolean
    onSmoke?: (dir: string) => void
    now?: number
    pidAlive?: (pid: number) => boolean
  } = {}
): InstallHarness {
  const calls = { download: 0, extract: 0, strip: [] as number[], smoke: 0, list: 0 }
  const names = over.archiveNames ?? [CLI, MCP]
  const verbose = over.archiveVerbose ?? names.map(() => '-rw-r--r--  0 0 0 12 Jan  1 00:00')
  const deps: InstallDeps = {
    root,
    spec,
    targetKey: TARGET_KEY,
    target: targetOf(spec),
    execPath: '/fake/electron',
    ledger,
    url: 'https://example.invalid/kordoc-bundle-1/kordoc-darwin-arm64.tgz',
    now: () => over.now ?? NOW,
    platform: process.platform,
    pidAlive: over.pidAlive ?? (() => false),
    freeBytes: () => over.free ?? 10_000_000_000,
    download: async (_url, dest) => {
      calls.download += 1
      writeFileSync(dest, 'fake tgz')
    },
    listEntries: async () => {
      calls.list += 1
      return { names, verbose }
    },
    extract: async (_archive, dest, strip) => {
      calls.extract += 1
      calls.strip.push(strip)
      mkdirSync(join(dest, 'node_modules/kordoc/dist'), { recursive: true })
      writeFileSync(join(dest, CLI), over.cliBody ?? CLI_BODY, 'utf-8')
      writeFileSync(join(dest, MCP), over.mcpBody ?? MCP_BODY, 'utf-8')
    },
    smoke: async (_execPath, dir) => {
      calls.smoke += 1
      over.onSmoke?.(dir)
      if (over.smokeFails) throw new Error('generate 실패')
    },
    signal: new AbortController().signal
  }
  return { deps, calls }
}

// ───────────────────────────── 명세 읽기(§3.2 · §5.2) ─────────────────────────────

test('명세: 정상·대상 없음·오류를 서로 다른 갈래로 가른다', () => {
  const root = tmpRoot()
  const okPath = join(root, 'ok.json')
  writeFileSync(okPath, JSON.stringify(rawSpec()), 'utf-8')
  const ok = readSpecState(okPath, TARGET_KEY)
  expect(ok.kind).toBe('ok')
  if (ok.kind === 'ok') {
    expect(ok.targetKey).toBe(TARGET_KEY)
    expect(ok.target.file).toBe('kordoc-darwin-arm64.tgz')
  }

  // 이 PC 의 대상이 없는 것·대상 키가 없는 것은 오류가 아니라 "대상 없음" — 옛 길로 떨어지는 갈래다.
  const emptyPath = join(root, 'empty.json')
  writeFileSync(emptyPath, JSON.stringify({ ...rawSpec(), targets: {} }), 'utf-8')
  expect(readSpecState(emptyPath, TARGET_KEY).kind).toBe('unsupported')
  expect(readSpecState(okPath, 'x86_64-pc-windows-msvc').kind).toBe('unsupported')
  expect(readSpecState(okPath, null).kind).toBe('unsupported')

  expect(readSpecState(join(root, 'missing.json'), TARGET_KEY).kind).toBe('invalid')
  const brokenPath = join(root, 'broken.json')
  writeFileSync(brokenPath, '{ not json', 'utf-8')
  expect(readSpecState(brokenPath, TARGET_KEY).kind).toBe('invalid')
})

test('명세 값 꼴: 경로·해시·크기가 어긋나면 오류다', () => {
  const bad: Array<Record<string, unknown>> = [
    { release: '../kordoc-bundle-1' },
    { release: 'kordoc/bundle' },
    { version: '4.17' },
    { cli: '/node_modules/kordoc/dist/cli.js' },
    { cli: 'node_modules/../../kordoc/dist/cli.js' },
    { cli: 'node_modules/kordoc/dist/cli.mjs' },
    { cliSha256: 'A'.repeat(64) },
    { mcpSha256: 'b'.repeat(63) }
  ]
  for (const over of bad) expect(() => specOf(over), JSON.stringify(over)).toThrow()
  for (const targetOver of [{ file: '../kordoc-darwin-arm64.tgz' }, { file: 'kordoc-darwin-arm64.zip' }, { size: 0 }, { unpackedSize: 0 }, { sha256: 'C'.repeat(64) }]) {
    expect(() => specOf({}, targetOver), JSON.stringify(targetOver)).toThrow()
  }
  expect(() => specOf({ targets: [] })).toThrow()
  expect(() => specOf({ targets: { unknown: rawSpec().targets } })).toThrow()
  expect(() => specOf()).not.toThrow()
})

// ───────────────────────────── 고르기(§5.2) ─────────────────────────────

test('withManagedKordoc: 쓸 수 있으면 값 / 아직 없으면 legacy 안 부름 / 대상 없음만 legacy / 명세 오류는 null', async () => {
  const spec = specOf()
  let legacyCalls = 0
  let installs = 0
  const invalidReasons: string[] = []
  const managed = { node: '/app', nodeArgs: ['-r', 'shim'], cliJs: '/app/cli.js', version: '4.17.1' }

  const build = (state: ReturnType<typeof readSpecState>, resolved: typeof managed | null) =>
    makeKordocSelector(
      {
        specState: () => state,
        resolveManaged: async () => resolved,
        startInstall: () => { installs += 1 },
        reportInvalid: (reason) => invalidReasons.push(reason)
      },
      async () => {
        legacyCalls += 1
        return { node: 'node', cliJs: 'cli.js', version: '0' }
      }
    )

  const okState = { kind: 'ok' as const, spec, targetKey: TARGET_KEY, target: targetOf(spec) }
  expect(await build(okState, managed)('/root')).toEqual(managed)
  expect(legacyCalls).toBe(0)
  expect(installs).toBe(0)

  // 대상이 있는데 아직 설치가 없으면 legacy 를 부르지 않고 설치만 띄운다 —
  // Node+pnpm 으로 수백 MB 를 따로 받는 옛 길을 조용히 열지 않는다(§5.2 갈래 2).
  expect(await build(okState, null)('/root')).toBeNull()
  expect(legacyCalls).toBe(0)
  expect(installs).toBe(1)

  // 대상 없음 — 옛 길 그대로.
  const unsupported = { kind: 'unsupported' as const, spec, targetKey: null }
  expect(await build(unsupported, managed)('/root')).not.toBeNull()
  expect(legacyCalls).toBe(1)

  // 명세 오류 — 옛 길을 열지 않고 null. 로그는 실행당 1회(KC-06).
  const invalid = { kind: 'invalid' as const, reason: 'release 꼴이 틀림' }
  const selectInvalid = build(invalid, managed)
  expect(await selectInvalid('/root')).toBeNull()
  expect(await selectInvalid('/root')).toBeNull()
  expect(legacyCalls).toBe(1)
  expect(installs).toBe(1)
  expect(invalidReasons).toEqual(['release 꼴이 틀림'])
})

test('쓸 수 있는 설치 판정: 이번 실행의 꼼꼼한 확인을 통과해야만 값을 낸다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec)
  const ledger = createVerifyLedger()
  expect(usableDir(dir, spec, TARGET_KEY, targetOf(spec), ledger)).toBeNull()
  expect(usableKordocDir(root, spec, TARGET_KEY, targetOf(spec), ledger)).toBeNull()

  const deps = verifyDeps(root, spec, ledger)
  expect(await verifyKordocDir({ ...deps, dir })).toBe(true)
  expect(usableDir(dir, spec, TARGET_KEY, targetOf(spec), ledger)).toBe(dir)
  expect(usableKordocDir(root, spec, TARGET_KEY, targetOf(spec), ledger)).toBe(dir)
  expect(deps.smokeCalls).toEqual([['/fake/electron', dir, join(dir, CLI)]])

  // `.retired` 가 찍힌 폴더는 도장이 맞아도 안 쓴다.
  writeFileSync(join(dir, RETIRED), JSON.stringify({ at: NOW, reason: '시험' }), 'utf-8')
  expect(usableDir(dir, spec, TARGET_KEY, targetOf(spec), ledger)).toBeNull()
})

test('도장은 있으나 shim 이 없으면 고르기는 null이고 그 자리에서 .retired 가 찍힌다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec, (d) => rmSync(join(d, SHIM_NAME)))
  expect(await readyKordocDir(verifyDeps(root, spec, createVerifyLedger()))).toBeNull()
  expect(existsSync(join(dir, RETIRED))).toBe(true)
  // 앱을 새로 켠 것과 같다(메모리 비움) — 디스크의 `.retired` 로 다시는 안 고른다.
  expect(await readyKordocDir(verifyDeps(root, spec, createVerifyLedger()))).toBeNull()
})

test('설치: 도장만 남은 폴더를 건너뛰지 않고 새 폴더에 다시 받는다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  // cli.js 가 없으면 findInstallIn 이 그 폴더를 아예 못 찾는다 — 설치가 조기 반환하면 안 된다(§4.2-2).
  const stale = makeInstall(root, installDirName(TARGET_SHA, 1000), spec, (d) => rmSync(join(d, CLI)))
  const ledger = createVerifyLedger()
  const { deps, calls } = installDeps(root, spec, ledger)
  const dir = await installKordoc(deps)

  expect(calls.download).toBe(1)
  expect(dir).not.toBe(stale)
  expect(existsSync(join(dir, '.knuaf-runtime.json'))).toBe(true)
  expect(usableKordocDir(root, spec, TARGET_KEY, targetOf(spec), ledger)).toBe(dir)
})

test('꼼꼼한 확인 실패는 .retired 로 남아 다음 실행·설치 조기 반환도 그 폴더를 안 쓴다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec, (d) => writeFileSync(join(d, CLI), '// 손상\n', 'utf-8'))
  expect(await verifyKordocDir({ ...verifyDeps(root, spec, createVerifyLedger()), dir })).toBe(false)
  expect(existsSync(join(dir, RETIRED))).toBe(true)

  const fresh = createVerifyLedger()
  expect(await readyKordocDir(verifyDeps(root, spec, fresh))).toBeNull()
  expect(usableKordocDir(root, spec, TARGET_KEY, targetOf(spec), fresh)).toBeNull()

  const { deps, calls } = installDeps(root, spec, fresh)
  const installed = await installKordoc(deps)
  expect(calls.download).toBe(1)
  expect(installed).not.toBe(dir)
})

test('꼼꼼한 확인은 실행당·폴더당 한 번, 다음 실행에서는 다시 돈다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec)
  const ledger = createVerifyLedger()
  const deps = verifyDeps(root, spec, ledger)
  expect(await verifyKordocDir({ ...deps, dir })).toBe(true)
  expect(await verifyKordocDir({ ...deps, dir })).toBe(true)
  expect(deps.smokeCalls.length).toBe(1)

  const next = verifyDeps(root, spec, createVerifyLedger())
  expect(await verifyKordocDir({ ...next, dir })).toBe(true)
  expect(next.smokeCalls.length).toBe(1)
})

test('꼼꼼한 확인이 안 돈 상태의 ensureKordoc 은 확인을 기다린 뒤 고른다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec)
  const ledger = createVerifyLedger()
  const deps = verifyDeps(root, spec, ledger, { smokeDelayMs: 30 })

  const first = readyKordocDir(deps)
  const second = readyKordocDir(deps) // 도는 중이면 합류한다(두 번 돌리지 않는다).
  expect(ledger.passed.size).toBe(0) // 확인 전에는 값을 내지 않는다(§5.2 · KC-03).
  expect(await first).toBe(dir)
  expect(await second).toBe(dir)
  expect(deps.smokeCalls.length).toBe(1)
})

// ───────────────────────────── 설치·게시(§4.2) ─────────────────────────────

test('설치: mcp.js 해시가 다르면 게시 전에 거절하고 새 폴더를 지운다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const { deps } = installDeps(root, spec, createVerifyLedger(), { mcpBody: '// 다른 mcp\n' })
  await expect(installKordoc(deps)).rejects.toMatchObject({ code: 'runtime_archive_rejected' })
  expect(existsSync(join(root, installDirName(TARGET_SHA, NOW)))).toBe(false)
})

test('설치: 돌려 보기가 실패하면 새 폴더를 지우고 잠금을 놓는다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const { deps } = installDeps(root, spec, createVerifyLedger(), { smokeFails: true })
  await expect(installKordoc(deps)).rejects.toThrow('generate 실패')
  expect(existsSync(join(root, installDirName(TARGET_SHA, NOW)))).toBe(false)
  expect(existsSync(join(root, '.lock'))).toBe(false)
})

test('설치: 목록에 심볼릭 링크·절대 경로·상위 경로가 있으면 풀기 전에 거절한다', async () => {
  const spec = specOf()
  for (const bad of [
    { archiveNames: [CLI, 'link'], archiveVerbose: ['-rw-r--r-- 0', 'lrwxrwxrwx 0'] },
    { archiveNames: [CLI, '/etc/passwd'], archiveVerbose: ['-rw-r--r-- 0', '-rw-r--r-- 0'] },
    { archiveNames: [CLI, 'node_modules/../../x'], archiveVerbose: ['-rw-r--r-- 0', '-rw-r--r-- 0'] }
  ]) {
    const root = tmpRoot()
    const { deps, calls } = installDeps(root, spec, createVerifyLedger(), bad)
    await expect(installKordoc(deps), JSON.stringify(bad)).rejects.toMatchObject({ code: 'runtime_archive_rejected' })
    expect(calls.extract, JSON.stringify(bad)).toBe(0)
  }
})

test('설치: 여유 공간이 모자라면 받기 전에 거절한다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const { deps, calls } = installDeps(root, spec, createVerifyLedger(), { free: 1 })
  await expect(installKordoc(deps)).rejects.toMatchObject({ code: 'runtime_no_space' })
  expect(calls.download).toBe(0)
})

test('설치: 덩어리는 최상위 폴더를 벗기지 않고 푼다(strip 0)', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const { deps, calls } = installDeps(root, spec, createVerifyLedger())
  await installKordoc(deps)
  expect(calls.strip).toEqual([0])
})

test('설치: 잠금을 남이 넘겨받았으면 게시하지 않는다', async () => {
  const spec = specOf()
  const root = tmpRoot()
  const { deps } = installDeps(root, spec, createVerifyLedger(), {
    onSmoke: () => {
      // 도는 중에 다른 쪽이 낡은 잠금으로 넘겨받은 상황을 흉내 낸다.
      writeFileSync(join(root, '.lock'), JSON.stringify({ token: 'other', pid: 1, startedAt: 0 }), 'utf-8')
    }
  })
  await expect(installKordoc(deps)).rejects.toMatchObject({ code: 'runtime_locked' })
  expect(existsSync(join(root, installDirName(TARGET_SHA, NOW)))).toBe(false)
  // 남의 잠금은 지우지 않는다.
  expect(existsSync(join(root, '.lock'))).toBe(true)
})

test('목록 검사: 윈도 전체 경로가 259자를 넘으면 풀기 전에 거절한다', () => {
  const longName = `node_modules/${'a'.repeat(200)}/x.js`
  const winDir = 'C:\\Users\\student\\AppData\\Local\\knuaf\\kordoc\\k-abc-1'
  expect(() => checkArchive([longName], ['-rw-r--r-- 0'], 'win32', winDir)).toThrow()
  expect(() => checkArchive([longName], ['-rw-r--r-- 0'], 'darwin', '/tmp/kordoc/k-abc-1')).not.toThrow()
  // 빈 덩어리·종류 줄 수 불일치도 같은 갈래다.
  expect(() => checkArchive([], [], 'darwin', '/tmp/k')).toThrow()
  expect(() => checkArchive([CLI], [], 'darwin', '/tmp/k')).toThrow()
})

/**
 * `runtime.ts` 는 `electron` 을 import 하므로 Node 에서 그대로 못 부른다(설치된 electron 패키지가
 * 실행 파일 경로 문자열을 내주거나 던진다). 저장소의 다른 스펙(preparation-main)과 같은 방식으로
 * 트랜스파일해 `electron` 만 갈아 끼우고 `extract` 하나만 꺼낸다.
 */
function loadExtract(): (archive: string, dest: string, strip?: number) => Promise<void> {
  const file = join(__dirname, '../src/main/runtime.ts')
  const js = transpileModule(readFileSync(file, 'utf-8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
  const factory = new Script(`(function(require,module,exports,__filename,__dirname){${js}\n})`, { filename: file })
    .runInThisContext() as (require: (name: string) => unknown, module: Record<string, unknown>, exports: Record<string, unknown>, filename: string, dirname: string) => void
  const realRequire = createRequire(file)
  const stubs: Record<string, unknown> = { electron: { app: { isPackaged: false, getAppPath: () => dirname(file) }, net: {} } }
  const exports: Record<string, unknown> = {}
  factory((name: string) => (Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name)), { exports }, exports, file, dirname(file))
  return exports.extract as (archive: string, dest: string, strip?: number) => Promise<void>
}

test('extract: 기본은 최상위 폴더를 벗기고, strip 0 은 살린다', async () => {
  if (!existsSync('/usr/bin/tar')) test.skip()
  const root = tmpRoot()
  const src = join(root, 'src')
  mkdirSync(join(src, 'kordoc-bundle/node_modules/kordoc/dist'), { recursive: true })
  writeFileSync(join(src, 'kordoc-bundle/node_modules/kordoc/dist/cli.js'), CLI_BODY, 'utf-8')
  const archive = join(root, 'bundle.tgz')
  const made = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', src, 'kordoc-bundle'], { encoding: 'utf-8' })
  expect(made.status, String(made.stderr)).toBe(0)

  const keep = join(root, 'keep')
  const strip = join(root, 'strip')
  mkdirSync(keep)
  mkdirSync(strip)
  const extract = loadExtract()
  await extract(archive, keep, 0)
  // kordoc 덩어리는 이렇게 맨 위에 `node_modules/` 가 온다 — 1 을 벗기면 파일이 사라진다(실측 §3).
  expect(existsSync(join(keep, 'kordoc-bundle/node_modules/kordoc/dist/cli.js'))).toBe(true)
  await extract(archive, strip)
  expect(existsSync(join(strip, 'node_modules/kordoc/dist/cli.js'))).toBe(true)
})

test('shim 은 정확히 한 줄이고, 내용이 다르면 확인이 실패한다', async () => {
  expect(SHIM_CONTENT).toBe('process.defaultApp = true;\n')
  const spec = specOf()
  const root = tmpRoot()
  const dir = makeInstall(root, installDirName(TARGET_SHA, 1000), spec, (d) =>
    writeFileSync(join(d, SHIM_NAME), 'process.defaultApp = true;\nconsole.log(1)\n', 'utf-8')
  )
  expect(await verifyKordocDir({ ...verifyDeps(root, spec, createVerifyLedger()), dir })).toBe(false)
  expect(existsSync(join(dir, RETIRED))).toBe(true)
})

test('mcp.js 자리는 cli.js 옆이다', () => {
  expect(mcpSibling(CLI)).toBe(MCP)
})

// ───────────────────────────── 정리(§4.4) ─────────────────────────────

function cleanupDeps(root: string, spec: KordocSpec, ledger: VerifyLedger, over: Record<string, unknown> = {}) {
  return {
    root,
    spec,
    targetKey: TARGET_KEY,
    target: targetOf(spec),
    isDev: false,
    ledger,
    now: () => 10 * 24 * 60 * 60 * 1000,
    pidAlive: () => false,
    ...over
  }
}

test('정리: 도장 없는 폴더·임시 파일만 바로 지우고, 도장 있는 폴더는 안 지운다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const incomplete = join(root, installDirName(TARGET_SHA, 2000))
  mkdirSync(join(incomplete, 'node_modules'), { recursive: true })
  const published = makeInstall(root, installDirName(TARGET_SHA, 3000), spec)
  const temp = join(root, '.download-4000.tar.gz')
  writeFileSync(temp, 'partial')

  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger()))

  expect(existsSync(incomplete)).toBe(false)
  expect(existsSync(temp)).toBe(false)
  expect(existsSync(published)).toBe(true)
  expect(existsSync(join(published, RETIRED))).toBe(false)
})

test('정리: 남이 쥔 잠금이 있으면 아무것도 안 지운다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const lock = acquireLock(root, 1000, () => true)
  expect(lock).not.toBeNull()
  const incomplete = join(root, installDirName(TARGET_SHA, 2000))
  mkdirSync(incomplete, { recursive: true })

  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger(), { now: () => Date.now(), pidAlive: () => true }))

  expect(existsSync(incomplete)).toBe(true)
  expect(existsSync(join(root, '.lock'))).toBe(true)
  if (lock) releaseLock(lock)
})

test('정리: 명세와 안 맞는 도장 폴더는 .retired 만 찍고 24시간 전엔 안 지운다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const stale = makeInstall(root, installDirName(TARGET_SHA, 2000), specOf({ release: 'kordoc-bundle-0' }))
  const day = 24 * 60 * 60 * 1000

  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger(), { now: () => day }))
  expect(existsSync(stale)).toBe(true)
  expect(existsSync(join(stale, RETIRED))).toBe(true)

  // 아직 24시간이 안 지났다 — 그대로 둔다.
  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger(), { now: () => day + 1000 }))
  expect(existsSync(stale)).toBe(true)

  // 24시간이 지났어도 쓸 수 있는 설치가 없으면 안 지운다(유일한 설치일 수 있다).
  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger(), { now: () => day * 2 }))
  expect(existsSync(stale)).toBe(true)
})

test('정리: 24시간이 지나고 쓸 수 있는 설치가 따로 있으면 옛 폴더를 지운다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const stale = makeInstall(root, installDirName(TARGET_SHA, 2000), specOf({ release: 'kordoc-bundle-0' }))
  const usable = makeInstall(root, installDirName(TARGET_SHA, 3000), spec)
  const ledger = createVerifyLedger()
  const day = 24 * 60 * 60 * 1000
  ledger.passed.add(usable) // 이번 실행 확인을 통과한 것으로 둔다.

  cleanupKordocAt(cleanupDeps(root, spec, ledger, { now: () => day }))
  expect(existsSync(stale)).toBe(true)
  cleanupKordocAt(cleanupDeps(root, spec, ledger, { now: () => day * 2 }))
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(usable)).toBe(true)
})

test('정리: 도장을 읽지 못한 폴더는 보존한다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const broken = join(root, installDirName(TARGET_SHA, 2000))
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, '.knuaf-runtime.json'), '{ not json', 'utf-8')

  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger()))

  expect(existsSync(broken)).toBe(true)
})

test('정리: 개발 빌드는 도장 있는 폴더를 지우지도 .retired 를 찍지도 않는다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const stale = makeInstall(root, installDirName(TARGET_SHA, 2000), specOf({ release: 'kordoc-bundle-0' }))

  cleanupKordocAt(cleanupDeps(root, spec, createVerifyLedger(), { isDev: true, now: () => 10 * 24 * 60 * 60 * 1000 }))

  expect(existsSync(stale)).toBe(true)
  expect(existsSync(join(stale, RETIRED))).toBe(false)
})

test('정리: 이미 설치돼 있어도 시작 때 임시 파일 정리를 다시 한다', () => {
  const spec = specOf()
  const root = tmpRoot()
  const installed = makeInstall(root, installDirName(TARGET_SHA, 3000), spec)
  const ledger = createVerifyLedger()
  ledger.passed.add(installed)
  const temp = join(root, '.download-5000.tar.gz')
  writeFileSync(temp, 'partial')

  cleanupKordocAt(cleanupDeps(root, spec, ledger))

  expect(existsSync(temp)).toBe(false)
  expect(existsSync(installed)).toBe(true)
})

// ───────────────────────────── 잠금(§4.6) ─────────────────────────────

test('잠금: 살아서 맥박이 뛰는 주인의 잠금은 시간이 아무리 지나도 안 뺏는다', () => {
  const root = tmpRoot()
  const lock = acquireLock(root, 1000, () => true)
  expect(lock).not.toBeNull()
  const text = readFileSync(join(root, '.lock'), 'utf-8')
  const tenHours = 10 * 60 * 60 * 1000
  expect(isLockStale(text, tenHours, () => true, tenHours)).toBe(false)
  // 같은 시각으로 다시 쥐려 해도 못 쥔다.
  expect(acquireLock(root, tenHours, () => true)).toBeNull()
  if (lock) releaseLock(lock)
})

test('잠금: 맥박이 5분 넘게 멎거나 pid 가 죽었으면 넘겨받는다', () => {
  const text = JSON.stringify({ token: 'x', pid: 4242, startedAt: 0 })
  expect(isLockStale(text, NOW, () => true, NOW)).toBe(false)
  expect(isLockStale(text, NOW, () => true, NOW - 6 * 60 * 1000)).toBe(true)
  expect(isLockStale(text, NOW, () => false, NOW)).toBe(true)
  expect(isLockStale('{ not json', NOW, () => true, NOW)).toBe(true)

  const root = tmpRoot()
  writeFileSync(join(root, '.lock'), JSON.stringify({ token: 'x', pid: 4242, startedAt: 0 }), 'utf-8')
  const old = (Date.now() - 10 * 60 * 1000) / 1000
  utimesSync(join(root, '.lock'), old, old)
  expect(acquireLock(root, Date.now(), () => true)).not.toBeNull()
})

test('잠금: 내 것이 아니면 놓을 때 파일을 안 지운다', () => {
  const root = tmpRoot()
  const lock = acquireLock(root, 1000, () => true)
  expect(lock).not.toBeNull()
  writeFileSync(join(root, '.lock'), JSON.stringify({ token: 'other', pid: 1, startedAt: 0 }), 'utf-8')
  if (lock) {
    expect(lockHeld(lock)).toBe(false)
    releaseLock(lock)
  }
  expect(existsSync(join(root, '.lock'))).toBe(true)
  expect(LOCK_BEAT_MS).toBe(30_000)
})

// ───────────────────────────── 다시 시도(§4.7) ─────────────────────────────

test('실패 뒤 10분 안에는 다시 안 받고, 성공하면 곧바로 다시 열린다', () => {
  const gate = createRetryGate(10 * 60 * 1000)
  expect(gate.mayStart(1000)).toBe(true)
  gate.failed(1000)
  expect(gate.mayStart(1000 + 9 * 60 * 1000)).toBe(false)
  expect(gate.mayStart(1000 + 10 * 60 * 1000)).toBe(true)
  gate.succeeded()
  expect(gate.mayStart(1000 + 10 * 60 * 1000 + 1)).toBe(true)
})

/** Electron 다리의 비공개 smoke 는 시험용 VM 안에서만 노출한다. */
function loadAdapter(stubs: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const file = join(__dirname, '../src/main/kordocRuntime.ts')
  const js = transpileModule(readFileSync(file, 'utf-8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
  const factory = new Script(`(function(require,exports,__dirname){${js}\nexports.testSmoke = smoke;\n})`, { filename: file })
    .runInNewContext({ process, console, setTimeout, clearTimeout, AbortController, ...globals })
  const realRequire = createRequire(file)
  const exports: Record<string, unknown> = {}
  factory((name: string) => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name), exports, dirname(file))
  return exports as {
    startKordocWork: (delay?: number) => void
    testSmoke: (exe: string, dir: string, cli: string, signal?: AbortSignal) => Promise<void>
  }
}

test('시작 작업: isOnline 없는 호스트는 받지 않고, 배경 실패는 처리한다', async () => {
  for (const failReady of [false, true]) {
    const root = tmpRoot()
    let work: (() => void) | undefined
    let downloads = 0
    const logs: string[] = []
    const adapter = loadAdapter({
      electron: { app: { isPackaged: false }, net: { fetch: () => { downloads++; throw new Error('network forbidden') } } },
      './runtime': { runtimeRoot: () => join(root, 'python'), targetTriple: () => TARGET_KEY },
      './diagLog': { diag: (text: string) => logs.push(text) },
      './kordocRuntimeCore': {
        ...require('../src/main/kordocRuntimeCore'),
        readSpecState: () => ({ kind: 'ok', spec: specOf(), targetKey: TARGET_KEY, target: targetOf(specOf()) }),
        readyKordocDir: async () => { if (failReady) throw new Error('verification unavailable'); return null }
      }
    }, { setTimeout: (fn: () => void) => { work = fn; return { unref() {} } } })
    adapter.startKordocWork(0)
    work!()
    const tick = Promise.withResolvers<void>()
    setImmediate(tick.resolve)
    await tick.promise
    expect(downloads).toBe(0)
    expect(logs.some((text) => text.includes('verification unavailable'))).toBe(failReady)
  }
})

test('smoke: 시간 초과·취소는 자식 close 뒤 정리하고, 빈 산출물은 거절한다', async () => {
  for (const mode of ['timeout', 'cancel', 'empty', 'success'] as const) {
    const root = tmpRoot()
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kills: 0, kill() { this.kills++; return true } })
    let timeout: (() => void) | undefined
    let args: string[] = []
    const adapter = loadAdapter({
      electron: { app: { isPackaged: false }, net: {} },
      './runtime': {},
      './diagLog': { diag() {} },
      'node:child_process': { spawn: (_exe: string, argv: string[]) => { args = argv; return child } }
    }, { setTimeout: (fn: () => void) => { timeout = fn; return 1 }, clearTimeout() {} })
    const abort = new AbortController()
    let settled = false
    const result = adapter.testSmoke('/fake/electron', root, join(root, CLI), abort.signal)
      .then(() => { settled = true; return 'ok' }, (error: Error) => { settled = true; return error.message })
    const box = join(root, '.smoke')
    expect(args).toEqual(['-r', join(root, SHIM_NAME), join(root, CLI), 'generate', join(box, 'in.md'), '-o', join(box, 'out.hwpx')])
    if (mode === 'timeout') timeout!()
    if (mode === 'cancel') abort.abort()
    if (mode === 'empty' || mode === 'success') writeFileSync(join(box, 'out.hwpx'), mode === 'empty' ? '' : 'hwpx')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(existsSync(box)).toBe(true)
    expect(child.kills).toBe(mode === 'timeout' || mode === 'cancel' ? 1 : 0)
    child.emit('close', mode === 'timeout' || mode === 'cancel' ? null : 0)
    expect(await result).toBe(mode === 'success' ? 'ok' : mode === 'empty' ? 'kordoc 확인 실행이 빈 파일이거나 파일을 만들지 않음' : mode === 'timeout' ? 'kordoc 확인 실행 시간 초과' : 'kordoc 확인 실행 취소')
    expect(existsSync(box)).toBe(false)
  }
})

test('선택: retired 최신 설치를 건너뛰고 온전한 설치를 쓰며, 은퇴 시각을 보존한다', async () => {
  const root = tmpRoot(), spec = specOf(), ledger = createVerifyLedger()
  const good = makeInstall(root, installDirName(TARGET_SHA, 1000), spec)
  const retired = makeInstall(root, installDirName(TARGET_SHA, 2000), spec)
  const mark = JSON.stringify({ at: 1, reason: 'bad smoke' })
  writeFileSync(join(retired, RETIRED), mark)
  expect(await readyKordocDir(verifyDeps(root, spec, ledger))).toBe(good)
  expect(usableKordocDir(root, spec, TARGET_KEY, targetOf(spec), ledger)).toBe(good)
  expect(readFileSync(join(retired, RETIRED), 'utf8')).toBe(mark)
})

test('설치: 취소는 진행 중인 자식이 끝날 때까지 폴더를 지우지 않는다', async () => {
  const root = tmpRoot(), spec = specOf(), abort = new AbortController()
  const { deps } = installDeps(root, spec, createVerifyLedger())
  const started = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  deps.signal = abort.signal
  deps.smoke = async (_exe, _dir, _cli, signal) => {
    expect(signal).toBe(abort.signal)
    started.resolve()
    await closed.promise
  }
  const result = installKordoc(deps)
  await started.promise
  abort.abort()
  expect(existsSync(join(root, installDirName(TARGET_SHA, NOW)))).toBe(true)
  closed.resolve()
  await expect(result).rejects.toMatchObject({ code: 'runtime_cancelled' })
  expect(existsSync(join(root, installDirName(TARGET_SHA, NOW)))).toBe(false)
})
