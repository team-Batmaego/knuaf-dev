/**
 * 승인 카드가 떠 있는 동안 현재 턴을 멈출 수 있다 (M3-01, v0.7.5).
 *
 * 맥 실기에서 도구 승인 카드가 입력칸을 대신하는 동안 ■ 중단 단추가 없고 Esc도 무반응이라, 학생이 그 턴을
 * 멈출 길이 없었다. 카드의 '거절'은 그 도구 요청 하나에 대한 답(`chat:respond`)이지 턴 중단이 아니다.
 * 이 시험은 카드가 떠 있는 채로 **기존 `chat:stop` 경로**(카드 안 중단 단추·Esc)로 턴을 멈추는 전 구간을 본다:
 *   ① 카드·대기가 해제되고 앱 상태가 작업 중·승인 대기가 아니다
 *   ② 승인 대기 중이던 **바로 그 턴**(threadId·turnId)에 인터럽트가 갔고, 서버가 그 턴을 취소로 닫았다
 *   ③ 승인 요청이 만들려던 파일이 중단 전·후·다음 턴 뒤에도 없다 — 허용은 한 번도 적용되지 않았고,
 *      중단 뒤 늦게 오는 허용 응답도 무시된다
 *   ④ 같은 대화(대화 기록·세션)에서 다음 글 턴이 **새 turn/start** 로 시작해 정상 종료까지 가고 입력칸이 다시 열린다
 * 양성 대조(`허용하면 파일이 만들어진다`)가 같은 장치에서 허용 → 파일 생성을 보여 ③ 의 '없음'이 빈 관찰이 아님을 잠근다.
 *
 * 숨김 실행(`launch()` 기본). 실제 로그인·AI 호출 없음 — 가짜 `codex app-server` 만 쓴다.
 * 한계: 가짜 서버가 흉내 내는 것은 "허용된 요청에 한해 지정 파일을 만든다"는 승인의 효과뿐이다. 진짜 Claude/Codex
 * 엔진이 명령을 실행하지 않는다는 것은 이 시험이 아니라 설치본 실기(A5/V1 ④)가 닫는다.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, userDataWith } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`
const FIRST_TEXT = '파일을 하나 만들어 줘'
const SECOND_TEXT = '다시 물어볼게요'
const AFTER_REPLY = '중단 뒤 다음 글에 정상으로 답했어요'

interface FakeEvent { event: string; [key: string]: unknown }
interface Snap { state: string; sessionId?: string; permission?: { id: string }; messages: { id: string; role: string; text: string }[] }

interface Scene {
  electronApp: ElectronApplication; page: Page; root: string
  /** 승인 요청이 만들려던 파일 — 허용이 살아 있는 턴에서 올 때만 가짜 서버가 만든다. */
  target: string
  events: () => FakeEvent[]
  snapshot: () => Promise<Snap>
  ask: FakeEvent
  first: Snap
}

