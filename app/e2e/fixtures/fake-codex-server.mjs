#!/usr/bin/env node
/**
 * 가짜 `codex app-server` — 시험용. `codex.ts`가 실제로 읽는 것만 맞춘다(검토 IMPL-R1-05).
 *
 * PATH 앞자리에 `codex` 이름으로 두고 쓴다. 실제 codex 가 깔린 기계와 CI 가 같은
 * 장면을 보게 하려는 것이지 새 시험 체계가 아니다. stdio 로 줄 단위 JSON-RPC 다.
 *
 * 환경변수
 *   FAKE_CODEX_MODE   logged-in(기본) | logged-out | dead(시작하자마자 끝난다)
 *   FAKE_CODEX_STATE  로그인 시작을 기억할 파일 하나 — 있으면 account/read 가 chatgpt
 *   FAKE_CODEX_REPLY  turn/start 뒤에 보낼 도우미 글의 **파일 경로**(예: 질문 원문)
 *   FAKE_CODEX_ASK    1이면 turn/start 뒤에 권한 요청을 보내고 턴을 끝내지 않는다
 *   FAKE_CODEX_ASK_COMMAND  권한 요청의 command (기본 `cat /etc/hosts`, 빈 값이면 필드 생략)
 *   FAKE_CODEX_ASK_REASON   권한 요청의 reason (기본 쉬운 이유 한 줄, 빈 값이면 필드 생략)
 *   FAKE_CODEX_FILE_EVENTS  JSON 알림 배열 뒤 파일 변경 승인을 요청한다(스키마 기반 시험)
 *   FAKE_CODEX_FILE_AFTER   승인 요청 뒤 보낼 JSON 알림 배열
 *   FAKE_CODEX_COMMAND_EVENTS  턴을 끝내기 전에 보낼 JSON 알림 배열 — `commandExecution` 결과 시험용
 *   FAKE_CODEX_DELAY_MS     모든 요청 응답을 이만큼 늦춘다(기본 0) — 느린 기계 조건 재현용
 *   FAKE_CODEX_MODELS       `model/list` 가 돌려줄 모델 배열(JSON). 없으면 Sol·Terra·Astra·Luna 기본값
 *   FAKE_CODEX_TURN_LOG     `turn/start` 로 온 model·effort 를 한 줄씩 덧붙일 파일 — 시험이 읽는다
 *   FAKE_CODEX_APPLIED_LOG  `turn/start` 뒤 그 대화에 **실제로 적용된** model·effort — 생략이
 *                           이전 값을 유지하는 계약(턴 덮어쓰기)을 흉내 내는 상태 기록
 *   FAKE_CODEX_TURN_INPUT_LOG  submitted turn text and thread id, one JSON record per turn
 *   FAKE_CODEX_DEFAULT_MODEL / FAKE_CODEX_DEFAULT_EFFORT
 *                           새 대화(과 `ephemeral` 대화)의 서버 기본값. 기본 `gpt-default` / `medium`
 *   FAKE_CODEX_INIT_DELAY_MS
 *                           initialize 응답을 늦추고, 그 전에 온 요청을 `Not initialized` 로 거절한다
 *   FAKE_CODEX_EPHEMERAL_FAIL_TIMES
 *                           기본값 조회용 `thread/start(ephemeral:true)` 를 그 횟수만큼 오류로 거절한다
 *   FAKE_CODEX_MODELS_FAIL_TIMES  모델 목록 조회를 처음 N회 오류로 거절한다(복구 UI 시험).
 *
 * 1층 잠금(§4.1-C)·턴 원장(⑨) 시험용 노브 — **설정하지 않으면 기존 동작 그대로**다.
 *   FAKE_CODEX_CONFIG_READ          `config/read` 응답(JSON). `{config, layers}` 또는 `{fail}`/`{malformed}`
 *   FAKE_CODEX_CONFIG_READ_FAIL_TIMES  `config/read` 를 처음 N회 오류로 거절
 *   FAKE_CODEX_PLUGIN_INSTALLED     `plugin/installed` 목록(JSON 배열 또는 `{pages:[…]}`/`{endless}`/`{malformed}`)
 *   FAKE_CODEX_APP_LIST             `app/list` 목록(같은 모양)
 *   FAKE_CODEX_MCP_STATUS           `mcpServerStatus/list` 목록(같은 모양) — 장 넘김 시험용
 *   FAKE_CODEX_THREAD_LIST          `thread/list` 목록(같은 모양)
 *   FAKE_CODEX_THREAD_TURNS_LIST    `thread/turns/list` 목록(같은 모양)
 *   FAKE_CODEX_THREAD_TURNS         `{threadId: [turn, …]}` — `thread/start`·`resume` 응답의 `thread.turns`
 *   FAKE_CODEX_INSTRUCTION_SOURCES  `instructionSources` 원값(JSON) — 배열·`null`·비배열 재현
 *   FAKE_CODEX_INSTRUCTION_SOURCES_MODE  `missing` 이면 `instructionSources` 칸 자체를 뺀다
 *   FAKE_CODEX_THREAD_ID_MODE       `echo`(기본) | `mismatch` | `missing` | `nonstring` | `none`(응답 없음)
 *   FAKE_CODEX_START_TIMEOUT        `1` 이면 `thread/start` 에 응답하지 않는다(미결 재현)
 *   FAKE_CODEX_RESUME_ERROR         `active-writer` | `no-rollout` | `error` | `timeout`
 *   FAKE_CODEX_RESUME_FAIL_TIMES    위 오류를 처음 N회만(기본 무한)
 *   FAKE_CODEX_TURN_ID_MODE         `fixed`(기본 `u-fake`) | `unique`(턴마다 새 id) | `shared`(겹친 시작이 같은 id)
 *   FAKE_CODEX_TURN_SEQ_FILE        `unique` 의 셈을 파일에 남겨 프로세스가 갈려도 id 가 겹치지 않게 한다
 *   FAKE_CODEX_TURN_NOTIFY_DELAY_MS 응답과 첫 알림 사이 지연 — 원장 기록이 먼저인지 시험이 본다
 *   FAKE_CODEX_TURN_CRASH           `before-reply` 면 턴을 남기고 응답 전에 죽는다(㉱)
 *   FAKE_CODEX_SKILLS_LIST / FAKE_CODEX_HOOKS_LIST / FAKE_CODEX_DISABLED_PLUGIN_IDS
 *                           목록 RPC 판정 금지(ⓞ) 시험용 가짜 응답
 *   FAKE_CODEX_REQUEST_LOG          온 요청을 `{method, params}` 한 줄씩 남긴다(㉲·㉮ 대조)
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MODE = process.env.FAKE_CODEX_MODE ?? 'logged-in'
if (MODE === 'dead') process.exit(1)

const STATE = process.env.FAKE_CODEX_STATE ?? ''
const REPLY_FILE = process.env.FAKE_CODEX_REPLY ?? ''
const ASK = process.env.FAKE_CODEX_ASK === '1'
/** 권한 요청의 command·reason — 여러 줄 명령/이유만 있는 요청을 재현하려고 열어 둔다(QA2A-R1-02). */
const ASK_COMMAND = process.env.FAKE_CODEX_ASK_COMMAND ?? 'cat /etc/hosts'
const ASK_REASON = process.env.FAKE_CODEX_ASK_REASON ?? '논문 폴더 밖 파일을 읽으려고 해요'
const FILE_EVENTS = process.env.FAKE_CODEX_FILE_EVENTS
const FILE_AFTER = process.env.FAKE_CODEX_FILE_AFTER
/** 턴이 끝나기 전에 보낼 알림 — 셸 명령 결과(`commandExecution`)의 출력을 시험한다. */
const COMMAND_EVENTS = process.env.FAKE_CODEX_COMMAND_EVENTS
/** 응답 지연(ms) — 느린 기계(CI) 조건을 만들기 위한 시험 전용 스위치. 기본 0(동작 불변). */
const DELAY_MS = Math.max(0, Number(process.env.FAKE_CODEX_DELAY_MS ?? 0) || 0)
/** 턴을 끝내지 않는다 — "작업 중" 화면을 안정적으로 본다. `after-delta` 면 답 첫 조각(전달 확인)을 보낸 뒤 붙잡는다. */
const HOLD = process.env.FAKE_CODEX_HOLD === '1'
const HOLD_AFTER_DELTA = process.env.FAKE_CODEX_HOLD === 'after-delta'
/** `model/list` 응답 — 시험이 요금제별 목록을 흉내 낼 수 있게 환경변수로 바꾼다. */
const TURN_LOG = process.env.FAKE_CODEX_TURN_LOG ?? ''
const APPLIED_LOG = process.env.FAKE_CODEX_APPLIED_LOG ?? ''
const DECISION_LOG = process.env.FAKE_CODEX_DECISION_LOG ?? ''
const TURN_INPUT_LOG = process.env.FAKE_CODEX_TURN_INPUT_LOG ?? ''
/** 새 대화에 서버가 실제로 쓰는 기본값 — 앱은 이것을 '되돌리기' 값으로 쓴다. */
const DEFAULT_MODEL = process.env.FAKE_CODEX_DEFAULT_MODEL ?? 'gpt-default'
const DEFAULT_EFFORT = process.env.FAKE_CODEX_DEFAULT_EFFORT ?? 'medium'
/** initialize 전 요청 거절 + 응답 지연(서버가 아직 초기화 중인 상태 재현). */
const INIT_DELAY_MS = Math.max(0, Number(process.env.FAKE_CODEX_INIT_DELAY_MS ?? 0) || 0)
/** 기본값 조회(ephemeral thread)만 실패시키는 횟수 — 실패 뒤 재조회 경로를 시험한다. */
let ephemeralFailures = Math.max(0, Number(process.env.FAKE_CODEX_EPHEMERAL_FAIL_TIMES ?? 0) || 0)
let modelListFailures = Math.max(0, Number(process.env.FAKE_CODEX_MODELS_FAIL_TIMES ?? 0) || 0)
const TURN_FAILURE = process.env.FAKE_CODEX_TURN_FAILURE ?? ''
const LOGIN_COMPLETE = process.env.FAKE_CODEX_LOGIN_COMPLETE ?? ''
const TURN_RELEASE = process.env.FAKE_CODEX_TURN_RELEASE ?? ''
const MODELS = (() => {
  const raw = process.env.FAKE_CODEX_MODELS
  if (raw) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] } }
  const one = (id, name, efforts, isDefault = false) => ({
    id, model: id, displayName: name, description: '',
    hidden: false, supportsPersonality: false, upgrade: null, upgradeInfo: null, availabilityNux: null,
    modelSpecialty: null, inputModalities: [], multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
    defaultServiceTier: null, availableAccessPrograms: null, isDefault,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: '' })),
    defaultReasoningEffort: efforts[0]
  })
  return [
    one('gpt-sol', 'Sol', ['medium', 'high'], true),
    one('gpt-terra', 'Terra', ['low', 'medium', 'high']),
    one('gpt-luna', 'Luna', ['low', 'medium']),
    one('gpt-astra', 'Astra', ['medium', 'high'])
  ]
})()

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

