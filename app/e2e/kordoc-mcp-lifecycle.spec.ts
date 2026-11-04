import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KordocMcpRegistry } from '../src/main/chat/kordocMcpRegistry'
import type { KordocRuntime } from '../src/main/chat/kordocMcp'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-lifecycle-')))
test.afterAll(() => rmSync(base, { recursive: true, force: true }))

function runtimeFixture(): KordocRuntime {
  const dir = join(base, 'kordoc')
  mkdirSync(dir, { recursive: true })
  const cliJs = join(dir, 'cli.js')
  writeFileSync(cliJs, '// synthetic fixture')
  writeFileSync(join(dir, 'mcp.js'), '// synthetic fixture')
  return { node: '/synthetic/node', cliJs, version: '4.17.1' }
}

test('W1: disable during ensure prevents the in-flight acquire from attaching', async () => {
  const root = join(base, 'w1-root')
  mkdirSync(root)
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<KordocRuntime>()
  let calls = 0
  const registry = new KordocMcpRegistry({
    ensureKordoc: () => {
      calls++
      started.resolve()
      return pending.promise
    }
  })

  const acquiring = registry.acquire(root)
  await started.promise
  registry.disable(root)
  pending.resolve(runtimeFixture())

  expect(await acquiring).toBeNull()
  expect(registry.isDisabled(root)).toBe(true)
  expect(await registry.acquire(root)).toBeNull()
  expect(calls).toBe(1)
})

test('W2: disable while a symlink alias is missing invalidates its attached root', async () => {
  const target = join(base, 'w2-target')
  const alias = join(base, 'w2-alias')
  const missing = join(base, 'w2-alias-missing')
  mkdirSync(target)
  symlinkSync(target, alias, 'dir')
  let calls = 0
  const registry = new KordocMcpRegistry({
    ensureKordoc: async () => {
      calls++
      return runtimeFixture()
    }
  })

  expect(await registry.acquire(alias)).not.toBeNull()
  renameSync(alias, missing)
  registry.disable(alias)
  renameSync(missing, alias)

  expect(await registry.acquire(alias)).toBeNull()
  expect(registry.isDisabled(alias)).toBe(true)
  expect(await registry.acquire(target)).toBeNull()
  expect(calls).toBe(1)
})
