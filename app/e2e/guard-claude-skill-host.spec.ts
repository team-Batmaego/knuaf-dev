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
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  buildLaunchScript, installSkill, sameTreeContent, setTreeAccess, skillBackupDir, skillSource, skillState, skillTargets, skillVersion,
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
function box(userPath = 'user-data'): { root: string; userData: string; host: string } {
  const base = mkdtempSync(join(tmpdir(), 'kd-skill-host-'))
  made.push(base)
  const root = join(base, '논문 폴더')
  const userData = join(base, userPath)
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
  // Codex 폴더 사본의 학생 메모는 기존처럼 재설치·백업을 부르지 않는다.
  const codex = skillTargets(root, userData).codex
  installSkill(source, codex, version, source)
  writeFileSync(join(codex, 'student-note.txt'), 'preserve me')
  expect(skillState(codex, version, source)).toBe('installed')
  expect(installSkill(source, codex, version, source).action).toBe('unchanged')
  expect(readFileSync(join(codex, 'student-note.txt'), 'utf-8')).toBe('preserve me')
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
  boxed: { root: string; userData: string }, opts: { trusted: boolean; bundle?: boolean | string }
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
    ...(opts.bundle === false ? {} : { skillBundleSource: () => typeof opts.bundle === 'string' ? opts.bundle : source })
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

  // I2: 지문이 같은 앱 자리의 Python 진입점은 trusted 설정과 무관하게 자동 허용한다.
  const intact = await rig({ root, userData }, { trusted: true })
  expect(plain(await intact.ask('PowerShell', call))).toEqual({ behavior: 'allow', updatedInput: call })
  expect(intact.cards).toHaveLength(0)

  const intactAsk = await rig({ root, userData }, { trusted: false })
  expect(autoAllow(root, 'PowerShell', call, [], userData, source)).toBe(true)
  expect(plain(await intactAsk.ask('PowerShell', call))).toEqual({ behavior: 'allow', updatedInput: call })
  expect(intactAsk.cards, 'intact/trusted=false').toHaveLength(0)

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

for (const location of ['', 'references', 'assets', 'scripts/__pycache__', 'scripts/.venv', 'scripts/sub', 'scripts/.DS_Store', 'scripts/cache.pyc']) {
  test(`앱 자리 ${location || '뿌리'}에 끼운 gg_extra.py는 자동 실행 없이 불일치 카드·재설치로 간다`, async () => {
    const { root, userData, target } = installedBox()
    const normal = { command: `python3 "${join(target, 'scripts', 'gg.py').replace(/\\/g, '/')}" status` }
    expect(autoAllow(root, 'Bash', normal, [], userData, source)).toBe(true)
    if (process.platform !== 'win32') setTreeAccess(target, true)
    const injected = join(target, location, 'gg_extra.py')
    mkdirSync(dirname(injected), { recursive: true })
    writeFileSync(injected, 'print("UNTRUSTED_PAYLOAD")\n')
    expect(sameTreeContent(target, source), location).toBe(false)
    expect(skillState(target, version, source), location).toBe('outdated')
    // 정상 동봉 스크립트도 사본이 달라진 동안에는 자동 실행하지 않는다.
    expect(autoAllow(root, 'Bash', normal, [], userData, source), location).toBe(false)

    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      const call = { command: `python3 "${injected.replace(/\\/g, '/')}"` }
      // 동봉본을 모르는 옛 호출자도 scripts/ 밖은 자동 실행 예외가 아니다.
      expect(autoAllow(root, tool, call, [], userData), `${tool}/legacy`).toBe(false)
      expect(autoAllow(root, tool, call, [], userData, source), tool).toBe(false)
      expect(hostWriteDecision(root, tool, call, userData), tool).toBeNull()
      const r = await rig({ root, userData }, { trusted: true })
      const pending = r.ask(tool, call)
      await settle(() => r.cards.length > 0)
      expect(r.cards, tool).toHaveLength(1)
      expect(r.cards[0].title, tool).toContain('규칙 사본')
      r.answer(false)
      expect(plain(await pending), tool).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
      const normalPending = r.ask(tool, normal)
      await settle(() => r.cards.length > 1)
      expect(r.cards, `${tool}/normal`).toHaveLength(2)
      expect(r.cards[1].title, `${tool}/normal`).toContain('원본과 달라요')
      r.answer(false)
      expect(plain(await normalPending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
    }

    const repaired = installSkill(source, target, version, source)
    expect(repaired.action).toBe('updated')
    expect(readFileSync(join(repaired.backup!, location, 'gg_extra.py'), 'utf-8')).toBe('print("UNTRUSTED_PAYLOAD")\n')
    expect(existsSync(injected)).toBe(false)
    expect(sameTreeContent(target, source)).toBe(true)
    expect(skillState(target, version, source)).toBe('installed')
    expect(autoAllow(root, 'Bash', normal, [], userData, source)).toBe(true)
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      const r = await rig({ root, userData }, { trusted: true })
      expect(plain(await r.ask(tool, normal)), tool).toEqual({ behavior: 'allow', updatedInput: normal })
      expect(r.cards, tool).toHaveLength(0)
    }
  })
}

test('앱 자리의 알 수 없는 뿌리 폴더도 백업·제거하고 Codex 학생 파일은 그대로 둔다', () => {
  const { root, userData, target } = installedBox()
  if (process.platform !== 'win32') setTreeAccess(target, true)
  const foreign = join(target, 'student-files', 'memo.txt')
  mkdirSync(dirname(foreign))
  writeFileSync(foreign, 'preserve in backup')
  expect(skillState(target, version, source)).toBe('outdated')
  const repaired = installSkill(source, target, version, source)
  expect(repaired.action).toBe('updated')
  expect(readFileSync(join(repaired.backup!, 'student-files', 'memo.txt'), 'utf-8')).toBe('preserve in backup')
  expect(existsSync(join(target, 'student-files'))).toBe(false)
  expect(skillState(target, version, source)).toBe('installed')

  const codex = skillTargets(root, userData).codex
  installSkill(source, codex, version, source)
  mkdirSync(join(codex, 'student-files'))
  writeFileSync(join(codex, 'student-files', 'memo.txt'), 'keep in place')
  expect(skillState(codex, version, source)).toBe('installed')
  expect(installSkill(source, codex, version, source).action).toBe('unchanged')
  expect(readFileSync(join(codex, 'student-files', 'memo.txt'), 'utf-8')).toBe('keep in place')
  expect(existsSync(skillBackupDir(codex))).toBe(false)
})

test('scripts/ 하위 경로는 동봉본과 같아도 trusted에서 따로 묻고 지문 밖 항목은 재설치한다', async () => {
  const { root, userData, host } = box()
  const bundle = join(root, 'test-bundle')
  mkdirSync(join(bundle, 'scripts', 'nested'), { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), '# test bundle\n')
  writeFileSync(join(bundle, 'scripts', 'nested', 'gg_extra.py'), 'print("BUNDLED")\n')
  const bundledVersion = skillVersion(bundle)
  installSkill(bundle, host, bundledVersion, bundle)
  const bundled = { command: `python3 "${join(host, 'scripts', 'nested', 'gg_extra.py').replace(/\\/g, '/')}"` }
  expect(sameTreeContent(host, bundle)).toBe(true)
  expect(autoAllow(root, 'Bash', bundled, [], userData, bundle)).toBe(false)
  for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
    for (const knownBundle of [false, bundle] as const) {
      for (const trusted of [true, false]) {
        // 지문이 참인 경우와 hostIntact가 없는 경우 모두 위치 검사는 trusted에 덮이지 않는다.
        const r = await rig({ root, userData }, { trusted, bundle: knownBundle })
        const pending = r.ask(tool, bundled)
        await settle(() => r.cards.length > 0)
        expect(r.cards, `${tool}/${trusted}/${knownBundle}`).toHaveLength(1)
        expect(r.cards[0].title).toContain('자동 실행 범위')
        r.answer(!trusted)
        expect(plain(await pending)).toEqual(trusted
          ? { behavior: 'deny', message: '사용자가 허용하지 않았습니다.' }
          : { behavior: 'allow', updatedInput: bundled })
      }
    }
  }

  if (process.platform !== 'win32') setTreeAccess(host, true)
  for (const skipped of ['__pycache__', '.venv', '.DS_Store', 'cache.pyc']) {
    const script = join(host, 'scripts', skipped, 'gg_extra.py')
    mkdirSync(dirname(script))
    writeFileSync(script, 'print("NOT_IN_FINGERPRINT")\n')
    // 일반 번들 지문은 제외하지만 앱 사본에서는 외부 삽입으로 감지해 다시 깐다.
    expect(sameTreeContent(host, bundle), skipped).toBe(false)
    expect(skillState(host, bundledVersion, bundle), skipped).toBe('outdated')
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      const call = { command: `python3 "${script.replace(/\\/g, '/')}"` }
      expect(autoAllow(root, tool, call, [], userData, bundle), `${tool}/${skipped}`).toBe(false)
    }
    const repaired = installSkill(bundle, host, bundledVersion, bundle)
    expect(repaired.action, skipped).toBe('updated')
    expect(readFileSync(join(repaired.backup!, 'scripts', skipped, 'gg_extra.py'), 'utf-8')).toBe('print("NOT_IN_FINGERPRINT")\n')
    expect(existsSync(script), skipped).toBe(false)
    expect(sameTreeContent(host, bundle), skipped).toBe(true)
    if (process.platform !== 'win32') setTreeAccess(host, true)
  }
})

