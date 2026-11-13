// 실제 Electron 기동 시험 — `before-quit` 배선과 자식 회수(검토 RT2-04, RT2-03).
//
// 앞선 단위 시험들은 helper(`shutdownWithin`)와 `close()` 만 본다. index.ts 의 배선을 지우거나
// `app.exit` 분기를 훼손해도 그것들은 통과했다. 이 시험은 **앱을 진짜로 띄워** 홀드된 턴을
// 남긴 채 종료하고, (1) 종료가 마감 안에 돌아오는지 (2) 엔진 자식이 남지 않는지
// (3) `[shutdown]` 진단 줄이 실제로 남는지를 본다.
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch, openProject, synthProject } from './helpers'
import { captureAppLog } from './diag'
import { fakeCodexEnv, replyFile, scratch, seedChat, userDataWith, writeCliShim } from './fixtures/fake-codex'

/** 메인 프로세스의 stderr — `[shutdown]` 진단이 여기로 나온다. */
function mainLog(app: ElectronApplication): { read: () => string } {
  const chunks: string[] = []
  app.process().stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
  app.process().stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
  return { read: () => chunks.join('') }
}

/**
 * 가짜 엔진 shim — 자기 pid 를 먼저 남기고 서버를 그대로 띄운다. 그래야 시험이
 * "끝난 뒤에도 그 pid 가 살아 있는가"를 물을 수 있다(자식 회수 확인).
 */
