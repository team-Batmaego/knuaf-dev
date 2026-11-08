import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { query, type Query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'
import { workFolderInstructions } from '../agent'
import { winSpawn, killTree } from '../win'
import { claudeSpawnOptions } from './claude-spawn'
import type { ConnectionStatus } from '../../shared/chat'
import { CLAUDE_AUTH_COPY } from '../../shared/copy'

export class ClaudeAuthenticationError extends Error {
  constructor() { super(CLAUDE_AUTH_COPY.required) }
}

const AUTH_FAILURE = /\b401\b[^\n]*OAuth access token (?:has expired|is invalid)|Failed to authenticate\.\s*API Error:\s*401\b/i

/** 정상 답변·도구 출력에 인용된 401은 판정하지 않는다. SDK 오류 필드만 읽는다. */
export function claudeAuthenticationFailed(message: unknown): boolean {
  if (message instanceof Error) return AUTH_FAILURE.test(message.message)
  const m = message as { type?: string; error?: string; is_error?: boolean; errors?: unknown[] }
  if (m?.type === 'assistant') return m.error === 'authentication_failed'
  return m?.type === 'result' && m.is_error === true && Array.isArray(m.errors)
    && m.errors.some(e => typeof e === 'string' && AUTH_FAILURE.test(e))
}

/** 작업폴더 밖을 가리키면 null이 아닌 그 경로를 돌려준다(묻는 이유를 문장으로 쓰기 위해). */
function outsideRoot(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const base = resolve(root)
  const abs = resolve(base, value)
  // 한글 경로는 두 가지 형태로 온다. macOS 파일시스템(따라서 앱이 쥔 root)은 NFD 로
  // 분해해 주고, 모델이 답변 텍스트에 써 보낸 경로는 NFC 다. 정규화 없이 문자열로
  // 비교하면 폴더 안의 파일이 "밖"으로 판정된다 — dmg 서명 봉인이 깨진 것과 같은 원인.
  const n = (x: string) => x.normalize('NFC')
  return n(abs) === n(base) || n(abs).startsWith(n(base) + sep) ? null : abs
}

/** 경로를 인자로 받는 도구들. 여기 없는 도구는 자동 허용 대상이 아니다. */
const PATH_TOOLS: Record<string, string[]> = {
  Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'],
  Read: ['file_path'], NotebookEdit: ['notebook_path'],
  Glob: ['path'], Grep: ['path'], LS: ['path']
}

/**
 * 다음 세션의 CLI 권한·동작을 바꾸는 **폴더 안** 파일들. 여기에 쓰는 일은 학생이
 * '매번 묻기'를 골랐으면 반드시 카드로 물어야 한다.
 *
 * 왜: CLI 는 `.claude/settings*.json` 의 `permissions.allow`·`hooks`, 스킬·에이전트의
 * `allowed-tools` 를 앱의 canUseTool **앞에서** 적용한다. 그래서 도우미가 이 파일을 한 번
 * 쓰면 그 다음부터 카드 없이 도구가 돌고 폴더 밖 읽기까지 통과한다 — 실측은
 * `work/knuaf-dev/2026-11-08-v061-settings-security/REPRO-SEC.md`(P2·P5·P9·P15·P19).
 * CLI 버전의 신뢰·git 게이트에 기대지 않는 방어여야 한다(그 게이트는 버전마다 바뀐다).
 */
const PROTECTED_DIRS = ['.claude']
/**
 * **마지막 조각**만 보는 이름들 — 어느 깊이에 있어도 보호한다. 하위 폴더의 CLAUDE.md 도
 * CLI 가 읽기 때문이다(`nestedMemoryAttachmentTriggers`, 동봉 0.3.275 바이너리 확인).
 * 비교는 소문자로 한다(맥 기본 파일시스템이 대소문자를 구분하지 않는다).
 */
const PROTECTED_NAMES = ['claude.md', 'claude.local.md']
/** **루트 바로 아래만** 보호하는 파일들 — CLI 가 작업 폴더 기준으로만 읽는다. */
const PROTECTED_ROOT_FILES = ['.mcp.json', '.claude.json']
/** 앱이 매 전송마다 다시 설치하는 스킬 사본 자리. 실행은 예외, 쓰기는 아니다(자기 규칙을 못 고친다). */
const APP_SKILL_PREFIX = '.claude/skills/'
/** 쓰기가 아니라 읽기만 하는 도구. 권한을 바꾸지 않으므로 보호 경로도 그대로 통과한다. */
const READ_ONLY_TOOLS: Record<string, true> = { Read: true, Glob: true, Grep: true, LS: true }

/**
 * 이 경로가 보호 대상인가. 있으면 폴더 기준 상대경로를 돌려준다(카드에 그대로 보여 준다).
 *
 * **루트 바로 아래만 보면 안 된다.** 동봉 CLI(0.3.275)는 파일 작업이 일어난 폴더마다
 * 그 폴더의 `.claude/skills` 를 스킬 자리로 더하고(`dynamicSkillDirs`, 파일의 폴더에서
 * 루트까지 거슬러 올라간다), 하위 폴더의 CLAUDE.md 도 읽는다
 * (`nestedMemoryAttachmentTriggers`). 그래서 `sub/.claude/skills/x/SKILL.md` 는 실제로
 * 다음 도구를 카드 없이 돌리는 `allowed-tools` 가 될 수 있다 — 검토 2회째 지적.
 *
 * 그래서 **경로 조각**으로 판정한다: 어느 깊이든 `.claude` 조각이 있거나, 마지막 조각이
 * `CLAUDE.md`·`CLAUDE.local.md` 면 보호. `.mcp.json`·`.claude.json` 은 루트 바로 아래만.
 *
 * 문자열만 보면 심볼릭 링크로 빠져나간다(`.claude/p → /tmp`, `p/settings.json`).
 * 그래서 **문자 그대로의 경로**와 **링크를 따라간 실제 경로** 둘 다 본다.
 */
export function protectedRel(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const base = resolve(root)
  const n = (x: string) => x.normalize('NFC').toLowerCase()
  const candidates = [resolve(base, value), realOrSelfDeep(resolve(base, value))]
  // root 자체도 링크일 수 있다(macOS 의 `/var` → `/private/var`). 그래서 기준도 두 형태로 본다.
  const bases = [...new Set([base, realOrSelfDeep(base)])]
  for (const abs of candidates) {
    const a = n(abs)
    for (const raw of bases) {
      const b = n(raw)
      if (a === b || !a.startsWith(b + sep)) continue
      const rel = abs.slice(raw.length + 1)
      const segments = n(rel).split(sep)
      const display = rel.replace(/\\/g, '/')
      if (segments.some((seg) => PROTECTED_DIRS.includes(seg))) return display
      const last = segments[segments.length - 1]
      if (PROTECTED_NAMES.includes(last)) return display
      if (segments.length === 1 && PROTECTED_ROOT_FILES.includes(last)) return display
    }
  }
  return null
}

/**
 * 아직 없는 파일도 **있는 조상까지** 링크를 풀어 실제 자리를 구한다.
 *
 * `realpathSync` 는 대상이 없으면 던지므로, 그대로 쓰면 `.claude` 를 가리키는 링크
 * (`settings-dir/settings.json`)가 링크를 안 따라간 문자열로 남아 보호 목록을 빠져나간다.
 */
function realOrSelfDeep(p: string): string {
  const seen: string[] = []
  let cur = p
  for (;;) {
    try { return join(realpathSync(cur), ...seen.reverse()) } catch { /* 없는 조각은 쌓아 둔다 */ }
    const parent = resolve(cur, '..')
    if (parent === cur) return p
    seen.push(cur.slice(parent.length).replace(/^[\\/]/, ''))
    cur = parent
  }
}

/**
 * 이 조각이 보호 경로를 가리키는 인자들.
 *
 * **모든 인자**를 본다 — 경로 모양(`looksLikePath`)으로 먼저 거르면 슬래시 없는 맨이름이
 * 빠져나간다. `mv stage .claude`·`cp evil.md CLAUDE.md` 는 인자에 `/` 가 없어 경로로
 * 읽히지 않았고, 그래서 자동 허용됐다(검토 SEC-FIX B1 실측). 맨이름은 작업폴더 기준
 * 상대경로로 해석되므로 `resolve` 후 판정하면 그대로 잡힌다.
 *
 * 플래그에 붙은 경로(`-o.claude/x`, `--out=.claude/x`)와 플래그 뒤 값도 본다 —
 * `sort -oFILE`·`cp -t DIR` 처럼 값이 붙거나 따로 오는 문법이 있다.
 */
export function protectedHits(root: string, t: string[]): string[] {
  const out: string[] = []
  for (const a of t.slice(1)) {
    const pieces = [a]
    if (a.startsWith('-')) pieces.push(a.replace(/^-+[A-Za-z0-9_-]*=?/, ''))
    for (const piece of pieces) {
      if (!piece) continue
      const rel = protectedRel(root, piece)
      if (rel && !out.includes(piece)) out.push(piece)
    }
  }
  return out
}

/**
 * 이 조각(실행 파일 + 인자)이 보호 경로를 건드리는가.
 *
 * 예외는 하나뿐이다 — 앱이 설치한 스킬 스크립트를 인터프리터로 여는 모양. 스킬은 매 턴
 * `.claude/skills/…/gg_*.py` 로 도구를 돌리므로 그것까지 물으면 카드가 매번 뜬다.
 * 그 밖에 `tee`·`touch`·`sed -i` 처럼 보호 경로에 닿는 조각은 전부 묻는다.
 */
export function touchesProtected(root: string, t: string[]): boolean {
  const hits = protectedHits(root, t)
  if (!hits.length) return false
  const [exe, ...args] = t
  const [script] = args
  const ownSkill = !!script && !script.startsWith('-') && !script.includes('..')
    && SKILL_PATH.test(script) && SKILL_SCRIPT.test(script)
    && INTERPRETERS.test(exeName(exe))
    && (protectedRel(root, script) ?? '').startsWith(APP_SKILL_PREFIX)
  return !(ownSkill && hits.length === 1 && hits[0] === script)
}

/** JSON·객체를 타입 없이 다루기 위한 좁은 판독기. 값은 모델·외부 파일에서 온다. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 문자열 배열 길이. 배열이 아니면 0. */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** 파일 앞부분만 읽는다 — 프런트매터 확인용. 큰 파일을 통째로 읽지 않는다. */
function head(file: string, bytes = 4096): string {
  try { return readFileSync(file, 'utf-8').slice(0, bytes) } catch { return '' }
}

export type AgentSettingsFinding = { file: string; what: string }

/**
 * 폴더에 **이미 있는** '다음 세션의 권한·동작을 바꾸는' 설정을 찾는다.
 *
 * 쓰기는 autoAllow 가 막지만, 학생이 받은 폴더에 이미 들어 있을 수 있다(내려받은 압축,
 * 다른 사람이 만든 논문 폴더). CLI 는 이런 파일을 앱의 canUseTool **앞에서** 읽으므로
 * 앱이 그 사실을 알아야 학생에게 말할 수 있다. 판정하지 않고 **사실만 모은다** —
 * 무엇을 지울지는 학생이 정한다(앱이 남의 파일을 지우지 않는다).
 */
export function inspectAgentSettings(root: string): AgentSettingsFinding[] {
  const out: AgentSettingsFinding[] = []
  const settings = ['.claude/settings.json', '.claude/settings.local.json']
  for (const rel of settings) {
    let parsed: unknown = null
    try { parsed = JSON.parse(readFileSync(join(root, rel), 'utf-8')) } catch { continue }
    const s = asRecord(parsed)
    if (!s) continue
    const perm = asRecord(s.permissions)
    const allows = countOf(perm?.allow)
    if (allows > 0) out.push({ file: rel, what: `도구를 묻지 않고 허용하는 규칙 ${allows}개` })
    const dirs = countOf(perm?.additionalDirectories)
    if (dirs > 0) out.push({ file: rel, what: `논문 폴더 밖을 여는 폴더 ${dirs}개` })
    const deny = countOf(perm?.deny)
    if (deny > 0) out.push({ file: rel, what: `도구를 막는 규칙 ${deny}개` })
    const hooks = asRecord(s.hooks)
    if (hooks && Object.keys(hooks).length > 0) out.push({ file: rel, what: `도구가 돌 때 함께 실행되는 명령 ${Object.keys(hooks).length}종` })
    if (s.statusLine !== undefined) out.push({ file: rel, what: '상태줄 실행 명령' })
    if (s.apiKeyHelper !== undefined) out.push({ file: rel, what: '계정 키를 꺼내는 명령' })
    const env = asRecord(s.env)
    if (env && Object.keys(env).length > 0) out.push({ file: rel, what: `도우미 환경변수 ${Object.keys(env).length}개` })
    if (s.enableAllProjectMcpServers === true) out.push({ file: rel, what: '폴더의 MCP 서버 전부 켜기' })
  }
  if (existsSync(join(root, '.mcp.json'))) out.push({ file: '.mcp.json', what: '외부 프로그램(MCP 서버) 목록' })
  // 하위 폴더까지 본다 — CLI 는 파일 작업이 일어난 폴더의 `.claude/skills` 도 스킬 자리로
  // 더하므로(dynamicSkillDirs), 루트만 훑으면 고지가 빠진다(검토 2회째 지적).
  const found = walkProtected(root)
  for (const dir of found.claudeDirs) {
    const relDir = relOf(root, dir)
    const agents = listMarkdown(join(dir, 'agents'))
    if (agents.length) out.push({ file: `${relDir}/agents`, what: `도우미 대신 일하는 에이전트 ${agents.length}개` })
    const commands = listMarkdown(join(dir, 'commands'))
    if (commands.length) out.push({ file: `${relDir}/commands`, what: `명령 ${commands.length}개` })
    const skills = listMarkdown(join(dir, 'skills'), true)
    // 앱이 설치한 knuaf-dev 사본은 뺀다 — 매 전송마다 앱이 다시 쓰는 자리다.
    const foreign = skills.filter((p) => !p.includes(`skills${sep}knuaf-dev${sep}`))
    if (foreign.length) out.push({ file: `${relDir}/skills`, what: `앱이 설치하지 않은 스킬 ${foreign.length}개` })
    for (const p of [...agents, ...commands, ...foreign]) {
      if (/^\s*allowed-tools\s*:/m.test(head(p))) out.push({ file: relOf(root, p), what: '스킬·에이전트가 스스로 도구를 허용하는 목록(allowed-tools)' })
    }
  }
  for (const p of found.memoryFiles) out.push({ file: relOf(root, p), what: '폴더 지시문 파일' })
  return out
}

/** 폴더 기준 상대경로. 카드·고지에 그대로 쓴다. */
function relOf(root: string, p: string): string {
  return p.slice(root.length + 1).replace(/\\/g, '/')
}

/** 고지용 탐색 깊이. 논문 폴더 구조는 얕고, 더 깊이 내려가면 오히려 놓친다. */
const INSPECT_MAX_DEPTH = 4
/** 훑지 않는 폴더 — 파일이 많고 CLI 가 그 안의 설정을 읽지 않는다. */
const INSPECT_SKIP: Record<string, true> = {
  '.git': true, '.venv': true, node_modules: true, __pycache__: true,
  '.knuaf-gui': true, dist: true, build: true, out: true, '.cache': true
}

/**
 * 폴더 아래에서 보호 대상을 찾는다 — `.claude` 디렉터리(어느 깊이든)와
 * `CLAUDE.md`·`CLAUDE.local.md`(어느 깊이든).
 *
 * `.claude` 안으로는 더 내려가지 않는다(그 안의 스킬·에이전트는 부른 쪽이 따로 본다).
 * 무거운 폴더는 건너뛴다 — 고지 한 줄 때문에 `.venv` 를 훑을 이유가 없다.
 */
function walkProtected(root: string): { claudeDirs: string[]; memoryFiles: string[] } {
  const claudeDirs: string[] = []
  const memoryFiles: string[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > INSPECT_MAX_DEPTH) return
    let entries: Dirent[] = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isFile()) {
        if (PROTECTED_NAMES.includes(e.name.normalize('NFC').toLowerCase())) memoryFiles.push(p)
        continue
      }
      if (!e.isDirectory() || INSPECT_SKIP[e.name]) continue
      if (e.name.normalize('NFC').toLowerCase() === '.claude') { claudeDirs.push(p); continue }
      visit(p, depth + 1)
    }
  }
  visit(root, 0)
  return { claudeDirs, memoryFiles }
}

