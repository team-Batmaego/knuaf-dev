// U1b — 웹 1차 검토 지적의 **재현** 시험. 고치기 전 코드에서 실패해야 한다.
//
// 뿌리(발주서 ④): 턴 값을 한 번 고정하지 않고 `prepare()`·`run()`·init 처리에서 각각
// 다시 읽는다. 그래서 ① 전송 준비 중에 칩을 만지면 실제로 보낸 값과 판정이 갈리고,
// ② 환경 변수 핀이 "학생 선택"처럼 섞인다.
//
// 실제 AI 호출 0회 — 가짜 CLI 만 띄운다.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection, CLAUDE_MODEL_COPY, toChatModelInfo } from '../src/main/chat/claude'
import { ChatService } from '../src/main/chat/service'
import { skillSource } from '../src/main/agent'
import { effectiveModelChoice, type ChatSnapshot, type ModelChoice } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')

/** Opus 는 max 까지, Sonnet 은 high 까지 — 실제 목록의 모양. */
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: '계정 기본 모델', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '가장 깊은 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '일상 작업', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }
]
/** 별칭으로 보낸 모델을 실제 CLI 처럼 그 id 로 답한다. */
const BY_MODEL: Record<string, string> = { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', 'claude-opus-5': 'claude-opus-5' }

function scene(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u1b-'))
  const log = join(root, 'query.jsonl')
  const seq = join(root, 'sessions.txt')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  const env = {
    ...process.env, W1_QUERY_LOG: log, W1_MODELS: JSON.stringify(MODELS),
    W1_SESSION_SEQ: seq, W1_INIT_MODEL_BY_MODEL: JSON.stringify(BY_MODEL), ...extra
  }
  /** CLI 에 실제로 간 턴들 — `--model`·`--effort`·`--resume` 을 그대로 본다. */
  const turns = (): { args: string[]; model?: string; effort?: string; resume?: string }[] =>
    readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { args?: string[] })
      .filter((row): row is { args: string[] } => Array.isArray(row.args) && !row.args.includes('auth'))
      .map(({ args }) => ({
        args,
        model: args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined,
        effort: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined,
        resume: args.find((a) => a.startsWith('--resume='))?.slice('--resume='.length)
      }))
  const stored = new Map<string, ModelChoice | null>()
  const make = (over: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) => new ChatService({
    skillSource: () => skillSource(appRoot, false, ''),
    userData: mkdtempSync(join(tmpdir(), 'kd-u1b-ud-')),
    emit: () => {}, openExternal: async () => {},
    modelChoice: (p) => stored.get(p) ?? null,
    modelChosen: (p) => stored.has(p),
    storeModelChoice: (p, choice) => { stored.set(p, choice) },
    connectionFactory: (provider, options) => provider === 'claude'
      ? new ClaudeConnection({ ...options, binary, env })
      : { status: async () => ({ installed: true, connected: true, version: null, detail: '' }), login: async () => {}, run: async () => {}, respond: () => {}, stop: async () => {} },
    ...over
  })
  return { root, log, binary, env, turns, stored, make }
}

async function idle(svc: ChatService, root: string): Promise<ChatSnapshot> {
  await expect.poll(() => svc.snapshot(root, 'claude').state, { timeout: 20_000 }).not.toBe('running')
  return svc.snapshot(root, 'claude')
}

/**
 * [중요 1] 전송 준비 중에 선택을 해제하면 기본값 미확인 막기를 우회한다.
 * `prepare()` 는 "고른 모델이 있다"로 통과하고, 뒤늦게 `run()` 이 선택을 다시 읽어
 * 모델 키 없이 `resume` 한다 — CLI 는 마지막 모델을 복원하므로 되돌리기가 조용히 실패한다.
 */
