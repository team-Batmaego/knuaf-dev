import { expect, test } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch, openProject, synthProject } from './helpers'

/**
 * 실제 Electron 창에서 재무 알림 말풍선을 끝까지 눌러 본다(2묶음 FIX1 검증).
 *
 * 시험 하나(부품 단위)는 `notice-bubble.spec.ts` 가 잠그지만, 그 시험은 `NoticeStack` 의 `api` 를
 * 갈아 끼우고 `Chat.tsx` 를 통째로 띄우지 않는다. 여기서 보는 것은 **진짜 화면 → 진짜 preload →
 * 진짜 main 핸들러 → 진짜 sidecar(`notices.choose`) → 스텁 도구** 한 줄기다:
 * ① 각주를 고르면 입력칸에 `각주 넣어 줘` 가 **덧붙는다**(쓰던 글 보존)
 * ② 알림 파일이 옛 모양(`choice:null`)으로 남아 있어도 화면이 고른 값을 이긴다(중요5)
 * ③ 선택 뒤 규칙집이 알림 파일을 지우면 카드가 **조용히** 사라진다(실패 문구 없음)
 * ④ X 는 `project_id:notice_identity` 열쇠로 앱 데이터 폴더에 저장된다(중요4)
 *
 * `gg_notices.py` 는 이 체크아웃에 아직 없다(계약만 확정). 규칙집 사본을 임시 폴더로 복사하고
 * 그 `scripts/` 안에 스텁을 넣는다 — `KNUAF_SCRIPTS_DIR` 이 규칙집 뿌리가 되므로(skillSource)
 * 사이드카도 스텁을 찾는다. 스텁의 행동은 논문 폴더의 `.stub-mode` 로 고른다.
 */

const app = resolve(__dirname, '..')
const shots = resolve(app, '..', '..', 'shots')
const PROJECT_ID = 'd29edc18f40887ca323113e98b70f9af3d23b4e7ade89cdf4115ada427f51942'
const IDENTITY = 'a69dd25772be8e49c05e95f472b4e417d6101e0f995d3689fcf63d8f78cd6f11'
const BOX = 'textarea[aria-label="답변을 입력하세요"]'
const TITLE = '학교 재무 양식의 수식 오류 18곳을 바로잡았어요'

/**
 * `gg_notices.py choose <root> --identity <id> --value <v>` 만 흉내 낸다.
 * `keep` = 알림 파일을 손대지 않는다(옛 `choice:null` 이 남는다), `delete` = 규칙집 v0.4.11 처럼 지운다.
 */
const STUB = `import json, sys
from pathlib import Path

argv = sys.argv[1:]
root = Path(argv[1])
identity = argv[argv.index("--identity") + 1]
value = argv[argv.index("--value") + 1]
mode_file = root / ".stub-mode"
mode = mode_file.read_text(encoding="utf-8").strip() if mode_file.exists() else "keep"
notice = root / ".knuaf-notices.json"
if mode == "delete":
    if notice.exists():
        notice.unlink()
print(json.dumps({"status": "chosen", "chosen": value, "identity": identity}))
`

function skillCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knuaf-skill-notice-'))
  cpSync(join(app, 'resources', 'skill'), dir, { recursive: true })
  writeFileSync(join(dir, 'scripts', 'gg_notices.py'), STUB, 'utf-8')
  return dir
}

