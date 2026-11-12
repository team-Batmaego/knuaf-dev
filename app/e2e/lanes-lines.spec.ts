import { expect, test } from '@playwright/test'
import type { JobDetail, LaneEvent, LaneLine } from '../src/shared/lanes-ipc'
import { appliedText, entryText, eventView, isDirect, lineView, sayText, stopLabel, tierGroups } from '../src/renderer/src/laneLines'
import {
  LANE_CARD,
  LANE_EVENT,
  LANE_LINE,
  LANE_NAME,
  LANE_SAY,
  LANE_ACTION,
  LANE_STOP_LABEL,
  LANES_SETTINGS,
  clip,
  depthName,
  modelLabel,
  modelName,
  objectOf,
  subjectParticle,
  subjectOf,
  topicParticle
} from '../src/renderer/src/copy-lanes'

/**
 * 작업 분담 순수 함수(설계 §7) — 줄 하나가 **어느 문구·종류·단추**로 가는지만 잠근다.
 * 글 자체는 `copy-lanes.ts` 를 그대로 불러 비교하므로, 문구를 고치면 이 시험은 따라오고
 * 매핑이 틀어지면 깨진다.
 */

const NOW = Date.parse('2026-11-10T12:00:00+09:00')
const AT = '2026-11-10T11:30:00+09:00'

const detail: JobDetail = { jobId: 'job-1', status: 'error', reason: 'violation', error: 'boom', task: '요약' }

function line<T extends LaneLine['kind']>(kind: T, extra: Record<string, unknown> = {}): LaneLine {
  const base = {
    id: `line-${kind}`,
    tier: 3,
    at: AT,
    dismissible: true,
    jobId: 'job-1',
    lane: 'research' as const,
    assignee: { company: 'claude' as const, model: 'claude-sonnet-4', effort: 'default' },
    detail
  }
  const plain = { id: base.id, at: AT, dismissible: base.dismissible }
  const needsJob = !['review-missing', 'version-mismatch', 'card-pending', 'main-limit-offer', 'handoff-running', 'handoff-failed'].includes(kind)
  return { ...(needsJob ? base : plain), kind, ...extra } as unknown as LaneLine
}

test('진행 줄 — 단계마다 제목이 바뀌고 멈추는 중에는 단추가 없다', () => {
  const queued = line('progress', { phase: 'queued', startedAt: null, waiting: 2 })
  expect(lineView(queued, NOW).title).toBe(LANE_LINE.queued('자료 찾기'))
  expect(lineView(queued, NOW).sub).toBe('Claude Sonnet')

  const running = line('progress', { phase: 'running', startedAt: AT, waiting: 0 })
  const view = lineView(running, NOW)
  expect(view.title).toBe(LANE_LINE.running('자료 찾기', 'Claude Sonnet'))
  // 기다리는 주문이 없으면 작은 글을 비운다(제목에 이미 모델이 있다).
  expect(view.sub).toBeUndefined()
  expect(view.tone).toBe('wait')
  expect(view.actions).toEqual([{ id: 'stop-one', label: LANE_ACTION.stopOne }])
  expect(lineView(line('progress', { phase: 'running', startedAt: AT, waiting: 3 }), NOW).sub).toBe(LANE_LINE.elapsed(30, 3))

  expect(lineView(line('progress', { phase: 'continuing', startedAt: AT, waiting: 0 }), NOW).title)
    .toBe(LANE_LINE.continuing('자료 찾기', 'Claude Sonnet'))
  const stopping = lineView(line('progress', { phase: 'stopping', startedAt: AT, waiting: 0 }), NOW)
  expect(stopping.title).toBe(LANE_LINE.stopping('자료 찾기'))
  expect(stopping.actions).toEqual([])
})

