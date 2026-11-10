import type { LaneAnnouncement, LaneLine, LaneEvent } from '../../shared/lanes-ipc'
import type { LaneRejectReason } from '../../shared/lanes'
import type { JobLane } from '../../shared/lanes-ipc'
import type { ZoneTone } from './components/ZoneLine'
import {
  JOB_STATUS_NAME,
  LANE_EVENT,
  LANE_LINE,
  LANE_NAME,
  LANE_SAY,
  LANE_ACTION,
  LANE_STOP_LABEL,
  clockKo,
  minutesSince,
  modelLabel,
  providerName,
  subjectOf
} from './copy-lanes'

/**
 * 작업 분담 알림 줄 — **순수 함수**만. 상태를 들지 않고 `LanesSnapshot` 조각 + 지금 시각으로
 * 그릴 값을 만든다(시험은 이 파일만 부른다, 설계 §7).
 *
 * 순서는 main이 이미 정해 보낸다(`LANE_IPC` §4 "main이 이미 정렬"). 화면은 종류(1~5)로 묶어
 * 종류마다 한 줄만 보이고 나머지는 [n건 더 보기] 뒤에 두는 **표시 규칙**만 더한다(§2-0).
 */

/** 단추 하나 — 그리기는 컴포넌트가, 뜻은 id가 정한다. */
export type LaneActionId =
  | 'stop-one'
  | 'redeliver'
  | 'continue'
  | 'later'
  | 'relogin'
  | 'retry'
  | 'discard'
  | 'report'
  | 'show-card'
  | 'review-models'
  | 'enable-lanes'
  | 'new-chat'
  /** ✕ — 줄을 닫는다(`dismiss`). */
  | 'dismiss'

export interface LaneActionView {
  id: LaneActionId
  label: string
  /** `primary`·`quiet` — 시안 `.zline button.primary` / `.quiet`(설계 §4: 이어서=primary, 나중에=quiet). */
  look?: 'primary' | 'quiet'
}

export interface LaneLineView {
  id: string
  /** 줄 id 중복 방지 — 같은 종류가 여럿일 때. */
  tone: ZoneTone
  title: string
  /** 작은 글. `\n` 은 줄바꿈(`<br>`)으로 그린다. */
  sub?: string
  /** [자세히] 로 펼칠 산문(원문 오류·이어 받기 묶음). */
  detail?: string
  actions: LaneActionView[]
  /** ✕ — main이 `dismissible:false` 라고 한 줄은 닫을 수 없다(card-pending). */
  close: boolean
  /** 막힘(종류 1)만 줄 자체가 `role="alert"` — 낭독 칸과 겹치지 않게 나머지는 역할 없음. */
  alert: boolean
}

/** 한 종류(1~5)의 줄 묶음. 앞의 하나만 보이고 나머지는 펼침 뒤에 있다. */
export interface LaneTierView {
  tier: 1 | 2 | 3 | 4 | 5
  lines: { view: LaneLineView; line: LaneLine }[]
}

const TIER_TONE: Record<1 | 2 | 3 | 4 | 5, ZoneTone> = { 1: 'bad', 2: 'attn', 3: 'wait', 4: 'info', 5: 'info' }

/** "[자세히]" 안 — 상태·사유·원문(파일은 열지 않음). */
export function detailText(detail: { status: string; reason: string | null; error: string | null }): string {
  const head = JOB_STATUS_NAME[detail.status as keyof typeof JOB_STATUS_NAME] ?? detail.status
  const lines = [detail.reason ? `${head} · ${detail.reason}` : head]
  if (detail.error) lines.push(detail.error)
  return lines.join('\n')
}

/**
 * 줄 하나 → 그릴 값. `now` 는 "{n}분째"만 쓴다(낭독 칸 밖).
 */
