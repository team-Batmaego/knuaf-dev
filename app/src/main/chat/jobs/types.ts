import type { AgentConnection, AgentEvents } from '../contracts'
import type { Provider } from '../../../shared/chat'
import type { AccountSnapshot, LaneEntry, LanePlan } from '../../../shared/lanes'
import type { RelayIsolation } from './isolation'
import type { TokenEvent } from './tokens'
import type { ConversationOwner, JobLane, JobStatus, UsageState } from '../../../shared/lanes-ipc'

/** 화면도 읽는 타입은 정의를 `shared/lanes-ipc.ts` 한 곳에 두고 여기서는 재수출만 한다. */
export type { ConversationOwner, JobLane, JobStatus, UsageState }

export interface InputReference { sourceId: string; path: string; hash: string; section: string }
export interface JobSpec {
  schema: number
  id: string
  lane: JobLane
  task: string
  inputs: InputReference[]
  outputs: string[]
  /** Skill-owned research-job.md §1; the app checks only lane presence and output ownership. */
  research?: {
    research_type: string
    questions: unknown[]
    routes: { doc: string; id_or_name: string; url: string }[]
    keywords: string[]
    output_file: string
    [field: string]: unknown
  }
  contractVersion: string
  company: Provider
  model: string
  effort: string | null
  parent?: string
  cause?: 'student-continue-after-limit'
}
export interface JobRecord {
  spec: JobSpec
  rootJobId: string
  root: string
  owner: ConversationOwner
  authorSessionId: string
  reviewerSessionId?: string
  sessionId?: string
  actualModel?: string
  actualEffort?: string | null
  status: JobStatus
  reason?: string
  accountId?: string
  proposalId?: string
  contentHash: string
  outputs: string[]
  createdAt: string
}
export interface ExecutionAccount {
  accountId: string
  connected: boolean
  account: AccountSnapshot
  consented: boolean
  usage: UsageState
}
export interface JobEvents extends AgentEvents {
  availability: (state: UsageState) => void
  tokens: (event: TokenEvent) => void
  actualModel: (model: string, effort: string | null) => void
}
/** An ordinary AgentConnection is deliberately insufficient: engines must enforce the relay contract. */
export interface JobConnection extends AgentConnection {
  relayProtocol: 1
  /**
   * 첫 턴 안에서 사용량 신호를 재판정할 수 있다는 연결 쪽 선언(㉠).
   * `true`인 연결만 턴 전 `usage:'unknown'`을 통과시켜 첫 턴을 연다;
   * 없거나 거짓이면 현행(unknown 차단) 그대로다. 엔진 구현은 배선 A 몫이라
   * 여기서 선언만 받고, 가짜 연결로 시험한다.
   */
  gateInTurn?: boolean
  availability(): Promise<ExecutionAccount>
  runJob(text: string, events: JobEvents): Promise<void>
}
export interface RelayRequest {
  key: string
  jobId: string
  company: Provider
  cwd: string
  skill: string
  model: string
  effort: string | null
  isolation: RelayIsolation
}
export interface JobResult {
  rootJobId: string
  jobId: string
  status: JobStatus
  outputs: string[]
  company: Provider
  model: string
  effort: string | null
}
export interface JobRunnerOptions {
  /** Private app storage, outside the thesis folder. Only the app writes here. */
  stateDir: string
  approvedPlan: (root: string) => LanePlan | null
  account: (company: Provider) => Promise<ExecutionAccount | null>
  skill: () => { path: string; schema: number; contractVersion: string }
  supportedSchemas: readonly number[]
  connectionFactory: (request: RelayRequest) => JobConnection
  /** The caller deduplicates by rootJobId too; claims are persisted before calling. */
  deliver: (owner: ConversationOwner, result: JobResult) => Promise<void>
  stopMain: (owner: ConversationOwner) => Promise<void>
  diagnostic: (record: object) => void
  shellSandboxAvailable: boolean
}
export interface ContinuationProposal {
  proposalId: string
  rootJobId: string
  parentJobId: string
  newJobId: string
  entry: LaneEntry
  accountId: string
  accountFingerprint: string
  contentHash: string
  state: 'open' | 'consumed' | 'discarded'
  shownAt: string
  clickedAt?: string
}
export class JobFailure extends Error {
  constructor(public readonly status: 'limit' | 'unknown' | 'auth', message: string) { super(message) }
}
