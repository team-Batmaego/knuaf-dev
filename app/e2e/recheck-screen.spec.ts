/**
 * 화면 묶음 B — 고친 문장을 도우미에게 확인받기 (설계 §6, ORDER-IMPL-2B).
 *
 * 진짜 앱을 띄운다. 보는 것: 확인 전 고침 1건 → 아무 메시지나 보냄 → **보낸 본문에 메모** →
 * 말풍선에는 **칩 한 줄** → 그 건이 `sent` → 다음 메시지에는 다시 안 붙음.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, paperReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import { CHAT } from '../src/renderer/src/copy'
import { RECHECK_MARK, recheckChipLabel } from '../src/shared/recheck'

const COMPOSER = `textarea[aria-label="${CHAT.placeholder}"]`

/** 파싱된 챗 로그의 학생 메시지들 — 가짜 서버가 받은 그대로다. */
function userTexts(root: string): string[] {
  try {
    const s = JSON.parse(readFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), 'utf-8')) as { messages?: { role: string; text: string }[] }
    return (s.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text)
  } catch {
    return []
  }
}

/**
 * 입력칸에 글을 넣고 보낸다 — **보내기 단추가 실제로 눌리는지 먼저 기다린다**.
 *
 * 단추는 대화가 연결되기 전·턴이 도는 동안 잠긴다(`Chat.tsx`). 그대로 누르면 클릭이 풀리지
 * 않거나 전송이 거절돼 메시지가 가지 않는다(실제로 이 시험들이 그렇게 흔들렸다).
 */
async function sendText(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER)
  const send = page.locator('.chat-composer button.send')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await composer.fill(text)
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
}

async function selectText(page: Page, needle: string, piece: string): Promise<void> {
  await page.evaluate(({ text, piece: phrase }) => {
    const el = [...document.querySelectorAll('.sheet p, .sheet .blk')].find((n) => (n.textContent ?? '').includes(text))
    if (!el) throw new Error(`문단을 찾지 못했다: ${text}`)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    while (node && !(node.nodeValue ?? '').includes(phrase)) node = walker.nextNode()
    if (!node) throw new Error(`글자를 찾지 못했다: ${phrase}`)
    const at = (node.nodeValue ?? '').indexOf(phrase)
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + phrase.length)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, { text: needle, piece })
}

test('확인 전 고침은 다음 메시지에 메모로 붙고, 말풍선에는 칩만 보인다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    // 숫자를 고친다 → 확인 전(pending) 고침이 하나 생긴다.
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    await input.press('Enter')
    await expect(page.locator('.paper-fb.edit-line')).toContainText('고쳤어요', { timeout: 30_000 })

    // 입력칸 위 칩 — 보낼 때 함께 확인받는다는 것을 알린다.
    const chip = page.locator('.recheck-chip')
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toContainText('직접 고친 문장 1개')

    // 아무 메시지나 보낸다.
    await sendText(page, '단위를 확인해 줘')

    // 보낸 본문에 메모가 붙었다 — 표지 줄과 그 고침이 그대로 간다.
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(1)
    const sent = userTexts(root)[0]
    expect(sent).toContain('단위를 확인해 줘')
    expect(sent).toContain(RECHECK_MARK)
    // 메모는 **문단 전체**의 전→후를 싣는다(§6-2 서식) — 조각이 아니라 문단이 근거 판단 단위다.
    expect(sent).toContain('농장A의 재배 면적은 600평이다.')
    expect(sent).toContain('농장A의 재배 면적은 700평이다.')
    expect(sent).toContain('(기계 검사: 숫자 바뀜)')

    // 말풍선에는 메모 전문이 아니라 **칩 한 줄**만 보인다(§6-1).
    const bubble = page.locator('.chat-msg.user').last()
    await expect(bubble.locator('.msg-recheck')).toHaveText(recheckChipLabel(1))
    await expect(bubble).not.toContainText('등록된 사실·출처와 대조해라')

    // 그 건은 이제 `전달됨`이고, 다음 메시지에는 메모가 다시 붙지 않는다.
    await sendText(page, '고마워요')
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(2)
    expect(userTexts(root)[1]).not.toContain(RECHECK_MARK)
  } finally {
    await electronApp.close()
  }
})

