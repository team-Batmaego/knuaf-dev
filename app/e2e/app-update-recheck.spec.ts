/**
 * v0.6.8 A1-3 — 켜 둔 채 쓰는 학생에게 새 앱 판을 알린다.
 *
 * 발주 시나리오 넷을 그대로 시험한다.
 *  (1) 앱을 켜 둔 채 새 판이 나옴 → 간격 안에 `available` 이 되고 화면 신호(emit)가 한 번 간다.
 *  (2) 받는 중·준비 중엔 주기 확인이 상태를 덮지 않는다.
 *  (3) 인터넷이 끊겨도 오류를 띄우지 않고 다음 간격에 다시 본다.
 *  (4) 앱을 닫을 때 타이머가 종료를 붙잡지 않는다(`unref`) + `stopRecheck()` 가 박자를 멈춘다.
 *
 * 진짜 GitHub 주소로는 요청하지 않는다 — fetch 대역이 채널 문서와 설치 파일을 그 자리에서 돌려준다.
 * 시계는 가짜로 바꾸지 않고 간격을 밀리초로 줄인다(같은 경로를 실제 타이머로 지나간다).
 */
import { expect, test } from '@playwright/test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppUpdates, type AppUpdateStatus } from '../src/main/update/appService'
import { releasePage } from '../src/main/update/appManifest'
import { ASSET_PREFIX, CHANNEL_URL, sha256 } from '../src/main/update/manifest'
import { updateConfig } from '../src/main/update/keys'
import { RECHECK_INTERVAL_MS, startRecheck } from '../src/main/update/recheck'

/** 채널 문서 하나 — 서명된 설치 파일 항목까지 갖춘 최소 모양. */
interface Fixture { bytes: Buffer; channel: { schema: number; app: Record<string, unknown> } }

const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const config = () => updateConfig(false, { KNUAF_UPDATE_PUBLIC_KEY: publicKey })
const roots: string[] = []
const temporary = (): string => { const root = mkdtempSync(join(tmpdir(), 'knuaf-recheck-')); roots.push(root); return root }
const pause = (ms: number): Promise<void> => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise }
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(v = '0.6.0'): Fixture {
  const bytes = Buffer.from(`signed fake installer ${v}`)
  const manifest = { schema: 1, name: 'knuaf-dev-app', version: v, platform: 'win32-x64', url: `${ASSET_PREFIX}v${v}/knuaf-dev-${v}-x64.exe`, size: bytes.length, sha256: sha256(bytes) }
  const source = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const envelope = { manifest: source.toString('base64'), sig: sign(null, source, pair.privateKey).toString('base64') }
  return { bytes, channel: { schema: 1, app: { latest: v, page: releasePage(v), 'win32-x64': envelope } } }
}

/** 켜 둔 앱 하나 — 실제 `AppUpdates` 에 fetch 대역과 emit 수집기를 건다. */
function harness(options: { recheckMs?: number; fixture?: Fixture } = {}) {
  const root = temporary(), f = options.fixture ?? fixture('0.6.0')
  const requests: string[] = [], emitted: AppUpdateStatus['phase'][] = []
  let channel: unknown = f.channel
  let channelFailure: Error | null = null
  let stallAsset = false
  let releaseAsset: (() => void) | null = null
  const updates = new AppUpdates({
    userData: root, current: '0.5.1', platform: 'win32', arch: 'x64', config: config(),
    handoff: { run: async transfer => { await transfer() } },
    fetch: async (url: string, init: { signal: AbortSignal }) => {
      requests.push(url)
      if (url === CHANNEL_URL) {
        if (channelFailure) throw channelFailure
        return new Response(JSON.stringify(channel))
      }
      // 내려받기 대역 — 멈추면 본문이 끝나지 않아 phase 가 `downloading` 에 머문다.
      // 취소(`cancel()`)가 오면 그 자리에서 거절해 설치 약속이 매달리지 않게 한다.
      if (stallAsset) {
        const gate = Promise.withResolvers<void>()
        releaseAsset = gate.resolve
        init.signal.addEventListener('abort', () => gate.reject(new Error('aborted')))
        await gate.promise
      }
      return new Response(f.bytes)
    },
    startInstaller: async () => {}, quit: () => {}, openExternal: async () => {},
    emit: status => { emitted.push(status.phase) },
    recheckMs: options.recheckMs ?? 0
  })
  return {
    root, updates, requests, emitted, fixture: f,
    serve(next: unknown): void { channel = next },
    fail(next: Error | null): void { channelFailure = next },
    stall(on: boolean): void { stallAsset = on; if (!on) releaseAsset?.() },
    channelCalls: (): number => requests.filter(url => url === CHANNEL_URL).length
  }
}

