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
  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify(msg) + '\n')
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      // 소비하지 않는 stderr 파이프가 대화를 멈추는 회귀도 잡는다.
      // `models` 는 SDK 초기화 응답의 실제 자리다 — 앱의 모델 칩이 여기서 목록을 받는다.
      const models = process.env.W1_MODELS ? JSON.parse(process.env.W1_MODELS) : []
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
      send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId })
    }
  })
}
