/**
 * 작업 분담(배선 C) IPC 계약 — main(C1)과 화면(C2)이 만나는 유일한 약속.
 *
 * 설계 근거: v0.7 화면 설계 `UI-DESIGN.md` r3b(U6, 웹 GPT 고친 항목 확인 PASS)와
 * pM 판단(`DECISION-U6-pM.md`). 각 항목 주석의 `§` 번호는 그 문서의 절·§8 통합 계약 행이다.
 *
 * 원칙
 * - **화면은 계산하지 않는다**(§6 `store/lanes.ts`). main이 상태 묶음(`LanesSnapshot`)을
 *   통째로 다시 보내고, 화면은 그것을 그리기만 한다. 줄 순서·종류·카드 무효·차례 묶기·
 *   이어 하기 가능 여부·낭독할 사건은 모두 main이 정해서 넣는다.
 * - 문구는 넣지 않는다. 계약은 **코드 값**만 주고, 글은 화면의 `copy-lanes.ts`가 짓는다.
 *   (예외: 학생 원문 인용·주문 할 일 요약·원문 오류처럼 앱이 지을 수 없는 글.)
 * - 이 파일은 renderer(tsconfig.web)에서도 읽힌다 → `main/` 을 import하지 않는다.
 *   main 전용이던 타입 중 화면이 필요한 것은 여기로 옮겼고, `main/chat/jobs/types.ts`
 *   는 이 파일에서 재수출만 한다(정의는 한 곳).
 * - 채널 접두어는 `lanes:`·`jobs:`만(책임자 합의). `chat:`·`progress:`·`agent:`는 다른 갈래 몫.
 * - 모든 요청 응답은 `LanesReply<T>` — `{ result }` 또는 `{ error: { code, message } }`.
 *
 * 구현은 이 파일에 없다: main 핸들러·preload 함수는 C1, 화면은 C2.
 */

import type { ChatMessage, Provider, WorkLane } from './chat'
import type { LaneEntry, LaneRejectReason, LaneRowId, RequestScope } from './lanes'

// =====================================================================================
// 1. main에서 옮긴 공용 타입 (정의는 여기 한 곳 — main/chat/jobs/types.ts 는 재수출)
// =====================================================================================

/** 설계는 본대화가 맡으므로 주문이 없다(정본 §3.8). */
export type JobLane = Exclude<WorkLane, 'design'>
export type JobStatus =
  | 'queued' | 'running' | 'completed' | 'limit' | 'unknown' | 'auth'
  | 'stopped' | 'interrupted' | 'rejected' | 'error' | 'violation'
export type UsageState = 'allowed' | 'limit' | 'unknown' | 'auth'
/** App-owned identity, never read from a job file or lanes.json. */
export interface ConversationOwner { id: string; sessionId: string; company: Provider }

// =====================================================================================
// 2. 채널 이름
// =====================================================================================

/** 화면 → main 요청(`ipcRenderer.invoke`). */
export const LANES_INVOKE = {
  /** 지금 상태 묶음 한 번 받기(창을 열 때·폴더를 바꿀 때). */
  snapshot: 'lanes:snapshot',
  /** §3·§3-5·§8-4·§8-10 카드 단추. */
  decideCard: 'lanes:decide-card',
  /** §3-5 "적용됐는지 확인하지 못했어요" [다시 확인] — 다시 적용하지 않고 상태만 묻는다. */
  cardStatus: 'lanes:card-status',
  /** §3-3·§5 [추천으로 되돌리기]·[나눠 맡기기 켜기] → 설정 확인 창용 카드를 만든다. */
  settingsCard: 'lanes:settings-card',
  /** §5·§8-8 [나눠 맡기기 끄기] — 확인 창 뒤. 진행 중 담당은 멈추고 결과는 넘기지 않는다. */
  disable: 'lanes:disable',
  /** §3-4 검토 모델 고르기 목록. */
  reviewModels: 'lanes:review-models',
  /** §3-4 목록에서 고름 → 대화에 §3-2 카드를 띄운다(고르는 것만으로는 적용 안 됨). */
  pickReview: 'lanes:pick-review',
  /** §5 요금 동의 묶음 — 계정 단위라 폴더 없이도 부른다. */
  consents: 'lanes:consents',
  /** §5·§8-6·§8-8 동의하기·거두기. 거두면 그 회사로 앱이 맡긴 담당을 멈춘다. */
  setConsent: 'lanes:set-consent',
  /** §2-0 ✕로 닫는 줄. */
  dismiss: 'lanes:dismiss',
  /** §4-1 본대화 한도 [이어서 하기]·[다시 하기]. */
  handoffContinue: 'lanes:handoff-continue',
  /** §4-1 본대화 한도 [나중에]. */
  handoffLater: 'lanes:handoff-later',
  /** §4-2·§8-7 한도로 멈춘 대화 목록(설정 › 폴더). */
  archives: 'lanes:archives',
  /** §4-2·§8-7 한도로 멈춘 대화 한 개(읽기 전용). */
  archive: 'lanes:archive'
} as const

