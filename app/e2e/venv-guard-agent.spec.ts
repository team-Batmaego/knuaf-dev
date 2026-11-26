// S-01 5단계 D-A(형님 결정: 에이전트의 공유 환경 설치 거부): 도우미가 도는 세 갈래 — 터미널 실행 스크립트
// (맥 .command·윈도 .cmd), 본대화·담당 연결 env(`subscriptionEnv`) — 가 모두 같은 두 값을 싣는다.
//   KNUAF_DEPS_VENV          = 앱 데이터 의존성 환경(준비 전이면 빈 값 — 스킬은 빈 값도 "폴더 .venv 보지 않음"으로 읽는다)
//   KNUAF_DEPS_VENV_READONLY = 1(도우미는 공유 환경에 설치하지 않는다 — 준비는 앱의 '준비하기'만)
// 값이 안 넘어와도(옛 호출자) 빈 값·READONLY 로 닫혀야 한다 — 폴더 .venv 로 떨어지는 기본값이 없어야 한다.
import { expect, test } from '@playwright/test'
import { buildLaunchScript, workFolderInstructions } from '../src/main/agent'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEPS_READONLY_ENV, DEPS_VENV_ENV, noDepsEnvFallback, subscriptionEnv } from '../src/main/chat/contracts'

const base = { root: '/tmp/논문', agent: 'claude' as const, agentPath: '/opt/claude', venvBin: null, bundledBin: null, firstPrompt: '시작하기' }

test('계약 이름은 사이드카·스킬과 같은 글자다', () => {
  expect(DEPS_VENV_ENV).toBe('KNUAF_DEPS_VENV')
  expect(DEPS_READONLY_ENV).toBe('KNUAF_DEPS_VENV_READONLY')
})

test('맥 터미널 스크립트: 앱 환경 경로와 READONLY 를 싣는다(작은따옴표 인용)', () => {
  const env = "/Users/학생/Library/Application Support/앱/deps/0123456789abcdef"
  const script = buildLaunchScript({ ...base, venvBin: env + '/bin', depsVenv: env }, 'darwin')
  expect(script).toContain(`export KNUAF_DEPS_VENV='${env}'`)
  expect(script).toContain("export KNUAF_DEPS_VENV_READONLY='1'")
  expect(script.split('\n').find((l) => l.startsWith('export PATH='))).toContain(env + '/bin')
})

/**
 * 윈도 cmd 의 `set "K=V"` 의미 모형: 값이 비면 변수를 **지운다**(공식 문서: `변수=` 는 변수 없음). 생성된 배치를 이 모형으로
 * 읽어 실행 직전의 환경을 얻는다 — 실기 cmd 는 실행 자리 필요(맥에서는 문자열+의미 단언).
 */
function cmdEnvAfter(script: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of script.split(/\r?\n/)) {
    const m = /^set "([^=]+)=(.*)"$/.exec(line)
    if (!m) continue
    if (m[2] === '') delete env[m[1]]; else env[m[1]] = m[2].replace(/%%/g, '%')
  }
  return env
}

test('B-01 윈도: 앱 환경이 없어도 KNUAF_DEPS_VENV 는 cmd 해석 뒤에 존재하고, 폴더 밖 절대 경로다', () => {
  const none = 'C:\\Users\\학생\\AppData\\Local\\앱\\deps\\_none'
  for (const depsVenv of [none, undefined]) {
    const script = buildLaunchScript({ ...base, root: 'C:\\논문', agentPath: 'C:\\claude\\claude.exe', depsVenv }, 'win32')
    const env = cmdEnvAfter(script)
    expect(Object.hasOwn(env, 'KNUAF_DEPS_VENV')).toBe(true)
    expect(env.KNUAF_DEPS_VENV).toBe(depsVenv ?? noDepsEnvFallback('win32'))
    expect(env.KNUAF_DEPS_VENV).toMatch(/^[A-Za-z]:\\/)
    expect(env.KNUAF_DEPS_VENV_READONLY).toBe('1')
    expect(script).not.toContain('set "KNUAF_DEPS_VENV="')
  }
})

test('B-01 윈도: 앱 환경 경로의 % 는 막고, 지정한 값 그대로 싣는다', () => {
  const env = 'C:\\Users\\학생%USERNAME%\\AppData\\Local\\앱\\deps\\0123456789abcdef'
  const script = buildLaunchScript({ ...base, root: 'C:\\논문', agentPath: 'C:\\claude\\claude.exe', depsVenv: env }, 'win32')
  expect(script).toContain('set "KNUAF_DEPS_VENV=C:\\Users\\학생%%USERNAME%%\\AppData\\Local\\앱\\deps\\0123456789abcdef"')
  expect(script).toContain('set "KNUAF_DEPS_VENV_READONLY=1"')
})

