// 무료 중계(DS·GLM) 출입증 — **주입 경계**만 잠근다. 실제 AI 호출 0회, Electron·창 없이 Node 로만 돈다.
//
// 왜 이 파일이 있나: 출입증 값은 저장소가 공개라 소스에 없고 **릴리스 빌드의 define** 으로만 메인
// 묶음에 들어간다(`app/src/main/free/token.ts`). 그 성질은 눈으로 코드를 읽어서는 안 지켜진다 —
// define 을 한 줄 잘못 옮기면(예: 최상위 `define`) 값이 화면 번들로 새는데, 로컬·PR 빌드는 값이
// 비어 있어 **아무도 못 알아챈다**. 그래서 (1) 형식, (2) define 이 메인에만 있는지, (3) 빌드 산출물에
// 식별자·값이 남았는지, (4) 학생 본인 CLI 환경에 새지 않는지, (5) 릴리스 워크플로가 값을 넘기고
// 산출물을 실제로 검사하는지를 여기서 잰다. 값이 무엇인지는 어디에서도 단언하지 않는다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { freeRelayToken, freeRelayTokenDefine, freeTokenOf } from '../src/main/free/token'
import { FREE_RELAY_URL, freeRelayError } from '../src/main/free/provider'
import { FREE_DS_MODEL, FREE_GLM_MODEL, LANE_TABLE, resolveLanes } from '../src/shared/lanes'
import { serverArgsFor } from '../src/main/chat/codex'
import { subscriptionEnv } from '../src/main/chat/contracts'
import { recommendedRow } from '../src/main/lanes/source'

/** `e2e` 스펙은 `app/` 에서 돈다(`playwright.config.ts` 의 testDir). 다른 스펙과 같이 위치 기준. */
const appRoot = resolve(__dirname, '..')
const repoRoot = resolve(appRoot, '..')

/** 모양만 맞는 가짜 출입증. 실제 값이 아니다 — 중계는 이 값을 절대 받지 않는다. */
const FAKE_TOKEN = `kf1_${'A'.repeat(43)}`

const nodeRequire = createRequire(join(appRoot, 'package.json'))

/**
 * `electron.vite.config.ts` 를 **실제로 평가**한다. 파일을 글자로 훑지 않는 이유: 주석·문자열·
 * 다른 define 에 같은 글자가 있어도 통과해 버리기 때문. 대신 `electron-vite`·`@vitejs/plugin-react`
 * 만 최소 셈(shim)으로 바꿔 끼운다 — 설정이 내보내는 객체는 진짜다(`defineConfig` 는 항등함수).
 */
function loadConfig(): Record<string, any> {
  return loadTsModule(join(appRoot, 'electron.vite.config.ts'), {
    'electron-vite': { defineConfig: (config: unknown) => config },
    '@vitejs/plugin-react': { default: () => [] }
  }).default as Record<string, any>
}

/**
 * TS 파일 하나를 CommonJS 로 바꿔 그 자리에서 평가한다. 끼워 넣을 셈(`shims`)은 밖에서 준다 —
 * 설정 파일 말고도 `electron` 에 기대는 메인 모듈(`settings.ts`)을 같은 방식으로 평가하려고
 * 일반화했다. 셈을 안 주면 `require` 는 진짜 Node 해석을 쓴다(상대 경로만 TS 를 이어 읽는다).
 */
function loadTsModule(
  entry: string,
  shims: Record<string, unknown> = {},
  globals: Record<string, unknown> = {}
): Record<string, any> {
  const load = (file: string): Record<string, unknown> => {
    const module = { exports: {} as Record<string, unknown> }
    const code = transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
    runInNewContext(code, {
      module,
      exports: module.exports,
      __dirname: dirname(file),
      __filename: file,
      process,
      console,
      // define 이 넣는 전역(예: `__KNUAF_FREE_TOKEN__`)을 흉내 내는 자리. 번들에서 define 은
      // 식별자를 리터럴로 바꾸지만, 여기서는 전역 바인딩이 같은 역할을 한다.
      ...globals,
      require: (name: string) => {
        if (name in shims) return shims[name]
        if (!name.startsWith('.')) return nodeRequire(name)
        const target = resolve(dirname(file), name)
        return load(existsSync(`${target}.ts`) ? `${target}.ts` : target)
      }
    })
    return module.exports
  }
  return load(entry)
}

