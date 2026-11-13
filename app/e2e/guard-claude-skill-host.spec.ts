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
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  buildLaunchScript, installSkill, setTreeAccess, skillBackupDir, skillSource, skillState, skillTargets, skillVersion,
  VERSION_FILE
} from '../src/main/agent'
import {
  autoAllow, claudeIsolationOptions, hostWriteDecision, SKILL_PROMPT
} from '../src/main/chat/claude'
import { isSkillHostPath, skillHostDir, skillHostRoot } from '../src/main/guard/scope'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

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

test('설치본 내용이 바뀌면 판 표시가 같아도 다시 깐다 — 내용 지문 대조(C-01ⓒ)', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  expect(skillState(target, version, source)).toBe('installed')

  // 잠금을 풀고 스크립트 한 줄만 바꾼다. `VERSION_FILE` 은 그대로라 판 표시만 보면 '설치됨'이다.
  setTreeAccess(target, true)
  const script = join(target, 'scripts', 'gg.py')
  writeFileSync(script, readFileSync(script, 'utf-8') + '\n# student edit\n')
  expect(readFileSync(join(target, VERSION_FILE), 'utf-8').trim()).toBe(version)

  // 판 표시만 보는 옛 판정은 'installed' 라고 답한다 — 내용 지문을 주면 'outdated' 여야 한다.
  expect(skillState(target, version)).toBe('installed')
  expect(skillState(target, version, source)).toBe('outdated')
  expect(installSkill(source, target, version, source).action).toBe('updated')
  expect(skillState(target, version, source)).toBe('installed')
})

test('자동 실행은 설치본 내용이 동봉본과 같을 때만 — 변조된 스크립트는 카드로 간다(C-01ⓒ)', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  const script = join(target, 'scripts', 'gg.py').replace(/\\/g, '/')
  const call = { command: `python3 "${script}" status` }

  expect(autoAllow(root, 'Bash', call, [], userData, source)).toBe(true)

  setTreeAccess(target, true)
  writeFileSync(join(target, 'scripts', 'gg.py'), readFileSync(join(target, 'scripts', 'gg.py'), 'utf-8') + '\n# student edit\n')
  // 변조된 스크립트를 스스로 실행하는 호출은 더 이상 카드 없이 지나가지 않는다.
  expect(autoAllow(root, 'Bash', call, [], userData, source)).toBe(false)

  installSkill(source, target, version, source)
  expect(autoAllow(root, 'Bash', call, [], userData, source)).toBe(true)
  // 동봉본에 없는 뿌리 파일은 지문 대상이 아니다 — 스킬 밖에 둔 학생 파일은 재설치를 부르지 않는다.
  setTreeAccess(target, true)
  writeFileSync(join(target, 'student-note.txt'), 'preserve me')
  expect(skillState(target, version, source)).toBe('installed')
  expect(installSkill(source, target, version, source).action).toBe('unchanged')
  expect(autoAllow(root, 'Bash', call, [], userData, source)).toBe(true)
  setTreeAccess(target, true)
})

// ------------------------------------------------------ canUseTool 최종 판정 (C-01ⓒ)

/**
 * `canUseTool` 이 실제로 내놓는 **최종 `PermissionResult`** 를 본다.
 *
 * `autoAllow` 의 반환값만 보던 시험(위)은 그 뒤의 `trusted()` 분기가 불일치를 덮는 것을 못
 * 잡았다(검토 Roh R2). 그래서 `claude.ts` 를 CJS 로 옮겨 vm 에서 돌리고 SDK `query` 만 가짜로
 * 꽂아, 실제 `run()` 이 만든 `options.canUseTool` 을 그대로 부른다 — 판정 순서·분기·카드까지
 * 실물 코드가 돈다(선례: `scripts/tests/kordoc-mcp-wiring.test.mjs`).
 */
const nodeRequire = createRequire(__filename)

/** vm 안 값은 프로토타입이 달라 `toEqual` 이 실패한다 — JSON 으로 옮겨 비교한다. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function claudeModule(): Record<string, any> {
  const captured: any[] = []
  const sdk = {
    query: (args: any) => {
      captured.push(args)
      return {
        supportedCommands: async () => [{ name: 'knuaf-dev' }],
        accountInfo: async () => ({}),
        close() {},
        async *[Symbol.asyncIterator]() { /* 한 턴에 메시지 없음 */ }
      }
    }
  }
  const cache = new Map<string, { exports: Record<string, any> }>()
  const load = (file: string): Record<string, any> => {
    const target = resolve(file)
    const hit = cache.get(target)
    if (hit) return hit.exports
    const module = { exports: {} as Record<string, any> }
    cache.set(target, module)
    const code = transpileModule(readFileSync(target, 'utf-8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      module, exports: module.exports, require: (name: string) => {
        if (name === '@anthropic-ai/claude-agent-sdk') return sdk
        if (!name.startsWith('.')) return nodeRequire(name)
        const base = resolve(dirname(target), name)
        return load(existsSync(base + '.ts') ? base + '.ts' : base)
      },
      process, Buffer, console, crypto: globalThis.crypto, Promise, URL,
      AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate
    })
    return module.exports
  }
  const mod = load(join(__dirname, '../src/main/chat/claude.ts'))
  return { ...mod, captured }
}

