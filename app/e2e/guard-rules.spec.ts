// §11.8-1·4~11·13·17·20 — 규칙 저장·직렬화·구획 모양·제한·글자 표·동시성
import { test, expect } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_MD_MAX_BYTES,
  RULES_END_MARK,
  RULES_MAX_COUNT,
  RULES_START_MARK,
  RULE_MAX_CHARS,
  RULE_MAX_LINES,
  normalizeRuleText,
  parseClaudeMd,
  serializeRulesSection,
  validateRuleText,
  validateSectionShape
} from '../src/main/guard/instructions'
import { addRuleToContent, mergeRules, readRules, removeRuleFromContent, ruleViews } from '../src/main/guard/rules'
import {
  applyRuleChange,
  defaultState,
  getBlob,
  loadState,
  putBlob,
  readClaudeMd,
  saveState,
  type GuardState
} from '../src/main/guard/store'
import { folderHash } from '../src/main/guard/scope'
import { scanRoot } from '../src/main/guard/scan'
import { withGuardLock, resetGuardLocks } from '../src/main/guard/lock'
import { evaluateT0, evaluateT2 } from '../src/main/guard/reconcile'

const made: string[] = []
test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-rules-'))
  made.push(dir)
  return dir
}

const OUTSIDE = '# 내 논문 규칙\n\n표는 각주 위에 둔다.\n'

function blockOf(...rules: string[]): string {
  return serializeRulesSection(rules.map((normalized) => ({ normalized })))
}

test('11.8-1: 원문 그대로 — 앞뒤 공백·빈 줄만 떼고 줄바꿈만 통일한다', () => {
  expect(normalizeRuleText('  표 제목은 위에  ')).toBe('표 제목은 위에')
  expect(normalizeRuleText('\n\n  두 줄\r\n짜리\r\n\n')).toBe('두 줄\n짜리')
  expect(normalizeRuleText('\uFEFFBOM 규칙')).toBe('BOM 규칙')
  // 허용된 변형 두 가지 밖에는 아무것도 바꾸지 않는다.
  const tricky = '가운데  공백   유지, `백틱`과 **별표** 그대로'
  expect(normalizeRuleText(' ' + tricky + '\n')).toBe(tricky)

  const check = validateRuleText('  표 제목은 위에  ')
  expect(check).toEqual({ ok: true, normalized: '표 제목은 위에' })
})

test('11.8-1·10: 정규형(NFC)이 아닌 메시지는 바꾸지 않고 거절한다', () => {
  const decomposed = '한글'.normalize('NFD')
  expect(decomposed).not.toBe(decomposed.normalize('NFC'))
  const check = validateRuleText(decomposed)
  expect(check.ok).toBe(false)
  expect(check.reason).toContain('정규형')
})

test('11.8-10: 글자 표 — 제어·형식·줄구분·비표준 공백·채움 문자·변형 선택·사설 영역', () => {
  const bad = [
    ['\u0000', '제어'],
    ['\u0007', '제어'],
    ['\u200B', '형식'],
    ['\u202E', '형식'],
    ['\u2028', '줄'],
    ['\u2029', '줄'],
    ['\u00A0', '공백'],
    ['\u3000', '공백'],
    ['\u3164', '채움'],
    ['\uFFA0', '채움'],
    ['\uFE0F', '변형'],
    ['\u{E0100}', '변형'],
    ['\uE000', '사용할 수 없는']
  ] as const
  for (const [ch, why] of bad) {
    const check = validateRuleText(`표제${ch}목`)
    expect(check.ok, `U+${(ch.codePointAt(0) ?? 0).toString(16)}는 거절돼야 한다`).toBe(false)
    expect(check.reason).toContain(why)
  }
  // 탭과 보통 줄바꿈은 허용.
  expect(validateRuleText('가\t나').ok).toBe(true)
  expect(validateRuleText('가\n나').ok).toBe(true)
  // 강조·링크·코드 표시는 글자 그대로 저장한다.
  expect(validateRuleText('**굵게** [링크](x) `코드`').ok).toBe(true)
})