test('앱 사본의 scripts·references·assets 안 캐시 파일은 탐지하되 Codex 사본 계약은 유지한다', async () => {
  const { root, userData, target } = installedBox()
  const codex = skillTargets(root, userData).codex
  installSkill(source, codex, version, source)
  const normal = { command: `python3 "${join(target, 'scripts', 'gg.py').replace(/\\/g, '/')}" status` }
  for (const dir of ['scripts', 'references', 'assets']) {
    for (const filename of ['.DS_Store', 'module.pyc']) {
      if (process.platform !== 'win32') setTreeAccess(target, true)
      const relative = join(dir, filename)
      const file = join(target, relative)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'foreign cache')
      mkdirSync(join(codex, dir), { recursive: true })
      writeFileSync(join(codex, relative), 'student cache')
      expect(sameTreeContent(target, source), relative).toBe(false)
      expect(skillState(target, version, source), relative).toBe('outdated')
      expect(autoAllow(root, 'Bash', normal, [], userData, source), relative).toBe(false)
      for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
        const r = await rig({ root, userData }, { trusted: true })
        const pending = r.ask(tool, normal)
        await settle(() => r.cards.length > 0)
        expect(r.cards, `${tool}/${relative}`).toHaveLength(1)
        expect(r.cards[0].title).toContain('원본과 달라요')
        r.answer(false)
        expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
      }
      const repaired = installSkill(source, target, version, source)
      expect(repaired.action, relative).toBe('updated')
      expect(readFileSync(join(repaired.backup!, relative), 'utf-8')).toBe('foreign cache')
      expect(existsSync(file)).toBe(false)
      expect(sameTreeContent(target, source)).toBe(true)
      expect(skillState(codex, version, source)).toBe('installed')
      expect(installSkill(source, codex, version, source).action).toBe('unchanged')
      expect(readFileSync(join(codex, relative), 'utf-8')).toBe('student cache')
    }
  }
})

test('SWEEP C02–C07·C23·C30: 직접 실행·상대 링크·상위 경로는 trusted와 무관하게 앱 실행 카드다', async () => {
  const { root, userData, target } = installedBox()
  const py = join(target, 'scripts', 'gg.py')
  const injected = join(target, 'scripts', 'gg_extra.py')
  symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(py, join(root, 'gg_link.py'), 'file')
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true })
  symlinkSync(target, join(root, '.claude', 'skills', 'knuaf-dev'), process.platform === 'win32' ? 'junction' : 'dir')
  const q = (path: string) => `"${path.replace(/\\/g, '/')}"`
  const cases = [
    ['C02-direct-script', q(py)],
    ['C03-direct-injected', q(injected)],
    ['C04-absolute-link', `python3 ${q(join(root, 'gg_link.py'))}`],
    ['C05-relative-link', 'python3 alias/scripts/gg.py'],
    ['C06-relative-file-link', 'python3 gg_link.py'],
    ['C07-root-relative', `python3 ${q(relative(root, py))}`],
    ['C23-host-as-executable', `${q(injected)} status`],
    ['C30-relative-local-skill-alias', 'python3 .claude/skills/knuaf-dev/scripts/gg.py'],
    ['N01-direct-relative-alias', 'alias/scripts/gg_extra.py'],
    ['N15-dotdot-direct', q(relative(root, injected))]
  ]
  for (const changed of [false, true]) {
    if (changed) {
      setTreeAccess(target, true)
      writeFileSync(py, '# changed script\n')
      writeFileSync(injected, '# injected script\n')
    }
    expect(sameTreeContent(target, source)).toBe(!changed)
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      for (const trusted of [true, false]) {
        const r = await rig({ root, userData }, { trusted })
        for (const [id, command] of cases) {
          const call = { command }
          expect(autoAllow(root, tool, call, [], userData, source), `${id}/${tool}/${trusted}/${changed}`).toBe(false)
          expect(hostWriteDecision(root, tool, call, userData), `${id}/${tool}`).toBeNull()
          const count = r.cards.length
          const pending = r.ask(tool, call)
          await settle(() => r.cards.length > count)
          expect(r.cards, `${id}/${tool}/${trusted}`).toHaveLength(count + 1)
          expect(r.cards[count].title, id).toContain('자동 실행 범위')
          r.answer(false)
          expect(plain(await pending), id).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
        }
      }
    }
  }
})

