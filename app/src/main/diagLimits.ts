/**
 * 진단 로그의 **상한**(검토 I-01·I-02). 창·IPC·시험 헬퍼가 같은 값을 쓰도록 여기 한 곳에 두고,
 * `e2e/diag-limits.spec.ts` 가 계약을 잠근다. Electron 을 쓰지 않는 순수 모듈이라 Node 시험에서
 * 그대로 부를 수 있다.
 *
 * 왜 상한이 필요한가: `KNUAF_APP_LOG` 가 켜지면 main 은 줄마다 `appendFileSync` 로 쓴다(멈춘
 * 뒤의 줄을 잃지 않으려고 일부러 그렇게 했다). 기동 구독이 창 수명 내내 남아 있으면
 * `console-message`·`unresponsive` 같은 반복 이벤트마다 main 스레드가 파일을 동기로 두드린다 —
 * 진단을 켠 실행(CI e2e 헬퍼는 항상 켠다)이 진단 때문에 느려지고, 20분이면 로그가 기가로 커진다.
 */

/** 기동 표식 상한 — 단계당 3줄(같은 이벤트가 반복돼도 앞의 몇 번이면 원인을 안다), 창당 40줄. */
export const STARTUP_DIAG_LIMITS = { perStage: 3, total: 40 } as const

/**
 * 기동 구간의 시간 상한 — 구간은 **창 닫힘 또는 이 상한**에서만 끝난다(검토 roh290b 새 결함).
 *
 * 첫 `ready-to-show`·`did-finish-load` 는 구간을 닫지 않는다: 그 둘은 문서 로드가 끝났다는
 * 신호일 뿐 React 의 `.titlebar` 가 떴다는 신호가 아니다(TitleBar.tsx, helpers.ts 의
 * `waitForSelector('.titlebar')` 는 그 뒤에 온다). 그때 닫으면 **제목줄을 기다리는 동안**의
 * render-process-gone·unresponsive·콘솔 오류를 놓친다.
 *
 * 60초인 이유: 제목줄 대기(helpers.ts)와 그 뒤 splash 단계까지 덮어야 한다. 20초는 창 생성에서
 * 첫 표시까지만 덮어 제목줄 대기 구간이 로그 밖으로 나갔다. 비용은 시간이 아니라 줄 수가 막는다
 * (`STARTUP_DIAG_LIMITS` 단계당 3줄·창당 40줄).
 */
export const STARTUP_WINDOW_MS = 60_000

/** `settings:get` 진단은 첫 3회만 — 설정 화면은 이 핸들러를 여러 번 부른다. */
export const SETTINGS_GET_DIAG_CALLS = 3

export interface StartupDiag {
  /** 그 단계의 줄을 하나 더 써도 되는가. 이미 닫혔거나 상한이면 `false`(파일 쓰기 없음). */
  allow(stage: string): boolean
  /** 구간을 닫는다. 먼저 닫은 쪽이 이유를 정한다 — 두 번째부터는 `false` 를 돌려준다. */
  close(reason: string): boolean
  /** 닫힌 이유(안 닫혔으면 `null`). */
  closed(): string | null
  /** 지금까지 허용한 줄 수. */
  count(): number
}

/**
 * 창 하나의 기동 표식 상한 계수기. 순수 상태라 시험에서 그대로 돌린다.
 *
 * 단계별 상한과 총 상한을 **함께** 둔다: 단계별만 두면 서로 다른 단계 이름을 만들어 내는 경로가
 * 총량을 못 막고, 총 상한만 두면 정작 반복되는 한 이벤트가 다른 단계의 몫을 다 먹는다.
 */
export function createStartupDiag(limits: { perStage: number; total: number } = STARTUP_DIAG_LIMITS): StartupDiag {
  const perStage = new Map<string, number>()
  let used = 0
  let closedBy: string | null = null
  return {
    allow(stage: string): boolean {
      if (closedBy) return false
      if (used >= limits.total) return false
      const seen = perStage.get(stage) ?? 0
      if (seen >= limits.perStage) return false
      perStage.set(stage, seen + 1)
      used += 1
      return true
    },
    close(reason: string): boolean {
      if (closedBy) return false
      closedBy = reason
      return true
    },
    closed(): string | null {
      return closedBy
    },
    count(): number {
      return used
    }
  }
}

/**
 * 앞의 `limit` 번만 `true` 를 돌려주는 문. 호출마다 도는 진단(`settings:get` 등)에 쓴다 —
 * 한 번 쓰고 마는 상태를 호출 쪽에 두지 않으려고 함수로 감싼다.
 */
export function createCallGate(limit: number): () => boolean {
  let used = 0
  return (): boolean => {
    if (used >= limit) return false
    used += 1
    return true
  }
}
