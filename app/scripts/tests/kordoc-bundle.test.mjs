// kordoc 덩어리 형식 시험 — 네트워크·pnpm 없이 도는 부분만 잡는다.
//
// 여기서 잠그는 것(앱이 기대는 계약):
//   * 같은 트리 → 같은 tgz 바이트(시각·순서·계정 정보가 새지 않는다)
//   * tar 항목 순서·헤더 고정값·gzip 헤더 고정값
//   * 긴 경로(pax)·한글 경로 왕복, 링크·이상 경로 거부
//   * OCR 섞임 / 다른 판 플랫폼 패키지 섞임 / 변조된 tgz → verify 실패
//   * 명세 레코드 필드
// 실제 설치·압축 해시는 `node app/scripts/kordoc-bundle/bundle.mjs --target …` 로만 나온다
// (네트워크가 필요해서 이 시험에 넣지 않는다).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectTree,
  gzipDeterministic,
  gunzip,
  packEntries,
  packTree,
  packTreeGzip,
  readTar,
  readTarGz,
  sha256Hex,
  splitName,
  truncateUtf8,
} from '../kordoc-bundle/tar.mjs'
import {
  CLI_SHA256,
  KORDOC_VERSION,
  MANIFEST_NAME,
  TARGETS,
  collectBundle,
  installTarget,
  planTarget,
  pnpmSpawnPlan,
  pruneNodeModules,
  quoteCmdArg,
  readPnpmVersion,
  resolveCommand,
  targetFileName,
  targetRecord,
  verifyTarGz,
  writeManifest,
} from '../kordoc-bundle/bundle.mjs'

const tempDirs = []
function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `kordoc-bundle-${tag}-`))
  tempDirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** 파일 몇 개를 가진 트리. `mtime` 을 주면 모든 항목 시각을 그 값으로 맞춘다. */
function makeTree(tag, files, { mtime } = {}) {
  const root = tempDir(tag)
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    if (mtime !== undefined) utimesSync(path, mtime, mtime)
  }
  if (mtime !== undefined) utimesSync(root, mtime, mtime)
  return root
}

const names = (entries) => entries.map((entry) => entry.path)

// ------------------------------------------------------------------ 결정성

test('같은 트리는 두 번 묶어도 바이트가 같다', () => {
  const root = makeTree('same', { 'a.txt': '가\n', 'b/c.txt': 'x'.repeat(2000) })
  const first = packTreeGzip(root)
  const second = packTreeGzip(root)
  assert.deepEqual(first, second)
  assert.equal(sha256Hex(first), sha256Hex(second))
})

test('파일 시각과 만든 순서가 달라도 해시가 같다', () => {
  const early = makeTree('early', { 'a.txt': 'A', 'z/b.txt': 'B' }, { mtime: 1_000_000 })
  const late = makeTree('late', { 'z/b.txt': 'B', 'a.txt': 'A' }, { mtime: 1_700_000_000 })
  assert.equal(sha256Hex(packTreeGzip(early)), sha256Hex(packTreeGzip(late)))
})

test('내용이 다르면 해시가 다르다', () => {
  const a = makeTree('content-a', { 'a.txt': 'A' })
  const b = makeTree('content-b', { 'a.txt': 'A ' })
  assert.notEqual(sha256Hex(packTreeGzip(a)), sha256Hex(packTreeGzip(b)))
})

test('gzip 헤더에 시각·호스트 정보가 없다', () => {
  const root = makeTree('gz', { 'a.txt': 'A' })
  const bytes = packTreeGzip(root)
  assert.equal(bytes[0], 0x1f)
  assert.equal(bytes[1], 0x8b)
  assert.equal(bytes[2], 8)
  assert.equal(bytes[3], 0, 'flags 는 0 이어야 한다(이름·주석 없음)')
  assert.equal(bytes.readUInt32LE(4), 0, 'MTIME 은 0 이어야 한다')
  assert.equal(bytes[9], 255, 'OS 바이트는 unknown(255)')
  // 왕복도 확인 — 우리가 만든 헤더를 우리가 읽는다.
  assert.equal(gunzip(bytes).length % 512, 0)
})

