/**
 * 설치판과 **같은 기본 경로**에 로그가 남는가 — 진짜 앱을 띄워서 본다.
 *
 * G0 조사(inv-logs/RESULT.md)의 결론: 설치판에는 파일 로그 기록기가 없어 `console.error`·`diag()`
 * 가 전부 증발했고, `%APPDATA%\<앱>\logs` 폴더는 '로그 폴더 열기'가 만든 **빈 폴더**였다.
 * 이 시험은 그 구멍이 다시 열리지 않게 세 가지를 확인한다:
 *
 *  1. 기동만 해도 `userData/logs/main.log` 가 생기고 `stage=boot` 줄이 있다.
 *  2. `app.getPath('logs')` 가 **그 폴더**다 — '로그 폴더 열기'(ipc.ts)가 여는 자리와 파일 위치가 같다.
 *  3. main 의 `console.error` 가 같은 파일로 온다. 값(토큰·경로)은 지워지고 진단에 필요한 코드는 남는다.
 *
 * `appLog: false` 로 띄우는 이유: helpers 는 `KNUAF_APP_LOG` 를 자기 임시 파일로 **덮어쓴다**.
 * 그 상태로 두면 앱이 기본 경로 대신 그 파일에 써도 시험이 통과해 버린다(가짜 초록).
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './helpers'

/** 로그에 절대 닿으면 안 되는 표식. */
const TOKEN_MARK = 'sk-boot-MARKERTOKEN2222222222222222222'
const PATH_MARK = 'MARKER-boot-papers-7f3d'

test('설치판 기본 경로(logs/main.log)에 기동 줄과 지워진 콘솔 오류가 남는다', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kd-main-log-'))
  const { electronApp } = await launch({ userData, appLog: false })
  try {
    // 1. 앱이 아는 로그 폴더 = 이 시험이 파일을 읽을 폴더. 어긋나면 '로그 폴더 열기'가 다른 곳을 연다.
    const dir = await electronApp.evaluate(({ app }) => app.getPath('logs'))
    expect(dir, "로그 폴더가 userData 아래로 격리되지 않았다 - 실제 사용자 폴더에 썼다").toBe(join(userData, 'logs'))
    const file = join(dir, 'main.log')

    // 기동 줄은 창이 뜨기 전에 이미 쓰인다. 첫 창이 떴으므로 폴링 없이도 있어야 한다.
    expect(existsSync(file), '기동했는데 로그 파일이 없다 - 설치판의 구멍이 그대로다').toBe(true)
    expect(readFileSync(file, 'utf-8'), '기동 단계가 로그에 없다').toContain('stage=boot')

    // 2. 콘솔이 없는 설치판에서 증발하던 오류가 같은 파일로 온다. 값은 지워진다.
    await electronApp.evaluate(({}, mark) => {
      console.error(`boot-check:fail code=EPERM token=${mark.token} path=${mark.path}`)
    }, { token: TOKEN_MARK, path: `/Users/${PATH_MARK}/논문/chat.json` })

    const read = (): string => (existsSync(file) ? readFileSync(file, 'utf-8') : '')
    await expect.poll(read, { timeout: 15_000 }).toContain('[console.error] boot-check:fail code=EPERM')
    const text = read()
    expect(text, '콘솔 사본에 토큰이 그대로 남았다').not.toContain(TOKEN_MARK)
    expect(text, '콘솔 사본에 논문 폴더 경로가 그대로 남았다').not.toContain(PATH_MARK)
    expect(text, '오류 코드까지 지웠다 - 로그가 진단에 쓸모없어진다').toContain('token=<값>')
  } finally {
    await electronApp.close()
  }
})
