/**
 * 제목줄 진행 표시 T1 — 실제 Electron 앱으로 밟는다.
 *
 * IMPL-T1 §3-4 U. `seedChat`(`fixtures/fake-codex.ts`)으로 대화 기록을 심는다.
 * 제목줄은 `useProgress`가 고른 값을 그린다(localStorage `knuaf.progress.v1:<root>`).
 *
 * Chat 배선 후 U1·U9의 본문 단언을 활성화했다 — 제목줄은 `useProgress`가 고른 값을 그린다.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, setWindowWidth, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch, seedChat, userDataWith, writeFakeClaude } from './fixtures/fake-codex'
import { REAL_STEP2, REAL_STEP4, REAL_STEP11 } from './fixtures/progress-real-v061'

// Roh 재현: 같은 논문에서 Claude 대화가 4단계 목록을 받음 → AI 회사를 Codex로 바꿈(그 대화엔 옛날 2단계) → 제목줄 4/7 유지, 저장값도 4단계. 앱 재시작(서로 다른 userData=localStorage 유지)도 4/7.
const REAL_STEP4_CODEX_OLD = `**창업논문 진행 목록** · 7단계 중 1–2단계 진행 중 · 독립 내용검토 전 (논문은 아직 완성 전)
▶ 1 자료·전공 확인 — 자료 세 가지 모두 "없음"으로 정본에 기록함(개정 4). 전공 바인딩 남음
▶ 2 계획 인터뷰 — 기본 계획(전공·작목·지역·자금) 질문 보냄
○ 3–7단계 남음
그 뒤: 한글 마무리(글꼴·여백·쪽번호)·교수 승인 — 학생 몫

- **다음 작업**: 전공을 받으면 전공 바인딩을 정본에 등록하고 이어갑니다.
- **지금 확인할 것**: 아래 Q2 — 자료가 없으니 계획은 인터뷰로 세웁니다.`

test('U-switch 같은 논문·공급자 전환 — Claude 4단계 → Codex 2단계(옛날) → 제목줄 4/7 유지, 저장값도 4단계', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const root = synthProject()
  // Claude 대화: 4단계(REAL_STEP11보다 뒤 단계인 실제 4단계 목록)를 심는다.
  const STEP4_TEXT = [
    '**창업논문 진행 목록** · 7단계 중 4단계 진행 중 · 독립 내용검토 전 (논문은 아직 완성 전)',
    '✓ 1–3단계 끝남 — 전공·계획·근거',
    '▶ 4 본문 Ⅰ~Ⅵ 초안 — Ⅰ·Ⅱ장 끝, 이번에 Ⅲ장',
    '○ 5–7단계 남음',
    '그 뒤: 한글 마무리(글꼴·여백·쪽번호)·교수 승인 — 학생 몫',
    '',
    '- **다음 작업**: Ⅲ장을 이어갑니다.',
    '- **지금 확인할 것**: 아래 Q3 두 가지.',
  ].join('\n')
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'chat-claude.json'), JSON.stringify({
    root, provider: 'claude', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: at(0), delivery: 'sent' },
      { id: 'm-claude-4', role: 'assistant', text: STEP4_TEXT, at: at(1) },
    ],
  }), 'utf-8')
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), JSON.stringify({
    root, provider: 'codex', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: at(0), delivery: 'sent' },
      { id: 'm-codex-2', role: 'assistant', text: REAL_STEP4_CODEX_OLD, at: at(1) },
    ],
  }), 'utf-8')

  // 시작: claude로 열린 대화 — 제목줄은 4/7 본문 Ⅰ~Ⅵ 초안
  const userData = userDataWith(dir, { helper_mode: 'claude-chat', provider_choice: { provider: 'claude', at: new Date().toISOString() } })
  const { electronApp, page } = await launch({ env, userData })
  try {
    await openProject(page, root, splitReady)
    await expect(titlebar(page)).toContainText('4/7')
    await expect(titlebar(page)).toContainText('본문 Ⅰ~Ⅵ 초안')

    // AI 회사 전환: "이 논문의 도우미" 칩 → "ChatGPT로 바꾸기"(Codex 표시 이름은 ChatGPT)
    await page.getByTitle('이 논문의 도우미').click()
    await expect(page.getByText(/AI 회사를 바꾸면 이전 대화 맥락이 이어지지 않을 수 있어요/)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'ChatGPT로 바꾸기' }).click()
    await expect(page.getByText(/ChatGPT는 Claude와 나눈 대화를 볼 수 없어요/)).toBeVisible({ timeout: 30_000 })
    // 대화가 Codex로 바뀌었더라도...
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('ChatGPT', { timeout: 30_000 })

    // 저장값이 4단계이므로 Codex 2단계(옛날)보다 늦지 않다 — 제목줄은 여전히 4/7
    await expect(titlebar(page), '공급자 전환 뒤 진행이 되돌아갔다').toContainText('4/7')
    await expect(titlebar(page)).toContainText('본문 Ⅰ~Ⅵ 초안')

    // 저장값도 4단계 (localStorage)
    const storedN = await page.evaluate((r) => {
      try {
        const raw = window.localStorage.getItem(`knuaf.progress.v1:${r}`)
        return raw ? JSON.parse(raw).block.n : null
      } catch { return null }
    }, root)
    expect(storedN).toBe(4)

    // 앱 재시작 — 같은 userData(localStorage 유지)로 다시 켜면 제목줄이 여전히 4/7
    await electronApp.close()
    const second = await launch({ env, userData })
    try {
      await openProject(second.page, root, splitReady)
      await expect(titlebar(second.page), '앱 재시작 뒤 진행이 사라졌다').toContainText('4/7')
      await expect(titlebar(second.page)).toContainText('본문 Ⅰ~Ⅵ 초안')
      await shot(second.page, 'u-switch-once')
    } finally {
      await second.electronApp.close()
    }
  } finally {
    try { await electronApp.close() } catch { /* 이미 닫혔다 */ }
  }
})

