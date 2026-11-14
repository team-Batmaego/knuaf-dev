/**
 * 회사 값의 **단일 통과 지점** — 화면이 보낸 문자열은 여기를 지나야 실행 파일 선택에 닿는다.
 *
 * [C1-01] 회사 이름은 실행 파일 탐색기(`findExecutable`)에 그대로 들어간다. 검증 없이 넘기면
 * 화면이 `'node'` 같은 값을 보냈을 때 그 이름의 실행 파일이 선택되고, 엔진 생성자가 그 경로로
 * 프로세스를 띄운다(판정서: 회사=node 가 CodexRelayConnection 생성자까지 도달).
 *
 * 그래서 **세 겹**으로 둔다: IPC 입구(`handlers.ts`) · 계정 조회(`accounts.ts`) · 배선의
 * `binary` 함수(`ipc.ts`). 한 곳만 남겨도 경계가 유지되도록 각자 검사한다.
 */
import type { Provider } from '../../shared/chat'
import { LaneFailure } from './failure'

export const PROVIDERS = ['claude', 'codex'] as const

export function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'codex'
}

/** 아니면 `internal` 로 닫는다 — 화면 값이 틀린 것이므로 성공을 만들지 않는다. */
export function providerOf(value: unknown, what = '회사'): Provider {
  if (!isProvider(value)) throw new LaneFailure('internal', `알 수 없는 ${what}예요.`)
  return value
}