test('11.8-10: 구획 표시 글자(<!--, -->)가 든 규칙은 거절한다', () => {
  for (const text of ['<!-- 주석 -->', '앞 <!-- 뒤', '앞 --> 뒤']) {
    const check = validateRuleText(text)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('구획 표시')
  }
})

test('11.8-9: 301자·6줄은 거절하고 300자·5줄은 통과한다', () => {
  expect(validateRuleText('가'.repeat(RULE_MAX_CHARS)).ok).toBe(true)
  const tooLong = validateRuleText('가'.repeat(RULE_MAX_CHARS + 1))
  expect(tooLong.ok).toBe(false)
  expect(tooLong.reason).toContain('300자')

  expect(validateRuleText(Array.from({ length: RULE_MAX_LINES }, () => '줄').join('\n')).ok).toBe(true)
  const tooManyLines = validateRuleText(Array.from({ length: RULE_MAX_LINES + 1 }, () => '줄').join('\n'))
  expect(tooManyLines.ok).toBe(false)
  expect(tooManyLines.reason).toContain('5줄')

  // 코드 포인트로 센다 — 이모지 하나는 1자다(UTF-16 길이 2가 아니다).
  expect(validateRuleText('😀'.repeat(RULE_MAX_CHARS)).ok).toBe(true)
  expect(validateRuleText('😀'.repeat(RULE_MAX_CHARS + 1)).ok).toBe(false)
})

test('11.8-1: 직렬화/파싱 왕복은 코드 포인트까지 같다(속 빈 줄 포함)', () => {
  const rules = [
    { normalized: '한 줄 규칙' },
    { normalized: '첫 줄\n\n셋째 줄' },
    { normalized: '  앞에 두 칸이 있는 규칙' },
    { normalized: '탭\t들어간 규칙' }
  ]
  const block = serializeRulesSection(rules)
  // 속 빈 줄도 두 칸 들여쓰기로 보존된다.
  expect(block.split('\n')).toContain('  ')
  const parsed = parseClaudeMd(`${OUTSIDE}\n${block}\n`)
  expect(parsed.damaged).toBe(false)
  expect(parsed.rules.map((rule) => rule.normalized)).toEqual(rules.map((rule) => rule.normalized))
})

test('11.8-5: 구획 밖 글자는 더하고 지워도 글자까지 같다', () => {
  const content = `${OUTSIDE}\n꼬리 글자도 그대로.\n`
  const added = addRuleToContent(content, '첫 규칙')
  expect(added.success).toBe(true)
  expect(added.sectionCreated).toBe(true)
  expect(added.newContent.startsWith(content)).toBe(true)
  const parsed = parseClaudeMd(added.newContent)
  expect(parsed.outsideBefore).toBe(content)
  expect(parsed.outsideAfter).toBe('')

  const second = addRuleToContent(added.newContent, '둘째 규칙')
  expect(second.success).toBe(true)
  expect(second.sectionCreated).toBe(false)
  expect(parseClaudeMd(second.newContent).outsideBefore).toBe(content)

  const removed = removeRuleFromContent(second.newContent, '첫 규칙')
  expect(removed.success).toBe(true)
  expect(parseClaudeMd(removed.newContent).outsideBefore).toBe(content)
  expect(parseClaudeMd(removed.newContent).rules.map((rule) => rule.normalized)).toEqual(['둘째 규칙'])
})

test('11.8-5: 파일이 없으면(빈 글자) 구획만 생기고, 마지막 항목을 지우면 파일이 빈다', () => {
  const created = addRuleToContent('', '하나뿐인 규칙')
  expect(created.success).toBe(true)
  expect(created.newContent.startsWith(RULES_START_MARK)).toBe(true)
  expect(created.newContent.trimEnd().endsWith(RULES_END_MARK)).toBe(true)

  const removed = removeRuleFromContent(created.newContent, '하나뿐인 규칙')
  expect(removed.success).toBe(true)
  expect(removed.newContent).toBe('')
})

