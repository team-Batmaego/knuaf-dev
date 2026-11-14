// 그림 통로의 앱 쪽 고리 — Node 단위 시험(Electron 없이, 가짜 연결).
//
// 잠그는 것(발주 W-APP-WIRE-A):
// ① 그림 자리는 **메인 턴 엔진의 환경에만** 얹힌다 — 고리가 없으면 env 는 넘긴 객체 그대로이고,
//    전역 연결(상태 확인·로그인, 턴 없음)에는 새지 않는다.
// ② send 한 번의 순서: recordStudentMessage → beginTurn(같은 requestId) → run → endTurn.
// ⑤ 턴이 끝나면 폴더 잠금은 **즉시** 풀리고(`release`), `endTurn()` 약속은 잡아 둔다 — 그래야 다음
//    전송이 "작업 중"으로 거절되지 않으면서도, 새 `beginTurn` 은 옛 `endTurn` 이 끝난 뒤에 온다.
// ③ 가짜 연결의 run 이 던져도 endTurn 은 불린다(턴이 실패·중단으로 끝나도 통로를 닫는다).
// ④ 그림 고리가 전부 던져도 send 는 성공하고 스냅샷에 오류·시스템 메시지가 생기지 않는다 —
//    규칙집에 그림 명령이 없는 판에서는 고리가 불려도 조용해야 한다.
import { expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import type { AgentConnection, AgentOptions } from '../src/main/chat/contracts'

const FIGURE_ENV = { KNUAF_FIGURE_HOME: '/tmp/figures-home' }

function scratch(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `kd-figwire-${tag}-`))
  const root = join(dir, 'paper')
  mkdirSync(root)
  // 동봉본과 설치 대상은 **다른** 자리여야 한다(같으면 설치는 자기 자신을 복사한다).
  const bundle = join(dir, 'bundle')
  mkdirSync(bundle)
  writeFileSync(join(bundle, 'SKILL.md'), '# test skill\n')
  return { root, bundle }
}

function fake(over: Partial<AgentConnection> = {}): AgentConnection {
  return {
    status: async () => ({ installed: true, connected: true, version: '0.0.0-test', detail: 'fake' }),
    login: async () => {},
    run: async () => {},
    respond: () => {},
    stop: async () => {},
    ...over
  }
}

/**
 * 턴 하나가 **완전히** 끝나기를 기다린다: 스냅샷이 실행 중을 벗어나고, 폴더 잠금이 풀리고,
 * 그림 쪽 마지막 고리(`endTurn`)까지 불린 뒤. 잠금을 같이 보는 이유는 잠금 해제가 `endTurn` 과
 * 무관하게 **즉시** 일어난다는 계약(⑤)을 이 시험들이 실제로 밟기 위해서다.
 */
async function untilTurnDone(svc: ChatService, root: string, log: string[]) {
  for (let i = 0; i < 400; i++) {
    const s = svc.snapshot(root, 'codex')
    if (log.at(-1) === 'end' && !svc.busy(root) && s.state !== 'running' && s.state !== 'permission') return s
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 10)
    await tick.promise
  }
  return svc.snapshot(root, 'codex')
}

test('① 그림 env 는 메인 엔진에만 얹힌다', async () => {
  const { root, bundle } = scratch('env')
  const seen: { root: string; env: NodeJS.ProcessEnv }[] = []
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, KNUAF_TEST_BASE: '1' }
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    env: baseEnv, emit: () => {}, openExternal: async () => {},
    connectionFactory: (_provider, options) => { seen.push({ root: options.root, env: options.env }); return fake() },
    figures: { env: FIGURE_ENV, beginTurn: async () => {}, endTurn: async () => {}, recordStudentMessage: async () => 0 }
  })
  try {
    await svc.send(root, 'codex', '그림이 필요해요', 'r-env')
    await svc.globalStatus('codex')
  } finally { await svc.close() }
  const main = seen.filter((s) => !s.root.includes('connect-probe'))
  const global = seen.filter((s) => s.root.includes('connect-probe'))
  expect(main, '메인 연결은 하나').toHaveLength(1)
  expect(main[0].env.KNUAF_FIGURE_HOME, '메인 엔진이 그림 저장소를 본다').toBe(FIGURE_ENV.KNUAF_FIGURE_HOME)
  expect(main[0].env.KNUAF_TEST_BASE, '넘긴 env 나머지는 그대로 남는다').toBe('1')
  expect(global, '전역 연결도 확인했다').toHaveLength(1)
  expect(global[0].env.KNUAF_FIGURE_HOME, '로그인·상태 확인에는 그림 자리가 없다').toBeUndefined()
})

test('① 고리가 없으면 env 는 넘긴 객체 그대로다', async () => {
  const { root, bundle } = scratch('noenv')
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, KNUAF_TEST_BASE: '1' }
  let captured: AgentOptions | undefined
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    env: baseEnv, emit: () => {}, openExternal: async () => {},
    connectionFactory: (_provider, options) => { captured = options; return fake() }
  })
  try { await svc.send(root, 'codex', '안녕하세요', 'r-plain') } finally { await svc.close() }
  expect(captured?.env, '고리가 없으면 같은 객체').toBe(baseEnv)
  expect(Object.keys(captured!.env).some((k) => k.startsWith('KNUAF_FIGURE'))).toBe(false)
})

