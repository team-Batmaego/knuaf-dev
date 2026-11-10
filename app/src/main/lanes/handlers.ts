/**
 * §5 화면 API 의 main 쪽 — 계약 `LANES_INVOKE` 14 + `JOBS_INVOKE` 8.
 *
 * 세 가지를 지킨다:
 * - **화면 값을 믿지 않는다**: 폴더·카드·주문은 이 프로세스가 아는 것과 대조하고, 다르면
 *   `not-found`·`no-folder` 로 돌려준다. 적용할 배치는 카드에 저장된 값뿐이다(`decideCard`).
 * - **상태가 바뀌면 묶음을 다시 보낸다**: 요청이 끝나면 `hub.touch(root)` 가 `lanes:changed` 를
 *   밀어 보낸다(계약 §5 첫 주석). 화면은 그 묶음으로 다시 그린다.
 * - **이음매가 없으면 `unavailable`**: 가짜 기본값으로 성공을 만들지 않는다.
 */
import type { Provider } from '../../shared/chat'
import { judgePlan } from '../../shared/lanes'
import {
  JOBS_INVOKE, LANES_INVOKE,
  type ArchivedChat, type ArchivedChatSummary, type CardAction, type CardDecision, type ConsentRow,
  type LaneCard, type LaneLine, type LanesErrorCode, type LanesReply, type LanesSnapshot,
  type ReviewModelGroup
} from '../../shared/lanes-ipc'
import type { JobRunner } from '../chat/jobs'
import { statSync } from 'node:fs'
import { canonical } from '../chat/jobs/isolation'
import type { JobStore } from '../chat/jobs/store'
import type { ExecutionAccount, JobRecord } from '../chat/jobs/types'
import {
  cardStatus, decideCard, disable, pickReview, reviewModels, settingsCard, type CardDeps
} from './cards'
import { LaneFailure } from './failure'
import { providerOf } from './providers'
import { consentRows, maskAccount, type LaneAccountView } from './snapshot'

