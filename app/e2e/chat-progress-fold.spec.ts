/**
 * v0.6.2 대화 화면 정리 — 실제 Electron 앱으로 밟는다.
 *
 * ① 한 턴의 중간말은 "작업 과정 보기 (N)" 한 줄로 접히고, 펼치면 원문이 전부 보인다.
 * ② 여러 칸 질문(`[Q3] … 1. … 2. …`)은 카드가 뜰 때 원문의 번호 칸을 접는다 — 예전에는
 *    `zone.kind === 'question'` 일 때만 접어서 형식 질문이 본문과 카드에 두 번 보였다.
 *
 * 스크린샷은 `KNUAF_FOLD_SHOTS_DIR` 가 있을 때만 남긴다(발주 확인용).
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { launch, openProject, splitReady } from './helpers'
import { CHAT, QUESTION_FORM } from '../src/renderer/src/copy'
import { fakeCodexEnv, questionProject, scratch, seedChat } from './fixtures/fake-codex'

const SHOTS = process.env.KNUAF_FOLD_SHOTS_DIR
const shot = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const at = (n: number): string => new Date(Date.now() - 60_000 + n * 1000).toISOString()

const FORM = `조사 결과를 정리했습니다.

[Q3] 작목과 자금 방향

1. 작목 (위 A·B·C 중 하나, 또는 다른 작목)
   예: A 고설 수경 딸기 / B 토마토
   미정이면: 아직 못 고르겠다고 적어주세요

2. 자금 방향 (아래 셋 중 하나)
   예: ① 후계농자금 융자 활용 / ② 기존 온실 임차
   미정이면: ①을 검토용 가정으로 둡니다

위 수치는 조사 자료입니다. 본문에 넣을 때 원문으로 다시 확인합니다.`

test('한 턴의 중간말을 접고, 펼치면 원문이 전부 보인다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [
    { id: 'u1', role: 'user', text: '전공은 원예환경시스템전공이에요', at: at(1), delivery: 'sent' },
    { id: 'a1', role: 'assistant', text: '전공 바인딩을 등록했습니다.', at: at(2) },
    { id: 'a2', role: 'assistant', text: '지원 범위와 질문 계획을 읽겠습니다.', at: at(3) },
    { id: 'a3', role: 'assistant', text: '공식 자료 조사로 넘어갑니다.', at: at(4) },
    { id: 'a4', role: 'assistant', text: '조사 결과입니다. 작목과 자금 방향을 골라 주세요.', at: at(5) }
  ])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const fold = page.locator('.progress-fold')
    await expect(fold, '중간말이 접히지 않았다').toBeVisible({ timeout: 30_000 })
    await expect(fold.locator('.progress-fold-head')).toHaveText(CHAT.progressShow(3))

    // 최종 답은 늘 펴져 있다.
    await expect(page.locator('.chat-msg.assistant').last()).toContainText('조사 결과입니다')
    // 접힌 동안 중간말은 화면 글자에 없다.
    await expect(page.locator('.chat-thread')).not.toContainText('전공 바인딩을 등록했습니다.')
    await shot(page, 'fold-closed')

    await fold.locator('.progress-fold-head').click()
    await expect(fold.locator('.progress-fold-head')).toHaveText(CHAT.progressHide)
    // 글자를 버리지 않는다 — 펼치면 셋 다 원문 그대로다.
    await expect(fold).toContainText('전공 바인딩을 등록했습니다.')
    await expect(fold).toContainText('지원 범위와 질문 계획을 읽겠습니다.')
    await expect(fold).toContainText('공식 자료 조사로 넘어갑니다.')
    await shot(page, 'fold-open')
  } finally {
    await electronApp.close()
  }
})

/**
 * Roh v0.6.2 권고1 — 시스템 알림이 낀 턴에서 묶음이 하나면 B 가 알림보다 먼저 보인다.
 * 묶음을 알림에서 끊으면 대화 줄 순서가 A → 알림 → B → 최종 답 그대로 선다.
 */
