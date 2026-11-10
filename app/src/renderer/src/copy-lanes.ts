import { MODEL_PICKER, PROVIDER_NAME } from './copy'
import { WORK_LANES, type Provider, type WorkLane } from '../../shared/chat'
import type { CardVariant, JobStatus, ModelRef } from '../../shared/lanes-ipc'

/**
 * 작업 분담(단위 6) 화면 문구 — 설계 `UI-DESIGN.md` r3b §2~§5 원문.
 *
 * `copy.ts` 를 건드리지 않는다(#73·순서 1 충돌 회피). 여기 있는 글은 화면만 쓴다.
 * 금지 문구(설계 §3-5 5): "필요한 파일만", "입력 파일만", "대화 기록은 넘기지 않아요" —
 * 담당의 **읽기를 막는다고 들리는 말**은 쓰지 않는다(정본: 쓰기만 담당 칸에 가둔다).
 */

/** 설계 표 머리의 역할 이름 — 칩의 "검토(새 대화)" 가 아니라 §2-1 표 머리를 쓴다. */
export const LANE_NAME = Object.fromEntries(
  WORK_LANES.map(({ lane, label }) => [lane, lane === 'review' ? '검토' : label])
) as Record<WorkLane, string>

export function providerName(company: Provider): string {
  return PROVIDER_NAME[company]
}

/**
 * 모델 id → 화면 이름. 칩 목록은 계정이 준 `name` 을 쓰지만, 담당·카드에는 id 만 온다.
 * 별칭 낱말이 id 안에 있으면 그 표기를 쓰고(`gpt-6.1-sol` → Sol, `claude-sonnet-4` → Sonnet),
 * 없으면 마지막 낱말을 첫 글자만 키운다.
 */
const MODEL_DISPLAY: Record<string, string> = {
  sol: 'Sol', terra: 'Terra', astra: 'Astra', luna: 'Luna',
  opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku'
}

export function modelName(model: string | null | undefined): string {
  if (!model) return ''
  const words = model.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)
  for (const word of words) {
    const name = MODEL_DISPLAY[word]
    if (name) return name
  }
  const named = words.filter((word) => !/^\d+(\.\d+)*$/.test(word))
  const last = named[named.length - 1] ?? model
  return last.charAt(0).toUpperCase() + last.slice(1)
}

/** "Claude Sonnet" — 회사 이름 + 모델 이름. */
export function modelLabel(ref: { company: Provider; model: string | null }): string {
  const model = modelName(ref.model)
  return model ? `${providerName(ref.company)} ${model}` : providerName(ref.company)
}

/** 깊이 표시 — 없으면 "기본"(설계 §5 표), 있으면 칩과 같은 이름(높게·최대로…). */
export function depthName(effort: string | null | undefined): string {
  if (!effort) return '기본'
  return MODEL_PICKER.efforts[effort] ?? effort
}