// ── 1층 잠금·턴 원장 시험용 노브 — 전부 '설정하지 않으면 기존과 같다' ───────────
/** JSON 노브. 깨진 JSON 은 `undefined`(기본값)로 본다. */
const jsonKnob = (name) => {
  const raw = process.env[name]
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}
const CONFIG_READ = jsonKnob('FAKE_CODEX_CONFIG_READ')
let configReadFailures = Math.max(0, Number(process.env.FAKE_CODEX_CONFIG_READ_FAIL_TIMES ?? 0) || 0)
const PLUGIN_INSTALLED = jsonKnob('FAKE_CODEX_PLUGIN_INSTALLED')
const APP_LIST = jsonKnob('FAKE_CODEX_APP_LIST')
const MCP_STATUS = jsonKnob('FAKE_CODEX_MCP_STATUS')
const THREAD_LIST = jsonKnob('FAKE_CODEX_THREAD_LIST')
const THREAD_TURNS_LIST = jsonKnob('FAKE_CODEX_THREAD_TURNS_LIST')
const THREAD_TURNS_KNOB = jsonKnob('FAKE_CODEX_THREAD_TURNS')
const THREAD_TURNS_RAW = process.env.FAKE_CODEX_THREAD_TURNS_RAW
const INSTRUCTION_SOURCES = jsonKnob('FAKE_CODEX_INSTRUCTION_SOURCES')
const INSTRUCTION_SOURCES_MODE = process.env.FAKE_CODEX_INSTRUCTION_SOURCES_MODE ?? ''
/** `echo`(기본) | `mismatch` | `missing` | `nonstring` | `none`(응답 없음) */
const THREAD_ID_MODE = process.env.FAKE_CODEX_THREAD_ID_MODE ?? 'echo'
/** `1` 이면 `thread/start` 에 응답하지 않는다 — 미결 시작 재현. */
const START_TIMEOUT = process.env.FAKE_CODEX_START_TIMEOUT === '1'
/** `active-writer` | `no-rollout` | `error` | `timeout` */
const RESUME_ERROR = process.env.FAKE_CODEX_RESUME_ERROR ?? ''
let resumeFailures = Math.max(0, Number(process.env.FAKE_CODEX_RESUME_FAIL_TIMES ?? 0) || 0)
/** `fixed`(기본 `u-fake`) | `unique` | `shared` */
const TURN_ID_MODE = process.env.FAKE_CODEX_TURN_ID_MODE ?? 'fixed'
const TURN_NOTIFY_DELAY_MS = Math.max(0, Number(process.env.FAKE_CODEX_TURN_NOTIFY_DELAY_MS ?? 0) || 0)
const TURN_CRASH = process.env.FAKE_CODEX_TURN_CRASH ?? ''
const SKILLS_LIST = jsonKnob('FAKE_CODEX_SKILLS_LIST')
const HOOKS_LIST = jsonKnob('FAKE_CODEX_HOOKS_LIST')
const DISABLED_PLUGIN_IDS = jsonKnob('FAKE_CODEX_DISABLED_PLUGIN_IDS')
const REQUEST_LOG = process.env.FAKE_CODEX_REQUEST_LOG ?? ''
/**
 * 턴 id 셈을 프로세스 밖에 둔다 — 앱이 프로세스를 갈아 끼워도(재시작 갈래) id 가 겹치지 않아야
 * 실제 서버와 같다. 파일이 없으면 예전처럼 프로세스 안에서만 센다.
 */
