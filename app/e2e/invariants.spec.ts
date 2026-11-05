import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Packager } from 'electron-builder'
import { app, launch, navTo, openPreset, openProject, plantStaleLock, synthProject } from './helpers'
import { APP_NAME, APP_NAME_ASCII } from '../src/shared/name'

const KORDOC = '문서를 읽는 데 필요한 도구를 준비할게요. 처음 한 번은 시간이 조금 걸릴 수 있어요.'


/**
 * 표시 이름은 플랫폼별로 바꾸되 데이터·업데이트 식별자는 유지한다.
 * Windows 실행 파일명은 NSIS의 실행 중 검사·기존 바로가기 보존에도 쓰인다.
 */
test('display names preserve installed data and executable identities', async () => {
  const packager = new Packager({ projectDir: app })
  await packager.validateConfig()
  const config = packager.config
  expect(config.mac?.executableName).toBe(APP_NAME)
  expect(config.mac?.extendInfo?.CFBundleDisplayName).toBe(APP_NAME)
  expect(config.dmg?.title).toBe(APP_NAME)
  expect(config.executableName).toBe('KNUAF-Dev · 창업논문 작성 도우미')
  expect(config.win?.executableName).toBeUndefined()
  expect(config.appId).toBe('kr.ac.knuaf.doc.companion')
  expect(config.productName).toBe(APP_NAME_ASCII)
  expect(APP_NAME_ASCII).toBe('knuaf-dev')
  expect(packager.metadata.name).toBe('knuaf-thesis-helper')
  expect(config.artifactName).toBe('knuaf-dev-${version}-${arch}.${ext}')
})

