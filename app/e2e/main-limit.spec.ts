// §0-5 1번 — 본대화 **확인된 한도**만 이어 하기 제안으로 이어진다(설계 §1-2·§1-3).
// 실제 AI 호출 0회: Claude 는 가짜 CLI, Codex 는 가짜 app-server, 인계 이음매는 대역이다.
//
// 지키는 것:
//  1. 판정은 **구조 신호**만 본다 — 오류 문구·`assistant.error` 는 근거가 아니다.
//  2. 신호는 **그 턴 안**의 것이어야 한다 — 앞 턴 거절이 다음 턴에 새지 않는다.
//  3. `entry` 는 **실패 당시** 실제로 보낸 회사·모델·깊이다(턴 지역 값).
//  4. 제안이 열리면 그 턴의 오류 줄 대신 제안 줄이 남는다.
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ChatService, type HandoffSeam } from '../src/main/chat/service'
import { ClaudeConnection } from '../src/main/chat/claude'
import { CodexConnection } from '../src/main/chat/codex'
import { canonical } from '../src/main/chat/jobs/isolation'
import {
  ConversationHandoff, type ConversationProposal, type HandoffSource
} from '../src/main/chat/jobs/conversation'
import type { ExecutionAccount } from '../src/main/chat/jobs/types'
import type { AgentConnection } from '../src/main/chat/contracts'
import { findExecutable, skillSource } from '../src/main/agent'
import { chatConnectionKey } from '../src/main/chat/jobs/key'
import { laneAccountProbe } from '../src/main/lanes/accounts'
import { planFromRow } from '../src/shared/lanes'
import { fakeCodexEnv } from './fixtures/fake-codex'
import type { ChatSnapshot } from '../src/shared/chat'

const appRoot = resolve(__dirname, '..')

/** 가짜 Claude CLI 가 초기화 응답으로 주는 모델 목록 — 앱 칩이 이 값을 읽는다. */
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }
]

function fakeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-main-limit-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '# fake skill\n')
  writeFileSync(join(dir, 'delegation.json'), JSON.stringify({ jobSchema: 1, laneRequestSchema: 1, contractVersion: 'role-v1' }))
  return dir
}

/** 진짜 판정이 통과할 최소 제안 — 시험은 "제안이 열렸는가"만 본다. */
function offer(source: HandoffSource): ConversationProposal {
  return {
    proposalId: `p-${source.rootConversationId}`,
    rootConversationId: source.rootConversationId,
    root: source.root,
    oldOwner: source.owner,
    newConversationId: `claude\0${source.root}`,
    entry: { company: 'claude', model: 'opus', effort: 'high', how: 'relay' },
    from: { company: source.entry.company, model: source.entry.model, effort: source.entry.effort },
    accountId: 'claude-account',
    accountFingerprint: 'f',
    bundleHash: 'h',
    bundlePath: '/private/bundle.json',
    archivePath: '/private/archive.json',
    tooLong: false,
    trimmed: false,
    state: 'open',
    shownAt: '2026-11-10T00:00:00.000Z'
  }
}

/**
 * 가짜 Claude CLI 셔뱅. `extra` 의 `W1_*` 로 이 실행의 턴 동작을 정한다.
 * `W1_QUERY_LOG` 에는 실제 CLI 처럼 띄운 인자·앱이 보낸 요청·받은 답이 모두 남는다.
 */
function claudeRig(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kd-main-limit-claude-'))
  const log = join(dir, 'query.jsonl')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  const env = { ...process.env, W1_QUERY_LOG: log, W1_MODELS: JSON.stringify(MODELS), ...extra }
  return { dir, log, binary, env }
}

type AccountSeam = (
  company: 'claude' | 'codex',
  options?: { fresh?: boolean; once?: { epoch: number } }
) => Promise<ExecutionAccount | null>