test('SWEEP C21·C29: 앱 자리를 향한 상대 링크 쓰기는 셸·모든 쓰기 도구에서 trusted 전에 거절한다', async () => {
  const { root, userData, target } = installedBox()
  symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(target, 'scripts', 'gg.py'), join(root, 'gg_link.py'), 'file')
  const paths = ['alias/scripts/gg.py', 'alias/scripts/gg_new.py', 'gg_link.py', relative(root, join(target, 'scripts', 'gg_new.py')).replace(/\\/g, '/')]
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    for (const path of paths) {
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        const call = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path, content: 'not executed' }
        expect(autoAllow(root, tool, call, [], userData, source), `${tool}/${path}`).toBe(false)
        expect(hostWriteDecision(root, tool, call, userData), `${tool}/${path}`).toMatchObject({ behavior: 'deny' })
        expect(plain(await r.ask(tool, call)), `${tool}/${path}`).toMatchObject({ behavior: 'deny' })
      }
      for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
        for (const command of [`touch "${path}"`, `tee "${path}"`, `python3 analysis.py --out=${path}`]) {
          const call = { command }
          expect(autoAllow(root, tool, call, [], userData, source), `${tool}/${command}`).toBe(false)
          expect(hostWriteDecision(root, tool, call, userData), `${tool}/${command}`).toMatchObject({ behavior: 'deny' })
          expect(plain(await r.ask(tool, call)), `${tool}/${command}`).toMatchObject({ behavior: 'deny' })
        }
      }
    }
    expect(r.cards).toHaveLength(0)
  }
  expect(existsSync(join(target, 'scripts', 'gg_new.py'))).toBe(false)
  expect(sameTreeContent(target, source)).toBe(true)
})

test('SWEEP 대조군: 정상 절대 스킬 호출·일반 상대 파일 작업은 앱 자리 제한으로 바뀌지 않는다', async () => {
  const { root, userData, target } = installedBox()
  writeFileSync(join(root, 'draft.md'), '# draft\n')
  writeFileSync(join(root, 'analysis.py'), 'print("student analysis")\n')
  const normal = { command: `python3 "${join(target, 'scripts', 'gg.py').replace(/\\/g, '/')}" status` }
  expect(autoAllow(root, 'Bash', normal, [], userData, source)).toBe(true)
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    expect(plain(await r.ask('Bash', normal))).toEqual({ behavior: 'allow', updatedInput: normal })
    for (const tool of ['Read', 'Write', 'Edit']) {
      const call = { file_path: 'draft.md', content: 'local edit' }
      expect(hostWriteDecision(root, tool, call, userData)).toBeNull()
      expect(autoAllow(root, tool, call, [], userData, source)).toBe(true)
      expect(plain(await r.ask(tool, call))).toEqual({ behavior: 'allow', updatedInput: call })
    }
    for (const command of ['cat draft.md', 'touch new.md', 'echo hello']) {
      const call = { command }
      expect(autoAllow(root, 'Bash', call, [], userData, source), command).toBe(true)
      expect(plain(await r.ask('Bash', call))).toEqual({ behavior: 'allow', updatedInput: call })
    }
    expect(r.cards).toHaveLength(0)
    // 임의 Python은 원래부터 자동 실행 예외가 아니다. trusted일 때 종전처럼 통과하며 앱 카드가 아니다.
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      const call = { command: 'python3 analysis.py' }
      expect(hostWriteDecision(root, tool, call, userData)).toBeNull()
      expect(autoAllow(root, tool, call, [], userData, source)).toBe(false)
      const before = r.cards.length
      const pending = r.ask(tool, call)
      if (!trusted) {
        await settle(() => r.cards.length > before)
        expect(r.cards).toHaveLength(before + 1)
        expect(r.cards[before].title).not.toContain('앱 규칙 사본')
        r.answer(true)
      }
      expect(plain(await pending)).toEqual({ behavior: 'allow', updatedInput: call })
      expect(r.cards).toHaveLength(before + (trusted ? 0 : 1))
    }
  }
})

test('SWEEP F07·F08: 바이트가 같아도 앱 스크립트·scripts 디렉터리 링크는 무결한 사본이 아니다', async () => {
  const { root, userData, target } = installedBox()
  const script = join(target, 'scripts', 'gg.py')
  const call = { command: `python3 "${script.replace(/\\/g, '/')}" status` }
  for (const location of ['file', 'directory']) {
    setTreeAccess(target, true)
    if (location === 'file') {
      const outside = join(root, 'outside.py')
      writeFileSync(outside, readFileSync(script))
      unlinkSync(script)
      symlinkSync(outside, script, 'file')
    } else {
      const outside = join(root, 'outside-scripts')
      renameSync(join(target, 'scripts'), outside)
      symlinkSync(outside, join(target, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    expect(sameTreeContent(target, source), location).toBe(false)
    expect(skillState(target, version, source), location).toBe('outdated')
    expect(autoAllow(root, 'Bash', call, [], userData, source), location).toBe(false)
    for (const trusted of [true, false]) {
      for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
        const r = await rig({ root, userData }, { trusted })
        const pending = r.ask(tool, call)
        await settle(() => r.cards.length > 0)
        expect(r.cards).toHaveLength(1)
        r.answer(false)
        expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
      }
    }
    expect(installSkill(source, target, version, source).action).toBe('updated')
    expect(sameTreeContent(target, source)).toBe(true)
    expect(autoAllow(root, 'Bash', call, [], userData, source)).toBe(true)
  }
})

test('A6 B2·B4·B6·I1: cwd 변경·쓰기 명령·상대 출력·앱 자리 조상 링크는 즉시 거절한다', async () => {
  const { root, userData, target } = installedBox()
  symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const script = join(target, 'scripts', 'gg.py').replace(/\\/g, '/')
  const rel = relative(root, target).replace(/\\/g, '/')
  const hostParent = relative(root, join(userData, 'skill-host')).replace(/\\/g, '/')
  const commands = [
    'cd alias/scripts && python3 gg_extra.py',
    'cp notes.md alias/scripts/gg.py', 'rm alias/scripts/gg_extra.py',
    'chmod u+w alias/scripts/gg.py', 'mkdir alias/scripts/sub',
    'sed -i.bak s/x/y/ alias/scripts/gg.py', 'ln -s notes.md alias/scripts/gg_lnk.py',
    `touch "${rel}/scripts/gg_new.py"`, `cp notes.md "${rel}/scripts/gg_new.py"`,
    `ln -s "${rel}" alias2`, `ln -s "${hostParent}" alias2`,
    `python3 "${script}" alias/scripts/gg_new.py`,
    `python3 "${script}" --out=alias/scripts/gg_new.py`
  ]
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      for (const command of commands) {
        const call = { command }
        expect(autoAllow(root, tool, call, [], userData, source), `${tool}/${command}`).toBe(false)
        const out = plain(await r.ask(tool, call))
        expect(out, `${tool}/${trusted}/${command}`).toMatchObject({ behavior: 'deny' })
        expect(out.message).toMatch(/앱이 관리하는 자리|앱이 이 명령/)
      }
    }
    expect(r.cards).toHaveLength(0)
  }
  expect(sameTreeContent(target, source)).toBe(true)
  expect(existsSync(join(root, 'alias2'))).toBe(false)
})

