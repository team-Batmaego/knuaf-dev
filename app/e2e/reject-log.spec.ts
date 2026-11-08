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
  request_id: '0f0e6a4b-1c2d-4e3f-8a9b-0c1d2e3f4a5b', cleanup_errors: []
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
    reason: 'invalid_change', request_id: '0f0e6a4b-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
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
  // 형식이 틀린 요청 ID 는 원문을 남기지 않고 **필드 자체를 뺀다** — 가짜 ID 는 쓸모가 없다.
  expect('request_id' in record).toBe(false)
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
  // 폴더 안 상대경로도 파일 이름은 버리고 **폴더 종류·확장자만** 남긴다(검토 R3 2회째 차단 2).
  const local = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', detail: { path: 'sections/Ⅲ장/01_현황.md' } })
  })!
  expect(local.detail).toEqual({ path: 'sections/….md' })
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

test('형식에 맞는 개인정보도 경로·요청 ID 로 새지 않는다', () => {
  // 검토 R3 2회째 차단 2 반례 A·B — 정규식은 통과하지만 값 자체가 개인정보다.
  const record = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({
      operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', request_id: '900101-1234567',
      detail: { code: 'duplicate_path', path: 'sections/홍길동_900101-1234567.md' }
    })
  })!
  expect(record.detail).toEqual({ code: 'duplicate_path', path: 'sections/….md' })
  expect('request_id' in record).toBe(false)
  const line = JSON.stringify(record)
  for (const secret of ['홍길동', '900101-1234567']) {
    expect(line, `로그에 개인정보가 남았다: ${secret}`).not.toContain(secret)
  }
  // 모르는 폴더·확장자도 원문 없이 종류만 남는다 — 중간 폴더 이름은 학생이 지은 것일 수 있다.
  const unknown = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'invalid_change', detail: { path: '내논문/홍길동/1장.hwp' } })
  })!
  expect(unknown.detail).toEqual({ path: 'other/….other' })
  // 진짜 앱 UUID 는 그대로 남는다 — 진단 가치가 있고 개인정보가 아니다.
  const uuid = '3f2a1c9e-8b7d-4e6a-9c1f-2d3e4f5a6b7c'
  const kept = applyRejection({
    provider: 'codex', command: GG_APPLY, exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed',
      reason: 'revision_conflict', request_id: uuid })
  })!
  expect(kept.request_id).toBe(uuid)
})

