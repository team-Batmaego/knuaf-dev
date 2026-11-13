// Claude SDK의 초기화·대화 프로토콜만 흉내 낸다. 네트워크·실제 계정 접근 없음.
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
// 실제 CLI 는 재개하면 그 세션 id 로 답하고, 새 대화면 새 id 를 만든다 — 앱은 그 id 를 저장해
// 다음 턴을 잇는다. 시험은 `W1_SESSION_SEQ`(카운터 파일)로 새 대화마다 다른 id 를 받는다.
const resumeArg = args.find((a) => a.startsWith('--resume='))
const seqFile = process.env.W1_SESSION_SEQ
let sessionId = 'fake-session'
if (resumeArg) sessionId = resumeArg.slice('--resume='.length)
else if (seqFile) {
  const n = (existsSync(seqFile) ? Number(readFileSync(seqFile, 'utf8')) || 0 : 0) + 1
  writeFileSync(seqFile, String(n))
  sessionId = `fake-session-${n}`
}
// 이 턴에 앱이 실제로 넘긴 모델 — 초기화가 무엇을 답할지 시험이 정한다(`W1_INIT_MODEL_BY_MODEL`).
const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined
/**
 * `--disallowedTools` = 엔진이 모델에게 **도구를 주지 않는** 자리다. 실제 CLI 는 그 이름을
 * 도구 목록에서 빼고, 모델이 그래도 부르면 "No such tool available" 로 끝낸다(훅도
 * can_use_tool 도 보지 않는다 — 검토 U5b 실측). 가짜 CLI 도 그 계약을 그대로 흉내 낸다.
 */
