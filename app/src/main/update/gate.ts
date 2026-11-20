import { createPublicKey } from 'node:crypto'

/**
 * 관문 전용 빌드 — 출시 전 윈도 실기기에서 인 앱 업데이트를 끝까지 돌려 보는 내부 빌드.
 *
 * 값이 들어오는 길은 **빌드 시점 define 하나**다(`electron.vite.config.ts` → `scripts/gate-define.mjs`).
 * 실행 중인 앱은 환경값·파일·인자로 이 값을 바꾸지 못한다. 평소·출시 빌드에서는 define 이 `null`
 * 이라 아래 `GATE` 가 `null` 이고, 채널·공개키·자산 주소는 지금까지와 똑같다.
 *
 * 주소는 같은 PC(`http://127.0.0.1:<포트>/channel.json`)만 받는다 — 관문 빌드가 밖으로 새도 다른
 * PC 의 그 주소에는 아무것도 없다. 빌드 설정과 여기(런타임) 양쪽에서 같은 모양을 검사한다.
 */
declare const __KNUAF_GATE__: unknown
export interface Gate { channel: string; key: string }
const CHANNEL = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/channel\.json$/
/** 다시 내보낸 SPKI 공개키 PEM 과 글자까지 같아야 한다 — `createPublicKey` 는 개인키도 받아 공개키를 파생하므로 형식만 보면 안 된다. */
function ed25519(key: string): boolean {
  try { const parsed = createPublicKey(key); return parsed.asymmetricKeyType === 'ed25519' && parsed.export({ type: 'spki', format: 'pem' }) === key } catch { return false }
}
/** `null`·없음은 평소 빌드. 그 밖의 값은 모양이 정확히 맞아야 한다 — 반쯤 맞는 값은 닫는다. */
export function gateOf(raw: unknown): Gate | null {
  if (raw === null || raw === undefined) return null
  const { channel, key } = (typeof raw === 'object' ? raw : {}) as { channel?: unknown; key?: unknown }
  const port = typeof channel === 'string' ? CHANNEL.exec(channel)?.[1] : undefined
  if (typeof channel !== 'string' || typeof key !== 'string' || !port || Number(port) > 65535 || !ed25519(key)) throw new Error('관문 빌드 설정이 잘못됐어요.')
  return { channel, key }
}
/** 관문 빌드의 자산(설치 파일) 주소: 관문 채널과 같은 출처만. */
export function gateAsset(value: unknown, gate: Gate): asserts value is string {
  const origin = new URL(gate.channel).origin + '/'
  if (typeof value !== 'string' || !value.startsWith(origin)) throw new Error('허용되지 않은 내려받기 주소예요.')
  const u = new URL(value)
  if (u.username || u.password || u.search || u.hash || u.href !== value || u.origin + '/' !== origin) throw new Error('허용되지 않은 내려받기 주소예요.')
}
// `typeof` 로 읽는 이유: define 이 없는 실행(단위 시험·스크립트)에서 bare 참조는 ReferenceError 다.
export const GATE: Gate | null = gateOf(typeof __KNUAF_GATE__ === 'undefined' ? null : __KNUAF_GATE__)
