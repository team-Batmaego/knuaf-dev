// U5b — **실제 CLI** 로 하위 담당 입구가 닫혔는지 확인한다. 실제 AI 호출은 0회:
// CLI 의 API 요청은 이 파일 안의 가짜 Messages API(127.0.0.1)로만 간다.
//
// 왜 가짜 CLI 시험(U5)만으로는 부족한가(검토 U5b 차단 1·2):
//  · `Workflow` 도구는 훅에도 `canUseTool` 에도 판정 자리가 없이 하위 담당을 띄운다.
//  · `context: fork` 스킬은 `Skill` 한 번으로 같은 일을 한다(동봉 `code-review` 가 fork).
// 둘 다 "이름으로 거르는 훅" 밖이라, 엔진이 도구를 **주지 않는지**(`disallowedTools`)를
// 실물에서 확인해야 한다. 가짜 CLI 는 우리가 쓴 규칙을 우리가 흉내 내는 것이라 증거가 못 된다.
//
// 플랫폼 CLI(SDK 동봉본)가 없는 환경(지원 밖 arch·musl 등)에서는 skip 한다 — CI 초록을
// 깨지 않으면서, 있는 곳에서는 실제로 돈다.
import { expect, test } from '@playwright/test'
import http from 'node:http'
import { appendFileSync, existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { studentTurnText } from '../src/main/chat/claude'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const appRoot = resolve(__dirname, '..')

/**
 * SDK 가 동봉한 플랫폼 CLI. 없으면 null — 그 환경에서는 이 시험을 건너뛴다.
 *
 * **SDK 쪽에서 찾아야 한다**(pnpm 격리): 플랫폼 패키지는 SDK 의 optionalDependency 라 앱
 * `package.json` 기준으로는 보이지 않는다. 앱이 실제로 띄우는 바이너리도 같은 패키지다.
 */
function bundledCli(): string | null {
  const require = createRequire(join(appRoot, 'package.json'))
  const libc = process.platform === 'linux' ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime ? '' : '-musl' : ''
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}`
  try {
    const fromSdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
    // resolve 가 준 것은 package.json 파일 경로다 — 그 폴더에서 바이너리를 찾는다.
    const pkg = join(dirname(resolve(fromSdk.resolve(`${name}/package.json`))), 'claude')
    return existsSync(pkg) ? pkg : null
  } catch { return null }
}

const SUBAGENT_MARKER = 'SUBAGENT-MARKER'

/** 로그에 하위 담당 표지가 찍힐 때까지 잠깐 기다린다 — 없으면 그대로 끝난다(양성 대조가 잡는다). */
async function waitForMarker(logFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('SUBAGENT-RAN')) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
const MAIN_MARKER = 'MAIN-MARKER'

type Reply = {
  tool?: [string, Record<string, unknown>]
  /** 학생 폴더에 `context: fork` 스킬 `forky` 를 둔다 — 학생 글의 슬래시로 펼쳐지는지 본다. */
  forkSkill?: boolean
}

/**
 * 가짜 Messages API. 메인 차례에는 시나리오의 `tool_use` 를, 하위 담당 차례에는 표지가 실려
 * 왔는지를 보고 `SUBAGENT-RAN` 을 남긴다 — 그 로그가 "엔진이 하위 담당을 실제로 띄웠다"는 증거다.
 */
async function fakeApi(reply: Reply, logFile: string): Promise<{ url: string; close: () => Promise<void>; toolsSeen: string[] }> {
  const toolsSeen: string[] = []
  let mainTurns = 0
  const flat = (c: unknown): string => typeof c === 'string' ? c : JSON.stringify(c)
  const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // SSE 프레임: `event: <이름>` 줄과 `data: <JSON>` 줄 — 이름을 data 자리에 쓰면 CLI 가
    // "no stream events" 로 실패한다(실CLI 에서 그대로 확인).
    for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  }
  const start = (model: string) => ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }] as [string, unknown]
  const text = (res: http.ServerResponse, model: string) => sse(res, [start(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }]])
  const tool = (res: http.ServerResponse, model: string, [name, input]: [string, Record<string, unknown>]) => sse(res, [start(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }]])
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}')
        return
      }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return }
      // 바깥에서 온 JSON — 여기서 한 번만 좁히고 그 뒤로는 좁힌 값만 읽는다.
      let parsed: unknown = {}
      try { parsed = JSON.parse(body) } catch { parsed = {} }
      const body0 = parsed && typeof parsed === 'object' ? parsed : {}
      const messages = 'messages' in body0 && Array.isArray(body0.messages) ? body0.messages : []
      const all = flat(messages)
      const head = messages.length > 0 ? messages[0] : undefined
      const first = head && typeof head === 'object' && 'content' in head ? flat(head.content) : ''
      const model = 'model' in body0 && typeof body0.model === 'string' ? body0.model : 'claude'
      const isMain = first.includes(MAIN_MARKER)
      if (!isMain && all.includes(SUBAGENT_MARKER)) {
        appendFileSync(logFile, JSON.stringify({ ev: 'SUBAGENT-RAN' }) + '\n')
        return text(res, model)
      }
      if (isMain && mainTurns === 0) {
        const raw = 'tools' in body0 && Array.isArray(body0.tools) ? body0.tools : []
        const names = raw.map((t) => (t && typeof t === 'object' && 'name' in t && typeof t.name === 'string' ? t.name : ''))
        toolsSeen.push(...names)
        appendFileSync(logFile, JSON.stringify({ ev: 'main-tools', tools: names }) + '\n')
      }
      if (!isMain) return text(res, model)
      if (!reply.tool || mainTurns > 0) return text(res, model)
      mainTurns++
      return tool(res, model, reply.tool)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    toolsSeen,
    close: () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      server.close(() => resolve())
      return promise
    }
  }
}

/**
 * 실제 CLI 한 판. `disallowed` 를 주면 앱이 실제로 넘기는 옵션과 같은 모양이 된다.
 * 돌려주는 `ran` 은 하위 담당 대화가 엔진에서 시작됐는지다.
 */
async function runCli(cli: string, reply: Reply, opts: { disallowed?: string[]; studentText?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kd-u5b-cli-'))
  const ws = join(root, 'ws'); const home = join(root, 'home'); const cfg = join(root, 'cfg')
  for (const dir of [ws, home, cfg]) mkdirSync(dir, { recursive: true })
  const logFile = join(root, 'log.jsonl')
  writeFileSync(logFile, '')
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { [ws]: { hasTrustDialogAccepted: true } } }))
  if (reply.forkSkill) {
    mkdirSync(join(ws, '.claude', 'skills', 'forky'), { recursive: true })
    writeFileSync(join(ws, '.claude', 'skills', 'forky', 'SKILL.md'),
      `---\nname: forky\ndescription: forked test skill\ncontext: fork\n---\n${SUBAGENT_MARKER} fork skill body: reply ok.\n`)
  }
  const api = await fakeApi(reply, logFile)
  let ran = false
  try {
    const env = {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TMPDIR: process.env.TMPDIR,
      ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-for-local-mock-only',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1'
    }
    // `studentText` 가 있으면 **앱이 만드는 그 글 그대로** 보낸다(첫 턴: `/knuaf-dev <학생글>`,
    // resume 턴: `studentTurnText(학생글)`). 없으면 대조용 표지 글.
    const q = query({
      prompt: opts.studentText ?? `${MAIN_MARKER} do the task`,
      options: {
        cwd: ws, pathToClaudeCodeExecutable: cli, env, settingSources: ['project', 'local'],
        permissionMode: 'default', model: 'claude-sonnet-4-5',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'test' },
        canUseTool: async (_name: string, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
        ...(opts.disallowed ? { disallowedTools: opts.disallowed } : {}),
        stderr: (d: string) => appendFileSync(join(root, 'stderr.txt'), d)
      }
    })
    // Workflow 는 **백그라운드로** 뜬다 — 메인 result 가 먼저 오고 하위 담당 요청이 그 뒤에 온다.
    // result 에서 끊으면 그 요청을 못 본다(검토 재현물도 결과 뒤에 기다린다).
    let seenResult = false
    for await (const m of q) {
      if (m.type !== 'result' || seenResult) continue
      seenResult = true
      await waitForMarker(logFile, 5_000)
    }
    ran = readFileSync(logFile, 'utf8').includes('SUBAGENT-RAN')
    return { ran, tools: api.toolsSeen }
  } finally { await api.close() }
}

const cli = bundledCli()

test.skip(!cli, '플랫폼 CLI(SDK 동봉본)가 없는 환경 — 실CLI 대조는 건너뛴다')

const WORKFLOW_REPLY: Reply = { tool: ['Workflow', { script: `export const meta = { name: 'w', description: 'd' }\nconst r = await agent('${SUBAGENT_MARKER} child', { label: 'x' })\nreturn { r }\n` }] }
const FORK_REPLY: Reply = { tool: ['Skill', { skill: 'code-review', args: `${SUBAGENT_MARKER} topic` }] }

test('U5b(실CLI): 엔진 옵션이 없으면 Workflow·fork Skill 이 하위 담당을 띄운다 — 시험기 유효성', async () => {
  // 양성 대조. 이게 깨지면 아래 두 시험은 "원래 안 뜨는 것"을 통과로 읽는다.
  expect((await runCli(cli!, WORKFLOW_REPLY)).ran, 'Workflow 가 하위 담당을 띄워야 대조가 성립한다').toBe(true)
  expect((await runCli(cli!, FORK_REPLY)).ran, 'fork 스킬이 하위 담당을 띄워야 대조가 성립한다').toBe(true)
})

test('U5b(실CLI): disallowedTools 로 Workflow·fork Skill 을 닫으면 하위 담당이 뜨지 않는다', async () => {
  // 앱이 실제로 넘기는 목록과 같은 값 — claude.ts 의 DISALLOWED_SUBAGENT_TOOLS.
  const disallowed = ['Agent', 'Task', 'Workflow', 'Skill']
  for (const reply of [WORKFLOW_REPLY, FORK_REPLY]) {
    const r = await runCli(cli!, reply, { disallowed })
    expect(r.ran, `${reply.tool?.[0]} 경로에서 하위 담당이 떴어요`).toBe(false)
    // 도구 목록에서도 빠졌다(모델이 부를 수 있는 선택지 자체가 없다).
    expect(r.tools).not.toContain('Workflow')
    expect(r.tools).not.toContain('Skill')
  }
})

/**
 * U5c — **학생이 슬래시로 시작하는 글**을 쳤을 때. `disallowedTools` 는 `Skill` 도구를 꺼도
 * CLI 가 학생 글의 슬래시 명령을 **직접** 펼치는 길을 막지 못한다(실측). 그래서 앱은 그 글을
 * 일반 글로 바꿔 보낸다 — 여기서는 그 처방이 실CLI 에서 실제로 하위 담당을 막는지 본다.
 */
const STUDENT_SLASH = '/forky 이 논문 봐 줘'

test('U5c(실CLI): 학생 글을 그대로 보내면 슬래시 fork 스킬이 하위 담당을 띄운다 — 양성 대조', async () => {
  // 대조: 앱의 처방 없이 학생 글을 그대로 보내면 CLI 가 `/forky` 를 명령으로 읽는다.
  const r = await runCli(cli!, { forkSkill: true }, { disallowed: ['Agent', 'Task', 'Workflow', 'Skill'], studentText: STUDENT_SLASH })
  expect(r.ran, '학생 글의 슬래시가 fork 스킬을 펼쳐야 대조가 성립한다').toBe(true)
})

test('U5c(실CLI): studentTurnText 를 거친 글은 명령으로 읽히지 않는다', async () => {
  const r = await runCli(cli!, { forkSkill: true }, {
    disallowed: ['Agent', 'Task', 'Workflow', 'Skill'],
    studentText: studentTurnText(STUDENT_SLASH)
  })
  expect(r.ran, '앞 칸을 붙였는데도 하위 담당이 떴어요').toBe(false)
})
