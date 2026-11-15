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

/**
 * 전환 뒤 **그 공급자의 대화가 실제로 화면에 올라왔는지**를 기다린다.
 *
 * 계정 칩의 'ChatGPT' 표시만 기다리면, Codex 대화가 아직 로드되지 않아 이전(Claude) 대화가
 * 남은 화면에서 4/7 을 보고 통과할 수 있다 — 그 뒤 Codex 값(2/7)이 올라오면 시험은 이미 끝나
 * 있다(Roh 권고 ①). 신호는 Codex 답에만 있는 '다음 작업' 줄이다: `Chat.tsx` 는 진행 목록
 * 덩어리만 감추므로 이 줄은 화면에 남는다. 같은 문구가 다른 픽스처(`REAL_STEP4`: "정본에
 * 등록하고(전공이 없으면…")와 겹치지 않게 '이어갑니다'까지 붙여 잡는다.
 */
const waitCodexThread = async (page: Page): Promise<void> => {
  await expect(page.locator('.chat-thread'), 'Codex 대화가 화면에 올라오기 전에 단정했다')
    .toContainText('전공 바인딩을 정본에 등록하고 이어갑니다', { timeout: 30_000 })
}

test('U-switch 같은 논문·공급자 전환 — Claude 4단계 → Codex 2단계(옛날) → 제목줄 4/7 유지, 저장값도 4단계', async () => {
  // 앱을 두 번 띄운다 — 기본 90초는 느린 기계에서 종료 대기만으로도 바닥난다(맥 CI 실측:
  // close 한 번에 68초). 다른 다중 실행 시험과 같은 180초를 준다. 단정은 그대로다.
  test.setTimeout(180_000)
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
  // 시각은 고정한다 — `at(n)` 은 부를 때마다 Date.now() 를 읽으므로, 공급자 파일을 각각 쓰면
  // Codex 쪽이 1ms 더 새로 찍힐 수 있다. 그러면 `pickProgress` 가 대화값(2/7)을 저장값(4/7)보다
  // 새것으로 보고 제목줄이 2/7 로 돌아간다(맥 CI 1회째 실패의 원인). Codex 답은 실제로 옛날이다.
  const atClaude4 = '2026-11-10T20:02:00.000Z'
  const atCodexOld2 = '2026-11-10T20:01:00.000Z'
  const atUser = '2026-11-10T20:00:00.000Z'
  writeFileSync(join(root, '.knuaf-gui', 'chat-claude.json'), JSON.stringify({
    root, provider: 'claude', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: atUser, delivery: 'sent' },
      { id: 'm-claude-4', role: 'assistant', text: STEP4_TEXT, at: atClaude4 },
    ],
  }), 'utf-8')
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), JSON.stringify({
    root, provider: 'codex', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: atUser, delivery: 'sent' },
      { id: 'm-codex-2', role: 'assistant', text: REAL_STEP4_CODEX_OLD, at: atCodexOld2 },
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
    // Roh 권고 ①: 칩 표시만 보고 단정하면 Codex 대화가 붙기 전의 4/7 을 통과시킬 수 있다.
    await waitCodexThread(page)

    // 저장값이 4단계이므로 Codex 2단계(옛날)보다 늦지 않다 — 제목줄은 여전히 4/7
    await expect(titlebar(page), '공급자 전환 뒤 진행이 되돌아갔다').toContainText('4/7')
    await expect(titlebar(page)).toContainText('본문 Ⅰ~Ⅵ 초안')

    // 저장값도 4단계 (localStorage) — 시각까지 20:02로 갱신됐어야 한다
    const stored = await page.evaluate((r) => {
      try {
        const raw = window.localStorage.getItem(`knuaf.progress.v1:${r}`)
        if (!raw) return null
        const p = JSON.parse(raw)
        return { n: p.block.n, at: p.at, id: p.messageId }
      } catch { return null }
    }, root)
    expect(stored?.n).toBe(4)

    // 앱 재시작 — 같은 userData(localStorage 유지)로 다시 켜면 제목줄이 여전히 4/7
    // provider_choice는 ChatGPT로 바뀐 채로 재시작한다 — Codex 2단계(옛날)가 대화값이라
    // 저장값(4단계)이 더 늦다는 것을 보여준다.
    //
    // 이 재시작 시험이 곧 **저장 지속성 검사**다. 디스크 반영은 파일로 확인할 수 없다 —
    // Chromium 의 leveldb 는 값을 snappy 로 압축하므로 원문 JSON 이 어떤 파일에도 없다
    // (파일 바이트를 기다리던 20초 폴링은 헛돌았다). 그래서 "내려갔다"를 따로 보지 않고
    // **재시작 뒤 고른 값**으로 판정한다: 저장값이 살아 있으면 4/7, 유실됐으면 대화값인
    // Codex 2/7 이 되어 이 단정이 실패한다(Roh 대조군 확인: 저장값을 지우면 2/7).
    // 픽스처 시각을 고정한 것은 그 판정이 매번 같은 값으로 떨어지게 하기 위해서다.
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

// Roh fix2 [중요]: 같은 진행 내용의 새 답(새 id, 20:02)이 와도 저장 시각이 갱신돼야 한다.
// 20:00 4단계 → 20:02 같은 내용 새 답 → Codex 20:01 2단계로 전환 → 여전히 4/7.
test('U-newreply 같은 내용 새 답(새 id·20:02) — 저장 시각 갱신, Codex 20:01 전환에도 4/7', async () => {
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const root = synthProject()
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
  const atOldClaude = new Date('2026-11-10T20:00:00Z').toISOString()
  const atNewClaude = new Date('2026-11-10T20:02:00Z').toISOString()
  const atCodexOld = new Date('2026-11-10T20:01:00Z').toISOString()
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  writeFileSync(join(root, '.knuaf-gui', 'chat-claude.json'), JSON.stringify({
    root, provider: 'claude', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: atOldClaude, delivery: 'sent' },
      { id: 'm-claude-2000', role: 'assistant', text: STEP4_TEXT, at: atOldClaude },
      { id: 'u1', role: 'user', text: '이어서', at: atNewClaude, delivery: 'sent' },
      { id: 'm-claude-2002', role: 'assistant', text: STEP4_TEXT, at: atNewClaude },
    ],
  }), 'utf-8')
  writeFileSync(join(root, '.knuaf-gui', 'chat-codex.json'), JSON.stringify({
    root, provider: 'codex', state: 'idle',
    messages: [
      { id: 'u0', role: 'user', text: '시작하기', at: atOldClaude, delivery: 'sent' },
      { id: 'm-codex-2001', role: 'assistant', text: REAL_STEP4_CODEX_OLD, at: atCodexOld },
    ],
  }), 'utf-8')
  const userData = userDataWith(dir, { helper_mode: 'claude-chat', provider_choice: { provider: 'claude', at: new Date().toISOString() } })
  const { electronApp, page } = await launch({ env, userData })
  try {
    await openProject(page, root, splitReady)
    await expect(titlebar(page)).toContainText('4/7')
    const stored = await page.evaluate((r) => {
      try {
        const raw = window.localStorage.getItem(`knuaf.progress.v1:${r}`)
        if (!raw) return null
        const p = JSON.parse(raw)
        return { n: p.block.n, at: p.at, id: p.messageId }
      } catch { return null }
    }, root)
    expect(stored?.n).toBe(4)
    expect(stored?.at).toBe(atNewClaude)
    expect(stored?.id).toBe('m-claude-2002')

    await page.getByTitle('이 논문의 도우미').click()
    await page.getByRole('button', { name: 'ChatGPT로 바꾸기' }).click()
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('ChatGPT', { timeout: 30_000 })
    // Roh 권고 ①: 칩 표시만 보고 단정하면 Codex 대화가 붙기 전의 4/7 을 통과시킬 수 있다.
    await waitCodexThread(page)
    await expect(titlebar(page), '같은 내용 새 답 후 Codex 20:01 전환에 진행이 후퇴했다').toContainText('4/7')
    await expect(titlebar(page)).toContainText('본문 Ⅰ~Ⅵ 초안')
  } finally {
    await electronApp.close()
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

// Roh [중요 1] 보강: 같은 messageId로 text만 갱신되는 스트리밍 — 1단계 덩어리 뒤 4단계 덩어리 붙음.
// service.ts는 같은 id로 text만 바꾼다. 저장 여부는 고른 진행값 자체(단계 상태)로 판단한다.
test('U-stream 같은 messageId 텍스트 갱신 1단계→4단계 — 저장값 4, Codex 전환에도 4/7', async () => {
  // U-switch 와 같은 이유(앱 두 번)로 180초. 단정은 그대로다.
  test.setTimeout(180_000)
  const dir = scratch()
  const bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in' })
  writeFakeClaude(bin)
  const root = synthProject()
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
  const at0 = at(0)
  const at1 = at(1)
  const writeChat = (messages: unknown[], provider: 'codex' | 'claude' = 'codex') => {
    mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
    writeFileSync(join(root, '.knuaf-gui', `chat-${provider}.json`), JSON.stringify({
      root, provider, state: 'idle', messages,
    }), 'utf-8')
  }
  const readStoredN = async (page: Page): Promise<number | null> =>
    page.evaluate((r) => {
      try {
        const raw = window.localStorage.getItem(`knuaf.progress.v1:${r}`)
        return raw ? JSON.parse(raw).block.n : null
      } catch { return null }
    }, root)

  // ① 처음 1단계 덩어리만 든 스트리밍 답 (claude provider와 일치 — userData는 claude)
  writeChat([
    { id: 'u0', role: 'user', text: '시작하기', at: at0, delivery: 'sent' },
    { id: 'm-stream', role: 'assistant', text: REAL_STEP2, at: at1 },
  ], 'claude')
  writeChat([
    { id: 'u0', role: 'user', text: '시작하기', at: at0, delivery: 'sent' },
    { id: 'm-codex-2', role: 'assistant', text: REAL_STEP4_CODEX_OLD, at: at1 },
  ], 'codex')
  const userData = userDataWith(dir, { helper_mode: 'claude-chat', provider_choice: { provider: 'claude', at: new Date().toISOString() } })
  const { electronApp, page } = await launch({ env, userData })

  try {
    await openProject(page, root, splitReady)
    await expect(titlebar(page)).toContainText('1/7')
    await expect(titlebar(page)).toContainText('자료·전공 확인')
    expect(await readStoredN(page)).toBe(1)

    // ② 같은 id로 text만 4단계로 갱신 — id·at·provider 불변.
    writeChat([
      { id: 'u0', role: 'user', text: '시작하기', at: at0, delivery: 'sent' },
      { id: 'm-stream', role: 'assistant', text: STEP4_TEXT, at: at1 },
    ], 'claude')
    // 파일만 바꾸면 메모리 스냅샷이 안 갱신된다 — 앱을 다시 띄우면 새 파일에서 읽는다.
    // 앱을 다시 띄우면 새 파일에서 읽어 focus가 4단계로 바뀐다(고른 진행값 서명 변경).
    // 이 흐름은 file→load 경로를 그대로 확인한다.
    //
    // 주의: 이 재시작은 **저장 지속성 검사가 아니다**. 바뀐 파일의 4단계 덩어리를 대화값으로
    // 다시 고르기 때문이다(디스크 반영 여부와 무관하게 4가 나온다). 디스크 반영은 파일로
    // 확인할 수도 없다 — leveldb 는 값을 snappy 로 압축해 원문이 남지 않는다.
    // U-stream 은 저장 지속성을 판정하지 못한다 — 저장값이 없어도 Claude 대화의 4단계를 다시
    // 읽어 뒤 단정까지 통과한다. 지속성은 U-switch 재시작 단정이 맡는다.
    await electronApp.close()
    const second = await launch({ env, userData })
    try {
      await openProject(second.page, root, splitReady)
      await expect.poll(async () => {
        try { return await readStoredN(second.page) } catch { return null }
      }, { timeout: 20_000 }).toBe(4)
      await expect(titlebar(second.page)).toContainText('4/7')
      await expect(titlebar(second.page)).toContainText('본문 Ⅰ~Ⅵ 초안')

      // Codex전환 확인 전에도 localStorage는 4인지 확인한다.
      // ③ Codex 전환(옛날 2단계 대화) — 여전히 4/7.
      await second.page.getByTitle('이 논문의 도우미').click()
      await second.page.getByRole('button', { name: 'ChatGPT로 바꾸기' }).click()
      await expect(second.page.getByTitle('이 논문의 도우미')).toContainText('ChatGPT', { timeout: 30_000 })
      // Roh 권고 ①: 칩 표시만 보고 단정하면 Codex 대화가 붙기 전의 4/7 을 통과시킬 수 있다.
      await waitCodexThread(second.page)
      await expect(titlebar(second.page), '스트리밍 갱신 후 전환에 진행이 되돌아갔다').toContainText('4/7')
      expect(await readStoredN(second.page)).toBe(4)
      await shot(second.page, 'u-stream')
    } finally {
      await second.electronApp.close()
    }
  } finally {
    try { await electronApp.close() } catch { /* 이미 닫혔다 */ }
  }
})
