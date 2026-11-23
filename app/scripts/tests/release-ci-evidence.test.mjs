// 태그 배포가 '이미 시험 통과한 커밋'을 건너뛰는 판정을 잠근다. 잠그는 이유는 조용한 실패다:
// 근거 판정이 헐거워지면 시험 안 한 커밋이 설치본이 되고(초록으로만 보인다), 너무 빡빡해지면
// 매번 예전처럼 2시간 넘게 중복 시험을 돌린다. 그래서 두 방향을 모두 시험한다 —
// 건너뛸 수 있는 실행은 건너뛰고, 조금이라도 어긋난 실행은 전부 돌린다(fail-closed).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  findEvidence, judgeJobs, parseAcceptReruns, publish, readShardCounts, renderSummary, writeOutputs
} from '../release-ci-evidence.mjs'

const SHA = 'a'.repeat(40)

const PYTEST = { name: 'Prepare pinned runtime and run tests', conclusion: 'success' }

/** ci.yml 의 초록 실행 하나 — 양 OS 샤드 + tests + 잡일을 흉내 낸다. 단계까지 채운다. */
function greenJobs(overrides = {}) {
  let id = 0
  const jobs = [
    { id: ++id, name: 'changes', conclusion: 'success', steps: [] },
    { id: ++id, name: 'lint', conclusion: 'success', steps: [] },
    { id: ++id, name: 'py39-guard', conclusion: 'success', steps: [] }
  ]
  for (const os of ['macos-latest', 'windows-latest']) {
    jobs.push({ id: ++id, name: `tests (${os}, 3.13)`, conclusion: 'success', steps: [PYTEST] })
    jobs.push({ id: ++id, name: `tests (${os}, 3.10)`, conclusion: 'success', steps: [PYTEST] })
    jobs.push({ id: ++id, name: `app (${os})`, conclusion: 'success', steps: [] })
  }
  for (const [os, count] of Object.entries({ windows: 5, macos: 2 })) {
    for (let shard = 1; shard <= count; shard++) {
      const steps = [{ name: `e2e (${os}-latest, ${shard})`, conclusion: 'success' }]
      // 태그 경로가 요구하는 빌드 단계: 맥 verify 는 typecheck·build, 윈도 e2e-windows 는 build.
      if (os === 'macos') steps.push({ name: 'pnpm typecheck', conclusion: 'success' })
      steps.push({ name: 'pnpm build', conclusion: 'success' })
      jobs.push({ id: ++id, name: `app (${os}-latest, ${shard})`, conclusion: 'success', steps })
    }
  }
  for (const [name, conclusion] of Object.entries(overrides)) {
    const job = jobs.find(candidate => candidate.name === name)
    if (job) job.conclusion = conclusion
  }
  return jobs
}

/** 한 작업의 단계만 바꾼 사본. */
function withSteps(jobs, jobName, edit) {
  return jobs.map(job => (job.name === jobName ? { ...job, steps: edit(job.steps) } : job))
}

const SHARDS = { windows: 5, macos: 2 }

function run({ number = 12, attempt = 1, id = 900 + number, conclusion = 'success', sha = SHA } = {}) {
  return {
    id,
    name: 'ci',
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    conclusion,
    run_number: number,
    run_attempt: attempt,
    html_url: `https://github.com/o/r/actions/runs/${id}`
  }
}

/** 경로별 응답을 돌려주는 가짜 API. 어떤 경로를 불렀는지 남겨 단언에 쓴다. */
function fakeApi({ runs = [], jobs = {}, onJobs } = {}) {
  const calls = []
  const fetchJson = async (path) => {
    calls.push(path)
    if (path.startsWith('/repos/o/r/actions/workflows/ci.yml/runs')) return { workflow_runs: runs }
    const match = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path)
    if (!match) throw new Error(`예상 밖 경로 ${path}`)
    if (onJobs) return onJobs(Number(match[1]), Number(match[2]))
    const batch = jobs[match[1]] ?? []
    return { total_count: batch.length, jobs: batch }
  }
  return { fetchJson, calls }
}

