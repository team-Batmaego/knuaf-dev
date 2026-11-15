/**
 * AI agent (Claude Code / Codex CLI) discovery, skill installation and terminal launch.
 *
 * Deliberately free of `electron` imports: every environment-specific value (home dir, app root,
 * packaged state, `shell.openPath`, venv lookup) is passed in through `AgentCtx`, so the module can be
 * unit-tested from plain Node (see e2e/agent.spec.ts). ipc.ts wires `agentApi` to IPC handlers.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { APP_NAME } from '../shared/name'
import { pathKeyOf } from './chat/contracts'
import { renameWithRetry, writeFileAtomic } from './safeWrite'
import { isSkillHostPath, skillHostDir, skillHostRoot } from './guard/scope'
import { resolveSkillSource } from './update/source'
import { agentActivity } from './update/activity'
import { winSpawn } from './win'

// ---------------------------------------------------------------- types

export type AgentKind = 'claude' | 'codex'
export type SkillState = 'installed' | 'outdated' | 'missing'

export interface AgentBinary { found: boolean; path: string | null; version: string | null }

export interface AgentStatus {
  claude: AgentBinary
  codex: AgentBinary
  skill: { claude: SkillState; codex: SkillState }
  skillVersion: string
}

export interface InstallResult { action: 'installed' | 'updated' | 'unchanged'; backup?: string }

export interface LaunchScriptOptions {
  root: string
  agent: AgentKind
  agentPath: string
  venvBin: string | null
  bundledBin: string | null
  firstPrompt: string
  /** $HOME — codex 의 전역 스킬 사본을 끄는 `-c` 오버라이드를 만들 때 쓴다. */
  home?: string
  /**
   * codex 터미널의 1층 잠금 인자(`-c …`, 설계 §4.1-C). 거부가 아니면 `agentApi.launch` 가
   * 열거 결과를 여기로 넘긴다 — 스크립트 생성은 순수 함수로 남는다.
   */
  lockArgs?: string[]
  /**
   * Claude 터미널의 앱 스킬 자리(플러그인 뿌리, `<userData>/skill-host/.claude`).
   * 있으면 `--plugin-dir-no-mcp` 로 넘겨 폴더 밖 스킬 사본만 보이게 한다. Codex 는 무시.
   */
  skillHost?: string
  /**
   * 터미널 도우미에 붙일 시스템 지시문 파일(`--append-system-prompt-file`, §11.5).
   * 이 단계(2단계)에는 그 파일을 만드는 쪽이 아직 없다 — 4단계가 채우면 인자가 자동으로 붙는다.
   * 파일이 없으면 인자 자체를 넣지 않는다(빈 인자는 CLI 가 오류로 본다).
   */
  guardPromptFile?: string
}

export interface LaunchOptions extends LaunchScriptOptions {
  supportDir: string
  /** When true the script is written but `open` is never called (env KNUAF_DRY_LAUNCH=1). */
  dryRun?: boolean
}

export interface LaunchDeps {
  writeFile?: (path: string, data: string, mode: number) => void
  chmod?: (path: string, mode: number) => void
  /** Electron `shell.openPath` injected by main; resolves to '' on success or an error string. */
  open?: (path: string) => Promise<string>
}

export interface LaunchResult { scriptPath: string }

/**
 * 터미널 Codex 를 열지 않기로 한 거부(설계 §4.1-C '거부할 때 학생이 보는 글').
 * `message` 가 곧 학생에게 보일 글이고, ipc 가 그대로 `code` 를 실어 보낸다 —
 * 렌더러는 `copy.ts` 의 `agent_tool_lock` 으로 제목을 잡고 원문을 '자세히'에 그대로 둔다.
 */
export class AgentToolLockError extends Error {
  readonly code = 'agent_tool_lock'
  constructor(studentCopy: string) {
    super(studentCopy)
    this.name = 'AgentToolLockError'
  }
}

/** Everything the main process knows that this module needs. Built once in ipc.ts. */
export interface AgentCtx {
  home: string
  appRoot: string
  isPackaged: boolean
  resourcesPath: string
  supportDir: string
  /**
   * 앱 데이터 폴더(`app.getPath('userData')`). Claude 스킬 사본이 논문 폴더 밖
   * `<userData>/skill-host/` 에 사는 자리다(설계 §4.2). Codex 쪽은 쓰지 않는다.
   */
  userData: string
  dryRun: boolean
  open: (path: string) => Promise<string>
  venvPython: (root: string | null) => string | null
  /** Optional: bundled interpreter, so its bin dir can be put on PATH for the agent. */
  bundledPython?: () => string | null
  /** Defaults to process.env; tests pass their own PATH/HOME. */
  env?: Record<string, string | undefined>
}

// ---------------------------------------------------------------- 2. executables

const EXTRA_DIRS = (home: string): string[] => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local', 'bin'),
  join(home, '.npm-global', 'bin'),
  join(home, '.npm', 'bin')
]

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface FindExecutableOptions {
  /** 테스트가 갈아 끼우는 플랫폼(기본은 hostPlatform()). */
  platform?: NodeJS.Platform
  /**
   * PATH **앞에** 둘 디렉터리. 주지 않으면 동봉 자리(bundledDirs)를 쓴다 — 이 기본값이
   * 첫 화면(`connect:status`)과 로그인·채팅(`ChatService`)까지 같은 규칙을 퍼뜨리는 통로다.
   * `KNUAF_AGENT_PATH_ONLY=1` 이면 어느 쪽이든 무시한다("도구 없음" 화면 시험 이음매).
   */
  leadingDirs?: string[]
}

// 시험 이음매 두 개 — 단위 시험이 플랫폼과 동봉 위치를 주입한다(제품 경로는 손대지 않는다).
let platformOverride: NodeJS.Platform | null = null

