/**
 * 화면 묶음 A — 뷰어 직접 수정 (ORDER-IMPL-2A, 설계 §3·§4-5-6).
 *
 * 진짜 앱을 띄워 sidecar 의 `section.edit` 을 실제로 부른다. 여기서 보는 것:
 *   ① 드래그 → 막대에 `직접 수정` → 그 글자 자리에 편집칸이 열린다
 *   ② 저장하면 글이 바뀌고 `고쳤어요.` 한 줄이 남는다(되돌리기 단추는 없다 — §4-5-6)
 *   ③ 취소하면 원고가 그대로다
 *   ④ 고치지 않는 학생의 화면은 그대로다(막대 밖에서 단추가 늘어나지 않는다)
 *
 * 구역·토글·잠금 같은 다른 축은 건드리지 않는다 — 이 파일은 이 기능 하나만 잠근다.
 */
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { addSectionBody, launch, openProject, paperReady, synthProject, rewriteSection } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'
import type { RpcResult, SectionRow, Status } from '../src/shared/types'

type ViewerEditProbe = { sent: Record<string, unknown> | null }
type ViewerEditHost = typeof globalThis & { __viewerEdit: ViewerEditProbe }
type SavePollHost = typeof globalThis & { __savePoll: { held: boolean; statusReads: number; release: () => void } }
type ProjectProbe = { root: string | null; revision: number | null }

/**
 * 지금 창의 렌더러 store 가 들고 있는 (폴더, 개정).
 *
 * `main.tsx` 가 시험 신호가 켜진 실행에서만 `window.__knuafProjectProbe` getter 로 내보낸다
 * (읽기 전용, 쓰기·함수 없음). 통로가 없으면 null — 제품 실행이 그렇다. IPC 응답을 세는
 * 대신 store 값을 직접 읽으므로, 응답이 늦게 반영돼 버려지는 경우(`store/project.ts` 의
 * `refresh`)에도 "화면이 실제로 무엇을 보고 있는가"를 잰다(검토 roh292 중요 1).
 */
async function readProjectProbe(page: Page): Promise<ProjectProbe | null> {
  return page.evaluate(() => {
    const host = window as unknown as { __knuafProjectProbe?: ProjectProbe }
    const probe = host.__knuafProjectProbe
    return probe ? { root: probe.root, revision: probe.revision } : null
  })
}

/**
 * 도우미 연결이 **확인된** 상태로 앱을 띄운다. 막대(`.selbar`)는 연결이 끊겨 있으면 서지 않는다 —
 * `zoneOf` 가 `disconnected` 를 돌려주고 `canQuote` 가 거짓이 된다. CI 에는 codex 가 없으므로
 * 이 시험은 가짜 CLI 를 PATH 앞자리에 심어 실제 기계와 같은 장면을 만든다.
 */
async function launchEdit() {
  const dir = scratch()
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in' })
  return launch({ env })
}


/**
 * 기록만 올린다(본문·지문은 그대로). 저장이 `expected_revision` 대조에서 거절되는 장면을
 * 만들 때 쓴다 — 원고를 다시 쓰면 '그사이 글이 바뀐' 것이 아니라 '지문이 바뀐' 것이 된다.
 */
function bumpRevision(root: string, expected: number): void {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const { python, scripts } = require('./helpers') as typeof import('./helpers')
  const change = join(root, `change-bump-${expected}.json`)
  writeFileSync(change, JSON.stringify({ request_id: `e2e:bump:${expected}`, ops: [
    { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } }
  ] }), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', change, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

/** 그 글자를 담은 문단을 고른다(화면 선택과 같은 경로 — `mouseup` 이 선택을 읽는다). */
async function selectParagraph(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const p = [...document.querySelectorAll('.sheet p')].find((el) => (el.textContent ?? '').includes(text))
    if (!p) throw new Error(`문단을 찾지 못했다: ${text}`)
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, needle)
}

/** 문단 안의 한 토막만 고른다 — 드래그 대신 Range 로 같은 자리를 만든다. */
async function selectText(page: Page, needle: string, phrase: string): Promise<void> {
  await page.evaluate(({ text, piece }) => {
    // 문단(`p`)뿐 아니라 비교 보기의 `del`·`ins`·`div.blk` 도 고른다 — 화면 글자면 된다.
    const p = [...document.querySelectorAll('.sheet p, .sheet .blk, .sheet .rev-segs')]
      .find((el) => (el.textContent ?? '').includes(text))
    if (!p) throw new Error(`문단을 찾지 못했다: ${text}`)
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    while (node && !(node.nodeValue ?? '').includes(piece)) node = walker.nextNode()
    if (!node) throw new Error(`글자를 찾지 못했다: ${piece}`)
    const at = (node.nodeValue ?? '').indexOf(piece)
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + piece.length)
    const sel = window.getSelection()
    if (!sel) throw new Error('선택을 만들 수 없다')
    sel.removeAllRanges(); sel.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, { text: needle, piece: phrase })
}

