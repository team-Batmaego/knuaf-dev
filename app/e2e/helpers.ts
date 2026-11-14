import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_WINDOW } from '../src/shared/window'

export const app = resolve(__dirname, '..')
export const repo = resolve(app, '..')
export const scripts = process.env.KNUAF_SCRIPTS_DIR ?? join(app, 'resources', 'skill', 'scripts')
export const python = process.env.KNUAF_PYTHON ?? join(repo, '.venv-dev', 'bin', 'python')

let dependencySeed: string | undefined

/** Install once per worker, then copy real directories; every project still passes the app's doctor. */
function seedDependencies(root: string): void {
  if (existsSync(join(root, '.venv'))) return
  if (!dependencySeed) {
    const seed = mkdtempSync(join(tmpdir(), 'kd-deps-'))
    const installed = spawnSync(python, ['-X', 'utf8', join(scripts, 'gg_deps.py'), 'ensure', seed], { encoding: 'utf8' })
    if (installed.status !== 0) throw new Error(installed.error ? `${(installed.error as NodeJS.ErrnoException).code ?? 'spawn error'}: ${installed.error.message}` : installed.stdout + installed.stderr)
    dependencySeed = join(seed, '.venv')
  }
  cpSync(dependencySeed, join(root, '.venv'), { recursive: true, dereference: true })
}

/** init-only project (revision 0) or a project with a source, a section and a fact (revision 1). */
export function synthProject(opts: { withContent?: boolean; financeGate?: boolean } = { withContent: true }): string {
  const root = mkdtempSync(join(tmpdir(), 'kd-e2e-'))
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'init', root], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  if (opts.withContent === false) return root
  mkdirSync(join(root, 'sections'), { recursive: true }); mkdirSync(join(root, 'sources'), { recursive: true })
  writeFileSync(join(root, 'sources', 'answers.md'), '# 원답변\n\n재배 면적: 600평\n', 'utf-8')
  writeFileSync(join(root, 'sections', '01.md'), '# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n농장A의 재배 면적은 600평이다. 정읍 일대 기후를 고려해 작목을 선택했다.\n<!-- gg:draft:end -->\n', 'utf-8')
  const change = join(root, 'change.json')
  writeFileSync(change, JSON.stringify({ request_id: 'e2e:1', ops: [
    { collection: 'sources', value: { id: 'src-answers', path: 'sources/answers.md', claims: {} } },
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } },
    { collection: 'facts', value: { id: 'fact-area', field_id: 'farm.area', kind: 'reported_fact', value: '600', unit: '평', value_type: 'decimal', period: '2026', scope: '농장A', answer_state: 'provided', verification: 'unreviewed', source_refs: [{ id: 'src-answers', revision: 1, locator: 'L3' }] } },
    ...syntheticMajor(root),
    ...(opts.financeGate === false ? [] : syntheticFinanceGate(root))
  ] }), 'utf-8')
  const a = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', '0'], { encoding: 'utf-8' })
  if (a.status !== 0) throw new Error(a.stdout + a.stderr)
  return root
}