interface Rig { ask: (name: string, input: unknown) => Promise<any>; cards: any[]; answer: (allow: boolean) => void }

/**
 * 한 턴을 실제로 돌려 `canUseTool` 을 얻는다. `trusted` 는 학생 설정('묻지 않기'·'이 폴더는
 * 계속 허용')을 흉내 내는 값이다. `bundle: false` 는 동봉본을 모르는 옛 호출자다.
 */
async function rig(
  boxed: { root: string; userData: string }, opts: { trusted: boolean; bundle?: boolean }
): Promise<Rig> {
  const claude = claudeModule()
  const cards: any[] = []
  const events = {
    message: () => {}, permission: (request: any) => cards.push(request),
    note: () => {}, session: () => {}, skill: () => {}
  }
  const connection = new claude.ClaudeConnection({
    binary: 'claude', root: boxed.root, skill: join(boxed.root, 'skill'), env: {},
    openExternal: async () => {}, trusted: () => opts.trusted,
    guard: { userData: boxed.userData, folderHash: 'test', key: null },
    ...(opts.bundle === false ? {} : { skillBundleSource: () => source })
  })
  // `auth status` 는 자식 프로세스를 띄운다 — 이 시험은 판정 배선만 본다.
  connection.status = async () => ({ installed: true, connected: true, version: null, probe: 'ok', detail: '' })
  await connection.run('안녕하세요', 'session-1', events)
  const canUseTool = claude.captured[0].options.canUseTool
  return {
    cards,
    ask: (name, input) => canUseTool(name, input, { signal: new AbortController().signal }),
    answer: (allow) => connection.respond(cards[cards.length - 1].id, allow)
  }
}

/** 카드는 microtask 뒤에 뜬다 — 매달리지 않게 잠깐씩 양보하며 기다린다. */
async function settle(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
}

/** 설치본 하나를 만들고, 스크립트를 한 줄 고쳐 '내용이 다른 사본'을 만든다. */
function installedBox(): { root: string; userData: string; target: string } {
  const { root, userData } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  return { root, userData, target }
}
function tamper(target: string): void {
  setTreeAccess(target, true)
  const script = join(target, 'scripts', 'gg.py')
  writeFileSync(script, readFileSync(script, 'utf-8') + '\n# student edit\n')
}

test('최종 판정(Bash): 사본이 다르면 trusted() 참이어도 카드 — 일치하면 종전대로 통과(C-01ⓒ)', async () => {
  const { root, userData, target } = installedBox()
  const script = join(skillHostDir(userData), 'scripts', 'gg.py').replace(/\\/g, '/')
  const call = { command: `python3 "${script}" status` }

  // 대조군 ①·② — 사본이 동봉본과 같으면 오늘과 같다(카드 없음).
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    expect(plain(await r.ask('Bash', call)), `intact/trusted=${trusted}`).toEqual({ behavior: 'allow', updatedInput: call })
    expect(r.cards, `intact/trusted=${trusted}`).toHaveLength(0)
  }

  tamper(target)

  // 불일치 ③ — '묻지 않기'(trusted 참)여도 자동 허용되지 않고 카드가 뜬다. 이 칸이 Roh R2 다.
  const strict = await rig({ root, userData }, { trusted: true })
  const pending = strict.ask('Bash', call)
  await settle(() => strict.cards.length > 0)
  expect(strict.cards, 'mismatch/trusted=true').toHaveLength(1)
  expect(strict.cards[0].title).toContain('규칙 사본')
  strict.answer(false)
  expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })

  // 불일치 ④ — '매번 묻기'에서도 카드다. 학생이 허용하면 그때 실행된다(거절이 아니다).
  const ask = await rig({ root, userData }, { trusted: false })
  const allowed = ask.ask('Bash', call)
  await settle(() => ask.cards.length > 0)
  expect(ask.cards, 'mismatch/trusted=false').toHaveLength(1)
  ask.answer(true)
  expect(plain(await allowed)).toEqual({ behavior: 'allow', updatedInput: call })

  // 이 판정은 스킬 스크립트를 여는 호출에만 붙는다 — 같은 사본 상태에서도 평범한 명령은 그대로.
  const plainRun = await rig({ root, userData }, { trusted: true })
  expect(plain(await plainRun.ask('Bash', { command: 'ls' }))).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  expect(plainRun.cards).toHaveLength(0)

  // 동봉본을 모르는 옛 호출자(시험·옛 배선)는 대조할 것이 없다 — 종전 판정 그대로 통과.
  const legacy = await rig({ root, userData }, { trusted: true, bundle: false })
  expect(plain(await legacy.ask('Bash', call))).toEqual({ behavior: 'allow', updatedInput: call })
  expect(legacy.cards).toHaveLength(0)
  setTreeAccess(target, true)
})