test('재실행 인정은 기본값이 켜짐이고 끄는 값만 끈다', () => {
  assert.equal(parseAcceptReruns(''), true)
  assert.equal(parseAcceptReruns(undefined), true)
  assert.equal(parseAcceptReruns('true'), true)
  assert.equal(parseAcceptReruns('false'), false)
  assert.equal(parseAcceptReruns('0'), false)
  assert.equal(parseAcceptReruns(' OFF '), false)
})

test('샤드 수는 shards.json 에서 읽는다', () => {
  const counts = readShardCounts()
  assert.ok(counts.macos >= 1 && counts.windows >= 1)
  const dir = mkdtempSync(join(tmpdir(), 'shards-'))
  const file = join(dir, 'shards.json')
  writeFileSync(file, JSON.stringify({ macos: [['a'], ['b']], windows: [['a']] }))
  assert.deepEqual(readShardCounts(file), { macos: 2, windows: 1 })
  writeFileSync(file, JSON.stringify({ macos: [] }))
  assert.throws(() => readShardCounts(file), /비었다/)
})

test('전부 초록인 실행만 근거로 인정한다', () => {
  assert.equal(judgeJobs(greenJobs(), SHARDS), null)
  // 문서만 바뀐 실행: 작업은 초록이지만 e2e 단계가 skipped 다 — 이걸 통과시키면 시험 안 한 태그가 나간다.
  const docsOnly = greenJobs().map(job => ({
    ...job,
    steps: job.steps.map(step => step.name.startsWith('e2e (') ? { ...step, conclusion: 'skipped' } : step)
  }))
  // 판정은 SHARDS 키 순서로 훑는다 — windows 가 먼저이므로 처음 걸리는 샤드는 1번이다.
  assert.match(judgeJobs(docsOnly, SHARDS), /e2e \(windows-latest, 1\) 단계가 skipped/)
  assert.match(judgeJobs(greenJobs({ 'app (macos-latest, 2)': 'failure' }), SHARDS), /성공하지 않은 작업/)
  assert.match(judgeJobs([], SHARDS), /작업 목록이 비었다/)
})

test('빠진 샤드·pytest·요약 다리를 근거로 쓰지 않는다', () => {
  const missingShard = greenJobs().filter(job => job.name !== 'app (windows-latest, 4)')
  assert.match(judgeJobs(missingShard, SHARDS), /app \(windows-latest, 4\) 작업이 없다/)
  const missingTests = greenJobs().filter(job => !job.name.startsWith('tests ('))
  // 판정은 SHARDS 키 순서(windows 먼저)로 훑으므로 처음 걸리는 OS 는 windows 다. 잠그는 것은
  // 'pytest 작업이 빠지면 탈락'이지 어느 OS 이름이 먼저 나오는지가 아니다.
  assert.match(judgeJobs(missingTests, SHARDS), /tests \(windows-latest, 3\.13\) 작업이 없다/)
  // 샤드가 늘었는데 근거 실행은 옛 샤드 수로 돌았다면 그 샤드는 시험되지 않았다.
  assert.match(judgeJobs(greenJobs(), { windows: 6, macos: 2 }), /app \(windows-latest, 6\) 작업이 없다/)
  const missingStep = greenJobs().map(job => job.name === 'app (macos-latest, 1)'
    ? { ...job, steps: [{ name: 'e2e (macos-latest, 1)', conclusion: 'success' }].slice(0, 0) }
    : job)
  assert.match(judgeJobs(missingStep, SHARDS), /e2e \(macos-latest, 1\) 단계가 없다/)
  const noBridge = greenJobs().filter(job => job.name !== 'app (windows-latest)')
  assert.match(judgeJobs(noBridge, SHARDS), /app \(windows-latest\) 요약 작업이 없다/)
})

