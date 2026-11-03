/**
 * GUI-12 감사(파일 링크가 원문 텍스트였다) → 형님 확정 2026-11-03 으로 **동작이 넓어졌다**.
 * 누르면 메인이 경로를 다시 확인한 뒤 ① 폴더 안에 실제로 있는 문서면 연결 프로그램으로 열고
 * ② 그 밖의 형식은 열지 않고 폴더에서 보여 주며 ③ 폴더 밖·없는 파일이면 결과물 시트로 간다.
 * 이 시험은 그 갈래를 메인의 shell 호출 기록으로 잠근다(실제 탐색기·프로그램은 띄우지 않는다).
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { launch, openProject, seedChat, shellCalls, spyShell, synthProject } from './helpers'

const callLog = (): string => join(mkdtempSync(join(tmpdir(), 'kd-shell-')), 'calls.txt')

/** 존재하는 txt 파일을 만들고 그 상대경로를 돌려준다. */
function plantFile(root: string, rel: string, body = 'ATTACH_REPRO_20261103\n'): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf-8')
  return rel
}

test('파일 단추: 폴더 안에 실제로 있는 문서는 연결 프로그램으로 연다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/검토전_본문.md', '# 본문\n')
  seedChat(root, `검토본을 만들었어요. [검토전_본문.md](${rel}) 에서 볼 수 있어요.`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    const link = page.getByRole('button', { name: '검토전_본문.md' })
    await expect(link).toBeVisible({ timeout: 30_000 })
    await link.click()
    // 열었고, 폴더에서 보기로 대신하지 않았고, 결과물 시트로 가지도 않았다.
    await expect.poll(() => shellCalls(log)).toEqual([`open\t${realpathSync(join(root, rel))}`])
    await expect(page.getByRole('heading', { name: '결과물' })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('파일 단추: 열지 않는 형식은 열지 않고 폴더에서 보여 준다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/설치파일.exe', 'MZ not really\n')
  seedChat(root, `첨부했어요. [설치파일.exe](${rel})`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log)
    await page.getByRole('button', { name: '설치파일.exe' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([`reveal\t${realpathSync(join(root, rel))}`])
  } finally {
    await electronApp.close()
  }
})

test('파일 단추: 열 프로그램이 없으면 폴더에서 보여 주고 쉬운 말로 알린다', async () => {
  const root = synthProject()
  const rel = plantFile(root, 'build/검토전_본문.md', '# 본문\n')
  seedChat(root, `검토본을 만들었어요. [검토전_본문.md](${rel})`)
  const log = callLog()

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await spyShell(electronApp, log, { openFailure: 'no application associated' })
    await page.getByRole('button', { name: '검토전_본문.md' }).click()
    await expect.poll(() => shellCalls(log)).toEqual([
      `open\t${realpathSync(join(root, rel))}`,
      `reveal\t${realpathSync(join(root, rel))}`
    ])
    await expect(page.getByText('파일을 열지 못해 폴더에서 보여 줬어요.')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('도우미 답변의 파일 링크가 마크다운 원문으로 보이지 않는다 (GUI-12)', async () => {
  const root = synthProject()
  // 파일을 만들지 않는다 — 없는 파일은 결과물 시트로 간다(옛 동작 유지).
  seedChat(root, '검토본을 만들었어요. [검토전_본문.md](build/검토전_본문.md) 에서 볼 수 있어요.')

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })

    expect(await msg.innerText(), '마크다운 원문이 그대로 보인다').not.toContain('](')
    // 일반 텍스트가 아니라 누를 수 있는 것이어야 한다 — 접근성 트리에도 역할이 생긴다.
    const link = page.getByRole('button', { name: '검토전_본문.md' })
    await expect(link, '파일 이름이 누를 수 있는 것이 아니다').toBeVisible()
    await link.click()
    await expect(page.getByRole('heading', { name: '결과물' })).toBeVisible({ timeout: 30_000 })
  } finally {
    await electronApp.close()
  }
})

/**
 * 안전 쪽 절반. 도우미가 쓴 링크를 무엇이든 누를 수 있게 만들면 답변 텍스트가 곧
 * 실행 권한이 된다. 프로젝트 안 상대경로가 아닌 것은 원문 그대로 둔다 — 감추지도,
 * 누를 수 있게 만들지도 않는다.
 */
test('폴더 밖·주소를 가리키는 링크는 누를 수 있게 만들지 않는다 (GUI-12)', async () => {
  const root = synthProject()
  const text = [
    '[받으세요](https://example.invalid/x.exe)',
    '[열쇠](/Users/other/.ssh/id_rsa)',
    '[위로](../../다른폴더/x.md)'
  ].join(' 그리고 ')
  seedChat(root, text)

  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await page.waitForSelector('.chat-pane', { timeout: 30_000 })
    const msg = page.locator('.chat-msg.assistant .prose').first()
    await expect(msg).toBeVisible({ timeout: 30_000 })
    for (const label of ['받으세요', '열쇠', '위로'])
      await expect(page.getByRole('button', { name: label }), `${label} 가 눌러진다`).toHaveCount(0)
    // 감추지는 않는다 — 학생이 무엇이 적혔는지 볼 수 있어야 한다.
    await expect(msg).toContainText('example.invalid')
  } finally {
    await electronApp.close()
  }
})