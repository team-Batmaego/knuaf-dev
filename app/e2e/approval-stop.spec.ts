/**
 * 승인 카드가 떠 있는 동안 현재 턴을 멈출 수 있다 (M3-01, v0.7.5).
 *
 * 맥 실기에서 도구 승인 카드가 입력칸을 대신하는 동안 ■ 중단 단추가 없고 Esc도 무반응이라, 학생이 그 턴을
 * 멈출 길이 없었다. 카드의 '거절'은 그 도구 요청 하나에 대한 답(`chat:respond`)이지 턴 중단이 아니다.
 * 이 시험은 카드가 떠 있는 채로 **기존 `chat:stop` 경로**(카드 안 중단 단추·Esc)로 턴을 멈추는 전 구간을 본다:
 *   ① 카드·대기가 해제된다  ② 엔진에 턴 취소(`turn/interrupt`)가 갔다  ③ 허용이 한 번도 나가지 않았다(미승인 실행 없음)
 *   ④ 같은 대화의 다음 글 턴이 정상으로 돈다.
 *
 * 숨김 실행(`launch()` 기본). 실제 로그인·AI 호출 없음 — 가짜 `codex app-server` 만 쓴다.
 * 가짜 서버는 명령을 실제로 실행하지 않으므로 '미승인 파일 미생성'은 "허용 결정이 서버에 한 번도 가지 않았다"로 본다.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, userDataWith } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const AFTER_REPLY = '중단 뒤 다음 글에 정상으로 답했어요'

const lines = (file: string): string[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []

/** 승인 카드가 뜬 채로 기다리는 장면 — 첫 턴만 묻고, 다음 턴은 정상으로 답하는 가짜 서버. */
async function openApproval(): Promise<{
  electronApp: ElectronApplication; page: Page; interrupts: string; decisions: string; root: string
}> {
  const dir = scratch()
  const interrupts = join(dir, 'interrupts.jsonl')
  const decisions = join(dir, 'decisions.jsonl')
  const root = synthProject()
  const env = fakeCodexEnv(join(dir, 'bin'), {
    FAKE_CODEX_MODE: 'logged-in',
    FAKE_CODEX_ASK: '1',
    FAKE_CODEX_ASK_ONCE_FILE: join(dir, 'asked'),
    FAKE_CODEX_INTERRUPT_LOG: interrupts,
    FAKE_CODEX_DECISION_LOG: decisions,
    FAKE_CODEX_REPLY: replyFile(dir, AFTER_REPLY)
  })
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
  await openProject(page, root)
  const ta = page.locator(COMPOSER)
  await expect(ta).toBeVisible({ timeout: 30_000 })
  await ta.fill('파일을 하나 만들어 줘')
  await page.getByRole('button', { name: CHAT.send, exact: true }).click()
  await expect(page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
  // 카드가 입력칸을 대신한다 — 지금 학생에게 ■ 는 없다(고치기 전 상태 그대로).
  await expect(ta).toHaveCount(0)
  return { electronApp, page, interrupts, decisions, root }
}

/** 멈춘 뒤의 공통 확인 ①~④. */
async function expectStoppedCleanly(page: Page, interrupts: string, decisions: string): Promise<void> {
  const ta = page.locator(COMPOSER)
  // ① 카드·대기 해제 — 입력칸이 돌아오고 작업 중 표시는 없다.
  await expect(page.locator('.askcard')).toHaveCount(0, { timeout: 15_000 })
  await expect(ta).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.zone-status')).toHaveCount(0)
  // ② 현재 턴 취소 — 가짜 서버가 `turn/interrupt` 를 받았다.
  await expect.poll(() => lines(interrupts).length, { timeout: 15_000 }).toBeGreaterThan(0)
  // ③ 허용 결정이 한 번도 나가지 않았다 — 미승인 명령은 실행되지 않는다.
  expect(lines(decisions).filter((l) => l.includes('"accept"')), '중단했는데 허용이 나갔다').toEqual([])
  // ④ 같은 대화의 다음 글 턴이 정상 — 또 묻지 않고(첫 턴만 묻는 서버) 답이 온다.
  await ta.fill('다시 물어볼게요')
  await page.getByRole('button', { name: CHAT.send, exact: true }).click()
  await expect(page.locator('.chat-pane')).toContainText(AFTER_REPLY, { timeout: 30_000 })
  await expect(page.locator('.askcard')).toHaveCount(0)
}

test('승인 카드 안의 중단 단추가 현재 턴을 멈춘다 (M3-01)', async () => {
  const { electronApp, page, interrupts, decisions } = await openApproval()
  try {
    // 카드 안(또는 옆)에 기존 ■ 와 같은 말의 단추가 있다 — 새 말을 만들지 않는다.
    const stop = page.locator('.askcard').getByRole('button', { name: CHAT.stop, exact: true })
    await expect(stop).toBeVisible()
    await stop.click()
    await expectStoppedCleanly(page, interrupts, decisions)
  } finally {
    await electronApp.close()
  }
})

test('승인 카드가 떠 있을 때 Esc 도 같은 중단이다 (M3-01)', async () => {
  const { electronApp, page, interrupts, decisions } = await openApproval()
  try {
    await page.keyboard.press('Escape')
    await expectStoppedCleanly(page, interrupts, decisions)
  } finally {
    await electronApp.close()
  }
})