/** A test selection with claim-backed evidence, not a production default. */
function syntheticMajor(root: string): { collection: string; value: Record<string, unknown> }[] {
  if (!existsSync(join(scripts, 'gg_major_contract.py'))) throw new Error('Incompatible bundle: run stage:skill')
  const result = spawnSync(python, ['-B', '-c', [
    'import sys; sys.path.insert(0, sys.argv[1])',
    'import gg_major_contract as mc',
    'print(mc.default_registry().resolve("specialty_crops").module_version)'
  ].join('\n'), scripts], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  writeFileSync(join(root, 'sources', 'major.txt'), 'Synthetic explicit selection\n')
  const fact = {
    id: 'major', field_id: 'common.major_id', kind: 'reported_fact', value: 'specialty_crops',
    unit: '', value_type: 'text', period: null, scope: 'project', answer_state: 'provided',
    verification: 'claim_supported', module_version: result.stdout.trim(),
    source_refs: [{ id: 'major-source', revision: 1, locator: 'L1', claim_id: 'major' }]
  }
  const { field_id, kind, value, unit, period, scope, answer_state } = fact
  return [
    { collection: 'sources', value: { id: 'major-source', path: 'sources/major.txt', claim_review: 'synthetic-review',
      claims: { major: { field_id, kind, value, unit, period, scope, answer_state } } } },
    { collection: 'facts', value: fact }
  ]
}

/**
 * v0.3.x 원본 계약의 본문 전 재무 게이트 기록. 지원 전공 + 본문 절이면 게이트 기록이
 * 없을 때 `project.status`가 `finance_gate`를 `needs_user`로 내 2단계에 머문다.
 * 합성 시험은 재무 수치를 다루지 않으므로 원본이 허용하는 `not_computable`(사유 포함)을
 * claim-backed 사실로 남겨 게이트를 통과시킨다 — 앱 판정 규칙은 바꾸지 않는다.
 */
function syntheticFinanceGate(root: string): { collection: string; value: Record<string, unknown> }[] {
  writeFileSync(join(root, 'sources', 'finance-gate.txt'), 'Synthetic finance inputs unavailable\n')
  const fact = {
    id: 'finance-gate', field_id: 'finance.gate.state', kind: 'reported_fact',
    value: 'not_computable', unit: '', value_type: 'text', period: null, scope: 'project',
    answer_state: 'provided', verification: 'claim_supported',
    reason: '합성 시험: 재무 입력 없음',
    source_refs: [{ id: 'finance-gate-source', revision: 1, locator: 'L1', claim_id: 'state' }]
  }
  const { field_id, kind, value, unit, period, scope, answer_state } = fact
  return [
    { collection: 'sources', value: { id: 'finance-gate-source', path: 'sources/finance-gate.txt', claim_review: 'synthetic-review',
      claims: { state: { field_id, kind, value, unit, period, scope, answer_state } } } },
    { collection: 'facts', value: fact }
  ]
}

export function plantStaleLock(root: string): void {
  mkdirSync(join(root, '.gg-lock'), { recursive: true })
  writeFileSync(join(root, '.gg-lock', 'owner.json'), JSON.stringify({ pid: 999999, host: require('node:os').hostname(), token: 'x', acquired_at: Date.now() / 1000 - 3600 }))
}

export async function launch(opts: { userData?: string; colorScheme?: 'light' | 'dark'; reducedMotion?: 'reduce' | 'no-preference'; env?: Record<string, string>; intro?: boolean; splash?: 'keep'; onboarded?: boolean; permissionPrompt?: boolean; waitFor?: string } = {}): Promise<{ electronApp: ElectronApplication; page: Page; appLog: string }> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'kd-userdata-'))
  /**
   * Every app launch shows its startup splash. Ordinary E2E tests send Escape after the overlay
   * is visible and wait for it to disappear; splash-specific tests pass `splash: 'keep'` to
   * observe the natural startup. This option belongs only to the test helper, not shipped code.
   *
   * `intro` retains its legacy show_intro fixture behavior; it does not control the startup splash.
   * `onboarded_at` is set as well. Without it the first-run connect/folder screens replace the
   * workspace, so tests of first-run behavior opt out with `onboarded: false`.
   */
  const settingsFile = join(userData, 'settings.json')
  mkdirSync(userData, { recursive: true })
  let preset: Record<string, unknown> = {}
  if (existsSync(settingsFile)) {
    try { preset = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown> } catch { preset = {} }
  }
  if (!opts.intro && preset.show_intro === undefined) preset.show_intro = false
  if (opts.onboarded === false) delete preset.onboarded_at
  else if (!preset.onboarded_at) preset.onboarded_at = new Date().toISOString()
  if (opts.permissionPrompt) delete preset.first_project_permission_asked_at
  else if (!preset.first_project_permission_asked_at) preset.first_project_permission_asked_at = new Date().toISOString()
  writeFileSync(settingsFile, JSON.stringify(preset), 'utf-8')
  // A shell that exports ELECTRON_RUN_AS_NODE would make the app run as plain Node (require('electron') yields the binary path).
  const env: NodeJS.ProcessEnv = { ...process.env, KNUAF_PYTHON: python, KNUAF_SCRIPTS_DIR: scripts, KNUAF_USER_DATA: userData, ...opts.env }
  // Retained even when aggregate diagnosis never answers; no project data is recorded.
  const doctorTrace = test.info().outputPath(`doctor-${Date.now()}.jsonl`)
  mkdirSync(join(doctorTrace, '..'), { recursive: true })
  env.KNUAF_E2E_DOCTOR_TRACE = doctorTrace
  /**
   * 종료 진단 로그 — **항상 켠다**(추가 플래그 없음). 앱은 `KNUAF_APP_LOG` 가 지정됐을 때만 쓰고,
   * 미지정 실행에서는 완전 무동작이다. `electronApp.close()` 가 안 돌아와도 이 파일에는 마지막
   * 단계가 남는다(PR #102 윈도우 CI 가 바로 그 경우였다).
   */
  const appLog = test.info().outputPath('app-log.txt')
  mkdirSync(join(appLog, '..'), { recursive: true })
  env.KNUAF_APP_LOG = appLog
  delete env.ELECTRON_RUN_AS_NODE
  // e2e 창은 화면에 뜨지 않는다 — 맥에서 다른 작업을 가로채지 않게(main 의 KNUAF_E2E_HIDDEN).
  // 눈으로 봐야 할 때만 KNUAF_E2E_VISIBLE=1 로 끈다(window-shots.spec.ts 처럼 창을 찍는 spec).
  if (env.KNUAF_E2E_HIDDEN === undefined && env.KNUAF_E2E_VISIBLE !== '1') env.KNUAF_E2E_HIDDEN = '1'
  const electronApp = await electron.launch({
    args: [join(app, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env,
    colorScheme: opts.colorScheme
  })
  const page = await electronApp.firstWindow()
  /**
   * 기본 시험은 사이드바와 대화·논문의 세 칸이 들어가는 폭에서 돌린다.
   * 좁은 배치를 검증하는 시험은 `setWindowWidth`로 별도 폭을 지정한다.
   */
  await electronApp.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setBounds(size) }, DEFAULT_WINDOW)
  if (opts.colorScheme || opts.reducedMotion) await page.emulateMedia({ colorScheme: opts.colorScheme, reducedMotion: opts.reducedMotion })
  // 첫 화면은 재실행에서 **두 단계 부품**(제목줄 아래)이 덮는다 — 연결이 확인돼 있으면 폴더
  // 단계, 끊겨 있으면 1단계(AI 연결). 둘 다에 있는 제목줄을 준비 신호로 기다린다.
  await page.waitForSelector(opts.waitFor ?? '.titlebar')
  const splash = page.locator('.splash')
  if (opts.splash !== 'keep') {
    await splash.waitFor({ state: 'visible', timeout: 30_000 })
    // The skip key listener is attached before the first animation frame marks this node.
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.splash__track > div')?.style.transform.startsWith('scaleX(') ?? false)
    await page.keyboard.press('Escape')
    await splash.waitFor({ state: 'detached' })
  }
  return { electronApp, page, appLog }
}

