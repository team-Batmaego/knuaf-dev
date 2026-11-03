/**
 * 실 kordoc MCP 실측 — `KNUAF_REAL_KORDOC=1` 일 때만 돈다(CI 기본 실행에서는 skip).
 *
 * 왜 있나: 탐침 A/B 판정이 **오류 문자열**에 기대므로, 그 문자열이 실물인지 로컬에서 한 번은
 * 확인해야 한다. 여기서 보는 것:
 *   ① 도구 목록 = `READ_TOOLS ∩ 그 판이 광고하는 도구`(4.17.1 실측 8개)
 *   ② 탐침 A(폴더 자체) → KORDOC_ROOT 오류가 **아님**(확장자 오류)
 *   ③ 탐침 B(부모 폴더) → KORDOC_ROOT 오류
 *   ④ stdin 을 닫으면 프로세스가 스스로 끝난다(E6 의 절반)
 *
 * 띄우는 법(로컬 1회):
 *   KNUAF_REAL_KORDOC=1 KNUAF_KORDOC_MCP_JS=<…>/kordoc/dist/mcp.js \
 *     pnpm -C app exec playwright test e2e/kordoc-mcp-real.spec.ts
 *
 * 학생 폴더·전역 설정은 건드리지 않는다 — `os.tmpdir()` 에 빈 폴더만 만든다.
 */
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { READ_TOOLS, advertisedReadTools, parseVersion } from '../src/main/chat/kordocMcp'
import { ROOT_DENIAL_TEXT } from '../src/main/chat/kordocMcpVerify'

const real = process.env.KNUAF_REAL_KORDOC === '1'
const mcpJs = process.env.KNUAF_KORDOC_MCP_JS ?? ''

test.skip(!real, 'KNUAF_REAL_KORDOC=1 일 때만 실 kordoc MCP 를 띄운다')
test.skip(real && (!mcpJs || !existsSync(mcpJs)), 'KNUAF_KORDOC_MCP_JS 에 kordoc dist/mcp.js 경로를 지정한다')

/** stdio JSON-RPC 최소 클라이언트 — 실제 CLI 들이 하는 일과 같은 모양. */
function client(jsPath: string, root: string) {
  const child = spawn(process.execPath, [jsPath], {
    env: { ...process.env, KORDOC_ROOT: root, KORDOC_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000) })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    const rec = message as { id?: unknown; result?: unknown; error?: { message?: string } }
    if (typeof rec.id !== 'number') return
    const p = pending.get(rec.id)
    if (!p) return
    pending.delete(rec.id)
    rec.error ? p.reject(new Error(rec.error.message ?? 'JSON-RPC 오류')) : p.resolve(rec.result)
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return {
    child,
    exited,
    stderr: () => stderr,
    request(method: string, params: unknown): Promise<unknown> {
      const id = ++seq
      const { promise, resolve, reject } = Promise.withResolvers<unknown>()
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return promise
    },
    notify(method: string, params: unknown) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
  }
}

function textOf(result: unknown): string {
  const rec = result as { content?: { type?: string; text?: unknown }[] }
  return (rec.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n')
}

test('실 kordoc MCP: 도구 목록·탐침 A/B·stdin 종료', async () => {
  test.setTimeout(120_000)
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-real-')))
  const root = join(base, '논문폴더')
  mkdirSync(root)
  const c = client(mcpJs, root)
  try {
    const started = Date.now()
    const init = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'knuaf-e2e', version: '1' }
    }) as { serverInfo?: { name?: string; version?: string } }
    const startupMs = Date.now() - started
    c.notify('notifications/initialized', {})
    expect(init.serverInfo?.name).toBe('kordoc')
    const version = init.serverInfo?.version ?? ''
    expect(parseVersion(version), `판 문자열: ${version}`).not.toBeNull()

    const list = await c.request('tools/list', {}) as { tools?: { name: string }[] }
    const names = (list.tools ?? []).map((t) => t.name)
    const advertised = advertisedReadTools(version)
    const expectedRead = advertised ? READ_TOOLS.filter((t) => advertised.includes(t)) : READ_TOOLS.filter((t) => names.includes(t))
    console.log(`[real] version=${version} startupMs=${startupMs} tools=${names.length}`)
    console.log(`[real] read=${expectedRead.join(',')}`)
    expect(names.length).toBeGreaterThan(0)
    for (const tool of expectedRead) expect(names, `광고되어야 할 읽기 도구: ${tool}`).toContain(tool)
    if (advertised) expect(expectedRead).toHaveLength(advertised.length)

    const probeA = await c.request('tools/call', { name: 'detect_format', arguments: { file_path: root } })
    const textA = textOf(probeA)
    console.log(`[real] probeA=${JSON.stringify(textA)}`)
    expect(textA).not.toContain(ROOT_DENIAL_TEXT)
    expect(textA).toContain('지원하지 않는 확장자')

    const probeB = await c.request('tools/call', { name: 'detect_format', arguments: { file_path: dirname(root) } })
    const textB = textOf(probeB)
    console.log(`[real] probeB=${JSON.stringify(textB)}`)
    expect(textB).toContain(ROOT_DENIAL_TEXT)

    // 없는 파일은 "찾을 수 없음"이지 root 오류가 아니다 — 탐침 판정이 두 오류를 섞지 않는 근거.
    const missing = await c.request('tools/call', { name: 'detect_format', arguments: { file_path: join(root, '없는파일.hwpx') } })
    const textMissing = textOf(missing)
    console.log(`[real] missing=${JSON.stringify(textMissing)}`)
    expect(textMissing).toContain('파일을 찾을 수 없습니다')
    expect(textMissing).not.toContain(ROOT_DENIAL_TEXT)

    // E6 의 절반: stdin 을 닫으면 스스로 끝난다(고아 방지의 전제).
    c.child.stdin.end()
    const race = await Promise.race([
      c.exited.then((e) => ({ exited: true as const, ...e })),
      new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), 5000))
    ])
    if (race.exited) console.log(`[real] exit code=${race.code} signal=${race.signal}`)
    expect(race.exited, `stdin 종료 뒤에도 살아 있어요. stderr:\n${c.stderr()}`).toBe(true)
    if (race.exited) expect(race.code).toBe(0)
  } finally {
    if (!c.child.killed && c.child.exitCode === null) c.child.kill('SIGKILL')
    rmSync(base, { recursive: true, force: true })
  }
})