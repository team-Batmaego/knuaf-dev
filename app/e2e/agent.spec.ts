// Unit tests for src/main/agent.ts. Plain Playwright `test()` in Node: no Electron is launched.
import { expect, test } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { mock } from 'node:test'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  agentApi, buildLaunchScript, bundledAgentDirs, bundledDirs, codexSkillConfigOverride, findExecutable, firstPromptFor, installSkill, launch, launchScriptExt, probeVersion,
  setAgentPlatformForTest, setBundledDirsProvider, setTreeAccess, skillBackupDir, skillSource, skillState, skillTargets, skillVersion, sq, VERSION_FILE
} from '../src/main/agent'
import { serverArgsFor } from '../src/main/chat/codex'
import { TERMINAL_ENUM_FAILED_COPY, TERMINAL_REFUSAL_HEAD } from '../src/main/chat/codexToolLock'
import { pathKeyOf } from '../src/main/chat/contracts'
import { fakeCodexEnv } from './fixtures/fake-codex'
import { ChatService } from '../src/main/chat/service'
import { APP_NAME } from '../src/shared/name'

const appRoot = resolve(__dirname, '..')
const source = skillSource(appRoot, false, '/nonexistent')

/**
 * 앱 스킬 자리는 설치 뒤 읽기 전용(파일 0444·폴더 0555)으로 잠긴다(설계 §4.2). 그래서 이 자리를
 * 건드리는 시험은 먼저 `chmod u+w` 에 해당하는 일을 직접 해야 한다 — 잠금이 실제로 걸렸다는
 * 증거이기도 하다(아무것도 안 풀고 쓰면 EACCES 로 죽는다). 정리도 같은 이유로 먼저 푼다.
 */
function unlockTree(dir: string): void { setTreeAccess(dir, true) }
// 시험이 process.env 를 건드리기 전 값 — 아래 복원 시험이 이 값과 비교한다(BUNDLE-WIN-ENV).
const pathBeforeTests = process.env[pathKeyOf(process.env)]
const homeBeforeTests = process.env.HOME

/**
 * env 를 잠시 바꾸고 **정확히** 되돌린다.
 *
 * 윈도우의 `process.env` 는 키 대소문자를 구분하지 않는다 — `Path` 와 `PATH` 는 같은 변수다.
 * 그래서 바꾼 키의 "이전 값"을 그때그때 읽어 되돌리면, 첫 키를 비운 뒤 두 번째 키를 읽을 때 이미
 * 빈 값이 잡히고, 복원에서 그 빈 값이 원래 값을 덮어쓴다. 실제로 동봉 시험이 윈도우 CI 에서
 * PATH 를 빈 채로 끝나 다음 파일(`chat.spec.ts`)의 PATH 시험을 깨뜨렸다(BUNDLE-WIN-ENV).
 *
 * 그래서 바꾸기 전 **전체 키·값을 스냅샷**하고, 복원할 때는 현재 키를 모두 지운 뒤 스냅샷을
 * (대소문자 무시로 짝지어) 그대로 다시 넣는다. 맥처럼 두 키가 다른 변수인 곳에서도 같다.
 */
async function withEnv<T>(
  patch: Record<string, string>,
  fn: () => T | Promise<T>,
  env: Record<string, string | undefined> = process.env
): Promise<T> {
  const keys = Object.keys(env)
  const before = new Map(keys.map((k) => [k, env[k]] as const))
  // 윈도우용 보조 색인 — 스냅샷에 `Path` 하나뿐인데 복원 루프가 다른 표기로 돌 때 쓴다.
  // 정확한 키가 있으면 언제나 그쪽이 이긴다(맥은 `PATH`·`Path` 가 서로 다른 변수다).
  const beforeLower = new Map(keys.map((k) => [k.toLowerCase(), env[k]] as const))
  try {
    for (const [k, v] of Object.entries(patch)) env[k] = v
    return await fn()
  } finally {
    for (const k of Object.keys(env)) delete env[k]
    for (const k of keys) {
      const v = before.has(k) ? before.get(k) : beforeLower.get(k.toLowerCase())
      if (v !== undefined) env[k] = v
    }
  }
}

/**
 * 윈도우 `process.env` 흉내 — 키를 대소문자 무시로 다루고, 변수마다 원래 키 이름 하나만 남긴다.
 * 맥에서는 `PATH` 와 `Path` 가 서로 다른 변수라 이 누수를 재현할 수 없어서 시험용으로 만든다.
 */
function winLikeEnv(init: Record<string, string>): Record<string, string> {
  const vars = new Map<string, { name: string; value: string }>()
  for (const [k, v] of Object.entries(init)) vars.set(k.toLowerCase(), { name: k, value: v })
  return new Proxy({} as Record<string, string>, {
    get: (_t, prop) => (typeof prop === 'string' ? vars.get(prop.toLowerCase())?.value : undefined),
    set: (_t, prop, value) => {
      if (typeof prop !== 'string') return false
      const key = prop.toLowerCase()
      vars.set(key, { name: vars.get(key)?.name ?? prop, value: String(value) })
      return true
    },
    deleteProperty: (_t, prop) => (typeof prop === 'string' ? vars.delete(prop.toLowerCase()) : true),
    has: (_t, prop) => (typeof prop === 'string' ? vars.has(prop.toLowerCase()) : false),
    ownKeys: () => [...vars.values()].map((v) => v.name),
    getOwnPropertyDescriptor: (_t, prop) => {
      const v = typeof prop === 'string' ? vars.get(prop.toLowerCase()) : undefined
      return v ? { enumerable: true, configurable: true, value: v.value } : undefined
    }
  })
}

// Where `claude` lives is machine-specific (Homebrew prefix, ~/.local/bin, a CI
// runner without it at all), so these assert the resolution behaviour rather than
// one developer's absolute path.
const claudePath = findExecutable('claude', process.env)