const SHOTS = process.env.KNUAF_FOLD_SHOTS_DIR ?? process.env.PROGRESS_SHOTS_DIR
const shot = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const at = (n: number): string => new Date(Date.now() - 60_000 + n * 1000).toISOString()

function seedReal(root: string) {
  seedChat(root, [
    { id: 'u0', role: 'user', text: '시작하기', at: at(0), delivery: 'sent' },
    { id: 'a1', role: 'assistant', text: '작업 폴더를 확인하고 스킬 준비를 시작합니다.', at: at(1) },
    { id: 'm2', role: 'assistant', text: REAL_STEP2, at: at(2) },
    { id: 'u1', role: 'user', text: '전부 없음', at: at(3), delivery: 'sent' },
    { id: 'm4', role: 'assistant', text: REAL_STEP4, at: at(4) },
    { id: 'u2', role: 'user', text: '전공은 원예시스템전공', at: at(5), delivery: 'sent' },
    { id: 'a6', role: 'assistant', text: '전공을 받았습니다. 확인하겠습니다.', at: at(6) },
    { id: 'a7', role: 'assistant', text: '등록했습니다. 읽겠습니다.', at: at(7) },
    { id: 'a8', role: 'assistant', text: '조사로 넘어갑니다.', at: at(8) },
    { id: 'a9', role: 'assistant', text: '외부 조사로 넘어갑니다.', at: at(9) },
    { id: 'a10', role: 'assistant', text: '결과를 정리하겠습니다.', at: at(10) },
    { id: 'm11', role: 'assistant', text: REAL_STEP11, at: at(11) },
  ])
}

const titlebar = (page: Page) => page.locator('.titlebar .tbtn.stg')

test('U1 실기록 모양 — 제목줄 "2/7 계획 인터뷰"', async () => {
  const dir = scratch()
  const root = synthProject()
  seedReal(root)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const button = titlebar(page)
    await expect(button, '제목줄 진행 단추가 보이지 않았다').toBeVisible({ timeout: 30_000 })
    await expect(button).toContainText('2/7')
    await expect(button).toContainText('계획 인터뷰')
    // 눈금 7칸 — 1 끝남·1 지금(...... 칸 개수 자체)
    await expect(button.locator('.ticks i')).toHaveCount(7)
    await expect(button.locator('.ticks i.d')).toHaveCount(1)
    await expect(button.locator('.ticks i.n')).toHaveCount(1)
    await expect(button).toHaveAttribute('aria-label', /7단계 중 2단계/)
    // Chat 배선 후: 대화 본문에 진행 목록 글자가 없다 — 제목줄에만 보인다.
    const thread = page.locator('.chat-thread')
    await expect(thread, '대화 본문에 진행 목록 글자가 남았다').not.toContainText('창업논문 진행 목록')
    await expect(thread, '대화 본문에 단계 줄이 남았다').not.toContainText('1 자료·전공 확인')
    // `다음 작업`·`지금 확인할 것` 줄은 구간 밖이라 남는다.
    await expect(thread).toContainText('다음 작업')
    await expect(thread).toContainText('지금 확인할 것')
    // 앞 안내·뒤 설명 문장도 남는다.
    await expect(thread).toContainText('창업논문 도우미')
    await shot(page, 'u1-closed')
  } finally {
    await electronApp.close()
  }
})

test('U7 대화 없음 — "시작 전", 펼치면 안내 + [제출 전 점검]', async () => {
  const dir = scratch()
  const root = synthProject()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const button = titlebar(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await expect(button).toContainText('시작 전')
    await expect(button.locator('.ticks i.d')).toHaveCount(0)
    await expect(button.locator('.ticks i.n')).toHaveCount(0)
    await button.click()
    const pop = page.locator('.titlebar .popover')
    await expect(pop).toBeVisible()
    await expect(pop).toContainText('도우미가 첫 진행 목록을 쓰면 채워져요')
    await shot(page, 'u7')
  } finally {
    await electronApp.close()
  }
})

