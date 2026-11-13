import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { coverageProblems, placementHints, readManifest, specFiles } from '../e2e-shards.mjs'

// 이 시험은 `.github/workflows/ci.yml` 의 e2e 샤딩 배선을 잠근다. 잠그는 이유는 조용한 실패다:
// 샤드를 늘리거나 아티팩트 이름을 고칠 때 (1) 묶음표 밖으로 새는 스펙, (2) 샤드끼리 겹치는 아티팩트
// 이름(v4 는 중복 이름을 거부해 작업이 죽는다), (3) 요약 다리가 `skipped`·`cancelled` 를 성공으로
// 세는 일 — 셋 다 초록으로 보이거나 필수 체크가 사라지는 식으로만 드러난다.
const workflowPath = resolve(import.meta.dirname, '../../../.github/workflows/ci.yml')
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n')
const lines = workflow.split('\n')

/** `jobs:` 아래 2칸 들여쓰기 키를 작업 경계로 보고 각 작업의 줄 범위를 돌려준다. */
function jobs() {
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line))
  assert.ok(start >= 0, 'ci.yml 에 jobs: 가 없다')
  const found = []
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^  ([A-Za-z_][\w-]*):\s*$/.exec(lines[i])
    if (!match) continue
    if (found.length) found[found.length - 1].end = i
    found.push({ name: match[1], start: i, end: lines.length })
  }
  return found.map(job => ({ ...job, body: lines.slice(job.start + 1, job.end) }))
}

const jobMap = new Map(jobs().map(job => [job.name, job]))
const must = name => {
  const job = jobMap.get(name)
  assert.ok(job, `ci.yml 에 ${name} 작업이 없다`)
  return job
}

test('필수 체크 이름은 요약 다리 두 개가 만든다', () => {
  const summary = must('app-summary')
  const summaryBody = summary.body.join('\n')
  // 이름 줄은 하나지만 matrix 가 두 OS 로 펼쳐져 `app (macos-latest)`·`app (windows-latest)` 두 체크가 된다.
  assert.match(summaryBody, /^\s*name:\s*app \(\$\{\{\s*matrix\.os\s*\}\}\)\s*$/m)
  const oses = summary.body.flatMap(line => /^\s*-\s*(macos-latest|windows-latest)\s*$/.exec(line)?.[1] ?? [])
  assert.deepEqual(oses.sort(), ['macos-latest', 'windows-latest'], '요약 다리는 맥·윈도 두 이름을 모두 만들어야 한다')
  // 다른 작업이 같은 이름을 만들면 필수 체크가 둘로 갈라진다.
  const nameLines = lines.filter(line => /^\s*name:\s*app \(\$\{\{\s*matrix\.os\s*\}\}\)\s*$/.test(line))
  assert.equal(nameLines.length, 1, '필수 체크 이름 줄은 요약 다리 한 곳에만 있어야 한다')
  // 샤드 작업은 자기 이름(4칸 들여쓰기 `name:`)을 따로 만들지 않는다 — 자동 이름
  // `app (windows-latest, 1)` 이면 충분하고, 단계 이름(10칸)은 상관없다.
  assert.doesNotMatch(must('app').body.join('\n'), /^ {4}name:/m)
})

test('요약 다리는 성공만 통과시킨다', () => {
  const summary = must('app-summary').body.join('\n')
  assert.match(summary, /^\s*needs:\s*app\s*$/m, '요약 다리는 app 작업 뒤에 돈다')
  assert.match(summary, /^\s*if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$/m, '문서만 바뀐 실행에서도 초록으로 남아야 한다')
})