/** 디렉터리 아래 모든 파일(없으면 빈 배열). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

test('출입증 형식: `kf1_` + base64url 43자만 받고 나머지는 null', () => {
  const body = 'A1b2C3d4E5f6G7h8I9j0K_l-mNOPQRSTUVWXYZabcde'
  expect(body).toHaveLength(43)
  expect(freeTokenOf(`kf1_${body}`)).toBe(`kf1_${body}`)
  // 끝 개행·앞뒤 공백은 지운다 — CLI 로 시크릿을 넣으면 딸려 오는 일이 흔하고, 그것 하나로
  // 무료 회사가 통째로 막히면 원인이 화면에도 로그에도 안 보인다.
  expect(freeTokenOf(`\n  kf1_${body}  \r\n`)).toBe(`kf1_${body}`)

  for (const bad of [
    undefined, null, 0, {}, [],
    '', ' ', 'kf1_', `kf1_${body.slice(0, 42)}`, `kf1_${body}x`, // 길이
    `KF1_${body}`, `kf2_${body}`, `kf1${body}`, // 접두
    `kf1_${body.slice(0, 42)}!`, `kf1_${body.slice(0, 42)}+`, `kf1_${body.slice(0, 42)}/`, // base64url 밖 문자
    `kf1_${body.slice(0, 42)} ` // 안쪽 공백(trim 은 앞뒤만)
  ]) {
    expect(freeTokenOf(bad), JSON.stringify(bad)).toBeNull()
  }
})

test('define 이 없는 실행에서 freeRelayToken() 은 null — bare 참조로 죽지 않는다', () => {
  // 이 프로세스는 define 없이 TS 를 그대로 돌린다(=단위 시험·개발 스크립트와 같은 조건).
  // `declare const` 를 그냥 읽으면 ReferenceError 다 — 그 회귀를 여기서 잠근다.
  expect(freeRelayToken()).toBeNull()
})

test('define 문자열은 형식 검사를 통과한 값만 싣고, 틀린 값은 빈 문자열로 접힌다', () => {
  expect(freeRelayTokenDefine({})).toBe('""')
  expect(freeRelayTokenDefine({ KNUAF_FREE_RELAY_TOKEN: '' })).toBe('""')
  expect(freeRelayTokenDefine({ KNUAF_FREE_RELAY_TOKEN: 'kf1_short' })).toBe('""')
  expect(freeRelayTokenDefine({ KNUAF_FREE_RELAY_TOKEN: `${FAKE_TOKEN}extra` })).toBe('""')
  // 맞는 값은 JS 문자열 리터럴로(=define 이 그대로 삼킬 수 있는 모양) 들어간다.
  expect(freeRelayTokenDefine({ KNUAF_FREE_RELAY_TOKEN: FAKE_TOKEN })).toBe(JSON.stringify(FAKE_TOKEN))
  expect(freeRelayTokenDefine({ KNUAF_FREE_RELAY_TOKEN: `  ${FAKE_TOKEN}\n` })).toBe(JSON.stringify(FAKE_TOKEN))
})

test('주입은 메인 define 하나뿐 — 화면·preload 쪽에는 키도 값도 없다', () => {
  const config = loadConfig()
  // 이 시험이 공허하지 않다는 증거: 메인 define 은 실제로 평가됐다(빌드 날짜 define 이 살아 있다).
  expect(typeof config.main?.define?.__APP_BUILD_DATE__).toBe('string')
  // 값은 지금 빌드의 환경값에서 나온다 — 설정이 값을 따로 하드코딩하지 않는다.
  expect(config.main.define.__KNUAF_FREE_TOKEN__).toBe(freeRelayTokenDefine())
  expect(JSON.parse(config.main.define.__KNUAF_FREE_TOKEN__)).toBe(freeTokenOf(process.env.KNUAF_FREE_RELAY_TOKEN) ?? '')

  for (const side of ['renderer', 'preload'] as const) {
    expect(Object.keys(config[side]?.define ?? {}), side).not.toContain('__KNUAF_FREE_TOKEN__')
    // 키 이름을 define 바깥(플러그인·다른 설정)으로 돌려 넣는 길까지 막는다.
    expect(JSON.stringify(config[side] ?? {}), side).not.toContain('KNUAF_FREE_TOKEN')
  }
})

test('빌드 산출물: 화면 번들에 출입증도 define 식별자도 없고, 메인의 식별자는 define 으로 접혔다', () => {
  const rendererDir = join(appRoot, 'out/renderer')
  const preloadDir = join(appRoot, 'out/preload')
  const mainFile = join(appRoot, 'out/main/index.js')
  expect(existsSync(mainFile), 'out/main/index.js 가 없다 — `pnpm build` 뒤에 돈다').toBe(true)
  expect(existsSync(join(rendererDir, 'index.html')), 'out/renderer 가 없다 — `pnpm build` 뒤에 돈다').toBe(true)

  const tokenShape = /kf1_[A-Za-z0-9_-]{43}/
  for (const file of [...filesUnder(rendererDir), ...filesUnder(preloadDir)]) {
    const text = readFileSync(file, 'utf8')
    // 화면 번들에 값이 있으면 학생이 개발자도구·파일로 출입증을 꺼낼 수 있다.
    expect(text, file).not.toMatch(tokenShape)
    // 식별자가 남아 있다는 것은 define 이 화면 쪽에 적용됐다는 뜻 — 그것도 유출 경로다.
    expect(text, file).not.toContain('__KNUAF_FREE_TOKEN__')
  }
  // 메인은 반대다: 식별자가 **남아 있으면** define 이 안 먹은 것이다(값이 없어도 치환은 된다).
  expect(readFileSync(mainFile, 'utf8')).not.toContain('__KNUAF_FREE_TOKEN__')
})

test('define 식별자를 읽는 곳은 token.ts 한 곳 — 다른 메인 모듈·화면·preload 는 값을 직접 보지 않는다', () => {
  // 주입 구멍이 하나면 유출도 한 곳만 막으면 된다. define 을 두 번째 파일에서 직접 읽기 시작하면
  // (예: 화면 쪽 상태를 만들려고, preload 에 넘기려고) 그 순간 경계가 둘이 되고 화면 묶음 유출이
  // 가능해진다. 부르는 쪽은 `freeRelayToken()` 을 쓴다 — 값이 아니라 '쓸 수 있는가'를 받는다.
  const tokenFile = join(appRoot, 'src', 'main', 'free', 'token.ts')
  const offenders: string[] = []
  for (const dir of ['src/main', 'src/preload', 'src/renderer']) {
    for (const file of filesUnder(join(appRoot, dir))) {
      if (file === tokenFile) continue
      if (readFileSync(file, 'utf8').includes('__KNUAF_FREE_TOKEN__')) offenders.push(file)
    }
  }
  expect(offenders, 'define 식별자는 `src/main/free/token.ts` 에서만 읽는다').toEqual([])

  // 같은 이유로 화면(preload 포함) 쪽 번들은 token 모듈을 가져오지 않는다.
  const imported = [...filesUnder(join(appRoot, 'src/renderer')), ...filesUnder(join(appRoot, 'src/preload'))].filter(
    (file) => /free\/token/.test(readFileSync(file, 'utf8'))
  )
  expect(imported, '화면·preload 번들은 무료 중계 출입증 모듈을 모른다').toEqual([])
})

/** `release.yml` 에서 `- name: <이름>` 한 단계의 본문 줄들(다음 단계 전까지). */
function stepBlocks(yaml: string, name: string): string[][] {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[][] = []
  const header = new RegExp(`^\\s*- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue
    const indent = lines[i].indexOf('-')
    const block = [lines[i]]
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      const isStep = /^\s*- /.test(line) && line.indexOf('-') <= indent
      if (isStep) break
      block.push(line)
    }
    blocks.push(block)
  }
  return blocks
}

test('릴리스 워크플로: 두 설치본 빌드가 출입증을 받고, 만든 산출물에서 유출을 실제로 검사한다', () => {
  // 이 시험만 글자를 본다 — 워크플로 배선은 YAML 문자열이 유일한 실물이라서다(빌드를 돌려 보는
  // 것은 태그 릴리스에서만 가능하다). 그래서 세 가지만 잰다: 넘기는가, 검사하는가, 패키징 뒤를 보는가.
  const yaml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

  const crlfYaml = yaml.replace(/\r?\n/g, '\r\n')
  expect(stepBlocks(crlfYaml, '설치본 빌드'), 'CRLF 워크플로에서도 설치본 빌드 두 단계를 찾아야 한다').toHaveLength(2)
  const builds = stepBlocks(yaml, '설치본 빌드')
  expect(builds, '설치본 빌드 단계가 둘(맥·윈도)이어야 한다').toHaveLength(2)
  for (const block of builds) {
    expect(block.join('\n')).toContain('KNUAF_FREE_RELAY_TOKEN: ${{ secrets.KNUAF_FREE_RELAY_TOKEN }}')
  }

  const guards = stepBlocks(yaml, '무료 중계 출입증 주입 확인')
  expect(guards, '맥·윈도 각각 유출 검사 단계가 있어야 한다').toHaveLength(2)
  const joined = guards.map((block) => block.join('\n'))
  // 값이 실제로 묶음에 박혔는지(define 이 먹었는지) + 화면 번들엔 없는지, 둘 다 본다.
  for (const block of joined) {
    expect(block).toMatch(/out[\\/]main[\\/]index\.js/)
    expect(block).toMatch(/out[\\/]renderer/)
    expect(block).toMatch(/out[\\/]preload/)
  }
  // 패키징(app.asar) 뒤를 보는 단계가 최소 하나는 있어야 한다 — out/ 만 보면 electron-builder 가
  // 무엇을 실었는지와 어긋날 수 있다(asar 는 out/ 을 그대로 담지만, 그것을 여기서 잰다).
  expect(joined.some((block) => /app\.asar/.test(block))).toBe(true)
  const macGuard = joined.find((block) => block.includes("node -e 'const fs = require"))
  const windowsGuard = joined.find((block) => block.includes('$bytes.Contains($env:IN_TOKEN)'))
  expect(macGuard).toContain('process.env.IN_TOKEN')
  expect(macGuard).not.toMatch(/grep\s+-[^\n]*\$IN_TOKEN/)
  expect(windowsGuard).toContain('$env:IN_TOKEN')
  expect(windowsGuard).toContain('.Contains(')
  expect(windowsGuard).not.toMatch(/(?:grep|findstr|Select-String)\b[^\n]*\$env:IN_TOKEN/)
})

const freeRelease = loadTsModule(
  join(appRoot, 'src/main/free/provider.ts'),
  {},
  { __KNUAF_FREE_TOKEN__: FAKE_TOKEN }
)

test('[A1/A3] 출입증이 없으면 무료 회사는 "쓸 수 없음"으로 닫히고, 비무료 환경은 오염을 지운다', () => {
  // 주입이 없는 상태(=로컬·PR 빌드)로 평가한다.
  const free = loadTsModule(join(appRoot, 'src/main/free/provider.ts'))
  const status = free.freeStatus()
  expect(status.connected).toBe(false)
  expect(status.errorKind).toBe('free-unavailable')

  // 무료 전송은 조용히 다른 회사로 바뀌지 않는다 — env 를 돌려주지 않고 던진다.
  expect(() => free.providerEnv('free', { HOME: '/x' })).toThrow()
  const account = free.freeExecutionAccount()
  expect(account.connected).toBe(false)
  expect(account.usage).toBe('auth')
  expect(account.account.company).toBe('free')

  // Mixed-case inherited variables must not survive, including on Windows where names are case-insensitive.
  const dirty = {
    HOME: '/x', KNUAF_FREE_TOKEN: FAKE_TOKEN, KNUAF_FREE_RELAY: '1', KNUAF_FREE_RELAY_TOKEN: FAKE_TOKEN,
    knuaf_free_relay_token: FAKE_TOKEN, KnUaF_FrEe_ReLaY_ToKeN: FAKE_TOKEN,
    knuaf_free_token: FAKE_TOKEN, Knuaf_Free_Relay: '1'
  }
  const freeEnvNames = ['KNUAF_FREE_TOKEN', 'KNUAF_FREE_RELAY', 'KNUAF_FREE_RELAY_TOKEN']
  const expectNoFreeEnvNames = (env: NodeJS.ProcessEnv) => {
    for (const key of Object.keys(env)) {
      expect(freeEnvNames, key).not.toContain(key.toUpperCase())
    }
  }
  for (const company of ['codex', 'claude'] as const) {
    const env = freeRelease.providerEnv(company, dirty)
    expectNoFreeEnvNames(env)
    expect(serverArgsFor(env).join(' '), company).not.toContain('knuaf-free')
  }
  // Original source remains untouched.
  expect(dirty.KNUAF_FREE_TOKEN).toBe(FAKE_TOKEN)
  expect(dirty.KNUAF_FREE_RELAY_TOKEN).toBe(FAKE_TOKEN)

  // Subscription env assembly removes all casing variants too — this is the actual launch path.
  const originalEntries = Object.fromEntries(Object.entries(process.env).filter(([key]) => freeEnvNames.includes(key.toUpperCase())))
  for (const key of Object.keys(originalEntries)) delete process.env[key]
  for (const key of freeEnvNames) {
    const variants = Object.keys(dirty).filter((candidate) => candidate.toUpperCase() === key)
    for (const variant of variants) process.env[variant] = dirty[variant as keyof typeof dirty]
  }
  try {
    expectNoFreeEnvNames(subscriptionEnv())
  } finally {
    for (const key of Object.keys(process.env)) {
      if (freeEnvNames.includes(key.toUpperCase())) delete process.env[key]
    }
    for (const [key, value] of Object.entries(originalEntries)) process.env[key] = value
  }
})

test('[A3] 무료 환경은 혼합 표기도 정리하고 정식 대문자 이름만 다시 넣는다', () => {
  const env = freeRelease.providerEnv('free', {
    HOME: '/x', knuaf_free_token: 'old-token', KnUaF_Free_Relay: 'old-marker',
    KnUaF_FrEe_ReLaY_ToKeN: 'old-relay-token'
  })
  expect(env.KNUAF_FREE_TOKEN).toBe(FAKE_TOKEN)
  expect(env.KNUAF_FREE_RELAY).toBe('1')
  expect(Object.keys(env).filter((key) => ['KNUAF_FREE_TOKEN', 'KNUAF_FREE_RELAY', 'KNUAF_FREE_RELAY_TOKEN'].includes(key.toUpperCase())).sort())
    .toEqual(['KNUAF_FREE_RELAY', 'KNUAF_FREE_TOKEN'])
})

test('[A2] 무료 모델은 DS·GLM 둘뿐이고, 기본값은 DS 다', () => {
  const models: { model: string; isDefault: boolean; efforts: unknown[] }[] = freeRelease.FREE_MODELS
  expect(models).toHaveLength(2)
  expect(models[0].model).toBe(FREE_DS_MODEL)
  expect(models[1].model).toBe(FREE_GLM_MODEL)
  expect(FREE_DS_MODEL).toBe('deepseek-v4.1-flash-free')
  expect(FREE_GLM_MODEL).toBe('glm-5.3-flash-free')
  expect(models.filter((entry) => entry.isDefault)).toHaveLength(1)
  expect(models[0].isDefault).toBe(true)
  expect(models[1].isDefault).toBe(false)
  // effort 는 노출하지 않는다(중계가 추론 강도를 받지 않는다).
  for (const entry of models) expect(entry.efforts).toHaveLength(0)
})

test('[A3] 무료 회사 Codex 에만 중계 설정이 붙고, 출입증 값은 argv 로 나가지 않는다', () => {
  const env = freeRelease.providerEnv('free', { HOME: '/x', KNUAF_CODEX_EFFORT: 'high' })
  expect(env.KNUAF_FREE_TOKEN).toBe(FAKE_TOKEN)
  expect(env.KNUAF_FREE_RELAY).toBe('1')
  expect(env.KNUAF_CODEX_MODEL).toBe(FREE_DS_MODEL)
  // 중계는 추론 강도를 받지 않는다 — 남아 있으면 CLI 가 `-c` 로 실어 보낸다.
  expect(Object.keys(env)).not.toContain('KNUAF_CODEX_EFFORT')

  const argv = serverArgsFor(env)
  const joined = argv.join(' ')
  expect(joined).toContain('model_provider="knuaf-free"')
  expect(joined).toContain(`model_providers.knuaf-free.base_url="${FREE_RELAY_URL}"`)
  expect(FREE_RELAY_URL).toBe('https://free.168-107-60-66.sslip.io/v1')
  expect(joined).toContain('model_providers.knuaf-free.name="knuaf-free"')
  expect(joined).toContain('model_providers.knuaf-free.wire_api="responses"')
  expect(joined).toContain('model_providers.knuaf-free.env_key="KNUAF_FREE_TOKEN"')
  // 값은 env 로만 간다 — argv 는 프로세스 목록에 그대로 보인다.
  for (const arg of argv) expect(arg).not.toContain(FAKE_TOKEN)
  expect(joined).not.toContain(FAKE_TOKEN)

  // 표식만 있고 토큰이 없으면 인자도 안 붙고 조용히 지나가지도 않는다.
  expect(() => serverArgsFor({ KNUAF_FREE_RELAY: '1' })).toThrow()
  // 학생 본인 Codex(구독) 에는 같은 값이 있어도 안 붙는다.
  expect(serverArgsFor({ ...env, KNUAF_FREE_RELAY: undefined }).join(' ')).not.toContain('knuaf-free')
})

test('[A8] 중계 오류는 정해진 종류로만 접히고, 본문은 message 에 남지 않는다', () => {
  // 모듈을 vm 에서 평가하면 `instanceof Error` 가 realm 을 넘지 못한다 — 여기서는 실제 모듈을 쓴다.
  const cases: [string, string][] = [
    ['503 {"error":"free_model_off"}', 'free-off'],
    ['429 {"error":"busy"}', 'free-busy'],
    ['429 {"error":"slow_down"}', 'free-minute-limit'],
    ['429 {"error":"daily_limit"}', 'free-daily-limit'],
    ['401 {"error":"invalid_token"}', 'free-auth'],
    ['request failed with status 401', 'free-auth'],
    ['unauthorized: token expired', 'free-auth'],
    ['connection reset', 'free-error']
  ]
  for (const [text, kind] of cases) {
    const error = freeRelayError(new Error(text))
    expect(error.kind, text).toBe(kind)
    // 본문에는 student 마다 다른 것(스레드 id·요청 본문)이 섞일 수 있다 — 화면·기록은 종류만 쓴다.
    expect(error.message).toBe(kind)
  }
})

test('[A6/A7] 무료만 연결이면 차선표가 free-only 로 접히고, 설계는 본대화 회사로 고정된다', () => {
  // 계정 하나(무료)만 연결된 상태. 유료 두 회사 판정이 비면 free-only 가 정답이다.
  expect(recommendedRow({ free: { accountId: 'knuaf-free', connected: true, consented: true, usage: 'unknown',
    account: { company: 'free', models: [] } } })).toBe('free-only')
  expect(recommendedRow({})).toBeNull()

  const row = LANE_TABLE['free-only']
  expect(row.lanes.research.company).toBe('free')
  expect(row.lanes.writing.company).toBe('free')
  expect(row.lanes.repeat.company).toBe('free')
  // 작성과 검토가 같은 모델이면 "작성자≠검토자"가 무너진다.
  expect(row.lanes.review.company).toBe('free')
  expect(row.lanes.review.model).toBe(FREE_GLM_MODEL)
  expect(row.lanes.research.model).toBe(FREE_DS_MODEL)
  expect(row.lanes.review.effort).toBeNull()

  const { plan } = resolveLanes('free-only', { mainCompany: 'free' })
  expect(plan.design).toMatchObject({ company: 'free', how: 'main' })
  expect(plan.review?.how).toBe('relay')
  expect(plan.review?.model).toBe(FREE_GLM_MODEL)
})

test('[A10] 설정: 저장된 선택은 보존하고, 없는 선택을 무료로 승격하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-free-settings-'))
  const settings = loadTsModule(join(appRoot, 'src/main/settings.ts'), {
    electron: { app: { getPath: () => dir } }
  })
  const write = (value: unknown) => writeFileSync(join(dir, 'settings.json'), JSON.stringify(value), 'utf8')

  // 파일이 없으면 선택 없음(null) — 첫 화면을 건너뛰게 만들면 안 된다.
  expect(settings.loadSettings().provider_choice).toBeNull()
  for (const raw of [null, {}, { provider: 'openai' }, { provider: '' }, 'free']) {
    write({ provider_choice: raw })
    expect(settings.loadSettings().provider_choice, JSON.stringify(raw)).toBeNull()
  }
  for (const provider of ['codex', 'claude', 'free']) {
    write({ provider_choice: { provider, at: '2026-11-16T00:00:00.000Z' } })
    expect(settings.loadSettings().provider_choice).toMatchObject({ provider })
  }
  // `helper_mode` 기본값은 선택으로 승격되지 않는다(옛 판의 함정).
  write({ helper_mode: 'codex-chat' })
  expect(settings.loadSettings().provider_choice).toBeNull()
})