test('tar 헤더는 uid·gid·mtime·이름을 비운다', () => {
  const root = makeTree('hdr', { 'a.txt': 'A' })
  const tar = packTree(root)
  const header = tar.subarray(0, 512)
  const field = (offset, width) => header.subarray(offset, offset + width).toString('latin1').replace(/\0+$/, '')
  assert.equal(field(108, 8), '0000000', 'uid')
  assert.equal(field(116, 8), '0000000', 'gid')
  assert.equal(field(136, 12), '00000000000', 'mtime')
  assert.equal(field(265, 32), '', 'uname')
  assert.equal(field(297, 32), '', 'gname')
  assert.equal(field(100, 8), '0000644', 'mode')
})

test('항목은 경로 바이트 오름차순이고 디렉터리 항목이 함께 들어간다', () => {
  const root = makeTree('order', { 'b/2.txt': '2', 'b/1.txt': '1', 'a.txt': 'a' })
  assert.deepEqual(names(readTar(packTree(root))), ['a.txt', 'b', 'b/1.txt', 'b/2.txt'])
})

test('한글 경로가 그대로 왕복한다', () => {
  const root = makeTree('hangul', { 'templates/빈 양식.hwpx': 'x', '가/나.txt': 'y' })
  const entries = readTar(packTree(root))
  assert.deepEqual(names(entries), ['templates', 'templates/빈 양식.hwpx', '가', '가/나.txt'])
  assert.equal(entries.find((entry) => entry.path === '가/나.txt').data.toString('utf8'), 'y')
})

// ------------------------------------------------------------------ 경로 다루기

test('splitName 은 100B 이하는 그대로, 255B 초과는 null', () => {
  assert.deepEqual(splitName('a/b.txt'), { name: 'a/b.txt', prefix: '' })
  const deep = `${'d'.repeat(120)}/f.txt`
  const split = splitName(deep)
  assert.ok(split)
  assert.equal(`${split.prefix}/${split.name}`, deep)
  assert.ok(Buffer.byteLength(split.prefix) <= 155 && Buffer.byteLength(split.name) <= 100)
  assert.equal(splitName('x'.repeat(300)), null)
})

test('255B 를 넘는 경로는 pax 헤더로 왕복한다', () => {
  const longDir = 'p'.repeat(200)
  const longName = 'n'.repeat(120)
  const root = makeTree('pax', { [`${longDir}/${longName}.txt`]: 'deep' })
  const path = `${longDir}/${longName}.txt`
  assert.ok(path.length > 255)
  const entries = readTar(packTree(root))
  const found = entries.find((entry) => entry.path === path)
  assert.ok(found, `pax 경로를 되읽지 못했다: ${names(entries).join(', ')}`)
  assert.equal(found.data.toString('utf8'), 'deep')
})

test('truncateUtf8 은 글자를 깨지 않고 자른다', () => {
  assert.equal(truncateUtf8('가나다', 5), '가') // 한글 3B → 1글자만
  assert.equal(truncateUtf8('abc', 100), 'abc')
})

// ------------------------------------------------------------------ 거부

test('심볼릭 링크는 담지 않고 던진다', () => {
  const root = makeTree('link', { 'real.txt': 'x' })
  try {
    symlinkSync('real.txt', join(root, 'link.txt'))
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return // 권한 없는 환경(윈도 비관리자)
    throw error
  }
  assert.throws(() => collectTree(root), /심볼릭 링크/)
})

test('읽을 때 절대경로·상위 이동·역슬래시 항목은 거부한다', () => {
  const evil = (name) => {
    const tar = Buffer.alloc(1024)
    tar.write(name, 0, 'latin1')
    tar.write('0000644\0', 100, 'latin1')
    tar.write('0000000\0', 108, 'latin1')
    tar.write('0000000\0', 116, 'latin1')
    tar.write('00000000000\0', 124, 'latin1')
    tar.write('00000000000\0', 136, 'latin1')
    tar.write('        ', 148, 'latin1')
    tar.write('0', 156, 'latin1')
    tar.write('ustar\0', 257, 'latin1')
    tar.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of tar.subarray(0, 512)) sum += byte
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    return tar
  }
  assert.throws(() => readTar(evil('/etc/passwd')), /절대경로/)
  assert.throws(() => readTar(evil('../escape')), /경로가 이상하다/)
  assert.throws(() => readTar(evil('a\\b')), /역슬래시/)
  assert.throws(() => readTar(evil('C:/win')), /드라이브 문자/)
})

