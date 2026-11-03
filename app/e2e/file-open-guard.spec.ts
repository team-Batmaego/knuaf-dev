/**
 * "폴더에서 보기"/"연결 프로그램으로 열기"의 경로·형식·폴더 통로 시험(형님 확정 2026-11-03,
 * 독립검토 ATTACH-R1-01·03·04·06 반영).
 *
 * 화면(도우미 답변의 링크)은 문자열을 그대로 보내므로, 메인이 ① 지금 연 논문 폴더 안의
 * ② 실제로 있는 경로인지(심링크 해소 + 파일 신원) ③ 파일이면서 확장자가 허용 목록인지
 * 다시 본다. 폴더는 화면이 경로를 주지 않는 `folder:open` 으로만 연다 — `.app` 같은 실행형
 * 번들이 `openPath` 로 새지 않게 함이다.
 *
 * 한계: 윈도우 전용 성질(다른 드라이브·UNC·정션)은 macOS 에서 재현할 수 없어 코드와 단위
 * 시험(`file-identity.spec.ts`)으로만 덮인다.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { launch, navTo, openProject, seedChat, shellCalls, spyShell, synthProject } from './helpers'

interface Reply {
  result?: { opened?: boolean; revealed?: boolean; reason?: string }
  error?: { code: string; message: string }
}

const invoke = (page: Page, method: 'reveal' | 'openPath' | 'openFileLink', target: string): Promise<Reply> =>
  page.evaluate(({ method, target }: { method: 'reveal' | 'openPath' | 'openFileLink'; target: string }) => {
    // 시험은 렌더러의 전역 브리지를 페이지 안에서 직접 부른다 — 이 파일은 tsconfig 밖이라
    // preload 의 Window 선언을 받지 못하므로, 부르는 모양만 최소한으로 적는다.
    const api = (window as unknown as { knuaf: Record<string, (p: string) => Promise<Reply>> }).knuaf
    return api[method](target)
  }, { method, target })

/** 폴더 열기 — 경로가 아니라 이름만 넘긴다. */
const openFolder = (page: Page, kind: string): Promise<{ result?: { revealed?: boolean }; error?: { code: string; message: string } }> =>
  page.evaluate((kind: string) => {
    const api = (window as unknown as { knuaf: { folderOpen: (k: string) => Promise<{ result?: { revealed?: boolean }; error?: { code: string; message: string } }> } }).knuaf
    return api.folderOpen(kind)
  }, kind)

function plant(root: string, rel: string, body = 'x\n'): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf-8')
  return rel
}

