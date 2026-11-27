// S-01 재현 시험(v0.7.5): 남이 넣어 둔 논문 폴더의 `.venv` 파이썬을 앱이 자기 권한으로 실행하면 안 된다.
// Node VM 더블 — Electron·사이드카·계정 프로세스를 띄우지 않는다. `python.ts`만 실제 소스로 읽고
// electron·관리 런타임·스킬 경로는 가짜로 둔다.
//
// 공격 모형(시나리오 S1): 폴더만 바꿀 수 있는 사람이 `.venv/bin/python3`(윈도는 `.venv/Scripts/python.exe`)에
// 실행되면 표시 파일을 남기는 가짜 실행기를 넣는다. 앱 데이터 폴더에는 이 venv 를 만든 기록이 없다.
// 기대: `venvPython`이 null(→ 사이드카·에이전트 PATH·담당 PATH 다섯 갈래가 함께 닫힘),
// `choosePython`은 venv 가 아닌 관리/번들 실행기를 고르고, 고른 실행기를 사이드카처럼 띄워도 표시 파일이 없다.
//
// 이 시험은 고치기 전 빨강이 정상이다(설계 `DESIGN-venv-guard.md` 검토 판정 뒤 구현이 초록으로 만든다).
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type * as PythonModule from '../src/main/python'

const appRoot = resolve(__dirname, '..')
const file = join(appRoot, 'src/main/python.ts'), realRequire = createRequire(file)
type Factory = (require: (name: string) => unknown, module: Record<string, unknown>, dirname: string) => void
function compile(path: string): Factory {
  return new Script(`(function(require,exports,__dirname){${transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText}\n})`, { filename: path }).runInThisContext() as Factory
}
const factory = compile(file)
const depsEnvFactory = compile(join(appRoot, 'src/main/deps-env.ts'))

/** CI 는 KNUAF_PYTHON 을 세워 둔다(choosePython 이 맨 앞에서 고르는 명시 지정). 이 시험은 그 값에 기대지 않는다. */
const KNUAF_PYTHON_SAVED = process.env.KNUAF_PYTHON

/** 이 OS 에서 앱이 "환경의 실행기"로 인정하는 자리(윈도 Scripts\\python.exe, 그 밖 bin/python3) — 빈 가짜 파일을 둔다. */
function fakeInterpreter(env: string): string {
  const exe = process.platform === 'win32' ? join(env, 'Scripts', 'python.exe') : join(env, 'bin', 'python3')
  mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, '')
  return exe
}

function harness() {
  delete process.env.KNUAF_PYTHON
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'knuaf-venv-guard-')))
  const userData = join(dir, 'userData'), managed = join(dir, 'managed', 'bin', 'python3')
  const root = join(dir, '남이 준 논문'), marker = join(dir, 'PWNED')
  mkdirSync(userData, { recursive: true }); mkdirSync(root)
  // Windows depsRoot uses LOCALAPPDATA/app.getName(), not Electron's userData override.
  const localAppData = process.env.LOCALAPPDATA
  if (process.platform === 'win32') process.env.LOCALAPPDATA = dir
  const depsEnv: Record<string, unknown> = {}
  depsEnvFactory(realRequire, depsEnv, join(appRoot, 'out', 'main'))
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getPath: () => userData, getVersion: () => '0.7.5', getName: () => 'userData' } },
    './runtime': { managedPython: () => managed },
    './agent': { skillSource: () => join(dir, 'skill') },
    './settings': { loadSettings: () => ({ python_override: null }) },
    './deps-env': depsEnv
  }
  const module: Record<string, unknown> = {}
  factory((name) => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module, join(appRoot, 'out', 'main'))
  return { dir, root, marker, managed, depsEnv, python: module as unknown as typeof PythonModule,
    cleanup: () => {
      if (KNUAF_PYTHON_SAVED === undefined) delete process.env.KNUAF_PYTHON; else process.env.KNUAF_PYTHON = KNUAF_PYTHON_SAVED
      if (process.platform === 'win32') {
        if (localAppData === undefined) delete process.env.LOCALAPPDATA
        else process.env.LOCALAPPDATA = localAppData
      }
      rmSync(dir, { recursive: true, force: true })
    } }
}

