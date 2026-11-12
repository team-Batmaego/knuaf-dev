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
import { expectWindowInner, launch, openProject, setWindowBounds } from './helpers'
import { fakeCodexEnv, questionProject, scratch, seedChat, userDataWith } from './fixtures/fake-codex'
import {
  at, changeCard, firstCard, inject, installLanesSeam, laneCalls, MESSAGES, progressLine,
  releaseCardDecision, settingsCard, shoot, snapshot
} from './fixtures/lanes'

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
    /**
     * 검토 C07-⑤: 예전에는 `page.setViewportSize(1180×800)` 로 렌더러 뷰포트를 **고정**했다.
     * 그건 창 크기와 무관한 CDP 에뮬레이션이라, 나중에 창을 900×600 으로 줄여도 화면은 1180×800
     * 그대로였다 — 900×600 조건의 증거가 아니었다. 그래서 실제 창 크기로 맞춘다.
     */
    await setWindowBounds(electronApp, 1180, 800)
    await page.waitForTimeout(300)
    // 문서용 캡처는 불투명 사이드바로 남긴다(웹 레이어가 vibrancy 를 담지 못한다).
    await page.evaluate(() => { document.documentElement.dataset.vibrancy = 'off' })
    await openProject(page, root)
    await page.locator('.chat-msg').first().waitFor({ timeout: 30_000 })
    await after(page, root, electronApp)
  } finally {
    await electronApp.close()
  }
}