/** 디렉터리의 `*.md` 파일 절대경로. `deep` 이면 한 단계 아래(`skills/<name>/SKILL.md`)까지. */
function listMarkdown(dir: string, deep = false): string[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  const out: string[] = []
  for (const name of names) {
    const p = join(dir, name)
    if (name.endsWith('.md')) { out.push(p); continue }
    if (!deep) continue
    try { if (readdirSync(p).includes('SKILL.md')) out.push(join(p, 'SKILL.md')) } catch { /* 파일이면 무시 */ }
  }
  return out
}

/**
 * 셸은 정적으로 가둘 수 없다 — Codex 의 workspace-write 는 OS 샌드박스지만 여기는 아니다.
 * 그래서 샌드박스를 흉내 내지 않고 **좁은 허용 목록**만 둔다: 명령을 이어붙이기 기호로
 * 쪼개어 모든 조각이 (작업폴더 안 gg 계열 스크립트 실행) 또는 (읽기만 하는 도구)일 때만
 * 통과시키고, 한 조각이라도 모르는 것이면 전체를 묻는다.
 *
 * 매번 묻는 쪽이 더 안전해 보이지만 아니다. 학생은 셸 파이프라인을 읽고 판단할 수 없어
 * 결국 늘 "허용"을 누르게 되고, 그러면 정작 위험한 명령에도 그냥 누른다. 경고가 의미를
 * 가지려면 드물어야 한다.
 */