test('11.8-5: 마지막 항목만 지울 때 구획 밖 글자는 남는다', () => {
  const content = `${OUTSIDE}꼬리.\n`
  const added = addRuleToContent(content, '유일한 규칙')
  const removed = removeRuleFromContent(added.newContent, '유일한 규칙')
  expect(removed.success).toBe(true)
  const parsed = parseClaudeMd(removed.newContent)
  expect(parsed.hasRulesSection).toBe(false)
  expect(removed.newContent).toContain('# 내 논문 규칙')
  expect(removed.newContent).toContain('꼬리.')
  expect(removed.newContent.trimEnd()).toBe(content.trimEnd())
})

test('11.8-17: 구획 모양이 깨졌으면 더하기·지우기가 거절되고 파일 글이 그대로다', () => {
  const shape = [RULES_START_MARK, RULES_END_MARK]
  const broken: Record<string, string> = {
    '시작 표시 둘': `${OUTSIDE}\n${shape[0]}\n- a\n${shape[0]}\n${shape[1]}\n`,
    '끝 표시 없음': `${OUTSIDE}\n${shape[0]}\n- a\n`,
    '순서 뒤집힘': `${OUTSIDE}\n${shape[1]}\n- a\n${shape[0]}\n`,
    '목록 아닌 줄': `${OUTSIDE}\n${shape[0]}\n- a\n그냥 글자\n${shape[1]}\n`
  }
  for (const [name, content] of Object.entries(broken)) {
    expect(validateSectionShape(content).valid, name).toBe(false)
    const add = addRuleToContent(content, '새 규칙')
    expect(add.success, name).toBe(false)
    expect(add.newContent, name).toBe('')
    expect(add.message, name).toContain('손상')
    const remove = removeRuleFromContent(content, 'a')
    expect(remove.success, name).toBe(false)
    expect(remove.newContent, name).toBe('')
  }
  // 거절은 파일을 건드리지 않는다 — 호출자가 newContent를 쓰지 않으므로 원본이 곧 결과다.
  expect(broken['목록 아닌 줄']).toContain('그냥 글자')
  expect(parseClaudeMd(broken['목록 아닌 줄']).damaged).toBe(true)
  // 표시가 아예 없으면 "구획 없음"이라 통과한다.
  expect(validateSectionShape(OUTSIDE).valid).toBe(true)
  expect(addRuleToContent(OUTSIDE, '첫 규칙').success).toBe(true)
})

test('11.8-9: 31번째 규칙·같은 글자 중복·결과 32KB 초과는 거절한다', () => {
  let content = ''
  for (let i = 0; i < RULES_MAX_COUNT; i++) {
    const added = addRuleToContent(content, `규칙 ${i}`)
    expect(added.success).toBe(true)
    content = added.newContent
  }
  expect(readRules(content).length).toBe(RULES_MAX_COUNT)

  const thirtyFirst = addRuleToContent(content, '규칙 31')
  expect(thirtyFirst.success).toBe(false)
  expect(thirtyFirst.errors.join(' ')).toContain(`최대 ${RULES_MAX_COUNT}`)

  // 중복은 개수 여유가 있을 때 걸린다(개수 검사가 먼저다).
  const roomy = addRuleToContent(addRuleToContent('', '규칙 7').newContent, '다른 규칙').newContent
  const duplicate = addRuleToContent(roomy, '규칙 7')
  expect(duplicate.success).toBe(false)
  expect(duplicate.errors.join(' ')).toContain('같은 내용')
  // 앞뒤 공백만 다른 것도 같은 규칙이다.
  expect(addRuleToContent(roomy, '  규칙 7  ').success).toBe(false)

  // 결과 파일 상한 — 구획 밖을 크게 채워 32KB를 넘긴다.
  const fat = '# 채움\n' + '가'.repeat(CLAUDE_MD_MAX_BYTES - 100)
  const overflow = addRuleToContent(fat, '규칙 하나')
  expect(overflow.success).toBe(false)
  expect(overflow.errors.join(' ')).toContain('32KB')
  expect(overflow.newContent).toBe('')
})