test('태그가 실제로 도는 맥 3.13 pytest 단계가 초록이어야 근거가 된다', () => {
  // 리뷰 C-01: 잡 결론이 success 면 단계가 skipped 여도 통과했다. 태그 verify 는 맥 3.13 으로
  // pytest 를 돌리므로, 그 작업·그 단계가 초록인지 직접 본다.
  const only310 = greenJobs().filter(job => job.name !== 'tests (macos-latest, 3.13)')
  assert.match(judgeJobs(only310, SHARDS), /tests \(macos-latest, 3\.13\) 작업이 없다/)
  const skippedPytest = withSteps(greenJobs(), 'tests (macos-latest, 3.13)', steps =>
    steps.map(step => ({ ...step, conclusion: 'skipped' })))
  assert.match(judgeJobs(skippedPytest, SHARDS), /tests \(macos-latest, 3\.13\) 의 Prepare pinned runtime and run tests 단계가 skipped/)
  const noPytestStep = withSteps(greenJobs(), 'tests (macos-latest, 3.13)', () => [])
  assert.match(judgeJobs(noPytestStep, SHARDS), /Prepare pinned runtime and run tests 단계가 없음/)
  // 한 작업 안에 같은 이름의 단계가 둘이면 둘 다 초록이어야 한다(뒤 단계 실패를 숨기지 않게).
  const duplicated = withSteps(greenJobs(), 'tests (windows-latest, 3.13)', steps => [...steps, { ...PYTEST, conclusion: 'failure' }])
  assert.match(judgeJobs(duplicated, SHARDS), /tests \(windows-latest, 3\.13\) 의 Prepare pinned runtime and run tests 단계가 failure/)
})

test('태그가 요구하는 typecheck·build 단계가 skipped 면 근거가 아니다', () => {
  const noTypecheck = withSteps(greenJobs(), 'app (macos-latest, 1)', steps =>
    steps.filter(step => step.name !== 'pnpm typecheck'))
  assert.match(judgeJobs(noTypecheck, SHARDS), /app \(macos-latest, 1\) 의 pnpm typecheck 단계가 없음/)
  const skippedBuild = withSteps(greenJobs(), 'app (macos-latest, 2)', steps =>
    steps.map(step => (step.name === 'pnpm build' ? { ...step, conclusion: 'skipped' } : step)))
  assert.match(judgeJobs(skippedBuild, SHARDS), /app \(macos-latest, 2\) 의 pnpm build 단계가 skipped/)
  const skippedWindowsBuild = withSteps(greenJobs(), 'app (windows-latest, 3)', steps =>
    steps.map(step => (step.name === 'pnpm build' ? { ...step, conclusion: 'skipped' } : step)))
  assert.match(judgeJobs(skippedWindowsBuild, SHARDS), /app \(windows-latest, 3\) 의 pnpm build 단계가 skipped/)
})

test('다른 커밋·다른 브랜치·실패한 실행은 후보가 아니다', async () => {
  const { fetchJson } = fakeApi({ runs: [
    run({ number: 3, sha: 'b'.repeat(40) }),
    run({ number: 4, conclusion: 'failure' }),
    { ...run({ number: 5 }), head_branch: 'release/0.7' },
    { ...run({ number: 6 }), event: 'pull_request' },
    { ...run({ number: 7 }), path: '.github/workflows/app-release.yml' }
  ] })
  const result = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson })
  assert.equal(result.skip, false)
  assert.match(result.reason, /찾지 못했다/)
})

test('초록 실행을 찾으면 근거 run 번호를 남기고 건너뛴다', async () => {
  const api = fakeApi({ runs: [run({ number: 481 })], jobs: { 1381: greenJobs() } })
  const result = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: api.fetchJson })
  assert.equal(result.skip, true)
  assert.equal(result.run_number, 481)
  assert.equal(result.run_attempt, 1)
  assert.match(result.run_url, /actions\/runs\/1381$/)
  assert.match(api.calls[0], /head_sha=a{40}/)
  assert.match(api.calls[1], /\/actions\/runs\/1381\/attempts\/1\/jobs/)
  assert.match(renderSummary(result), /main CI \[#481\]/)
})

