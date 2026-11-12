import type * as dnsTypes from './dns-pin'
/**
 * figures/dns-pin.test.ts — 이름 한 번 풀기·공인 IP만 통과 (설계 R4-2, C-01).
 *
 * 왜 응답을 **전부** 검사하는가: 공인 IP 하나와 사설 IP 하나를 섞어 주면 클라이언트가 어느 쪽을
 * 고르느냐에 따라 사설망으로 들어갈 수 있다(R4-2 리바인딩). 하나라도 사설이면 그 이름은 거절이다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, get as httpsGet } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { after, before, describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})

const dns = (await import(new URL('./dns-pin.ts', import.meta.url).href)) as typeof import('./dns-pin')

const answers = (...records: Array<[string, number]>): dnsTypes.LookupAll => async () =>
  records.map(([address, family]) => ({ address, family }))

describe('isPublicIpv4', () => {
  it('사설·예약·멀티캐스트를 막는다', () => {
    const privateOnes = [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.10.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.0.0.1',
      '192.0.2.5',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255'
    ]
    for (const address of privateOnes) assert.equal(dns.isPublicIpv4(address), false, address)
  })

  it('공인 주소는 통과한다', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '203.241.1.1', '172.15.0.1', '172.32.0.1']) {
      assert.equal(dns.isPublicIpv4(address), true, address)
    }
  })

  it('모양이 아니면 false', () => {
    for (const address of ['1.2.3', '1.2.3.4.5', 'a.b.c.d', '', '1.2.3.256', '01.2.3.4x']) {
      assert.equal(dns.isPublicIpv4(address), false, address)
    }
  })
})

describe('isPublicIpv6', () => {
  it('IPv4-mapped는 안쪽 IPv4 규칙을 쓴다', () => {
    assert.equal(dns.isPublicIpv6('::ffff:127.0.0.1'), false)
    assert.equal(dns.isPublicIpv6('::ffff:7f00:1'), false)
    assert.equal(dns.isPublicIpv6('::ffff:192.168.1.1'), false)
    assert.equal(dns.isPublicIpv6('::ffff:8.8.8.8'), true)
  })

  it('루프백·링크로컬·유니크로컬·멀티캐스트·문서용을 막는다', () => {
    for (const address of [
      '::',
      '::1',
      'fe80::1',
      'febf::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      '3fff::1'
    ]) {
      assert.equal(dns.isPublicIpv6(address), false, address)
    }
  })

  it('안쪽 IPv4를 감싼 터널은 그 IPv4가 사설이면 거절한다(R-7)', () => {
    // 6to4 2002::/16 — 조각 1·2가 IPv4.
    assert.equal(dns.isPublicIpv6('2002:7f00:1::'), false)
    assert.equal(dns.isPublicIpv6('2002:a00:1::1'), false)
    assert.equal(dns.isPublicIpv6('2002:808:808::1'), true)
    // Teredo·ORCHID 등 2001::/23은 안쪽 주소 검사로 안전을 못 보장하므로 전부 거절.
    assert.equal(dns.isPublicIpv6('2001:0:4136:e378:8000:63bf:3fff:fdd2'), false)
    assert.equal(dns.isPublicIpv6('2001:2::1'), false)
    assert.equal(dns.isPublicIpv6('2001:20::1'), false)
  })

  it('NAT64는 감싼 IPv4로 판정한다 — 사설이면 거절, 공인이면 통과', () => {
    assert.equal(dns.isPublicIpv6('64:ff9b::1'), false)
    assert.equal(dns.isPublicIpv6('64:ff9b::127.0.0.1'), false)
    assert.equal(dns.isPublicIpv6('64:ff9b::10.0.0.1'), false)
    assert.equal(dns.isPublicIpv6('64:ff9b::8.8.8.8'), true)
    assert.equal(dns.isPublicIpv6('64:ff9b::808:808'), true)
  })

  it('2000::/3 밖은 접두가 그럴듯해도 거절한다', () => {
    for (const address of ['4000::1', '1fff::1', '1000::1']) {
      assert.equal(dns.isPublicIpv6(address), false, address)
    }
  })

  it('공인 글로벌은 통과한다', () => {
    for (const address of [
      '2001:4860:4860::8888',
      '2606:4700::1111',
      '2620:119:35::35',
      '2800:3f0:4001::1',
      '2a00:1450::1',
      '2a10:1::1',
      '2400:cb00::1'
    ]) {
      assert.equal(dns.isPublicIpv6(address), true, address)
    }
  })

  it('대문자·존 표기도 같은 뜻으로 본다', () => {
    assert.equal(dns.isPublicIpv6('FE80::1%en0'), false)
    assert.equal(dns.isPublicIpv6('::FFFF:8.8.8.8'), true)
    assert.equal(dns.isPublicIpv6('2620:119:35::35%en0'), true)
  })

  it('모양이 아니면 false', () => {
    for (const address of ['2001', '2001:db8:::1', ':::', 'gggg::1', '1.2.3.4']) {
      assert.equal(dns.isPublicIpv6(address), false, address)
    }
  })
})

describe('pinHost', () => {
  it('공인 응답이면 첫 레코드로 고정한다', async () => {
    const pin = await dns.pinHost('example.go.kr', answers(['203.241.1.1', 4], ['203.241.1.2', 4]))
    assert.deepEqual(pin, { ok: true, address: '203.241.1.1', family: 4 })
  })

  it('공인+사설이 섞이면 private', async () => {
    const pin = await dns.pinHost('example.go.kr', answers(['203.241.1.1', 4], ['10.0.0.5', 4]))
    assert.deepEqual(pin, { ok: false, reason: 'private' })
  })

  it('두 번째 응답이 사설이어도 거절한다(리바인딩)', async () => {
    let call = 0
    const rebinding: dnsTypes.LookupAll = async () => {
      call += 1
      return call === 1 ? [{ address: '203.241.1.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
    }
    assert.equal((await dns.pinHost('a.go.kr', rebinding)).ok, true)
    assert.deepEqual(await dns.pinHost('a.go.kr', rebinding), { ok: false, reason: 'private' })
  })

  it('빈 응답은 empty, 조회 실패는 dns', async () => {
    assert.deepEqual(await dns.pinHost('a.go.kr', answers()), { ok: false, reason: 'empty' })
    const failing: dnsTypes.LookupAll = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    assert.deepEqual(await dns.pinHost('a.go.kr', failing), { ok: false, reason: 'dns' })
  })
})

describe('fixedLookup', () => {
  const pin = { address: '203.241.1.1', family: 4 }

  it('넘긴 IP만 돌려준다(다시 풀지 않는다)', () => {
    let seen: { address: string; family: number } | null = null
    dns.fixedLookup(pin)('example.go.kr', {}, (error, address, family) => {
      assert.equal(error, null)
      seen = { address: address as string, family: family ?? 0 }
    })
    assert.deepEqual(seen, { address: '203.241.1.1', family: 4 })
  })

  it('family가 다르면 ENOTFOUND로 거절한다', () => {
    let code: string | undefined
    dns.fixedLookup(pin)('example.go.kr', { family: 6 }, (error) => {
      code = error?.code
    })
    assert.equal(code, 'ENOTFOUND')
  })

  it("문자열 family('IPv4')도 받아들인다", () => {
    let code: string | undefined = 'unset'
    dns.fixedLookup(pin)('example.go.kr', { family: 'IPv6' }, (error) => {
      code = error?.code
    })
    assert.equal(code, 'ENOTFOUND')
    let ok = false
    dns.fixedLookup(pin)('example.go.kr', { family: 'IPv4' }, (error) => {
      ok = error === null
    })
    assert.equal(ok, true)
  })

  it('all:true에는 배열로 답한다 — Node가 autoSelectFamily로 부르는 모양', () => {
    let seen: unknown = null
    dns.fixedLookup(pin)('example.go.kr', { all: true }, (error, address) => {
      assert.equal(error, null)
      seen = address
    })
    assert.deepEqual(seen, [{ address: '203.241.1.1', family: 4 }])
  })
})

/**
 * 대역 transport는 `lookup(host, {}, cb)`로만 불러 `{all:true}`를 못 본다 — 그 틈(B-1)을 실제
 * TLS 연결로 잠근다. 인증서는 `fixtures/localhost-*.pem`(CN=localhost, SAN 127.0.0.1)이고 서버는
 * `127.0.0.1:0`에만 뜬다. DNS는 여전히 안 탄다(`lookup: fixedLookup`이 IP를 고정).
 */
