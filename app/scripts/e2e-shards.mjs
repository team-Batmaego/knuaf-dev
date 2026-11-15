// e2e 샤드 실행기 — `e2e/shards.json` 의 묶음표대로 Playwright 를 띄운다.
//
// 왜 `playwright test --shard N/M` 을 쓰지 않는가: Playwright 는 시험 *개수*로 연속 분할하고
// 소요 시간은 보지 않는다. 실측 로그(run 43029013785)로 시뮬레이션하면 4샤드의 최대 샤드가
// 74분으로 3샤드(58분)보다 느려진다 — `in-app-preview`·`workspace` 처럼 시험당 3~5배 비싼
// 파일이 개수로는 안 보이기 때문이다. 그래서 파일 묶음을 저장소에 고정하고, 이 스크립트가
// 자기 묶음의 스펙 경로만 넘긴다(셸별 인자 분할·Windows `pnpm.cmd` 문제도 함께 피한다).
//
// 사용:
//   node scripts/e2e-shards.mjs windows 3     # windows 3번 샤드 실행
//   node scripts/e2e-shards.mjs macos 1
//   node scripts/e2e-shards.mjs --check       # 묶음표가 e2e 실제 파일과 맞는지 검사(CI 단계)
//   node scripts/e2e-shards.mjs --verify-discovery windows
//                                             # Playwright 가 실제로 찾는 스펙과 묶음표를 대조(CI 단계)
//
// 묶음표를 다시 만드는 법: CI 로그의 list 리포터 줄
//   `ok 12 e2e/foo.spec.ts:4:5 › 이름 (1.2m)` / `✓ … (1.2m)`
// 에서 파일별 시간을 합산해 LPT(긴 것부터 가장 한가한 샤드에)로 나눈다. `--check` 는 *누락*만
// 잡고 *균형*은 잡지 않는다(의도) — 편차가 커지면 위 방법으로 표만 다시 만든다.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// 설정(config) 쪽 제외 목록과 같은 뜻이다: `live-*` 는 실제 로그인·구독 사용량이 필요하고,
// `window-shots` 는 맥 전용 화면 촬영이며, `qa*`/`review` 캡처는 환경변수로만 켠다.
// (config 의 `testIgnore` 는 `live-*`·`window-shots` 만 빼고 나머지는 스펙 안에서 skip 한다.)
export const EXCLUDED = name =>
  name.startsWith('live-') || ['window-shots', 'qa-shots', 'qa2-shots', 'review-shots'].includes(name)

const MANIFEST = join(import.meta.dirname, '..', 'e2e', 'shards.json')
const E2E_DIR = join(import.meta.dirname, '..', 'e2e')

/**
 * `e2e` 아래 스펙의 **상대 경로에서 확장자를 뗀 이름**(`sub/foo`) → 실행에 넘길 경로(`e2e/sub/foo.spec.ts`).
 *
 * 이름이 아니라 상대 경로를 키로 쓰는 이유는 하위 폴더다: `e2e/a/ok.spec.ts` 와 `e2e/b/ok.spec.ts` 는
 * 파일 이름이 같아 이름만으로는 구분할 수 없다. 확장자를 떼는 이유는 묶음표가 그동안 이름(확장자 없음)을
 * 적어 왔기 때문이다 — 기존 표를 그대로 두고 하위 폴더만 `폴더/이름` 으로 적으면 된다.
 */
export function specFiles(dir = E2E_DIR) {
  const files = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const match = /^(.+)\.spec\.tsx?$/.exec(entry.name)
    if (!match) continue
    // `parentPath`(구 Node 는 `path`)는 넘긴 `dir` 문자열 그대로의 접두사를 갖는다 — 상대 경로만 뽑는다.
    const parent = entry.parentPath ?? entry.path ?? dir
    const rel = [relative(dir, parent).split(sep).join('/'), entry.name].filter(Boolean).join('/')
    const key = rel.replace(/\.spec\.tsx?$/, '')
    if (files.has(key)) throw new Error(`스펙 이름이 겹친다: ${key}`)
    files.set(key, `e2e/${rel}`)
  }
  return files
}

