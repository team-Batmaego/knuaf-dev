/**
 * figures/dns-pin.ts — 이름을 한 번만 풀고, 결과가 전부 공인 IP일 때만 연결한다 (설계 R4-2, C-01).
 *
 * 왜 이렇게 하나: 이름을 풀어 검사한 뒤 `https.request`가 다시 풀면, 그 사이 DNS가 사설 IP로 바뀌는
 * 재바인딩 틈이 생긴다. 그래서 ① 여기서 `dns.lookup(host,{all:true})`로 **한 번만** 풀고 ② 결과 중
 * 하나라도 사설·루프백·링크로컬·CGNAT·IPv4-mapped 사설·`fc00::/7`이면 **전부 버리고** ③ 살아남은
 * 하나를 `lookup` 콜백으로 돌려줘 `https.request`가 그 IP로만 접속하게 한다. TLS `servername`은
 * 호스트 그대로라 인증서 검증도 그대로다.
 *
 * 검사는 "받아들일 것만 나열"이 아니라 "거절할 것을 나열"로 쓴다 — 목록을 빠뜨린 새 예약 대역이
 * 기본적으로 통과하지 않게 하려면 반대로 해야 하지만, 여기선 IPv4 사설·예약 대역이 많고 IPv6도
 * 넓어서, **공인 대역만 명시적으로 통과**시키는 쪽이 틀릴 여지가 적다.
 */

import { lookup as defaultLookup } from 'node:dns'

export interface AddressRecord {
  address: string
  family: number
}

export type LookupAll = (
  host: string,
  options: { all: true }
) => Promise<readonly AddressRecord[]>

export type PinResult =
  | { ok: true; address: string; family: number }
  | { ok: false; reason: 'dns' | 'private' | 'empty' }