export function lineView(line: LaneLine, now: number): LaneLineView {
  const base = {
    id: line.id,
    tone: TIER_TONE[line.tier],
    close: line.dismissible,
    alert: line.tier === 1,
    actions: [] as LaneActionView[]
  }
  // 주문에 묶인 줄만 담당·역할이 있다. 나머지(검토 안내·카드 미결·본대화 한도)는 각 갈래가 직접 짓는다.
  const model = 'assignee' in line ? modelLabel(line.assignee) : ''
  const lane = 'lane' in line ? LANE_NAME[line.lane] : ''
  switch (line.kind) {
    case 'progress': {
      const minutes = minutesSince(line.startedAt, now)
      const waiting = line.waiting > 0 ? LANE_LINE.elapsed(minutes ?? 0, line.waiting) : undefined
      const title =
        line.phase === 'queued'
          ? LANE_LINE.queued(lane)
          : line.phase === 'running'
            ? LANE_LINE.running(lane, model)
            : line.phase === 'continuing'
              ? LANE_LINE.continuing(lane, model)
              : LANE_LINE.stopping(lane)
      return {
        ...base,
        tone: 'wait',
        title,
        sub: line.phase === 'queued' ? model : waiting,
        actions: line.phase === 'stopping' ? [] : [{ id: 'stop-one', label: LANE_ACTION.stopOne }]
      }
    }
    case 'delivering':
      return { ...base, tone: 'wait', title: LANE_LINE.delivering(lane) }
    case 'deliver-failed':
      return {
        ...base,
        title: LANE_LINE.deliverFailed(lane),
        sub: LANE_LINE.keptResult,
        detail: detailText(line.detail),
        actions: [{ id: 'redeliver', label: LANE_ACTION.redeliver }]
      }
    case 'limit-offer': {
      const reset = line.resetAt ? LANE_LINE.limitOfferSub(lane, providerName(line.to.company), providerName(line.assignee.company), line.resetAt) : null
      const head = reset ?? [lane, `${providerName(line.to.company)} 계정 사용량이 줄어요`].join(' · ')
      return {
        ...base,
        title: LANE_LINE.limitOffer(modelLabel(line.to), line.effortLowered),
        sub: [head, LANE_LINE.limitOfferFoot(lane)].join('\n'),
        actions: [
          { id: 'continue', label: LANE_ACTION.continue, look: 'primary' },
          { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
        ],
        close: false
      }
    }
    case 'limit-blocked':
      return {
        ...base,
        title: LANE_LINE.limitBlocked(lane),
        sub: LANE_LINE.limitBlockedReason[line.reason](providerName(line.other))
      }
    case 'continue-gone':
      return { ...base, title: LANE_LINE.continueGone }
    case 'usage-unknown':
      return {
        ...base,
        title: LANE_LINE.usageUnknown(lane, providerName(line.assignee.company)),
        sub: LANE_LINE.usageUnknownSub
      }
    case 'auth':
      return {
        ...base,
        title: LANE_LINE.auth(lane, providerName(line.assignee.company)),
        actions: [
          { id: 'relogin', label: LANE_ACTION.relogin },
          { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
        ],
        close: false
      }
    case 'failed':
      return {
        ...base,
        title: LANE_LINE.failed(lane),
        sub: LANE_LINE.failedSub,
        detail: detailText(line.detail),
        actions: [{ id: 'report', label: LANE_ACTION.report }]
      }
    case 'interrupted':
      return {
        ...base,
        title: LANE_LINE.interrupted(lane),
        sub: LANE_LINE.interruptedSub,
        actions: [
          { id: 'retry', label: LANE_ACTION.retry, look: 'quiet' },
          { id: 'discard', label: LANE_ACTION.discard, look: 'quiet' }
        ]
      }
    case 'stopped':
      return { ...base, title: LANE_LINE.stopped(lane) }
    case 'folder-changed':
      return {
        ...base,
        title: LANE_LINE.folderChanged(lane),
        sub: LANE_LINE.keptResult,
        actions: [{ id: 'report', label: LANE_ACTION.report }]
      }
    case 'review-missing':
      return {
        ...base,
        title: LANE_LINE.reviewMissing,
        actions:
          line.reason === 'model-missing'
            ? [{ id: 'review-models', label: LANE_ACTION.reviewModels, look: 'quiet' }]
            : line.reason === 'lanes-off'
              ? [{ id: 'enable-lanes', label: LANE_ACTION.enableLanes, look: 'quiet' }]
              : []
      }
    case 'version-mismatch':
      return { ...base, title: LANE_LINE.versionMismatch }
    case 'card-pending':
      return {
        ...base,
        title: LANE_LINE.cardPending,
        actions: [{ id: 'show-card', label: LANE_ACTION.showCard }],
        close: false
      }
    case 'main-limit-offer': {
      if (line.tooLong) {
        return {
          ...base,
          title: LANE_LINE.mainLimitTooLong,
          actions: [{ id: 'new-chat', label: LANE_ACTION.newChat, look: 'primary' }],
          close: false
        }
      }
      return {
        ...base,
        title: LANE_LINE.mainLimit(modelLabel(line.to)),
        sub: LANE_LINE.mainLimitSub(providerName(line.to.company)),
        detail: LANE_LINE.mainLimitDetail,
        actions: [
          { id: 'continue', label: LANE_ACTION.continue, look: 'primary' },
          { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
        ],
        close: false
      }
    }
    case 'handoff-running':
      return { ...base, tone: 'wait', title: LANE_LINE.handoffRunning(providerName(line.to.company)) }
    case 'handoff-failed':
      return {
        ...base,
        title: LANE_LINE.handoffFailed(providerName(line.to.company)),
        actions: [
          { id: 'continue', label: LANE_ACTION.retry, look: 'quiet' },
          { id: 'later', label: LANE_ACTION.later, look: 'quiet' }
        ],
        close: false
      }
  }
}

/**
 * 종류 1~5 순서로 묶는다. main이 이미 정렬했으므로 **받은 차례를 지키고**, 빈 종류는 뺀다.
 */
export function tierGroups(lines: LaneLine[], now: number): LaneTierView[] {
  const groups: LaneTierView[] = []
  for (const tier of [1, 2, 3, 4, 5] as const) {
    const view = lines.filter((line) => line.tier === tier).map((line) => ({ view: lineView(line, now), line }))
    if (view.length > 0) groups.push({ tier, lines: view })
  }
  return groups
}

/** `[n건 더 보기]` — ✕ 옆 작은 단추(§2-0). */
export function moreLabel(count: number): string {
  return `${count}건 더 보기`
}

/** 펼친 뒤 [접기]. */
export const LESS_LABEL = '접기'

/**
 * 낭독 칸 한 문장 — `announcement.seq` 가 바뀔 때만 부른다(§2-1 U6-05).
 * 경과 시간·대기 개수는 넣지 않는다(그 변화로는 `seq` 가 오르지 않는다).
 */
export function sayText(announcement: LaneAnnouncement | null, lines: LaneLine[], now: number): string | null {
  if (!announcement) return null
  if (announcement.kind === 'started') {
    return announcement.lane ? LANE_SAY.started(LANE_NAME[announcement.lane]) : null
  }
  if (announcement.kind === 'delivered') {
    return announcement.lane ? LANE_SAY.delivered(LANE_NAME[announcement.lane]) : null
  }
  const line = announcement.lineId ? lines.find((item) => item.id === announcement.lineId) : undefined
  return line ? lineView(line, now).title : null
}

/** 입력칸 ■의 이름 — 담당 진행 줄이 있으면 둘 다 멈춘다(§2-1 [r2 W25]). */
export function stopLabel(stopButton: 'chat' | 'chat-and-lanes', fallback: string): string {
  return stopButton === 'chat-and-lanes' ? LANE_STOP_LABEL : fallback
}

// =====================================================================================
// §2-2 기록 줄 — 대화 흐름 안 `chat-event`
// =====================================================================================

export interface LaneEventView {
  id: string
  at: number
  /** ⚠ 붙는 경고인가(`.chat-event .warn`). */
  warn: boolean
  text: string
  /** "멈춘 대화 보기" — 이어 받은 뒤 첫 줄에서 옛 대화를 연다. */
  archiveId?: string
}

export function eventView(event: LaneEvent): LaneEventView | null {
  const at = Date.parse(event.at) || 0
  switch (event.kind) {
    case 'delivered':
      return {
        id: event.id,
        at,
        warn: false,
        text: event.continued
          ? LANE_EVENT.continued(LANE_NAME[event.lane], modelLabel(event.by))
          : LANE_EVENT.delivered(LANE_NAME[event.lane], modelLabel(event.by), event.task)
      }
    case 'not-run':
      return { id: event.id, at, warn: false, text: LANE_EVENT.notRun(LANE_NAME[event.lane], event.reason) }
    case 'review-skipped':
      return { id: event.id, at, warn: true, text: LANE_EVENT.reviewSkipped(event.reason) }
    case 'main-takeover':
      return { id: event.id, at, warn: false, text: LANE_EVENT.mainTakeover(LANE_NAME[event.lane]) }
    case 'self-spawn':
      return { id: event.id, at, warn: false, text: LANE_EVENT.selfSpawn }
    case 'version-mismatch':
      return { id: event.id, at, warn: false, text: LANE_EVENT.versionMismatch }
    case 'once-ended':
      return { id: event.id, at, warn: false, text: LANE_EVENT.onceEnded(event.afterFirst) }
    case 'lanes-declined':
      return { id: event.id, at, warn: false, text: LANE_EVENT.declined }
    case 'settings-applied':
      return { id: event.id, at, warn: false, text: LANE_EVENT.settingsApplied }
    case 'handoff-done':
      return {
        id: event.id,
        at,
        warn: true,
        text: LANE_EVENT.handoffDone(providerName(event.to.company)),
        archiveId: event.archiveId
      }
    default:
      return null
  }
}

// =====================================================================================
// §3 카드 줄 — 접힌 카드 한 줄
// =====================================================================================

/** 적용된 줄을 "자료 찾기 Claude Sonnet"(깊이는 빼고)으로. 접힘 문구는 §3-5 원문. */
export function appliedText(lane: JobLane | 'design', entry: { company: 'claude' | 'codex'; model: string | null }): string {
  return `${LANE_NAME[lane]} ${modelLabel(entry)}`
}

/** 접힌 카드가 "적용 안 함"으로 적을 줄 — `검토(새 대화 규칙)` 꼴. */
export function rejectedText(lane: JobLane | 'design', reason: LaneRejectReason, short: Record<LaneRejectReason, string>): string {
  return `${LANE_NAME[lane]}(${short[reason]})`
}

export { subjectOf, clockKo }