export const JOBS_INVOKE = {
  /** §2-1 [이 담당 멈추기] — 그 주문만. (입력칸 ■ = 대화와 담당 함께는 기존 `chat:stop` + main 몫.) */
  stopOne: 'jobs:stop-one',
  /** §4 한도 이어 하기 [이어서 하기]. */
  continue: 'jobs:continue',
  /** §4 [나중에] — 보류가 아니라 이번 주문을 미실행(limit)으로 넘긴다. */
  later: 'jobs:later',
  /** §2-1 앱 재시작 줄 [다시 맡기기] — 새 주문으로 처음부터. */
  retry: 'jobs:retry',
  /** §2-1 앱 재시작 줄 [버리기]. */
  discard: 'jobs:discard',
  /** §2-1·§8-2 넘기기 실패 [다시 넘기기]. */
  redeliver: 'jobs:redeliver',
  /** §2-1 인증 문제 [나중에] — 그 주문은 `auth` 미실행으로 도우미에게 넘어간다. */
  authLater: 'jobs:auth-later'
} as const

/** main → 화면 밀어 보내기(`webContents.send`). 상태가 바뀔 때마다 묶음 전체. */
export const LANES_PUSH = { snapshot: 'lanes:changed' } as const

export type LanesInvokeChannel = (typeof LANES_INVOKE)[keyof typeof LANES_INVOKE]
export type JobsInvokeChannel = (typeof JOBS_INVOKE)[keyof typeof JOBS_INVOKE]

// =====================================================================================
// 3. 응답 모양
// =====================================================================================

export type LanesErrorCode =
  /** 이음매가 없어 작업 분담 기능 자체가 꺼짐(가짜 기본값 금지). */
  | 'unavailable'
  /** 그 id(카드·주문·제안·보관·줄)가 없다. */
  | 'not-found'
  /** 폴더가 열려 있지 않다. */
  | 'no-folder'
  | 'internal'
export type LanesReply<T> = { result: T; error?: never } | { error: { code: LanesErrorCode; message: string }; result?: never }

// =====================================================================================
// 4. 상태 묶음 (§6 "화면은 계산하지 않음")
// =====================================================================================

/** 회사·모델·깊이 한 묶음. 화면 표시 이름은 화면이 칩과 같은 규칙으로 짓는다. */
export interface ModelRef { company: Provider; model: string; effort: string | null }

export interface LanesSnapshot {
  /** 이 묶음이 가리키는 논문 폴더. 폴더가 없으면 `null`(요금 동의 묶음만 의미 있음). */
  root: string | null
  /** 보낼 때마다 1씩 오른다. 화면은 더 작은 seq를 버린다(늦게 온 옛 묶음 무시). */
  seq: number
  /** §2-0 알림 자리 작업 분담 줄. **main이 이미 정렬**(종류 1→5, 같은 종류는 먼저 생긴 것부터). */
  lines: LaneLine[]
  /** §3 대화 흐름 안 카드(열림·접힘 모두). 대화 속 자리는 `createdAt` 순. */
  cards: LaneCard[]
  /** §2-2 대화 안 기록 줄. 자리는 `at` 순. 영속·재시작 뒤 유지는 main 몫(아래 열린 질문 Q1). */
  events: LaneEvent[]
  /** §5 설정 "작업 분담". */
  settings: LanesSettingsView
  /** §4-2 이 폴더의 한도로 멈춘 대화 요약(설정 › 폴더 "n개"·[다른 멈춘 대화 ▾]). */
  archives: ArchivedChatSummary[]
  /**
   * §2-1 낭독(U6-05). 상태가 **바뀐 순간에만** 새 값(seq가 오름). 화면은 seq가 바뀌면
   * 전용 알림 칸 글을 한 문장으로 갈아 끼운다. 경과 시간·대기 개수 변화로는 오르지 않는다.
   */
  announcement: LaneAnnouncement | null
  /**
   * §2-1 [r2 W25] 입력칸 ■ 이름. 담당 진행 줄이 있으면 'chat-and-lanes'
   * ("대화와 담당 함께 멈추기"). ■의 실제 동작(둘 다 멈춤)은 main 몫.
   */
  stopButton: 'chat' | 'chat-and-lanes'
}

