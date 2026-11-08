/**
 * 정본 등록 거절 사유 기록 (발주 R3, 윈도우 W-08).
 *
 * 윈도우 시험에서 첫 장 등록이 형식 검증으로 거절됐다가 재시도로 등록됐는데, **왜** 거절됐는지
 * 원문이 어디에도 남지 않았다. 앱은 도우미의 셸 출력을 저장하지 않고, `gg.py apply` 의 거절
 * 결과도 그 출력 안에서만 존재한다. 여기서 거는 것은 둘이다 — ①그 출력에서 거절을 찾아
 * 사유·코드 수준으로 한 줄 남긴다 ②정상 종료나 거절이 아닌 출력에는 아무것도 남기지 않는다.
 * 학생에게 보이는 화면·문구는 이 시험의 대상이 아니다(불변이어야 한다).
 *
 * 1회째 검토(차단 2·중요 4) 뒤로는 값의 **모양**을 본다 — 명령줄 원문·인자 값·절대경로·
 * 자유 문자열은 로그에 들어가지 않고, 형식이 틀린 값은 `<redacted>` 로 바뀐다.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRejection, recordRejection } from '../src/main/chat/rejectLog'
import { CodexConnection } from '../src/main/chat/codex'
import { findExecutable } from '../src/main/agent'
import type { AgentEvents } from '../src/main/chat/contracts'
import { fakeCodexEnv } from './fixtures/fake-codex'

/**
 * 실기에서 본 모양 그대로 — `gg.py` 는 거절 결과를 stdout 에 JSON 으로 찍고 exit 2 로 끝난다
 * (`COMMIT_EXIT`: committed 0, not_committed 2, committed_cleanup_pending 3, indeterminate 4).
 * 셸이 앞뒤에 경고를 섞어도 결과 객체를 찾아야 한다.
 */
const REJECT = {
  operation: 'apply', target: 'canonical', commit_state: 'not_committed', reason: 'invalid_change',
  detail: { code: 'fact_metadata_invalid', field: 'measure', index: 2 },
  request_id: 'chat:run-1', cleanup_errors: []
}
const REJECT_OUTPUT = `warning: skill cache stale\n${JSON.stringify(REJECT, null, 2)}\n`
const GG_APPLY = 'python .agents/skills/knuaf-dev/scripts/gg.py apply . --change c.json --expected-revision 3'

/** 시험이 만든 임시 폴더는 끝나면 지운다 — 1 MiB 회전 파일이 남지 않게(검토 권고 3). */
const scratch: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
test.afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('거절 결과에서 사유·코드만 뽑아 기록을 만든다', () => {
  const record = applyRejection({ provider: 'codex', command: GG_APPLY, output: REJECT_OUTPUT, exitCode: 2, at: '2026-11-08T00:00:00.000Z' })
  expect(record).not.toBeNull()
  expect(record).toMatchObject({
    at: '2026-11-08T00:00:00.000Z', provider: 'codex', exitCode: 2,
    operation: 'apply', target: 'canonical', commit_state: 'not_committed',
    reason: 'invalid_change', request_id: 'chat:run-1',
    detail: { code: 'fact_metadata_invalid', field: 'measure', index: 2 }
  })
  // 원고 본문·명령 출력 전문은 남기지 않는다.
  expect(JSON.stringify(record)).not.toContain('warning: skill cache stale')
})

test('명령줄 원문·인자 값·경로는 저장하지 않고 작업 이름과 옵션 이름만 남긴다', () => {
  // 검토 차단 1 반례 — 같은 셸 명령 안에서 학생 실데이터를 파일로 쓰고 gg.py 로 등록한다.
  const command = `printf '학생: 홍길동, 개인정보: 900101-1234567' > /tmp/c.json; ${GG_APPLY}`
  const record = applyRejection({ provider: 'codex', command, output: REJECT_OUTPUT, exitCode: 2 })!
  expect(record.command).toBe('gg.py apply --change --expected-revision')
  const line = JSON.stringify(record)
  for (const secret of ['홍길동', '900101-1234567', '/tmp/c.json', 'printf', '.agents/skills']) {
    expect(line, `로그에 원문 조각이 남았다: ${secret}`).not.toContain(secret)
  }
  // 절대경로를 인자로 준 명령도 경로가 아니라 옵션 이름만 남는다.
  const absolute = applyRejection({ provider: 'codex', command: 'python gg.py apply "/Users/홍길동/졸업논문" --change /tmp/c.json', output: REJECT_OUTPUT, exitCode: 2 })!
  expect(absolute.command).toBe('gg.py apply --change')
  expect(JSON.stringify(absolute)).not.toContain('홍길동')
})

