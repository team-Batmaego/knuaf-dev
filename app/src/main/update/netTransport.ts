/**
 * 실제 전송 계층 — `net.request`(Chromium 망: 시스템 프록시·OS 인증서 저장소)로 요청하고,
 * `redirect: 'manual'` 의 `'redirect'` 이벤트를 **응답으로 되돌려** 준다.
 *
 * 왜 `net.fetch(…, { redirect: 'manual' })` 이 아닌가: 그 경로는 3xx를 돌려주지 않고 요청을 스스로
 * 취소한다(`Redirect was cancelled`, electron#43715). 그래서 `boundedFetch` 의 이동 주소 검사가
 * 한 번도 실행되지 않았고, 0.6.1~0.6.3 의 앱 안 업데이트가 **모든 판에서** 실패했다
 * (실측: 2026-11-13-v063-release/RESULT-AUTOUPDATE.md).
 *
 * 이 파일이 지키는 경계: **`followRedirect()` 를 부르지 않는다.** 전송 계층은 허용 목록을 모르므로
 * 스스로 이동할 능력이 없어야 한다. 3xx는 응답으로 올라가고, 검사는 `boundedFetch` 한 곳에서만 한다
 * (요청을 내기 **전에** 검사 — 따라간 뒤 사후 검사 금지).
 *
 * 계약(`Transport`)은 그대로다: `(url, { signal }) => Promise<Response>`.
 */
import { net, type ClientRequest, type IncomingMessage } from 'electron'
import type { Transport } from './network'

function abortError(): Error {
  const error = new Error('업데이트를 취소했어요.')
  error.name = 'AbortError'
  return error
}

/**
 * 응답 헤더를 웹 `Headers` 로. `redirect` 이벤트·`IncomingMessage` 둘 다
 * `Record<string, string[]>` 이므로 단일 값으로 편다.
 *
 * `content-length` 가 반드시 살아야 한다 — `boundedFetch` 의 크기 상한 검사가 그 값을 읽는다.
 */
function headersOf(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

/**
 * 응답 본문을 웹 스트림으로.
 *
 * Electron `IncomingMessage` 는 **이벤트만** 준다(`pause`·`destroy`·`complete` 없음) — Node 의
 * `http.IncomingMessage` 와 다르다. 그래서 (a) `Readable.toWeb` 은 쓸 수 없고 (b) 소비자 속도를
 * 맞추려고 `pause()` 를 부를 수도 없다. 받은 청크는 큐에 쌓아 두고 `pull()` 이 소비자 속도대로
 * 내보낸다(다운로드는 상한 25MB 이하라 큐가 커져도 문제되지 않는다).
 * `cancel()` 은 `request.abort()` 로 연결을 실제로 끊는다 — 학생이 '취소'를 누르면 멈춰야 한다.
 */
function bodyOf(message: IncomingMessage, request: ClientRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = []
  let ended = false, cancelled = false, failure: Error | null = null
  let wake: (() => void) | null = null
  // 이벤트(end/error)가 소비자보다 먼저 와도 잃지 않게, 상태를 큐에 접어 두고 pull 이 읽는다.
  // `pull` 은 앞의 약속이 풀릴 때까지 다시 불리지 않으므로 깨우는 자리는 하나면 된다.
  // 응답 뒤의 '취소'(학생이 누른 버튼)는 이제 본문을 통해서만 전달된다 — 전송 계층은 이미 정착했다.
  const onAbort = (): void => {
    failure = abortError()
    try { request.abort() } catch { /* 이미 끝난 요청 */ }
    wake?.()
  }
  const onData = (chunk: Buffer): void => { if (cancelled) return; queue.push(chunk); wake?.() }
  const onEnd = (): void => { ended = true; wake?.() }
  const onError = (error: Error): void => { failure = error; wake?.() }
  // 취소·끊긴 연결은 'error' 가 아니라 'aborted' 로만 온다 — 이걸 빼면 읽는 쪽이 영원히 기다린다.
  const onAborted = (): void => { failure ??= abortError(); wake?.() }
  // 이벤트 구독은 **떼지 않는다** — `error` 를 듣는 이가 없으면 EventEmitter 가 던지고, 그 예외는
  // 우리 `finally` 밖에서 터진다. 대신 `onData` 가 끝난 뒤 청크를 큐에 넣지 않는다(위 `cancelled`).
  message.on('data', onData)
  message.on('end', onEnd)
  message.on('error', onError)
  message.on('aborted', onAborted)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        // 취소·실패를 먼저 본다 — '취소'를 누른 뒤에는 큐에 남은 조각을 더 내보내지 않는다.
        if (cancelled) return
        if (failure) { controller.error(failure); return }
        const chunk = queue.shift()
        if (chunk) { controller.enqueue(chunk); return }
        if (ended) { controller.close(); return }
        const { promise, resolve } = Promise.withResolvers<void>()
        wake = resolve
        await promise
      }
    },
    cancel() {
      cancelled = true
      queue.length = 0 // 더 읽지 않으므로 남은 조각은 버린다(최대 25MB).
      signal.removeEventListener('abort', onAbort)
      wake?.()
      try { request.abort() } catch { /* 이미 닫힌 요청 */ }
    }
  })
}

export const netRequestTransport: Transport = (url, init) => {
  const { promise, resolve, reject } = Promise.withResolvers<Response>()
  const request = net.request({ url, method: 'GET', redirect: 'manual' })
  let settled = false
  const onAbort = (): void => {
    try { request.abort() } catch { /* 이미 끝난 요청 */ }
    finish(() => reject(abortError()))
  }
  /** 네 갈래(redirect·response·error·abort) 중 **첫 것만** 유효하다 — 나머지 이벤트는 버린다. */
  const finish = (apply: () => void): void => {
    if (settled) return
    settled = true
    init.signal.removeEventListener('abort', onAbort)
    apply()
  }
  request.on('redirect', (status, _method, location, headers) => {
    // 따라가지 않는다. 3xx 를 그대로 응답으로 돌려주고, Chromium 의 자동 처리는 우리가 먼저 닫는다.
    const responseHeaders = headersOf(headers)
    responseHeaders.set('location', location)
    finish(() => resolve(new Response(null, { status, headers: responseHeaders })))
    try { request.abort() } catch { /* 이미 취소된 요청 */ }
  })
  request.on('response', (message: IncomingMessage) => {
    const status = message.statusCode
    // 204·205·304 는 본문이 없어야 한다 — `Response` 가 그 조합을 거부한다.
    const body = status === 204 || status === 205 || status === 304 ? null : bodyOf(message, request, init.signal)
    finish(() => resolve(new Response(body, { status, headers: headersOf(message.headers) })))
  })
  request.on('error', (error: Error) => finish(() => reject(error)))
  // 이미 취소된 신호로 시작하면 요청을 내지 않는다(요청 전 취소도 같은 오류 모양으로 끝난다).
  if (init.signal.aborted) { onAbort(); return promise }
  init.signal.addEventListener('abort', onAbort, { once: true })
  request.end()
  return promise
}
