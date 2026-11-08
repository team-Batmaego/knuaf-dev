// U1c — Astra 1회째 판정(차단 2건)의 재현·잠금 시험. 실제 AI 호출 0회(가짜 CLI 만).
//
// 지켜야 하는 경계(Astra 판정):
//  · 이미 초기화된 세션의 되돌리기 보호는 그대로다.
//  · 모델을 명시해 보낸 턴의 init 은 계정 기본값이 아니다.
import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection, CLAUDE_MODEL_COPY } from '../src/main/chat/claude'
import type { ModelChoice } from '../src/shared/chat'

/** Opus·Sonnet 두 줄 — 깊이 목록은 모델마다 다르다. */
const MODELS = [
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '깊은 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '일상 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
]

function rig(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u1c-'))
  const log = join(root, 'query.jsonl')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  // 시험이 env 를 직접 고친다(기본값 변화·초기화 실패 주입) — 연결이 같은 객체를 본다.
  const env: NodeJS.ProcessEnv = { ...process.env, W1_QUERY_LOG: log, W1_MODELS: JSON.stringify(MODELS), ...extra }
  let choice: ModelChoice | null = null
  let everChosen = false
  const seen: string[] = []
  const conn = new ClaudeConnection({
    binary, root, skill: '', env, openExternal: async () => {},
    modelChoice: () => choice,
    modelChosen: () => everChosen
  })
  const events = {
    message: () => {}, permission: () => {}, note: () => {},
    session: (id: string) => { seen.push(id) }, skill: () => {}
  }
  /** CLI 에 실제로 간 턴들 — `--model` 값을 그대로 본다. */
  const turns = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { args?: string[] })
    .filter((row): row is { args: string[] } => Array.isArray(row.args) && !row.args.includes('auth'))
    .map(({ args }) => ({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined }))
  return {
    conn, env, events, turns, binary, root,
    choose: (v: ModelChoice | null, chosen = true) => { choice = v; everChosen = chosen },
    session: () => seen.at(-1)
  }
}

/**
 * R1 — 초기화 전에 실패한 새 대화가 빈 표식을 남기면, 그 뒤 "안 고름"으로 새 대화를 여는
 * 복구 경로가 막힌다. 실패한 초기화는 덮어쓴 대화가 아니다.
 */
test('U1c-R1: 초기화 전에 실패한 새 대화는 기본값 복구를 막지 않는다', async () => {
  const r = rig()
  // 기본값을 모르는 연결에서 Opus 를 골라 새 대화를 연다 — 초기화 응답 전에 CLI 가 죽는다.
  r.choose({ model: 'opus', effort: null })
  r.env.W1_MODELS = 'invalid-json'
  await expect(r.conn.run('초기화 실패', undefined, r.events)).rejects.toThrow()
  // 실제 세션 init 은 오지 않았다 — 이 대화는 "덮어쓴 대화"가 아니다.
  expect(r.session()).toBeUndefined()

  delete r.env.W1_MODELS
  r.choose(null)
  await expect(r.conn.prepare(undefined)).resolves.toBeUndefined()
})

/**
 * R1 경계 — **이미 초기화된** 세션의 되돌리기 보호는 그대로여야 한다.
 * (모델을 보낸 대화를 해제하면 기본값을 모를 때 여전히 막는다.)
 */
test('U1c-R1경계: 이미 초기화된 대화의 해제는 계속 막는다', async () => {
  const r = rig()
  r.choose({ model: 'opus', effort: null })
  await r.conn.run('Opus 로 시작', undefined, r.events)
  const session = r.session()!
  expect(session).toBeDefined()
  expect(r.turns().at(-1)!.model).toBe('opus')

  // 이 대화는 init 까지 받았다 — 해제하면 기본값을 명시해야 한다. 모르면 막는다.
  r.choose(null)
  await expect(r.conn.prepare(session)).rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
})

