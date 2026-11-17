/**
 * 화면 API 오류 — `LaneFailure` 는 `LanesReply` 의 `error.code` 로 그대로 나간다.
 *
 * 카드(`cards.ts`)·인계(`service.ts`)·핸들러(`handlers.ts`)가 같은 형을 던져야 IPC 응답이
 * 한 가지 규칙(`unavailable`·`not-found`·`no-folder`·`internal`)으로 접힌다. 가짜 기본값으로
 * 성공을 만들지 않는다.
 */
import type { LanesErrorCode } from '../../shared/lanes-ipc'

export class LaneFailure extends Error {
  constructor(readonly code: LanesErrorCode, message: string) {
    super(message)
    this.name = 'LaneFailure'
  }
}
