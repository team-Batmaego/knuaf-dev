import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, navTo, openProject, python, scripts, synthProject } from './helpers'

const OUT = resolve(__dirname, 'artifacts')

/** Apply a second change on top of the synth project (revision 1 → 2). */
function applyChange(root: string, change: object, expected: number): void {
  const file = join(root, `change-${expected}.json`)
  writeFileSync(file, JSON.stringify(change), 'utf-8')
  const r = spawnSync(python, [join(scripts, 'gg.py'), 'apply', root, '--change', file, '--expected-revision', String(expected)], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
}

const intakeFact = (id: string, field: string, value: string | null, state: string, extra: object = {}) => ({
  collection: 'facts',
  value: {
    id, field_id: field, kind: 'reported_fact', value,
    unit: null, value_type: 'text', period: null, scope: null,
    answer_state: state, verification: 'unreviewed',
    source_refs: [{ id: 'src-answers', revision: 1, locator: 'L1' }],
    ...extra
  }
})

test('자료 팝오버: 현재 작성물과 참고자료를 구분하고 참고자료를 답변에 첨부한다', async () => {
  const root = synthProject()
  writeFileSync(join(root, 'sources', '초고.docx'), 'docx')
  applyChange(root, {
    request_id: 'e2e:intake:1',
    ops: [
      intakeFact('fact-manuscript', 'intake.current_manuscript', 'sources/초고.docx', 'provided'),
      intakeFact('fact-basis', 'intake.work_basis', '이어쓰기', 'provided')
    ]
  }, 1)
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  await navTo(page, '자료')
  const pop = page.locator('.paper-head .popover')
  await expect(pop).toBeVisible()

  // 현재 작성물과 참고자료는 별도 목록이고, 재무 파일은 아직 정해지지 않았다.
  await expect(pop.getByText('현재 작성물', { exact: true })).toBeVisible()
  const manuscriptRow = pop.locator('.pop-row').filter({ hasText: '현재 원고' })
  await expect(manuscriptRow).toContainText('초고.docx')
  const financeRow = pop.locator('.pop-row').filter({ hasText: '재무 파일' })
  await expect(financeRow).toContainText('아직 없어요')
  await expect(pop.getByText('참고자료', { exact: true })).toBeVisible()
  await expect(pop.getByRole('button', { name: /answers\.md/ })).toBeVisible()
  await expect(pop.getByRole('button', { name: '파일 고르기…' })).toBeVisible()

  // 점검으로 이동했다가 돌아와도 현재 작성물 선택은 바뀌지 않는다.
  await navTo(page, '점검')
  await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
  await navTo(page, '자료')
  await expect(pop).toBeVisible()
  await expect(pop.locator('.pop-row').filter({ hasText: '현재 원고' })).toContainText('초고.docx')

  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, 'materials.png') })

  // A reference attaches to the answer draft; it does not change the selected manuscript.
  const answerRow = pop.getByRole('button', { name: /answers\.md/ }).locator('..')
  await answerRow.getByRole('button', { name: '답변에 첨부' }).click()
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  const draftTarget = page.locator('textarea').or(page.locator('.card', { hasText: '도우미에게 보낼 요청' }).locator('.prose'))
  await expect(draftTarget.first()).toBeVisible({ timeout: 30_000 })
  const ta = page.locator('textarea')
  if (await ta.count()) expect(await ta.inputValue()).toContain(join('sources', 'answers.md'))
  else await expect(page.locator('.card', { hasText: '도우미에게 보낼 요청' }).locator('.prose')).toContainText(join('sources', 'answers.md'))
  await electronApp.close()
})
