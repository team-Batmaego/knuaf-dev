// 그림 통로의 **앱 배선** — 실제 Electron 기동 시험.
//
// 앞선 시험(`figure-wiring.spec.ts`)은 `ChatService` 의 고리만 본다. `ipc.ts` 에서 통로를 열지
// 않고 `figures` 를 넘기지 않아도, `index.ts` 의 종료 목록에서 `figures.stop` 을 빼도 그것들은
// 통과한다. 이 시험은 **앱을 진짜로 띄워** 두 가지를 본다.
//
// ① 메인 턴 엔진에 실린 환경: `KNUAF_GUI=1`, `KNUAF_FIGURE_HOME=<userData>/figures`.
//    규칙집이 읽는 이름은 이 둘뿐이다(계약 §1). 엔진이 실제로 받은 값을 shim 이 적어 둔다.
// ② 앱이 뜨면 저장소 자리와 하트비트가 실제로 생기고, 종료하면 정리 목록에 `figures.stop` 이
//    남는다 — 통로를 열었으면 닫았다는 증거가 진단 줄에 있어야 한다.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, userDataWith, writeCliShim } from './fixtures/fake-codex'

/**
 * 뜬 엔진이 받은 두 값을 한 줄씩 남기는 shim.
 *
 * `fakeCodexEnv` 가 이미 `codex` 를 깔지만, 그 shim 은 값을 안 남긴다. 여기서 같은 이름으로
 * 덮어 **값을 남긴 뒤** 가짜 서버로 넘긴다. URL 로 넘기는 이유는 윈도우 `D:\…` 가 스킴으로
 * 읽히지 않게 하기 위해서다(`shutdown-wiring.spec.ts` 의 `pidWritingShim` 과 같은 이유).
 */