/** 호스트 플랫폼. 시험이 윈도우 분기를 돌릴 수 있게 갈아 끼울 수 있다(돌려주면 복원). */
export function hostPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform
}

export function setAgentPlatformForTest(platform: NodeJS.Platform | null): NodeJS.Platform | null {
  const prev = platformOverride
  platformOverride = platform
  return prev
}

/** One layout calculation for both implicit chat discovery and explicit AgentCtx discovery. */
export function bundledAgentLayout(base: string, platform: NodeJS.Platform, arch: string): string[] {
  const dirs = [join(base, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`)]
  if (platform === 'win32') dirs.push(join(base, 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin'))
  return dirs
}
function defaultBundledDirs(platform: NodeJS.Platform): string[] {
  const resources = (process as { resourcesPath?: string; defaultApp?: boolean })
  const base = resources.resourcesPath && !resources.defaultApp ? resources.resourcesPath : join(__dirname, '..', '..', 'resources')
  return bundledAgentLayout(base, platform, process.arch)
}

let bundledDirsProvider: (platform: NodeJS.Platform) => string[] = defaultBundledDirs

/** 시험 이음매: 동봉 자리 공급자를 갈아 끼우고 이전 것을 돌려준다. */
export function setBundledDirsProvider(fn: (platform: NodeJS.Platform) => string[]): (platform: NodeJS.Platform) => string[] {
  const prev = bundledDirsProvider
  bundledDirsProvider = fn
  return prev
}

/** 동봉 자리(PATH 앞에 놓일 디렉터리들). 모든 소비 경로가 이 함수를 거친다. */
export function bundledDirs(platform: NodeJS.Platform = hostPlatform()): string[] {
  return bundledDirsProvider(platform)
}

/**
 * First executable named `name` on env.PATH, then in the usual user-install dirs. Absolute path or null.
 *
 * 순서는 **동봉본 → PATH → EXTRA_DIRS** 다. 동봉본을 먼저 두는 이유: 학생 PC 에 다른 버전의
 * codex 가 깔려 있어도 앱이 시험한 조합으로 동작한다.
 *
 * `KNUAF_AGENT_PATH_ONLY=1` 은 PATH 만 본다 — 시험용 이음매다. Finder 로 띄운 앱은 셸의
 * PATH 를 물려받지 않아(/usr/bin:/bin:/usr/sbin:/sbin) 아래 EXTRA_DIRS 가 사실상 유일한
 * 발견 경로인데, 그래서 시험에서 PATH 를 비워도 개발 기계에서는 진짜 codex 가 계속
 * 발견됐다. "도구 없음" 화면은 그 상태를 재현할 방법이 있어야 시험된다.
 */
export function findExecutable(
  name: string,
  env: Record<string, string | undefined> = process.env,
  opts: FindExecutableOptions = {}
): string | null {
  const platform = opts.platform ?? hostPlatform()
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const sep = platform === 'win32' ? ';' : ':'
  // 윈도우에서 실제 키는 `Path` 인 경우가 많다 — 복사된 env(`AgentCtx.env`·시험 입력)에서도
  // 같은 규칙으로 읽어야 도구를 찾는다(검토 W1D-R1-02). 맥은 종전 그대로 `PATH`.
  const fromPath = (env[pathKeyOf(env, platform)] ?? '').split(sep).filter(Boolean)
  const dirs = env.KNUAF_AGENT_PATH_ONLY === '1'
    ? fromPath
    : [...(opts.leadingDirs ?? bundledDirs(platform)), ...fromPath, ...EXTRA_DIRS(home)]
  const names = platform === 'win32' ? winCandidateNames(name) : [name]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const n of names) {
      const candidate = join(dir, n)
      if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * 윈도우에서 찾아 볼 파일 이름들. **확장자 없는 이름은 넣지 않는다** — `CreateProcess` 는
 * 확장자를 스스로 붙이지 않으므로 그 이름은 띄울 수 없고, npm 이 깐 Claude Code 는 한 폴더에
 * `claude`(셸 스크립트)와 `claude.cmd`(실행 shim)를 같이 둔다. 확장자 없는 쪽을 먼저 집으면
 * `execFile` 이 ENOENT 로 죽어 로그인돼 있어도 "연결 상태를 확인하지 못했어요"가 떴다
 * (CL-WIN-01, 윈도우 실기기).
 *
 * `.exe` 를 먼저 본다: 네이티브 설치본은 cmd.exe 를 거치지 않아 인자 이스케이프(`winSpawn` 의
 * `%` 거절 포함)가 필요 없고, `probeVersion` 처럼 셸 없이 띄우는 호출에서도 그대로 동작한다.
 * `.cmd`·`.bat` 은 npm shim 이고 실행 경로들이 `winSpawn` 으로 감싼다.
 */
function winCandidateNames(name: string): string[] {
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
}

/** Explicit context uses exactly the same bundled executable layout as default discovery. */
export function bundledAgentDirs(
  ctx: Pick<AgentCtx, 'appRoot' | 'isPackaged' | 'resourcesPath'>,
  platform: NodeJS.Platform = hostPlatform()
): string[] {
  const base = ctx.isPackaged ? ctx.resourcesPath : join(ctx.appRoot, 'resources')
  return bundledAgentLayout(base, platform, process.arch)
}

/**
 * `<path> --version`, trimmed first line; null on failure or after 8s.
 *
 * 윈도우에서 npm 이 깐 `.cmd` shim 은 셸 없이 띄울 수 없다(Node 의 CVE-2024-27980 수정 이후
 * EINVAL) — 그래서 다른 실행 경로(`chat/claude.ts`·`chat/transport.ts`)와 같은 `winSpawn` 을
 * 거친다. 이걸 빼면 찾은 도우미의 버전만 조용히 비어 배지가 빈칸으로 남는다.
 */
export function probeVersion(path: string): Promise<string | null> {
  return agentActivity.run(async () => {
    const { promise, resolve } = Promise.withResolvers<string | null>()
    try {
      const spec = winSpawn(path, ['--version'])
      execFile(spec.command, spec.args, { timeout: 8000, encoding: 'utf-8', windowsHide: true, ...spec.options }, (err, stdout) => {
        if (err) return resolve(null)
        const line = String(stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean)
        resolve(line ?? null)
      })
    } catch { resolve(null) }
    return promise
  })
}

// ---------------------------------------------------------------- 3. skill source + version

/** Development overrides select the whole bundle, not just the sidecar scripts. */
export function skillSource(appRoot: string, isPackaged: boolean, resourcesPath: string): string {
  const bundled = isPackaged ? join(resourcesPath, 'skill')
    : process.env.KNUAF_SCRIPTS_DIR ? dirname(resolve(process.env.KNUAF_SCRIPTS_DIR))
      : join(appRoot, 'resources', 'skill')
  return resolveSkillSource(bundled)
}

const SKILL_METADATA = ['version.json', 'skill.json', 'install-manifest.json']

/** Walk `abs`, collecting "rel/path:sha256(content)" for the files installSkill copies. */
function skillFingerprint(abs: string, rel: string, out: string[]): void {
  if (!existsSync(abs)) return
  for (const name of readdirSync(abs)) {
    const child = join(abs, name)
    if (!copyFilter(child)) continue
    try {
      const st = statSync(child)
      if (st.isDirectory()) skillFingerprint(child, `${rel}/${name}`, out)
      else if (st.isFile()) out.push(`${rel}/${name}:${createHash('sha256').update(readFileSync(child)).digest('hex')}`)
    } catch { /* vanished between readdir and stat */ }
  }
}

/**
 * sha256 over the CONTENT of every installed file, first 12 hex. Stable across
 * machines for the same content.
 *
 * This used to hash SKILL.md plus `name:size` of scripts/*.py, which left two blind
 * spots: references/ was not hashed at all (replacing all 21 documents produced the
 * same version), and a same-length script edit was invisible. installSkill then
 * reported 'unchanged' and a project kept a stale copy of the rules.
 */
export function skillVersion(source: string): string {
  return skillDigest(source).slice(0, 12)
}

/** `skillVersion` 의 전체 값 — 두 사본을 대조할 때 12자 절단 전에 비교한다. */
function skillDigest(source: string): string {
  const h = createHash('sha256')
  const skillMd = join(source, 'SKILL.md')
  h.update(existsSync(skillMd) ? readFileSync(skillMd) : Buffer.alloc(0))
  const entries: string[] = []
  for (const dir of ['references', 'scripts', 'assets']) skillFingerprint(join(source, dir), dir, entries)
  for (const name of SKILL_METADATA) {
    const file = join(source, name)
    if (existsSync(file)) entries.push(`${name}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`)
  }
  entries.sort()
  for (const e of entries) h.update('\n' + e)
  return h.digest('hex')
}

/**
 * 두 사본이 **같은 내용**인가(C-01ⓒ). 판 표시(`VERSION_FILE`)는 학생이 풀고 고칠 수 있으므로
 * 설치본 무결성의 근거가 못 된다 — 동봉본과 파일 내용을 그대로 대조한다.
 *
 * 대상은 스킬이 실제로 싣는 것과 같은 집합이다(`SKILL.md` + `references`/`scripts`/`assets` +
 * 판 metadata). 뿌리에 학생이 둔 다른 파일(`student-note.txt` 등)은 양쪽 모두에서 빠지므로
 * 재설치를 부르지 않는다. 읽기 실패(권한·사라짐)는 불일치로 닫는다.
 */
export function sameTreeContent(a: string, b: string): boolean {
  try { return skillDigest(a) === skillDigest(b) } catch { return false }
}

// ---------------------------------------------------------------- 4. targets + state

export const VERSION_FILE = '.knuaf-dev-version'

export const SKILL_NAME = 'knuaf-dev'

/**
 * 이름이 바뀌기 전의 스킬 폴더 이름. 학생 작업폴더에 이미 깔려 있던 것을 그대로 두면
 * 같은 스킬 둘이 함께 enabled 로 보여 모델이 옛 지침을 따를 수 있다 —
 * `skillBackupDir` 주석이 말하는 바로 그 사고다. 새로 깔 때 형제 자리에서 치운다.
 */
export const SUPERSEDED_SKILL_NAMES = ['knuaf-doc']

/**
 * Install dirs. **Claude lives outside the paper folder** (`<userData>/skill-host/…`, §4.2) so
 * folder settings can never reach it and the agent cannot rewrite its own rules; Codex keeps its
 * project-local copy (`<root>/.agents/skills/…`) because Codex has no plugin-dir equivalent and the
 * folder copy is how it discovers the skill at all.
 */
export function skillTargets(root: string, userData: string): Record<AgentKind, string> {
  return {
    claude: skillHostDir(userData),
    codex: join(root, '.agents', 'skills', SKILL_NAME)
  }
}

/**
 * 앱 스킬 자리를 설치하는 동안만 쓰기 가능하게 만든다(설계 §4.2 '권한 풀기→복사→잠금').
 *
 * 설치본은 읽기 전용으로 잠근다 — 도우미가 자기 규칙을 고쳐 다음 턴의 권한 경계를 바꾸는 길을
 * 막기 위해서다. 그런데 읽기 전용 폴더에는 복사도 못 하므로, 다시 깔 때는 먼저 풀고 끝나면
 * 되잠근다. `chmod` 는 윈도우에서도 Node 가 쓰기 비트만 토글한다(읽기 전용 속성).
 * 링크는 따라가지 않는다 — 링크 대상은 앱 자리가 아니다.
 */
export function setTreeAccess(target: string, writable: boolean): void {
  let st
  try { st = lstatSync(target) } catch { return }
  if (st.isSymbolicLink()) return
  try { chmodSync(target, st.isDirectory() ? (writable ? 0o755 : 0o555) : (writable ? 0o644 : 0o444)) } catch { /* 권한이 이미 그렇거나 파일시스템이 지원하지 않는다 */ }
  if (!st.isDirectory()) return
  let names: string[]
  try { names = readdirSync(target) } catch { return }
  for (const name of names) setTreeAccess(join(target, name), writable)
}

/**
 * 설치본 판정. `source` 를 주면 판 표시가 같아도 **내용 지문**까지 대조한다(C-01ⓒ) —
 * 표시는 학생이 풀고 고칠 수 있으므로, 내용이 어긋나면 'outdated' 로 다시 깐다.
 */
export function skillState(target: string, version: string, source?: string): SkillState {
  if (!existsSync(target)) return 'missing'
  let have: string
  try {
    have = readFileSync(join(target, VERSION_FILE), 'utf-8').trim()
  } catch {
    return 'outdated'
  }
  if (have !== version) return 'outdated'
  if (source !== undefined && !sameTreeContent(target, source)) return 'outdated'
  return 'installed'
}

// ---------------------------------------------------------------- 5. install

function stamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const SKIP_NAMES = new Set(['__pycache__', '.venv', '.DS_Store'])
function copyFilter(src: string): boolean {
  const name = basename(src)
  return !SKIP_NAMES.has(name) && !name.endsWith('.pyc')
}

/**
 * Where a superseded copy goes. It must NOT be a sibling of `target`: a backup left
 * inside `<root>/.claude/skills/` is itself discovered as a skill, so the project ends
 * up with two near-identical knuaf-dev entries competing to be loaded.
 * `target` is `<root>/<.claude|.agents>/skills/knuaf-dev` (see skillTargets).
 */
export function skillBackupDir(target: string): string {
  const root = dirname(dirname(dirname(target)))
  return join(root, '.knuaf-gui', 'skill-backups')
}

/**
 * 옛 이름으로 깔려 있던 형제 폴더를 백업으로 옮긴다. 지우지 않는 이유는 그 안에
 * 학생이 손댄 것이 있을 수 있어서다 — 백업 자리는 skills/ 밖이라 다시 발견되지 않는다.
 * 새로 깔 것이 이미 최신이어도 돌려야 한다. 옛 폴더는 그와 무관하게 남아 있다.
 */
export function retireSupersededSkills(target: string): string[] {
  const skills = dirname(target)
  const moved: string[] = []
  for (const name of SUPERSEDED_SKILL_NAMES) {
    const old = join(skills, name)
    if (old === target || !existsSync(old)) continue
    const dir = skillBackupDir(target)
    mkdirSync(dir, { recursive: true })
    const kind = basename(dirname(skills))  // '.claude' | '.agents'
    let dest = join(dir, `${kind}-${name}-${stamp()}`)
    let i = 1
    while (existsSync(dest)) dest = join(dir, `${kind}-${name}-${stamp()}-${i++}`)
    // 윈도우에서 잠깐 막히면(EPERM/EBUSY/EACCES) 짧게 다시 시도한다 — 폴더 이동이라 폴백은 없다.
    renameWithRetry(old, dest)
    moved.push(dest)
  }
  return moved
}

/**
 * Copy the bundle payload and root metadata; GUI ownership lives outside it.
 *
 * `compareTo` 는 대조용 동봉본이다 — 주면 판 표시가 같아도 내용이 다를 때 다시 깐다(C-01ⓒ).
 * 생략하면 판 표시만 본다(옛 호출자·시험).
 */
export function installSkill(source: string, target: string, version: string, compareTo?: string): InstallResult {
  // A missing build bundle must never retire a student's working installed copy.
  const skillMd = join(source, 'SKILL.md')
  if (!existsSync(skillMd)) throw new Error('스킬 원본에 SKILL.md가 없음: ' + source)
  retireSupersededSkills(target)
  const project = dirname(dirname(dirname(target)))
  const markerDir = join(project, '.knuaf-gui')
  mkdirSync(markerDir, { recursive: true })
  const marker = writeFileAtomic(join(markerDir, 'skill-install.json'), JSON.stringify({
    schema: 'knuaf-gui/skill-install@1',
    installs: [{ path: '.claude/skills/knuaf-dev' }, { path: '.agents/skills/knuaf-dev' }]
  }), { mode: 0o600 })
  if (!marker.ok) throw marker.error
  // 대조본을 주면 내용 지문까지 본다 — 표시만 같고 내용이 어긋난 사본은 'updated' 로 다시 깐다.
  const state = skillState(target, version, compareTo)
  if (state === 'installed') return { action: 'unchanged' }

  // 앱 스킬 자리(논문 폴더 밖)만 읽기 전용으로 잠근다(§4.2). Codex 의 폴더 사본은 잠그지 않는다 —
  // 그 자리는 학생 폴더 안이고, 다른 도구·학생이 손댈 수 있어야 한다(설치 때마다 덮어쓴다).
  const lock = isSkillHostPath(target)
  if (lock) setTreeAccess(target, true)
  try {
    let backup: string | undefined
    if (state === 'outdated') {
      const dir = skillBackupDir(target)
      mkdirSync(dir, { recursive: true })
      const kind = basename(dirname(dirname(target)))  // '.claude' | '.agents'
      backup = join(dir, `${kind}-${stamp()}`)
      let i = 1
      while (existsSync(backup)) backup = join(dir, `${kind}-${stamp()}-${i++}`)
      renameWithRetry(target, backup)
      // 위에서 복사를 위해 풀었던 권한이 백업에 그대로 따라간다 — 백업도 다시 잠근다.
      if (lock) setTreeAccess(backup, false)
    }

    mkdirSync(target, { recursive: true })
    cpSync(skillMd, join(target, 'SKILL.md'))
    for (const dir of ['references', 'scripts', 'assets']) {
      const from = join(source, dir)
      if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true, filter: copyFilter })
    }
    for (const name of SKILL_METADATA) {
      const from = join(source, name)
      if (existsSync(from)) cpSync(from, join(target, name))
    }
    writeFileSync(join(target, VERSION_FILE), version + '\n', 'utf-8')

    return backup ? { action: 'updated', backup } : { action: 'installed' }
  } finally {
    if (lock) setTreeAccess(target, false)
  }
}

// ---------------------------------------------------------------- 6. launch script

/** POSIX single-quote: safe for any bytes including spaces, Hangul and quotes. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * `codex -c` 오버라이드 문자열 — ~/.codex/skills·~/.agents/skills 에 남은 전역
 * `knuaf-dev` 사본을 이 프로세스에서만 끈다. 같은 이름의 낡은 사본이 프로젝트 사본과
 * 함께 enabled 로 보이면 모델이 옛 지침을 따를 수 있다(~/.codex 는 deprecated 지만
 * 아직 스캔된다). 사용자의 config.toml 은 건드리지 않는다 — 오버라이드는 이 프로세스만.
 * 전역 사본이 없으면 null — 인자를 늘리지 않는다.
 */
export function codexSkillConfigOverride(home: string | undefined): string | null {
  if (!home) return null
  const paths = [SKILL_NAME, ...SUPERSEDED_SKILL_NAMES].flatMap((name) => [
    join(home, '.codex', 'skills', name, 'SKILL.md'),
    join(home, '.agents', 'skills', name, 'SKILL.md')
  ]).filter((p) => existsSync(p))
  if (paths.length === 0) return null
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `skills.config=[${paths.map((p) => `{path="${esc(p)}",enabled=false}`).join(',')}]`
}

export const BANNER = `${APP_NAME}가 AI 도우미를 엽니다. 이 창을 닫으면 도우미도 종료돼요.`

/** Directories an agent process needs ahead of PATH: project venv, bundled runtime, user installs. */
export function agentBinDirs(o: Pick<LaunchScriptOptions, 'venvBin' | 'bundledBin'>): string[] {
  const dirs: string[] = []
  if (o.venvBin) dirs.push(o.venvBin)
  if (o.bundledBin) dirs.push(o.bundledBin)
  dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

export function buildLaunchScript(o: LaunchScriptOptions, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? buildLaunchScriptWin(o) : buildLaunchScriptPosix(o)
}

/** 실행물 확장자 — 맥·리눅스는 `.command`(Terminal 이 열어 준다), 윈도우는 `.cmd`. */
export function launchScriptExt(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '.cmd' : '.command'
}

/** 배치 파일에서 `%` 는 변수 확장이다 — 글자 그대로 넣으려면 `%%` 로 적는다. */
function batLiteral(s: string): string {
  return s.replace(/%/g, '%%')
}
/** 배치의 `cd`·`set` 처럼 따옴표 **안에** 넣는 값 — `%` 만 `%%` 로 막으면 된다. */
function batQuote(s: string): string {
  return `"${batLiteral(s)}"`
}
/** 배치에서 cmd 메타문자 — `%` 는 `%%` 로 따로 막으므로 여기 없다(배치에서 `^%` 는 안 통한다). */
const BAT_META = /([()\][!^"`<>&|;, *?])/g

/**
 * 배치 shim의 **실행 파일 경로**. 명령 이름은 shim 의 `%*` 로 다시 해석되지 않으므로 **한 층**만
 * 막는다(`win.ts` 의 `escapeCommand` 와 같은 규칙 — `%` 는 배치 확장이라 `%%`).
 * 두 층으로 막으면 첫 cmd 해석 뒤에도 `^` 가 남아 실행 파일 이름을 찾지 못한다
 * (W1C-R1-01 확인. cross-spawn `parse.js` 도 명령에는 `escape.command` 만 쓴다).
 * 네이티브 실행물에는 쓰지 않는다. 공백을 ^로만 막으면 cmd가 실행물을 찾더라도 CRT가
 * 따옴표 없는 argv[0]을 공백에서 잘라 경로 뒷부분을 추가 인자로 만든다(Windows CI QA-04).
 */
function batCommand(s: string): string {
  return batLiteral(s).replace(BAT_META, '^$1')
}

/**
 * 배치 파일의 **실행 줄**에 넣을 인자 하나. 확장 단계가 명령줄과 달라 `win.ts` 의 함수를
 * 쓰지 않는다(W1C-R1-01). 순서가 중요하다:
 *   1. `%` → `%%` — 배치 확장은 여기서만 막을 수 있다.
 *   2. MSVCRT 인용 — `"` 앞과 끝의 역슬래시를 두 배로.
 *   3. cmd 메타문자를 `^` 로 — 대상이 npm shim(`claude.cmd`/`codex.cmd`)이면 **두 번**.
 *      shim 은 `%*` 로 한 번 더 파싱되기 때문이다(`win.ts` 주석의 cross-spawn 규칙과 같은 이유).
 *      대상이 `.exe`(설치본에 동봉한 `codex.exe`)면 **한 번**만 — cmd 가 한 번 읽고 바로
 *      MSVCRT 로 넘기므로, 두 번 막으면 `^` 가 인자에 남아 설정값이 깨진다(실기기 QA-04).
 */
function batArg(s: string, doubleEscape: boolean): string {
  let a = batLiteral(s)
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1')
  a = `"${a}"`
  a = a.replace(BAT_META, '^$1')
  if (doubleEscape) a = a.replace(BAT_META, '^$1')
  return a
}
/** 대상이 `%*` 로 인자를 다시 읽는 배치(npm shim)인지 — `win.ts` 의 `CMD_SHIM` 과 같은 규칙. */
function isBatchShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}
/** cmd 인자는 **한 줄**이라야 한다 — 첫 프롬프트의 줄바꿈을 한 칸으로 눌러 담는다. */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' ').trim()
}

