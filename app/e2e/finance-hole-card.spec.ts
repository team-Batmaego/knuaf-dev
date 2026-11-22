import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

test('재무 카드 고치기는 대화를 보내지 않고 입력칸에 채운다', async () => {
  const root = synthProject()
  const projectPath = join(root, 'project.json')
  const project = JSON.parse(readFileSync(projectPath, 'utf8'))
  const projectId = 'd29edc18f40887ca323113e98b70f9af3d23b4e7ade89cdf4115ada427f51942'
  project.project_id = projectId
  writeFileSync(projectPath, JSON.stringify(project))
  const message = '본문의 금액과 비교 기준을 함께 확인해 줘.'
  writeFileSync(join(root, '.knuaf-notices.json'), JSON.stringify({
    schema: 'knuaf.notices/1', project_id: projectId, notices: [{
      project_id: projectId, notice_identity: 'a'.repeat(64), card_key: 'a'.repeat(64),
      kind: 'finance_hole_figure', choice_policy: 'none', blocking: true, dismissible: false,
      title: '본문과 정리한 금액의 기준을 확인해 주세요',
      choices: [{ value: 'fix', label: '고치기' }, { value: 'later', label: '나중에' }],
      talk_message: message, items: []
    }]
  }))
  const { electronApp, page } = await launch({ userData: mkdtempSync(join(tmpdir(), 'knuaf-card-user-')) })
  try {
    await openProject(page, root)
    const card = page.locator('.notice-card')
    const userMessages = page.locator('.chat-msg.user')
    const before = await userMessages.allTextContents()
    await expect(card).toContainText('본문과 정리한 금액의 기준을 확인해 주세요', { timeout: 30_000 })
    await card.getByRole('button', { name: '고치기' }).click()
    await expect(page.locator('textarea[aria-label="답변을 입력하세요"]')).toHaveValue(message)
    await expect(userMessages).toHaveCount(before.length)
    expect(await userMessages.allTextContents()).toEqual(before)
    await expect(userMessages.filter({ hasText: message })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})