const BENIGN_REDIR = /\s*(?:2>&1|&?>\s*\/dev\/null|2>\s*\/dev\/null)/g
/**
 * 치환·서브셸·리다이렉트·변수가 남아 있으면 조각 단위로 판정할 수 없다.
 *
 * `$` 를 통째로 막는 게 핵심이다. 값을 모르는 채 문자 그대로 보면
 * `cat "$HOME/.ssh/id_rsa"` 가 루트 기준 상대경로로 읽혀 "폴더 안"으로 판정되고,
 * 실행 시점에는 진짜 홈으로 펼쳐진다. 변수를 추적하려면 셸 인터프리터를 써야 하므로
 * 추적하지 않고 묻는다 — 대신 두 공급자 지시문이 변수를 쓰지 말라고 일러둔다.
 *
 * `~` 도 같은 부류인데 처음엔 빠져 있었다. `$HOME` 만 막고 `~` 를 놔두면
 * `cat ~/.ssh/id_rsa` 가 resolve(root, "~/.ssh/id_rsa") = root + "/~/.ssh/id_rsa" 로
 * 접혀 "폴더 안"이 되고, cat 은 읽기 전용 목록에 있으므로 묻지도 않고 통과했다.
 * 펼침은 셸이 하고 판정은 앱이 하니, 펼쳐지는 기호는 전부 판정 불가로 둔다.
 */