const TURN_SEQ_FILE = process.env.FAKE_CODEX_TURN_SEQ_FILE ?? ''
let startSeq = 0
let turnSeq = 0
if (TURN_SEQ_FILE && existsSync(TURN_SEQ_FILE)) {
  const seeded = Number(readFileSync(TURN_SEQ_FILE, 'utf8'))
  if (Number.isFinite(seeded) && seeded > 0) turnSeq = Math.floor(seeded)
}
const nextTurnSeq = () => {
  const next = ++turnSeq
  if (TURN_SEQ_FILE) {
    try { writeFileSync(TURN_SEQ_FILE, String(next)) } catch { /* 셈을 못 남기면 이 프로세스 안에서만 센다 */ }
  }
  return next
}
/**
 * 턴 목록을 `thread/start`·`resume` 응답에 싣는다. 기본(`0`)이면 예전처럼 늘 빈 배열 —
 * 1층 잠금 이전 spec 이 보는 응답이 한 바이트도 달라지지 않게 한다.
 */
const TRACK_TURNS = process.env.FAKE_CODEX_TRACK_TURNS === '1'
  || TURN_NOTIFY_DELAY_MS > 0 || TURN_CRASH !== '' || TURN_ID_MODE !== 'fixed'
  || THREAD_TURNS_KNOB !== undefined || THREAD_TURNS_RAW !== undefined

