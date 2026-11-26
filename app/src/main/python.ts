import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { managedPython } from './runtime'
import { skillSource } from './agent'
import { loadSettings } from './settings'
import { depsKey, envPython, pruneEnvs, trustedEnv } from './deps-env'

/** app/ in a checkout (out/main → ../..); resources live next to it when packaged. */
export const APP_ROOT = resolve(__dirname, '..', '..')
import type { SidecarInfo } from '../shared/types'

/** Both checkout and packaged execution use the selected composed bundle. */
export function scriptsDir(): string {
  return join(skillSource(APP_ROOT, app.isPackaged, process.resourcesPath), 'scripts')
}

export function sidecarDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'sidecar')
  return join(APP_ROOT, 'sidecar')
}

export function bundledPython(): string | null {
  // e2e 전용: 개발 빌드에서만 번들을 없는 것으로 친다(번들이 있는 기계에서도 "번들 없음"
  // 장면을 그대로 재현하기 위함). 설치본에서는 이 변수를 읽지 않는다(D10 과 같은 경계).
  if (!app.isPackaged && process.env.KNUAF_NO_BUNDLE === '1') return null
  const base = app.isPackaged ? join(process.resourcesPath, 'python') : join(APP_ROOT, 'resources', 'python')
  const candidates = process.platform === 'win32' ? [join(base, 'python.exe')] : [join(base, 'bin', 'python3'), join(base, 'bin', 'python3.12')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** 앱 데이터 의존성 환경의 뿌리. 관리 런타임과 같은 규칙: 맥 userData, 윈도 LOCALAPPDATA(로밍에 큰 폴더 금지). */
export function depsRoot(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, app.getName(), 'deps')
  return join(app.getPath('userData'), 'deps')
}

/** 지금 스킬·기반 python 에 맞는 의존성 환경 키. */
export function depsEnvKey(override: string | null = null): string {
  return depsKey(scriptsDir(), basePython(override))
}

/**
 * 신뢰된 앱 데이터 의존성 환경 폴더(표식 있음), 없으면 빈 문자열(S-01 §3.2).
 * 논문 폴더의 `.venv` 는 어떤 경우에도 고르지 않는다 — 폴더에 쓸 수 있는 사람이 앱 권한으로
 * 코드를 돌리는 길이었다(S-01). 옛 판이 폴더에 만든 `.venv` 는 쓰지 않고 알리기만 한다(D1, 사이드카 doctor.all `legacy_venv`).
 */
export function depsVenv(override: string | null = null): string {
  return trustedEnv(depsRoot(), depsEnvKey(override))
}

/** 오래된 키 환경 정리(§3.2) — 지금 설정의 키 + 직전 1개만 남긴다. 앱 시작 때 한 번. */
export function pruneDepsEnvs(): Promise<string[]> {
  return pruneEnvs(depsRoot(), depsEnvKey(loadSettings().python_override))
}

export function depsPython(override: string | null = null): string | null {
  const dir = depsVenv(override)
  return dir ? envPython(dir) : null
}

/**
 * 예전 이름을 남긴 자리(에이전트·본대화·담당 PATH 가 `ctx.venvPython(root)` 로 부른다).
 * `projectRoot` 는 **보지 않는다** — 앱 데이터 환경만 돌려준다(S-01). 폴더가 열려 있지 않으면 null.
 */
export function venvPython(projectRoot: string | null): string | null {
  if (!projectRoot) return null
  return depsPython(loadSettings().python_override)
}

/**
 * 도우미(터미널·본대화·담당) env 의 `KNUAF_DEPS_VENV` 값 — 지금 설정의 신뢰된 앱 데이터 환경, 없으면 빈 값
 * (설계 §3.4). READONLY(D-A)는 `agentDepsEnv` 가 늘 함께 싣는다.
 */
export function agentDepsVenv(): string {
  return depsVenv(loadSettings().python_override)
}

/**
 * Interpreter choice: explicit override, app-data deps env (S-01 — never the project folder's .venv),
 * managed runtime, bundled runtime, PATH.
 * 관리 런타임은 사용자가 버튼을 눌렀을 때만 생기므로 번들보다 앞이다 — 번들이 깨진
 * 설치본에서도 버튼이 실제로 효과가 있어야 한다(D6).
 */
export function choosePython(projectRoot: string | null, override: string | null): Pick<SidecarInfo, 'python' | 'kind'> {
  if (override && existsSync(override)) return { python: override, kind: 'env' }
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return { python: process.env.KNUAF_PYTHON, kind: 'env' }
  const deps = projectRoot ? depsPython(override) : null
  if (deps) return { python: deps, kind: 'venv' }
  const managed = managedPython()
  if (managed) return { python: managed, kind: 'managed' }
  const bundled = bundledPython()
  if (bundled) return { python: bundled, kind: 'bundled' }
  return { python: process.platform === 'win32' ? 'python' : 'python3', kind: 'path' }
}

/** The interpreter that gg_deps.py ensure should use as the venv base: never the venv itself. */
export function basePython(override: string | null): string {
  if (override && existsSync(override)) return override
  if (process.env.KNUAF_PYTHON && existsSync(process.env.KNUAF_PYTHON)) return process.env.KNUAF_PYTHON
  return managedPython() ?? bundledPython() ?? (process.platform === 'win32' ? 'python' : 'python3')
}

export function wheelhouseDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, 'wheelhouse') : join(APP_ROOT, 'resources', 'wheelhouse')
  return existsSync(dir) ? dir : null
}