// ---------------------------------------------------------------- §2 알림 자리 줄

/** §2-0 종류: 1 막힘 · 2 학생 선택 · 3 진행 · 4 지속 경고 · 5 미결 카드. */
export type LineTier = 1 | 2 | 3 | 4 | 5

interface LineBase {
  /** 줄 id — ✕(`dismiss`)·[n건 더 보기] 펼침 기억·낭독 대상에 쓴다. */
  id: string
  tier: LineTier
  /** 생긴 시각(ISO). 같은 종류 안 순서의 근거. */
  at: string
  /** ✕를 보일지. */
  dismissible: boolean
}

/** §2-1 [자세히] — 상태·사유·원문 오류를 펼친다(파일은 열지 않음). */
export interface JobDetail { jobId: string; status: JobStatus; reason: string | null; error: string | null; task: string }

/** 주문 하나에 묶인 줄의 공통 칸. */
interface JobLineBase extends LineBase {
  jobId: string
  lane: JobLane
  /** 이 주문을 맡은(맡을) 회사·모델. */
  assignee: ModelRef
  detail: JobDetail
}

export type LaneLine =
  /** §2-1 대기·실행·이어서 하는 중·멈추는 중 (종류 3). */
  | (JobLineBase & {
      kind: 'progress'
      tier: 3
      phase: 'queued' | 'running' | 'continuing' | 'stopping'
      /** 실행 시작 시각 — "{n}분째"는 화면이 시계로 센다(낭독 칸 밖). 대기면 null. */
      startedAt: string | null
      /** 뒤에 기다리는 주문 수 — "다음 n건 기다림"(직렬 실행). */
      waiting: number
    })
  /** §2-1·§8-2 끝남, 넘기는 중 (종류 3, 단추 없음). */
  | (JobLineBase & { kind: 'delivering'; tier: 3 })
  /** §2-1·§8-2 넘기기 실패 (종류 2) [다시 넘기기] [자세히]. */
  | (JobLineBase & { kind: 'deliver-failed'; tier: 2 })
  /** §4 한도 + 이어 하기 가능 (종류 2) [이어서 하기] [나중에]. 확인된 한도 + 열린 제안일 때만. */
  | (JobLineBase & {
      kind: 'limit-offer'
      tier: 2
      proposalId: string
      /** 이어 받을 회사·모델·깊이. 검토는 늘 높게. */
      to: ModelRef
      /** 깊이를 기본값으로 내렸으면 true — 제목에 "(기본 깊이)". */
      effortLowered: boolean
      /** 원 회사가 알려 준 한도 풀림 예정(ISO). 모르면 null. */
      resetAt: string | null
    })
  /** §2-1·§4 "단추가 안 뜨는 경우" (종류 2, ✕). */
  | (JobLineBase & {
      kind: 'limit-blocked'
      tier: 2
      /** 이어 받을 회사(사유 글에 이름이 들어감). */
      other: Provider
      reason: 'not-logged-in' | 'no-consent' | 'also-unavailable' | 'model-missing'
    })
  /** §4 누른 뒤 제안이 버려지고 이어 갈 곳이 없어짐 — "상황이 바뀌어 이어서 할 수 없어요" (종류 2, ✕). */
  | (JobLineBase & { kind: 'continue-gone'; tier: 2 })
  /** §2-1 사용량 모름 (종류 2, ✕). */
  | (JobLineBase & { kind: 'usage-unknown'; tier: 2 })
  /** §2-1 인증 문제 (종류 2) [다시 로그인] [나중에]. 인증이 실제로 통과할 때만 사라진다. */
  | (JobLineBase & { kind: 'auth'; tier: 2 })
  /** §2-1 일반 실패 (종류 2, ✕) [자세히] [문제 신고]. */
  | (JobLineBase & { kind: 'failed'; tier: 2 })
  /** §2-1 앱 재시작(interrupted) (종류 2) [다시 맡기기] [버리기]. */
  | (JobLineBase & { kind: 'interrupted'; tier: 2 })
  /** §2-1 학생이 멈춤(확인됨) (종류 4, ✕). */
  | (JobLineBase & { kind: 'stopped'; tier: 4 })
  /** §2-1·§8-5 담당 중 논문 파일 바뀜 (종류 1, ✕, 줄 자체 role=alert). 주체를 단정하지 않는다. */
  | (JobLineBase & { kind: 'folder-changed'; tier: 1 })
  /** §2-2 지속 안내: 독립 검토 안 함 (종류 4). 사유별 단추는 화면이 `reason`으로 고른다. */
  | (LineBase & { kind: 'review-missing'; tier: 4; reason: 'lanes-off' | 'model-missing' | 'limit' })
  /** §2-2 지속 안내: 앱·스킬 판 안 맞음 (종류 4). */
  | (LineBase & { kind: 'version-mismatch'; tier: 4 })
  /** §3·§2-0 미결 카드 (종류 5, ✕ 없음) [카드 보기]. */
  | (LineBase & { kind: 'card-pending'; tier: 5; cardId: string })
  /**
   * §4-1 본대화 한도 (종류 2) — 기존 대화 오류 줄을 **대신**한다. 확인된 한도 + 제안일 때만.
   * `tooLong`이면 [이어서 하기] 대신 "앞 대화가 너무 길어…" + [새 대화로 시작].
   */
  | (LineBase & { kind: 'main-limit-offer'; tier: 2; proposalId: string; to: ModelRef; tooLong: boolean })
  /** §4-1 "{회사}로 넘기는 중…" (종류 3). */
  | (LineBase & { kind: 'handoff-running'; tier: 3; to: ModelRef })
  /** §4-1 넘기지 못함 (종류 2) [다시 하기] [나중에]. */
  | (LineBase & { kind: 'handoff-failed'; tier: 2; proposalId: string; to: ModelRef })

