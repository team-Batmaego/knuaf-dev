/**
 * guard/scope.ts — 보호 대상 경로 판정 + 경로 분리
 *
 * 보호 대상 규칙 (§4.3, §11.8):
 * - 경로 조각 중 `.claude`가 있거나,
 * - 마지막 조각이 `CLAUDE.md`·`CLAUDE.local.md`이거나,
 * - 루트의 `.claude.json`·`.mcp.json`
 *
 * 앱 스킬 자리(`<userData>/skill-host/.claude/skills/knuaf-dev`)는 보호 대상에서
 * 제외한다(§4.2-1).
 */

import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

/** 보호 대상 여부 */
export function isProtectedPath(p: string, _root?: string): boolean {
  const normalized = normalizePath(p)
  if (!normalized) return false

  // 1) 경로 조각 중 `.claude`가 있으면 보호
  const parts = normalized.split('/')
  for (const part of parts) {
    if (part === '.claude') return true
  }

  // 2) 마지막 조각이 CLAUDE.md 또는 CLAUDE.local.md면 보호
  const basename = parts[parts.length - 1]
  if (basename === 'CLAUDE.md' || basename === 'CLAUDE.local.md') return true

  // 3) 루트 아래 `.claude.json`·`.mcp.json`이면 보호
  if (basename === '.claude.json' || basename === '.mcp.json') return true

  return false
}

/** 경로 정규화: \ -> /, 연속 슬래시 정리 */
export function normalizePath(p: string): string | null {
  if (!p) return null
  let s = p.replace(/\\/g, '/')
  while (s.includes('//')) s = s.replace('//', '/')
  // trim trailing slash except root
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** 주어진 경로가 app 스킬 자리(<userData>/skill-host/.claude/skills/knuaf-dev) 아래인지 */
export function isSkillHostPath(p: string): boolean {
  if (!p) return false
  const normalized = normalizePath(p)
  if (!normalized) return false
  // <userData>/skill-host/.claude/skills/knuaf-dev 경로 확인
  return normalized.includes('/skill-host/.claude/skills/knuaf-dev')
}

/** 폴더 실제 경로의 sha256 해시(보관본 키용) */
export function folderHash(rootRealPath: string): string {
  return createHash('sha256').update(rootRealPath).digest('hex')
}

/** 보호 경로 상대식별자(root 아래 상대 경로) */
export function protectedRel(root: string, path: string): string | null {
  const r = resolve(root)
  const p = resolve(path)
  if (p === r) return ''
  if (!p.startsWith(r + '/')) return null
  return p.slice(r.length + 1)
}