test('A6 cd 거절은 이유와 다시 하는 법을 알려 주고, cd 없이 다시 부르면 폴더 안 일로 통과한다', async () => {
  const { root, userData } = installedBox()
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'sub', 'notes.md'), '# n\n')
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    // 학생 폴더 안 평범한 하위 폴더라도 cd 가 섞이면 판정 불가로 거절 — 카드 없이, 다시 하는 법을 담아.
    const denied = plain(await r.ask('Bash', { command: 'cd sub && cat notes.md' }))
    expect(denied).toMatchObject({ behavior: 'deny' })
    expect(denied.message).toContain('cd')
    expect(denied.message).toContain('경로를 붙여')
    expect(r.cards).toHaveLength(0)
    // 도우미가 안내대로 cd 없이 다시 부르면 폴더 안 읽기 명령이라 카드 없이 통과한다.
    const retry = { command: 'cat sub/notes.md' }
    expect(autoAllow(root, 'Bash', retry, [], userData, source)).toBe(true)
    expect(plain(await r.ask('Bash', retry))).toEqual({ behavior: 'allow', updatedInput: retry })
    expect(r.cards).toHaveLength(0)
  }
  // 예외 하나: 논문 폴더 **자체**로 옮기는 cd 는 cwd 가 root 그대로라 종전처럼 판정한다(도우미의 환경 점검 꼴).
  const toRoot = { command: `cd "${root}" && cat sub/notes.md` }
  expect(autoAllow(root, 'Bash', toRoot, [], userData, source)).toBe(true)
  expect(hostWriteDecision(root, 'Bash', toRoot, userData)).toBeNull()
  // root 를 거쳐 하위 폴더로 한 번 더 옮기면 다시 판정 불가다.
  expect(autoAllow(root, 'Bash', { command: `cd "${root}" && cd sub && cat notes.md` }, [], userData, source)).toBe(false)
})

test('A7 cd 예외는 논문 폴더 자체뿐 — 하위 폴더·상위·링크 너머로 옮긴 뒤 쓰기는 trusted와 무관하게 거절한다', async () => {
  const { root, userData, target } = installedBox()
  mkdirSync(join(root, 'sub'), { recursive: true })
  symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const outside = mkdtempSync(join(tmpdir(), 'kd-cd-out-'))
  symlinkSync(outside, join(root, 'outlink'), process.platform === 'win32' ? 'junction' : 'dir')
  const mutants = [
    'cd sub && touch new.md',                              // 하위 폴더 && 쓰기
    'cd alias && touch scripts/gg_new.py',                 // 링크 → 앱 자리 && 쓰기
    'cd alias/scripts && python3 gg.py',                   // 링크 → 앱 자리 && 실행
    'cd outlink && touch pwn.md',                          // 링크 → 폴더 밖 && 쓰기
    'cd .. && touch pwn.md',                               // 상위 && 쓰기
    `cd "${root}/sub" && touch new.md`,                    // 절대경로라도 root 자체가 아니면
    `cd "${root}/.." && touch pwn.md`,
    `cd "${root}" && cd alias && touch scripts/gg_new.py`, // root 를 거친 두 번째 cd
    'cd && touch pwn.md',                                  // 인자 없는 cd = 홈
    // J1: 혼자 쓴 cd 도 닫는다 — 다음 호출로 작업 폴더가 이어지면 판정 기준(root)과 어긋난다.
    'cd sub', 'cd alias', 'cd outlink', 'cd ..', 'pushd sub', `cd "${root}/sub"`,
    // K1: 논리 cd 로는 root 라도 `..` 를 거치면 예외 아님(물리 모드 셸이면 링크 대상의 부모).
    'cd alias/.. && touch pwn.md', 'cd sub/.. && cat notes.md',
  ]
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    for (const command of mutants) {
      const call = { command }
      expect(autoAllow(root, 'Bash', call, [], userData, source), command).toBe(false)
      const out = plain(await r.ask('Bash', call))
      expect(out, `${trusted}/${command}`).toMatchObject({ behavior: 'deny' })
    }
    expect(r.cards).toHaveLength(0)
  }
  expect(existsSync(join(root, 'sub', 'new.md'))).toBe(false)
  expect(existsSync(join(target, 'scripts', 'gg_new.py'))).toBe(false)
  expect(sameTreeContent(target, source)).toBe(true)
})

test('A6 B5: 같은 합성 사본에서 잠금 풀기→복사→상대 실행 연쇄는 두 trusted 설정 모두 막힌다', async () => {
  for (const trusted of [true, false]) {
    const { root, userData, target } = installedBox()
    symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const notes = join(root, 'notes.py')
    const payload = join(target, 'scripts', 'gg_extra.py')
    writeFileSync(notes, 'print("SWEEP2_CHAIN_PAYLOAD")\n')
    const r = await rig({ root, userData }, { trusted })
    const decisions: unknown[] = []
    const first = await r.ask('Bash', { command: 'chmod u+w alias/scripts' })
    decisions.push(plain(first))
    if (first.behavior === 'allow') chmodSync(join(target, 'scripts'), 0o755)
    const second = await r.ask('Bash', { command: 'cp notes.py alias/scripts/gg_extra.py' })
    decisions.push(plain(second))
    if (second.behavior === 'allow') cpSync(notes, payload)
    const before = r.cards.length
    const pending = r.ask('Bash', { command: 'python3 alias/scripts/gg_extra.py' })
    await settle(() => r.cards.length > before)
    expect(r.cards).toHaveLength(before + 1)
    expect(r.cards[before].title).toContain('자동 실행 범위')
    r.answer(false)
    decisions.push(plain(await pending))
    expect(decisions).toEqual([
      expect.objectContaining({ behavior: 'deny', message: expect.stringContaining('앱이 관리하는 자리') }),
      expect.objectContaining({ behavior: 'deny', message: expect.stringContaining('앱이 관리하는 자리') }),
      { behavior: 'deny', message: '사용자가 허용하지 않았습니다.' }
    ])
    expect(existsSync(payload)).toBe(false)
    expect(sameTreeContent(target, source)).toBe(true)
  }
})