test('경로 검사: 폴더 밖·심링크·없는 경로는 열지도 보여 주지도 않는다', async () => {
  const root = synthProject()
  const outside = mkdtempSync(join(tmpdir(), 'kd-out-'))
  writeFileSync(join(outside, 'secret.txt'), '밖\n', 'utf-8')
  const inside = plant(root, 'build/notes.txt')
  const link = 'build/링크.txt'
  symlinkSync(join(outside, 'secret.txt'), join(root, link))
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')
  const clear = (): void => writeFileSync(log, '')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)

    // ① 폴더 안의 실제 파일은 통과한다.
    clear()
    expect((await invoke(page, 'reveal', inside)).result, '폴더 안 파일을 거절했다').toBeTruthy()
    expect(await shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, inside))}`])

    // ② 폴더 밖 절대경로.
    clear()
    for (const method of ['reveal', 'openPath', 'openFileLink'] as const)
      expect((await invoke(page, method, join(outside, 'secret.txt'))).error?.code, `${method} 가 폴더 밖을 통과시켰다`).toBe('invalid_params')
    expect(await shellCalls(log), '폴더 밖 경로로 shell 을 불렀다').toEqual([])

    // ③ `..` 로 빠지는 상대경로(실제로 있는 파일).
    clear()
    const escape = relative(root, join(outside, 'secret.txt'))
    expect(escape.startsWith('..'), '시험 전제: 상대경로가 폴더 밖을 가리킨다').toBe(true)
    expect((await invoke(page, 'reveal', escape)).error?.code).toBe('invalid_params')
    expect((await invoke(page, 'openFileLink', escape)).error?.code).toBe('invalid_params')
    expect(await shellCalls(log)).toEqual([])

    // ④ 폴더 안의 심링크가 밖을 가리키는 경우.
    clear()
    for (const method of ['reveal', 'openPath', 'openFileLink'] as const)
      expect((await invoke(page, method, link)).error?.code, `${method} 가 심링크 밖 경로를 통과시켰다`).toBe('invalid_params')
    expect(await shellCalls(log)).toEqual([])

    // ⑤ 없는 파일.
    clear()
    for (const method of ['reveal', 'openPath', 'openFileLink'] as const)
      expect((await invoke(page, method, 'build/없는파일.md')).error?.code, `${method} 가 없는 파일을 통과시켰다`).toBe('invalid_params')
    expect(await shellCalls(log)).toEqual([])

    // ⑥ 폴더는 문서 열기로 가지 않는다 — 화면이 경로를 주지 않는 folder:open 으로만 연다.
    clear()
    expect((await invoke(page, 'reveal', root)).result).toBeTruthy()
    expect((await invoke(page, 'openPath', root)).error?.code, '폴더를 문서 열기로 통과시켰다').toBe('not_openable')
    expect((await openFolder(page, 'project')).result, '논문 폴더를 열지 못했다').toEqual({ revealed: false })
    expect((await openFolder(page, 'outside')).error?.code, '임의 폴더 이름을 통과시켰다').toBe('not_found')
    expect(await shellCalls(log)).toEqual([`reveal\t${realpathSync(root)}`, `open\t${realpathSync(root)}`])
  } finally {
    await electronApp.close()
  }
})

test('확장자 검사: 문서만 열고, 대소문자·끝 점·이중 확장자로 우회하지 못한다', async () => {
  const root = synthProject()
  plant(root, 'build/notes.txt')
  plant(root, 'build/UPPER.TXT')
  plant(root, 'build/payload.EXE')
  plant(root, 'build/report.txt.exe')
  plant(root, 'build/report.exe.txt')
  plant(root, 'build/notes.txt.')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')
  const clear = (): void => writeFileSync(log, '')
  const open = async (rel: string): Promise<Reply> => invoke(page, 'openPath', rel)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)

    clear()
    expect((await open('build/notes.txt')).result?.opened, 'txt 를 열지 않았다').toBe(true)
    expect((await open('build/UPPER.TXT')).result?.opened, '대문자 확장자를 열지 않았다').toBe(true)
    expect(await shellCalls(log)).toEqual([
      `open\t${realpathSync(join(root, 'build/notes.txt'))}`,
      `open\t${realpathSync(join(root, 'build/UPPER.TXT'))}`
    ])

    // 실행 파일·이중 확장자·끝 점은 열지 않는다(끝 점은 macOS 에서 실제 파일명이다).
    clear()
    for (const rel of ['build/payload.EXE', 'build/report.txt.exe', 'build/notes.txt.'])
      expect((await open(rel)).error?.code, `${rel} 를 열었다`).toBe('not_openable')
    expect(await shellCalls(log)).toEqual([])

    // 마지막 확장자만 본다 — `a.exe.txt` 는 텍스트로 연다.
    clear()
    expect((await open('build/report.exe.txt')).result?.opened).toBe(true)
    expect(await shellCalls(log)).toEqual([`open\t${realpathSync(join(root, 'build/report.exe.txt'))}`])

    // 대화 단추 경로: 열지 않는 형식은 열지 않고 **폴더에서 보여 준다**.
    clear()
    const r = await invoke(page, 'openFileLink', 'build/payload.EXE')
    expect(r.result).toMatchObject({ opened: false, revealed: true, reason: 'extension' })
    expect(await shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, 'build/payload.EXE'))}`])
  } finally {
    await electronApp.close()
  }
})

test('실행형 번들(.app)은 디렉터리라는 이유로 열리지 않는다 (ATTACH-R1-01)', async () => {
  const root = synthProject()
  const bundle = 'build/ReviewProbe.app'
  plant(root, `${bundle}/Contents/Info.plist`, '<plist/>\n')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')
  const clear = (): void => writeFileSync(log, '')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)

    clear()
    expect((await invoke(page, 'openPath', bundle)).error?.code, '.app 번들이 문서 열기로 통과했다').toBe('not_openable')
    expect(await shellCalls(log), '.app 번들을 openPath 로 보냈다').toEqual([])

    // 대화 단추는 열지 않고 폴더에서 선택해 보여 준다.
    const r = await invoke(page, 'openFileLink', bundle)
    expect(r.result).toMatchObject({ opened: false, revealed: true, reason: 'extension' })
    expect(await shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, bundle))}`])
  } finally {
    await electronApp.close()
  }
})

test('대화의 .app 링크는 화면에서도 열지 않고 폴더에서 보여 준다 (ATTACH-R1-01)', async () => {
  const root = synthProject()
  plant(root, 'build/ReviewProbe.app/Contents/Info.plist', '<plist/>\n')
  seedChat(root, '첨부했어요. [ReviewProbe.app](build/ReviewProbe.app)')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await page.getByRole('button', { name: 'ReviewProbe.app' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, 'build/ReviewProbe.app'))}`])
  } finally {
    await electronApp.close()
  }
})

