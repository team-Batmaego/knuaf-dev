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

function symlinkFixture(name: string) {
  const dir = join(base, name)
  const a = join(dir, 'A')
  const b = join(dir, 'B')
  const alias = join(dir, 'alias')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  symlinkSync(a, alias, 'dir')
  return { dir, a, b, alias }
}

test('W1: retarget during ensure then disable rejects the pending request and its starting key', async () => {
  const { dir, a, b, alias } = symlinkFixture('w1-retarget-disable')
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

  const acquiring = registry.acquire(alias)
  await started.promise
  renameSync(alias, join(dir, 'alias-A'))
  symlinkSync(b, alias, 'dir')
  registry.disable(alias)
  pending.resolve(runtimeFixture())

  expect(await acquiring).toBeNull()
  expect(registry.isDisabled(alias)).toBe(true)
  expect(registry.isDisabled(b)).toBe(true)
  expect(await registry.acquire(a)).toBeNull()
  expect(calls).toBe(1)
})

test('W1: retarget into an already disabled canonical root rejects the pending request', async () => {
  const { dir, b, alias } = symlinkFixture('w1-retarget-disabled-root')
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

  registry.disable(b)
  const acquiring = registry.acquire(alias)
  await started.promise
  renameSync(alias, join(dir, 'alias-A'))
  symlinkSync(b, alias, 'dir')
  pending.resolve(runtimeFixture())

  expect(await acquiring).toBeNull()
  expect(calls).toBe(1)
})

test('W1: retarget without disable never caches a B spec under the starting A key', async () => {
  const { dir, a, b, alias } = symlinkFixture('w1-retarget-without-disable')
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<KordocRuntime>()
  let calls = 0
  const registry = new KordocMcpRegistry({
    ensureKordoc: () => {
      calls++
      if (calls === 1) {
        started.resolve()
        return pending.promise
      }
      return Promise.resolve(runtimeFixture())
    }
  })

  const acquiring = registry.acquire(alias)
  await started.promise
  renameSync(alias, join(dir, 'alias-A'))
  symlinkSync(b, alias, 'dir')
  pending.resolve(runtimeFixture())

  expect(await acquiring).toBeNull()
  const fromA = await registry.acquire(a)
  expect(fromA).not.toBeNull()
  expect(fromA!.env.KORDOC_ROOT).toBe(a)
  expect(calls).toBe(2)
})

test('W2: disabling a retargeted alias invalidates its previously attached root', async () => {
  const { dir, a, b, alias } = symlinkFixture('w2-retarget-disable')
  let calls = 0
  const registry = new KordocMcpRegistry({
    ensureKordoc: async () => {
      calls++
      return runtimeFixture()
    }
  })

  expect(await registry.acquire(alias)).not.toBeNull()
  renameSync(alias, join(dir, 'alias-A'))
  symlinkSync(b, alias, 'dir')
  registry.disable(alias)
  renameSync(alias, join(dir, 'alias-B'))
  renameSync(join(dir, 'alias-A'), alias)

  expect(await registry.acquire(alias)).toBeNull()
  expect(await registry.acquire(a)).toBeNull()
  expect(calls).toBe(1)
})

test('W2: isDisabled does not erase an attached key before the alias disappears', async () => {
  const { dir, a, b, alias } = symlinkFixture('w2-query-before-disappearance')
  let calls = 0
  const registry = new KordocMcpRegistry({
    ensureKordoc: async () => {
      calls++
      return runtimeFixture()
    }
  })

  expect(await registry.acquire(alias)).not.toBeNull()
  renameSync(alias, join(dir, 'alias-A'))
  symlinkSync(b, alias, 'dir')
  expect(registry.isDisabled(alias)).toBe(false)
  renameSync(alias, join(dir, 'alias-B'))
  registry.disable(alias)
  renameSync(join(dir, 'alias-A'), alias)

  expect(await registry.acquire(alias)).toBeNull()
  expect(await registry.acquire(a)).toBeNull()
  expect(calls).toBe(1)
})
