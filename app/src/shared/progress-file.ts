// progress (v0.6.4 2단계) — 스킬이 쓴 진행 파일(`.knuaf-progress.json`)의 형식·검증·변환.
//
// IMPL-T1 §4-1. 파일이 정본이고, 하나라도 어긋나면 **파일 전체**를 버린다(부분 채택 금지).
// 검증은 순수 함수 — 예외 없이 `null`을 돌려주고, 호출자(main)는 그대로 렌더러에 넘긴다.
// 렌더러는 파일 경로를 모른다: main이 읽은 내용만 IPC로 받는다(신뢰 경계, §4-2).
import type { Provider } from './chat'
import {
  pickProgress,
  type PickResult,
  type ProgressBlock,
  type ProgressPick,
  type ProgressStep,
  type StoredProgress,
} from './progress-list'

/** 논문 폴더 안 고정 이름. 스킬(`gg.py progress --write`)이 쓴다. */
export const PROGRESS_FILE_NAME = '.knuaf-progress.json'
export const PROGRESS_SCHEMA = 'knuaf.progress/1'
/** 문자열 필드 상한 — 넘으면 파일 전체 무효(§4-1). */
export const PROGRESS_MAX_TEXT = 500
/** `unknown` 단계에 붙는 메모 — `copy.ts`의 `PROGRESS.uncertain`과 같은 말. */
export const UNCERTAIN_NOTE = '확인 필요'

export type ProgressFileState = 'done' | 'now' | 'todo' | 'unknown'

export interface ProgressFileStep {
  n: number
  state: ProgressFileState
  note?: string
}

export interface ProgressFileFlag {
  text: string
  needed_for: number
}

export interface ProgressFileAfter {
  text: string
  owner: string
}

/** 검증을 통과한 파일 내용. 없는 필드는 기본값으로 채운다. */
export interface ProgressFile {
  schema: typeof PROGRESS_SCHEMA
  written_at: string
  revision: number
  skill_version: string
  review_pending: boolean
  steps: ProgressFileStep[]
  flags: ProgressFileFlag[]
  after: ProgressFileAfter | null
  next: string | null
  ask: string | null
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= PROGRESS_MAX_TEXT

const isStepState = (v: unknown): v is ProgressFileState =>
  v === 'done' || v === 'now' || v === 'todo' || v === 'unknown'

function readSteps(v: unknown): ProgressFileStep[] | null {
  if (!Array.isArray(v) || v.length !== 7) return null
  const steps: ProgressFileStep[] = []
  const seen = new Set<number>()
  for (const raw of v) {
    if (!isPlain(raw)) return null
    const n = raw.n
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 7 || seen.has(n)) return null
    seen.add(n)
    if (!isStepState(raw.state)) return null
    if (raw.note !== undefined && !isText(raw.note)) return null
    steps.push({ n, state: raw.state, ...(raw.note === undefined ? {} : { note: raw.note }) })
  }
  // n 1~7 중복·누락 없이 — 길이 7 + 서로 다른 1~7이면 자동으로 채워진다.
  if (seen.size !== 7) return null
  // 상태 규칙(규칙집 wES:p2R 요청): ▶가 하나 이상이거나, ▶ 없이 전부 ✓ 또는 `unknown`.
  // `unknown`만 섞인 경우는 허용하고, ○(todo)가 있는데 ▶가 없으면 여전히 무효다.
  const hasNow = steps.some((s) => s.state === 'now')
  const settled = steps.every((s) => s.state === 'done' || s.state === 'unknown')
  if (!hasNow && !settled) return null
  return steps.sort((a, b) => a.n - b.n)
}

function readFlags(v: unknown): ProgressFileFlag[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const flags: ProgressFileFlag[] = []
  for (const raw of v) {
    if (!isPlain(raw)) return null
    if (!isText(raw.text)) return null
    const neededFor = raw.needed_for
    if (typeof neededFor !== 'number' || !Number.isInteger(neededFor)) return null
    flags.push({ text: raw.text, needed_for: neededFor })
  }
  return flags
}

function readAfter(v: unknown): ProgressFileAfter | null | undefined {
  if (v === undefined || v === null) return null
  if (!isPlain(v)) return undefined
  if (!isText(v.text) || !isText(v.owner)) return undefined
  return { text: v.text, owner: v.owner }
}

/**
 * 파일 글자(또는 이미 파싱한 값)를 검증해 `ProgressFile`로 만든다.
 * 어긋나면 `null` — 호출자는 "파일 없음"과 똑같이 다룬다(파서 → 저장값으로 떨어진다).
 */