function buildLaunchScriptPosix(o: LaunchScriptOptions): string {
  const pathParts = agentBinDirs(o).map(sq)
  pathParts.push('"$HOME/.local/bin"', '"$PATH"')

  // 비상구(외부 터미널)에도 앱 채팅과 같은 1층을 건다(설계 §4.1-D·§15 2단계).
  //   `--setting-sources=` 빈 목록 — 폴더·사용자 설정을 하나도 읽지 않는다(앱 채팅의
  //   `settingSources: []` 와 같은 값). `=` 로 붙여야 한다 — 공백이면 뒤 인자를 삼킨다.
  //   `--strict-mcp-config` — 폴더 `.mcp.json` 을 끈다.
  //   `--plugin-dir-no-mcp` — 스킬은 논문 폴더가 아니라 앱 자리에서만 공급하고, 그 플러그인의
  //     MCP 발견도 끈다(`claudeIsolationOptions` 의 `skipMcpDiscovery` 와 같은 뜻).
  //   `--append-system-prompt-file` — §11.5 의 학생 규칙 구획. 파일이 없으면 인자도 없다.
  //   `--disallowedTools=…` 는 `=` 로 묶어야 한다 — 공백이면 가변 인자가 뒤따르는 첫 프롬프트까지
  //     삼킨다(7364349).
  const skillOff = o.agent === 'codex' ? codexSkillConfigOverride(o.home) : null
  // 1층 잠금(§4.1-C) — 열거에서 끌 수 있다고 판정한 이름만 `-c …=false` 로 붙는다.
  const lockArgs = (o.lockArgs ?? []).map((a) => ' ' + sq(a)).join('')
  const claudeFlags = [
    '--setting-sources=',
    '--strict-mcp-config',
    ...(o.skillHost ? ['--plugin-dir-no-mcp', sq(o.skillHost)] : []),
    ...(o.guardPromptFile ? ['--append-system-prompt-file', sq(o.guardPromptFile)] : []),
    "'--disallowedTools=AskUserQuestion'"
  ].join(' ')
  const execLine = o.agent === 'claude'
    ? `exec ${sq(o.agentPath)} ${claudeFlags} ${sq(o.firstPrompt)}`
    : `exec ${sq(o.agentPath)}${lockArgs}${skillOff ? ` -c ${sq(skillOff)}` : ''}` // codex: no positional prompt; the user types in the TUI

  return [
    '#!/bin/bash',
    `cd ${sq(o.root)} || exit 1`,
    `export PATH=${pathParts.join(':')}`,
    'export KNUAF_DOC_APP=1',
    // 이 창에서 학생·도우미가 직접 돌리는 규칙집 스크립트(gg_*)도 UTF-8 로 말하게 한다 —
    // 윈도우 기본(cp949)으로 파이프하면 받는 쪽에서 한글이 깨진다(사용자 설정도 덮는다).
    // 대가: PYTHONUTF8 은 stdout 뿐 아니라 Python 의 기본 파일 인코딩도 UTF-8 로 바꾼다 —
    // 인코딩 없이 cp949 파일을 읽는 다른 도구에는 영향이 갈 수 있다(규칙집은 UTF-8 전제).
    'export PYTHONUTF8=1',
    'export PYTHONIOENCODING=utf-8',
    // ~/.claude/CLAUDE.md 같은 사용자 메모리의 @import가 외부 경로를 가리키면 영어 보안
    // 프롬프트가 학생에게 뜬다 — 이 앱이 띄우는 도우미는 메모리 파일을 아예 읽지 않는다.
    'export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    // 스킬 스크립트가 논문 폴더에 `__pycache__` 를 남기지 않게 한다(§4.1 표). 앱 채팅도 같은 값을
    // 넘긴다(`contracts.ts subscriptionEnv`·`claude.ts` query 옵션) — 세 경로가 같은 값이어야 한다.
    'export PYTHONDONTWRITEBYTECODE=1',
    `printf '%s\\n' ${sq(BANNER)}`,
    "printf '%s\\n' ''",
    execLine,
    ''
  ].join('\n')
}