/** 앱 화면이 준비됐다는 표시 — v5 에는 "내 논문" h1 이 없다(대화 칸 자체가 그 화면이다). */
export const CHAT_READY = '.chat-pane'

/**
 * 열려 있는 시트를 닫는다. v5 의 자료·결과물·설정은 오른쪽 시트, 제출 전 점검은 논문 칸을
 * 덮는 한 장이다 — 둘 다 Esc 로 닫힌다.
 */
export async function closeSheet(page: Page): Promise<void> {
  const over = page.locator('.sheetover')
  if (await over.count()) {
    // 논문 칸을 덮는 한 장은 닫기 단추가 확실한 길이다(Esc 도 되지만 겹친 창에서 흔들린다).
    await over.getByRole('button', { name: '닫기' }).first().click()
    await over.waitFor({ state: 'detached', timeout: 30_000 })
  }
  // 설정 시트 위에 확인 창이 겹쳐 있을 수 있다 — 열린 dialog 가 없어질 때까지 Esc 로 닫는다.
  for (let i = 0; i < 3 && (await page.locator('dialog[open]').count()); i++) {
    await page.locator('dialog[open]').last().press('Escape')
  }
}

/**
 * 메인의 shell 호출을 한 파일에 기록한다 — 시험이 실제 탐색기·기본 프로그램을 띄우지 않게.
 * `openFailure` 를 주면 openPath 가 그 문자열(열기 실패)을 돌려준다. `swapOnOpen` 은 openPath
 * 가 불린 **그 순간** 폴더를 바꿔치기한다 — 열기 응답을 기다리는 사이 대상이 바뀌는 경우
 * (검토 ATTACH-R1-03)를 파일 시스템 조작으로 재현한다. 기록 한 줄은 `open<TAB>경로` 또는
 * `reveal<TAB>경로` 다.
 */
