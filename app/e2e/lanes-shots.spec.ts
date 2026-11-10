/**
 * v0.7 작업 분담(단위 6) 화면 캡처 — 설계 `UI-DESIGN.md` r3c §2·§3·§4·§5 와 시안 `mock/v07.r3.html` 대조용.
 *
 * preload 에 아직 `lanes` 가 없어서(배선 C1 몫) 실제 묶음은 오지 않는다. 그래서 상태는 승인된
 * 시험 통로(`knuaf:lanes-test`·`knuaf:lanes-test-archive`)로 넣는다 — 설계 §7 "가짜 store 상태로 그림".
 * 실제 AI 호출은 하지 않는다. 사진은 `KNUAF_LANES_SHOTS_DIR` 가 있을 때만 남긴다.
 *
 * 창은 두 번만 띄운다(대화 장면 6장 · 설정 1장). 기동이 느린 기계에서 장면마다 새 앱을 띄우면
 * 같은 화면을 얻는 데 몇 배가 걸린다 — 주입 통로가 장면 사이 전환을 이미 할 수 있다.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openProject, setWindowWidth } from './helpers'
import { fakeCodexEnv, questionProject, scratch, seedChat, userDataWith } from './fixtures/fake-codex'

const OUT = process.env.KNUAF_LANES_SHOTS_DIR

const at = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString()

const MESSAGES = [
  { id: 'u1', role: 'user', text: '3장 시장 현황에 감초 가격 자료 좀 찾아 줘', at: at(9), delivery: 'sent' },
  { id: 'a1', role: 'assistant', text: '네, 자료 찾기 담당에게 도매·소매 가격 조사를 맡길게요. 끝나면 원문을 다시 확인해서 3장에 넣을게요.', at: at(8) }
]

/** 공통 묶음 뼈대 — 각 장면이 필요한 칸만 덮어쓴다. */
function snapshot(root: string, seq: number, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    root,
    seq,
    lines: [],
    cards: [],
    events: [],
    settings: {
      mode: 'on',
      source: { kind: 'recommended', rowId: 'claude-high-codex-low' },
      rows: [],
      differsFromRecommendation: false,
      temporary: [],
      recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' },
      nextDesignCompany: null,
      consents: []
    },
    archives: [],
    announcement: null,
    stopButton: 'chat',
    ...patch
  }
}

const detail = (jobId: string, task: string) => ({ jobId, status: 'running', reason: null, error: null, task })
const progressLine = (id: string, jobId: string, lane: string, task: string, minutes: number, waiting: number, assignee: Record<string, unknown>) => ({
  kind: 'progress', tier: 3, id, at: at(minutes), dismissible: false,
  jobId, lane, detail: detail(jobId, task), assignee,
  phase: 'running', startedAt: at(minutes), waiting
})

async function inject(page: Page, snapshotValue: Record<string, unknown>): Promise<void> {
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('knuaf:lanes-test', { detail: value }))
  }, snapshotValue)
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!OUT) return
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

async function open(settings: Record<string, unknown>, after: (page: Page, root: string, app: ElectronApplication) => Promise<void>): Promise<void> {
  const dir = scratch()
  const root = questionProject()
  seedChat(root, MESSAGES)
  const { electronApp, page } = await launch({
    colorScheme: 'light',
    env: fakeCodexEnv(`${dir}/bin`, { FAKE_CODEX_MODE: 'logged-in' }),
    userData: userDataWith(dir, { permission_mode: 'trust', ...settings })
  })
  try {
    await page.setViewportSize({ width: 1180, height: 800 })
    // 문서용 캡처는 불투명 사이드바로 남긴다(웹 레이어가 vibrancy 를 담지 못한다).
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    await openProject(page, root)
    await page.locator('.chat-msg').first().waitFor({ timeout: 30_000 })
    await after(page, root, electronApp)
  } finally {
    await electronApp.close()
  }
}