test('시스템 알림 앞뒤의 중간말은 각자의 자리에서 접혀 알림을 사이에 둔다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [
    { id: 'u1', role: 'user', text: '전공은 원예환경시스템전공이에요', at: at(1), delivery: 'sent' },
    { id: 'a1', role: 'assistant', text: '전공 바인딩을 등록했습니다.', at: at(2) },
    { id: 's1', role: 'system', text: '규칙집이 갱신됐어요.', at: at(3) },
    { id: 'a2', role: 'assistant', text: '지원 범위를 다시 읽겠습니다.', at: at(4) },
    { id: 'a3', role: 'assistant', text: '조사 결과입니다. 작목을 골라 주세요.', at: at(5) }
  ])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    await expect(page.locator('.progress-fold'), '묶음이 둘로 갈리지 않았다').toHaveCount(2, { timeout: 30_000 })
    const rows = await page.locator('.chat-thread > .progress-fold, .chat-thread > .chat-msg').evaluateAll((els) =>
      els.map((e) => ({
        kind: e.classList.contains('progress-fold') ? 'fold'
          : e.classList.contains('assistant') ? 'assistant'
            : e.classList.contains('system') ? 'system' : 'user',
        text: (e.textContent ?? '').replace(/\s+/g, ' ').trim()
      })))
    // 예전에는 A·B 가 한 묶음으로 A 자리에 서서 B 가 알림보다 먼저 보였다.
    expect(rows.map((r) => r.kind)).toEqual(['user', 'fold', 'system', 'fold', 'assistant'])
    expect(rows[2].text).toContain('규칙집이 갱신됐어요.')
    await shot(page, 'system-boundary-closed')

    const heads = page.locator('.progress-fold-head')
    await heads.nth(0).click()
    await expect(page.locator('.progress-fold').nth(0)).toContainText('전공 바인딩을 등록했습니다.')
    await expect(page.locator('.progress-fold').nth(0)).not.toContainText('지원 범위를 다시 읽겠습니다.')
    await heads.nth(1).click()
    await expect(page.locator('.progress-fold').nth(1)).toContainText('지원 범위를 다시 읽겠습니다.')
    await expect(page.locator('.progress-fold').nth(1)).not.toContainText('전공 바인딩을 등록했습니다.')
    await shot(page, 'system-boundary-open')
  } finally {
    await electronApp.close()
  }
})

/**
 * 형님 화면의 실제 실패 모양 — 2,000자 넘는 최종 답(표·`###` 포함)이 "더 보기"로 잘리고,
 * 그 안 1,400자쯤에 `[Q3]` 질문 블록이 있다. 예전 코드는 이 말을 `zone.kind === 'question'`
 * 으로만 접어서 형식 질문이 잘린 본문과 카드에 두 번 보였다.
 */
const longAnswer = (): string => {
  const rows = [
    '| 후보 | 10a당 소득 수준 | 초기투자 | 기술난이도 | 판로 | 현금 회수 |',
    '|---|---|---|---|---|---|',
    ...['딸기(고설 수경)', '토마토(수경)', '딸기(토경)'].map((crop, i) =>
      `| **${crop}** | ${(2216 - i * 400).toLocaleString('en-US')}만 원 | ${i === 0 ? '가장 큼' : '큼'} | ${i === 0 ? '높음' : '중간'} | 전주 딸기단지·공판장 | ${i === 0 ? '첫 겨울부터 수확' : '회수 늦음'} |`)
  ]
  const para = '내재해형 연동 하우스 설치비가 ㎡당 16.4만~17.9만 원 수준이라 1,000㎡만 지어도 1.64억~1.79억 원입니다. 양액·환경제어 설비는 별도라 자금 방향을 먼저 정해야 규모가 정해집니다.'
  return [
    '**창업논문 진행 목록** · 7단계 중 2단계 진행 중 · 독립 내용검토 전',
    '',
    '### 먼저 확인할 점: 자기자본 1억으로는 온실 신축이 어렵습니다',
    '',
    para.repeat(8),
    '',
    '### 작목 후보 (전공 범위 = 시설원예)',
    '',
    ...rows,
    '',
    '추천은 **A(고설 수경 딸기)**입니다. 전북 시설딸기(촉성)가 지역 주요 작목 중 소득 1위이고 전주시에 딸기연구회 단지가 있어 기술·판로 접근이 쉽습니다. 투자비가 가장 큰 것이 단점이라 자금 방향과 함께 정해야 합니다.',
    '',
    '### 자금 방향 (융자)',
    '',
    para,
    '',
    FORM,
    '',
    para.repeat(6)
  ].join('\n')
}