test('Windows installer is configured for a one-click per-user install', async () => {
  const yml = readFileSync(join(app, 'electron-builder.yml'), 'utf-8')
  const root = mkdtempSync(join(tmpdir(), 'knuaf-installer-config-'))
  try {
    for (const lineEnding of ['\n', '\r\n']) {
      const config = join(root, 'electron-builder.yml')
      writeFileSync(config, yml.replace(/\r?\n/g, lineEnding))
      // Use the builder's YAML loader: field order and additional options do not
      // change these installation requirements, and booleans stay typed.
      const packager = new Packager({ projectDir: app, config })
      await packager.validateConfig()
      const nsis = packager.config.nsis
      expect(nsis?.oneClick).toBe(true)
      expect(nsis?.perMachine).toBe(false)
      expect(nsis?.runAfterFinish).toBe(true)
      expect(nsis?.createDesktopShortcut).toBe(true)
      expect(nsis?.createStartMenuShortcut).toBe(true)
      expect(nsis?.include).toBe('build/installer.nsh')
      expect(nsis?.shortcutName).toBe(APP_NAME)
      expect(nsis?.uninstallDisplayName).toBe(APP_NAME + ' ${version}')
    }
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('reduced motion collapses transitions but keeps the spinner', async () => {
  const { electronApp, page } = await launch({ reducedMotion: 'reduce' })
  const dur = await page.locator('.titlebar .tbtn').first().evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(dur.split(',').map((s) => parseFloat(s)).every((d) => d <= 0.00001)).toBe(true)
  await electronApp.close()
})

test('제작자 정보는 첫 화면을 가리지 않고 설정에서 볼 수 있다', async () => {
  const { electronApp, page } = await launch({ intro: true, reducedMotion: 'reduce' })
  try {
    await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
    await page.getByRole('button', { name: '설정' }).first().click()
    await page.locator('dialog[open] nav').getByRole('button', { name: '앱 정보', exact: true }).click()
    await expect(page.getByText('GUI: made by 산업곤충전공 이준재')).toBeVisible()
    await expect(page.getByText('prod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재')).toBeVisible()
  } finally { await electronApp.close() }
})

test('hard rules hold across screens', async () => {
  const root = synthProject()
  const { electronApp, page } = await launch()
  // 첫 화면은 단계 대신 입력칸을 보여 주고, 경로 입력은 설정에만 있다.
  await expect(page.locator('.chat-pane')).toBeVisible()
  await expect(page.getByText('어떤 논문을 쓰고 있어요?')).toBeVisible()
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  await openProject(page, root)
  await page.waitForSelector('.chat-pane', { timeout: 30_000 })

  await expect(page.getByLabel('프로젝트', { exact: true })).toBeVisible()
  await expect(page.locator('.titlebar .tbtn.now')).toBeVisible()

  // 대화 화면 controls must not ask for JSON/model/path input either (same rule as 도구).
  expect(await page.locator('.chat-pane .tbar-seg, .chat-pane .segmented').count()).toBe(0)
  expect(await page.locator('main input[aria-label="폴더 경로"]').count()).toBe(0)
  const chatCtrls = (await page.locator('.chat-pane label, .chat-pane .field > span, .chat-pane button').allInnerTexts()).join('\n')
  expect(chatCtrls).not.toMatch(/JSON|모델/)

  // The independent-review notice appears at the publish/save action, even without opening 점검.
  await navTo(page, '결과물')
  const files = page.locator('.paper-head .popover')
  const submitRow = files.locator('[data-make="submission_candidate"]')
  const submitBtn = submitRow.getByRole('button')
  await expect(submitBtn).toBeEnabled()
  await submitBtn.click()
  await expect(submitRow).toContainText('다른 사람 검토 기록이 아직 없어요')
  // The same notice reaches the 고급 도구 발행 지점 (설정 > 고급 도구 > 검토본보내기).
  await navTo(page, '설정')
  await openPreset(page, 'tools:export')
  await page.selectOption('details[data-preset="tools:export"] select', 'submission_candidate')
  await expect(page.locator('details[data-preset="tools:export"] >> text=다른 사람 검토 기록이 아직 없어요')).toBeVisible()
  const labels = (await page.locator('details[data-preset="tools:export"] label, details[data-preset="tools:export"] .field > span').allInnerTexts()).join('\n')
  expect(labels).not.toMatch(/JSON|모델/)

  await navTo(page, '점검')
  await page.waitForSelector('[data-screen="checkup"]', { timeout: 30_000 })

  // four lanes by name, no percentage progress, no single done badge
  for (const t of ['자동 점검', '다른 사람 검토', '파일 확인', '교수님 승인']) await expect(page.getByText(t, { exact: true })).toBeVisible()
  expect(await page.locator('[role=progressbar], progress').count()).toBe(0)
  expect(await page.locator('main').innerText()).not.toMatch(/\d+\s*%/)
  // 그 문구는 이제 여러 자리(만들기 고지·결과물 시트·점검 행)에 나온다 — 점검 행으로 좁히되,
  // **고지 요소 자체가 보이는지**를 본다(확인 1회째: toContainText 는 숨은 요소도 통과한다).
  const notice = page.locator('[data-screen="checkup"] .lanes .ln').filter({ hasText: '다른 사람 검토' })
    .getByText('아직 기록이 없어요. 자동 점검 통과가 이를 대신하지 않아요.')
  await expect(notice, '점검 행의 고지가 보이지 않는다').toBeVisible()
  expect(await page.locator('button:has-text("완료")').count()).toBe(0)

  // no skip / N-A controls anywhere on 점검
  expect(await page.locator('button:has-text("건너뛰기"), button:has-text("해당 없음")').count()).toBe(0)

  // 논문 차례: read-only — 종이 칸이 저장된 글을 그대로 보여 주고, 편집기가 어디에도 없다.
  // (v4 는 사이드바 차례 → 읽기 전용 Sheet 였다. 그 자리를 종이 칸이 대신한다.)
  await navTo(page, '내 논문')
  if (!(await page.locator('.paperpane').isVisible())) await page.getByRole('tab', { name: '내 논문' }).click()
  await expect(page.locator('.paperpane .sheet')).toContainText('농장A의 재배 면적은 600평이다')
  expect(await page.locator('.paperpane textarea, .paperpane [contenteditable="true"]').count()).toBe(0)
  // GUI-09 — 본문 텍스트가 a11y 트리에 노드로 들어 있는지 고정한다. 스냅샷은
  // VoiceOver 가 아니므로 실기 읽기 확인은 사람 몫으로 남는다.
  expect(await page.locator('.paperpane').ariaSnapshot()).toContain('농장A의 재배 면적은 600평이다')
  // 차례는 종이 머리의 장 이름 ▾ 팝오버가 연다.
  await page.locator('.paper-head .chap').click()
  await expect(page.locator('.paper-head .popover .pop-row').first()).toContainText('머리말')
  await page.keyboard.press('Escape')

  // v2 cleanup requires a free OS-guard observation, never PID inference.
  await navTo(page, '설정')
  await openPreset(page, 'fix:lock')
  await openPreset(page, 'fix:kordoc')
  await expect(page.locator(`text=${KORDOC}`)).toHaveCount(1)
  const cleanup = page.getByRole('button', { name: '소유 기록 정리', exact: true })
  await expect(cleanup).toBeDisabled()
  plantStaleLock(root)
  await page.click('text=다시 진단')
  await expect(cleanup).toBeDisabled()
  await page.getByRole('button', { name: '점유 상태 확인', exact: true }).click()
  await expect(cleanup).toBeEnabled()
  await electronApp.close()
})
