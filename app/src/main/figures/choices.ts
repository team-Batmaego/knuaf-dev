/**
 * figures/choices.ts — 학생 선택을 **앱 기록**에 묶는다 (설계 R4-7, r5 I-02)
 *
 * 승인 그림이 2장 이상이면 앱이 원고를 안 바꾸고 후보표(`choices/<folderHash>/<slot>.json`)를 쓴다.
 * 도우미는 채팅 글로 학생에게 묻고, 앱은 그 폴더의 **다음 학생 메시지 원문**을 후보표에 붙인다.
 *
 * 선택 인정 조건은 좁다: 학생 메시지의 앞뒤 공백을 뺀 값이 **정확히** `A`·`B`·`C` 중 하나이고, 그
 * 이름의 후보가 있어야 한다. "B가 좋겠어요"도, "AB"도 선택이 아니다 — 애매한 해석이 곧 잘못된
 * 그림 삽입이기 때문이다. 학생 메시지가 없으면(도우미가 혼자 고름) 거절.
 *
 * 다만 **어느 메시지를 답으로 볼지**는 좁히지 않는다. 선택이 아닌 말이 먼저 왔다고 해서 그 표를
 * 포기하지 않고, 다음 메시지로 갈아 끼운다(`recordStudentMessage` · I-2).
 */

import { join } from 'node:path'
import { readJson, writeJson } from './storage'

export interface ChoiceCandidate {
  label: 'A' | 'B' | 'C'
  sha256: string
  desc: string
}

export interface StudentMessage {
  text: string
  at: number
}

export interface ChoiceSheet {
  v: 1
  reqId: string
  slot: string
  question: string
  candidates: ChoiceCandidate[]
  studentMessage: StudentMessage | null
}

export const CHOICE_LABELS = ['A', 'B', 'C'] as const
export const CHOICE_QUESTION_SUFFIX = 'A·B·C 중 하나만 적어 주세요'

/** `needs_choice` 때 도우미에게 줄 질문 원문. 후보 설명을 줄바꿈으로 잇는다. */
export function choiceQuestion(candidates: readonly ChoiceCandidate[]): string {
  const lines = candidates.map((candidate) => `${candidate.label}. ${candidate.desc}`)
  return `그림 후보가 여러 장입니다.\n${lines.join('\n')}\n넣을 그림의 이름(${CHOICE_QUESTION_SUFFIX}).`
}

export function choicePath(choicesDir: string, hash: string, slot: string): string {
  return join(choicesDir, hash, `${slot}.json`)
}

export async function writeChoiceSheet(path: string, sheet: ChoiceSheet): Promise<void> {
  await writeJson(path, sheet)
}

export async function readChoiceSheet(path: string): Promise<ChoiceSheet | null> {
  const value = await readJson<ChoiceSheet>(path)
  if (!value || value.v !== 1 || typeof value.slot !== 'string' || !Array.isArray(value.candidates)) return null
  return value
}

/**
 * 그 폴더의 다음 학생 메시지를 후보표 전부에 적는다. 반환값은 갱신한 파일 수.
 * `(folderHash, slot)` 목록은 호출자가 준다 — 저장소를 훑어 파일 이름을 해석하지 않는다(슬롯 이름은
 * 이미 계약 정규식으로 좁혀 뒀다).
 *
 * **정확한 선택이 적힌 표는 건드리지 않고, 아니면 덮어쓴다**(I-2). 도우미가 "후보가 여러 장입니다"를
 * 띄운 직후 학생이 "잠깐만"이라고 썼다고 하자. 예전에는 그 첫 메시지가 영원히 박혀 `place --choose A`가
 * `not_exact`로 죽었다 — 다시 고를 기회가 없었다. 선택이 아닌 말은 선택이 아니므로 최신 원문으로
 * 갈아 끼우고, 정확히 A·B·C인 답이 한 번 적히면 그때 동결한다.
 */
export async function recordStudentMessage(
  choicesDir: string,
  hash: string,
  slots: readonly string[],
  text: string,
  now = Date.now()
): Promise<number> {
  const exact = isExactChoice(text)
  let updated = 0
  for (const slot of slots) {
    const path = choicePath(choicesDir, hash, slot)
    const sheet = await readChoiceSheet(path)
    if (!sheet) continue
    // 동결은 **저장된 답**이 정확한 A·B·C일 때 건다 — 새 메시지가 선택이 아니어도(예: "고마워") 덮지 않는다.
    // 새 메시지 쪽만 보면 "A" 뒤 "고마워"가 A를 지워 `place --choose A`가 not_exact로 죽는다(I-2).
    if (sheet.studentMessage && isExactChoice(sheet.studentMessage.text)) continue
    if (!exact && sheet.studentMessage?.text === text) continue
    await writeChoiceSheet(path, { ...sheet, studentMessage: { text, at: now } })
    updated += 1
  }
  return updated
}

/** 메시지가 후보 이름 하나와 **정확히** 같은가(앞뒤 공백만 허용). */
export function isExactChoice(text: string): boolean {
  const answer = text.trim()
  return CHOICE_LABELS.some((label) => label === answer)
}

export type ChoiceCheck =
  | { ok: true; candidate: ChoiceCandidate }
  | { ok: false; reason: 'no_sheet' | 'no_student_message' | 'not_exact' | 'unknown_label' }

/**
 * `place --choose X` 검사. 학생 메시지 원문이 정확히 그 이름 하나일 때만 통과한다.
 * 후보표의 sha256은 그때 저장된 그림을 가리키므로, 호출자는 이 값을 store 파일과 대조해야 한다.
 */
export function checkChoice(sheet: ChoiceSheet | null, choice: string): ChoiceCheck {
  if (!sheet) return { ok: false, reason: 'no_sheet' }
  if (!sheet.studentMessage) return { ok: false, reason: 'no_student_message' }
  const answer = sheet.studentMessage.text.trim()
  if (answer !== choice.trim()) return { ok: false, reason: 'not_exact' }
  const candidate = sheet.candidates.find((item) => item.label === answer)
  if (!candidate) return { ok: false, reason: 'unknown_label' }
  return { ok: true, candidate }
}