/** 앱이 만들지 않은 `.venv`. 실행되면 표시 파일을 남긴다(posix: 셸 스크립트). */
function plantForeignVenv(root: string, marker: string): string {
  const venv = join(root, '.venv')
  if (process.platform === 'win32') {
    mkdirSync(join(venv, 'Scripts'), { recursive: true })
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = C:\\Attacker\\Python312\nversion = 3.12.1\n')
    const exe = join(venv, 'Scripts', 'python.exe')
    writeFileSync(exe, 'not a real executable') // 윈도에서는 선택 판정만 본다
    return exe
  }
  mkdirSync(join(venv, 'bin'), { recursive: true })
  writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /opt/attacker/bin\nversion = 3.12.1\n')
  const exe = join(venv, 'bin', 'python3')
  writeFileSync(exe, `#!/bin/sh\necho "ran with app privileges: $*" > '${marker.replace(/'/g, `'\\''`)}'\nexit 0\n`)
  chmodSync(exe, 0o755)
  return exe
}

test('S1: 앱이 만든 기록이 없는 프로젝트 .venv 는 실행기 후보가 되지 않는다', () => {
  const h = harness()
  try {
    const planted = plantForeignVenv(h.root, h.marker)
    expect(existsSync(planted)).toBe(true)
    // 단일 공급원: 사이드카(choosePython)·터미널/본대화 PATH(agentCtx·pythonBinDirs)·담당 PATH(relayOptions)가 모두 이 값을 쓴다.
    expect(h.python.venvPython(h.root)).toBeNull()
    const pick = h.python.choosePython(h.root, null)
    expect(pick.kind).not.toBe('venv')
    expect(pick.python).not.toBe(planted)
    expect(pick.python).toBe(h.managed)
  } finally { h.cleanup() }
})

test('S1 실행: 고른 실행기를 사이드카처럼 띄워도 폴더 안 코드가 돌지 않는다', () => {
  test.skip(process.platform === 'win32', '가짜 실행 파일은 posix 셸 스크립트로만 만든다')
  const h = harness()
  try {
    plantForeignVenv(h.root, h.marker)
    const pick = h.python.choosePython(h.root, null)
    // sidecar.ts startNow 와 같은 모양의 실행. 관리 실행기 가짜 경로는 없으므로 ENOENT 로 끝나는 것이 정상이다.
    spawnSync(pick.python, ['-m', 'knuaf_sidecar', '--interpreter-kind', pick.kind], { cwd: h.dir, timeout: 5000 })
    expect(existsSync(h.marker)).toBe(false)
  } finally { h.cleanup() }
})

test('S2: 표식 있는 앱 데이터 환경만 고르고, 표식 없음·키 다름은 고르지 않는다(폴더 .venv 는 늘 무시)', () => {
  test.skip(process.platform === 'win32', '가짜 실행 파일 경로를 posix 꼴로 만든다')
  const h = harness()
  try {
    const planted = plantForeignVenv(h.root, h.marker)
    const py = h.python as unknown as Record<string, (...a: unknown[]) => string>
    const root = py.depsRoot(), key = py.depsEnvKey(null)
    const env = join(root, key), envPy = join(env, 'bin', 'python3')
    mkdirSync(join(env, 'bin'), { recursive: true })
    writeFileSync(envPy, '')
    // 표식 없음(만들다 만 잔해) → 신뢰 안 함
    expect(py.depsVenv(null)).toBe('')
    expect(py.agentDepsVenv()).toBe(py.depsNoneDir()) // 빈 값이 아니라 "없음" 경로(B-01)
    expect(h.python.choosePython(h.root, null).python).toBe(h.managed)
    // 키가 다른 표식 → 신뢰 안 함
    writeFileSync(join(env, 'knuaf-ready.json'), JSON.stringify({ key: 'other' }))
    expect(py.depsVenv(null)).toBe('')
    // main 이 준비 끝에 쓴 표식 → 신뢰. 폴더 .venv 는 여전히 고르지 않는다.
    ;(h.depsEnv.markReady as (r: string, k: string) => string)(root, key)
    expect(py.depsVenv(null)).toBe(env)
    const pick = h.python.choosePython(h.root, null)
    expect(pick).toEqual({ python: envPy, kind: 'venv' })
    expect(pick.python).not.toBe(planted)
    expect(h.python.venvPython(h.root)).toBe(envPy) // 에이전트·본대화·담당 PATH 입력
    expect(py.agentDepsVenv()).toBe(env) // 에이전트·본대화·담당 env 의 KNUAF_DEPS_VENV(D-A)
    // 표식 없는 잔해 폐기는 앱 데이터 뿌리 안에서만, 표식 있는 환경은 그대로
    expect((h.depsEnv.discardUnmarked as (r: string, k: string) => boolean)(root, key)).toBe(false)
    expect(existsSync(envPy)).toBe(true)
  } finally { h.cleanup() }
})

test('GC(§3.2): 앱 데이터 deps/ 에는 현재 키 + 직전(가장 최근 표식) 1개만 남긴다', async () => {
  test.skip(process.platform === 'win32', '심볼릭 링크 장면을 posix 로 만든다')
  const h = harness()
  try {
    const de = h.depsEnv as Record<string, (...a: unknown[]) => unknown>
    const root = join(h.dir, 'userData', 'deps')
    const env = (key: string, marked: boolean, ageSec: number) => {
      const dir = join(root, key)
      mkdirSync(join(dir, 'bin'), { recursive: true }); writeFileSync(join(dir, 'bin', 'python3'), '')
      if (marked) {
        de.markReady(root, key)
        const t = Date.now() / 1000 - ageSec
        utimesSync(join(dir, 'knuaf-ready.json'), t, t)
      }
      return dir
    }
    const current = env('aaaaaaaaaaaaaaaa', false, 0)   // 지금 키(준비 중일 수 있음) — 표식 없어도 남김
    const newer = env('bbbbbbbbbbbbbbbb', true, 60)      // 직전 — 남김
    const older = env('cccccccccccccccc', true, 3600)    // 더 옛것 — 지움
    const debris = env('dddddddddddddddd', false, 0)     // 표식 없는 잔해 — 지움
    const notes = join(root, 'notes'); mkdirSync(notes)  // 키 모양이 아님 — 건드리지 않음
    const outside = join(h.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'x')
    symlinkSync(outside, join(root, 'eeeeeeeeeeeeeeee'))  // 키 모양 링크 — 따라가지 않음
    const removed = await de.pruneEnvs(root, 'aaaaaaaaaaaaaaaa') as string[]
    expect(removed.sort()).toEqual([older, debris].sort())
    for (const kept of [current, newer, notes]) expect(existsSync(kept)).toBe(true)
    for (const gone of [older, debris]) expect(existsSync(gone)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('x')
    // 뿌리가 없으면 조용히 빈 목록
    expect(await de.pruneEnvs(join(h.dir, 'nope'), 'aaaaaaaaaaaaaaaa')).toEqual([])
  } finally { h.cleanup() }
})

test('B-01: 환경이 없을 때 모든 갈래가 같은 "없음" 경로(앱 데이터 deps/_none, 만들지 않음)를 쓴다', () => {
  test.skip(process.platform === 'win32', '가짜 실행 파일 경로를 posix 꼴로 만든다')
  const h = harness()
  try {
    const py = h.python as unknown as Record<string, (...a: unknown[]) => string>
    const de = h.depsEnv as Record<string, (...a: unknown[]) => unknown>
    const root = py.depsRoot(), none = join(root, '_none')
    expect(py.depsNoneDir()).toBe(none)
    expect(py.agentDepsVenv()).toBe(none) // 표식 없음 → 도우미 env
    expect(py.processDepsVenv(null)).toBe(none) // 사이드카 기동 env·호출 인자
    expect(existsSync(none)).toBe(false)
    // 준비된 뒤에는 실제 환경
    const key = py.depsEnvKey(null), env = join(root, key)
    mkdirSync(join(env, 'bin'), { recursive: true }); writeFileSync(join(env, 'bin', 'python3'), '')
    de.markReady(root, key)
    expect(py.agentDepsVenv()).toBe(env)
    expect(py.processDepsVenv(null)).toBe(env)
    // "없음" 폴더는 앱의 어떤 길로도 생기지 않는다: 표식·폐기·정리는 키 모양만 받는다
    expect(() => de.markReady(root, '_none')).toThrow()
    expect(de.discardUnmarked(root, '_none')).toBe(false)
    expect(existsSync(none)).toBe(false)
  } finally { h.cleanup() }
})

test('I-01 실제 잠금: 한 번에 하나, 취소하면 null, 죽은 프로세스의 잠금은 잔해로 치운다', async () => {
  const h = harness()
  try {
    const de = h.depsEnv as Record<string, (...a: unknown[]) => unknown>
    const root = join(h.dir, 'userData', 'deps')
    const acquire = (opts?: object) => de.acquireEnvLock(root, { pollMs: 5, ...opts }) as Promise<(() => void) | null>
    const first = await acquire()
    expect(first).not.toBeNull()
    expect(existsSync(join(root, '.lock'))).toBe(true)
    let secondGot = false
    const second = acquire().then((release) => { secondGot = true; return release })
    await new Promise((r) => setTimeout(r, 40))
    expect(secondGot).toBe(false) // 기다린다
    let cancelled = false
    expect(await acquire({ isCancelled: () => cancelled || (cancelled = true) })).toBeNull() // 기다리다 취소
    first!()
    const release2 = await second
    expect(secondGot).toBe(true)
    release2!()
    expect(existsSync(join(root, '.lock'))).toBe(false)
    // 죽은 프로세스가 남긴 잠금: 치우고 가져간다
    writeFileSync(join(root, '.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 'x' }))
    const third = await acquire()
    expect(third).not.toBeNull()
    third!()
    // 살아 있는 다른 프로세스(부모)의 잠금: 가져가지 못한다
    writeFileSync(join(root, '.lock'), JSON.stringify({ pid: process.ppid, at: 'x' }))
    let n = 0
    expect(await acquire({ isCancelled: () => ++n > 5 })).toBeNull()
    rmSync(join(root, '.lock'), { force: true })
  } finally { h.cleanup() }
})

test('I-03 표식 되돌리기: 원문 그대로 복원, 없었으면 제거, 신뢰 철회는 표식만 지운다', () => {
  const h = harness()
  try {
    const de = h.depsEnv as Record<string, (...a: unknown[]) => unknown>
    const root = join(h.dir, 'userData', 'deps'), key = 'aaaaaaaaaaaaaaaa', env = join(root, key)
    const interpreter = fakeInterpreter(env)
    expect(de.readMark(root, key)).toBeNull()
    de.markReady(root, key)
    expect(de.trustedEnv(root, key)).toBe(env)
    const original = de.readMark(root, key) as string
    de.markReady(root, key, { again: true })
    de.restoreMark(root, key, original)
    expect(de.readMark(root, key)).toBe(original)
    de.restoreMark(root, key, null)
    expect(de.trustedEnv(root, key)).toBe('')
    expect(existsSync(interpreter)).toBe(true) // 환경 자체는 그대로(치우는 것은 discardUnmarked)
    de.markReady(root, key)
    expect(de.revokeTrust(root, key)).toBe(true)
    expect(de.trustedEnv(root, key)).toBe('')
    expect(de.revokeTrust(root, '_none')).toBe(false)
  } finally { h.cleanup() }
})

test('윈도 환경 실행기 자리: Scripts\\python.exe 만 인정하고 bin/python3 는 인정하지 않는다(맥에서도 platform 인자로 확인)', () => {
  const h = harness()
  try {
    const de = h.depsEnv as Record<string, (...a: unknown[]) => unknown>
    const posixOnly = join(h.dir, 'posix-only'), winLike = join(h.dir, 'win-like')
    mkdirSync(join(posixOnly, 'bin'), { recursive: true }); writeFileSync(join(posixOnly, 'bin', 'python3'), '')
    mkdirSync(join(winLike, 'Scripts'), { recursive: true }); writeFileSync(join(winLike, 'Scripts', 'python.exe'), '')
    // CI 윈도 빨강의 뿌리: bin 꼴 가짜만 있으면 "no interpreter"(경로의 8.3 이름 RUNNER~1 과 무관 — 그 경우 오류는 'outside app data')
    expect(de.envPython(posixOnly, 'win32')).toBeNull()
    expect(de.envPython(winLike, 'win32')).toBe(join(winLike, 'Scripts', 'python.exe'))
    expect(de.envPython(winLike, 'darwin')).toBeNull()
    expect(de.envPython(posixOnly, 'darwin')).toBe(join(posixOnly, 'bin', 'python3'))
  } finally { h.cleanup() }
})

// ---- 12단계 I-01(D-U 격리 계약 2판 전제 ①②, roh-win-iso1): 사이드카 시작 전에 환경 자리를 검사한다 ----------------
// 링크는 폴더 'junction' 으로 만든다 — 윈도는 관리자 권한 없이 되고, posix 는 그 인자를 무시하고 심볼릭 링크를 만든다.
const KEY = 'aaaaaaaaaaaaaaaa'
type Api = Record<string, (...a: unknown[]) => unknown>

/** 지금 키의 신뢰 환경(표식 + 이 OS 의 실행기)을 만든다. 반환 = 환경 폴더. */
function trustedFixture(h: ReturnType<typeof harness>): { root: string; key: string; env: string } {
  const py = h.python as unknown as Api
  const root = py.depsRoot() as string, key = py.depsEnvKey(null) as string, env = join(root, key)
  fakeInterpreter(env)
  writeFileSync(join(env, 'knuaf-ready.json'), JSON.stringify({ key }))
  return { root, key, env }
}

/** 앱이 사이드카·도우미에 싣는 모든 갈래가 `project` 에 대해 그 환경을 거부했는지. */
function expectRejected(h: ReturnType<typeof harness>, project: string): void {
  const py = h.python as unknown as Api
  expect(py.depsVenv(null, project)).toBe('')
  expect(py.venvPython(project)).toBeNull()
  const sent = py.agentDepsVenv(project) as string
  expect(sent).toBe(py.depsNoneDir(project)) // 그 폴더 기준의 "없음" 값
  expect((h.depsEnv as unknown as Api).envPython(sent)).toBeNull()
  expect(h.python.choosePython(project, null)).toEqual({ python: h.managed, kind: 'managed' })
}

test('I-01 정상 배치: 분리된 환경은 신뢰한다 — 논문 폴더를 링크로 열어도 같다', () => {
  const h = harness()
  try {
    const { env } = trustedFixture(h), py = h.python as unknown as Api
    const alias = join(h.dir, '바로가기'); symlinkSync(h.root, alias, 'junction')
    for (const project of [h.root, alias]) {
      expect(py.depsVenv(null, project)).toBe(env)
      expect(h.python.choosePython(project, null).kind).toBe('venv')
    }
    expect((h.depsEnv as unknown as Api).envPlacement(py.depsRoot(), py.depsEnvKey(null), h.root)).toBeNull()
  } finally { h.cleanup() }
})

test('I-01 ②: 환경 폴더가 링크를 따라 앱 데이터 밖으로 풀리면 거부한다(표식·실행기가 있어도)', () => {
  const h = harness()
  try {
    const { root, key, env } = trustedFixture(h), py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
    const outside = join(h.dir, '바깥', '환경'); mkdirSync(join(outside, '..'), { recursive: true })
    renameSync(env, outside); symlinkSync(outside, env, 'junction')
    expectRejected(h, h.root)
    expect(py.depsVenv(null)).toBe('') // 논문 폴더가 없어도 거부
    expect(de.envPlacement(root, key, null)).toBe('outside_app_data')
  } finally { h.cleanup() }
})

test('I-01 ②: deps 루트 자체가 앱 데이터 밖을 가리키는 링크면 거부하고, 정리·폐기도 바깥을 지우지 않는다', async () => {
  const h = harness()
  try {
    const { root, key } = trustedFixture(h), de = h.depsEnv as unknown as Api
    const outside = join(h.dir, '바깥-deps')
    renameSync(root, outside); symlinkSync(outside, root, 'junction')
    // 표식 없는 폴더 둘 — 정상 배치라면 정리·폐기 대상
    const loose = 'bbbbbbbbbbbbbbbb'; mkdirSync(join(outside, loose))
    expectRejected(h, h.root)
    expect(await de.pruneEnvs(root, key)).toEqual([])
    expect(de.discardUnmarked(root, loose)).toBe(false)
    expect(existsSync(join(outside, loose))).toBe(true)
    expect(() => de.markReady(root, key)).toThrow(/outside app data/)
    expect(de.envPlacement(root, key, null)).toBe('outside_app_data')
  } finally { h.cleanup() }
})

test('I-01 ②: 끊긴 링크(대상 없음)인 환경 자리는 "아직 없음"이 아니라 거부다', () => {
  const h = harness()
  try {
    const py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
    const root = py.depsRoot() as string; mkdirSync(root, { recursive: true })
    expect(de.envPlacement(root, KEY, h.root)).toBeNull() // 아직 없는 정상 자리(준비 전)는 통과
    symlinkSync(join(h.dir, '없는 곳'), join(root, KEY), 'junction')
    expect(de.envPlacement(root, KEY, h.root)).toBe('outside_app_data')
  } finally { h.cleanup() }
})

test('I-01 ① 환경이 논문 폴더 안: 논문 폴더가 앱 데이터를 품으면 그 폴더에서만 거부한다(링크로 열어도)', () => {
  const h = harness()
  try {
    const { root, key, env } = trustedFixture(h), py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
    const alias = join(h.dir, '앱데이터-바로가기'); symlinkSync(join(h.dir, 'userData'), alias, 'junction')
    for (const project of [h.dir, join(h.dir, 'userData'), root, env, alias]) {
      expectRejected(h, project)
      expect(de.envPlacement(root, key, project)).toBe('overlaps_project')
    }
    expect(py.depsVenv(null, h.root)).toBe(env) // 겹치지 않는 폴더에서는 그대로 — 표식은 철회하지 않는다
  } finally { h.cleanup() }
})

test('I-01 ① 논문 폴더가 환경 안: 환경 안 하위 폴더(직접·링크)는 거부하고, 폐기는 그 폴더를 지우지 않는다', () => {
  const h = harness()
  try {
    const { root, key, env } = trustedFixture(h), de = h.depsEnv as unknown as Api
    const inner = join(env, '논문'); mkdirSync(inner)
    const alias = join(h.dir, '논문-바로가기'); symlinkSync(inner, alias, 'junction')
    for (const project of [inner, alias]) {
      expectRejected(h, project)
      expect(de.envPlacement(root, key, project)).toBe('overlaps_project')
    }
    rmSync(join(env, 'knuaf-ready.json'))
    expect(de.discardUnmarked(root, key, alias)).toBe(false) // 학생 폴더를 품은 자리는 지우지 않는다
    expect(existsSync(inner)).toBe(true)
  } finally { h.cleanup() }
})

test('I-01 ① 환경 링크가 논문 폴더 안을 가리키면 거부한다', () => {
  const h = harness()
  try {
    const { root, key, env } = trustedFixture(h), de = h.depsEnv as unknown as Api
    const planted = join(h.root, '환경'); renameSync(env, planted); symlinkSync(planted, env, 'junction')
    expectRejected(h, h.root)
    expect(de.envPlacement(root, key, h.root)).not.toBeNull()
  } finally { h.cleanup() }
})

// 12단계 I-02: 위 선택 시험은 가짜 실행기라 "고른다"만 본다. 여기서는 앱 데이터 자리에 **실제 venv** 를 만들어
// 고른 실행기를 돌리고, 대상 환경 prefix 로 뜨며 논문 폴더의 `.venv`·동명 모듈이 끼지 않는지 본다(윈도 CI 는 Scripts\python.exe).
test('I-02 실제 실행: 고른 앱 환경 python 은 대상 prefix 로 돌고 논문 폴더 .venv·미끼가 끼지 않는다', () => {
  const base = [KNUAF_PYTHON_SAVED, process.platform === 'win32' ? 'python' : 'python3']
    .find((c): c is string => !!c && spawnSync(c, ['-c', 'import venv'], { timeout: 20_000 }).status === 0)
  test.skip(!base && !process.env.CI, 'venv 를 만들 수 있는 python 이 이 기계에 없다')
  expect(base, 'CI 에서는 실제 venv 시험을 건너뛰지 않는다').toBeTruthy()
  const h = harness()
  try {
    const py = h.python as unknown as Api
    const root = py.depsRoot() as string, key = py.depsEnvKey(null) as string, env = join(root, key)
    const make = (dir: string): void => {
      const run = spawnSync(base!, ['-m', 'venv', '--without-pip', dir], { encoding: 'utf8', timeout: 60_000 })
      expect(run.status, run.stderr).toBe(0)
    }
    make(env); make(join(h.root, '.venv'))
    const purelib = spawnSync(base!, ['-c', 'import sys,sysconfig; p={"base":sys.argv[1],"platbase":sys.argv[1]}; print(sysconfig.get_path("purelib","venv",vars=p) if "venv" in sysconfig.get_scheme_names() else sysconfig.get_path("purelib",vars=p))', join(h.root, '.venv')], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(purelib, 'zz_planted.pth'), `import pathlib; pathlib.Path(${JSON.stringify(h.marker)}).write_text('ran')\n`)
    writeFileSync(join(h.root, 'json.py'), `import pathlib; pathlib.Path(${JSON.stringify(h.marker)}).write_text('ran')\n`)
    writeFileSync(join(env, 'knuaf-ready.json'), JSON.stringify({ key }))
    const pick = h.python.choosePython(h.root, null)
    expect(pick.kind).toBe('venv')
    // 규칙집 자식 계약과 같은 꼴(`-I -X utf8`, cwd=환경 폴더). 호출자 환경의 PYTHONPATH 가 논문 폴더를 가리켜도 끼지 않는다.
    const probe = 'import json,os,sys; print(json.dumps({"same": os.path.samefile(sys.prefix, sys.argv[1]), "isolated": sys.flags.isolated, "user": sys.flags.no_user_site, "path": sys.path}))'
    const run = spawnSync(pick.python, ['-I', '-X', 'utf8', '-c', probe, env], { cwd: env, encoding: 'utf8', timeout: 20_000, env: { ...process.env, PYTHONPATH: h.root } })
    expect(run.status, run.stderr).toBe(0)
    const seen = JSON.parse(run.stdout) as { same: boolean; isolated: number; user: number; path: string[] }
    expect(seen).toMatchObject({ same: true, isolated: 1, user: 1 })
    const folder = realpathSync.native(h.root)
    expect(seen.path.filter((p) => p === '' || (existsSync(p) && realpathSync.native(p).startsWith(folder)))).toEqual([])
    // 사이드카와 같은 모양(격리 플래그 없이, cwd=앱 쪽)으로 띄워도 폴더 .venv 는 돌지 않는다.
    expect(spawnSync(pick.python, ['-c', 'pass'], { cwd: h.dir, timeout: 20_000 }).status).toBe(0)
    expect(existsSync(h.marker)).toBe(false)
    // 미끼가 살아 있음을 확인한다(검사가 헛돌지 않게): 폴더 .venv 를 일부러 띄우면 표시가 남는다.
    const planted = (h.depsEnv as unknown as Api).envPython(join(h.root, '.venv')) as string
    spawnSync(planted, ['-c', 'pass'], { cwd: h.dir, timeout: 20_000 })
    expect(existsSync(h.marker)).toBe(true)
  } finally { h.cleanup() }
})

// ---- 13단계 venv4(웹 독립검토) 재현 ------------------------------------------------------------------------------

/** 대소문자를 구분하는 윈도 폴더 흉내(NTFS 디렉터리별 설정): 이름이 대소문자만 다른 두 폴더는 서로 다른 것이다. */
function caseSensitiveWindowsFs(dirs: string[], files: Record<string, string>, links: Record<string, string>) {
  const win = realRequire('node:path').win32 as typeof import('node:path')
  const nodes = new Map<string, { kind: 'dir' | 'file' | 'link'; ino: bigint; target?: string; text?: string }>()
  let ino = 10n
  for (const d of ['C:', ...dirs]) nodes.set(d, { kind: 'dir', ino: ino++ })
  for (const [f, text] of Object.entries(files)) nodes.set(f, { kind: 'file', ino: ino++, text })
  for (const [l, target] of Object.entries(links)) nodes.set(l, { kind: 'link', ino: ino++, target })
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
  const walk = (path: string, followLast: boolean): { path: string; node: NonNullable<ReturnType<typeof nodes.get>> } => {
    const parts = win.normalize(path).replace(/\\$/, '').split('\\')
    let current = parts[0]
    for (let i = 1; i < parts.length; i++) {
      current += '\\' + parts[i]
      const node = nodes.get(current) ?? fail('ENOENT')
      if (node.kind === 'link' && (followLast || i < parts.length - 1)) current = walk(node.target!, true).path
    }
    return { path: current, node: nodes.get(current) ?? fail('ENOENT') }
  }
  const stats = (n: { kind: string; ino: bigint }) => ({ dev: 1n, ino: n.ino, mtimeMs: 0, isDirectory: () => n.kind === 'dir', isSymbolicLink: () => n.kind === 'link' })
  const removed: string[] = [], written: string[] = []
  const native = (p: string) => walk(p, true).path
  const fs = {
    lstatSync: (p: string) => stats(walk(p, false).node), statSync: (p: string) => stats(walk(p, true).node),
    existsSync: (p: string) => { try { walk(p, true); return true } catch { return false } },
    realpathSync: Object.assign((p: string) => native(p), { native }),
    readdirSync: (p: string) => { const at = native(p) + '\\'; return [...nodes.keys()].filter((k) => k.startsWith(at) && !k.slice(at.length).includes('\\')).map((k) => k.slice(at.length)) },
    readFileSync: (p: string) => walk(p, true).node.text ?? fail('EISDIR'),
    rmSync: (p: string) => { removed.push(p) }, writeFileSync: (p: string) => { written.push(p) }, renameSync: (_a: string, b: string) => { written.push(b) },
    mkdirSync: () => {}
  }
  const exports: Record<string, unknown> = {}
  depsEnvFactory((name) => name === 'node:path' ? win : name === 'node:fs' ? fs : name === 'node:fs/promises' ? { rm: async (p: string) => { removed.push(p) } } : realRequire(name),
    exports, join(appRoot, 'out', 'main'))
  return { api: exports as unknown as Api, removed, written }
}

test('13단계 B-01: 대소문자만 다른 별개 폴더로 이어지는 deps 정션은 앱 데이터 밖이다(식별자가 다르면 글자 비교로 뒤집지 않는다)', async () => {
  const key = KEY, loose = 'bbbbbbbbbbbbbbbb', away = 'C:\\DATA\\elsewhere'
  const w = caseSensitiveWindowsFs(
    ['C:\\data', 'C:\\DATA', away, `${away}\\${key}`, `${away}\\${key}\\bin`, `${away}\\${key}\\Scripts`, `${away}\\${loose}`],
    { [`${away}\\${key}\\knuaf-ready.json`]: JSON.stringify({ key }), [`${away}\\${key}\\bin\\python3`]: '', [`${away}\\${key}\\Scripts\\python.exe`]: '' },
    { 'C:\\data\\deps': away })
  const root = 'C:\\data\\deps'
  expect(w.api.trustedEnv(root, key)).toBe('')
  expect(() => w.api.markReady(root, key)).toThrow(/outside app data/)
  expect(w.api.discardUnmarked(root, loose)).toBe(false)
  expect(await w.api.pruneEnvs(root, key)).toEqual([])
  expect(w.removed).toEqual([])
  expect(w.written).toEqual([])
  expect(w.api.envPlacement(root, key, null)).toBe('outside_app_data')
})

test('13단계 B-01 윈도 실물: 대소문자 구분 폴더에서 이름만 다른 폴더로 가는 정션을 거부한다', () => {
  test.skip(process.platform !== 'win32', '윈도 NTFS 의 디렉터리별 대소문자 구분이 있어야 한다')
  const h = harness()
  try {
    const cs = join(h.dir, 'cs'); mkdirSync(cs)
    const enabled = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', cs, 'enable'], { encoding: 'utf8' })
    test.skip(enabled.status !== 0, `대소문자 구분을 켤 수 없는 자리: ${enabled.stdout}${enabled.stderr}`)
    const de = h.depsEnv as unknown as Api
    const away = join(cs, 'DATA', 'elsewhere'), root = join(cs, 'data', 'deps'), loose = 'bbbbbbbbbbbbbbbb'
    mkdirSync(join(cs, 'data')); mkdirSync(join(away, loose), { recursive: true })
    fakeInterpreter(join(away, KEY)); writeFileSync(join(away, KEY, 'knuaf-ready.json'), JSON.stringify({ key: KEY }))
    symlinkSync(away, root, 'junction')
    expect(de.trustedEnv(root, KEY)).toBe('')
    expect(de.discardUnmarked(root, loose)).toBe(false)
    expect(existsSync(join(away, loose))).toBe(true)
    expect(de.envPlacement(root, KEY, null)).toBe('outside_app_data')
  } finally { h.cleanup() }
})

test('13단계 I-01: 링크 뒤의 `..` 는 접기 전에 파일 시스템으로 푼다(실제로 환경 안인 폴더는 겹침)', () => {
  test.skip(process.platform === 'win32', '윈도는 OS 가 `..` 를 글자로 먼저 접는다 — posix 의 실제 해석 장면이다')
  const h = harness()
  try {
    const { root, key, env } = trustedFixture(h), de = h.depsEnv as unknown as Api
    mkdirSync(join(env, 'sub')); symlinkSync(join(env, 'sub'), join(h.root, 'alias'))
    const project = join(h.root, 'alias') + '/..' // join 은 `..` 를 접으므로 글자로 붙인다
    expect(realpathSync.native(project)).toBe(realpathSync.native(env))
    expectRejected(h, project)
    expect(de.envPlacement(root, key, project)).toBe('overlaps_project')
    // 없는 곳을 거쳐 `..` 로 나오는 경로는 풀 수 없는 것으로 거부한다
    expect(de.envPlacement(root, key, join(h.root, '없음') + '/..')).toBe('overlaps_project')
  } finally { h.cleanup() }
})

test('14단계 I-01: 끊긴 논문 폴더 링크는 끝 구분자나 미생성 하위 경로가 있어도 거부한다', () => {
  const h = harness()
  try {
    const { env } = trustedFixture(h)
    const path = join(h.root, 'project-link')
    symlinkSync(join(h.dir, 'missing-project'), path, 'junction')
    const sep = process.platform === 'win32' ? '\\' : '/'
    // 미생성인 보통 경로는 판정 가능하다. 같은 이름의 끊긴 링크는 다르다.
    expect(h.python.depsVenv(null, join(h.root, 'uncreated') + sep)).toBe(env)
    for (const project of [path, path + sep + 'uncreated', path + sep, path + sep + sep]) {
      expect(h.python.depsVenv(null, project), project).toBe('')
    }
  } finally { h.cleanup() }
})

test('14단계 I-01: 끝 구분자는 기존 파일을 폴더로 바꾸지 않는다', () => {
  test.skip(process.platform === 'win32', 'POSIX 의 끝 구분자 의미를 확인한다')
  const h = harness()
  try {
    trustedFixture(h)
    const file = join(h.root, 'file'); writeFileSync(file, '')
    expect(h.python.depsVenv(null, file + '/')).toBe('')
  } finally { h.cleanup() }
})

/** 거부된 장면에서 앱이 도우미·사이드카에 싣는 값 — 미끼가 있는 자리를 가리키면 안 되고, 그 자리에 실행기가 없어야 한다. */
function expectSafeNone(h: ReturnType<typeof harness>, project: string | null, bait: string): void {
  const py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
  for (const value of [py.agentDepsVenv(project), py.processDepsVenv(null, project), py.depsNoneDir(project)] as string[]) {
    expect(de.envPython(value)).toBeNull() // 도우미·사이드카가 이 값에서 실행기를 찾으면 미끼가 돈다
    expect(existsSync(value) && realpathSync.native(value) === realpathSync.native(bait)).toBe(false)
    expect(value).toBe(de.noDepsEnvFallback())
  }
}

for (const where of ['논문 폴더 안', '앱 데이터 밖'] as const) {
  test(`13단계 I-02: deps 가 ${where}을(를) 가리키고 거기 _none 미끼가 있으면 "없음" 값은 만들 수 없는 고정 경로다`, () => {
    const h = harness()
    try {
      const py = h.python as unknown as Api
      const root = py.depsRoot() as string
      const away = where === '논문 폴더 안' ? join(h.root, '받은-deps') : join(h.dir, '바깥-deps')
      const bait = join(away, '_none'); fakeInterpreter(bait)
      mkdirSync(join(root, '..'), { recursive: true }); symlinkSync(away, root, 'junction')
      expectSafeNone(h, h.root, bait)
      expectSafeNone(h, null, bait)
    } finally { h.cleanup() }
  })
}

test('14단계 I-02: 앱 데이터 안으로 풀리더라도 deps 링크는 _none 의 부모로 쓰지 않는다', () => {
  const h = harness()
  try {
    const root = h.python.depsRoot(), clean = join(h.dir, 'userData', 'clean')
    mkdirSync(clean)
    symlinkSync(clean, root, 'junction')
    const sent = h.python.agentDepsVenv(h.root)
    expect(sent).not.toBe(join(root, '_none'))
    expect(sent).not.toBe(join(clean, '_none'))
  } finally { h.cleanup() }
})

test('14단계 I-02: 앱 데이터 별칭 대신 확인한 실제 경로를 넘긴다', () => {
  const h = harness()
  try {
    const base = join(h.dir, 'userData'), alias = join(h.dir, 'data-alias')
    symlinkSync(base, alias, 'junction')
    const de = h.depsEnv as unknown as Api
    expect(de.noneEnvDir(join(alias, 'deps'), h.root)).toBe(join(realpathSync.native(base), 'deps', '_none'))
  } finally { h.cleanup() }
})

test('13단계 I-02: _none 이 아직 없어도, 논문 폴더가 그 자리를 품으면(누가 만들 수 있으면) 쓰지 않는다', () => {
  const h = harness()
  try {
    const py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
    const none = join(py.depsRoot() as string, '_none')
    expect(py.agentDepsVenv(h.root)).toBe(none) // 정상 배치: 앱 데이터의 "없음" 경로 그대로
    for (const project of [h.dir, join(h.dir, 'userData')]) {
      expect(py.agentDepsVenv(project)).not.toBe(none)
      expect(py.agentDepsVenv(project)).toBe(de.noDepsEnvFallback())
    }
  } finally { h.cleanup() }
})

test('13단계 I-02: 앱 데이터에 _none 이 어쩌다 생겨 있으면 쓰지 않는다', () => {
  const h = harness()
  try {
    const py = h.python as unknown as Api
    const bait = join(py.depsRoot() as string, '_none'); fakeInterpreter(bait)
    expectSafeNone(h, h.root, bait)
  } finally { h.cleanup() }
})

test('13단계 R-01: 순환 링크인 환경 자리는 거부한다', () => {
  const h = harness()
  try {
    const py = h.python as unknown as Api, de = h.depsEnv as unknown as Api
    const root = py.depsRoot() as string, other = join(h.dir, 'userData', '고리'); mkdirSync(root, { recursive: true })
    symlinkSync(other, join(root, KEY), 'junction'); symlinkSync(join(root, KEY), other, 'junction')
    expect(de.envPlacement(root, KEY, h.root)).toBe('outside_app_data')
  } finally { h.cleanup() }
})