export async function spyShell(
  electronApp: ElectronApplication,
  log: string,
  opts: { openFailure?: string; swapOnOpen?: { move: string; to: string; symlink: string; target: string } } = {}
): Promise<void> {
  await electronApp.evaluate(({ shell }, o: {
    log: string
    failure: string
    swap: { move: string; to: string; symlink: string; target: string } | null
  }) => {
    // evaluate 는 메인 프로세스에서 돈다 — 이 앱의 메인 번들은 ESM 이라 `require` 가 없다.
    const fs = process.getBuiltinModule('node:fs')
    const note = (line: string): void => fs.appendFileSync(o.log, line + '\n')
    shell.showItemInFolder = (p: string) => { note(`reveal\t${p}`) }
    shell.openPath = async (p: string) => {
      note(`open\t${p}`)
      // 열기 응답을 기다리는 사이 폴더가 다른 곳을 가리키게 만든다.
      if (o.swap) {
        fs.renameSync(o.swap.move, o.swap.to)
        fs.symlinkSync(o.swap.target, o.swap.symlink)
      }
      return o.failure
    }
  }, { log, failure: opts.openFailure ?? '', swap: opts.swapOnOpen ?? null })
}

/** `spyShell` 이 남긴 기록(없으면 빈 배열). */
export function shellCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
}

/**
 * 로그인 창을 띄우는 `shell.openExternal` 만 **아무것도 하지 않게** 바꾼다.
 *
 * `spyShell` 에 넣지 않는 이유: 그 기록 파일을 `shellCalls(log)` 로 **정확 배열** 단언하는
 * 시험이 다섯 개 있어, `external\t` 줄이 하나라도 새면 전부 깨진다. 여기서는 기록도 남기지 않는다.
 *
 * 왜 필요한가: 가짜 codex 서버는 `authUrl: 'about:blank'` 를 주고, 제품 코드는 그 주소를
 * 실제 기본 브라우저로 연다. CI 윈도우에서 브라우저 프로세스가 런치 래퍼(`cmd.exe`)의 핸들을
 * 물고 남으면 앱이 정상 종료해도 `close()` 가 안 돌아온다 — 재로그인 시험은 매번 브라우저를
 * 띄우므로 그 경로에 특히 취약하다. 화면 문구(`브라우저에서 로그인`)는 제품 상태라 그대로다.
 */
export async function stubExternal(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {} })
}

/** 강제 종료 명령에 거는 제한. 상한(`ms`) 뒤에 붙는 최악의 추가 시간이다. */
const KILL_TIMEOUT_MS = 5_000

/** 강제 종료 한 번의 **계획** — 실행과 분리해 두어야 시험이 실제 명령 없이 명령·pid·옵션을 단언한다. */
export type KillPlan =
  | { kind: 'taskkill'; command: string; options: { shell: true; windowsHide: true; timeout: number } }
  | { kind: 'signal'; signal: NodeJS.Signals }

/**
 * 이 pid 를 정리할 명령. **여기서 실행하지 않는다** — 시험이 실제 `taskkill` 없이 이 값을 단언한다.
 *
 * 윈도우에서 `proc.kill()` 은 래퍼(`cmd.exe`)만 죽이고 그 아래는 남는다 — 트리째 죽여야 한다.
 * Playwright 자신도 강제 종료에 같은 모양(`taskkill /T /F`)을 쓴다(1.63.0 `killProcess`).
 * 그 외 플랫폼은 `shell: false` 라 이 pid 가 곧 electron 이다.
 */
export function killPlan(pid: number, platform: NodeJS.Platform = process.platform): KillPlan {
  if (platform === 'win32')
    return {
      kind: 'taskkill',
      command: `taskkill /pid ${pid} /T /F`,
      options: { shell: true, windowsHide: true, timeout: KILL_TIMEOUT_MS }
    }
  return { kind: 'signal', signal: 'SIGKILL' }
}

/** 강제 종료 대상 — Electron 이 준 자식 프로세스에서 쓰는 두 필드만. */
export type KillTarget = { pid: number; kill(signal: NodeJS.Signals): boolean }