/** 알림 파일은 규칙집이 쓴다 — 그 모양 그대로 둔다(앱은 읽기만 한다). */
function noticeFile(choice: string | null, extra = 0): string {
  const items = (tag: string) => [
    { key: `${tag}-a`, kind: 'typo', what: '2027년 투자 소계가 한 행을 빼고 더하고 있었어요', where: '투자 소계', current: '1,200,000', basis: '합계 범위가 한 행 짧았어요', how: '합계 범위를 넓혀 주세요', where_detail: '4.투자계획!E24', cells: ['4.투자계획!E24'] },
    { key: `${tag}-b`, kind: 'method', what: '감가상각을 정액법으로 계산하고 있었어요', where: '감가상각', current: '정액법', basis: '사업계획서는 정률법을 적었어요', how: '정률법으로 다시 계산해 주세요', where_detail: '5.손익!C11', cells: ['5.손익!C11'] }
  ]
  const notices = [{
    title: TITLE,
    notice_identity: IDENTITY,
    project_id: PROJECT_ID,
    items: items('invest'),
    choices: [
      { value: 'direct_tell', label: '교수님께 직접 말씀드릴게요' },
      { value: 'footnote', label: '논문에 각주로 적을게요' }
    ],
    choice,
    dismissible: true
  }]
  for (let index = 0; index < extra; index += 1) {
    notices.push({
      ...notices[0],
      title: `매출 원가 계산이 2년치에서 어긋났어요 (${index + 2}번째 알림)`,
      notice_identity: IDENTITY.slice(0, 60) + String(index + 100).padStart(4, '0'),
      items: items(`cost${index}`),
      choices: []
    })
  }
  return JSON.stringify({ schema: 'knuaf.notices/1', written_at: '2026-11-12T00:00:00+00:00', project_id: PROJECT_ID, notices }, null, 2)
}

/**
 * 프로젝트 + 알림 파일 + 스텁 규칙집. `project.json` 에 `project_id` 를 넣는다 —
 * 닫기 기억의 접두 검사(`peekProject`)가 이 값을 읽고, 없으면 X 는 늘 `project_mismatch` 다.
 */
function scene(mode: 'keep' | 'delete', extra = 0): { root: string; skill: string; userData: string } {
  const root = synthProject()
  const projectJson = JSON.parse(readFileSync(join(root, 'project.json'), 'utf-8')) as Record<string, unknown>
  projectJson.project_id = PROJECT_ID
  writeFileSync(join(root, 'project.json'), JSON.stringify(projectJson, null, 2), 'utf-8')
  writeFileSync(join(root, '.knuaf-notices.json'), noticeFile(null, extra), 'utf-8')
  writeFileSync(join(root, '.stub-mode'), mode, 'utf-8')
  return { root, skill: skillCopy(), userData: mkdtempSync(join(tmpdir(), 'knuaf-userdata-notice-')) }
}

async function open(root: string, skill: string, userData: string) {
  const { electronApp, page } = await launch({ userData, env: { KNUAF_SCRIPTS_DIR: join(skill, 'scripts') } })
  await openProject(page, root)
  return { electronApp, page }
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

test('각주를 고르면 쓰던 초안에 문장을 덧붙이고, 옛 choice:null 파일을 이긴다', async () => {
  const { root, skill, userData } = scene('keep')
  const { electronApp, page } = await open(root, skill, userData)
  try {
    const card = page.locator('.notice-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.notice-title')).toHaveText(TITLE)

    // 학생이 쓰던 글 — 각주 문장은 **덮어쓰지 않고** 줄을 바꿔 붙는다.
    await page.locator(BOX).fill('쓰던 글')
    await card.locator('.notice-choice button', { hasText: '논문에 각주로 적을게요' }).click()

    // 저장이 확인되면 선택 단추는 다시 열리지 않고 [각주 넣어 줘] 줄이 선다.
    await expect(card.locator('.notice-foot button')).toHaveText('각주 넣어 줘', { timeout: 30_000 })
    await expect(card.locator('.notice-choice')).toHaveCount(0)
    await expect(card.locator('.notice-failed')).toHaveCount(0)

    // 규칙집은 파일을 안 고쳤다(스텁 `keep`) — 화면의 기억이 옛 `choice:null` 을 이겨야 한다.
    expect(JSON.parse(readFileSync(join(root, '.knuaf-notices.json'), 'utf-8')).notices[0].choice).toBeNull()

    await card.locator('.notice-foot button').click()
    await expect(page.locator(BOX)).toHaveValue('쓰던 글\n각주 넣어 줘')

    await page.screenshot({ path: join(shots, 'notice-real-footnote.png') })
  } finally {
    await electronApp.close()
  }
})

