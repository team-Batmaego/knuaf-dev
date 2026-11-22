/**
 * 담당 회사 계정 조회 — **엔진과 같은 생산자**로 읽는다.
 *
 * `JobRunner` 는 실행 직전 앱 값(`options.account`)과 엔진 `availability()` 의 지문
 * (`accountId`·`connected`·`usage`·`account`)을 대조하고 다르면 주문을 `rejected` 로 닫는다
 * (`jobs.ts` `fingerprint`). 그래서 앱 쪽 값을 **추측으로 만들면 모든 주문이 거절**된다 —
 * 여기서는 실제 담당 연결을 하나 띄워 `availability()` 를 그대로 묻고 곧바로 닫는다.
 *
 * 비용: Claude 는 초기화 왕복 한 번(턴 없음), Codex 는 app-server 한 번. 계정 값은 자주
 * 바뀌지 않으므로 짧게 캐시하고 동시 호출은 하나로 접는다. **모델 호출은 하지 않는다.**
 */
import { mkdirSync } from 'node:fs'
import type { Provider } from '../../shared/chat'
import type { ExecutionAccount } from '../chat/jobs/types'
import { relayIsolation } from '../chat/jobs/isolation'
import { ClaudeRelayConnection } from '../chat/claude'
import { CodexRelayConnection } from '../chat/codex'
import type { AgentOptions } from '../chat/contracts'
import { isProvider } from './providers'
import { freeExecutionAccount } from '../free/provider'
import { agentActivity, UpdateSuspendedError, type AgentActivity } from '../update/activity'

/** 계정 값 캐시 수명. 짧게 — 요금제·한도는 몇 초 사이에 바뀌지 않는다. */
const TTL_MS = 15_000

export interface AccountProbeDeps {
  /** 담당 플러그인·격리의 기준 폴더(앱 전용 자리). */
  appDir: string
  env: () => NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void>
  binary: (company: Provider) => string | null
  /**
   * 인계(`update/handoff.ts`)와 **같은** 임대 장부. 인계가 정지시키면 조회는 새 프로세스를
   * 띄우지 않고, 이미 도는 조회는 인계의 `drain()` 이 끝날 때까지 붙잡는다. 시험이 새 인스턴스를
   * 넣을 수 있게 선택 항목이다(기본 = 앱 전역 장부).
   */
  activity?: AgentActivity
}

/**
 * `fresh` 는 캐시를 건너뛰고 **지금** 관측한다 — 카드 적용·동의 켜기처럼 권한을 바꾸는 자리는
 * 15초 전 값을 쓰면 안 된다(C1-06). 실패는 `null`(모름)이고, 부르는 쪽이 닫는다.
 */
export type AccountProbe = ((company: Provider, options?: { fresh?: boolean }) => Promise<ExecutionAccount | null>) & {
  /**
   * **인계 제안 판정 전용 상한** — 실행당 회사당 1회, 로그인 세대가 바뀌면 다시 1회.
   * 누르기 **전**에 부르므로 이 값이 제안 단추의 근거다. 15초 캐시를 읽지도 쓰지도 않는다
   * (캐시된 값과 상한 값이 서로를 덮으면 "실행당 1회"가 깨진다).
   *
   * 실패는 저장하지 않는다 — 기다리던 모두에게 **같은 실패**를 그대로 돌려주고, 다음 제안에서
   * 다시 1회 읽는다(실패를 굳히면 연결이 돌아와도 단추가 영영 없다).
   */
  once(company: Provider, epoch: number): Promise<ExecutionAccount | null>
  close(): Promise<void>
}

/**
 * 회사별 계정 조회. 실행 파일이 없으면 `null`(그 회사는 쓸 수 없음). 실패도 `null` 이다 —
 * 모르는 값을 `allowed` 로 지어내지 않는다.
 */