test('재실행(attempt 2)은 기본값에서 인정하고, 끄면 인정하지 않는다', async () => {
  const api = fakeApi({ runs: [run({ number: 482, attempt: 2, id: 1482 })], jobs: { 1482: greenJobs() } })
  const accepted = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: api.fetchJson })
  assert.equal(accepted.skip, true)
  assert.equal(accepted.run_attempt, 2)

  const rejected = await findEvidence({
    repo: 'o/r', sha: SHA, shards: SHARDS, acceptReruns: false, fetchJson: api.fetchJson
  })
  assert.equal(rejected.skip, false)
  assert.match(rejected.reason, /attempt 2 \(재실행 인정 꺼짐\)/)
  // 재실행 인정이 꺼져 있으면 attempt 1 실행을 찾아 쓴다.
  const api2 = fakeApi({
    runs: [run({ number: 482, attempt: 2, id: 1482 }), run({ number: 481, id: 1381 })],
    jobs: { 1482: greenJobs(), 1381: greenJobs() }
  })
  const first = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, acceptReruns: false, fetchJson: api2.fetchJson })
  assert.equal(first.skip, true)
  assert.equal(first.run_attempt, 1)
})

test('온전치 않은 실행은 건너뛰고 그다음 후보를 본다', async () => {
  const api = fakeApi({
    runs: [run({ number: 500, id: 1500 }), run({ number: 499, id: 1499 })],
    jobs: { 1500: greenJobs({ 'app (windows-latest, 2)': 'cancelled' }), 1499: greenJobs() }
  })
  const result = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: api.fetchJson })
  assert.equal(result.skip, true)
  assert.equal(result.run_number, 499)
})

test('작업 목록 조회가 실패하면 그 후보는 버리고 예전처럼 전부 돈다', async () => {
  const api = fakeApi({ runs: [run({ number: 600 })], onJobs: () => { throw new Error('GitHub API 403') } })
  const result = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: api.fetchJson })
  assert.equal(result.skip, false)
  assert.match(result.reason, /조회 실패/)
})

test('작업 목록은 끝까지 읽는다 — 한 페이지 100개를 넘겨도 샤드를 놓치지 않는다', async () => {
  // 1페이지에서 샤드 작업이 잘려 나가도 2페이지까지 읽어야 근거가 성립한다.
  const all = greenJobs()
  const padded = [...Array.from({ length: 100 - all.length + 1 }, (_, i) => ({
    id: 10_000 + i, name: `filler-${i}`, conclusion: 'success', steps: []
  })), ...all]
  assert.ok(padded.length > 100)
  const pages = []
  const fetchJson = async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [run({ number: 700, id: 1700 })] }
    // `per_page=100` 의 100 을 페이지 번호로 잡지 않도록 `?`/`&` 앞을 요구한다.
    const page = Number(/[?&]page=(\d+)/.exec(path)[1])
    pages.push(page)
    return { total_count: padded.length, jobs: page === 1 ? padded.slice(0, 100) : padded.slice(100) }
  }
  const result = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson })
  assert.equal(result.skip, true)
  assert.deepEqual(pages, [1, 2])
})

