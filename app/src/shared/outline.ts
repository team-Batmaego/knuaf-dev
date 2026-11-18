/**
 * 학교 차례(목차) 상태 — CONTRACT-A4 §1.
 *
 * 규칙집(knuaf-doc)의 `gg_outline.outline_state` 가 답하는 것을 **그대로** 받는다. 앱은 새 상태를
 * 만들지 않고, 모르는 값이 오면 '모른다'(null)로 접는다 — 모르는 것을 '차례 없음'으로 읽으면
 * 없는 사실을 학생에게 말하게 된다.
 *
 * `unsupported` 는 오류가 아니다: 앱이 옛 규칙집 판을 쓰고 있어 그 모듈이 없는 경우다
 * (CONTRACT-A4 §2). 그때도 지금 문구 그대로다.
 */
export type OutlineStateName =
  | 'not_bound'
  | 'seeded'
  | 'no_school_toc'
  | 'existing_manuscript'
  | 'outline_conflict'
  | 'unsupported'

export interface OutlineState {
  state: OutlineStateName
  major_id: string | null
  profile_id: string | null
  sections: number
  reason: string | null
}

const STATES: readonly string[] = [
  'not_bound', 'seeded', 'no_school_toc', 'existing_manuscript', 'outline_conflict', 'unsupported'
]

/**
 * 사이드카 응답을 검사한다. 모양이 어긋나거나 모르는 `state` 면 null — 화면은 그러면 아무 주장도
 * 하지 않는다(새 상태를 내놓는 새 규칙집 판이 와도 앱이 먼저 사실을 지어내지 않게).
 */
export function outlineStateOf(raw: unknown): OutlineState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.state !== 'string' || !STATES.includes(value.state)) return null
  return {
    state: value.state as OutlineStateName,
    major_id: typeof value.major_id === 'string' ? value.major_id : null,
    profile_id: typeof value.profile_id === 'string' ? value.profile_id : null,
    sections: typeof value.sections === 'number' ? value.sections : 0,
    reason: typeof value.reason === 'string' ? value.reason : null
  }
}

/** 제목줄이 지금 말할 한 줄이 어느 문구인가 — `copy.ts` 의 `TITLEBAR` 키. */
export type TitlebarNote = 'paperLater' | 'noSchoolToc'

/**
 * 제목줄 안내 한 줄의 **판정만** 한다(문구는 copy 가 갖는다 — CONTRACT-A4 §2 두째 줄).
 *
 * 바뀌는 조건은 둘 다 참일 때뿐이다:
 *  - 장이 **0개**다(`sectionCount === 0`). 목록을 못 읽었으면(`null`) 0개가 아니라 '모른다'이므로
 *    지금 문구 그대로다 — 읽기 실패를 "차례가 없다"로 꾸미지 않는다.
 *  - 규칙집이 `no_school_toc` 라고 답했다(학교 고정 차례가 없는 전공: 산업곤충·원예환경시스템).
 *
 * `seeded`·`existing_manuscript`·`outline_conflict`·`not_bound`·`unsupported`·오류는 모두 지금 문구다.
 */
export function titlebarNoteOf(sectionCount: number | null, outline: OutlineState | null): TitlebarNote {
  if (sectionCount !== 0) return 'paperLater'
  return outline?.state === 'no_school_toc' ? 'noSchoolToc' : 'paperLater'
}