test.describe('findExecutable / probeVersion', () => {
  test('resolves an executable claude when installed, and null for a bogus name', async () => {
    if (claudePath) {
      expect(existsSync(claudePath)).toBe(true)
      if (process.platform === 'win32') {
        // 윈도우는 실행 가능한 확장자만 후보로 본다(`.exe` → `.cmd` → `.bat`). 확장자 없는
        // 이름은 CreateProcess 가 띄우지 못한다 — npm 설치 폴더의 `claude` shim 실패(CL-WIN-01).
        expect(['claude.exe', 'claude.cmd', 'claude.bat']).toContain(basename(claudePath))
      } else {
        // 비 Windows 는 종전과 같다 — 이름이 정확히 `claude` 로 끝나야 한다.
        expect(claudePath.endsWith('/claude')).toBe(true)
      }
    }
    expect(findExecutable('definitely-not-a-real-binary-xyz', process.env)).toBeNull()
  })

  test('falls back to the extra dirs when PATH is empty', () => {
    // Same answer without PATH: the fallback dirs must cover the usual installs.
    expect(findExecutable('claude', { PATH: '', HOME: process.env.HOME })).toBe(claudePath)
  })

  /**
   * 검토 W1D-R1-02 — 복사된 환경(`AgentCtx.env`·시험 입력)은 일반 객체라 윈도우의 실제 키
   * `Path` 를 쓴다. 같은 원인으로 도구를 못 찾으면 안 된다. 맥은 `Path` 가 별개 변수다.
   */
  test('복사된 환경에서도 PATH 를 찾는다 — 윈도우는 키 이름을 대소문자 무시로 (W1D-R1-02)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-env-'))
    const win = process.platform === 'win32'
    const file = join(dir, win ? 'knuaf-probe-tool.cmd' : 'knuaf-probe-tool')
    writeFileSync(file, win ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf-8')
    if (!win) chmodSync(file, 0o755)
    if (win) {
      // 윈도우에서 실제 키는 `Path` 다 — 복사본에서도 찾아야 한다.
      expect(findExecutable('knuaf-probe-tool', { Path: dir, USERPROFILE: dir })).toBe(file)
      expect(findExecutable('knuaf-probe-tool', { PATH: dir, USERPROFILE: dir })).toBe(file)
    } else {
      // 맥에서는 `Path` 와 `PATH` 가 서로 다른 변수다 — `Path` 만으로는 찾지 않는다(맥 판정 불변).
      expect(findExecutable('knuaf-probe-tool', { Path: dir, HOME: dir })).toBeNull()
      expect(findExecutable('knuaf-probe-tool', { PATH: dir, HOME: dir })).toBe(file)
    }
  })

  /**
   * CODEX-BUNDLE — 윈도우 설치본에 동봉한 Codex CLI 는 PATH **앞**에서 찾는다. 호스트가 맥이어도
   * `platform: 'win32'` 로 윈도우 분기를 그대로 검사한다(파일 존재 검사는 호스트 것이므로
   * 실행 비트를 준다 — 윈도우에서는 확장자만 본다).
   */
  test('동봉한 CLI 를 PATH 앞에서 찾는다 — 윈도우 분기', () => {
    const bundled = mkdtempSync(join(tmpdir(), 'kd-bundle-'))
    const onPath = mkdtempSync(join(tmpdir(), 'kd-onpath-'))
    const bundledExe = join(bundled, 'codex.exe')
    const onPathExe = join(onPath, 'codex.exe')
    for (const f of [bundledExe, onPathExe]) { writeFileSync(f, ''); chmodSync(f, 0o755) }
    const found = findExecutable('codex', { Path: onPath, USERPROFILE: bundled }, { platform: 'win32', leadingDirs: [bundled] })
    expect(found).toBe(bundledExe)  // PATH 에도 있는데 동봉본이 이긴다
  })

  test('KNUAF_AGENT_PATH_ONLY=1 이면 동봉본도 보지 않는다 — "도구 없음" 화면의 의미 보존', () => {
    const bundled = mkdtempSync(join(tmpdir(), 'kd-only-'))
    const exe = join(bundled, 'codex.exe')
    writeFileSync(exe, '')
    chmodSync(exe, 0o755)
    expect(findExecutable('codex', { Path: '', USERPROFILE: bundled, KNUAF_AGENT_PATH_ONLY: '1' }, { platform: 'win32', leadingDirs: [bundled] })).toBeNull()
    // 같은 조건에서 스위치만 빼면 찾는다 — 위가 "없어서" 통과한 것이 아님을 같은 자리에서 보인다.
    expect(findExecutable('codex', { Path: '', USERPROFILE: bundled }, { platform: 'win32', leadingDirs: [bundled] })).toBe(exe)
  })

  test('맥 분기에서는 이름 규칙이 그대로다 — `.exe` 를 후보로 보지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-darwin-'))
    // 이름을 하나만 둔다(개발 기계의 진짜 codex 가 뒤 후보에서 걸리지 않게).
    const name = 'knuaf-bundle-probe'
    const exe = join(dir, `${name}.exe`)
    const plain = join(dir, name)
    writeFileSync(exe, '')
    chmodSync(exe, 0o755)
    expect(findExecutable(name, { PATH: '', HOME: dir }, { platform: 'darwin', leadingDirs: [dir] })).toBeNull()
    writeFileSync(plain, '')
    chmodSync(plain, 0o755)
    expect(findExecutable(name, { PATH: '', HOME: dir }, { platform: 'darwin', leadingDirs: [dir] })).toBe(plain)
  })

  /**
   * CL-WIN-01 — npm 이 깐 Claude Code 는 한 폴더에 `claude`(셸 스크립트)와 `claude.cmd`(실행
   * shim)를 같이 둔다. 예전에는 확장자 없는 쪽을 먼저 집어 `execFile` 이 ENOENT(7ms, stdout 0)로
   * 죽었고, 로그인돼 있어도 "연결 상태를 확인하지 못했어요"(`probe:'failed'`)만 떴다(윈도우 실기기).
   * 같은 폴더에 둘 다 있을 때 `.cmd` 를 고르는 것을 여기서 고정한다.
   */
  test('윈도우: 같은 폴더의 `claude`+`claude.cmd` 에서 `.cmd` 를 고른다 (CL-WIN-01)', () => {
    const name = 'knuaf-npm-probe'
    const dir = mkdtempSync(join(tmpdir(), 'kd-win-npm-'))
    const put = (d: string, file: string): string => {
      const p = join(d, file)
      writeFileSync(p, file.endsWith('.cmd') ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n')
      chmodSync(p, 0o755)
      return p
    }
    put(dir, name)  // npm 이 같이 두는 확장자 없는 셸 스크립트
    const cmd = put(dir, `${name}.cmd`)
    // 동봉 자리·PATH 밖(EXTRA_DIRS)의 진짜 설치물이 끼어들지 않게 PATH 만 본다.
    const env = { Path: dir, USERPROFILE: dir, KNUAF_AGENT_PATH_ONLY: '1' }
    expect(findExecutable(name, env, { platform: 'win32' })).toBe(cmd)
    // `.exe`(네이티브 설치본)가 같이 있으면 그쪽이 먼저다 — cmd.exe 를 거치지 않는 길.
    const exe = put(dir, `${name}.exe`)
    expect(findExecutable(name, env, { platform: 'win32' })).toBe(exe)
    // 확장자 없는 이름 하나뿐이면 실행물이 아니다 — 찾았다고 하면 그 순간 ENOENT 다.
    const plainOnly = mkdtempSync(join(tmpdir(), 'kd-win-plain-'))
    put(plainOnly, name)
    expect(findExecutable(name, { Path: plainOnly, USERPROFILE: plainOnly, KNUAF_AGENT_PATH_ONLY: '1' }, { platform: 'win32' })).toBeNull()
  })

  test('bundledAgentDirs — Claude는 맥·윈도우, Codex는 윈도우만이며 패키지·개발 자리 일치', () => {
    const dev = { appRoot: '/tmp/app-root', isPackaged: false, resourcesPath: '/nonexistent' }
    const claude = (base: string, platform: string) => join(base, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${process.arch}`)
    expect(bundledAgentDirs(dev, 'darwin')).toEqual([claude(join(dev.appRoot, 'resources'), 'darwin')])
    expect(bundledAgentDirs(dev, 'win32')).toEqual([
      claude(join(dev.appRoot, 'resources'), 'win32'), join(dev.appRoot, 'resources', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    ])
    const packaged = { ...dev, isPackaged: true, resourcesPath: '/app/Contents/Resources' }
    expect(bundledAgentDirs(packaged, 'darwin')).toEqual([claude(packaged.resourcesPath, 'darwin')])
    expect(bundledAgentDirs(packaged, 'win32')).toEqual([
      claude(packaged.resourcesPath, 'win32'), join(packaged.resourcesPath, 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    ])
  })

  /**
   * 검토 CODEX-BUNDLE-R1-01 — 동봉 우선은 **옵션을 준 호출자만의 혜택이면 안 된다**. 첫 화면
   * (`connect:status`)과 로그인·채팅(`ChatService`)은 `findExecutable(provider)` 를 옵션 없이
   * 부르기 때문이다. 그래서 동봉 자리는 `findExecutable` 의 **기본값**이고, 그 기본값을 여기서
   * (그리고 아래 ChatService 시험에서) 확인한다.
   */
  test.describe('동봉 우선은 기본값 (CODEX-BUNDLE-R1-01)', () => {
    /**
     * `ChatService` 는 탐색을 `findExecutable(provider)` 로 부른다 — env 인자가 없어 **process.env**
     * 를 본다(연결 객체에 넘기는 env 는 spawn 환경이라 다른 것이다). 그래서 실제 소비 경로를
     * 검사하려면 process.env 를 잠시 바꿔야 한다. 끝나면 `withEnv` 가 정확히 되돌린다 —
     * 윈도우에서는 `Path` 와 `PATH` 가 같은 변수라 별칭을 함께 만지면 복원이 서로를 덮어쓴다.
     */
    const withBundled = (dir: string, fn: () => void | Promise<void>, envPatch: Record<string, string> = {}) => {
      const prevPlatform = setAgentPlatformForTest('win32')
      const prevDirs = setBundledDirsProvider(() => [dir])
      // 플랫폼의 **실제** PATH 키 하나만 다룬다(윈도우면 `Path`).
      const patch: Record<string, string> = { [pathKeyOf(process.env)]: '', HOME: dir, USERPROFILE: dir, ...envPatch }
      return (async () => {
        try {
          await withEnv(patch, fn)
        } finally {
          setAgentPlatformForTest(prevPlatform)
          setBundledDirsProvider(prevDirs)
        }
      })()
    }
    const fakeExe = (dir: string, name = 'codex.exe'): string => {
      const p = join(dir, name)
      writeFileSync(p, '#!/bin/sh\nexit 1\n')
      chmodSync(p, 0o755)
      return p
    }
    const chatFor = (dir: string, env: Record<string, string | undefined>): ChatService =>
      new ChatService({
        skillSource: () => join(dir, 'skill'), userData: join(dir, 'userData'),
        emit: () => {}, openExternal: async () => {}, sidecarBusy: () => false,
        venvPython: () => null, bundledPython: () => null, isTrusted: () => false, env
      })

    test('옵션 없이 부른 탐색이 동봉본을 찾고, PATH 설치본보다 앞선다 (윈도우)', async () => {
      const bundled = mkdtempSync(join(tmpdir(), 'kd-def-bundle-'))
      const onPath = mkdtempSync(join(tmpdir(), 'kd-def-path-'))
      const bundledExe = fakeExe(bundled)
      fakeExe(onPath)
      await withBundled(bundled, () => {
        // 옵션 없이(= 실제 소비 경로들과 같은 방식으로) 부른다.
        expect(findExecutable('codex', { Path: onPath, USERPROFILE: bundled })).toBe(bundledExe)
      })
    })

    test('첫 화면·폴더별 연결: 동봉본만 있으면 설치 안내로 떨어지지 않는다 (윈도우)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-svc-'))
      const bundled = mkdtempSync(join(tmpdir(), 'kd-svc-bin-'))
      const exe = fakeExe(bundled)
      await withBundled(bundled, async () => {
        // 소비 경로가 하는 바로 그 호출 — 동봉본이 뽑힌다(별도 설치가 없어도).
        expect(findExecutable('codex')).toBe(exe)
        const chat = chatFor(dir, {})
        // 전역(첫 화면) — 설치 안내 분기(installed:false)가 아니라 연결 시도까지 간다.
        const global = await chat.globalStatus('codex')
        expect(global.installed).toBe(true)
        expect(global.probe).toBe('failed')  // 가짜 CLI 라 연결은 실패한다 — 그 전에 찾긴 찾았다
        // 폴더별 연결도 같은 기본 탐색을 쓴다: 설치 안내로 떨어지지 않는다.
        const perFolder = await chat.status(join(dir, 'proj'), 'codex').catch((e) => ({ installed: true, detail: String(e) }))
        expect(perFolder.installed).not.toBe(false)
      })
    })

    test('KNUAF_AGENT_PATH_ONLY=1 이면 동봉도 PATH 도 아니면 설치 안내 — 종전 의미 보존', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-only-svc-'))
      const bundled = mkdtempSync(join(tmpdir(), 'kd-only-bin-'))
      fakeExe(bundled)
      await withBundled(bundled, async () => {
        expect(findExecutable('codex')).toBeNull()
        const chat = chatFor(dir, {})
        const global = await chat.globalStatus('codex')
        expect(global.installed).toBe(false)
        expect(String(global.detail)).toContain('설치 안내')
        const perFolder = await chat.status(join(dir, 'proj'), 'codex')
        expect(perFolder.installed).toBe(false)
      }, { KNUAF_AGENT_PATH_ONLY: '1' })
    })

    test('맥 기본 동봉 자리는 Claude SDK이며 codex 동봉 자리는 포함하지 않는다', () => {
      const resources = (process as { resourcesPath?: string }).resourcesPath ?? join(appRoot, 'resources')
      expect(bundledDirs('darwin')).toEqual([
        join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${process.arch}`)
      ])
    })

    /**
     * BUNDLE-WIN-ENV 재현 — 윈도우 CI 에서 이 시험들이 PATH 를 빈 채로 끝나 다음 파일
     * (`chat.spec.ts`)의 PATH 시험을 깨뜨렸다. 맥에서는 `PATH`·`Path` 가 다른 변수라 재현되지
     * 않으므로, 윈도우처럼 대소문자를 무시하는 env 를 만들어 **복원 로직 자체**를 검사한다.
     */
    test('env 복원은 윈도우의 키 대소문자 무시에서도 원래 값으로 돌아온다 (BUNDLE-WIN-ENV)', async () => {
      const win = winLikeEnv({ Path: 'C:\\Windows\\System32', HOME: '/Users/s' })
      await withEnv({ Path: '', PATH: '' }, async () => { expect(win.Path).toBe(''); expect(win.PATH).toBe('') }, win)
      expect(win.PATH).toBe('C:\\Windows\\System32')   // 키별 "이전 값" 복원은 여기서 '' 를 남겼다
      expect(win.Path).toBe('C:\\Windows\\System32')
      expect(Object.keys(win)).toEqual(['Path', 'HOME'])  // 별칭이 새 변수로 늘어나지도 않는다
      // 맥처럼 서로 다른 변수인 곳에서도 그대로 동작한다.
      const mac = { PATH: '/usr/bin', Path: 'x' }
      await withEnv({ PATH: '' }, () => { expect(mac.PATH).toBe('') }, mac)
      expect(mac.PATH).toBe('/usr/bin')
      expect(mac.Path).toBe('x')
    })

    /** 발주서 요청 — 시험이 끝난 뒤 실제 환경이 원래대로인지 여기서 단언한다. */
    test('동봉 시험 뒤에도 PATH 가 비지 않는다 — 다음 파일로 새지 않는다 (BUNDLE-WIN-ENV)', () => {
      // 윈도우 CI 에서 종전 코드는 여기서 '' 였고, 그래서 다음 파일의 PATH 시험이 깨졌다.
      expect(process.env[pathKeyOf(process.env)]).toBe(pathBeforeTests)
      expect(process.env.HOME).toBe(homeBeforeTests)
    })
  })

  test('probeVersion은 네이티브·shim 모두 콘솔을 숨긴다 (W1-R01)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const calls: { command: string; args: string[]; options: any }[] = []
    const execFile = mock.method(require('node:child_process'), 'execFile', (command, args, options, callback) => {
      calls.push({ command, args, options })
      callback(null, '\n 1.2.3-test\nsecond line\n')
    })
    try {
      for (const os of ['win32', 'darwin', 'linux']) {
        Object.defineProperty(process, 'platform', { value: os, configurable: true })
        for (const binary of ['C:\\native\\codex.exe', 'C:\\native\\claude.exe', 'C:\\npm\\claude.cmd', 'C:\\npm\\claude.bat']) {
          expect(await probeVersion(binary)).toBe('1.2.3-test')
          const call = calls.at(-1)!
          expect(call.options).toMatchObject({ timeout: 8000, encoding: 'utf-8', windowsHide: true })
          if (os === 'win32' && /\.(cmd|bat)$/.test(binary)) {
            expect(call.command).toMatch(/(?:^|[\\/])cmd\.exe$/i)
            expect(call.options.windowsVerbatimArguments).toBe(true)
            expect(call.args.slice(0, 4)).toEqual(['/v:off', '/d', '/s', '/c'])
          } else {
            expect(call.command).toBe(binary)
            expect(call.args).toEqual(['--version'])
          }
        }
      }
      expect(calls).toHaveLength(12)
    } finally {
      execFile.mock.restore()
      Object.defineProperty(process, 'platform', platform)
    }
  })

  test('probeVersion returns a line for claude and null for a missing binary', async () => {
    test.skip(!claudePath, 'claude is not installed on this machine')
    const v = await probeVersion(claudePath!)
    expect(typeof v).toBe('string')
    expect(v!.length).toBeGreaterThan(0)
    expect(v).not.toContain('\n')
    expect(await probeVersion('/nonexistent/bin/nothing')).toBeNull()
  })
})

