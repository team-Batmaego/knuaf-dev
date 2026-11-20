// 관문 전용 빌드의 빌드 시점 값 — `electron.vite.config.ts` 가 main define 에 넣는다.
//
// 빌드 환경값 `KNUAF_GATE_CHANNEL`·`KNUAF_GATE_PUBLIC_KEY` 는 **빌드할 때만** 읽는다(이 파일은 앱
// 번들에 들어가지 않는다). 둘 다 없으면 'null' — 평소·출시 빌드. 하나만 있거나 모양이 틀리면 던져서
// 빌드를 실패시킨다: 반쯤 맞는 값으로 "운영처럼 보이는 관문 빌드"가 나오지 않게 한다.
// 이 환경값 이름은 `gate-build.yml` 에만 나와야 한다(`check-release-update-config.mjs` 가 검사).
import { createPublicKey } from 'node:crypto'

/**
 * 산출물 검사가 찾는 표식. 앱 소스에는 이 문자열을 쓰지 않는다 — 관문 빌드의 define 값으로만 들어간다.
 * 묶음 도구가 안 쓰는 속성을 지우면 번들에 안 남을 수 있다(실측: 지금 빌드에서는 지워진다). 그래서 검사는
 * 이 표식에 기대지 않고 같은 PC 채널 주소·공개키 개수와 값·치환 안 된 상수를 각각 따로 본다.
 */
export const GATE_MARK = 'KNUAF-GATE-BUILD'
export const GATE_CHANNEL = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/channel\.json$/

export function gateValue(env = process.env) {
  const channel = env.KNUAF_GATE_CHANNEL, key = env.KNUAF_GATE_PUBLIC_KEY
  if (!channel && !key) return null
  const port = typeof channel === 'string' ? GATE_CHANNEL.exec(channel)?.[1] : undefined
  if (!port || Number(port) > 65535) throw new Error('KNUAF_GATE_CHANNEL must be http://127.0.0.1:<port>/channel.json')
  let type
  try { type = createPublicKey(String(key)).asymmetricKeyType } catch { /* 아래에서 던진다 */ }
  if (type !== 'ed25519') throw new Error('KNUAF_GATE_PUBLIC_KEY must be an Ed25519 public key (PEM)')
  return { mark: GATE_MARK, channel, key }
}

/** define 에 넣을 JS 식 문자열. */
export function gateDefine(env = process.env) { return JSON.stringify(gateValue(env)) }
