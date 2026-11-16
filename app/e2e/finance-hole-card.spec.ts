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

test('목표와 계획 차이 카드(8판)의 이대로 진행은 보내지 않고 입력칸에 채운다', async () => {
  const root = synthProject()
  const projectPath = join(root, 'project.json')
  const project = JSON.parse(readFileSync(projectPath, 'utf8'))
  const projectId = 'd29edc18f40887ca323113e98b70f9af3d23b4e7ade89cdf4115ada427f51942'
  project.project_id = projectId
  writeFileSync(projectPath, JSON.stringify(project))
  const proceed = '지금 계획대로 목표 차이를 감수하고 진행할게요'
  const key = 'c'.repeat(64)
  // 규칙집 B2(gg_target_gap.row) 행 모양 그대로 — 학생 화면 문장·숫자는 앱이 조립하지 않는다.
  writeFileSync(join(root, '.knuaf-notices.json'), JSON.stringify({
    schema: 'knuaf.notices/1', project_id: projectId, notices: [{
      title: '목표까지 12,000,000원이 모자라요',
      choices: [{ value: 'fix', label: '고치기' }, { value: 'proceed', label: '이대로 진행' }, { value: 'later', label: '나중에' }],
      talk_message: '목표 순이익과 계획의 차이를 조정하고 싶어요', proceed_message: proceed,
      items: [{ what: '목표는 50,000,000원인데, 지금 계획은 38,000,000원이에요. 두 값을 빼면 12,000,000원이 모자라요.',
        where: '재무 계획', current: '2028년 목표 50,000,000원 · 지금 계획 38,000,000원 · 차이 12,000,000원',
        basis: '목표에서 지금 계획을 뺀 금액이에요.', how: '목표와 계획을 도우미와 함께 살펴봐요.', where_detail: '', changed: '' }],
      kind: 'finance_hole_target_gap', blocking: false, choice_policy: 'none', dismissible: false,
      fix_mode: 'talk', record_refs: [], project_id: projectId, notice_identity: key, card_key: key
    }]
  }))
  const { electronApp, page } = await launch({ userData: mkdtempSync(join(tmpdir(), 'knuaf-card-user-')) })
  try {
    await openProject(page, root)
    const card = page.locator('.notice-card')
    const userMessages = page.locator('.chat-msg.user')
    const before = await userMessages.allTextContents()
    await expect(card).toContainText('목표까지 12,000,000원이 모자라요', { timeout: 30_000 })
    await expect(card).not.toContainText('제출 전에 꼭 고쳐야 해요')
    await expect(card.locator('.notice-x')).toHaveCount(0)
    await card.getByRole('button', { name: '이대로 진행' }).click()
    await expect(page.locator('textarea[aria-label="답변을 입력하세요"]')).toHaveValue(proceed)
    await expect(userMessages).toHaveCount(before.length)
    expect(await userMessages.allTextContents()).toEqual(before)
  } finally {
    await electronApp.close()
  }
})