export type LaneLineKind = LaneLine['kind']

/** §2-1 낭독 한 건. 문장은 화면이 `kind`·`lane`으로 짓는다. */
export interface LaneAnnouncement {
  seq: number
  kind: 'started' | 'delivered' | 'line'
  lane: JobLane | null
  /** `kind:'line'`이면 그 줄 id — 그 줄 제목을 그대로 읽는다. */
  lineId: string | null
}

// ---------------------------------------------------------------- §2-2 기록 줄

interface EventBase { id: string; at: string }

export type LaneEvent =
  /** 넘김 확인 — "{역할} 담당({회사 모델})이 "{요약}"을 끝내 도우미에게 넘겼어요". 본대화 수신 확인 뒤에만. */
  | (EventBase & { kind: 'delivered'; jobId: string; lane: JobLane; by: ModelRef; continued: boolean; task: string })
  /** 미실행 전달 — "…하지 못했어요({사유}) — 도우미에게 알렸어요". */
  | (EventBase & { kind: 'not-run'; jobId: string; lane: JobLane; reason: 'limit' | 'auth' | 'unknown' | 'error'; task: string })
  /** ⚠ 독립 검토를 하지 않았어요. */
  | (EventBase & { kind: 'review-skipped'; reason: 'lanes-off' | 'model-missing' | 'limit' })
  /** 추천 모델 없음 → 도우미가 직접 맡아요 (lanes.ts `LaneNote` main-takeover). */
  | (EventBase & { kind: 'main-takeover'; lane: JobLane; model: string })
  /** ChatGPT 본대화가 스스로 하위 담당을 띄움(정본 §5-7) — 기록만. */
  | (EventBase & { kind: 'self-spawn' })
  /** 앱·스킬 판 안 맞음. */
  | (EventBase & { kind: 'version-mismatch' })
  /** §3 [이번만] 차례 끝 — `afterFirst`면 "다음에 나눠 맡길 때 다시 물어봐요". */
  | (EventBase & { kind: 'once-ended'; afterFirst: boolean })
  /** §3-1 [나눠 맡기지 않기] · §5 끄기. */
  | (EventBase & { kind: 'lanes-declined' })
  /** §3-3 설정에서 적용 — 대화에도 같은 기록. */
  | (EventBase & { kind: 'settings-applied'; cardId: string })
  /**
   * §4-1·§4-2 이어 받은 대화 첫 줄 — "…한도로 멈춰 {회사}가 이어 받았어요" [멈춘 대화 보기].
   * 기록으로 저장돼 재시작 뒤에도 남는다.
   */
  | (EventBase & { kind: 'handoff-done'; from: ModelRef; to: ModelRef; archiveId: string })

