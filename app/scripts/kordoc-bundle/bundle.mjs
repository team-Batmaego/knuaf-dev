#!/usr/bin/env node
// kordoc 덩어리(OCR 뺀 판) 만들기 — 판/대상 OS 고정, 같은 입력이면 같은 tgz 해시.
//
// 앱이 하는 일(11-13 확정): 첫 실행 준비 때 이 tgz 를 내려받아 풀고, 앱 exe 를
// ELECTRON_RUN_AS_NODE=1 로 띄워 `node_modules/kordoc/dist/cli.js` / `mcp.js` 를 돌린다.
// 그래서 이 스크립트가 지키는 계약은 네 가지다.
//   1) 판 고정 — kordoc 4.17.1, 부속 패키지 버전 못박음. 뜨는 대로 깔지 않는다.
//   2) 대상 고정 — darwin-arm64 / darwin-x64 / win32-x64. 한 덩어리에 다른 판 바이너리가
//      섞이면 윈도 설치본이 깨진다(11-10 실측). 섞이면 verify 가 실패한다.
//   3) OCR 제외 — onnxruntime-node·@huggingface 를 담지 않는다.
//   4) 재현 가능 — 같은 입력이면 같은 sha256. tar 헤더(mtime·uid·gid·순서)를 고정하고
//      gzip 헤더를 직접 조립한다(tar.mjs).
//
// 사용(저장소 루트):
//   node app/scripts/kordoc-bundle/bundle.mjs                     # 세 대상 전부
//   node app/scripts/kordoc-bundle/bundle.mjs --target darwin-arm64
//   node app/scripts/kordoc-bundle/bundle.mjs --verify            # 기존 산출물 재검사
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  collectTree,
  gzipDeterministic,
  packEntries,
  readTarGz,
  sha256Hex,
} from './tar.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const KORDOC_VERSION = '4.17.1'
// 11-10 실측: 맥·윈도 tarball 의 cli.js 해시가 같다(플랫폼별 빌드 아님).
export const CLI_SHA256 = 'f755b0bc4ee860622066f30200e188481501d25969e2e38bcf79e9d2b4897a5c'
export const MANIFEST_NAME = 'kordoc-bundle.json'
export const MANIFEST_FORMAT_VERSION = 1

/** kordoc 이 실행 중에만 쓰는 의존성. 버전은 실측으로 고정한 값이다. */
export const BASE_DEPENDENCIES = {
  kordoc: KORDOC_VERSION,
  'pdfjs-dist': '4.10.38',
  sharp: '0.35.5',
  '@hyzyla/pdfium': '2.1.13',
}

/**
 * 대상별로 반드시 있어야 하는 플랫폼 패키지(이름 → 버전).
 * 이 목록은 장식이 아니라 계약이다: verify 가 "있어야 할 것"과 "있으면 안 되는 것"을
 * 같은 표에서 계산한다.
 */
export const TARGETS = {
  'darwin-arm64': {
    os: 'darwin',
    cpu: 'arm64',
    packages: {
      '@img/sharp-darwin-arm64': '0.35.5',
      '@img/sharp-libvips-darwin-arm64': '1.3.4',
      '@napi-rs/canvas-darwin-arm64': '0.1.100',
    },
  },
  'darwin-x64': {
    os: 'darwin',
    cpu: 'x64',
    packages: {
      '@img/sharp-darwin-x64': '0.35.5',
      '@img/sharp-libvips-darwin-x64': '1.3.4',
      '@napi-rs/canvas-darwin-x64': '0.1.100',
    },
  },
  'win32-x64': {
    os: 'win32',
    cpu: 'x64',
    packages: {
      '@img/sharp-win32-x64': '0.35.5',
      '@napi-rs/canvas-win32-x64-msvc': '0.1.100',
    },
  },
}

const DEFAULT_OUT = resolve(HERE, '..', '..', 'out', 'kordoc-bundle')
const OCR_PACKAGES = ['onnxruntime-node', '@huggingface/transformers']

// ------------------------------------------------------------------ 계획

export const targetFileName = (target) => `kordoc-${target}.tgz`

