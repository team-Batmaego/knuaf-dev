import { assetUrl, MAX_BYTES, object, verifySkill, type VerifiedSkill } from './manifest'
import type { UpdateConfig } from './keys'
import { codeOf, diag } from '../diagLog'
/**
 * `redirect: 'manual'` 의 뜻은 **전송 계층이** 3xx 를 따라가지 않고 응답으로 돌려준다는 것이다
 * (`netTransport.ts`). 3xx 를 응답으로 주지 않는 전송 계층(Electron `net.fetch`)은 쓸 수 없다 —
 * 그 경로는 `Redirect was cancelled` 로 요청을 스스로 취소해 아래 검사까지 오지 않는다.
 */
export type Transport = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>
/** 3xx 판정 목록 — 전송 계층이 돌려주는 3xx 응답은 여기서만 걸러 낸다. */
const REDIRECTS: readonly number[] = [301, 302, 303, 307, 308]
const CDN: Record<string, true> = { 'release-assets.githubusercontent.com': true, 'objects.githubusercontent.com': true, 'github-releases.githubusercontent.com': true }

/** Redirects are inspected before the next request, not just after fetching an arbitrary host. */
export async function boundedFetch(url: string, signal: AbortSignal, fetch: Transport, limit: number, config: UpdateConfig, channel = false): Promise<Response> {
  const stage = channel ? 'channel' : 'asset'
  // 실패 로그의 재료 — 값이 아니라 모양만 남긴다(호스트·상태 코드). 쿼리 문자열은 싣지 않는다.
  let host = '', status: number | null = null
  try {
    if (channel) { if (url !== config.channel) throw new Error('채널 주소가 달라요.') } else assetUrl(url)
    host = new URL(url).hostname
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { signal, redirect: 'manual' })
      status = response.status
      if (REDIRECTS.includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || channel || redirects === 5) throw new Error('허용되지 않은 업데이트 이동 주소예요.')
        const next = new URL(location, url)
        if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || !Object.hasOwn(CDN, next.hostname)) throw new Error('허용되지 않은 업데이트 이동 주소예요.')
        url = next.href
        host = next.hostname
        status = null
        continue
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('업데이트를 내려받지 못했어요.') }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body.cancel(); throw new Error('업데이트 크기 상한을 넘었어요.') }
      let received = 0
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength
          if (received > limit) throw new Error('업데이트 크기 상한을 넘었어요.')
          controller.enqueue(chunk)
        }
      }))
      return new Response(body, { status: response.status, headers: response.headers })
    }
    throw new Error('업데이트 이동 횟수가 너무 많아요.')
  } catch (error) {
    // 앱·규칙집 업데이트 실패는 진단 로그에 한 줄 남긴다 — 맥 실측에서 원인 단서가 0줄이었다.
    // 남기는 것은 **모양**뿐이다: 단계·호스트·상태 코드·오류 이름. 주소·쿼리 문자열은 싣지 않는다.
    // `KNUAF_APP_LOG` 가 없으면 `diag` 는 완전 무동작이다(동작 불변).
    diag(`update:failed stage=${stage} host=${host || '(없음)'} status=${status ?? '-'} error=${codeOf(error)}`)
    throw error
  }
}
export async function readChannelDocument(config: UpdateConfig, fetch: Transport, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!config.keys.length) throw new Error('업데이트를 확인할 수 없어요.')
  const response = await boundedFetch(config.channel, signal, fetch, 512 * 1024, config, true)
  const channel = object(JSON.parse(await response.text()))
  if (channel.schema !== 1) throw new Error('업데이트 채널 형식이 잘못됐어요.')
  return channel
}
export async function readChannel(config: UpdateConfig, fetch: Transport, signal: AbortSignal): Promise<VerifiedSkill | null> {
  const channel = await readChannelDocument(config, fetch, signal)
  return Object.hasOwn(channel, 'skill') ? verifySkill(channel.skill, config.keys) : null
}
export const downloadLimit = (size: number): number => Math.min(MAX_BYTES, size)