/**
 * 목록 응답 노브 해석 — `[[…], […]]`(장별), `{pages}`, `{endless}`, `{fail: n}`,
 * `{malformed:'null'|'object'|'string'}`. 정의하지 않았으면 `undefined`(기본 응답).
 */
const listPages = new Map()
function pagedResult(key, spec) {
  const page = listPages.get(key) ?? 0
  listPages.set(key, page + 1)
  if (spec === undefined) return { data: [], nextCursor: null }
  if (Array.isArray(spec)) return { data: spec, nextCursor: null }
  if (spec && typeof spec === 'object') {
    if (spec.fail !== undefined && page < spec.fail) return { error: { code: -32603, message: 'temporary failure' } }
    if (spec.error === true) return { error: { code: -32603, message: 'temporary failure' } }
    if (spec.malformed === 'null') return { data: null, nextCursor: null }
    if (spec.malformed === 'object') return { data: {}, nextCursor: null }
    if (spec.malformed === 'string') return { data: 'nope', nextCursor: null }
    if (spec.endless === true) return { data: spec.data ?? [{ id: 'n-page' }], nextCursor: `p${page + 1}` }
    if (Array.isArray(spec.pages)) {
      const rows = spec.pages[page] ?? []
      const more = page + 1 < spec.pages.length
      return { data: rows, nextCursor: more ? `p${page + 1}` : null }
    }
  }
  return { data: [], nextCursor: null }
}
const sendPaged = (id, key, spec) => {
  const res = pagedResult(key, spec)
  if (res.error) return out({ id, error: res.error })
  return out({ id, result: { data: res.data, nextCursor: res.nextCursor } })
}
/** 대화별 턴 — 원장 대조·바깥 턴 재현용. 노브·파일로 미리 심을 수 있다. */
const threadTurns = new Map()
/**
 * 실제 응답의 `thread.turns` 는 **턴 객체**의 배열이다(`{id, items}`). 짧게 id 문자열로 심는
 * 노브(`FAKE_CODEX_THREAD_TURNS`)도 같은 모양으로 올려 둔다 — 앱이 두 모양을 다르게 읽으면
 * 시험이 실제 서버를 흉내 내지 못한다.
 */