test('U1b-1: 기본값을 모르는 대화에서 전송 준비 중 해제해도 모델 없이 재개하지 않는다', async () => {
  const s = scene()
  // 같은 연결에서 prepare() 와 run() 이 차례로 값을 읽는 상황을 만든다 —
  // prepare 가 본 값은 Opus(통과), 그 뒤 학생이 해제해 run 이 보는 값은 null.
  const seq: (ModelChoice | null)[] = [{ model: 'opus', effort: null }, { model: 'opus', effort: null }, null]
  let i = 0
  const conn = new ClaudeConnection({
    binary: s.binary, root: s.root, skill: '', env: s.env, openExternal: async () => {},
    modelChoice: () => seq[Math.min(i++, seq.length - 1)] ?? null,
    modelChosen: () => true
  })
  const noop = { message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }

  // ① 첫 턴은 Opus 로 시작한다 — 이 대화의 init 은 선택값이라 기본값으로 저장되지 않는다.
  await conn.run('고른 채 시작', undefined, noop)
  const first = s.turns().at(-1)!
  expect(first.model).toBe('opus')
  expect(first.resume).toBeUndefined()
  const sessionId = 'fake-session-1'

  // ② 준비는 통과한다(그때는 아직 Opus).
  await expect(conn.prepare(sessionId)).resolves.toBeUndefined()

  // ③ 그 사이 해제됐다 → 전송은 **모델 없이 나가지 않아야** 한다(기본값을 모른다).
  await expect(conn.run('해제 뒤 전송', sessionId, noop)).rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
  expect(s.turns().filter((t) => t.resume === sessionId)).toEqual([])
})

/**
 * [중요 2] 앞 대화의 선택 이력이 새 대화의 기본값 확인을 막는다.
 * 기본값 저장 조건이 \`overriddenFor === null\`("이 연결에서 모델을 보낸 적 없음")이라,
 * A 대화를 Opus 로 시작한 뒤 같은 연결로 연 B 대화는 모델 없이 열려도 init.model 을
 * 저장하지 못한다. 그러면 B 의 다음 턴은 \`modelChosen\` 때문에 영영 막힌다 —
 * "새 대화를 열면 계정 기본값을 다시 확인한다"는 복구 경로가 죽는다.
 */
test('U1b-2: 앞 대화에서 모델을 골랐어도 새 대화는 계정 기본값을 다시 확인한다', async () => {
  const s = scene({ W1_INIT_MODEL: 'claude-opus-5' })
  // 연결 하나가 A 대화와 B 대화를 함께 맡는다(폴더·회사가 같으면 연결도 하나다).
  let choice: ModelChoice | null = { model: 'opus', effort: null }
  const conn = new ClaudeConnection({
    binary: s.binary, root: s.root, skill: '', env: s.env, openExternal: async () => {},
    modelChoice: () => choice, modelChosen: () => true
  })
  const seen: string[] = []
  const events = { message: () => {}, permission: () => {}, note: () => {}, session: (id: string) => seen.push(id), skill: () => {} }

  // A 대화: 처음부터 Opus 를 골랐다 → 이 연결은 "덮어쓴 대화"를 갖게 된다.
  await conn.run('A 대화 첫 턴', undefined, events)
  expect(s.turns().at(-1)!.model).toBe('opus')
  const aSession = seen.at(-1)
  expect(aSession).toBeDefined()

  // 학생이 선택을 해제하고 새 대화를 연다 — 모델 옵션 없이 나가야 한다.
  choice = null
  await conn.run('B 대화 첫 턴', undefined, events)
  const b1 = s.turns().at(-1)!
  expect(b1.model).toBeUndefined()
  const bSession = seen.at(-1)!
  // 새 대화는 앞 대화와 다른 세션이다(같은 연결이 두 대화를 맡는다).
  expect(bSession).not.toBe(aSession)

  // B 의 init 은 계정 기본값을 알려 줬다. B 의 다음 턴은 막히지 않고 그 값을 명시해 되돌린다.
  // (지금은 A 대화 이력 때문에 저장이 안 돼 영영 막힌다.)
  await expect(conn.prepare(bSession)).resolves.toBeUndefined()
})

