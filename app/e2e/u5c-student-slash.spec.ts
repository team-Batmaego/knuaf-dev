// U5c — 학생이 입력창에 `/`로 시작하는 글을 보내도 그것이 **CLI 명령으로 읽히지 않게** 한다.
//
// 왜: `disallowedTools` 로 `Skill` 도구를 꺼도, 학생 글이 `/code-review …` 처럼 슬래시로 시작하면
// CLI 가 그 **슬래시 명령**을 직접 펼친다 — `Skill` 도구와 무관한 길이다. 앱 스킬 사본 폴더의
// fork 스킬, CLI 동봉 fork 스킬 모두 그렇게 하위 담당을 띄운다(실CLI 두 판 실측, 검토
// `REVIEW-U5-FIXCHECK.md` '범위 밖 관찰'). 앱 안에서 숨은 하위 담당이 도는 것은 설계 §3.2 와
// 형님 UI 원칙(학생은 아무것도 외울 필요 없음)에 모두 어긋난다.
//
// 성질: 학생이 친 글의 **낱말은 하나도 바꾸지 않는다**. 앞에 한 칸을 붙여 CLI 가 그 줄을 명령으로
// 읽지 않게 할 뿐이다(실측: 앞 공백 한 칸이면 일반 턴으로 간다).
import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeConnection, SKILL_PROMPT, studentTurnText } from '../src/main/chat/claude'
import type { AgentEvents } from '../src/main/chat/contracts'

const noopEvents: AgentEvents = { message: () => {}, permission: () => {}, note: () => {}, session: () => {}, skill: () => {} }

test('U5c: 학생 글이 슬래시로 시작하면 앞에 한 칸을 붙여 명령으로 읽히지 않게 한다', () => {
  // 첫 줄이 슬래시로 시작하는 글 — CLI 가 명령으로 읽을 수 있는 자리. 낱말은 그대로 두고 앞 칸만
  // 붙인다. **명령 이름을 가려내지 않는다**: 앱이 아는 목록(동봉·프로젝트·사용자·플러그인)을 다
  // 나열할 수 없고, 하나라도 빠지면 그 이름이 그대로 하위 담당을 연다. 앞 칸은 모델이 읽는
  // 낱말을 바꾸지 않으므로 넓게 잡는 쪽이 안전하다.
  for (const text of ['/code-review 이 논문 봐 줘', '/forky', '/knuaf-dev 뭐야', '/', '/ 경로가 아니라 그냥 글']) {
    const out = studentTurnText(text)
    expect(out.startsWith(' '), text).toBe(true)
    expect(out.trimStart()).toBe(text) // 글은 한 글자도 바뀌지 않는다
  }
  // 앞 공백·줄바꿈·탭이 이미 있으면 CLI 가 이미 일반 턴으로 읽는다 — 손대지 않는다(재현 실측).
  for (const text of [' /code-review x', '\n/code-review x', '\t/code-review x']) {
    expect(studentTurnText(text), JSON.stringify(text)).toBe(text)
  }
  // 줄 **안**의 슬래시는 명령 자리가 아니다(첫 줄만 본다). 코드 블록 안의 예시도 그대로 둔다.
  for (const text of [
    '앞말이에요\n/code-review',
    '이런 명령이 있어요:\n```\n/code-review\n```',
    '전각 슬래시 ／code-review 는 명령이 아니다',
    '', '   ', '그냥 질문이에요'
  ]) expect(studentTurnText(text), JSON.stringify(text)).toBe(text)
  // 문자열이 아니면 그대로 돌려준다(방어).
  expect(studentTurnText(undefined as unknown as string)).toBe(undefined)
})

/** 가짜 CLI 하나 — 앱이 실제로 CLI 에 넘긴 프롬프트를 로그에서 본다. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'kd-u5c-'))
  const log = join(root, 'query.jsonl')
  const fixture = resolve(__dirname, 'fixtures/fake-claude-query.mjs')
  const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 })
  writeFileSync(log, '')
  const env: NodeJS.ProcessEnv = { ...process.env, W1_QUERY_LOG: log, W1_SESSION_SEQ: join(root, 'seq') }
  const conn = new ClaudeConnection({ binary, root, skill: '', env, openExternal: async () => {} })
  /** CLI 에 실제로 간 사용자 글들(순서대로). */
  const prompts = (): string[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; message?: { content?: unknown } })
    .filter((r) => r.type === 'user')
    .map((r) => {
      const content = r.message?.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .map((b) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : ''))
        .join('')
    })
    .filter((text) => text !== '')
  return { root, conn, prompts }
}

test('U5c: resume 턴에 학생 글이 슬래시로 시작해도 CLI 에는 일반 글로 간다', async () => {
  const r = rig()
  try {
    // ① 새 대화 — 앱이 스킬 슬래시 명령을 앞에 붙인다(앱의 길, 그대로 둔다). 이름은 앱 상수
    // (`SKILL_PROMPT`)에서 가져온다 — 글자를 복붙하면 CLI 가 플러그인 이름표를 붙이는 순간 어긋난다.
    await r.conn.run('첫 요청', undefined, noopEvents)
    const first = r.prompts().at(-1)!
    expect(first.startsWith(`${SKILL_PROMPT} `)).toBe(true)

    // ② 이어지는 턴에 학생이 `/code-review …` 를 그대로 쳤다.
    await r.conn.run('/code-review 이 논문 봐 줘', 'fake-session-1', noopEvents)
    const resumed = r.prompts().at(-1)!
    // CLI 가 명령으로 읽지 않도록 앞 칸이 붙고, 학생이 쓴 낱말은 그대로다.
    expect(resumed).toBe(' /code-review 이 논문 봐 줘')
    expect(resumed.trimStart()).toBe('/code-review 이 논문 봐 줘')
  } finally { await r.conn.stop() }
})

test('U5c: 첫 턴 — 스킬 슬래시 뒤에 학생 글이 붙으므로 앱 스킬이 이긴다(그대로 둔다)', async () => {
  const r = rig()
  try {
    // 첫 턴은 앱이 `<스킬 슬래시> <학생글>` 로 보낸다 — 슬래시 명령 자리는 그 하나뿐이고,
    // 그 뒤의 슬래시는 명령 자리가 아니다(실CLI 두 판 실측: 옛 `/knuaf-dev` 뒤 `/code-review` 는
    // 안 먹었다. `/.claude:knuaf-dev` 로 바꾼 뒤 재실측은 없다 — REPORT-U5.md 참고).
    await r.conn.run('/code-review 이 논문 봐 줘', undefined, noopEvents)
    const first = r.prompts().at(-1)!
    expect(first.startsWith(`${SKILL_PROMPT} /code-review 이 논문 봐 줘`)).toBe(true)
  } finally { await r.conn.stop() }
})