/** 강제 종료 결과. `ok: false` 면 `closeApp` 이 실패로 드러낸다 — 조용히 넘기지 않는다. */
export type KillOutcome = { ok: true } | { ok: false; detail: string }

/** 강제 종료 실행기. 시험은 **이것을 갈아 끼워** 실제 프로세스를 건드리지 않는다. */
export type ForceKiller = (target: KillTarget) => KillOutcome

/** pid 가 아직 살아 있는가. `EPERM` 은 "있지만 남의 것"이라 살아 있는 것으로 본다. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `spawnSync` 가 돌려주는 것 중 판정에 쓰는 부분만. */
export type SpawnOutcome = { status: number | null; signal: NodeJS.Signals | null; error?: Error }

/**
 * `taskkill` 결과를 **판정**한다. 종료 코드를 추측하지 않는다.
 *
 * `spawnSync` 는 0 이 아닌 코드로 끝나도 예외를 던지지 않으므로 `status`·`signal`·`error` 를
 * 직접 봐야 한다(검토 I-01). 다만 "이미 없다"는 실패가 아니다 — 윈도우 `taskkill` 은 없는 pid
 * 에도 0 이 아닌 코드를 내므로, 코드가 아니라 **pid 생존**으로 결론낸다.
 */
export function judgeKill(result: SpawnOutcome, stillAlive: boolean): KillOutcome {
  if (result.status === 0) return { ok: true }
  if (!stillAlive) return { ok: true }
  const why = result.error
    ? ((result.error as NodeJS.ErrnoException).code ?? result.error.message)
    : result.signal
      ? `signal=${result.signal}`
      : `status=${result.status}`
  return { ok: false, detail: `taskkill ${why}` }
}

/** `forceKill` 의 바깥 의존 — 시험이 실제 명령·실제 pid 없이 각 갈래를 만든다. */
export type KillDeps = {
  alive?: (pid: number) => boolean
  platform?: NodeJS.Platform
  spawn?: (command: string, options: object) => SpawnOutcome
}

/**
 * 기본 강제 종료 실행기 — 실제로 정리한다. 회귀 시험은 이 함수의 **기본 인자**를 쓰지 않는다.
 */
export function forceKill(target: KillTarget, deps: KillDeps = {}): KillOutcome {
  const { pid } = target
  const isAlive = deps.alive ?? alive
  const plan = killPlan(pid, deps.platform ?? process.platform)
  if (plan.kind === 'taskkill') {
    const run = deps.spawn ?? ((command, options) => spawnSync(command, options as never) as SpawnOutcome)
    return judgeKill(run(plan.command, plan.options), isAlive(pid))
  }
  if (target.kill(plan.signal)) return { ok: true }
  // `kill()` 이 false 를 돌려줘도 이미 죽었으면 목적은 달성이다(검토 I-01).
  return isAlive(pid) ? { ok: false, detail: `kill(${plan.signal}) false` } : { ok: true }
}

/**
 * 앱을 닫되 **상한을 둔다**.
 *
 * 왜 필요한가: Playwright 의 `ElectronApplication.close()` 는 앱 종료가 아니라 **런치 래퍼
 * 프로세스의 `close` 이벤트**를 무타임아웃으로 기다린다(playwright-core 1.63.0, `appClosePromise`).
 * 윈도우에서는 `shell: true` 때문에 그 래퍼가 `cmd.exe` 다. 래퍼가 안 죽으면 앱이
 * `[shutdown] stage=process-exit code=0` 으로 정상 종료했는데도 `close()` 가 영영 돌아오지
 * 않는다 — 시험은 90초 타임아웃으로 죽고, 워커 정리까지 90초를 더 쓴다(run 43296520840
 * 윈도우 샤드 4, 같은 시험이 main 단일 잡에서는 38.1s 통과).
 *
 * 앱이 스스로 끝나면 이 상한은 아무 일도 하지 않는다. 넘겼을 때만 프로세스 **트리**를
 * 강제로 정리하고 그 사실을 `close:force` 로 남긴다 — 조용히 넘기면 다음 사람이 못 본다.
 *
 * 강제 정리마저 실패하면 `close:force-failed <이유>` 를 남기고 **던진다** — 정리 실패를
 * 통과로 덮으면 다음 사람이 잔류 프로세스를 또 만난다. `close()` 자체의 거절은 `close:rejected`
 * 로만 남기고 던지지 않는다(앱이 이미 끝난 정상적인 경우가 있다).
 *
 * `close:end` 는 어느 갈래에서도 **반드시** 남긴다(finally). 안 남기면 `captureAppLog` 의
 * 5초 헬스비트가 워커 종료까지 계속 찍혀, 통과한 시험도 매달린 것처럼 보인다(오탐).
 */
