import { useState } from 'react'

/**
 * [자세히]가 전달문 원문을 읽는 상태 — `idle` 은 아직 안 읽음, `text` 의 `null` 은 "아직 없음",
 * `failed` 는 통로 오류(읽기 실패). 계약 `JobsApi.deliveryText` 는 **읽기만 한다**(검토 C06).
 */
export type DeliveryTextState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'text'; text: string | null }
  | { kind: 'failed' }

/** `jobs.deliveryText` 의 화면 쪽 모양 — 통로 오류는 `null` 로 좁혀 온다(`Chat` 이 좁힌다). */
export type DeliveryRead = (root: string, jobId: string) => Promise<{ text: string | null } | null>

/**
 * 기록 줄의 [자세히] — **펼칠 때 한 번** 읽는다(설계 §2-2 "원문은 [자세히]로만 연다").
 * 펼침 상태는 부르는 쪽이 갖는다: `ZoneLine` 은 상태 원문과 전달문을 단추 하나로 함께 열어야 하고,
 * `LaneEventLine` 은 자기 단추 하나뿐이라 같은 자리에서 자기 `open` 을 쓴다.
 * 읽기 실패는 다시 펼칠 때 한 번 더 시도하고, 읽은 값은 다시 읽지 않는다.
 * 주문에 묶이지 않은 줄(검토 안내·카드 미결·본대화 한도)은 `jobId` 가 없어 `canRead` 가 false 다.
 */
export function useDeliveryText(read: DeliveryRead | undefined, root: string | undefined, jobId: string | undefined) {
  const [state, setState] = useState<DeliveryTextState>({ kind: 'idle' })
  const canRead = !!read && !!root && !!jobId
  const load = (): void => {
    if (!canRead || state.kind === 'loading' || state.kind === 'text') return
    setState({ kind: 'loading' })
    // 통로 오류(`null`)·예외는 모두 "읽지 못했어요" 하나로 접는다 — 화면을 막지 않는다.
    void (read!(root!, jobId!) as Promise<{ text: string | null } | null>)
      .then((r) => setState(r ? { kind: 'text', text: r.text } : { kind: 'failed' }), () => setState({ kind: 'failed' }))
  }
  return { canRead, state, load }
}
