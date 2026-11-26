import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import { closeApp } from './electron-lifecycle'
import { captureAppLog } from './diag'
import { fakeCodexEnv, replyFile, scratch, userDataWith } from './fixtures/fake-codex'

// Full renderer → main → fake app-server path, using the real 0.164/0.169 inventory shape.
test('v065 설치 마켓 플러그인이 있어도 첫 Codex 전송은 잠금 뒤 답을 표시한다', async ({}, info) => {
  const dir = scratch()
  const env = fakeCodexEnv(`${dir}/bin`, {
    FAKE_CODEX_PLUGIN_INSTALLED: JSON.stringify({
      marketplaces: [{ name: 'openai-primary-runtime', path: null, plugins: [
        { id: 'documents@openai-primary-runtime', installed: true, enabled: true }
      ] }], marketplaceLoadErrors: []
    }),
    FAKE_CODEX_REPLY: replyFile(dir, '마켓 플러그인 잠금 뒤 첫 응답')
  })
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  const { electronApp, page, appLog } = await launch({ env, userData })
  const log = captureAppLog(electronApp, appLog)
  try {
    await openProject(page, synthProject())
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('첫 전송')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('마켓 플러그인 잠금 뒤 첫 응답')).toBeVisible()
    await expect(page.getByText('Codex 설정의 외부 도구를 끄지 못했어요')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('first-codex-response.png') })
  } finally { await closeApp(electronApp, log) }
})
