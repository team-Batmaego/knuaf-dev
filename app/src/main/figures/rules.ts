/**
 * figures/rules.ts — 사람이 검토한 출처 규칙집 읽기 (설계 R4-4·§10, I-03)
 *
 * 정본은 스킬의 `references/figure-sources.json`이고, 앱은 `resolveSkillSource()`가 준 경로(검증된
 * 활성 판
 * 또는 앱 동봉판)에서만 읽는다. **논문 폴더 사본은 읽지 않는다** — 학생 폴더의 파일은 학생이 바꿀 수
 * 있으므로 허용목록의 근거가 될 수 없다.
 *
 * 파일이 없거나 깨지면 **빈 목록**(= 전부 거절). 내장 목록으로 넓히지 않는다: 넓히는 순간 사람 검토
 * 없이 승인되는 경로가 생긴다.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathPattern, type FigureRule } from './url-rules'

export interface RulesLoad {
  ok: boolean
  rules: FigureRule[]
  /** 증명·진단용 — 어느 파일을 읽었는가. */
  source: string | null
  problem: 'missing' | 'broken' | null
}

const RULE_KIND = 'page_kogl_applies_to_body_images'

/** 검증된 판 루트에서 규칙집을 읽는다. */
export async function loadRules(skillSource: string | null): Promise<RulesLoad> {
  if (!skillSource) return { ok: false, rules: [], source: null, problem: 'missing' }
  const path = join(skillSource, 'references', 'figure-sources.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, rules: [], source: path, problem: 'missing' }
  }
  const rules = parseRules(text)
  return { ok: true, rules, source: path, problem: null }
}

/** 규칙집 JSON 본문을 규칙 목록으로 좁힌다. 잘못된 항목은 **그 항목만** 버린다. */
export function parseRules(text: string): FigureRule[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const list = "rules" in raw ? raw.rules : null
  if (!Array.isArray(list)) return []
  const rules: FigureRule[] = []
  for (const item of list) {
    const rule = asRule(item)
    if (rule) rules.push(rule)
  }
  return rules
}

function asRule(item: unknown): FigureRule | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const text = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const id = text('id')
  const host = text('host')
  const org = text('org')
  const pagePath = text('pagePath')
  const imagePath = text('imagePath')
  const rule = text('rule')
  if (!id || !host || !org || !pagePath || !imagePath || !rule) return null
  // 모르는 판정 규칙은 조용히 무시한다 — 이름이 다른 규칙을 우리 뜻으로 해석하지 않는다.
  if (rule !== RULE_KIND) return null
  // 깨진 정규식도 그 항목만 버린다(넓히지 않는다).
  if (!compiles(pagePath) || !compiles(imagePath)) return null
  const hostLooksValid = !host.includes('/') && !host.includes('@') && !host.includes(':')
  if (!hostLooksValid) return null
  return {
    id,
    host,
    org,
    pagePath,
    imagePath,
    rule,
    ...(text('evidence') ? { evidence: text('evidence') as string } : {}),
    ...(text('note') ? { note: text('note') as string } : {})
  }
}

function compiles(pattern: string): boolean {
  try {
    pathPattern(pattern)
    return true
  } catch {
    return false
  }
}
