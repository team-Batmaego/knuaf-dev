/**
 * E1 정책 표 + E2 Claude 옵션 스냅샷 (설계 §3.4·§3.3, WORK-PLAN M1).
 *
 * 이 시험은 **실제 파일·실제 심볼릭 링크**를 임시 폴더에 만든다 — 문자열 비교로는 심링크 판정을
 * 고정할 수 없기 때문이다(설계 §1-B: 기존 `outsideRoot`는 링크를 못 본다).
 * 학생 파일·전역 설정(`~/.claude`·`~/.codex`)은 건드리지 않는다.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DENY_FOREIGN_MCP, DENY_NOT_READ, DENY_OUTSIDE_ROOT, MIN_KORDOC_VERSION, READ_TOOLS, READ_TOOL_PATHS,
  WRITE_TOOLS, claudeMcpOptions, insideRootReal, mcpPolicy, resolveKordocMcp, resolveKordocMcpSpec,
  runtimeFromEnsureEnvelope,
  versionAtLeast, type KordocRuntime
} from '../src/main/chat/kordocMcp'

/** 판정 헬퍼 — 표와 1:1로 읽히게 한다. */
const allow = { behavior: 'allow' } as const
const deny = (message: string) => ({ behavior: 'deny', message })

const roots: string[] = []
test.afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** 폴더 안 파일·밖 파일·양방향 링크·없는 파일·한글(NFC/NFD) 이름. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-policy-')))
  roots.push(base)
  const root = join(base, '논문폴더')
  const outsideDir = join(base, '밖폴더')
  mkdirSync(root); mkdirSync(outsideDir)
  const insideFile = join(root, '자료.hwpx')
  const outsideFile = join(outsideDir, '외부.hwpx')
  writeFileSync(insideFile, 'x'); writeFileSync(outsideFile, 'x')
  const linkOut = join(root, 'link-out.hwpx')      // 폴더 안 링크 → 밖 파일
  const linkIn = join(outsideDir, 'link-in.hwpx')  // 폴더 밖 링크 → 안 파일
  symlinkSync(outsideFile, linkOut)
  symlinkSync(insideFile, linkIn)
  const nfdFile = join(root, `${'한글자료'.normalize('NFD')}.hwpx`)
  writeFileSync(nfdFile, 'x')
  return {
    base, root, outsideDir, insideFile, outsideFile, linkOut, linkIn, nfdFile,
    nfcOfNfd: join(root, `${'한글자료'.normalize('NFC')}.hwpx`),
    missing: join(root, '없는파일.hwpx')
  }
}

const f = fixture()
const singlePathTools = READ_TOOLS.filter((t) => t !== 'compare_documents' && t !== 'lint_document' && t !== 'agency_pack_info')

test('E1: 읽기 도구 7개 — 폴더 안·밖·링크 양방향·없음·한글·인자형', () => {
  for (const tool of singlePathTools) {
    const policy = (input: unknown) => mcpPolicy(f.root, `mcp__kordoc__${tool}`, input)
    expect(policy({ file_path: f.insideFile }), `${tool} 안`).toEqual(allow)
    expect(policy({ file_path: f.outsideFile }), `${tool} 밖`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: f.linkOut }), `${tool} 링크→밖`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: f.linkIn }), `${tool} 밖 링크→안`).toEqual(allow)
    expect(policy({ file_path: f.missing }), `${tool} 없음`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: f.nfdFile }), `${tool} NFD`).toEqual(allow)
    expect(policy({ file_path: f.nfcOfNfd }), `${tool} NFD파일을 NFC로`).toEqual(allow)
    // 인자 형태 — 비었거나 문자열이 아니거나 아예 없으면 거절(허용 못 하면 닫힌다).
    expect(policy({}), `${tool} 인자 없음`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: '' }), `${tool} 빈 문자열`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: 42 }), `${tool} 숫자`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy({ file_path: [f.insideFile] }), `${tool} 배열`).toEqual(deny(DENY_OUTSIDE_ROOT))
    expect(policy(null), `${tool} input null`).toEqual(deny(DENY_OUTSIDE_ROOT))
  }
})