test('A6 I2·R3·R5: 정상 Python은 세 셸에서 카드 없이, 다른 인터프리터는 앱 전용 카드로 간다', async () => {
  const { root, userData, target } = installedBox()
  const script = join(target, 'scripts', 'gg.py').replace(/\\/g, '/')
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
      const call = { command: `python3 "${script}" status` }
      expect(autoAllow(root, tool, call, [], userData, source)).toBe(true)
      expect(plain(await r.ask(tool, call))).toEqual({ behavior: 'allow', updatedInput: call })
      for (const interpreter of ['sh', 'bash', 'node']) {
        const other = { command: `${interpreter} "${script}"` }
        expect(autoAllow(root, tool, other, [], userData, source)).toBe(false)
        const before = r.cards.length
        const pending = r.ask(tool, other)
        await settle(() => r.cards.length > before)
        expect(r.cards).toHaveLength(before + 1)
        expect(r.cards[before].title).toContain('앱 규칙 사본의 자동 실행 범위')
        r.answer(false)
        expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
      }
    }
  }
})

test('A6 I3: 경로로 부른 폴더 밖 실행 파일만 자동 허용에서 빼고 PATH 이름 계약은 유지한다', async () => {
  const { root, userData } = box()
  const outside = join(dirname(root), 'outside-tool.sh')
  writeFileSync(outside, '#!/bin/sh\necho SWEEP2_OUTSIDE\n')
  symlinkSync(outside, join(root, 'outside-link'), 'file')
  const r = await rig({ root, userData }, { trusted: false })
  for (const command of [`"${outside.replace(/\\/g, '/')}"`, './outside-link']) {
    const call = { command }
    expect(autoAllow(root, 'Bash', call, [], userData)).toBe(false)
    const before = r.cards.length
    const pending = r.ask('Bash', call)
    await settle(() => r.cards.length > before)
    expect(r.cards).toHaveLength(before + 1)
    r.answer(false)
    expect(plain(await pending)).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
  }
  expect(autoAllow(root, 'Bash', { command: 'echo hello' }, [], userData)).toBe(true)
  expect(autoAllow(root, 'Bash', { command: 'python3 --version' }, [], userData)).toBe(true)
  expect(hostWriteDecision(root, 'Bash', { command: 'git status' }, userData)).toBeNull()
})

test('A6 I4: 파일 도구의 홈 축약 경로는 추측하지 않고 trusted 전에 절대경로를 요구한다', async () => {
  const { root, userData } = box()
  for (const trusted of [true, false]) {
    const r = await rig({ root, userData }, { trusted })
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      for (const path of ['~/user-data/skill-host/.claude/skills/knuaf-dev/scripts/gg.py', '~\\user-data\\skill-host\\.claude\\skills\\knuaf-dev\\scripts\\gg.py']) {
        const call = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path }
        expect(autoAllow(root, tool, call, [], userData)).toBe(false)
        expect(plain(await r.ask(tool, call))).toMatchObject({ behavior: 'deny', message: expect.stringContaining('절대경로') })
      }
    }
    expect(r.cards).toHaveLength(0)
  }
})

test('짧은 이름 ABCDEF~1: 실제 설치본의 Bash·PowerShell 실행을 쓰기로 오인하지 않는다', async () => {
  const { root, userData, host } = box(join('ABCDEF~1', 'AppData', 'Roaming', 'knuaf-dev'))
  installSkill(source, host, version)
  const script = join(host, 'scripts', 'gg.py').replace(/\\/g, '/')
  expect(existsSync(script)).toBe(true)
  expect(skillState(host, version, source)).toBe('installed')

  for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
    const r = await rig({ root, userData }, { trusted: true })
    for (const quote of ['"', "'"]) {
      const call = { command: `python.exe ${quote}${script}${quote} status` }
      expect(hostWriteDecision(root, tool, call, userData), `${tool}/${quote}`).toBeNull()
      // Bash와 PowerShell 모두 같은 앱 자리·내용 검사를 통과해야 자동 실행한다.
      expect(autoAllow(root, tool, call, [], userData, source), `${tool}/${quote}`).toBe(true)
      expect(plain(await r.ask(tool, call)), `${tool}/${quote}`).toEqual({ behavior: 'allow', updatedInput: call })
    }
    expect(r.cards, tool).toHaveLength(0)

    const output = join(host, 'SKILL.md').replace(/\\/g, '/')
    const writeCall = { command: `python.exe "${script}" --out "${output}"` }
    expect(hostWriteDecision(root, tool, writeCall, userData), tool).toMatchObject({ behavior: 'deny' })
    expect(autoAllow(root, tool, writeCall, [], userData, source), tool).toBe(false)
  }
})

test('낱말 중간·따옴표 안 리터럴 ~는 Bash·PowerShell 경로에서 글자다', () => {
  const root = 'C:/Users/ABCDEF~1/paper'
  const userData = 'C:/Users/ABCDEF~1/AppData/Roaming/knuaf-dev'
  const script = `${userData}/skill-host/.claude/skills/knuaf-dev/scripts/gg.py`
  for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
    for (const path of [script, `"${script}"`, `'${script}'`]) {
      const call = { command: `python.exe ${path} status` }
      expect(hostWriteDecision(root, tool, call, userData), `${tool}/${path}`).toBeNull()
      if (tool === 'Bash') expect(autoAllow(root, tool, call, [], userData), path).toBe(true)
    }
    const localScript = `${root}/.claude/skills/knuaf-dev/scripts/gg.py`
    if (tool !== 'Bash') expect(autoAllow(root, tool, { command: `python.exe "${localScript}" status` }), tool).toBe(true)
    for (const command of ['echo "~/x"', "echo '~user/x'", 'echo ABCDEF~1', 'echo "~"']) {
      expect(hostWriteDecision(root, tool, { command }, userData), `${tool}/${command}`).toBeNull()
    }
  }
})