/** 한 폴더·한 서비스 — 본대화 연결만 시험이 고른다(인계는 대역). */
function fixture(options: {
  main: (root: string, skill: string) => AgentConnection
  handoff?: boolean
  jobAccount?: AccountSeam
}) {
  const base = canonical(mkdtempSync(join(tmpdir(), 'kd-main-limit-')))
  const root = join(base, 'thesis')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'kd-main-limit-ud-'))
  const skill = fakeSkill()
  /** 서비스가 이음매에 넘긴 실패 당시 사실 — 제안이 **무엇으로** 판정됐는지 본다. */
  const sources: HandoffSource[] = []
  /** 계정 이음매가 실제로 몇 번·어떤 조건으로 불렸는가 — 상한 시험이 이 값을 센다. */
  const reads: { company: 'claude' | 'codex'; options?: { fresh?: boolean; once?: { epoch: number } } }[] = []
  const main = options.main(root, skill)
  const svc = new ChatService({
    skillSource: () => skill, userData, emit: () => {}, openExternal: async () => {},
    connectionFactory: () => main,
    jobConnectionFactory: () => { throw new Error('담당은 이 시험에서 쓰지 않는다') },
    jobAccount: async (company, readOptions) => {
      reads.push({ company, options: readOptions })
      return options.jobAccount ? options.jobAccount(company, readOptions) : null
    },
    jobShellSandboxAvailable: true,
    invalidateHandoff: () => {},
    handoff: options.handoff === false ? undefined : {
      visible: () => sources.filter(s => s.reason === 'limit').map(offer),
      propose: async (source: HandoffSource) => { sources.push(source); return offer(source) },
      continue: async () => null,
      later: () => true,
      archives: () => [],
      archive: () => null,
      invalidateRoot: () => {}
    }
  })
  return { svc, root, skill, sources, reads }
}

async function settled(svc: ChatService, root: string, provider: 'claude' | 'codex'): Promise<ChatSnapshot> {
  await expect.poll(() => svc.snapshot(root, provider).state, { timeout: 30_000 }).not.toBe('running')
  return svc.snapshot(root, provider)
}

// ── Claude 4줄 ────────────────────────────────────────────────────────────────

test('main-limit: 고정 문구 일반 오류는 제안 0', async () => {
  // 연결 실패 — 거절 사건이 없다. 앱은 예전 고정 문구를 그대로 보여 주고 제안을 열지 않는다.
  const rig = claudeRig({ W1_QUERY_ERROR: 'network' })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  const snap = await settled(f.svc, f.root, 'claude')
  expect(snap.state).toBe('error')
  expect(snap.error).toBe('Claude 작업이 완료되지 않았어요. 연결·사용 한도와 마지막 대화를 확인해 주세요.')
  expect(f.sources).toHaveLength(0)
})

test("main-limit: 원문 '한도 아님' 부정문도 0", async () => {
  // 부정문이 든 오류 원문 — 정규식이었다면 "한도" 부분 문자열로 오판한다.
  const rig = claudeRig({ W1_QUERY_ERROR: 'network', W1_QUERY_ERROR_TEXT: '한도 문제는 아니며 연결 실패' })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  const snap = await settled(f.svc, f.root, 'claude')
  expect(snap.state).toBe('error')
  expect(f.sources).toHaveLength(0)
})

test('main-limit: assistant rate_limit만으로는 0', async () => {
  // `assistant.error:'rate_limit'` 만 있고 거절 사건은 없다 — §1-2 는 이 경우를 한도로 안 본다.
  const rig = claudeRig({ W1_QUERY_ERROR: 'rate_limit' })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  const snap = await settled(f.svc, f.root, 'claude')
  expect(snap.state).toBe('error')
  expect(f.sources).toHaveLength(0)
})

test('main-limit: 거절 사건 뒤 결과 없이 예외도 1', async () => {
  // `crash` — 사건은 보내고 결과 줄 없이 프로세스가 죽는다. 결과 줄 유무는 근거가 아니다.
  const rig = claudeRig({ W1_QUERY_ERROR: 'crash', W1_QUERY_ERROR_TEXT: 'crash', W1_RATE_LIMIT: '1' })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  await settled(f.svc, f.root, 'claude')
  expect(f.sources).toHaveLength(1)
  expect(f.sources[0].reason).toBe('limit')
  expect(f.sources[0].entry).toEqual({ company: 'claude', model: 'claude-opus-5', effort: null, how: 'main' })
})

