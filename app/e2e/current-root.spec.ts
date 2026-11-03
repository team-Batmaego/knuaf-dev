/**
 * 허용 기준 폴더 수명 시험(검토 ATTACH-R1-05).
 *
 * 메인의 파일 검사 기준은 **마지막으로 성공한 `project:open`** 의 폴더다. 실패한 전환은
 * 기준을 바꾸지 않아야 한다 — 그러지 않으면 화면은 A 논문인데 메인은 B 를 허용한다.
 * 여기서는 실행기를 실행할 수 없는 경로로 바꿔 전환을 실제로 실패시킨 뒤, A 는 열리고 B 는
 * 거절되는지 본다. 화면(store)은 실패한 `open` 에서 기존 root 를 유지하는 기존 시험이 따로 있다.
 */
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { launch, openProject, python, shellCalls, spyShell, synthProject } from './helpers'

interface OpenReply {
  result?: { root: string; hasProject: boolean }
  error?: { code: string; message: string }
  startupFailed?: boolean
}

interface Reply { result?: { opened?: boolean }; error?: { code: string; message: string } }

const plant = (root: string, rel: string): void => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '메모\n', 'utf-8')
}

/** 렌더러 브리지를 페이지 안에서 직접 부른다(이 파일은 tsconfig 밖). */
const bridge = <T>(page: Page, call: string, arg: unknown): Promise<T> =>
  page.evaluate(({ call, arg }: { call: string; arg: unknown }) => {
    const api = (window as unknown as { knuaf: Record<string, (a: unknown) => Promise<unknown>> }).knuaf
    return api[call](arg) as Promise<unknown>
  }, { call, arg }) as Promise<T>

/**
 * renderer 는 **모든** 열기 요청에서 자기 세대를 올린다(store/project.ts). 메인도 요청이
 * 도착한 순간(존재 확인보다 먼저) 세대를 올려야, 진행 중이던 B 뒤에 없는 경로 C 가 와도
 * 늦게 성공한 B 가 허용 기준·창 제목을 바꾸지 않는다.
 */
test('뒤에 온 없는 경로 요청도 진행 중이던 전환을 무효화한다 (ATTACH-R1-05 2차)', async () => {
  const a = synthProject()
  const b = synthProject({ withContent: false })
  plant(a, 'memo.txt')
  plant(b, 'memo.txt')
  const missing = join(mkdtempSync(join(tmpdir(), 'kd-missing-')), '없는폴더')
  const gate = mkdtempSync(join(tmpdir(), 'kd-gate-'))
  const trigger = join(gate, 'go')
  const started = join(gate, 'started')
  // B 의 사이드카 시작만 잡아 두는 실행기 — C 요청을 그 사이에 넣기 위한 시험 대역이다.
  const wrapper = join(gate, 'slow-python.sh')
  writeFileSync(wrapper, `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${trigger}" ]; do sleep 0.05; done\nexec "${python}" "$@"\n`, 'utf-8')
  chmodSync(wrapper, 0o755)
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, a)
    await spyShell(electronApp, log)
    await bridge(page, 'setSettings', { python_override: wrapper })

    // B 를 기다리지 않고 시작한다. 실행기가 started 를 만들 때까지 B 는 시작 중이다.
    const pendingB = bridge<OpenReply>(page, 'openProject', b)
    await expect.poll(() => existsSync(started), { timeout: 15_000 }).toBe(true)

    // 그 사이 없는 경로 C — renderer 의 세대를 올리는 요청이다.
    const c = await bridge<OpenReply>(page, 'openProject', missing)
    expect(c.error?.code).toBe('not_found')

    writeFileSync(trigger, '')
    expect((await pendingB).result?.root, 'B 의 성공 응답이 오지 않았다').toBe(b)

    // 늦게 성공한 B 는 허용 기준도 창 제목도 바꾸지 않는다 — 화면은 A 다.
    expect((await bridge<Reply>(page, 'openFileLink', join(a, 'memo.txt'))).result?.opened, 'A 를 열지 못했다').toBe(true)
    expect((await bridge<Reply>(page, 'openFileLink', join(b, 'memo.txt'))).error?.code, '무효화된 B 가 허용 기준이 됐다').toBe('invalid_params')
    const title = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    expect(title, '늦은 B 가 창 제목을 바꿨다').toContain(basename(a))
    expect(title).not.toContain(basename(b))
  } finally {
    await electronApp.close()
  }
})

test('실패한 폴더 전환은 메인의 허용 기준을 바꾸지 않는다 (ATTACH-R1-05)', async () => {
  const a = synthProject()
  const b = synthProject({ withContent: false })
  plant(a, 'memo.txt')
  plant(b, 'memo.txt')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')
  // 존재하지만 실행할 수 없는 파일 — 이걸 실행기로 지정하면 다음 열기가 실패한다.
  const bogus = join(mkdtempSync(join(tmpdir(), 'kd-bogus-')), 'python')
  writeFileSync(bogus, '#!/bin/sh\nexit 1\n', 'utf-8')
  chmodSync(bogus, 0o000)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, a)
    await spyShell(electronApp, log)

    await bridge(page, 'setSettings', { python_override: bogus })
    const failed = await bridge<OpenReply>(page, 'openProject', b)
    expect(failed.error, '실행기를 실행할 수 없는데 폴더 전환이 성공했다').toBeTruthy()
    expect(failed.startupFailed, '실패한 전환이 startupFailed 로 오지 않았다').toBe(true)

    // 기준은 여전히 A — A 는 열리고 B 는 거절된다.
    expect((await bridge<Reply>(page, 'openFileLink', join(a, 'memo.txt'))).result?.opened, 'A 를 열지 못했다').toBe(true)
    expect((await bridge<Reply>(page, 'openFileLink', join(b, 'memo.txt'))).error?.code, '실패한 B 가 허용 기준이 됐다').toBe('invalid_params')
    expect(await shellCalls(log), '허용된 호출은 A 하나뿐이어야 한다').toHaveLength(1)
  } finally {
    await electronApp.close()
  }
})