export async function closeApp(
  electronApp: ElectronApplication,
  log: { mark: (stage: string) => void },
  ms = 20_000,
  opts: { forceKill?: ForceKiller } = {}
): Promise<void> {
  log.mark('close:start')
  const proc = electronApp.process()
  const expiry = Promise.withResolvers<'expired'>()
  const timer = setTimeout(() => expiry.resolve('expired'), ms)
  timer.unref?.()
  try {
    // 강제 종료 뒤 원래 약속이 늦게 거절해도 시험을 오염시키지 않는다.
    const closed = electronApp.close().then(
      () => 'closed' as const,
      (e: unknown) => {
        log.mark(`close:rejected ${(e as Error)?.message ?? String(e)}`)
        return 'closed' as const
      }
    )
    if (await Promise.race([closed, expiry.promise]) === 'expired') {
      const pid = proc.pid
      log.mark(`close:force pid=${pid ?? '없음'} 상한=${ms}ms`)
      if (typeof pid === 'number') {
        const outcome = (opts.forceKill ?? forceKill)(proc as unknown as KillTarget)
        if (!outcome.ok) {
          log.mark(`close:force-failed ${outcome.detail}`)
          throw new Error(`close:force-failed ${outcome.detail}`)
        }
      }
    }
  } finally {
    clearTimeout(timer)
    log.mark('close:end')
  }
}

/** 두 공급자 모두에 같은 도우미 답변을 심는다 — 어느 공급자로 열려도 그 글이 보인다. */
export function seedChat(root: string, text: string): void {
  mkdirSync(join(root, '.knuaf-gui'), { recursive: true })
  for (const p of ['codex', 'claude'])
    writeFileSync(join(root, '.knuaf-gui', `chat-${p}.json`), JSON.stringify({
      root, provider: p, state: 'idle',
      messages: [{ id: 'a1', role: 'assistant', text, at: new Date().toISOString() }]
    }), 'utf-8')
}

/**
 * 작업공간 배치가 **멈출 때까지** 기다린다(맥 CI 처방).
 *
 * 폴더를 열면 대화가 먼저 뜨고 그 뒤에 종이 칸이 열리면서(절 목록을 읽은 뒤) **대화 칸 폭이
 * 좁아진다**(1,180 → 500 안팎). 그 재배치가 도는 동안 재거나 누르면 클릭이 빗나가고(버튼이
 * 그사이 움직인다) 좌표가 낡는다 — 맥 CI 에서 `chat-long`(펼치기 클릭이 안 먹음)·`qa2`(재는
 * 순간 노드가 붙지 않음) 가 그렇게 갈렸다. 두 rAF 연속 같은 모양이면 멈춘 것으로 본다.
 *
 * **한계(검토 MACR3-R1-02)**: 이 함수는 "지금 움직이지 않는다"만 본다. 아직 오지 않은 절 목록이
 * 나중에 배치를 바꾸지 않는다는 보장은 없다 — 로딩 중 빈 배치(solo·폭 1180)도 조용하다.
 * 그래서 부르는 쪽이 **자기가 쓸 요소의 준비**(`openProject` 의 `ready`)를 먼저 기다려야 한다.
 */
export async function settleWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = document.querySelector('.workspace')
    if (!ws) return false
    const chat = document.querySelector('.chat-pane') as HTMLElement | null
    const key = `${ws.className}|${Math.round(chat?.clientWidth ?? -1)}`
    const w = window as unknown as { __wsKey?: string; __wsSame?: number }
    if (w.__wsKey === key) w.__wsSame = (w.__wsSame ?? 0) + 1
    else { w.__wsKey = key; w.__wsSame = 0 }
    return (w.__wsSame ?? 0) >= 2
  }, undefined, { polling: 'raf', timeout: 15_000 })
}