test('잘린 작업 목록은 근거로 쓰지 않는다', async () => {
  const trimmed = greenJobs()
  // 중간 빈 페이지: total_count 는 30 인데 1페이지가 10건 뒤 빈 페이지 — 나머지는 오지 않는다.
  const middleEmpty = async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [run({ number: 800, id: 1800 })] }
    const page = Number(/[?&]page=(\d+)/.exec(path)[1])
    return { total_count: 30, jobs: page === 1 ? trimmed.slice(0, 10) : [] }
  }
  const empty = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: middleEmpty })
  assert.equal(empty.skip, false)
  assert.match(empty.reason, /작업 목록이 불완전하다 \(10\/30/)

  // 5페이지(500건) 한도를 넘겨도 총계에 못 미치면 잘린 목록이다.
  const overLimit = async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [run({ number: 801, id: 1801 })] }
    const page = Number(/[?&]page=(\d+)/.exec(path)[1])
    return {
      total_count: 600,
      jobs: Array.from({ length: 100 }, (_, i) => ({
        id: page * 1000 + i, name: `filler-${page}-${i}`, conclusion: 'success', steps: []
      }))
    }
  }
  const limited = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: overLimit })
  assert.equal(limited.skip, false)
  assert.match(limited.reason, /500\/600.*5페이지 한도/)

  // 중복 ID 는 같은 페이지를 두 번 받은 신호다 — 근거로 쓰지 않는다.
  const duplicated = async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [run({ number: 802, id: 1802 })] }
    return { total_count: trimmed.length, jobs: [trimmed[0], ...trimmed] }
  }
  const dup = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: duplicated })
  assert.equal(dup.skip, false)
  assert.match(dup.reason, /작업 ID 가 중복됐다/)

  // total_count 가 없는 응답도 잘린 것으로 본다(옛/대체 응답).
  const noTotal = async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [run({ number: 803, id: 1803 })] }
    return { jobs: trimmed }
  }
  const missing = await findEvidence({ repo: 'o/r', sha: SHA, shards: SHARDS, fetchJson: noTotal })
  assert.equal(missing.skip, false)
  assert.match(missing.reason, /total_count/)
})

test('출력은 GITHUB_OUTPUT 형식이고 근거 번호가 빈다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'))
  const file = join(dir, 'out')
  writeFileSync(file, '')
  writeOutputs(file, { skip: false, reason: '기록 없음\n다음 줄' })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^skip=false$/m)
  assert.match(text, /^run_number=$/m)
  // 여러 줄 이유가 출력 파일을 쪼개지 않는다.
  assert.match(text, /^reason=기록 없음 다음 줄$/m)

  const skipped = join(dir, 'out2')
  writeFileSync(skipped, '')
  writeOutputs(skipped, { skip: true, run_number: 481, run_attempt: 2, run_url: 'u', reason: 'r' })
  const second = readFileSync(skipped, 'utf8')
  assert.match(second, /^skip=true$/m)
  assert.match(second, /^run_number=481$/m)
  assert.match(second, /^run_attempt=2$/m)
})

test('요약 쓰기가 실패하면 출력(GITHUB_OUTPUT)은 남지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'))
  const output = join(dir, 'out')
  writeFileSync(output, '')
  const result = { skip: true, run_number: 481, run_attempt: 1, run_url: 'u', reason: 'r' }
  // GITHUB_OUTPUT 은 append-only 다 — skip=true 가 먼저 남으면 단계가 실패해도 지울 수 없다.
  assert.throws(() => publish(result, { output, summary: join(dir, '없는디렉터리', 'summary.md') }))
  assert.equal(readFileSync(output, 'utf8'), '')
  // 정상일 때는 요약과 출력을 둘 다 남긴다.
  const summary = join(dir, 'summary.md')
  publish(result, { output, summary })
  assert.match(readFileSync(summary, 'utf8'), /#481/)
  assert.match(readFileSync(output, 'utf8'), /^skip=true$/m)
})

