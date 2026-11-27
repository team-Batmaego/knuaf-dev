// 태그 배포(release.yml)가 `verify`·`e2e-windows` 를 다시 돌릴지, 이미 초록인 main CI 기록을
// 근거로 건너뛸지 판정한다.
//
// 왜 필요한가: ci.yml 은 push 트리거가 브랜치 한정(`branches: ["main", "release/**"]`)이라 태그
// 푸시에는 돌지 않는다. 그래서 release.yml 이 태그 경로에서 시험을 다시 돌려 왔는데, 태그 커밋은
// 대개 main 에 이미 푸시된 커밋이고 그 push CI 가 같은 시험(pytest·typecheck·build·e2e)을 돌렸다.
// v0.7.2 태그 1회는 2시간 35분이었고 그중 2시간 16분이 이 중복이었다.
//
// 판정은 fail-closed 다 — 근거가 조금이라도 어긋나거나 조회가 실패하면 `skip=false` 로 닫아
// 예전처럼 전부 돈다. 이 스크립트는 어떤 경우에도 예외로 작업을 죽이지 않는다(출력은 늘 나간다).
//
// 근거로 인정하는 실행(전부 만족해야 함):
//   - 같은 저장소의 `.github/workflows/ci.yml` 실행
//   - event=push, head_branch=main, head_sha=태그 커밋, conclusion=success
//   - 재실행 인정이 꺼져 있으면 run_attempt=1
//   - 작업이 전부 conclusion=success (skipped·cancelled·failure 없음)
//   - 작업 목록이 잘리지 않았다 — 받은 건수 = total_count, 작업 id 가 전부 있고 서로 다르다
//   - `tests (<os>-latest, …)` 작업의 pytest 단계가 success, 맥은 그중 3.13 이 있다(태그 verify 와 같다)
//   - 맥 2·윈도 5 샤드의 `e2e (<os>, <샤드>)` 단계가 각각 success, 맥 샤드는 typecheck·build 단계도
//     success, `app (<os>)` 요약 다리가 있다 — 문서만 바뀐 실행은 e2e·typecheck·build 가 skipped 라 탈락한다
//
// 사용(CI 전용, `.github/workflows/release.yml` 의 `evidence` 작업):
//   GITHUB_REPOSITORY=owner/repo GITHUB_SHA=<sha> GITHUB_TOKEN=... node app/scripts/release-ci-evidence.mjs
//   → $GITHUB_OUTPUT 에 skip/run_number/run_attempt/run_url/reason, $GITHUB_STEP_SUMMARY 에 요약.
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKFLOW = '.github/workflows/ci.yml'
const MANIFEST = resolve(import.meta.dirname, '..', 'e2e', 'shards.json')
const MAX_PAGES = 5

// 태그 경로가 실제로 돌리는 것과 같은 것만 근거로 친다. 아래 두 값은 `.github/workflows/release.yml`
// 의 `verify`(setup-python / pytest 단계)와 ci.yml 의 단계 이름·버전을 그대로 옮긴 것이므로,
// 어느 한쪽을 고치면 여기도 같이 고쳐야 한다(시험이 배선과 이름을 대조한다).
const RELEASE_PYTHON = '3.13'
const PYTEST_STEP = 'Prepare pinned runtime and run tests'
// 샤드 작업에서 태그 경로가 실제로 요구하는 단계: 맥 verify 는 typecheck·build·e2e,
// 윈도 e2e-windows 는 build·e2e. 여기 없는 단계(pnpm test:scripts 등)는 태그 경로가 안 돌린다.
const SHARD_STEPS = { macos: ['pnpm typecheck', 'pnpm build'], windows: ['pnpm build'] }

/** 재실행 인정 설정. 비었으면(변수 미설정) 기본값=인정. */
export function parseAcceptReruns(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return true
  return !['false', '0', 'no', 'off'].includes(text)
}

/** `e2e/shards.json` 의 OS 별 샤드 수 — 작업 이름을 손으로 적지 않는다. */
export function readShardCounts(path = MANIFEST) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const counts = {}
  for (const [os, shards] of Object.entries(manifest)) {
    if (!Array.isArray(shards) || !shards.length) throw new Error(`shards.json 의 ${os} 묶음이 비었다`)
    counts[os] = shards.length
  }
  if (!Object.keys(counts).length) throw new Error('shards.json 에 OS 묶음이 없다')
  return counts
}

/**
 * 한 단계의 상태. 같은 이름이 여러 번 나오면 전부 success 여야 success 다(뒤 단계 실패를 숨기지 않게).
 * 단계가 없으면 '없음'.
 */
function stepState(job, name) {
  const steps = (job.steps ?? []).filter(candidate => candidate.name === name)
  if (!steps.length) return '없음'
  const bad = steps.find(step => step.conclusion !== 'success')
  return bad ? (bad.conclusion ?? '결론 없음') : 'success'
}