test('main-limit: 앞 턴 거절이 다음 턴에 안 샘', async () => {
  const turnSeq = join(mkdtempSync(join(tmpdir(), 'kd-main-limit-seq-')), 'turn')
  // 턴1: 거절 사건 + 실패. 턴2: 사건은 없고 실패만 — 한도가 아니다.
  const rig = claudeRig({
    W1_TURN_SEQ: turnSeq, W1_QUERY_FAIL_TURNS: '1,2', W1_RATE_LIMIT_TURNS: '1', W1_QUERY_ERROR: 'network'
  })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '첫 질문', 'req-1')
  await settled(f.svc, f.root, 'claude')
  expect(f.sources).toHaveLength(1)
  // 이어 하기를 [나중에]로 접고 다음 턴을 보낸다 — 제안이 열린 채면 두 번째 판정을 볼 수 없다.
  await f.svc.send(f.root, 'claude', '두 번째 질문', 'req-2')
  await settled(f.svc, f.root, 'claude')
  // 턴2 는 사건이 없으므로 제안이 늘지 않는다. (지역 변수가 아니면 여기서 2가 된다.)
  expect(f.sources).toHaveLength(1)
})

test('main-limit: Codex 코드만', async () => {
  // 세 코드를 한 시험에서 본다 — `usageLimitExceeded` 만 한도다(§1-2, p1X 11-11).
  for (const [failure, expected] of [['usage-limit', 1], ['rate-code', 0], ['unauthorized', 0]] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'kd-main-limit-codex-'))
    const env = fakeCodexEnv(dir, { FAKE_CODEX_TURN_FAILURE: failure })
    const f = fixture({
      // 가짜 서버는 `skills/list` 로 **작업 폴더 안** 설치 사본을 보고한다 — 스킬 폴더가
      // 밖에 있으면 앱이 "스킬을 찾지 못했어요" 로 턴을 시작하지 못하고 판정 자체가 안 돈다.
      main: root => {
        const skill = join(root, '.agents', 'skills', 'knuaf-dev')
        mkdirSync(skill, { recursive: true })
        writeFileSync(join(skill, 'SKILL.md'), '# test skill\n')
        return new CodexConnection({
          binary: findExecutable('codex', env)!, root, skill, env, openExternal: async () => {}
        })
      }
    })
    await f.svc.send(f.root, 'codex', '질문', 'req-1')
    await settled(f.svc, f.root, 'codex')
    expect({ failure, sources: f.sources.length }).toEqual({ failure, sources: expected })
    if (expected === 1) {
      // 실패 당시 보낸 값 — 이 턴의 `turn/start` 에 실린 model·effort 다.
      expect(f.sources[0].entry.company).toBe('codex')
      expect(f.sources[0].entry.how).toBe('main')
    }
  }
})

test('main-limit: 실패 당시 공급자', async () => {
  // 실패를 릴리스 파일로 붙잡는다 — 곧바로 실패하면 턴 중간에 칩을 바꿀 틈이 없어
  // "보낸 값"과 "지금 칩"이 늘 같아지고, 시험이 아무것도 구분하지 못한다.
  const release = join(mkdtempSync(join(tmpdir(), 'kd-main-limit-release-')), 'release')
  // 1턴만: 거절 사건 + 실패. 사건이 있어야 '확인된 한도'로 제안이 열린다.
  const rig = claudeRig({
    W1_QUERY_ERROR: 'network', W1_QUERY_RELEASE: release, W1_QUERY_FAIL_TURNS: '1', W1_RATE_LIMIT_TURNS: '1'
  })
  const turnSeq = join(rig.dir, 'turn')
  const withSeq = { ...rig.env, W1_TURN_SEQ: turnSeq }
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: withSeq, openExternal: async () => {}
    })
  })
  const sending = f.svc.send(f.root, 'claude', '질문', 'req-1')
  // 앱이 이 턴의 계획(sentModel·effort)을 이미 정하고 CLI 에 보낸 뒤에 칩을 바꾼다.
  await expect.poll(() => readFileSync(rig.log, 'utf8').includes('"type":"user"'), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => f.svc.snapshot(f.root, 'claude').state, { timeout: 10_000 }).toBe('running')
  f.svc.setModel(f.root, 'claude', { model: 'opus', effort: 'high' })
  await sending
  writeFileSync(release, 'release the failure')
  await settled(f.svc, f.root, 'claude')
  expect(f.sources).toHaveLength(1)
  // 보낸 값은 턴 계획(sentModel)이다 — 모델을 고르지 않았으므로 계정 기본값(`claude-opus-5`), 깊이 없음.
  expect(f.sources[0].entry).toEqual({ company: 'claude', model: 'claude-opus-5', effort: null, how: 'main' })
  expect(f.sources[0].rootConversationId).toBe(`claude\0${canonical(f.root)}`)
})

