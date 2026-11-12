/**
 * 진단 산출물의 **비밀값·경로 누출** 회귀 시험(검토 RT3 중요). Node 단위 — Electron 창 없이.
 *
 * 왜 필요한가: PR #102 윈도우 CI 의 `app-log.txt` 는 Playwright 산출물로 업로드된다. 거기에는
 * 앱 stderr 사본이 그대로 들어갔고, 관측된 것만으로도 ① 앱이 아닌 stderr 표식과 ② `SafeWriteFs`
 * 오류의 토큰·경로 표식이 파일에 닿았다. 논문 폴더 절대 경로와 모델 키가 섞이면 그대로 유출이다.
 *
 * 고정하는 계약:
 *  - `scrub` 은 값(인증 헤더·토큰·절대 경로·base64 덩어리)을 지우고 **모양**(이름·숫자·코드)은 남긴다.
 *  - `diag()` 는 그 `scrub` 을 거친 것만 파일에 쓴다.
 *  - 시험 수집(`witnessLines`)은 앱 태그로 시작하는 줄만 옮기고, 옮긴 줄에서도 값을 지운다.
 *  - 셋 다 **가짜 표식**으로 단언한다 — 실제 비밀값은 시험에도 넣지 않는다.
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diag, scrub } from '../src/main/diagLog'
import { witnessLines } from './diag'

/** 절대 경로에 절대 쓰지 않는 가짜 표식 — 이름만 보고 "지워졌는지" 안다. */
const PATH_MARK = 'MARKER-user-papers-7fd3'
const TOKEN_MARK = 'sk-test-MARKERTOKEN000000000000000000000000'
const HEADER_MARK = 'Bearer MARKERHEADER000000000000000000000000'

test('scrub 은 토큰·인증 헤더·절대 경로를 지우고 진단에 필요한 모양은 남긴다', () => {
  const line = [
    'stage=task:chat.close:reject',
    `authorization: ${HEADER_MARK}`,
    `token=${TOKEN_MARK}`,
    `file=/Users/${PATH_MARK}/논문/chat.json`,
    'code=EPERM',
    'pid=12345',
    'pending=[stop:0]'
  ].join(' ')

  const out = scrub(line)
  for (const secret of [TOKEN_MARK, 'MARKERHEADER000000000000000000000000', PATH_MARK]) {
    expect(out, `비밀값이 그대로 남았다: ${secret}`).not.toContain(secret)
  }
  // 지우되 **진단 가치는 남긴다** — 이게 없으면 로그가 무의미해진다.
  expect(out).toContain('stage=task:chat.close:reject')
  expect(out).toContain('code=EPERM')
  expect(out).toContain('pid=12345')
  expect(out).toContain('pending=[stop:0]')
})

test('scrub 은 윈도우 절대 경로와 긴 키 덩어리도 지우고, 줄 길이를 상한 안으로 자른다', () => {
  const out = scrub(`file=C:\\Users\\${PATH_MARK}\\논문\\chat.json key=${'a'.repeat(64)}`)
  expect(out).not.toContain(PATH_MARK)
  expect(out).not.toContain('a'.repeat(64))
  expect(out).toContain('file=')
  // 긴 줄은 잘리되 잘렸다는 사실이 남는다(조용히 자르면 "원래 그게 전부"로 읽힌다).
  // 값처럼 보이는 덩어리는 위 규칙이 먼저 지우므로, 여기서는 지워지지 않는 긴 문장으로 잰다.
  const long = scrub('가'.repeat(500))
  expect(long.length).toBeLessThan(500)
  expect(long).toContain('…(+')
})

test('diag() 는 파일에 scrub 을 거친 것만 쓴다 — 가짜 토큰·경로가 파일에 없다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-diag-'))
  const file = join(dir, 'app-log.txt')
  const before = process.env.KNUAF_APP_LOG
  process.env.KNUAF_APP_LOG = file
  try {
    diag(`safeWrite:fail chat.json code=EPERM note=${HEADER_MARK}`)
    diag(`close:start path=/Users/${PATH_MARK}/논문 token=${TOKEN_MARK}`)
    const text = readFileSync(file, 'utf8')
    for (const secret of [TOKEN_MARK, 'MARKERHEADER000000000000000000000000', PATH_MARK]) {
      expect(text, `진단 파일에 비밀값이 닿았다: ${secret}`).not.toContain(secret)
    }
    expect(text, '진단이 아예 기록되지 않았다').toContain('safeWrite:fail chat.json code=EPERM')
  } finally {
    if (before === undefined) delete process.env.KNUAF_APP_LOG
    else process.env.KNUAF_APP_LOG = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('시험 수집은 앱 태그 줄만 옮기고, 옮긴 줄에서도 값을 지운다', () => {
  const chunk = [
    'DevTools listening on ws://127.0.0.1:1234/devtools/browser/abc',
    `[knuaf] 파일을 저장하지 못했어요: chat.json (EPERM) — 토큰 ${TOKEN_MARK}`,
    `[shutdown] 정리 완료 120ms (sidecar.stop, chat.close) path=/Users/${PATH_MARK}/논문`,
    'Error: boom'
  ].join('\n')

  const lines = witnessLines('err', chunk, 1_700_000_000_000)
  const text = lines.join('\n')
  // 앱이 아니라고 표시된 줄은 원문 없이 개수만 남는다.
  expect(text).not.toContain('DevTools listening')
  expect(text).not.toContain('Error: boom')
  expect(text).toContain('앱 태그 없는 줄 2개 생략')
  // 앱 태그 줄은 남되 값은 지운다.
  expect(text).toContain('[knuaf] 파일을 저장하지 못했어요')
  expect(text).toContain('[shutdown] 정리 완료 120ms')
  expect(text).not.toContain(TOKEN_MARK)
  expect(text).not.toContain(PATH_MARK)
})