test('11.8-8: 학생이 구획 안을 직접 고치면 파일이 정본 — 표가 따라간다', () => {
  const added = addRuleToContent(OUTSIDE, '처음 규칙')
  const edited = added.newContent.replace('처음 규칙', '학생이 고친 규칙')

  const previous = [
    { id: 'msg:1', message: '처음 규칙', timestamp: 100, normalized: '처음 규칙' }
  ]
  const merged = mergeRules(edited, previous)
  expect(merged.map((entry) => entry.normalized)).toEqual(['학생이 고친 규칙'])
  expect(merged[0].id).not.toBe('msg:1')

  // 같은 글자가 남아 있으면 id·시각을 이어받는다(기억 표시 유지).
  const carried = mergeRules(added.newContent, previous)
  expect(carried).toEqual(previous)

  // 목록의 "기억함" 표시는 파일 내용을 따른다.
  const views = ruleViews(edited, previous)
  expect(views).toEqual([{ id: 'msg:1', text: '처음 규칙', timestamp: 100, present: false }])
  expect(ruleViews(added.newContent, previous)[0].present).toBe(true)
})

test('11.8-9/20: id는 내용이 같으면 다시 불러도 같다(호출마다 달라지지 않는다)', () => {
  const content = addRuleToContent(addRuleToContent('', '가나다라마바사아자차').newContent, '가나다라마바사아자차 둘째').newContent
  const first = mergeRules(content, [])
  const second = mergeRules(content, [])
  expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id))
  expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length)
})

test('11.8-20: 같은 메시지에 두 번 눌러도 규칙은 하나다', async () => {
  resetGuardLocks()
  const box = await ruleBox()
  const outcome = await pressTwice(box, '같은 메시지 규칙')
  expect(outcome.successes.filter(Boolean).length).toBe(1)
  const rules = readRules(readFileSync(join(box.root, 'CLAUDE.md'), 'utf-8'))
  expect(rules.map((rule) => rule.normalized)).toEqual(['같은 메시지 규칙'])
})

test('11.8-20: 30개째와 31개째를 동시에 눌러도 30개다', async () => {
  resetGuardLocks()
  const box = await ruleBox()
  let content = ''
  for (let i = 0; i < RULES_MAX_COUNT - 1; i++) {
    const added = addRuleToContent(content, `미리 ${i}`)
    content = added.newContent
  }
  writeFileSync(join(box.root, 'CLAUDE.md'), content)
  await syncState(box)

  const results = await Promise.all([
    press(box, '서른째'),
    press(box, '서른한째')
  ])
  expect(results.filter((result) => result.success).length).toBe(1)
  expect(readRules(readFileSync(join(box.root, 'CLAUDE.md'), 'utf-8')).length).toBe(RULES_MAX_COUNT)
})

test('11.8-13: 앱이 쓰는 도중 죽어도 구획·보관본·목록이 서로 같다', () => {
  const added = addRuleToContent(OUTSIDE, '죽기 전 규칙')
  const parsed = parseClaudeMd(added.newContent)
  expect(parsed.damaged).toBe(false)
  expect(parsed.rules.map((rule) => rule.normalized)).toEqual(['죽기 전 규칙'])
  // 같은 글자에서 다시 파싱해도 (구획, 보관본, 목록)이 같다.
  const again = parseClaudeMd(serializeSectionWrapper(parsed))
  expect(again.rules.map((rule) => rule.normalized)).toEqual(['죽기 전 규칙'])
})