test('요약은 건너뛸 때도 돌 때도 근거를 남긴다', () => {
  const skipped = renderSummary({ skip: true, run_number: 481, run_attempt: 1, run_url: 'https://x/1' })
  assert.match(skipped, /#481/)
  assert.match(skipped, /켜짐/)
  const full = renderSummary({ skip: false, reason: '기록 없음' }, false)
  assert.match(full, /전부 실행/)
  assert.match(full, /기록 없음/)
  assert.match(full, /꺼짐/)
})

// ── 워크플로 배선 ─────────────────────────────────────────────────────────────
// 판정 스크립트만 있고 release.yml 이 그것을 안 보면 기능은 없는 것과 같다. 반대로 배선이
// 느슨해지면(예: macos 가 evidence 를 안 기다림) 시험 안 한 커밋으로 초안이 만들어진다.
const workflow = readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/release.yml'), 'utf8')
  .replace(/\r\n/g, '\n')

/** `jobs:` 아래 2칸 들여쓰기 키를 작업 경계로 보고 그 작업의 본문을 돌려준다. */
function jobBlock(name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex(line => line === `  ${name}:`)
  assert.ok(start >= 0, `${name} 작업이 없다`)
  let end = start + 1
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:$/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

test('release.yml 은 태그 커밋의 main CI 를 먼저 확인한다', () => {
  const evidence = jobBlock('evidence')
  assert.match(evidence, /node app\/scripts\/release-ci-evidence\.mjs/)
  assert.match(evidence, /actions: read/)
  // 출력 이름이 판정 스크립트의 출력 키와 같아야 `needs.evidence.outputs.skip` 이 값을 받는다.
  for (const key of ['skip', 'run_number', 'run_attempt', 'run_url']) {
    assert.match(evidence, new RegExp(`^      ${key}: \\$\\{\\{ steps\\.judge\\.outputs\\.${key} \\}\\}$`, 'm'))
  }
  // 판정 단계 결과도 출력으로 넘긴다 — 워크플로 조건이 `skip` 만 믿지 않게(I-01).
  assert.match(evidence, /^      valid: \$\{\{ steps\.judge\.outcome == 'success' \}\}$/m)
  // 기본값=인정. 저장소 변수 하나로 끌 수 있다.
  assert.match(evidence, /vars\.RELEASE_CI_EVIDENCE_ACCEPT_RERUNS/)
})

test('맥 시험은 근거가 없을 때만 돌고, 윈도 시험은 그 판정을 물려받는다', () => {
  const verify = jobBlock('verify')
  assert.match(verify, /needs: evidence/, 'verify 가 evidence 를 안 기다린다')
  // 건너뛰기는 evidence 작업 성공 + 판정 단계 성공(valid) + skip=true 세 가지가 모두 맞을 때만.
  // `skip` 만 보면 출력만 남고 판정이 실패한 경우(I-01)에 시험을 생략한다.
  assert.match(
    verify,
    /if: \$\{\{ !cancelled\(\) && !\(needs\.evidence\.result == 'success' && needs\.evidence\.outputs\.valid == 'true' && needs\.evidence\.outputs\.skip == 'true'\) \}\}/,
    'verify 조건이 작업·단계·skip 을 모두 확인하지 않거나, evidence 작업 실패 시 릴리스가 멈춘다'
  )
  // e2e-windows 는 verify 만 기다린다 — verify 가 건너뛰면 GitHub 이 의존 작업을 '건너뜀'으로
  // 전파하므로 윈도 e2e 도 함께 건너뛴다. 여기에 독립 `if:` 를 붙이면 그 전파가 깨진다.
  const windowsE2e = jobBlock('e2e-windows')
  assert.match(windowsE2e, /needs: verify/)
  assert.doesNotMatch(windowsE2e, /\n    if:/, 'e2e-windows 에 독립 if 가 붙으면 verify 의 건너뜀이 전파되지 않는다')
})

test('빌드·서명·초안 작업은 건너뛴 경우에도 돌고, 시험이 실패하면 돌지 않는다', () => {
  for (const name of ['macos', 'windows']) {
    const block = jobBlock(name)
    assert.match(block, /needs:.*evidence/, `${name} 이 evidence 를 안 기다린다`)
    assert.match(block, /!cancelled\(\)/, `${name} 이 취소된 실행에서 새 작업을 띄운다`)
    assert.match(
      block,
      /needs\.evidence\.result == 'success' && needs\.evidence\.outputs\.valid == 'true' && needs\.evidence\.outputs\.skip == 'true'\) \|\| \(needs\.verify\.result == 'success' && needs\.e2e-windows\.result == 'success'\)/,
      `${name} 의 조건이 '작업·단계·skip 이 모두 확인됐거나 둘 다 성공'이 아니다`
    )
  }
})

test('맥 잡은 건너뛴 실행에서 CI 가 덮지 않는 오프라인 재스테이징을 직접 확인한다', () => {
  const macos = jobBlock('macos')
  // C-01: 태그 verify 는 pytest 직전에 stage-skill --offline 을 거치는데, CI pytest 는
  // KNUAF_TEST_SCRIPTS_DIR 로 그 훅을 건너뛴다. 그래서 근거 기록만으로는 그 경로가 증명되지 않는다.
  assert.match(
    macos,
    /- name: [^\n]*오프라인 재스테이징 확인[^\n]*\n\s+if: \$\{\{ success\(\) && needs\.evidence\.result == 'success' && needs\.evidence\.outputs\.valid == 'true' && needs\.evidence\.outputs\.skip == 'true' \}\}\n\s+working-directory: app\n\s+run: node scripts\/stage-skill\.mjs --offline/,
    '건너뛴 실행에서 오프라인 재스테이징 확인이 안 돈다'
  )
  // 설치본 빌드(dist:mac -> stage:skill) 뒤에 돌아야 캐시가 이미 채워져 있다.
  assert.ok(macos.indexOf('pnpm dist:mac') < macos.indexOf('stage-skill.mjs --offline'),
    '오프라인 확인이 설치본 빌드보다 먼저 돌면 첫 실행에서 캐시가 비어 실패한다')
})

test('판정기가 요구하는 단계 이름·버전이 ci.yml·release.yml 배선과 같다', () => {
  // 이름이 어긋나면 판정이 영원히 '없음'이 되어 조용히 전부 돈다(느려질 뿐이지만 기능이 죽는다).
  const ci = readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n')
  assert.match(ci, /^      - name: Prepare pinned runtime and run tests$/m)
  assert.match(ci, /^      - run: pnpm typecheck$/m)
  assert.match(ci, /^      - run: pnpm build$/m)
  // 판정기가 요구하는 pytest 버전(3.13)이 ci.yml 행렬과 태그 verify 의 setup-python 양쪽에 있다.
  assert.match(ci, /python: \["3\.10", "3\.13"\]/)
  assert.match(jobBlock('verify'), /python-version: "3\.13"/)
})

test('초안 본문은 건너뛴 경우의 근거 CI run 을 싣는다', () => {
  const macos = jobBlock('macos')
  // 원시 skip 이 아니라 시험 생략과 같은 세 조건(잡 성공·판정 단계 성공·skip)으로 기록한다.
  assert.match(macos, /SKIP_TESTS: \$\{\{ needs\.evidence\.result == 'success' && needs\.evidence\.outputs\.valid == 'true' && needs\.evidence\.outputs\.skip == 'true' \}\}/)
  assert.doesNotMatch(macos, /SKIP_TESTS: \$\{\{ needs\.evidence\.outputs\.skip \}\}/)
  assert.match(macos, /EVIDENCE_RUN: \$\{\{ needs\.evidence\.outputs\.run_number \}\}/)
  assert.match(macos, /EVIDENCE_URL: \$\{\{ needs\.evidence\.outputs\.run_url \}\}/)
  assert.ok(macos.includes('$SKIP_TESTS'), 'notes 생성이 SKIP_TESTS 를 안 읽는다')
  assert.ok(macos.includes('$EVIDENCE_RUN'), 'notes 생성이 근거 run 번호를 안 싣는다')
})