test.describe('skill source + version', () => {

  test('skillVersion is stable, 12 hex, and changes with content', () => {
    const a = skillVersion(source)
    const b = skillVersion(source)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)

    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-'))
    writeFileSync(join(fake, 'SKILL.md'), '# x\n')
    const v1 = skillVersion(fake)
    writeFileSync(join(fake, 'SKILL.md'), '# y\n')
    expect(skillVersion(fake)).not.toBe(v1)
  })

  test('a references-only change moves the version', () => {
    // It did not before: references/ was left out of the hash entirely, so replacing
    // every rule document still read as 'installed' and projects kept a stale copy.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-refs-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'references'))
    writeFileSync(join(fake, 'references', 'workflow-order.md'), '원래 내용\n')
    const before = skillVersion(fake)
    writeFileSync(join(fake, 'references', 'workflow-order.md'), '바뀐 내용\n')
    expect(skillVersion(fake)).not.toBe(before)
  })

  test('a same-length script edit moves the version', () => {
    // The old hash used name:size, so an equal-length edit was invisible.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-size-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'scripts'))
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'VERSION = "1.0"\n')
    const before = skillVersion(fake)
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'VERSION = "9.9"\n')
    expect(skillVersion(fake)).not.toBe(before)
  })

  test('bytecode and OS junk do not move the version', () => {
    // installSkill never copies these, so they must not make a project look outdated.
    const fake = mkdtempSync(join(tmpdir(), 'kd-skill-junk-'))
    writeFileSync(join(fake, 'SKILL.md'), '# same\n')
    mkdirSync(join(fake, 'scripts'))
    writeFileSync(join(fake, 'scripts', 'gg_core.py'), 'x = 1\n')
    const before = skillVersion(fake)
    mkdirSync(join(fake, 'scripts', '__pycache__'))
    writeFileSync(join(fake, 'scripts', '__pycache__', 'gg_core.cpython-313.pyc'), 'junk')
    writeFileSync(join(fake, 'scripts', '.DS_Store'), 'junk')
    expect(skillVersion(fake)).toBe(before)
  })
})