test('(1) 켜 둔 채 새 판이 나오면 간격 안에 available 이 되고 화면에 한 번만 알린다', async () => {
  // 처음에는 새 판이 없다 — 켤 때 확인이 이미 돈 앱의 모습.
  const h = harness({ recheckMs: 20, fixture: fixture('0.5.1') })
  expect((await h.updates.check()).phase).toBe('idle')
  h.emitted.length = 0
  await expect.poll(() => h.channelCalls(), { timeout: 5_000 }).toBeGreaterThan(1)
  await pause(60) // 같은 판을 몇 번 더 본다
  expect(h.updates.status().phase).toBe('idle')
  expect(h.emitted).toEqual([]) // 새 판이 없으면 화면 신호도 없다

  h.serve(fixture('0.6.0').channel) // 새 판이 올라왔다
  await expect.poll(() => h.updates.status().phase, { timeout: 5_000 }).toBe('available')
  expect(h.updates.status()).toMatchObject({ latest: '0.6.0', page: releasePage('0.6.0') })
  // 조용한 확인은 '확인 중' 을 띄우지 않고, 결과가 달라진 순간 한 번만 알린다.
  expect(h.emitted).toEqual(['available'])
  h.updates.stopRecheck()
})

test('(2) 받는 중에는 주기 확인이 상태를 덮지 않고 채널도 부르지 않는다', async () => {
  const h = harness()
  expect((await h.updates.check()).phase).toBe('available')
  h.stall(true)
  const installing = h.updates.install()
  installing.catch(() => { /* 취소로 끝난다 */ })
  await expect.poll(() => h.updates.status().phase, { timeout: 5_000 }).toBe('downloading')
  const requests = h.channelCalls(), before = h.updates.status()
  expect(await h.updates.recheck()).toMatchObject({ phase: 'downloading' })
  expect(h.channelCalls()).toBe(requests) // 확인 자체를 하지 않는다
  expect(h.updates.status()).toEqual(before)
  h.updates.cancel()
  await expect(installing).rejects.toThrow()
})

test('(3) 인터넷이 끊긴 주기 확인은 오류를 띄우지 않고 다음 간격에 다시 본다', async () => {
  const h = harness({ recheckMs: 20, fixture: fixture('0.5.1') })
  expect((await h.updates.check()).phase).toBe('idle')
  h.emitted.length = 0
  const before = h.updates.status()
  h.fail(new Error('getaddrinfo ENOTFOUND github.com'))
  await expect.poll(() => h.channelCalls(), { timeout: 5_000 }).toBeGreaterThan(1) // 다음 박자가 다시 시도
  await pause(60) // 몇 번 더 실패한다
  expect(h.updates.status()).toEqual(before) // 오류 화면 없음 — 이전 모습 그대로
  expect(h.emitted).toEqual([])

  h.fail(null) // 망이 돌아오면 다음 박자가 새 판을 알아챈다
  h.serve(fixture('0.6.0').channel)
  await expect.poll(() => h.updates.status().phase, { timeout: 5_000 }).toBe('available')
  expect(h.emitted).toEqual(['available'])
  h.updates.stopRecheck()
})

test('(4) 타이머는 앱 종료를 붙잡지 않고 stopRecheck 뒤에는 박자가 멈춘다', async () => {
  let ticks = 0
  const timer = startRecheck(10, async () => { ++ticks })
  expect(timer.held()).toBe(false) // unref — 살아 있는 타이머가 프로세스를 못 붙잡는다
  await expect.poll(() => ticks, { timeout: 5_000 }).toBeGreaterThan(0)
  timer.stop(); timer.stop() // 여러 번 불러도 안전
  const stopped = ticks
  await pause(60)
  expect(ticks).toBe(stopped)

  const h = harness({ recheckMs: 10 })
  const { channelCalls } = h
  h.updates.stopRecheck()
  const after = channelCalls()
  await pause(60)
  expect(channelCalls()).toBe(after)
  expect(RECHECK_INTERVAL_MS).toBe(30 * 60 * 1000) // 정한 간격(30분) — 바뀌면 체크포인트도 고친다
})