test('드래그 → 직접 수정 → 저장하면 그 글자만 바뀌고 "고쳤어요." 한 줄이 남는다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await page.clock.install()
    await openProject(page, root)
    await paperReady(page, '600평')

    // 고르기 전에는 막대에 `직접 수정` 이 없다(선택이 있어야 뜬다).
    await expect(page.locator('.selbar')).toHaveCount(0)
    await selectText(page, '600평', '600평')

    const bar = page.locator('.selbar')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    const editButton = bar.getByRole('button', { name: '직접 수정' })
    await expect(editButton).toBeVisible()
    await expect(editButton).not.toHaveAttribute('data-blocked', /.*/)

    await editButton.click()
    // 편집칸이 그 글자 자리에 열리고, 그 글자가 미리 들어가 전체 선택돼 있다.
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(input).toHaveValue('600평')
    await expect(input).toBeFocused()

    await input.fill('700평')
    // Hold the real committed edit response and explicitly run the renderer's polling timer.
    await electronApp.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => Promise<unknown>
      // Electron's private registry is the existing IPC interception seam.
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      const real = ipc._invokeHandlers.get('rpc')!
      const gate = Promise.withResolvers<void>()
      const state = { held: false, statusReads: 0, release: gate.resolve }
      const host = globalThis as SavePollHost
      host.__savePoll = state
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        const reply = await real(...args)
        if (args[1] === 'section.edit') { state.held = true; await gate.promise }
        if (args[1] === 'project.status' && state.held) state.statusReads++
        return reply
      })
    })
    await input.press('Enter')
    await expect.poll(() => electronApp.evaluate(() => {
      const host = globalThis as SavePollHost
      return host.__savePoll.held
    })).toBe(true)
    await page.clock.runFor(2100)
    await expect.poll(() => electronApp.evaluate(() => {
      const host = globalThis as SavePollHost
      return host.__savePoll.statusReads
    })).toBeGreaterThan(0)
    await electronApp.evaluate(() => {
      const host = globalThis as SavePollHost
      host.__savePoll.release()
    })

    // 저장 → 편집칸이 닫히고 종이에 새 글자가 보인다.
    await expect(page.locator('.edit-slot-input')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.paperpane .sheet')).toContainText('700평', { timeout: 30_000 })
    // 저장 뒤 한 줄은 `고쳤어요.` — 되돌리기 단추는 없다(§4-5-6).
    const line = page.locator('.paper-fb.edit-line')
    await expect(line).toContainText('고쳤어요', { timeout: 15_000 })
    await expect(page.getByRole('button', { name: '되돌리기' })).toHaveCount(0)
    // 채팅에 "고쳤어요" 이벤트 줄이 생기지 않는다(§3-3 noteOwnEdit).
    await expect(page.locator('.chat-pane')).not.toContainText('곳을 고쳤어요')
  } finally {
    await electronApp.close()
  }
})

test('직접 수정 저장에 정리 경고가 있으면 반영된 본문과 함께 경고를 보인다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await electronApp.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => Promise<RpcResult<Record<string, unknown>>>
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      const real = ipc._invokeHandlers.get('rpc')!
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        const reply = await real(...args)
        if (args[1] === 'section.edit' && reply.result) return { ...reply, result: { ...reply.result, cleanup_warning: 'release_cleanup_failed' } }
        return reply
      })
    })
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await input.fill('700평')
    await input.press('Enter')
    await expect(page.locator('.paperpane .sheet')).toContainText('700평', { timeout: 30_000 })
    await expect(page.locator('.paper-fb .make-fb.warning')).toContainText('작업은 반영됐지만 정리가 남았어요.')
    await expect(page.locator('.paper-fb .make-fb.warning')).toContainText('같은 작업을 바로 반복하지 말고')
  } finally {
    await electronApp.close()
  }
})

test('편집칸에서 취소하면 원고가 그대로다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()

    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    await input.press('Escape')

    await expect(page.locator('.edit-slot-input')).toHaveCount(0)
    // 종이는 그대로 — 원고가 바뀌지 않았다.
    await expect(page.locator('.paperpane .sheet')).toContainText('600평')
    await expect(page.locator('.paperpane .sheet')).not.toContainText('700평')
  } finally {
    await electronApp.close()
  }
})

