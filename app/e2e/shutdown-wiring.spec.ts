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
 * 가짜 엔진 shim — 자기 pid 를 **덧붙이고** 서버를 그대로 띄운다. 그래야 시험이
 * "끝난 뒤에도 그 pid 가 살아 있는가"를 물을 수 있다(자식 회수 확인).
 *
 * 덮어쓰지 않는 이유: 지킴이 갈래는 엔진을 갈아 끼운다(§4.1-C PROCESS DISCARD RULE —
 * `restart()`/`discardProcess()`). 덮어쓰면 마지막 pid 만 남아 **먼저 뜬 엔진이 회수됐는지**를
 * 물을 수 없고, 반대로 처음 pid 만 잡으면 이미 버려진 프로세스를 '턴을 맡은 엔진'으로 착각한다
 * (#125 macos 2 실패가 정확히 이 자리였다). 그래서 뜬 엔진 **전부**를 남긴다.
 */
function pidWritingShim(bin: string, pidFile: string): void {
  const proxy = join(bin, 'codex-proxy.mjs')
  // **URL 로 넘긴다.** 동적 import 는 경로 문자열을 URL 로 해석하므로 윈도우의 `D:\…` 는
  // `c:`·`d:` 를 스킴으로 읽혀 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 로 죽는다(윈도우 CI:
  // `확인 실패`는 이 proxy 가 pid 를 못 남겨 엔진이 안 뜬 결과다). 맥에서는 통과해 숨는다.
  const serverUrl = pathToFileURL(resolve(__dirname, 'fixtures/fake-codex-server.mjs')).href
  writeFileSync(proxy, [
    `import { appendFileSync } from 'node:fs'`,
    `appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n')`,
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

/**
 * pid 파일의 완전한 줄들.
 *
 * 덧붙이는 중인 마지막 줄은 **잘린 값**일 수 있다(`41057` 을 쓰는 중에 `4105` 로 읽히면 그건
 * 없는 프로세스다). 그래서 파일이 개행으로 끝나지 않으면 마지막 조각을 버리고, 남은 줄도
 * 숫자 전체가 맞는 것만 받는다 — 잘린 pid 로 '살아 있다/죽었다'를 물으면 판정이 거짓이 된다.
 */
function readPids(file: string): number[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf-8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop()
  return lines.map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number)
}

/** 지금까지 뜬 엔진 pid 전부(뜬 순서, 중복 없음). */
function spawnedPids(pidFile: string): number[] {
  return [...new Set(readPids(pidFile))]
}

/**
 * 첫 엔진이 뜰 때까지 기다린다. **하나만** 기다린다 — 이 시점 뒤로는 턴을 맡은 엔진이
 * 누구인지가 문제이고(지킴이 재기동으로 갈릴 수 있다), 그 판정은 `turnServingPid` 가 한다.
 */
async function waitSpawned(pidFile: string): Promise<number[]> {
  for (let i = 0; i < 300; i++) {
    const pids = spawnedPids(pidFile)
    if (pids.length > 0) return pids
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('가짜 엔진이 뜨지 않았다 — pid 파일이 없다')
}

/**
 * 그 턴을 실제로 받은 엔진 pid. 가짜 서버가 `turn/start` 처리 시점에 자기 pid 를 남긴다
 * (`FAKE_CODEX_TURN_PID_LOG`) — '먼저 뜬 pid' 를 턴 담당으로 가정하지 않는다.
 */
async function turnServingPid(turnPidFile: string): Promise<number> {
  for (let i = 0; i < 300; i++) {
    const pids = readPids(turnPidFile)
    if (pids.length > 0) return pids[pids.length - 1]
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('턴을 맡은 엔진 pid 가 기록되지 않았다')
}

test('턴이 매달린 채로 앱을 닫아도 종료가 마감 안에 돌아오고, 엔진 자식이 남지 않는다 (RT2-03·RT2-04)', async () => {
  const dir = scratch(), bin = join(dir, 'bin')
  const turnPidFile = join(dir, 'turn.pid')
  // `FAKE_CODEX_HOLD=1` — turn/start 뒤에 턴을 끝내지 않는다. 그 턴이 종료를 붙잡는다.
  // `FAKE_CODEX_IGNORE_STDIN_EOF=1` — 엔진이 부모 파이프가 닫혀도 **스스로 죽지 않는다**. 이게 없으면
  // 앱이 자식을 죽이지 않고 버리기만 해도(누수) 부모가 죽는 순간 사라져 회수 판정이 가려진다.
  const env = fakeCodexEnv(bin, {
    FAKE_CODEX_HOLD: '1',
    FAKE_CODEX_REPLY: replyFile(dir, '홀드된 답'),
    FAKE_CODEX_TURN_PID_LOG: turnPidFile,
    FAKE_CODEX_IGNORE_STDIN_EOF: '1'
  })
  const pidFile = join(dir, 'engine.pid')
  pidWritingShim(bin, pidFile)
  const root = synthProject()
  seedChat(root, [{ id: 'previous', role: 'assistant', text: '이전 대화', at: new Date().toISOString() }])
  const { electronApp, page, appLog } = await launch({ env, userData: userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } }) })
  const log = mainLog(electronApp)
  const diagLog = captureAppLog(electronApp, appLog)
  let closed = false
  let pids: number[] = []
  try {
    await openProject(page, root)
    const chip = page.getByTitle('이 논문의 도우미')
    await expect(chip).toContainText('연결됨')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('매달릴 요청')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    // 턴이 시작됐다 — 이 상태에서 종료하면 예전에는 run 이 영원히 안 끝나 앱이 안 꺼졌다.
    await expect(page.getByRole('button', { name: '중단', exact: true })).toBeVisible()
    // **턴을 맡은** 엔진이 살아 있어야 한다. 지킴이 갈래는 적재 검증을 위해 엔진을 갈아 끼울 수
    // 있으므로(`restart()`), '먼저 뜬 pid' 가 아니라 `turn/start` 를 실제로 받은 pid 로 묻는다.
    const serving = await turnServingPid(turnPidFile)
    expect(alive(serving), `턴을 맡은 엔진이 살아 있지 않다 pid=${serving}`).toBe(true)
    pids = await waitSpawned(pidFile)
    expect(pids, '뜬 엔진이 없다').not.toHaveLength(0)
    // 갈아 끼운 흔적까지 남긴다 — 아래 '전부 죽었는가'의 대상이다.
    expect(pids, `턴을 맡은 엔진(${serving})이 뜬 엔진 목록에 없다: ${pids.join(',')}`).toContain(serving)

    const started = Date.now()
    diagLog.mark('close:start')
    await electronApp.close()
    diagLog.mark('close:end')
    closed = true
    const elapsed = Date.now() - started
    // 마감 10초 + 자식 회수 관측 1.5초 + 여유. 예전 배선이면 여기서 영원히 매달렸다.
    expect(elapsed, `종료가 마감을 넘겨 ${elapsed}ms 걸렸다`).toBeLessThan(45_000)

    // **그 실행에서 뜬 엔진 전부**가 죽었는지 관측한다(가정하지 않는다). 처음 pid 만 보면
    // 지킴이가 갈아 끼운 엔진이 새는 것을 놓친다. 닫은 **뒤에** pid 파일을 다시 읽는다 —
    // 턴 중에 찍어 둔 목록만 쓰면 그 뒤에 뜬 엔진(재기동·탐침)을 놓친다.
    // '전부 죽었다'는 판정은 **안정 상태**에서만 한다: 죽음이 확인되면 한 번 더 읽어 새 pid 가
    // 없을 때까지 반복하므로, 회수 직후에 뜬 프로세스도 다음 바퀴에서 대상이 된다.
    for (let i = 0; i < 120; i++) {
      pids = [...new Set([...readPids(pidFile), serving])].sort((x, y) => x - y)
      if (pids.some(alive)) { await new Promise((r) => setTimeout(r, 50)); continue }
      await new Promise((r) => setTimeout(r, 100))
      const again = [...new Set([...readPids(pidFile), serving])].sort((x, y) => x - y)
      if (again.join(',') === pids.join(',')) { pids = again; break }   // 새 pid 가 없다 = 안정
      pids = again
    }
    const survivors = pids.filter(alive)
    expect(survivors, `종료 뒤에도 엔진 자식이 살아 있다 pid=${survivors.join(',')}`).toEqual([])
    // "죽였는가"를 물을 대상이 실제로 있었는지 — 목록이 비면 위 단언은 공허하게 통과한다.
    expect(pids, '뜬 엔진이 하나도 관측되지 않았다 — 회수 여부를 물을 수 없다').not.toHaveLength(0)
    // 진단은 실제 배선에서 나온 것이어야 한다 — helper 시험에는 이 줄이 없다.
    // "정상 완료" 실행과 강제 마감 실행을 **구별**한다(검토 RT2-04).
    expect(log.read(), '종료 진단 줄이 없다 — before-quit 배선을 확인할 수 없다').toMatch(/\[shutdown\] 정리 완료 \d+ms/)
  } finally {
    if (!closed) {
      try { await electronApp.close() } catch { /* 이미 끝남 */ }
    }
    for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
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