/**
 * [중요 3] 환경 변수로 명시한 모델의 init 을 계정 기본값으로 저장한다.
 * 설계 §1: 기본값은 "모델 옵션 없이 연 query"의 init.model 만 인정한다.
 * 핀으로 모델을 보낸 턴의 init 은 그 모델이지 계정 기본값이 아니다.
 */
test('U1b-3: 환경 변수로 보낸 모델의 초기화를 계정 기본값으로 저장하지 않는다', async () => {
  const s = scene({ W1_INIT_MODEL: 'claude-opus-5' })
  const env: NodeJS.ProcessEnv = { ...s.env, KNUAF_CLAUDE_MODEL: 'sonnet' }
  const conn = new ClaudeConnection({
    binary: s.binary, root: s.root, skill: '', env, openExternal: async () => {},
    modelChoice: () => null,
    modelChosen: () => true
  })
  let sessionId: string | undefined
  await conn.run('핀으로 첫 턴', undefined, {
    message: () => {}, permission: () => {}, note: () => {}, session: (id) => { sessionId = id }, skill: () => {}
  })
  const turn = s.turns().at(-1)!
  expect(turn.model).toBe('sonnet')
  expect(sessionId).toBeDefined()

  // 핀을 뺀다(시험이 소유한 옵션 객체). 핀의 init 이 기본값으로 저장됐다면 prepare 가 통과하고,
  // 저장되지 않았다면(옳음) 되돌릴 값을 몰라 전송 전에 막는다.
  delete env.KNUAF_CLAUDE_MODEL
  await expect(conn.prepare(sessionId!)).rejects.toThrow(CLAUDE_MODEL_COPY.unsetNeedsChoice)
})

/**
 * [중요 4] 해제한 깊이에 환경 변수 깊이가 다시 들어간다.
 * 칩에서 깊이를 "기본값"으로 되돌렸는데 `KNUAF_CLAUDE_EFFORT` 가 있으면 그 값이 전송돼,
 * 화면·저장값과 실제 요청이 갈린다. 모델이 지원하지 않는 깊이면 더 나쁘다.
 */
test('U1b-4: 깊이를 "기본값"으로 되돌리면 환경 변수 깊이를 다시 넣지 않는다', async () => {
  const s = scene({ KNUAF_CLAUDE_EFFORT: 'max' })
  const svc = s.make()
  try {
    // Sonnet 은 max 를 지원하지 않는다 — 저장 단계에서도 거절된다(기존 규칙).
    await svc.setModel(s.root, 'claude', { model: 'sonnet', effort: null })
    await svc.send(s.root, 'claude', '깊이 해제', 'b4-turn')
    expect((await idle(svc, s.root)).state).toBe('idle')
    const turn = s.turns().at(-1)!
    expect(turn.model).toBe('sonnet')
    // 화면이 "기본값"이라고 했으면 요청에도 깊이가 없어야 한다.
    expect(turn.effort).toBeUndefined()
  } finally { await svc.close() }
})

/**
 * [중요 5] 실제 보낸 값이 아니라 초기화 도중 **다시 읽은** 선택값과 비교한다.
 * · 보낸 턴(\`--model\`)과 비교 기준이 갈리면, CLI 가 다른 모델로 열어도 경고가 없다.
 * · 안 보낸 선택을 기준으로 삼으면 거짓 경고를 내고, 기본값 저장까지 건너뛴다.
 */