test('체크섬이 깨진 헤더는 거부한다', () => {
  const root = makeTree('crc', { 'a.txt': 'A' })
  const tar = Buffer.from(packTree(root))
  tar[0] = 0x62 // 이름 바이트를 바꾸면 체크섬이 맞지 않는다
  assert.throws(() => readTar(tar), /체크섬/)
})

test('CRC 가 깨진 gzip 은 거부한다', () => {
  const bytes = Buffer.from(packTreeGzip(makeTree('badcrc', { 'a.txt': 'A' })))
  bytes[bytes.length - 5] ^= 0xff
  assert.throws(() => gunzip(bytes), /CRC|길이/)
})

// ------------------------------------------------------------------ verify (계약 대조)

/** verify 시험용 가짜 덩어리 — 계약을 만족하는 최소 트리. */
function fakeBundle(tag, { target = 'darwin-arm64', extra = {}, cli = 'fake-cli', kordocVersion = KORDOC_VERSION } = {}) {
  const plan = planTarget(target)
  const files = {
    'package.json': JSON.stringify({ name: 'kordoc-bundle', private: true }),
    'node_modules/kordoc/package.json': JSON.stringify({ name: 'kordoc', version: kordocVersion }),
    'node_modules/kordoc/dist/cli.js': cli,
    'node_modules/kordoc/dist/mcp.js': 'fake-mcp',
  }
  for (const [name, version] of Object.entries(plan.dependencies)) {
    if (name === 'kordoc') continue
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version })
  }
  for (const [rel, content] of Object.entries(extra)) files[rel] = content
  return packTreeGzip(makeTree(tag, files))
}

test('verify 는 가짜 덩어리에서 cli 해시만 걸린다(나머지 계약은 만족)', () => {
  const problems = verifyTarGz(fakeBundle('ok'), 'darwin-arm64')
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /cli\.js 해시가 계약과 다르다/)
  assert.match(CLI_SHA256, /^[0-9a-f]{64}$/)
})

test('verify 는 OCR 패키지가 섞이면 실패한다', () => {
  const problems = verifyTarGz(
    fakeBundle('ocr', { extra: { 'node_modules/onnxruntime-node/package.json': '{}' } }),
    'darwin-arm64',
  )
  assert.ok(problems.some((problem) => problem.includes('OCR')), problems.join('\n'))
})

test('verify 는 다른 판 플랫폼 패키지가 섞이면 실패한다', () => {
  const problems = verifyTarGz(
    fakeBundle('foreign', { extra: { 'node_modules/@img/sharp-win32-x64/package.json': '{}' } }),
    'darwin-arm64',
  )
  assert.ok(problems.some((problem) => problem.includes('다른 판')), problems.join('\n'))
})

test('verify 는 kordoc 판이 다르면 실패한다', () => {
  const problems = verifyTarGz(fakeBundle('ver', { kordocVersion: '4.16.0' }), 'darwin-arm64')
  assert.ok(problems.some((problem) => problem.includes('kordoc 판이 다르다')), problems.join('\n'))
})

test('verify 는 cli.js 가 없으면 실패한다', () => {
  const root = makeTree('nocli', { 'node_modules/kordoc/package.json': JSON.stringify({ version: KORDOC_VERSION }) })
  const problems = verifyTarGz(packTreeGzip(root), 'darwin-arm64')
  assert.ok(problems.some((problem) => problem.includes('dist/cli.js')), problems.join('\n'))
})

test('verify 는 모르는 대상을 거부한다', () => {
  assert.throws(() => verifyTarGz(fakeBundle('unknown'), 'linux-arm64'), /모르는 대상/)
})

// ------------------------------------------------------------------ 명세