test('홈으로 펼쳐지는 ~와 모호한 인용·이스케이프는 짧은 이름 자리에서도 trusted보다 먼저 거절한다', async () => {
  const { root, userData, host } = box(join('ABCDEF~1', 'AppData', 'Roaming', 'knuaf-dev'))
  installSkill(source, host, version)
  const script = join(host, 'scripts', 'gg.py').replace(/\\/g, '/')
  const bash = [
    'cat ~', 'cat ~/x', 'cat ~user', 'cat ~user/x', 'a=~/x', 'PATH=x:~/y',
    'echo ok;~', 'echo ok|~', 'echo ok||~', 'echo ok&&~',
    'cat "~/x', "cat '~user/x", String.raw`cat \~`, String.raw`cat "x\" ~/x`,
    `python.exe "${script}" ~/x`, `python.exe "${script}" a=~/x`, `python.exe "${script}" PATH=x:~/y`
  ]
  const powershell = [
    'Get-Content ~', 'Get-Content ~/x', String.raw`Get-Content ~\x`, 'Get-Content ~user',
    'Get-Content "~/x', "Get-Content '~/x", 'Get-Content `~',
    `python.exe "${script}" ~`, `python.exe "${script}" ~/x`, `python.exe "${script}" ~\\x`
  ]
  for (const tool of ['Bash', 'PowerShell', 'pwsh']) {
    const r = await rig({ root, userData }, { trusted: true })
    for (const command of tool === 'Bash' ? bash : powershell) {
      const call = { command }
      const denied = hostWriteDecision(root, tool, call, userData)
      expect(denied, `${tool}/${command}`).toMatchObject({ behavior: 'deny' })
      expect(denied!.message, command).not.toContain(userData)
      expect(denied!.message, command).not.toContain('skill-host')
      expect(autoAllow(root, tool, call, [], userData, source), `${tool}/${command}`).toBe(false)
      expect(plain(await r.ask(tool, call)), `${tool}/${command}`).toEqual(denied)
    }
    expect(r.cards, tool).toHaveLength(0)
  }
})

test('설치 뒤 앱 자리는 읽기 전용이고 다시 깐 뒤에도 다시 잠긴다', () => {
  const { root, userData, host } = box()
  const target = skillTargets(root, userData).claude
  installSkill(source, target, version)
  expect(statSync(target).mode & 0o222).toBe(0)
  if (process.platform !== 'win32') expect(statSync(target).mode & 0o555).toBe(0o555)
  expect(statSync(join(target, 'SKILL.md')).mode & 0o222).toBe(0)
  expect(statSync(join(target, 'scripts')).mode & 0o222).toBe(0)

  // 잠긴 사본은 그냥 덮어쓸 수 없다 — 이 실패가 잠금이 실제로 걸렸다는 증거다.
  expect(() => writeFileSync(join(target, 'SKILL.md'), '# student edit\n')).toThrow(/EACCES|EPERM/)

  if (process.platform === 'win32') {
    // 윈도 파일 잠금은 보조(생성·이름 바꾸기 못 막음), 변조는 내용 지문 대조로 감지 — icacls 강화는 v0.6.5.
    const file = join(target, 'SKILL.md').replace(/'/g, "''")
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText('${file}', 'pwn')`
    ], { stdio: 'pipe' })).toThrow()
  } else {
    // 셸로 직접 덮어쓰려 해도 막힌다 — 판정(hostWriteDecision)을 못 거치는 경로(리다이렉트)의
    // 마지막 그물이 이 잠금이다.
    expect(() => execFileSync('sh', ['-c', `echo pwn > ${JSON.stringify(join(target, 'SKILL.md'))}`], { stdio: 'pipe' })).toThrow()
  }
  expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).not.toContain('pwn')

  const script = join(target, 'scripts', 'gg.py').replace(/\\/g, '/')
  const call = { command: `python3 "${script}" status` }
  for (const mutation of ['create', 'rename', 'replace']) {
    expect(skillState(target, version, source), mutation).toBe('installed')
    expect(autoAllow(root, 'Bash', call, [], userData, source), mutation).toBe(true)
    // POSIX에서는 잠금을 풀어 같은 지문 경계를 시험한다. 윈도에서는 잠긴 채 세 조작을 한다.
    if (process.platform !== 'win32') setTreeAccess(target, true)
    if (mutation === 'create') {
      const added = join(target, 'references', 'student-added.md')
      writeFileSync(added, '# added payload\n')
      expect(readFileSync(added, 'utf-8')).toBe('# added payload\n')
    } else if (mutation === 'rename') {
      const renamed = join(target, 'scripts', 'gg_renamed.py')
      renameSync(join(target, 'scripts', 'gg.py'), renamed)
      expect(existsSync(join(target, 'scripts', 'gg.py'))).toBe(false)
      expect(existsSync(renamed)).toBe(true)
    } else {
      const replacement = join(root, 'replacement.md')
      const destination = join(target, 'SKILL.md')
      writeFileSync(replacement, '# replacement payload\n')
      if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Move-Item -LiteralPath '${replacement.replace(/'/g, "''")}' -Destination '${destination.replace(/'/g, "''")}' -Force -ErrorAction Stop`
        ], { stdio: 'pipe' })
      } else renameSync(replacement, destination)
      expect(existsSync(replacement)).toBe(false)
      expect(readFileSync(destination, 'utf-8')).toBe('# replacement payload\n')
    }
    // 판 표시는 그대로여도 파일 생성·이름·내용 변경을 각각 잡아 실행을 자동 허용하지 않는다.
    expect(skillState(target, version), mutation).toBe('installed')
    expect(skillState(target, version, source), mutation).toBe('outdated')
    expect(autoAllow(root, 'Bash', call, [], userData, source), mutation).toBe(false)
    expect(installSkill(source, target, version, source).action, mutation).toBe('updated')
    expect(skillState(target, version, source), mutation).toBe('installed')
    expect(autoAllow(root, 'Bash', call, [], userData, source), mutation).toBe(true)
    expect(statSync(target).mode & 0o222, mutation).toBe(0)
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o555, mutation).toBe(0o555)
    expect(statSync(join(target, 'SKILL.md')).mode & 0o222, mutation).toBe(0)
    expect(statSync(join(target, 'scripts')).mode & 0o222, mutation).toBe(0)
    expect(() => writeFileSync(join(target, 'SKILL.md'), '# student edit\n'), mutation).toThrow(/EACCES|EPERM/)
  }

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