test('진단 값도 형식이 틀리면 원문 대신 고정 표시로 바꾼다', () => {
  // 검토 차단 2 반례 — 키는 허용 목록이지만 값에 원고·개인정보가 실려 있다.
  const record = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({
      operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: '학생 이름 및 원고의 긴 원문',
      request_id: '홍길동 900101-1234567',
      detail: {
        code: 'duplicate_path', field: 'measure',
        missing: ['measure', '학생 이름 및 원고의 긴 원문 내용'],
        path: '/Users/홍길동/논문/sections/01.md',
        index: -1
      }
    })
  })!
  expect(record.reason).toBe('<redacted>')
  expect(record.request_id).toBe('<redacted>')
  expect(record.detail).toEqual({
    code: 'duplicate_path', field: 'measure',
    missing: ['measure', '<redacted>'],
    path: '<redacted>'
  })
  const line = JSON.stringify(record)
  for (const secret of ['홍길동', '학생 이름', '900101-1234567', '/Users/']) expect(line).not.toContain(secret)
  // 폴더 밖을 가리키는 상대경로도 원문을 쓰지 않는다.
  const escape = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', detail: { path: '../../etc/passwd' } })
  })!
  expect(escape.detail).toEqual({ path: '<redacted>' })
  // 폴더 안 상대경로는 논문 파일 이름이 한글이어도 그대로 남는다(진단 가치 보존).
  const local = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', detail: { path: 'sections/Ⅲ장/01_현황.md' } })
  })!
  expect(local.detail).toEqual({ path: 'sections/Ⅲ장/01_현황.md' })
  // 지나치게 긴 경로도 원문을 쓰지 않는다 — 로그 한 줄을 원고 본문만 한 길이로 키우지 않게.
  const long = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', detail: { path: `sections/${'가'.repeat(500)}.md` } })
  })!
  expect(long.detail).toEqual({ path: '<redacted>' })
  // 드라이브 문자·UNC·절대경로는 상대 모양이 아니므로 원문을 쓰지 않는다.
  for (const path of ['C:/Users/x/논문/01.md', '\\\\server\\share\\01.md', '/Users/x/01.md']) {
    const blocked = applyRejection({
      provider: 'codex', command: GG_APPLY, exitCode: 2,
      output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
        reason: 'invalid_change', detail: { path } })
    })!
    expect(blocked.detail, `절대경로가 남았다: ${path}`).toEqual({ path: '<redacted>' })
  }
})

test('정상 종료이거나 거절 결과가 없으면 기록을 만들지 않는다', () => {
  expect(applyRejection({ provider: 'codex', command: GG_APPLY, output: '{"revision": 4}', exitCode: 2 })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'ls', output: 'ls: cannot access c.json', exitCode: 1 })).toBeNull()
  // 커밋은 됐고 잠금 청소만 남은 exit 3 — 거절이 아니므로 사유 로그를 만들지 않는다.
  expect(applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 3,
    output: '{"operation": "apply", "target": "canonical", "commit_state": "committed_cleanup_pending", "reason": "release_cleanup_failed", "cleanup_errors": [{"release": "busy"}]}' })).toBeNull()
  // `blocked` 봉투는 자유 문자열 사유라 남기지 않는다 — 형식 검증을 통과할 수 없다.
  expect(applyRejection({ provider: 'codex', command: 'python gg.py apply x', output: '{"status": "blocked", "reason": "--change 필요"}', exitCode: 2 })).toBeNull()
})