test('② 두 턴의 순서: 후보표 → beginTurn(turnId=requestId) → run → endTurn, 그리고 잠금 해제', async () => {
  const { root, bundle } = scratch('order')
  const log: string[] = []
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => fake({ run: async () => { log.push('run') } }),
    figures: {
      env: FIGURE_ENV,
      recordStudentMessage: async (_root, text) => { log.push(`record:${text}`); return 1 },
      beginTurn: async (_root, turnId) => { log.push(`begin:${turnId}`) },
      endTurn: async () => { log.push('end') }
    }
  })
  try {
    await svc.send(root, 'codex', '그림을 넣어 주세요', 'req-1')
    expect((await untilTurnDone(svc, root, log)).state).toBe('idle')
    // 잠금이 풀렸으니 다음 턴이 돈다 — 안 풀렸으면 send 가 "작업이 끝난 뒤" 오류로 던진다.
    await svc.send(root, 'codex', '이번엔 다른 그림', 'req-2')
    expect((await untilTurnDone(svc, root, log)).state).toBe('idle')
  } finally { await svc.close() }
  expect(log).toEqual([
    'record:그림을 넣어 주세요', 'begin:req-1', 'run', 'end',
    'record:이번엔 다른 그림', 'begin:req-2', 'run', 'end'
  ])
})

test('③ run 이 던져도 endTurn 은 불린다', async () => {
  const { root, bundle } = scratch('throw')
  const log: string[] = []
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => fake({ run: async () => { throw new Error('연결 종료') } }),
    figures: {
      env: FIGURE_ENV,
      recordStudentMessage: async () => 0,
      beginTurn: async () => {},
      endTurn: async () => { log.push('end') }
    }
  })
  try {
    await svc.send(root, 'codex', '질문', 'req-throw')
    const s = await untilTurnDone(svc, root, log)
    // 대화 자체는 지금까지처럼 실패로 남는다 — 그림 고리가 실패 경로를 바꾸지 않는다.
    expect(s.state).toBe('error')
    expect(s.error).toContain('연결 종료')
  } finally { await svc.close() }
  expect(log, '실패한 턴도 통로를 닫는다').toEqual(['end'])
})

test('④ 그림 고리가 전부 던져도 대화는 그대로 간다', async () => {
  const { root, bundle } = scratch('swallow')
  const called: string[] = []
  const boom = (name: string) => async () => { called.push(name); throw new Error(`figure ${name} 실패`) }
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => fake({ run: async (_t, _sid, events) => { events.message('m1', '네, 넣어 드릴게요') } }),
    figures: {
      env: FIGURE_ENV,
      recordStudentMessage: boom('record'),
      beginTurn: boom('begin'),
      endTurn: async () => { called.push('end'); throw new Error('figure end 실패') }
    }
  })
  try {
    const sent = await svc.send(root, 'codex', '그림 넣어 주세요', 'req-swallow')
    expect(sent.messages.some((m) => m.id === 'req-swallow'), '보낸 말은 대화에 남는다').toBe(true)
    const s = await untilTurnDone(svc, root, called)
    expect(called, '고리는 전부 불렸다').toEqual(['record', 'begin', 'end'])
    expect(s.state).toBe('idle')
    expect(s.error, '그림 실패는 학생에게 오류로 보이지 않는다').toBeUndefined()
    expect(s.messages.filter((m) => m.role === 'system'), '그림 실패로 시스템 줄을 만들지 않는다').toHaveLength(0)
    expect(s.messages.map((m) => m.id)).toEqual(['req-swallow', 'm1'])
  } finally { await svc.close() }
})

test('⑤ 턴이 끝난 직후의 다음 전송은 거절되지 않고, 새 턴은 옛 endTurn 뒤에 열린다', async () => {
  const { root, bundle } = scratch('chain')
  const log: string[] = []
  const closing = Promise.withResolvers<void>()
  let ends = 0
  const svc = new ChatService({
    skillSource: () => bundle, userData: mkdtempSync(join(tmpdir(), 'kd-figwire-ud-')),
    emit: () => {}, openExternal: async () => {},
    connectionFactory: () => fake({ run: async () => { log.push('run') } }),
    figures: {
      env: FIGURE_ENV,
      recordStudentMessage: async () => 0,
      beginTurn: async (_root, turnId) => { log.push(`begin:${turnId}`) },
      endTurn: async () => {
        ends += 1
        log.push('end:start')
        // 첫 턴의 endTurn 만 붙잡아 둔다 — 잠금과 분리됐다는 것을 보려면 그 사이에 전송해야 한다.
        if (ends === 1) await closing.promise
        log.push('end:done')
      }
    }
  })
  try {
    await svc.send(root, 'codex', '첫 그림', 'req-a')
    for (let i = 0; i < 400 && !log.includes('end:start'); i++) await new Promise((r) => setTimeout(r, 5))
    expect(log, '첫 턴의 endTurn 이 돌고 있다').toContain('end:start')
    expect(svc.busy(root), '잠금은 endTurn 을 기다리지 않는다').toBe(false)
    const second = svc.send(root, 'codex', '두 번째', 'req-b')
    // 붙잡힌 endTurn 이 풀리기 전에는 새 턴을 열지 않는다(옛 endTurn 이 새 turn.json 을 지우면 안 된다).
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    expect(log, '옛 endTurn 이 끝나기 전에는 새 턴을 열지 않는다').not.toContain('begin:req-b')
    closing.resolve()
    // 거절되지 않고 끝까지 간다 — 예전 모양(async finally)에서는 여기서 "작업 중"으로 던졌다.
    await second
    for (let i = 0; i < 400 && !(log.at(-1) === 'end:done' && svc.snapshot(root, 'codex').state === 'idle'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(svc.snapshot(root, 'codex').state).toBe('idle')
  } finally { await svc.close() }
  expect(log).toEqual([
    'begin:req-a', 'run', 'end:start',
    'end:done', 'begin:req-b', 'run', 'end:start', 'end:done'
  ])
})