test('U1b-5: 초기화 대조·기본값 저장은 실제로 보낸 값으로 판단한다', async () => {
  // ⑴ 실제로 보낸 모델과 CLI 가 연 모델이 다르면 알린다(비교 기준은 보낸 값).
  // 별칭→id 대응표를 비운다 — CLI 가 요청과 다른 모델로 열었다고 답하는 상황.
  const s = scene({ W1_INIT_MODEL: 'claude-sonnet-5', W1_INIT_MODEL_BY_MODEL: '{}' })
  let reads = 0
  const conn = new ClaudeConnection({
    binary: s.binary, root: s.root, skill: '', env: s.env, openExternal: async () => {},
    // 첫 읽기 = 옵션 조립(opus 를 보낸다), 그 뒤 읽기 = 초기화 뒤 비교(지금은 null).
    modelChoice: () => { reads++; return reads === 1 ? { model: 'opus', effort: null } : null },
    modelChosen: () => true
  })
  const notes: string[] = []
  await conn.run('보낸 값과 열린 값이 다르다', undefined, {
    message: () => {}, permission: () => {}, note: (t) => notes.push(t), session: () => {}, skill: () => {}
  })
  expect(s.turns().at(-1)!.model).toBe('opus')
  expect(notes.some((n) => n.includes('opus') && n.includes('claude-sonnet-5'))).toBe(true)

  // ⑵ 모델을 보내지 않은 턴은 그 init 을 계정 기본값으로 저장한다(반대 방향).
  const s2 = scene({ W1_INIT_MODEL: 'claude-opus-5' })
  let reads2 = 0
  const conn2 = new ClaudeConnection({
    binary: s2.binary, root: s2.root, skill: '', env: s2.env, openExternal: async () => {},
    // 첫 읽기 = 옵션 조립(모델 없음). 그 뒤 선택은 opus 로 바뀌었지만 이 턴은 안 보냈다.
    modelChoice: () => { reads2++; return reads2 === 1 ? null : { model: 'opus', effort: null } },
    modelChosen: () => true
  })
  await conn2.run('모델 없이 첫 턴', undefined, {
    message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {}
  })
  const turn2 = s2.turns().at(-1)!
  expect(turn2.model).toBeUndefined()
  await expect(conn2.prepare(turn2.resume!)).resolves.toBeUndefined()
})

/**
 * [권고 1] "모델을 바꾸면 그 모델이 지원하지 않는 기존 깊이는 해제된다"를 잠근다.
 * 화면(칩)은 모델 줄을 누를 때 `effort: null` 을 보내지만, 옛 저장값(`sonnet` + `max`)이나
 * 다른 경로로 들어온 선택은 `effectiveModelChoice` 가 정규화한다. 전송까지 확인한다.
 */
test('U1b-권고1: 모델을 바꾸면 지원하지 않는 기존 깊이는 해제되어 전송에도 안 실린다', async () => {
  // ① 정규화 규칙 자체 — 옛 판이 남긴 `sonnet + max` 는 모델을 살리고 깊이만 버린다.
  const catalog = MODELS.map(toChatModelInfo).filter((m) => m !== null)
  expect(effectiveModelChoice({ model: 'sonnet', effort: 'max' }, catalog)).toEqual({ model: 'sonnet', effort: null })
  // 지원하는 깊이는 그대로 둔다(과잉 해제 금지).
  expect(effectiveModelChoice({ model: 'opus', effort: 'max' }, catalog)).toEqual({ model: 'opus', effort: 'max' })

  // ② 전송 경로 — 화면에서 Opus+max 를 고른 뒤 Sonnet 으로 바꾸면 다음 턴에 깊이가 없다.
  const s = scene()
  const svc = s.make()
  try {
    await svc.setModel(s.root, 'claude', { model: 'opus', effort: 'max' })
    await svc.send(s.root, 'claude', 'Opus 최대로', 'b6-opus')
    expect((await idle(svc, s.root)).state).toBe('idle')
    expect(s.turns().at(-1)!.effort).toBe('max')

    // 칩이 모델 줄을 누를 때 보내는 값 그대로(깊이 해제).
    await svc.setModel(s.root, 'claude', { model: 'sonnet', effort: null })
    await svc.send(s.root, 'claude', 'Sonnet 으로', 'b6-sonnet')
    expect((await idle(svc, s.root)).state).toBe('idle')
    const turn = s.turns().at(-1)!
    expect(turn.model).toBe('sonnet')
    expect(turn.effort).toBeUndefined()
  } finally { await svc.close() }
})