test('정상 종료이거나 거절 결과가 없으면 기록을 만들지 않는다', () => {
  expect(applyRejection({ provider: 'codex', command: GG_APPLY, output: '{"revision": 4}', exitCode: 2 })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'ls', output: 'ls: cannot access c.json', exitCode: 1 })).toBeNull()
  // 커밋은 됐고 잠금 청소만 남은 exit 3 — 거절이 아니므로 사유 로그를 만들지 않는다.
  expect(applyRejection({ provider: 'codex', command: 'gg.py apply x', exitCode: 3,
    output: '{"operation": "apply", "target": "canonical", "commit_state": "committed_cleanup_pending", "reason": "release_cleanup_failed", "cleanup_errors": [{"release": "busy"}]}' })).toBeNull()
  // `blocked` 봉투라도 gg.py 의 고정 사유 목록에 없는 자유 문자열은 남기지 않는다. 실측 고정
  // 사유(`--change와 --expected-revision 필요`)는 아래 전용 시험이 기록을 확인한다.
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
  // 검토 R3 2회째 중요 1 반례 — 앞머리 실행기 뒤의 프로그램이 grep 이면 실행이 아니다.
  expect(applyRejection({ provider: 'codex', command: `env LANG=C grep 'gg.py apply' past.log`, exitCode: 1, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: `sudo -u root cat past.log | grep 'gg.py apply'`, exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: `printf '%s\\n' "gg.py apply --change c.json"`, exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
  // 주석·코드 문자열 안의 언급도 실행이 아니다.
  expect(applyRejection({ provider: 'codex', command: '# gg.py apply . --change c.json\nls', exitCode: 2, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: `python -c "print('gg.py apply')"`, exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: `node -e "console.log('gg.py apply')"`, exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
  // `--help`·`--version` 같은 조회는 apply 실행이 아니다.
  expect(applyRejection({ provider: 'codex', command: 'gg.py --help apply', exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
  expect(applyRejection({ provider: 'codex', command: 'gg.py apply --help', exitCode: 0, output: REJECT_OUTPUT })).toBeNull()
})

test('앞머리 실행기를 벗기면 진짜 gg.py apply 실행을 놓치지 않는다', () => {
  // 검토 R3 2회째 중요 1 — 출처 판정을 낱말 해석으로 바꾸면서 실행을 놓치면 로그가 통째로 빈다.
  const commands = [
    `env LANG=C python3 .agents/skills/knuaf-dev/scripts/gg.py apply . --change c.json`,
    `env -u LANG PYTHONPATH=/x python gg.py apply . --change c.json`,
    'sudo -u root python gg.py apply . --change c.json',
    'command python gg.py apply . --change c.json',
    'nohup python gg.py apply . --change c.json > out.log 2>&1',
    `sh -c 'python gg.py apply . --change c.json'`,
    `bash -lc "python gg.py apply . --change c.json"`,
    '/usr/bin/python3 gg.py apply .',
    'timeout 60 python gg.py apply .',
    'python3 -B gg.py apply .',
    './gg.py apply .'
  ]
  for (const command of commands) {
    const record = applyRejection({ provider: 'codex', command, output: REJECT_OUTPUT, exitCode: 2 })
    expect(record, `실행을 놓쳤다: ${command}`).not.toBeNull()
    expect(record!.reason).toBe('invalid_change')
  }
  // 페이로드를 벗긴 뒤에도 로그에는 프로그램·옵션 이름만 남는다.
  const nested = applyRejection({ provider: 'codex', command: `sudo sh -c 'python gg.py apply . --request-id 1 --change c.json'`, output: REJECT_OUTPUT, exitCode: 2 })!
  expect(nested.command).toBe('gg.py apply --request-id --change')
})

test('blocked 봉투는 gg.py 의 고정 사유일 때만 거절로 기록한다', () => {
  // 회귀 — `gg.py apply .`(인자 누락)는 blocked 봉투(exit 2)로 끝난다. 핀 스크립트 실측값 그대로.
  const record = applyRejection({
    provider: 'codex', command: 'python gg.py apply .', exitCode: 2,
    output: '{"status": "blocked", "reason": "--change와 --expected-revision 필요"}'
  })
  expect(record).toMatchObject({ reason: '--change와 --expected-revision 필요', exitCode: 2 })
  // blocked 봉투에는 apply 서명 필드가 없다 — 없는 값을 지어내지 않는다.
  expect(record!.operation).toBeUndefined()
  expect(record!.target).toBeUndefined()
  expect(record!.commit_state).toBeUndefined()
  // 목록 밖 자유 문자열·경로가 섞인 사유는 원문을 남기지 않는다.
  for (const reason of ['missing.json 파일이 없음', "[Errno 2] No such file or directory: 'missing.json'", '/Users/홍길동/논문']) {
    expect(applyRejection({
      provider: 'codex', command: 'python gg.py apply . --change missing.json', exitCode: 2,
      output: JSON.stringify({ status: 'blocked', reason })
    }), `자유 문자열 사유가 기록됐다: ${reason}`).toBeNull()
  }
  // 출처가 확인되지 않은 blocked 봉투도 기록하지 않는다.
  expect(applyRejection({ provider: 'codex', command: `env LANG=C grep 'gg.py apply' past.log`, exitCode: 1,
    output: '{"status": "blocked", "reason": "--change와 --expected-revision 필요"}' })).toBeNull()
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
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "invalid_change",\n "cleanup_errors": [],\n "request_id": "7c9d1e2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f"\n}' })
  expect(invalid).toMatchObject({ reason: 'invalid_change', commit_state: 'not_committed', request_id: '7c9d1e2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f' })
  const conflict = applyRejection({ provider: 'codex', command: GG_APPLY,
    exitCode: 2, output: '{\n "operation": "apply",\n "target": "canonical",\n "commit_state": "not_committed",\n "reason": "revision_conflict",\n "cleanup_errors": [],\n "revision": 0,\n "request_id": "8d0e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a"\n}' })
  expect(conflict).toMatchObject({ reason: 'revision_conflict', revision: 0 })
})

test('진단의 원문 문자열은 버리고 허용 키·허용 모양만 남긴다', () => {
  const record = applyRejection({
    provider: 'codex', command: 'gg.py apply x', exitCode: 2,
    output: JSON.stringify({ operation: 'apply', target: 'canonical', commit_state: 'not_committed', reason: 'invalid_change',
      detail: { code: 'duplicate_path', path: 'sections/홍길동/01.md', raw: '학생이 쓴 본문 전체', index: -1 } })
  })
  expect(record?.detail).toEqual({ code: 'duplicate_path', path: 'sections/….md' })
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
