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
import type { Provider } from '../../shared/chat'
import type { ExecutionAccount } from '../chat/jobs/types'
import { relayIsolation } from '../chat/jobs/isolation'
import { ClaudeRelayConnection } from '../chat/claude'
import { CodexRelayConnection } from '../chat/codex'
import type { AgentOptions } from '../chat/contracts'
import { isProvider } from './providers'

/** 계정 값 캐시 수명. 짧게 — 요금제·한도는 몇 초 사이에 바뀌지 않는다. */
const TTL_MS = 15_000

export interface AccountProbeDeps {
  /** 담당 플러그인·격리의 기준 폴더(앱 전용 자리). */
  appDir: string
  env: () => NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void>
  binary: (company: Provider) => string | null
}

/**
 * `fresh` 는 캐시를 건너뛰고 **지금** 관측한다 — 카드 적용·동의 켜기처럼 권한을 바꾸는 자리는
 * 15초 전 값을 쓰면 안 된다(C1-06). 실패는 `null`(모름)이고, 부르는 쪽이 닫는다.
 */
type Probe = ((company: Provider, options?: { fresh?: boolean }) => Promise<ExecutionAccount | null>)

/**
 * 회사별 계정 조회. 실행 파일이 없으면 `null`(그 회사는 쓸 수 없음). 실패도 `null` 이다 —
 * 모르는 값을 `allowed` 로 지어내지 않는다.
 */
export function laneAccountProbe(deps: AccountProbeDeps): Probe {
  const cache = new Map<Provider, { at: number; value: ExecutionAccount | null }>()
  const inflight = new Map<Provider, Promise<ExecutionAccount | null>>()

  const probe = async (company: Provider): Promise<ExecutionAccount | null> => {
    // [C1-01] 자기 방어 — 이 함수만 따로 불려도 허용 회사 밖의 이름이 실행 파일 탐색에 닿지 않는다.
    if (!isProvider(company)) return null
    const binary = deps.binary(company)
    if (!binary) return null
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
    try { return await connection.availability() } finally {
      try { await connection.stop() } catch { /* 이미 닫힌 연결 */ }
    }
  }

  return (company, options) => {
    if (!isProvider(company)) return Promise.resolve(null)
    if (!options?.fresh) {
      const hit = cache.get(company)
      if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value)
      const running = inflight.get(company)
      if (running) return running
    }
    const started = probe(company)
      .catch((): null => null)
      .then(value => {
        cache.set(company, { at: Date.now(), value })
        return value
      })
      .finally(() => { inflight.delete(company) })
    inflight.set(company, started)
    return started
  }
}
