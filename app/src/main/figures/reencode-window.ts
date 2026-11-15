/**
 * figures/reencode-window.ts — 승인 그림을 **네트워크 없는 숨김 창**에서 풀고 PNG로 다시 굽는다 (R4-5)
 *
 * 원본 바이트를 docx에 그대로 넣지 않는 이유: JPEG/PNG 안에 붙은 메타데이터·색 프로파일·추가
 * 청크가 그대로 따라간다. Chromium 디코더로 화소만 뽑아 캔버스에 그리고 PNG로 다시 인코딩하면
 * 남는 건 화소뿐이다. 원본은 tmp에서 지우고 해시만 증명에 남긴다.
 *
 * 창은 `sandbox:true`·`nodeIntegration:false`·별도 partition·`show:false`이고, 그 세션의 모든
 * http(s)·ws 요청을 막는다. 이 창에는 외부 페이지도 스크립트도 없다 — 우리가 넣은 data URL 하나뿐이다.
 *
 * 시험에서 Electron 창을 만들 수 없으므로 디코더를 인자로 받는다(`decode`). 기본 구현만 Electron을
 * 동적 import하므로 단위 시험에서 이 모듈을 불러도 electron이 필요 없다.
 */

import type { BrowserWindow as BrowserWindowType } from 'electron'
import type { Session, session as SessionType } from 'electron'

export interface DecodedImage {
  png: Uint8Array
  width: number
  height: number
}

export type ImageDecoder = (bytes: Uint8Array, timeoutMs: number, signal?: AbortSignal) => Promise<DecodedImage>

/** electron 모듈에서 우리가 쓰는 값만. */
type ElectronModule = {
  BrowserWindow: typeof BrowserWindowType
  session: typeof SessionType
}

export type ReencodeResult =
  | { ok: true; png: Uint8Array; width: number; height: number }
  | { ok: false; reason: 'decode' | 'timeout' | 'empty' | 'unavailable' }

export interface ReencodeOptions {
  /** 기본은 Electron 숨김 창. 시험은 가짜 디코더를 넣는다. */
  decode?: ImageDecoder
  /** 디코드 상한(설계 R4-5: 10초). */
  timeoutMs?: number
}

export const DECODE_TIMEOUT_MS = 10_000

/**
 * 바이트를 PNG로 다시 굽는다. 상한을 넘기면 **디코더에게 중단 신호를 보내고** `timeout`으로 닫는다.
 *
 * 상한 시각에 그냥 `Promise.race`로 이기면 디코더는 계속 돌고, Electron 쪽은 숨김 창과 렌더러
 * 프로세스를 그대로 안고 간다(I-3). 그래서 타이머가 `abort()`를 먼저 부르고, 디코더는 자기 자원을
 * 정리한 뒤 거절한다. 신호를 무시하는 디코더(대역·오작동)라도 부름쪽은 상한에 풀려야 하므로
 * 경주에 `timeout` 쪽을 하나 더 둔다 — 신호는 자원 정리용, 경주는 상한 보장용으로 역할이 다르다.
 */