/**
 * 윈도우 대응 실행물 — `.command`(bash) 대신 `.cmd`(배치)다. 같은 일을 한다: 작업 폴더로
 * 이동하고, 프로젝트 .venv·번들 파이썬 자리를 PATH 앞에 두고, 같은 환경변수를 세우고,
 * 같은 가드레일(`--setting-sources=` / `--strict-mcp-config` / 앱 스킬 자리 / 전역 knuaf-dev 사본
 * 끄기)로 도우미를 띄운다.
 *
 * 다른 곳 둘: cmd 에는 `exec` 가 없고(그냥 실행한다), **한 인자에 줄바꿈을 담을 수 없다** —
 * 첫 프롬프트의 줄바꿈은 한 칸으로 눌러 한 줄로 만든다(문장 뜻은 그대로다).
 *
 * **코드페이지.** 파일은 UTF-8(BOM 없음)로 쓰는데 cmd 는 배치 줄을 콘솔 코드페이지(한국어
 * 윈도우는 949)로 읽는다. 그러면 한글 경로가 깨져 `cd` 가 "구문이 잘못되었습니다" 로 실패한다
 * (실기기 QA-04). cmd 는 배치를 **한 줄씩 다시 읽으므로** 둘째 줄에서 `chcp 65001` 로 바꾸면
 * 그 뒤 줄은 UTF-8 로 읽힌다 — 그래서 그 앞 두 줄은 ASCII 여야 한다.
 *
 * **실패하면 창을 남긴다.** 이동·실행이 실패하면 창이 바로 닫혀 학생은 이유를 못 본다 —
 * 오류가 나면 `pause` 로 멈춘다(정상 종료 0 이면 그냥 닫힌다). 다른 배치를 직접 실행하면
 * 제어가 돌아오지 않으므로 실행 부분은 자식 cmd 에 맡긴다. `call` 은 사용자 경로/인자를
 * 다시 확장하므로 쓰지 않는다. 부모 배치가 종료 코드를 보존하고 실패를 보여 준다.
 */
