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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, setWindowWidth, splitReady, synthProject } from './helpers'
import { fakeCodexEnv, scratch, seedChat } from './fixtures/fake-codex'
import { REAL_STEP2, REAL_STEP4, REAL_STEP11 } from './fixtures/progress-real-v061'

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