/** IPv4 하나가 공인인가. `a.b.c.d` 4조각, 각 0~255. */
export function isPublicIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return false // 0.0.0.0/8 "이 네트워크"
  if (a === 10) return false
  if (a === 127) return false
  if (a === 169 && b === 254) return false // 링크로컬
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && octets[2] === 0) return false // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && octets[2] === 2) return false // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // 벤치마크
  if (a === 198 && b === 51 && octets[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return false // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a >= 224) return false // 멀티캐스트·예약·브로드캐스트
  return true
}

/** IPv6 주소를 16비트 조각 8개로 푼다. 모양이 아니면 null. 존 표기(`%en0`)는 떼어 낸다. */
function hextetsOf(text: string): readonly number[] | null {
  const value = text.toLowerCase().split('%')[0] as string
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = hexGroups(halves[0] as string)
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = hexGroups(halves[1] as string)
  if (!tail) return null
  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

/** `:`로 나뉜 조각들. 마지막 조각이 `a.b.c.d` 점 표기면 두 조각으로 편다. */
function hexGroups(text: string): number[] | null {
  if (text === '') return []
  const out: number[] = []
  for (const group of text.split(':')) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(group)) {
      const octets = group.split('.').map((part) => Number(part))
      if (octets.some((value) => value > 255)) return null
      out.push(((octets[0] as number) << 8) | (octets[1] as number))
      out.push(((octets[2] as number) << 8) | (octets[3] as number))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(Number.parseInt(group, 16))
  }
  return out
}

const ipv4Of = (high: number, low: number): string =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`

/**
 * IPv6 하나가 공인인가.
 *
 * 조각으로 풀어 **2000::/3**(현재 전세계 유니캐스트 할당 대역)만 통과시키고, 그 안의 특수 대역을
 * 뺀다. 접두 문자열 비교(`startsWith('2001:')`)로 하면 `2001:db8::`(문서용)·`2001::/32`(Teredo)·
 * `2002::/16`(6to4)이 전부 "공인"으로 새는데, 이 셋은 **안쪽 IPv4를 감싸므로** 사설 IPv4로 가는
 * 우회로가 된다. 그래서 경계를 숫자로 비교한다.
 *
 * `64:ff9b::/96`(NAT64)도 안쪽 IPv4를 감싼다 — 2000::/3 밖이라 그냥 통과시키면 안 되고, 안쪽
 * 주소로 판정한다(`64:ff9b::127.0.0.1`은 루프백이다).
 */
export function isPublicIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] as string
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (dotted) return isPublicIpv4(dotted[1] as string)

  const parts = hextetsOf(value)
  if (!parts) return false
  const first = parts[0] as number

  // IPv4-mapped(::ffff:0:0/96)는 안쪽 IPv4 규칙을 그대로 쓴다. 16진 표기(`::ffff:7f00:1`)도 같다.
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0xffff) {
    return isPublicIpv4(ipv4Of(parts[6] as number, parts[7] as number))
  }

  // 2000::/3 밖은 전부 거절: ::, ::1, fe80::/10, fc00::/7, ff00::/8 등.
  // 단 NAT64(64:ff9b::/96)는 안쪽 IPv4 규칙으로 판정한다 — 감싼 주소가 공인일 때만 통과.
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0) {
    return isPublicIpv4(ipv4Of(parts[6] as number, parts[7] as number))
  }
  if (first < 0x2000 || first > 0x3fff) return false

  // 2001::/23 IETF 프로토콜 할당 — Teredo(2001:0::/32), ORCHID, 벤치마크(2001:2::/48).
  // Teredo는 안쪽 IPv4가 XOR로 뒤집혀 있어 "안쪽 주소만 검사"로는 안전을 보장할 수 없다.
  if (first === 0x2001 && (parts[1] as number) <= 0x01ff) return false
  // 2001:db8::/32 문서용
  if (first === 0x2001 && parts[1] === 0x0db8) return false
  // 2002::/16 6to4 — 조각 1·2가 감싼 IPv4다. 그것이 공인일 때만 통과.
  if (first === 0x2002) return isPublicIpv4(ipv4Of(parts[1] as number, parts[2] as number))
  // 3fff::/20 문서용(RFC 9637)
  if (first === 0x3fff && ((parts[1] as number) & 0xf000) === 0) return false

  return true
}

export function isPublicAddress(address: string): boolean {
  return address.includes(':') ? isPublicIpv6(address) : isPublicIpv4(address)
}

/**
 * 호스트를 한 번 풀어 고정한다. 결과 전부가 공인이어야 하고, 하나라도 아니면 거절한다
 * (공인+사설 섞인 응답은 공격자가 사설 쪽으로 유도할 수 있는 신호다).
 */
export async function pinHost(host: string, lookupAll: LookupAll = systemLookup): Promise<PinResult> {
  let records: readonly AddressRecord[]
  try {
    records = await lookupAll(host, { all: true })
  } catch {
    return { ok: false, reason: 'dns' }
  }
  if (records.length === 0) return { ok: false, reason: 'empty' }
  for (const record of records) {
    if (!isPublicAddress(record.address)) return { ok: false, reason: 'private' }
  }
  const chosen = records[0] as AddressRecord
  return { ok: true, address: chosen.address, family: chosen.family }
}

const systemLookup: LookupAll = (host, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<readonly AddressRecord[]>()
  defaultLookup(host, options, (error, addresses) => {
    if (error) reject(error)
    else resolve(addresses)
  })
  return promise
}

/**
 * `https.request`의 `lookup` 옵션 모양으로 감싼다. 넘긴 IP만 돌려주므로 Node가 다시 풀지 않는다.
 * family 불일치 요청은 거절한다 — 조용히 다른 IP로 가면 고정이 깨진다.
 *
 * `options.all`을 반드시 따라야 한다: Node 20+ 는 `autoSelectFamily`가 켜져 있으면
 * `lookup(host,{all:true})`로 부르고 **배열** 콜백을 기대한다. 문자열로 답하면 Node가 주소를 못 읽어
 * `ERR_INVALID_IP_ADDRESS: undefined`로 죽는다(대역 transport가 `{}`로만 불러 이 틈을 못 봤다).
 */
export function fixedLookup(pin: { address: string; family: number }): (
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | AddressRecord[],
    family?: number
  ) => void
) => void {
  return (_hostname, options, callback) => {
    const wanted = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    if (wanted && wanted !== pin.family) {
      const error = Object.assign(new Error('dns pin family mismatch'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }])
      return
    }
    callback(null, pin.address, pin.family)
  }
}