test('11.8-6: 질의 중 저장은 T2가 되돌리지 않는다(앱이 쓴 판이 기준)', async () => {
  resetGuardLocks()
  const box = await ruleBox()
  await withGuardLock(box.root, async () => {
    const result = await press(box, '질의 중에 저장한 규칙')
    expect(result.success).toBe(true)
  })
  // 그 질의의 T2를 돌린다 — 방금 앱이 쓴 것과 디스크·보관본이 같으므로 되돌릴 것이 없다.
  const state = loadState(box.userData, box.folder, box.key).state
  expect(state.queryOpen).toBe(true)
  const t2 = evaluateT2({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state,
    scan: scanRoot({ root: box.root, userData: box.userData })
  })
  expect(t2.reverted).toEqual([])
  expect(t2.notes).toEqual([])
  expect(readFileSync(join(box.root, 'CLAUDE.md'), 'utf-8')).toContain('질의 중에 저장한 규칙')

  // 그리고 다음 질의의 T0도 조용하다 — 앱이 쓴 판이 기준이라 학생 변경이 아니다.
  const { integrity: _i, ...saved } = t2.state
  saveState(box.userData, box.folder, saved, box.key)
  const t0 = evaluateT0({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: t2.state,
    scan: scanRoot({ root: box.root, userData: box.userData })
  })
  expect(t0.accepted).toEqual([])
  expect(t0.reverted).toEqual([])
  expect(t0.notes).toEqual([])
})

test('11.8-6: 도우미가 먼저 고쳐 둔 경우에도 저장된 파일·보관본에 도우미 줄이 없다', async () => {
  resetGuardLocks()
  const box = await ruleBox()
  // 도우미가 구획 안팎에 줄을 넣는다.
  const dirty = OUTSIDE + '\n- 도우미가 넣은 규칙\n'
  writeFileSync(join(box.root, 'CLAUDE.md'), dirty)

  const result = await withGuardLock(box.root, async () => press(box, '학생 규칙'))
  expect(result.success).toBe(true)
  const disk = readFileSync(join(box.root, 'CLAUDE.md'), 'utf-8')
  expect(disk).not.toContain('도우미가 넣은 규칙')
  expect(disk).toContain('학생 규칙')

  const state = loadState(box.userData, box.folder, box.key).state
  const injected = state.leaves['CLAUDE.md'].hash
  expect(getBlob(box.userData, box.folder, injected)?.toString('utf-8')).toBe(disk)
})

test('11.8-6: 파일을 못 쓰게 만들면 저장되지 않고 "지금은 저장하지 못했어요"', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  resetGuardLocks()
  const box = await ruleBox()
  chmodSync(box.root, 0o555)
  try {
    const result = await withGuardLock(box.root, async () => press(box, '못 쓰는 규칙'))
    expect(result.success).toBe(false)
    expect(result.message).toContain('저장하지 못했어요')
    expect(readFileSync(join(box.root, 'CLAUDE.md'), 'utf-8')).not.toContain('못 쓰는 규칙')
    // 상태도 바뀌지 않는다(성공 시점은 상태 파일 교체).
    const state = loadState(box.userData, box.folder, box.key).state
    expect(state.rules).toEqual([])
  } finally {
    chmodSync(box.root, 0o755)
  }
})

// ── 도우미 ────────────────────────────────────────────────────────────────

interface RuleBox {
  root: string
  userData: string
  folder: string
  key: Buffer
}