const disallowedArg = args.includes('--disallowedTools') ? args[args.indexOf('--disallowedTools') + 1] : ''
const DISALLOWED = new Set(disallowedArg.split(',').map((s) => s.trim()).filter(Boolean))
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
} else if (args[0] === 'auth' && args[1] === 'login') {
  appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify({ args }) + '\n')
  console.log('https://example.invalid/fake-claude-login')
  const timer = setInterval(() => {
    if (!existsSync(process.env.W1_LOGIN_COMPLETE)) return
    clearInterval(timer)
    if (process.env.W1_LOGIN_FAIL === '1') process.exitCode = 1
    else writeFileSync(process.env.W1_AUTH_STATE, 'fake login completed')
  }, 20)
} else {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n')
  const lines = createInterface({ input: process.stdin })
  /** 실제 CLI 처럼 앱의 답을 기다리는 요청들 — 응답 줄이 오면 이 자리에서 풀린다. */
  const waiting = new Map()
  /** 초기화가 등록한 PreToolUse 훅. 실제 CLI 는 이 id 로 앱에 물어보고 답을 기다린다. */
  let hookIds = []
  const ask = (request) => new Promise((resolve) => {
    const requestId = `r-${waiting.size + 1}`
    waiting.set(requestId, resolve)
    send({ type: 'control_request', request_id: requestId, request })
  })
  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify(msg) + '\n')
    if (msg.type === 'control_response') {
      const done = waiting.get(msg.response?.request_id)
      if (done) { waiting.delete(msg.response.request_id); done(msg.response.response ?? msg.response) }
      return
    }
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      // 소비하지 않는 stderr 파이프가 대화를 멈추는 회귀도 잡는다.
      // `models` 는 SDK 초기화 응답의 실제 자리다 — 앱의 모델 칩이 여기서 목록을 받는다.
      const models = process.env.W1_MODELS ? JSON.parse(process.env.W1_MODELS) : []
      hookIds = (msg.request.hooks?.PreToolUse ?? []).flatMap((m) => m.hookCallbackIds ?? [])
      process.stderr.write('x'.repeat(256 * 1024), () => send({ type: 'control_response', response: {
        subtype: 'success', request_id: msg.request_id,
        response: { commands: [{ name: 'knuaf-dev' }], account: { apiKeySource: 'none' }, models }
      } }))
    } else if (msg.type === 'user') {
      // 실제 CLI 는 첫 user 메시지 앞에 초기화 메시지를 보낸다 — 앱은 그 model 로 계정
      // 기본값을 확인하고, 요청한 모델과 어긋나는지 본다.
      // `W1_INIT_MODEL_BY_MODEL` 은 `--model` 별로 초기화가 답할 model 을 정한다 —
      // 실제 CLI 처럼 "보낸 모델을 그대로 쓴다"를 흉내 내려면 그 파일에 별칭→id 를 적는다.
      const byModel = process.env.W1_INIT_MODEL_BY_MODEL ? JSON.parse(process.env.W1_INIT_MODEL_BY_MODEL) : {}
      const initModel = (modelArg && byModel[modelArg]) || process.env.W1_INIT_MODEL || 'claude-opus-5'
      const announce = () => send({ type: 'system', subtype: 'init', session_id: sessionId,
        model: initModel, tools: [], mcp_servers: [] })
      announce()
      void (async () => {
        /**
         * 하위 담당 호출을 **실제 CLI 처럼** 흉내 낸다(설계 §3.2 [r11] · §8). 두 갈래가 있다.
         *  · `W1_HOOK_TOOL`: 훅이 켜진 일반 도구 경로 — CLI 가 앱의 PreToolUse 훅에 묻고,
         *    거절이면 도구를 **실행하지 않고** 그 사유를 tool_result 로 돌려준다.
         *  · `W1_PERMISSION_TOOL`: 훅을 못 듣는 판 — CLI 가 can_use_tool 로 묻는다(2차 그물).
         * 어느 쪽이든 "거절이면 Agent 결과가 없다"가 시험의 핵심이다.
         */
        const decide = async (tool) => {
          if (process.env.W1_HOOK_TOOL && hookIds.length > 0) {
            const decision = await ask({
              subtype: 'hook_callback', callback_id: hookIds[0], tool_use_id: 'tu-hook',
              input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: 'tu-hook',
                tool_input: { subagent_type: 'general-purpose', prompt: '혼자 조사해 줘', description: '조사' } }
            })
            const verdict = decision?.hookSpecificOutput ?? {}
            if (process.env.W1_HOOK_LOG) appendFileSync(process.env.W1_HOOK_LOG, JSON.stringify(verdict) + '\n')
            return { denied: verdict.permissionDecision === 'deny', reason: verdict.permissionDecisionReason ?? '' }
          }
          if (process.env.W1_PERMISSION_TOOL) {
            const decision = await ask({
              subtype: 'can_use_tool', tool_name: tool, tool_use_id: 'tu-perm', permission_suggestions: [],
              input: { subagent_type: 'general-purpose', prompt: '혼자 조사해 줘', description: '조사' }
            })
            if (process.env.W1_HOOK_LOG) appendFileSync(process.env.W1_HOOK_LOG, JSON.stringify(decision ?? {}) + '\n')
            return { denied: decision?.behavior === 'deny', reason: decision?.message ?? '' }
          }
          return { denied: false, reason: '' }
        }
        const tool = process.env.W1_HOOK_TOOL || process.env.W1_PERMISSION_TOOL
        if (tool && DISALLOWED.has(tool)) {
          // 엔진 단계 차단 — 훅·can_use_tool 을 부르지도 않는다(실측). 도구는 돌지 않는다.
          if (process.env.W1_HOOK_LOG) appendFileSync(process.env.W1_HOOK_LOG, JSON.stringify({ engineBlocked: tool }) + '\n')
          send({ type: 'user', uuid: 'tool-result', session_id: sessionId, message: { content: [{
            type: 'tool_result', tool_use_id: 'tu-call', is_error: true,
            content: `Error: No such tool available: ${tool}. ${tool} is disabled for this session.`
          }] } })
        } else if (tool) {
          const outcome = await decide(tool)
          // 도구가 **실제로 돌았는가**를 따로 남긴다 — 거절이면 돌지 않았다는 사실이 시험의 핵심이다.
          if (process.env.W1_HOOK_LOG) appendFileSync(process.env.W1_HOOK_LOG, JSON.stringify({ executed: !outcome.denied }) + '\n')
          // 거절이면 도구 결과는 오류 한 줄뿐이다 — 하위 담당이 돌았다는 흔적을 만들지 않는다.
          send({ type: 'assistant', uuid: 'tool-call', session_id: sessionId, message: { content: [{
            type: 'tool_use', id: 'tu-call', name: tool,
            input: { subagent_type: 'general-purpose', prompt: '혼자 조사해 줘', description: '조사' }
          }] } })
          send({ type: 'user', uuid: 'tool-result', session_id: sessionId, message: { content: [{
            type: 'tool_result', tool_use_id: 'tu-call', is_error: outcome.denied,
            content: outcome.denied ? outcome.reason : 'Agent 결과: 혼자 조사했습니다.'
          }] } })
        }
        const failure = process.env.W1_QUERY_ERROR || (process.env.W1_AUTH_STATE && !existsSync(process.env.W1_AUTH_STATE) ? 'authentication_failed' : '')
        if (failure) {
          const text = failure === 'authentication_failed'
            ? 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.'
            : failure === 'rate_limit' ? 'API Error: 429 rate limit exceeded' : 'Network error: ECONNRESET'
          const fail = () => {
            send({ type: 'assistant', error: failure === 'network' ? 'unknown' : failure, uuid: 'fake-error', session_id: sessionId, message: {
              content: [{ type: 'text', text }]
            } })
            send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text], session_id: sessionId })
          }
          if (process.env.W1_QUERY_RELEASE) {
            const timer = setInterval(() => { if (existsSync(process.env.W1_QUERY_RELEASE)) { clearInterval(timer); fail() } }, 20)
          } else fail()
          return
        }
        send({ type: 'assistant', uuid: 'answer', session_id: sessionId, message: {
          content: [{ type: 'text', text: '가짜 CLI 응답' }]
        } })
        // 토큰 기록 시험이 result.usage 를 흉내 낼 수 있게 연다 — 기본은 필드 없음(기존 시험 불변).
        const usage = process.env.W1_QUERY_USAGE ? { usage: JSON.parse(process.env.W1_QUERY_USAGE) } : {}
        send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...usage })
      })()
    }
  })
}
