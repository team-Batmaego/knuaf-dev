// S-01 5단계 D-A(형님 결정: 에이전트의 공유 환경 설치 거부): 도우미가 도는 세 갈래 — 터미널 실행 스크립트
// (맥 .command·윈도 .cmd), 본대화·담당 연결 env(`subscriptionEnv`) — 가 모두 같은 두 값을 싣는다.
//   KNUAF_DEPS_VENV          = 앱 데이터 의존성 환경(준비 전이면 빈 값 — 스킬은 빈 값도 "폴더 .venv 보지 않음"으로 읽는다)
//   KNUAF_DEPS_VENV_READONLY = 1(도우미는 공유 환경에 설치하지 않는다 — 준비는 앱의 '준비하기'만)
// 값이 안 넘어와도(옛 호출자) 빈 값·READONLY 로 닫혀야 한다 — 폴더 .venv 로 떨어지는 기본값이 없어야 한다.
import { expect, test } from '@playwright/test'
import { buildLaunchScript, workFolderInstructions } from '../src/main/agent'
import { DEPS_READONLY_ENV, DEPS_VENV_ENV, subscriptionEnv } from '../src/main/chat/contracts'

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

test('맥 터미널 스크립트: 값이 없으면 빈 값으로 닫는다', () => {
  const script = buildLaunchScript(base, 'darwin')
  expect(script).toContain("export KNUAF_DEPS_VENV=''")
  expect(script).toContain("export KNUAF_DEPS_VENV_READONLY='1'")
})

test('윈도 터미널 스크립트: set 인용 안에 싣고 % 는 막는다', () => {
  const env = 'C:\\Users\\학생%USERNAME%\\AppData\\Local\\앱\\deps\\0123456789abcdef'
  const script = buildLaunchScript({ ...base, root: 'C:\\논문', agentPath: 'C:\\claude\\claude.exe', depsVenv: env }, 'win32')
  expect(script).toContain('set "KNUAF_DEPS_VENV=C:\\Users\\학생%%USERNAME%%\\AppData\\Local\\앱\\deps\\0123456789abcdef"')
  expect(script).toContain('set "KNUAF_DEPS_VENV_READONLY=1"')
  const plain = buildLaunchScript({ ...base, root: 'C:\\논문', agentPath: 'C:\\claude\\claude.exe' }, 'win32')
  expect(plain).toContain('set "KNUAF_DEPS_VENV="')
})

test('본대화·담당 env: subscriptionEnv 가 같은 두 값을 싣고, 사용자 값은 덮는다', () => {
  const saved = { a: process.env[DEPS_VENV_ENV], b: process.env[DEPS_READONLY_ENV] }
  process.env[DEPS_VENV_ENV] = '/attacker/.venv'
  process.env[DEPS_READONLY_ENV] = '0'
  try {
    const env = subscriptionEnv(['/u/deps/k0/bin'], '/u/deps/k0')
    expect(env[DEPS_VENV_ENV]).toBe('/u/deps/k0')
    expect(env[DEPS_READONLY_ENV]).toBe('1')
    const none = subscriptionEnv()
    expect(none[DEPS_VENV_ENV]).toBe('')
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