test('명세 레코드는 파일명·크기·해시·kordoc 판·cli 상대경로를 담는다', () => {
  const tgz = fakeBundle('record')
  const entries = collectTree(makeTree('record-tree', { 'node_modules/kordoc/dist/cli.js': 'x' }))
  const record = targetRecord({ target: 'darwin-arm64', tgz, entries })
  assert.equal(record.file, targetFileName('darwin-arm64'))
  assert.equal(record.bytes, tgz.length)
  assert.equal(record.sha256, sha256Hex(tgz))
  assert.equal(record.kordocVersion, KORDOC_VERSION)
  assert.equal(record.cli.path, 'node_modules/kordoc/dist/cli.js')
  assert.equal(record.cli.sha256, CLI_SHA256)
  assert.equal(record.unpackedBytes, 1)
  assert.equal(record.files, 1)
  assert.deepEqual(record.packages, planTarget('darwin-arm64').dependencies)
})

test('명세 레코드에는 작업 폴더 절대경로가 없다', () => {
  // 11-15 실측 회귀: buildTarget 이 workDir 를 레코드에 섞어 명세에 `/var/folders/...` 가 박혔다.
  const tgz = fakeBundle('record-clean')
  const entries = collectTree(makeTree('record-clean-tree', { 'node_modules/kordoc/dist/cli.js': 'x' }))
  const record = targetRecord({ target: 'darwin-arm64', tgz, entries })
  const serialized = JSON.stringify(record)
  assert.equal('workDir' in record, false)
  assert.equal(/workDir|\/var\/folders|\/tmp\//.test(serialized), false, serialized)
})

test('명세는 부분 빌드에서 다른 대상을 지우지 않고 targets 를 정렬한다', () => {
  const outDir = tempDir('manifest')
  const tgz = fakeBundle('manifest')
  const entries = collectTree(makeTree('manifest-tree', { 'a.txt': 'a' }))
  writeManifest(outDir, [targetRecord({ target: 'win32-x64', tgz, entries })], { tooling: { node: 'v0', pnpm: '0', zlib: '0' } })
  const manifest = writeManifest(outDir, [targetRecord({ target: 'darwin-arm64', tgz, entries })], {
    tooling: { node: 'v0', pnpm: '0', zlib: '0' },
  })
  assert.deepEqual(Object.keys(manifest.targets), ['darwin-arm64', 'win32-x64'])
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.ocr, false)
  assert.equal(manifest.kordocVersion, KORDOC_VERSION)
  const written = JSON.parse(readFileSync(join(outDir, MANIFEST_NAME), 'utf8'))
  assert.deepEqual(written.targets, manifest.targets)
  assert.match(readFileSync(join(outDir, MANIFEST_NAME), 'utf8'), /\n$/)
})

// ------------------------------------------------------------------ 계획

test('세 대상의 플랫폼 패키지가 서로 겹치지 않는다', () => {
  const seen = new Map()
  for (const target of Object.keys(TARGETS)) {
    for (const name of planTarget(target).platformPackages) {
      assert.equal(seen.has(name), false, `${name} 이 ${seen.get(name)} 와 ${target} 양쪽에 있다`)
      seen.set(name, target)
    }
  }
})

test('collectBundle 은 node_modules·package.json 만 담는다(잔재 제외)', () => {
  const root = makeTree('collect', {
    'package.json': '{}',
    'node_modules/kordoc/package.json': '{}',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'junk.tmp': 'x',
  })
  // node_modules 자체는 항목이 아니다(그 안의 것만 담는다) — junk.tmp 도 빠진다.
  assert.deepEqual(names(collectBundle(root)), [
    'node_modules/kordoc',
    'node_modules/kordoc/package.json',
    'package.json',
    'pnpm-lock.yaml',
  ])
})

test('packEntries 는 수집 뒤 크기가 바뀐 파일을 잡는다', () => {
  assert.throws(
    () => packEntries([{ path: 'a.txt', type: 'file', size: 99 }], () => Buffer.from('short')),
    /크기가 수집 시점과 다르다/,
  )
})

test('gzipDeterministic 은 같은 입력에 같은 출력을 낸다', () => {
  const raw = Buffer.from('x'.repeat(1000))
  assert.deepEqual(gzipDeterministic(raw), gzipDeterministic(raw))
  assert.equal(readTarGz(gzipDeterministic(Buffer.alloc(1024))).length, 0)
})

// ------------------------------------------------------------------ 설치 잔재 제거