/** 작업 목록이 '같은 시험 전부 초록'인지 본다. 문제가 없으면 null, 있으면 그 이유 한 줄. */
export function judgeJobs(jobs, shards) {
  const list = Array.isArray(jobs) ? jobs : []
  if (!list.length) return '작업 목록이 비었다'
  const failed = list.filter(job => job.conclusion !== 'success')
  if (failed.length) {
    return `성공하지 않은 작업: ${failed.map(job => `${job.name}=${job.conclusion}`).join(', ')}`
  }
  for (const [os, count] of Object.entries(shards)) {
    const runner = `${os}-latest`
    // pytest 는 태그의 verify 가 실제로 도는 버전(3.13)의 작업을 요구한다 — 3.10 만 초록인 실행은
    // 태그가 돌릴 3.13 을 증명하지 못한다. 다른 버전의 작업이 있으면 결론 검사는 위에서 이미 했다.
    const pythonTestsName = `tests (${runner}, ${RELEASE_PYTHON})`
    const pythonTests = list.find(job => job.name === pythonTestsName)
    if (!pythonTests) return `${pythonTestsName} 작업이 없다`
    // 잡 결론만 보면 단계가 skipped 인 초록 잡을 통과시킨다 — 태그 verify 가 도는 pytest 단계를 직접 본다.
    const pytest = stepState(pythonTests, PYTEST_STEP)
    if (pytest !== 'success') return `${pythonTests.name} 의 ${PYTEST_STEP} 단계가 ${pytest}`
    for (let shard = 1; shard <= count; shard++) {
      const jobName = `app (${runner}, ${shard})`
      const job = list.find(candidate => candidate.name === jobName)
      if (!job) return `${jobName} 작업이 없다`
      const stepName = `e2e (${runner}, ${shard})`
      const target = (job.steps ?? []).find(candidate => candidate.name === stepName)
      if (!target) return `${jobName} 에 ${stepName} 단계가 없다`
      // 문서만 바뀐 실행은 작업이 초록으로 끝나지만 이 단계는 skipped 다 — 여기서 걸러진다.
      if (target.conclusion !== 'success') return `${stepName} 단계가 ${target.conclusion} 다`
      // 태그가 요구하는 빌드 단계까지 초록이어야 한다(맥 typecheck·build, 윈도 build).
      for (const required of SHARD_STEPS[os] ?? []) {
        const state = stepState(job, required)
        if (state !== 'success') return `${jobName} 의 ${required} 단계가 ${state}`
      }
    }
    if (!list.find(candidate => candidate.name === `app (${runner})`)) return `app (${runner}) 요약 작업이 없다`
  }
  return null
}

/**
 * 실행 하나의 작업 목록 전체. 잘린 목록은 근거로 쓸 수 없으므로(fail-closed) 완전하지 않으면 던진다:
 * - `total_count` 가 없거나 페이지마다 다르면 잘린 것으로 본다
 * - 빈 페이지가 나왔는데 아직 total 에 못 미치면 잘린 것으로 본다
 * - 5페이지(500건) 한도를 넘겨도 못 채우면 던진다
 * - `id` 가 없는 항목·중복 항목은 잘린/섞인 목록의 신호다
 */
async function listJobs(fetchJson, repo, run) {
  const attempt = run.run_attempt ?? 1
  const jobs = []
  const ids = new Set()
  let total = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchJson(`/repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`)
    if (typeof data.total_count !== 'number') throw new Error('작업 총계(total_count)가 없다')
    if (total === null) total = data.total_count
    else if (data.total_count !== total) throw new Error(`작업 총계가 페이지마다 다르다 (${total} -> ${data.total_count})`)
    const batch = Array.isArray(data.jobs) ? data.jobs : []
    for (const job of batch) {
      if (job.id === undefined || job.id === null) throw new Error('작업 ID 가 없는 항목이 있다')
      if (ids.has(job.id)) throw new Error(`작업 ID 가 중복됐다 (${job.id})`)
      ids.add(job.id)
      jobs.push(job)
    }
    if (jobs.length >= total) break
    if (!batch.length) break
  }
  if (jobs.length !== total) {
    throw new Error(`작업 목록이 불완전하다 (${jobs.length}/${total}, ${MAX_PAGES}페이지 한도)`)
  }
  return jobs
}

