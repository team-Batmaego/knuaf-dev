import type { ArtifactItem, Envelope, HistoryRow, LockInfo, MajorBinding, OwnerCleanup, MaterialsData, RpcError, RpcResult, SectionRow, Status } from '../../shared/types'
import type { StageBuildTree } from '../../shared/stage'
import { usePrep, WRITE_METHODS } from './store/prep'

export type EventHandler = (event: string, data: unknown) => void

/**
 * `project.load` — 정본 전체. 파일 현재성은 여기 `outputs[*].stale` 뿐이다(v2 §4-1).
 * `artifact.list` 의 `revision` 은 outputs 에 등록된 항목의 값이라 미등록 검토본에서 null 이
 * 되므로 현재성 판단에 쓰지 않는다(검토 IMPL-R1-03).
 */
export interface ProjectOutput { path?: string | null; revision?: number | null; stale?: boolean }
export interface ProjectLoad {
  project: Record<string, unknown> & { outputs?: Record<string, ProjectOutput> }
  revision: number
  schema_version: number
}

/** `section.read_all` — 등록 순서대로 읽은 절 본문(section.read 와 같은 모양). */
export interface SectionRead { id: string; title: string; path: string; draft: string; raw_chars?: number }

export class RpcFailure extends Error {
  code: string
  data?: unknown
  constructor(err: RpcError) { super(err.message); this.code = err.code; this.data = err.data }
}

let seq = 0

async function call<T>(method: string, params: Record<string, unknown> = {}, onEvent?: EventHandler, clientId?: string): Promise<T> {
  // 쓰기 작업 동안 그 폴더의 대화 전송은 기다리고 화면은 "저장·검사를 마치는 중" 한 줄을 띄운다
  // (형님 확정 2026-10-19 알림 B안 — 기다림이지 오류가 아니다, 끝나면 사라진다).
  const root = WRITE_METHODS.has(method) && typeof params.root === 'string' ? params.root : null
  if (root) usePrep.getState().begin(root, 'write')
  try {
    const r: RpcResult<T> = await window.knuaf.call(method, params, onEvent, clientId)
    if (r.error) throw new RpcFailure(r.error)
    return r.result as T
  } finally {
    if (root) usePrep.getState().end(root, 'write')
  }
}

const OUTPUT_METHODS: Record<string, true> = {
  'paper.generate': true, 'docx.build': true, 'excel.create': true, 'excel.clear': true, 'excel.fill': true,
  'excel.formula_patch': true, 'excel.print': true, 'office.word': true, 'office.excel': true, 'office.batch': true
}

async function outputParams(params: Record<string, unknown>, clientId?: string): Promise<Record<string, unknown>> {
  const binding = await call<MajorBinding>('project.major', { root: params.root }, undefined, clientId)
  // Explicit caller choices still reach the original guard, which rejects a mismatch.
  return { ...params, major_id: 'major_id' in params ? params.major_id : binding.major_id }
}

// Own the preflight gap even when main has already finished the read and cannot cancel it.
const preflightCancels = new Map<string, () => boolean>()

async function script(method: string, params: Record<string, unknown>, onEvent?: EventHandler, clientId?: string): Promise<Envelope> {
  if (OUTPUT_METHODS[method] !== true) return call<Envelope>(method, params, onEvent, clientId)
  const id = clientId ?? rpc.newClientId()
  let interrupt!: (error: RpcFailure) => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
  let preparing = true
  let cancellation: RpcFailure | null = null
  preflightCancels.set(id, () => {
    if (!preparing) return false // Once dispatched, the real output's cancellation result is authoritative.
    cancellation ??= new RpcFailure({ code: 'cancelled', message: 'request cancelled' })
    interrupt(cancellation)
    return true
  })
  try {
    const selected = await Promise.race([outputParams(params, id), interrupted])
    if (cancellation) throw cancellation // Cancellation may win just after the read promise settled.
    preparing = false
    return await call<Envelope>(method, selected, onEvent, id)
  } finally {
    preflightCancels.delete(id)
  }
}

