/**
 * guard/rules.ts — 구획 파싱/직렬화, 길이·문자 검사, 보관본 규칙 상태
 *
 * §11.8: 루트 CLAUDE.md 원본=파일 내 앱 구획, 주입판=injected(보관본).
 * 무손실 직렬화: 첫줄 `- `, 이어지는 줄(빈줄 포함) 두칸 들여쓰기, 항목 사이 빈줄 없음.
 * 구획 손상 시 거절. NFC 아니면 거절, 앞뒤 공백/빈줄 trim + 줄바꿈 \n 통일만 허용.
 * 300자/5줄/30개/중복 검사.
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  type RuleItem,
  RULES_END_MARK,
  RULES_START_MARK,
  normalizeRuleText,
  parseClaudeMd,
  serializeRules,
  validateRulesSection,
  validateSectionShape
} from './instructions'

export interface UpdateResult {
  success: boolean
  newContent: string
  message: string
  sectionCreated: boolean
  errors: string[]
}

export function formatRulesBlock(rules: RuleItem[]): string {
  if (rules.length === 0) {
    return `${RULES_START_MARK}\n${RULES_END_MARK}`
  }
  // serializeRules는 시작/끝 마크 포함
  return serializeRules(rules)
}

function replaceOrAppendSection(content: string, block: string): { text: string; created: boolean } {
  const startIdx = content.indexOf(RULES_START_MARK)
  const endIdx = content.indexOf(RULES_END_MARK)
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = content.slice(0, startIdx)
    const after = content.slice(endIdx + RULES_END_MARK.length)
    return { text: `${before}${block}${after}`, created: false }
  }
  // 구획 없음 → 파일 끝에 추가
  const base = content.replace(/\s*$/, '')
  const prefix = base.length > 0 ? base + '\n\n' : ''
  return { text: `${prefix}${block}\n`, created: true }
}

export function addRuleToClaudeMd(filePath: string, rawText: string): UpdateResult {
  const result: UpdateResult = { success: false, newContent: '', message: '', sectionCreated: false, errors: [] }
  if (!existsSync(filePath)) {
    result.errors.push('대상 파일이 존재하지 않습니다.')
    return result
  }
  const content = readFileSync(filePath, 'utf-8')
  const shape = validateSectionShape(content)
  if (!shape.valid) {
    result.errors.push(...shape.errors)
    return result
  }
  const parsed = parseClaudeMd(filePath)
  const normalized = normalizeRuleText(rawText)
  if (!normalized) {
    result.errors.push('규칙이 비어 있습니다.')
    return result
  }
  // NFC 검사
  if (normalized !== normalized.normalize('NFC')) {
    result.errors.push('정규형(NFC)이 아닌 문자가 있어 저장하지 않았어요.')
    return result
  }
  // 구획 표시 흉내 방지
  if (normalized.includes('<!--') || normalized.includes('-->')) {
    result.errors.push('구획 표시(<!--, -->)를 포함한 규칙은 저장할 수 없어요.')
    return result
  }
  // 길이/줄 수 검사 (원문 기준이 아니라 정규화 후 기준 — 설계: 앞뒤 공백/빈줄 trim 후)
  const lineCount = normalized.split('\n').length
  const charCount = [...normalized].length
  if (lineCount > 5) { result.errors.push(`규칙이 5줄을 초과합니다(${lineCount}줄).`); return result }
  if (charCount > 300) { result.errors.push(`규칙이 300자를 초과합니다(${charCount}자).`); return result }
  if (parsed.rules.length >= 30) { result.errors.push('규칙은 최대 30개까지 저장할 수 있어요.'); return result }
  // 중복 검사 (저장 글자 그대로 비교)
  if (parsed.rules.some(r => r.normalized === normalized)) {
    result.errors.push('같은 내용의 규칙이 이미 있어요.')
    return result
  }
  // 제어문자 검사 (탭/줄바꿈 제외)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/.test(normalized)) {
    result.errors.push('보이지 않는 제어문자가 있어 저장할 수 없어요.')
    return result
  }

  const newRule: RuleItem = {
    raw: rawText,
    normalized,
    messageId: String(Date.now()),
    timestamp: Date.now()
  }
  const nextRules = [...parsed.rules, newRule]
  const validation = validateRulesSection(nextRules)
  if (!validation.valid) {
    result.errors.push(...validation.errors)
    return result
  }
  const block = formatRulesBlock(nextRules)
  const replaced = replaceOrAppendSection(content, block)
  result.newContent = replaced.text
  result.sectionCreated = replaced.created
  result.success = true
  result.message = '규칙을 저장했어요.'
  return result
}

export function removeRuleFromClaudeMd(filePath: string, ruleId: string): UpdateResult {
  const result: UpdateResult = { success: false, newContent: '', message: '', sectionCreated: false, errors: [] }
  if (!existsSync(filePath)) {
    result.errors.push('대상 파일이 존재하지 않습니다.')
    return result
  }
  const content = readFileSync(filePath, 'utf-8')
  const shape = validateSectionShape(content)
  if (!shape.valid) {
    result.errors.push(...shape.errors)
    return result
  }
  const parsed = parseClaudeMd(filePath)
  if (!parsed.hasRulesSection) {
    result.errors.push('규칙 구획이 없어요.')
    return result
  }
  const idx = parsed.rules.findIndex(r => r.messageId === ruleId)
  if (idx === -1) {
    result.errors.push('해당 규칙을 찾을 수 없어요.')
    return result
  }
  const nextRules = parsed.rules.filter((_, i) => i !== idx)
  if (nextRules.length === 0) {
    // 구획 자체 제거
    const startIdx = content.indexOf(RULES_START_MARK)
    const endIdx = content.indexOf(RULES_END_MARK)
    if (startIdx >= 0 && endIdx > startIdx) {
      const before = content.slice(0, startIdx).replace(/\s*$/, '')
      const after = content.slice(endIdx + RULES_END_MARK.length).replace(/^\s*/, '')
      result.newContent = [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '')
    } else {
      result.newContent = content
    }
  } else {
    const block = formatRulesBlock(nextRules)
    const replaced = replaceOrAppendSection(content, block)
    result.newContent = replaced.text
  }
  result.success = true
  result.message = '규칙을 지웠어요.'
  return result
}