describe('fixedLookup + 실제 https.request', () => {
  let server: ReturnType<typeof createServer>
  let port = 0
  let ca = ''

  before(async () => {
    const dir = new URL('./fixtures/', import.meta.url)
    const [cert, key] = await Promise.all([
      readFile(new URL('localhost-cert.pem', dir)),
      readFile(new URL('localhost-key.pem', dir))
    ])
    ca = cert.toString('utf8')
    server = createServer({ cert, key }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('pinned')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
    assert.ok(port > 0)
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  /** 실제 https 연결 하나. `lookup`이 몇 번 어떤 모양으로 불렸는지도 모은다. */
  async function call(pin: { address: string; family: number }): Promise<{ body: string; lookups: unknown[] }> {
    const lookups: unknown[] = []
    const fixed = dns.fixedLookup(pin)
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpsGet(
        {
          host: 'localhost',
          port,
          path: '/',
          servername: 'localhost',
          ca,
          agent: false,
          lookup: (hostname, options, callback) => {
            lookups.push(options)
            fixed(hostname, options, callback as Parameters<typeof fixed>[2])
          }
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        }
      )
      request.on('error', reject)
    })
    return { body, lookups }
  }

  it('all:true로 불려도 고정 IP로 붙는다(B-1: 예전엔 ERR_INVALID_IP_ADDRESS)', async () => {
    const { body, lookups } = await call({ address: '127.0.0.1', family: 4 })
    assert.equal(body, 'pinned')
    assert.ok(lookups.length > 0)
    // Node가 실제로 `all:true`로 부른다는 것을 여기서 못 박는다 — 대역이 놓친 모양.
    assert.equal((lookups[0] as { all?: boolean }).all, true)
  })
})