test('고친 곳이 없으면 종이 머리에 목록 단추가 없다 — 고치지 않는 학생의 화면은 그대로다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paper-head').getByRole('button', { name: /직접 고친 곳/ })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('확인이 필요한 고침은 "직접 고친 곳 1" 과 확인 전 목록으로 보인다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    // 숫자를 바꾸면 `needs_check` — 확인 전이 된다(설계 §2-2).
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    await page.getByRole('button', { name: '저장', exact: true }).click()

    const listButton = page.locator('.paper-head').getByRole('button', { name: '직접 고친 곳 1' })
    await expect(listButton).toBeVisible({ timeout: 30_000 })
    await listButton.click()
    await expect(page.locator('.edit-row')).toHaveCount(1)
    await expect(page.locator('.edit-row .state')).toHaveText('확인 전')
    // 되돌리기는 목록에도 없다.
    await expect(page.locator('.edit-row').getByRole('button', { name: '되돌리기' })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('복구 알림은 확인을 누를 때까지 남고, 누르면 사라진다', async () => {
  const root = synthProject()
  // §4-5-2 첫 줄 그대로의 상태를 **앱을 켜기 전에** 만든다(앱이 꺼진 사이와 같다):
  // 원고 자리는 비었고 `displaced-1` 에 A 가 있다. 첫 화면 읽기가 복구 입구다.
  const { createHash } = await import('node:crypto')
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const raw = join(root, 'sections', '01.md')
  const original = fs.readFileSync(raw)
  const bundle = join(root, '.knuaf-gui', 'edit-backup', 'edit-restored')
  fs.mkdirSync(bundle, { recursive: true })
  fs.writeFileSync(join(bundle, 'displaced-1-0'), original)
  const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
  fs.appendFileSync(join(root, '.knuaf-gui', 'student-edits.jsonl'), JSON.stringify({
    edit_id: 'edit-restored', request_id: 'app:student-edit:sec-01:1:deadbeefdead',
    at: '2024-01-01T00:00:00+00:00', revision_before: 1, revision_after: null,
    edits: [{ section_id: 'sec-01', before_block: '600평이다.', after_block: '700평이다.' }],
    needs_check: null, new_issues: [], state: 'writing',
    files: [{ n: 0, section_id: 'sec-01', path: 'sections/01.md', sha_a: sha(original), sha_c: '1'.repeat(64) }]
  }) + '\n', 'utf-8')
  fs.unlinkSync(raw)

  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    // 첫 화면 읽기가 복구한다 — 원고는 A 로 돌아오고 알림이 남는다.
    await paperReady(page, '600평')
    const notice = page.locator('.edit-notice').first()
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toContainText('원고')
    expect(fs.readFileSync(raw, 'utf-8')).toContain('600평')

    const confirm = notice.getByRole('button', { name: '확인' })
    await expect(confirm).toBeVisible()
    await confirm.click()
    await expect(page.locator('.edit-notice')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await electronApp.close()
  }
})

test('고친 부분 보기를 켜면 직접 수정이 흐려지고 이유를 말한다', async () => {
  const { rewriteSection } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    // 도우미가 본문을 다시 저장하면 비교 모드가 켜진다(바뀐 절이 있다).
    rewriteSection(root, { body: '농장A의 재배 면적은 800평이다. 정읍 일대 기후를 고려해 작목을 선택했다.', expected: 2 })
    // 비교 모드가 켜지면 종이는 지운/새 문장으로 다시 그려진다 — 800평이 화면에 있어야 고를 수 있다.
    const toggle = page.locator('.review-toggle')
    await expect(toggle).toBeVisible({ timeout: 30_000 })
    await toggle.click()
    // 켜면 종이가 비교 보기로 다시 그려진다 — 새 문장이 화면에 올 때까지 기다린 뒤 고른다.
    await expect(page.locator('.paperpane .sheet')).toContainText('800평', { timeout: 15_000 })
    await selectText(page, '800평', '800평')
    const button = page.locator('.selbar').getByRole('button', { name: '직접 수정' })
    await expect(button).toBeVisible({ timeout: 15_000 })
    await expect(button).toHaveAttribute('data-blocked', /.+/)
    await expect(button).toHaveAttribute('title', '고친 부분 보기를 끄고 골라 주세요')
  } finally {
    await electronApp.close()
  }
})

for (const externalBody of [false, true]) {
test(`저장이 실패하면 원고는 그대로이고 실패 한 줄이 뜬다 (${externalBody ? '같은 장 바깥 수정' : '개정만 변경'})`, async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await page.clock.install()
    await openProject(page, root)
    await paperReady(page, '600평')
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('700평')
    // 저장이 실제로 보내는 payload 를 붙잡는다. 아래 (나)는 이 기록이 아니라 렌더러 store 를
    // 직접 읽어 판정한다 — 응답을 받았다는 사실은 store 반영을 뜻하지 않는다.
    const initial = await electronApp.evaluate(async ({ ipcMain }, folder) => {
      type Handler = (...args: unknown[]) => Promise<unknown>
      // Electron's existing private handler registry is the in-process test seam.
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      const real = ipc._invokeHandlers.get('rpc')!
      const status = await real({}, 'project.status', { root: folder }) as RpcResult<Status>
      const sections = await real({}, 'project.sections', { root: folder }) as RpcResult<SectionRow[]>
      if (!status.result || !sections.result) throw new Error('initial project snapshot failed')
      const probe: ViewerEditProbe = { sent: null }
      const host = globalThis as ViewerEditHost
      host.__viewerEdit = probe
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        if (args[1] === 'section.edit') probe.sent = args[2] as Record<string, unknown>
        return await real(...args)
      })
      return { revision: status.result.revision, hash: sections.result.find((row) => row.id === 'sec-01')!.draft_hash }
    }, root)

    // 그사이 정본이 앞서 나간다 — 저장은 `stale_view` 로 거절되고 원고는 그대로다.
    if (externalBody) {
      rewriteSection(root, { body: '농장A의 재배 면적은 900평이다. 바깥에서 고친 원고다.', expected: initial.revision })
    } else bumpRevision(root, initial.revision)
    // rewriteSection rebinds sec-01 to sections/sec-01.md; follow the canonical row, not its old path.
    const currentPath = await electronApp.evaluate(async ({ ipcMain }, folder) => {
      type Handler = (...args: unknown[]) => Promise<unknown>
      // Same in-process Electron handler registry used above.
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      const real = ipc._invokeHandlers.get('rpc')!
      const reply = await real({}, 'project.sections', { root: folder }) as RpcResult<SectionRow[]>
      const row = reply.result?.find((section) => section.id === 'sec-01')
      if (!row) throw new Error('current canonical section missing')
      return row.path
    }, root)
    const beforeSave = readFileSync(join(root, currentPath), 'utf-8')
    expect(beforeSave).toContain(externalBody ? '900평' : '600평')
    // (가) 외부 변경이 실제로 디스크에 앉았다 — 앱·IPC 를 거치지 않고 정본을 직접 읽는다.
    // `bumpRevision` 은 본문을 그대로 두므로 본문만으로는 '정말 바뀌었나'를 말할 수 없다.
    const onDisk = JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { revision: number }
    expect(onDisk.revision).toBe(initial.revision + 1)
    // (나) 렌더러 **store** 가 이 폴더의 외부 변경 개정(`initial.revision + 1`)을 들고 있다.
    // IPC 응답을 세지 않고 `window.__knuafProjectProbe` getter 로 store 값을 직접 읽는다 —
    // `refresh` 는 응답 뒤 `peekProject` 를 한 번 더 기다리고 그 사이 방문이 바뀌면 결과를
    // 버리므로, 응답을 받았다는 사실은 store 반영을 뜻하지 않는다(검토 roh292 중요 1).
    //
    // 시계가 멈춰 있어 감시 타이머(2초)가 저절로 돌지 않는다. 아직 못 봤으면 회차마다 시계를
    // 한 번 밀고, 민 직후에 store 를 다시 읽는다. 회차 사이에는 `expect.poll` 이 실제 시간을
    // 두므로 앞 갱신이 실제 IPC 를 마칠 틈이 생긴다(`statusInFlight` 인 동안의 틱은 아무 일도
    // 안 하고 돌아간다). 민 횟수는 판정 근거가 아니다 — 판정은 store 값 하나로만 한다.
    const target = initial.revision + 1
    let ticks = 0
    await expect.poll(async () => {
      const probe = await readProjectProbe(page)
      if (probe === null || probe.root !== root || probe.revision !== target) {
        if (ticks < 8) { ticks++; await page.clock.runFor(2100) }
        return await readProjectProbe(page)
      }
      return probe
    }, { timeout: 20_000, intervals: [100, 150, 250, 400, 600, 800] }).toEqual({ root, revision: target })
    await page.clock.runFor(32)
    await input.press('Enter')

    const failure = page.locator('.paper-fb.edit-line[role="alert"]')
    await expect(failure).toContainText('그사이 글이 바뀌었어요', { timeout: 30_000 })
    expect(await electronApp.evaluate(() => {
      const host = globalThis as ViewerEditHost
      return host.__viewerEdit.sent
    })).toMatchObject({
      expected_revision: initial.revision, expected_draft_hash: initial.hash
    })
    // A refused save must preserve the entire external canonical draft, byte for byte.
    const disk = readFileSync(join(root, currentPath), 'utf-8')
    expect(disk).toBe(beforeSave)
    expect(disk).not.toContain('700평')
    await expect(page.locator('.edit-slot-input')).toHaveValue('700평')
  } finally {
    await electronApp.close()
  }
})
}

