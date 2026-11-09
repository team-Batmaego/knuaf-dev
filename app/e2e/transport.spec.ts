// Unit test for src/main/chat/transport.ts — plain Playwright `test()` in Node: no Electron.
//
// 윈도우에서 `winSpawn` 은 `.cmd`/`.bat` 를 `cmd.exe` 로 감싼다. 그러면 transport 의 자식은
// cmd.exe 이고 실제 도구는 **손자**다 — stop() 이 cmd.exe 만 죽이면 도구가 고아로 남는다
// (윈도우 CI 4차: 잡 정리에서 `Terminate orphan process: node`). 이 시험이 그 반례를 고정한다.
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProcess } from '../src/main/chat/transport'
import { taskkillPath } from '../src/main/win'
import { writeCliShim } from './fixtures/fake-codex'

/** 살아 있는지 — 신호 0 은 죽이지 않고 존재만 본다. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(ok: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 20)) }
  return ok()
}

/**
 * 가짜 도구(자기 pid 를 남기고 살아 있는다)를 transport 로 띄우고 stop 한 뒤, 그 프로세스가
 * 죽었는지 본다. 윈도우에서는 `winSpawn` 이 cmd.exe 로 감싸므로 이 pid 는 **손자**다.
 */
async function expectTreeKilled(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kd-transport-'))
  const pidFile = join(dir, 'tool.pid')
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TOOL_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`, 'utf-8')
  writeCliShim(dir, 'fake',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
    `"${process.execPath}" "${runner}"`)
  const binary = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake')
  const rpc = new JsonRpcProcess(binary, [], dir, { ...env, TOOL_PID_FILE: pidFile })
  try {
    expect(await until(() => existsSync(pidFile)), '가짜 도구가 뜨지 않았다').toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid), '가짜 도구가 살아 있지 않다').toBe(true)

    await rpc.stop()

    // stop 뒤에 도구 프로세스가 살아 있으면 안 된다 — 윈도우에서 cmd.exe 만 죽이면 고아로 남는다.
    expect(await until(() => !alive(pid)), 'stop 뒤에도 도구 프로세스가 살아 있다(고아)').toBe(true)
  } finally {
    void rpc.stop().catch(() => {})
  }
}

test('stop 은 감싼 도구의 프로세스 트리까지 끝낸다 — 고아를 남기지 않는다 (W1 ①)', async () => {
  await expectTreeKilled(process.env)
})

/**
 * 윈도우 CI 5차의 반례: 앱이 좁은 PATH 로 떠 있으면(PATH 에 System32 없음) `taskkill` 을
 * **이름으로** 찾던 종전 구현은 못 찾아 cmd.exe 만 죽였고 손자가 살아남았다. 이제는 절대
 * 경로(`SystemRoot\System32\taskkill.exe`)로 부르므로 PATH 와 무관하다.
 */
test('PATH 에 System32 가 없어도 트리째 끝낸다 — taskkill 절대 경로 (W1 ①)', async () => {
  const saved = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'kd-nopath-'))   // System32 가 없는 PATH
  try {
    await expectTreeKilled(process.env)
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

test('taskkill 경로는 SystemRoot → windir → C:\\Windows 순 (W1 ①)', () => {
  expect(taskkillPath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe')
  expect(taskkillPath({ windir: 'E:\\Win' })).toBe('E:\\Win\\System32\\taskkill.exe')
  expect(taskkillPath({ SystemRoot: 'F:\\W', windir: 'E:\\Win' }), 'SystemRoot 가 먼저다').toBe('F:\\W\\System32\\taskkill.exe')
  expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe')
  // 끝 구분자가 있어도 두 번 붙지 않는다.
  expect(taskkillPath({ SystemRoot: 'G:\\Windows\\' })).toBe('G:\\Windows\\System32\\taskkill.exe')
})

/**
 * 종료는 상한 안에 끝나고 대기 중인 요청은 거절이 되어야 한다. 'exit'가 늦게 와도
 * pending 45s 타이머가 메인을 붙잡고 있지 않게 — 윈도우에서 kill이 'exit'를 못 만들면
 * 이 계약이 e2e close hang(codex-relogin teardown)으로 번진다. 타임아웃 경로까지 끝나는지 본다.
 */
test('stop 은 exit가 늦어도 6초 안에 닫히고 대기 요청은 거절한다 (RT)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-transport-stop-'))
  const pidFile = join(dir, 'tool.pid')
  const runner = join(dir, 'runner.mjs')
  // SIGTERM을 오래 붙잡는 도구: stop의 kill이 바로 'exit'로 번지지 않는 경우.
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\nprocess.on('SIGTERM', () => {})\nwriteFileSync(process.env.TOOL_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`, 'utf-8')
  writeCliShim(dir, 'fake',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
    `"${process.execPath}" "${runner}"`)
  const binary = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake')
  const rpc = new JsonRpcProcess(binary, [], dir, { ...process.env, TOOL_PID_FILE: pidFile })
  try {
    expect(await until(() => existsSync(pidFile)), '가짜 도구가 뜨지 않았다').toBe(true)
    // 응답 없이 매달린 요청 — stop이 이 45s 타이머를 clear해야 worker가 끝나지 않는다.
    const pending = rpc.request('account/read', {})
    const rejection = expect(pending).rejects.toThrow()
    const start = Date.now()
    await rpc.stop()
    expect(Date.now() - start).toBeLessThan(6_000)
    expect(rpc.closed).toBe(true)
    await rejection
  } finally {
    void rpc.stop().catch(() => {})
  }
})

/**
 * killTree 실패로 'exit'가 끝내 오지 않는 결정적 반례(RT 2회차 중요 1).
 * killFn을 바꿔 끼워 t2 경로를 플랫폼과 무관하게 밟는다. 수정 전(t2 resolve만 있고
 * finish 없음)에는 closed·pending 거절·onClose가 모두 일어나지 않아 이 시험이 실패한다.
 * 시험이 끝난 뒤 worker(부모)가 정상 종료되면 자식 핸들이 더 이상 부모를 붙잡지 않는다는 뜻이다.
 */
test('kill이 exit를 못 만들면 t2가 닫고 pending을 거절하며 onClose를 한 번만 부른다 (RT2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-transport-nokill-'))
  const pidFile = join(dir, 'tool.pid')
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TOOL_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`, 'utf-8')
  writeCliShim(dir, 'fake',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
    `"${process.execPath}" "${runner}"`)
  const binary = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake')
  let onCloseCalls = 0
  const rpc = new JsonRpcProcess(binary, [], dir, { ...process.env, TOOL_PID_FILE: pidFile }, { killFn: () => {} })
  rpc.onClose = () => { onCloseCalls++ }
  try {
    expect(await until(() => existsSync(pidFile)), '가짜 도구가 뜨지 않았다').toBe(true)
    // 응답 없이 매달린 요청 — t2가 clear해야 worker 타이머(45s)가 끝나지 않는다.
    const pending = rpc.request('account/read', {})
    const rejection = expect(pending).rejects.toThrow('AI 연결이 종료됐어요')
    const start = Date.now()
    await rpc.stop()
    expect(Date.now() - start).toBeLessThan(6_000)
    expect(rpc.closed).toBe(true)
    expect(onCloseCalls).toBe(1)
    await rejection
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf-8')), 'SIGKILL') } catch { /* 이미 죽었거나 없음 */ }
    void rpc.stop().catch(() => {})
  }
})
