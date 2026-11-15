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
 * `IncomingMessage` 의 읽기 쪽 모습만. 공개 타입(`electron.d.ts`)은 `NodeEventEmitter` 로만
 * 적혀 있지만 런타임 객체는 Node `Readable` 이므로(`lib/common/api/net-client-request.ts`)
 * 여기 한 곳에서만 좁힌다.
 */
type BodyStream = {
  read(): Uint8Array | null
  /** 정상 종료만 참이다 — 데이터가 없어 `read()` 가 null 인 것과 구별하는 유일한 표지. */
  readonly readableEnded: boolean
  on(event: 'readable' | 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * 응답 본문을 웹 스트림으로 — **소비자가 당길 때만** 읽는다(수신 배압).
 *
 * 예전 구현은 `data` 를 들어 흘려 받아 큐에 쌓았다. 소비자가 느리면 본문 전체가 힙에 들어왔다
 * (Roh R-01 실측: 4MiB 응답을 300ms 안 읽어도 4,194,304바이트 전부 수신). 본문 상한이 작지 않다 —
 * 규칙집 80MiB(`manifest.MAX_BYTES`), 앱 설치 파일 1GiB(`appManifest.MAX_INSTALLER_BYTES`).
 *
 * 그래서 `'readable'` + `read()` 로 당긴다. Electron 의 `IncomingMessage` 는 내부에서
 * `_read()` 가 불릴 때만 원격 데이터를 꺼내고, `push()` 가 false 를 돌려주면 원격 읽기 콜백
 * (`resume`)을 붙잡아 둔다 — 즉 **우리가 읽지 않으면 네트워크 수신 자체가 멈춘다**. 큐가 없으니
 * 상한을 넘길 것이 없고, 남는 메모리는 Node `Readable` 버퍼(기본 16KiB)와 소켓 버퍼뿐이다.
 *
 * `cancel()` 은 `request.abort()` 로 연결을 실제로 끊는다 — 학생이 '취소'를 누르면 멈춰야 한다.
 */
function bodyOf(message: IncomingMessage, request: ClientRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const stream = message as unknown as BodyStream
  let closed = false, cancelled = false, failure: Error | null = null
  // 모든 사건(readable·end·error·close·abort)이 이 수를 올린다. `read()` 가 null 을 돌려준 뒤
  // `wake` 를 세우기 전에 사건이 지나가면 깨울 사람이 없으므로, 수를 되짚어 한 번 더 돈다.
  // 사건마다 따로 표시하면 그사이에 낀 'end' 같은 것을 놓친다 — 세는 쪽이 빠짐없다.
  let signals = 0
  let wake: (() => void) | null = null
  // 응답 뒤의 '취소'(학생이 누른 버튼)는 이제 본문을 통해서만 전달된다 — 전송 계층은 이미 정착했다.
  const onAbort = (): void => {
    failure = abortError()
    try { request.abort() } catch { /* 이미 끝난 요청 */ }
    signals += 1
    wake?.()
  }
  const onReadable = (): void => { signals += 1; wake?.() }
  // '취소' 문구를 먼저 잡아 둔다 — abort 직후 Chromium 이 mojo 오류를 던져도 학생에게는 취소로 보여야 한다.
  const onError = (error: Error): void => { failure ??= error; signals += 1; wake?.() }
  const onEnd = (): void => { signals += 1; wake?.() }
  // 이 Electron 판의 `IncomingMessage` 는 'aborted' 를 **한 번도 내지 않는다**(abort 는 요청 쪽
  // 이벤트이고, 응답은 `destroy()` 로만 끝난다). 그래서 종료 신호는 'close' 로 받는다 —
  // 오류 없이 destroy 되면 'error' 없이 'close' 만 오므로, 이걸 빼면 읽는 쪽이 영원히 기다린다.
  const onClose = (): void => { closed = true; signals += 1; wake?.() }
  // 이벤트 구독은 **떼지 않는다** — `error` 를 듣는 이가 없으면 EventEmitter 가 던지고, 그 예외는
  // 우리 `finally` 밖에서 터진다. 대신 `cancel()` 뒤에는 pull 이 청크를 더 내보내지 않는다.
  stream.on('readable', onReadable)
  stream.on('end', onEnd)
  stream.on('error', onError)
  stream.on('close', onClose)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  /** 다 쓴 스트림의 취소 리스너를 뗀다 — 취소 신호는 프로세스보다 오래 살 수 있다. */
  const detach = (): void => { signal.removeEventListener('abort', onAbort) }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        // 취소·실패를 먼저 본다 — '취소'를 누른 뒤에는 읽던 조각을 더 내보내지 않는다.
        if (cancelled) return
        if (failure) { detach(); controller.error(failure); return }
        const seen = signals
        const chunk = stream.read()
        if (chunk) { controller.enqueue(chunk); return }
        // `read()` 의 null 은 '아직 없음'과 '끝' 둘 다다 — `readableEnded` 만이 둘을 가른다.
        if (stream.readableEnded) { detach(); controller.close(); return }
        // 오류 없이 끊긴 응답(취소는 위 `failure` 로 먼저 걸러진다) — 여기서 닫으면 안 된다.
        if (closed) { detach(); controller.error(new Error('업데이트 연결이 끊겼어요.')); return }
        const { promise, resolve } = Promise.withResolvers<void>()
        wake = resolve
        // `read()` 와 위 줄 사이에 지나간 사건은 `wake` 를 못 깨운다 — 수가 달라졌으면 다시 돈다.
        if (signals !== seen) { wake = null; continue }
        await promise
        wake = null
      }
    },
    cancel() {
      cancelled = true
      detach()
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
