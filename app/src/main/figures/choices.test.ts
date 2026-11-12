import type * as choicesTypes from './choices'
/**
 * figures/choices.test.ts — 2장 이상일 때 학생 선택을 좁게 인정한다 (설계 R4-7, r5 I-02).
 *
 * 왜 "정확히 A·B·C"인가: "B가 좋겠어요"·"AB"·"아무거나"를 해석하려 들면 잘못된 그림이 논문에
 * 들어간다. 애매하면 거절하고 다시 묻는 쪽이 싸다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})

const choices = (await import(new URL('./choices.ts', import.meta.url).href)) as typeof import('./choices')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-choices-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

const candidates: choicesTypes.ChoiceCandidate[] = [
  { label: 'A', sha256: 'a'.repeat(64), desc: '들깨 잎 근접 사진' },
  { label: 'B', sha256: 'b'.repeat(64), desc: '들깨밭 전경' }
]

const sheet = (over: Partial<choicesTypes.ChoiceSheet> = {}): choicesTypes.ChoiceSheet => ({
  v: 1,
  reqId: 'req-abcdef12',
  slot: '3.2',
  question: choices.choiceQuestion(candidates),
  candidates,
  studentMessage: null,
  ...over
})

describe('choiceQuestion', () => {
  it('후보를 A/B/C로 늘어놓고 이름만 적으라고 한다', () => {
    const question = choices.choiceQuestion(candidates)
    assert.match(question, /A\. 들깨 잎 근접 사진/)
    assert.match(question, /B\. 들깨밭 전경/)
    assert.match(question, /A·B·C 중 하나만 적어 주세요/)
  })
})

describe('후보표 쓰기·읽기', () => {
  it('쓰고 그대로 읽는다', async () => {
    const path = choices.choicePath(join(root, 'choices'), 'abc123', '3.2')
    await choices.writeChoiceSheet(path, sheet())
    const read = await choices.readChoiceSheet(path)
    assert.equal(read?.slot, '3.2')
    assert.equal(read?.candidates.length, 2)
    assert.equal(read?.studentMessage, null)
  })

  it('판이 다르거나 모양이 깨진 표는 null', async () => {
    const dir = join(root, 'choices')
    const path = choices.choicePath(dir, 'abc123', 'broken')
    await choices.writeChoiceSheet(path, { ...sheet(), v: 2 } as unknown as choicesTypes.ChoiceSheet)
    assert.equal(await choices.readChoiceSheet(path), null)
    assert.equal(await choices.readChoiceSheet(join(dir, 'abc123', 'nope.json')), null)
  })
})

describe('recordStudentMessage', () => {
  it('빈 표 전부에 원문을 적는다', async () => {
    const dir = join(root, 'record')
    await choices.writeChoiceSheet(choices.choicePath(dir, 'h1', '1.1'), sheet({ slot: '1.1' }))
    await choices.writeChoiceSheet(choices.choicePath(dir, 'h1', '2.1'), sheet({ slot: '2.1' }))
    const updated = await choices.recordStudentMessage(dir, 'h1', ['1.1', '2.1'], '  A ', 42)
    assert.equal(updated, 2)
    const read = await choices.readChoiceSheet(choices.choicePath(dir, 'h1', '2.1'))
    assert.deepEqual(read?.studentMessage, { text: '  A ', at: 42 })
  })

  it('정확한 답이 적힌 표는 동결 — 뒤에 온 다른 말이 답을 덮지 않는다', async () => {
    const dir = join(root, 'record2')
    const path = choices.choicePath(dir, 'h2', '1.1')
    await choices.writeChoiceSheet(path, sheet({ studentMessage: { text: 'B', at: 1 } }))
    assert.equal(await choices.recordStudentMessage(dir, 'h2', ['1.1'], 'A', 2), 0)
    assert.equal((await choices.readChoiceSheet(path))?.studentMessage?.text, 'B')
    assert.equal((await choices.readChoiceSheet(path))?.studentMessage?.at, 1)
  })

  it('정확한 답이 적힌 표는 선택이 아닌 말이 와도 그대로다(I-2)', async () => {
    const dir = join(root, 'record-freeze')
    const path = choices.choicePath(dir, 'h7', '1.1')
    await choices.writeChoiceSheet(path, sheet())
    assert.equal(await choices.recordStudentMessage(dir, 'h7', ['1.1'], 'A', 1), 1)
    // "고마워"는 선택이 아니다 — 저장된 A를 덮으면 `place --choose A`가 not_exact로 죽는다.
    assert.equal(await choices.recordStudentMessage(dir, 'h7', ['1.1'], '고마워', 2), 0)
    assert.deepEqual((await choices.readChoiceSheet(path))?.studentMessage, { text: 'A', at: 1 })
  })

  it('정확한 답 뒤 다른 정확한 답도 덮지 않는다(B 다음 C → B)', async () => {
    const dir = join(root, 'record-freeze2')
    const path = choices.choicePath(dir, 'h8', '1.1')
    await choices.writeChoiceSheet(path, sheet())
    assert.equal(await choices.recordStudentMessage(dir, 'h8', ['1.1'], 'B', 1), 1)
    assert.equal(await choices.recordStudentMessage(dir, 'h8', ['1.1'], 'C', 2), 0)
    assert.deepEqual((await choices.readChoiceSheet(path))?.studentMessage, { text: 'B', at: 1 })
  })

  it('선택이 아닌 말이 먼저 와도 다음 정확한 답으로 갈아 끼운다', async () => {
    const dir = join(root, 'record4')
    const path = choices.choicePath(dir, 'h4', '1.1')
    await choices.writeChoiceSheet(path, sheet())
    assert.equal(await choices.recordStudentMessage(dir, 'h4', ['1.1'], 'B가 좋겠어요', 10), 1)
    assert.equal((await choices.readChoiceSheet(path))?.studentMessage?.text, 'B가 좋겠어요')
    assert.equal(await choices.recordStudentMessage(dir, 'h4', ['1.1'], 'B', 11), 1)
    const read = await choices.readChoiceSheet(path)
    assert.deepEqual(read?.studentMessage, { text: 'B', at: 11 })
    // 그래야 `place --choose B`가 산다 — 예전에는 첫 메시지가 박혀 not_exact로 죽었다.
    assert.equal(choices.checkChoice(read, 'B').ok, true)
  })

  it('정확하지 않은 같은 말이 또 오면 다시 쓰지 않는다', async () => {
    const dir = join(root, 'record5')
    const path = choices.choicePath(dir, 'h5', '1.1')
    await choices.writeChoiceSheet(path, sheet())
    assert.equal(await choices.recordStudentMessage(dir, 'h5', ['1.1'], '잠깐만', 10), 1)
    assert.equal(await choices.recordStudentMessage(dir, 'h5', ['1.1'], '잠깐만', 20), 0)
    assert.equal((await choices.readChoiceSheet(path))?.studentMessage?.at, 10)
  })

  it('정확하지 않은 새 말은 최신 원문으로 바꾼다', async () => {
    const dir = join(root, 'record6')
    const path = choices.choicePath(dir, 'h6', '1.1')
    await choices.writeChoiceSheet(path, sheet())
    await choices.recordStudentMessage(dir, 'h6', ['1.1'], '잠깐만', 10)
    assert.equal(await choices.recordStudentMessage(dir, 'h6', ['1.1'], '조금 이따', 20), 1)
    assert.deepEqual((await choices.readChoiceSheet(path))?.studentMessage, { text: '조금 이따', at: 20 })
  })

  it('다른 폴더의 표는 건드리지 않는다', async () => {
    const dir = join(root, 'record3')
    await choices.writeChoiceSheet(choices.choicePath(dir, 'other', '1.1'), sheet())
    assert.equal(await choices.recordStudentMessage(dir, 'mine', ['1.1'], 'A', 3), 0)
  })
})

describe('checkChoice', () => {
  const answered = (text: string): choicesTypes.ChoiceSheet => sheet({ studentMessage: { text, at: 1 } })

  it('정확히 A·B면 통과하고 그 후보를 돌려준다', () => {
    const result = choices.checkChoice(answered('B'), 'B')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.candidate.sha256, 'b'.repeat(64))
  })

  it('앞뒤 공백은 봐준다(복사·붙여넣기 흔적)', () => {
    assert.equal(choices.checkChoice(answered(' A\n'), 'A').ok, true)
  })

  it('문장·두 글자·빈 답은 거절', () => {
    assert.deepEqual(choices.checkChoice(answered('B가 좋겠어요'), 'B'), { ok: false, reason: 'not_exact' })
    assert.deepEqual(choices.checkChoice(answered('AB'), 'A'), { ok: false, reason: 'not_exact' })
    assert.deepEqual(choices.checkChoice(answered(''), 'A'), { ok: false, reason: 'not_exact' })
  })

  it('학생 메시지가 없으면 no_student_message', () => {
    assert.deepEqual(choices.checkChoice(sheet(), 'A'), { ok: false, reason: 'no_student_message' })
  })

  it('표가 없으면 no_sheet', () => {
    assert.deepEqual(choices.checkChoice(null, 'A'), { ok: false, reason: 'no_sheet' })
  })

  it('학생이 고른 이름이 후보에 없으면 unknown_label', () => {
    const two = sheet({ candidates: candidates.slice(0, 1), studentMessage: { text: 'C', at: 1 } })
    assert.deepEqual(choices.checkChoice(two, 'C'), { ok: false, reason: 'unknown_label' })
  })

  it('호출자가 다른 이름을 넘기면 not_exact', () => {
    assert.deepEqual(choices.checkChoice(answered('A'), 'B'), { ok: false, reason: 'not_exact' })
  })
})