export function runnableSpecs(files = specFiles()) {
  // 키가 상대 경로라 제외 판정은 파일 이름으로 한다(`sub/live-x.spec.ts` 도 제외).
  return new Set([...files.keys()].filter(name => !EXCLUDED(name.slice(name.lastIndexOf('/') + 1))))
}

export function readManifest(path = MANIFEST) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const keys = Object.keys(manifest)
  if (keys.length !== 2 || !manifest.windows || !manifest.macos) {
    throw new Error(`묶음표는 windows·macos 두 키만 가져야 한다: ${keys.join(', ')}`)
  }
  for (const os of ['windows', 'macos']) {
    const shards = manifest[os]
    if (!Array.isArray(shards) || !shards.length) throw new Error(`${os} 샤드 목록이 비어 있다`)
    for (const shard of shards) {
      if (!Array.isArray(shard) || !shard.length) throw new Error(`${os} 에 빈 샤드가 있다`)
      for (const name of shard) {
        if (typeof name !== 'string' || !name) throw new Error(`${os} 에 잘못된 스펙 이름: ${JSON.stringify(name)}`)
      }
    }
  }
  return manifest
}

/** 묶음표가 돌려야 할 스펙을 정확히 한 번씩 담고 있는지 확인한다. 문제 목록을 돌려준다. */
export function coverageProblems(manifest, files = specFiles()) {
  const runnable = runnableSpecs(files)
  const problems = []
  for (const os of ['windows', 'macos']) {
    const names = manifest[os].flat()
    const seen = new Set()
    for (const name of names) {
      if (seen.has(name)) problems.push(`${os}: 중복 — ${name}`)
      seen.add(name)
    }
    for (const name of runnable) if (!seen.has(name)) problems.push(`${os}: 빠짐 — ${name}`)
    for (const name of seen) if (!runnable.has(name)) problems.push(`${os}: 돌 수 없는 스펙 — ${name}`)
  }
  return problems
}

/**
 * 검사에서 걸린 스펙을 어디에 넣으면 되는지 바로 고칠 수 있게 문장으로 만든다.
 *
 * 무게(시험 소요 시간)는 저장소에 없다 — 새 스펙은 아직 잰 값이 없으므로 지금 **파일 수**가
 * 가장 적은 묶음을 고른다. 파일 수는 무게의 대리 지표일 뿐이라(현재 30/18/16/28/30 처럼 개수와
 * 시간이 1:1 이 아니다) 무거운 스펙(helpers 를 쓰는 Electron 시험)이면 사람이 한 번 더 본다.
 * 그래도 "어느 묶음이 가장 한가한가"를 매번 손으로 세지 않게 하는 것이 목적이다.
 */
export function placementHints(manifest, files = specFiles()) {
  const runnable = runnableSpecs(files)
  // 묶음표에 한 번도 안 나온 스펙 = 새로 추가된 스펙. 넣을 곳이 없으니 가장 가벼운 묶음부터 채운다.
  const placed = { windows: new Set(manifest.windows.flat()), macos: new Set(manifest.macos.flat()) }
  const missing = [...runnable].filter(name => !placed.windows.has(name) || !placed.macos.has(name)).sort()
  const sizes = { windows: manifest.windows.map(s => s.length), macos: manifest.macos.map(s => s.length) }
  const hints = []
  for (const name of missing) {
    const picks = []
    for (const os of ['windows', 'macos']) {
      if (placed[os].has(name)) continue
      // 안내문은 "지금 가장 가벼운 묶음"이라고 말하므로 **넣기 전** 개수를 적는다.
      // 다만 같은 실행 안에서 앞 스펙을 이미 배정했으면 그 무게를 반영한다(둘 다 3번을 가리키지 않게).
      const best = sizes[os].indexOf(Math.min(...sizes[os]))
      picks.push(`${os} ${best + 1}번(${sizes[os][best]}개)`)
      sizes[os][best] += 1
    }
    hints.push(`- ${name}: ${picks.join(' · ')} 에 넣는다 — 지금 파일 수가 가장 적은 묶음`)
  }
  // 같은 묶음 안 중복은 조용히 두 번 돌기만 하므로 지목해서 알려 준다.
  for (const os of ['windows', 'macos']) {
    const seen = new Set(), dup = new Set()
    for (const name of manifest[os].flat()) (seen.has(name) ? dup : seen).add(name)
    for (const name of [...dup].sort()) hints.push(`- ${name}: ${os} 묶음표에 두 번 이상 있다 — 한 번만 남긴다`)
  }
  // 반대 방향(묶음표에는 있는데 e2e 에 없는 이름)은 넣을 곳이 아니라 지울 곳을 알려 준다.
  const stale = new Set()
  for (const os of ['windows', 'macos']) {
    for (const name of manifest[os].flat()) if (!runnable.has(name)) stale.add(`${name} (${os})`)
  }
  for (const name of [...stale].sort()) hints.push(`- ${name}: 묶음표에서 지운다 — e2e 에 없는 이름이거나 실행 제외 대상`)
  return hints
}

