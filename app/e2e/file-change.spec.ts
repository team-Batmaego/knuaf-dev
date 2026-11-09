import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexConnection } from '../src/main/chat/codex'
import { findExecutable } from '../src/main/agent'
import type { AgentEvents } from '../src/main/chat/contracts'
import type { PermissionRequest } from '../src/shared/chat'
import { fakeCodexEnv } from './fixtures/fake-codex'

const update = { path: 'sections/01.md', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-기존 내용\n+새 내용\n' }
const add = { path: '자료/새 파일.md', kind: { type: 'add' }, diff: '새 문서\n두 번째 줄\n' }
const started = (id: string, changes: unknown[], threadId = 't-fake', turnId = 'u-fake') => ({
  method: 'item/started', params: { threadId, turnId, item: { type: 'fileChange', id, changes, status: 'inProgress' } }
})
const patch = (id: string, changes: unknown[], turnId = 'u-fake') => ({
  method: 'item/fileChange/patchUpdated', params: { threadId: 't-fake', turnId, itemId: id, changes }
})

async function approval(before: unknown[], after: unknown[] = [], observe?: (requests: PermissionRequest[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'w08-root-'))
  const skill = join(root, '.agents', 'skills', 'knuaf-dev')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
  const env = { ...process.env, ...fakeCodexEnv(join(root, 'bin'), {
    FAKE_CODEX_FILE_EVENTS: JSON.stringify(before), FAKE_CODEX_FILE_AFTER: JSON.stringify(after)
  }) }
  const binary = findExecutable('codex', env)
  if (!binary) throw new Error('가짜 Codex를 찾지 못했어요.')
  const conn = new CodexConnection({ binary, root, skill, env, openExternal: async () => {} })
  const requests: PermissionRequest[] = []
  const events: AgentEvents = { message: () => {}, permission: request => requests.push(request), note: () => {}, session: () => {}, skill: () => {} }
  const run = conn.run('파일 변경 시험', undefined, events).catch(() => {})
  try {
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    if (observe) await observe(requests)
    return requests
  } finally {
    await conn.stop()
    await run
  }
}

test('승인 요청의 같은 항목과 턴에 속한 파일 변경만 보여 준다', async () => {
  const requests = await approval([
    started('file-1', [update, add]),
    started('file-2', [{ ...update, path: '다른-항목.md' }]),
    started('file-1', [{ ...update, path: '다른-턴.md' }], 't-fake', '다른-턴'),
    started('file-1', [{ ...update, path: '다른-대화.md' }], '다른-대화')
  ])
  expect(requests[0].fileChanges).toEqual([update, add])
})

test('승인 전 patchUpdated의 변경은 처음 항목보다 최신이다', async () => {
  const requests = await approval([started('file-1', [update]), patch('file-1', [add])])
  expect(requests[0].fileChanges).toEqual([add])
})

test('같은 항목의 늦은 알림은 대기 중인 카드를 갱신한다', async () => {
  await approval([], [started('file-1', [update])], async requests => {
    expect(requests[0].fileChanges).toBeUndefined()
    await expect.poll(() => requests.at(-1)?.fileChanges).toEqual([update])
    expect(requests.at(-1)?.id).toBe(requests[0].id)
  })
})

test('승인 대기 중 파일 변경 항목이 끝나면 오래된 미리보기를 감춘다', async () => {
  const completed = { method: 'item/completed', params: { threadId: 't-fake', turnId: 'u-fake', item: { id: 'file-1', type: 'fileChange' } } }
  await approval([started('file-1', [update])], [completed], async requests => {
    expect(requests[0].fileChanges).toEqual([update])
    await expect.poll(() => requests.at(-1)?.detail).toContain('변경 내용을 확인하지 못했어요')
    expect(requests.at(-1)?.fileChanges).toBeUndefined()
  })
})

test('변경 내용을 받지 못하면 JSON 대신 학생이 읽을 안내를 보인다', async () => {
  const requests = await approval([started('file-2', [update])])
  expect(requests[0].detail).toContain('변경 내용을 확인하지 못했어요')
  expect(requests[0].detail).not.toContain('threadId')
  expect(requests[0].fileChanges).toBeUndefined()
})