test('논문 폴더 자체가 .app 번들이면 폴더 열기는 reveal 로만 한다 (ATTACH-R1-01 2차)', async () => {
  const base = synthProject()
  const bundle = `${base}.app`
  renameSync(base, bundle)
  mkdirSync(join(bundle, 'Contents'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>\n', 'utf-8')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, bundle)
    await spyShell(electronApp, log)
    // 사이드바의 실제 폴더 열기 — 논문 폴더가 곧 실행형 번들인 경우.
    await page.getByRole('button', { name: process.platform === 'darwin' ? 'Finder에서 열기' : '파일 탐색기에서 열기' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(bundle)}`])

    // IPC 로도 같다 — 열지 않고 보여 주기만.
    writeFileSync(log, '')
    expect((await openFolder(page, 'project')).result).toEqual({ revealed: true })
    expect(await shellCalls(log)).toEqual([`reveal\t${realpathSync(bundle)}`])
  } finally {
    await electronApp.close()
  }
})

test('열기 응답을 기다린 뒤 경로가 바뀌면 대체 표시도 하지 않는다 (ATTACH-R1-03)', async () => {
  const root = synthProject()
  plant(root, 'build/memo.txt')
  const outside = mkdtempSync(join(tmpdir(), 'kd-swap-'))
  writeFileSync(join(outside, 'memo.txt'), '밖\n', 'utf-8')
  const before = realpathSync(join(root, 'build/memo.txt'))
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')
  const swap = { move: join(root, 'build'), to: join(root, 'build-orig'), symlink: join(root, 'build'), target: outside }
  const restore = (): void => { rmSync(join(root, 'build')); renameSync(join(root, 'build-orig'), join(root, 'build')) }

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log, { openFailure: 'Failed to open path', swapOnOpen: swap })

    // 대화 단추 경로 — 열기 실패 뒤 재검사에서 대상이 밖으로 바뀐 것을 보고 대체 표시를 중단한다.
    const link = await invoke(page, 'openFileLink', 'build/memo.txt')
    expect(link.error?.code, '바뀐 경로로 폴더에서 보여 줬다').toBe('changed')
    expect(await shellCalls(log)).toEqual([`open\t${before}`])
    restore()

    // 결과물 '원래 앱으로 열기' 경로도 같은 재검사를 쓴다.
    writeFileSync(log, '')
    const open = await invoke(page, 'openPath', 'build/memo.txt')
    expect(open.error?.code).toBe('changed')
    expect(await shellCalls(log)).toEqual([`open\t${before}`])
  } finally {
    await electronApp.close()
  }
})

test('설정의 로그 폴더 열기는 메인이 정한 로그 폴더로 동작한다 (ATTACH-R1-04)', async () => {
  const root = synthProject()
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    const logs = await electronApp.evaluate(({ app }) => app.getPath('logs'))
    await navTo(page, '설정')
    await page.getByRole('button', { name: '로그 폴더 열기' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`open\t${realpathSync(logs)}`])
  } finally {
    await electronApp.close()
  }
})

test('연결 프로그램이 없으면 열기를 포기하고 폴더에서 보여 준다', async () => {
  const root = synthProject()
  plant(root, 'build/notes.txt')
  const log = join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log, { openFailure: 'no application associated' })
    const r = await invoke(page, 'openFileLink', 'build/notes.txt')
    // 원인을 단정하지 않는다 — OS 열기 실패라는 사실만 담는다(ATTACH-R1-07).
    expect(r.result).toMatchObject({ opened: false, revealed: true, reason: 'open_failed' })
    expect(await shellCalls(log)).toEqual([
      `open\t${realpathSync(join(root, 'build/notes.txt'))}`,
      `reveal\t${realpathSync(join(root, 'build/notes.txt'))}`
    ])
  } finally {
    await electronApp.close()
  }
})