function check() {
  const manifest = readManifest()
  const files = specFiles()
  const problems = coverageProblems(manifest, files)
  for (const os of ['windows', 'macos']) {
    const shards = manifest[os]
    const counts = shards.map(shard => shard.length).join(' / ')
    console.log(`${problems.some(p => p.startsWith(os)) ? 'FAIL' : 'ok  '} ${os}: ${shards.flat().length} files in ${shards.length} shards (${counts})`)
  }
  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`)
    for (const hint of placementHints(manifest, files)) console.error(hint)
    console.error('e2e 묶음표가 e2e 실제 스펙과 맞지 않는다 — 위 줄대로 고치고 --check 를 다시 돌린다.')
    return 1
  }
  console.log('e2e 묶음표 검사 통과')
  return 0
}

function playwrightCli() {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('playwright/package.json')
  return join(dirname(manifestPath), 'cli.js')
}

const APP_DIR = resolve(import.meta.dirname, '..')

/**
 * `NODE_PATH` 는 pnpm 셔틀(`pnpm exec`)이 넣어 주던 값을 그대로 재현한다.
 * 선언하지 않은 패키지도 `.pnpm/node_modules` 에는 있기 때문이다 — `e2e/docx-zip.spec.ts` 의 `jszip` 이
 * 그렇다. 이 한 줄이 없으면 `Cannot find module 'jszip'` 으로 그 스펙만 죽는다.
 */
function nodePath() {
  const hoisted = join(APP_DIR, 'node_modules', '.pnpm', 'node_modules')
  return [hoisted, process.env.NODE_PATH].filter(Boolean).join(delimiter)
}

function playwrightEnv(extra = {}) {
  return { ...process.env, NODE_PATH: nodePath(), ...extra }
}

function osKey(os) {
  const key = String(os).toLowerCase()
  if (key !== 'windows' && key !== 'macos') throw new Error(`OS 는 windows 또는 macos 다: ${os}`)
  return key
}

/** list 모드 JSON 에서 스펙 id → `파일 › 제목`. 스펙은 파일 스위트 아래 describe 스위트에 중첩된다. */
function specIds(report) {
  const ids = new Map()
  const walk = suite => {
    for (const spec of suite.specs ?? []) {
      if (spec.id) ids.set(spec.id, `${spec.file ?? suite.file ?? '?'} › ${spec.title}`)
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return ids
}

function listSpecs(outputFile, paths) {
  const child = spawnSync(
    process.execPath,
    [playwrightCli(), 'test', ...paths, '--list', '--grep-invert', 'real window capture', '--reporter=json'],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: playwrightEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile }),
      cwd: APP_DIR,
    }
  )
  if (child.error) throw child.error
  if (!existsSync(outputFile)) throw new Error(`Playwright --list 가 결과 파일을 남기지 않았다 (exit ${child.status})`)
  // 시험이 0개면 `--list` 가 "No tests found." 로 exit 1 을 낸다 — 그건 오류가 아니라 보고할 사실이다
  // (샤드가 `testIgnore` 에 걸렸거나 파일에 `test()` 가 없다). 리포트가 있으면 그걸 읽는다.
  const report = JSON.parse(readFileSync(outputFile, 'utf8'))
  // 시험이 0개면 `--list` 가 이 문구를 `errors` 에 넣고 exit 1 을 낸다 — 오류가 아니라 "0개"라는 사실이다
  // (샤드가 `testIgnore` 에 걸렸거나 파일에 `test()` 가 없다). 그 밖의 오류는 그대로 올린다.
  const fatal = (report.errors ?? []).filter(error => !/^Error: No tests found\./.test(error.message ?? ''))
  if (fatal.length) {
    for (const error of fatal) console.error(`e2e 발견 오류: ${error.message ?? JSON.stringify(error)}`)
    throw new Error('Playwright 가 스펙을 나열하다 오류를 냈다(위 줄)')
  }
  return specIds(report)
}

/**
 * Playwright 가 실제로 찾는 스펙과 묶음표를 대조한다.
 *
 * `--check` 는 폴더만 훑으므로 `testIgnore`·설정 오류처럼 "파일은 있는데 안 도는" 경우를 못 본다.
 * 여기서는 Playwright 자신에게 물어본 목록을 쓴다. 비교 키는 `spec.id` 다(실행 사이에 안정적이고,
 * list 모드에도 있다). 캡처(`qa*`/`review-shots`)는 파일은 있지만 묶음표에서 빼는 대상이므로
 * 발견 목록에서도 뺀다 — 아니면 "어느 샤드도 안 돈다"가 정상인데 실패로 뜬다.
 */
function verifyDiscovery(os) {
  const key = osKey(os)
  const manifest = readManifest()
  const files = specFiles()
  const dir = mkdtempSync(join(tmpdir(), 'e2e-discovery-'))
  try {
    const discovered = new Map(
      [...listSpecs(join(dir, 'all.json'), [])].filter(([, label]) => {
        const file = label.slice(0, label.lastIndexOf(' › '))
        return !EXCLUDED(file.slice(file.lastIndexOf('/') + 1).replace(/\.spec\.tsx?$/, ''))
      })
    )
    const union = new Map()
    const problems = []
    for (const [index, shard] of manifest[key].entries()) {
      const number = index + 1
      const missing = shard.filter(name => !files.has(name))
      if (missing.length) throw new Error(`${key} ${number}번 샤드에 e2e 에 없는 이름이 있다: ${missing.join(', ')}`)
      const specs = listSpecs(join(dir, `shard-${number}.json`), shard.map(name => files.get(name)))
      // 파일은 있는데 Playwright 가 시험을 하나도 안 내놓는 경우 — `testIgnore` 에 걸렸거나 파일에
      // `test()` 가 없다. `--check` 는 통과시키고 e2e 도 초록이지만 그 스펙은 영원히 안 돈다.
      if (!specs.size) problems.push(`${key}: ${number}번 샤드가 시험을 하나도 안 돈다 — ${shard.join(', ')}`)
      for (const [id, label] of specs) {
        const seen = union.get(id)
        if (seen) problems.push(`${key}: 두 샤드가 같은 스펙을 돈다 — ${label} (${seen.number}번 · ${number}번)`)
        else union.set(id, { number, label })
      }
    }
    for (const [id, label] of discovered) if (!union.has(id)) problems.push(`${key}: 어느 샤드도 돌지 않는다 — ${label}`)
    // 반대 방향(묶음표에 있는데 발견에 없다)은 따로 검사하지 않는다: 묶음표 쪽 목록도 같은
    // `--list` 에서 나오므로 구조적으로 발견의 부분집합이다. 그 경우는 위의 "0개 샤드"가 잡는다.

    console.log(`e2e 발견 대조 ${key}: Playwright ${discovered.size} 개 · 묶음표 ${union.size} 개`)
    if (problems.length) {
      for (const problem of problems) console.error(`- ${problem}`)
      console.error('e2e 묶음표가 Playwright 의 실제 발견과 다르다 — 위 줄대로 고치고 --verify-discovery 를 다시 돌린다.')
      return 1
    }
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function run(os, shardArg) {
  const manifest = readManifest()
  const key = osKey(os)
  const shard = Number(shardArg)
  const shards = manifest[key]
  if (!Number.isInteger(shard) || shard < 1 || shard > shards.length) {
    throw new Error(`${key} 샤드는 1..${shards.length} 이다: ${shardArg}`)
  }

  const files = specFiles()
  const names = shards[shard - 1]
  const missing = names.filter(name => !files.has(name))
  if (missing.length) throw new Error(`묶음표에 없는 스펙(e2e 에서 사라졌다): ${missing.join(', ')}`)
  const paths = names.map(name => files.get(name))

  // `test` 하위 명령을 명시한다 — `cli.js <경로>` 는 `unknown command` 로 죽는다.
  // stdio 는 그대로 물려준다: 출력이 길어도 파이프 버퍼(`maxBuffer`)에 걸리지 않는다.
  const summaryFile = join(APP_DIR, 'test-results', `e2e-shard-${key}-${shard}.json`)
  console.log(`e2e shard ${key}/${shard}: ${paths.length} files`)
  const child = spawn(
    process.execPath,
    [
      playwrightCli(),
      'test',
      ...paths,
      '--grep-invert',
      'real window capture',
      '--output',
      'test-results/e2e-artifacts',
      '--reporter=list,json',
    ],
    { stdio: 'inherit', env: playwrightEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: summaryFile }), cwd: APP_DIR }
  )
  const status = await new Promise(resolveStatus => {
    // `error` 만 나고 `exit` 이 없는 경우(실행 자체 실패)에도 멈추지 않게 둘 다 받는다.
    child.once('error', error => {
      console.error(error)
      resolveStatus(1)
    })
    child.once('exit', (code, signal) => resolveStatus(signal ? 1 : (code ?? 1)))
  })

  let stats = null
  let reporterProblems = 0
  try {
    const report = JSON.parse(readFileSync(summaryFile, 'utf8'))
    stats = report.stats ?? null
    if (report.errors?.length) {
      reporterProblems = report.errors.length
      for (const error of report.errors) console.error(`e2e 리포터 오류: ${error.message ?? JSON.stringify(error)}`)
    }
  } catch (error) {
    console.error(`시험 수 요약을 읽지 못했다(리포터 JSON 형식 변경 여부 확인): ${error.message}`)
  } finally {
    // 요약 파일은 지운다 — 다음 실행이 옛 숫자를 읽지 않게.
    try {
      unlinkSync(summaryFile)
    } catch {}
  }

  if (stats) {
    const total = (stats.expected ?? 0) + (stats.skipped ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0)
    const seconds = Math.round((stats.duration ?? 0) / 1000)
    console.log(
      `e2e shard ${key}/${shard} 결과: ${total} tests in ${paths.length} files ` +
        `(통과 ${stats.expected ?? 0}, 실패 ${stats.unexpected ?? 0}, 건너뜀 ${stats.skipped ?? 0}, ` +
        `불안정 ${stats.flaky ?? 0}, ${seconds}s)`
    )
  }
  return reporterProblems ? 1 : status
}

// 시험 파일이 이 모듈의 함수를 가져다 쓸 때는 CLI 를 띄우지 않는다 — 직접 실행할 때만 돈다.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
const [command, second] = invokedDirectly ? process.argv.slice(2) : []
try {
  if (command === '--check' || command === '-c') process.exitCode = check()
  else if (command === '--verify-discovery') process.exitCode = verifyDiscovery(second)
  else if (command) process.exitCode = await run(command, second)
  else if (invokedDirectly) {
    console.error('사용: node scripts/e2e-shards.mjs <windows|macos> <샤드번호> | --check | --verify-discovery <windows|macos>')
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