test('최종 판정(PowerShell): 사본이 다르면 trusted() 참이어도 카드(C-01ⓒ)', async () => {
  const { root, userData, target } = installedBox()
  const script = join(skillHostDir(userData), 'scripts', 'gg.py').replace(/\\/g, '/')
  const call = { command: `python.exe "${script}" status` }

  // 대조군 — 내용이 같으면 오늘과 한 글자도 다르지 않다.
  //
  // '묻지 않기'(trusted 참)는 자동 허용이다. '매번 묻기'는 **평범한 카드**다 —
  // `autoAllow` 의 PowerShell 갈래는 폴더 안 `.claude/skills/` 만 인정하므로(위 시험
  // 'PowerShell 스킬 호출은 맥 Bash 와 같은 기준으로'), 옮겨 간 앱 자리 스크립트는
  // 원래부터 카드였다. 이 시험이 잠그는 것은 그 카드가 **불일치 카드로 바뀌었는가**다.
  const intact = await rig({ root, userData }, { trusted: true })
  expect(plain(await intact.ask('PowerShell', call))).toEqual({ behavior: 'allow', updatedInput: call })
  expect(intact.cards).toHaveLength(0)

  const intactAsk = await rig({ root, userData }, { trusted: false })
  const intactPending = intactAsk.ask('PowerShell', call)
  await settle(() => intactAsk.cards.length > 0)
  expect(intactAsk.cards, 'intact/trusted=false').toHaveLength(1)
  expect(intactAsk.cards[0].title, 'intact/trusted=false').not.toContain('규칙 사본')
  intactAsk.answer(false)
  expect(plain(await intactPending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })

  tamper(target)

  const strict = await rig({ root, userData }, { trusted: true })
  const pending = strict.ask('PowerShell', call)
  await settle(() => strict.cards.length > 0)
  expect(strict.cards, 'mismatch/trusted=true').toHaveLength(1)
  expect(strict.cards[0].title).toContain('규칙 사본')
  strict.answer(false)
  expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })

  const ask = await rig({ root, userData }, { trusted: false })
  const allowed = ask.ask('pwsh', call)
  await settle(() => ask.cards.length > 0)
  expect(ask.cards, 'mismatch/trusted=false').toHaveLength(1)
  ask.answer(true)
  expect(plain(await allowed)).toEqual({ behavior: 'allow', updatedInput: call })
  setTreeAccess(target, true)
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
  // 판정 불가능한 명령은 **닫는다**(C-01ⓐ) — 예전에는 null 로 흘려 trusted() 가 통과시켰다.
  // 리다이렉트·치환·백틱·서브셸은 앱이 뜻을 못 따라가므로 경로도 못 짚는다. 닫는 편이 안전하다.

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