/** pnpm 이 실제로 남기는 모양: 패키지들 + 기계 상태 점파일 + .bin + .pnpm. */
function pnpmLikeTree(tag, state) {
  return makeTree(tag, {
    'package.json': '{"name":"kordoc-bundle"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'node_modules/kordoc/package.json': JSON.stringify({ version: KORDOC_VERSION }),
    'node_modules/kordoc/dist/cli.js': 'cli',
    'node_modules/kordoc/dist/cli.js.map': '{"version":3}',
    'node_modules/sharp/package.json': '{}',
    'node_modules/.modules.yaml': 'nodeLinker: hoisted\n',
    'node_modules/.pnpm-workspace-state-v1.json': JSON.stringify(state),
    'node_modules/.bin/kordoc': '#!/bin/sh\n',
    'node_modules/.pnpm/sharp@0.35.5/node_modules/sharp/package.json': '{}',
    'node_modules/onnxruntime-node/package.json': '{}',
    'node_modules/@img/sharp-win32-x64/package.json': '{}',
  })
}

test('pruneNodeModules 는 점(.) 상태 파일까지 걷어낸다', () => {
  // 11-15 실측 회귀: `.pnpm-workspace-state-v1.json` 이 남아 두 번 빌드의 해시가 갈렸다.
  const root = pnpmLikeTree('prune', { projects: { '/tmp/kordoc-bundle-abc': { name: 'x' } } })
  pruneNodeModules(root, planTarget('darwin-arm64'))
  const left = names(collectBundle(root)).filter((path) => path.startsWith('node_modules/.'))
  assert.deepEqual(left, [], `점 항목이 남았다: ${left.join(', ')}`)
})

test('기계 상태 파일 내용이 달라도 같은 해시가 나온다(회귀)', () => {
  // 두 작업 폴더가 점파일 내용(임시 절대경로·나노초 시각)만 다르다 — 그래도 바이트가 같아야 한다.
  const a = pnpmLikeTree('state-a', { projects: { '/tmp/kordoc-bundle-AAA': { at: 1 } } })
  const b = pnpmLikeTree('state-b', { projects: { '/private/var/folders/xx/kordoc-bundle-BBB': { at: 2 } } })
  for (const root of [a, b]) pruneNodeModules(root, planTarget('darwin-arm64'))
  assert.deepEqual(packTreeGzip(a), packTreeGzip(b))
})

test('pruneNodeModules 는 OCR·타 판 패키지·소스맵을 걷어낸다', () => {
  const root = pnpmLikeTree('prune-foreign', {})
  pruneNodeModules(root, planTarget('darwin-arm64'))
  const left = names(collectBundle(root))
  assert.equal(left.some((path) => path.includes('onnxruntime-node')), false)
  assert.equal(left.some((path) => path.includes('sharp-win32-x64')), false)
  assert.equal(left.some((path) => path.endsWith('.map')), false)
  assert.ok(left.includes('node_modules/kordoc/dist/cli.js'))
})

// ------------------------------------------------------------------ pnpm 실행기 해석

/** 실행 비트를 준 파일을 만든다(내용이 곧 실행 방식). */
function makeExecutable(root, name, content) {
  const path = join(root, name)
  writeFileSync(path, content)
  chmodSync(path, 0o755)
  return path
}

test('resolveCommand 는 PATH 를 순서대로 보고 없으면 null 을 돌려준다', () => {
  const dir = tempDir('path')
  const exe = makeExecutable(dir, 'pnpm', '#!/bin/sh\n')
  assert.equal(resolveCommand('pnpm', { env: { PATH: dir }, platform: 'linux' }), exe)
  assert.equal(resolveCommand('pnpm', { env: { PATH: dir }, platform: 'linux' }), exe)
  assert.equal(resolveCommand('nope', { env: { PATH: dir }, platform: 'linux' }), null)
})

test('resolveCommand 는 윈도에서 .cmd 를 찾는다', () => {
  const dir = tempDir('path-win')
  const cmd = join(dir, 'pnpm.cmd')
  writeFileSync(cmd, '@ECHO off\r\n')
  assert.equal(resolveCommand('pnpm', { env: { PATH: dir }, platform: 'win32' }), cmd)
})

