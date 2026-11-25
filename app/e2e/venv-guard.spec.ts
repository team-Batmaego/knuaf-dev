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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type * as PythonModule from '../src/main/python'

const appRoot = resolve(__dirname, '..')
const file = join(appRoot, 'src/main/python.ts'), realRequire = createRequire(file)
const factory = new Script(`(function(require,exports,__dirname){${transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText}\n})`, { filename: file }).runInThisContext() as
  (require: (name: string) => unknown, module: Partial<typeof PythonModule>, dirname: string) => void

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-venv-guard-'))
  const userData = join(dir, 'userData'), managed = join(dir, 'managed', 'bin', 'python3')
  const root = join(dir, '남이 준 논문'), marker = join(dir, 'PWNED')
  mkdirSync(userData, { recursive: true }); mkdirSync(root)
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: false, getPath: () => userData, getVersion: () => '0.7.5' } },
    './runtime': { managedPython: () => managed },
    './agent': { skillSource: () => join(dir, 'skill') }
  }
  const module: Partial<typeof PythonModule> = {}
  factory((name) => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module, join(appRoot, 'out', 'main'))
  return { dir, root, marker, managed, python: module as typeof PythonModule,
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
