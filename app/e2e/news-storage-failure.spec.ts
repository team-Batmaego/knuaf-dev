import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type * as ReleaseModule from '../src/main/releaseNotes'
import type { IpcMain } from 'electron'
import type { Settings, NewsState } from '../src/shared/types'

test('storage failure keeps startup and acknowledgement usable', () => {
  const file = resolve(__dirname, '../src/main/releaseNotes.ts')
  const source = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const factory = new Script(`(function(require,exports,console){${source}\n})`, { filename: file }).runInThisContext() as (require: (name: string) => unknown, exports: Partial<typeof ReleaseModule>, logger: Pick<Console, 'error'>) => void
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const settings: Settings = { recent: [], credit_shown_at: null, python_override: null }
  const errors: unknown[][] = []
  const realRequire = createRequire(file)
  const dependencies: Record<string, unknown> = {
    './settings': { loadSettings: () => settings, saveSettings: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } },
    'node:fs': {
      readdirSync: (dir: string) => dir.endsWith('release-notes') ? ['0.6.8.md'] : [],
      readFileSync: (path: string) => path.endsWith('skill.json') ? JSON.stringify({ source: { tag: 'v0.5.1' } }) : '---\n판: 0.6.8\n날짜: 2026-11-16\n크기: 작은 판\n할 일: 없음\n---\n- 새 소식이에요.\n'
    }
  }
  const module: Partial<typeof ReleaseModule> = {}
  factory(name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module, { error: (...args) => errors.push(args) })
  const ipc = { handle: (name: string, fn: (...args: unknown[]) => unknown) => { handlers.set(name, fn) } } as Pick<IpcMain, 'handle'>
  module.registerReleaseNotes!(() => '/skill', '/app', ipc, () => '0.6.8', false)
  expect([...handlers.keys()]).toEqual(['news:state', 'news:seen'])
  expect((handlers.get('news:state')!(null) as NewsState).mode).toBe('none')
  settings.onboarded_at = 'now'
  const state = handlers.get('news:state')!(null) as NewsState
  expect(state.mode).toBe('none')
  expect(state.unread).toEqual([])
  expect(() => handlers.get('news:seen')!(null, { app: '0.6.8', skill: '0.5.1' })).not.toThrow()
  expect((handlers.get('news:state')!(null) as NewsState).mode).toBe('none')
  expect(errors).toHaveLength(2)
})

test('unavailable app does not block registration and news state retries', () => {
  const file = resolve(__dirname, '../src/main/releaseNotes.ts')
  const source = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const factory = new Script(`(function(require,exports,console){${source}\n})`, { filename: file }).runInThisContext() as (require: (name: string) => unknown, exports: Partial<typeof ReleaseModule>, logger: Pick<Console, 'error'>) => void
  for (const failingVersion of [undefined, () => { throw new Error('unavailable') }]) {
    let getVersion = failingVersion
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const settings: Settings = { recent: [], credit_shown_at: null, python_override: null }
    const realRequire = createRequire(file)
    const dependencies: Record<string, unknown> = {
      './settings': { loadSettings: () => settings, saveSettings: (patch: Partial<Settings>) => Object.assign(settings, patch) },
      'node:fs': { readdirSync: () => [], readFileSync: () => JSON.stringify({ source: { tag: 'v0.5.1' } }) }
    }
    const module: Partial<typeof ReleaseModule> = {}
    factory(name => Object.hasOwn(dependencies, name) ? dependencies[name] : realRequire(name), module, { error: () => {} })
    const ipc = { handle: (name: string, fn: (...args: unknown[]) => unknown) => { handlers.set(name, fn) } } as Pick<IpcMain, 'handle'>
    module.registerReleaseNotes!(() => '/skill', '/app', ipc, () => getVersion!(), false)
    expect([...handlers.keys()]).toEqual(['news:state', 'news:seen'])
    expect(handlers.get('news:state')!(null)).toEqual({ app: '', skill: null, mode: 'none', notes: [], unread: [] })
    getVersion = () => '0.6.8'
    expect(handlers.get('news:state')!(null)).toMatchObject({ app: '0.6.8', mode: 'none' })
    expect(settings.release_notes_seen).toEqual({ app: '0.6.8', skill: '0.5.1' })
  }
})