test('main-limit: 제안이 열리면 오류 줄 대신', async () => {
  const rig = claudeRig({ W1_QUERY_ERROR: 'network', W1_RATE_LIMIT: '1' })
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  const snap = await settled(f.svc, f.root, 'claude')
  // 제안이 오류 줄 자리를 대신한다 — 실패 문구가 아니라 단추가 남는다.
  expect(snap.error).toBeUndefined()
  expect(snap.state).toBe('idle')
  expect(f.svc.handoffLines(canonical(f.root)).map(line => line.kind)).toEqual(['main-limit-offer'])
  expect(basename(f.sources[0].root)).toBe('thesis')
})

// ── §0-5 4번 — 누르기 전 계정 읽기 상한(설계 §5) ────────────────────────────────
//
// 상한: 앱 실행당 회사당 1회 + 그 회사 로그인 상태가 바뀐 뒤 1회. 진행 중 읽기는 하나로 접고
// (single-flight), 실패는 메모에 남기지 않는다. 읽기는 모델 턴도 사용량 조회도 아니다.

/** 가짜 CLI 초기화 응답에 `sonnet` 을 더한다 — `claude-low` 판의 design 칸이 이 이름이다. */
const SONNET = {
  value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max']
}

/** 가짜 CLI 가 프로세스를 띄운 횟수 — 턴·초기화 왕복 모두 `cwd` 를 남긴다. */
function spawns(rig: { log: string }): number {
  const raw = readFileSync(rig.log, 'utf8').trim()
  if (!raw) return 0
  return raw.split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(record => 'cwd' in record).length
}

/**
 * `propose()` 는 **반대 회사**를 읽는다 — 넘기는 쪽을 codex 로 둬야 Claude 를 읽는다.
 * 묶음은 학생 글 1건 + 파일 변화 1건이면 충분하다(이 시험은 판정만 본다).
 */
function probeSource(rootConversationId: string, root: string, model = 'gpt-6.1-sol'): HandoffSource {
  return {
    rootConversationId, owner: { id: 'old', sessionId: 'old-session', company: 'codex' }, root,
    entry: { company: 'codex', model, effort: 'high', how: 'main' }, reason: 'limit',
    students: [{ text: '학생 글', attachments: [] }], lastAssistant: null,
    beforeHashes: { 'project.json': 'before' }, afterHashes: { 'project.json': 'after' },
    approvedPlan: planFromRow('both-high'), jobs: [], skillVersion: 'skill-v1',
    sourceLocation: '/private/chat.json'
  }
}

/** 제안만 여는 최소 이음매 — 열기·닫기는 이 시험의 관심 밖이다(대역). */
function probeHandoff(account: (company: 'claude' | 'codex') => Promise<ExecutionAccount | null>): ConversationHandoff {
  return new ConversationHandoff({
    stateDir: mkdtempSync(join(tmpdir(), 'kd-handoff-once-')), maxBytes: 10_000, account,
    gateInTurn: company => company === 'claude',
    open: async request => ({ id: request.id, sessionId: 'new-session', company: 'claude', firstTurn: 'ok' }),
    close: async () => {},
    prepareActivation: async () => () => {},
    beginTransition: () => ({
      ready: async () => {},
      commit: (_owner: unknown, activate: () => void) => { activate(); return true },
      cancel: () => {}, flush: async () => {}
    }),
    audit: () => {}
  })
}