export async function reencodeToPng(bytes: Uint8Array, options: ReencodeOptions = {}): Promise<ReencodeResult> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' }
  const timeoutMs = options.timeoutMs ?? DECODE_TIMEOUT_MS
  const decode = options.decode ?? electronDecoder
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const expired = new Promise<null>((settle) => {
    // `finally`의 abort까지 포함해 반드시 풀린다 — 남는 대기 약속을 만들지 않는다.
    abort.signal.addEventListener('abort', () => settle(null), { once: true })
  })
  type Outcome = { kind: 'decoded'; image: DecodedImage } | { kind: 'failed'; reason: 'decode' | 'timeout' }
  try {
    const raced = await Promise.race<Outcome | null>([
      decode(bytes, timeoutMs, abort.signal).then(
        (image): Outcome => ({ kind: 'decoded', image }),
        (error: unknown): Outcome => ({ kind: 'failed', reason: isAbortError(error) ? 'timeout' : 'decode' })
      ),
      expired
    ])
    if (raced === null) return { ok: false, reason: 'timeout' }
    if (raced.kind === 'failed') return { ok: false, reason: raced.reason }
    if (raced.image.png.length === 0) return { ok: false, reason: 'decode' }
    return { ok: true, png: raced.image.png, width: raced.image.width, height: raced.image.height }
  } finally {
    clearTimeout(timer)
    // 디코더가 늦게 끝나도 신호는 닫아 둔다 — 남은 리스너가 다음 일에 걸리지 않게.
    abort.abort()
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Electron 숨김 창으로 화소만 다시 굽는다. 창 하나를 매번 만드는 비용은 승인 그림 수(요청당 ≤3)만큼이고
 * 창을 재사용하면 이전 그림의 상태가 남으므로 매번 새로 만든다.
 *
 * 셋을 지킨다(I-3). ① 파티션은 **하나만** 쓴다 — 그림마다 파티션을 만들면 Electron 세션이 요청 수만큼
 * 쌓이고 그 세션의 요청 차단기도 같이 쌓인다. ② 상한이 오면 `abort` 신호가 오고, 디코더는 창을 부순
 * 뒤 AbortError로 거절한다 — 부름쪽만 풀리고 창은 남는 일이 없다. ③ 렌더러가 죽거나(`render-process-gone`)
 * 멈추면(`unresponsive`) 그 창은 못 쓰므로 상한까지 기다리지 않고 바로 실패로 닫는다.
 */
const electronDecoder: ImageDecoder = async (bytes, _timeoutMs, signal) => {
  // electron은 Electron 안에서만 값을 내놓는다(`import type`은 지워지므로 안전). 정적 import는
  // 단위 시험(맨 Node)에서 모듈 로드 자체를 깨뜨리므로 값은 여기서 동적으로 가져온다.
  const electron: ElectronModule = await import('electron')
  const { BrowserWindow, session } = electron
  await ensureDecodeSession(session)

  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      partition: DECODE_PARTITION,
      webSecurity: true,
      images: true
    }
  })
  const closed = Promise.withResolvers<void>()
  win.on('closed', () => closed.resolve())

  // 실패·중단을 한 통로로 모은다 — 어느 쪽이 먼저 와도 아래 await가 거기서 풀린다.
  const failure = Promise.withResolvers<never>()
  void failure.promise.catch(() => {})
  const failed = (error: Error): void => failure.reject(error)
  win.webContents.on('render-process-gone', () => failed(new Error('render-process-gone')))
  win.on('unresponsive', () => failed(new Error('unresponsive')))
  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
    failed(abortError())
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal?.aborted) onAbort()
    const html =
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'none'; img-src data:; script-src 'unsafe-inline'\"><body></body>"
    await Promise.race([win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`), failure.promise])
    const base64 = Buffer.from(bytes).toString('base64')
    const script = `(async () => {
      const binary = atob(${JSON.stringify(base64)});
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([raw]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let out = '';
      const chunk = 0x8000;
      for (let i = 0; i < buffer.length; i += chunk) {
        out += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
      }
      return JSON.stringify({ png: btoa(out), width: canvas.width, height: canvas.height });
    })()`
    const raw = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      failure.promise
    ])
    const parsed = JSON.parse(String(raw)) as { png: string; width: number; height: number }
    if (!parsed.png || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) {
      throw new Error('decode failed')
    }
    return { png: new Uint8Array(Buffer.from(parsed.png, 'base64')), width: parsed.width, height: parsed.height }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
    const grace = Promise.withResolvers<void>()
    setTimeout(grace.resolve, 1000)
    await Promise.race([closed.promise, grace.promise])
  }
}

/** 그림 디코드 전용 파티션 — 하나뿐이다. 그 세션의 요청 차단기는 최초 한 번만 건다. */
const DECODE_PARTITION = 'figure-decode'
let decodeSession: Promise<Session> | null = null

function ensureDecodeSession(sessionModule: typeof SessionType): Promise<Session> {
  if (!decodeSession) {
    decodeSession = Promise.resolve().then(() => {
      const part = sessionModule.fromPartition(DECODE_PARTITION, { cache: false })
      // 이 창에서 나가는 요청은 전부 막는다(우리가 넣은 data URL은 webRequest를 타지 않는다).
      part.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
        (_details, callback) => {
          callback({ cancel: true })
        }
      )
      part.setProxy({ mode: 'direct' })
      return part
    })
  }
  return decodeSession
}

function abortError(): Error {
  const error = new Error('decode aborted')
  error.name = 'AbortError'
  return error
}