test('확정 거절이 아닌 상태(indeterminate)와 무관한 명령의 출력은 기록하지 않는다', () => {
  // 검토 중요 1 반례 A — 커밋 여부 불명은 거절이 아니다.
  expect(applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 4,
    output: '{"operation":"apply","target":"canonical","commit_state":"indeterminate","reason":"commit_state_unknown"}' })).toBeNull()
  // 반례 B — gg.py 를 부르지 않은 명령의 출력에 앞선 실패 사례가 인용돼 있어도 거절이 아니다.
  expect(applyRejection({ provider: 'codex', command: 'npm test', exitCode: 1, output: REJECT_OUTPUT })).toBeNull()
  // 글자로만 gg.py 를 언급하는 명령(에코·검색·과거 출력 조회)도 실행이 아니다.
  expect(applyRejection({ provider: 'codex', command: `echo "${GG_APPLY}"`, exitCode: 1, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'grep -r "gg.py apply" logs', exitCode: 1, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'git show HEAD:run.log | grep gg.py apply', exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
})

test('짝 잃은 따옴표 뒤에 오는 진짜 거절 JSON 을 놓치지 않는다', () => {
  // 검토 중요 2 반례 — 경고 줄의 따옴표가 뒤 JSON 을 삼키면 안 된다.
  const output = `warning: "unterminated\n{"operation":"apply","target":"canonical","commit_state":"not_committed","reason":"invalid_change"}`
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 2, output })!
  expect(record.reason).toBe('invalid_change')
  expect(record.commit_state).toBe('not_committed')
})

test('셸 종료코드가 0 이어도 출처가 확인된 gg.py 거절은 기록한다', () => {
  // 검토 중요 3 반례 — `|| true` 로 셸은 성공으로 끝났지만 등록은 거절됐다.
  const record = applyRejection({ provider: 'codex', command: 'python gg.py apply . --change bad.json || true', output: REJECT_OUTPUT, exitCode: 0 })
  expect(record).toMatchObject({ reason: 'invalid_change', exitCode: 0 })
})

test('실기에서 나온 두 거절 모양을 그대로 잡는다', () => {
  // 핀 스크립트로 직접 재현한 출력 — `invalid_change`(exit 2)와 `revision_conflict`(exit 2).
  const invalid = applyRejection({ provider: 'codex', command: GG_APPLY,
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "invalid_change",\n "cleanup_errors": [],\n "request_id": "r3:test2"\n}' })
  expect(invalid).toMatchObject({ reason: 'invalid_change', commit_state: 'not_committed', request_id: 'r3:test2' })
  const conflict = applyRejection({ provider: 'codex', command: GG_APPLY,
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "revision_conflict",\n "cleanup_errors": [],\n "revision": 0,\n "request_id": "r3:test"\n}' })
  expect(conflict).toMatchObject({ reason: 'revision_conflict', revision: 0 })
})

test('진단의 원문 문자열은 버리고 허용 키·허용 모양만 남긴다', () => {
  const record = applyRejection({
    provider: 'codex', command: 'gg.py apply x', exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed', reason: 'invalid_change',
      detail: { code: 'duplicate_path', path: 'sections/01.md', raw: '학생이 쓴 본문 전체', index: -1 } })
  })
  expect(record?.detail).toEqual({ code: 'duplicate_path', path: 'sections/01.md' })
})

test('기록은 한 줄씩 덧붙고, 쓸 수 없으면 던지지 않는다', () => {
  const file = join(tempDir('reject-log-'), 'nested', 'apply-reject.log')
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', output: REJECT_OUTPUT, exitCode: 2 })!
  expect(recordRejection(file, record)).toBe(true)
  expect(recordRejection(file, { ...record, reason: 'second' })).toBe(true)
  const lines = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as { reason: string })
  expect(lines.map((line) => line.reason)).toEqual(['invalid_change', 'second'])
  // 디렉터리를 만들 수 없는 자리(파일을 부모로 쓴 경우)에도 턴을 막지 않는다.
  const blocked = join(tempDir('reject-log-'), 'file')
  writeFileSync(blocked, 'not a dir', 'utf-8')
  expect(recordRejection(join(blocked, 'log'), record)).toBe(false)
})