/**
 * 이 폴더에 **본문이 있는 종이**가 자리 잡을 때까지 — 두 칸 배치(`.workspace.split`)가 된다.
 *
 * 본문이 있는 폴더를 여는 시험만 쓴다(`synthProject()` 는 본문이 있다). 본문 없는 폴더
 * (`synthProject({ withContent: false })`)에 쓰면 영원히 기다린다 — 그래서 기본값이 아니라
 * 호출자가 고른다(검토 MACR3-R1-02: 모든 폴더에 본문을 강제하지 않는다).
 */
export async function splitReady(page: Page): Promise<void> {
  await expect(page.locator('.workspace.split')).toBeVisible({ timeout: 30_000 })
}

/**
 * 종이 본문이 그려질 때까지(선택할 문단이 생길 때까지). `text` 를 주면 그 글자가 보일 때까지.
 * 종이에서 문단을 고르거나 종이 머리를 읽는 시험은 이 전제를 먼저 세운다.
 */
export async function paperReady(page: Page, text?: string): Promise<void> {
  const sheet = page.locator('.paperpane .sheet')
  await expect(sheet).toBeVisible({ timeout: 30_000 })
  if (text) await expect(sheet).toContainText(text, { timeout: 30_000 })
}

/**
 * Open a project by entering its path through Settings > Folder > Advanced.
 * The path input is hidden until the Folder section is selected and its disclosure is expanded.
 *
 * `ready` waits for the element the caller will use before workspace layout settles. The
 * project section list can still change the layout after the initial open.
 * Ordinary scenarios get an independent .venv and wait for renderer-proven readiness.
 * Preparation race/failure scenarios opt out explicitly; they own their pending response.
 */
export async function openProject(page: Page, root: string, ready?: (p: Page) => Promise<unknown>, opts: { preparation?: 'pending' } = {}): Promise<void> {
  if (opts.preparation !== 'pending') seedDependencies(root)
  await page.getByRole('button', { name: '설정' }).first().click()
  await page.waitForSelector('dialog[open]', { timeout: 30_000 })
  await page.locator('dialog[open] nav').getByRole('button', { name: '폴더', exact: true }).click()
  const disclosure = page.locator('dialog[open] details:has(input[aria-label="폴더 경로"])')
  await expect(disclosure).toHaveCount(1)
  await expect(disclosure).toBeVisible()
  await disclosure.evaluate((d) => { (d as HTMLDetailsElement).open = true })
  const pathInput = page.getByRole('textbox', { name: '폴더 경로' })
  await expect(pathInput).toBeVisible()
  await pathInput.fill(root)
  await disclosure.getByRole('button', { name: '경로로 열기', exact: true }).click()
  // 폴더 열기가 시작됐다 — 시트가 닫히고 대화 칸이 남는다.
  await page.waitForSelector(CHAT_READY, { timeout: 30_000 })
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 30_000 })
  if (opts.preparation !== 'pending') await projectPrepared(page)
  // 호출자가 쓸 요소가 준비된 뒤에, 배치가 멈춘 것을 확인하고 돌려준다.
  if (ready) await ready(page)
  await settleWorkspace(page)
}

