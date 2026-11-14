import type { CardAction, CardDecision, LaneCard } from '../../shared/lanes-ipc'

/**
 * 늦게 온 카드 응답이 지금 화면에 아직 유효한가(검토 C2-C02ⓑ).
 *
 * `target` 은 요청할 때의 폴더, `cardRoot` 는 응답 카드가 말하는 폴더, `liveRoot` 는 **응답이 닿은
 * 지금** 화면의 폴더다. 요청 때 폴더를 캡처한 것만으로는 부족하다 — 기다리는 사이 폴더가 바뀌면
 * B 폴더 화면에 A 폴더 카드가 뜨고, 그 카드를 승인하면 엉뚱한 폴더의 배치가 바뀐다.
 *
 * 설정 창은 대화 화면 없이도 열리고(`SettingsModal`) 폴더가 바뀌어도 계속 붙어 있으므로 이 경우가
 * 실제로 난다. 판정은 이 파일 하나에 모으고, 화면은 결과(`drop`/`error`/`show`·`done`)대로만 움직인다.
 */
export function cardStillApplies(target: string, cardRoot: string, liveRoot: string | null): boolean {
  return liveRoot === target && cardRoot === target
}

/** 지금 화면에 보이는 카드에 승인·재확인을 보내도 되는가 — 폴더가 없거나 카드가 없으면 안 된다. */
export function cardUsable(card: LaneCard | null, root: string | null, liveRoot: string | null): boolean {
  return !!root && !!card && cardStillApplies(root, card.root, liveRoot)
}

/** `settingsCard` 응답의 화면 쪽 모양(`callValue` 의 값/오류). */
export type SettingsCardReply = { value: LaneCard } | { error: string }

/** 요청 뒤 할 일 — `drop` 은 조용히 버림, `error` 는 단추 자리 실패 표시, `show` 는 확인 창. */
export type CardFollow = { action: 'drop' } | { action: 'error' } | { action: 'show'; card: LaneCard }

/**
 * 응답이 닿은 순간 무엇을 할지 — `openCard` 는 이 값대로만 움직인다.
 * 옛 폴더의 응답(`liveRoot !== target`)은 성공도 실패도 버린다: 지금 폴더 화면에 옛 요청의 카드도,
 * 옛 요청의 오류도 띄우지 않는다. 지금 폴더의 응답이라도 카드가 말하는 폴더가 다르면 버린다.
 */
export function resolveCardResponse(target: string, liveRoot: string | null, reply: SettingsCardReply): CardFollow {
  // 옛 폴더의 응답은 성공도 실패도 버린다 — 지금 폴더 화면에 옛 요청의 오류를 띄우지 않는다.
  if (liveRoot !== target) return { action: 'drop' }
  if ('error' in reply) return { action: 'error' }
  return cardStillApplies(target, reply.value.root, liveRoot) ? { action: 'show', card: reply.value } : { action: 'drop' }
}

/**
 * 설정 카드 요청 한 번 — **응답이 닿은 뒤에** 지금 폴더를 다시 읽는다(검토 C2-C02ⓑ).
 * `liveRoot` 를 값으로 먼저 받으면 요청 전 폴더가 박혀 버리므로 함수로 받는다.
 */
export async function requestCard(
  target: string,
  request: (root: string) => Promise<SettingsCardReply>,
  liveRoot: () => string | null
): Promise<CardFollow> {
  const reply = await request(target)
  return resolveCardResponse(target, liveRoot(), reply)
}

/** 승인·재확인 뒤 할 일 — `done` 은 응답 카드로 접힘·무효를 그린다. */
export type DecisionFollow = { action: 'drop' } | { action: 'error' } | { action: 'done'; decision: CardDecision }

async function followDecision(
  root: string | null,
  liveRoot: () => string | null,
  send: (target: string) => Promise<CardDecision | null>
): Promise<DecisionFollow> {
  if (!root) return { action: 'drop' }
  const decision = await send(root)
  if (liveRoot() !== root) return { action: 'drop' }
  return decision ? { action: 'done', decision } : { action: 'error' }
}

/**
 * 승인 — **보이는 카드가 지금 폴더의 카드일 때만** 보낸다. 보낸 뒤 응답이 닿기까지 폴더가 바뀌었으면
 * 그 응답도 버린다(옛 폴더의 접힘·무효를 새 폴더 화면에 그리지 않는다, 검토 C2-C02ⓑ).
 */
export async function decideIfCurrent(
  card: LaneCard | null,
  root: string | null,
  liveRoot: () => string | null,
  cardId: string,
  baseVersion: number,
  action: CardAction,
  send: (root: string, cardId: string, baseVersion: number, action: CardAction) => Promise<CardDecision | null>
): Promise<DecisionFollow> {
  if (!cardUsable(card, root, liveRoot())) return { action: 'drop' }
  return followDecision(root, liveRoot, (target) => send(target, cardId, baseVersion, action))
}

/** 재확인 — 승인과 같은 문지기를 쓴다. */
export async function recheckIfCurrent(
  card: LaneCard | null,
  root: string | null,
  liveRoot: () => string | null,
  cardId: string,
  send: (root: string, cardId: string) => Promise<CardDecision | null>
): Promise<DecisionFollow> {
  if (!cardUsable(card, root, liveRoot())) return { action: 'drop' }
  return followDecision(root, liveRoot, (target) => send(target, cardId))
}