const CARD_ROWS = [
  { lane: 'research', before: null, after: { company: 'codex', model: 'astra', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'writing', before: null, after: { company: 'codex', model: 'sol', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'repeat', before: null, after: { company: 'codex', model: 'terra', effort: null, how: 'relay' }, rejected: null, designSwitchTo: null, requested: null },
  { lane: 'review', before: null, after: { company: 'codex', model: 'astra', effort: 'high', how: 'relay' }, rejected: null, designSwitchTo: null, requested: null }
]

function firstCard(cardId: string, state: Record<string, unknown>, createdAt: string): Record<string, unknown> {
  return {
    cardId, root: '', variant: 'first', baseVersion: 1, createdAt, reviewDue: false, quote: null,
    rows: CARD_ROWS,
    fees: [{ company: 'codex', accountLabel: 'a…@gmail.com', consented: false }],
    fastDrain: false, recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' }, state
  }
}

test('대화 장면 — 진행 줄 · 카드(열림/접힘) · 기록 줄 · 본대화 한도 · 멈춘 대화', async () => {
  test.setTimeout(300_000)
  await open({}, async (page, root) => {
    /** 줄·카드·기록 줄이 설계가 말한 **자리**에 있는가 — 사진만으로는 회귀를 못 잡는다. */
    const places = async (): Promise<void> => {
      // §2-0: 알림 줄은 입력칸 자리(`chat-zone`) 안, 입력칸보다 위.
      const laneLine = page.locator('.chat-zone .zline').first()
      const composer = page.locator('.chat-composer')
      if (await laneLine.count() > 0) {
        const [line, box] = [await laneLine.boundingBox(), await composer.boundingBox()]
        expect(line && box && line.y + line.height <= box.y + 2, '알림 줄이 입력칸 아래로 내려갔다').toBe(true)
      }
      // §3: 카드는 대화 흐름(`chat-thread`) 안 — 입력칸 자리를 차지하지 않는다.
      if (await page.locator('.lane-card').count() > 0) {
        await expect(page.locator('.chat-thread .lane-card').first()).toBeVisible()
        await expect(page.locator('.chat-zone .lane-card')).toHaveCount(0)
      }
    }

    // ① 담당 진행 줄 + 미결 카드 줄
    const jobId = 'job-research-1'
    await inject(page, snapshot(root, 1, {
      lines: [
        progressLine('line-progress', jobId, 'research', '감초 도매·소매 가격 조사', 3, 1,
          { company: 'codex', model: 'astra', effort: null }),
        { kind: 'card-pending', tier: 5, id: 'line-card', at: at(4), dismissible: false, cardId: 'card-1' }
      ],
      stopButton: 'chat-and-lanes',
      announcement: { seq: 1, kind: 'started', lane: 'research', lineId: null }
    }))
    await expect(page.locator('.zline')).toHaveCount(2, { timeout: 15_000 })
    // §2-1 표 그대로: 제목 "자료 찾기 담당 · ChatGPT Astra", 작은 글 "{n}분째 · 다음 1건 기다림".
    await expect(page.locator('#line-progress')).toContainText('자료 찾기 담당 · ChatGPT Astra')
    await expect(page.locator('#line-progress small')).toContainText('분째 · 다음 1건 기다림')
    // 종류 2(미결 카드)가 종류 3(진행)과 다른 줄로, 진행이 위.
    const [progressBox, cardBox] = [await page.locator('#line-progress').boundingBox(), await page.locator('#line-card').boundingBox()]
    expect(progressBox && cardBox && progressBox.y < cardBox.y, '종류 3이 종류 5보다 위에 있어야 한다').toBe(true)
    await places()
    await shoot(page, 'lane-progress')

    // ② 처음 분담 카드 — 열림
    const openCard = firstCard('card-first', { kind: 'open' }, at(2))
    await inject(page, snapshot(root, 2, {
      cards: [{ ...openCard, root }],
      lines: [{ kind: 'card-pending', tier: 5, id: 'line-card', at: at(2), dismissible: false, cardId: 'card-first' }],
      announcement: { seq: 2, kind: 'line', lane: null, lineId: 'line-card' }
    }))
    await expect(page.locator('.lane-card:not(.folded)')).toBeVisible({ timeout: 15_000 })
    // §3-1 뼈대 순서: 제목 → 리드 → 바뀌는 줄 → 읽는 범위 → 요금 상자 → 단추 → 적용 범위.
    const card = page.locator('.lane-card:not(.folded)')
    await expect(card.locator('h3')).toHaveText('작업을 나눠 맡길까요?')
    await expect(card).toContainText('도우미 혼자 하던 일을 역할별로 나눠요. 검토는 늘 새 대화에서 해요.')
    await expect(card.locator('.lane-dl dt')).toHaveText(['자료 찾기', '글쓰기', '반복 작업', '검토'])
    await expect(card.locator('.lane-dl dd').first()).toHaveText('ChatGPT · Astra · 기본')
    await expect(card.locator('.chipref')).toContainText('아래 칩에서 골라요 — 추천 Claude Opus')
    // 읽기 범위는 "막는다"고 들리는 말을 쓰지 않는다(설계 §3 금지 문구).
    await expect(card).toContainText('담당은 파일을 읽을 수 있지만 논문 파일을 고치지는 못해요')
    await expect(card).not.toContainText('필요한 파일만')
    // 동의 안 한 회사가 끼면 요금 상자(§3 뼈대 6).
    await expect(card.locator('.lane-risk')).toContainText('ChatGPT 요금 안내에 아직 동의하지 않았어요')
    await expect(card.locator('.lane-actions button')).toHaveText(['이 배치로 계속', '이번만', '나눠 맡기지 않기'])
    // §3-1 뼈대 4: 적용 범위는 **단추 아래 한 곳**에만. 카드 본문(단추 위)에 또 있으면 문구가 두 번 읽힌다.
    const scopes = card.getByText(/^계속: 이 논문의 기본 배치가 돼요/)
    await expect(scopes, '적용 범위 줄이 카드에 두 번 나온다').toHaveCount(1)
    const [scopeBox, actsBox] = [await scopes.first().boundingBox(), await card.locator('.lane-actions').boundingBox()]
    expect(scopeBox && actsBox && scopeBox.y >= actsBox.y + actsBox.height - 1, '적용 범위 줄이 단추 위에 있다').toBe(true)
    await places()
    await shoot(page, 'lane-card-open')

    // ③ 같은 카드 — 접힘([자세히] 있는 한 줄)
    await inject(page, snapshot(root, 3, {
      cards: [{ ...firstCard('card-first', { kind: 'applied', scope: 'continue' }, at(2)), root }],
      lines: [],
      announcement: null,
      stopButton: 'chat'
    }))
    await expect(page.locator('.lane-card.folded')).toBeVisible({ timeout: 15_000 })
    // §3-5 접힘 — 적용한 줄과 범위가 한 줄에 남는다.
    await expect(page.locator('.lane-card.folded')).toContainText('작업 분담을 정했어요 — 자료 찾기 ChatGPT Astra · 글쓰기 ChatGPT Sol · 반복 작업 ChatGPT Terra · 검토 ChatGPT Astra (계속)')
    await expect(page.locator('.lane-card.folded').getByRole('button', { name: '자세히' })).toHaveAttribute('aria-expanded', 'false')
    await places()
    await shoot(page, 'lane-card-folded')

    // ④ 기록 줄 + 넘김 확인 불가 줄
    await inject(page, snapshot(root, 4, {
      events: [
        { kind: 'delivered', id: 'ev-1', at: at(7), jobId: 'job-1', lane: 'research', by: { company: 'codex', model: 'astra', effort: null }, continued: false, task: '감초 도매·소매 가격 조사' },
        { kind: 'review-skipped', id: 'ev-2', at: at(6), reason: 'lanes-off' },
        { kind: 'self-spawn', id: 'ev-3', at: at(5) }
      ],
      lines: [{
        kind: 'deliver-uncertain', tier: 2, id: 'line-uncertain', at: at(1), dismissible: true,
        jobId: 'job-2', lane: 'writing', detail: { jobId: 'job-2', status: 'unknown', reason: null, error: null, task: '3장 초안' },
        assignee: { company: 'codex', model: 'sol', effort: null }
      }],
      announcement: { seq: 3, kind: 'line', lane: null, lineId: 'line-uncertain' }
    }))
    await expect(page.locator('.chat-event')).toHaveCount(3, { timeout: 15_000 })
    // §2-2 표 문구 — 대화 흐름 안, 시각 순서(위가 먼저).
    const events = page.locator('.chat-thread .chat-event')
    await expect(events.nth(0)).toContainText('자료 찾기 담당(ChatGPT Astra)이 “감초 도매·소매 가격 조사”를 끝내 도우미에게 넘겼어요')
    await expect(events.nth(1)).toHaveClass(/warn/)
    await expect(events.nth(1)).toContainText('독립 검토를 하지 않았어요 — 나눠 맡기기를 안 씀')
    await expect(events.nth(2)).toContainText('ChatGPT가 스스로 하위 담당을 띄웠어요')
    // 넘김 확인 불가 줄은 종류 2 attn — 다시 넘기지 않으므로 단추는 [자세히]뿐이다.
    const uncertain = page.locator('#line-uncertain')
    await expect(uncertain).toContainText('글쓰기 결과를 도우미에게 넘겼는지 확인하지 못했어요')
    await expect(uncertain).toContainText('넘어갔을 수도 있어 다시 넘기지 않아요')
    expect(await uncertain.getByRole('button', { name: '다시 넘기기' }).count(), '확인 불가 줄에 다시 넘기기가 붙었다').toBe(0)
    await places()
    await shoot(page, 'lane-events')

    // ⑤ 본대화 한도 — 오류 줄을 대신하는 줄
    await inject(page, snapshot(root, 5, {
      lines: [{
        kind: 'main-limit-offer', tier: 2, id: 'line-main-limit', at: at(1), dismissible: false,
        proposalId: 'proposal-1',
        to: { company: 'codex', model: 'sol', effort: null },
        tooLong: false, trimmed: false
      }],
      events: [],
      announcement: { seq: 4, kind: 'line', lane: null, lineId: 'line-main-limit' }
    }))
    await expect(page.locator('.zline.attn')).toBeVisible({ timeout: 15_000 })
    const limit = page.locator('#line-main-limit')
    // §4-1 제목·작은 글 — 길이를 줄이지 않았으면 "내가 쓴 글과 마지막 답"(trimmed=false).
    await expect(limit).toContainText('한도에 걸렸어요 — ChatGPT Sol로 이어서 대화할까요?')
    await expect(limit.locator('small')).toContainText('ChatGPT 계정 사용량이 줄어요 · 이 대화에서 내가 쓴 글과 마지막 답을 ChatGPT에 넘겨요')
    await expect(limit.getByRole('button')).toHaveText(['자세히', '이어서 하기', '나중에'])
    // [자세히]를 펼치면 이어 받기 묶음 ①~⑤가 산문으로 나온다.
    await limit.getByRole('button', { name: '자세히' }).click()
    await expect(page.locator('.zline-raw')).toContainText('1. 내가 쓴 글 전부')
    await expect(page.locator('.zline-raw')).toContainText('5. 스킬 판')
    // 사진은 접힌 기본 모양으로 — 펼침은 위에서 이미 확인했다.
    await limit.getByRole('button', { name: '자세히' }).click()
    await expect(page.locator('.zline-raw')).toHaveCount(0)
    await places()
    await shoot(page, 'lane-main-limit')

    // ⑥ 한도로 멈춘 대화 보기 — 기록 줄 [멈춘 대화 보기] → 읽기 전용 화면
    const archive = {
      summary: {
        archiveId: 'archive-1', company: 'claude', model: 'opus',
        startedAt: at(70), stoppedAt: at(5), reason: 'limit',
        successorId: 'chat-2', successor: { company: 'codex', model: 'sol', effort: null }
      },
      messages: [
        { id: 'au1', role: 'user', text: '3장 시장 현황에 감초 가격 자료 좀 찾아 줘', at: at(70), delivery: 'sent' },
        { id: 'aa1', role: 'assistant', text: '네, 자료 찾기 담당에게 맡길게요. 끝나면 원문을 다시 확인해서 3장에 넣을게요.', at: at(69) }
      ]
    }
    await page.evaluate((value) => {
      window.dispatchEvent(new CustomEvent('knuaf:lanes-test-archive', { detail: value }))
    }, archive)
    await inject(page, snapshot(root, 6, {
      events: [{
        kind: 'handoff-done', id: 'ev-handoff', at: at(5),
        from: { company: 'claude', model: 'opus', effort: 'high' },
        to: { company: 'codex', model: 'sol', effort: null },
        archiveId: 'archive-1'
      }],
      lines: [progressLine('line-progress', 'job-3', 'writing', '3장 초안', 1, 0,
        { company: 'codex', model: 'sol', effort: null })],
      announcement: null
    }))
    const link = page.getByRole('button', { name: '멈춘 대화 보기' })
    await expect(link).toBeVisible({ timeout: 15_000 })
    await link.click()
    const banner = page.locator('.zline-wrap.stopped-banner')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    // 읽기 전용 화면이 실제로 그 대화를 그렸는가 — 단추만 있고 글이 비면 사진이 거짓말이 된다.
    await expect(banner).toContainText('한도로 멈춘 대화예요 · 읽기 전용')
    await expect(page.locator('.chat-thread')).toContainText('감초 가격 자료 좀 찾아 줘')
    await expect(page.locator('.chat-thread .chat-event.warn')).toContainText('한도로 멈췄어요')
    // 지금 대화의 작업 분담 줄은 숨는다(§4-2).
    await expect(page.locator('.zline.warn')).toHaveCount(0)
    await shoot(page, 'lane-stopped')
  })
})

test('설정 › 작업 분담', async () => {
  test.setTimeout(300_000)
  await open({}, async (page, root, app) => {
    await inject(page, snapshot(root, 1, {
      settings: {
        mode: 'on',
        source: { kind: 'recommended', rowId: 'claude-high-codex-low' },
        rows: [
          { lane: 'research', entry: { company: 'claude', model: 'sonnet', effort: null, how: 'relay' }, note: null, recommendedModel: 'sonnet' },
          { lane: 'writing', entry: { company: 'codex', model: 'terra', effort: null, how: 'relay' }, note: null, recommendedModel: 'terra' },
          { lane: 'repeat', entry: { company: 'codex', model: 'luna', effort: null, how: 'main' }, note: 'main-takeover', recommendedModel: 'luna' },
          { lane: 'review', entry: { company: 'claude', model: 'opus', effort: 'high', how: 'relay' }, note: null, recommendedModel: 'opus' }
        ],
        differsFromRecommendation: false,
        temporary: [{ lane: 'research', entry: { company: 'codex', model: 'astra', effort: null, how: 'relay' } }],
        recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' },
        nextDesignCompany: null,
        consents: [
          { company: 'codex', accountId: 'acc-codex', accountLabel: 'a…@gmail.com', state: 'agreed', at: at(60 * 30), subscribed: true },
          { company: 'claude', accountId: 'acc-claude', accountLabel: 'b…@naver.com', state: 'none', at: null, subscribed: true }
        ]
      }
    }))
    await page.getByRole('button', { name: '설정' }).first().click()
    await page.waitForSelector('dialog[open]', { timeout: 30_000 })
    await page.locator('dialog[open] nav').getByRole('button', { name: '작업 분담', exact: true }).click()
    await expect(page.locator('.lane-table')).toBeVisible({ timeout: 15_000 })

    // §5 표 — 머리 4칸, 줄 5개(설계 + 네 역할), 예외 줄은 값 칸이 글.
    const table = page.locator('.lane-table')
    await expect(table.locator('thead th')).toHaveText(['역할', '회사 · 모델', '깊이', '어디서'])
    await expect(table.locator('tbody tr')).toHaveCount(5)
    await expect(table.locator('tbody tr').nth(0)).toContainText('설계')
    await expect(table.locator('tbody tr').nth(1)).toContainText('자료 찾기')
    await expect(table.locator('tbody tr').nth(1)).toContainText('Claude · Sonnet')
    await expect(table.locator('tbody tr').nth(3).locator('.exc')).toContainText('도우미가 직접 맡아요 — 추천 모델(Luna)이 이 계정에 없어요')
    await expect(table.locator('tbody tr').nth(3).locator('td').nth(2)).toHaveText('—')
    // 출처·이번만 줄.
    await expect(page.locator('section.card:not([hidden])')).toContainText('추천 — Claude 높음 + ChatGPT 낮음')
    await expect(page.locator('section.card:not([hidden])')).toContainText('지금 이번 차례만: 자료 찾기 ChatGPT Astra (끝나면 위 배치로 돌아가요)')
    // §3-4 동의 두 줄 + 상태 글.
    await expect(page.locator('.set-row2')).toHaveCount(2)
    await expect(page.locator('.set-row2').nth(0)).toContainText('동의함')
    await expect(page.locator('.set-row2').nth(1)).toContainText('아직 안 함 — 처음 맡길 때 물어봐요')
    await shoot(page, 'lane-settings')

    // 좁은 창 — 앱 최소 폭(900)에서 표가 내용 칸을 넘지 않는가. §5 [r3 U6-07]의 "내용 칸 480px 미만"
    // 갈래는 창 폭으로는 닿지 않는다(설정 창 780 고정, 창 최소 900) → 확대로 그 폭을 만든다.
    await setWindowWidth(app, 900)
    await page.waitForTimeout(400)
    const wider = await page.evaluate(() => {
      const wrap = document.querySelector('.settings-wrap') as HTMLElement
      const body = wrap?.children[1] as HTMLElement
      const table = document.querySelector('.lane-table') as HTMLElement
      return {
        body: body?.getBoundingClientRect().width ?? 0,
        table: table?.getBoundingClientRect().width ?? 0,
        overflow: (body?.scrollWidth ?? 0) - (body?.clientWidth ?? 0)
      }
    })
    // 표는 내용 칸 안에 들어가고 가로로 넘치지 않는다(좁은 창에서 잘리면 값이 안 보인다).
    expect(wider.table, `표 ${wider.table}px > 내용 칸 ${wider.body}px`).toBeLessThanOrEqual(wider.body + 1)
    expect(wider.overflow, `내용 칸이 가로로 ${wider.overflow}px 넘쳤다`).toBeLessThanOrEqual(0)

    // 확대 → 내용 칸 실폭이 480 미만. 표가 줄마다 두 줄 카드로 바뀌고 머리는 숨는다.
    // CSS `zoom` 은 컨테이너 질의 폭에 반영되지 않는다 — Electron 줌으로 CSS 픽셀 자체를 줄인다.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.7) })
    await page.waitForTimeout(500)
    const narrow = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]') as HTMLElement
      const nav = document.querySelector('dialog[open] nav.settings-nav') as HTMLElement
      // 질의 기준은 설정 본문 칸(`container-type: inline-size`)이다 — 카드가 아니다.
      const body = (document.querySelector('.settings-wrap') as HTMLElement)?.children[1] as HTMLElement
      const tableEl = document.querySelector('.lane-table') as HTMLElement
      return {
        dialog: dialog?.getBoundingClientRect().width ?? 0,
        nav: nav?.getBoundingClientRect().width ?? 0,
        body: body?.getBoundingClientRect().width ?? 0,
        table: tableEl?.getBoundingClientRect().width ?? 0,
        bodyOverflow: (body?.scrollWidth ?? 0) - (body?.clientWidth ?? 0)
      }
    })
    console.log(`[lane-settings] dialog=${narrow.dialog} body=${narrow.body} nav=${narrow.nav} table=${narrow.table}`)
    expect(narrow.body, `확대 뒤 내용 칸이 ${narrow.body}px — 480 미만이어야 두 줄 갈래가 켜진다`).toBeLessThan(480)
    // 머리 줄은 눈에서만 숨는다(clip 1px) — `display:none` 이 아니라 상자 폭으로 확인한다.
    const head = await table.locator('thead').evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height, clip: getComputedStyle(el).clipPath || getComputedStyle(el).clip }
    })
    expect(head.width, `머리 줄이 ${head.width}px — 1px 로 접혀야 한다`).toBeLessThanOrEqual(1)
    expect(head.height, `머리 줄 높이 ${head.height}px`).toBeLessThanOrEqual(1)
    // 줄마다 두 줄: 첫 칸(역할)은 블록, 나머지 칸은 한 줄에 이어 붙는다.
    await expect(table.locator('tbody tr').nth(1).locator('td').nth(0)).toHaveCSS('display', 'block')
    await expect(table.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveCSS('display', 'inline')
    expect(narrow.nav, `분류 칸 ${narrow.nav}px — 156px 이어야 한다`).toBeLessThanOrEqual(160)
    expect(narrow.bodyOverflow, `두 줄 갈래에서 내용 칸이 가로로 ${narrow.bodyOverflow}px 넘쳤다`).toBeLessThanOrEqual(0)
    // 표가 내용 칸 안에 들어간다.
    expect(narrow.table, `표 ${narrow.table}px > 내용 칸 ${narrow.body}px`).toBeLessThanOrEqual(narrow.body + 1)
    await shoot(page, 'lane-settings-narrow')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1) })
  })
})