test('선택 뒤 알림 파일이 지워지면 카드가 조용히 사라진다', async () => {
  const { root, skill, userData } = scene('delete')
  const { electronApp, page } = await open(root, skill, userData)
  try {
    const card = page.locator('.notice-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.locator('.notice-choice button', { hasText: '논문에 각주로 적을게요' }).click()
    // 다시 읽기(`reloadKey`)까지 실제 화면에서 돈다 — 파일이 없으면 카드도 없다.
    await expect(page.locator('.notice-card')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.notice-failed')).toHaveCount(0)
    expect(existsSync(join(root, '.knuaf-notices.json'))).toBe(false)
    await page.screenshot({ path: join(shots, 'notice-real-chosen-closed.png') })
  } finally {
    await electronApp.close()
  }
})

test('X 로 닫으면 project_id:notice_identity 열쇠가 앱 데이터 폴더에 남는다', async () => {
  const { root, skill, userData } = scene('keep')
  const { electronApp, page } = await open(root, skill, userData)
  try {
    const card = page.locator('.notice-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(shots, 'notice-real-card.png') })
    await card.locator('.notice-x').click()
    await expect(page.locator('.notice-card')).toHaveCount(0, { timeout: 30_000 })

    const file = join(userData, 'notices-dismissed.json')
    await expect.poll(() => existsSync(file) && readFileSync(file, 'utf-8').includes(`${PROJECT_ID}:${IDENTITY}`), { timeout: 15_000 }).toBe(true)
  } finally {
    await electronApp.close()
  }
})

test('알림 셋을 모두 펼쳐도 입력칸이 창 안에 남고, 닫으면 대화 칸이 되돌아온다', async () => {
  const { root, skill, userData } = scene('keep', 2)
  const { electronApp, page } = await open(root, skill, userData)
  try {
    await expect(page.locator('.notice-card')).toHaveCount(3, { timeout: 30_000 })
    for (const summary of await page.locator('.notice-more > summary').all()) await summary.click()
    await expect(page.locator('.notice-easy').first()).toBeVisible()

    // 카드 셋을 다 펼치면 카드 줄이 자기 상한(`min(50vh,360px)`)에서 **안에서만** 굴러야 한다.
    // 수정 전에는 줄이 832px 로 자라 대화 칸(28px)과 입력칸을 창 밖으로 밀어냈다(1440×900 실측).
    const open = await page.evaluate(() => {
      const box = document.querySelector('.chat-composer')!.getBoundingClientRect()
      const stack = document.querySelector('.notice-stack') as HTMLElement
      const thread = document.querySelector('.chat-thread')!.getBoundingClientRect()
      return { boxBottom: Math.round(box.bottom), inner: window.innerHeight, stackClient: stack.clientHeight,
        stackScroll: stack.scrollHeight, thread: Math.round(thread.height) }
    })
    expect(open.boxBottom).toBeLessThanOrEqual(open.inner)
    expect(open.stackScroll).toBeGreaterThan(open.stackClient)
    expect(open.thread).toBeGreaterThan(0)
    await page.screenshot({ path: join(shots, 'notice-real-stacked-open.png') })

    // 셋을 다 닫으면 줄이 사라지고 대화 칸이 그만큼 돌아온다 — 남은 여백이 아니라 자리다.
    // 카드가 사라지면 열쇠 목록도 줄어든다 — 매번 첫 X 를 다시 잡는다.
    for (let left = 3; left > 0; left -= 1) await page.locator('.notice-x').first().click()
    await expect(page.locator('.notice-card')).toHaveCount(0, { timeout: 15_000 })
    const closed = await page.evaluate(() => Math.round(document.querySelector('.chat-thread')!.getBoundingClientRect().height))
    expect(closed).toBeGreaterThan(open.thread)
  } finally {
    await electronApp.close()
  }
})
