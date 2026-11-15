/**
 * E8 레지스트리 몫 — 폴더별 수명(설계 §3.2 '언제'·'실패 시', §3.3 실패 처분).
 * 성공만 캐시 · 실패 미캐시 · 안내 폴더당 1회 · disable 은 이 프로세스에서 영구.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KordocMcpRegistry, attachFailureNote } from '../src/main/chat/kordocMcpRegistry'
import type { KordocRuntime } from '../src/main/chat/kordocMcp'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-registry-')))
const root = join(base, '논문폴더')
mkdirSync(root)
test.afterAll(() => rmSync(base, { recursive: true, force: true }))

function runtimeFixture(): KordocRuntime {
  const dir = join(base, 'kordoc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.js'), '// cli')
  writeFileSync(join(dir, 'mcp.js'), '// mcp')
  return { node: '/opt/homebrew/bin/node', cliJs: join(dir, 'cli.js'), version: '4.17.1' }
}

function harness(reply: () => Promise<KordocRuntime | null>) {
  const calls: string[] = []
  const notes: string[] = []
  const registry = new KordocMcpRegistry({
    ensureKordoc: async (r) => { calls.push(r); return reply() },
    note: (t) => notes.push(t)
  })
  return { registry, calls, notes }
}

test('E8: 성공은 폴더당 1회 — 두 번째 acquire 는 ensureKordoc 을 부르지 않는다', async () => {
  const runtime = runtimeFixture()
  const h = harness(async () => runtime)
  const first = await h.registry.acquire(root)
  const second = await h.registry.acquire(root)
  expect(first).not.toBeNull()
  expect(second).toBe(first)
  expect(h.calls).toEqual([root])
  expect(h.notes).toEqual([])
  expect(first!.env.KORDOC_ROOT).toBe(root)
  expect(first!.env.KORDOC_OFFLINE).toBe('1')
})

test('E8: 실패는 캐시하지 않는다 — 다음 acquire 가 다시 시도하고, 안내는 한 번', async () => {
  const runtime = runtimeFixture()
  let answer: KordocRuntime | null = null
  const h = harness(async () => answer)
  expect(await h.registry.acquire(root)).toBeNull()
  expect(await h.registry.acquire(root)).toBeNull()
  expect(h.calls).toHaveLength(2)
  expect(h.notes).toHaveLength(1)
  expect(h.notes[0]).toBe(attachFailureNote('no-runtime'))
  // 설치가 뒤늦게 되면 붙는다 — 실패를 캐시했다면 여기서 영영 null 이다.
  answer = runtime
  expect(await h.registry.acquire(root)).not.toBeNull()
  expect(h.calls).toHaveLength(3)
  expect(h.notes).toHaveLength(1)
})

test('E8: ensureKordoc 예외와 낮은 판도 같은 처분 — null + 안내 1회', async () => {
  const throwing = harness(async () => { throw new Error('설치 실패') })
  expect(await throwing.registry.acquire(root)).toBeNull()
  expect(throwing.notes).toEqual([attachFailureNote(null)])

  const old = harness(async () => ({ ...runtimeFixture(), version: '4.16.9' }))
  expect(await old.registry.acquire(root)).toBeNull()
  expect(old.notes).toEqual(['한글 문서 읽기 도구를 붙이지 못했어요(깔린 kordoc 판이 오래됐어요). 문서 읽기는 스킬의 스크립트로만 돼요.'])
})

test('E8: disable — 안전 검증 실패 폴더는 이 프로세스에서 다시 열지 않는다', async () => {
  const runtime = runtimeFixture()
  const h = harness(async () => runtime)
  expect(await h.registry.acquire(root)).not.toBeNull()
  h.registry.disable(root)
  expect(h.registry.isDisabled(root)).toBe(true)
  expect(await h.registry.acquire(root)).toBeNull()
  // ensureKordoc 은 처음 한 번만 — disable 뒤에는 시도조차 하지 않는다.
  expect(h.calls).toHaveLength(1)
  expect(h.notes).toEqual([])
})

test('E8: 다른 폴더는 서로의 캐시·안내·disable 에 영향받지 않는다', async () => {
  const runtime = runtimeFixture()
  const otherRoot = join(base, '다른논문')
  mkdirSync(otherRoot)
  const h = harness(async () => runtime)
  await h.registry.acquire(root)
  h.registry.disable(root)
  expect(await h.registry.acquire(otherRoot)).not.toBeNull()
  expect(h.calls).toEqual([root, otherRoot])
})