// ---------------------------------------------------------------- §3 카드

export type CardVariant =
  /** §3-1 처음 분담(요금 동의 + 배치 승인). */
  | 'first'
  /** §3-2 배치 바꾸기(학생 말에서). §3-4 검토 모델 고르기도 이 갈래. */
  | 'change'
  /** §3-3 설정 확인 창: 켜기. 범위는 [계속]만. */
  | 'settings-enable'
  /** §3-3 설정 확인 창: 추천으로 되돌리기. 범위는 [계속]만. */
  | 'settings-revert'

/** §3 공통 뼈대 3 — 바뀌는 줄. 적용 안 되는 줄은 `rejected`에 이유. */
export interface CardRow {
  lane: WorkLane
  before: LaneEntry | null
  after: LaneEntry | null
  /** null이면 적용됨. 이유 코드는 lanes.ts `LaneRejectReason` 그대로. */
  rejected: LaneRejectReason | null
  /** §3-2 설계를 다른 회사로 바꾸는 줄이면 그 회사 — "다음 메시지를 보낼 때부터예요". */
  designSwitchTo: Provider | null
}

/** §3 공통 뼈대 6 — 요금 안내(§3-2 U6-06 공통 문구). */
export interface FeeNotice {
  company: Provider
  /** 가린 계정 표시(예: a…@gmail.com). main이 가린다 — 화면에 원 이메일을 주지 않는다. */
  accountLabel: string
  /** 이미 동의했으면 한 줄로 줄인다. 동의 없는 회사가 하나라도 끼면 상자 전체. */
  consented: boolean
}

export type CardState =
  | { kind: 'open' }
  /** §3-5 처리 중 — 단추 disabled, "적용하는 중…". */
  | { kind: 'applying' }
  /** §3-5 접힘. `scope`는 적용 범위. 실제로 바뀐 줄만 `applied`에. */
  | { kind: 'applied'; scope: RequestScope; applied: WorkLane[] }
  /** §3-1 [나눠 맡기지 않기]. */
  | { kind: 'declined' }
  | { kind: 'cancelled' }
  /** §3-5 무효 — 다른 창에서 처리됨 또는 `baseVersion` 불일치. */
  | { kind: 'invalid' }
  /** §3-5·U6-04 더 새 카드로 밀려남 — "새 카드로 바뀌었어요". */
  | { kind: 'superseded'; by: string }

export interface LaneCard {
  /** §8-4 main이 카드 id 단위로 열림→소비됨을 한 번에 바꾼다. */
  cardId: string
  root: string
  variant: CardVariant
  /** §8-10·U6-04 만든 시점의 기본 배치 판. 화면은 받아서 그대로 돌려준다. */
  baseVersion: number
  createdAt: string
  /** §3-1 검토가 필요해서 뜬 카드면 true — "검토할 차례예요…" 머리 줄. */
  reviewDue: boolean
  /** §3 공통 2 — 학생 원문(`lanes-request.json` 인용 그대로). 학생 말에서 온 게 아니면 null. */
  quote: string | null
  rows: CardRow[]
  fees: FeeNotice[]
  /** §3-2 한도가 빨리 주는 조합이면 true(막지 않음). */
  fastDrain: boolean
  state: CardState
}

/** 카드 단추. `decline`=§3-1 [나눠 맡기지 않기], `cancel`=§3-2 [취소], `ack`=모두 거절일 때 [확인]. */
export type CardAction = 'continue' | 'once' | 'decline' | 'cancel' | 'ack'

/** `decideCard`·`cardStatus` 결과. */
export interface CardDecision {
  outcome:
    /** 이번 요청이 처리했다. */
    | 'applied'
    /** §8-4 이미 처리됨(두 창·중복 IPC) — 두 번째부터. */
    | 'already-handled'
    /** §3-5 `baseVersion` 불일치·밀려남. */
    | 'invalid'
    /** `cardStatus` 전용: 아직 처리 중. */
    | 'pending'
  card: LaneCard
  /**
   * §8-10 [이번만]이 묶인 차례. 도우미가 답하는 중이면 그 차례 id, 쉬는 중이면
   * `'next-student-turn'`(앱이 도우미에게 따로 차례를 보내지 않는다). 이번만이 아니면 null.
   */
  boundTurn: string | 'next-student-turn' | null
}