/** `오후 2:40` — 시안·설계가 쓰는 시계 표기. */
export function clockKo(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hour = date.getHours()
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `11월 8일` */
export function dayKo(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}월 ${date.getDate()}일`
}

/** `11월 8일 오후 2:40` — 보관 대화 줄. */
export function stampKo(iso: string | null | undefined): string {
  const day = dayKo(iso)
  const clock = clockKo(iso)
  return day && clock ? `${day} ${clock}` : day || clock
}

/** 시작 시각에서 지난 분. 시계로만 세고 낭독 칸에는 넣지 않는다(설계 §2-1). */
export function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.floor((now - at) / 60_000))
}

/**
 * 주격 조사 `이/가` — 로마자 이름은 마지막 글자로 정한다.
 * (Sol·Sonnet → 이, Astra·Terra·Luna·Opus·Haiku → 가). 고정 목록 밖은 모음 끝이면 가.
 */
const PARTICLE: Record<string, '이' | '가'> = {
  Sol: '이', Sonnet: '이', Astra: '가', Terra: '가', Luna: '가', Opus: '가', Haiku: '가'
}

export function subjectParticle(name: string): '이' | '가' {
  const fixed = PARTICLE[name.trim()]
  if (fixed) return fixed
  const last = name.trim().slice(-1).toLowerCase()
  if (!last) return '가'
  return 'aeiou'.includes(last) ? '가' : '이'
}

/** `ChatGPT Sol이` 처럼 조사까지 붙인 이름. */
export function subjectOf(name: string): string {
  return `${name}${subjectParticle(name)}`
}

export function clip(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** 주문 상태 코드 → 한국어(펼침 [자세히] 안에서만 쓴다). */
export const JOB_STATUS_NAME: Record<JobStatus, string> = {
  queued: '대기',
  running: '실행 중',
  completed: '끝남',
  limit: '한도',
  unknown: '사용량 모름',
  auth: '로그인 필요',
  stopped: '멈춤',
  interrupted: '앱 재시작',
  rejected: '거절',
  error: '오류',
  violation: '규칙 위반'
}

// =====================================================================================
// §2-1 알림 자리 — 담당 진행 줄
// =====================================================================================

export const LANE_LINE = {
  /** 대기 — 종류 3. */
  queued: (lane: string) => `${lane} 담당 · 차례 기다리는 중`,
  running: (lane: string, model: string) => `${lane} 담당 · ${model}`,
  continuing: (lane: string, model: string) => `${lane} 담당 · ${model} · 이어서 하는 중`,
  stopping: (lane: string) => `${lane} 담당을 멈추는 중`,
  /** 실행 줄 작은 글 — "{n}분째 · 다음 1건 기다림". */
  elapsed: (minutes: number, waiting: number) => {
    const parts = [`${minutes}분째`]
    if (waiting > 0) parts.push(`다음 ${waiting}건 기다림`)
    return parts.join(' · ')
  },
  delivering: (lane: string) => `${lane} 담당이 끝났어요 — 도우미에게 넘기는 중`,
  deliverFailed: (lane: string) => `${lane} 결과를 도우미에게 넘기지 못했어요`,
  keptResult: '결과는 보관돼 있어요',
  /** §4 한도 + 이어 하기 가능. */
  limitOffer: (to: string, effortLowered: boolean) =>
    `한도에 걸렸어요 — ${to}${effortLowered ? '(기본 깊이)' : ''}으로 이어서 할까요?`,
  limitOfferSub: (lane: string, toCompany: string, fromCompany: string, resetAt: string | null) => {
    const parts = [lane, `${toCompany} 계정 사용량이 줄어요`]
    const clock = clockKo(resetAt)
    if (clock) parts.push(`${fromCompany}가 알려 준 한도 풀림 예정 ${clock}`)
    return parts.join(' · ')
  },
  limitOfferFoot: (lane: string) => `나중에: 이번 ${lane}는 건너뛰어요`,
  /** §2-1 한도 + 이어 하기 불가(사유 한 줄). */
  limitBlocked: (lane: string) => `${lane} 담당이 한도에 걸려 하지 못했어요`,
  limitBlockedReason: {
    'not-logged-in': (other: string) => `${other}에 로그인돼 있지 않아요`,
    'no-consent': (other: string) => `${other} 요금 안내에 동의하지 않았어요 — 설정 › 작업 분담`,
    'also-unavailable': (other: string) => `${other}도 지금 쓸 수 없어요`,
    'model-missing': (other: string) => `이어 받을 모델이 ${other} 계정에 없어요`
  },
  continueGone: '상황이 바뀌어 이어서 할 수 없어요',
  usageUnknown: (lane: string, company: string) =>
    `지금 ${company} 사용량을 확인하지 못해 ${lane} 담당을 시작하지 않았어요`,
  usageUnknownSub: '잠시 뒤 대화에서 다시 맡겨 달라고 말해 주세요',
  auth: (lane: string, company: string) => `${company} 로그인을 다시 해야 ${lane} 담당을 맡길 수 있어요`,
  failed: (lane: string) => `${lane} 담당이 오류로 멈췄어요`,
  failedSub: '원문은 자세히',
  interrupted: (lane: string) => `앱이 다시 켜져서 ${lane} 담당이 끝났는지 알 수 없어요`,
  interruptedSub: '다시 맡기면 처음부터 새로 해요',
  stopped: (lane: string) => `${lane} 담당을 멈췄어요 — 결과는 도우미에게 넘기지 않아요`,
  folderChanged: (lane: string) => `담당이 일하는 동안 논문 파일이 바뀌어서 ${lane} 결과를 넘기지 않았어요`,
  /** §2-2 지속 안내. */
  reviewMissing: '이 원고는 아직 독립 검토를 하지 않았어요',
  reviewMissingReason: {
    'lanes-off': '나눠 맡기기를 안 씀',
    'model-missing': '검토 모델이 이 계정에 없음',
    limit: '한도'
  },
  versionMismatch: '앱과 스킬 판이 맞지 않아 이번 대화는 나눠 맡기지 않아요',
  cardPending: '작업 분담 확인이 남아 있어요',
  /** §4-1 본대화 한도. */
  mainLimit: (to: string) => `한도에 걸렸어요 — ${to}로 이어서 대화할까요?`,
  mainLimitSub: (company: string) =>
    `${company} 계정 사용량이 줄어요 · 이 대화에서 내가 쓴 글과 마지막 답을 ${company}에 넘겨요`,
  mainLimitTooLong: '앞 대화가 너무 길어 자동으로 이어 받을 수 없어요',
  /** "넘겨요 ▸" 펼침 — 정본 이어 받기 묶음 ①~⑤. */
  mainLimitDetail: [
    '내가 쓴 글 전부',
    '마지막 AI 답',
    '이 대화 동안 바뀐 파일 이름',
    '작업 분담·주문 상태',
    '스킬 판'
  ].map((item, index) => `${index + 1}. ${item}`).join('\n'),
  handoffRunning: (company: string) => `${company}로 넘기는 중…`,
  handoffFailed: (company: string) => `${company}로 넘기지 못했어요`
} as const

/** 줄 단추 이름 — 종류별. */
export const LANE_ACTION = {
  stopOne: '이 담당 멈추기',
  redeliver: '다시 넘기기',
  continue: '이어서 하기',
  later: '나중에',
  relogin: '다시 로그인',
  retry: '다시 맡기기',
  discard: '버리기',
  details: '자세히',
  report: '문제 신고',
  showCard: '카드 보기',
  reviewModels: '검토 모델 고르기',
  enableLanes: '나눠 맡기기 켜기',
  newChat: '새 대화로 시작'
} as const

/** §2-1 낭독(화면 읽기 프로그램) — 상태가 바뀐 순간에만 한 문장. */
export const LANE_SAY = {
  started: (lane: string) => `${lane} 담당이 시작했어요`,
  delivered: (lane: string) => `${lane} 담당이 끝나 도우미에게 넘겼어요`
} as const

// =====================================================================================
// §2-2 대화 안 기록 줄
// =====================================================================================

export const LANE_EVENT = {
  delivered: (lane: string, by: string, task: string) =>
    `${lane} 담당(${by})이 “${clip(task)}”을 끝내 도우미에게 넘겼어요`,
  continued: (lane: string, by: string) => `${lane}를 ${by}이 이어 받아 끝내 도우미에게 넘겼어요`,
  notRun: (lane: string, reason: 'limit' | 'auth' | 'unknown' | 'error') => {
    const word = reason === 'limit' ? '한도' : reason === 'auth' ? '로그인' : reason === 'unknown' ? '사용량 모름' : '오류'
    return `${lane} 담당이 하지 못했어요(${word}) — 도우미에게 알렸어요`
  },
  reviewSkipped: (reason: 'lanes-off' | 'model-missing' | 'limit') =>
    `독립 검토를 하지 않았어요 — ${
      reason === 'lanes-off' ? '나눠 맡기기를 안 씀' : reason === 'model-missing' ? '검토 모델이 이 계정에 없음' : '한도'
    }`,
  mainTakeover: (lane: string) => `추천 ${lane} 모델이 이 계정에 없어 도우미가 직접 맡아요`,
  selfSpawn: 'ChatGPT가 스스로 하위 담당을 띄웠어요 — 앱이 막을 수 없어 기록만 해요. 이 사용량도 한도에 들어가요',
  versionMismatch: '앱과 스킬 판이 맞지 않아 이번 대화는 나눠 맡기지 않아요',
  onceEnded: (afterFirst: boolean) =>
    `이번만 쓴 작업 분담이 끝났어요 — ${afterFirst ? '다음에 나눠 맡길 때 다시 물어봐요' : '기본 배치로 돌아가요'}`,
  declined: '나눠 맡기지 않기로 했어요 — 도우미가 혼자 해요. 설정 › 작업 분담에서 다시 켤 수 있어요',
  settingsApplied: '설정에서 작업 분담을 바꿨어요',
  handoffDone: (to: string) => `한도로 멈췄어요 — ${to}이 이어 받았어요`,
  archiveLink: '멈춘 대화 보기'
} as const

// =====================================================================================
// §3 배치 카드
// =====================================================================================

export const LANE_CARD = {
  title: {
    first: '작업을 나눠 맡길까요?',
    change: '작업 분담을 이렇게 바꿀까요?',
    'settings-enable': '작업을 나눠 맡길까요?',
    'settings-revert': '추천 배치로 되돌릴까요?'
  } satisfies Record<CardVariant, string>,
  firstLead: '도우미 혼자 하던 일을 역할별로 나눠요. 검토는 늘 새 대화에서 해요.',
  reviewDue: '검토할 차례예요 — 누르지 않으면 독립 검토 없이 진행해요.',
  quote: (text: string) => `내가 한 말: “${text}”`,
  quoteMore: '전체 보기',
  quoteLess: '접기',
  chipref: (recommended: string | null) =>
    `설계는 지금처럼 아래 칩에서 골라요${recommended ? ` — 추천 ${recommended}` : ''}`,
  /** 읽기 범위 — "…만 읽어요" 금지(설계 §3 뼈대 5). */
  readScope: '맡기면 그 회사의 새 대화가 열려요. 담당은 파일을 읽을 수 있지만 논문 파일을 고치지는 못해요.',
  readScopeDetail:
    '앱은 주문서에 적은 파일을 읽으라고 알려 줘요. 하지만 읽기를 그 파일로 막지는 않아요 — 담당은 이 논문 폴더의 다른 파일(앱이 폴더에 남기는 대화 기록 파일도 포함)과 그 밖의 파일도 읽을 수 있어요. 이 대화를 담당에게 자동으로 넘기지는 않아요. 담당이 쓰는 곳은 그 일 전용 칸뿐이에요.',
  feeNotConsented: (company: string) => `${company} 요금 안내에 아직 동의하지 않았어요.`,
  feeIntro: '나눠 맡기면 구독 사용량이 더 빨리 줄어요. 계정에 추가 사용·크레딧이 켜져 있으면, 한도를 넘는 순간부터 요금이 나갈 수 있어요.',
  feeApp: '앱이 여는 담당은 한도가 다 된 걸 알면 새로 띄우지 않아요. 이미 일하던 담당은 앱이 멈추기 전까지 더 쓸 수 있어요.',
  feeSpawn: '본대화 ChatGPT가 스스로 하위 담당을 띄우는 건 앱이 막지 못하고, 알리고 기록만 해요. 그 사용량도 한도와 요금에 들어가요.',
  feeConsent: (company: string, account: string) => `이 안내 동의는 ${company} 계정(${account})에 남고 모든 논문에 적용돼요.`,
  feeAlready: (company: string, account: string) =>
    `${company}(${account}) 요금 안내에 이미 동의했어요 — 모든 논문에 적용돼요`,
  /** 적용 범위 — 모든 갈래 카드에 늘 보인다(단추 아래 작은 글). */
  scope: (first: boolean) =>
    `계속: 이 논문의 기본 배치가 돼요 · 이번만: 누른 뒤 이번 차례에 맡기는 일에만 써요 — 끝나면 ${
      first ? '다음에 나눠 맡길 때 다시 물어봐요' : '지금 기본 배치로 돌아가요'
    }`,
  scopeSettings: '계속: 이 논문의 기본 배치가 돼요',
  fastDrain: '이 조합은 한도가 빨리 줄 수 있어요',
  designSwitch: (company: string) => `설계를 ${company}로 바꾸면 ${company} 대화로 넘어가요 — 다음 메시지를 보낼 때부터예요`,
  act: {
    continue: '이 배치로 계속',
    once: '이번만',
    decline: '나눠 맡기지 않기',
    changeContinue: (count: number) => `${count}개 바꾸기 · 계속`,
    changeOnce: (count: number) => `${count}개 바꾸기 · 이번만`,
    allContinue: '계속 이렇게',
    allOnce: '이번만',
    ack: '확인',
    cancel: '취소',
    settingsContinue: '계속'
  },
  acting: '적용하는 중…',
  unknown: '적용됐는지 확인하지 못했어요',
  recheck: '다시 확인',
  folded: {
    /** §3-5 접힘 — "작업 분담을 바꿨어요 — 자료 찾기 Claude Sonnet (계속) · 적용 안 함: 검토(새 대화 규칙)". */
    applied: (first: boolean, applied: string, scope: string, rejected: string[]) => {
      const head = `${first ? '작업 분담을 정했어요' : '작업 분담을 바꿨어요'} — ${applied} (${scope})`
      return rejected.length > 0 ? `${head} · 적용 안 함: ${rejected.join(', ')}` : head
    },
    cancelled: '취소했어요',
    declined: '나눠 맡기지 않기로 했어요',
    invalid: '이 카드는 이미 처리됐거나 더 이상 쓸 수 없어요 — 지금 배치는 설정 › 작업 분담에서 볼 수 있어요',
    superseded: '새 카드로 바뀌었어요',
    details: '자세히',
    detailsClose: '접기'
  },
  /** 카드 줄 값 — 적용/거절. */
  rowApplied: (company: string, model: string, depth: string) => `${company} · ${model} · ${depth}`,
  rowRejected: '적용 안 함',
  /** 거절 사유 — `LaneRejectReason` 코드. */
  reject: {
    'not-subscribed': '구독 로그인이 아니라 이 회사는 쓰지 않아요',
    malformed: '말에서 배치를 알아내지 못했어요',
    'cross-provider': '다른 회사의 모델이라 쓸 수 없어요',
    'model-unverified': '이 계정에서 확인되지 않은 모델이에요',
    'model-not-listed': '이 계정 목록에 없는 모델이에요',
    'effort-not-supported': '이 모델이 지원하지 않는 깊이예요',
    'review-main': '검토는 늘 새 대화에서 해요'
  },
  /** 접힌 줄의 짧은 사유 — "검토(새 대화 규칙)". */
  rejectShort: {
    'not-subscribed': '구독 아님',
    malformed: '알아내지 못함',
    'cross-provider': '다른 회사',
    'model-unverified': '확인 안 됨',
    'model-not-listed': '목록에 없음',
    'effort-not-supported': '깊이 미지원',
    'review-main': '새 대화 규칙'
  },
  /** §3-4 검토 모델 고르기. */
  reviewPickTitle: '검토 모델 고르기',
  reviewPickNote: '이 계정에서 깊이 높게를 쓸 수 있는 모델만 보여요. 고르면 배치 카드가 떠요.',
  reviewPickFailed: '목록을 불러오지 못했어요',
  reviewPickEmpty: '쓸 수 있는 모델이 없어요'
} as const

// =====================================================================================
// §4-2 한도로 멈춘 대화
// =====================================================================================

export const LANE_ARCHIVE = {
  folderSub: (count: number) => `이 논문의 한도로 멈춘 대화 ${count}개`,
  open: '열기',
  note: '읽기만 할 수 있어요. 열면 설정 창이 닫히고 대화 칸에 보여요.',
  stoppedAt: (stamp: string) => `${stamp} 멈춤`,
  bannerTitle: '한도로 멈춘 대화예요 · 읽기 전용',
  bannerSub: (model: string, stamp: string) => `${model} · ${stamp} 멈춤`,
  back: '지금 대화로 돌아가기',
  others: '다른 멈춘 대화 ▾',
  notices: (count: number) => `지금 대화에 안내 ${count}건`
} as const

// =====================================================================================
// §5 설정 "작업 분담"
// =====================================================================================

export const LANES_SETTINGS = {
  title: '작업 분담',
  tableTitle: '이 논문의 기본 배치',
  caption: '이 논문에서 역할별로 맡기는 모델이에요. 검토는 늘 새 대화에서 해요.',
  colLane: '역할',
  colModel: '회사 · 모델',
  colDepth: '깊이',
  colWhere: '어디서',
  whereNew: '새 대화',
  whereMain: '본대화',
  designCell: (recommended: string | null) => `아래 칩에서 골라요${recommended ? ` (추천 ${recommended})` : ''}`,
  source: {
    recommended: (label: string) => `추천 — ${label}`,
    mine: (iso: string) => `내가 정함 · ${dayKo(iso)}`,
    changed: '추천이 바뀌었어요 — 되돌리기로 새 추천을 쓸 수 있어요',
    none: '아직 정하지 않았어요'
  },
  pendingHead: '아직 승인하지 않은 추천 배치예요 — 처음 맡길 때 이 배치로 물어봐요',
  temporary: (text: string) => `지금 이번 차례만: ${text} (끝나면 위 배치로 돌아가요)`,
  nextDesign: (company: string) => `다음 메시지부터: 설계 ${company}`,
  hint: '바꾸려면 대화에 “자료는 Sonnet으로”처럼 말하세요.',
  revert: '추천으로 되돌리기',
  turnOff: '나눠 맡기기 끄기',
  turnOn: '나눠 맡기기 켜기',
  offBody: '나눠 맡기지 않아요 — 도우미가 혼자 하고 독립 검토는 하지 않아요',
  consentTitle: '요금 안내 동의',
  consentNote: '계정마다 · 모든 논문에 적용',
  consentAgreed: (day: string) => `동의함${day ? ` · ${day}` : ''}`,
  consentNone: '아직 안 함 — 처음 맡길 때 물어봐요',
  consentWithdrawn: (day: string) => `거둠${day ? ` · ${day}` : ''}`,
  consentAgree: '안내 보고 동의하기',
  consentAgain: '안내 보고 다시 동의하기',
  consentWithdraw: '동의 거두기',
  consentOnly: '구독 로그인일 때만 작업 분담을 써요.',
  noFolder: '논문을 열면 그 논문의 배치가 보여요',
  notSubscribed: '구독 로그인이 아니라 이 회사는 쓰지 않아요',
  mainTakeover: (model: string) => `도우미가 직접 맡아요 — 추천 모델(${model})이 이 계정에 없어요`,
  reviewUnavailable: '검토 안 함',
  reviewPick: '검토 모델 고르기',
  offConfirmTitle: '나눠 맡기지 않을까요?',
  offConfirmBody: '진행 중인 담당은 멈춰요, 결과는 넘기지 않아요. 앱이 맡긴 담당만이에요.',
  withdrawConfirmTitle: '요금 안내 동의를 거둘까요?',
  withdrawConfirmBody: (company: string, account: string) =>
    `${company} 계정(${account})에서 앱이 나눠 맡기지 않아요. 앱이 맡긴 ${company} 담당은 멈춰요 — 이미 쓴 사용량은 되돌릴 수 없어요.`,
  consentConfirmTitle: (company: string) => `${company} 요금 안내에 동의할까요?`,
  spent: '이미 쓴 사용량은 되돌릴 수 없어요'
} as const

/** 진행 줄이 있을 때 입력칸 ■의 이름(설계 §2-1 [r2 W25]). */
export const LANE_STOP_LABEL = '대화와 담당 함께 멈추기'

/** 테스트 주입 통로 — preload(preload/index.ts)에 `lanes` 가 아직 없어서(배선 C1 몫) 화면 시험은 이 사건으로 상태를 넣는다. */
export const LANES_TEST_EVENT = 'knuaf:lanes-test'

/** 폴더가 없거나 이음매가 없을 때 화면이 쓰는 빈 값 대신 — 계산하지 않는다는 원칙상 store 가 `null` 로 둔다. */
export type LaneModelRef = ModelRef