function pidWritingShim(bin: string, pidFile: string): void {
  const proxy = join(bin, 'codex-proxy.mjs')
  // **URL 로 넘긴다.** 동적 import 는 경로 문자열을 URL 로 해석하므로 윈도우의 `D:\…` 는
  // `c:`·`d:` 를 스킴으로 읽혀 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 로 죽는다(윈도우 CI:
  // `확인 실패`는 이 proxy 가 pid 를 못 남겨 엔진이 안 뜬 결과다). 맥에서는 통과해 숨는다.
  const serverUrl = pathToFileURL(resolve(__dirname, 'fixtures/fake-codex-server.mjs')).href
  writeFileSync(proxy, [
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    // 동적 import 가 필요하다: 이 파일은 시험이 만들어 **자식 node 프로세스**가 단독 실행하는
    // 스크립트이고, pid 를 먼저 남긴 **뒤에** 가짜 서버를 시작해야 한다(정적 import 는 먼저 실행된다).
    `await import(${JSON.stringify(serverUrl)})`
  ].join('\n'), 'utf-8')
  // `findExecutable` 은 윈도우에서 `codex.exe` → `codex.cmd` → `codex.bat` 순으로 찾는다
  // (`agent.ts` `winCandidateNames`). 확장자 없는 `codex` 만 바꾸면 윈도우에서는 **기존
  // `codex.cmd`** 가 선택돼 이 proxy 에 닿지 않는다(검토 RT2-04). 같은 이름 규칙으로 놓는다.
  writeCliShim(bin, 'codex',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} "$@"`,
    `"${process.execPath}" "${proxy}" %*`)
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitAlive(pidFile: string): Promise<number> {
  for (let i = 0; i < 300; i++) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf-8').trim())
      if (pid > 0) return pid
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('가짜 엔진이 뜨지 않았다 — pid 파일이 없다')
}

test('턴이 매달린 채로 앱을 닫아도 종료가 마감 안에 돌아오고, 엔진 자식이 남지 않는다 (RT2-03·RT2-04)', async () => {
  const dir = scratch(), bin = join(dir, 'bin')
  // `FAKE_CODEX_HOLD=1` — turn/start 뒤에 턴을 끝내지 않는다. 그 턴이 종료를 붙잡는다.
  const env = fakeCodexEnv(bin, { FAKE_CODEX_HOLD: '1', FAKE_CODEX_REPLY: replyFile(dir, '홀드된 답') })
  const pidFile = join(dir, 'engine.pid')
  pidWritingShim(bin, pidFile)
  const root = synthProject()
  seedChat(root, [{ id: 'previous', role: 'assistant', text: '이전 대화', at: new Date().toISOString() }])
  const { electronApp, page, appLog } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } }) })
  const log = mainLog(electronApp)
  const diagLog = captureAppLog(electronApp, appLog)
  let closed = false
  let enginePid = 0
  try {
    await openProject(page, root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('매달릴 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    // 턴이 시작됐다 — 이 상태에서 종료하면 예전에는 run 이 영원히 안 끝나 앱이 안 꺼졌다.
    await expect(page.getByRole('button', { name: '중단', exact: true })).toBeVisible()
    enginePid = await waitAlive(pidFile)
    expect(alive(enginePid), '가짜 엔진이 살아 있지 않다').toBe(true)

    const started = Date.now()
    diagLog.mark('close:start')
    await electronApp.close()
    diagLog.mark('close:end')
    closed = true
    const elapsed = Date.now() - started
    // 마감 10초 + 자식 회수 관측 1.5초 + 여유. 예전 배선이면 여기서 영원히 매달렸다.
    expect(elapsed, `종료가 마감을 넘겨 ${elapsed}ms 걸렸다`).toBeLessThan(45_000)

    // 엔진 자식이 남지 않았는지 **관측**한다(가정하지 않는다).
    for (let i = 0; i < 40 && alive(enginePid); i++) await new Promise((r) => setTimeout(r, 50))
    expect(alive(enginePid), `종료 뒤에도 엔진 자식이 살아 있다 pid=${enginePid}`).toBe(false)
    // 진단은 실제 배선에서 나온 것이어야 한다 — helper 시험에는 이 줄이 없다.
    // "정상 완료" 실행과 강제 마감 실행을 **구별**한다(검토 RT2-04).
    expect(log.read(), '종료 진단 줄이 없다 — before-quit 배선을 확인할 수 없다').toMatch(/\[shutdown\] 정리 완료 \d+ms/)
  } finally {
    if (!closed) {
      try { await electronApp.close() } catch { /* 이미 끝남 */ }
    }
    if (enginePid && alive(enginePid)) { try { process.kill(enginePid, 'SIGKILL') } catch { /* gone */ } }
  }
})

test('마감을 넘기면 회수·강제 종료 분기를 실제로 밟는다 — 그 경로를 단언한다 (RT2-04)', async () => {
  // 검토 지적: 앞 시험은 앱이 정상 정리되면 `[shutdown]` 만 확인해 **강제 종료/reclaim 분기까지
  // 밟았는지** 알 수 없었다. `KNUAF_E2E_QUIT_STALL=1` 로 sidecar 정리를 정착하지 않게 만들어
  // 마감 초과를 결정적으로 만든다(추가 청취자 없음 → listenerCount 분기 통과).
  const dir = scratch(), bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_HOLD: '1', KNUAF_E2E_QUIT_STALL: '1' })
  const root = synthProject()
  const { electronApp, page, appLog } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat' }) })
  const diagLog = captureAppLog(electronApp, appLog)
  let closed = false
  try {
    // 사이드카를 실제로 띄운다 — 그래야 회수 대상 pid 가 있고, "죽였는가"를 관측할 수 있다.
    await openProject(page, root)
    const log = mainLog(electronApp)
    const started = Date.now()
    diagLog.mark('close:start')
    await electronApp.close()
    diagLog.mark('close:end')
    closed = true
    const text = log.read()
    // 마감(10초) + 회수 관측(1.5초) 안에 끝나야 한다.
    expect(Date.now() - started, '강제 종료가 마감을 한참 넘겼다').toBeLessThan(40_000)
    expect(text, '마감을 넘겼는데 그 사실이 로그에 없다').toMatch(/\[shutdown\] 10000ms 안에 끝나지 않은 정리: sidecar\.stop/)
    expect(text, '회수 시도를 하지 않았다 — exit 경로가 아니다').toMatch(/\[shutdown\] 자식 회수 시도 pid=\d/)
    // 회수 콜백이 **실제로 신호를 보냈는지** — 아무 신호도 보내지 않는 옛 배선이면 여기에 살아 있음이 남는다.
    expect(text, '회수 콜백이 아무 신호도 보내지 않았다(옛 배선)').toMatch(/살아있음=없음|확인못함=\d/)
    expect(text, '회수 뒤에도 자식이 살아 있다').not.toMatch(/살아있음=\d/)
    expect(text, '강제 종료가 아니라 정상 정리로 끝났다').not.toMatch(/\[shutdown\] 정리 완료/)
  } finally {
    if (!closed) { try { await electronApp.close() } catch { /* already gone */ } }
  }
})

test('추가 before-quit 청취자가 있으면 강제 종료하지 않고 그 청취자의 몫으로 넘긴다 (RT2-04)', async () => {
  // index.ts 의 `listenerCount('before-quit') === 1` 분기 — 다른 청취자의 veto 를 무시하지 않는다.
  // 시험은 그 청취자를 **일부러 막는** 것으로 두고, 우리 마감이 끝난 뒤에도 앱이 살아 있음을 본다.
  const dir = scratch(), bin = join(dir, 'bin')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_HOLD: '1' })
  const { electronApp, page, appLog } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat' }) })
  const diagLog = captureAppLog(electronApp, appLog)
  let released = false
  try {
    await electronApp.evaluate(({ app }) => {
      const state = { release: false }
      Object.assign(globalThis, { vetoProbe: state })
      app.on('before-quit', (e) => { if (!state.release) e.preventDefault() })
    })
    const started = Date.now()
    // `app.quit()` 은 우리 before-quit 을 지나 마감까지 간다 — 그 뒤 veto 청취자가 막는다.
    await electronApp.evaluate(({ app }) => app.quit())
    await new Promise((r) => setTimeout(r, 12_000))
    expect(Date.now() - started).toBeGreaterThan(10_000)
    // 창은 아직 살아 있다 — 강제 종료가 veto 를 무시하지 않았다는 뜻이다.
    expect(await page.evaluate(() => 1 + 1)).toBe(2)
    // 그리고 **강제 종료 분기에 들어가지 않았다**: 그 분기였다면 프로세스가 이미 죽어 이 단언에 닿지 못한다.
    const after = await electronApp.evaluate(({ app }) => app.isReady())
    expect(after, '앱이 아직 실행 중이어야 한다').toBe(true)
    await electronApp.evaluate(() => { Reflect.get(globalThis, 'vetoProbe').release = true })
    released = true
    diagLog.mark('close:start')
    await electronApp.close()
    diagLog.mark('close:end')
  } finally {
    if (!released) {
      try { await electronApp.evaluate(() => { Reflect.get(globalThis, 'vetoProbe').release = true }) } catch { /* already gone */ }
      try { await electronApp.close() } catch { /* already gone */ }
    }
  }
})