const SHELL_UNJUDGEABLE = /[`<>(){}$~]/
/**
 * 폴더 안에 머무르지 않는 도구들. 경로 인자가 전부 폴더 안이어도 **폴더 밖 효과**를 낸다 —
 * 네트워크로 내보내거나, 다른 앱을 몰거나, 권한·설치를 건드린다.
 *
 * 앱의 경계는 "논문 폴더 안" 하나다. 네트워크는 그 경계 밖에서도 가장 바깥이라
 * 여기 둔다. 목록에 없는 평범한 도구는 경로만 폴더 안이면 묻지 않는다.
 */
const OUTSIDE_REACH = new Set([
  'curl', 'wget', 'nc', 'ncat', 'socat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet',
  'sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'launchctl', 'defaults', 'osascript',
  'open', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'git', 'crontab', 'killall'
])
/**
 * 앱이 읽을 수 없는 프로그램을 돌리는 것들. 파일 하나만 넘겨도 그 안에 무엇이 있는지
 * 앱은 모른다 — 스킬이 실제로 돌리는 스크립트만 통과시킨다.
 */
const INTERPRETERS = /^(python3?(\.\d+)?|sh|bash|zsh|node|perl|ruby)$/
/** 스킬이 실제로 돌리는 스크립트들. */
const SKILL_SCRIPT = /(^|[\\/])(gg|gg_[a-z_]+|build_docx|show_research|merge_sections|build_status|lint_[a-z_]+)\.py$/
/**
 * 스킬 스크립트로 인정하는 경로의 문자 집합: 영문자·숫자·한글(완성형과 macOS 의 풀어쓴 자모)·
 * 공백·`.`·`_`·`-`·`/`. 셸이 이 문자들은 펼치지 않으므로 앱이 본 문자열이 그대로 파일 이름이
 * 된다. 따옴표는 이미 벗겨진 뒤다. 그 밖의 문자가 하나라도 있으면 묻는다.
 *
 * 예외는 맨 앞의 윈도우 드라이브 접두 `X:/` 하나다. 지시문이 따옴표 절대경로를 쓰라고 하므로
 * 윈도우에서는 `"C:/Users/…/scripts/gg.py"` 로 온다. 이 접두는 셸이 펼치지 않고 옵션으로
 * 바뀌지도 않는다. 다른 자리의 `:`, `C:` 뒤 `\`, 슬래시 없는 `C:foo` 는 계속 묻는다.
 */
const SKILL_PATH = /^(?:[A-Za-z]:\/)?[A-Za-z0-9\p{Script=Hangul} ._\-/]+$/u
/**
 * 따로 도는 AI 프로그램들. 셸로 띄우면 학생 화면에 보이지 않고 멈출 수도 없으며,
 * 이 대화의 승인·쿼터·로그인 확인을 건너뛴다. 경로가 전부 폴더 안이어도 묻는다.
 *
 * **실행 자리**에서만 본다. `grep claude notes.md`·`echo codex` 는 AI 를 실행하지 않는다.
 * 다른 명령 뒤에 숨기는 길(`env claude`·`xargs claude`·`find -exec`·`sh -c "claude …"`)은
 * 감싸기·실행 플래그·인라인 코드로 이미 묻고, 그 뒤 낱말에 이름이 있으면 카드 문구만 AI 로 바꾼다.
 */
const AI_CLI = new Set([
  'claude', 'codex', 'gemini', 'agy', 'ocx', 'omp', 'opencode', 'ollama', 'aider', 'cursor-agent',
  'qwen', 'kiro-cli'
])
/**
 * 뒤에 오는 낱말을 프로그램으로 실행하는 명령들. 이름만 보면 `env`·`nohup` 이 실행 파일로
 * 읽혀 진짜 실행 파일(AI·인터프리터)이 판정을 빠져나간다. 옵션 문법이 명령마다 달라
 * 뒤 낱말을 다시 판정하지 않고 통째로 묻는다 — 스킬은 이것들을 쓰지 않는다.
 * 윈도우의 실행기(`powershell -EncodedCommand …`·`cmd /c`·`start`)도 같은 부류다.
 */
const LAUNCHERS = new Set([
  'env', 'nohup', 'time', 'timeout', 'gtimeout', 'nice', 'ionice', 'chrt', 'taskset', 'exec', 'command',
  'builtin', 'eval', 'source', '.', 'xargs', 'parallel', 'caffeinate', 'stdbuf', 'unbuffer', 'setsid',
  'script', 'watch', 'arch', 'flock', 'chronic', 'uv', 'uvx', 'pipx', 'bunx', 'bun', 'deno',
  'powershell', 'pwsh', 'cmd', 'start', 'wsl', 'cscript', 'wscript'
])
/** 감싸기에 이것만 붙으면 버전·도움말을 찍을 뿐 아무것도 실행하지 않는다(`uv --version`). */
const INFO_FLAG = /^(-v|-V|--version|-h|--help)$/
/**
 * 셸 상태를 바꾸는 내장 명령. 뒤에 오는 명령이 어떻게 실행될지(변수·별칭·함수·트랩)를
 * 바꾼다. 무엇을 바꾸는지 분석하지 않고 감싸기와 같이 묻는다.
 */
const SHELL_STATE = new Set([
  'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'alias', 'unalias', 'function', 'hash', 'trap'
])
/**
 * 압축을 풀거나 내용을 펼치는 명령. **인자에 보호 경로가 없어도** 압축 안에 들어 있으면
 * 그 자리에 그대로 만들어진다 — `tar xf a.tar` 하나로 `.claude/settings.local.json` 이
 * 생긴다(검토 SEC-FIX I1). 압축 안을 미리 읽어 판정하지 않고 묻는다.
 *
 * 동봉 스킬은 이 명령들을 쓰지 않는다(grep: 문서·스크립트 모두 없음, `zip(` 은 파이썬 내장).
 * 그래서 평소 카드가 늘지 않는다.
 */
const UNPACK = new Set([
  'tar', 'bsdtar', 'gtar', 'unzip', 'ditto', 'cpio', 'gunzip', 'unpigz', '7z', '7za', 'xar'
])
/** 이 옵션이 붙으면 프로그램을 실행하는 평범한 도구들. */
const LAUNCH_FLAGS: Record<string, string[]> = {
  find: ['-exec', '-execdir', '-ok', '-okdir'],
  fd: ['-x', '-X', '--exec', '--exec-batch'],
  fdfind: ['-x', '-X', '--exec', '--exec-batch'],
  rg: ['--pre']
}
/** `X=1 python3 evil.py` — 앞에 붙은 변수 대입은 실행 파일 자리를 가리고 PATH 같은 것을 바꾼다. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * 판정에 쓰는 실행 파일 이름. 맥(APFS 기본)과 윈도우는 대소문자를 가리지 않아 `Claude`·
 * `Python3` 도 그대로 실행되고, 윈도우는 `claude.cmd`·`python.exe` 로 실행된다.
 * 이름 목록과 비교하기 전에 그 차이를 접는다. 접어서 생기는 오판은 더 묻는 쪽뿐이다.
 */
function exeName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

/**
 * 명령을 조각(`;`·`|`·`||`·`&&`)과 낱말로 나눈다. 판단할 수 없으면 null.
 *
 * 셸 파서를 흉내 내지 않는다. 셸이 다르게 읽을 수 있는 형태를 만나면 판정을 포기한다:
 * - 따옴표 밖 `\`(이스케이프), 따옴표 안 `\"`·`\\` 같은 이스케이프, 닫히지 않은 따옴표.
 * - 단일 `&`. 앞을 뒤로 돌리고 뒤를 따로 실행한다(`command -v claude & claude -p x`).
 * - 실행 자리 낱말에 따옴표가 섞인 것(`'cl'aude`·`e"nv"`). 셸은 이어 붙여 `claude`·`env` 를
 *   실행한다. 통째로 감싼 `"/…/.venv/bin/python"` 은 그대로 읽는다(지시문이 그렇게 쓰라고 한다).
 * - 실행 자리의 `*`·`?`·`[`. 셸이 파일 이름으로 펼친다(`/opt/homebrew/bin/cl?ude`).
 * 따옴표 안의 `;`·`|`·`&` 는 글자다(`rg "claude|codex" notes.md` 는 한 조각).
 */
function parseShell(raw: string): string[][] | null {
  // 따옴표 안의 윈도우 경로 구분자(\)만 슬래시로 바꿔 읽는다.
  // 따옴표 안의 이스케이프(\\"·\\$·\\`)와 따옴표 밖의 `\`는 셸이 다르게 읽으므로 판정 불가다.
  const cmd = raw.replace(BENIGN_REDIR, ' ')
  if (SHELL_UNJUDGEABLE.test(cmd) || /\n/.test(cmd)) return null
  const norm = cmd.replace(/"[^"]*"/g, (g) => g.replace(/\\(?=[A-Za-z0-9\p{Script=Hangul}._\-/:\\])/gu, '/'))
  const segs: string[][] = []
  let seg: string[] = []
  let word: string | null = null
  let parts = 0                    // 낱말을 이루는 따옴표 구간·맨 글자 구간 수
  let quoted = false
  let exeMixed = false
  const endWord = () => {
    if (word === null) return
    if (!seg.length && quoted && parts > 1) exeMixed = true
    seg.push(word); word = null; parts = 0; quoted = false
  }
  const endSeg = () => { endWord(); if (seg.length) segs.push(seg); seg = [] }
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i]
    if (c === '"' || c === "'") {
      const close = norm.indexOf(c, i + 1)
      if (close < 0) return null
      const body = norm.slice(i + 1, close)
      if (c === '"' && /\\["\\$`]/.test(body)) return null
      word = (word ?? '') + body; parts++; quoted = true; i = close
    } else if (c === '\\') return null
    else if (/\s/.test(c)) endWord()
    else if (c === ';') endSeg()
    else if (c === '|') { endSeg(); if (norm[i + 1] === '|') i++ }
    else if (c === '&') { if (norm[i + 1] !== '&') return null; endSeg(); i++ }
    else {
      if (word === null || /["']/.test(norm[i - 1] ?? '')) parts++
      word = (word ?? '') + c
    }
  }
  endSeg()
  if (exeMixed || segs.some((t) => /[*?[]/.test(t[0]))) return null
  return segs
}

type Reason = { kind: 'reach' | 'ai' | 'launch' | 'state' | 'interp' | 'unpack'; name: string }
/**
 * 경로와 별개로, 이 조각을 묻는 이유. 없으면 null.
 *
 * 자동 허용과 카드 문구가 같은 판정을 쓴다 — 둘이 따로 놀면 "묻지 않은 이유"와
 * "물은 이유"가 어긋난다.
 */
function segmentReason(t: string[]): Reason | null {
  const [exe, ...args] = t
  const base = exeName(exe)
  // 찾아보기만 하고 실행하지 않는다 — 환경 점검에 `command -v kordoc pnpm node` 가 실제로 쓰였다.
  if (['which', 'type', 'whereis'].includes(base) || (base === 'command' && /^-[vV]$/.test(args[0] ?? ''))) return null
  if (AI_CLI.has(base)) return { kind: 'ai', name: base }
  if (OUTSIDE_REACH.has(base)) return { kind: 'reach', name: base }
  if (UNPACK.has(base)) return { kind: 'unpack', name: base }
  let runs: Reason | null = null
  if (ASSIGNMENT.test(exe)) runs = { kind: args.length ? 'launch' : 'state', name: exe.split('=')[0] + '=' }
  else if (SHELL_STATE.has(base)) runs = { kind: 'state', name: base }
  else if (LAUNCHERS.has(base) && args.length && !args.every((a) => INFO_FLAG.test(a))) runs = { kind: 'launch', name: base }
  else if (INTERPRETERS.test(base)) {
    // 인터프리터는 **첫 인자가 스킬 스크립트 파일**일 때만 통과한다. 그 앞에 옵션이 하나라도
    // 오면 묻는다 — 옵션은 묶을 수 있어(`-xc`·`-lc`·`-cc`) 하나씩 맞춰 보면 빠진다.
    // `bash -xc "echo; claude scripts/gg.py"` 는 인라인 코드 문자열이 `/gg.py` 로 끝나
    // 스킬 스크립트로 읽혔다(FIXCHECK AUTO-FIX-01). 첫 인자 자리라면 셸·파이썬은 그것을
    // 코드가 아니라 파일 이름으로 연다. 버전·도움말 조회와 인자 없는 실행은 그대로 둔다.
    // 셸이 펼치기 전 문자열로 판정하므로, 스킬 파일은 **펼쳐도 모양이 바뀌지 않는 문자만** 든
    // 경로로 인정한다(SKILL_PATH). 막을 문자를 나열하지 않는다 — `python3 */gg.py -m helper`
    // 의 `*/gg.py` 는 `-Wignore/gg.py` 같은 옵션으로 펼쳐져 뒤의 `-m` 이 실행됐다(FIXCHECK2).
    // 공백은 허용한다: 맥 기본 폴더 이름("무제 폴더")이 경로에 들어간다.
    const [script] = args
    const skill = !!script && !script.startsWith('-') && SKILL_PATH.test(script) && SKILL_SCRIPT.test(script)
    if (args.length && !skill && !args.every((a) => INFO_FLAG.test(a))) runs = { kind: 'interp', name: base }
  } else {
    const flags = LAUNCH_FLAGS[base] ?? []
    const flag = args.find((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)))
    if (flag) runs = { kind: 'launch', name: `${base} ${flag.split('=')[0]}` }
  }
  if (!runs) return null
  // 감싸기·인라인 코드 뒤에서 실행되는 AI 는 카드에 AI 라고 말한다.
  const ai = args.flatMap((a) => a.split(/[\s=;]+/)).map(exeName).find((w) => AI_CLI.has(w))
  return ai ? { kind: 'ai', name: ai } : runs
}

/**
 * 이 낱말이 "경로처럼 생겼는가" — 폴더 밖 검사를 걸어야 하는지 정한다.
 *
 * 윈도우에는 구분자가 둘(`/`·`\`)이고 드라이브 문자(`C:`)·UNC(`\\server\share`)가 따로 있다.
 * `/` 만 보면 `D:\…\재무계획.xlsx` 가 평범한 낱말로 읽혀 **폴더 밖 검사를 통째로 건너뛴다** —
 * 폴더 밖 파일을 읽는 셸 명령이 묻지 않고 자동 허용되던 구멍이다(형님 승인 W1 연결 기제 ③).
 *
 * 맥에서는 종전 그대로 `/` 만 본다 — 거기서 `\` 는 **파일명에 들어갈 수 있는 글자**라
 * 구분자로 읽으면 안 된다(맥 판정 불변).
 */
export function looksLikePath(a: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === '.' || a === '..') return true
  if (a.includes('/')) return true
  if (platform !== 'win32') return false
  return a.includes('\\') || /^[A-Za-z]:/.test(a)
}

/** 경로처럼 생긴 인자는 전부 작업폴더 안이어야 한다. 플래그와 평범한 낱말은 통과. */
function argsInRoot(root: string, args: string[]): boolean {
  return args.every((a) => a.startsWith('-') || !looksLikePath(a) || outsideRoot(root, a) === null)
}

/**
 * 이 명령을 묻지 않고 통과시켜도 되는가. 모든 조각이 묻는 이유 없이 폴더 안이어야 한다.
 *
 * 예전에는 아홉 개짜리 읽기 전용 목록이었다. 그래서 `shasum <폴더 안 파일>`,
 * `find <폴더 안>`, `mkdir -p <폴더 안>` 같은 것이 전부 승인 창을 띄웠고,
 * 시험주행에서는 메시지 여덟 개 도는 동안 카드가 여섯 번 떴다. 전부 폴더 안 일이었다.
 *
 * 읽지도 못할 것을 반복해서 클릭하게 만들면 그건 보호가 아니라 습관적 승인을 기르는
 * 일이다. 그래서 파일 도구에 이미 적용하던 선을 셸에도 같게 적용한다 —
 * **경로가 전부 논문 폴더 안이면 묻지 않는다.** 폴더 밖으로 나가는 도구와 앱이 읽을 수
 * 없는 프로그램만 계속 묻는다.
 */
function isSkillCommand(root: string, input: unknown): boolean {
  const raw = (input as { command?: unknown })?.command
  if (typeof raw !== 'string' || !raw.trim()) return false
  const segs = parseShell(raw)
  return !!segs?.length && segs.every((t) => segmentReason(t) === null && argsInRoot(root, t.slice(1)))
}

/**
 * Bash 명령의 인자 중 작업폴더 밖을 가리키는 경로만 모은다.
 *
 * isSkillCommand 와 규칙은 같지만 묻는 것이 다르다. 저쪽은 "통과시킬까",
 * 이쪽은 "학생에게 뭐라고 말할까"다. 이게 없으면 PATH_TOOLS 에 Bash 가 없는 탓에
 * 폴더 밖 파일을 읽는 명령에도 "논문 폴더 안에서 도구를 돌리는 명령이면 허용해도 돼요"가
 * 붙는다. 물어본 이유와 정반대를 읽은 학생은 그대로 허용을 누르고, 그 옆이
 * "이 폴더에서는 계속 허용"이라 한 번의 오독이 폴더 전체 신뢰로 굳는다.
 */
function bashOutside(root: string, segs: string[][]): string[] {
  const out: string[] = []
  for (const t of segs) {
    // 실행 파일 자체(/usr/bin/grep 등)는 뺀다 — argsInRoot 와 같은 범위.
    for (const a of t.slice(1)) {
      if (a.startsWith('-') || !looksLikePath(a)) continue
      const o = outsideRoot(root, a)
      if (o && !out.includes(o)) out.push(o)
    }
  }
  return out
}

/**
 * 승인 통로가 이미 닫힌 뒤에 들어온 도구 호출의 흔적.
 *
 * SDK 는 문자열 prompt 를 단일 턴으로 보고 첫 `result` 에서 CLI 의 stdin 을 닫는다.
 * 그 뒤의 쓰기 계열 호출은 요청이 전송되기도 전에 죽어 `canUseTool` 이 불리지 않고,
 * 앱은 승인 창을 띄울 기회조차 없다. 학생 화면에는 아무 일도 없었던 것처럼 보이고
 * 도우미만 "쓰기 권한이 차단됐다"고 말한다(시험주행 발견 11).
 *
 * 막을 수는 없어도 **말할 수는 있다.** 실패한 도구 결과는 앱이 이미 읽고 있는
 * 메시지 스트림에 그대로 흘러오므로 여기서 집어 낸다.
 */
const PERMISSION_LOST = /Tool permission request failed/i

/** 이 메시지에 "승인 통로가 닫혀 죽은 도구 호출"이 몇 건 들어 있는가. */
/** SDK 가 받는 추론 강도. 알 수 없는 값은 조용히 무시한다 — 오타로 세션이 죽지 않게. */
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function lostToolCalls(message: unknown): number {
  const content = (message as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    const b = block as { type?: unknown; is_error?: unknown; content?: unknown }
    if (b?.type !== 'tool_result' || b.is_error !== true) continue
    const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
    if (PERMISSION_LOST.test(body)) n++
  }
  return n
}

/** 원시 JSON 대신 학생이 읽을 수 있는 한 문장. 자세한 값은 그대로 덧붙인다. */
function describeTool(name: string, input: unknown, root: string): { title: string; detail: string } {
  const keys = PATH_TOOLS[name] ?? []
  const hit = keys.map((k) => argOf(input, k)).map((v) => protectedRel(root, v)).find(Boolean)
  if (hit && !READ_ONLY_TOOLS[name]) {
    return { title: '도우미의 권한을 바꾸는 파일이에요', detail: `대상: ${hit}\n\n이 파일은 다음에 도우미가 무엇을 묻지 않고 할 수 있는지를 정해요. 마음에 들지 않으면 거절해 주세요. 거절해도 논문 쓰는 일은 그대로 됩니다.` }
  }
  const outside = keys.map((k) => outsideRoot(root, argOf(input, k))).find(Boolean)
  if (outside) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `대상: ${outside}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
  const cmd = argOf(input, 'command')
  if (name === 'Bash' && typeof cmd === 'string') {
    const segs = parseShell(cmd)
    if (segs === null) return { title: '앱이 읽을 수 없는 명령이에요', detail: `${cmd}\n\n변수나 기호가 섞여 있어 무엇을 건드릴지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    const out = bashOutside(root, segs)
    if (out.length) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `${cmd}\n\n폴더 밖: ${out.join(', ')}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
    // 폴더 밖이 아니면 권한 파일을 건드리는지 본다. 둘 다 걸리면 폴더 밖을 먼저 말한다 —
    // 밖으로 나가는 쪽이 학생에게 더 큰 사실이고, 권한 파일은 그 다음 문제다.
    const guarded = segs.flatMap((t) => (touchesProtected(root, t) ? protectedHits(root, t) : []))
    if (guarded.length) return { title: '도우미의 권한을 바꾸는 파일이에요', detail: `${cmd}\n\n대상: ${guarded.join(', ')}\n\n이 파일은 다음에 도우미가 무엇을 묻지 않고 할 수 있는지를 정해요. 마음에 들지 않으면 거절해 주세요.` }
    // 여기까지 왔다는 것은 autoAllow 가 통과시키지 않았다는 뜻이다. 이유를 사실대로
    // 나눠 말한다 — 예전에는 무엇에 걸렸든 "경로는 모두 논문 폴더 안이에요"라고 단정해서,
    // 경로 인자가 하나도 없는 명령(`command -v …`)에도 그렇게 적혔다(시험주행 발견 6).
    // 여러 조각이 걸리면 바깥 효과가 큰 쪽을 먼저 말한다.
    const reasons = segs.map(segmentReason).filter((r): r is Reason => r !== null)
    const first = (kind: Reason['kind']) => reasons.find((r) => r.kind === kind)
    const reach = first('reach')
    if (reach) return { title: '논문 폴더 밖으로 나가는 명령이에요', detail: `${cmd}\n\n"${reach.name}" 는 네트워크·다른 앱·설치처럼 폴더 밖에 닿아요. 의도한 일이 아니면 거절해 주세요.` }
    const ai = first('ai')
    if (ai) return { title: '다른 AI 프로그램을 부르는 명령이에요', detail: `${cmd}\n\n"${ai.name}" 는 이 대화 밖에서 따로 도는 AI예요. 화면에 보이지 않고 멈출 수도 없어요. 의도한 일이 아니면 거절해 주세요.` }
    const launch = first('launch')
    if (launch) return { title: '다른 프로그램을 대신 실행하는 명령이에요', detail: `${cmd}\n\n"${launch.name}" 뒤에 오는 것이 실제로 실행돼요. 무엇이 실행될지 앱이 미리 확인하지 못해요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    const unpack = first('unpack')
    if (unpack) return { title: '압축을 풀어 파일을 만드는 명령이에요', detail: `${cmd}\n\n"${unpack.name}" 는 압축 안에 든 파일을 그대로 꺼내 놓아요. 앱이 그 안을 미리 확인하지 못해요. 의도한 일이 아니면 거절해 주세요.` }
    const state = first('state')
    if (state) return { title: '셸 설정을 바꾸는 명령이에요', detail: `${cmd}\n\n"${state.name}" 는 뒤에 오는 명령이 실행되는 방식을 바꿀 수 있어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    if (first('interp')) return { title: '앱이 읽을 수 없는 프로그램을 실행해요', detail: `${cmd}\n\n프로그램 안에 무엇이 있는지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    return { title: '컴퓨터에서 명령을 실행하려고 해요', detail: `${cmd}\n\n앱이 폴더 안 일이라고 확인하지 못한 명령이에요. 무슨 일인지 모르겠으면 거절해 주세요.` }
  }
  return { title: `도우미가 "${name}" 도구를 쓰려고 해요`, detail: JSON.stringify(input, null, 2) }
}

/** 도구 입력에서 경로 인자 하나를 꺼낸다. 입력은 모델이 보낸 것이라 타입을 믿지 않는다. */
function argOf(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object' || !(key in input)) return undefined
  return (input as Record<string, unknown>)[key]
}

/** 자동 허용 판정 — 클래스 밖 순수 함수로 두어 테스트가 직접 고정한다(권한 경계). */
export function autoAllow(root: string, name: string, input: unknown, allowed: string[] = []): boolean {
  const ok = (v: unknown) => outsideRoot(root, v) === null || (typeof v === 'string' && allowed.includes(realOrSelf(resolve(root, v)).normalize('NFC')))
  const keys = PATH_TOOLS[name]
  if (keys) {
    const values = keys.map((k) => argOf(input, k))
    if (!values.every(ok)) return false
    // 폴더 안이어도 권한 파일은 묻는다 — 도우미가 자기 권한을 스스로 넓히는 통로를 막는다.
    if (!READ_ONLY_TOOLS[name] && values.some((v) => protectedRel(root, v) !== null)) return false
    return true
  }
  if (name === 'Bash') {
    const raw = argOf(input, 'command')
    const segs = typeof raw === 'string' ? parseShell(raw) : null
    // 셸로 보호 경로를 쓰는 길(`tee .claude/settings.local.json`)도 카드로 돌린다.
    if (segs?.some((t) => touchesProtected(root, t))) return false
    return isSkillCommand(root, input)
  }
  return false
}

/**
 * project.json 에 등록된 출처 파일은 폴더 밖이어도 학생이 직접 이름을 댄 파일이다
 * (재무 엑셀·학교 지침 PDF 등). 학생이 알려준 파일을 읽는 것까지 묻지는 않는다.
 * 읽기 전용 판정이 아니라 "이 경로는 안다"는 뜻이므로, 셸 실행에는 적용하지 않는다.
 */
export function registeredSources(root: string): string[] {
  try {
    const p = JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { sources?: Record<string, { path?: unknown }> }
    return Object.values(p.sources ?? {})
      .map((s) => (typeof s?.path === 'string' ? realOrSelf(resolve(root, s.path)).normalize('NFC') : null))
      .filter((x): x is string => !!x)
  } catch { return [] }
}

function realOrSelf(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

export { describeTool }

export class ClaudeConnection implements AgentConnection {
  private active?: Query
  private loginProcess?: ChildProcess
  private loginUnconfirmed = false
  /** 계정 복구 판정은 실제 로그인 시도의 성공 종료와 status 응답을 함께 본다. */
  get loginConfirmed(): boolean { return !this.loginUnconfirmed }
  private controller?: AbortController
  private approvals = new Map<string, (allow: boolean) => void>()
  constructor(private options: AgentOptions) {}
  private autoAllowed(name: string, input: unknown): boolean {
    return autoAllow(this.options.root, name, input, registeredSources(this.options.root))
  }
  /**
   * 폴더에 이미 있는 '권한을 바꾸는 설정'을 학생에게 한 번 알린다.
   *
   * 판정하지 않고 사실만 적는다 — 앱은 남의 파일을 지우지 않는다. 문구는 "무엇이 있는지"와
   * "무엇을 하면 되는지" 두 가지만 담는다. 도구 이름·키 이름은 학생에게 의미가 없으므로
   * 쓰지 않는다(실제 키는 `what` 문장 안에서 이미 풀어 썼다).
   */
  private noteExistingSettings(events: AgentEvents): void {
    const findings = inspectAgentSettings(this.options.root)
    if (!findings.length) return
    const shown = findings.slice(0, 4).map((f) => `· ${f.file} — ${f.what}`)
    if (findings.length > shown.length) shown.push(`· 그 밖에 ${findings.length - shown.length}건`)
    events.note(`이 폴더에 도우미의 권한을 바꾸는 설정이 이미 들어 있어요. 앱이 만든 것이 아닙니다.\n${shown.join('\n')}\n\n모르는 것이면 지우거나, 다른 폴더에서 작업해 주세요.`)
  }
  /**
   * `auth status` 의 JSON 만이 로그인 여부의 근거다. 실행 실패·시간 초과·깨진 JSON 은
   * "로그인 필요"가 아니라 "확인하지 못했어요"다 — 예전에는 셋 다 조용히 `connected:false`
   * 로 접혀서, CLI 가 잠깐 멈추기만 해도 학생에게 로그인을 다시 시키는 문구가 떴다
   * (IMPL-R1-04). `probe:'failed'` 가 그 구분이고, 폴더별 화면도 같은 필드를 쓴다.
   */
  async status(): Promise<ConnectionStatus> {
    // auth status는 만료된 자격정보에도 loggedIn:true일 수 있다. 새 로그인 프로세스가
    // 성공 종료하기 전에는 그 옛 응답으로 재인증 성공을 선언하지 않는다.
    if (this.loginProcess) return { installed: true, connected: false, version: null, probe: 'ok', detail: CLAUDE_AUTH_COPY.required }
    let output = ''
    // 윈도우에서 npm 이 깐 claude 는 `.cmd` 다 — Node 가 셸 없이 띄우지 못해 cmd.exe 로 감싼다
    // (맥·리눅스와 `.exe` 는 그대로 — winSpawn 이 빈 옵션을 돌려준다).
    const probe = winSpawn(this.options.binary, ['auth', 'status'])
    try { output = (await promisify(execFile)(probe.command, probe.args, { env: this.options.env, timeout: this.options.statusTimeoutMs ?? 12_000, ...probe.options })).stdout }
    catch (e) { output = (e as { stdout?: string }).stdout ?? '' }
    let r: Record<string, unknown> | null = null
    try { const parsed = JSON.parse(output); if (parsed && typeof parsed === 'object') r = parsed as Record<string, unknown> } catch { /* 실행 실패·시간 초과·깨진 JSON → 확인 실패 */ }
    if (!r) return { installed: true, connected: false, version: null, probe: 'failed', detail: 'Claude 연결 상태를 확인하지 못했어요. 잠시 후 "다시 확인"을 눌러 주세요.' }
    const connected = !this.loginProcess && r.loggedIn === true && r.authMethod === 'claude.ai' && r.apiProvider === 'firstParty'
    return { installed: true, connected, version: null, probe: 'ok', detail: connected ? '' : 'Claude 구독 계정 로그인이 필요해요. 개인용 검증만 지원하며 API로 자동 전환하지 않아요.' }
  }
  async login() {
    if (this.loginProcess) throw new Error('브라우저에서 진행 중인 로그인을 완료해 주세요.')
    // Official CLI owns credential storage and prints an auth URL — surface it in the
    // student's browser instead of letting it die on a pipe nobody reads.
    // 윈도우의 `.cmd` 는 cmd.exe 로 감싼다(status 와 같은 이유 — winSpawn).
    const spec = winSpawn(this.options.binary, ['auth', 'login', '--claudeai'])
    this.loginUnconfirmed = true
    const child = this.loginProcess = spawn(spec.command, spec.args, { env: this.options.env, stdio: ['ignore', 'pipe', 'pipe'], ...spec.options })
    let buf = ''
    let opened = false
    const onData = (d: Buffer) => {
      if (opened) return
      buf += d.toString()
      const m = /https:\/\/\S+/.exec(buf)
      if (m) { opened = true; void this.options.openExternal(m[0].replace(/[)\].,;]+$/, '')) }
    }
    child.stdout?.on('data', onData); child.stderr?.on('data', onData)
    /**
     * 소유권은 자식마다 자기 것이다. 예전에는 종료·오류 콜백이 무조건 `loginProcess` 를
     * 비웠는데, 그러면 `login(A) → reopenLogin(B) → A 종료` 순서에서 **살아 있는 B 의
     * 추적이 지워진다.** 그 뒤 취소·stop 은 B 를 찾지 못해 로그인 프로세스가 그대로 남는다
     * (P2-R1-02). 지금 소유자일 때만 비운다.
     */
    const release = () => { if (this.loginProcess === child) this.loginProcess = undefined }
    child.on('error', release)
    child.on('close', (code) => {
      if (this.loginProcess === child && code === 0) this.loginUnconfirmed = false
      release()
    })
    const timer = setTimeout(() => { release(); killTree(child) }, 180_000)
    timer.unref(); child.once('close', () => clearTimeout(timer))
  }
  /** 취소 = 이 창에서 기다리기를 그만둔다. CLI 가 소유한 로그인 프로세스를 끝낸다. */
  async cancelLogin() {
    const child = this.loginProcess
    this.loginProcess = undefined
    // 윈도우에서 `.cmd` 로 감싼 로그인 자식도 트리째 끝낸다 — 손자가 남으면 로그인이 계속 산다.
    if (child) killTree(child)
  }
  /**
   * 다시 열기 = 지금 프로세스를 끝내고 처음부터 다시 시작한다. Claude CLI 가 브라우저를
   * 직접 열기 때문에 URL 을 앱이 쥐고 있을 수 없다 — 새 프로세스가 새 주소를 연다.
   */
  async reopenLogin() {
    await this.cancelLogin()
    await this.login()
  }
  async run(text: string, sessionId: string | undefined, events: AgentEvents) {
    if (!(await this.status()).connected) throw new Error('Claude 구독 계정 로그인을 완료해 주세요.')
    this.controller = new AbortController()
    // '매번 묻기'인데 폴더에 권한을 바꾸는 설정이 이미 있으면 첫 턴에 한 번 말한다.
    // 앱이 그 파일을 읽지 않게 했어도(위 settingSources) CLI 는 읽으므로, 학생이 그 사실을
    // 모른 채 대화를 시작하면 안 된다. 매 턴 반복하지 않는다 — 알림이 소음이 되면 안 읽는다.
    if (!sessionId && !this.options.trusted?.()) this.noteExistingSettings(events)
    // 첫 프롬프트에 논문 작업 폴더 경계와 스킬 생성 폴더 허용을 명시한다.
    const q = this.active = query({ prompt: sessionId ? text : `/knuaf-dev ${text}\n\n${workFolderInstructions(this.options.root)}`, options: {
      cwd: this.options.root, pathToClaudeCodeExecutable: this.options.binary,
      ...claudeSpawnOptions(this.options.binary),
      // The project's own skill copy stays authoritative — a stale ~/.claude/skills
      // cannot shadow or mix with it. The external .command launcher pins the same
      // scope (buildLaunchScript in ../agent.ts).
      // `local` 은 뺀다. `.claude/settings.local.json` 의 permissions.allow 가 CLI 에서
      // canUseTool **앞에** 적용돼 카드·폴더 경계를 통째로 끄는 통로였다(REPRO-SEC P2·P6·P15).
      // `project` 는 남긴다 — 스킬·CLAUDE.md 발견이 이 소스에 걸려 있다. 그 대신 쓰기는
      // autoAllow 가 막고, 이미 있는 project 설정은 inspectAgentSettings 가 학생에게 알린다.
      env: this.options.env, settingSources: ['project'],
      resume: sessionId, abortController: this.controller, permissionMode: 'default',
      // 모델·추론 강도 핀. 미설정이면 CLI 기본값을 그대로 쓴다 — 학생 설정을 덮지 않는다.
      // (live 스펙이 sonnet 으로 비용을 낮추는 데도 같은 통로를 쓴다.)
      ...(this.options.env.KNUAF_CLAUDE_MODEL ? { model: this.options.env.KNUAF_CLAUDE_MODEL } : {}),
      ...(CLAUDE_EFFORTS.has(this.options.env.KNUAF_CLAUDE_EFFORT ?? '')
        ? { effort: this.options.env.KNUAF_CLAUDE_EFFORT as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '이 세션은 개인용 knuaf-dev GUI입니다. knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 질문과 답변은 채팅 텍스트로 유지하고 인터뷰 원문과 해석을 스킬의 로그 계약대로 기록하세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요. 서브에이전트를 백그라운드로 띄우지 마세요(run_in_background 금지). 턴이 끝난 뒤에 도구를 쓰면 승인 통로가 이미 닫혀 있어 그 작업은 반드시 실패합니다.' },
      // 백그라운드 서브에이전트를 막는 것은 취향이 아니다. SDK 는 문자열 prompt 를 단일
      // 턴으로 보고 첫 result 에서 CLI 의 stdin 을 닫는다(sdk.mjs: isSingleUserTurn).
      // 그 뒤에 오는 쓰기 계열 호출은 승인 요청이 전송되기도 전에
      // "AbortError: Stream closed" 로 죽고, canUseTool 은 호출조차 되지 않는다 —
      // 앱은 승인 창을 띄울 기회조차 없고 도우미는 그것을 "쓰기 권한 차단"으로 읽는다
      // (시험주행 발견 11, 재현으로 확인). 제대로 된 해법은 세션 동안 stdin 을 열어 두는
      // 스트리밍 입력이며 연결 수명 구조를 바꿔야 한다. 그때까지는 말로 막는다.
      canUseTool: async (name, input, options): Promise<PermissionResult> => {
        if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'knuaf-dev 인터뷰 지침에 따라 질문을 채팅 텍스트로 제시하세요.' }
        // 작업폴더 안에서 하는 일은 학생이 이미 요청한 일이다 — 그 폴더를 직접 골라
        // "여기에 논문을 써 달라"고 한 것이 동의다. Codex 는 sandbox: 'workspace-write'
        // 로 같은 선을 이미 긋고 있고(codex.ts), 앱의 미리보기·저장은 메인 프로세스가 현재
        // 논문 폴더/insideRoot 를 확인하며, 사이드카도 _confine() 으로 같은 선을 긋는다.
        //
        // 매번 묻는 것은 동의를 구하는 게 아니라 읽지도 못할 것을 클릭하게 만드는 일이고,
        // 그러면 정작 폴더 밖을 건드리는 순간에도 습관적으로 허용을 누르게 된다.
        if (this.autoAllowed(name, input)) return { behavior: 'allow', updatedInput: input }
        // 여기서 통과하는 두 경우가 있다. (1) 설정의 "도우미가 도구를 쓸 때 물어볼까요?"
        // 가 기본값 '묻지 않기'다 — 그러면 폴더를 가리지 않고 통과한다. (2) 학생이 권한
        // 카드에서 "이 폴더에서는 계속 허용"을 직접 눌렀다.
        //
        // 기본을 묻지 않기로 둔 것은 편의를 위한 결정이고, 무엇을 포기하는지는 설정
        // 화면에 그대로 적혀 있다(도우미는 폴더 밖 PDF·웹 문서도 읽고, 그 안에 섞인
        // 지시를 앱이 걸러 주지 않는다). 물어보기로 되돌리면 위의 autoAllow 가 폴더 안
        // 일을 걸러 주므로, 그때 남는 질문은 폴더 밖·읽을 수 없는 명령뿐이다.
        if (this.options.trusted?.()) return { behavior: 'allow', updatedInput: input }
        const id = randomUUID()
        const allowed = await new Promise<boolean>(resolve => {
          const done = (v: boolean) => { options.signal.removeEventListener('abort', aborted); this.approvals.delete(id); resolve(v) }
          const aborted = () => done(false)
          this.approvals.set(id, done)
          options.signal.addEventListener('abort', aborted, { once: true })
          events.permission({ id, ...describeTool(name, input, this.options.root) })
        })
        return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '사용자가 허용하지 않았습니다.' }
      }
    } })
    try {
      const commands = await q.supportedCommands()
      if (!commands.some(c => c.name === 'knuaf-dev' || c.name.endsWith(':knuaf-dev'))) throw new Error('Claude가 knuaf-dev 스킬을 찾지 못했어요.')
      events.skill()
      const account = await q.accountInfo()
      if (account.apiKeySource && account.apiKeySource !== 'none') throw new Error('API 인증이 감지되어 중단했어요. 구독 인증을 확인해 주세요.')
      let lost = 0
      for await (const message of q) {
        if (claudeAuthenticationFailed(message)) throw new ClaudeAuthenticationError()
        if ('session_id' in message && message.session_id) events.session(message.session_id)
        lost += lostToolCalls(message)
        if (message.type === 'assistant') {
          const text = message.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          if (text) events.message(message.uuid, text)
        }
        if (message.type === 'result' && message.is_error) throw new Error('Claude 작업이 완료되지 않았어요. 연결·사용 한도와 마지막 대화를 확인해 주세요.')
      }
      // 턴이 성공으로 끝나도 그 안에서 조용히 죽은 작업이 있으면 그대로 말한다.
      // 이걸 안 하면 도우미의 마무리 인사만 남고 실패는 아무 데도 안 보인다.
      if (lost > 0) events.note(`도우미가 이번 작업 중에 파일 ${lost}건을 저장하지 못했어요. 앱이 승인 창을 띄우기 전에 통로가 닫혀서, 그 저장은 일어나지 않았어요. 필요하면 다시 요청해 주세요.`)
    } catch (e) {
      if (claudeAuthenticationFailed(e)) throw new ClaudeAuthenticationError()
      throw e
    } finally {
      q.close(); this.active = undefined
      // 답을 기다리던 요청은 거절로 닫고 지운다. 그냥 지우면 canUseTool 의 promise 가
      // 영영 안 풀려 그 도구 호출이 매달린 채 남는다.
      for (const answer of [...this.approvals.values()]) answer(false)
      this.approvals.clear()
    }
  }
  respond(id: string, allow: boolean) {
    const answer = this.approvals.get(id)
    if (!answer) throw new Error('이미 종료된 권한 요청이에요.')
    answer(allow)
  }
  async stop() {
    for (const answer of this.approvals.values()) answer(false)
    this.controller?.abort(); this.active?.close(); if (this.loginProcess) killTree(this.loginProcess)
  }
}