test('handoff: 누르기 전 숨은 모델·사용량 호출 0', async () => {
  // 본대화 한도 한 턴. 이 턴은 **본대화 모델 프로세스 1개**만 띄운다 — 제안을 그리기 전에 대상
  // 회사 모델 턴을 열거나 사용량을 따로 묻는 코드가 있으면 이 수가 늘어난다.
  const rig = claudeRig({ W1_QUERY_ERROR: 'network', W1_QUERY_FAIL_TURNS: '1', W1_RATE_LIMIT_TURNS: '1' })
  // 턴 번호는 카운터 **파일**로 센다(`W1_TURN_SEQ` 없이는 `_TURNS` 집합이 늘 빈 집합이다).
  rig.env.W1_TURN_SEQ = join(rig.dir, 'turn')
  const f = fixture({
    main: () => new ClaudeConnection({
      binary: rig.binary, root: '', skill: '', env: rig.env, openExternal: async () => {}
    })
  })
  await f.svc.send(f.root, 'claude', '질문', 'req-1')
  await settled(f.svc, f.root, 'claude')
  expect(f.sources).toHaveLength(1)
  expect(f.svc.handoffLines(canonical(f.root)).map(line => line.kind)).toEqual(['main-limit-offer'])
  // 계정도 읽지 않았다 — 누르기 전 판정은 단추 조건뿐이고, 이 시험의 인계는 대역이다.
  // 상한 경로 자체는 아래 두 시험이 잰다.
  expect(f.reads).toEqual([])
  const raw = readFileSync(rig.log, 'utf8')
  // 사용량 조회(`get_usage`)는 앱 어디에도 없다(§5 ㉠) — 호출 흔적이 남으면 여기서 걸린다.
  expect(raw.includes('get_usage')).toBe(false)
  // 엔진 프로세스를 띄운 기록은 그 본대화 턴 하나뿐이다.
  expect(spawns(rig)).toBe(1)
})

test('handoff: 동시 두 제안의 첫 계정 조회는 1회', async () => {
  // 동시에 두 제안이 열려도 실제 읽기는 하나이고, 두 제안은 **같은 값**으로 판정된다.
  // 실패는 저장하지 않는다 — 기다리던 모두에게 같은 실패가 가고 다음 제안이 다시 1회 읽는다.
  const rig = claudeRig({ W1_MODELS: JSON.stringify([...MODELS, SONNET]) })
  const probe = laneAccountProbe({
    appDir: rig.dir, env: () => rig.env, openExternal: async () => {}, binary: () => rig.binary
  })
  const handoff = probeHandoff(company => probe.once(company, 0))
  // 서로 다른 대화(폴더)에서 같은 순간에 한도가 났다 — 시도 기록도 대화별이다.
  const [first, second] = await Promise.all([
    handoff.propose(probeSource('root-a', '/thesis-a')),
    handoff.propose(probeSource('root-b', '/thesis-b'))
  ])
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  // `claude-low` 판의 design 칸 = `claude/sonnet/main` — 실제 읽은 계정의 요금제로 정해진다.
  expect(first!.entry).toMatchObject({ company: 'claude', model: 'sonnet', effort: 'high' })
  expect(first!.accountId).toBe(second!.accountId)
  // 계정 식별자는 계정 자체의 해시다 — 두 제안이 같은 계정을 봤다는 증거.
  expect(first!.accountId).toMatch(/^[0-9a-f]{64}$/)
  expect(spawns(rig)).toBe(1)

  // ── 실패는 저장하지 않는다 ────────────────────────────────────────────────
  // `deps.env()` 는 옵션 조립 단계에서 불린다 — 던지면 `probe()` 자체가 거절한다.
  // **같은** 상한 인스턴스로 실패 → 성공을 겪어야 "실패를 굳히지 않는다"가 증명된다.
  let broken = true
  const flaky = laneAccountProbe({
    appDir: rig.dir, openExternal: async () => {}, binary: () => rig.binary,
    env: () => { if (broken) throw new Error('계정 읽기 실패'); return rig.env }
  })
  const after = probeHandoff(company => flaky.once(company, 0))
  // 두 제안 모두 거절 — 서비스는 이 거절을 `null` 로 접는다(여기서는 거절 자체를 본다).
  const failed = await Promise.allSettled([
    after.propose(probeSource('root-c', '/thesis-c')),
    after.propose(probeSource('root-d', '/thesis-d'))
  ])
  expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(after.proposals()).toEqual([])
  expect(spawns(rig)).toBe(1)
  // 방해가 걷히면 **다시** 1회 읽는다 — 실패를 굳혔다면 옛 거절이 되살아 단추가 영영 없다.
  broken = false
  expect(await after.propose(probeSource('root-c', '/thesis-c'))).not.toBeNull()
  expect(spawns(rig)).toBe(2)
})