test('긴 답(표·###·2,000자 넘김)에서도 질문 카드와 겹치는 [Q3] 줄을 접는다', async () => {
  const dir = scratch()
  const root = questionProject()
  const text = longAnswer()
  expect(text.length, '2,000자를 넘겨 "더 보기"가 걸리는 조건이어야 한다').toBeGreaterThan(2000)
  expect(text.indexOf('[Q3]'), '[Q3] 가 첫 2,000자 안에 있어야 예전 실패를 재현한다').toBeLessThan(2000)
  seedChat(root, [{ id: 'a-long', role: 'assistant', text, at: at(1) }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    await expect(page.locator('.qform'), '여러 칸 질문 카드가 없다').toBeVisible({ timeout: 30_000 })
    const body = page.locator('.chat-msg.assistant')
    // 잘린 본문에도, 접힌 채로도 [Q3] 는 없다 — 카드가 그 자리를 대신한다.
    await expect(body).not.toContainText('[Q3] 작목과 자금 방향')
    await expect(body).not.toContainText('2. 자금 방향')
    await expect(body.locator('.q-fold')).toContainText(CHAT.foldFields(2))
    // 2,000자 넘는 답이면 "더 보기"가 걸려 있어야 한다 — 예전 실패는 그 잘린 본문 쪽에서 났다.
    const more = body.getByRole('button', { name: /자 더 보기$/ })
    await expect(more, '"더 보기"가 없으면 2,000자 조건이 아니다').toBeVisible()
    // ② 마크다운: `###`·표·`**굵게**` 가 날 글자가 아니라 요소로 그려진다. 잘린 본문에서도
    // 표는 온전한 행까지만 남고(머리 줄·구분 줄이 살아 있다) 조각난 파이프가 글자로 새지 않는다.
    const md = body.locator('.chat-md')
    await expect(md.locator('table'), '표가 요소로 그려지지 않았다').toHaveCount(1)
    await expect(md.locator('table th').first()).toHaveText('후보')
    await expect(md.locator('table tr').nth(1).locator('td').first()).toHaveText('딸기(고설 수경)')
    await expect(md.locator('h3').first()).toHaveText('먼저 확인할 점: 자기자본 1억으로는 온실 신축이 어렵습니다')
    const raw = await md.innerText()
    for (const mark of ['###', '| ---', '**', '](']) expect(raw, `${mark} 가 글자로 남았다`).not.toContain(mark)
    await shot(page, 'long-question-closed')

    await more.click()
    // 펼친 글은 원문 그대로다(카드 몫 줄은 아래 "여기에 펼치기"가 따로 맡는다).
    await expect(body).toContainText('자금 방향 (융자)')
    await expect(body).toContainText('내재해형 연동 하우스 설치비')
    await expect(body).not.toContainText('[Q3] 작목과 자금 방향')
    // 펼친 뒤에도 표는 하나의 완전한 표다 — 잘린 행이 이어 붙지 않는다.
    const rows = await md.locator('table tr').count()
    expect(rows, '펼친 표의 행 수가 모자란다').toBeGreaterThan(1)
    await expect(md.locator('h3')).toHaveText([
      '먼저 확인할 점: 자기자본 1억으로는 온실 신축이 어렵습니다',
      '작목 후보 (전공 범위 = 시설원예)',
      '자금 방향 (융자)'
    ])
    await shot(page, 'long-question-open')

    // "여기에 펼치기"를 누르면 카드 몫까지 포함해 원문 전부가 돌아온다.
    await body.getByRole('button', { name: CHAT.unfold }).click()
    await expect(body).toContainText('[Q3] 작목과 자금 방향')
    await expect(body).toContainText('예: A 고설 수경 딸기')
    await shot(page, 'long-question-unfolded')
  } finally {
    await electronApp.close()
  }
})

test('여러 칸 질문 카드는 원문의 번호 칸을 접고, 설명 문장은 남긴다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [{ id: 'a-q3', role: 'assistant', text: FORM, at: at(1) }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const form = page.locator('.qform')
    await expect(form, '여러 칸 질문 카드가 없다').toBeVisible({ timeout: 30_000 })

    // 예전에는 이 자리에 "1. 작목 … 2. 자금 방향 …" 이 그대로 남아 카드와 두 번 보였다.
    const body = page.locator('.chat-msg.assistant')
    await expect(body).not.toContainText('[Q3] 작목과 자금 방향')
    await expect(body).not.toContainText('2. 자금 방향')
    // 카드에 없는 글은 남는다.
    await expect(body).toContainText('조사 결과를 정리했습니다.')
    await expect(body).toContainText('위 수치는 조사 자료입니다.')
    await expect(body.locator('.q-fold')).toContainText(CHAT.foldFields(2))
    await shot(page, 'question-folded')

    // 펼치면 원문 그대로 — 카드가 보여 주지 않는 예시 줄까지 돌아온다.
    await body.getByRole('button', { name: CHAT.unfold }).click()
    await expect(body).toContainText('[Q3] 작목과 자금 방향')
    await expect(body).toContainText('예: A 고설 수경 딸기')
    await shot(page, 'question-unfolded')
  } finally {
    await electronApp.close()
  }
})