/**
 * 윈도 파이썬 런처 `py -3` (v0.7.5 S2 실기 — 윈도 Claude '시작하기'가 막힘).
 *
 * 규칙집(SKILL.md:27·update.md:9)이 윈도 실행기를 `py -3` 으로 적는데, 앱 판정은 이름이 `python` 인 실행기만
 * 스킬 스크립트 실행으로 알아봐서 `py -3 "<앱 스킬>/scripts/gg.py" init …` 이 앱 자리 쓰기로 오판돼 거절됐다.
 * 고침은 좁다: **윈도 뿌리**에서 경로 없는 `py`·`py.exe` + `-3`·`-3.<숫자>` + **앱 스킬 자리 안 스크립트**일 때만
 * `python` 과 같게 읽는다. 같은 판정으로 `py`·`pyw` 를 Bash 의 "아는 프로그램" 목록에서 빼(인터프리터로 취급) `py -3 -c "…"`·
 * `py -3 임의.py` 가 python3 와 같은 카드로 가게 했다(기존 구멍 N1).
 *
 * 윈도 판정은 맥에서 윈도 모양 문자열 뿌리로 잠근다(위 `ABCDEF~1` 시험과 같은 방식). 현장 꼴(한글 사용자명·`C:/` 뿌리·
 * PowerShell 역슬래시 따옴표 경로)을 그대로 쓴다. 실제 윈도 실행은 새 설치본 S2 재실기가 닫는다.
 */
const WIN_ROOT = 'C:/omo-work/rc-win/gate1-student'
const WIN_USER_DATA = 'C:/Users/이뚠냥/AppData/Roaming/knuaf-dev'
const winScript = (userData: string, name: string): string => `${userData.replace(/\\/g, '/')}/skill-host/.claude/skills/knuaf-dev/scripts/${name}`
const PY_LAUNCHERS = ['py -3', 'py -3.11', 'py -3.9', 'py.exe -3', 'PY -3', 'Py.EXE -3.12']
const TOOLS = ['Bash', 'PowerShell', 'pwsh']

