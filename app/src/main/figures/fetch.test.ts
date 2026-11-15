import type * as dnsTypes from './dns-pin'
import type * as fetchTypes from './fetch'
/**
 * figures/fetch.test.ts — 상한·시간·리다이렉트·고정 IP (설계 §4-2·4-4, R4-2).
 *
 * 실제 네트워크를 쓰지 않는다: `transport` 대역이 응답을 만들어 내고, `lookupAll` 대역이 DNS 답을
 * 정한다. 이 시험이 잠그는 것 ① 리다이렉트 홉마다 규칙·DNS를 다시 본다 ② 본문 상한을 넘는 순간
 * 끊는다 ③ 시계는 홉을 가로질러 하나다 ④ 요청 옵션에 프록시·에이전트가 끼지 않는다.
 */

import { registerHooks } from 'node:module'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RequestOptions } from 'node:https'
import type { ClientRequest } from 'node:http'

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

const fetchMod = (await import(new URL('./fetch.ts', import.meta.url).href)) as typeof import('./fetch')
const dns = (await import(new URL('./dns-pin.ts', import.meta.url).href)) as typeof import('./dns-pin')

type TransportResponse = fetchTypes.TransportResponse

/** 응답 대역. `destroy()`는 'close'를 흘려 잘린 본문을 흉내 낸다. */
function respond(status: number, headers: Record<string, string>, body: Buffer, options: { hold?: boolean } = {}): TransportResponse {
  const emitter = new EventEmitter()
  const res: TransportResponse = {
    statusCode: status,
    headers,
    on: emitter.on.bind(emitter) as TransportResponse['on'],
    destroy() {
      emitter.emit('close')
    }
  }
  if (!options.hold) {
    setImmediate(() => {
      if (body.length > 0) emitter.emit('data', body)
      emitter.emit('end')
    })
  }
  return res
}

const seen: RequestOptions[] = []
const pins: Array<{ address: string; family: number }> = []

function transportFor(handler: (url: RequestOptions) => TransportResponse): fetchTypes.Transport {
  return (options, onResponse) => {
    seen.push(options)
    const request = { on() {}, end() {}, destroy() {} } as unknown as ClientRequest
    const lookup = options.lookup as (host: string, opts: object, cb: (error: Error | null, address: string, family: number) => void) => void
    lookup(String(options.host), {}, (error, address, family) => {
      assert.equal(error, null)
      pins.push({ address, family })
    })
    setImmediate(() => onResponse(handler(options)))
    return request
  }
}

const publicDns: dnsTypes.LookupAll = async () => [{ address: '203.241.1.1', family: 4 }]
const allowAll = () => ({ ok: true as const })

function reset(): void {
  seen.length = 0
  pins.length = 0
}