export const rpc = {
  call,
  status: (root: string) => call<Status>('project.status', { root }),
  load: (root: string) => call<ProjectLoad>('project.load', { root }),
  major: (root: string) => call<MajorBinding>('project.major', { root }),
  checks: (root: string, scope: 'all' | 'submission' = 'all') => call<Status['checks']>('project.checks', { root, scope }),
  sections: (root: string) => call<SectionRow[]>('project.sections', { root }),
  readSection: (root: string, id: string) => call<{ id: string; title: string; path: string; draft: string }>('section.read', { root, id }),
  readAllSections: (root: string) => call<SectionRead[]>('section.read_all', { root }),
  export: async (root: string, kind: string) => call<{ path: string; kind: string; status: string; request_id: string }>(
    'project.export', await outputParams({ root, kind })),
  history: (root: string) => call<HistoryRow[]>('project.history', { root }),
  restore: (root: string, revision: number, expected_revision: number) => call<{ revision: number; restored_from: number; pre_restore_snapshot: string; notice: string }>('project.restore', { root, revision, expected_revision }),
  lockInfo: (root: string, probe = false) => call<LockInfo>('lock.info', { root, probe }),
  unlock: (root: string) => call<OwnerCleanup>('lock.unlock', { root }),
  doctor: (root: string) => call<Record<string, any>>('doctor.all', { root }),
  /**
   * `build/` 아래 개정별 폴더. 검토본 기준 N 은 여기서 읽는다(진행 규칙 §4-4) —
   * `artifact.list` 의 `revision` 은 미등록 검토본에서 null 이라 쓰지 않는다.
   * 3-A 가 `StageBuildTree` 를 주고, 그 모양과 실제 응답이 같음은 3-A 의 변환 시험이 잠갔다.
   */
  buildTree: (root: string) => call<StageBuildTree>('fs.build_tree', { root }),
  materials: (root: string) => call<MaterialsData>('materials.list', { root }),
  artifacts: (root: string) => call<{ items: ArtifactItem[] }>('artifact.list', { root }),
  init: (root: string) => call<{ project: unknown }>('project.init', { root }),
  /** Long-running script; pass a `clientId` from `newClientId()` to be able to `cancel` it. */
  script,
  /** Mint a renderer-side id for a cancellable call. */
  newClientId: () => `r${Date.now().toString(36)}-${++seq}`,
  /** Cancel the owned preflight and the current main request under the same clientId. */
  cancel: async (clientId: string): Promise<boolean> => {
    const local = preflightCancels.get(clientId)?.() ?? false
    return (await window.knuaf.cancel(clientId)) || local
  }
}

/** Human wording for error codes; the raw message is always shown too. */
export function describeError(e: unknown): string {
  if (e instanceof RpcFailure) {
    const prefix: Record<string, string> = {
      lock_held: '다른 작업이 폴더를 잠그고 있어요. "설정 > 문제 해결"에서 잠금 상태를 확인하세요.',
      revision_stale: '정본이 그사이 바뀌었어요. 새로고침 후 다시 시도하세요.',
      overwrite_refused: '이미 같은 이름의 결과물이 있어 덮어쓰지 않았어요. 결과물 목록에서 열 수 있어요.',
      deps_not_ready: '작업 준비가 아직 끝나지 않았어요. 준비 작업을 자동으로 다시 시도해요. 계속되면 "설정 > 문제 해결"에서 확인해 주세요.',
      sidecar_down: 'Python 실행기가 꺼져 있어요. 설정에서 다시 시작하세요.',
      timeout: '시간 안에 끝나지 않아 중단했어요.',
      cancelled: '취소했어요.'
    }
    return (prefix[e.code] ? prefix[e.code] + ' ' : '') + `(${e.code}) ${e.message}`
  }
  return String(e)
}