test('셔뱅 없는 텍스트 셔틀은 sh 로 감싼다(실측 ENOEXEC 회귀)', () => {
  // `~/.npm-global/bin/pnpm` 은 `#!` 없이 시작하는 sh 스크립트다 — 그대로 spawn 하면 ENOEXEC.
  const dir = tempDir('shim-sh')
  const shim = makeExecutable(dir, 'pnpm', '# pnpm shim\n# no shebang on purpose\n')
  const plan = pnpmSpawnPlan('pnpm', ['add', 'kordoc@4.17.1'], { env: { PATH: dir }, platform: 'darwin' })
  assert.equal(plan.file, '/bin/sh')
  assert.deepEqual(plan.args, [shim, 'add', 'kordoc@4.17.1'])
})

test('진짜 실행 파일은 감싸지 않는다', () => {
  const dir = tempDir('shim-elf')
  const exe = makeExecutable(dir, 'pnpm', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
  assert.deepEqual(pnpmSpawnPlan('pnpm', ['add'], { env: { PATH: dir }, platform: 'linux' }), { file: exe, args: ['add'] })
  const dir2 = tempDir('shim-shebang')
  const node = makeExecutable(dir2, 'pnpm', '#!/usr/bin/env node\n')
  assert.deepEqual(pnpmSpawnPlan('pnpm', ['add'], { env: { PATH: dir2 }, platform: 'darwin' }), {
    file: node,
    args: ['add'],
  })
})

test('윈도 .cmd 는 cmd.exe 로 띄우고 인자를 cmd 문법으로 감싼다', () => {
  const dir = tempDir('shim-cmd')
  const cmd = join(dir, 'pnpm.cmd')
  writeFileSync(cmd, '@ECHO off\r\n')
  const plan = pnpmSpawnPlan('pnpm', ['add', '--os=win32', 'C:\\a b\\x'], {
    env: { PATH: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    platform: 'win32',
  })
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(plan.verbatim, true)
  // 스위치 순서는 코드 계약 그대로: /d /s /v:off /c (모두 /c 앞이면 cmd 가 받는다).
  assert.deepEqual(plan.args.slice(0, 4), ['/d', '/s', '/v:off', '/c'])
  // /s 는 첫·끝 따옴표만 벗긴다 → 바깥 전체 인용을 벗긴 안쪽이 cmd 가 실제로 받는 명령줄이다.
  const line = plan.args[4]
  assert.match(line, /^".*"$/)
  assert.equal(line.slice(1, -1), `${cmd} add --os=win32 "C:\\a b\\x"`)
})

test('공백 있는 pnpm.cmd 경로는 안쪽에서 따옴표로 감싼다', () => {
  // 셔틀 경로에 공백이 있으면(예: `C:\Program Files\…`) 안쪽 인용이 없을 때 cmd 가 첫 낱말에서 끊는다.
  const dir = join(tempDir('space parent'), 'bin dir')
  mkdirSync(dir, { recursive: true })
  const cmd = join(dir, 'pnpm.cmd')
  writeFileSync(cmd, '@ECHO off\r\n')
  const plan = pnpmSpawnPlan('pnpm', ['add', 'kordoc@4.17.1'], {
    env: { PATH: dir, ComSpec: 'cmd.exe' },
    platform: 'win32',
  })
  const line = plan.args[4]
  assert.match(line, /^".*"$/)
  assert.equal(line.slice(1, -1), `"${cmd}" add kordoc@4.17.1`)
})

test('quoteCmdArg 는 공백·특수문자가 없으면 그대로 둔다', () => {
  assert.equal(quoteCmdArg('--os=win32'), '--os=win32')
  assert.equal(quoteCmdArg('a b'), '"a b"')
  assert.equal(quoteCmdArg(''), '""')
  assert.equal(quoteCmdArg('a&b'), '"a&b"')
})

test('pnpm 이 PATH 에 없으면 설치를 시작하지 않고 던진다', () => {
  const dir = tempDir('no-pnpm')
  assert.throws(
    () => pnpmSpawnPlan('pnpm', ['add'], { env: { PATH: dir }, platform: 'linux' }),
    /pnpm 을 PATH 에서 찾지 못했다/,
  )
  const work = tempDir('no-pnpm-work')
  assert.throws(
    () => installTarget(work, planTarget('darwin-arm64'), { env: { PATH: dir } }),
    /pnpm 을 PATH 에서 찾지 못했다/,
  )
})

// ------------------------------------------------------------------ 검토 지적 회귀 (11-15 Roh)

test('cmd 인용은 % 를 조용히 넘기지 않고 거절한다', () => {
  // % 는 큰따옴표로 막을 수 없다(명령줄에서 환경변수로 먼저 확장된다). 그래서 거절이 계약이다.
  assert.throws(() => quoteCmdArg('C:\\Users\\a%20b\\x'), /% 를 넣을 수 없다/)
  const dir = tempDir('pct')
  writeFileSync(join(dir, 'pnpm.cmd'), '@ECHO off\r\n')
  assert.throws(
    () =>
      pnpmSpawnPlan('pnpm', ['add', 'C:\\%TEMP%\\x'], {
        env: { PATH: dir, ComSpec: 'cmd.exe' },
        platform: 'win32',
      }),
    /% 를 넣을 수 없다/,
  )
  // 지연 확장 문자는 감싸서 넘긴다(우리는 /v:off 로도 끈다 — 벨트와 멜빵).
  assert.equal(quoteCmdArg('a!b'), '"a!b"')
})

test('윈도 명령줄은 /v:off 로 띄우고 전체를 한 번 더 감싼다', () => {
  const dir = tempDir('cmdshell')
  const cmd = join(dir, 'pnpm.cmd')
  writeFileSync(cmd, '@ECHO off\r\n')
  const plan = pnpmSpawnPlan('pnpm', ['add', 'kordoc@4.17.1'], {
    env: { PATH: dir, ComSpec: 'cmd.exe' },
    platform: 'win32',
  })
  assert.deepEqual(plan.args.slice(0, 4), ['/d', '/s', '/v:off', '/c'])
  // /s 는 첫·끝 따옴표만 벗긴다 → 안쪽 인용이 살아남으려면 전체를 감싸야 한다.
  assert.match(plan.args[4], /^".*"$/)
})

test('못 도는 pnpm 은 설치 전에 드러난다', () => {
  // 11-15 에 설치 전에 죽던 원인은 플래그였고 그 플래그는 뺐다. 그래서 판 하한은 두지 않는다.
  // 대신 "실행기가 도는가"는 설치 전에 확인한다 — 원인을 한 줄로 보여 주기 위해서다.
  const dir = tempDir('pnpm-broken')
  makeExecutable(dir, 'pnpm', '#!/bin/sh\necho boom >&2\nexit 3\n')
  const env = { ...process.env, PATH: dir }
  assert.throws(() => readPnpmVersion('pnpm', { env, platform: 'linux' }), /pnpm --version 이 실패했다/)
  const work = tempDir('pnpm-broken-work')
  assert.throws(
    () => installTarget(work, planTarget('darwin-arm64'), { pnpm: 'pnpm', env }),
    /pnpm --version 이 실패했다/,
  )
  // 도는 pnpm 이면 판을 돌려준다(하한 판정 없음).
  const okDir = tempDir('pnpm-ok')
  makeExecutable(okDir, 'pnpm', '#!/bin/sh\necho 11.25.0\n')
  assert.equal(readPnpmVersion('pnpm', { env: { PATH: okDir }, platform: 'linux' }), '11.25.0')
})

test('설치 인자에 pnpm 10·11 이 거절하는 --no-frozen-lockfile 이 없다', () => {
  // 이 플래그는 pnpm 10.32·11.25 에서 `Unknown option` 으로 설치 전에 죽었다(11-15 실측).
  const dir = tempDir('install-args')
  makeExecutable(
    dir,
    'pnpm',
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 12.18.0; exit 0; fi\necho "$@" > "$PNPM_ARGS_OUT"\nexit 1\n',
  )
  const out = join(dir, 'args.txt')
  const work = tempDir('install-args-work')
  let error = null
  try {
    installTarget(work, planTarget('darwin-arm64'), { env: { ...process.env, PATH: dir, PNPM_ARGS_OUT: out } })
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'cli.js 가 없으니 실패해야 한다')
  const seen = readFileSync(out, 'utf8')
  assert.equal(seen.includes('frozen-lockfile'), false, seen)
  assert.match(seen, /--config\.node-linker=hoisted/)
  assert.match(seen, /--os=darwin/)
})

test('@napi-rs/canvas 래퍼가 계획에 있고 빠지면 verify 가 잡는다', () => {
  // pdfjs-dist 는 렌더할 때 require('@napi-rs/canvas') 를 한다. --no-optional 설치라
  // 선택 의존성으로는 들어오지 않는다 → 계획에 직접 넣고, 없으면 실패해야 한다(I-01).
  for (const target of Object.keys(TARGETS)) {
    assert.equal(planTarget(target).dependencies['@napi-rs/canvas'], '0.1.100')
  }
  const plan = planTarget('darwin-arm64')
  const files = {
    'package.json': JSON.stringify({ name: 'kordoc-bundle', private: true }),
    'node_modules/kordoc/package.json': JSON.stringify({ version: KORDOC_VERSION }),
    'node_modules/kordoc/dist/cli.js': 'fake-cli',
    'node_modules/kordoc/dist/mcp.js': 'fake-mcp',
  }
  // 래퍼를 뺀 채 나머지 필수 패키지는 다 넣는다 → 문제는 래퍼 하나뿐이어야 한다.
  for (const [name, version] of Object.entries(plan.dependencies)) {
    if (name === 'kordoc' || name === '@napi-rs/canvas') continue
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version })
  }
  const problems = verifyTarGz(packTreeGzip(makeTree('no-canvas-wrapper', files)), 'darwin-arm64')
  assert.equal(problems.filter((p) => p.includes('@napi-rs/canvas')).length, 1, problems.join('\n'))
  assert.ok(
    problems.some((p) => p.includes('필수 패키지가 없다 — @napi-rs/canvas')),
    problems.join('\n'),
  )
})