test.describe('installSkill', () => {
  test('a missing source preserves existing student copies, GUI marker and legacy skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-missing-source-'))
    try {
      const target = skillTargets(root, join(root, 'user-data')).claude
      const legacy = join(dirname(target), 'knuaf-doc')
      for (const folder of [target, legacy, join(root, '.knuaf-gui')]) mkdirSync(folder, { recursive: true })
      writeFileSync(join(target, 'SKILL.md'), '# student working copy\n')
      writeFileSync(join(legacy, 'SKILL.md'), '# student legacy notes\n')
      const marker = join(root, '.knuaf-gui', 'skill-install.json')
      writeFileSync(marker, '{"student":"preserved"}')
      expect(() => installSkill(join(root, 'missing-bundle'), target, 'new-version')).toThrow()
      expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# student working copy\n')
      expect(readFileSync(join(legacy, 'SKILL.md'), 'utf8')).toBe('# student legacy notes\n')
      expect(readFileSync(marker, 'utf8')).toBe('{"student":"preserved"}')
      expect(existsSync(skillBackupDir(target))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('metadata-only bundle changes reinstall both providers, preserve backups and remain GUI-managed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-composed-install-'))
    try {
      const origin = join(root, 'bundle'), project = join(root, 'project'), home = join(root, 'home')
      const userData = join(root, 'user-data')
      cpSync(source, origin, { recursive: true })
      mkdirSync(home)
      const targets = skillTargets(project, userData), previous = skillVersion(origin)
      const metadata = JSON.parse(readFileSync(join(origin, 'skill.json'), 'utf8'))
      for (const [kind, target] of Object.entries(targets)) {
        installSkill(origin, target, previous)
        // Claude 사본은 잠겨 있다 — 학생이 권한을 풀고 손댄 상황(백업이 보존해야 하는 것).
        if (kind === 'claude') unlockTree(target)
        writeFileSync(join(target, 'student-note.txt'), 'preserve student annotations')
      }
      writeFileSync(join(origin, 'skill.json'), JSON.stringify({ ...metadata, version: '1.0.1' }))
      const current = skillVersion(origin)
      expect(current).not.toBe(previous)
      const localPython = resolve(appRoot, '../.venv-dev/bin/python')
      const python = process.env.KNUAF_PYTHON ?? (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3')
      // Execute the installed updater, but forbid every real network connection even on a regression.
      const entry = `import runpy,sys
def offline(event,args):
    if event in ("socket.connect","socket.getaddrinfo"): raise RuntimeError("network forbidden in managed install test")
sys.addaudithook(offline)
sys.argv=[sys.argv[1],"auto"]
runpy.run_path(sys.argv[0],run_name="__main__")`
      for (const target of Object.values(targets)) {
        expect(skillState(target, current)).toBe('outdated')
        const result = installSkill(origin, target, current)
        expect(result.action).toBe('updated')
        expect(readFileSync(join(result.backup!, 'student-note.txt'), 'utf8')).toBe('preserve student annotations')
        expect(JSON.parse(readFileSync(join(result.backup!, 'skill.json'), 'utf8'))).toEqual(metadata)
        expect(JSON.parse(readFileSync(join(target, 'skill.json'), 'utf8')).version).toBe('1.0.1')
        expect(skillVersion(target)).toBe(current)
        const managed = spawnSync(python, ['-c', entry, join(target, 'scripts/gg_update.py')], {
          encoding: 'utf8', timeout: 15_000, env: { ...process.env, HOME: home, USERPROFILE: home },
        })
        expect(managed.status, managed.stdout + managed.stderr).toBe(0)
        expect(JSON.parse(managed.stdout).result).toBe('managed')
      }
      // Claude 사본은 앱 자리(논문 폴더 밖), Codex 사본만 폴더 안 — 논문 폴더에 `.claude` 가
      // 생기지 않는 것이 이 배선의 목적이다(그 폴더를 CLI 가 설정으로 읽지 않게).
      expect(readdirSync(join(userData, 'skill-host', '.claude', 'skills'))).toEqual(['knuaf-dev'])
      expect(readdirSync(join(project, '.agents/skills'))).toEqual(['knuaf-dev'])
      expect(existsSync(join(project, '.claude'))).toBe(false)
    } finally { unlockTree(root); rmSync(root, { recursive: true, force: true }) }
  })

  test('installs into a tmp project root, is unchanged on rerun, and backs up when tampered', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-root-'))
    const userData = join(root, 'user-data')
    const targets = skillTargets(root, userData)
    // Claude 는 앱 스킬 자리(논문 폴더 밖), Codex 는 폴더 사본.
    expect(targets.claude).toBe(join(userData, 'skill-host', '.claude', 'skills', 'knuaf-dev'))
    expect(targets.codex).toBe(join(root, '.agents', 'skills', 'knuaf-dev'))
    const version = skillVersion(source)

    expect(skillState(targets.claude, version)).toBe('missing')
    const first = installSkill(source, targets.claude, version)
    expect(first).toEqual({ action: 'installed' })
    for (const f of ['SKILL.md', 'references', 'scripts', VERSION_FILE]) expect(existsSync(join(targets.claude, f))).toBe(true)
    expect(readFileSync(join(targets.claude, VERSION_FILE), 'utf-8').trim()).toBe(version)
    expect(skillState(targets.claude, version)).toBe('installed')
    // filtered copy: no __pycache__ even though the checkout has one
    expect(existsSync(join(targets.claude, 'scripts', '__pycache__'))).toBe(false)
    expect(readdirSync(join(targets.claude, 'scripts')).some((n) => n.endsWith('.py'))).toBe(true)

    expect(installSkill(source, targets.claude, version)).toEqual({ action: 'unchanged' })

    unlockTree(targets.claude)
    writeFileSync(join(targets.claude, VERSION_FILE), 'tampered\n')
    expect(skillState(targets.claude, version)).toBe('outdated')
    const third = installSkill(source, targets.claude, version)
    expect(third.action).toBe('updated')
    expect(existsSync(third.backup!)).toBe(true)
    expect(readFileSync(join(third.backup!, VERSION_FILE), 'utf-8')).toBe('tampered\n')
    expect(readFileSync(join(targets.claude, VERSION_FILE), 'utf-8').trim()).toBe(version)

    // The backup must not be a sibling of the skill: anything under skills/ is
    // discovered as its own skill, so a sibling backup competes with the real one.
    expect(readdirSync(join(userData, 'skill-host', '.claude', 'skills'))).toEqual(['knuaf-dev'])
    expect(third.backup).toBe(join(skillBackupDir(targets.claude), basename(third.backup!)))
    expect(basename(third.backup!)).toMatch(/^\.claude-\d{8}-\d{6}$/)
    expect(third.backup!.startsWith(join(userData, 'skill-host', '.knuaf-gui'))).toBe(true)
    expect(existsSync(join(root, '.claude'))).toBe(false)
    // 다시 깐 사본은 다시 잠긴다(§4.2: 풀기→복사→잠금). 백업도 잠긴 채로 남는다.
    expect(statSync(join(targets.claude, VERSION_FILE)).mode & 0o222).toBe(0)
    expect(statSync(targets.claude).mode & 0o222).toBe(0)
    unlockTree(root)
    rmSync(root, { recursive: true, force: true })
  })

  test('a codex backup is named apart from a claude one', () => {
    const root = mkdtempSync(join(tmpdir(), 'kd-root-bak-'))
    const userData = join(root, 'user-data')
    const targets = skillTargets(root, userData)
    const version = skillVersion(source)
    for (const kind of ['claude', 'codex'] as const) {
      installSkill(source, targets[kind], version)
      // Claude 사본은 잠겨 있다 — 학생이 소유자 권한으로 푼 뒤 고친 상황을 흉내낸다.
      if (kind === 'claude') unlockTree(targets[kind])
      writeFileSync(join(targets[kind], VERSION_FILE), 'tampered\n')
      installSkill(source, targets[kind], version)
    }
    // 장부는 사본마다 그 사본의 상위 뿌리에 남는다 — Claude 는 앱 자리, Codex 는 논문 폴더.
    const claudeBackups = readdirSync(join(userData, 'skill-host', '.knuaf-gui', 'skill-backups'))
    const codexBackups = readdirSync(join(root, '.knuaf-gui', 'skill-backups'))
    expect(claudeBackups).toHaveLength(1)
    expect(claudeBackups[0].startsWith('.claude-')).toBe(true)
    expect(codexBackups).toHaveLength(1)
    expect(codexBackups[0].startsWith('.agents-')).toBe(true)
    unlockTree(root)
    rmSync(root, { recursive: true, force: true })
  })

  test('replacing only the annual template marks an installed skill outdated', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'kd-annual-template-'))
    const origin = join(fixture, 'source')
    const target = skillTargets(join(fixture, 'project'), join(fixture, 'user-data')).codex
    mkdirSync(join(origin, 'assets', 'templates'), { recursive: true })
    writeFileSync(join(origin, 'SKILL.md'), '# fixed rules\n')
    const template = join(origin, 'assets', 'templates', 'finance-template.xlsx')
    writeFileSync(template, 'annual template 2026')
    const previous = skillVersion(origin)
    installSkill(origin, target, previous)
    expect(skillState(target, previous)).toBe('installed')

    // Same length and unchanged scripts/docs: template content alone must invalidate.
    writeFileSync(template, 'annual template 2027')
    const current = skillVersion(origin)
    expect(skillState(target, current)).toBe('outdated')
    expect(installSkill(origin, target, current).action).toBe('updated')
    expect(skillState(target, current)).toBe('installed')
  })
})

