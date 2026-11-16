import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, launch, navTo, openPreset, openProject, python, synthProject } from './helpers'

/**
 * 계약 §7 e2e 42~44 — 바뀐 계산 칸 알림을 **진짜 Electron 창**에서 끝까지 눌러 본다.
 *
 * 부품 시험(`notice-bubble.spec.ts`)은 `api` 를 갈아 끼우고, 통로 시험(`notice-choose-main.spec.ts`)은
 * IPC 만 본다. 여기서 보는 것은 화면 -> preload -> main -> sidecar -> **스텁 규칙집** 한 줄기다:
 * 42 고급 도구의 "검토한 셀 지도대로 비우기" 가 멈춤 카드를 띄우고, 같은 단추를 다시 누르면
 *    확인 1회 -> 같은 인자로 clear 재실행 1회. 확인이 `notice_stale` 이면 재실행 0회.
 * 43 대화 창 말풍선의 확인 단추가 1회 기록되고, 규칙집이 행을 acknowledged 로 바꾸면 단추가 사라진다.
 * 44 `confirm` 없는 행에는 단추가 없고, `relayed_quote` 경로는 `--by` 없이 그 문장만 도구로 간다.
 *
 * 앱에 동봉된 규칙집 핀에는 아직 `gg_notices.py confirm` 이 없다(PR #162 미머지) — `notice-real-screen.spec.ts`
 * 와 같은 방식으로 규칙집 사본을 임시 폴더로 복사하고 `scripts/` 안의 두 도구만 스텁으로 바꾼다.
 * 스텁 판단은 **논문 폴더의 파일**로 고른다(`.stub-ack` = 확인 끝, `.stub-stale` = 오래된 알림).
 *
 * 한계: 44 의 옛 앱 호환(옛 앱이 `confirm` 을 버리고 읽는지)은 지금 앱 화면에서 재현할 수 없다.
 * 그래서 화면 쪽은 "`confirm` 없는 행 -> 단추 없음"만 잠그고, `relayed_quote` 는 앱 화면이 쓰지 않는
 * 통로라 sidecar 를 따로 띄워 확인한다(전달 문장이 있으면 `--by` 가 붙지 않는다).
 */

const PROJECT_ID = 'd29edc18f40887ca323113e98b70f9af3d23b4e7ade89cdf4115ada427f51942'
const IDENTITY = 'a69dd25772be8e49c05e95f472b4e417d6101e0f995d3689fcf63d8f78cd6f11'
const CELL = '3. 투자계획!C8'
const LABEL = '확인했어요, 그대로 만들어 주세요'
const SHOWN = '「재무계획.xlsx」에서 원래 자동으로 계산되던 칸 1곳이 바뀌어 있어요. 이번에는 만들지 않았어요.'
const ACK = '「재무계획.xlsx」의 바뀐 계산 칸 1곳은 확인해 주셨어요.'
// `copy.ts` 의 `FORMULA_HELD.formula_cells_changed` 와 같은 문장 — 화면은 코드가 아니라 이 문장을 보여 준다.
const HELD = '원래 자동으로 계산되던 칸이 바뀌어 있어서 이번에는 만들지 않았어요. 일부러 바꾼 거라면 같은 단추를 한 번 더 눌러 주세요'
// sidecar `NOTICE_REJECT_TEXT.notice_stale` — 거절 사유는 코드가 아니라 이 문장으로 온다.
const STALE = '알림을 본 뒤에 파일이 바뀌었어요. 다시 요청해 주시면 지금 상태로 다시 알려 드릴게요'

/** 도구가 부른 하위 명령·인자를 논문 폴더에 한 줄씩 남긴다 — 시험이 argv 를 글자로 대조한다. */
const NOTICE_STUB = `import json, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(args[1])
with (root / '.stub-calls').open('a', encoding='utf-8') as f:
    f.write(json.dumps(['confirm', *args], ensure_ascii=False) + '\\n')
if (root / '.stub-delay').exists():
    import time
    time.sleep(2)
if (root / '.stub-stale').exists():
    print(json.dumps({'status': 'rejected', 'reason': 'notice_stale'}))
    sys.exit(1)
notice = root / '.knuaf-notices.json'
data = json.loads(notice.read_text(encoding='utf-8'))
data['notices'][0].pop('confirm', None)
data['notices'][0]['title'] = ${JSON.stringify(ACK)}
notice.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
(root / '.stub-ack').write_text('yes', encoding='utf-8')
print(json.dumps({'status': 'acknowledged', 'notice_identity': args[args.index('--identity') + 1]}))
`