test('확인 전 고침이 없으면 메모도 칩도 없다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.recheck-chip')).toHaveCount(0)
    await sendText(page, '그냥 인사')
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(1)
    expect(userTexts(root)[0]).toBe('그냥 인사')
  } finally {
    await electronApp.close()
  }
})

test('목록 맨 위 지금 확인받기 — 메모만 담은 메시지를 바로 보낸다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    await input.press('Enter')
    await expect(page.locator('.paper-fb.edit-line')).toContainText('고쳤어요', { timeout: 30_000 })

    // 목록을 열면 맨 위에 지금 확인받기가 있고, 그 건의 상태는 `확인 전`이다.
    // 목록 단추는 종이 머리의 `직접 고친 곳 n` 이다 — 다른 팝오버(파일·만들기)와 섞이지 않게 이름으로 찾는다.
    await page.getByRole('button', { name: /^직접 고친 곳/ }).click()
    await expect(page.locator('.edit-asknow')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.popover')).toContainText('확인 전')
    // 목록 안 단추가 눌리는 순간 그 건이 닫혀 목록이 다시 그려진다 — 요소가 곧 사라지므로 직접 누른다.
    await page.locator('.edit-asknow button').evaluate((el) => (el as HTMLElement).click())

    // 메모만 담긴 메시지 — 학생이 쓴 본문이 없으므로 표지 줄로 시작한다.
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(1)
    expect(userTexts(root)[0].startsWith(RECHECK_MARK)).toBe(true)
    // 그 뒤로는 칩이 사라진다(확인 전 고침 0건).
    await expect(page.locator('.recheck-chip')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await electronApp.close()
  }
})

test('목록의 다시 확인 요청 — 그 건이 확인 전으로 돌아가 다음 메시지에 다시 붙는다', async () => {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  const root = synthProject()
  const { electronApp, page } = await launch({ env })
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 })

    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    await input.press('Enter')
    await expect(page.locator('.paper-fb.edit-line')).toContainText('고쳤어요', { timeout: 30_000 })

    // 한 번 보내 그 건을 닫는다(전달됨) — 이제 다음 메시지에 저절로 붙지 않는다.
    await sendText(page, '한 번만 봐 줘')
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(1)
    expect(userTexts(root)[0]).toContain(RECHECK_MARK)
    await expect(page.locator('.recheck-chip')).toHaveCount(0, { timeout: 15_000 })

    // 목록에서 그 건에 `다시 확인 요청` 이 보인다 — 누르면 확인 전으로 돌아간다.
    await page.getByRole('button', { name: /^직접 고친 곳/ }).click()
    const again = page.getByRole('button', { name: '다시 확인 요청' })
    await expect(again).toBeVisible({ timeout: 15_000 })
    // 누르는 순간 그 건이 `pending` 이 되면서 이 단추는 **사라진다** — Playwright 의 안정성
    // 대기는 영영 끝나지 않는다(요소가 DOM 에서 떨어짐). 그래서 요소의 click() 을 직접 부른다.
    await again.evaluate((el) => (el as HTMLElement).click())
    await page.keyboard.press('Escape')
    // 칩이 다시 뜨고, 다음 메시지에 메모가 또 실린다.
    await expect(page.locator('.recheck-chip')).toBeVisible({ timeout: 15_000 })
    await sendText(page, '다시 한 번 봐 줘')
    await expect.poll(() => userTexts(root), { timeout: 30_000 }).toHaveLength(2)
    expect(userTexts(root)[1]).toContain(RECHECK_MARK)
  } finally {
    await electronApp.close()
  }
})