async function ruleBox(): Promise<RuleBox> {
  const base = tmp()
  const root = join(base, 'paper')
  const userData = join(base, 'userdata')
  mkdirSync(root, { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(root, 'CLAUDE.md'), OUTSIDE)
  const folder = folderHash(root)
  const key = Buffer.from('test-key', 'utf-8')
  const box = { root, userData, folder, key }
  await syncState(box)
  return box
}

/** T0를 돌려 보관본을 폴더와 맞춘다(service.ts의 첫 전송과 같은 상태). */
async function syncState(box: RuleBox): Promise<void> {
  const { integrity: _i, ...without } = {
    ...defaultState(),
    leaves: {},
    injected: null
  }
  saveState(box.userData, box.folder, without, box.key)
  const t0 = evaluateT0({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    state: loadState(box.userData, box.folder, box.key).state,
    scan: scanRoot({ root: box.root, userData: box.userData })
  })
  const { integrity: _j, ...save } = t0.state
  saveState(box.userData, box.folder, save, box.key)
}

/** 단추 한 번 — 잠금 안에서 장부·상태를 읽고 앱 쓰기 순서를 돈다. */
async function press(box: RuleBox, text: string): Promise<{ success: boolean; message: string }> {
  const state = loadState(box.userData, box.folder, box.key).state
  const outcome = applyRuleChange({
    rootReal: box.root,
    userData: box.userData,
    folderHash: box.folder,
    key: box.key,
    state,
    action: 'add',
    mutate: (baseline) => addRuleToContent(baseline, text, { messageId: `msg:${text}`, timestamp: 1 })
  })
  if (outcome.success) {
    const { integrity: _i, ...save } = outcome.state
    saveState(box.userData, box.folder, save, box.key)
  }
  return { success: outcome.success, message: outcome.message }
}

async function pressTwice(box: RuleBox, text: string): Promise<{ successes: boolean[] }> {
  const results = await Promise.all([
    withGuardLock(box.root, async () => press(box, text)),
    withGuardLock(box.root, async () => press(box, text))
  ])
  return { successes: results.map((result) => result.success) }
}

function serializeSectionWrapper(parsed: ReturnType<typeof parseClaudeMd>): string {
  return [parsed.outsideBefore, serializeRulesSection(parsed.rules), parsed.outsideAfter].join('\n')
}

test('지우기: 해당 항목만 지우고 같은 글자가 여러 번이면 첫 하나만', () => {
  const two = addRuleToContent(addRuleToContent('', 'A 규칙').newContent, 'B 규칙').newContent
  const removed = removeRuleFromContent(two, 'A 규칙')
  expect(parseClaudeMd(removed.newContent).rules.map((rule) => rule.normalized)).toEqual(['B 규칙'])
  // 없는 규칙을 지우면 거절.
  const missing = removeRuleFromContent(two, 'C 규칙')
  expect(missing.success).toBe(false)
  expect(missing.errors.join(' ')).toContain('찾을 수 없어요')
})

test('구획이 없는데 지우기를 부르면 거절한다', () => {
  const removed = removeRuleFromContent(OUTSIDE, '아무 규칙')
  expect(removed.success).toBe(false)
  expect(removed.errors.join(' ')).toContain('구획이 없어요')
})

test('빈 규칙·공백뿐인 규칙은 거절한다', () => {
  expect(addRuleToContent('', '').success).toBe(false)
  expect(addRuleToContent('', '   \n  ').success).toBe(false)
})

test('손상된 구획에서는 mergeRules가 빈 표를 돌려준다(파일 정본 보호)', () => {
  const damaged = `${OUTSIDE}\n${RULES_START_MARK}\n- a\n`
  expect(parseClaudeMd(damaged).damaged).toBe(true)
  expect(mergeRules(damaged, [{ id: 'x', message: 'a', timestamp: 1, normalized: 'a' }])).toEqual([])
  expect(ruleViews(damaged, [{ id: 'x', message: 'a', timestamp: 1, normalized: 'a' }])).toEqual([])
})

test('보관본 blob 상한·규칙 표가 상태 파일에 남는다', () => {
  const box = tmp()
  const hash = putBlob(box, 'x', '내용')
  const state: GuardState = { ...defaultState(), rules: [{ id: 'r1', message: 'm', timestamp: 2, normalized: 'm' }] }
  const { integrity: _i, ...without } = state
  saveState(box, 'f', without, Buffer.from('k'))
  expect(loadState(box, 'f', Buffer.from('k')).state.rules).toEqual(state.rules)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(readClaudeMd(box).state).toBe('missing')
})
