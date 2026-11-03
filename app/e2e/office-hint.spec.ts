import { expect, test } from '@playwright/test'
import { officeHint } from '../src/renderer/src/copy'

test('macOS Apple Events denial is separated from unrelated errors and includes recovery steps', () => {
  const hint = officeHint('AppleEvent error -1743')
  expect(hint).not.toBeNull()
  expect(hint?.body).toContain('시스템 설정')
  expect(hint?.body).toContain('자동화')
  expect(hint?.body).toContain('다시 시도')
  expect(hint?.body).not.toContain('실행 터미널')
  expect(officeHint('Permission denied while reading a file')).toBeNull()
})
