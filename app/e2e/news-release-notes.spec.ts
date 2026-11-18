import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initialSeen } from '../src/main/releaseNotes'
import type { ReleaseNote, Settings } from '../src/shared/types'
import { launch } from './helpers'

test('first install, legacy use and seen marker choose the correct baseline', () => {
  const current = { app: '0.6.8', skill: '0.5.1' }
  const settings: Settings = { recent: [], credit_shown_at: null, python_override: null }
  const note = (kind: 'app' | 'skill', version: string): ReleaseNote => ({ kind, version, date: '2026-11-01', major: false, action: null, lines: [] })
  const notes = [note('app', '0.6.6'), note('app', '0.6.7'), note('app', '0.6.8'), note('skill', '0.5.0'), note('skill', '0.5.1')]
  expect(initialSeen(settings, current, notes)).toEqual(current)
  expect(initialSeen({ ...settings, onboarded_at: '2026-01-01' }, current, notes)).toEqual({ app: '0.6.7', skill: '0.5.0' })
  expect(initialSeen({ ...settings, recent: [{ root: '/a', opened_at: '' }] }, current, [])).toEqual({ app: '0.0.0', skill: '0.0.0' })
  expect(initialSeen({ ...settings, provider_choice: { provider: 'codex', at: '' } }, current, notes)).toEqual({ app: '0.6.7', skill: '0.5.0' })
  expect(initialSeen({ ...settings, release_notes_seen: current }, current, notes)).toEqual(current)
})

test('small and major releases show once and persist acknowledgement', async ({}, testInfo) => {
  const notesDir = testInfo.outputPath('notes')
  mkdirSync(notesDir, { recursive: true })
  const env = { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin', KNUAF_E2E_RELEASE_NOTES: notesDir }
  const probe = await launch({ env, onboarded: false })
  const version = await probe.electronApp.evaluate(({ app }) => app.getVersion())
  await probe.electronApp.close()
  const parts = version.split('.').map(Number)
  const prior = `${parts[0]}.${parts[1]}.${Math.max(0, parts[2] - 1)}`
  const note = (size: string, action: string) => `---\n판: ${version}\n날짜: 2026-11-16\n크기: ${size}\n할 일: ${action}\n---\n- 바뀐 내용을 볼 수 있어요.\n`
  for (const major of [false, true]) {
    writeFileSync(join(notesDir, `${version}.md`), note(major ? '큰 판' : '작은 판', major ? '설정을 확인해 주세요.' : '없음'))
    if (!major) {
      const fresh = await launch({ env, onboarded: false, userData: testInfo.outputPath('fresh-user') })
      try { await expect(fresh.page.getByRole('button', { name: '새 소식' })).toHaveCount(0); await expect(fresh.page.getByRole('dialog', { name: '새로워진 점' })).toHaveCount(0) } finally { await fresh.electronApp.close() }
    }
    const userData = testInfo.outputPath(major ? 'major-user' : 'small-user')
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ release_notes_seen: { app: prior, skill: null } }))
    let run = await launch({ userData, env })
    try {
      if (major) {
        const dialog = run.page.getByRole('dialog', { name: '새로워진 점' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText('이렇게 해 주세요')).toBeVisible()
        await run.page.keyboard.press('Escape')
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: '확인했어요' }).click()
      } else {
        await expect(run.page.getByRole('dialog', { name: '새로워진 점' })).toHaveCount(0)
        await run.page.getByRole('button', { name: '새 소식' }).click()
        await expect(run.page.getByRole('heading', { name: '업데이트 기록' })).toBeVisible()
        await expect(run.page.getByText('지금 쓰는 앱')).toBeVisible()
        await expect(run.page.getByText('지금 쓰는 규칙집')).toBeVisible()
      }
      expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).release_notes_seen.app).toBe(version)
    } finally { await run.electronApp.close() }
    run = await launch({ userData, env })
    try { await expect(run.page.getByRole('button', { name: '새 소식' })).toHaveCount(0); await expect(run.page.getByRole('dialog', { name: '새로워진 점' })).toHaveCount(0) } finally { await run.electronApp.close() }
  }
})

test('first install does not show news and narrow window shows update', async () => {
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin' } })
  try {
    await expect(page.getByRole('button', { name: '새 소식' })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '새로워진 점' })).toHaveCount(0)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1440, 900)
      win.webContents.send('app-update:status', { phase: 'available', current: '0.6.8', latest: '99.0.0', page: null })
    })
    const button = page.locator('.titlebar .news-app-update')
    await expect(button).toBeHidden()
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 900))
    await expect(button).toBeVisible()
  } finally { await electronApp.close() }
})
