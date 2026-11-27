import { create } from 'zustand'
import type { DependencyReport } from '../../../shared/types'

export type PrepKind = 'prep' | 'write'
export type DependencyPhase = 'idle' | 'checking' | 'installing' | 'verifying' | 'ready' | 'blocked'
export interface DependencyPreparation {
  visit: number
  operationId: string
  phase: DependencyPhase
  report?: DependencyReport
  error?: { code: string; message: string; phase: 'checking' | 'installing' | 'verifying' }
}

interface PrepState {
  /** Counters represent unfinished work, not successful readiness. */
  prep: Record<string, number>
  write: Record<string, number>
  dependencies: Record<string, DependencyPreparation>
  begin: (root: string, kind?: PrepKind) => void
  end: (root: string, kind?: PrepKind) => void
  startDependency: (root: string, visit: number, operationId: string) => void
  updateDependency: (root: string, operationId: string, result: Partial<DependencyPreparation>) => void
}

const bump = (m: Record<string, number>, root: string, by: number): Record<string, number> => {
  const next = { ...m }
  const n = (m[root] ?? 0) + by
  if (n > 0) next[root] = n
  else delete next[root]
  return next
}

export const usePrep = create<PrepState>((set) => ({
  prep: {}, write: {}, dependencies: {},
  begin: (root, kind = 'prep') => set((s) => ({ [kind]: bump(s[kind], root, 1) }) as Partial<PrepState>),
  end: (root, kind = 'prep') => set((s) => ({ [kind]: bump(s[kind], root, -1) }) as Partial<PrepState>),
  startDependency: (root, visit, operationId) => set(s => ({ dependencies: {
    ...s.dependencies, [root]: { visit, operationId, phase: 'checking' }
  } })),
  updateDependency: (root, operationId, result) => set(s => s.dependencies[root]?.operationId === operationId
    ? { dependencies: { ...s.dependencies, [root]: { ...s.dependencies[root], ...result } } } : {})
}))

/**
 * S-01 규칙집(D-U 판)의 의존성 거부 코드 — JSON `code` + 종료 2. 앱은 이 글자로 잡아 학생이 할 일로 잇는다.
 * `deps_venv_empty`: 의존성 환경 경로가 빈 채로 설치(이 컴퓨터에서 아직 준비 안 함),
 * `deps_venv_readonly`: 도우미 전용 READONLY 에서 설치 시도.
 * 제목은 `copy.ts` ERROR_COPY 의 같은 코드 제목과 같아야 한다(preparation-state 시험이 잠근다).
 */
export const SKILL_REFUSAL_TITLES = {
  deps_venv_empty: '이 컴퓨터에서 아직 패키지를 준비하지 않았어요',
  deps_venv_readonly: '도우미는 패키지를 직접 설치하지 않아요'
} as const
export type SkillRefusalCode = keyof typeof SKILL_REFUSAL_TITLES

export function skillRefusalCode(data: unknown): SkillRefusalCode | null {
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : null
  return typeof code === 'string' && Object.hasOwn(SKILL_REFUSAL_TITLES, code) ? code as SkillRefusalCode : null
}

export function preparationFailureTitle(error: DependencyPreparation['error']): string {
  const refusal = skillRefusalCode(error)
  if (refusal) return SKILL_REFUSAL_TITLES[refusal]
  if (error?.code === 'deps_contract_unsupported') return '이 앱 판의 규칙집으로는 패키지를 준비할 수 없어요'
  if (error?.code === 'deps_env_placement') return '패키지를 둘 자리를 믿을 수 없어 준비하지 않았어요'
  if (error?.code === 'deps_required') return '이 컴퓨터에서 패키지를 준비해 주세요'
  if (error?.code === 'cancelled') return '준비를 취소했어요'
  if (error?.code === 'agent_busy') return '도우미가 작업 중이라 준비를 시작하지 못했어요'
  if (error?.phase === 'verifying') return '설치는 끝났지만 준비 확인에 실패했어요'
  if (error?.phase === 'checking' || error?.code === 'deps_doctor') return '준비 상태를 확인하지 못했어요'
  return '패키지 준비를 마치지 못했어요'
}

export function waitKind(s: Pick<PrepState, 'prep' | 'write'>, root: string | null): PrepKind | null {
  if (!root) return null
  if ((s.prep[root] ?? 0) > 0) return 'prep'
  if ((s.write[root] ?? 0) > 0) return 'write'
  return null
}

export const isPreparing = (root: string | null): boolean => waitKind(usePrep.getState(), root) !== null

/** Only this visit's proven ready result can release a send; blocked/idle never do. */
export function waitPrepared(root: string, leave: () => boolean, watchLeave: (check: () => void) => () => void): Promise<boolean> {
  const visit = usePrep.getState().dependencies[root]?.visit
  const outcome = (): boolean | null => {
    const state = usePrep.getState()
    const preparation = state.dependencies[root]
    if (leave() || preparation?.visit !== visit) return false
    if (isPreparing(root)) return null
    return preparation?.phase === 'ready'
  }
  const immediate = outcome()
  if (immediate !== null) return Promise.resolve(immediate)
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let offPrep = (): void => {}
  let offLeave = (): void => {}
  const check = (): void => {
    const result = outcome()
    if (result !== null) { offPrep(); offLeave(); resolve(result) }
  }
  offPrep = usePrep.subscribe(check)
  offLeave = watchLeave(check)
  check()
  return promise
}

export const WRITE_METHODS = new Set([
  'kordoc.ensure', 'lock.unlock', 'paper.generate', 'project.export', 'project.init', 'project.restore',
  // 뷰어 직접 수정은 정본을 쓴다 — 빠지면 저장하는 동안 화면의 쓰기 대기 안내가 안 걸린다(설계 §9).
  'section.edit', 'section.edit_batch'
])