test('같은 낱말이 다른 곳에 있으면 한 줄이 뜨고 같이 고치기로 한 번에 저장된다', async () => {
  const { addSectionBody } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    // 둘째 장에 같은 낱말(`재배`)을 심는다. 첫 장에서 그 낱말을 바꾸면 '사라진 낱말'이 된다.
    // 앱을 열기 **전에** 쓴다 — 열린 뒤에 쓰면 앱이 이미 읽은 개정 번호와 디스크가 어긋나
    // 저장이 `stale_view` 로 거절될 수 있다(윈도 CI 43204858056).
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 2 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 관리도', { timeout: 30_000 })

    // 숫자만 바꾸면 §3-4 대상이 아니다(숫자는 후보에서 빠진다) — 낱말을 바꾼다.
    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('경작 면적')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    // 방금 고친 자리는 '다른 곳'이 아니다 — 남은 곳은 둘째 장 1군데뿐이다(§3-4).
    await expect(line).toContainText("다른 곳에도 '재배'가 1군데 있어요.")

    // 03 — `같이 고치기` 첫 클릭은 **목록만 연다**. 저장 호출이 없어야 한다.
    await line.getByRole('button', { name: '같이 고치기' }).click()
    const list = page.locator('.sameword-list')
    await expect(list).toBeVisible()
    await expect(list.locator('.sameword-place')).toHaveCount(1)
    // 아직 아무것도 안 바뀌었다 — 둘째 장은 그대로다.
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 관리도 함께 적는다.')

    // 확정 — 목록 안의 `1군데 고치기`에서만 저장한다.
    await list.getByRole('button', { name: '1군데 고치기' }).click()
    await expect(page.locator('.paperpane .sheet')).toContainText('경작 관리도 함께 적는다.', { timeout: 30_000 })
    await expect(page.locator('.paper-fb.edit-line[role="alert"]')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('같이 고치기 저장에 정리 경고가 있으면 반영된 본문과 함께 경고를 보인다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 1 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 관리도', { timeout: 30_000 })
    await electronApp.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => Promise<RpcResult<Record<string, unknown>>>
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      const real = ipc._invokeHandlers.get('rpc')!
      ipcMain.removeHandler('rpc')
      ipcMain.handle('rpc', async (...args: unknown[]) => {
        const reply = await real(...args)
        if (args[1] === 'section.edit_batch' && reply.result) return { ...reply, result: { ...reply.result, cleanup_warning: 'release_cleanup_failed' } }
        return reply
      })
    })
    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await input.fill('경작 면적')
    await input.press('Enter')
    await page.locator('.sameword').getByRole('button', { name: '같이 고치기' }).click()
    await page.locator('.sameword-list').getByRole('button', { name: '1군데 고치기' }).click()
    await expect(page.locator('.paperpane .sheet')).toContainText('경작 관리도 함께 적는다.', { timeout: 30_000 })
    await expect(page.locator('.paper-fb .make-fb.warning')).toContainText('작업은 반영됐지만 정리가 남았어요.')
    await expect(page.locator('.paper-fb .make-fb.warning')).toContainText('같은 작업을 바로 반복하지 말고')
  } finally {
    await electronApp.close()
  }
})