/** Observe the renderer's preparation state, not a direct IPC install result. */
export async function projectPrepared(page: Page): Promise<void> {
  await navTo(page, '설정')
  await openPreset(page, 'fix:deps')
  const preparation = page.locator('dialog[open] details[data-preset="fix:deps"]')
  await expect(preparation.locator('.card-head')).toContainText('준비됨', { timeout: 30_000 })
  await closeSheet(page)
  await expect(page.locator('.chat-zone .zline.wait')).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Navigate to the shared workspace surfaces. '자료' and '결과물' open their paper-header lists;
 * the removed full-screen list views are not navigation destinations.
 *
 * '내 논문' selects the paper tab when a file preview is open; '설정' opens its modal and
 * '점검' opens the paper overlay from the titlebar menu.
 */
export async function navTo(page: Page, label: string): Promise<void> {
  await closeSheet(page)
  if (label === '내 논문') {
    const paperTab = page.getByRole('tab', { name: '내 논문' })
    if (await paperTab.isVisible()) await paperTab.click()
    return
  }
  if (label === '설정') {
    await page.getByRole('button', { name: '설정' }).first().click()
    return
  }
  if (label === '점검') {
    await page.locator('.titlebar .tbtn.stg').click()
    await page.locator('.titlebar .popover').getByRole('button', { name: '제출 전 점검' }).click()
    return
  }
  if (label === '자료' || label === '결과물') {
    const paper = page.locator('.paper-head')
    const paperTab = page.getByRole('tab', { name: '내 논문' })
    if (!(await paper.isVisible()) && await paperTab.isVisible()) await paperTab.click()
    const trigger = label === '자료' ? 'head-materials' : 'head-files'
    const button = paper.locator(`[data-focus-key="${trigger}"]`)
    const popover = button.locator('..').locator('.popover')
    if (!(await popover.isVisible()) || await button.getAttribute('aria-expanded') !== 'true') await button.click()
    await expect(popover).toBeVisible()
    return
  }
  throw new Error(`모르는 목적지: ${label}`)
}



/** Open a Settings disclosure by its deep-link preset (`tools:export`, `fix:lock`, `folder:path`…). */
export async function openPreset(page: Page, preset: string): Promise<void> {
  const family = preset.slice(0, preset.indexOf(':'))
  const section = family === 'tools' ? '고급 도구'
    : family === 'fix' ? '문제 해결'
      : family === 'folder' ? '폴더'
        : family === 'python' ? 'Python 실행기'
          : family === 'info' ? '앱 정보'
            : null
  if (section) await page.locator('dialog[open] nav').getByRole('button', { name: section, exact: true }).click()
  const disclosure = page.locator(`dialog[open] details[data-preset="${preset}"]`)
  await expect(disclosure).toBeVisible()
  await disclosure.evaluate((d) => { (d as HTMLDetailsElement).open = true })
}


/** 절 하나를 등록하고 그 절에 본문을 써 넣는다 — "본문이 있는 장"이 하나 생긴다. */
export function addSectionBody(root: string, opts: { id?: string; title?: string; body?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const title = opts.title ?? 'Ⅰ. 머리말'
  const body = opts.body ?? '농장A의 재배 면적은 600평이다.'
  mkdirSync(join(root, 'sections'), { recursive: true })
  writeFileSync(join(root, 'sections', `${id}.md`), `# ${title}\n\n<!-- gg:draft:start -->\n${body}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}`, ops: [
    { collection: 'sections', value: { id, title, order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 0)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 절 본문을 갈아 끼운다 — 기록이 오르고 "방금 저장된 문단"이 생긴다. */
export function rewriteSection(root: string, opts: { id?: string; body?: string; expected: number }): void {
  const id = opts.id ?? 'sec-01'
  writeFileSync(join(root, 'sections', `${id}.md`), `# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n${opts.body ?? ''}\n<!-- gg:draft:end -->\n`, 'utf-8')
  const change = join(root, `change-${id}-rewrite.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:rw`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/${id}.md`, status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/**
 * 장 하나를 `review_ready` 로 올린다 — "지금"이 3단계(검토본)가 되는 장면을 만든다.
 * 절 상태는 정본이 들고 있으므로 apply 로 올리고, 앱은 2초 감시로 따라온다.
 */
export function markSectionReady(root: string, opts: { id?: string; expected?: number } = {}): void {
  const id = opts.id ?? 'sec-01'
  const change = join(root, `change-${id}-ready.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:p3:${id}:ready`, ops: [
    { collection: 'sections', value: { id, title: 'Ⅰ. 머리말', order: 1, path: `sections/01.md`, status: 'review_ready' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(opts.expected ?? 1)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 창 크기를 실제로 바꾼다 — 폭 경계는 창 폭이라 `page.setViewportSize` 로는 안 바뀐다. */
export async function setWindowWidth(electronApp: ElectronApplication, width: number): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0].setBounds({ width: w }) }, width)
}

/**
 * 대화의 진행 표시 — 작업 중이면 정확히 하나다(형님 확정 2026-10-19 전송 중 A안): 마지막 학생 메시지가 아직
 * 보내는 중이면 그 말풍선 밖 "보내는 중" 글자, 아니면 입력칸 위 빙글이 줄. 작업이 끝나면 0개.
 */
export const PROGRESS = '.zone-status, .deliv[data-st="sending"]'