test('자유롭게 답하기로 바꾸면 카드가 사라지므로 질문 원문도 다시 보인다', async () => {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, [{ id: 'a-q3', role: 'assistant', text: FORM, at: at(1) }])
  const { electronApp, page } = await launch({ env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }) })
  try {
    await openProject(page, root, splitReady)
    const form = page.locator('.qform')
    await expect(form, '여러 칸 질문 카드가 없다').toBeVisible({ timeout: 30_000 })
    const body = page.locator('.chat-msg.assistant')
    // 카드가 보이는 동안은 접힌다(카드가 그 줄을 대신 보여 준다).
    await expect(body.locator('.q-fold')).toBeVisible()
    await expect(body).not.toContainText('[Q3] 작목과 자금 방향')

    // '직접 입력' 을 누르면 카드는 숨고 입력칸이 뜬다 — 이제 원문이 유일한 질문 표시다.
    await form.getByRole('button', { name: QUESTION_FORM.free }).click()
    await expect(page.locator('.chat-composer textarea')).toBeVisible()
    await expect(form, '카드가 숨지 않았다').toBeHidden()
    await expect(body.locator('.q-fold'), '카드가 없는데 접힘 안내가 남았다').toHaveCount(0)
    await expect(body, '질문 원문이 접힌 채 남았다').toContainText('[Q3] 작목과 자금 방향')
    // 번호는 마크다운 목록 요소가 그린다 — 글자로는 칸 이름만 확인한다.
    await expect(body.locator('.chat-md ol li')).toHaveCount(2)
    await expect(body.locator('.chat-md ol li').nth(1)).toContainText('자금 방향 (아래 셋 중 하나)')
    await expect(body).toContainText('예: A 고설 수경 딸기')
    await shot(page, 'question-free')

    // 돌아가면 카드가 다시 보이므로 접힘도 함께 돌아온다.
    await page.getByRole('button', { name: QUESTION_FORM.back }).click()
    await expect(form).toBeVisible()
    await expect(body.locator('.q-fold')).toBeVisible()
    await expect(body).not.toContainText('[Q3] 작목과 자금 방향')
  } finally {
    await electronApp.close()
  }
})
