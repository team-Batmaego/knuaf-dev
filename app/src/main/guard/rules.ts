/**
 * guard/rules.ts — 루트 `CLAUDE.md`의 앱 구획 편집(순수) + 규칙 표 맞추기
 *
 * 파일에는 **id를 적지 않는다** — 학생이 읽는 파일을 깨끗하게 둔다(§11.8).
 * 그래서 "기억함" 표시와 목록은 보관본의 규칙 표(`state.rules`)에서 오고,
 * 파일을 학생이 직접 고쳤으면 **파일 내용이 정본**이다(T0가 표를 다시 맞춘다).
 *
 * 구획 밖 글자는 한 글자도 건드리지 않는다. 구획이 손상됐으면 저장·지우기를 거절하고
 * 파일을 그대로 둔다(§11.8 '구획 모양').
 */

import { createHash } from 'node:crypto'
import {
  type RuleItem,
  CLAUDE_MD_MAX_BYTES,
  RULES_MAX_COUNT,
  RULES_START_MARK,
  RULES_END_MARK,
  normalizeRuleText,
  parseClaudeMd,
  replaceOrAppendSection,
  serializeRulesSection,
  validateRuleText,
  validateRulesCollection,
  validateSectionShape
} from './instructions'
import type { RuleEntry } from './store'

/**
 * 이번 변경으로 더해진 규칙 하나의 원문·시각(§16.5.4 ⓑ). 파일에는 id·시각을 적지 않으므로
 * 저장이 끝나기 전까지 이 값은 쪽지가 나른다. `timestamp`가 없으면 저장 시각을 쓴다.
 */
export interface AddedRule {
  /** `ruleId(normalized)` — 파일 글자 해시 */
  id: string
  /** 학생이 보낸 원문 */
  message: string
  messageId?: string
  timestamp?: number
}

export interface UpdateResult {
  success: boolean
  /** 성공했을 때만 새 파일 전문. 실패면 빈 문자열(호출자가 파일을 쓰지 않는다) */
  newContent: string
  message: string
  sectionCreated: boolean
  errors: string[]
  /** 더하기 성공 시 그 규칙의 원문·시각(지우기·실패면 없음) */
  rule?: AddedRule
}

const DAMAGED_MESSAGE = 'CLAUDE.md의 규칙 구획이 손상돼 있어요 · [파일 열기]'

function failure(errors: string[], message = ''): UpdateResult {
  return { success: false, newContent: '', message, sectionCreated: false, errors }
}

/** 파일 글자에서 규칙 항목만. 손상이면 빈 목록. */
export function readRules(content: string): RuleItem[] {
  const parsed = parseClaudeMd(content)
  return parsed.damaged ? [] : parsed.rules
}

/** 항목 식별자 = 저장 글자의 sha256(§11.8 '규칙 목록'). 순번·메시지 id가 아니다. */
function ruleId(normalized: string): string {
  return 'file:' + createHash('sha256').update(normalized, 'utf-8').digest('hex')
}

/** 규칙 표 한 줄의 출처(§16.5.4 ⓒ) — 학생이 파일에 직접 쓴 규칙인가 */
export const FILE_ORIGIN = 'file'

/**
 * 파일 구획과 보관본 규칙 표를 맞춘다(§16.5.4).
 *
 * 항목의 출처는 셋뿐이다 — ⓐ 이전 표에 같은 정규 글자가 있으면 그 id·원문·시각
 * ⓑ 없으면 이번 변경의 쪽지 항목(`candidate`) ⓒ 둘 다 없으면 원문 = 정규 글자,
 * 시각 = 이 교체의 시각(학생이 파일에 직접 쓴 규칙). **시각 0은 쓰지 않는다.**
 * 구획에 같은 글자가 둘 이상 있으면(학생이 직접 복사) 손상이 아니라 **하나로 본다**.
 * 파일에서 사라진 규칙은 표에서 빠진다 — 학생이 지운 것으로 본다.
 */
export function mergeRules(
  content: string,
  previous: readonly RuleEntry[],
  candidate?: RuleEntry,
  now: number = Date.now()
): RuleEntry[] {
  const parsed = parseClaudeMd(content)
  if (parsed.damaged) return []
  const pool = new Map<string, RuleEntry>()
  for (const entry of previous) {
    if (!pool.has(entry.normalized)) pool.set(entry.normalized, entry)
  }
  const seen = new Set<string>()
  const merged: RuleEntry[] = []
  for (const item of parsed.rules) {
    if (seen.has(item.normalized)) continue
    seen.add(item.normalized)
    const known = pool.get(item.normalized)
    if (known) {
      pool.delete(item.normalized)
      merged.push(known)
      continue
    }
    if (candidate && candidate.normalized === item.normalized) {
      merged.push({ ...candidate })
      continue
    }
    merged.push({
      id: ruleId(item.normalized),
      message: item.normalized,
      timestamp: now,
      normalized: item.normalized,
      origin: FILE_ORIGIN
    })
  }
  return merged
}