/** 승인 카드가 뜬 채로 기다리는 장면 — 첫 턴만 묻고, 다음 턴은 정상으로 답하는 가짜 서버. */
async function openApproval(): Promise<Scene> {
  const dir = scratch()
  const log = join(dir, 'events.jsonl')
  const target = join(dir, 'approved-output.txt')
  const root = synthProject()
  const env = fakeCodexEnv(join(dir, 'bin'), {
    FAKE_CODEX_MODE: 'logged-in',
    FAKE_CODEX_ASK: '1',
    FAKE_CODEX_ASK_ONCE_FILE: join(dir, 'asked'),
    FAKE_CODEX_ASK_COMMAND: `touch ${target}`,
    FAKE_CODEX_ASK_WRITE_FILE: target,
    FAKE_CODEX_CANCEL_ON_INTERRUPT: '1',
    FAKE_CODEX_EVENT_LOG: log,
    FAKE_CODEX_TURN_ID_MODE: 'unique',
    FAKE_CODEX_TURN_SEQ_FILE: join(dir, 'turn-seq'),
    FAKE_CODEX_REPLY: replyFile(dir, AFTER_REPLY)
  })
  const { electronApp, page } = await launch({ env, userData: userDataWith(dir, { permission_mode: 'ask' }) })
  const events = (): FakeEvent[] => existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeEvent) : []
  const snapshot = async (): Promise<Snap> => {
    const r = await page.evaluate((r) => window.knuaf.chat.snapshot(r, 'codex'), root) as { result: Snap }
    return r.result
  }
  await openProject(page, root)
  const ta = page.locator(COMPOSER)
  await expect(ta).toBeVisible({ timeout: 30_000 })
  await ta.fill(FIRST_TEXT)
  await page.getByRole('button', { name: CHAT.send, exact: true }).click()
  await expect(page.locator('.askcard')).toBeVisible({ timeout: 30_000 })
  // 카드가 입력칸을 대신한다 — 지금 학생에게 ■ 는 없다(고치기 전 상태 그대로).
  await expect(ta).toHaveCount(0)
  const ask = events().find((e) => e.event === 'ask')
  expect(ask, '가짜 서버가 승인 요청을 보내지 않았다').toBeTruthy()
  const first = await snapshot()
  // 지금 화면의 카드가 그 요청이다 — 카드 id = 서버가 보낸 요청 id.
  expect(first.state).toBe('permission')
  expect(first.permission?.id).toBe(String(ask!.requestId))
  expect(existsSync(target), '승인 전에 파일이 이미 있다').toBe(false)
  return { electronApp, page, root, target, events, snapshot, ask: ask!, first }
}

/** 멈춘 뒤의 공통 확인 ①~④. */
async function expectStoppedCleanly(scene: Scene): Promise<void> {
  const { page, root, target, events, snapshot, ask, first } = scene
  const ta = page.locator(COMPOSER)
  // ① 카드·대기 해제 — 입력칸이 돌아오고, 앱 상태도 작업 중·승인 대기가 아니다.
  await expect(page.locator('.askcard')).toHaveCount(0, { timeout: 15_000 })
  await expect(ta).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.zone-status')).toHaveCount(0)
  await expect.poll(async () => (await snapshot()).state, { timeout: 15_000 }).not.toMatch(/^(running|permission)$/)
  const stopped = await snapshot()
  expect(stopped.permission, '중단했는데 승인 요청이 남아 있다').toBeUndefined()
  // ② 승인 대기 중이던 그 턴(threadId·turnId)에 인터럽트가 갔고, 서버가 그 턴을 취소로 닫았다.
  await expect.poll(() => events().filter((e) => e.event === 'interrupt').length, { timeout: 15_000 }).toBeGreaterThan(0)
  const interrupts = events().filter((e) => e.event === 'interrupt')
  expect(interrupts.every((e) => e.matched === true), '승인 대기 턴이 아닌 곳으로 인터럽트가 갔다').toBe(true)
  expect(interrupts.map((e) => [e.threadId, e.turnId])).toContainEqual([ask.threadId, ask.turnId])
  expect(events().filter((e) => e.event === 'turn-cancelled').map((e) => [e.threadId, e.turnId]))
    .toEqual([[ask.threadId, ask.turnId]])
  // ③ 미승인 파일 — 중단 직후에도, 늦게 온 허용 응답을 흘려보낸 뒤에도 없다.
  expect(existsSync(target), '중단했는데 승인 안 된 파일이 생겼다').toBe(false)
  await page.evaluate(([r, id]) => window.knuaf.chat.respond(r, 'codex', id, true), [root, String(ask.requestId)])
  await page.waitForTimeout(500)
  expect(existsSync(target), '중단 뒤 늦게 온 허용이 먹혀 파일이 생겼다').toBe(false)
  expect(events().filter((e) => e.event === 'decision' && e.applied === true), '허용이 적용됐다').toEqual([])
  expect((await snapshot()).permission, '늦은 허용 뒤 승인 요청이 다시 떴다').toBeUndefined()
  // ④ 같은 대화의 다음 글 턴 — 새 turn/start 로 시작해 정상 종료, 입력칸이 다시 열린다.
  await ta.fill(SECOND_TEXT)
  await page.getByRole('button', { name: CHAT.send, exact: true }).click()
  await expect(page.locator('.chat-pane')).toContainText(AFTER_REPLY, { timeout: 30_000 })
  await expect.poll(() => events().filter((e) => e.event === 'turn-completed').length, { timeout: 30_000 }).toBe(1)
  const starts = events().filter((e) => e.event === 'turn-start')
  // 앱은 중단 뒤 엔진 프로세스를 새로 띄우므로 서버 안의 셈(n)은 이어지지 않는다 — turn/start 가 정확히 두 번이고 턴 id 가 서로 다른지로 본다.
  expect(starts).toHaveLength(2)
  const [firstStart, secondStart] = starts
  expect(secondStart.turnId, '다음 글이 새 턴이 아니다').not.toBe(firstStart.turnId)
  expect(firstStart.turnId).toBe(ask.turnId)
  expect(events().filter((e) => e.event === 'turn-completed').map((e) => e.turnId)).toEqual([secondStart.turnId])
  await expect(page.locator('.askcard')).toHaveCount(0)
  await expect(page.locator('.zone-status')).toHaveCount(0)
  await expect(ta).toBeEnabled()
  await expect(page.getByRole('button', { name: CHAT.send, exact: true })).toBeVisible()
  await expect.poll(async () => (await snapshot()).state, { timeout: 15_000 }).toBe('idle')
  // 같은 논리적 대화 — 세션이 이어지고 첫 글이 그대로 있으며 둘째 글·답이 그 뒤에 쌓였다.
  const last = await snapshot()
  if (first.sessionId) expect(last.sessionId).toBe(first.sessionId)
  const texts = last.messages.map((m) => m.text)
  expect(last.messages.slice(0, first.messages.length).map((m) => m.id)).toEqual(first.messages.map((m) => m.id))
  expect(texts.findIndex((t) => t.includes(FIRST_TEXT))).toBeGreaterThanOrEqual(0)
  expect(texts.findIndex((t) => t.includes(SECOND_TEXT))).toBeGreaterThan(texts.findIndex((t) => t.includes(FIRST_TEXT)))
  expect(texts.findIndex((t) => t.includes(AFTER_REPLY))).toBeGreaterThan(texts.findIndex((t) => t.includes(SECOND_TEXT)))
  expect(existsSync(target), '다음 턴 뒤에 승인 안 된 파일이 생겼다').toBe(false)
  expect(events().filter((e) => e.event === 'decision' && e.applied === true)).toEqual([])
}