export function readRulesFromClaudeMd(filePath: string): RuleItem[] {
  if (!existsSync(filePath)) return []
  const parsed = parseClaudeMd(filePath)
  return parsed.rules
}

export function updateStateRules<T extends { id: string; message: string; timestamp?: number; normalized?: string }>(
  rules: T[],
  action: 'add' | 'remove',
  payload: { rule?: T; ruleId?: string }
): { rules: T[]; message: string; errors: string[] } {
  const errors: string[] = []
  if (action === 'add') {
    if (!payload.rule) return { rules, message: '', errors: ['새 규칙이 필요해요.'] }
    if (rules.length >= 30) return { rules, message: '', errors: ['규칙은 최대 30개까지예요.'] }
    const normalized = payload.rule.normalized ?? normalizeRuleText(payload.rule.message)
    if (rules.some(r => (r.normalized ?? normalizeRuleText(r.message)) === normalized)) {
      return { rules, message: '', errors: ['같은 내용의 규칙이 이미 있어요.'] }
    }
    return { rules: [...rules, payload.rule], message: '규칙을 추가했어요.', errors }
  }
  if (action === 'remove') {
    if (!payload.ruleId) return { rules, message: '', errors: ['규칙 ID가 필요해요.'] }
    if (!rules.some(r => r.id === payload.ruleId)) return { rules, message: '', errors: ['규칙을 찾을 수 없어요.'] }
    return { rules: rules.filter(r => r.id !== payload.ruleId), message: '규칙을 지웠어요.', errors }
  }
  return { rules, message: '', errors: ['지원하지 않는 동작이에요.'] }
}

export function rulesToStateEntries(rules: RuleItem[]): Array<{ id: string; message: string; timestamp: number; normalized: string }> {
  return rules.map(r => ({ id: r.messageId, message: r.raw, timestamp: r.timestamp, normalized: r.normalized }))
}