/** 42 의 멈춤/성공 — 확인(`.stub-ack`) 전에는 계약 §3 모양 그대로 멈추고, 뒤에는 사본을 만든다. */
const EXCEL_STUB = `import json, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(args[args.index('--project') + 1])
with (root / '.stub-calls').open('a', encoding='utf-8') as f:
    f.write(json.dumps(['clear', *args], ensure_ascii=False) + '\\n')
if not (root / '.stub-ack').exists():
    detail = {'cells': [${JSON.stringify(CELL)}], 'lineage_key': 'file:test', 'notice_identity': ${JSON.stringify(IDENTITY)}, 'guidance': ${JSON.stringify(HELD)}}
    print(json.dumps({'status': 'held', 'reason': 'formula_cells_changed', 'detail': detail, 'guidance': detail['guidance']}, ensure_ascii=False), flush=True)
    if (root / '.stub-stream-delay').exists():
        import time
        (root / '.stub-streaming').write_text('yes', encoding='utf-8')
        time.sleep(2)
    sys.exit(2)
print(json.dumps({'status': 'ok', 'path': args[args.index('--out') + 1]}))
`

type Scene = { root: string; skill: string; userData: string }

/**
 * 프로젝트 + 알림 파일 + 스텁 규칙집. `project.json` 에 `project_id` 를 넣는다 — 닫기 기억의
 * 접두 검사(`peekProject`)와 열쇠(`project_id:notice_identity`)가 이 값을 읽는다.
 */
function scene(confirm = true, stale = false): Scene {
  const root = synthProject()
  const projectPath = join(root, 'project.json')
  const project = JSON.parse(readFileSync(projectPath, 'utf-8'))
  project.project_id = PROJECT_ID
  writeFileSync(projectPath, JSON.stringify(project))
  const row = {
    title: SHOWN,
    notice_identity: IDENTITY,
    project_id: PROJECT_ID,
    dismissible: true,
    items: [{ key: CELL, kind: 'other', what: '자동으로 계산되던 칸이 바뀌었어요', how: '바뀐 칸을 확인해 주세요', cells: [CELL] }],
    ...(confirm ? { confirm: { label: LABEL } } : {})
  }
  writeFileSync(join(root, '.knuaf-notices.json'), JSON.stringify({ schema: 'knuaf.notices/1', written_at: '2026-11-12T00:00:00+00:00', project_id: PROJECT_ID, notices: [row] }))
  if (stale) writeFileSync(join(root, '.stub-stale'), 'yes')
  // 규칙집 뿌리(`KNUAF_SCRIPTS_DIR`)는 `scripts/` 의 부모다 — sidecar 가 gg_core 를 sys.path 에 넣는다.
  const skill = mkdtempSync(join(tmpdir(), 'knuaf-formula-skill-'))
  cpSync(join(app, 'resources', 'skill'), skill, { recursive: true })
  writeFileSync(join(skill, 'scripts', 'gg_notices.py'), NOTICE_STUB)
  writeFileSync(join(skill, 'scripts', 'gg_excel_template.py'), EXCEL_STUB)
  return { root, skill, userData: mkdtempSync(join(tmpdir(), 'knuaf-formula-user-')) }
}

/** 스텁이 남긴 호출 기록 — `[<하위 명령>, <하위 명령>, ...argv]`. */
function calls(root: string): string[][] {
  const path = join(root, '.stub-calls')
  return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line)) : []
}

async function open(s: Scene) {
  const launched = await launch({ userData: s.userData, env: { KNUAF_SCRIPTS_DIR: join(s.skill, 'scripts') } })
  await openProject(launched.page, s.root)
  return launched
}

test.setTimeout(150_000)

for (const stale of [false, true]) {
  test(`42: 고급 도구 확인 ${stale ? '오래된 알림은 재실행하지 않음' : '뒤 같은 인자로 재실행'}`, async () => {
    const s = scene(true, stale)
    const { electronApp, page } = await open(s)
    try {
      await navTo(page, '설정')
      await openPreset(page, 'tools:excel')
      // 원본은 사용자가 고른 파일이라 폴더 밖 절대 경로여도 된다(sidecar `CONFINED` 밖).
      await page.locator('#xl_source').fill(join(s.root, 'input.xlsx'))
      const button = page.getByRole('button', { name: '검토한 셀 지도대로 비우기', exact: true })
      await button.click()
      const held = page.locator('.result-held')
      await expect(held).toContainText(HELD, { timeout: 30_000 })
      await expect(held.locator('.result-cells li')).toHaveText([CELL])
      // 사유 코드는 기계 값이다 — 화면 글자로 새면 안 된다(계약 §8).
      await expect(page.locator('body')).not.toContainText('formula_cells_changed')
      expect(calls(s.root).map((entry) => entry[0])).toEqual(['clear'])

      await button.click()
      if (stale) {
        await expect(page.locator('dialog[open]')).toContainText(STALE, { timeout: 30_000 })
        // 확인이 거절되면 재실행은 0회다 — 같은 단추를 다시 눌러도 사본을 만들지 않는다.
        expect(calls(s.root).map((entry) => entry[0])).toEqual(['clear', 'confirm'])
      } else {
        await expect(page.locator('.result-ok')).toContainText('완료', { timeout: 30_000 })
        const recorded = calls(s.root)
        expect(recorded.map((entry) => entry[0])).toEqual(['clear', 'confirm', 'clear'])
        // 재실행은 **같은 인자**여야 한다 — 확인이 사본 조건을 바꾸지 않는다.
        expect(recorded[2]).toEqual(recorded[0])
      }
      const confirmCall = calls(s.root)[1]
      expect(confirmCall.slice(0, 2)).toEqual(['confirm', 'confirm'])
      expect(confirmCall.slice(-4)).toEqual(['--identity', IDENTITY, '--by', 'app_click'])
    } finally {
      await electronApp.close()
    }
  })
}

