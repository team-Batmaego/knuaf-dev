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
import { pathPattern, RULE_LEGACY, RULE_PAGE_QUERY, type FigureRule, type QuerySpec } from './url-rules'

export interface RulesLoad {
  ok: boolean
  rules: FigureRule[]
  /** 증명·진단용 — 어느 파일을 읽었는가. */
  source: string | null
  problem: 'missing' | 'broken' | null
}

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

/** 파일 계약 위반은 전부 거절, 항목 계약 위반은 해당 항목만 버린다(G1~G5, I1~I7). */
export function parseRules(text: string): FigureRule[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  if (!('v' in raw) || raw.v !== 1 || !('rules' in raw) || !Array.isArray(raw.rules)) return []
  const list = raw.rules
  // 항목 검사보다 먼저 센다. 잘못된 새 항목도 옛 항목으로 우회할 수 없어야 한다(G5).
  const hostKinds = new Map<string, string>()
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const { host, rule } = item as { host?: unknown; rule?: unknown }
    if (typeof host !== 'string' || (rule !== RULE_LEGACY && rule !== RULE_PAGE_QUERY)) continue
    const previous = hostKinds.get(host)
    if (previous && previous !== rule) return []
    hostKinds.set(host, rule)
  }
  const rules: FigureRule[] = []
  const ids = new Set<string>()
  for (const item of list) {
    const rule = asRule(item)
    if (!rule) continue
    if (ids.has(rule.id)) return []
    ids.add(rule.id)
    rules.push(rule)
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
  if (rule !== RULE_LEGACY && rule !== RULE_PAGE_QUERY) return null
  if (!compiles(pagePath) || !compiles(imagePath) || !validHost(host)) return null
  let pageQuery: ReadonlyMap<string, QuerySpec> | undefined
  if (rule === RULE_PAGE_QUERY) {
    const parsed = asPageQuery(record.pageQuery)
    if (!parsed) return null
    pageQuery = parsed
  } else if (Object.hasOwn(record, 'pageQuery')) return null
  return {
    id,
    host,
    org,
    pagePath,
    imagePath,
    rule,
    ...(pageQuery ? { pageQuery } : {}),
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


function validHost(host: string): boolean {
  if (host.length > 253) return false
  const labels = host.split('.')
  if (labels.length < 2 || labels[labels.length - 1]!.length < 2 || /[^a-z]/.test(labels[labels.length - 1]!)) return false
  return labels.every((label) => label.length >= 1 && label.length <= 63 &&
    !/[^a-z0-9-]/.test(label) && !label.startsWith('-') && !label.endsWith('-') && !label.startsWith('xn--'))
}

function validLiteral(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && !/[^A-Za-z0-9._~-]/.test(value)
}

function asPageQuery(value: unknown): ReadonlyMap<string, QuerySpec> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = value as Record<string, unknown>
  const names = Object.keys(entries)
  if (names.length < 1 || names.length > 8) return null
  const result = new Map<string, QuerySpec>()
  for (const name of names) {
    if (name.length < 1 || name.length > 64 || /[^A-Za-z0-9_.-]/.test(name)) return null
    const spec = entries[name]
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
    const fields = spec as { literal?: unknown; digits?: unknown; enum?: unknown }
    const keys = Object.keys(spec)
    if (keys.length !== 1) return null
    if (keys[0] === 'literal' && validLiteral(fields.literal)) {
      result.set(name, { kind: 'literal', value: fields.literal })
    } else if (keys[0] === 'digits' && fields.digits === true) {
      result.set(name, { kind: 'digits' })
    } else if (keys[0] === 'enum' && Array.isArray(fields.enum)) {
      if (fields.enum.length < 1 || fields.enum.length > 8 || !fields.enum.every(validLiteral)) return null
      const values = new Set<string>(fields.enum)
      if (values.size !== fields.enum.length) return null
      result.set(name, { kind: 'enum', values })
    } else return null
  }
  return result
}