/** 한 대상의 설치 계획 — 순수 함수(네트워크·파일 없음). */
export function planTarget(target) {
  const spec = TARGETS[target]
  if (!spec) throw new Error(`모르는 대상: ${target} (가능: ${Object.keys(TARGETS).join(', ')})`)
  const dependencies = { ...BASE_DEPENDENCIES, ...spec.packages }
  return {
    target,
    os: spec.os,
    cpu: spec.cpu,
    file: targetFileName(target),
    // 이름 고정 순서 — 명세·로그가 실행마다 흔들리지 않게.
    dependencies: Object.fromEntries(Object.keys(dependencies).sort().map((k) => [k, dependencies[k]])),
    platformPackages: Object.keys(spec.packages).sort(),
    foreignPackages: Object.entries(TARGETS)
      .filter(([other]) => other !== target)
      .flatMap(([, s]) => Object.keys(s.packages))
      .sort(),
  }
}

function writeWorkPackage(workDir, plan) {
  const json = {
    name: 'kordoc-bundle',
    version: '0.0.0',
    private: true,
    dependencies: plan.dependencies,
  }
  writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(json, null, 2)}\n`)
}

// ------------------------------------------------------------------ 설치

// 실행기 해석 ---------------------------------------------------------
//
// 그냥 `spawnSync('pnpm', …)` 하면 이 맥에서 ENOEXEC 으로 죽는다(실측). 이유는 pnpm 11 이
// 설치하는 전역 셔틀(`~/.npm-global/bin/pnpm`)이 shebang 없는 `sh` 스크립트여서다 —
// 커널은 이걸 실행 파일로 못 알아보고, execvp 를 직접 부르는 프로그램(애플 libc)은
// 셸에게 넘기지 않는다. 윈도의 `pnpm.cmd` 는 배치 파일이라 같은 부류다(Node 18.20+ 는
// 셸 없이 .cmd 를 띄우지 못한다). 그래서 실행 파일의 첫 바이트를 보고 부를 방법을 고른다.

const NATIVE_MAGIC = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]

function readHead(path, size = 4) {
  const buffer = Buffer.alloc(size)
  let fd
  try {
    fd = openSync(path, 'r')
    const read = readSync(fd, buffer, 0, size, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 실행 파일을 그대로 띄울 수 있는가(네이티브 바이너리이거나 `#!` 로 시작). */
function runnableDirectly(head) {
  if (!head || head.length < 4) return false
  if (head.toString('latin1', 0, 2) === '#!') return true
  if (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return true
  if (head.toString('latin1', 0, 2) === 'MZ') return true
  return NATIVE_MAGIC.includes(head.readUInt32BE(0))
}

/** PATH 에서 실행 파일을 찾는다(윈도는 확장자도 붙여 본다). 못 찾으면 null. */
export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  const exts =
    platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(name) ? ['.cmd', '.exe', '.bat', '.com', ''] : ['']
  const dirs = name.includes('/') || name.includes('\\') ? [''] : (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir === '' ? `${name}${ext}` : join(dir, `${name}${ext}`)
      if (candidate === '') continue
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // 다음 후보
      }
    }
  }
  return null
}