/** 후보 실행(최신순)을 훑어 처음으로 온전히 초록인 실행을 근거로 삼는다. */
export async function findEvidence({ repo, sha, shards, acceptReruns = true, fetchJson }) {
  const query = new URLSearchParams({
    head_sha: sha, branch: 'main', event: 'push', status: 'success', per_page: '30'
  })
  const runs = await fetchJson(`/repos/${repo}/actions/workflows/ci.yml/runs?${query}`)
  const candidates = (runs.workflow_runs ?? [])
    .filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' &&
      run.conclusion === 'success' && run.path === WORKFLOW)
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))
  if (!candidates.length) {
    return { skip: false, reason: `main CI 에서 ${String(sha).slice(0, 7)} 의 초록 실행을 찾지 못했다` }
  }
  const rejected = []
  for (const run of candidates) {
    const attempt = run.run_attempt ?? 1
    if (!acceptReruns && attempt !== 1) {
      rejected.push(`#${run.run_number}: attempt ${attempt} (재실행 인정 꺼짐)`)
      continue
    }
    let jobs
    try {
      jobs = await listJobs(fetchJson, repo, run)
    } catch (error) {
      rejected.push(`#${run.run_number}: 작업 목록 조회 실패 (${error.message})`)
      continue
    }
    const problem = judgeJobs(jobs, shards)
    if (problem) {
      rejected.push(`#${run.run_number}: ${problem}`)
      continue
    }
    return {
      skip: true,
      run_number: run.run_number,
      run_attempt: attempt,
      run_url: run.html_url ?? '',
      reason: `main CI #${run.run_number} (attempt ${attempt}) 가 같은 시험을 초록으로 통과했다`
    }
  }
  return { skip: false, reason: `근거로 쓸 수 있는 실행이 없다 — ${rejected.join(' / ')}` }
}

/** GitHub REST 읽기 전용 호출. 토큰은 헤더로만 나가고 로그·출력에 쓰지 않는다. */
export function github(repo, token) {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'knuaf-release-ci-evidence'
      }
    })
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${path}`)
    return response.json()
  }
}

/** 잡 요약(마크다운). 근거 run 번호가 릴리스 기록에 남는 자리다. */
export function renderSummary(result, acceptReruns = true) {
  const setting = acceptReruns ? '켜짐(기본값)' : '꺼짐'
  if (result.skip) {
    return [
      '### 태그 경로 시험 건너뜀',
      '',
      `- 근거: main CI [#${result.run_number}](${result.run_url}) (attempt ${result.run_attempt})`,
      `- 이 태그 커밋은 main CI 에서 같은 시험(pytest ${RELEASE_PYTHON}·typecheck·build·e2e 맥 2·윈도 5 샤드)을 이미 초록으로 통과했다.`,
      '- 이번 실행은 설치본 빌드·서명·체크섬·판 확인·초안과, CI 가 덮지 않는 스킬 오프라인 재스테이징 확인만 돈다.',
      `- 재실행 인정: ${setting}`,
      ''
    ].join('\n')
  }
  return [
    '### 태그 경로 시험 전부 실행',
    '',
    `- 이유: ${result.reason}`,
    `- 재실행 인정: ${setting}`,
    ''
  ].join('\n')
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

export function writeOutputs(path, result) {
  const lines = [
    `skip=${result.skip === true}`,
    `run_number=${result.skip === true ? result.run_number : ''}`,
    `run_attempt=${result.skip === true ? result.run_attempt : ''}`,
    `run_url=${result.skip === true ? oneLine(result.run_url) : ''}`,
    `reason=${oneLine(result.reason)}`,
    ''
  ]
  appendFileSync(path, lines.join('\n'))
}

/**
 * 결과를 기록한다. 요약을 **먼저** 쓰고 출력(GITHUB_OUTPUT)을 마지막에 쓴다.
 * GITHUB_OUTPUT 은 append-only 라 한 번 쓴 `skip=true` 는 되돌릴 수 없다. 그래서 요약 쓰기가
 * 실패하면 출력은 아예 남기지 않고 단계를 실패시킨다(그러면 아래 잡들이 `valid` 를 못 받아
 * 전부 돈다). 반대 순서면 출력만 남고 단계가 실패해, 워크플로가 'skip=true + 실패한 evidence'
 * 를 보고 시험을 생략할 수 있다.
 */
export function publish(result, { output, summary } = {}, acceptReruns = true) {
  if (summary) appendFileSync(summary, renderSummary(result, acceptReruns))
  if (output) writeOutputs(output, result)
}

async function main(env = process.env) {
  const acceptReruns = parseAcceptReruns(env.RELEASE_CI_EVIDENCE_ACCEPT_RERUNS)
  let result
  try {
    const repo = env.GITHUB_REPOSITORY
    const sha = env.GITHUB_SHA
    const token = env.GITHUB_TOKEN || env.GH_TOKEN
    if (!repo || !sha) throw new Error('GITHUB_REPOSITORY·GITHUB_SHA 가 없다')
    if (!token) throw new Error('GITHUB_TOKEN 이 없다')
    result = await findEvidence({
      repo, sha, shards: readShardCounts(), acceptReruns, fetchJson: github(repo, token)
    })
  } catch (error) {
    // 판정을 못 하면 예전처럼 전부 돈다. 이 작업이 릴리스 자체를 막는 일은 없어야 한다.
    result = { skip: false, reason: `판정 실패(전부 돈다): ${error instanceof Error ? error.message : error}` }
  }
  console.log(`skip=${result.skip === true} — ${result.reason}`)
  publish(result, { output: env.GITHUB_OUTPUT, summary: env.GITHUB_STEP_SUMMARY }, acceptReruns)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
