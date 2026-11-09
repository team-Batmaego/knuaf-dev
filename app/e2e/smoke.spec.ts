import { test, expect } from '@playwright/test'
import { launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'

test('open a project, see four lanes, export a draft, clean only owner evidence', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })
  await navTo(page, '점검')
  await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })
  // Four lanes, separately, by name — never one merged badge.
  await expect(page.getByText('자동 점검', { exact: true })).toBeVisible()
  await expect(page.getByText('다른 사람 검토', { exact: true })).toBeVisible()
  await expect(page.getByText('파일 확인', { exact: true })).toBeVisible()
  await expect(page.getByText('교수님 승인', { exact: true })).toBeVisible()
  await expect(page.locator('text=아직 기록이 없어요')).toBeVisible()
  // The row names the check in 한국어; check_id lives behind 자세히. school_profile is only
  // ever emitted blocked (gg_core.py:1552), so the row is always there to be found.
  // v5 에서 검사 행은 **자동 점검 행의 "자세히"** 안에 있다(시안 ⑫) — 먼저 펼친다.
  await page.locator('[data-screen="checkup"] summary:has-text("자세히")').first().click()
  await expect(page.locator('text=학교 규칙 등록').first()).toBeVisible()
  await navTo(page, '결과물')
  // 결과물 > 파일 팝오버 — 검토본은 관문 없이 만든다.
  const files = page.locator('.paper-head .popover')
  const reviewRow = files.locator('[data-make="review"]')
  await reviewRow.getByRole('button').click()
  await expect(reviewRow).toContainText('검토본을 만들었어요', { timeout: 30_000 })
  // A v2 owner record is evidence, not the OS lock. Inspect, probe, then clean.
  plantStaleLock(root)
  await navTo(page, '설정')
  await openPreset(page, 'fix:lock')
  await page.click('text=다시 진단')
  const cleanup = page.getByRole('button', { name: '소유 기록 정리', exact: true })
  // Re-diagnosis clears the old report; an owner observation must arrive before probing.
  await page.getByText('마지막 점유 기록', { exact: true }).waitFor({ state: 'visible' })
  await expect(cleanup).toBeDisabled()
  await page.getByRole('button', { name: '점유 상태 확인', exact: true }).click()
  await expect(cleanup).toBeEnabled()
  await cleanup.click()
  await page.locator('dialog[open]').last().getByRole('button', { name: '소유 기록 정리', exact: true }).click()
  await expect(page.getByText('소유 기록을 정리했어요.', { exact: true })).toBeVisible({ timeout: 30_000 })
  await electronApp.close()
})