test('현장 꼴 그대로: 윈도 뿌리·한글 사용자명·PowerShell 역슬래시 따옴표의 py -3 스킬 호출은 거절하지 않고 자동 실행한다', () => {
  // userData 를 역슬래시로 주는 변형은 맥에서 흉내 낼 수 없다(`skillHostDir` 가 맥의 posix join 이라 `C:\\…` 를 윈도처럼
  // 잇지 못한다 — python 도 같다). 그 꼴은 윈도 실기·CI 가 닫는다. 명령 안의 역슬래시 경로는 아래에서 그대로 쓴다.
  for (const userData of [WIN_USER_DATA]) {
    const gg = winScript(userData, 'gg.py')
    const upd = winScript(userData, 'gg_update.py')
    const back = (p: string): string => p.replace(/\//g, '\\')
    const field: Record<string, string[]> = {
      // 노트북 실기의 4건(gate1-s2-denials.txt)과 같은 모양.
      PowerShell: [`py -3 "${back(upd)}" auto`, `py -3 "${back(gg)}" init "${back(WIN_ROOT)}"`],
      pwsh: [`py -3 "${back(upd)}" auto`, `py -3 "${back(gg)}" init "${back(WIN_ROOT)}"`],
      Bash: [`py -3 "${gg}" init "${WIN_ROOT}"`, `py -3 "${upd}" auto`]
    }
    for (const tool of TOOLS) {
      for (const command of field[tool]) {
        const call = { command }
        const label = `${tool}/${userData}/${command}`
        expect(hostWriteDecision(WIN_ROOT, tool, call, userData), label).toBeNull()
        expect(autoAllow(WIN_ROOT, tool, call, [], userData), label).toBe(true)
        // python.exe 로 같은 호출을 한 것과 같은 결론이다.
        const reference = { command: command.replace(/^py\b/, 'python.exe').replace(' -3', '') }
        expect(hostWriteDecision(WIN_ROOT, tool, reference, userData), `ref/${label}`).toBeNull()
        expect(autoAllow(WIN_ROOT, tool, reference, [], userData), `ref/${label}`).toBe(true)
      }
    }
  }
})

test('py -3 계열 꼴은 python 과 똑같이 판정한다 — 거절하지 않고 scripts/ 직속만 자동 실행한다', () => {
  for (const tool of TOOLS) {
    for (const launcher of PY_LAUNCHERS) {
      for (const [name, rest] of [['gg.py', `init "${WIN_ROOT}"`], ['gg_update.py', 'auto'], ['gg.py', 'status']]) {
        const call = { command: `${launcher} "${winScript(WIN_USER_DATA, name)}" ${rest}` }
        const label = `${tool}/${call.command}`
        expect(hostWriteDecision(WIN_ROOT, tool, call, WIN_USER_DATA), label).toBeNull()
        expect(autoAllow(WIN_ROOT, tool, call, [], WIN_USER_DATA), label).toBe(true)
      }
    }
    // scripts/ 밖 앱 자리 파일은 python 과 같이 거절은 아니되 자동 실행도 아니다(위치 카드로 간다).
    const outside = { command: `py -3 "${winScript(WIN_USER_DATA, 'sub/gg_extra.py')}"` }
    const reference = { command: `python.exe "${winScript(WIN_USER_DATA, 'sub/gg_extra.py')}"` }
    for (const call of [outside, reference]) {
      expect(hostWriteDecision(WIN_ROOT, tool, call, WIN_USER_DATA), `${tool}/${call.command}`).toBeNull()
      expect(autoAllow(WIN_ROOT, tool, call, [], WIN_USER_DATA), `${tool}/${call.command}`).toBe(false)
    }
  }
})

test('N2: 윈도 뿌리가 아니면 py -3 를 python 으로 읽지 않는다(맥·리눅스 뿌리는 종전 판정)', () => {
  // 뿌리를 **문자열 맥 경로로 고정**한다 — 실제 임시 폴더를 쓰면 윈도 러너(`C:\\Users\\…`)에서는 뿌리가 윈도로
  // 판정돼 같은 시험의 뜻이 뒤집힌다. 뿌리 모양은 문자열이 정하므로(`pathOpsFor`) 어느 OS 에서 돌아도 같은 판정이다.
  const root = '/Users/x/paper'
  const userData = '/Users/x/Library/Application Support/knuaf-dev'
  const gg = `${userData}/skill-host/.claude/skills/knuaf-dev/scripts/gg.py`
  for (const tool of TOOLS) {
    const call = { command: `py -3 "${gg}" init "${root}"` }
    expect(hostWriteDecision(root, tool, call, userData), tool).toMatchObject({ behavior: 'deny' })
    expect(autoAllow(root, tool, call, [], userData), tool).toBe(false)
    // 같은 자리·같은 인자를 python 으로 부르면 거절이 아니다 — 위 거절은 py 를 안 알아봐서이지 경로 문제가 아니다.
    const reference = { command: `python3 "${gg}" init "${root}"` }
    expect(hostWriteDecision(root, tool, reference, userData), `ref/${tool}`).toBeNull()
  }
})

const scriptIn = (userData: string, name: string): string => join(skillHostDir(userData), 'scripts', name).replace(/\\/g, '/')

test('음성 대조: py 의 다른 인자·다른 이름·다른 꼴은 지금처럼 앱 자리 쓰기로 거절한다 (윈도 뿌리)', () => {
  const gg = winScript(WIN_USER_DATA, 'gg.py')
  const created = winScript(WIN_USER_DATA, 'gg_new.py')
  const q = (s: string): string => `"${s}"`
  const denied = [
    // 인라인 코드·모듈 실행: `-3` 뒤가 `-c`/`-m` 이라 스크립트 자리가 옵션이다.
    `py -3 -c "pass" ${q(gg)}`,
    `py -3 -m http.server ${q(gg)}`,
    `py -3 -c "open('x','w')" ${q(created)}`,
    // 런처 옵션이 `-3` 꼴이 아니다 — 인식하지 않는다.
    `py -V:3.11 ${q(gg)} init x`,
    `py -2 ${q(gg)}`,
    `py -3x ${q(gg)}`,
    `py -3.11x ${q(gg)}`,
    `py ${q(gg)} init x`,
    `py -3 -3 ${q(gg)}`,
    // 실행기 이름이 py 와 같지 않다 — 앞뒤 어느 쪽이든 이름 흉내는 런처가 아니다(N4).
    `pyw -3 ${q(gg)} init x`,
    `pypy -3 ${q(gg)} init x`,
    `py3 -3 ${q(gg)} init x`,
    `py.cmd -3 ${q(gg)} init x`,
    `py.bat -3 ${q(gg)} init x`,
    `py.exe.exe -3 ${q(gg)} init x`,
    `xpy -3 ${q(gg)} init x`,
    // 실행기가 경로 있는 이름이다.
    `./py -3 ${q(gg)} init x`,
    `C:/tmp/py.exe -3 ${q(gg)} init x`,
    `${q(`${WIN_ROOT}/py`)} -3 ${q(gg)} init x`,
    // 스크립트가 맞아도 추가 인자가 앱 자리를 쓴다(자기 사본 쓰기).
    `py -3 ${q(gg)} --out=${q(created)}`,
    `py -3 ${q(gg)} init ${q(created)}`,
    // 앱 자리 파일을 다른 명령이 쓴다.
    `touch ${q(created)}`
  ]
  const bashOnly = [`py -3 ${q(gg)} init x && touch ${q(created)}`]
  for (const tool of TOOLS) {
    for (const command of tool === 'Bash' ? [...denied, ...bashOnly] : denied) {
      const call = { command }
      expect(hostWriteDecision(WIN_ROOT, tool, call, WIN_USER_DATA), `${tool}/${command}`).toMatchObject({ behavior: 'deny' })
      expect(autoAllow(WIN_ROOT, tool, call, [], WIN_USER_DATA), `${tool}/${command}`).toBe(false)
    }
  }
})

test('N1: py·pyw 의 인라인 코드·임의 스크립트는 Bash·PowerShell 모두 python3 와 같이 자동 실행하지 않는다', async () => {
  const { root, userData } = installedBox()
  const pairs: [string, string][] = [
    ['py -3 -c "pass"', 'python3 -c "pass"'],
    ['py -c "pass"', 'python3 -c "pass"'],
    ['py -3.11 -c "pass"', 'python3 -c "pass"'],
    ['py.exe -3 -m http.server', 'python3 -m http.server'],
    ['py -3 analysis.py', 'python3 analysis.py'],
    ['py -3.11 analysis.py --x', 'python3 analysis.py --x'],
    ['py analysis.py', 'python3 analysis.py'],
    ['pyw -3 analysis.py', 'python3 analysis.py'],
    ['pyw -c "pass"', 'python3 -c "pass"'],
    ['PY -3 -c "pass"', 'python3 -c "pass"']
  ]
  for (const [command, reference] of pairs) {
    for (const tool of TOOLS) {
      // 맥 뿌리·윈도 뿌리 둘 다 — 이 판정은 뿌리 모양과 무관해야 한다.
      for (const [r, u, src] of [[root, userData, source], [WIN_ROOT, WIN_USER_DATA, undefined]] as const) {
        expect(autoAllow(r, tool, { command }, [], u, src), `${tool}/${command}`).toBe(false)
        expect(autoAllow(r, tool, { command: reference }, [], u, src), `ref/${tool}/${reference}`).toBe(false)
      }
    }
  }
  // 실제 흐름: Bash 에서 카드가 뜬다 — python3 -c 와 같은 제목.
  const asked = await rig({ root, userData }, { trusted: false })
  const titles: string[] = []
  for (const command of ['py -3 -c "pass"', 'pyw -3 analysis.py', 'python3 -c "pass"']) {
    const before = asked.cards.length
    const pending = asked.ask('Bash', { command })
    await settle(() => asked.cards.length > before)
    expect(asked.cards, command).toHaveLength(before + 1)
    titles.push(asked.cards[before].title)
    asked.answer(false)
    expect(plain(await pending), command).toEqual({ behavior: 'deny', message: '사용자가 허용하지 않았습니다.' })
  }
  expect(new Set(titles).size, titles.join(' | ')).toBe(1)
  // 정보 조회(버전·도움말)는 python3 와 같이 그대로 통과한다.
  for (const command of ['py --version', 'py -3 -V', 'py -h']) {
    expect(autoAllow(root, 'Bash', { command }, [], userData, source), command).toBe(true)
  }
})

test('N1 회귀 대조: 정상 스킬 호출(py -3 <앱 스킬>/scripts/gg.py)은 Bash 에서 계속 자동 통과한다', () => {
  const gg = winScript(WIN_USER_DATA, 'gg.py')
  for (const launcher of PY_LAUNCHERS) {
    const call = { command: `${launcher} "${gg}" init "${WIN_ROOT}"` }
    expect(autoAllow(WIN_ROOT, 'Bash', call, [], WIN_USER_DATA), call.command).toBe(true)
    expect(hostWriteDecision(WIN_ROOT, 'Bash', call, WIN_USER_DATA), call.command).toBeNull()
  }
  // 폴더 안 규칙집 사본의 스킬 스크립트도 python 과 같다.
  const local = `${WIN_ROOT}/.claude/skills/knuaf-dev/scripts/gg.py`
  expect(autoAllow(WIN_ROOT, 'Bash', { command: `py -3 "${local}" status` }, [], WIN_USER_DATA)).toBe(
    autoAllow(WIN_ROOT, 'Bash', { command: `python.exe "${local}" status` }, [], WIN_USER_DATA))
})
