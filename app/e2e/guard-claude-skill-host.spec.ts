/**
 * 설계 §15 2단계 중 **앱 스킬 자리 + 1층 옵션**(§4.1·§4.1-D·§4.2) — Claude 쪽 배선.
 *
 * 스킬이 논문 폴더 밖(`<userData>/skill-host/.claude/skills/knuaf-dev`)으로 나가면 두 가지가
 * 한꺼번에 바뀐다.
 *   1. 폴더 사본을 더 이상 만들지 않는다 — 폴더 `.claude` 가 없어야 CLI 가 그 폴더를 설정으로
 *      읽을 여지가 없다.
 *   2. 폴더 밖 스킬 실행이 전부 권한 카드가 된다 — 그래서 앱 스킬 자리는 **읽기·실행만** 예외로
 *      두고 쓰기는 카드 없이 거절한다(§4.2-1). 이 파일이 그 두 선을 함께 잠근다.
 *
 * 시험은 합성 `userData`/`root` 만 쓴다 — 실 `~/.claude`·학생 자료는 건드리지 않는다.
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  buildLaunchScript, installSkill, setTreeAccess, skillBackupDir, skillSource, skillState, skillTargets, skillVersion,
  VERSION_FILE
} from '../src/main/agent'
import {
  autoAllow, claudeIsolationOptions, hostWriteDecision, SKILL_PROMPT
} from '../src/main/chat/claude'
import { isSkillHostPath, skillHostDir, skillHostRoot } from '../src/main/guard/scope'

const appRoot = resolve(__dirname, '..')
/** 동봉 원본(`resources/skill`) — `pnpm stage:skill` 이 만든다. */
const source = skillSource(appRoot, false, '/nonexistent')
const version = skillVersion(source)

