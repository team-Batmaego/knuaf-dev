import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, navTo, openProject, python, scripts, synthProject } from './helpers'

test('외부에서 만든 파일을 팝오버를 다시 열어 확인하고 연다', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await navTo(page, '결과물')
    const pop = page.locator('.paper-head .popover')
    await expect(pop.getByText('아직 만든 파일이 없어요')).toBeVisible()
    await page.locator('[data-focus-key="head-files"]').click()
    const review = join(root, 'build', '7', 'review')
    mkdirSync(review, { recursive: true })
    writeFileSync(join(review, '검토용.md'), '# 새 검토본')
    const word = spawnSync(
      python,
      [join(scripts, 'build_docx.py'), root, '--in', 'sections/01.md', '--out', '검토용_초안.docx', '--major', 'specialty_crops', '--no-toc'],
      { encoding: 'utf-8' }
    )
    if (word.status !== 0) throw new Error(word.stdout + word.stderr)
    writeFileSync(join(root, 'build', '재무.xlsx'), 'excel')
    writeFileSync(join(root, '미등록_입력.docx'), 'word')
    writeFileSync(join(root, '미등록_재무.xlsx'), 'excel')
    await page.locator('[data-focus-key="head-files"]').click()
    for (const name of ['검토용.md', '검토용_초안.docx', '재무.xlsx']) {
      await expect(pop.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible()
    }
    await expect(pop.getByRole('button', { name: /미등록_입력\.docx/ })).toHaveCount(0)
    await expect(pop.getByRole('button', { name: /미등록_재무\.xlsx/ })).toHaveCount(0)
    await pop.getByRole('button', { name: /검토용\.md/ }).click()
    await expect(page.getByText('새 검토본')).toBeVisible()
  } finally { await electronApp.close() }
})