// ---------------------------------------------------------------- §3-4 검토 모델 목록

/** 그 계정 모델 중 `high`를 지원하는 것만, 회사별 묶음. 추천·자동 선택 없음. */
export interface ReviewModelGroup {
  company: Provider
  models: { model: string; name: string }[]
}

// ---------------------------------------------------------------- §5 설정

export interface LanesSettingsView {
  /** ① 나눠 맡김 ② 나눠 맡기지 않음 ③ 아직 안 정함. 폴더가 없으면 null. */
  mode: 'on' | 'off' | 'undecided' | null
  /** 묶음 머리 오른쪽 출처. */
  source:
    | { kind: 'recommended'; rowId: LaneRowId }
    | { kind: 'mine'; at: string }
    | { kind: 'recommendation-changed' }
    | { kind: 'none' }
  /** 표 줄(설계 줄은 칩을 가리키므로 `entry`를 쓰지 않는다). `mode:'off'`면 빈 배열. */
  rows: SettingsRow[]
  /** [추천으로 되돌리기] 활성 — 추천과 다를 때만. */
  differsFromRecommendation: boolean
  /** "지금 이번 차례만: …" — [이번만]·이어 하기로 다른 값이 돌고 있을 때만. */
  temporary: { lane: JobLane; entry: ModelRef }[]
  /** "다음 메시지부터: 설계 {회사}" — 없으면 null. */
  nextDesignCompany: Provider | null
  consents: ConsentRow[]
}

export interface SettingsRow {
  lane: WorkLane
  entry: LaneEntry | null
  /** 값 칸 예외 글. */
  note: 'main-takeover' | 'review-unavailable' | 'not-subscribed' | null
  /** 추천 모델 이름(main-takeover 글에 "추천 모델(Luna)"로 씀). */
  recommendedModel: string | null
}

/** §5·§8-6 요금 동의 줄 — 계정 id 단위. */
export interface ConsentRow {
  company: Provider
  accountId: string
  /** 가린 계정 표시. */
  accountLabel: string
  state: 'none' | 'agreed' | 'withdrawn'
  /** 동의함·거둠 날짜(ISO). `none`이면 null. */
  at: string | null
  /** 구독 로그인이 아니면 false — 이 회사는 쓰지 않음. */
  subscribed: boolean
}

// ---------------------------------------------------------------- §4-2 한도로 멈춘 대화

export interface ArchivedChatSummary {
  archiveId: string
  company: Provider
  model: string | null
  startedAt: string
  stoppedAt: string
  reason: 'limit'
  /** 이어 받은 대화 id. */
  successorId: string
}

/** 읽기 전용. 새 차례·담당 결과를 받지 않는다(D7-02). */
export interface ArchivedChat {
  summary: ArchivedChatSummary
  messages: ChatMessage[]
}

// =====================================================================================
// 5. 화면이 부를 API (preload가 `window.knuaf.lanes`·`window.knuaf.jobs`로 노출)
// =====================================================================================

/**
 * 모든 요청은 상태를 바꾼 뒤 `lanes:changed`로 새 묶음을 밀어 보낸다. 화면은 요청 응답이
 * 아니라 밀려온 묶음으로 다시 그린다(응답은 오류·즉시 결과 확인용).
 */
export interface LanesApi {
  snapshot(root: string | null): Promise<LanesReply<LanesSnapshot>>
  /** 구독. 해제 함수를 돌려준다. */
  onSnapshot(fn: (snapshot: LanesSnapshot) => void): () => void

  /** §3·§8-4·§8-10. 같은 카드 두 번째 요청은 `already-handled`. */
  decideCard(root: string, cardId: string, baseVersion: number, action: CardAction): Promise<LanesReply<CardDecision>>
  /** §3-5 [다시 확인]. 적용하지 않는다. */
  cardStatus(root: string, cardId: string): Promise<LanesReply<CardDecision>>
  /** §3-3 설정 확인 창 카드. 결과 카드의 단추는 [계속]·[취소]만. */
  settingsCard(root: string, kind: 'enable' | 'revert'): Promise<LanesReply<LaneCard>>
  /** §5·§8-8 끄기. */
  disable(root: string): Promise<LanesReply<void>>

  /** §3-4. */
  reviewModels(root: string): Promise<LanesReply<ReviewModelGroup[]>>
  /** §3-4 고름 → 대화에 카드가 뜬다(그 카드를 돌려준다). */
  pickReview(root: string, company: Provider, model: string): Promise<LanesReply<LaneCard>>