test('shard 묶음 수는 OS 별로 shards.json 과 같다', () => {
  const manifest = readManifest()
  const app = must('app').body.join('\n')
  assert.match(app, /^\s*fail-fast:\s*false\s*$/m, '한 샤드가 죽어도 나머지 샤드는 끝까지 돌아야 원인을 한 번에 본다')
  const entries = [...app.matchAll(/^\s*-\s*os:\s*(\S+)\s*\n\s*shard:\s*(\d+)\s*$/gm)]
    .map(match => ({ os: match[1], shard: Number(match[2]) }))
  // matrix 에 OS 만 있는 줄(샤드 없이)이 섞이면 위 정규식이 조용히 건너뛴다 — 개수로 잡는다.
  assert.equal(entries.length, [...app.matchAll(/^\s*-\s*os:\s*\S+\s*$/gm)].length, 'matrix 항목은 모두 `- os:` + `shard:` 짝이어야 한다')
  for (const os of ['windows-latest', 'macos-latest']) {
    const shards = entries.filter(entry => entry.os === os)
    const expected = os === 'windows-latest' ? manifest.windows.length : manifest.macos.length
    assert.equal(shards.length, expected, `${os} 샤드 수가 묶음표와 다르다`)
    // 실행기가 1부터 세므로 샤드 번호는 1..N 이 빠짐없이 있어야 한다 — 5번을 지웠는데 4개로 남는 사고를 막는다.
    assert.deepEqual(shards.map(entry => entry.shard).sort((a, b) => a - b), Array.from({ length: expected }, (_, index) => index + 1), `${os} 샤드 번호가 1..${expected} 가 아니다`)
  }
  assert.equal(entries.length, manifest.windows.length + manifest.macos.length, `matrix 에 예상 밖 OS 가 있다: ${entries.map(entry => entry.os).join(', ')}`)
})

test('아티팩트 이름은 샤드마다 다르다', () => {
  const names = ['e2e-artifacts-macos', 'e2e-artifacts-windows', 'doctor-timings-windows', 'ui-shots-macos', 'ui-shots-windows']
  for (const base of names) {
    // GitHub 표현식은 그대로 비교해야 하므로 템플릿 보간 대신 이어붙인다.
    const suffix = '-${{ matrix.shard }}'
    const suffixed = lines.filter(line => line === `          name: ${base}${suffix}`)
    const bare = lines.filter(line => /^(?:\s*name:\s*)(.*)$/.exec(line)?.[1]?.trim() === base)
    assert.equal(suffixed.length, 1, `${base} 아티팩트에 샤드 접미사가 없다 — v4 는 중복 이름을 거부해 작업이 죽는다`)
    assert.equal(bare.length, 0, `${base} 아티팩트가 접미사 없이 남아 있다`)
  }
})

test('e2e 단계는 묶음표 실행기를 부른다', () => {
  const app = must('app').body.join('\n')
  assert.match(app, /- run: node scripts\/e2e-shards\.mjs --check\n\s+if: needs\.changes\.outputs\.docs_only != 'true'/, 'e2e 전에 묶음표 검사를 돈다')
  const step = /- name: e2e \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.shard \}\}\)\n([\s\S]*?)\n      - /.exec(app)
  assert.ok(step, 'e2e 단계를 찾지 못했다')
  assert.match(step[1], /run: node scripts\/e2e-shards\.mjs \$\{\{ runner\.os == 'Windows' && 'windows' \|\| 'macos' \}\} \$\{\{ matrix\.shard \}\}/)
  assert.match(step[1], /if: needs\.changes\.outputs\.docs_only != 'true'/)
  assert.match(step[1], /KNUAF_PYTHON:/)
  assert.match(step[1], /KNUAF_SHOT_DIR:/)
  // 예전 두 줄짜리 OS 분기 단계가 남아 있으면 샤드가 두 번 돈다.
  assert.doesNotMatch(app, /- name: e2e \(macOS\)|- name: e2e \(Windows\)/)
})

test('e2e 전에 Playwright 발견 대조를 OS 마다 한 번 돈다', () => {
  const app = must('app').body.join('\n')
  // `--check` 는 폴더만 본다 — `testIgnore` 로 조용히 빠지는 스펙은 발견 대조만 잡는다.
  assert.match(
    app,
    /- run: node scripts\/e2e-shards\.mjs --verify-discovery \$\{\{ runner\.os == 'Windows' && 'windows' \|\| 'macos' \}\}\n\s+if: needs\.changes\.outputs\.docs_only != 'true' && matrix\.shard == 1/,
    'OS 별 표가 다르므로 OS 마다 한 번(1번 샤드)만 돈다'
  )
  const checks = app.match(/--verify-discovery/g)?.length ?? 0
  assert.equal(checks, 1, `발견 대조가 ${checks}곳이다 — 다리마다 돌면 같은 검사가 7번이다`)
})

test('요약 다리는 저장소 내용을 읽지 않는다', () => {
  // 작업 목록 API 만 쓰므로 `contents` 를 주지 않는다 — 권한은 필요한 만큼만 준다.
  const body = must('app-summary').body.join('\n')
  const permissions = /\n    permissions:\n((?:      .*\n)+)/.exec(body)?.[1]
  assert.ok(permissions, '요약 다리에 permissions 블록이 없다')
  assert.match(permissions, /^      actions: read\s*$/m, '작업 목록 API 읽기 권한은 있어야 한다')
  assert.doesNotMatch(permissions, /contents:/, '저장소 내용을 읽지 않으므로 contents 권한을 주지 않는다')
})