/** 규칙 표 항목 → 말풍선·목록용. 파일에 그 글자가 남아 있는지로 "기억함"을 판단한다. */
export interface RuleView {
  id: string
  text: string
  timestamp: number
  /** 파일 구획에 그 글자가 있는가 */
  present: boolean
}

export function ruleViews(content: string, entries: RuleEntry[]): RuleView[] {
  const parsed = parseClaudeMd(content)
  if (parsed.damaged) return []
  const texts = new Set(parsed.rules.map((rule) => rule.normalized))
  return entries.map((entry) => ({
    id: entry.id,
    text: entry.normalized,
    timestamp: entry.timestamp,
    present: texts.has(entry.normalized)
  }))
}

function guardShape(content: string): UpdateResult | null {
  const shape = validateSectionShape(content)
  if (!shape.valid) return failure(shape.errors, DAMAGED_MESSAGE)
  const parsed = parseClaudeMd(content)
  if (parsed.damaged) return failure([parsed.damageReason ?? '구획이 손상됐어요.'], DAMAGED_MESSAGE)
  return null
}

/** 규칙 하나 더하기. 새 파일 글자를 쓰지 않고 돌려준다 — 파일 쓰기는 store가 한다. */
export function addRuleToContent(
  content: string,
  rawText: string,
  opts?: { messageId?: string; timestamp?: number }
): UpdateResult {
  const broken = guardShape(content)
  if (broken) return broken

  const parsed = parseClaudeMd(content)
  const check = validateRuleText(rawText)
  if (!check.ok || !check.normalized) return failure([check.reason ?? '규칙을 저장할 수 없어요.'])
  const normalized = check.normalized

  if (parsed.rules.length >= RULES_MAX_COUNT) return failure([`규칙은 최대 ${RULES_MAX_COUNT}개까지예요.`])
  if (parsed.rules.some((rule) => rule.normalized === normalized)) return failure(['같은 내용의 규칙이 이미 있어요.'])

  const nextRules = [...parsed.rules, { normalized }]
  const collection = validateRulesCollection(nextRules)
  if (!collection.valid) return failure(collection.errors)

  const block = serializeRulesSection(nextRules)
  const replaced = replaceOrAppendSection(content, block)
  if (Buffer.byteLength(replaced.text, 'utf-8') > CLAUDE_MD_MAX_BYTES) {
    return failure([`결과 파일이 ${Math.floor(CLAUDE_MD_MAX_BYTES / 1024)}KB를 초과해요.`])
  }
  return {
    success: true,
    newContent: replaced.text,
    message: '규칙을 저장했어요.',
    sectionCreated: replaced.created,
    errors: [],
    rule: {
      id: ruleId(normalized),
      message: rawText,
      ...(opts?.messageId === undefined ? {} : { messageId: opts.messageId }),
      ...(opts?.timestamp === undefined ? {} : { timestamp: opts.timestamp })
    }
  }
}

/** 규칙 하나 지우기(파일 항목 글자로 지정). */
export function removeRuleFromContent(content: string, ruleText: string): UpdateResult {
  const broken = guardShape(content)
  if (broken) return broken

  const parsed = parseClaudeMd(content)
  if (!parsed.hasRulesSection) return failure(['규칙 구획이 없어요.'])
  const target = normalizeRuleText(ruleText)
  const index = parsed.rules.findIndex((rule) => rule.normalized === target)
  if (index < 0) return failure(['해당 규칙을 찾을 수 없어요.'])

  const nextRules = parsed.rules.filter((_, i) => i !== index)
  if (nextRules.length === 0) {
    // 마지막 항목이면 구획을 통째로 뺀다 — 빈 구획을 남기지 않는다.
    // 구획 밖 글자는 **한 바이트도** 건드리지 않는다(§11.8 '규칙 목록' 마지막 항목 줄).
    const startIdx = content.indexOf(RULES_START_MARK)
    const endIdx = content.indexOf(RULES_END_MARK)
    const before = content.slice(0, startIdx)
    // 앱이 처음 만든 구획만 있던 파일이면, 구획을 만들 때 앱이 덧붙인 줄바꿈도 함께 지운다
    // — 되돌린 결과가 원래의 빈 파일이어야 왕복이 맞는다.
    const after = before === '' && content.slice(endIdx + RULES_END_MARK.length) === '\n'
      ? ''
      : content.slice(endIdx + RULES_END_MARK.length)
    return {
      success: true,
      newContent: before + after,
      message: '규칙을 지웠어요.',
      sectionCreated: false,
      errors: []
    }
  }
  const replaced = replaceOrAppendSection(content, serializeRulesSection(nextRules))
  return { success: true, newContent: replaced.text, message: '규칙을 지웠어요.', sectionCreated: false, errors: [] }
}