test('B-01 맥: 생성된 셸 스크립트를 실제로 돌리면 도우미 프로세스가 비어 있지 않은 환경 경로를 받는다', () => {
  test.skip(process.platform === 'win32', 'bash 스크립트를 실제로 해석한다')
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-b01-'))
  try {
    const root = join(dir, '남이 준 논문'); mkdirSync(join(root, '.venv', 'bin'), { recursive: true })
    const agent = join(dir, 'fake-agent'), seen = join(dir, 'seen.txt')
    writeFileSync(agent, `#!/bin/sh\nprintf '%s|%s' "\${KNUAF_DEPS_VENV-<unset>}" "\${KNUAF_DEPS_VENV_READONLY-<unset>}" > '${seen}'\n`)
    chmodSync(agent, 0o755)
    for (const [depsVenv, expected] of [['/u/deps/_none', '/u/deps/_none'], [undefined, noDepsEnvFallback(process.platform)]] as const) {
      const script = join(dir, 'launch.sh')
      writeFileSync(script, buildLaunchScript({ ...base, root, agentPath: agent, depsVenv }, process.platform), { mode: 0o755 })
      const run = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, KNUAF_DEPS_VENV: '/attacker/.venv' } })
      expect(run.status).toBe(0)
      expect(readFileSync(seen, 'utf8')).toBe(`${expected}|1`)
      expect(existsSync(join(root, '.venv', 'bin', 'ran'))).toBe(false)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('본대화·담당 env: subscriptionEnv 가 같은 두 값을 싣고, 사용자 값은 덮는다', () => {
  const saved = { a: process.env[DEPS_VENV_ENV], b: process.env[DEPS_READONLY_ENV] }
  process.env[DEPS_VENV_ENV] = '/attacker/.venv'
  process.env[DEPS_READONLY_ENV] = '0'
  try {
    const env = subscriptionEnv(['/u/deps/k0/bin'], '/u/deps/k0')
    expect(env[DEPS_VENV_ENV]).toBe('/u/deps/k0')
    expect(env[DEPS_READONLY_ENV]).toBe('1')
    // 값을 못 받아도 빈 값·키 없음이 되지 않는다(윈도 빈 값은 변수 삭제) — 존재할 수 없는 고정 경로.
    const none = subscriptionEnv()
    expect(none[DEPS_VENV_ENV]).toBe(noDepsEnvFallback(process.platform))
    expect(none[DEPS_READONLY_ENV]).toBe('1')
  } finally {
    for (const [k, v] of [[DEPS_VENV_ENV, saved.a], [DEPS_READONLY_ENV, saved.b]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('도우미 지시문: 규칙집 거부 코드 둘 다 앱의 준비 단추로 보낸다', () => {
  const text = workFolderInstructions('/tmp/논문')
  expect(text).toContain('deps_venv_readonly')
  expect(text).toContain('deps_venv_empty')
  expect(text).toContain('"패키지 준비"')
  expect(text).not.toContain('(.venv,')
})

test('D1 문구: 옛 폴더 .venv 는 지워도 되고, 이 컴퓨터에서 한 번 준비하면 된다(앱은 지우지 않음)', async () => {
  const { DEPS_COPY, RUNTIME } = await import('../src/renderer/src/copy')
  expect(DEPS_COPY.legacyVenvTitle).toContain('.venv')
  expect(DEPS_COPY.legacyVenvBody).toContain('지워도 돼요')
  expect(DEPS_COPY.legacyVenvBody).toContain('"패키지 준비"')
  // 준비 카드 설명·완료 문구가 더 이상 "프로젝트 폴더 안 .venv" 에 설치한다고 말하지 않는다.
  for (const text of [DEPS_COPY.installCaption, DEPS_COPY.readyBody, RUNTIME.venvStaleAction]) {
    expect(text).not.toMatch(/폴더 안.*\.venv|프로젝트 \.venv/)
  }
})

test('I-04 r2: 목표 환경 전환 실패(deps_activate_failed)는 기본 오류 문구가 아니라 다시 누르는 안내를 가진다', async () => {
  const { errorCopy } = await import('../src/renderer/src/copy')
  const copy = errorCopy('deps_activate_failed')
  expect(copy).not.toEqual(errorCopy('default'))
  expect(copy.action).toContain('"패키지 준비"')
})