const turnEntry = (t) => (typeof t === 'string' ? { id: t, items: [] } : t)
const normalizeTurns = (list) => (Array.isArray(list) ? list.map(turnEntry) : [])
const turnsOf = (id) => {
  if (!threadTurns.has(id)) threadTurns.set(id, [])
  return threadTurns.get(id)
}
if (THREAD_TURNS_KNOB && typeof THREAD_TURNS_KNOB === 'object') {
  for (const [tid, turns] of Object.entries(THREAD_TURNS_KNOB)) threadTurns.set(tid, normalizeTurns(turns))
}
const instructionSources = () => INSTRUCTION_SOURCES !== undefined ? INSTRUCTION_SOURCES : []

const loggedIn = () => MODE === 'logged-in' || (MODE === 'logged-out' && !!STATE && existsSync(STATE))
const replyText = () => {
  if (!REPLY_FILE) return ''
  try { return readFileSync(REPLY_FILE, 'utf8') } catch { return '' }
}

let threadId = 't-fake'
let serverSeq = 9000
/** 서버가 아직 initialize 를 못 받았으면 다른 요청은 거절한다(문서의 초기화 계약). */
let initialized = false
/** 대화별로 **실제 적용된** model·effort. 턴 덮어쓰기가 뒤 턴에 남는 계약을 흉내 낸다. */
const threads = new Map()
/** 앱 재시작 경계 재현용 — 대화 상태를 파일에 남겨 다음 프로세스가 같은 대화를 이어받는다. */
const THREAD_FILE = process.env.FAKE_CODEX_THREAD_STATE ?? ''
if (THREAD_FILE && existsSync(THREAD_FILE)) {
  try {
    const v = JSON.parse(readFileSync(THREAD_FILE, 'utf8'))
    if (typeof v?.threadId === 'string') threads.set(v.threadId, { model: v.model, effort: v.effort })
  } catch { /* 잘린 파일은 무시 */ }
}
const saveThread = (id, st) => {
  if (THREAD_FILE) writeFileSync(THREAD_FILE, JSON.stringify({ threadId: id, model: st.model, effort: st.effort }))
}
const threadState = (id) => {
  if (!threads.has(id)) threads.set(id, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT })
  return threads.get(id)
}
let ephemeralSeq = 0
/** `thread/start`·`thread/resume` 응답 — 앱이 대화의 model·effort 를 읽는다. */
const threadResult = (id, turns) => {
  const st = threadState(id)
  const listed = turns ?? (THREAD_TURNS_RAW !== undefined
    ? (() => { try { return JSON.parse(THREAD_TURNS_RAW) } catch { return [] } })()
    : TRACK_TURNS ? turnsOf(id) : [])
  const result = {
    thread: { id, turns: listed, ephemeral: false },
    model: st.model, modelProvider: 'openai', serviceTier: null,
    disabledPluginIds: DISABLED_PLUGIN_IDS ?? [], cwd: process.cwd(),
    approvalPolicy: 'on-request', approvalsReviewer: null, sandbox: { type: 'workspaceWrite' },
    reasoningEffort: st.effort
  }
  // `instructionSources` 를 빼는 갈래(ⓗ′)는 키 자체를 두지 않는다.
  if (INSTRUCTION_SOURCES_MODE !== 'missing') result.instructionSources = instructionSources()
  return result
}
/** `thread/start`·`resume` 응답의 `thread.id` — 노브로 불일치/누락/비문자열을 재현한다. */
const responseThreadId = (requested) => {
  if (THREAD_ID_MODE === 'mismatch') return `other-${++startSeq}`
  if (THREAD_ID_MODE === 'missing') return undefined
  if (THREAD_ID_MODE === 'nonstring') return 12345
  return requested
}