function envCapturingShim(bin: string, envFile: string): void {
  const proxy = join(bin, 'codex-env-proxy.mjs')
  const serverUrl = pathToFileURL(resolve(__dirname, 'fixtures/fake-codex-server.mjs')).href
  writeFileSync(proxy, [
    `import { appendFileSync } from 'node:fs'`,
    `appendFileSync(${JSON.stringify(envFile)}, JSON.stringify({`,
    `  pid: process.pid,`,
    `  gui: process.env.KNUAF_GUI ?? null,`,
    `  home: process.env.KNUAF_FIGURE_HOME ?? null`,
    `}) + '\\n')`,
    `await import(${JSON.stringify(serverUrl)})`
  ].join('\n'), 'utf-8')
  writeCliShim(bin, 'codex',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} "$@"`,
    `"${process.execPath}" "${proxy}" %*`)
}

type Captured = { pid: number; gui: string | null; home: string | null }

/** 엔진이 남긴 줄들. 반쯤 쓰인 마지막 줄은 버린다 — 잘린 JSON 은 없는 값이다. */
function captured(envFile: string): Captured[] {
  if (!existsSync(envFile)) return []
  const lines = readFileSync(envFile, 'utf-8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop()
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as Captured] } catch { return [] }
  })
}

test('메인 턴 엔진에 그림 환경 둘이 실리고, 종료에 통로가 정리 목록에 남는다', async () => {
  const dir = scratch(), bin = join(dir, 'bin')
  const envFile = join(dir, 'engine-env.jsonl')
  const turnPidLog = join(dir, 'turn-pids.txt')
  const env = fakeCodexEnv(bin, {
    FAKE_CODEX_MODE: 'logged-in',
    FAKE_CODEX_REPLY: replyFile(dir, '그림 자리를 확인했어요'),
    FAKE_CODEX_TURN_PID_LOG: turnPidLog
  })
  envCapturingShim(bin, envFile)
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  const figureHome = join(userData, 'figures')
  const root = synthProject()

  const { electronApp, page } = await launch({ env, userData })
  const chunks: string[] = []
  electronApp.process().stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
  electronApp.process().stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
  try {
    await openProject(page, root)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨')

    // 앱이 뜨면 저장소 자리와 하트비트가 실제로 생긴다 — 열지 못했으면 이 파일이 없다.
    expect(existsSync(figureHome), `그림 저장소가 없다: ${figureHome}`).toBe(true)
    const beat = join(figureHome, 'figure-channel.json')
    expect(existsSync(beat), '하트비트 파일이 없다 — 통로가 열리지 않았다').toBe(true)
    const beatState = JSON.parse(readFileSync(beat, 'utf-8')) as { v: number; updatedAt: number }
    expect(beatState.v).toBe(1)
    expect(typeof beatState.updatedAt).toBe('number')

    // 메인 턴을 한 번 돌려야 엔진이 뜬다(상태 확인은 턴이 없는 전역 연결이라 env 가 다르다).
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('그림 자리 확인')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('그림 자리를 확인했어요')).toBeVisible({ timeout: 30_000 })

    // **턴을 맡은 엔진**의 값만 본다. 앱은 턴과 무관한 전역 연결(상태 확인·로그인)에도 엔진을
    // 띄우는데, 그 엔진에는 그림 env 가 없는 게 설계다(턴이 없으니). 전부를 단언하면 그 정상
    // 동작이 실패가 되고, 반대로 아무 기록이나 보면 엉뚱한 엔진을 검사한다.
    await expect.poll(() => captured(envFile).length, { timeout: 15_000 }).toBeGreaterThan(0)
    const turnPids = existsSync(turnPidLog)
      ? [...new Set(readFileSync(turnPidLog, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number))]
      : []
    expect(turnPids.length, '턴을 맡은 엔진 pid 가 없다 — 가짜 엔진이 턴을 받지 않았다').toBeGreaterThan(0)
    for (const pid of turnPids) {
      const seen = captured(envFile).find((s) => s.pid === pid)
      expect(seen, `턴을 맡은 엔진 pid=${pid} 이 shim 을 지나지 않았다`).toBeTruthy()
      expect(seen!.gui, `KNUAF_GUI 가 실리지 않았다: pid=${pid} ${JSON.stringify(seen)}`).toBe('1')
      expect(seen!.home, `KNUAF_FIGURE_HOME 이 실리지 않았다: pid=${pid} ${JSON.stringify(seen)}`).toBe(figureHome)
    }
  } finally {
    await electronApp.close()
  }

  const log = chunks.join('')
  expect(log, '종료 진단 줄이 없다 — before-quit 배선을 확인할 수 없다').toMatch(/\[shutdown\] 정리 완료 \d+ms/)
  expect(log, '그림 통로가 정리 목록에 없다 — 앱이 통로를 열지 않았거나 stop 을 배선하지 않았다')
    .toMatch(/\[shutdown\] 정리 완료 \d+ms \([^)]*figures\.stop/)
})

test('통로를 못 열어도 앱은 뜨고 대화는 그대로 간다 — 그림 env 만 빠진다', async () => {
  const dir = scratch(), bin = join(dir, 'bin')
  const envFile = join(dir, 'engine-env.jsonl')
  const env = fakeCodexEnv(bin, { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '그림 없이도 답합니다') })
  envCapturingShim(bin, envFile)
  // 저장소 자리에 **파일**을 놓아 `mkdir` 이 실패하게 만든다(권한 조작은 CI·윈도우에서 흔들린다).
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  writeFileSync(join(userData, 'figures'), 'not a directory', 'utf-8')
  const root = synthProject()

  const { electronApp, page } = await launch({ env, userData })
  try {
    await openProject(page, root)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨')
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('그림 없이 질문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    // 대화는 지금까지와 같다 — 학생 화면에 그림 오류·알림이 없다.
    await expect(page.getByText('그림 없이도 답합니다')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => captured(envFile).length, { timeout: 15_000 }).toBeGreaterThan(0)
    for (const seen of captured(envFile)) {
      expect(seen.gui, `통로를 못 열었는데 그림 env 가 실렸다: ${JSON.stringify(seen)}`).toBeNull()
      expect(seen.home).toBeNull()
    }
  } finally {
    await electronApp.close()
  }
})