test('본문이 바뀌면 같은 낱말 제안은 접힌다 — 체크가 다른 자리로 옮겨 가지 않는다 (Roh 02)', async () => {
  const { addSectionBody, rewriteSection } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    // 둘째 장은 앱을 열기 전에 써 둔다 — 열린 뒤에 쓰면 앱이 읽은 개정 번호와 디스크가
    // 어긋나 저장이 `stale_view` 로 거절될 수 있다(윈도 CI 43204858056). 이 시험이 재는
    // '열린 뒤의 바깥 변경'은 아래 `rewriteSection` 쪽이다.
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 2 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 관리도', { timeout: 30_000 })

    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('경작 면적')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await line.getByRole('button', { name: '같이 고치기' }).click()
    const list = page.locator('.sameword-list')
    await expect(list).toBeVisible()
    // 둘째 장 자리를 뺀다.
    await list.locator('input[type="checkbox"]').first().uncheck()
    await expect(list.locator('.sameword-place')).toHaveCount(1)

    // 도우미가 둘째 장을 다시 쓴다 → 본문이 바뀌므로 그 제안은 낡은 것이고 접힌다.
    // 기록 번호는 지금 정본에서 읽는다(직전 저장으로 이미 올라가 있다).
    const { spawnSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    const { python, scripts } = await import('./helpers')
    const revision = (JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { revision: number }).revision
    rewriteSection(root, { id: 'sec-02', body: '경작 관리도 함께 적는다.', expected: revision })
    void spawnSync; void python; void scripts
    await expect(page.locator('.sameword')).toHaveCount(0, { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('편집 중에 건너뛴 본문 갱신은 취소하면 따라잡는다 (Roh 06)', async () => {
  const { rewriteSection } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    await expect(page.locator('.edit-slot-input')).toBeVisible({ timeout: 15_000 })

    // 편집칸을 열어 둔 채 다른 경로가 원고를 고친다 — 그동안의 재조회는 건너뛴다.
    rewriteSection(root, { body: '농장A의 재배 면적은 900평이다. 정읍 일대 기후를 고려해 작목을 선택했다.', expected: 2 })
    await page.waitForTimeout(2500)
    // 취소하면 한 번 다시 읽는다 — 종이에 새 본문이 보인다.
    await page.locator('.edit-slot-input').press('Escape')
    await expect(page.locator('.edit-slot-input')).toHaveCount(0)
    await expect(page.locator('.paperpane .sheet')).toContainText('900평', { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('그대로를 누르면 그 낱말 제안만 닫힌다 (Roh 08)', async () => {
  const { addSectionBody } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    // 둘째 장은 앱을 열기 전에 써 둔다 — 열린 뒤에 쓰면 앱이 읽은 개정 번호와 디스크가
    // 어긋나 저장이 `stale_view` 로 거절될 수 있다(윈도 CI 43204858056). 이 시험이 재는 것은
    // `그대로` 단추의 동작이지 바깥 변경이 아니다.
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 2 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 관리도', { timeout: 30_000 })

    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('경작 면적')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await line.getByRole('button', { name: '그대로' }).click()
    await expect(page.locator('.sameword')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('제출 전 점검이 필요한 고침은 저장 뒤 한 줄에 보인다 (Roh 07)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { python, scripts } = await import('./helpers')
  const root = synthProject()
  // 검토를 **지금 본문의 실제 지문**으로 등록한다 — 그래야 다음 고침이 그 검토를 낡게 만든다.
  // 지문은 규칙집이 계산하는 값이라 python 으로 물어본다(앱이 흉내 내지 않는다).
  const probe = spawnSync(python, ['-c', [
    'import json, sys; sys.path.insert(0, sys.argv[1])',
    'import gg_core as core',
    'root = sys.argv[2]',
    'p = core.load(root)',
    'refs = [{"collection": "sections", "id": "sec-01"}]',
    'print(json.dumps(core.fingerprint(root, p, refs)))'
  ].join('\n'), scripts, root], { encoding: 'utf-8' })
  const fingerprint = probe.stdout.trim()
  expect(fingerprint.length).toBeGreaterThan(0)
  const revision = (JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { revision: number }).revision
  writeFileSync(join(root, 'change-review.json'), JSON.stringify({ request_id: 'e2e:review', ops: [
    { collection: 'reviews', value: {
      id: 'rev-01', review_kind: 'content', author_id: 'a', reviewer_id: 'b',
      target_refs: [{ collection: 'sections', id: 'sec-01' }],
      input_fingerprint: JSON.parse(fingerprint), findings: [], disposition: 'resolved', status: 'pass',
      path: 'sections/01.md', coverage: [{ axis: 'content', locator: '전체' }]
    } }
  ] }), 'utf-8')
  spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', join(root, 'change-review.json'),
    '--expected-revision', String(revision)], { encoding: 'utf-8' })

  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    // 오타만 고친다 — needs_check=false, 대신 그 장의 검토가 낡는다(§4-2 8).
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('600 평')
    await input.press('Enter')

    await expect(page.locator('.paper-fb.edit-line')).toContainText('고쳤어요', { timeout: 30_000 })
    await expect(page.locator('.paper-fb.edit-line .recheck'))
      .toContainText('제출 전에 도우미 점검', { timeout: 15_000 })

    // 목록 머리 — 장 상태는 `review_ready` 그대로지만 **검토가 낡았으므로** 안내가 보여야 한다.
    // (e647475 는 `section.status === 'review_ready'` 로 걸러 이 안내를 숨겼다 — Roh 2회째 07.)
    await page.locator('.paper-head').getByRole('button', { name: /직접 고친 곳/ }).click()
    const head = page.locator('.edit-recheck')
    await expect(head).toBeVisible({ timeout: 15_000 })
    await expect(head).toContainText('Ⅰ. 머리말')
  } finally {
    await electronApp.close()
  }
})

test('체크를 뺀 자리는 확정 뒤에도 원고 그대로다 (Roh 03)', async () => {
  const { addSectionBody } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    // 같은 낱말이 다른 장에도 있게 해서 목록에 자리가 둘 이상 뜨게 한다.
    // 앱을 열기 전에 써 둔다 — 열린 뒤에 연달아 쓰면 앱이 읽은 개정 번호와 디스크가 어긋난다.
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 2 })
    addSectionBody(root, { id: 'sec-03', title: 'Ⅲ. 결론', body: '재배 기록은 따로 남긴다.', expected: 3 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 기록은 따로', { timeout: 30_000 })

    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('경작 면적')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await line.getByRole('button', { name: '같이 고치기' }).click()
    const list = page.locator('.sameword-list')
    // b067ecd 에서는 이 목록이 열리지 않는다(첫 클릭에 바로 저장) — 거기서 실패한다.
    await expect(list).toBeVisible({ timeout: 15_000 })

    const places = list.locator('.sameword-place')
    await expect(places.first()).toBeVisible()
    expect(await places.count()).toBeGreaterThanOrEqual(2)

    // Ⅲ. 결론 자리만 체크를 뺀다 — 그 문장은 손대지 않아야 한다.
    const target = places.filter({ hasText: '재배 기록은' })
    await expect(target).toHaveCount(1)
    await target.locator('input[type="checkbox"]').uncheck()

    // 확정 — 남은 자리 수는 지금 본문이 정한다(숫자를 시험이 짐작하지 않는다).
    const label = await list.getByRole('button', { name: /군데 고치기/ }).textContent()
    const n = Number((label ?? '').replace(/[^0-9]/g, ''))
    expect(n).toBeGreaterThanOrEqual(1)
    await list.getByRole('button', { name: `${n}군데 고치기` }).click()

    // 체크한 자리는 바뀌고, 뺀 자리는 원고 그대로다.
    await expect(page.locator('.paperpane .sheet')).toContainText('경작 관리도 함께 적는다.', { timeout: 30_000 })
    await expect(page.locator('.paperpane .sheet')).toContainText('재배 기록은 따로 남긴다.')
  } finally {
    await electronApp.close()
  }
})

test('앞 문단이 지워져도 제외한 자리가 되살아나지 않는다 (Roh 02)', async () => {
  const { rewriteSection } = await import('./helpers')
  const { readFileSync } = await import('node:fs')
  const root = synthProject()
  const revision = (): number =>
    (JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { revision: number }).revision
  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    // 세 문단 — 가운데·끝에 같은 낱말이 있고, 앞 문단을 지우면 뒤 자리의 block_index 가 밀린다.
    rewriteSection(root, { body: '지울 재배 문장.\n\n남길 재배 문장.\n\n꼬리 재배 문장.', expected: 2 })
    await expect(page.locator('.paperpane .sheet')).toContainText('꼬리 재배 문장.', { timeout: 30_000 })

    // 앞 문단의 낱말을 바꾼다 → 사라진 `재배` 제안이 뜨고, 남은 자리는 둘(가운데·끝).
    await selectText(page, '지울 재배 문장', '지울 재배 문장')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('지울 경작 문장.')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    // 저장 직후의 다시 읽기가 같은 낱말 줄을 한 번 더 그린다 — 그 재그리드가 끝난 뒤 누른다.
    await page.waitForTimeout(1500)
    await line.getByRole('button', { name: '같이 고치기' }).click()
    const list = page.locator('.sameword-list')
    await expect(list).toBeVisible()
    const places = list.locator('.sameword-place')
    await expect(places).toHaveCount(2)

    // 끝 문단(꼬리 …)의 체크를 끈다.
    const target = places.filter({ hasText: '꼬리 재배 문장.' })
    await expect(target).toHaveCount(1)
    await target.locator('input[type="checkbox"]').uncheck()
    await expect(target.locator('input[type="checkbox"]')).not.toBeChecked()

    // 도우미가 **앞 문단을 지운** 본문을 등록한다 → 남은 자리의 block_index 가 밀린다.
    // 그 순간 그 제안은 낡은 것이므로 접혀야 한다(§4-5-8 02) — 되살아나면 체크가 엉뚱한 자리를 가리킨다.
    // 주의: `rewriteSection` 은 요청 ID 가 고정이라 두 번째 호출이 중복 제거된다. 그래서 여기서는
    // 고유 요청 ID 로 직접 등록한다(그러지 않으면 정본이 바뀌지 않아 이 시험이 다른 것을 잰다).
    const { spawnSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const { python, scripts } = await import('./helpers')
    writeFileSync(join(root, 'sections', '01.md'),
      '# Ⅰ. 머리말\n\n<!-- gg:draft:start -->\n남길 재배 문장.\n\n꼬리 재배 문장.\n<!-- gg:draft:end -->\n', 'utf-8')
    writeFileSync(join(root, 'change-drop.json'), JSON.stringify({ request_id: `e2e:drop:${revision()}`, ops: [
      { collection: 'sections', value: { id: 'sec-01', title: 'Ⅰ. 머리말', order: 1, path: 'sections/01.md', status: 'drafting' } }
    ] }), 'utf-8')
    const dropped = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', join(root, 'change-drop.json'),
      '--expected-revision', String(revision())], { encoding: 'utf-8' })
    expect(dropped.status, dropped.stdout + dropped.stderr).toBe(0)
    await expect(page.locator('.sameword')).toHaveCount(0, { timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

test('같이 고치기 목록에 장 제목이 보인다 (Roh 03)', async () => {
  const { addSectionBody } = await import('./helpers')
  const root = synthProject()
  const { electronApp, page } = await launchEdit()
  try {
    // 두 장을 앱을 열기 전에 써 둔다 — 열린 뒤에 연달아 쓰면 두 번째 쓰기 뒤에 앱이 읽은
    // 개정 번호가 디스크와 어긋나, 저장이 `stale_view` 로 거절된다(윈도 CI 43204858056).
    addSectionBody(root, { id: 'sec-02', title: 'Ⅱ. 본문', body: '재배 관리도 함께 적는다.', expected: 2 })
    addSectionBody(root, { id: 'sec-03', title: 'Ⅲ. 결론', body: '재배 기록은 따로 남긴다.', expected: 3 })
    await openProject(page, root)
    await paperReady(page, '600평')
    await expect(page.locator('.paperpane .sheet')).toContainText('Ⅲ. 결론', { timeout: 30_000 })

    await selectText(page, '재배 면적은 600평이다', '재배 면적')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('경작 면적')
    await input.press('Enter')

    const line = page.locator('.sameword')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await line.getByRole('button', { name: '같이 고치기' }).click()
    const list = page.locator('.sameword-list')
    await expect(list).toBeVisible()
    // 각 자리가 어느 장인지 보인다 — 문맥만으로는 학생이 어느 장인지 모른다(§4-5-8 03).
    await expect(list).toContainText('Ⅱ. 본문')
    await expect(list).toContainText('Ⅲ. 결론')
  } finally {
    await electronApp.close()
  }
})

test('검토가 낡은 장은 목록 머리에 남고, 검토가 다시 유효해지면 사라진다 (Roh 07)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { python, scripts } = await import('./helpers')
  const root = synthProject()
  // 준비 — ①status 를 review_ready 로, ②그 상태의 **실제 지문**으로 통과 검토를 등록한다.
  // 두 op 를 한 번에 보내면 검증에서 거절되므로(같은 apply 안의 상호 참조) 차례로 보낸다.
  const applyOps = (ops: unknown[]): void => {
    const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { revision: number }
    writeFileSync(join(root, 'change-ready.json'), JSON.stringify({ request_id: `e2e:ready:${project.revision}`, ops }), 'utf-8')
    const out = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', join(root, 'change-ready.json'),
      '--expected-revision', String(project.revision)], { encoding: 'utf-8' })
    expect(out.status, out.stdout + out.stderr).toBe(0)
  }
  const readProject = (): { sections: Record<string, Record<string, unknown>> } =>
    JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as { sections: Record<string, Record<string, unknown>> }
  applyOps([{ collection: 'sections', value: { ...readProject().sections['sec-01'], status: 'review_ready' } }])
  const probe = spawnSync(python, ['-c', [
    'import json, sys; sys.path.insert(0, sys.argv[1])',
    'import gg_core as core',
    'root = sys.argv[2]',
    'p = core.load(root)',
    'refs = [{"collection": "sections", "id": "sec-01"}]',
    'print(json.dumps(core.fingerprint(root, p, refs)))'
  ].join('\n'), scripts, root], { encoding: 'utf-8' })
  expect(probe.status, probe.stderr).toBe(0)
  applyOps([{ collection: 'reviews', value: {
    id: 'rev-01', review_kind: 'content', author_id: 'a', reviewer_id: 'b',
    target_refs: [{ collection: 'sections', id: 'sec-01' }],
    input_fingerprint: JSON.parse(probe.stdout.trim()), findings: [], disposition: 'resolved', status: 'pass',
    path: 'sections/01.md', coverage: [{ axis: 'content', locator: '전체' }]
  } }])

  const { electronApp, page } = await launchEdit()
  try {
    await openProject(page, root)
    await paperReady(page, '600평')
    // 오타만 고친다 — needs_check=false, 대신 그 장의 검토가 낡는다(§4-2 8).
    await selectText(page, '600평', '600평')
    await page.locator('.selbar').getByRole('button', { name: '직접 수정' }).click()
    const input = page.locator('.edit-slot-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill('600 평')
    await input.press('Enter')

    await expect(page.locator('.paper-fb.edit-line')).toContainText('고쳤어요', { timeout: 30_000 })
    await expect(page.locator('.paper-fb.edit-line .recheck'))
      .toContainText('제출 전에 도우미 점검', { timeout: 15_000 })

    // 목록 머리 — 장 상태는 `review_ready` 그대로지만 **검토가 낡았으므로** 안내가 보여야 한다.
    // e647475 는 `section.status === 'review_ready'` 로 걸러 이 안내를 숨겼다(Roh 2회째 07).
    await page.locator('.paper-head').getByRole('button', { name: /직접 고친 곳/ }).click()
    await expect(page.locator('.edit-recheck')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.edit-recheck')).toContainText('Ⅰ. 머리말')
  } finally {
    await electronApp.close()
  }
})