test('E1: compare_documents — file_path_a·b 둘 다 폴더 안이어야 허용', () => {
  const policy = (input: unknown) => mcpPolicy(f.root, 'mcp__kordoc__compare_documents', input)
  expect(policy({ file_path_a: f.insideFile, file_path_b: f.nfcOfNfd })).toEqual(allow)
  expect(policy({ file_path_a: f.outsideFile, file_path_b: f.insideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(policy({ file_path_a: f.insideFile, file_path_b: f.outsideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(policy({ file_path_a: f.linkOut, file_path_b: f.insideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(policy({ file_path_a: f.insideFile, file_path_b: f.missing })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(policy({ file_path_a: f.insideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(policy({ file_path_b: f.insideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
})

test('E1: agency_pack_info는 pack_path, lint_document는 경로가 선택', () => {
  expect(mcpPolicy(f.root, 'mcp__kordoc__agency_pack_info', { pack_path: f.insideFile })).toEqual(allow)
  expect(mcpPolicy(f.root, 'mcp__kordoc__agency_pack_info', { pack_path: f.outsideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(mcpPolicy(f.root, 'mcp__kordoc__agency_pack_info', { file_path: f.insideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { text: '본문 검수' })).toEqual(allow)
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { blocks: [] })).toEqual(allow)
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', {})).toEqual(allow)
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { file_path: f.insideFile })).toEqual(allow)
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { file_path: f.outsideFile })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { file_path: f.linkOut })).toEqual(deny(DENY_OUTSIDE_ROOT))
  expect(mcpPolicy(f.root, 'mcp__kordoc__lint_document', { file_path: 3 })).toEqual(deny(DENY_OUTSIDE_ROOT))
})

test('E1: 22개 도구 전수 — 쓰기 12개는 폴더 안 경로여도 거절, 표에 없는 이름도 거절', () => {
  expect([...READ_TOOLS, ...WRITE_TOOLS].length).toBe(22)
  for (const tool of WRITE_TOOLS) {
    expect(mcpPolicy(f.root, `mcp__kordoc__${tool}`, { file_path: f.insideFile }), tool).toEqual(deny(DENY_NOT_READ))
    expect(mcpPolicy(f.root, `mcp__kordoc__${tool}`, {}), tool).toEqual(deny(DENY_NOT_READ))
  }
  expect(mcpPolicy(f.root, 'mcp__kordoc__new_tool', { file_path: f.insideFile })).toEqual(deny(DENY_NOT_READ))
  expect(mcpPolicy(f.root, 'mcp__kordoc__*', { file_path: f.insideFile })).toEqual(deny(DENY_NOT_READ))
  expect(mcpPolicy(f.root, 'mcp__kordoc__', {})).toEqual(deny(DENY_NOT_READ))
})

test('E1: MCP가 아닌 도구는 null(기존 흐름), 다른 서버 MCP는 거절', () => {
  for (const name of ['Read', 'Write', 'Bash', 'Edit', 'Glob']) {
    expect(mcpPolicy(f.root, name, { file_path: f.outsideFile }), name).toBeNull()
  }
  expect(mcpPolicy(f.root, 'mcp__other__x', { file_path: f.insideFile })).toEqual(deny(DENY_FOREIGN_MCP))
  expect(mcpPolicy(f.root, 'mcp__other__parse_document', { file_path: f.insideFile })).toEqual(deny(DENY_FOREIGN_MCP))
})

test('E1: insideRootReal — realpath 기준 판정과 NFC 정규화', () => {
  expect(insideRootReal(f.root, f.root)).toBe(true)
  expect(insideRootReal(f.root, `${f.root}/`)).toBe(true)
  expect(insideRootReal(f.root, f.insideFile)).toBe(true)
  expect(insideRootReal(f.root, `${f.root}/하위/../자료.hwpx`)).toBe(true)
  expect(insideRootReal(f.root, f.outsideFile)).toBe(false)
  expect(insideRootReal(f.root, f.base)).toBe(false)
  expect(insideRootReal(f.root, f.linkOut)).toBe(false)
  expect(insideRootReal(f.root, f.linkIn)).toBe(true)
  expect(insideRootReal(f.root, f.missing)).toBe(false)
  expect(insideRootReal(f.root, f.nfdFile)).toBe(true)
  expect(insideRootReal(f.root, '')).toBe(false)
  expect(insideRootReal(f.root, undefined)).toBe(false)
  expect(insideRootReal(f.root, 7)).toBe(false)
  // 접두만 같은 형제 폴더는 밖이다(`논문폴더2` ⊃ `논문폴더`).
  const sibling = join(f.base, '논문폴더2')
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'a.hwpx'), 'x')
  expect(insideRootReal(f.root, join(sibling, 'a.hwpx'))).toBe(false)
})

/** 판 비교 — 표에 없는 판을 열지 않는 근거. */
test('E2: 판 하한은 숫자 비교이고, 못 읽는 판은 미달', () => {
  expect(MIN_KORDOC_VERSION).toBe('4.17.1')
  expect(versionAtLeast('4.17.1')).toBe(true)
  expect(versionAtLeast('4.17.10')).toBe(true)
  expect(versionAtLeast('4.24.39')).toBe(true)
  expect(versionAtLeast('v4.17.1')).toBe(true)
  expect(versionAtLeast('4.17.0')).toBe(false)
  expect(versionAtLeast('4.9.99')).toBe(false)
  expect(versionAtLeast('garbage')).toBe(false)
  expect(versionAtLeast(null)).toBe(false)
  expect(versionAtLeast(undefined)).toBe(false)
})

/** 런타임 픽스처 — cli.js·mcp.js 형제 배치(실제 kordoc 배포 모양). */
function runtimeFixture(): { dir: string; runtime: KordocRuntime } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kordoc-runtime-')))
  roots.push(dir)
  writeFileSync(join(dir, 'cli.js'), '// cli')
  writeFileSync(join(dir, 'mcp.js'), '// mcp')
  return { dir, runtime: { node: '/opt/homebrew/bin/node', cliJs: join(dir, 'cli.js'), version: '4.17.1', extraEnv: { ELECTRON_RUN_AS_NODE: '1' } } }
}

test('E2: 실행 사양 — mcp.js 형제 진입점·울타리 env·extraEnv', () => {
  const { dir, runtime } = runtimeFixture()
  const spec = resolveKordocMcpSpec(runtime, f.root)!
  expect(spec).toEqual({
    command: '/opt/homebrew/bin/node',
    args: [join(dir, 'mcp.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', KORDOC_ROOT: f.root, KORDOC_OFFLINE: '1' },
    version: '4.17.1'
  })
  // 로그인·비밀값은 절대 넘기지 않는다.
  expect(Object.keys(spec.env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'KORDOC_OFFLINE', 'KORDOC_ROOT'])
  // extraEnv가 울타리를 덮지 못한다.
  const hijack = resolveKordocMcpSpec({ ...runtime, extraEnv: { KORDOC_ROOT: f.base, KORDOC_OFFLINE: '0' } }, f.root)!
  expect(hijack.env.KORDOC_ROOT).toBe(f.root)
  expect(hijack.env.KORDOC_OFFLINE).toBe('1')
})

test('E2: mcp.js가 없으면 `cli.js mcp` 부명령, 셔틀·낮은 판·Node 없음은 미부착', () => {
  const { dir, runtime } = runtimeFixture()
  rmSync(join(dir, 'mcp.js'))
  expect(resolveKordocMcpSpec(runtime, f.root)!.args).toEqual([join(dir, 'cli.js'), 'mcp'])

  const { runtime: fresh } = runtimeFixture()
  expect(resolveKordocMcp({ ...fresh, version: '4.16.9' }, f.root)).toEqual({ ok: false, spec: null, reason: 'old-version' })
  expect(resolveKordocMcp({ ...fresh, version: 'unknown' }, f.root).reason).toBe('old-version')
  expect(resolveKordocMcp({ ...fresh, cliJs: join(dir, 'kordoc.cmd') }, f.root).reason).toBe('shuttle')
  expect(resolveKordocMcp({ ...fresh, cliJs: join(dir, 'kordoc') }, f.root).reason).toBe('shuttle')
  expect(resolveKordocMcp({ ...fresh, node: '   ' }, f.root).reason).toBe('no-node')
  expect(resolveKordocMcp(null, f.root).reason).toBe('no-runtime')
  expect(resolveKordocMcpSpec(undefined, f.root)).toBeNull()
  expect(resolveKordocMcp(fresh, join(f.base, '없는폴더')).reason).toBe('bad-root')
})

test('E2: (선택 도우미) kordoc.ensure 봉투 → 런타임 — ready 만, shim 우선, .js 아닌 경로 거절', () => {
  const { dir } = runtimeFixture()
  const cliJs = join(dir, 'cli.js')
  const ready = { ok: true, data: { status: 'ready', cli_path: cliJs, actual_version: '4.17.1' } }
  expect(runtimeFromEnsureEnvelope(ready, '/opt/homebrew/bin/node')).toEqual({
    node: '/opt/homebrew/bin/node', cliJs, version: '4.17.1', extraEnv: {}
  })
  // 셸 래퍼가 cli_path 로 오면 shim_cli_js(실제 cli.js)를 쓴다.
  expect(runtimeFromEnsureEnvelope({ ok: true, data: { status: 'ready', shim_cli_js: cliJs, cli_path: join(dir, 'kordoc'), actual_version: '4.17.1' } }, '/node')!.cliJs).toBe(cliJs)
  // ready 가 아니거나 사실이 모자라면 붙이지 않는다.
  expect(runtimeFromEnsureEnvelope({ ok: false, data: ready.data }, '/node')).toBeNull()
  expect(runtimeFromEnsureEnvelope({ ok: true, data: { status: 'blocked', cli_path: cliJs, actual_version: '4.17.1' } }, '/node')).toBeNull()
  expect(runtimeFromEnsureEnvelope({ ok: true, data: { status: 'ready', cli_path: join(dir, 'kordoc.cmd'), actual_version: '4.17.1' } }, '/node')).toBeNull()
  expect(runtimeFromEnsureEnvelope({ ok: true, data: { status: 'ready', cli_path: cliJs } }, '/node')).toBeNull()
  expect(runtimeFromEnsureEnvelope(null, '/node')).toBeNull()
  expect(runtimeFromEnsureEnvelope(ready, '/node', { ELECTRON_RUN_AS_NODE: '1' })!.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
})

test('E2: Claude 옵션 세 키 — mcpServers.kordoc·strictMcpConfig·쓰기 12개 제외', () => {
  const { runtime } = runtimeFixture()
  const spec = resolveKordocMcpSpec(runtime, f.root)!
  const options = claudeMcpOptions(spec)
  expect(options).toEqual({
    mcpServers: {
      kordoc: { type: 'stdio', command: '/opt/homebrew/bin/node', args: spec.args, env: spec.env, timeout: 120_000 }
    },
    strictMcpConfig: true,
    disallowedTools: WRITE_TOOLS.map((t) => `mcp__kordoc__${t}`)
  })
  expect(options.disallowedTools).toHaveLength(12)
  // 읽기 도구는 지우지 않는다 — 열어 둔 것과 지운 것이 겹치면 도구가 조용히 사라진다.
  for (const tool of READ_TOOLS) expect(options.disallowedTools).not.toContain(`mcp__kordoc__${tool}`)
  // 경로 인자표는 읽기 10개 전부를 덮는다.
  expect(Object.keys(READ_TOOL_PATHS).sort()).toEqual([...READ_TOOLS].sort())
})