import type { AgentConnection, AgentEvents } from '../contracts'
import type { Provider, WorkLane } from '../../../shared/chat'
import type { AccountSnapshot, LaneEntry, LanePlan } from '../../../shared/lanes'
import type { RelayIsolation } from './isolation'
import type { TokenEvent } from './tokens'

export type JobLane = Exclude<WorkLane, 'design'>
export type JobStatus = 'queued' | 'running' | 'completed' | 'limit' | 'unknown' | 'auth' | 'stopped' | 'interrupted' | 'rejected' | 'error' | 'violation'
export interface InputReference { sourceId: string; path: string; hash: string; section: string }
export interface JobSpec {
  schema: number
  id: string
  lane: JobLane
  task: string
  inputs: InputReference[]
  outputs: string[]
  contractVersion: string
  company: Provider
  model: string
  effort: string | null
  parent?: string
  cause?: 'student-continue-after-limit'
}
/** App-owned identity, never read from a job file or lanes.json. */
export interface ConversationOwner { id: string; sessionId: string; company: Provider }
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
export type UsageState = 'allowed' | 'limit' | 'unknown' | 'auth'
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
  /** App-selected CPython; descriptor-relative public writes fail closed if unsupported. */
  python: string
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