test('해석 못 하는 셸 명령은 카드 없이 거절한다 — 리다이렉트·치환·서브셸(C-01ⓐ)', () => {
  const { root, userData, host } = box()
  const hostFile = join(host, 'SKILL.md').replace(/\\/g, '/')
  // 해석에 실패해 닫는 경우 — 경로를 짚을 수 없으므로 문구에 내부 자리 이름도 흘리지 않는다.
  const denyUnparseable = (command: string) => {
    const out = hostWriteDecision(root, 'Bash', { command }, userData)
    expect(out, command).toMatchObject({ behavior: 'deny' })
    expect(out!.message, command).not.toContain('skill-host')
    expect(out!.message, command).not.toContain(userData)
  }

  denyUnparseable(`echo pwn > "${hostFile}"`)
  denyUnparseable(`echo pwn >"${join(host, 'x.md')}"`)
  denyUnparseable(`cp "$(echo "${hostFile}")" y.md`)
  denyUnparseable(`sh -c 'echo pwn > ${hostFile}'`)
  denyUnparseable('echo ${HOME}')
  denyUnparseable('echo `id`')
  denyUnparseable('(cd /tmp && touch x)')
  denyUnparseable('{ echo a; } > /tmp/x')

  // 해석은 되지만 자리를 짚는 명령 — 이쪽은 **어느 경로인지** 보여 주며 거절한다.
  const shown = hostWriteDecision(root, 'Bash', { command: `cat ${hostFile} | tee out.md` }, userData)
  expect(shown).toMatchObject({ behavior: 'deny' })
  expect(shown!.message).toContain(hostFile)

  // 지킴이 상태와 무관한 평범한 폴더 안 명령은 그대로 통과한다 — 카드를 만들지 않는다.
  expect(hostWriteDecision(root, 'Bash', { command: 'echo hi' }, userData)).toBeNull()
  expect(hostWriteDecision(root, 'Bash', { command: `python3 "${join(host, 'scripts', 'gg.py')}" status` }, userData)).toBeNull()
  // 빈 명령은 판정할 것이 없다.
  expect(hostWriteDecision(root, 'Bash', { command: '   ' }, userData)).toBeNull()
  // 지킴이가 꺼져 있으면(열쇠 없음) 이 판정도 하지 않는다.
  expect(hostWriteDecision(root, 'Bash', { command: `echo pwn > "${hostFile}"` }, undefined)).toBeNull()
})

test('PowerShell 도 해석 못 하면 거절한다 — 변수·세미콜론·파이프(C-01ⓐ)', () => {
  const { root, userData, host } = box()
  const hostFile = join(host, 'SKILL.md').replace(/\\/g, '/')
  const deny = (command: string) => {
    const out = hostWriteDecision(root, 'PowerShell', { command }, userData)
    expect(out, command).toMatchObject({ behavior: 'deny' })
    expect(out!.message, command).not.toContain(userData)
    expect(out!.message, command).not.toContain('skill-host')
  }

  deny('Write-Output $env:HOME')
  deny(`Write-Output $env:HOME; Remove-Item "${hostFile}"`)
  deny('Get-ChildItem | Where-Object Name')

  // 해석은 되지만 자리를 짚는 명령은 그 자리를 보여 주며 거절한다.
  expect(hostWriteDecision(root, 'PowerShell', { command: `Copy-Item x.md "${hostFile}"` }, userData)).toMatchObject({ behavior: 'deny' })

  // 해석 가능하고 폴더 밖 경로도 없는 명령은 통과한다.
  expect(hostWriteDecision(root, 'PowerShell', { command: 'Write-Output hello' }, userData)).toBeNull()
})

test('폴더 안 링크가 앱 자리를 가리켜도 보호한다 — 실제 대상 기준(C-01ⓑ)', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  const link = join(root, 'app-link')
  symlinkSync(host, link, 'dir')
  const viaLink = join(link, 'SKILL.md').replace(/\\/g, '/')
  const hostFile = join(host, 'SKILL.md').replace(/\\/g, '/')

  // 문자열만 보면 폴더 안이다 — 실제 자리로 보면 앱 자리다.
  expect(isSkillHostPath(viaLink, userData)).toBe(true)
  expect(hostWriteDecision(root, 'Write', { file_path: viaLink }, userData)).toMatchObject({ behavior: 'deny' })
  expect(hostWriteDecision(root, 'Bash', { command: `cp x.md "${viaLink}"` }, userData)).toMatchObject({ behavior: 'deny' })
  expect(autoAllow(root, 'Bash', { command: `cp x.md "${viaLink}"` }, [], userData)).toBe(false)
  expect(autoAllow(root, 'Write', { file_path: viaLink }, [], userData)).toBe(false)

  // 링크가 앱 자리 **뿌리**(`.claude`)를 가리키는 경우도 같다.
  const rawRoot = join(root, 'claude-link')
  symlinkSync(skillHostRoot(userData), rawRoot, 'dir')
  expect(isSkillHostPath(join(rawRoot, 'skills', 'knuaf-dev', 'SKILL.md'), userData)).toBe(true)
  expect(hostWriteDecision(root, 'Write', { file_path: join(rawRoot, 'settings.json') }, userData)).toMatchObject({ behavior: 'deny' })

  // 링크 아닌 폴더 안 경로는 그대로 통과한다.
  expect(hostWriteDecision(root, 'Write', { file_path: join(root, 'draft.md') }, userData)).toBeNull()
  expect(hostWriteDecision(root, 'Read', { file_path: hostFile }, userData)).toBeNull()
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
