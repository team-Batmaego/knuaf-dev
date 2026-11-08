/**
 * 정본 등록 거절 사유 기록 (발주 R3, 윈도우 W-08).
 *
 * 윈도우 시험에서 첫 장 등록이 형식 검증으로 거절됐다가 재시도로 등록됐는데, **왜** 거절됐는지
 * 원문이 어디에도 남지 않았다. 앱은 도우미의 셸 출력을 저장하지 않고, `gg.py apply` 의 거절
 * 결과도 그 출력 안에서만 존재한다. 여기서 거는 것은 둘이다 — ①그 출력에서 거절을 찾아
 * 사유·코드 수준으로 한 줄 남긴다 ②정상 종료나 거절이 아닌 출력에는 아무것도 남기지 않는다.
 * 학생에게 보이는 화면·문구는 이 시험의 대상이 아니다(불변이어야 한다).
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

test('거절 결과에서 사유·코드만 뽑아 기록을 만든다', () => {
  const record = applyRejection({ provider: 'codex', command: 'python gg.py apply "논문" --change c.json --expected-revision 3', output: REJECT_OUTPUT, exitCode: 2, at: '2026-11-08T00:00:00.000Z' })
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

test('정상 종료이거나 거절 결과가 없으면 기록을 만들지 않는다', () => {
  expect(applyRejection({ provider: 'codex', command: 'python gg.py apply x', output: REJECT_OUTPUT, exitCode: 0 })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'python gg.py apply x', output: '{"revision": 4}', exitCode: 2 })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'ls', output: 'ls: cannot access c.json', exitCode: 1 })).toBeNull()
  // 커밋은 됐고 잠금 청소만 남은 exit 3 — 거절이 아니므로 사유 로그를 만들지 않는다.
  expect(applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 3,
    output: '{"operation": "apply", "target": "canonical", "commit_state": "committed_cleanup_pending", "reason": "release_cleanup_failed", "cleanup_errors": [{"release": "busy"}]}' })).toBeNull()
  // `blocked` 봉투(exit 2)도 같은 자리에서 잡는다 — `--change` 누락 같은 호출 오류.
  const blocked = applyRejection({ provider: 'codex', command: 'python gg.py apply x', output: '{"status": "blocked", "reason": "--change 필요"}', exitCode: 2 })
  expect(blocked?.reason).toBe('--change 필요')
  // 남의 CLI 가 같은 봉투를 찍으면 gg 결과로 보지 않는다.
  expect(applyRejection({ provider: 'codex', command: 'npm run build', output: '{"status": "blocked", "reason": "peer dep"}', exitCode: 2 })).toBeNull()
})

test('실기에서 나온 두 거절 모양을 그대로 잡는다', () => {
  // 핀 스크립트로 직접 재현한 출력 — `invalid_change`(exit 2)와 `revision_conflict`(exit 2).
  const invalid = applyRejection({ provider: 'codex', command: '$PY gg.py apply . --change ch.json --expected-revision 0',
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "invalid_change",\n "cleanup_errors": [],\n "request_id": "r3:test2"\n}' })
  expect(invalid).toMatchObject({ reason: 'invalid_change', commit_state: 'not_committed', request_id: 'r3:test2' })
  const conflict = applyRejection({ provider: 'codex', command: 'gg.py apply . --change ch.json --expected-revision 1',
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "revision_conflict",\n "cleanup_errors": [],\n "revision": 0,\n "request_id": "r3:test"\n}' })
  expect(conflict).toMatchObject({ reason: 'revision_conflict', revision: 0 })
})

test('진단의 원문 문자열은 버리고 허용 키만 남긴다', () => {
  const record = applyRejection({
    provider: 'codex', command: 'gg.py apply x', exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed', reason: 'invalid_change',
      detail: { code: 'duplicate_path', path: 'sections/01.md', raw: '학생이 쓴 본문 전체', index: -1 } })
  })
  expect(record?.detail).toEqual({ code: 'duplicate_path', path: 'sections/01.md' })
})

test('기록은 한 줄씩 덧붙고, 쓸 수 없으면 던지지 않는다', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reject-log-')), 'nested', 'apply-reject.log')
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', output: REJECT_OUTPUT, exitCode: 2 })!
  expect(recordRejection(file, record)).toBe(true)
  expect(recordRejection(file, { ...record, reason: 'second' })).toBe(true)
  const lines = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as { reason: string })
  expect(lines.map((line) => line.reason)).toEqual(['invalid_change', 'second'])
  // 디렉터리를 만들 수 없는 자리(파일을 부모로 쓴 경우)에도 턴을 막지 않는다.
  const blocked = join(mkdtempSync(join(tmpdir(), 'reject-log-')), 'file')
  writeFileSync(blocked, 'not a dir', 'utf-8')
  expect(recordRejection(join(blocked, 'log'), record)).toBe(false)
})

test('상한을 넘으면 한 번만 물러나고 무한히 커지지 않는다', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reject-log-')), 'apply-reject.log')
  writeFileSync(file, `${'x'.repeat(1024 * 1024 + 1)}\n`, 'utf-8')
  const record = applyRejection({ provider: 'codex', command: 'gg.py apply x', output: REJECT_OUTPUT, exitCode: 2 })!
  expect(recordRejection(file, record)).toBe(true)
  expect(existsSync(`${file}.1`)).toBe(true)
  expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1)
  expect(readFileSync(`${file}.1`, 'utf-8').length).toBeGreaterThan(1024 * 1024)
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
      item: { id: 'cmd-1', type: 'commandExecution', command: 'python gg.py apply . --change c.json --expected-revision 3',
        cwd: '/tmp', status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output, exitCode, durationMs: 12 }
    }
  }
}

async function runTurn(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'reject-run-'))
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
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

test('도우미의 gg.py 거절은 논문 폴더의 로그 한 줄로 남는다', async () => {
  const { log } = await runTurn([commandCompleted(REJECT_OUTPUT, 2)])
  expect(existsSync(log), '거절 사유가 로그에 남지 않았다').toBe(true)
  const [record] = readFileSync(log, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(record).toMatchObject({ provider: 'codex', exitCode: 2, reason: 'invalid_change', commit_state: 'not_committed' })
})

test('정상 종료한 명령은 로그를 만들지 않는다', async () => {
  const { log } = await runTurn([commandCompleted('{"revision": 4}', 0)])
  expect(existsSync(log)).toBe(false)
})