  /** §5 폴더 없이도. */
  consents(): Promise<LanesReply<ConsentRow[]>>
  /** §5·§8-6·§8-8. `on:false`면 그 회사로 앱이 맡긴 진행 중 담당을 멈춘다. */
  setConsent(company: Provider, accountId: string, on: boolean): Promise<LanesReply<ConsentRow>>

  /** §2-0 ✕. `dismissible:false`인 줄이면 오류. */
  dismiss(root: string, lineId: string): Promise<LanesReply<void>>

  /** §4-1 [이어서 하기]·[다시 하기]. 성공해야 칩·대화가 바뀐다(대화 쪽은 `chat:` 갈래가 알린다). */
  handoffContinue(root: string, proposalId: string): Promise<LanesReply<void>>
  /** §4-1 [나중에] — 줄이 기존 대화 오류 줄로 돌아간다. */
  handoffLater(root: string, proposalId: string): Promise<LanesReply<void>>

  /** §4-2·§8-7. */
  archives(root: string): Promise<LanesReply<ArchivedChatSummary[]>>
  archive(root: string, archiveId: string): Promise<LanesReply<ArchivedChat>>
}

export interface JobsApi {
  /** §2-1 [이 담당 멈추기]. */
  stopOne(root: string, jobId: string): Promise<LanesReply<void>>
  /** §4 [이어서 하기]. 제안이 버려졌으면 새 줄(새 제안 또는 continue-gone)이 묶음으로 온다. */
  continue(root: string, proposalId: string): Promise<LanesReply<void>>
  /** §4 [나중에]. */
  later(root: string, proposalId: string): Promise<LanesReply<void>>
  /** §2-1 [다시 맡기기]. 새 주문 id는 main이 만든다. */
  retry(root: string, jobId: string): Promise<LanesReply<void>>
  /** §2-1 [버리기]. */
  discard(root: string, jobId: string): Promise<LanesReply<void>>
  /** §2-1·§8-2 [다시 넘기기]. */
  redeliver(root: string, jobId: string): Promise<LanesReply<void>>
  /** §2-1 인증 [나중에]. */
  authLater(root: string, jobId: string): Promise<LanesReply<void>>
}

// =====================================================================================
// 6. 열린 질문 — 설계·현재 main 코드로 닫히지 않아 구현 전에 책임자 확인이 필요한 것
// =====================================================================================
/*
 * Q1 (§8-1·§2-2) 기록 줄과 "결과 전달 차례"는 대화 기록(`chat-${provider}.json`) 안에 있어야
 *     재시작 뒤에도 순서대로 남는다. 그건 `ChatMessage`에 `origin:'app-relay'` 같은 칸을 더하는
 *     일이라 `chat:` 갈래 몫이다. 이 계약은 `events`를 묶음으로 주지만, 영속 위치를 대화 기록으로
 *     할지 앱 저장소로 할지는 미정.
 * Q2 (§2-1 [이 담당 멈추기]) 지금 `JobRunner.stop(root)`는 폴더 단위(모든 주문)뿐이다. 주문 하나만
 *     멈추는 길이 main에 없다 — C1이 새로 만들어야 하는지, 범위 밖인지.
 * Q3 (§8-2 [다시 넘기기]) `JobStore`는 at-most-once(started→uncertain, 다시 보내지 않음)다.
 *     학생이 누른 다시 넘기기를 이 규칙의 예외로 둘지.
 * Q4 (§8-6 동의 상태) `JobStore.consent`는 `true`만 저장한다. 설계의 "동의함·{날짜}"·"거둠·{날짜}"를
 *     보이려면 상태·날짜 저장이 필요하다.
 * Q5 (§3·§8-10 `baseVersion`·카드 저장·차례 id) main에 아직 없다(배선 C1이 새로 만듦). 카드가
 *     재시작 뒤에도 남는지(미결 줄 ✕ 없음이라 남아야 자연스러움) 확인 필요.
 * Q6 (§8-5) 담당 중 논문 파일 바뀜의 비교 범위(본대화 쓰기 제외 방법)는 미정 — 줄 모양만 둔다.
 * Q7 (§4-2·§8-7) 보관 대화는 ConversationHandoff 앱 단위(pM 11-08) 몫. 이 계약은 읽기 두 통로만 둔다.
 */