test('승인 카드 안의 중단 단추가 현재 턴을 멈춘다 (M3-01)', async () => {
  const scene = await openApproval()
  try {
    // 카드 안(또는 옆)에 기존 ■ 와 같은 말의 단추가 있다 — 새 말을 만들지 않는다.
    const stop = scene.page.locator('.askcard').getByRole('button', { name: CHAT.stop, exact: true })
    await expect(stop).toBeVisible()
    await stop.click()
    await expectStoppedCleanly(scene)
  } finally {
    await scene.electronApp.close()
  }
})

test('승인 카드가 떠 있을 때 Esc 도 같은 중단이다 (M3-01)', async () => {
  const scene = await openApproval()
  try {
    await scene.page.keyboard.press('Escape')
    await expectStoppedCleanly(scene)
  } finally {
    await scene.electronApp.close()
  }
})

test('양성 대조: 같은 장치에서 허용하면 지정 파일이 만들어진다 (M3-01)', async () => {
  const scene = await openApproval()
  try {
    await scene.page.locator('.askcard').getByRole('button', { name: CHAT.allow, exact: true }).click()
    await expect.poll(() => existsSync(scene.target), { timeout: 15_000 }).toBe(true)
    const decisions = scene.events().filter((e) => e.event === 'decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ requestId: scene.ask.requestId, applied: true })
    // 허용은 턴 취소가 아니다 — 인터럽트도 취소도 없다.
    expect(scene.events().filter((e) => e.event === 'interrupt' || e.event === 'turn-cancelled')).toEqual([])
  } finally {
    await scene.electronApp.close()
  }
})