/** IPC 등록 통로 — 시험에서 가짜 `ipcMain` 을 끼울 수 있게 최소만 요구한다. */
export interface LaneIpcChannel {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface LaneHandlerDeps {
  ipc: LaneIpcChannel
  hub: {
    snapshot(root: string | null): Promise<LanesSnapshot>
    /** 폴더를 고르지 않고 변경만 알린다([C1-15]). */
    nudge(): void
    touch(root?: string | null): void
  }
  store: JobStore
  runner: JobRunner | null
  account: (company: Provider) => Promise<ExecutionAccount | null>
  /** 캐시를 건너뛴 계정 조회([C1-06]) — 카드 적용 직전 대조가 쓴다. 없으면 `account`. */
  freshAccount?: (company: Provider) => Promise<ExecutionAccount | null>
  /**
   * 허용 폴더 경계([C1-08]) — main 이 지금 열어 둔 폴더(와 그 밖의 허용 폴더)만 통과시킨다.
   * 화면이 보낸 root 두 개를 서로 대조하는 것만으로는 **둘 다 바꿔** 다른 폴더의 저장 상태·
   * 전달 원문을 건드릴 수 있었다. 값이 `null` 이면 아직 폴더가 없다는 뜻이라 요청을 닫는다.
   */
  allowed: (folder: string) => boolean
  mainCompany: Provider
  /** 설계를 다른 회사로 바꾸는 적용(칩 다시 쓰기) — `null` 이면 그런 카드는 `unavailable`. */
  applyDesign: CardDeps['applyDesign']
  setConsent: (company: Provider, accountId: string, on: boolean) => { state: 'agreed' | 'withdrawn'; at: string | null }
  handoff: {
    continue: (root: string, proposalId: string) => Promise<void>
    later: (root: string, proposalId: string) => void
    archives: (root: string) => ArchivedChatSummary[]
    archive: (root: string, archiveId: string) => ArchivedChat | null
  }
  jobs: {
    stopOne: (root: string, jobId: string) => Promise<unknown>
    continue: (root: string, proposalId: string) => Promise<void>
    later: (root: string, proposalId: string) => Promise<void>
    retry: (root: string, jobId: string) => JobRecord
    discard: (root: string, jobId: string) => JobRecord
    redeliver: (root: string, jobId: string) => Promise<void>
    authLater: (root: string, jobId: string) => Promise<void>
    deliveryText: (root: string, jobId: string) => string | null
  }
  diagnostic?: (record: object) => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function codeOf(error: unknown): LanesErrorCode {
  if (error instanceof LaneFailure) return error.code
  if (error instanceof Error && /ENOENT/.test(error.message)) return 'no-folder'
  return 'internal'
}

/** 폴더 인자를 실제 경로로 맞춘다 — 비었거나 없는 폴더는 `no-folder`. */
function folderOf(root: unknown): string {
  if (typeof root !== 'string' || !root) throw new LaneFailure('no-folder', '논문 폴더가 열려 있지 않아요.')
  let folder: string
  try { folder = canonical(root) } catch { throw new LaneFailure('no-folder', '논문 폴더를 찾지 못했어요.') }
  try { if (!statSync(folder).isDirectory()) throw new Error('not a folder') } catch {
    throw new LaneFailure('no-folder', '논문 폴더를 찾지 못했어요.')
  }
  return folder
}

/** 폴더 해석 + 허용 경계 — 두 겹이 모두 통과해야 상태를 읽거나 쓴다. */
function folderAllowed(deps: LaneHandlerDeps, root: unknown): string {
  const folder = folderOf(root)
  if (!deps.allowed(folder)) throw new LaneFailure('no-folder', '지금 열려 있지 않은 논문 폴더예요.')
  return folder
}

/**
 * 그 주문이 이 폴더의 것인가 — 화면이 준 폴더 값과 주문의 실제 폴더를 대조한다. 러너가 이미
 * 같은 검사를 하지만, 요청이 상태를 바꾸기 **전에** 막아 두면 다른 폴더 주문 번호로도 아무 일도
 * 일어나지 않는다(방어 한 겹).
 */
function jobInFolder(deps: LaneHandlerDeps, folder: string, jobId: unknown): string {
  if (typeof jobId !== 'string' || !jobId) throw new LaneFailure('not-found', '주문을 찾지 못했어요.')
  const record = deps.runner?.records().find(entry => entry.spec.id === jobId || entry.rootJobId === jobId)
  if (!record || record.root !== folder) throw new LaneFailure('not-found', '주문을 찾지 못했어요.')
  return record.spec.id
}

export interface LaneHandlers {
  lanes: Record<keyof typeof LANES_INVOKE, (...args: never[]) => Promise<LanesReply<unknown>>>
  jobs: Record<keyof typeof JOBS_INVOKE, (...args: never[]) => Promise<LanesReply<unknown>>>
}

/**
 * 22 요청을 등록한다. 반환한 표는 시험이 IPC 를 거치지 않고 같은 함수를 직접 부르는 통로다.
 */
export function registerLaneHandlers(deps: LaneHandlerDeps): LaneHandlers {
  const cards: CardDeps = {
    store: deps.store,
    account: deps.account,
    freshAccount: deps.freshAccount,
    mainCompany: deps.mainCompany,
    runner: deps.runner ? { records: () => deps.runner!.records(), stopJob: id => deps.runner!.stopJob(id) } : null,
    applyDesign: deps.applyDesign
  }
  const diagnostic = deps.diagnostic ?? (() => {})
  /** 방금 읽은 계정 — 요금제 판정에 쓰고, 화면으로는 가린 표시만 나간다. */
  const accounts = new Map<Provider, ExecutionAccount>()

  const refreshAccounts = async (): Promise<LaneAccountView[]> => {
    const views: LaneAccountView[] = []
    for (const company of ['claude', 'codex'] as const) {
      const account = await deps.account(company)
      if (!account) { accounts.delete(company); continue }
      accounts.set(company, account)
      views.push({
        connected: account.connected, consented: account.consented, usage: account.usage,
        accountId: account.accountId, account: account.account
      })
    }
    return views
  }

  /**
   * 모든 요청의 공통 껍데기 — 오류를 `LanesReply` 로 접고, 바뀌었으면 묶음을 민다.
   *
   * [C1-15] **구독 폴더 선택과 변경 알림은 다른 일이다.** 예전에는 폴더 없는 요청(`setConsent`)이
   * `hub.touch(null)` 을 불러 화면이 보던 폴더를 null 로 바꿨고, 그 뒤 묶음은 전역 묶음이 됐다.
   * 이제 폴더가 있는 요청만 그 폴더를 고르고, 폴더 없는 요청은 **알림만** 보낸다(`nudge`).
   * 경로도 `canonical` 로 맞춰 넘긴다 — 화면이 보낸 모양 그대로면 발행기가 발행 직전 대조에서
   * 그 묶음을 버린다.
   */
  const reply = async <T>(root: string | null, run: () => Promise<T> | T, touch = true): Promise<LanesReply<T>> => {
    try {
      const result = await run()
      if (touch) {
        if (root) {
          let folder = root
          try { folder = canonical(root) } catch { /* 이미 해석된 값이면 그대로 */ }
          deps.hub.touch(folder)
        } else deps.hub.nudge()
      }
      return { result }
    } catch (error) {
      diagnostic({ type: 'lanes-ipc', error: messageOf(error) })
      return { error: { code: codeOf(error), message: messageOf(error) } }
    }
  }

  /**
   * 폴더가 필요한 요청. 폴더 해석 자체가 던지므로(없는 폴더) **`reply` 안에서** 푼다 —
   * 바깥에서 풀면 그 예외가 `LanesReply` 를 거치지 않고 IPC 밖으로 샌다.
   */
  const withFolder = <T>(root: unknown, run: (folder: string) => Promise<T> | T, touch = true): Promise<LanesReply<T>> =>
    reply<T>(typeof root === 'string' && root ? root : null, () => run(folderAllowed(deps, root)), touch)

  const consentRow = (company: Provider, accountId: string): ConsentRow => {
    const account = accounts.get(company)
    const saved = deps.store.consent(company, accountId)
    const connected = account?.accountId === accountId
    return {
      company,
      accountId,
      accountLabel: maskAccount(accountId),
      state: saved?.state ?? 'none',
      at: saved?.at ?? null,
      // 지금 로그인한 계정일 때만 요금제를 확인할 수 있다.
      subscribed: connected ? judgePlan(account.account).usable : false
    }
  }

  const lanes = {
    // [C1-16] 폴더 해석이 `reply` 밖에서 평가되면 그 예외가 응답을 지나쳐 IPC 로 샌다.
    snapshot: (root: string | null) => reply<LanesSnapshot>(
      typeof root === 'string' && root ? root : null,
      () => deps.hub.snapshot(typeof root === 'string' && root ? folderAllowed(deps, root) : null),
      false
    ),
    decideCard: (root: string, cardId: string, baseVersion: number, action: CardAction) => withFolder(root,
      folder => decideCard(cards, folder, cardId, baseVersion, action)),
    // [다시 확인]은 아무것도 바꾸지 않는다 — 묶음도 다시 지을 이유가 없다.
    cardStatus: (root: string, cardId: string) => withFolder(root,
      folder => cardStatus(cards, folder, cardId), false),
    settingsCard: (root: string, kind: 'enable' | 'revert') => withFolder(root,
      folder => settingsCard(cards, folder, kind)),
    disable: (root: string) => withFolder(root, async folder => { await disable(cards, folder) }),
    reviewModels: (root: string | null) => reply<ReviewModelGroup[]>(
      typeof root === 'string' && root ? root : null,
      () => { if (typeof root === 'string' && root) folderAllowed(deps, root); return reviewModels(cards) },
      false
    ),
    // [C1-01] 회사 값은 여기서 먼저 닫는다 — 계정 조회가 실행 파일 선택으로 이어진다.
    pickReview: (root: string, company: Provider, model: string) => {
      let provider: Provider
      try { provider = providerOf(company) } catch (error) { return reply(root ?? null, () => { throw error }, false) }
      return withFolder(root, folder => pickReview(cards, folder, provider, model))
    },
    consents: () => reply(null, async () => {
      const views = await refreshAccounts()
      return consentRows(
        Object.fromEntries(views.map(view => [view.account.company, view])),
        deps.store.consents()
      )
    }, false),
    setConsent: (company: Provider, accountId: string, on: boolean) => reply(null, async () => {
      const provider = providerOf(company)
      if (typeof accountId !== 'string' || !accountId) throw new LaneFailure('not-found', '계정을 찾지 못했어요.')
      await refreshAccounts()
      // [C1-07] 동의는 **지금 확인된 계정**에만 켠다. 처음 보는 id 로 켜면 나중에 그 계정으로
      // 로그인했을 때 저장값이 곧바로 "동의함"으로 읽힌다. 거두기는 과거 계정에도 허용한다.
      if (on === true && accounts.get(provider)?.accountId !== accountId) {
        throw new LaneFailure('not-found', '지금 로그인한 계정이 아니에요.')
      }
      deps.setConsent(provider, accountId, on === true)
      return consentRow(provider, accountId)
    }),
    dismiss: (root: string, lineId: string) => withFolder(root, async folder => {
      const line = await findLine(deps, folder, lineId)
      if (!line) throw new LaneFailure('not-found', '그 줄을 찾지 못했어요.')
      if (!line.dismissible) throw new LaneFailure('internal', '이 줄은 ✕로 닫을 수 없어요.')
      deps.store.dismiss(folder, lineId)
    }),
    handoffContinue: (root: string, proposalId: string) => withFolder(root,
      folder => deps.handoff.continue(folder, proposalId)),
    handoffLater: (root: string, proposalId: string) => withFolder(root,
      folder => { deps.handoff.later(folder, proposalId) }),
    archives: (root: string) => withFolder(root, folder => deps.handoff.archives(folder), false),
    archive: (root: string, archiveId: string) => withFolder(root, folder => {
      const archive = deps.handoff.archive(folder, archiveId)
      if (!archive) throw new LaneFailure('not-found', '보관 대화를 찾지 못했어요.')
      return archive
    }, false)
  }

  const jobs = {
    stopOne: (root: string, jobId: string) => withFolder(root, async folder => {
      jobInFolder(deps, folder, jobId)
      await deps.jobs.stopOne(folder, jobId)
    }),
    continue: (root: string, proposalId: string) => withFolder(root, folder => {
      proposalInFolder(deps, folder, proposalId)
      return deps.jobs.continue(folder, proposalId)
    }),
    later: (root: string, proposalId: string) => withFolder(root, folder => {
      proposalInFolder(deps, folder, proposalId)
      return deps.jobs.later(folder, proposalId)
    }),
    retry: (root: string, jobId: string) => withFolder(root, folder => {
      jobInFolder(deps, folder, jobId)
      deps.jobs.retry(folder, jobId)
    }),
    discard: (root: string, jobId: string) => withFolder(root, folder => {
      jobInFolder(deps, folder, jobId)
      const record = deps.jobs.discard(folder, jobId)
      // 계약 `JobStatus` 에 `discarded` 가 없다 — `stopped` 로 닫고 그 줄을 ✕로 숨긴다.
      deps.store.dismiss(folder, `job:${record.spec.id}:interrupted`)
      deps.store.dismiss(folder, `job:${record.spec.id}:stopped`)
    }),
    redeliver: (root: string, jobId: string) => withFolder(root, folder => {
      jobInFolder(deps, folder, jobId)
      return deps.jobs.redeliver(folder, jobId)
    }),
    authLater: (root: string, jobId: string) => withFolder(root, async folder => {
      jobInFolder(deps, folder, jobId)
      await deps.jobs.authLater(folder, jobId)
    }),
    // 원문만 돌려준다 — 읽기라 다시 넘기지 않는다(계약 [Roh 중요 1]).
    deliveryText: (root: string, jobId: string) => withFolder(root, folder => {
      jobInFolder(deps, folder, jobId)
      return { text: deps.jobs.deliveryText(folder, jobId) }
    }, false)
  }

  bind(deps.ipc, LANES_INVOKE, lanes)
  bind(deps.ipc, JOBS_INVOKE, jobs)
  return {
    lanes: lanes as LaneHandlers['lanes'],
    jobs: jobs as LaneHandlers['jobs']
  }
}

function bind(ipc: LaneIpcChannel, channels: Record<string, string>, table: Record<string, (...args: never[]) => Promise<unknown>>): void {
  for (const [key, channel] of Object.entries(channels)) {
    const handler = table[key]
    ipc.handle(channel, (_event, ...args) => handler(...(args as never[])))
  }
}

/**
 * 그 제안이 이 폴더의 것인가 — 러너의 열린 제안을 폴더로 대조한다. 다른 폴더 제안 번호로도
 * 아무 일이 일어나지 않게 한다.
 */
function proposalInFolder(deps: LaneHandlerDeps, folder: string, proposalId: unknown): string {
  if (typeof proposalId !== 'string' || !proposalId) throw new LaneFailure('not-found', '이어 할 제안을 찾지 못했어요.')
  const proposal = deps.runner?.proposals().find(entry => entry.proposalId === proposalId)
  const record = proposal ? deps.runner?.records().find(entry => entry.rootJobId === proposal.rootJobId) : null
  if (!proposal || !record || record.root !== folder) throw new LaneFailure('not-found', '이어 할 제안을 찾지 못했어요.')
  return proposal.proposalId
}

/** 그 폴더의 지금 줄 중 하나 — `dismissible` 판정은 묶음을 지은 값 그대로 본다. */
async function findLine(deps: LaneHandlerDeps, root: string, lineId: string): Promise<LaneLine | null> {
  const snapshot = await deps.hub.snapshot(root)
  return snapshot.lines.find(line => line.id === lineId) ?? null
}