describe('fetchLimited', () => {
  it('규칙·고정 IP를 요청 옵션에 넣는다(프록시·에이전트 없음)', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: { lookupAll: publicDns, transport: transportFor(() => respond(200, { 'content-type': 'text/html' }, Buffer.from('ok'))) }
    })
    assert.equal(result.ok, true)
    const options = seen[0] as RequestOptions
    assert.equal(options.agent, false)
    assert.equal(options.servername, 'www.rda.go.kr')
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.port, 443)
    assert.equal((options.headers as Record<string, string>)['accept-encoding'], 'identity')
    assert.deepEqual(pins, [{ address: '203.241.1.1', family: 4 }])
  })

  it('상한을 넘는 즉시 끊는다 — 다 받고 세지 않는다', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 4,
      timeoutMs: 5000,
      deps: {
        lookupAll: publicDns,
        transport: transportFor(() => respond(200, {}, Buffer.from('0123456789')))
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'limit' })
  })

  it('시간이 지나면 timeout', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 30,
      deps: {
        lookupAll: publicDns,
        transport: transportFor(() => respond(200, {}, Buffer.from(''), { hold: true }))
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
  })

  it('리다이렉트 홉마다 규칙을 다시 본다', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: (url) =>
        url.hostname === 'www.rda.go.kr' ? { ok: true } : { ok: false, reason: 'outside_rules' },
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: {
        lookupAll: publicDns,
        transport: transportFor(() =>
          respond(302, { location: 'https://evil.example/a.jpg' }, Buffer.from(''))
        )
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'outside_rules' })
  })

  it('리다이렉트 홉마다 DNS를 다시 고정한다', async () => {
    reset()
    let hop = 0
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: {
        lookupAll: async () => [{ address: hop++ === 0 ? '203.241.1.1' : '10.0.0.7', family: 4 }],
        transport: transportFor(() => respond(302, { location: '/home/2' }, Buffer.from('')))
      }
    })
    // 두 번째 홉의 DNS 답이 사설이므로 거절 — 고정이 홉마다 다시 걸린다는 증거.
    assert.deepEqual(result, { ok: false, reason: 'private' })
  })

  it('사설 DNS 답은 연결 전에 거절한다(요청을 안 보낸다)', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: { lookupAll: async () => [{ address: '127.0.0.1', family: 4 }], transport: transportFor(() => respond(200, {}, Buffer.from('x'))) }
    })
    assert.deepEqual(result, { ok: false, reason: 'private' })
    assert.equal(seen.length, 0)
  })

  it('리다이렉트가 상한을 넘으면 redirect', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 1,
      deps: {
        lookupAll: publicDns,
        transport: transportFor(() => respond(307, { location: '/home/2' }, Buffer.from('')))
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'redirect' })
    assert.equal(seen.length, 2)
  })

  it('2xx가 아닌 응답은 status', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: { lookupAll: publicDns, transport: transportFor(() => respond(404, {}, Buffer.from(''))) }
    })
    assert.deepEqual(result, { ok: false, reason: 'status' })
  })

  it('https가 아니면 홉에서 거절한다', async () => {
    reset()
    const result = await fetchMod.fetchLimited('http://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: { lookupAll: publicDns, transport: transportFor(() => respond(200, {}, Buffer.from('x'))) }
    })
    assert.deepEqual(result, { ok: false, reason: 'scheme' })
  })

  it('DNS가 매달리면 호출 상한에 timeout — 조회가 시계 밖으로 새지 않는다', async () => {
    reset()
    // R-1: DNS 조회에도 같은 상한이 걸려야 한다. 예전에는 `await pinHost(...)` 앞에 시계가 없어
    // 조회가 영영 안 끝나면 파이썬 도우미의 60초 대기가 통째로 날아갔다.
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 20,
      deps: {
        lookupAll: () => new Promise<readonly dnsTypes.AddressRecord[]>(() => {}),
        transport: transportFor(() => respond(200, {}, Buffer.from('x')))
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
    // 조회에서 끝났으므로 요청은 한 번도 나가지 않는다.
    assert.equal(seen.length, 0)
  })

  it('홉마다 남은 시간으로 DNS 상한을 다시 잡는다', async () => {
    reset()
    let calls = 0
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 40,
      deps: {
        // 첫 홉은 빨리 끝나고, 둘째 홉 DNS가 매달린다 — 남은 시간만 기다린다.
        lookupAll: () => {
          calls += 1
          if (calls === 1) return Promise.resolve([{ address: '203.241.1.1', family: 4 }])
          return new Promise<readonly dnsTypes.AddressRecord[]>(() => {})
        },
        transport: transportFor(() => respond(302, { location: '/home/2' }, Buffer.from('')))
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'timeout' })
    assert.equal(calls, 2)
  })

  it('전송이 던지면 network', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: {
        lookupAll: publicDns,
        transport: () => {
          throw new Error('boom')
        }
      }
    })
    assert.deepEqual(result, { ok: false, reason: 'network' })
  })

  it('최종 URL·Content-Type을 돌려준다', async () => {
    reset()
    const result = await fetchMod.fetchLimited('https://www.rda.go.kr/home/1', {
      validate: allowAll,
      maxBytes: 1024,
      timeoutMs: 5000,
      deps: {
        lookupAll: publicDns,
        transport: transportFor(() => respond(200, { 'content-type': 'image/jpeg' }, Buffer.from('abc')))
      }
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.contentType, 'image/jpeg')
    assert.equal(result.finalUrl.href, 'https://www.rda.go.kr/home/1')
    assert.equal(result.body.toString(), 'abc')
  })

  it('dns-pin 대역과 같은 IP만 쓴다', () => {
    const pin = dns.fixedLookup({ address: '203.241.1.1', family: 4 })
    assert.equal(typeof pin, 'function')
  })
})