/**
 * R2 — 모델 옵션 없이 연 새 대화의 init 은 **최신** 계정 기본값이다.
 * 처음 본 값만 저장하면 기본값이 바뀐 뒤에도 옛 모델을 계속 명시해 보낸다.
 */
test('U1c-R2: 새 대화에서 확인한 최신 기본값으로 갱신해 전송한다', async () => {
  const r = rig({ W1_INIT_MODEL: 'claude-sonnet-5' })
  r.choose(null, true)

  await r.conn.run('첫 기본값', undefined, r.events)
  expect(r.turns().at(-1)!.model).toBeUndefined()

  // 계정/프로젝트 기본값이 바뀐 상황 — 새 대화의 init 이 다른 모델을 알려 준다.
  r.env.W1_INIT_MODEL = 'claude-opus-5'
  await r.conn.run('기본값이 바뀐 뒤 새 대화', undefined, r.events)
  const second = r.session()!
  expect(second).toBeDefined()

  // 이 대화의 다음 턴은 **새로 확인한** 기본값을 명시한다.
  await r.conn.run('새 대화 이어 가기', second, r.events)
  expect(r.turns().at(-1)!.model).toBe('claude-opus-5')
})

/**
 * R2 경계 — 기본값이 갱신돼도 **모델을 고른 대화의 전송값**은 바뀌지 않는다.
 * (Astra 판정 ④ "이미 고른 모델이 있는 대화의 전송값에 영향이 없는지" 확인.)
 */
test('U1c-R2경계: 기본값이 갱신돼도 고른 모델의 전송값은 그대로다', async () => {
  const r = rig({ W1_INIT_MODEL: 'claude-opus-5' })
  r.choose(null, true)
  await r.conn.run('첫 기본값', undefined, r.events)

  // Opus 를 골라 대화 A 를 연다(모델을 보낸 턴).
  r.choose({ model: 'opus', effort: null })
  await r.conn.run('Opus 대화 시작', undefined, r.events)
  const opusSession = r.session()!
  expect(r.turns().at(-1)!.model).toBe('opus')

  // 계정 기본값이 바뀐다 — 모델 없이 연 새 대화가 그 값을 확인한다.
  r.env.W1_INIT_MODEL = 'claude-sonnet-5'
  r.choose(null, true)
  await r.conn.run('기본값 확인용 새 대화', undefined, r.events)
  expect(r.turns().at(-1)!.model).toBeUndefined()

  // 학생이 다시 Opus 를 고르고 대화 A 를 잇는다 — 갱신된 기본값이 끼어들지 않는다.
  r.choose({ model: 'opus', effort: null })
  await r.conn.run('Opus 대화 이어 가기', opusSession, r.events)
  expect(r.turns().at(-1)!.model).toBe('opus')
})

/**
 * R2 경계 — 모델을 **보낸** 턴의 init 은 기본값이 아니다(환경 변수 핀 포함).
 * 이 조건이 풀리면 핀의 모델이 계정 기본값으로 둔갑한다(웹 중요 3).
 */
test('U1c-R2경계: 모델을 보낸 턴의 초기화는 기본값으로 저장하지 않는다', async () => {
  const r = rig({ W1_INIT_MODEL: 'claude-opus-5' })
  const env: NodeJS.ProcessEnv = { ...r.env, KNUAF_CLAUDE_MODEL: 'sonnet' }
  const conn = new ClaudeConnection({
    binary: r.binary, root: r.root, skill: '', env, openExternal: async () => {},
    modelChoice: () => null, modelChosen: () => true
  })
  await conn.run('핀으로 첫 턴', undefined, r.events)
  expect(r.turns().at(-1)!.model).toBe('sonnet')

  // 핀을 뺀다 — 핀의 init 이 기본값으로 저장됐다면 통과하고, 아니면(옳음) 막힌다.
  delete env.KNUAF_CLAUDE_MODEL
  await expect(conn.prepare(r.session()!)).rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
})