test('상한을 넘으면 한 번만 물러나고, 회전에 실패하면 쓰지 않고 false 를 돌려준다', () => {
  const file = join(tempDir('reject-log-'), 'apply-reject.log')
  writeFileSync(file, `${'x'.repeat(1024 * 1024 + 1)}\n`, 'utf-8')
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', output: REJECT_OUTPUT, exitCode: 2 })!
  expect(recordRejection(file, record)).toBe(true)
  expect(existsSync(`${file}.1`)).toBe(true)
  expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1)
  expect(readFileSync(`${file}.1`, 'utf-8').length).toBeGreaterThan(1024 * 1024)

  // 검토 중요 4 반례 — `.1` 자리에 디렉터리가 있어 회전이 실패하면 파일을 키우지 않는다.
  const locked = join(tempDir('reject-log-'), 'apply-reject.log')
  writeFileSync(locked, 'y'.repeat(1024 * 1024 + 1), 'utf-8')
  mkdirSync(`${locked}.1`)
  const before = statSync(locked).size
  expect(recordRejection(locked, record)).toBe(false)
  expect(statSync(locked).size).toBe(before)

  // 크기 검사는 현재 크기 + 추가 바이트로 한다 — 여유가 1바이트뿐이면 회전한다.
  const tight = join(tempDir('reject-log-'), 'apply-reject.log')
  writeFileSync(tight, 'z'.repeat(1024 * 1024 - 1), 'utf-8')
  expect(recordRejection(tight, record)).toBe(true)
  expect(existsSync(`${tight}.1`)).toBe(true)
  // 두 번째 회전도 되어야 한다 — 이전 세대를 남겨 두면 윈도우에서 그 뒤 기록이 영영 멈춘다.
  writeFileSync(tight, 'z'.repeat(1024 * 1024), 'utf-8')
  expect(recordRejection(tight, record)).toBe(true)
  expect(readFileSync(tight, 'utf-8').trim().split('\n')).toHaveLength(1)
})

test('거절이 앞쪽에 있고 뒤에 20만 자가 넘는 잡음이 붙어도 찾는다', () => {
  // 검토 권고 1 반례 — 거절 JSON 뒤로 긴 진행 출력이 이어진다.
  const noise = Array.from({ length: 20_000 }, (_, i) => `progress ${i} ${'x'.repeat(20)}`).join('\n')
  const output = `${JSON.stringify(REJECT)}\n${noise}`
  expect(output.length).toBeGreaterThan(400_000) // 창을 나눠 보는 경로를 실제로 탄다
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 2, output })!
  expect(record.reason).toBe('invalid_change')
})

test('긴 잡음·짝 잃은 괄호가 섞여도 결과를 찾고 빨리 끝난다', () => {
  const noise = `${'{'.repeat(50_000)}\n${Array.from({ length: 2000 }, (_, i) => `log line ${i} {"junk": true}`).join('\n')}\n`
  const started = Date.now()
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', output: `${noise}${JSON.stringify(REJECT)}`, exitCode: 2 })
  expect(record?.reason).toBe('invalid_change')
  expect(Date.now() - started).toBeLessThan(2_000)
})

/** `commandExecution` 완료 알림 하나 — 스키마의 CommandExecutionThreadItem. */
function commandCompleted(output: string, exitCode: number) {
  return {
    method: 'item/completed',
    params: {
      threadId: 't-fake', turnId: 'u-fake',
      item: { id: 'cmd-1', type: 'commandExecution', command: GG_APPLY,
        cwd: '/tmp', status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output, exitCode, durationMs: 12 }
    }
  }
}

/** 가짜 Codex 로 한 턴을 돌린다. `blockLogDir` 면 로그 폴더 자리에 파일을 놓아 쓰기를 실패시킨다. */
async function runTurn(events: unknown[], blockLogDir = false) {
  const root = tempDir('reject-run-')
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
  if (blockLogDir) writeFileSync(join(root, '.knuaf-gui'), 'not a dir', 'utf-8')
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), { FAKE_CODEX_COMMAND_EVENTS: JSON.stringify(events) }) }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const conn = new CodexConnection({ binary, root, skill, env, openExternal: async () => {} })
  const stub: AgentEvents = { message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }
  try {
    await conn.run('시험', undefined, stub)
    return { log: join(root, '.knuaf-gui', 'apply-reject.log') }
  } finally {
    await conn.stop()
  }
}

test('도우미의 gg.py 거절은 논문 폴더의 로그 정확히 한 줄로 남는다', async () => {
  const { log } = await runTurn([commandCompleted(REJECT_OUTPUT, 2)])
  expect(existsSync(log), '거절 사유가 로그에 남지 않았다').toBe(true)
  const lines = readFileSync(log, 'utf-8').trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]) as Record<string, unknown>).toMatchObject({ provider: 'codex', exitCode: 2, reason: 'invalid_change', commit_state: 'not_committed' })
})

test('정상 종료한 명령은 로그를 만들지 않는다', async () => {
  const { log } = await runTurn([commandCompleted('{"revision": 4}', 0)])
  expect(existsSync(log)).toBe(false)
})

test('로그를 못 써도 턴은 정상 완료된다', async () => {
  const { log } = await runTurn([commandCompleted(REJECT_OUTPUT, 2)], true)
  expect(existsSync(log)).toBe(false)
})