test('대화 장면 — 진행 줄 · 카드(열림/접힘) · 기록 줄 · 본대화 한도 · 멈춘 대화', async () => {
  test.setTimeout(300_000)
  await open({}, async (page, root) => {
    /*
     * 검토 C06 의 화면 증거 — 기록 줄 [자세히]가 **전달문 원문**까지 여는지 사진으로 남긴다.
     * preload 에 `lanes` 가 없으므로 이음매를 가짜로 갈아 끼우고 `jobs.deliveryText` 만 값을 준다.
     */
    const DELIVERY = '감초 도매·소매 가격 조사 결과\n- 도매 1kg 8,900원 · 소매 12,400원\n- 출처: 농림축산식품부 유통 실태 2026-10'
    await installLanesSeam(page, {
      card: firstCard('card-unused', { kind: 'open' }, at(2)),
      deliveryText: DELIVERY
    })

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
    // V03: `relay`(새 대화에 맡김)도 "새 대화"를 적는다 — 예전 값('ChatGPT · Astra · 기본')은 그 말이 빠져 있었다.
    await expect(card.locator('.lane-dl dd').first()).toHaveText('ChatGPT · Astra · 기본 · 새 대화')
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
    await expect(page.locator('.lane-folded')).toBeVisible({ timeout: 15_000 })
    // §3-5 접힘 — 적용한 줄과 범위가 한 줄에 남는다. 테두리 있는 카드가 아니라 기록 한 줄이다(검토 C2-V03).
    await expect(page.locator('.lane-folded')).toContainText('작업 분담을 정했어요 — 자료 찾기 ChatGPT Astra · 글쓰기 ChatGPT Sol · 반복 작업 ChatGPT Terra · 검토 ChatGPT Astra (계속)')
    await expect(page.locator('.lane-folded').getByRole('button', { name: '자세히' })).toHaveAttribute('aria-expanded', 'false')
    // V03 측정 단언 — 껍데기가 카드가 아니라 줄이다: 테두리·둥근 모서리·바탕 없음, 글리프는 14px 가운뎃점.
    const foldedBox = await page.locator('.lane-folded').evaluate((el) => {
      const s = getComputedStyle(el)
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, background: s.backgroundColor, display: s.display }
    })
    expect(foldedBox, '접힌 줄이 카드 상자를 유지한다').toMatchObject({ border: '0px', radius: '0px' })
    expect(foldedBox.background).toBe('rgba(0, 0, 0, 0)')
    expect(foldedBox.display).toBe('flex')
    const glyph = page.locator('.lane-folded > svg')
    await expect(glyph).toHaveAttribute('width', '14')
    await expect(glyph.locator('circle')).toHaveAttribute('r', '4')
    await expect(glyph.locator('path')).toHaveCount(0)
    // [자세히]를 열면 읽기 전용 표가 줄 아래로 내려온다 — 줄 자체는 그대로 남는다.
    await page.locator('.lane-folded').getByRole('button', { name: '자세히' }).click()
    await expect(page.locator('.lane-folded .lane-folded-body .lane-dl dt')).toHaveText(['자료 찾기', '글쓰기', '반복 작업', '검토'])
    await expect(page.locator('.lane-folded-body')).toHaveCSS('margin-left', '22px')
    await page.locator('.lane-folded').getByRole('button', { name: '접기' }).click()
    await expect(page.locator('.lane-folded-body')).toHaveCount(0)
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
    /*
     * V02 측정 단언 — 시안 `v07.r3.html:103` 은 경고 삼각형만 주황이고 **본문은 회청색 그대로**다.
     * 글자색을 직접 비교한다(사진으로는 구분되지 않는다). 글리프도 삼각형(`path`)이고 원이 아니다.
     */
    const [warnColor, plainColor] = await Promise.all([
      events.nth(1).evaluate((el) => getComputedStyle(el).color),
      events.nth(0).evaluate((el) => getComputedStyle(el).color)
    ])
    expect(warnColor, '경고 줄 본문까지 주황색이다').toBe(plainColor)
    const warnIcon = events.nth(1).locator('svg')
    expect(await warnIcon.locator('path').count(), '경고 줄 글리프에 삼각형이 없다').toBeGreaterThan(0)
    expect(await warnIcon.locator('circle').count(), '경고 줄 글리프가 원형이다').toBe(0)
    const warnIconColor = await warnIcon.evaluate((el) => getComputedStyle(el).color)
    expect(warnIconColor, '경고 글리프가 경고색이 아니다').not.toBe(warnColor)
    const plainIcon = events.nth(0).locator('svg')
    await expect(plainIcon.locator('circle')).toHaveAttribute('cx', '12')
    // 넘김 확인 불가 줄은 종류 2 attn — 다시 넘기지 않으므로 단추는 [자세히]뿐이다.
    const uncertain = page.locator('#line-uncertain')
    await expect(uncertain).toContainText('글쓰기 결과를 도우미에게 넘겼는지 확인하지 못했어요')
    await expect(uncertain).toContainText('넘어갔을 수도 있어 다시 넘기지 않아요')
    expect(await uncertain.getByRole('button', { name: '다시 넘기기' }).count(), '확인 불가 줄에 다시 넘기기가 붙었다').toBe(0)
    /*
     * 검토 C06 화면 증거 — 전달문 원문은 [자세히]로만 열린다. 받은 주문 번호를 그대로 읽으러 가는지
     * 호출 기록으로 잠그고, 편 원문을 사진으로 남긴다.
     */
    const delivered = events.nth(0)
    await delivered.getByRole('button', { name: '자세히' }).click()
    await expect(delivered.locator('.zline-raw')).toContainText('도매 1kg 8,900원 · 소매 12,400원')
    // 원문에는 40자로 접힌 주문 전문이 아니라 넘긴 글이 그대로 온다.
    await delivered.locator('.zline-raw').scrollIntoViewIfNeeded()
    await shoot(page, 'lane-events-delivery')
    expect((await laneCalls(page)).filter(([name]) => name === 'deliveryText')).toEqual([['deliveryText', root, 'job-1']])
    // 사진은 접힌 기본 모양으로 남긴다 — 펼침은 위 사진이 이미 증거다.
    await delivered.getByRole('button', { name: '자세히' }).click()
    await expect(delivered.locator('.zline-raw')).toHaveCount(0)
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

    /*
     * 시안 `mainlimittrim-light.png` — 길어서 묶음을 **줄여** 넘기는 갈래(계약 `trimmed:true`).
     * 검토가 "대응 사진 없음"으로 적은 장면이다. 문구가 "전부"라고 말하지 않는지 글자로 잰다.
     */
    await inject(page, snapshot(root, 6, {
      lines: [{
        kind: 'main-limit-offer', tier: 2, id: 'line-main-limit-trim', at: at(1), dismissible: false,
        proposalId: 'proposal-2',
        to: { company: 'codex', model: 'sol', effort: null },
        tooLong: false, trimmed: true
      }],
      events: [],
      announcement: { seq: 5, kind: 'line', lane: null, lineId: 'line-main-limit-trim' }
    }))
    const trim = page.locator('#line-main-limit-trim')
    await expect(trim).toBeVisible({ timeout: 15_000 })
    await expect(trim.locator('small')).toContainText('내가 쓴 글 일부(길어서 앞부분을 줄였어요)와 마지막 답을 ChatGPT에 넘겨요')
    await expect(trim).not.toContainText('내가 쓴 글과 마지막 답')
    await trim.getByRole('button', { name: '자세히' }).click()
    await expect(page.locator('.zline-raw')).toContainText('내가 쓴 글 — 길어서 앞부분 일부는 빠져요')
    await places()
    await shoot(page, 'lane-main-limit-trimmed')
    await trim.getByRole('button', { name: '자세히' }).click()

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
    await inject(page, snapshot(root, 7, {
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
    // 검토 C07-②: 예전 단언 `.zline.warn` 은 tone 이 `wait|bad|attn|info` 뿐이라 **항상 0**이었다
    // (always-pass). 방금 넣은 줄의 실제 id(`line-progress`)로 바꿔 "안내가 그대로 떠 있어도 통과"를 막는다.
    await expect(page.locator('#line-progress')).toHaveCount(0)
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
    /*
     * V01 측정 단언 — 시안 `settings-light.png` 는 "기본"·"높게"·"새 대화"가 **한 줄**이다.
     * `auto` 표에서는 긴 예외 설명이 남는 폭을 다 먹어 이 칸들이 "기/본" 으로 꺾였다.
     * 사진으로는 회귀를 못 잡으므로 글자의 **줄 상자 개수**를 센다. 칸 높이(padding 포함)로 재면
     * 한 줄짜리도 8px 패딩 두 번 때문에 줄 높이를 넘겨 늘 실패한다 — 범위 사각형으로 잰다.
     */
    const cellHeights = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.lane-table td.nw')).map((el) => {
        const td = el as HTMLElement
        const range = document.createRange()
        range.selectNodeContents(td)
        const tops = new Set<number>()
        for (const rect of Array.from(range.getClientRects())) tops.add(Math.round(rect.top))
        return {
          text: td.textContent ?? '',
          lines: tops.size,
          line: parseFloat(getComputedStyle(td).lineHeight) || 0,
          whiteSpace: getComputedStyle(td).whiteSpace
        }
      })
    })
    expect(cellHeights.length, '고정 폭 칸이 하나도 없다').toBeGreaterThan(0)
    for (const cell of cellHeights) {
      expect(cell.whiteSpace, `"${cell.text}" 칸이 줄바꿈을 허용한다`).toBe('nowrap')
      expect(cell.lines, `"${cell.text}" 칸이 ${cell.lines}줄(${cell.line}px)로 꺾였다`).toBe(1)
    }
    // 둘째 칸(회사 · 모델)이 남는 폭을 쓴다 — 고정 폭 합(19+12+16) 뒤 나머지.
    const columnWidths = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('.lane-table thead th'))
      return ths.map((th) => th.getBoundingClientRect().width)
    })
    expect(columnWidths[1], '회사 · 모델 칸이 가장 넓지 않다').toBeGreaterThan(columnWidths[0])
    expect(columnWidths[1], '회사 · 모델 칸이 가장 넓지 않다').toBeGreaterThan(columnWidths[2])
    expect(columnWidths[1], '회사 · 모델 칸이 가장 넓지 않다').toBeGreaterThan(columnWidths[3])
    await shoot(page, 'lane-settings')

    /*
     * 좁은 창 — 앱 최소 크기 900×600 에서 표가 내용 칸을 넘지 않는가. §5 [r3 U6-07]의 "내용 칸
     * 480px 미만" 갈래는 창 폭으로는 닿지 않는다(설정 창 780 고정, 창 최소 900) → 확대로 만든다.
     *
     * 검토 C07-⑤: 예전에는 폭만 900 으로 바꾸고 **높이는 그대로**였다. 이제 창 자체를 900×600 으로
     * 줄이고, 렌더러가 정말 그 크기를 받았는지 먼저 확인한다 — 확인 없이 재면 "600 높이에서도
     * 들어간다"는 증거가 아니라 옛 800 높이의 증거다.
     */
    await setWindowBounds(app, 900, 600)
    await expectWindowInner(page, 900, 600)
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
    await shoot(page, 'lane-settings-900x600')

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

    /*
     * 검토 C07-④ — 설계 §5 [r3d C2]: 900×600 + 확대 170%에서 ①제목·닫기가 **화면 안**,
     * ②동의 거두기·되돌리기 단추가 **스크롤로 닿음**, ③글자가 한 글자씩 꺾이지 않음.
     * 예전 시험은 ①을 안 보고 ②를 "표 폭"으로 대신했으며 ③은 아예 안 봤다.
     */
    const chrome = await page.evaluate(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const inside = (el: Element | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { inside: r.top >= -0.5 && r.left >= -0.5 && r.bottom <= vh + 0.5 && r.right <= vw + 0.5, w: r.width, h: r.height }
      }
      const body = (document.querySelector('.settings-wrap') as HTMLElement)?.children[1] as HTMLElement
      return {
        vw, vh,
        title: inside(document.querySelector('#settings-modal-title')),
        close: inside(document.querySelector('dialog[open] .sheet-head button[aria-label]')),
        body: inside(body),
        scrollable: body ? body.scrollHeight - body.clientHeight : 0
      }
    })
    // 확대 170%면 900 물리폭의 CSS 폭은 900/1.7 ≈ 529 다. 이 값이 안 줄었으면 확대가 안 먹은 것이고,
    // 그러면 아래 "화면 안" 단언은 옛 배율의 증거일 뿐이다.
    expect(chrome.vw, `뷰포트 CSS 폭 ${chrome.vw} — 확대 170% 가 안 먹었다`).toBeGreaterThan(450)
    expect(chrome.vw, `뷰포트 CSS 폭 ${chrome.vw} — 확대 170% 가 안 먹었다`).toBeLessThan(600)
    expect(chrome.title?.inside, `제목이 화면 밖(${JSON.stringify(chrome.title)})`).toBe(true)
    expect(chrome.close?.inside, `닫기 단추가 화면 밖(${JSON.stringify(chrome.close)})`).toBe(true)
    expect(chrome.body?.inside, `내용 칸이 화면 밖(${JSON.stringify(chrome.body)})`).toBe(true)
    expect(chrome.scrollable, '내용 칸이 스크롤되지 않는다 — 아래 단추에 닿을 수 없다').toBeGreaterThan(0)

    // ② 맨 아래 단추(동의 거두기·되돌리기 자리)까지 실제로 스크롤해서 닿는가. 스크롤 전에는 화면 밖이어야
    //    "스크롤로 닿음"이 뜻이 있다 — 이미 보이면 이 단언은 아무것도 안 잡는다.
    const reach = await page.evaluate(() => {
      const body = (document.querySelector('.settings-wrap') as HTMLElement)?.children[1] as HTMLElement
      const buttons = Array.from(body.querySelectorAll('button')).filter((b) => (b as HTMLButtonElement).offsetParent !== null && !(b as HTMLButtonElement).disabled)
      const last = buttons[buttons.length - 1] as HTMLButtonElement | undefined
      if (!body || !last) return null
      const before = last.getBoundingClientRect()
      const seen = before.top >= 0 && before.bottom <= window.innerHeight
      body.scrollTop = body.scrollHeight
      const after = last.getBoundingClientRect()
      return {
        label: last.textContent ?? '', seen,
        after: { top: after.top, bottom: after.bottom, left: after.left, right: after.right },
        vh: window.innerHeight, vw: window.innerWidth
      }
    })
    expect(reach, '내용 칸에 누를 수 있는 단추가 없다').not.toBeNull()
    expect(reach!.label.length, '맨 아래 단추 이름이 비었다').toBeGreaterThan(0)
    expect(reach!.after.bottom, `맨 아래 "${reach!.label}" 단추가 스크롤 뒤에도 화면 아래로 나갔다`).toBeLessThanOrEqual(reach!.vh + 0.5)
    expect(reach!.after.top, '맨 아래 단추가 스크롤 뒤에도 위로 잘렸다').toBeGreaterThanOrEqual(-0.5)
    expect(reach!.after.right, '맨 아래 단추가 오른쪽으로 나갔다').toBeLessThanOrEqual(reach!.vw + 0.5)

    // ③ 한 글자씩 세로로 꺾이지 않는가 — 한 글자씩 꺾이면 칸 높이가 글자 수만큼 줄 높이를 먹는다.
    const wrapped = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.lane-table td, .set-row2 .caption, .set-row2 .nm')).map((el) => {
        const r = el.getBoundingClientRect()
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20
        return { text: (el.textContent ?? '').slice(0, 24), lines: r.height / line, width: r.width }
      })
    })
    expect(wrapped.length, '한 글자 꺾임을 잴 칸이 없다').toBeGreaterThan(0)
    for (const cell of wrapped) {
      expect(cell.lines, `"${cell.text}" 가 ${cell.lines.toFixed(1)}줄(폭 ${cell.width}px) — 한 글자씩 꺾였다`)
        .toBeLessThanOrEqual(3)
    }

    await shoot(page, 'lane-settings-narrow')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1) })
  })
})