export function laneAccountProbe(deps: AccountProbeDeps): AccountProbe {
  const activity = deps.activity ?? agentActivity
  const cache = new Map<Provider, { at: number; value: ExecutionAccount | null }>()
  const inflight = new Map<Provider, Promise<ExecutionAccount | null>>()
  const active = new Set<CodexRelayConnection | ClaudeRelayConnection>()
  let closing = false
  let closePromise: Promise<void> | undefined
  /** 조회가 띄운 연결의 종료 약속 — 정지 알림이 끊고, 조회의 `finally` 가 그 약속을 기다린다. */
  const halts = new Map<CodexRelayConnection | ClaudeRelayConnection, Promise<void>>()
  /** 정지 횟수 — 조회 시작 때 잡아 두고, 끝났을 때 같을 때만 캐시·메모에 쓴다. */
  let suspensions = 0
  const halt = (connection: CodexRelayConnection | ClaudeRelayConnection): Promise<void> => {
    const running = halts.get(connection)
    if (running) return running
    // 종료 실패는 삼킨다 — 인계는 '자식이 죽었는가'를 이 약속으로만 기다린다.
    const stopped = connection.stop().catch(() => {})
    halts.set(connection, stopped)
    return stopped
  }
  /**
   * 정지는 **지금 도는 조회의 자식**을 곧바로 끊는다. 그러지 않으면 인계는 `drain()` 상한(30초)을
   * 다 기다린 뒤 실패하고, 학생에게는 "작업이 끝난 뒤 다시 눌러 주세요"만 남는다.
   */
  const unsubscribe = activity.onSuspend(() => {
    suspensions++
    for (const connection of active) void halt(connection)
  })

  /**
   * `probe()` 는 **임대를 쥔 채** 돈다. 인계는 `suspend()` 뒤 `drain()` 으로 임대가 0이 되기를
   * 기다리므로, 이 임대가 있어야 인계가 조회의 자식(`connection.stop()` 까지)을 기다린다.
   * 놓는 자리는 `probe()` 의 마지막 `finally` — 자식 종료 **뒤**다.
   */
  const probe = async (company: Provider, release: () => void): Promise<ExecutionAccount | null> => {
    // 조회 시작 시점의 정지 세대 — 끝났을 때 같을 때만 값을 돌려주고 저장한다.
    const generation = suspensions
    try {
      if (closing) return null
      // [C1-01] 자기 방어 — 이 함수만 따로 불려도 허용 회사 밖의 이름이 실행 파일 탐색에 닿지 않는다.
      if (!isProvider(company)) return null
      const binary = deps.binary(company)
      if (!binary) return null
      if (company === 'free') return freeExecutionAccount()
      mkdirSync(deps.appDir, { recursive: true })
      const options: AgentOptions = {
        binary, root: deps.appDir, skill: '', env: deps.env(), openExternal: deps.openExternal
      }
      const request = {
        key: `${deps.appDir}\0${company}\0account-probe`,
        jobId: 'account-probe',
        company,
        cwd: deps.appDir,
        skill: '',
        model: '',
        effort: null,
        isolation: relayIsolation(deps.appDir, [], false)
      }
      const connection = company === 'claude'
        ? new ClaudeRelayConnection(options, request, deps.appDir)
        : new CodexRelayConnection(options, request)
      active.add(connection)
      try {
        const result = await connection.availability()
        // 정지가 끼어들었으면 그 값은 새 세대의 답이 아니다 — 캐시에 굳히지 않는다.
        return closing || suspensions !== generation ? null : result
      } finally {
        // 정지 알림이 이미 끊었으면 그 종료를 **기다린다** — 임대는 자식이 죽은 뒤에 놓인다.
        const halted = halts.get(connection)
        try { if (halted) await halted; else if (!closing) await connection.stop() }
        finally { halts.delete(connection); active.delete(connection) }
      }
    } finally { release() }
  }

  // 인계 제안 판정용 실행 메모 — 15초 캐시와 **분리**한다(위 `once` 주석).
  const memo = new Map<Provider, { value?: ExecutionAccount | null; generation: number; inflight?: Promise<ExecutionAccount | null> }>()

  /**
   * 인계(정지) 중에는 프로세스를 띄우지 않고 **이미 아는 값**만 돌려준다. `fresh` 는 예외다 —
   * "지금 관측"이 계약이라(권한을 바꾸는 자리가 옛 계정으로 통과하면 안 된다) 묵은 값 대신
   * `null`(모름)을 준다. 임대(`activity.enter()`)는 이 정지 검사와 **같은 동기 구간**에서 잡는다 —
   * 그 사이에 `suspend()` 가 끼어들 수 없으므로 "임대는 잡았는데 이미 정지"인 창이 없다.
   */
  const read = (company: Provider, options?: { fresh?: boolean }): Promise<ExecutionAccount | null> => {
    if (closing) return Promise.resolve(null)
    if (!isProvider(company)) return Promise.resolve(null)
    if (activity.suspended) {
      // `null` 은 캐시에 쓰지 않는다: 인계가 실패해 앱이 계속 살 때 '모름'이 15초 굳으면 안 된다.
      // `fresh` 는 "지금 관측"이 계약인데 정지 중에는 관측을 못 한다 — `null`(모름)을 주면 호출부가
      // '계정이 바뀜'으로 읽어 카드·제안을 닫으므로, 정지 사실을 그대로 알린다.
      if (options?.fresh) return Promise.reject(new UpdateSuspendedError())
      return inflight.get(company) ?? Promise.resolve(cache.get(company)?.value ?? null)
    }
    if (!options?.fresh) {
      const hit = cache.get(company)
      if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value)
      const running = inflight.get(company)
      if (running) return running
    }
    // 정지 검사(위)와 같은 동기 구간 — 여기서 `enter()` 가 던지지 않는다.
    const generation = suspensions
    const started = probe(company, activity.enter())
      .catch((): null => null)
      .then(value => {
        // 정지가 끼어들어 끊긴 조회는 값이 아니다 — 새 세대의 캐시로 굳히지 않는다.
        if (suspensions === generation) cache.set(company, { at: Date.now(), value })
        return value
      })
      .finally(() => { inflight.delete(company) })
    inflight.set(company, started)
    return started
  }

  const once = (company: Provider, epoch: number): Promise<ExecutionAccount | null> => {
    if (closing) return Promise.resolve(null)
    if (!isProvider(company)) return Promise.resolve(null)
    if (activity.suspended) {
      // `once` 는 실패를 저장하지 않는 계약이다 — 정지 중에도 메모에 아무것도 쓰지 않는다.
      // 세대가 다르면 옛 값도 옛 진행 약속도 새 세대의 답이 아니다: `null` 대신 정지 사실을 알린다.
      const known = memo.get(company)
      if (!known || known.generation !== epoch) return Promise.reject(new UpdateSuspendedError())
      return known.inflight ?? Promise.resolve('value' in known ? known.value ?? null : null)
    }
    let entry = memo.get(company)
    if (!entry) { entry = { generation: epoch }; memo.set(company, entry) }
    // 로그인이 바뀌었으면 옛 값·옛 진행 약속 둘 다 버린다 — 옛 연결의 답이 새 세대에 남으면 안 된다.
    if (entry.generation !== epoch) {
      delete entry.value
      entry.inflight = undefined
      entry.generation = epoch
    }
    if ('value' in entry) return Promise.resolve(entry.value ?? null)
    const running = entry.inflight
    if (running) return running
    const generation = suspensions
    const release = activity.enter()
    // `.catch` 없음 — 실패는 저장하지 않고 대기자 전원에게 그대로 간다.
    const started = probe(company, release)
      .then(value => {
        if (entry.generation === epoch && suspensions === generation) entry.value = value
        return value
      })
      .finally(() => { if (entry.inflight === started) entry.inflight = undefined })
    entry.inflight = started
    return started
  }

  const fn = (company: Provider, options?: { fresh?: boolean }) => read(company, options)
  return Object.assign(fn, { once, close: () => { closing = true; unsubscribe(); return closePromise ??= Promise.all([...active].map(connection => halt(connection))).then(() => undefined) } })
}
