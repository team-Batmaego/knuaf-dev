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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-venv-guard-'))
  const userData = join(dir, 'userData'), managed = join(dir, 'managed', 'bin', 'python3')
  const root = join(dir, '남이 준 논문'), marker = join(dir, 'PWNED')
  mkdirSync(userData, { recursive: true }); mkdirSync(root)
  const depsEnv: Record<string, unknown> = {}
  depsEnvFactory(realRequire, depsEnv, join(appRoot, 'out', 'main'))
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getPath: () => userData, getVersion: () => '0.7.5', getName: () => 'knuaf-test' } },
    './runtime': { managedPython: () => managed },
    './agent': { skillSource: () => join(dir, 'skill') },
    './settings': { loadSettings: () => ({ python_override: null }) },
    './deps-env': depsEnv
  }
  const module: Record<string, unknown> = {}
  factory((name) => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module, join(appRoot, 'out', 'main'))
  return { dir, root, marker, managed, depsEnv, python: module as unknown as typeof PythonModule,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) }
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
    expect(py.agentDepsVenv()).toBe('')
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