/** cmd.exe 에 넘길 인자 하나를 감싼다(따옴표·`&`·`^` 같은 cmd 문법에서 살아남게). */
export function quoteCmdArg(arg) {
  if (arg === '') return '""'
  // cmd 가 문법으로 먹는 문자만 감싼다. `=`·`,`·`;`·`!` 는 cmd 에서 평범한 문자다 —
  // 이걸로 감싸면 `--os=win32` 가 `"--os=win32"` 가 되어 pnpm 이 플래그를 못 읽는다(11-15 실패).
  if (!/[\s"&|<>^()%]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * `pnpm add` 를 어떻게 띄울지 정한다. 돌려주는 값은 spawnSync 에 그대로 넘긴다.
 * 텍스트 스크립트(셔뱅 없음)면 POSIX 에서는 `sh`, 윈도에서는 `cmd.exe` 로 감싼다 — 인자는
 * 각각 따로 넘겨 셸 인용 문제를 만들지 않는다(윈도 cmd 만 예외로 인용을 우리가 한다).
 */
export function pnpmSpawnPlan(pnpm, args, { env = process.env, platform = process.platform } = {}) {
  const resolved = resolveCommand(pnpm, { env, platform })
  if (!resolved) throw new Error(`pnpm 을 PATH 에서 찾지 못했다(${pnpm}) — PATH 를 확인해라`)
  if (runnableDirectly(readHead(resolved))) return { file: resolved, args }
  if (platform === 'win32') {
    const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
    const line = [resolved, ...args].map(quoteCmdArg).join(' ')
    return { file: comspec, args: ['/d', '/s', '/c', line], verbatim: true }
  }
  return { file: '/bin/sh', args: [resolved, ...args] }
}

/**
 * 작업 폴더에 대상 판을 깐다. lab/make-payload.sh 가 실측으로 확인한 플래그를 그대로 쓴다:
 *   --config.node-linker=hoisted  → 진짜 hoisted(심볼릭 링크 0개). 윈도 설치본이 링크를 못 만든다.
 *   --config.ignore-scripts=true  → 설치 스크립트가 네트워크를 타면 재현이 깨진다.
 *   --no-optional                 → 타 플랫폼 선택 의존성 유입 차단(플랫폼 패키지는 직접 지정).
 */
export function installTarget(workDir, plan, { pnpm = 'pnpm', storeDir, env = process.env } = {}) {
  writeWorkPackage(workDir, plan)
  const specs = Object.entries(plan.dependencies).map(([name, version]) => `${name}@${version}`)
  const args = [
    'add',
    '--config.node-linker=hoisted',
    '--config.ignore-scripts=true',
    '--no-optional',
    `--os=${plan.os}`,
    `--cpu=${plan.cpu}`,
    '--no-frozen-lockfile',
    // package.json 에 정확한 판을 적는다(기본은 `^` 범위) — 명세의 dependencies 와 같아진다.
    '--save-exact',
    ...(storeDir ? [`--store-dir`, storeDir] : []),
    '--reporter=append-only',
    ...specs,
  ]
  const spawn = pnpmSpawnPlan(pnpm, args, { env })
  // pnpm 10+ 는 "빌드 스크립트 무시" 때문에 exit 1 을 낸다(설치는 이미 끝난 상태).
  // 이 실패만 삼킨다 — 그 밖의 실패는 그대로 던진다. 그 문구는 stdout 으로도 나오므로 둘 다 본다.
  const result = spawnSync(spawn.file, spawn.args, {
    encoding: 'utf8',
    cwd: workDir,
    env,
    maxBuffer: 32 * 1024 * 1024,
    ...(spawn.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  if (result.error) throw result.error
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const installed = existsSync(join(workDir, 'node_modules', 'kordoc', 'dist', 'cli.js'))
  if (!installed) {
    throw new Error(`설치 실패(exit ${result.status}) — kordoc/dist/cli.js 가 없다\n${output.trim()}`)
  }
  if (result.status !== 0 && !/Ignored build scripts/i.test(output)) {
    throw new Error(`pnpm add 실패(exit ${result.status})\n${output.trim()}`)
  }
  return { exitCode: result.status, ignoredBuilds: result.status !== 0 }
}

/** 설치 직후 기계마다 달라지는 것들을 걷어낸다(절대경로·시각·링크·소스맵). */
export function pruneNodeModules(workDir, plan) {
  const modules = join(workDir, 'node_modules')
  const remove = (rel) => rmSync(join(modules, ...rel.split('/')), { recursive: true, force: true })

  // 1) 셸 셔틀(.bin) — 앱은 `node <cli.js>` 로 띄우므로 필요 없고, 윈도에서 링크/심(shim)이 된다.
  remove('.bin')
  // 2) pnpm 내부 저장소와 기계 상태 파일 — 절대경로가 박혀 있어 재현성·개인정보 문제.
  remove('.pnpm')
  remove('.modules.yaml')
  remove('.package-lock.json')
  // 2b) 그래도 남는 점(.) 항목 — pnpm 10 은 `.pnpm-workspace-state-v1.json` 을 남기고,
  //     그 안에 임시 폴더 절대경로와 나노초 시각이 박힌다. 그대로 담으면 해시가 실행마다,
  //     기계마다 달라져 "해시 고정 내려받기"가 성립하지 않는다. npm 패키지 이름은 점으로
  //     시작할 수 없으므로 node_modules 루트의 점 항목은 전부 도구 상태 파일이다.
  for (const name of readdirSync(modules)) {
    if (name.startsWith('.')) remove(name)
  }
  // 3) OCR 경로 — 담지 않는다.
  for (const name of OCR_PACKAGES) remove(name)
  // 4) 다른 판 플랫폼 패키지(방어) — 있어야 할 판만 남긴다.
  for (const name of plan.foreignPackages) remove(name)
  // 5) kordoc dist 소스맵 — 디버깅용, 실행에 불필요.
  const dist = join(modules, 'kordoc', 'dist')
  if (existsSync(dist)) {
    for (const name of readdirSync(dist)) {
      if (name.endsWith('.map')) rmSync(join(dist, name), { force: true })
    }
  }
}

/**
 * 덩어리에 담을 파일 트리 — `node_modules/**` + `package.json` (+ 있으면 `pnpm-lock.yaml`).
 * 순회는 tar.mjs 의 collectTree 가 한다: 심볼릭 링크·특수 파일을 만나면 즉시 던지고,
 * 경로 바이트 오름차순으로 돌려준다(계약을 두 곳에서 따로 구현하지 않는다).
 */
export function collectBundle(workDir) {
  const keep = (path) => path === 'package.json' || path === 'pnpm-lock.yaml' || path.startsWith('node_modules/')
  return collectTree(workDir).filter((entry) => keep(entry.path))
}

// ------------------------------------------------------------------ 검사

const isOcrPath = (path) =>
  /^node_modules\/(onnxruntime|@huggingface)/.test(path) || /\/onnxruntime-(node|web)/.test(path)

/** 설치 폴더에 OCR 잔재가 있으면 던진다 — 조용히 담지 않는다. */
export function assertNoOcr(workDir) {
  const found = collectTree(workDir)
    .filter((entry) => isOcrPath(entry.path))
    .map((entry) => entry.path)
  if (found.length > 0) {
    throw new Error(`OCR 패키지가 남아 있다(제외 판이 아니다):\n  ${found.slice(0, 10).join('\n  ')}`)
  }
}

const memberBytes = (archive, name) => {
  const member = archive.find((entry) => entry.path === name)
  if (!member) throw new Error(`tgz 안에 없다: ${name}`)
  return member.data
}

/**
 * 만든 tgz 하나를 계약 전부에 대조한다. 앱이 받기 전에 여기서 잡아야 한다.
 * @returns {string[]} 문제 목록(비어 있으면 통과)
 */
export function verifyTarGz(buffer, target) {
  const plan = planTarget(target)
  const problems = []
  const archive = readTarGz(buffer)
  const names = new Set(archive.map((entry) => entry.path))
  const getPackageVersion = (name) => {
    const key = `node_modules/${name}/package.json`
    if (!names.has(key)) return null
    try {
      return JSON.parse(memberBytes(archive, key).toString('utf8')).version ?? null
    } catch {
      problems.push(`${target}: ${key} 를 읽을 수 없다`)
      return null
    }
  }

  // 1) kordoc 판 — 뜨는 대로 담으면 앱의 계약이 흔들린다.
  const kordocVersion = getPackageVersion('kordoc')
  if (kordocVersion === null) problems.push(`${target}: node_modules/kordoc/package.json 이 없다`)
  else if (kordocVersion !== KORDOC_VERSION) {
    problems.push(`${target}: kordoc 판이 다르다(${kordocVersion} != ${KORDOC_VERSION})`)
  }

  // 2) cli.js — 앱이 exe 로 띄우는 진입점. 판 고정 sha256 과 대조한다.
  const cliPath = 'node_modules/kordoc/dist/cli.js'
  if (!names.has(cliPath)) problems.push(`${target}: ${cliPath} 가 없다`)
  else {
    const digest = sha256Hex(memberBytes(archive, cliPath))
    if (digest !== CLI_SHA256) problems.push(`${target}: cli.js 해시가 계약과 다르다(${digest})`)
  }
  if (!names.has('node_modules/kordoc/dist/mcp.js')) problems.push(`${target}: dist/mcp.js 가 없다`)

  // 3) OCR 제외
  for (const path of names) if (isOcrPath(path)) problems.push(`${target}: OCR 패키지가 들어 있다 — ${path}`)

  // 4) 있어야 할 플랫폼 패키지 / 있으면 안 되는 플랫폼 패키지
  for (const [name, version] of Object.entries(plan.dependencies)) {
    if (!names.has(`node_modules/${name}/package.json`)) problems.push(`${target}: 필수 패키지가 없다 — ${name}`)
    else {
      const found = getPackageVersion(name)
      if (found !== null && found !== version) problems.push(`${target}: ${name} 판이 다르다(${found} != ${version})`)
    }
  }
  for (const name of plan.foreignPackages) {
    if (names.has(`node_modules/${name}/package.json`)) problems.push(`${target}: 다른 판 패키지가 섞였다 — ${name}`)
  }

  // 5) 규모 상한 — 실수로 OCR 판을 담았다면 여기서 걸린다(T3 실측 211.7 MB 상한).
  //    (링크·특수 파일은 readTarGz 가 던지므로 여기서 따로 세지 않는다.)
  const unpacked = archive.reduce((sum, entry) => sum + entry.size, 0)
  if (unpacked > 320 * 1024 * 1024) problems.push(`${target}: 풀린 크기가 상한을 넘는다(${unpacked} B)`)
  if (archive.length > 60000) problems.push(`${target}: 항목 수가 상한을 넘는다(${archive.length})`)

  return problems
}

// ------------------------------------------------------------------ 명세

export function targetRecord({ target, tgz, entries, cliSha256, mcpSha256, kordocVersion }) {
  const plan = planTarget(target)
  return {
    target,
    file: plan.file,
    bytes: tgz.length,
    sha256: sha256Hex(tgz),
    unpackedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    files: entries.filter((entry) => entry.type === 'file').length,
    packages: plan.dependencies,
    cli: { path: 'node_modules/kordoc/dist/cli.js', sha256: cliSha256 ?? CLI_SHA256 },
    kordocVersion: kordocVersion ?? KORDOC_VERSION,
    ...(mcpSha256 ? { mcp: { path: 'node_modules/kordoc/dist/mcp.js', sha256: mcpSha256 } } : {}),
  }
}

function toolingRecord({ env = process.env } = {}) {
  let pnpm = 'unknown'
  try {
    const spawn = pnpmSpawnPlan('pnpm', ['--version'], { env })
    const result = spawnSync(spawn.file, spawn.args, {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
      ...(spawn.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    if (result.status === 0) pnpm = (result.stdout || '').trim()
  } catch {
    // pnpm 이 PATH 에 없다 — 명세에는 unknown 으로 남기고 빌드는 계속한다(설치 단계가 먼저 실패한다).
  }
  return {
    node: process.version,
    zlib: process.versions.zlib ?? 'unknown',
    pnpm,
  }
}

/** 명세를 쓴다. 기존 명세가 있으면 이번에 안 만든 대상은 그대로 둔다(부분 빌드). */
export function writeManifest(outDir, records, { tooling = toolingRecord() } = {}) {
  const path = join(outDir, MANIFEST_NAME)
  let previous = {}
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      previous = {}
    }
  }
  const targets = { ...(previous.targets ?? {}) }
  for (const record of records) targets[record.target] = record
  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    kordocVersion: KORDOC_VERSION,
    ocr: false,
    cli: { path: 'node_modules/kordoc/dist/cli.js', sha256: CLI_SHA256 },
    mcp: { path: 'node_modules/kordoc/dist/mcp.js' },
    tooling,
    targets: Object.fromEntries(Object.keys(targets).sort().map((key) => [key, targets[key]])),
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

// ------------------------------------------------------------------ 빌드

function assertOwnWorkDir(workDir) {
  const name = basename(workDir)
  if (!name.startsWith('kordoc-bundle-')) {
    throw new Error(`작업 폴더는 kordoc-bundle- 로 시작해야 지운다(받은 값: ${name})`)
  }
}

/**
 * 한 대상: 빈 작업 폴더 → 설치 → 정리 → tgz → 검사.
 * 빈 폴더에서 시작하는 이유는 결정성이다(이전 설치 잔재가 섞이지 않게).
 */
export function buildTarget(target, { outDir, workRoot, storeDir, keepWork = false, force = false } = {}) {
  const plan = planTarget(target)
  const out = resolve(outDir ?? DEFAULT_OUT)
  const file = join(out, plan.file)
  if (existsSync(file) && !force) throw new Error(`이미 있다: ${file} (다시 만들려면 --force)`)

  const root = workRoot ?? tmpdir()
  mkdirSync(root, { recursive: true })
  const workDir = mkdtempSync(join(root, 'kordoc-bundle-'))
  assertOwnWorkDir(workDir)

  try {
    const install = installTarget(workDir, plan, { storeDir })
    pruneNodeModules(workDir, plan)
    assertNoOcr(workDir)

    const entries = collectBundle(workDir)
    const tgz = gzipDeterministic(packEntries(entries, (entry) => readFileSync(join(workDir, ...entry.path.split('/')))))
    const problems = verifyTarGz(tgz, target)
    if (problems.length > 0) throw new Error(`검사 실패\n${problems.map((p) => `  - ${p}`).join('\n')}`)

    const cliSha256 = sha256Hex(readFileSync(join(workDir, 'node_modules', 'kordoc', 'dist', 'cli.js')))
    const mcpPath = join(workDir, 'node_modules', 'kordoc', 'dist', 'mcp.js')
    const mcpSha256 = existsSync(mcpPath) ? sha256Hex(readFileSync(mcpPath)) : undefined
    const record = targetRecord({ target, tgz, entries, cliSha256, mcpSha256 })

    mkdirSync(out, { recursive: true })
    writeFileSync(file, tgz)
    // 명세에 실리는 것(record)과 사람이 보는 진단(workDir·ignoredBuilds)을 갈라 둔다 —
    // 작업 폴더 절대경로가 명세에 새면 기계마다 다른 파일이 되고, 개인 경로가 저장소에 남는다.
    return { record, workDir, ignoredBuilds: install.ignoredBuilds, recorded: entries.length }
  } finally {
    if (!keepWork) rmSync(workDir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const options = { targets: [], verify: false, keepWork: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 다음에 값이 필요하다`)
      i += 1
      return value
    }
    switch (arg) {
      case '--target':
        options.targets.push(...next().split(',').map((t) => t.trim()).filter(Boolean))
        break
      case '--out':
        options.out = resolve(next())
        break
      case '--work-root':
        options.workRoot = resolve(next())
        break
      case '--store-dir':
        options.storeDir = resolve(next())
        break
      case '--verify':
        options.verify = true
        break
      case '--keep-work':
        options.keepWork = true
        break
      case '--force':
        options.force = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`모르는 인자: ${arg}`)
    }
  }
  if (options.targets.length === 0) options.targets = Object.keys(TARGETS)
  for (const target of options.targets) planTarget(target)
  return options
}

const helpText = `kordoc 덩어리(OCR 뺀 판) 만들기

사용:
  node app/scripts/kordoc-bundle/bundle.mjs [--target <대상>[,<대상>]] [--out <폴더>]

옵션:
  --target   darwin-arm64 | darwin-x64 | win32-x64 (기본: 전부)
  --out      산출물 폴더 (기본: app/out/kordoc-bundle)
  --verify   새로 만들지 않고 기존 tgz 를 명세와 대조만 한다
  --force    같은 이름의 tgz 가 있어도 덮어쓴다
  --keep-work      임시 작업 폴더를 지우지 않는다(디버깅용)
  --work-root      임시 폴더 위치(기본: 시스템 임시 폴더)
  --store-dir      pnpm store 위치(기본: pnpm 기본값)`

function verifyExisting(outDir, targets) {
  const manifestPath = join(outDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) throw new Error(`명세가 없다: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const problems = []
  for (const target of targets) {
    const record = manifest.targets?.[target]
    if (!record) {
      problems.push(`${target}: 명세에 없다`)
      continue
    }
    const file = join(outDir, record.file ?? targetFileName(target))
    if (!existsSync(file)) {
      problems.push(`${target}: tgz 가 없다 — ${file}`)
      continue
    }
    const bytes = readFileSync(file)
    if (bytes.length !== record.bytes) problems.push(`${target}: 크기가 명세와 다르다`)
    if (sha256Hex(bytes) !== record.sha256) problems.push(`${target}: sha256 이 명세와 다르다`)
    problems.push(...verifyTarGz(bytes, target))
  }
  return problems
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(helpText)
    return 0
  }
  const outDir = options.out ?? DEFAULT_OUT
  if (options.verify) {
    const problems = verifyExisting(outDir, options.targets)
    if (problems.length > 0) {
      console.error(`검사 실패 ${problems.length}건`)
      for (const problem of problems) console.error(`  - ${problem}`)
      return 1
    }
    console.log(`검사 통과: ${options.targets.join(', ')} (${outDir})`)
    return 0
  }

  const records = []
  for (const target of options.targets) {
    const { record, ignoredBuilds, workDir, recorded } = buildTarget(target, {
      outDir,
      workRoot: options.workRoot,
      storeDir: options.storeDir,
      keepWork: options.keepWork,
      force: options.force,
    })
    records.push(record)
    const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1)
    console.log(`${target}: ${record.file} ${mib(record.bytes)} MiB / ${mib(record.unpackedBytes)} MB 풀림, ${record.files} 파일`)
    console.log(`  sha256 ${record.sha256}`)
    if (options.keepWork) console.log(`  작업 폴더: ${workDir} (${recorded} 항목 수집)`)
    if (ignoredBuilds) console.log('  (pnpm 이 빌드 스크립트 무시로 exit≠0 — 설치 자체는 끝났다)')
  }
  const manifest = writeManifest(outDir, records)
  console.log(`명세: ${join(outDir, MANIFEST_NAME)} (대상 ${Object.keys(manifest.targets).length})`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[kordoc-bundle] ${error.message}`)
    process.exitCode = 1
  }
}