test('U8 펼침 — "그 뒤" 실제 문구와 [제출 전 점검]이 점검 창을 연다', async () => {
  const dir = scratch()
  const root = synthProject()
  seedReal(root)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    await titlebar(page).click()
    const pop = page.locator('.titlebar .popover')
    await expect(pop).toBeVisible()
    // 접기 단추(가운데 원형 ›)가 펼친 목록 위에 겹치지 않는다 — z-order 회귀(T1 u8-open).
    // 목록이 단추보다 위에 오면 "7. 워드 검토본" 줄을 가리지 않는다.
    await expect(pop).toContainText('7. 워드 검토본')
    const popZ = await pop.evaluate((el) => getComputedStyle(el).zIndex)
    const handleZ = await page.evaluate(() => {
      const h = document.querySelector('button[aria-controls="paperpane"]')
      return h ? getComputedStyle(h).zIndex : null
    })
    expect(Number(popZ), '팝오버 z-index가 접기 단추보다 낮다').toBeGreaterThan(Number(handleZ ?? 0))
    await expect(pop).toContainText('한글 마무리(글꼴·여백·쪽번호)·교수 승인 — 학생 몫')
    await expect(pop).toContainText('답 기준')
    await expect(pop).toContainText('독립 내용검토 전')
    await shot(page, 'u8-open')
    await pop.getByRole('button', { name: '제출 전 점검' }).click()
    const over = page.locator('.paperpane .sheetover')
    await expect(over).toBeVisible({ timeout: 30_000 })
    await expect(over.getByRole('heading')).toContainText('제출 전 점검')
    await shot(page, 'u8-checkup')
  } finally {
    await electronApp.close()
  }
})

test('U2 목록 없는 답 뒤에도 제목줄 그대로', async () => {
  const dir = scratch()
  const root = synthProject()
  const messages = [
    { id: 'u0', role: 'user', text: '시작하기', at: at(0), delivery: 'sent' },
    { id: 'm11', role: 'assistant', text: REAL_STEP11, at: at(1) },
    { id: 'u1', role: 'user', text: '무엇을 골라야 해요?', at: at(2), delivery: 'sent' },
    { id: 'a2', role: 'assistant', text: '작목과 자금 방향 두 가지를 골라 주세요.', at: at(3) },
  ]
  seedChat(root, messages)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const button = titlebar(page)
    await expect(button).toContainText('2/7')
    await expect(button).toContainText('계획 인터뷰')
  } finally {
    await electronApp.close()
  }
})

test('U10 좁은 창 1,024 / 900 — 단추가 [대화 | 내 논문]과 겹치지 않는다', async () => {
  const dir = scratch()
  const root = synthProject()
  seedReal(root)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const button = titlebar(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await setWindowWidth(electronApp, 1024)
    await page.waitForTimeout(600)
    const seg = page.locator('.tbar-seg')
    await expect(seg).toBeVisible({ timeout: 20_000 })
    const buttonBox = await button.boundingBox()
    const segBox = await seg.boundingBox()
    expect(buttonBox).not.toBeNull()
    expect(segBox).not.toBeNull()
    expect(buttonBox!.x, '제목줄 진행과 세그먼트가 겹친다').toBeGreaterThan(segBox!.x + segBox!.width)
    await shot(page, 'u10-1024')
    await setWindowWidth(electronApp, 900)
    await page.waitForTimeout(600)
    await expect(button).toContainText('2/7')
    await shot(page, 'u10-900')
  } finally {
    await electronApp.close()
  }
})

test('U8-small 작은 창(높이 720) — [제출 전 점검]이 펼침 안에 늘 보인다', async () => {
  const dir = scratch()
  const root = synthProject()
  seedReal(root)
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    // 창 높이 720 — 팝오버 최대 높이와 겹친 긴 목록에서 진입점이 잘리지 않는지 본다.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const b = win.getBounds()
      win.setBounds({ ...b, height: 720 })
    })
    await page.waitForTimeout(600)
    await titlebar(page).click()
    const pop = page.locator('.titlebar .popover')
    await expect(pop).toBeVisible()
    const check = pop.getByRole('button', { name: '제출 전 점검' })
    await expect(check, '제출 전 점검이 펼침 안에 없다').toBeVisible()
    const popBox = await pop.boundingBox()
    const checkBox = await check.boundingBox()
    expect(popBox).not.toBeNull()
    expect(checkBox).not.toBeNull()
    expect(
      checkBox!.y + checkBox!.height,
      '제출 전 점검이 팝오버 아래쪽에 잘렸다',
    ).toBeLessThanOrEqual(popBox!.y + popBox!.height + 2)
    // 목록 영역이 스크롤된다 — pop-scroll 존재 + overflow-y auto
    const scrollable = await pop.locator('.pop-scroll').evaluate((el) => {
      const cs = getComputedStyle(el)
      return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
    })
    expect(scrollable, '목록 영역이 스크롤되지 않는다').toBe(true)
    await shot(page, 'u8-small')
    await check.click()
    const over = page.locator('.paperpane .sheetover')
    await expect(over).toBeVisible({ timeout: 30_000 })
    await expect(over.getByRole('heading')).toContainText('제출 전 점검')
  } finally {
    await electronApp.close()
  }
})
