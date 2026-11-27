// kordoc 실행 인자 자리 회귀 — 설계 §6 `KordocRuntime.nodeArgs`, §10 표의 `resolveKordocMcp` 줄.
//
// 잠그는 것: `mcp.js` 형제 진입점 갈래는 **글자 하나 안 바뀐다**(nodeArgs 를 끼우지 않는다),
// 부명령 갈래만 `[...nodeArgs, cliJs, 'mcp']` 로 늘어난다, 모양이 틀린 `nodeArgs` 는 미부착이다.
// 프로세스·네트워크는 띄우지 않는다 — 순수 함수만 본다(선례: `kordoc-mcp-wiring.test.mjs`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const CHAT = resolve(import.meta.dirname, '../../src/main/chat')

/** 시험 하나가 만든 임시 폴더 — 워크트리 밖(tmpdir)에만 만든다. */
const tempDirs = []
function tempDir(tag) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kordoc-args-${tag}-`)))
  tempDirs.push(dir)
  return dir
}
test.after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

const cache = new Map()
function load(file) {
  const target = resolve(file)
  const cached = cache.get(target)
  if (cached) return cached.exports
  const module = { exports: {} }
  cache.set(target, module)
  const code = transpileModule(readFileSync(target, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
  const injected = (name) => {
    if (!name.startsWith('.')) return nodeRequire(name)
    const base = resolve(dirname(target), name)
    return load(existsSync(base + '.ts') ? base + '.ts' : base)
  }
  runInNewContext(code, {
    module, exports: module.exports, require: injected,
    process, Buffer, console, crypto: globalThis.crypto, Promise, URL
  })
  return module.exports
}

/**
 * vm 안에서 만든 배열·객체는 프로토타입이 달라 `assert/strict` 의 deepEqual 이 실패한다
 * ("same structure but not reference-equal"). 호스트 것과 비교하기 전에 옮긴다.
 */
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

const { resolveKordocMcp, resolveKordocMcpSpec } = load(join(CHAT, 'kordocMcp.ts'))

/**
 * 실제 kordoc 배포 모양 — `cli.js` 옆에 `mcp.js`. 논문 폴더(`root`)는 따로 둔다.
 * `siblingMcp:false` 면 `mcp.js` 를 만들지 않아 부명령 갈래를 탄다.
 */
function fixtures(tag, { siblingMcp = true } = {}) {
  const base = tempDir(tag)
  const install = join(base, 'kordoc-4.25.3+kordoc-bundle-2')
  const dist = join(install, 'node_modules', 'kordoc', 'dist')
  const root = join(base, '논문폴더')
  mkdirSync(dist, { recursive: true })
  mkdirSync(root)
  writeFileSync(join(dist, 'cli.js'), '// cli')
  if (siblingMcp) writeFileSync(join(dist, 'mcp.js'), '// mcp')
  const shimPath = join(install, 'electron-node-shim.cjs')
  writeFileSync(shimPath, 'process.defaultApp = true;')
  const runtime = {
    node: '/opt/kordoc/knuaf-dev 앱',
    cliJs: join(dist, 'cli.js'),
    version: '4.25.3',
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
  }
  return { base, install, dist, root, runtime, nodeArgs: ['-r', shimPath] }
}

test('mcp.js 가 옆에 있으면 nodeArgs 를 끼우지 않는다 — args 는 지금 코드 그대로', () => {
  const f = fixtures('sibling')
  // nodeArgs 를 줘도 형제 진입점 갈래는 그대로여야 한다(맥·윈도 실측이 shim 없이 잰 길).
  const spec = resolveKordocMcpSpec({ ...f.runtime, nodeArgs: f.nodeArgs }, f.root)
  assert.deepEqual(plain(spec.args), [join(f.dist, 'mcp.js')])
  assert.equal(spec.command, f.runtime.node)
  assert.deepEqual(plain(spec.env), { ELECTRON_RUN_AS_NODE: '1', KORDOC_ROOT: f.root, KORDOC_OFFLINE: '1' })
})

test('mcp.js 가 없으면 부명령 갈래에 nodeArgs 가 앞에 붙는다', () => {
  const f = fixtures('subcommand', { siblingMcp: false })
  const spec = resolveKordocMcpSpec({ ...f.runtime, nodeArgs: f.nodeArgs }, f.root)
  assert.deepEqual(plain(spec.args), [f.nodeArgs[0], f.nodeArgs[1], join(f.dist, 'cli.js'), 'mcp'])
})

test('사양은 nodeArgs 를 복사한다 — 받은 쪽이 원본을 흔들어도 사양은 그대로', () => {
  const f = fixtures('copy', { siblingMcp: false })
  const nodeArgs = [...f.nodeArgs]
  const spec = resolveKordocMcpSpec({ ...f.runtime, nodeArgs }, f.root)
  nodeArgs.push('--오염')
  assert.deepEqual(plain(spec.args), [f.nodeArgs[0], f.nodeArgs[1], join(f.dist, 'cli.js'), 'mcp'])
})

test('nodeArgs 가 없거나 빈 배열이면 부명령 갈래는 예전 그대로다', () => {
  const f = fixtures('absent', { siblingMcp: false })
  const expected = [join(f.dist, 'cli.js'), 'mcp']
  assert.deepEqual(plain(resolveKordocMcpSpec(f.runtime, f.root).args), expected)
  assert.deepEqual(plain(resolveKordocMcpSpec({ ...f.runtime, nodeArgs: [] }, f.root).args), expected)
})

test('nodeArgs 모양이 틀리면 미부착(no-node)이다 — 문자열 배열만 받는다', () => {
  const f = fixtures('shape')
  for (const bad of ['-r', { 0: '-r', length: 1 }, ['-r', 1], ['-r', null], [undefined], [[]], 7, true]) {
    assert.deepEqual(
      plain(resolveKordocMcp({ ...f.runtime, nodeArgs: bad }, f.root)),
      { ok: false, spec: null, reason: 'no-node' },
      `nodeArgs=${String(JSON.stringify(bad))}`
    )
  }
  // 형제 진입점이 있어도 모양 판정이 갈래보다 앞이다 — 반쯤 아는 런타임으로 열지 않는다.
  assert.equal(resolveKordocMcp({ ...f.runtime, nodeArgs: '-r' }, f.root).reason, 'no-node')
})