test.describe('buildLaunchScript', () => {
  test('quotes paths and prompts, exports PATH, execs claude with the prompt', () => {
    const s = buildLaunchScript({
      root: '/tmp/논문 폴더', agent: 'claude', agentPath: '/opt/homebrew/bin/claude',
      venvBin: '/tmp/논문 폴더/.venv/bin', bundledBin: '/App/Resources/python/bin', firstPrompt: '시작하기'
    }, 'darwin')   // 맥 기대 시험은 플랫폼을 명시한다 — 윈도우 기대는 별도 시험이 맡는다
    expect(s.startsWith('#!/bin/bash\n')).toBe(true)
    expect(s).toContain(`cd '/tmp/논문 폴더' || exit 1`)
    expect(s).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':'/App/Resources/python/bin':'/opt/homebrew/bin':'/usr/local/bin':"$HOME/.local/bin":"$PATH"`)
    expect(s).toContain('export KNUAF_DOC_APP=1')
    // 도우미·학생이 이 창에서 돌리는 규칙집 스크립트도 UTF-8 로 말한다 — 윈도우 기본
    // 코드페이지로 파이프하면 받는 쪽에서 한글이 깨진다(v0.6.4 발견, v0.5.0 규칙집 수정과 별개).
    expect(s).toContain('export PYTHONUTF8=1')
    expect(s).toContain('export PYTHONIOENCODING=utf-8')
    // ~/.claude/CLAUDE.md의 @import가 외부 경로를 가리키면 학생에게 영어 보안 프롬프트가 뜬다 —
    // 이 앱이 띄우는 도우미는 메모리 파일을 아예 읽지 않는다.
    expect(s).toContain('export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1')
    expect(s).toContain(`${APP_NAME}가 AI 도우미를 엽니다`)
    // 스킬 스크립트가 논문 폴더에 `__pycache__` 를 남기지 않는다(§4.1 표) — 채팅 경로와 같은 값.
    expect(s).toContain('export PYTHONDONTWRITEBYTECODE=1')
    // 비상구(외부 터미널)에도 채팅과 같은 1층(§4.1-D) — 설정 출처 0개 + 폴더 `.mcp.json` 차단 +
    // 도구 팝업 차단. 설정 출처는 **빈 목록**이라 `=` 로 붙인다 — 공백이면 값이 빠진다.
    // `--disallowedTools=…` 도 `=` 필수 — 공백이면 가변 인자가 첫 프롬프트를 삼킨다.
    expect(s).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources= --strict-mcp-config '--disallowedTools=AskUserQuestion' '시작하기'`)
    // 스킬 자리·규칙 파일이 없으면 그 인자도 없다(4단계가 파일을 만들면 자동으로 붙는다).
    expect(s).not.toContain('--plugin-dir-no-mcp')
    expect(s).not.toContain('--append-system-prompt-file')
  })

  /**
   * 형님 승인 W1 연결 기제 ④. 윈도우에는 `.command`(bash)가 없으므로 `.cmd`(배치)를 낸다 —
   * 같은 일(작업 폴더로 이동·PATH·환경변수·가드레일)을 하고, cmd 가 담을 수 없는 것만 다르다.
   */
  test('win32 는 .cmd 배치로 같은 일을 한다 — 첫 프롬프트는 한 줄로 눌러 담는다', () => {
    const o = {
      root: 'C:\\Users\\학생\\내 논문', agent: 'claude' as const,
      agentPath: 'C:\\Users\\학생\\AppData\\Roaming\\npm\\claude.cmd',
      venvBin: 'C:\\Users\\학생\\내 논문\\.venv\\Scripts', bundledBin: null,
      firstPrompt: firstPromptFor(3, 'C:\\Users\\학생\\내 논문')
    }
    const s = buildLaunchScript(o, 'win32')
    expect(s.startsWith('@echo off\r\n')).toBe(true)
    // 실기기 QA-04 — 둘째 줄에서 UTF-8 코드페이지로 바꾼다. cmd 는 배치를 콘솔 코드페이지(949)로
    // 읽으므로, 그 전 줄들은 ASCII 여야 하고 한글은 그 뒤에만 나온다.
    const lines = s.split('\r\n')
    expect(lines[1]).toBe('chcp 65001 >nul')
    expect(lines.slice(0, 2).join('\r\n')).toMatch(/^[\x20-\x7e\r\n]*$/)
    expect(s.charCodeAt(0), 'BOM 이 있으면 첫 줄이 깨진다').toBe('@'.charCodeAt(0))
    // 지연 확장을 끈다(`!` 가 경로·문장에서 글자 그대로 가게).
    expect(s).toContain('\r\nsetlocal DisableDelayedExpansion\r\n')
    // 작업 폴더로 이동(드라이브까지) — 공백·한글 경로가 인용된다. 실패하면 창을 남긴다.
    expect(s).toContain('cd /d "C:\\Users\\학생\\내 논문" || exit /b 1')
    // 도우미가 오류로 끝나면 창을 남긴다(바로 닫히면 학생이 이유를 못 본다).
    expect(s).toContain('set "KNUAF_LAUNCH_EXIT=%errorlevel%"')
    expect(s).toContain('pause\r\nexit /b %KNUAF_LAUNCH_EXIT%')
    expect(s).toContain('if "%KNUAF_LAUNCH_EXIT%"=="0" exit /b 0')
    expect(lines.filter(Boolean).at(-1)).toBe('exit /b %errorlevel%')
    // PATH 는 `;` 이고 .venv 가 앞에 온다. 원래 PATH 를 덮지 않는다.
    expect(s).toContain('set "PATH=C:\\Users\\학생\\내 논문\\.venv\\Scripts;%PATH%"')
    expect(s).toContain('set "KNUAF_DOC_APP=1"')
    // 맥 스크립트와 같은 이유 — cmd 기본 코드페이지(949)로 파이프한 한글이 받는 쪽에서 깨진다.
    expect(s).toContain('set "PYTHONUTF8=1"')
    expect(s).toContain('set "PYTHONIOENCODING=utf-8"')
    expect(s).toContain('set "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"')
    // 채팅과 같은 1층 — 설정 출처 0개, 도구 팝업은 끈다. 인용 부호는 배치 이스케이프 층수에
    // 따라 달라지므로(대상이 `.cmd` shim 이면 두 층) 토큰 자체로 확인하고, 실제 argv 는
    // 아래 실행 시험이 잠근다.
    for (const flag of ['--setting-sources=', '--strict-mcp-config', '--disallowedTools=AskUserQuestion']) expect(s).toContain(flag)
    expect(s).toContain('set "PYTHONDONTWRITEBYTECODE=1"')
    // 첫 프롬프트는 **한 줄**이고 그 글자는 살아 있다(cmd 인자에는 줄바꿈이 못 들어간다).
    expect(s).toContain('이어서')
    expect(s).toContain('작업')
    expect(s).not.toContain('이어서 하기\r\n')
    // 맥 스크립트의 것(셔뱅·exec·export)은 없다.
    expect(s).not.toContain('#!/bin/bash')
    expect(s).not.toContain('export ')
    expect(s).not.toContain('exec ')
    // 확장자가 실행물을 정한다(윈도우에는 실행 비트가 없다).
    expect(launchScriptExt('win32')).toBe('.cmd')
    expect(launchScriptExt('darwin')).toBe('.command')
  })

  /** W1C-R1-01(④) — 배치의 확장 단계는 명령줄과 달라 `%`→`%%`, 메타문자는 따로 막는다. */
  test('win32 배치는 배치 확장 규칙으로 막는다 — `%`·`&`·`!`·공백 (W1 ④)', () => {
    const o = {
      root: 'C:\\Users\\A&B\\내 논문', agent: 'claude' as const,
      agentPath: 'C:\\Program Files\\npm\\claude.cmd',
      venvBin: null, bundledBin: null, firstPrompt: '100% & 확인!'
    }
    const s = buildLaunchScript(o, 'win32')
    // `%` 는 배치에서 `%%` 로 적어야 글자 그대로다(배치는 거절하지 않는다 — 확장 단계가 다르다).
    expect(s).toContain('100%%')
    // 실행 줄의 `&`·`!` 는 전부 `^` 뒤에 있다(따옴표만으로는 cmd 가 막지 못한다).
    const exec = s.split('\r\n').find((l) => l.includes('claude.cmd'))
    expect(exec, '실행 줄이 없다').toBeTruthy()
    expect(exec).not.toMatch(/(^|[^^])&/)
    expect(exec).not.toMatch(/(^|[^^])!/)
    // **실행 파일 경로는 한 층만** — shim 의 `%*` 로 다시 해석되지 않는다(W1C-R1-01 확인).
    // 두 층이면 첫 해석 뒤에도 `^` 가 남아 프로그램 이름을 찾지 못한다.
    // 인자들이 `^^^"` 로 시작하므로 실행 파일 경로는 첫 ` ^` 앞까지다.
    const cmdPart = exec!.slice(0, exec!.indexOf(' ^'))
    expect(cmdPart).toBe('C:\\Program^ Files\\npm\\claude.cmd')
    expect(cmdPart).not.toContain('^^')
    expect(cmdPart).not.toContain('^"')
    // `cd` 는 따옴표 안이라 `&` 가 그대로여도 안전하다.
    expect(s).toContain('cd /d "C:\\Users\\A&B\\내 논문" || exit /b 1')
  })

  /**
   * 실기기 QA-04 — 설치본은 `codex.exe` 를 동봉한다. `.exe` 는 cmd 가 한 번 읽고 바로 MSVCRT 로
   * 넘기므로 인자의 `^` 는 **한 층**이다. 두 층이면 `^"` 가 남아 `-c` 설정값이 깨진다.
   */
  test('win32 배치 — 대상이 .exe 면 인자를 한 층만 막는다 (QA-04)', () => {
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    const base = { root: 'C:\\Users\\이뚠냥\\Downloads\\QA 한글 시험', agent: 'codex' as const, venvBin: null, bundledBin: null, firstPrompt: '', home }
    const exeLine = buildLaunchScript({ ...base, agentPath: 'C:\\Program Files\\knuaf\\resources\\codex\\codex.exe' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.exe'))!
    const shimLine = buildLaunchScript({ ...base, agentPath: 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.cmd'))!
    const exeArg = exeLine.split(' -c ')[1]
    const shimArg = shimLine.split(' -c ')[1]
    // cmd가 실행물을 찾는 것과, 네이티브 CRT가 argv[0]을 온전히 읽는 것은 별개다.
    // CI 실패는 설정값 손상이 아니라 Files\\동봉, codex\\codex.exe가 추가 인자로 온 것이었다.
    expect(exeLine.split(' -c ')[0]).toBe('"C:\\Program Files\\knuaf\\resources\\codex\\codex.exe"')
    expect(exeArg.startsWith('^"skills.config=')).toBe(true)
    expect(exeArg).not.toContain('^^')
    expect(shimArg.startsWith('^^^"skills.config=')).toBe(true)
  })

  /**
   * W1C-R1-01(④) **실행** 반례 — 생성한 배치를 직접 `cmd /d /c` 로 돌린다(터미널 창 없이).
   * 가짜 `codex.cmd` 가 받은 argv 를 남기고, `Program Files` 공백 경로·`A&B` 홈의 설정값·
   * `&` 부수 명령이 명령으로 갈라지지 않았는지 본다. 맥은 문자열 단언만 — skip 아니라 분기다.
   */
  test('win32 배치를 실제로 실행해도 argv 가 그대로 온다 (W1 ④, 실행)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-batch-'))
    // 실기기 QA-04 — 루트·홈에 **한글과 공백**을 둔다. 배치 파일은 UTF-8 이고 cmd 는 콘솔
    // 코드페이지(한국어 949, CI 러너 437)로 읽으므로, `chcp 65001` 이 없으면 `cd` 부터 실패한다.
    const root = join(base, '한글 논문 폴더')                // 한글 + 공백
    const agentDir = join(base, 'Program Files', 'npm')    // 공백 경로
    const home = join(base, '이뚠냥 A&B')                    // 한글 + cmd 메타문자
    const argvFile = join(base, 'argv.json')
    const marker = join(base, 'PWNED.txt')
    const recorder = join(base, 'recorder.mjs')
    const agentPath = join(agentDir, 'codex.cmd')
    for (const d of [root, agentDir, join(home, '.codex', 'skills', 'knuaf-dev')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n', 'utf-8')
    writeFileSync(recorder, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\n`, 'utf-8')
    // npm shim 과 같은 모양 — `%*` 로 인자를 그대로 넘긴다(그래서 인자만 두 번 막는다).
    writeFileSync(agentPath, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`, 'utf-8')

    const config = codexSkillConfigOverride(home)!
    const codex = buildLaunchScript({ root, agent: 'codex', agentPath, venvBin: null, bundledBin: null, firstPrompt: '', home }, 'win32')
    // (문자열, 두 플랫폼) 명령은 한 층·인자는 `^` 뒤 — A&B 설정값이 갈라지지 않는다.
    const exec = codex.split('\r\n').find((l) => l.includes('codex.cmd'))!
    expect(exec.split(' -c ')[0]).toMatch(/Program\^ Files/)
    expect(exec.split(' -c ')[0]).not.toContain('^^')
    expect(exec).not.toMatch(/(^|[^^])&/)

    // `&` 뒤의 부수 명령 — 따옴표만으로는 막지 못하므로 실제 실행으로 확인한다.
    const evil = `x&echo PWNED>"${marker}"`
    const claude = buildLaunchScript({ root, agent: 'claude', agentPath, venvBin: null, bundledBin: null, firstPrompt: evil }, 'win32')
    expect(claude).not.toMatch(/(^|[^^])&/)
    if (process.platform !== 'win32') return

    const run = (script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> => new Promise((resolve, reject) => {
      const file = join(base, 'run.cmd')
      writeFileSync(file, script, 'utf-8')
      // 실기기와 같은 CP949에서 시작한다. ASCII 진입 배치가 생성한 UTF-8 배치를 읽는다.
      const entry = join(base, 'start.cmd')
      writeFileSync(entry, '@echo off\r\nchcp 949 >nul\r\n"%~dp0run.cmd"\r\n', 'utf-8')
      const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', entry], { env: { ...process.env, ARGV_OUT: argvFile, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.setEncoding('utf-8').on('data', (s) => { stdout += s })
      child.stderr.setEncoding('utf-8').on('data', (s) => { stdout += s })
      child.on('error', reject).on('close', (code) => resolve({ code, stdout }))
    })
    const recorded = (): { argv: string[]; cwd: string; argv0?: string; commandLine?: string } => JSON.parse(readFileSync(argvFile, 'utf-8'))
    expect((await run(codex)).code, 'codex 배치가 실패했다(한글 경로로 cd 하지 못했을 수 있다)').toBe(0)
    expect(recorded().argv, 'codex argv 가 다르다').toEqual(['-c', config])
    expect(realpathSync.native(recorded().cwd), '한글·공백 작업 폴더로 이동하지 않았다').toBe(realpathSync.native(root))
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)
    expect((await run(claude)).code, 'claude 배치가 실패했다').toBe(0)
    expect(recorded().argv, 'claude argv 가 다르다')
      .toEqual(['--setting-sources=', '--strict-mcp-config', '--disallowedTools=AskUserQuestion', evil])
    expect(existsSync(marker), '`&` 뒤의 부수 명령이 실행됐다').toBe(false)

    // 실기기 QA-04 — 설치본의 동봉 `codex.exe`(npm shim 이 아님). 받은 원래 argv 를 남기는 `.exe` 로
    // 파이썬 실행 파일을 `codex.exe` 이름으로 복사해 쓴다: `sitecustomize` 가 시작하자마자
    // `sys.orig_argv` 를 적고 끝낸다(`-c` 뒤 설정값은 코드로 실행되지 않는다).
    const py = process.env.KNUAF_PYTHON
    expect(py && existsSync(py), 'CI 는 KNUAF_PYTHON(절대 경로)을 준다 — .exe 실행 시험에 필요하다').toBeTruthy()
    const exeDir = join(base, 'Program Files', '동봉 codex')
    mkdirSync(exeDir, { recursive: true })
    const exe = join(exeDir, 'codex.exe')
    copyFileSync(py!, exe)
    for (const f of readdirSync(dirname(py!))) if (/\.dll$/i.test(f)) copyFileSync(join(dirname(py!), f), join(exeDir, f))
    const site = join(base, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'sitecustomize.py'), [
      'import ctypes, json, os, sys',
      'ctypes.windll.kernel32.GetCommandLineW.restype = ctypes.c_wchar_p',
      "with open(os.environ['ARGV_OUT'], 'w', encoding='utf-8') as f:",
      "    json.dump({'argv': sys.orig_argv[1:], 'argv0': sys.orig_argv[0], 'cwd': os.getcwd(), 'commandLine': ctypes.windll.kernel32.GetCommandLineW()}, f)",
      "os._exit(int(os.environ.get('FAKE_AGENT_EXIT', '0')))",
      ''
    ].join('\n'), 'utf-8')
    const exeScript = buildLaunchScript({ root, agent: 'codex', agentPath: exe, venvBin: null, bundledBin: null, firstPrompt: '', home }, 'win32')
    writeFileSync(argvFile, '{}', 'utf-8')
    expect((await run(exeScript, { PYTHONHOME: dirname(py!), PYTHONPATH: site })).code, 'codex.exe 배치가 실패했다').toBe(0)
    // 정확 일치 조건을 유지한다. 경로 조각을 버리거나 인자 끝부분만 비교하지 않는다.
    expect(recorded().argv, `codex.exe 인자가 다르다: ${recorded().commandLine}`).toEqual(['-c', config])
    expect(realpathSync.native(recorded().argv0!), '공백 경로 전체가 argv[0]이어야 한다').toBe(realpathSync.native(exe))
    expect(realpathSync.native(recorded().cwd), '한글·공백 작업 폴더로 이동하지 않았다').toBe(realpathSync.native(root))

    // 전역 스킬 사본이 없어 -c를 생략하는 기본 실행도 경로 조각이 인자로 끼지 않아야 한다.
    const noConfig = buildLaunchScript({ root, agent: 'codex', agentPath: exe, venvBin: null, bundledBin: null, firstPrompt: '', home: join(base, 'no-skills') }, 'win32')
    const noConfigResult = await run(noConfig, { PYTHONHOME: dirname(py!), PYTHONPATH: site })
    expect(noConfigResult.code, noConfigResult.stdout).toBe(0)
    expect(recorded().argv, recorded().commandLine).toEqual([])
    expect(realpathSync.native(recorded().argv0!)).toBe(realpathSync.native(exe))

    // 실패 시 원래 종료 코드와 안내가 남는다. shim은 직접 실행하면 부모로 돌아오지 않는다.
    writeFileSync(agentPath, '@echo off\r\nexit /b 7\r\n', 'utf-8')
    const shimFailure = await run(codex)
    expect(shimFailure.code, shimFailure.stdout).toBe(7)
    expect(shimFailure.stdout).toContain('종료 코드: 7')
    const exeFailure = await run(exeScript, { PYTHONHOME: dirname(py!), PYTHONPATH: site, FAKE_AGENT_EXIT: '9' })
    expect(exeFailure.code, exeFailure.stdout).toBe(9)
    expect(exeFailure.stdout).toContain('종료 코드: 9')
    const missingRoot = buildLaunchScript({ root: join(base, '없는 폴더'), agent: 'codex', agentPath: exe, venvBin: null, bundledBin: null, firstPrompt: '' }, 'win32')
    const cdFailure = await run(missingRoot)
    expect(cdFailure.code, cdFailure.stdout).toBe(1)
    expect(cdFailure.stdout).toContain('종료 코드: 1')
  })

  /**
   * 검토 I-01(실행) — 생성한 `.command` 를 **실제로 돌려** 그 창의 자식이 두 값을 받는지 본다.
   * 문자열 단언은 `export` 위치·순서가 틀려도 통과한다 — 자식의 환경을 직접 읽어야 잠긴다.
   *
   * 가짜 CLI 는 인자를 무시하고 받은 환경과 작업 폴더를 찍는다. **부모에는 반대 값**을 넣어
   * 둔다(`0`/`ascii`) — 스크립트의 export 가 이기지 못하면 그대로 새어 나와 시험이 실패한다.
   */
  test('posix 런치 스크립트로 띄운 자식이 PYTHONUTF8·PYTHONIOENCODING 을 받는다 (I-01, 실행)', async () => {
    // 윈도에는 `bash` 가 없고(있어도 Git Bash 의 `/c/...` 경로는 `realpathSync` 비교와 안 맞는다)
    // 생성 경로도 `C:\...` 다 — 아래 `.cmd` 시험이 윈도 몫을 맡는다.
    test.skip(process.platform === 'win32', 'POSIX 실행 시험은 윈도에서 제외 — 윈도는 아래 .cmd 시험이 맡음')
    const base = mkdtempSync(join(tmpdir(), 'kd-utf8-'))
    const root = join(base, '한글 논문 폴더')
    mkdirSync(root, { recursive: true })
    const agentPath = join(base, 'fake-claude')
    writeFileSync(agentPath, '#!/bin/bash\nprintf \'UTF8=%s IO=%s PWD=%s\\n\' "$PYTHONUTF8" "$PYTHONIOENCODING" "$PWD"\n', 'utf-8')
    chmodSync(agentPath, 0o755)
    const scriptPath = join(base, 'launch.command')
    writeFileSync(scriptPath, buildLaunchScript({
      root, agent: 'claude', agentPath, venvBin: null, bundledBin: null, firstPrompt: '시작하기'
    }, 'darwin'), { encoding: 'utf-8', mode: 0o755 })

    const result = await new Promise<{ code: number | null, stdout: string }>((ok, fail) => {
      const child = spawn('bash', [scriptPath], {
        env: { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'ascii' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      child.stdout.setEncoding('utf-8').on('data', (s: string) => { stdout += s })
      child.stderr.setEncoding('utf-8').on('data', (s: string) => { stdout += s })
      child.on('error', fail).on('close', (code) => ok({ code, stdout }))
    })
    expect(result.code, result.stdout).toBe(0)
    const line = result.stdout.split('\n').find((l) => l.includes('UTF8='))
    expect(line, `가짜 CLI 가 뜨지 않았다: ${result.stdout}`).toBeTruthy()
    // 두 값이 자식까지 갔는지 — 부모의 `0`/`ascii` 가 남아 있으면 여기서 걸린다.
    expect(line!.startsWith('UTF8=1 IO=utf-8 ')).toBe(true)
    // 그 자식이 정말 그 창(작업 폴더)에서 떴는지 — `exec` 은 셸을 대체하므로 cwd 가 유지된다.
    const pwd = line!.split('PWD=')[1]
    expect(realpathSync.native(pwd), '작업 폴더로 이동한 뒤 실행되지 않았다').toBe(realpathSync.native(root))
  })

  /**
   * 검토 I-01(실행) — 윈도우 `.cmd` 판. 배치의 `set` 은 `setlocal` 범위 안에서만 유효하고,
   * 실행 줄이 `call` 없이 자식 cmd 로 넘어가므로 **실제로 돌려야** 상속이 확인된다.
   * 윈도우에서만 뜻이 있다(다른 OS 는 `cmd.exe` 가 없다) — CI `windows-latest` 가 돈다.
   */
  test('win32 런치 배치로 띄운 자식이 PYTHONUTF8·PYTHONIOENCODING 을 받는다 (I-01, 실행)', async () => {
    test.skip(process.platform !== 'win32', 'cmd 배치 실행은 윈도우에서만 확인한다 — CI windows-latest 가 돈다')
    const base = mkdtempSync(join(tmpdir(), 'kd-utf8-'))
    const root = join(base, '한글 논문 폴더')
    const agentDir = join(base, 'Program Files', 'npm')
    mkdirSync(root, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    const agentPath = join(agentDir, 'claude.cmd')
    const outFile = join(base, 'env.txt')
    // npm shim 과 같은 모양(`@echo off` + `exit /b`)이되, 받은 두 값만 남긴다.
    writeFileSync(agentPath, [
      '@echo off',
      '> "%UTF8_OUT%" echo %PYTHONUTF8% %PYTHONIOENCODING%',
      'exit /b 0',
      ''
    ].join('\r\n'), 'utf-8')
    const scriptPath = join(base, 'launch.cmd')
    writeFileSync(scriptPath, buildLaunchScript({
      root, agent: 'claude', agentPath, venvBin: null, bundledBin: null, firstPrompt: '시작하기'
    }, 'win32'), 'utf-8')

    const result = await new Promise<{ code: number | null, stdout: string }>((ok, fail) => {
      const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', scriptPath], {
        // 부모에는 반대값 — 배치의 `set` 이 이기지 못하면 그대로 새어 나온다.
        env: { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'ascii', UTF8_OUT: outFile },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      child.stdout.setEncoding('utf-8').on('data', (s: string) => { stdout += s })
      child.stderr.setEncoding('utf-8').on('data', (s: string) => { stdout += s })
      child.on('error', fail).on('close', (code) => ok({ code, stdout }))
    })
    expect(result.code, result.stdout).toBe(0)
    expect(existsSync(outFile), `가짜 CLI 가 뜨지 않았다: ${result.stdout}`).toBe(true)
    expect(readFileSync(outFile, 'utf-8').trim(), '자식이 두 값을 받지 못했다').toBe('1 utf-8')
  })

  test('codex gets no positional prompt and no -c without a global skill copy; sq escapes single quotes', () => {
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/homebrew/bin/codex', venvBin: null, bundledBin: null, firstPrompt: '시작하기' }, 'darwin')
    expect(s.trimEnd().split('\n').pop()).toBe(`exec '/opt/homebrew/bin/codex'`)
    expect(s).not.toContain('skills.config')
    expect(s).not.toContain("'시작하기'")
    expect(sq(`it's`)).toBe(`'it'\\''s'`)
    expect(firstPromptFor(0)).toBe('시작하기')
    expect(firstPromptFor(null)).toBe('시작하기')
    expect(firstPromptFor(3)).toBe('이어서 하기')
  })
  /**
   * 1층 잠금(설계 §4.1-C) — 열거에서 "끌 수 있다"로 판정한 이름만 `-c …=false` 로 붙는다.
   * 스크립트 생성 시점의 인자 고정이 곧 잠금이다: 학생이 그 뒤 설정을 바꿔도 이 프로세스는
   * 따라가지 않는다(설계가 인정한 한계).
   */
  test('터미널 Codex 잠금 인자가 exec 줄에 그대로 실린다 — POSIX', () => {
    const lockArgs = ['-c', 'mcp_servers.x.enabled=false', '-c', 'project_doc_max_bytes=0', '-c', 'features.apps=false']
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/codex', venvBin: null, bundledBin: null, firstPrompt: '', lockArgs }, 'darwin')
    expect(s.trimEnd().split('\n').pop()).toBe(
      `exec '/opt/codex' '-c' 'mcp_servers.x.enabled=false' '-c' 'project_doc_max_bytes=0' '-c' 'features.apps=false'`
    )
  })

  test('잠금 인자는 전역 스킬 사본 끄기보다 앞에 온다 — 그 토큰이 계속 마지막이다', () => {
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    const lockArgs = ['-c', 'features.apps=false', '-c', 'project_doc_max_bytes=0']
    const line = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/codex', venvBin: null, bundledBin: null, firstPrompt: '', home, lockArgs }, 'darwin')
      .trimEnd().split('\n').pop()!
    expect(line).toContain(`'-c' 'features.apps=false'`)
    expect(line.indexOf('features.apps=false')).toBeLessThan(line.indexOf('skills.config'))
    expect(line.startsWith(`exec '/opt/codex' '-c' 'features.apps=false' '-c' 'project_doc_max_bytes=0' -c 'skills.config=`)).toBe(true)
  })

  test('win32 배치에도 잠금 인자가 실린다 — .exe 는 한 층, npm shim 은 두 층', () => {
    const lockArgs = ['-c', 'mcp_servers.x.enabled=false', '-c', 'project_doc_max_bytes=0', '-c', 'features.apps=false']
    const base = { root: 'C:\\Users\\이뚠냥\\Downloads\\QA 한글 시험', agent: 'codex' as const, venvBin: null, bundledBin: null, firstPrompt: '', lockArgs }
    const exeLine = buildLaunchScript({ ...base, agentPath: 'C:\\Program Files\\knuaf\\resources\\codex\\codex.exe' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.exe'))!
    const shimLine = buildLaunchScript({ ...base, agentPath: 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd' }, 'win32')
      .split('\r\n').find((l) => l.includes('codex.cmd'))!
    // 실행물 경로는 그대로, 인자만 잠금 토큰으로 이어진다.
    expect(exeLine.startsWith('"C:\\Program Files\\knuaf\\resources\\codex\\codex.exe" ^"-c^" ^"mcp_servers.x.enabled=false^"')).toBe(true)
    expect(exeLine).toContain('^"project_doc_max_bytes=0^"')
    expect(exeLine).toContain('^"features.apps=false^"')
    expect(exeLine).not.toContain('^^')
    expect(shimLine).toContain('^^^"mcp_servers.x.enabled=false^^^"')
    expect(shimLine).toContain('^^^"features.apps=false^^^"')
  })

  test('the first work-folder prompt allows skill folders but forbids nested paper-work folders', () => {
    const prompt = firstPromptFor(0, '/tmp/논문')
    expect(prompt).toContain('작업 폴더: /tmp/논문')
    expect(prompt).toContain('논문 작업 파일은 여기서 바로 다루세요.')
    expect(prompt).toContain('논문 작업용 하위 폴더(예: knuaf-work)를 새로 만들어 그 안에서 작업하지 마세요.')
    expect(prompt).toContain('스킬 스크립트(gg.py·gg_deps.py 등)가 정해진 자리에 스스로 만드는 폴더(.venv, sources/extracts 등)는 그대로 두어도 됩니다.')
    expect(prompt).not.toContain('`.venv` 외의 하위 폴더')
    expect(prompt).not.toContain('DOCX')
  })

  test('a stale global knuaf-dev copy is disabled for the external codex launch', () => {
    // ~/.codex/skills·~/.agents/skills 의 낡은 사본이 프로젝트 사본과 함께 enabled 로
    // 보이면 모델이 옛 지침을 따른다 — 비상구 터미널에서도 그 사본을 끈다.
    const home = mkdtempSync(join(tmpdir(), 'kd-home-'))
    expect(codexSkillConfigOverride(home)).toBeNull()
    mkdirSync(join(home, '.codex', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    const cfg = codexSkillConfigOverride(home)
    // 제품은 TOML 문자열용으로 역슬래시를 두 번 쓴다 — 윈도우 경로 그대로 견주면 어긋나므로
    // 기대값에도 같은 이스케이프를 적용한다(맥에서는 역슬래시가 없어 종전과 같은 문자열).
    const esc = (p: string): string => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    expect(cfg).toBe(`skills.config=[{path="${esc(join(home, '.codex', 'skills', 'knuaf-dev', 'SKILL.md'))}",enabled=false}]`)
    const s = buildLaunchScript({ root: '/x', agent: 'codex', agentPath: '/opt/codex', venvBin: null, bundledBin: null, firstPrompt: '', home }, 'darwin')
    expect(s).toContain(`-c '${cfg}'`)

    // app-server 스폰에도 같은 오버라이드 — -c 는 subcommand 앞의 루트 인자다.
    expect(serverArgsFor({ HOME: home })).toEqual(['-c', cfg, '-c', 'project_doc_max_bytes=0', 'app-server'])
    // 폴더 `AGENTS.md` 차단은 전역 사본 유무와 무관하게 늘 붙는다(설계 §4.1-E).
    expect(serverArgsFor({ HOME: join(mkdtempSync(join(tmpdir(), 'kd-home-')), 'none') })).toEqual(['-c', 'project_doc_max_bytes=0', 'app-server'])
    // ~/.agents/skills 도 스캔 대상 — 두 사본이 함께 있으면 둘 다 끈다.
    mkdirSync(join(home, '.agents', 'skills', 'knuaf-dev'), { recursive: true })
    writeFileSync(join(home, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'), '# old\n')
    expect(serverArgsFor({ HOME: home })[1]).toContain('.agents')
  })
})

test.describe('launch', () => {
  test('dryRun writes an executable launch script and never calls open', async () => {
    const supportDir = join(mkdtempSync(join(tmpdir(), 'kd-support-')), 'nested')
    let opened = 0
    const r = await launch({
      root: '/tmp/p', agent: 'claude', agentPath: '/opt/homebrew/bin/claude', venvBin: null, bundledBin: null,
      firstPrompt: '시작하기', supportDir, dryRun: true
    }, { open: async () => { opened++; return '' } })
    expect(r.scriptPath.startsWith(supportDir)).toBe(true)
    const win = process.platform === 'win32'
    expect(r.scriptPath).toMatch(win ? /launch-[0-9a-f]{8}\.cmd$/ : /launch-[0-9a-f]{8}\.command$/)
    const body = readFileSync(r.scriptPath, 'utf-8')
    if (win) {
      // 윈도우에는 POSIX 실행 비트가 없다 — 실행물을 정하는 것은 확장자다(위 단언).
      expect(body).toContain('"--setting-sources="')
      expect(body).toContain('"--strict-mcp-config"')
    } else {
      expect(statSync(r.scriptPath).mode & 0o111).toBeTruthy()
      expect(body).toContain(`exec '/opt/homebrew/bin/claude' --setting-sources= --strict-mcp-config '--disallowedTools=AskUserQuestion' '시작하기'`)
    }
    expect(opened).toBe(0)
  })

  test('calls open when not dryRun and surfaces its error', async () => {
    const supportDir = mkdtempSync(join(tmpdir(), 'kd-support-'))
    const calls: string[] = []
    const r = await launch({ root: '/tmp/p', agent: 'codex', agentPath: '/x/codex', venvBin: null, bundledBin: null, firstPrompt: '', supportDir }, { open: async (p) => { calls.push(p); return '' } })
    expect(calls).toEqual([r.scriptPath])
    await expect(launch({ root: '/tmp/p', agent: 'codex', agentPath: '/x/codex', venvBin: null, bundledBin: null, firstPrompt: '', supportDir }, { open: async () => 'no app' })).rejects.toThrow('no app')
  })
})

test.describe('agentApi', () => {
  test('status + installSkill + launch compose against a tmp ctx', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kd-ctx-'))
    const opened: string[] = []
    const ctx = {
      home, appRoot, isPackaged: false, resourcesPath: '/nonexistent', supportDir: join(home, 'support'),
      userData: join(home, 'user-data'), dryRun: true,
      open: async (p: string) => { opened.push(p); return '' },
      venvPython: (root: string | null) => (root ? join(root, '.venv', 'bin', 'python3') : null),
      env: process.env
    }
    const root = mkdtempSync(join(tmpdir(), 'kd-root-'))
    // no project open: skill state reports missing for both agents
    expect((await agentApi.status(ctx, null)).skill).toEqual({ claude: 'missing', codex: 'missing' })
    const st = await agentApi.status(ctx, root)
    // Whether claude is installed is a property of the machine, not of agentApi.
    expect(st.claude).toMatchObject({ found: claudePath !== null, path: claudePath })
    if (claudePath) expect(typeof st.claude.version).toBe('string')
    expect(st.skill).toEqual({ claude: 'missing', codex: 'missing' })
    expect(st.skillVersion).toBe(skillVersion(source))

    expect(agentApi.installSkill(ctx, 'codex', root)).toEqual({ action: 'installed' })
    expect(existsSync(join(root, '.agents', 'skills', 'knuaf-dev', 'SKILL.md'))).toBe(true)
    expect((await agentApi.status(ctx, root)).skill).toEqual({ claude: 'missing', codex: 'installed' })

    // launch resolves the real binary, so it only runs where claude is installed.
    // 같은 조건에서 **윈도우도** API 를 부른다 — 실행물 모양만 플랫폼별로 다르게 단언한다
    // (W1C-R1-03: 이 검사를 조건문으로 빼면 Windows 보증이 조용히 사라진다).
    if (claudePath) {
      const r = await agentApi.launch(ctx, { root: '/tmp/논문 폴더', kind: 'claude', revision: 2 })
      const script = readFileSync(r.scriptPath, 'utf-8')
      expect(opened, 'dry-run 인데 open 을 불렀다').toEqual([])
      if (process.platform === 'win32') {
        // 윈도우: 실행물은 `.cmd` 배치이고, 같은 ctx 조합(venv·프롬프트)이 그 안에 실린다.
        expect(r.scriptPath).toMatch(/launch-[0-9a-f]{8}\.cmd$/)
        expect(script).toContain('@echo off')
        for (const flag of ['--setting-sources=', '--strict-mcp-config', '--disallowedTools=AskUserQuestion']) expect(script).toContain(flag)
        // 앱 스킬 자리는 윈도우에서도 `/` 로 인용된다 — 스킬 자리 판정이 `\` 를 거부한다.
        expect(script).toContain(join(ctx.userData, 'skill-host', '.claude').replace(/\\/g, '/'))
        expect(script).toContain('/tmp/논문')          // 첫 프롬프트의 작업 폴더
        expect(script).toContain('.venv')              // ctx 가 준 venv 자리
      } else {
        expect(script).toContain(`cd '/tmp/논문 폴더' || exit 1`)
        expect(script).toContain(`export PATH='/tmp/논문 폴더/.venv/bin':`)
        expect(script).toContain(`exec '${claudePath}' --setting-sources= --strict-mcp-config --plugin-dir-no-mcp '${join(ctx.userData, 'skill-host', '.claude')}' '--disallowedTools=AskUserQuestion' '이어서 하기`)
        expect(script).toContain(`작업 폴더: /tmp/논문 폴더`)
      }
    }
  })

  /**
   * 1층 잠금(설계 §4.1-C) — 터미널 Codex 는 **열거에서 남은 것이 0개일 때만** 연다.
   * 앱 연결이 없어도 되도록 `agentApi.launch` 가 짧게 `codex app-server` 를 띄워 열거한다.
   */
  function gateCtx(base: string, opened: string[], env: Record<string, string>) {
    // 열거용 app-server 는 **논문 폴더를 cwd 로** 띄운다 — 그 폴더가 없으면 spawn 이 ENOENT 로
    // 죽어 열거 실패로 보인다(실제 앱에서는 폴더가 열려 있으므로 늘 존재한다).
    return {
      home: join(base, 'home'),
      appRoot,
      isPackaged: false,
      resourcesPath: '/nonexistent',
      supportDir: join(base, 'support'),
      userData: join(base, 'user-data'),
      dryRun: true,
      open: async (p: string) => { opened.push(p); return '' },
      venvPython: () => null,
      env
    }
  }

  /** 열린 논문 폴더 — 열거용 app-server 의 cwd 이므로 실제로 있어야 한다. */
  function gateRoot(base: string): string {
    const root = join(base, '논문')
    mkdirSync(root, { recursive: true })
    return root
  }

  function readLog(path: string): { method: string }[] {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string })
  }

  test('codex 터미널 — 끌 수 있는 외부 도구는 -c 로 끄고, 남은 것이 0개일 때만 스크립트를 쓴다', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-gate-'))
    const binDir = join(base, 'bin')
    const log = join(base, 'req.log')
    const opened: string[] = []
    const env = {
      ...fakeCodexEnv(binDir, {
        FAKE_CODEX_REQUEST_LOG: log,
        FAKE_CODEX_CONFIG_READ: JSON.stringify({
          config: { mcp_servers: { ext: { command: 'ext-server' } }, plugins: {} },
          layers: [{ name: { type: 'user' }, config: { mcp_servers: { ext: { command: 'ext-server' } } } }]
        })
      }),
      HOME: join(base, 'home')
    }
    const ctx = gateCtx(base, opened, env)
    const r = await agentApi.launch(ctx, { root: gateRoot(base), kind: 'codex', revision: null })
    const script = readFileSync(r.scriptPath, 'utf-8')
    expect(r.scriptPath.startsWith(ctx.supportDir)).toBe(true)
    expect(opened, 'dry-run 인데 open 을 불렀다').toEqual([])
    if (process.platform === 'win32') {
      expect(script).toContain('^"mcp_servers.ext.enabled=false^"')
    } else {
      expect(script).toContain(`'-c' 'mcp_servers.ext.enabled=false'`)
    }
    expect(script).toContain('project_doc_max_bytes=0')
    expect(script).toContain('features.apps=false')
    // Apps 는 언제나 마지막이다 — 앞의 이름 잠금과 섞이지 않는다.
    expect(script.indexOf('features.apps=false')).toBeGreaterThan(script.indexOf('mcp_servers.ext.enabled=false'))
    // 열거는 앱 연결이 아니라 **이 호출이 띄운** 서버로 했다(설계 §4.1-C 1번).
    const methods = readLog(log).map((e) => e.method)
    expect(methods).toContain('config/read')
    expect(methods).toContain('plugin/installed')
  })

  test('codex 터미널 — 설정을 읽지 못하면 열지 않는다', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-gate-'))
    const log = join(base, 'req.log')
    const opened: string[] = []
    const env = {
      ...fakeCodexEnv(join(base, 'bin'), {
        FAKE_CODEX_REQUEST_LOG: log,
        FAKE_CODEX_CONFIG_READ: JSON.stringify({ fail: true })
      }),
      HOME: join(base, 'home')
    }
    const ctx = gateCtx(base, opened, env)
    await expect(agentApi.launch(ctx, { root: gateRoot(base), kind: 'codex', revision: null }))
      .rejects.toMatchObject({ code: 'agent_tool_lock', message: TERMINAL_ENUM_FAILED_COPY })
    expect(opened).toEqual([])
    const wrote = existsSync(ctx.supportDir) ? readdirSync(ctx.supportDir).filter((f) => f.startsWith('launch-')) : []
    expect(wrote, '거부했는데 실행 스크립트를 썼다').toEqual([])
  })

  test('codex 터미널 — 앱이 끌 수 없는 도구가 켜져 있으면 이유를 적어 거부한다', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kd-gate-'))
    const opened: string[] = []
    const env = {
      ...fakeCodexEnv(join(base, 'bin'), {
        FAKE_CODEX_CONFIG_READ: JSON.stringify({
          config: { mcp_servers: { web: { url: 'https://example.invalid/mcp' } }, plugins: {} },
          layers: [{ name: { type: 'user' }, config: { mcp_servers: { web: { url: 'https://example.invalid/mcp' } } } }]
        })
      }),
      HOME: join(base, 'home')
    }
    const ctx = gateCtx(base, opened, env)
    const error = await agentApi.launch(ctx, { root: gateRoot(base), kind: 'codex', revision: null }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string }
    )
    expect(error?.code).toBe('agent_tool_lock')
    expect(error?.message?.startsWith(TERMINAL_REFUSAL_HEAD)).toBe(true)
    expect(error?.message).toContain('**web**')
    expect(opened).toEqual([])
    const wrote = existsSync(ctx.supportDir) ? readdirSync(ctx.supportDir).filter((f) => f.startsWith('launch-')) : []
    expect(wrote, '거부했는데 실행 스크립트를 썼다').toEqual([])
  })
})
