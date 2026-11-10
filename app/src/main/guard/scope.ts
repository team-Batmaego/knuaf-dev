/**
 * guard/scope.ts — 보호 대상 경로 판정 + 경로 도우미
 *
 * 보호 규칙 하나(§4.3, V2 §3.1):
 * - 경로 조각 중 `.claude`가 있거나,
 * - 마지막 조각이 `CLAUDE.md`·`CLAUDE.local.md`이거나,
 * - 루트(폴더 바로 아래)의 `.claude.json`·`.mcp.json`
 *
 * 깊이·폴더·확장자 예외는 없다. 링크는 따라가지 않는다 — 판정은 경로 문자열만 본다.
 * 카드 판정(`claude.ts`)과 지킴이가 **같은 함수**를 쓴다(§10-13).
 *
 * 예외 자리:
 * - 앱 스킬 자리 `<userData>/skill-host/.claude/skills/knuaf-dev` — 1층이 관리하는 자리(§4.2-1)
 * - 앱 보관본 `<userData>/guard/` — 도우미가 쓰면 안 되는 자리(§11.8 '보관본 지키기')
 */

import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 마지막 조각이 이 이름이면 보호(깊이 무관). 상속 속성 이름(`toString` 등)이 섞이지 않도록
 * `Set`을 쓰고, 비교는 대소문자를 무시한다(맥 기본 볼륨·윈도우는 같은 파일, §16.2).
 */
const PROTECTED_BASENAMES = new Set(['claude.md', 'claude.local.md'])
/** 폴더 바로 아래(=루트)에서만 보호하는 이름. */
const ROOT_ONLY_BASENAMES = new Set(['.claude.json', '.mcp.json'])
/** 앱 스킬 자리 꼬리(경로 조각들). */
const SKILL_HOST_TAIL = ['skill-host', '.claude', 'skills', 'knuaf-dev']

/** 경로 정규화: `\`→`/`, 연속 슬래시 정리, 끝 슬래시 제거(루트 제외). */
export function normalizePath(p: string): string | null {
  if (!p) return null
  let s = p.replace(/\\/g, '/')
  while (s.includes('//')) s = s.replace('//', '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** 정규화한 경로의 조각. 빈 조각과 `.`은 버리고 `..`은 그대로 둔다(밖으로 나가는 판정용). */
function pathSegments(p: string): string[] {
  const normalized = normalizePath(p)
  if (!normalized) return []
  return normalized.split('/').filter((part) => part !== '' && part !== '.')
}

/** 폴더 안 상대 경로 하나에 대한 보호 여부. */
function isProtectedSegments(parts: string[], rootScoped: boolean): boolean {
  for (const part of parts) {
    if (part.toLowerCase() === '.claude') return true
  }
  const raw = parts[parts.length - 1]
  if (!raw) return false
  const base = raw.toLowerCase()
  if (PROTECTED_BASENAMES.has(base)) return true
  // `.claude.json`·`.mcp.json`은 폴더 바로 아래만이다. 루트를 모르는 호출에서는
  // 어느 깊이에서든 보호로 본다(안전측 — 설정 파일은 하위 폴더에서도 CLI가 읽는다).
  if (ROOT_ONLY_BASENAMES.has(base) && (!rootScoped || parts.length === 1)) return true
  return false
}

/**
 * 보호 대상 여부. `root`를 주면 **루트 기준 상대 경로**로 판정한다 —
 * 루트 자체가 `.claude` 아래에 있어도 폴더 안의 평범한 파일이 전부 보호로 번지지 않는다.
 * 루트 밖 경로는 절대 경로 조각으로 판정한다(카드가 따로 묻는 자리).
 */
export function isProtectedPath(p: string, root?: string): boolean {
  if (!p) return false
  if (root) {
    const rel = protectedRel(root, p)
    if (rel !== null) return rel !== '' && isProtectedSegments(rel.split('/').filter(Boolean), true)
    const abs = pathSegments(p)
    return isProtectedSegments(abs.filter((part) => part !== '..'), false)
  }
  return isProtectedSegments(pathSegments(p), false)
}

/** `child`가 `parent` 아래(같은 경로 포함)인가. 문자열 접두사가 아니라 조각으로 본다. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + sep)
}

/** 루트 아래 상대 경로. 루트 자신이면 `''`, 밖이면 null. 구분자는 `/`. */
export function protectedRel(root: string, path: string): string | null {
  const r = resolve(root)
  const p = resolve(path)
  const rel = relative(r, p)
  if (rel === '') return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null
  return rel.split(sep).join('/')
}

/** 실제 경로(심볼릭 링크 해소). 없으면 resolve 결과를 그대로 쓴다. */
export function realRoot(root: string): string {
  const resolved = resolve(root)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** 폴더 실제 경로의 sha256(보관본 키). 같은 폴더를 링크로 열어도 같은 보관본을 쓴다. */
export function folderHash(root: string): string {
  return createHash('sha256').update(realRoot(root)).digest('hex')
}

/** 앱 스킬 자리. */
export function skillHostDir(userData: string): string {
  return join(userData, 'skill-host', '.claude', 'skills', 'knuaf-dev')
}

/** `p`가 앱 스킬 자리 아래인가. `userData`를 주면 절대 경로로 대조한다. */
export function isSkillHostPath(p: string, userData?: string): boolean {
  if (!p) return false
  if (userData) return isInside(skillHostDir(userData), p)
  const parts = pathSegments(p)
  for (let i = 0; i + SKILL_HOST_TAIL.length <= parts.length; i++) {
    let hit = true
    for (let k = 0; k < SKILL_HOST_TAIL.length; k++) {
      if (parts[i + k] !== SKILL_HOST_TAIL[k]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/** 앱 보관본 자리. */
export function guardStoreDir(userData: string): string {
  return join(userData, 'guard')
}

/** `p`가 앱 보관본 아래인가(읽기·쓰기 모두 금지 대상, §11.8). */
export function isGuardStorePath(p: string, userData: string): boolean {
  if (!p) return false
  return isInside(guardStoreDir(userData), p)
}
