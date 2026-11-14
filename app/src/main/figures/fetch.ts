/**
 * figures/fetch.ts — 규칙을 통과한 URL 하나를 **상한 안에서** 받는다 (설계 §4-2·4-4, R4-2).
 *
 * Electron `net`을 안 쓴다: 시스템 프록시·PAC을 타고, 실제 접속 IP를 우리가 정할 수 없다.
 * 대신 Node `https.request`에 **고정한 IP**(dns-pin)를 `lookup`으로 넣고 `agent:false`로 연결을
 * 재사용하지 않는다. 리다이렉트는 **수동** — 홉마다 URL 규칙과 DNS 고정을 다시 적용하고, 최대 3번.
 * 프록시 설정은 아예 읽지 않으므로 환경변수 `HTTPS_PROXY`가 있어도 직접 붙는다.
 *
 * 상한은 "다 받고 세는" 게 아니라 **흘려 받으며 즉시 끊는다** — 상한 없는 다운로드가 상한 검사의
 * 목적을 지운다. 파일 전체에 걸린 시계 하나(기본 30초)가 리다이렉트 홉까지 함께 잰다.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { fixedLookup, pinHost, type LookupAll } from './dns-pin'

export interface TransportResponse {
  statusCode: number | undefined
  headers: IncomingMessage['headers']
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  destroy(error?: Error): void
}

/** 시험에서 가짜 응답을 넣기 위한 대역. 기본은 node:https. */
export type Transport = (options: RequestOptions, onResponse: (res: TransportResponse) => void) => ClientRequest

export interface FetchDeps {
  lookupAll?: LookupAll
  transport?: Transport
}

export interface FetchOptions {
  /** 이 URL로 가도 되는가 — 규칙집 판정. 홉마다 다시 부른다. */
  validate: (url: URL) => { ok: true } | { ok: false; reason: string }
  /** 본문 상한(바이트). 넘는 순간 연결을 끊는다. */
  maxBytes: number
  /** 이 호출 전체(리다이렉트 홉 포함)의 상한 시간. */
  timeoutMs: number
  headers?: Record<string, string>
  maxRedirects?: number
  deps?: FetchDeps
}

export type FetchResult =
  | { ok: true; finalUrl: URL; status: number; body: Buffer; contentType: string | null }
  | { ok: false; reason: string }

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function fetchLimited(start: string, options: FetchOptions): Promise<FetchResult> {
  const deadline = Date.now() + options.timeoutMs
  const maxRedirects = options.maxRedirects ?? 3
  const transport = options.deps?.transport ?? defaultTransport
  let current: URL
  try {
    current = new URL(start)
  } catch {
    return { ok: false, reason: 'url' }
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = options.validate(current)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    if (current.protocol !== 'https:') return { ok: false, reason: 'scheme' }

    // DNS 조회도 이 호출의 시계 안에서 끝나야 한다 — 조회가 매달리면 호출 전체 상한이 무의미해진다(R-1).
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, reason: 'timeout' }
    const pinned = await withDeadline(pinHost(current.hostname, options.deps?.lookupAll), remaining)
    if (!pinned) return { ok: false, reason: 'timeout' }
    if (!pinned.ok) return { ok: false, reason: pinned.reason }

    const left = deadline - Date.now()
    if (left <= 0) return { ok: false, reason: 'timeout' }

    const response = await requestOnce(transport, current, pinned, options, left)
    if (!response.ok) return response

    const status = response.status
    const location = headerValue(response.headers, 'location')
    if (REDIRECTS.has(status) && location) {
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, reason: 'redirect' }
      }
      // 다음 홉은 위에서 validate·pin을 다시 거친다. 본문은 이미 버렸다.
      current = next
      continue
    }
    if (status < 200 || status >= 300) return { ok: false, reason: 'status' }
    return {
      ok: true,
      finalUrl: current,
      status,
      body: response.body,
      contentType: headerValue(response.headers, 'content-type') ?? null
    }
  }
  return { ok: false, reason: 'redirect' }
}

/** 이 시간 안에 끝나야 한다. 늦으면 null — 부름쪽이 `timeout`으로 닫는다(R-1). */
function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((settle) => {
    const timer = setTimeout(() => settle(null), timeoutMs)
    const finish = (value: T | null): void => {
      clearTimeout(timer)
      settle(value)
    }
    work.then(finish, () => finish(null))
  })
}

function headerValue(
  headers: IncomingMessage['headers'],
  name: string
): string | null {
  const value = headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

// node:https의 콜백은 IncomingMessage를 준다 — 우리 대역보다 넓으므로 한 번만 좁힌다(필드 이름 동일).
const defaultTransport: Transport = (options, onResponse) =>
  httpsRequest(options, (res) => onResponse(res as unknown as TransportResponse))

/** 한 홉. 성공하면 본문까지 읽어 돌려준다(상한 초과·시간 초과는 즉시 파괴). */
async function requestOnce(
  transport: Transport,
  url: URL,
  pin: { address: string; family: number },
  options: FetchOptions,
  timeoutMs: number
): Promise<
  | { ok: true; status: number; headers: IncomingMessage['headers']; body: Buffer }
  | { ok: false; reason: string }
> {
  const { promise, resolve } = Promise.withResolvers<
    | { ok: true; status: number; headers: IncomingMessage['headers']; body: Buffer }
    | { ok: false; reason: string }
  >()

  let settled = false
  let request: ClientRequest | null = null
  let response: TransportResponse | null = null

  const finish = (value: Awaited<typeof promise>): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(value)
  }
  const fail = (reason: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    // 읽는 중인 연결을 끊는다 — 남겨 두면 소켓이 계속 받는다.
    try {
      response?.destroy()
    } catch {
      /* 이미 닫힘 */
    }
    try {
      request?.destroy()
    } catch {
      /* 이미 닫힘 */
    }
    resolve({ ok: false, reason })
  }
  const timer = setTimeout(() => fail('timeout'), timeoutMs)

  try {
    request = transport(
      {
        protocol: 'https:',
        host: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: fixedLookup(pin),
        servername: url.hostname,
        rejectUnauthorized: true,
        headers: {
          // 앱 자신을 밝힌다. 압축은 안 받는다(받은 바이트가 곧 파일이게).
          'user-agent': 'knuaf-figure/1',
          accept: '*/*',
          'accept-encoding': 'identity',
          ...options.headers
        }
      },
      (res) => {
        response = res
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > options.maxBytes) {
            fail('limit')
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks, size)
          })
        })
        res.on('close', () => {
          // 'end' 없이 닫히면 잘린 본문이다.
          fail('truncated')
        })
        res.on('error', () => fail('network'))
      }
    )
    request.on('error', () => fail('network'))
    request.end()
  } catch {
    fail('network')
  }

  return promise
}
