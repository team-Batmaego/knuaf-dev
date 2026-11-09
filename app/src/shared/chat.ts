import type { Provider } from './lanes'
export type { Provider } from './lanes'
export { CODEX_TIER_MODELS, CODEX_MODEL_ALIASES, WORK_LANES, codexRecommendations, isCrossProviderModelId, resolveCodexAlias } from './lanes'
export type { CodexTier, CodexRecommendation, LaneRecommendation, WorkLane } from './lanes'

/**
 * 학생이 고른 모델과 생각 깊이. 고르지 않았으면 `null` 이고, 그때 앱은 지금까지처럼
 * 모델·effort 를 **보내지 않는다**(CLI·계정 기본값). 대화 파일이 아니라 설정에 남는다 —
 * `.knuaf-gui/chat-*.json` 의 저장 형식은 그대로다.
 */
export interface ModelChoice { model: string; effort: string | null }
/** `model/list` 가 알려 준, 이 계정이 쓸 수 있는 모델 하나. */
export interface ChatModelInfo {
  /** `turn/start` 의 `model` 에 그대로 넣는 값. */
  model: string
  /** 학생 화면에 보일 이름(displayName). */
  name: string
  description: string
  /** 고를 수 있는 생각 깊이(`supportedReasoningEfforts`). */
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}
/**
 * 모델 목록 통로의 응답.
 * `supported:false` 는 그 공급자에 아직 이 통로가 없다는 뜻이다(이번 판의 Claude) —
 * 화면은 추천·목록을 띄우지 않고 지금처럼 기본값으로 둔다.
 */
export interface ChatModels {
  provider: Provider
  supported: boolean
  models: ChatModelInfo[]
  /** 설정에 남은 선택. 목록에 없으면 `null`(안 골름) — 칩도 선택 없음으로 보인다. */
  selected: ModelChoice | null
  /** 목록을 받지 못했을 때의 이유. 있으면 `models` 는 비어 있다. */
  error?: string
}
/**
 * 'interrupted' 는 앱이 죽은 뒤 복구했을 때, 'stopped' 는 학생이 중단을 눌렀을 때.
 * 둘을 한 상태로 쓰면 화면이 멀쩡히 살아 있는 앱을 두고 "종료됐어요"라고 말한다(GUI-05).
 */
export type RunState = 'idle' | 'running' | 'permission' | 'interrupted' | 'stopped' | 'error'
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string
  delivery?: 'pending' | 'sent' | 'uncertain'
}
/** Codex fileChange 항목의 내용. add/delete의 diff는 파일 내용이고 update는 unified diff다. */
export interface PermissionFileChange {
  path: string
  kind: { type: 'add' | 'delete' | 'update' | 'unknown'; move_path?: string | null }
  diff: string | null
}
export interface PermissionRequest { id: string; title: string; detail: string; fileChanges?: PermissionFileChange[] }
export interface ChatSnapshot {
  root: string; provider: Provider; sessionId?: string; state: RunState
  messages: ChatMessage[]; permission?: PermissionRequest; error?: string
  skillHash?: string; skillLoaded?: boolean
  /** 전송 중 확인된 인증 실패. 상태 조회의 옛 로그인 정보보다 우선한다. */
  authRequired?: boolean
}
/**
 * 연결 도구의 상태. `connected` 하나로는 "로그인이 필요해요"와 "확인하지 못했어요"를
 * 구별할 수 없다 — Claude 의 `auth status` 가 시간 초과·오류·잘못된 JSON 으로 실패해도
 * 예전에는 조용히 `connected:false` 가 되어 화면이 로그인을 요구했다.
 *
 * `probe` 는 그 구분이다: `'ok'` = CLI 가 정상 응답을 줬다(연결 여부는 지금 규칙대로),
 * `'failed'` = 실행 실패·시간 초과·파싱 실패라 **연결 여부를 알 수 없다**.
 * 값이 없으면 `'ok'` 로 읽는다 — 기존 호출자의 동작이 그대로다.
 */
export interface ConnectionStatus { installed: boolean; connected: boolean; version: string | null; detail: string; probe?: 'ok' | 'failed' }
export interface Artifact { path: string; name: string; kind: 'docx' | 'xlsx' | 'pdf'; modified: number }
export interface Material { path: string; role: 'manuscript' | 'finance' | 'reference'; name: string }
export type Preview = { kind: 'pdf'; url: string } | { kind: 'xlsx'; sheets: { name: string; rows: string[][]; truncated: boolean }[] } | { kind: 'unavailable'; reason: string }
export type GuiReply<T> = { result: T; error?: never } | { error: string; result?: never }

/**
 * 설정에 남은 선택을 이 계정 목록에 비춰 정규화한다.
 * - 목록을 아직 모르면(`null`) 선택을 그대로 둔다 — 목록을 못 받았다고 학생 선택을 지우지 않는다.
 * - 목록에 없는 모델이면 `null`(안 골름): 요금제가 바뀌어 그 모델이 사라져도 다음 전송이
 *   실패하지 않고 지금까지처럼 기본값으로 돈다.
 * - 그 모델이 지원하지 않는 생각 깊이는 버린다(모델 선택은 살린다).
 */
export function effectiveModelChoice(
  choice: ModelChoice | null | undefined,
  models: ChatModelInfo[] | null
): ModelChoice | null {
  const model = typeof choice?.model === 'string' ? choice.model.trim() : ''
  if (!model) return null
  const effort = typeof choice?.effort === 'string' && choice.effort ? choice.effort : null
  if (!models) return { model, effort }
  const info = models.find((m) => m.model === model)
  if (!info) return null
  return { model, effort: effort && info.efforts.includes(effort) ? effort : null }
}
