// Electron e2e: 오류 자동 보고 **동의** 계약(DESIGN §2-5·§4 시험 (4)·시나리오 E).
// 수집·큐 I/O 자체는 `crash-sanitise.spec.ts`(Node-only)가 잠근다. 여기서 잠그는 것은 화면과
// 디스크가 함께 움직이는 네 장면뿐이다 — 질문 전 0건, "보내기" 1회, "안 보내기" 즉시 삭제,
// 닫기는 답이 아님.
//
// 수신지는 **127.0.0.1 가짜 서버**뿐이다(`resolveReportUrl` 의 LOCAL_HOSTS). 운영 Worker 로
// 나가는 경로는 이 파일에 없다 — 실 웹훅·실 비밀값·실 사용자 자료를 쓰지 않는다.
import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { launch } from './helpers'
import { scratch, userDataWith } from './fixtures/fake-codex'
import { buildRecord, crashPaths, writeQueue } from '../src/main/crash/sanitise'

/** 받은 POST 본문을 모으는 가짜 수신지. 201 만 큐를 비우는 응답이다(§2-5 outcomeFor). */
interface Sink {
  url: string
  posts: () => Array<Record<string, unknown>>
  close: () => Promise<void>
}

async function startSink(): Promise<Sink> {
  const posts: Array<Record<string, unknown>> = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        posts.push({ unparsed: true })
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/report`,
    posts: () => posts.slice(),
    close: () => {
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      return closed.promise
    }
  }
}

/** 앱이 죽기 전에 남겼을 큐 1건을 같은 스키마로 심는다(`crash/queue.json`). */
function seedQueue(userData: string): void {
  const now = new Date()
  const rec = buildRecord(
    { source: 'main', name: 'TypeError', code: null, origin: 'uncaughtException', stack: null },
    { appRoot: '/nonexistent/app', version: '0.6.2', platform: process.platform, release: '25.6.0', arch: 'arm64', now }
  )
  if (!rec) throw new Error('seed record rejected by buildRecord')
  writeQueue(userData, [{ rec, attempt: 0, first_seen: rec.at }])
}

function queueItems(userData: string): unknown[] {
  try {
    const raw = JSON.parse(readFileSync(crashPaths(userData).queue, 'utf8')) as { items?: unknown }
    return Array.isArray(raw.items) ? raw.items : []
  } catch {
    return []
  }
}

const ASK = 'dialog[data-screen="crash-consent"]'

test('CRASH_ASK_UNSET: 답하기 전에는 질문만 띄우고 한 건도 보내지 않는다', async () => {
  const dir = scratch()
  const userData = userDataWith(dir)
  seedQueue(userData)
  const sink = await startSink()
  const { electronApp, page } = await launch({ userData, env: { KNUAF_CRASH_URL: sink.url } })
  try {
    const ask = page.locator(ASK)
    await expect(ask).toBeVisible({ timeout: 30_000 })
    await expect(ask).toContainText('앞으로 오류가 나면 자동으로 보내요')
    expect(await page.evaluate(() => window.knuaf.crash.status())).toEqual({ ask: true })
    // 질문 전 상태 그대로: 큐 1건 유지, POST 0.
    expect(queueItems(userData)).toHaveLength(1)
    await page.waitForTimeout(1500)
    expect(sink.posts()).toHaveLength(0)
    expect((await page.evaluate(() => window.knuaf.getSettings())).report_consent).toBe('unset')
  } finally {
    await electronApp.close()
    await sink.close()
  }
})

test('CRASH_ASK_ALLOW: "보내기"는 on 으로 굳고 대기 1건을 한 번 보낸다', async () => {
  const dir = scratch()
  const userData = userDataWith(dir)
  seedQueue(userData)
  const sink = await startSink()
  const { electronApp, page } = await launch({ userData, env: { KNUAF_CRASH_URL: sink.url } })
  try {
    const ask = page.locator(ASK)
    await expect(ask).toBeVisible({ timeout: 30_000 })
    await ask.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => sink.posts().length, { timeout: 20_000 }).toBe(1)
    expect((await page.evaluate(() => window.knuaf.getSettings())).report_consent).toBe('on')
    // 본문은 `rec` 뿐이다 — 로컬 관리용 `attempt`·`first_seen` 이 섞이면 안 된다(§2-5).
    const body = sink.posts()[0]
    expect(body.schema).toBe(1)
    expect(body.kind).toBe('crash')
    expect(Object.hasOwn(body, 'attempt')).toBe(false)
    expect(Object.hasOwn(body, 'first_seen')).toBe(false)
    expect(body.where).toBeNull()
    await expect.poll(() => queueItems(userData).length).toBe(0)
    await expect(ask).toBeHidden()
  } finally {
    await electronApp.close()
    await sink.close()
  }
})

test('CRASH_ASK_OFF: off 로 답한 실행은 대기 항목을 지우고 보내지 않는다', async () => {
  const dir = scratch()
  const userData = userDataWith(dir, { report_consent: 'off' })
  seedQueue(userData)
  const sink = await startSink()
  const { electronApp, page } = await launch({ userData, env: { KNUAF_CRASH_URL: sink.url } })
  try {
    await expect.poll(() => queueItems(userData).length, { timeout: 20_000 }).toBe(0)
    await page.waitForTimeout(1500)
    expect(sink.posts()).toHaveLength(0)
    await expect(page.locator(ASK)).toBeHidden()
    expect((await page.evaluate(() => window.knuaf.getSettings())).report_consent).toBe('off')
  } finally {
    await electronApp.close()
    await sink.close()
  }
})

test('CRASH_ASK_DISMISS: 닫기는 답이 아니다 — unset·대기 유지, 이번 실행에서 다시 묻지 않는다', async () => {
  const dir = scratch()
  const userData = userDataWith(dir)
  seedQueue(userData)
  const sink = await startSink()
  const { electronApp, page } = await launch({ userData, env: { KNUAF_CRASH_URL: sink.url } })
  try {
    const ask = page.locator(ASK)
    await expect(ask).toBeVisible({ timeout: 30_000 })
    await ask.press('Escape')
    await expect(ask).toBeHidden()
    expect((await page.evaluate(() => window.knuaf.getSettings())).report_consent).toBe('unset')
    expect(queueItems(userData)).toHaveLength(1)
    // 다시 묻지 않는다(같은 실행 한정) — 상태가 흔들려도 시트가 되살아나면 안 된다.
    await page.waitForTimeout(1500)
    await expect(ask).toBeHidden()
    expect(sink.posts()).toHaveLength(0)
  } finally {
    await electronApp.close()
    await sink.close()
  }
})
