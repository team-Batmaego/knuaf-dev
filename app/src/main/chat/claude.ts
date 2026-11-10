import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { query, type ModelInfo, type Query, type PermissionResult, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConnection, AgentEvents, AgentOptions } from './contracts'
import { workFolderInstructions } from '../agent'
import { winSpawn, killTree } from '../win'
import { claudeSpawnOptions } from './claude-spawn'
import { claudeTokens } from './jobs/tokens'
import { JobFailure, type ExecutionAccount, type JobConnection, type JobEvents, type RelayRequest, type UsageState } from './jobs/types'
import type { ChatModelInfo, ConnectionStatus } from '../../shared/chat'
import type { ModelCatalogEntry } from '../../shared/lanes'
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
const SKILL_SCRIPT = /(^|\/)(gg|gg_[a-z_]+|build_docx|show_research|merge_sections|build_status|lint_[a-z_]+)\.py$/
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
  const cmd = raw.replace(BENIGN_REDIR, ' ')
  if (SHELL_UNJUDGEABLE.test(cmd) || /\n/.test(cmd)) return null
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
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '"' || c === "'") {
      const close = cmd.indexOf(c, i + 1)
      if (close < 0) return null
      const body = cmd.slice(i + 1, close)
      if (c === '"' && /\\["\\$`]/.test(body)) return null
      word = (word ?? '') + body; parts++; quoted = true; i = close
    } else if (c === '\\') return null
    else if (/\s/.test(c)) endWord()
    else if (c === ';') endSeg()
    else if (c === '|') { endSeg(); if (cmd[i + 1] === '|') i++ }
    else if (c === '&') { if (cmd[i + 1] !== '&') return null; endSeg(); i++ }
    else {
      if (word === null || /["']/.test(cmd[i - 1] ?? '')) parts++
      word = (word ?? '') + c
    }
  }
  endSeg()
  if (exeMixed || segs.some((t) => /[*?[]/.test(t[0]))) return null
  return segs
}

type Reason = { kind: 'reach' | 'ai' | 'launch' | 'state' | 'interp'; name: string }
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

/** 모델 고르기가 저장된 선택을 되돌릴 수 없을 때의 문구(main·renderer 공통). */
export const CLAUDE_MODEL_COPY = {
  unsetNeedsChoice: '이 대화에서 모델을 골랐던 적이 있어서, "안 고름"으로 되돌리려면 계정 기본 모델을 알아야 해요. 지금은 그 값을 확인하지 못했어요. 모델 칩에서 모델을 하나 골라 주세요. (새 대화를 열면 계정 기본값을 다시 확인해요.)',
  defaultMismatch: (requested: string, actual: string) => `고른 모델(${requested})로 대화가 열리지 않았어요. 이 대화는 ${actual}로 진행되고 있어요. 모델 칩에서 다시 확인해 주세요.`
}

/**
 * SDK 의 모델 목록 한 줄 → 앱의 모델 목록 한 줄.
 *
 * 깊이 목록은 **모델이 주는 그대로** 쓴다(형님 Q1 "low~max 있듯이"). 줄이거나 더하지 않는다 —
 * 모델마다 다른 목록을 앱이 추측하면 엔진이 조용히 낮춰 도는 일을 학생이 알 수 없다.
 * `defaultEffort` 는 SDK 가 알려 주지 않으므로 `null` 이다(Codex 의 `model/list` 와 다르다).
 */
export function toChatModelInfo(info: ModelInfo): ChatModelInfo | null {
  const model = typeof info?.value === 'string' ? info.value.trim() : ''
  if (!model) return null
  const efforts: string[] = Array.isArray(info.supportedEffortLevels)
    ? info.supportedEffortLevels.filter((e) => CLAUDE_EFFORTS.has(e))
    : []
  return {
    model,
    name: typeof info.displayName === 'string' && info.displayName ? info.displayName : model,
    description: typeof info.description === 'string' ? info.description : '',
    efforts,
    defaultEffort: null,
    isDefault: false
  }
}

/**
 * 메인 대화가 엔진 기능으로 스스로 하위 담당을 띄우는 길을 막는다(설계 §3.2 [r11]).
 *
 * 왜 막는가: v0.7은 다른 모델에게 넘기는 일을 **앱이 연 담당(relay)** 으로만 보낸다. 검토는
 * 언제나 새 대화여야 하고(§3.4, 형님 확정), 분담 사용량은 학생 동의와 확인을 거쳐야 한다
 * (§3.5). 엔진의 하위 담당은 그 두 길을 그대로 건너뛴다.
 *
 * 이름: 동봉 CLI(2.1.319) 안의 별칭 표가 `{Task:"Agent", …}` 이고 훅 input 은 그 별칭을
 * 접은 정본 이름(`Agent`)으로 온다 — 그래도 둘 다 적어 두어 판이 바뀌어 옛 이름으로 와도
 * 같은 판정을 받는다. 대소문자를 접는 것은 오판이 늘어나는 쪽이 아니라 막는 쪽이기 때문이다
 * (이 이름들과 다른 도구 `TaskCreate`·`TaskList` 등은 목록에 없다).
 */
const SUBAGENT_TOOLS: Record<string, true> = { agent: true, task: true }

/**
 * 엔진에게 **도구 자체를 주지 않는다**(§3.2 [r11] 강제의 본체). 훅은 이름으로 거르는 2차
 * 그물이고, 이것은 그 앞단이다 — 실CLI 두 판(2.1.275·2.1.319) 실측:
 *  - `Agent`·`Task` 를 넣으면 도구 목록에서 빠지고 호출도 거절된다.
 *  - `Workflow` 를 넣어야 한다. **이것을 빼면 훅도 `canUseTool` 도 보지 않는 경로**로
 *    하위 담당을 백그라운드로 띄운다(훅엔 `tool:"Workflow"` 가 찍히지만 판정 밖이고,
 *    `canUseTool` 은 통과시킨다 — 결과는 "Workflow launched in background").
 *  - `Skill` 을 넣어야 한다. 빼면 `context: fork` 스킬이 하위 담당을 띄운다. 동봉 스킬
 *    `code-review` 가 fork 라 학생 PC 어디서나 `Skill` 한 번이면 열린다. 훅은 `tool:"Skill"`
 *    을 보지만 스킬 본문의 frontmatter(`context: fork`)는 앱이 모르고, 이름 하나만 막는
 *    `Skill(code-review)` 로는 프로젝트·사용자 폴더의 fork 스킬을 못 막는다.
 *
 * `Skill` 을 끄고도 앱은 그대로 돈다 — 앱은 첫 턴을 `/knuaf-dev <요청>` 슬래시 명령으로
 * 보내고(inline), 슬래시 확장은 `Skill` 도구 없이 CLI 가 직접 한다(두 판 실측: 도구 목록에
 * `Skill` 이 없어도 스킬 본문이 실려 왔다). 그래서 모델이 스스로 부르는 스킬만 닫힌다.
 *
 * ToolSearch 로 되살아나지도 않는다(두 판 실측: "No matching deferred tools found" /
 * 검색 결과에 `Skill` 이 없음).
 */
const DISALLOWED_SUBAGENT_TOOLS = ['Agent', 'Task', 'Workflow', 'Skill']

/** 하위 담당 호출을 거절할 때 모델이 읽는 문장 — 다음에 할 일을 그대로 적는다. */
const SUBAGENT_DENY_REASON = '하위 담당(Agent·Task 도구)은 이 앱에서 열 수 없어요. 앱이 승인한 배치의 일은 앱이 직접 새 대화로 넘기고, 검토는 언제나 새 대화로만 열려요. 넘길 일은 `gg.py delegate` 주문서로 넘기세요. 그 명령이 아직 없으면 그 일은 직접 하거나, 학생에게 "이 일은 다른 모델에게 넘겨 주세요"라고 한 줄로 알리세요.'

/** 이 도구 호출이 하위 담당을 띄우는 것인가. 훅과 canUseTool 이 같은 판정을 쓴다. */
export function isSubagentTool(name: unknown): boolean {
  return typeof name === 'string' && SUBAGENT_TOOLS[name.toLowerCase()] === true
}

/**
 * PreToolUse 훅 — 하위 담당 호출을 **언제나** 거절한다(승인 배치·동의·신뢰 폴더와 무관).
 *
 * 이것은 **2차 겹**이다. 본체는 `disallowedTools`(엔진이 그 도구를 모델에게 주지 않는다)이고,
 * 이 훅은 엔진 옵션이 판마다 달라지거나 앱이 옵션을 잘못 조립했을 때 남는 겹이다.
 * 훅 하나에 기대면 안 되는 이유는 실측에 있다 — 훅 콜백이 예외를 던지면 CLI 는 **열린 채
 * 통과**시킨다(fail-open). 그래서 도구 이름 판정은 엔진에 맡기고, 훅은 정상 경로에서 같은
 * 뜻을 한 번 더 말하는 자리로 둔다.
 *
 * 매처 없이 모든 도구에 걸고 여기서 거른다. 매처는 CLI 판마다 정규식 의미가 달라질 수 있고
 * (`Agent|Task` 는 `TaskCreate` 에도 걸린다), 이 판정은 권한 경계라 확실해야 한다.
 * 매처 없는 훅은 도구 호출마다 한 번 도는데, 그 왕복은 앱 안 IPC 다(네트워크 아님).
 *
 * 하위 담당 안에서 불릴 때(`agent_id` 있음)도 같은 거절이다 — `agent_id` 를 보지 않으므로
 * 담당이 다시 담당을 띄우는 우회로도 열리지 않는다(v0.7은 엔진 하위 담당을 어디에서도 쓰지
 * 않는다 — 두 회사 모두 relay).
 */
export const subagentGuardHook = async (input: unknown): Promise<SyncHookJSONOutput> => {
  const hook = input as { hook_event_name?: unknown; tool_name?: unknown }
  if (hook?.hook_event_name !== 'PreToolUse' || !isSubagentTool(hook.tool_name)) return { continue: true }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: SUBAGENT_DENY_REASON
    }
  }
}

/**
 * 학생이 친 글을 **CLI 가 명령으로 읽지 않게** 만든 뒤 그대로 넘긴다(U5c).
 *
 * 왜 필요한가: `disallowedTools` 로 `Skill` 도구를 꺼도, 학생 글이 `/` 로 시작하면 CLI 는 그것을
 * **슬래시 명령**으로 보고 스킬을 직접 펼친다 — `Skill` 도구를 거치지 않는 길이라 그 옵션이
 * 막지 못한다. 앱 스킬 사본 폴더의 `context: fork` 스킬도, CLI 동봉 `code-review` 도 그렇게
 * 하위 담당을 띄운다(두 판 실측). 앱 안에서 숨은 하위 담당이 도는 것은 §3.2 [r11] 과
 * 형님 UI 원칙(학생이 명령을 외울 필요 없음)에 어긋난다.
 *
 * 처방: 첫 줄이 `/` 로 시작하면 **앞에 한 칸**을 붙인다. 학생이 쓴 낱말은 한 글자도 바꾸지
 * 않고, CLI 는 그 줄을 평범한 글 한 줄로 읽는다(실측: 앞 공백 한 칸이면 일반 턴).
 *
 * 손대지 않는 경우:
 *  · 이미 앞에 공백·줄바꿈·탭이 있다 — CLI 가 이미 일반 턴으로 읽는다(실측).
 *  · 전각 슬래시(`／`)·`//` — 명령 자리가 아니다(실측).
 *  · 줄 **안**의 슬래시, 코드 블록 안 예시 — 명령 자리는 첫 줄 첫 글자뿐이다(실측).
 *
 * 첫 턴(새 대화)은 여기 오지 않는다 — 앱이 `/knuaf-dev ${글}` 로 보내므로 슬래시 명령 자리는
 * `/knuaf-dev` 하나이고, 그 뒤의 슬래시는 명령이 아니다(실측). 그 앞붙임은 앱의 길이라 그대로 둔다.
 */
export function studentTurnText(text: string): string {
  if (typeof text !== 'string' || text === '') return text
  return text.startsWith('/') ? ` ${text}` : text
}

/** 모든 턴에 붙는 앱 지침 — 세션 경계·스킬 규칙·셸 표기·하위 담당 금지. */
const CLAUDE_SYSTEM_APPEND = '이 세션은 개인용 knuaf-dev GUI입니다. knuaf-dev 스킬과 참조 지침을 그대로 따르세요. 질문과 답변은 채팅 텍스트로 유지하고 인터뷰 원문과 해석을 스킬의 로그 계약대로 기록하세요. 셸 명령은 앱이 그대로 읽고 판단할 수 있어야 자동으로 통과합니다. 변수 대입($PY=… 같은)·$PWD 같은 변수 참조·`…`·$(…)·서브셸·리다이렉트를 쓰지 말고, 경로는 따옴표로 감싼 절대경로를 그대로 적으세요. 그러지 않으면 학생에게 읽을 수 없는 승인 창이 뜹니다. 셸에 프로그램을 밀어 넣지 마세요(heredoc·python -c 등). 엑셀·문서 읽기는 스킬의 스크립트에 이미 있으니 그것을 쓰세요. 하위 담당(Agent·Task) 도구는 앱이 거절하니 부르지 마세요 — 넘길 일은 `gg.py delegate` 주문서로 넘기고, 그 명령이 아직 없으면 그 일은 직접 하거나 학생에게 한 줄로 알리세요. 턴이 끝난 뒤에 도구를 쓰면 승인 통로가 이미 닫혀 있어 그 작업은 반드시 실패합니다.'

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
  const outside = keys.map((k) => outsideRoot(root, (input as Record<string, unknown>)[k])).find(Boolean)
  if (outside) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `대상: ${outside}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
  const cmd = (input as { command?: unknown })?.command
  if (name === 'Bash' && typeof cmd === 'string') {
    const segs = parseShell(cmd)
    if (segs === null) return { title: '앱이 읽을 수 없는 명령이에요', detail: `${cmd}\n\n변수나 기호가 섞여 있어 무엇을 건드릴지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    const out = bashOutside(root, segs)
    if (out.length) return { title: '논문 폴더 밖의 파일을 건드리려고 해요', detail: `${cmd}\n\n폴더 밖: ${out.join(', ')}\n\n논문 폴더 안이 아니에요. 의도한 일이 아니면 거절해 주세요.` }
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
    const state = first('state')
    if (state) return { title: '셸 설정을 바꾸는 명령이에요', detail: `${cmd}\n\n"${state.name}" 는 뒤에 오는 명령이 실행되는 방식을 바꿀 수 있어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    if (first('interp')) return { title: '앱이 읽을 수 없는 프로그램을 실행해요', detail: `${cmd}\n\n프로그램 안에 무엇이 있는지 앱이 미리 알 수 없어요. 무슨 일인지 모르겠으면 거절해 주세요.` }
    return { title: '컴퓨터에서 명령을 실행하려고 해요', detail: `${cmd}\n\n앱이 폴더 안 일이라고 확인하지 못한 명령이에요. 무슨 일인지 모르겠으면 거절해 주세요.` }
  }
  return { title: `도우미가 "${name}" 도구를 쓰려고 해요`, detail: JSON.stringify(input, null, 2) }
}

/** 자동 허용 판정 — 클래스 밖 순수 함수로 두어 테스트가 직접 고정한다(권한 경계). */
export function autoAllow(root: string, name: string, input: unknown, allowed: string[] = []): boolean {
  const ok = (v: unknown) => outsideRoot(root, v) === null || (typeof v === 'string' && allowed.includes(realOrSelf(resolve(root, v)).normalize('NFC')))
  const keys = PATH_TOOLS[name]
  if (keys) return keys.every((k) => ok((input as Record<string, unknown>)[k]))
  if (name === 'Bash') return isSkillCommand(root, input)
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
  /**
   * 이 대화에서 앱이 모델을 **명시해서** 보낸 적이 있는가. 한 번이라도 보냈으면 CLI 는
   * `resume` 때 그 모델을 복원하므로(D1-03, 실측), "안 고름"은 생략이 아니라 기본 모델을
   * 명시해서 되돌려야 한다. 대화(세션)마다 다르므로 세션 id 와 함께 든다 —
   * 새 대화는 아직 id 가 없으므로 `''` 로 표시하고, 첫 `system/init` 이 준 id 로 옮긴다.
   */
  private overriddenFor: string | null = null
  /** 이 앱이 밝혀 낸 계정 기본 모델. 모델 옵션 없이 연 대화의 첫 `system/init.model` 만 인정한다. */
  private accountDefault: string | null = null
  /** 목록의 `value`(별칭) → `resolvedModel`(실제 id). 요청과 init 을 견주는 데만 쓴다. */
  private resolvedModels = new Map<string, string>()
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
   * 이 계정이 쓸 수 있는 모델 목록. 초기화 응답(`initialize`)이 이미 들고 오므로 턴을
   * 보내지 않고 묻는다 — 빈 입력 스트림으로 연 query 는 대화 기록을 만들지 않는다.
   * 모델 목록 화면을 열 때마다 새 프로세스가 뜨지만, 한 번의 초기화 왕복이면 끝난다
   * (실측 약 0.7초, 로컬 가짜 CLI).
   */
  async models(): Promise<ChatModelInfo[]> {
    const q = this.probe()
    try {
      const list = await q.supportedModels()
      const parsed = (Array.isArray(list) ? list : [])
        .map(toChatModelInfo)
        .filter((m): m is ChatModelInfo => m !== null)
      for (const info of Array.isArray(list) ? list : []) {
        if (typeof info?.value === 'string' && typeof info.resolvedModel === 'string' && info.resolvedModel) {
          this.resolvedModels.set(info.value, info.resolvedModel)
        }
      }
      return parsed
    } finally {
      q.close()
    }
  }

  /**
   * 목록·기본값 조회용 query. **턴을 보내지 않는다** — 빈 입력 스트림을 주면 CLI 는
   * 초기화 응답까지만 주고 대화 기록을 남기지 않는다(실측: `projects/` 가 생기지 않음).
   * `run()` 과 같은 옵션을 쓴다 — 목록은 실제 대화와 같은 환경에서 나와야 한다.
   */
  private probe(): Query {
    // 대화 중인 턴의 컨트롤러를 갈아 끼우지 않는다 — 목록 조회는 그 턴과 무관하고,
    // 갈아 끼우면 stop() 이 이미 버려진 컨트롤러를 abort 해 진행 중인 턴이 멈추지 않는다.
    const controller = new AbortController()
    return query({ prompt: (async function* () {})(), options: this.queryOptions(undefined, {}, controller) })
  }

  /**
   * `run()` 과 `probe()` 가 함께 쓰는 query 옵션. 모델·깊이는 여기서만 정한다.
   *
   * 모델 (D1-03): 이 대화에서 앱이 모델을 보낸 적이 있으면 CLI 는 `resume` 때 그 모델을
   * 복원한다(실측). 그래서 "안 고름"은 **생략이 아니라 기본 모델을 명시**해서 되돌린다.
   * 계정 기본값은 모델 옵션 **없이** 연 대화의 첫 `system/init.model` 만 인정하고, 첫
   * 턴부터 모델을 골랐던 대화의 init 은 선택값이므로 저장하지 않는다. 기본값을 모르면
   * "안 고름"을 그 대화에서는 막는다(`prepare()` 가 전송 전에 던진다).
   *
   * 깊이: 실측 결과 CLI 는 `resume` 때 **직전 깊이를 복원하지 않는다**(이력의 마지막
   * `perTurnEffort` 가 `max` 여도, 플래그 없이 재개한 요청은 모델 기본값 `high` 로 나갔다).
   * 그래서 깊이는 매 턴 고른 값만 보내고, "안 고름"은 지금까지처럼 생략한다 — 되돌릴 것이 없다.
   */
  private queryOptions(sessionId: string | undefined, params: { model?: string; effort?: string }, controller = this.controller) {
    return {
      cwd: this.options.root, pathToClaudeCodeExecutable: this.options.binary,
      ...claudeSpawnOptions(this.options.binary),
      // The project's own skill copy stays authoritative — a stale ~/.claude/skills
      // cannot shadow or mix with it. The external .command launcher pins the same
      // scope (buildLaunchScript in ../agent.ts).
      env: this.options.env, settingSources: ['project', 'local'] as ('project' | 'local')[],
      resume: sessionId, abortController: controller, permissionMode: 'default' as const,
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      // 매 턴 같은 문구 — 세션 경계·스킬 규칙 안내.
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: CLAUDE_SYSTEM_APPEND },
      // 하위 담당 금지의 **본체**(§3.2 [r11]) — 엔진이 도구를 주지 않는다. 훅·canUseTool 보다
      // 먼저 듣고, 훅이 못 듣는 판(콜백 예외·`disableAllHooks`)에서도 같은 효과다.
      disallowedTools: DISALLOWED_SUBAGENT_TOOLS,
      // 2차 그물 — 이름으로 거르는 훅. 엔진 옵션이 판마다 달라지는 경우를 대비한 겹이다.
      // 매처 없이 걸어 별칭 해석 차이(정본 `Agent` vs 옛 별칭 `Task`)를 여기서 흡수한다.
      // `probe()` 도 같은 옵션을 쓰지만 목록 조회는 턴을 보내지 않으므로 훅은 불리지 않는다.
      hooks: { PreToolUse: [{ hooks: [subagentGuardHook] }] }
    }
  }

  /**
   * 한 턴의 모델·깊이 계획. **한 번만 읽고 그 값으로 끝까지 간다** — 옵션 조립·초기화 대조·
   * 기본값 저장이 모두 이 한 값을 쓴다(웹 검토 U1b 중요 1·5). 예전에는 `prepare()`·`run()`·
   * 초기화 처리에서 각각 다시 읽어서, 그 사이에 칩을 만지면 "보낸 값"과 "판정한 값"이 갈렸다.
   *
   * 순서:
   * 1. 학생이 고른 모델 → 그 모델 + 고른 깊이. **깊이를 안 골랐으면 깊이를 보내지 않는다** —
   *    환경 변수 깊이를 여기 끼워 넣으면 화면("기본값")과 실제 요청이 갈린다(중요 4).
   * 2. 고른 모델이 없고 개발용 핀(`KNUAF_CLAUDE_MODEL`)이 있으면 그 핀. 핀은 학생 선택이
   *    아니라 시험·검증용 기본값 자리다(live 스펙이 이 통로로 비용을 낮춘다).
   * 3. 되돌려야 하는데 계정 기본값을 모르면 `blocked` — 모델 없이 재개하면 CLI 가 마지막
   *    모델을 복원하므로(D1-03) 조용히 이전 모델로 가게 된다. 부르는 쪽이 전송을 막는다.
   * 4. 그 밖에는 아무 키도 넣지 않는다(지금까지와 같은 요청 모양).
   *
   * `sentModel` 은 실제로 CLI 에 넘긴 모델이다. 초기화 응답과 견주고 기본값 저장 여부를
   * 정하는 기준도 이 값이다 — 다시 읽은 선택값이 아니다(중요 5).
   * `marksOverride` 는 "이 대화를 앱이 덮어썼다"를 기록할지다. 계획을 세우는 시점에 기록하지
   * 않고 **전송이 실제로 시작될 때** 기록한다 — 막힌 턴이 흔적을 남기면 안 된다.
   */
  private turnPlan(sessionId: string | undefined): { model?: string; effort?: string; sentModel: string | null; blocked: boolean; marksOverride: boolean } {
    const choice = this.options.modelChoice?.() ?? null
    const envModel = this.options.env.KNUAF_CLAUDE_MODEL || undefined
    const envEffort = CLAUDE_EFFORTS.has(this.options.env.KNUAF_CLAUDE_EFFORT ?? '')
      ? this.options.env.KNUAF_CLAUDE_EFFORT as string
      : undefined

    if (choice?.model) {
      // 학생이 깊이를 "기본값"으로 두었으면 깊이는 비운다(모델 기본값을 쓴다).
      return { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), sentModel: choice.model, blocked: false, marksOverride: true }
    }
    if (envModel) return { model: envModel, ...(envEffort ? { effort: envEffort } : {}), sentModel: envModel, blocked: false, marksOverride: false }

    /**
     * 여기부터는 "고른 모델 없음". 언제 되돌려야 하는가:
     * ① 이 연결에서 이 대화를 덮어쓴 적이 있다(같은 앱 실행), 또는
     * ② 앱을 다시 켜서 재개했는데 이 학생은 전에 모델을 고른 적이 있다(설정의 흔적).
     * ②가 없으면 재시작 뒤 "안 고름"이 CLI 의 마지막 모델 복원에 조용히 먹힌다(D1-03).
     * 새 대화는 아직 덮어쓴 적이 없으므로 ①·② 어느 쪽도 아니다 — 모델 키 없이 열어 기본값을
     * 확인하고, 그 확인으로 ②가 풀린다(중요 2).
     */
    const mustRestore = this.overriddenFor === (sessionId ?? '') || (sessionId !== undefined && (this.options.modelChosen?.() ?? false))
    if (!mustRestore) return { ...(envEffort ? { effort: envEffort } : {}), sentModel: null, blocked: false, marksOverride: false }
    if (!this.accountDefault) return { ...(envEffort ? { effort: envEffort } : {}), sentModel: null, blocked: true, marksOverride: false }
    return { model: this.accountDefault, ...(envEffort ? { effort: envEffort } : {}), sentModel: this.accountDefault, blocked: false, marksOverride: false }
  }

  /**
   * 요청한 값(별칭 `opus`·`sonnet`)과 초기화가 알려 준 실제 id(`claude-opus-5`)가 같은
   * 모델인가. 어긋남을 **증명할 수 있을 때만** false 다 — 별칭이 id 로 풀리는 것은 정상이고,
   * 그것을 경고로 띄우면 매 턴 거짓 경고가 난다.
   * 1. `default` 는 "계정 기본값"이라는 뜻이므로 초기화가 준 값이 곧 답이다.
   * 2. 목록을 받아 두었으면 그 줄의 `resolvedModel` 과 견준다(가장 정확하다).
   * 3. 아니면 낱말 포함으로 본다 — `opus` ⊂ `claude-opus-5`, `haiku-9` ⊄ `claude-opus-5`.
   */
  private sameModel(requested: string, actual: string): boolean {
    if (requested === 'default' || requested === actual) return true
    const bare = (v: string) => v.replace(/\[[^\]]*\]$/, '').toLowerCase()
    const resolved = this.resolvedModels.get(requested)
    if (resolved) return bare(resolved) === bare(actual)
    const words = new Set(bare(actual).split(/[^a-z0-9]+/).filter(Boolean))
    return bare(requested).split(/[^a-z0-9]+/).filter(Boolean).every((w) => words.has(w))
  }


  /**
   * 전송 전 확인. 되돌릴 기본값이 필요한데 확인하지 못했으면 **여기서 던진다** — 보낸 글이
   * 대화에 남거나 초안이 사라지기 전에 막는다(Codex `prepare()` 와 같은 원칙, MC1-01).
   * `run()` 도 같은 계획으로 한 번 더 막으므로, 준비와 전송 사이에 칩이 바뀌어도
   * 모델 없이 재개되지 않는다(중요 1).
   */
  async prepare(sessionId: string | undefined): Promise<void> {
    if (this.turnPlan(sessionId).blocked) throw new Error(CLAUDE_MODEL_COPY.unsetNeedsChoice)
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
    // 이 턴에 쓸 값을 **여기서 한 번만** 읽는다. 아래의 옵션 조립·초기화 대조·기본값 저장이
    // 모두 이 계획을 쓴다 — 전송 중에 칩이 바뀌어도 이미 정한 값으로 나간다(중요 1·5).
    const plan = this.turnPlan(sessionId)
    if (plan.blocked) throw new Error(CLAUDE_MODEL_COPY.unsetNeedsChoice)
    /**
     * "이 대화를 앱이 덮어썼다" 표식은 **초기화가 실제로 온 뒤**에 붙인다(R1).
     * 예전에는 전송 직전에 붙여서, 초기화 전에 죽은 턴도 새 대화를 "덮어쓴 대화"로 만들어
     * 버렸다. 그러면 그 뒤 "안 고름"으로 새 대화를 여는 복구 경로가 막힌다 — 실패한 턴은
     * 아무것도 덮어쓰지 않았으므로 표식도 남기지 않는다.
     */
    const markOverride = plan.marksOverride && sessionId !== undefined
    if (markOverride) this.overriddenFor = sessionId
    this.controller = new AbortController()
    // 첫 프롬프트에 논문 작업 폴더 경계와 스킬 생성 폴더 허용을 명시한다.
    // 이어지는 턴은 학생 글을 그대로 보내되, 슬래시로 시작하면 CLI 가 명령으로 읽지 않게
    // 맨 앞에 한 칸을 붙인다(U5c — `studentTurnText`).
    const q = this.active = query({
      prompt: sessionId ? studentTurnText(text) : `/knuaf-dev ${text}\n\n${workFolderInstructions(this.options.root)}`,
      options: {
        ...this.queryOptions(sessionId, plan),
        // 백그라운드 서브에이전트를 막는 것은 취향이 아니다. SDK 는 문자열 prompt 를 단일
        // 턴으로 보고 첫 result 에서 CLI 의 stdin 을 닫는다(sdk.mjs: isSingleUserTurn).
        // 그 뒤에 오는 쓰기 계열 호출은 승인 요청이 전송되기도 전에
        // "AbortError: Stream closed" 로 죽고, canUseTool 은 호출조차 되지 않는다 —
        // 앱은 승인 창을 띄울 기회조차 없고 도우미는 그것을 "쓰기 권한 차단"으로 읽는다
        // (시험주행 발견 11, 재현으로 확인). 제대로 된 해법은 세션 동안 stdin 을 열어 두는
        // 스트리밍 입력이며 연결 수명 구조를 바꿔야 한다. 그때까지는 말로 막는다.
        canUseTool: async (name, input, options): Promise<PermissionResult> => {
          if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'knuaf-dev 인터뷰 지침에 따라 질문을 채팅 텍스트로 제시하세요.' }
          /**
           * **하위 담당은 여기서 막지 않는다 — 막을 수 없기 때문이다.** 실CLI 두 판 실측:
           * `Agent` 에는 이 콜백이 **한 번도 불리지 않는다**(허용 규칙을 지워도, 훅을 떼도).
           * 엔진이 승인 질문 없이 도는 도구라 이 자리에 오지 않는다. 반면 훅 콜백이 예외를
           * 던지면 엔진은 **열린 채 통과**시킨다(fail-open) — 실측에서 그대로 하위 담당이 떴다.
           * 그래서 실제 관문은 `disallowedTools`(엔진이 도구를 주지 않음)이고, 훅은 이름으로
           * 거르는 2차 겹이다. 여기에 같은 판정을 또 적으면 "막았다"는 착각만 남는다.
           */
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
      }
    })
    try {
      const commands = await q.supportedCommands()
      if (!commands.some(c => c.name === 'knuaf-dev' || c.name.endsWith(':knuaf-dev'))) throw new Error('Claude가 knuaf-dev 스킬을 찾지 못했어요.')
      events.skill()
      const account = await q.accountInfo()
      if (account.apiKeySource && account.apiKeySource !== 'none') throw new Error('API 인증이 감지되어 중단했어요. 구독 인증을 확인해 주세요.')
      let lost = 0
      // 이 턴이 **실제로 보낸** 모델(plan.sentModel). 다시 읽은 선택값이 아니다 — 그 사이
      // 칩이 바뀌면 보내지 않은 값으로 경고하거나 저장하게 된다(중요 5).
      let verified = false
      for await (const message of q) {
        if (claudeAuthenticationFailed(message)) throw new ClaudeAuthenticationError()
        if ('session_id' in message && message.session_id) events.session(message.session_id)
        // 계정 기본값은 **모델을 보내지 않은** 대화의 첫 init 에서만 인정한다. 첫 턴부터
        // 모델을 골랐다면 그 init 은 선택값이지 기본값이 아니다(§1 [r3 D1-03]).
        if (!verified && message.type === 'system' && message.subtype === 'init') {
          verified = true
          const actual = typeof message.model === 'string' && message.model ? message.model : null
          /**
           * 계정 기본값은 **모델을 보내지 않은 새 대화**의 init 이다(설계 §1). 조건에
           * `!this.accountDefault` 를 두지 않는다(R2) — 계정/프로젝트 기본값은 바뀔 수 있고,
           * 새 대화의 init 이 곧 그때의 답이다. 처음 본 값만 붙들면 기본값이 바뀐 뒤에도
           * 옛 모델을 계속 명시해 보낸다. 모델을 보낸 턴(핀 포함)은 여전히 제외한다.
           */
          if (!sessionId && !plan.sentModel && actual) this.accountDefault = actual
          // 새 대화의 표식은 초기화가 왔으므로 이제 붙인다(위 주석) — 다음 턴부터 같은 대화다.
          if (plan.marksOverride && message.session_id) this.overriddenFor = message.session_id
          if (plan.sentModel && actual && !this.sameModel(plan.sentModel, actual)) {
            events.note(CLAUDE_MODEL_COPY.defaultMismatch(plan.sentModel, actual))
          }
        }
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

/**
 * 담당(relay) 한 번의 한도 판정 — 설계 §3.5 A.
 *
 * A 는 **관측된 rate limit 사건**만으로 정한다. `utilization`·`resetsAt` 으로
 * "아직 여유 있겠지"를 추론하지 않는다(설계 §3.5 "사용률·리셋으로 추정 금지").
 * 읽을 수 없거나 모르는 값이면 `'unknown'` 이다 — `'allowed'` 를 지어내지 않는다.
 *
 * 근거(동봉 SDK 0.3.275 `sdk.d.ts`): `SDKRateLimitInfo` = `{status: 'allowed'|'allowed_warning'|'rejected',
 * overageStatus?, isUsingOverage?, overageInUse?, utilization?, resetsAt?, …}`.
 * 과금으로 넘어가는 중(`isUsingOverage`/`overageInUse` 참)은 "기본 사용 한도 안"이 아니므로 A 가 아니다.
 */
export function claudeUsageState(info: { status?: unknown; isUsingOverage?: unknown; overageInUse?: unknown } | null | undefined): UsageState {
  if (!info || typeof info !== 'object') return 'unknown'
  if (info.status === 'rejected') return 'limit'
  if (info.status !== 'allowed' && info.status !== 'allowed_warning') return 'unknown'
  if (info.isUsingOverage === true || info.overageInUse === true) return 'limit'
  return 'allowed'
}

/** `"Claude Max"`·`"claude.ai Max"` 처럼 오는 구독 이름을 `lanes.ts` 가 보는 `'max'`/`'pro'` 로 접는다. */
export function claudeSubscriptionTier(value: unknown): 'max' | 'pro' | null {
  if (typeof value !== 'string') return null
  const words = new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  return words.has('max') ? 'max' : words.has('pro') ? 'pro' : null
}

/**
 * 이 계정이 누구인가 — `JobRunner` 는 실행 전에 `options.account()`(앱 동의 반영본)와
 * `availability()` 값의 **지문(JSON.stringify)** 이 같은지 본다. 두 값이 같은 함수에서
 * 나오지 않으면 모든 주문이 `rejected` 로 닫힌다. 그래서 계정 값의 생산은 여기 한 곳이고,
 * 배선 C 의 `jobAccount` 도 이 함수를 부른다.
 *
 * `consented` 는 **엔진이 정하지 않는다**(false) — 앱 저장소가 정본이고 `service.ts` 가 덮는다.
 * `usage` 도 여기서 정하지 않는다(`availability()` 가 관측값으로 채운다).
 */
export function claudeExecutionAccount(options: AgentOptions, models: readonly ModelCatalogEntry[] | null,
  detail: { apiKeySource?: string | null; subscriptionType?: string | null; subject?: string } = {}): ExecutionAccount {
  const tier = claudeSubscriptionTier(detail.subscriptionType)
  // 계정 식별자는 요금제·이메일이 아니라 **계정 자체**를 가리켜야 한다 — 동의가 계정 단위로
  // 남기 때문이다(설계 §3.5 규칙 1). 값이 없으면 앱이 아는 경로로 대신한다.
  const subject = detail.subject ?? options.root
  return {
    accountId: createHash('sha256').update(JSON.stringify([options.binary, subject])).digest('hex'),
    connected: true,
    account: {
      company: 'claude',
      ...(typeof detail.apiKeySource === 'string' ? { apiKeySource: detail.apiKeySource } : {}),
      ...(tier ? { subscriptionType: tier } : {}),
      models
    },
    consented: false,
    usage: 'unknown'
  }
}

/** 담당(relay) 세션에 붙이는 앱 지침 — 본대화 지침에 담당 전용 경계를 덧붙인다. */
const RELAY_SYSTEM_APPEND = `${CLAUDE_SYSTEM_APPEND} 이 세션은 앱이 연 담당(relay)입니다. 결과는 주문서가 정한 출력 칸에만 쓰고, 그 밖의 파일은 만들지도 고치지도 마세요. 학생에게 직접 묻지 말고, 판단이 필요하면 주문서의 조건 칸에 적으세요.`

/**
 * 이 주문 전용 플러그인 폴더를 만든다 — **앱 전용 자리** 아래 `relay-plugin/<jobId>`.
 *
 * 왜 학생 폴더가 아닌가: 이 조립은 **SDK 격리가 시작되기 전**에 앱 프로세스가 한다. 학생 폴더
 * 안에 만들면 그 폴더에 접근할 수 있는 쪽(학생·다른 앱·링크)이 우리가 검사한 뒤 경로를 바꿔
 * 우리 쓰기를 자기 목적지로 돌릴 수 있다(검토 1~3회차). 앱 전용 자리(`userData`)는 그런
 * 경로가 없으므로, 검사와 쓰기 대상이 갈라지는 문제 자체가 사라진다.
 *
 * SDK 에는 **절대경로**로만 넘어가므로 위치가 학생 폴더일 필요가 없다(실측: `plugins[].path`).
 *
 * 수명: 주문 하나가 끝나면(`removeRelayPlugin`) 지운다. 앱이 중간에 죽어 남으면 다음 시작의
 * `sweepRelayPlugins` 가 치운다.
 */
/** 주문 id 이자 플러그인 폴더 이름의 규칙 — 만들 때·지울 때·정리할 때 같은 규칙을 쓴다. */
const RELAY_JOB_ID = /^[a-zA-Z0-9_-]+$/

export function relayPluginPath(appDir: string, jobId: string): string {
  if (!RELAY_JOB_ID.test(jobId)) throw new Error('Invalid job id')
  return join(appDir, 'relay-plugin', jobId)
}

export function prepareRelayPlugin(appDir: string, jobId: string, skill: string): string {
  const dir = relayPluginPath(appDir, jobId)
  // 기존 폴더에 표식이 없으면 **우리 것이 아니다** — 그 자리는 쓰지 않는다(덮어쓰기·삭제 금지).
  if (existsSync(dir) && !ownsRelayPlugin(dir)) {
    throw new Error('담당 플러그인 자리에 앱이 만들지 않은 폴더가 있어요. 이 주문은 열지 않습니다.')
  }
  mkdirSync(dir, { recursive: true })
  const manifest = join(dir, '.claude-plugin')
  mkdirSync(manifest, { recursive: true })
  writeFileSync(join(manifest, 'plugin.json'), JSON.stringify({ name: 'knuaf', version: '1.0.0', description: 'knuaf-dev relay skill' }))
  // 스킬 사본은 앱이 소유한 원본에서 이 주문 전용으로 한 번만 뜬다.
  cpSync(skill, join(dir, 'skills', 'knuaf-dev'), { recursive: true, force: true })
  // 표식은 **다 만든 뒤에** 쓴다 — 정리가 반쯤 만들어진 폴더를 "우리 것"으로 지우지 않게.
  writeFileSync(join(dir, RELAY_PLUGIN_MARK), JSON.stringify({ version: 1 }) + '\n')
  return dir
}

/** 이 폴더가 앱이 만든 담당 플러그인 폴더인가 — 표식 파일 이름은 `RELAY_PLUGIN_MARK`. */
const RELAY_PLUGIN_MARK = '.knuaf-relay-plugin'

/**
 * 소유 판정. **표식 파일**이 있고, 폴더 자체가 링크가 아니고, 그 표식도 링크가 아닐 때만 참이다.
 * 이름 규칙(`<jobId>`)만으로는 남의 폴더가 우연히 맞을 수 있어 표식을 함께 본다.
 */
function ownsRelayPlugin(dir: string): boolean {
  try {
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return false
    const mark = lstatSync(join(dir, RELAY_PLUGIN_MARK))
    return mark.isFile() && !mark.isSymbolicLink()
  } catch { return false }
}

/** 주문이 끝났을 때(성공·실패·중단) 그 주문 전용 폴더를 지운다. 우리 것이 아니면 건드리지 않는다. */
export function removeRelayPlugin(appDir: string, jobId: string): void {
  if (!RELAY_JOB_ID.test(jobId)) return
  const path = relayPluginPath(appDir, jobId)
  // 표식이 없으면 이 폴더는 우리가 만든 것이 아니다 — 지우지 않는다.
  if (!ownsRelayPlugin(path)) return
  try { rmSync(path, { recursive: true, force: true }) } catch { /* 다음 시작 정리가 맡는다 */ }
}

/**
 * 앱 시작 때 지난 실행의 잔여 폴더를 치운다.
 *
 * **앱이 만든 것만** 지운다:
 *  · 기준 폴더(`relay-plugin`)가 링크면 **아무것도 하지 않는다** — 바깥을 우리 저장소로 착각하면
 *    남의 파일을 지울 수 있다(검토 4회차 정적 분석).
 *  · 항목마다 `ownsRelayPlugin` 로 표식을 확인한다. 표식이 없는 폴더·파일은 남긴다.
 *  · 항목이 링크면 따라가지 않고 링크 자체만 지운다 — 그것도 표식이 없으면 그대로 둔다.
 */
export function sweepRelayPlugins(appDir: string): void {
  const base = join(appDir, 'relay-plugin')
  let names: string[]
  try {
    const stat = lstatSync(base)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return
    names = readdirSync(base)
  } catch { return }
  for (const name of names) {
    // 표식 **과** 이름 규칙이 둘 다 맞아야 우리 것이다 — 이름을 바꾼 폴더(예: `job-a.backup`)는
    // 사람이 손댄 것이라 남긴다(검토 5회차).
    if (!RELAY_JOB_ID.test(name)) continue
    const path = join(base, name)
    if (!ownsRelayPlugin(path)) continue
    try { rmSync(path, { recursive: true, force: true }) } catch { /* 하나 못 지워도 나머지는 지운다 */ }
  }
}

/**
 * 담당 연결 — 본대화와 **완전히 다른 옵션 객체**를 쓴다(발주 §④-a).
 *
 * 격리(설계 §3.3 ①②③):
 *  · `settingSources: []` — 학생·프로젝트 설정 파일을 읽지 않는다(SDK "isolation mode").
 *  · `hooks.PreToolUse` + `canUseTool` — 둘 다 `request.isolation` 의 **같은 판정**을 옮긴다.
 *    훅 `allow` 는 `canUseTool` 을 건너뛰므로, 한쪽만 두면 관문이 갈라진다.
 *  · `sandbox` — 셸을 OS 샌드박스에 가두고, 샌드박스가 안 되면 실패하게 한다.
 *  · `disallowedTools` — 하위 담당 도구는 엔진이 주지 않는다(§3.2 [r11]).
 *
 * 스킬: `settingSources: []` 는 `.claude/skills` 발견도 끊는다. 그래서 앱이 그 주문 전용
 * 플러그인 폴더를 만들고(`<root>/.knuaf-gui/relay-plugin/<jobId>`), `plugins` 로 넘긴다.
 * 그래야 도구 목록에 `knuaf-dev` 가 뜨고 `Skill` 도구 없이 슬래시 명령으로 펼쳐진다.
 */
export class ClaudeRelayConnection implements JobConnection {
  readonly relayProtocol = 1 as const
  /**
   * ㉠(형님 확정) — Claude 는 턴 **밖에서** A 를 관측할 통로가 없다(실측 3건). 그래서
   * `availability()` 는 `usage:'unknown'` 을 돌려주고, 러너는 이 선언이 있을 때만 그 unknown 을
   * 통과시켜 첫 턴을 연다. 그 턴에서 첫 `rate_limit_event` 가 `limit` 면 **그 자리에서**
   * `JobFailure('limit')` 로 닫고 결과를 넘기지 않는다(아래 `runJob`). 필드 이름은 a-gate 갈래
   * `jobs/types.ts` 의 `gateInTurn` 과 같다. */
  readonly gateInTurn = true
  private active?: Query
  private controller?: AbortController
  /** 이미 실행 중인 주문 — 같은 연결에 두 주문이 겹치면 관문·중지가 뒤엉킨다. */
  private running = false
  constructor(private options: AgentOptions, private request: RelayRequest, private appDir: string) {}

  status(): Promise<ConnectionStatus> { return new ClaudeConnection(this.options).status() }
  /** 담당 연결은 로그인 창을 열지 않는다 — 본대화 연결의 몫이다. */
  login(): Promise<void> { return Promise.reject(new Error('담당 연결은 로그인을 열지 않아요.')) }
  /** 러너가 무조건 부른다 — 던지면 주문 정리가 흐트러진다. 담당에는 승인 카드가 없다. */
  respond(): void {}
  run(): Promise<void> { return Promise.reject(new Error('담당 연결은 runJob 으로만 움직여요.')) }

  /**
   * 주문 시작 전 계정 상태. 설계 §3.5 는 A 를 **관측된 사건**으로만 정하게 했는데,
   * Claude 는 턴 밖에서 그 사건을 읽을 통로가 없다(실측 3건: 빈 입력 턴 0 이벤트,
   * `usage_EXPERIMENTAL…` 은 `rate_limits: null`). 그래서 여기서는 `'unknown'` 을 **정직하게**
   * 돌려주고, A 판정은 `runJob` 안에서 첫 `rate_limit_event` 로 한다. `'allowed'` 를
   * 지어내면 한도를 넘은 계정에 주문을 열어 주게 된다.
   */
  async availability(): Promise<ExecutionAccount> {
    const status = await this.status()
    if (!status.connected) return { ...claudeExecutionAccount(this.options, null), connected: false, usage: 'auth' }
    const controller = new AbortController()
    const q = query({ prompt: (async function* () {})(), options: this.queryOptions(controller) })
    try {
      // 초기화 응답 한 번으로 명령·모델·계정을 함께 받는다. `supportedModels()` 는 별도 왕복이다.
      const init = await q.initializationResult()
      const models = (Array.isArray(init?.models) ? init.models : [])
        .map(toChatModelInfo)
        .filter((m): m is ChatModelInfo => m !== null)
        .map((m): ModelCatalogEntry => ({ model: m.model, name: m.name, efforts: m.efforts }))
      const account = init?.account
      const known = claudeExecutionAccount(this.options, models, {
        apiKeySource: account?.apiKeySource,
        subscriptionType: account?.subscriptionType,
        subject: account?.email ?? account?.organization
      })
      // API 키 경로는 구독이 아니다 — 러너가 `auth` 로 닫도록 그 값을 그대로 알린다.
      const keyed = Boolean(account?.apiKeySource) && account?.apiKeySource !== 'none'
      const provider = account?.apiProvider
      return { ...known, connected: !keyed && (!provider || provider === 'firstParty'), usage: keyed ? 'auth' : 'unknown' }
    } catch {
      // 초기화를 못 받았다 = 지금 쓸 수 있는지 모른다. 모름을 `allowed` 로 바꾸지 않는다.
      return { ...claudeExecutionAccount(this.options, null), usage: 'unknown' }
    } finally { q.close() }
  }

  /** 주문 한 건. 순서와 관문은 `runJob` 주석 참조. */
  async runJob(text: string, events: JobEvents): Promise<void> {
    if (this.running) throw new Error('이 담당 연결은 이미 한 주문을 실행 중이에요.')
    this.running = true
    // 앞 단계(상태 확인·플러그인 조립·query 생성)에서 던져도 잠금과 핸들이 남지 않게 한다.
    let q: Query | undefined
    // 한도가 턴 중간에 깨졌는가 — `events.availability` 는 `connection.stop()` 을 부르므로
    // 우리도 같은 사실을 알고 `JobFailure('limit')` 로 정확히 닫는다(설계 §3.5 규칙 3).
    let verdict: 'limit' | null = null
    try {
      const status = await this.status()
      if (!status.connected) throw new JobFailure('auth', status.detail || 'Claude 구독 계정 로그인이 필요해요.')
      this.controller = new AbortController()
      const plugin = this.pluginDir()
      q = this.active = query({ prompt: this.relayPrompt(text), options: this.queryOptions(this.controller, plugin) })
      const commands = await q.supportedCommands()
      if (!Array.isArray(commands) || !commands.some(c => c.name === 'knuaf-dev' || c.name.endsWith(':knuaf-dev'))) {
        throw new Error('담당 세션에서 knuaf-dev 스킬을 찾지 못했어요.')
      }
      events.skill()
      const account = await q.accountInfo()
      if (account?.apiKeySource && account.apiKeySource !== 'none') throw new JobFailure('auth', 'API 인증이 감지되어 담당을 열지 않았어요.')
      if (account?.apiProvider && account.apiProvider !== 'firstParty') throw new JobFailure('auth', '구독 인증이 아닌 경로라 담당을 열지 않았어요.')
      let announced = false
      for await (const message of q) {
        if (claudeAuthenticationFailed(message)) throw new JobFailure('auth', CLAUDE_AUTH_COPY.required)
        // 순서 고정: 러너는 세션 id 가 없으면 토큰 기록을 버린다(jobs.ts `tokens`).
        if ('session_id' in message && message.session_id) events.session(message.session_id)
        if (message.type === 'system' && message.subtype === 'init') {
          // 실제 모델은 별칭이 아니라 CLI 가 푼 id 다 — 러너가 요청값과 대조해 기록한다.
          announced = true
          events.actualModel(typeof message.model === 'string' ? message.model : this.request.model, this.request.effort)
        }
        if (message.type === 'rate_limit_event') {
          const state = claudeUsageState(message.rate_limit_info)
          events.availability(state)
          if (state === 'limit') { verdict = 'limit'; q.close(); break }
        }
        if (message.type === 'result') {
          if (message.is_error) throw new JobFailure(classifyRelayResult(message), relayResultDetail(message))
          if (message.usage) {
            // 요청 순번 1 / 알림 순번 1 — 주문 한 건은 단일 턴(단일 프롬프트)이다.
            events.tokens(claudeTokens(message.usage, 1, 1))
          }
        }
      }
      if (verdict) throw new JobFailure(verdict, '담당이 기본 사용 한도를 넘어 멈췄어요.')
      if (!announced) throw new Error('담당 세션이 초기화를 알려 주지 않았어요.')
    } finally {
      q?.close(); this.active = undefined; this.running = false
      // 성공·실패·한도·중단 어느 쪽으로 끝나도 이 주문의 플러그인 사본은 남기지 않는다.
      removeRelayPlugin(this.appDir, this.request.jobId)
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort(); this.active?.close(); this.active = undefined
    // 주문이 시작되기 전에 멈춰도 그 주문의 사본이 남지 않게 한다.
    removeRelayPlugin(this.appDir, this.request.jobId)
  }

  /**
   * 주문 첫 글의 `/knuaf-dev` 를 플러그인 스킬 이름으로 바꾼다.
   * 러너는 `/knuaf-dev 담당 모드: <주문서>` 를 보내지만, 플러그인 스킬은 `<플러그인>:<스킬>` 로
   * 불린다(실측: 명령 목록에 `knuaf:knuaf-dev`). 앞 공백은 CLI 가 이 줄을 슬래시 명령이 아니라
   * 평범한 글로 읽게 만든다 — 그러면 스킬이 안 실린다.
   */
  private relayPrompt(text: string): string {
    return text.replace(/^\s*\/knuaf-dev\b/, '/knuaf:knuaf-dev')
  }

  /** 이 주문 전용 플러그인 폴더 — 학생 폴더가 아니라 앱 전용 자리다. */
  private pluginDir(): string {
    return prepareRelayPlugin(this.appDir, this.request.jobId, this.request.skill)
  }

  /**
   * 조립된 옵션을 그대로 보여준다 — 시험 이음매.
   * "SDK 에 넘어간 `plugins` 경로가 앱 전용 자리인가"를 실제 옵션으로 확인하기 위한 것이다.
   */
  debugQueryOptions(): Record<string, unknown> {
    // 경로만 계산한다 — 이 이음매가 파일을 만들면 시험이 검증하려는 대상이 흐려진다.
    return this.queryOptions(new AbortController(), relayPluginPath(this.appDir, this.request.jobId))
  }

  /**
   * 담당 전용 옵션. 본대화 `queryOptions()` 와 **별개로** 조립한다 — 한쪽을 고치면 다른 쪽의
   * 관문이 조용히 약해지는 일을 막는다(발주 §④-a).
   */
  private queryOptions(controller: AbortController, plugin?: string) {
    const isolation = this.request.isolation
    return {
      cwd: this.request.cwd,
      pathToClaudeCodeExecutable: this.options.binary,
      ...claudeSpawnOptions(this.options.binary),
      env: this.options.env,
      // ① 설정 출처 없음 — 학생·프로젝트 settings.json 과 CLAUDE.md 를 읽지 않는다.
      settingSources: [...isolation.settingSources] as ('user' | 'project' | 'local')[],
      abortController: controller,
      permissionMode: 'default' as const,
      // ③ 셸은 OS 샌드박스에 가두고, 샌드박스를 못 걸면 세션을 열지 않는다.
      sandbox: isolation.sandbox,
      model: this.request.model,
      ...(this.request.effort ? { effort: this.request.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: RELAY_SYSTEM_APPEND },
      // 하위 담당 금지(§3.2 [r11]) + 셸을 못 가두는 플랫폼에서는 셸 도구 자체를 뺀다(§3.3).
      disallowedTools: [...DISALLOWED_SUBAGENT_TOOLS, ...(isolation.shellEnabled ? [] : ['Bash'])],
      ...(plugin ? { plugins: [{ type: 'local' as const, path: plugin, skipMcpDiscovery: true }] } : {}),
      hooks: { PreToolUse: [{ hooks: [this.relayHook.bind(this)] }] },
      canUseTool: this.relayPermission.bind(this)
    }
  }

  /**
   * PreToolUse 훅 — 관문의 1차 겹.
   *
   * **절대 던지지 않는다.** 훅 콜백이 예외를 던지면 CLI 는 그 도구 호출을 통과시킨다(fail-open,
   * 실측). 판정에서 무엇이 터지든 거절로 접는다.
   */
  private async relayHook(input: unknown): Promise<SyncHookJSONOutput> {
    try {
      const hook = input as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown }
      if (hook?.hook_event_name !== 'PreToolUse') return { continue: true }
      const decision = this.request.isolation.preToolUse(String(hook.tool_name), (hook.tool_input ?? {}) as Record<string, unknown>)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.permissionDecision,
          ...(decision.permissionDecisionReason ? { permissionDecisionReason: decision.permissionDecisionReason } : {})
        }
      }
    } catch {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: '담당 도구 판정이 실패해 이 호출을 거절했어요.'
        }
      }
    }
  }

  /**
   * `canUseTool` — 관문의 2차 겹. 훅이 `allow` 를 내면 이 콜백은 불리지 않으므로(실측),
   * 두 겹이 **같은 함수**(`request.isolation`)를 봐야 판정이 갈라지지 않는다.
   * `appApproved = true` 는 "앱이 승인한 셸"이라는 뜻이다 — 이 연결에는 묻는 학생이 없다.
   */
  private async relayPermission(name: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const decision = this.request.isolation.canUseTool(name, input, true)
    return decision.permissionDecision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.permissionDecisionReason ?? '담당은 승인된 출력 칸만 사용할 수 있어요.' }
  }
}

/** 담당 턴이 실패로 끝났을 때 그 까닭을 분류한다. 문구 추측이 아니라 원인을 나눈다. */
function classifyRelayResult(message: { errors?: unknown[]; result?: unknown }): 'limit' | 'auth' | 'unknown' {
  const detail = relayResultDetail(message)
  if (/usage limit|rate limit|quota|한도/i.test(detail)) return 'limit'
  if (/401|authenticat/i.test(detail)) return 'auth'
  return 'unknown'
}

function relayResultDetail(message: { errors?: unknown[]; result?: unknown }): string {
  const parts = Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === 'string') : []
  if (typeof message.result === 'string' && message.result) parts.push(message.result)
  return parts.join(' / ').slice(0, 500)
}
