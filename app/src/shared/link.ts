// link (v0.6.4 ⑤) — 대화 속 http(s) 주소를 여는 통로의 **계약**. main 검사·IPC·preload가 같은 타입을 쓴다
// (값은 없다 — 번들에 아무것도 더하지 않는다).

/** 거부 이유 — 화면이 원인을 단정하지 않고 사실만 말할 수 있게 나눠 둔다. */
export type LinkRejectReason = 'empty' | 'too_long' | 'malformed' | 'scheme' | 'credentials'

/** `link:open` 응답. 열지 못했으면 이유만 — 예외를 던지지 않는다. */
export type LinkOpenReply =
  | { result: { opened: true } }
  | { result: { opened: false; reason: LinkRejectReason | 'open_failed' } }