test('handoff: 계정 읽기는 실행당 1 + 로그인 변경 뒤 1', async () => {
  const rig = claudeRig({ W1_MODELS: JSON.stringify([...MODELS, SONNET]) })
  const probe = laneAccountProbe({
    appDir: rig.dir, env: () => rig.env, openExternal: async () => {}, binary: () => rig.binary
  })
  // 세 번 물어도 한 번 읽는다 — 진행 중 약속을 함께 기다린다.
  const [a, b, c] = await Promise.all([
    probe.once('claude', 0), probe.once('claude', 0), probe.once('claude', 0)
  ])
  expect(a!.accountId).toBe(b!.accountId)
  expect(b!.accountId).toBe(c!.accountId)
  expect(spawns(rig)).toBe(1)
  // 세대가 바뀌면(성공한 로그인 확인) 옛 값을 버리고 정확히 한 번 더 읽는다.
  await probe.once('claude', 1)
  expect(spawns(rig)).toBe(2)
  // 새 세대 안에서는 다시 1회다.
  await probe.once('claude', 1)
  expect(spawns(rig)).toBe(2)

  // ── 서비스가 넘기는 세대 값 ────────────────────────────────────────────────
  // `laneAccount(once)` 는 **읽는 순간의** 세대를 넘긴다 — 로그인 확인이 세대를 올린 뒤 1 이다.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kd-auth-epoch-')))
  const loginRig = claudeRig({
    W1_MODELS: JSON.stringify([...MODELS, SONNET]),
    W1_AUTH_STATE: join(root, 'authenticated'),
    W1_LOGIN_COMPLETE: join(root, 'complete-login')
  })
  const reads: { company: 'claude' | 'codex'; options?: { fresh?: boolean; once?: { epoch: number } } }[] = []
  const svc = new ChatService({
    skillSource: () => skillSource(appRoot, false, ''),
    userData: join(root, 'userdata'),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: (_provider, options) =>
      new ClaudeConnection({ ...options, binary: loginRig.binary, env: loginRig.env }),
    // 상한 시험은 세대 **값**만 본다 — 실제 읽기는 위에서 이미 쟀다.
    jobAccount: async (company, options) => { reads.push({ company, options }); return null }
  })
  try {
    expect(svc.authEpoch('claude')).toBe(0)
    await svc.login(root, 'claude')
    // 로그인 프로세스가 끝나야 CLI 가 자기 자격을 확정한다(성공 종료 = `loginConfirmed`).
    writeFileSync(loginRig.env.W1_LOGIN_COMPLETE!, 'successful retry')
    await expect.poll(() => {
      const connections: unknown = Reflect.get(svc, 'connections')
      if (!(connections instanceof Map)) throw new Error('연결 지도가 없어요')
      const connection: unknown = connections.get(chatConnectionKey(root, 'claude'))
      if (!(connection instanceof ClaudeConnection)) throw new Error('폴더 Claude 연결이 없어요')
      return Reflect.get(connection, 'loginProcess')
    }).toBeUndefined()
    expect((await svc.status(root, 'claude')).connected).toBe(true)
    expect(svc.authEpoch('claude')).toBe(1)
    reads.length = 0
    await svc.laneAccount('claude', { once: true })
    expect(reads).toEqual([{ company: 'claude', options: { once: { epoch: 1 } } }])
  } finally { await svc.close() }
})