export function parseProgressFile(raw: string | unknown): ProgressFile | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isPlain(value)) return null
  if (value.schema !== PROGRESS_SCHEMA) return null
  if (!isText(value.written_at) || Number.isNaN(Date.parse(value.written_at))) return null
  const steps = readSteps(value.steps)
  if (steps === null) return null
  const flags = readFlags(value.flags)
  if (flags === null) return null
  const after = readAfter(value.after)
  if (after === undefined) return null
  if (value.review_pending !== undefined && typeof value.review_pending !== 'boolean') return null
  if (value.revision !== undefined && (typeof value.revision !== 'number' || !Number.isInteger(value.revision))) return null
  if (value.skill_version !== undefined && !isText(value.skill_version)) return null
  if (value.next !== undefined && value.next !== null && !isText(value.next)) return null
  if (value.ask !== undefined && value.ask !== null && !isText(value.ask)) return null
  return {
    schema: PROGRESS_SCHEMA,
    written_at: value.written_at,
    revision: typeof value.revision === 'number' ? value.revision : 0,
    skill_version: typeof value.skill_version === 'string' ? value.skill_version : '',
    review_pending: value.review_pending === true,
    steps,
    flags,
    after,
    next: typeof value.next === 'string' ? value.next : null,
    ask: typeof value.ask === 'string' ? value.ask : null,
  }
}

/**
 * 파일 내용 → 화면이 그리는 진행 목록(`ProgressBlock`).
 * `unknown`은 그 단계만 "확인 필요"로 그린다 — 유효성엔 영향이 없다(§4-1).
 * 메모가 있으면 메모만 그린다(규칙집 wES:p2R 요청 — "확인 필요" 덧말을 붙이지 않음).
 */
export function progressBlockOf(file: ProgressFile): ProgressBlock {
  const steps: ProgressStep[] = file.steps.map((s) => {
    if (s.state === 'unknown') {
      return s.note === undefined
        ? { n: s.n, state: 'unknown', note: UNCERTAIN_NOTE }
        : { n: s.n, state: 'unknown', note: s.note }
    }
    return s.note === undefined ? { n: s.n, state: s.state } : { n: s.n, state: s.state, note: s.note }
  })
  const nowList = steps.filter((s) => s.state === 'now').map((s) => s.n)
  const doneList = steps.filter((s) => s.state === 'done').map((s) => s.n)
  const allDone = steps.every((s) => s.state === 'done')
  return {
    steps,
    flags: file.flags.map((f) => f.text),
    after: file.after === null ? null : file.after.text,
    reviewPending: file.review_pending,
    // 표시 n(규칙집 wES:p2R 요청) — ▶가 있으면 가장 큰 ▶, 전부 ✓이면 7,
    // ▶ 없이 ✓·unknown이 섞였으면 가장 큰 ✓(✓가 하나도 없으면 1). 파서 규칙은 그대로.
    n: nowList.length ? Math.max(...nowList) : allDone ? 7 : doneList.length ? Math.max(...doneList) : 1,
  }
}

/**
 * 파일 값 → 고른 진행값. 저장값과 섞지 않는다(파일이 정본, §4-2 중요 7).
 * `messageId`·`at`은 파일이 언제 쓰였는지만 담는다 — localStorage에는 저장하지 않는다.
 */
export function progressPickOf(file: ProgressFile, provider: Provider): ProgressPick {
  return {
    block: progressBlockOf(file),
    messageId: `file:${file.written_at}`,
    provider,
    at: file.written_at,
  }
}

export type ProgressSource = 'file' | 'conversation' | 'stored' | 'none'

export interface ProgressChoice {
  kind: ProgressSource
  pick: ProgressPick | null
}

/**
 * 제목줄이 그릴 값 하나를 고른다 — 우선순위 §4-2 중요 7.
 *
 * 1. 검증된 파일이 있으면 **파일이 정본**(대화·저장값과 시각 비교 없음).
 * 2. 파일이 없거나 무효면 1단계 그대로 — 대화 파서 값 → 저장값.
 */
export function chooseProgress(
  file: ProgressFile | null,
  provider: Provider,
  conv: ProgressPick | null,
  stored: StoredProgress | null,
  snapshotRoot: string | null,
  root: string | null,
): ProgressChoice {
  if (root === null || root === '') return { kind: 'none', pick: null }
  if (file !== null) return { kind: 'file', pick: progressPickOf(file, provider) }
  const result: PickResult = pickProgress(conv, stored, snapshotRoot, root)
  return result.kind === 'none' ? { kind: 'none', pick: null } : { kind: result.kind, pick: result.pick }
}
