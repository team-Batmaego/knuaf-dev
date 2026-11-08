// 회귀 시험 — 논문 폴더 안 Claude 설정 파일로 권한을 넓히는 길을 막았는지.
//
// 실제 앱(빌드 산출물)을 띄우고 **동봉 CLI**(2.1.275)로 확인한다. 학생이 받는 CLI 가
// PATH 의 다른 버전이 아니라 동봉본이기 때문이다(검토 SEC 중요-1).
// 대응 실측: work/knuaf-dev/2026-11-08-v061-settings-security/REPRO-SEC.md (P2·P5·P6·P15·P19)
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { launch, openProject } from './helpers'
import type { ChatSnapshot } from '../src/shared/chat'

test.setTimeout(600_000)

/** 동봉 CLI 자리 — `KNUAF_AGENT_PATH_ONLY=1` 과 함께 PATH 앞에 둔다. */
const BUNDLED = join(
  __dirname, '..', 'node_modules', '.pnpm',
  '@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.275',
  'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'
)

const snap = async (page: Page, root: string): Promise<ChatSnapshot | null> => page.evaluate(async (rt) => {
  const x = await window.knuaf.chat.snapshot(rt, 'claude'); return 'result' in x ? x.result : null
}, root)

const send = async (page: Page, root: string, text: string) => page.evaluate(async ([rt, t]) => {
  return await window.knuaf.chat.send(rt, 'claude', t, crypto.randomUUID())
}, [root, text] as const)

const respond = async (page: Page, root: string, id: string, allow: boolean) => page.evaluate(async ([rt, rid, a]) => {
  return await window.knuaf.chat.respond(rt, 'claude', rid, a)
}, [root, id, allow] as const)

/** '매번 묻기' 상태로 앱을 띄운다. CLI 는 동봉본만 보게 한다. */
async function launchAsk(tag: string) {
  const userData = mkdtempSync(join(tmpdir(), `kd-guard-${tag}-`))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    first_project_permission_asked_at: new Date().toISOString(),
    onboarded_at: new Date().toISOString(),
    provider_choice: { provider: 'claude', at: new Date().toISOString() },
    helper_mode: 'claude-chat',
    permission_mode: 'ask',
    trusted_roots: [],
    show_intro: false
  }), 'utf-8')
  return launch({
    userData,
    env: {
      KNUAF_E2E_VISIBLE: '1',
      KNUAF_CLAUDE_MODEL: 'sonnet',
      KNUAF_AGENT_PATH_ONLY: '1',
      PATH: `${BUNDLED}:${process.env.PATH ?? ''}`
    }
  })
}

async function openReady(page: Page, root: string) {
  await openProject(page, root, undefined, { preparation: 'pending' })
  await page.evaluate(async (rt) => await window.knuaf.depsEnsure(rt), root)
}

type TurnResult = {
  cards: { title: string; detail: string }[]
  notes: string[]
  state: string
  error?: string
  text: string
}

/** 한 턴을 보내고, 카드가 뜨면 기록한 뒤 `decide` 대로 답한다. */
async function turn(page: Page, root: string, text: string, decide: 'deny' | 'allow' = 'deny'): Promise<TurnResult> {
  const cards: { title: string; detail: string }[] = []
  // 앱이 저장·검사 작업 중이면 send 가 거절된다 — 준비가 끝날 때까지 다시 보낸다.
  for (let i = 0; i < 40; i++) {
    const sent = await send(page, root, text)
    if (!sent?.error) break
    if (!JSON.stringify(sent.error).includes('저장·검사 작업 중')) return { cards, notes: [], state: 'send-failed', error: JSON.stringify(sent.error), text: '' }
    await new Promise((r) => setTimeout(r, 1500))
  }
  const deadline = Date.now() + 240_000
  let final: ChatSnapshot | null = null
  const handled = new Set<string>()
  while (Date.now() < deadline) {
    const s = await snap(page, root)
    if (!s) { await new Promise((r) => setTimeout(r, 500)); continue }
    if (s.state === 'permission' && s.permission) {
      cards.push({ title: s.permission.title, detail: s.permission.detail })
      if (!handled.has(s.permission.id)) {
        handled.add(s.permission.id)
        await respond(page, root, s.permission.id, decide === 'allow')
      }
    }
    if (s.state === 'idle' || s.state === 'error' || s.state === 'stopped') { final = s; break }
    await new Promise((r) => setTimeout(r, 700))
  }
  if (!final) final = await snap(page, root)
  const notes = (final?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.text)
  const last = (final?.messages ?? []).filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
  return { cards, notes, state: final?.state ?? 'unknown', error: final?.error, text: last }
}

/** 시험마다 빈 논문 폴더를 만든다(학생 실자료 금지). */
function freshRoot(tag: string): string {
  // realpath 로 고정한다 — macOS 의 `/var` → `/private/var` 링크 때문에 앱의 폴더 경계
  // 판정이 "밖"으로 갈리면 시험이 다른 이유로 카드를 띄운다(실제로 그렇게 갈렸다).
  const root = realpathSync(mkdtempSync(join(tmpdir(), `kd-guard-root-${tag}-`)))
  mkdirSync(join(root, 'sections'), { recursive: true })
  writeFileSync(join(root, 'project.json'), JSON.stringify({ sources: {} }), 'utf-8')
  return root
}