function buildLaunchScriptWin(o: LaunchScriptOptions): string {
  // 윈도우에는 홈브루 자리가 없다(agentBinDirs 의 그 둘은 맥 전용) — venv·번들만 앞에 둔다.
  const dirs = [o.venvBin, o.bundledBin].filter((d): d is string => !!d).map(batLiteral)
  const skillOff = o.agent === 'codex' ? codexSkillConfigOverride(o.home) : null
  const dbl = isBatchShim(o.agentPath)
  // .exe의 명령 이름은 argv[0]으로도 읽힌다. cmd escape 대신 경로 전체를 인용해야 한다.
  const command = dbl ? batCommand(o.agentPath) : batQuote(o.agentPath)
  const lockArgs = (o.lockArgs ?? []).map((a) => ' ' + batArg(a, dbl)).join('')
  // Claude 1층 인자 — POSIX 판과 같은 값. 경로는 `/` 구분자로 넘긴다(스킬 자리 판정이 `\` 를
  // 거부하고, CLI 도 윈도우에서 `/` 를 그대로 받는다). 배치에서 `=` 가 든 한 낱말은 그대로 인용.
  const claudeFlags = [
    batArg('--setting-sources=', dbl),
    batArg('--strict-mcp-config', dbl),
    ...(o.skillHost ? [batArg('--plugin-dir-no-mcp', dbl), batArg(o.skillHost, dbl)] : []),
    ...(o.guardPromptFile ? [batArg('--append-system-prompt-file', dbl), batArg(o.guardPromptFile, dbl)] : []),
    batArg('--disallowedTools=AskUserQuestion', dbl)
  ].join(' ')
  const execLine = o.agent === 'claude'
    ? `${command} ${claudeFlags} ${batArg(oneLine(o.firstPrompt), dbl)}`
    : `${command}${lockArgs}${skillOff ? ` -c ${batArg(skillOff, dbl)}` : ''}`

  return [
    '@echo off',
    // 이 줄까지는 ASCII 다 — 다음 줄부터 UTF-8 로 읽힌다(위 주석의 코드페이지).
    'chcp 65001 >nul',
    // 지연 확장을 끈다 — `!` 가 든 경로·문장이 글자 그대로 가게(레지스트리 설정과 무관하게).
    'setlocal DisableDelayedExpansion',
    'if "%~1"=="--knuaf-run" goto knuaf-run',
    // 자식은 같은 파일의 실행 절만 읽는다. 고정 인자 하나뿐이고 원문 프롬프트를 재확장하지 않는다.
    '"%ComSpec%" /d /v:off /s /c ""%~f0" --knuaf-run"',
    'set "KNUAF_LAUNCH_EXIT=%errorlevel%"',
    'if "%KNUAF_LAUNCH_EXIT%"=="0" exit /b 0',
    'echo.',
    'echo 도우미를 실행하지 못했거나 오류로 끝났어요. 위 오류 내용을 확인해 주세요. 종료 코드: %KNUAF_LAUNCH_EXIT%',
    'pause',
    'exit /b %KNUAF_LAUNCH_EXIT%',
    ':knuaf-run',
    `cd /d ${batQuote(o.root)} || exit /b 1`,
    `set "PATH=${dirs.join(';')}${dirs.length ? ';' : ''}%PATH%"`,
    'set "KNUAF_DOC_APP=1"',
    // 위 맥 스크립트와 같은 이유 — cmd 의 기본 코드페이지(949)로 파이프하면 한글이 깨진다.
    // 대가도 같다: PYTHONUTF8 은 Python 의 기본 파일 인코딩까지 UTF-8 로 바꾼다 —
    // 인코딩 없이 cp949 파일을 읽는 다른 도구에는 영향이 갈 수 있다(규칙집은 UTF-8 전제).
    'set "PYTHONUTF8=1"',
    'set "PYTHONIOENCODING=utf-8"',
    'set "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"',
    'set "PYTHONDONTWRITEBYTECODE=1"',
    `echo ${batLiteral(BANNER)}`,
    'echo.',
    execLine,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n')
}

// ---------------------------------------------------------------- 7. launch

export function workFolderInstructions(root: string): string {
  return `작업 폴더: ${root}\n이 폴더 자체가 논문 작업 폴더예요. 논문 작업 파일은 여기서 바로 다루세요. 논문 작업용 하위 폴더(예: knuaf-work)를 새로 만들어 그 안에서 작업하지 마세요. 스킬 스크립트(gg.py·gg_deps.py 등)가 정해진 자리에 스스로 만드는 폴더(.venv, sources/extracts 등)는 그대로 두어도 됩니다.`
}

export function firstPromptFor(revision: number | null, root?: string): string {
  const base = revision === null || revision < 1 ? '시작하기' : '이어서 하기'
  // 작업 루트를 고정하고, 스킬 스크립트가 정해진 자리에 만드는 폴더는 허용한다.
  return root ? `${base}\n\n${workFolderInstructions(root)}` : base
}

export async function launch(o: LaunchOptions, deps: LaunchDeps = {}): Promise<LaunchResult> {
  const writeFile = deps.writeFile ?? ((p, data, mode) => writeFileSync(p, data, { encoding: 'utf-8', mode }))
  const chmod = deps.chmod ?? chmodSync
  mkdirSync(o.supportDir, { recursive: true })
  const scriptPath = join(o.supportDir, `launch-${randomBytes(4).toString('hex')}${launchScriptExt()}`)
  writeFile(scriptPath, buildLaunchScript(o), 0o755)
  chmod(scriptPath, 0o755) // writeFile mode is masked by umask; make sure it is executable
  if (!o.dryRun) {
    if (!deps.open) throw new Error('launch: open() is required unless dryRun')
    const err = await deps.open(scriptPath)
    if (err) throw new Error('터미널을 열지 못함: ' + err)
  }
  return { scriptPath }
}

// ---------------------------------------------------------------- 8. composed API

/** `root` is the open project; with no project open the skill reports 'missing'. */
export async function getStatus(ctx: AgentCtx, root: string | null): Promise<AgentStatus> {
  return agentActivity.run(async () => {
  const env = ctx.env ?? process.env
  const leadingDirs = bundledAgentDirs(ctx)
  const probe = async (name: AgentKind): Promise<AgentBinary> => {
    const path = findExecutable(name, env, { leadingDirs })
    return { found: !!path, path, version: path ? await probeVersion(path) : null }
  }
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')])
  const bundle = skillSource(ctx.appRoot, ctx.isPackaged, ctx.resourcesPath)
  const version = skillVersion(bundle)
  // Claude 사본은 폴더 밖(앱 자리)이라 폴더가 없어도 판정할 수 있다(§4.2). Codex 는 폴더 사본.
  return {
    claude,
    codex,
    skill: {
      claude: skillState(skillHostDir(ctx.userData), version, bundle),
      codex: root ? skillState(skillTargets(root, ctx.userData).codex, version, bundle) : 'missing'
    },
    skillVersion: version
  }
  })
}

export const agentApi = {
  status: (ctx: AgentCtx, root: string | null): Promise<AgentStatus> => getStatus(ctx, root),

  installSkill: (ctx: AgentCtx, kind: AgentKind, root: string | null): InstallResult => {
    agentActivity.ensureActive()
    // Claude 사본은 폴더 밖(앱 자리)이라 연 폴더가 필요 없다(§4.2). Codex 는 폴더 사본이라 필요하다.
    if (kind === 'codex' && !root) throw new Error('먼저 작업 폴더를 열어 주세요.')
    const source = skillSource(ctx.appRoot, ctx.isPackaged, ctx.resourcesPath)
    return installSkill(source, skillTargets(root ?? ctx.userData, ctx.userData)[kind], skillVersion(source), source)
  },

  launch: (ctx: AgentCtx, o: { root: string; kind: AgentKind; revision: number | null }): Promise<LaunchResult> => {
    return agentActivity.run(async () => {
    const env = ctx.env ?? process.env
    const agentPath = findExecutable(o.kind, env, { leadingDirs: bundledAgentDirs(ctx) })
    if (!agentPath) throw new Error(`${o.kind} 실행 파일을 찾지 못함 (PATH에 없음)`)
    const venv = ctx.venvPython(o.root)
    const bundled = ctx.bundledPython?.() ?? null
    // 1층 잠금(설계 §4.1-C '터미널 Codex — 실패 닫힘') — 열거에서 남은 것이 0개일 때만 연다.
    const lockArgs = o.kind === 'codex' ? await terminalLockArgs(agentPath, o.root, env) : undefined
    return launch({
      root: o.root,
      agent: o.kind,
      agentPath,
      venvBin: venv ? dirname(venv) : null,
      bundledBin: bundled ? dirname(bundled) : null,
      firstPrompt: firstPromptFor(o.revision, o.root),
      home: ctx.home,
      supportDir: ctx.supportDir,
      dryRun: ctx.dryRun,
      // 앱 스킬 자리는 Claude 터미널에만 붙는다(§15 2단계). `/` 구분자로 넘긴다 — 스킬 자리
      // 판정(`isSkillHostPath`)과 CLI 인자가 같은 모양을 보게.
      ...(o.kind === 'claude' ? { skillHost: skillHostRoot(ctx.userData).replace(/\\/g, '/') } : {}),
      ...(lockArgs ? { lockArgs } : {})
    }, { open: ctx.open })
    })
  }
}

/**
 * 터미널 Codex 의 `-c` 잠금 인자. 앱 연결이 없을 수도 있으므로 **짧게 띄운** `codex app-server`
 * 로 열거한다(설계 §4.1-C 1번 "앱 연결로; 없으면 띄운다"). 띄우기·열거 어느 쪽이 실패해도
 * 열지 않는다 — 2층 비상구는 닫히고 앱 안 대화는 그대로 남는다.
 */
async function terminalLockArgs(agentPath: string, root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const [{ serverArgsFor }, { JsonRpcProcess }, { codexToolLock, TERMINAL_ENUM_FAILED_COPY }] = await Promise.all([
    import('./chat/codex'),
    import('./chat/transport'),
    import('./chat/codexToolLock')
  ])
  const rpc = new JsonRpcProcess(agentPath, serverArgsFor(env), root, env)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'knuaf_dev_gui', version: '0.6.2' }, capabilities: { experimentalApi: true } })
    rpc.send({ method: 'initialized', params: {} })
    const outcome = await codexToolLock({ root, form: 'terminal', injected: [], rpc })
    if (!outcome.ok) throw new AgentToolLockError(outcome.studentCopy)
    // `form` 은 요청이 고정한 값이다 — 서버 응답이 아니라 이 호출의 결과 꼴을 다시 확인한다.
    if (outcome.form !== 'terminal') throw new AgentToolLockError(TERMINAL_ENUM_FAILED_COPY)
    return outcome.args
  } catch (error) {
    if (error instanceof AgentToolLockError) throw error
    throw new AgentToolLockError(TERMINAL_ENUM_FAILED_COPY)
  } finally {
    await rpc.stop().catch(() => {})
  }
}