test('묶음표는 e2e 실제 스펙을 정확히 덮는다', () => {
  const problems = coverageProblems(readManifest(), specFiles())
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('하위 폴더 스펙이 빠지면 폴더째 지목한다', () => {
  // 파일 이름만 보면 `e2e/sub/ok.spec.ts` 와 `e2e/other/ok.spec.ts` 를 구분하지 못한다 —
  // 키가 상대 경로여야 어느 쪽이 빠졌는지 알려 줄 수 있다.
  const dir = mkdtempSync(join(tmpdir(), 'e2e-nested-'))
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'ok.spec.ts'), '')
    const files = specFiles(dir)
    assert.deepEqual([...files.keys()], ['sub/ok'], '키는 `폴더/이름`(확장자 없음)이다')
    assert.deepEqual([...files.values()], [`e2e/sub/ok.spec.ts`], '실행 경로는 `e2e` 기준이다')
    const hints = placementHints({ windows: [[]], macos: [[]] }, files)
    assert.ok(hints.some(hint => hint.startsWith('- sub/ok:')), `폴더째 지목해야 한다: ${hints.join('\n')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('실제 Playwright CLI: 통과 0 · 실패 비 0 · 긴 출력 · 승격된 패키지 import', () => {
  // 이 시험이 잠그는 사고는 셋이다. (1) `cli.js <경로>` 는 `test` 하위 명령이 없어 `unknown command`
  // 로 죽는다(스펙을 하나도 안 돌리고 초록처럼 보였다). (2) `spawnSync` 의 `maxBuffer` 를 넘기면
  // 통과한 시험도 죽는다. (3) `pnpm exec` 셔틀이 넣어 주던 `NODE_PATH` 가 없으면, package.json 에
  // 선언하지 않고 `.pnpm/node_modules` 에만 있는 패키지(`jszip`)를 import 하는 스펙이 죽는다.
  const appDir = resolve(import.meta.dirname, '../..')
  const dir = mkdtempSync(join(tmpdir(), 'e2e-cli-'))
  try {
    symlinkSync(join(appDir, 'node_modules'), join(dir, 'node_modules'), 'junction')
    writeFileSync(join(dir, 'playwright.config.mjs'), 'export default { testDir: "e2e", workers: 1, reporter: "list" }\n')
    mkdirSync(join(dir, 'e2e', 'sub'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    copyFileSync(join(appDir, 'scripts', 'e2e-shards.mjs'), join(dir, 'scripts', 'e2e-shards.mjs'))

    const spec = (body, name) => writeFileSync(join(dir, 'e2e', 'sub', name), body)
    spec('import { test, expect } from "@playwright/test"\nimport JSZip from "jszip"\ntest("hoisted", () => { expect(typeof JSZip).toBe("function") })\n', 'pass.spec.ts')
    spec('import { test, expect } from "@playwright/test"\ntest("loud", () => { process.stdout.write("x".repeat(2 * 1024 * 1024)); expect(1).toBe(1) })\n', 'loud.spec.ts')
    spec('import { test, expect } from "@playwright/test"\ntest("bad", () => { expect(1).toBe(2) })\n', 'bad.spec.ts')

    // 앱의 출력을 파이프로 받지 않는다(`stdio: 'inherit'`) — 실행기가 하는 것과 같게 둬서
    // 2 MiB 를 뿜는 시험이 `maxBuffer` 로 죽지 않는지까지 이 시험이 본다. 대신 요약은 파일로 받는다.
    const log = join(dir, 'run.log')
    const shard = (names, os = 'windows') => {
      writeFileSync(join(dir, 'e2e', 'shards.json'), JSON.stringify({ windows: [names], macos: [names] }))
      const fd = openSync(log, 'w')
      try {
        const result = spawnSync(process.execPath, ['scripts/e2e-shards.mjs', os, '1'], {
          cwd: dir,
          stdio: ['ignore', fd, fd],
          env: { ...process.env, NODE_PATH: '', TMPDIR: dir },
        })
        assert.equal(result.error, undefined, `실행기 자체가 죽었다: ${result.error?.message}`)
        return { status: result.status, output: readFileSync(log, 'utf8') }
      } finally {
        closeSync(fd)
      }
    }

    const ok = shard(['sub/pass', 'sub/loud'])
    assert.equal(ok.status, 0, `통과 묶음이 0 이어야 한다: ${ok.output}`)
    assert.match(ok.output, /2 tests in 2 files/, `시험 수 요약을 남긴다: ${ok.output}`)
    assert.match(ok.output, /통과 2/, 'JSON 리포터 통계로 센다')

    const bad = shard(['sub/pass', 'sub/bad'])
    assert.notEqual(bad.status, 0, `실패 묶음은 0 이 아니어야 한다: ${bad.output}`)
    assert.match(bad.output, /실패 1/, '실패 수를 요약에 남긴다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('발견 대조는 시험이 하나도 안 도는 샤드를 잡는다', () => {
  // `--check` 는 파일만 보므로 `testIgnore` 로 조용히 빠지는 스펙을 못 잡는다 — 발견 대조가 그 구멍을 막는다.
  // `testIgnore` 에 걸린 파일을 경로로 직접 넘기면 Playwright 는 조용히 0개를 내놓는다(오류가 아니다).
  const appDir = resolve(import.meta.dirname, '../..')
  const dir = mkdtempSync(join(tmpdir(), 'e2e-discovery-'))
  try {
    symlinkSync(join(appDir, 'node_modules'), join(dir, 'node_modules'), 'junction')
    writeFileSync(
      join(dir, 'playwright.config.mjs'),
      'export default { testDir: "e2e", workers: 1, testIgnore: ["**/ignored.spec.ts"] }\n'
    )
    mkdirSync(join(dir, 'e2e'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    copyFileSync(join(appDir, 'scripts', 'e2e-shards.mjs'), join(dir, 'scripts', 'e2e-shards.mjs'))
    writeFileSync(join(dir, 'e2e', 'ok.spec.ts'), 'import { test } from "@playwright/test"\ntest("ok", () => {})\n')
    writeFileSync(join(dir, 'e2e', 'ignored.spec.ts'), 'import { test } from "@playwright/test"\ntest("ignored", () => {})\n')
    writeFileSync(join(dir, 'e2e', 'shards.json'), JSON.stringify({ windows: [['ok'], ['ignored']], macos: [['ok'], ['ignored']] }))

    const result = spawnSync(process.execPath, ['scripts/e2e-shards.mjs', '--verify-discovery', 'windows'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '', TMPDIR: dir },
    })
    assert.equal(result.status, 1, `시험이 하나도 안 도는 샤드가 있으면 실패해야 한다: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /windows: 2번 샤드가 시험을 하나도 안 돈다 — ignored/, result.stderr)
    assert.doesNotMatch(result.stdout, /Playwright 2 개/, 'ignored 스펙은 발견에도 안 들어간다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('빠진 스펙은 가장 가벼운 묶음을 지목해 준다', () => {
  const manifest = readManifest()
  // release/v0.6.x 가 새 스펙을 들여올 때와 같은 상태를 인위적으로 만든다: 파일만 있고 묶음표엔 없다.
  const files = specFiles()
  const removed = manifest.windows[0].pop()
  try {
    const hints = placementHints(manifest, files)
    const line = hints.find(hint => hint.startsWith(`- ${removed}:`))
    assert.ok(line, `${removed} 를 넣을 곳을 알려 주지 않는다: ${hints.join('\n')}`)
    assert.match(line, /windows \d+번\(\d+개\)/, 'windows 쪽 가장 가벼운 묶음을 지목한다')
    assert.doesNotMatch(line, /macos \d+번/, 'windows 에서만 빠졌으면 macos 는 지목하지 않는다')
  } finally {
    manifest.windows[0].push(removed)
  }
})

test('지목한 묶음은 실제로 그 OS 에서 가장 파일 수가 적다', () => {
  const manifest = readManifest()
  const removed = manifest.windows[1].pop()
  try {
    const line = placementHints(manifest, specFiles()).find(hint => hint.startsWith(`- ${removed}:`))
    const [, shard, count] = /windows (\d+)번\((\d+)개\)/.exec(line)
    const sizes = manifest.windows.map(shard => shard.length)
    assert.equal(Number(count), Math.min(...sizes), '안내한 파일 수가 최소가 아니다')
    assert.equal(Number(shard), sizes.indexOf(Math.min(...sizes)) + 1, '안내한 샤드 번호가 최소 묶음이 아니다')
  } finally {
    manifest.windows[1].push(removed)
  }
})

test('묶음표에만 있는 이름은 지우라고 알려 준다', () => {
  const manifest = readManifest()
  manifest.macos[0].push('ghost-spec')
  try {
    const hints = placementHints(manifest, specFiles())
    assert.ok(hints.some(hint => hint.includes('ghost-spec (macos)') && hint.includes('지운다')), hints.join('\n'))
    assert.ok(!hints.some(hint => hint.startsWith('- ghost-spec:') && hint.includes('에 넣는다')), '넣으라고 하면 안 된다')
  } finally {
    manifest.macos[0].pop()
  }
})

test('요약 다리의 셸 판정: success 만 exit 0', () => {
  const summary = must('app-summary').body
  const start = summary.findIndex(line => /^\s*run:\s*\|\s*$/.test(line))
  assert.ok(start >= 0, '요약 다리에 run 블록이 없다')
  const indent = /^(\s*)/.exec(summary[start])[1].length
  const block = []
  for (let i = start + 1; i < summary.length; i++) {
    const line = summary[i]
    if (line.trim() && /^\s*/.exec(line)[0].length <= indent) break
    block.push(line.slice(Math.min(indent + 2, line.length)))
  }
  const script = block.join('\n')
  const fallback = '샤드별 결과는 위 작업 목록 참조'
  assert.ok(script.includes(fallback), '실패한 다리를 못 얻었을 때 한 줄 이유를 남긴다')
  assert.match(script, /exit 1/, '성공이 아니면 작업을 실패로 끝낸다')
  // 판정 기준은 두 OS 샤드를 모두 접은 `needs.app.result` 라 어느 OS 가 깨져도 두 요약이 함께
  // 빨개진다 — 그래서 실패 목록은 OS 로 가르지 않고 샤드 다리 전부를 보여 준다.
  assert.ok(script.includes('test("^app \\\\(.+, [0-9]+\\\\)$")'), '실패 목록은 `app (<os>, <샤드>)` 다리를 거른다')

  const dir = mkdtempSync(join(tmpdir(), 'ci-sharding-'))
  try {
    const stub = (exitCode, output) => {
      const path = join(dir, `gh-${exitCode}-${output.length}`)
      writeFileSync(path, `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`)
      chmodSync(path, 0o755)
      return path
    }
    const run = (value, gh) => {
      // GitHub 표현식은 이 시험에서 대체한다 — 셸 판정 로직만 본다.
      const file = join(dir, `step-${value}.sh`)
      writeFileSync(file, script.replace(/\$\{\{[^}]*\}\}/g, 'x'))
      const path = join(dir, 'bin')
      return spawnSync('bash', ['-e', file], {
        encoding: 'utf8',
        // `:` 로 잇지 않는다 — 경로 구분자는 플랫폼마다 다르다(`;` 는 Windows).
        env: {
          ...process.env,
          PATH: [path, process.env.PATH].filter(Boolean).join(delimiter),
          NEEDS_RESULT: value,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_RUN_ID: '1',
          GH_TOKEN: 't',
        },
      })
    }
    const withGh = (exitCode, output) => {
      const path = join(dir, 'bin')
      rmSync(path, { recursive: true, force: true })
      mkdirSync(path, { recursive: true })
      const target = stub(exitCode, output)
      copyFileSync(target, join(path, 'gh'))
    }

    withGh(0, '실패한 다리: app (windows-latest, 3) — failure')
    const ok = run('success', 'ok')
    assert.equal(ok.status, 0, `success 는 통과해야 한다: ${ok.stdout}${ok.stderr}`)

    for (const value of ['failure', 'cancelled', 'skipped']) {
      withGh(0, '실패한 다리: app (windows-latest, 3) — failure')
      const bad = run(value, 'gh ok')
      assert.equal(bad.status, 1, `${value} 를 성공으로 세면 필수 체크가 거짓 초록이 된다`)
      assert.match(bad.stdout, /실패한 다리: app \(windows-latest, 3\)/, `${value} 때 어느 다리가 깨졌는지 남긴다`)

      // gh 가 죽어도(권한·API 실패) 판정은 유지되고, 대신 한 줄 이유를 남긴다.
      withGh(1, '')
      const blind = run(value, 'gh fail')
      assert.equal(blind.status, 1, `${value} 판정은 gh 실패와 무관하다`)
      assert.match(blind.stdout, new RegExp(fallback), '실패한 다리 목록을 못 얻으면 한 줄 이유를 남긴다')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