const made: string[] = []
function box(): { root: string; userData: string; host: string } {
  const base = mkdtempSync(join(tmpdir(), 'kd-skill-host-'))
  made.push(base)
  const root = join(base, '논문 폴더')
  const userData = join(base, 'user-data')
  mkdirSync(root, { recursive: true })
  return { root, userData, host: skillHostDir(userData) }
}
test.afterAll(() => {
  for (const dir of made) {
    // 앱 스킬 자리는 읽기 전용으로 잠긴 채 남는다 — 정리 전에 소유자 권한으로 푼다.
    setTreeAccess(dir, true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('설치는 논문 폴더 밖 앱 자리에만 생기고 폴더에 `.claude` 를 만들지 않는다', () => {
  const { root, userData, host } = box()
  const targets = skillTargets(root, userData)
  expect(targets.claude).toBe(host)
  expect(host).toBe(join(userData, 'skill-host', '.claude', 'skills', 'knuaf-dev'))
  expect(skillHostRoot(userData)).toBe(join(userData, 'skill-host', '.claude'))

  expect(skillState(host, version)).toBe('missing')
  expect(installSkill(source, targets.claude, version)).toEqual({ action: 'installed' })

  for (const f of ['SKILL.md', 'references', 'scripts', VERSION_FILE]) expect(existsSync(join(host, f)), f).toBe(true)
  expect(skillState(host, version)).toBe('installed')
  // 폴더 사본은 더 이상 만들지 않는다 — 폴더에 `.claude` 자체가 없어야 한다.
  expect(existsSync(join(root, '.claude'))).toBe(false)
  // Codex 사본은 설계대로 폴더 안 그대로다.
  expect(targets.codex).toBe(join(root, '.agents', 'skills', 'knuaf-dev'))
})

test('표식은 앱 자리 뿌리에 생기고 `gg_update.py` 가 보는 모양 그대로다', () => {
  const { root, userData, host } = box()
  installSkill(source, skillTargets(root, userData).claude, version)
  const marker = JSON.parse(readFileSync(join(userData, 'skill-host', '.knuaf-gui', 'skill-install.json'), 'utf-8')) as {
    schema: string
    installs: { path: string }[]
  }
  expect(marker.schema).toBe('knuaf-gui/skill-install@1')
  expect(marker.installs.map((i) => i.path)).toEqual(['.claude/skills/knuaf-dev', '.agents/skills/knuaf-dev'])
  // `gg_update.py _gui_managed()` 는 부모 폴더 이름(`.claude`)과 표식 두 가지를 본다.
  expect(host.endsWith(join('.claude', 'skills', 'knuaf-dev'))).toBe(true)
  expect(existsSync(join(userData, 'skill-host', '.knuaf-gui', 'skill-install.json'))).toBe(true)
})

test('지문이 어긋나면 백업하고 다시 깔며, 잠긴 자리에서도 EACCES 로 죽지 않는다', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  // 재실행은 아무것도 하지 않는다(잠금을 풀었다 잠그는 일도 없다).
  expect(installSkill(source, target, version)).toEqual({ action: 'unchanged' })

  // 학생이 소유자 권한으로 잠금을 풀고 고친 상황 — 다음 설치는 원본으로 되돌리고 그 사본을 남긴다.
  setTreeAccess(target, true)
  writeFileSync(join(target, 'student-note.txt'), 'preserve me')
  writeFileSync(join(target, VERSION_FILE), 'tampered\n')
  expect(skillState(target, version)).toBe('outdated')

  const third = installSkill(source, target, version)
  expect(third.action).toBe('updated')
  expect(third.backup).toBeTruthy()
  expect(third.backup).toBe(join(skillBackupDir(target), basename(third.backup!)))
  expect(readFileSync(join(third.backup!, 'student-note.txt'), 'utf-8')).toBe('preserve me')
  expect(readFileSync(join(target, VERSION_FILE), 'utf-8').trim()).toBe(version)
  // 백업은 앱 자리 뿌리(플러그인 뿌리 밖)에 남는다 — `skills/` 아래에 두면 스킬로 다시 발견된다.
  expect(readdirSync(join(userData, 'skill-host', '.claude', 'skills'))).toEqual(['knuaf-dev'])
  expect(third.backup!.startsWith(join(userData, 'skill-host', '.knuaf-gui', 'skill-backups'))).toBe(true)
})

test('설치 뒤 앱 자리는 읽기 전용이고 다시 깐 뒤에도 다시 잠긴다', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  expect(statSync(target).mode & 0o222).toBe(0)
  expect(statSync(target).mode & 0o555).toBe(0o555)
  expect(statSync(join(target, 'SKILL.md')).mode & 0o222).toBe(0)
  expect(statSync(join(target, 'scripts')).mode & 0o222).toBe(0)

  // 잠긴 사본은 그냥 덮어쓸 수 없다 — 이 실패가 잠금이 실제로 걸렸다는 증거다.
  expect(() => writeFileSync(join(target, 'SKILL.md'), '# student edit\n')).toThrow(/EACCES|EPERM/)

  // 셸로 직접 덮어쓰려 해도 막힌다 — 판정(hostWriteDecision)을 못 거치는 경로(리다이렉트)의
  // 마지막 그물이 이 잠금이다.
  expect(() => execFileSync('sh', ['-c', `echo pwn > ${JSON.stringify(join(target, 'SKILL.md'))}`], { stdio: 'pipe' })).toThrow()
  expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).not.toContain('pwn')

  // Codex 사본(폴더 안)은 잠그지 않는다 — 학생·다른 도구가 손댈 수 있어야 한다.
  const codex = skillTargets(root, userData).codex
  installSkill(source, codex, version)
  expect(statSync(codex).mode & 0o200).toBe(0o200)
})

test('자동 허용: 앱 자리 읽기·스킬 실행은 통과, 쓰기와 자리 경로를 인자로 준 호출은 막는다', () => {
  const { root, userData, host } = box()
  const script = join(host, 'scripts', 'gg.py').replace(/\\/g, '/')
  const hostFile = join(host, 'SKILL.md').replace(/\\/g, '/')

  // 읽기 — 폴더 밖이지만 앱이 깐 자리다.
  expect(autoAllow(root, 'Read', { file_path: hostFile }, [], userData)).toBe(true)
  expect(autoAllow(root, 'Glob', { path: join(host, 'references') }, [], userData)).toBe(true)
  // 실행 — 인터프리터로 여는 스킬 스크립트 한 조각.
  expect(autoAllow(root, 'Bash', { command: `python3 "${script}" status` }, [], userData)).toBe(true)
  // 스크립트에 붙는 인자는 그 스크립트의 인자다 — 자리 경로가 아니면 그대로 통과.
  expect(autoAllow(root, 'Bash', { command: `python3 "${script}" gg_update.py auto` }, [], userData)).toBe(true)
  // 쓰기 — 실행·읽기 예외는 쓰기까지 덮지 않는다.
  expect(autoAllow(root, 'Write', { file_path: hostFile }, [], userData)).toBe(false)
  expect(autoAllow(root, 'Edit', { file_path: hostFile, old_string: 'a', new_string: 'b' }, [], userData)).toBe(false)
  // 스크립트에게 자기 자리 경로를 인자로 넘기는 호출은 실행 예외가 아니다.
  expect(autoAllow(root, 'Bash', { command: `python3 "${script}" --out "${hostFile}"` }, [], userData)).toBe(false)
  // `..` 로 자리를 벗어나는 호출도 아니다.
  expect(autoAllow(root, 'Bash', { command: `python3 "${host}/../skills/knuaf-dev/scripts/gg.py" status` }, [], userData)).toBe(false)

})

test('쓰기 판정: 앱 자리에 쓰는 도구·명령만 카드 없이 거절하고 읽기·실행은 통과시킨다', () => {
  const { root, userData, host } = box()
  const script = join(host, 'scripts', 'gg.py').replace(/\\/g, '/')
  const hostFile = join(host, 'SKILL.md').replace(/\\/g, '/')

  expect(hostWriteDecision(root, 'Write', { file_path: hostFile }, userData)).toMatchObject({ behavior: 'deny' })
  expect(hostWriteDecision(root, 'Edit', { file_path: hostFile }, userData)).toMatchObject({ behavior: 'deny' })
  expect(hostWriteDecision(root, 'Bash', { command: `cp "${root}/x.md" "${hostFile}"` }, userData)).toMatchObject({ behavior: 'deny' })
  expect(hostWriteDecision(root, 'Bash', { command: `cp x.md "${join(host, 'references', 'a.md')}"` }, userData)).toMatchObject({ behavior: 'deny' })
  // 판정 불가(치환·리다이렉트·인라인 코드)인 명령은 종전과 같은 한계다 — 앱이 뜻을 못 따라가면
  // 경로도 못 짚는다. 그 자리에서 실제로 쓰기를 막는 것은 읽기 전용 잠금이다(아래 시험).

  // 읽기·실행은 거절 대상이 아니다(그 판정은 autoAllow 가 한다).
  expect(hostWriteDecision(root, 'Read', { file_path: hostFile }, userData)).toBeNull()
  expect(hostWriteDecision(root, 'Bash', { command: `python3 "${script}" status` }, userData)).toBeNull()
  // 폴더 안 쓰기는 이 판정과 무관하다.
  expect(hostWriteDecision(root, 'Write', { file_path: join(root, 'draft.md') }, userData)).toBeNull()
  // 지킴이 열쇠가 없으면 기능이 꺼진다.
  expect(hostWriteDecision(root, 'Write', { file_path: hostFile }, undefined)).toBeNull()

  // 경로 판정은 정규화된 절대경로로 한다 — 자리 이름 조각만 흉내낸 폴더는 아니다.
  expect(isSkillHostPath(hostFile, userData)).toBe(true)
  expect(isSkillHostPath(join(root, 'skill-host', '.claude', 'skills', 'knuaf-dev', 'x.md'), userData)).toBe(false)
})

test('첫 프롬프트는 플러그인 이름 고정값이다', () => {
  // `supportedCommands()` 실측: 뿌리 `.claude` 를 플러그인으로 주면 이름이 `.claude:knuaf-dev`.
  // `plugin.json` 을 넣으면 `knuaf-dev:knuaf-dev` 로 바뀌므로 넣지 않는다.
  expect(SKILL_PROMPT).toBe('/.claude:knuaf-dev')
})

test('터미널 스크립트가 같은 1층 인자를 싣는다 — 자리·규칙 파일이 있을 때만', () => {
  const { userData } = box()
  const hostRoot = skillHostRoot(userData)
  const guardFile = join(userData, 'guard', 'rules.md')
  const base = { root: '/tmp/논문', agent: 'claude' as const, agentPath: '/opt/claude', venvBin: null, bundledBin: null, firstPrompt: '시작하기' }

  const plain = buildLaunchScript(base, 'darwin')
  expect(plain).toContain(`exec '/opt/claude' --setting-sources= --strict-mcp-config '--disallowedTools=AskUserQuestion' '시작하기'`)
  expect(plain).not.toContain('--plugin-dir-no-mcp')
  expect(plain).not.toContain('--append-system-prompt-file')
  expect(plain).toContain('export PYTHONDONTWRITEBYTECODE=1')

  const full = buildLaunchScript({ ...base, skillHost: hostRoot, guardPromptFile: guardFile }, 'darwin')
  expect(full).toContain(`--plugin-dir-no-mcp '${hostRoot}' --append-system-prompt-file '${guardFile}' '--disallowedTools=AskUserQuestion'`)

  // 윈도우는 경로를 `/` 로 넘긴다 — 판정(`SKILL_PATH`)이 `\` 를 거부해 모든 실행이 카드가 된다.
  const win = buildLaunchScript({ ...base, root: 'C:\\논문', agentPath: 'C:\\claude\\claude.cmd', skillHost: hostRoot.replace(/\\/g, '/'), guardPromptFile: guardFile.replace(/\\/g, '/') }, 'win32')
  expect(win).toContain('--plugin-dir-no-mcp')
  expect(win).toContain('--append-system-prompt-file')
  expect(win).toContain(hostRoot.replace(/\\/g, '/'))
  expect(win).not.toContain(hostRoot.replace(/\//g, '\\'))
  expect(win).toContain('set "PYTHONDONTWRITEBYTECODE=1"')
})

test('SDK 격리 옵션: 설정 출처 0개 + 엄격 MCP + 앱 자리 플러그인 하나', () => {
  const { userData } = box()
  const opts = claudeIsolationOptions(userData)
  expect(opts.settingSources).toEqual([])
  expect(opts.strictMcpConfig).toBe(true)
  expect(opts.plugins).toEqual([{ type: 'local', path: skillHostRoot(userData), skipMcpDiscovery: true }])
  expect(opts.plugins[0].path).toBe(join(userData, 'skill-host', '.claude'))
  // 지킴이 열쇠가 없으면 플러그인도 없다 — 격리만 건다.
  expect(claudeIsolationOptions(undefined)).toEqual({ settingSources: [], strictMcpConfig: true, plugins: [] })
})