test('넘기기 갈래 — 실패만 [다시 넘기기], 불확실은 단추 없이 ✕뿐', () => {
  const failed = lineView(line('deliver-failed', { tier: 2 }), NOW)
  expect(failed.title).toBe(LANE_LINE.deliverFailed('자료 찾기'))
  expect(failed.sub).toBe(LANE_LINE.keptResult)
  expect(failed.detail).toBeTruthy()
  expect(failed.actions).toEqual([{ id: 'redeliver', label: LANE_ACTION.redeliver }])
  expect(failed.tone).toBe('attn')
  // §2-1 표 순서: 실패 줄만 [다시 넘기기]가 [자세히]보다 앞이다.
  expect(failed.detailAfterActions).toBe(true)

  const uncertain = lineView(line('deliver-uncertain', { tier: 2 }), NOW)
  expect(uncertain.title).toBe(LANE_LINE.deliverUncertain('자료 찾기'))
  expect(uncertain.sub).toBe(LANE_LINE.deliverUncertainSub)
  expect(uncertain.actions).toEqual([])
  expect(uncertain.close).toBe(true)

  expect(lineView(line('delivering'), NOW).title).toBe(LANE_LINE.delivering('자료 찾기'))
})

test('한도 이어 하기 — [이어서 하기]가 앞의 primary, ✕는 없다', () => {
  const offer = line('limit-offer', {
    tier: 2,
    proposalId: 'p1',
    to: { company: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
    effortLowered: true,
    resetAt: null
  })
  const view = lineView(offer, NOW)
  expect(view.title).toBe(LANE_LINE.limitOffer('ChatGPT Sol', true))
  expect(view.sub).toBe([`자료 찾기 · ChatGPT 계정 사용량이 줄어요`, LANE_LINE.limitOfferFoot('자료 찾기')].join('\n'))
  expect(view.actions).toEqual([
    { id: 'continue', label: LANE_ACTION.continue, look: 'primary' },
    { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
  ])
  expect(view.close).toBe(false)

  const withReset = lineView({ ...offer, resetAt: '2026-11-10T15:00:00+09:00' } as LaneLine, NOW)
  expect(withReset.sub).toContain('한도 풀림 예정')

  const blocked = lineView(line('limit-blocked', { tier: 2, other: 'codex', reason: 'no-consent' }), NOW)
  expect(blocked.title).toBe(LANE_LINE.limitBlocked('자료 찾기'))
  expect(blocked.sub).toBe(LANE_LINE.limitBlockedReason['no-consent']('ChatGPT'))
  expect(blocked.actions).toEqual([])
})

test('나머지 담당 줄 — 종류·닫기 가능 여부가 계약대로다', () => {
  expect(lineView(line('continue-gone', { tier: 2 }), NOW).title).toBe(LANE_LINE.continueGone)
  expect(lineView(line('usage-unknown', { tier: 2 }), NOW).sub).toBe(LANE_LINE.usageUnknownSub)

  const auth = lineView(line('auth', { tier: 2 }), NOW)
  expect(auth.title).toBe(LANE_LINE.auth('자료 찾기', 'Claude'))
  expect(auth.actions.map((a) => a.id)).toEqual(['relogin', 'later'])
  expect(auth.close).toBe(false)

  const failed = lineView(line('failed', { tier: 2 }), NOW)
  expect(failed.title).toBe(LANE_LINE.failed('자료 찾기'))
  expect(failed.sub).toBe(LANE_LINE.failedSub)
  expect(failed.actions).toEqual([{ id: 'report', label: LANE_ACTION.report }])

  const interrupted = lineView(line('interrupted', { tier: 2 }), NOW)
  expect(interrupted.actions.map((a) => a.id)).toEqual(['retry', 'discard'])
  expect(interrupted.actions.every((a) => a.look === 'quiet')).toBe(true)

  expect(lineView(line('stopped', { tier: 4 }), NOW).title).toBe(LANE_LINE.stopped('자료 찾기'))

  const changed = lineView(line('folder-changed', { tier: 1 }), NOW)
  expect(changed.tone).toBe('bad')
  expect(changed.alert).toBe(true)
  expect(changed.sub).toBe(LANE_LINE.keptResult)
  // C06: 이 줄에도 [자세히]가 있어야 하고(예전에는 `detail` 자체가 없었다), 전달문을 읽을 주문이 남아야 한다.
  expect(changed.detail).toBe('오류 · violation\nboom')
  expect(changed.jobId).toBe('job-1')
})

test('검토 안내 — 사유마다 단추가 갈린다', () => {
  expect(lineView(line('review-missing', { tier: 4, reason: 'model-missing' }), NOW).actions)
    .toEqual([{ id: 'review-models', label: LANE_ACTION.reviewModels, look: 'quiet' }])
  expect(lineView(line('review-missing', { tier: 4, reason: 'lanes-off' }), NOW).actions)
    .toEqual([{ id: 'enable-lanes', label: LANE_ACTION.enableLanes, look: 'quiet' }])
  expect(lineView(line('review-missing', { tier: 4, reason: 'limit' }), NOW).actions).toEqual([])
  expect(lineView(line('version-mismatch', { tier: 4 }), NOW).title).toBe(LANE_LINE.versionMismatch)

  const pending = lineView(line('card-pending', { tier: 5, cardId: 'c1' }), NOW)
  expect(pending.actions).toEqual([{ id: 'show-card', label: LANE_ACTION.showCard }])
  expect(pending.close).toBe(false)
  expect(pending.tone).toBe('info')
})

test('본대화 한도 — 너무 길면 [새 대화로 시작] 하나, 아니면 [이어서 하기]', () => {
  const to = { company: 'codex' as const, model: 'gpt-6.1-sol', effort: 'low' }
  const long = lineView(line('main-limit-offer', { tier: 2, proposalId: 'p', to, tooLong: true, trimmed: false }), NOW)
  expect(long.title).toBe(LANE_LINE.mainLimitTooLong)
  expect(long.actions).toEqual([{ id: 'new-chat', label: LANE_ACTION.newChat, look: 'primary' }])
  expect(long.detail).toBeUndefined()

  for (const trimmed of [false, true]) {
    const view = lineView(line('main-limit-offer', { tier: 2, proposalId: 'p', to, tooLong: false, trimmed }), NOW)
    expect(view.title).toBe(LANE_LINE.mainLimit('ChatGPT Sol'))
    expect(view.sub).toBe(LANE_LINE.mainLimitSub('ChatGPT', trimmed))
    expect(view.detail).toBe(LANE_LINE.mainLimitDetail(trimmed))
    expect(view.actions.map((a) => a.id)).toEqual(['continue', 'later'])
    expect(view.close).toBe(false)
  }
  // 줄인 묶음은 "전부"라고 말하지 않는다 — 화면 문구가 아니라 계약 값 하나로만 갈린다.
  expect(LANE_LINE.mainLimitSub('ChatGPT', true)).not.toContain('내가 쓴 글과')
  expect(LANE_LINE.mainLimitDetail(true)).toContain('앞부분 일부는 빠져요')
  expect(LANE_LINE.mainLimitDetail(false).split('\n')).toHaveLength(5)
})

test('넘기기 진행·실패 줄 — 회사 이름만 끼고, 실패는 [다시 하기]', () => {
  const to = { company: 'codex' as const, model: 'gpt-6.1-sol', effort: null }
  const running = lineView(line('handoff-running', { tier: 3, to }), NOW)
  expect(running.title).toBe(LANE_LINE.handoffRunning('ChatGPT'))
  expect(running.tone).toBe('wait')

  const failed = lineView(line('handoff-failed', { tier: 2, proposalId: 'p', to }), NOW)
  expect(failed.title).toBe(LANE_LINE.handoffFailed('ChatGPT'))
  expect(failed.actions).toEqual([
    { id: 'continue', label: LANE_ACTION.retry, look: 'quiet' },
    { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
  ])
})

test('종류 묶기 — 빈 종류는 빼고 받은 차례를 지킨다', () => {
  const lines = [
    line('progress', { id: 'a', tier: 3, phase: 'running', startedAt: AT, waiting: 0 }),
    line('folder-changed', { id: 'b', tier: 1 }),
    line('progress', { id: 'c', tier: 3, phase: 'queued', startedAt: null, waiting: 0 }),
    line('card-pending', { id: 'd', tier: 5, cardId: 'x' })
  ]
  const groups = tierGroups(lines, NOW)
  expect(groups.map((g) => g.tier)).toEqual([1, 3, 5])
  expect(groups[1].lines.map(({ view }) => view.id)).toEqual(['a', 'c'])
  expect(groups.every((g) => g.lines.every(({ view }) => view.title.length > 0))).toBe(true)
  expect(tierGroups([], NOW)).toEqual([])
})

test('낭독 한 문장 — 사건이 없거나 가리키는 줄이 없으면 아무것도 읽지 않는다', () => {
  const lines = [line('progress', { id: 'p', tier: 3, phase: 'running', startedAt: AT, waiting: 0 })]
  expect(sayText(null, lines, NOW)).toBeNull()
  expect(sayText({ seq: 1, kind: 'started', lane: null, lineId: null }, lines, NOW)).toBeNull()
  expect(sayText({ seq: 1, kind: 'started', lane: 'review', lineId: null }, lines, NOW)).toBe(LANE_SAY.started(LANE_NAME.review))
  expect(sayText({ seq: 2, kind: 'delivered', lane: 'research', lineId: null }, lines, NOW)).toBe(LANE_SAY.delivered(LANE_NAME.research))
  expect(sayText({ seq: 3, kind: 'line', lane: null, lineId: 'p' }, lines, NOW)).toBe(LANE_LINE.running('자료 찾기', 'Claude Sonnet'))
  expect(sayText({ seq: 4, kind: 'line', lane: null, lineId: 'gone' }, lines, NOW)).toBeNull()
})

test('기록 줄 — 경고 표시와 "멈춘 대화 보기" 손잡이가 계약대로 붙는다', () => {
  const base = { id: 'e1', at: AT }
  const by = { company: 'claude' as const, model: 'claude-sonnet-4', effort: null }

  const delivered = eventView({ ...base, kind: 'delivered', jobId: 'j', lane: 'research', by, continued: false, task: '요약' })
  expect(delivered?.text).toBe(LANE_EVENT.delivered('자료 찾기', 'Claude Sonnet', '요약'))
  expect(delivered?.warn).toBe(false)
  expect(delivered?.at).toBe(Date.parse(AT))
  expect(delivered?.archiveId).toBeUndefined()
  // C06: 주문 번호를 줄까지 나른다 — 버리면 화면이 전달문을 읽을 길이 없다.
  expect(delivered?.jobId).toBe('j')

  const continued = eventView({ ...base, kind: 'delivered', jobId: 'j', lane: 'research', by, continued: true, task: '요약' })
  expect(continued?.text).toBe(LANE_EVENT.continued('자료 찾기', 'Claude Sonnet'))

  const notRun = eventView({ ...base, kind: 'not-run', jobId: 'j', lane: 'writing', reason: 'limit', task: 't' })
  expect(notRun?.text).toBe(LANE_EVENT.notRun('글쓰기', 'limit'))
  // 미실행 전달도 결과가 주문 칸에 남는다 — [자세히]가 그 전달문을 읽는다(설계 §2-1).
  expect(notRun?.jobId).toBe('j')

  const skipped = eventView({ ...base, kind: 'review-skipped', reason: 'model-missing' })
  expect(skipped?.warn).toBe(true)
  expect(skipped?.text).toBe(LANE_EVENT.reviewSkipped('model-missing'))

  expect(eventView({ ...base, kind: 'main-takeover', lane: 'repeat', model: 'gpt-6.1-luna' })?.text)
    .toBe(LANE_EVENT.mainTakeover('반복 작업'))
  expect(eventView({ ...base, kind: 'self-spawn' })?.text).toBe(LANE_EVENT.selfSpawn)
  expect(eventView({ ...base, kind: 'version-mismatch' })?.text).toBe(LANE_EVENT.versionMismatch)
  expect(eventView({ ...base, kind: 'once-ended', afterFirst: true })?.text).toBe(LANE_EVENT.onceEnded(true))
  expect(eventView({ ...base, kind: 'once-ended', afterFirst: false })?.text).toBe(LANE_EVENT.onceEnded(false))
  expect(eventView({ ...base, kind: 'lanes-declined' })?.text).toBe(LANE_EVENT.declined)

  const handoff = eventView({ ...base, kind: 'handoff-done', from: by, to: { company: 'codex', model: 'gpt-6.1-sol', effort: null }, archiveId: 'a1' })
  expect(handoff?.warn).toBe(true)
  expect(handoff?.archiveId).toBe('a1')
  expect(handoff?.text).toBe(LANE_EVENT.handoffDone('Claude', 'ChatGPT Sol'))

  // 모르는 사건은 그리지 않는다(옛 기록·새 판이 섞여도 화면이 깨지지 않게).
  expect(eventView({ ...base, kind: 'nope' } as unknown as LaneEvent)).toBeNull()
})

test('이름·조사·자르기 — 표 밖 이름도 읽을 수 있게', () => {
  expect(modelName('claude-sonnet-4')).toBe('Sonnet')
  expect(modelName('gpt-6.1-sol')).toBe('Sol')
  expect(modelName('gpt-6.1-astra')).toBe('Astra')
  expect(modelName(null)).toBe('')
  expect(modelLabel({ company: 'codex', model: 'gpt-6.1-luna' })).toBe('ChatGPT Luna')
  expect(modelLabel({ company: 'claude', model: null })).toBe('Claude')
  expect(depthName(null)).toBe('기본')
  expect(depthName('high')).toBeTruthy()

  expect(subjectParticle('Sol')).toBe('이')
  expect(subjectParticle('Astra')).toBe('가')
  expect(subjectParticle('Terra')).toBe('가')
  expect(subjectParticle('Data')).toBe('가')
  expect(subjectParticle('Chat')).toBe('이')
  expect(subjectOf('Opus')).toBe('Opus가')
  // 조사는 **끝 낱말**이 정한다 — "ChatGPT Astra"의 끝 글자 `t`가 아니라 `Astra`를 본다.
  expect(subjectOf('ChatGPT Astra')).toBe('ChatGPT Astra가')
  expect(subjectOf('ChatGPT Sol')).toBe('ChatGPT Sol이')
  expect(subjectOf('Claude Opus')).toBe('Claude Opus가')

  // C08 반례 — 괄호·숫자·영문 끝에서 옛 규칙이 틀린 조사를 찍었다.
  expect(subjectOf('Astra(아스트라)')).toBe('Astra(아스트라)가')
  expect(subjectOf('2')).toBe('2가')
  expect(objectOf('plan')).toBe('')
  expect(objectOf('1')).toBe('을')
  expect(objectOf('초안(수정본)')).toBe('을')
  expect(objectOf('감초 도매·소매 가격 조사')).toBe('를')
  expect(topicParticle('Sol')).toBe('은')
  expect(topicParticle('자료 찾기')).toBe('는')
  expect(topicParticle('반복 작업')).toBe('은')

  // 목적격·보조사는 한글 받침으로 고른다 — "조사"는 받침이 없어 `를`, "작업"은 있어 `은`.
  expect(LANE_EVENT.delivered('자료 찾기', 'ChatGPT Astra', '감초 도매·소매 가격 조사'))
    .toBe('자료 찾기 담당(ChatGPT Astra)이 “감초 도매·소매 가격 조사”를 끝내 도우미에게 넘겼어요')
  expect(LANE_EVENT.delivered('글쓰기', 'ChatGPT Sol', '3장 초안'))
    .toBe('글쓰기 담당(ChatGPT Sol)이 “3장 초안”을 끝내 도우미에게 넘겼어요')
  // 판정할 수 없는 영문 끝에는 조사를 붙이지 않는다 — 틀린 조사보다 조사 없음이 낫다.
  expect(LANE_EVENT.delivered('자료 찾기', 'ChatGPT Astra', 'draft plan'))
    .toBe('자료 찾기 담당(ChatGPT Astra)이 “draft plan” 끝내 도우미에게 넘겼어요')
  expect(LANE_EVENT.delivered('자료 찾기', 'ChatGPT Astra', '1'))
    .toBe('자료 찾기 담당(ChatGPT Astra)이 “1”을 끝내 도우미에게 넘겼어요')
  expect(LANE_LINE.limitOfferFoot('자료 찾기')).toBe('나중에: 이번 자료 찾기는 건너뛰어요')
  expect(LANE_LINE.limitOfferFoot('반복 작업')).toBe('나중에: 이번 반복 작업은 건너뛰어요')
  expect(LANE_EVENT.handoffEnd('ChatGPT Sol')).toBe('한도로 멈췄어요 — ChatGPT Sol이 이어 받았어요')
  expect(LANE_EVENT.continued('자료 찾기', 'Claude Sonnet')).toBe('자료 찾기를 Claude Sonnet이 이어 받아 끝내 도우미에게 넘겼어요')

  expect(clip('  여러   줄\n공백  ')).toBe('여러 줄 공백')
  expect(clip('가'.repeat(40))).toHaveLength(40)
  const long = clip('가'.repeat(50))
  expect(long).toHaveLength(40)
  expect(long.endsWith('…')).toBe(true)

  expect(stopLabel('chat-and-lanes', '멈추기')).toBe(LANE_STOP_LABEL)
  expect(stopLabel('chat', '멈추기')).toBe('멈추기')
})

test('설정 표 문구 — 설계 §5 원문 그대로', () => {
  expect(LANES_SETTINGS.designCell(null)).toBe('아래 칩에서 골라요')
  expect(LANES_SETTINGS.designCell('Claude Opus')).toBe('아래 칩에서 골라요 (추천 Claude Opus)')
  expect(LANES_SETTINGS.colLane).toBe('역할')
  expect(LANES_SETTINGS.colWhere).toBe('어디서')
  expect(LANES_SETTINGS.consentYes).toBe('동의')
})

test('C03: 카드 줄 문구 — 직접 맡기기와 새 대화를 실행 방식으로 구별한다', () => {
  // 설계 차선은 how:'main' 이면서 모델이 있다 — how 만 보면 설계 모델이 사라진다.
  expect(isDirect({ how: 'main', model: 'claude-opus-4' })).toBe(false)
  expect(isDirect({ how: 'main', model: null })).toBe(true)
  expect(isDirect({ how: 'sub', model: null })).toBe(false)
  expect(isDirect({ how: 'relay', model: null })).toBe(false)

  // 도우미가 직접 하는 줄: 회사·모델·깊이·"새 대화"가 모두 없다(설계 §5 "도우미가 직접 맡아요").
  const direct = entryText({ company: 'claude', model: null, effort: null, how: 'main' })
  expect(direct).toBe(LANE_CARD.direct)
  expect(direct).not.toContain('기본')
  expect(direct).not.toContain('새 대화')

  expect(entryText({ company: 'codex', model: 'gpt-6.1-astra', effort: 'high', how: 'sub' }))
    .toBe('ChatGPT · Astra · 높게 · 새 대화')
  // 추천 배치의 실제 값은 relay 다 — 카드에서도 새 대화로 적어야 표와 어긋나지 않는다(C2-V03).
  expect(entryText({ company: 'codex', model: 'gpt-6.1-astra', effort: 'high', how: 'relay' }))
    .toBe('ChatGPT · Astra · 높게 · 새 대화')
  expect(entryText({ company: 'claude', model: 'claude-opus-4', effort: 'high', how: 'main' }))
    .toBe('Claude · Opus · 높게')
  expect(entryText({ company: 'claude', model: null, effort: null, how: 'sub' }))
    .toBe('Claude · 기본 · 기본 · 새 대화')

  // 접힌 줄도 같은 판정을 쓴다 — "설계 Claude" 처럼 본대화 모델을 잃지 않는다.
  expect(appliedText('design', { company: 'claude', model: 'claude-opus-4', effort: 'high', how: 'main' }))
    .toBe('설계 Claude Opus')
  expect(appliedText('repeat', { company: 'claude', model: null, effort: null, how: 'main' }))
    .toBe(`반복 작업 ${LANE_CARD.direct}`)
})