function handle(message) {
  // Answerless notifications and responses from the app.
  if (message.method === undefined) {
    if (DECISION_LOG && message.id !== undefined && message.result?.decision) {
      appendFileSync(DECISION_LOG, `${JSON.stringify({ decision: message.result.decision })}\n`)
    }
    return
  }
  if (message.method === 'initialized') { initialized = true; return }
  if (message.id === undefined) return
  const id = message.id
  const params = message.params ?? {}
  if (!initialized && message.method !== 'initialize') {
    return out({ id, error: { code: -32002, message: 'Not initialized' } })
  }
  if (REQUEST_LOG) appendFileSync(REQUEST_LOG, `${JSON.stringify({ method: message.method, params })}\n`)
  switch (message.method) {
    // ── 1층 잠금 열거·대조(§4.1-C). 노브가 없으면 "아무것도 없는 설정"으로 답한다. ──
    case 'config/read': {
      if (configReadFailures > 0) {
        configReadFailures -= 1
        return out({ id, error: { code: -32603, message: 'config read failed' } })
      }
      if (CONFIG_READ === undefined) return out({ id, result: { config: { mcp_servers: {}, plugins: {} }, layers: [] } })
      if (CONFIG_READ && typeof CONFIG_READ === 'object' && CONFIG_READ.fail === true) {
        return out({ id, error: { code: -32603, message: 'config read failed' } })
      }
      if (CONFIG_READ && typeof CONFIG_READ === 'object' && CONFIG_READ.malformed === true) {
        return out({ id, result: { config: null } })
      }
      return out({ id, result: CONFIG_READ })
    }
    case 'plugin/installed':
      return sendPaged(id, 'plugin', PLUGIN_INSTALLED)
    case 'app/list':
      return sendPaged(id, 'apps', APP_LIST)
    case 'mcpServerStatus/list':
      return sendPaged(id, 'mcp', MCP_STATUS)
    case 'thread/list':
      return sendPaged(id, 'threads', THREAD_LIST)
    case 'thread/turns/list':
      return sendPaged(id, 'turns', THREAD_TURNS_LIST)
    case 'skills/list': {
      if (SKILLS_LIST !== undefined) return out({ id, result: SKILLS_LIST })
      const cwd = (params.cwds ?? [])[0] ?? process.cwd()
      const skill = join(cwd, '.agents', 'skills', 'knuaf-dev', 'SKILL.md')
      // 실제 Codex처럼 설치된 파일만 보고하고 경로 별칭·구분자를 정규화한다.
      const skills = existsSync(skill) ? [{ path: realpathSync(skill), enabled: true }] : []
      return out({ id, result: { data: [{ skills }] } })
    }
    case 'hooks/list':
      return out({ id, result: { data: HOOKS_LIST ?? [] } })
    case 'initialize':
      // userAgent 의 판(version) 토큰을 앱이 읽는다. 늦게 답해 초기화 중 상태를 만든다.
      if (INIT_DELAY_MS > 0) setTimeout(() => out({ id, result: { userAgent: 'codex_cli_rs/0.0.0-test' } }), INIT_DELAY_MS)
      else out({ id, result: { userAgent: 'codex_cli_rs/0.0.0-test' } })
      return
    case 'account/read':
      return out({ id, result: { account: loggedIn() ? { type: 'chatgpt' } : null } })
    case 'account/login/start':
      if (STATE && !LOGIN_COMPLETE) writeFileSync(STATE, 'chatgpt\n')
      out({ id, result: { loginId: 'fake', authUrl: 'about:blank' } })
      if (LOGIN_COMPLETE) {
        const timer = setInterval(() => {
          if (!existsSync(LOGIN_COMPLETE)) return
          clearInterval(timer)
          if (STATE) writeFileSync(STATE, 'chatgpt\n')
          out({ method: 'account/login/completed', params: { loginId: 'fake', success: true } })
        }, 50)
      } else if (process.env.FAKE_CODEX_LOGIN_EARLY === '1') {
        out({ method: 'account/login/completed', params: { loginId: 'old-attempt', success: true } })
        out({ method: 'account/login/completed', params: { loginId: 'fake', success: true } })
      } else out({ method: 'account/login/completed', params: { loginId: 'fake', success: true } })
      return
    case 'thread/start':
    case 'thread/resume': {
      // `ephemeral` 은 앱이 '서버 기본값'을 물을 때 쓴다 — 디스크에 남지 않는 대화 하나.
      if (params.ephemeral === true) {
        if (ephemeralFailures > 0) {
          ephemeralFailures -= 1
          return out({ id, error: { code: -32603, message: 'temporary failure' } })
        }
        const ephId = `t-ephemeral-${++ephemeralSeq}`
        threads.set(ephId, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT })
        return out({ id, result: threadResult(ephId) })
      }
      threadId = params.threadId ?? 't-fake'
      const isResume = message.method === 'thread/resume'
      if (isResume) {
        if (RESUME_ERROR && resumeFailures !== 0) {
          if (resumeFailures > 0) resumeFailures -= 1
          if (RESUME_ERROR === 'timeout') return // 응답 없음 — 앱이 시간 초과로 본다
          const message_ = RESUME_ERROR === 'active-writer' ? `-32600 thread ${threadId} already has an active writer`
            : RESUME_ERROR === 'no-rollout' ? `-32600 no rollout found for thread id ${threadId}`
              : 'resume failed'
          const code = RESUME_ERROR === 'error' ? -32603 : -32600
          return out({ id, error: { code, message: message_ } })
        }
      } else if (START_TIMEOUT) {
        return // 미결 시작 — 앱이 시간 초과로 본다. 이후 이 프로세스는 쓰이지 않아야 한다.
      }
      const result = threadResult(threadId)
      const replyId = responseThreadId(threadId)
      if (replyId === undefined) delete result.thread.id
      else result.thread.id = replyId
      return out({ id, result })
    }
    case 'model/list':
      if (modelListFailures > 0) {
        modelListFailures -= 1
        return out({ id, error: { code: -32603, message: '모델 목록 임시 오류' } })
      }
      // 쪽 나눔은 흉내 내지 않는다(앱은 nextCursor 가 없으면 멈춘다).
      return out({ id, result: { data: MODELS, nextCursor: null } })
    case 'turn/start': {
      if (TURN_INPUT_LOG) {
        const text = (params.input ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
        appendFileSync(TURN_INPUT_LOG, `${JSON.stringify({ threadId: params.threadId, text })}\n`)
      }
      // 앱이 실제로 보낸 값만 남긴다 — "안 골랐을 때는 키가 없다"를 시험이 구분할 수 있게.
      if (TURN_LOG) {
        const rec = {}
        if ('model' in params) rec.model = params.model
        if ('effort' in params) rec.effort = params.effort
        appendFileSync(TURN_LOG, `${JSON.stringify(rec)}\n`)
      }
      /**
       * 턴 덮어쓰기 계약: 보낸 model·effort 는 이 대화의 **뒤 턴에도** 남는다.
       * 생략은 "기본값으로 돌아가기"가 아니라 "지금 값을 유지"다(문서의 Turns 절).
       */
      const st = threadState(params.threadId ?? threadId)
      if ('model' in params && typeof params.model === 'string' && params.model) st.model = params.model
      if ('effort' in params && typeof params.effort === 'string' && params.effort) st.effort = params.effort
      if (APPLIED_LOG) appendFileSync(APPLIED_LOG, `${JSON.stringify({ ...st })}\n`)
      saveThread(params.threadId ?? threadId, st)
      const turnThread = params.threadId ?? threadId
      const turnId = TURN_ID_MODE === 'unique' ? `u-${nextTurnSeq()}`
        : TURN_ID_MODE === 'shared' ? 'u-shared' : 'u-fake'
      if (TURN_CRASH === 'before-reply') {
        // 턴은 남고 응답 전에 죽는다(㉱) — 앱이 원장을 못 쓰는 갈래.
        turnsOf(turnThread).push(turnEntry(turnId))
        process.exit(9)
      }
      turnsOf(turnThread).push(turnEntry(turnId))
      out({ id, result: { turn: { id: turnId } } })
      const started = () => out({ method: 'turn/started', params: { threadId: turnThread, turn: { id: turnId } } })
      if (TURN_NOTIFY_DELAY_MS > 0) setTimeout(started, TURN_NOTIFY_DELAY_MS)
      else started()
      if (TURN_FAILURE && (!LOGIN_COMPLETE || !existsSync(LOGIN_COMPLETE))) {
        const message = TURN_FAILURE === 'refresh' ? 'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.'
          : TURN_FAILURE === '401' ? 'HTTP 401 Unauthorized: authentication failed'
            : TURN_FAILURE === '401-with-secret-marker' ? 'SYNTHETIC-SENSITIVE-MARKER'
            : TURN_FAILURE === 'external-unauthorized' ? 'External research website returned HTTP 401 Unauthorized'
              : TURN_FAILURE === 'refresh-network' ? 'Your access token could not be refreshed: network timeout'
                : TURN_FAILURE === 'bare401' ? 'HTTP 401 Unauthorized: authentication failed'
                  : TURN_FAILURE === 'external401' ? '401 from external research website'
                    : TURN_FAILURE === 'rate' ? 'HTTP 429 rate limit exceeded' : 'Network error: ECONNRESET'
        const fail = () => out({ method: 'turn/completed', params: { threadId, turn: {
          id: turnId, status: 'failed', error: { message, ...(TURN_FAILURE.startsWith('401') ? { codexErrorInfo: 'unauthorized' } : {}) }
        } } })
        if (TURN_RELEASE) {
          const timer = setInterval(() => { if (existsSync(TURN_RELEASE)) { clearInterval(timer); fail() } }, 50)
        } else fail()
        return
      }
      if (FILE_EVENTS !== undefined) {
        for (const event of JSON.parse(FILE_EVENTS)) out(event)
        out({ id: ++serverSeq, method: 'item/fileChange/requestApproval', params: {
          threadId, turnId, itemId: 'file-1', startedAtMs: 1, reason: null, grantRoot: null
        } })
        if (FILE_AFTER) setTimeout(() => { for (const event of JSON.parse(FILE_AFTER)) out(event) }, 50)
        return
      }
      if (ASK) {
        // 허락 카드 장면 — 턴을 끝내지 않고 학생의 답을 기다린다.
        // 요청 id 는 최상위에 있어야 한다(줄 단위 JSON-RPC — 앱도 그렇게 읽는다).
        out({ id: ++serverSeq, method: 'item/commandExecution/requestApproval', params: {
          threadId,
          ...(ASK_COMMAND ? { command: ASK_COMMAND } : {}),
          ...(ASK_REASON ? { reason: ASK_REASON } : {})
        } })
        return
      }
      if (COMMAND_EVENTS !== undefined) {
        for (const event of JSON.parse(COMMAND_EVENTS)) out(event)
      }
      if (HOLD) return
      if (HOLD_AFTER_DELTA) {
        out({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'i-fake', delta: '답을 쓰고 있어요' } })
        return
      }
      const text = replyText()
      if (text) {
        out({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'i-fake', delta: text } })
        out({ method: 'item/completed', params: { threadId, item: { id: 'i-fake', type: 'agentMessage', text } } })
      }
      out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
      return
    }
    case 'turn/interrupt':
      return out({ id, result: {} })
    case 'item/commandExecution/requestApproval':
      return
    default:
      return out({ id, error: { code: -32601, message: `fake codex: 모르는 요청 ${message.method}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (DELAY_MS > 0) setTimeout(() => { try { handle(msg) } catch { /* 잘린 요청 */ } }, DELAY_MS)
      else handle(msg)
    } catch { /* 줄이 잘려 왔다 */ }
  }
})