/*
 * 검토 C07-① — "카드 단추를 **실제로 눌러** 요청이 한 번만 나가고, 10초 동안 잠기고,
 * 늦은 응답 없이도 [다시 확인]으로 복구되고, 확인 창이 응답으로 접히는가"를 화면에서 잰다.
 *
 * `window.knuaf` 는 contextBridge 가 `SetReadOnlyNonConfigurable` + `DeepFreeze` 로 잠가 창 안에서
 * 갈아 끼울 수 없다. 그래서 제품 코드의 시험 이음매(`LANES_TEST_SEAM_EVENT`, `store/lanes.ts:167`)로
 * 가짜 `lanes`/`jobs` 를 넣는다 — 설계 §7 "실 AI 호출 없음(가짜 store 상태로 그림·e2e)" 범위 안이다.
 *
 * `decideCard` 는 **답하지 않는 Promise** 를 돌려준다. 그래야 "누른 뒤 잠김"과 10초 경보를 잡는다.
 */
test('대화 카드 — 실제 클릭 · 이중 클릭 · 10초 복구', async () => {
  test.setTimeout(300_000)
  await open({}, async (page, root) => {
    const first = { ...firstCard('card-first', { kind: 'open' }, at(2)), root }
    // `cardStatus` 응답도 이 카드를 돌려준다 — [다시 확인]이 다른 카드를 그리지 않게.
    await installLanesSeam(page, { card: first })
    await inject(page, snapshot(root, 10, {
      cards: [first],
      lines: [{ kind: 'card-pending', tier: 5, id: 'line-card', at: at(2), dismissible: false, cardId: 'card-first' }],
      announcement: { seq: 10, kind: 'line', lane: null, lineId: 'line-card' }
    }))
    const card = page.locator('.lane-card')
    await expect(card).toBeVisible({ timeout: 15_000 })

    const decided = async (): Promise<unknown[][]> =>
      (await laneCalls(page)).filter(([name]) => name === 'decideCard')

    // ① 한 번 누르면 그 한 번만 요청이 나간다 — 카드 id·baseVersion·동작이 함께 실린다.
    await card.getByRole('button', { name: '이 배치로 계속' }).click()
    await expect.poll(async () => (await decided()).length, { timeout: 10_000 }).toBe(1)
    expect(await decided()).toEqual([['decideCard', root, 'card-first', 1, 'continue']])
    // ② 답이 오기 전에는 단추가 전부 잠기고 "적용하는 중…" 이 붙는다(설계 §3-5).
    for (const button of await card.locator('.lane-actions button').all()) {
      expect(await button.isDisabled(), '결과를 받기 전에 단추가 열려 있다').toBe(true)
    }
    await expect(card.locator('[role=status]')).toHaveText('적용하는 중…')
    // ③ 이중 클릭 — 잠긴 단추를 마우스로 한 번 더 눌러도 요청은 늘지 않는다.
    const primary = card.locator('.lane-actions button').first()
    await primary.scrollIntoViewIfNeeded()
    const box = await primary.boundingBox()
    expect(box, '첫 단추 위치를 못 쟀다').not.toBeNull()
    const [x, y] = [box!.x + box!.width / 2, box!.y + box!.height / 2]
    await page.mouse.click(x, y)
    await page.mouse.click(x, y)
    await page.waitForTimeout(300)
    expect((await decided()).length, '이중 클릭으로 요청이 두 번 나갔다').toBe(1)
    // ④ 10초 무응답 — 다시 적용하지 않고 상태만 다시 묻는다. 단추는 여전히 잠긴다.
    const alert = card.locator('[role=alert]')
    await expect(alert).toContainText('적용됐는지 확인하지 못했어요', { timeout: 15_000 })
    // [다시 확인]은 `.lane-actions` **밖**의 작은 단추다(설계 §3-5 — 승인 단추 자리에 끼우지 않는다).
    await expect(alert.locator('.lk')).toHaveText('다시 확인')
    expect(await card.locator('.lane-actions button').first().isDisabled(), '10초 뒤 승인 단추가 다시 열렸다').toBe(true)
    await alert.locator('.lk').click()
    await expect.poll(async () => (await laneCalls(page)).filter(([name]) => name === 'cardStatus').length, { timeout: 10_000 }).toBe(1)
    expect((await laneCalls(page)).filter(([name]) => name === 'cardStatus')).toEqual([['cardStatus', root, 'card-first']])
    expect((await decided()).length, '[다시 확인]이 승인 요청을 다시 보냈다').toBe(1)
    await expect(alert).toBeVisible()

    /*
     * ⑤ 늦게 온 응답 — `Chat.tsx:443-446` 은 `decideCard` 응답을 **버린다**(대화 카드는 밀려온
     * 묶음이 그린다). 그래서 답을 줘도 화면은 그대로여야 하고, 접힘은 재주입으로만 그려진다.
     */
    await releaseCardDecision(page, {
      result: { outcome: 'applied', reason: null, card: { ...first, state: { kind: 'applied', scope: 'continue' } }, boundTurn: null }
    })
    await page.waitForTimeout(500)
    expect(await page.locator('.lane-card').count(), '대화 카드가 응답만으로 접혔다(응답은 버려야 한다)').toBe(1)

    await inject(page, snapshot(root, 11, {
      cards: [{ ...first, state: { kind: 'applied', scope: 'continue' } }],
      lines: [],
      announcement: null
    }))
    const folded = page.locator('.lane-folded')
    await expect(folded).toBeVisible({ timeout: 15_000 })
    await expect(folded).toContainText('작업 분담을 정했어요 — 자료 찾기 ChatGPT Astra · 글쓰기 ChatGPT Sol · 반복 작업 ChatGPT Terra · 검토 ChatGPT Astra (계속)')
    // 접힌 줄의 [자세히]로 초점이 옮겨진다(LanePlanCard.tsx:41-43).
    await expect(folded.getByRole('button', { name: '자세히' })).toBeFocused()
    await shoot(page, 'lane-card-clicked')

    /*
     * ⑥ 배치 바꾸기(§3-2) — 승인 전 카드가 실제로 바뀌는 값을 보이는가(검토 C03·C09).
     * 같은 창에서 묶음만 갈아 끼운다(주입 통로는 장면 사이 전환을 이미 할 수 있다).
     */
    const change = { ...changeCard('card-change', { kind: 'open' }, at(2)), root }
    await inject(page, snapshot(root, 12, { cards: [change], lines: [], announcement: null }))
    const changeView = page.locator('.lane-card')
    await expect(changeView.locator('h3')).toHaveText('작업 분담을 이렇게 바꿀까요?', { timeout: 15_000 })
    // 인용은 40자 이하라 [전체 보기]가 붙지 않는다(붙으면 읽기 범위 [자세히]와 헷갈린다 — 검토 C09).
    await expect(changeView.locator('.quote')).toHaveText('내가 한 말: “자료는 Sonnet으로 하고 검토는 그대로 둬”')
    expect(await changeView.locator('.quote button').count(), '짧은 인용에 [전체 보기]가 붙었다').toBe(0)
    // 실제로 바뀌는 줄 수(3)가 단추에 실린다 — 거절 1줄은 빠진다.
    await expect(changeView.locator('.lane-actions button')).toHaveText(['3개 바꾸기 · 계속', '3개 바꾸기 · 이번만', '취소'])
    await expect(changeView.locator('.lane-dl dt')).toHaveText(['자료 찾기', '글쓰기', '반복 작업', '검토'])
    // 설계 줄이 없는 카드라도 각 줄의 전 → 후가 그대로 보인다(검토 C03).
    const firstRow = changeView.locator('.lane-dl dd').nth(0)
    await expect(firstRow.locator('.was')).toHaveText('ChatGPT · Astra · 기본 · 새 대화')
    await expect(firstRow).toContainText('Claude · Sonnet · 기본 · 새 대화')
    expect(await changeView.locator('.lane-dl dd .was').count(), '바뀌기 전 값이 빠졌다').toBe(3)
    expect(await changeView.locator('.lane-dl dd .arrow').count(), '전 → 후 화살표가 빠졌다').toBe(3)
    // 거절 줄은 사유까지 한 문장으로.
    await expect(changeView.locator('.lane-dl dd.rej')).toHaveText('적용 안 함 — 구독 로그인이 아니라 이 회사는 쓰지 않아요')
    await expect(changeView.locator('.lane-dl dd.rej svg')).toHaveCount(1)
    // 이미 동의한 회사만 있으면 상자 전체가 아니라 한 줄 안내다(계약 `FeeNotice.consented`).
    await expect(changeView.locator('.lane-risk')).toContainText('Claude(b…@naver.com) 요금 안내에 이미 동의했어요 — 모든 논문에 적용돼요')
    await shoot(page, 'lane-card-change')
    // 바꾸기 카드도 같은 승인 통로 — 판(`baseVersion` 3)과 동작이 그대로 실린다.
    await changeView.getByRole('button', { name: '3개 바꾸기 · 계속' }).click()
    await expect.poll(async () => (await decided()).length, { timeout: 10_000 }).toBe(2)
    expect((await decided())[1]).toEqual(['decideCard', root, 'card-change', 3, 'continue'])

    /*
     * ⑦ 무효 접힘 — 계정이 바뀐 카드는 **다른 한 줄**로 접힌다(설계 §3-5 [r3c C0]).
     * 사유는 묶음에 실리지 않고 `decideCard` 응답에만 오므로(`store/lanes.ts:251-258`) 실제로 눌러 받는다.
     */
    const doomed = { ...firstCard('card-invalid', { kind: 'open' }, at(2)), root }
    await inject(page, snapshot(root, 13, { cards: [doomed], lines: [], announcement: null }))
    const doomedCard = page.locator('.lane-card')
    await expect(doomedCard.locator('h3')).toBeVisible({ timeout: 15_000 })
    await expect(doomedCard.getByRole('button', { name: '이 배치로 계속' })).toBeVisible()
    await doomedCard.getByRole('button', { name: '이 배치로 계속' }).click()
    await expect.poll(async () => (await decided()).length, { timeout: 10_000 }).toBe(3)
    expect((await decided())[2]).toEqual(['decideCard', root, 'card-invalid', 1, 'continue'])
    await releaseCardDecision(page, {
      result: {
        outcome: 'invalid', reason: 'account-changed',
        card: { ...doomed, state: { kind: 'invalid' } }, boundTurn: null
      }
    })
    // 응답은 버려지므로 화면은 재주입으로만 접힌다. 접힘 문구는 store 의 `invalid` 사유를 고른다.
    await inject(page, snapshot(root, 14, {
      cards: [{ ...doomed, state: { kind: 'invalid' } }], lines: [], announcement: null
    }))
    await expect(page.locator('.lane-folded')).toContainText(
      '로그인 계정이 바뀌어 이 카드는 쓸 수 없어요 — 다시 맡기면 새 카드로 물어봐요',
      { timeout: 15_000 }
    )
    await expect(page.locator('.lane-folded')).not.toContainText('이미 처리됐거나')
    await shoot(page, 'lane-card-invalid')
  })
})