test('확인 대기 중 다른 도구는 실행할 수 없다', async () => {
  const s = scene()
  writeFileSync(join(s.root, '.stub-delay'), 'yes')
  const { electronApp, page } = await open(s)
  try {
    await navTo(page, '설정')
    await openPreset(page, 'tools:excel')
    await page.locator('#xl_source').fill(join(s.root, 'input.xlsx'))
    const clear = page.getByRole('button', { name: '검토한 셀 지도대로 비우기', exact: true })
    await clear.click()
    await expect(page.locator('.result-held')).toContainText(HELD, { timeout: 30_000 })
    await clear.click()
    await expect.poll(() => calls(s.root).map((entry) => entry[0])).toEqual(['clear', 'confirm'])
    await expect(page.getByRole('button', { name: '사본 만들기', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '검사', exact: true })).toBeDisabled()
    await expect(page.locator('.result-ok')).toContainText('완료', { timeout: 30_000 })
    expect(calls(s.root).map((entry) => entry[0])).toEqual(['clear', 'confirm', 'clear'])
  } finally { await electronApp.close() }
})

test('도구가 멈춤 출력을 내보낸 뒤 종료 전에도 사유 코드를 숨긴다', async () => {
  const s = scene()
  writeFileSync(join(s.root, '.stub-stream-delay'), 'yes')
  const { electronApp, page } = await open(s)
  try {
    await navTo(page, '설정')
    await openPreset(page, 'tools:excel')
    await page.getByRole('button', { name: '검토한 셀 지도대로 비우기', exact: true }).click()
    await expect.poll(() => existsSync(join(s.root, '.stub-streaming'))).toBe(true)
    await expect(page.locator('.progress[aria-busy="true"]')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('formula_cells_changed')
    await expect(page.locator('.result-held')).toContainText(HELD, { timeout: 30_000 })
  } finally { await electronApp.close() }
})

test('43: 대화 알림을 확인하면 규칙집이 바꾼 행에서 단추가 사라진다', async () => {
  const s = scene()
  const { electronApp, page } = await open(s)
  try {
    const card = page.locator('.notice-card')
    await expect(card).toContainText(SHOWN, { timeout: 30_000 })
    const button = card.locator('.notice-confirm button')
    await expect(button).toHaveText(LABEL)
    await button.click()
    // 스텁이 행을 acknowledged(단추 없음)로 다시 썼다 — 화면이 알림 파일을 다시 읽어야 사라진다.
    await expect(card).toContainText(ACK, { timeout: 30_000 })
    await expect(card.locator('.notice-confirm button')).toHaveCount(0)
    const recorded = calls(s.root)
    expect(recorded.map((entry) => entry[0])).toEqual(['confirm'])
    expect(recorded[0].slice(-4)).toEqual(['--identity', IDENTITY, '--by', 'app_click'])
  } finally {
    await electronApp.close()
  }
})

test('44: 확인 필드 없는 알림과 전달 문장 sidecar 경로', async () => {
  const s = scene(false)
  const { electronApp, page } = await open(s)
  try {
    const card = page.locator('.notice-card')
    // 옛 앱과 같은 모양(confirm 없음) — 알림은 보이지만 누를 단추가 없다.
    await expect(card).toContainText(SHOWN, { timeout: 30_000 })
    await expect(card.locator('.notice-confirm button')).toHaveCount(0)

    // 화면은 `relayed_quote` 를 쓰지 않는다(단추 경로는 늘 app_click) — 그 갈래는 sidecar 를 따로 띄워 본다.
    const request = JSON.stringify({ id: 1, method: 'notices.confirm', params: { root: s.root, identity: IDENTITY, relayed_quote: '그대로 만들어 주세요' } }) + '\n'
    const result = spawnSync(python, ['-m', 'knuaf_sidecar', '--scripts-dir', join(s.skill, 'scripts')], {
      cwd: join(app, 'sidecar'), input: request, encoding: 'utf-8', timeout: 30_000
    })
    expect(result.status, result.stderr).toBe(0)
    const reply = result.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.id === 1 && 'result' in line)
    expect(reply?.result).toMatchObject({ ok: true, status: 'acknowledged' })
    const recorded = calls(s.root)
    expect(recorded.map((entry) => entry[0])).toEqual(['confirm'])
    // 전달 문장이 실리면 `--by` 는 붙지 않는다(둘을 함께 넘기면 confirm_source_invalid).
    expect(recorded[0].slice(-4)).toEqual(['--identity', IDENTITY, '--relayed-quote', '그대로 만들어 주세요'])
  } finally {
    await electronApp.close()
  }
})