test('풀어 놓은 트리에서 @napi-rs/canvas 가 해석된다(전역 모듈 없이)', () => {
  // 검사가 "package.json 이 있다"만 보는 게 아니라 실제 탐색이 성립하는지 잠근다.
  const root = makeTree('canvas-resolve', {
    'package.json': '{"name":"kordoc-bundle"}\n',
    'node_modules/@napi-rs/canvas/package.json': JSON.stringify({
      name: '@napi-rs/canvas',
      version: '0.1.100',
      main: 'index.js',
    }),
    'node_modules/@napi-rs/canvas/index.js': 'module.exports = require("@napi-rs/canvas-darwin-arm64")\n',
    'node_modules/@napi-rs/canvas-darwin-arm64/package.json': JSON.stringify({
      name: '@napi-rs/canvas-darwin-arm64',
      version: '0.1.100',
      main: 'index.js',
    }),
    'node_modules/@napi-rs/canvas-darwin-arm64/index.js': 'module.exports = { createCanvas() {} }\n',
  })
  const require = createRequire(join(root, 'package.json'))
  // 맥 /var 는 /private/var 심볼릭 링크다 → 양쪽을 realpath 로 맞춘 뒤 비교한다(11-15 실측 실패).
  assert.equal(
    realpathSync(require.resolve('@napi-rs/canvas')),
    realpathSync(join(root, 'node_modules', '@napi-rs', 'canvas', 'index.js')),
  )
  assert.equal(typeof require('@napi-rs/canvas').createCanvas, 'function')
})

test('명세는 대상마다 그 대상을 만든 도구 판을 적는다', () => {
  const outDir = tempDir('manifest-tooling')
  const record = (target, tooling) =>
    targetRecord({ target, tgz: Buffer.from('x'), entries: [], tooling })
  writeManifest(outDir, [record('darwin-arm64', { pnpm: '12.18.0' })], { tooling: { pnpm: '12.18.0' } })
  // 부분 빌드: 다른 대상을 다시 만들면 그 대상의 tooling 만 바뀐다.
  const manifest = writeManifest(outDir, [record('win32-x64', { pnpm: '13.0.0' })], { tooling: { pnpm: '13.0.0' } })
  assert.equal(manifest.targets['darwin-arm64'].tooling.pnpm, '12.18.0')
  assert.equal(manifest.targets['win32-x64'].tooling.pnpm, '13.0.0')
  assert.equal(manifest.tooling.pnpm, '13.0.0')
})