/*
 * 검토 C07-①(설정 갈래) — 설정 확인 창은 반대로 **응답으로 접힌다**(`LanesSettings.tsx:104-115`
 * `setCard(decision.card)`). 카드가 `snapshot.cards` 에 오지 않는 갈래(계약 §3 [F5])라서다.
 */
test('설정 카드 — 실제 클릭 · 응답으로 접힘 · 초점 복귀', async () => {
  test.setTimeout(300_000)
  await open({}, async (page, root) => {
    const snap = snapshot(root, 20, {
      settings: {
        mode: 'off',
        source: { kind: 'recommended', rowId: 'claude-high-codex-low' },
        rows: [],
        differsFromRecommendation: false,
        temporary: [],
        recommendedDesign: { company: 'claude', model: 'opus', effort: 'high' },
        nextDesignCompany: null,
        consents: []
      }
    })
    await installLanesSeam(page, { card: settingsCard({ kind: 'open' }), snapshot: snap })
    await inject(page, snap)

    await page.getByRole('button', { name: '설정' }).first().click()
    await page.waitForSelector('dialog[data-screen="settings"][open]', { timeout: 30_000 })
    await page.locator('dialog[data-screen="settings"] nav').getByRole('button', { name: '작업 분담', exact: true }).click()
    // 꺼짐 상태여야 [나눠 맡기기 켜기] 하나만 그린다(켜짐이면 표가 먼저 온다).
    const turnOn = page.getByRole('button', { name: '나눠 맡기기 켜기' })
    await expect(turnOn).toBeVisible({ timeout: 15_000 })
    await turnOn.click()
    await page.waitForSelector('dialog[data-screen="lane-settings-card"][open]', { timeout: 15_000 })

    const sheet = page.locator('dialog[data-screen="lane-settings-card"]')
    await expect(sheet.locator('.lane-card h3')).toHaveText('작업을 나눠 맡길까요?')
    await expect(sheet.locator('.lane-actions button')).toHaveText(['계속', '취소'])
    // 카드가 제목을 직접 그리므로 시트 머리 글자는 비어 있다(제목이 두 번 읽히지 않는다).
    await expect(sheet.locator('.sheet-head h2')).toHaveText('')
    await expect(sheet.locator('.lane-folded')).toHaveCount(0)
    expect((await laneCalls(page)).filter(([name]) => name === 'settingsCard')).toEqual([['settingsCard', root, 'enable']])

    // [계속] — 카드의 `baseVersion`(4)이 그대로 실린다. 카드는 응답으로 접힌다.
    await sheet.getByRole('button', { name: '계속' }).click()
    await expect.poll(async () => (await laneCalls(page)).filter(([name]) => name === 'decideCard').length, { timeout: 10_000 }).toBe(1)
    expect((await laneCalls(page)).filter(([name]) => name === 'decideCard')).toEqual([['decideCard', root, 'card-settings-1', 4, 'continue']])
    await expect(sheet.locator('[role=status]')).toHaveText('적용하는 중…')
    await releaseCardDecision(page, {
      result: {
        outcome: 'applied', reason: null,
        card: { ...settingsCard({ kind: 'applied', scope: 'continue' }), root },
        boundTurn: null
      }
    })
    const folded = sheet.locator('.lane-folded')
    await expect(folded).toBeVisible({ timeout: 15_000 })
    await expect(folded).toContainText('작업 분담을 정했어요 — 자료 찾기 ChatGPT Astra · 글쓰기 ChatGPT Sol · 반복 작업 ChatGPT Terra · 검토 ChatGPT Astra (계속)')
    await shoot(page, 'lane-settings-card')

    // 닫으면 누른 설정 단추로 초점이 돌아온다(설계 §3-5). `closeCard` 의 동기 focus 는 modal 중
    // 무시되지만, dialog 가 닫힐 때 브라우저가 showModal 직전 초점(=누른 단추)을 복원한다.
    await sheet.locator('.sheet-head button[aria-label="닫기"]').click()
    // `Sheet` 는 dialog 를 늘 그려 두고 `close()` 만 부른다 — 사라지는 것이 아니라 닫히는 것이다.
    await expect(sheet).toBeHidden()
    await expect(turnOn).toBeFocused()
  })
})