// 모델은 "권한을 넓히는 설정을 써 달라"는 요청을 스스로 거절한다(P12 실측). 그 거절은
// 방어가 아니고(검토 권고-1), 시험 신호로도 쓸 수 없다. 그래서 **같은 코드 경로**를
// 무해한 보호 파일로 확인한다 — 판정 규칙(PROTECTED_DIRS/PROTECTED_FILES)이 같다.
test('권한을 바꾸는 파일 쓰기는 카드로 물어본다 (Write CLAUDE.md)', async () => {
  const root = freshRoot('write')
  const target = join(root, 'CLAUDE.md')
  const { electronApp, page } = await launchAsk('write')
  try {
    await openReady(page, root)
    const r = await turn(page, root, `knuaf-dev 스킬 작업은 잠시 멈춰 주세요. 이 논문 폴더의 작업 메모를 ${target} 파일로 남겨 주세요. 내용은 "# 작업 메모" 한 줄이면 됩니다. 만들었으면 한 줄로 알려 주세요.`)
    console.log('GUARD write:', JSON.stringify(r))
    expect(r.cards.length, 'CLAUDE.md 쓰기에 카드가 떠야 한다').toBeGreaterThan(0)
    expect(r.cards[0].title).toBe('도우미의 권한을 바꾸는 파일이에요')
    expect(existsSync(target), '거절했으므로 파일이 없어야 한다').toBe(false)
  } finally { await electronApp.close() }
})

// 수정 전에는 `tee`·`touch`·`cp`·`mkdir` 으로 보호 경로에 쓰는 것이 **자동 허용**이었다
// (단위 실측: `tee .claude/settings.local.json` → true). 그래서 셸 경로도 시험한다.
// 명령은 도우미가 의미상 거절할 이유가 없는 것(폴더 만들기)을 고른다 — 모델 거절은
// 방어가 아니라 시험 신호로도 쓸 수 없다(검토 권고-1, P12 실측).
test('셸로 권한 폴더에 쓰는 길도 카드로 물어본다 (mkdir)', async () => {
  const root = freshRoot('bash')
  const target = join(root, '.claude', 'agents')
  const { electronApp, page } = await launchAsk('bash')
  try {
    await openReady(page, root)
    const r = await turn(page, root, `knuaf-dev 스킬 작업은 잠시 멈춰 주세요. 지시한 셸 명령 하나만 Bash 도구로 그대로 실행해 주세요: mkdir -p "${target}"`)
    console.log('GUARD bash:', JSON.stringify(r))
    expect(r.cards.length, '셸로 권한 폴더에 쓰는 길도 카드로 가야 한다').toBeGreaterThan(0)
    expect(r.cards[0].title).toBe('도우미의 권한을 바꾸는 파일이에요')
    expect(existsSync(target), '거절했으므로 폴더가 없어야 한다').toBe(false)
  } finally { await electronApp.close() }
})

test('이미 있던 local 허락 규칙은 더 이상 카드를 끄지 못한다', async () => {
  // 재현 P2 의 조건 그대로: `.claude/settings.local.json` 에 `Bash(*)` 허용.
  // 수정 전: CLI 가 이 규칙을 canUseTool 앞에서 적용해 **카드 0건 + 실행됨**(P2 실측).
  // 수정 뒤: settingSources 에서 local 을 뺐으므로 앱 판정만 남고, 앱이 막는 명령은 카드로 간다.
  //
  // 명령은 **폴더 안**의 파이썬 파일을 고른다. 폴더 안·경로 인자만 보면 앱의 autoAllow 가
  // 통과시키는 모양이지만 인터프리터 실행이라 앱은 막는다 — 그래서 "허락 규칙이 카드를
  // 껐는가"만 차이로 남는다. 폴더 밖 경로를 쓰면 폴더 경계 판정이 먼저 걸려 시험이 흐려진다.
  const root = freshRoot('existing')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(*)'] } }, null, 2), 'utf-8')
  writeFileSync(join(root, 'probe.py'), 'open("probe-ran.txt", "w").write("ran")\n', 'utf-8')
  const { electronApp, page } = await launchAsk('existing')
  try {
    await openReady(page, root)
    const r = await turn(page, root, `knuaf-dev 스킬 작업은 잠시 멈춰 주세요. 지시한 셸 명령 하나만 Bash 도구로 그대로 실행하고, 결과를 한 줄로 알려 주세요: python3 probe.py`)
    console.log('GUARD existing:', JSON.stringify(r))
    expect(r.cards.length, '허락 규칙이 있어도 카드가 떠야 한다').toBeGreaterThan(0)
    expect(existsSync(join(root, 'probe-ran.txt')), '거절했으므로 실행되지 않아야 한다').toBe(false)
    // 그리고 그 사실을 학생에게 알린다(앱이 만든 것이 아닌 설정).
    expect(r.notes.join('\n')).toContain('권한을 바꾸는 설정')
  } finally { await electronApp.close() }
})

/**
 * "논문 쓰기는 그대로 묻지 않는다"는 여기서 재지 않는다.
 *
 * 실제 앱으로 재 보면 모델이 그 턴에 Write 를 부르지 않고 되묻는 경우가 있어(정본 등록
 * 절차 안내 등) "카드 0건 + 파일 생성"이 모델 상태에 좌우된다. 그 성질은 앱 판정의
 * 문제이므로 `e2e/chat.spec.ts` 의 autoAllow 단위 시험이 결정적으로 고정한다:
 * `작업폴더 안의 파일 작업은 묻지 않는다` + `도우미의 권한을 바꾸는 파일은 폴더 안이어도 묻는다`
 * 안의 "논문 쓰기 자체는 그대로 묻지 않는다".
 */
