// **설치본**(dmg → /Applications) 전용 시험.
//
// 개발 빌드 e2e(`app/e2e`)와 일부러 따로 둔다. 여기서만 참이어야 하는 것은 "저장소 체크아웃이
// 아니라 **번들 안의 리소스**로 돈다"는 사실이다 — 동봉 python, 동봉 스킬 스크립트, 동봉
// 사이드카, 오프라인 휠, 첫 실행, userData 자리, 창이 뜨는지.
//
// 여기서 **다루지 않는 것**(형님 맥 몫, 발주 ①):
//   진짜 ChatGPT/Claude 로그인 · 진짜 AI 답변 · Word/Excel 자동화 · 한글 입력 · Gatekeeper 경고.
//   CI 러너가 내려받은 적 없는 dmg 를 풀어 쓰므로 격리 표시(com.apple.quarantine)가 없고,
//   그래서 Gatekeeper 는 이 자리에서 재현되지 않는다.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { bundle, bundledProject, launchInstalled, readSplashRecord, seededUserData } from './launch-installed'
import { openProject, paperReady } from '../e2e/helpers'
import { APP_NAME } from '../src/shared/name'


/** 이 저장소의 앱 버전 — 설치본이 낡은 빌드면 여기서 갈린다. */
function repoVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
  if (!pkg || typeof pkg !== 'object' || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error('package.json 에서 version 을 읽지 못했다')
  }
  return pkg.version
}

test('처음 켜면 대화 입력칸이 뜨고, 동봉 리소스가 앱 안에 있다', async () => {
  const b = bundle()
  // userData 를 넘기지 않는다 — 학생의 첫 실행과 같은 자리(앱이 스스로 고르는 폴더)를 본다.
  const { electronApp, page } = await launchInstalled({ userData: null })
  try {
    const info = await page.evaluate(() => window.knuaf.appInfo())
    // ① 설치본으로 돌고 있다(개발 트리 `out/main/index.js` 가 아니다).
    expect(info.packaged).toBe(true)
    expect(info.version).toBe(repoVersion())
    // ② 첫 실행의 userData 자리는 표시이름(productName) 폴더다 — 여기가 어긋나면 학생의
    //    설정·최근 폴더가 매번 새로 시작한다.
    expect(info.userData).toBe(join(homedir(), 'Library', 'Application Support', 'knuaf-dev'))
    // ③ 첫 실행부터 단계 화면 없이 대화 입력칸과 모델 칩을 쓸 수 있다.
    await expect(page.getByRole('heading', { name: '어떤 논문을 쓰고 있어요?' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('textbox', { name: '답변을 입력하세요' })).toBeVisible()
    await expect(page.getByTitle('이 논문의 도우미')).toBeVisible()
    // ④ 창이 떴다(숨김 실행이어도 창 객체와 렌더는 살아 있다).
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    // ⑤ 번들 리소스 — 설치본이 읽는 자리 그대로(`python.ts`·`runtime.ts` 의 packaged 분기).
    for (const p of [
      b.python,
      join(b.scripts, 'gg.py'),
      join(b.scripts, 'gg_core.py'),
      join(b.scripts, 'build_docx.py'),
      join(b.scripts, 'requirements-runtime.txt'),
      join(b.sidecar, 'knuaf_sidecar', '__main__.py'),
      join(b.docs, 'student-guide.pdf'),
      join(b.docs, 'student-guide.html')
    ]) expect(existsSync(p), `번들에 없다: ${p}`).toBe(true)
    // 동봉 python 은 **실행되는 바이너리**여야 한다(파일 존재만으로는 부족하다).
    expect(execFileSync(b.python, ['-V'], { encoding: 'utf-8' }).trim()).toMatch(/^Python 3\.\d+/)
    expect(statSync(b.python).mode & 0o111, '동봉 python 에 실행 권한이 없다').not.toBe(0)

    // ⑥ 오프라인 휠 — 러너가 인터넷 없이도 프로젝트 venv 를 만들 수 있어야 한다.
    const wheels = readdirSync(b.wheelhouse).filter((f) => f.endsWith('.whl'))
    for (const dist of ['openpyxl', 'python_docx', 'pypdf']) {
      expect(wheels.some((w) => w.startsWith(dist)), `${dist} 휠이 없다: ${wheels.join(', ')}`).toBe(true)
    }

    // ⑦ 실행기 선택이 **번들**로 떨어진다 — 개발 트리 경로가 아니라 앱 안의 python·스킬.
    const sc = await page.evaluate(() => window.knuaf.sidecarInfo())
    expect(sc.basePython).toBe(b.python)
    expect(sc.wheelhouse).toBe(b.wheelhouse)
    expect(sc.scriptsDir).toBe(b.scripts)
  } finally {
    await electronApp.close()
  }
})

test('동봉 python·스킬로 폴더를 열면 사이드카가 붙고 종이가 뜬다', async () => {
  const b = bundle()
  // 폴더도 **동봉 python + 동봉 gg.py** 로 만든다 — 저장소의 .venv-dev 를 쓰지 않는다.
  const root = bundledProject()
  // 관측은 **띄우는 순간부터** 돈다 — 시작 화면이 붙어 있는 동안의 새 소식 창과 분리 시각을 본다.
  const { electronApp, page } = await launchInstalled({ userData: seededUserData(), recordSplash: true })
  try {
    // 이 시험이 개발 트리 우회로 도는 게 아님을 먼저 못 박는다.
    expect(await electronApp.evaluate(() => process.env.KNUAF_PYTHON ?? null)).toBeNull()
    expect(await electronApp.evaluate(() => process.env.KNUAF_SCRIPTS_DIR ?? null)).toBeNull()

    // 이 userData 는 '앱을 쓰던 학생, 새 소식 확인 기록 없음'이다 — 큰 판 글이 동봉돼 있으면
    // 새 소식 창이 한 번 뜨는 게 의도다(A1). 뜨면 동봉 판 글로 떴는지 보고 '확인했어요'로 닫는다.
    // 뜨지 않는 판(작은 판만 있는 경우)도 그대로 통과한다.
    //
    // 순서를 지키는 시험이다(PR #160 재판정 ③): 시작 화면이 **붙어 있는 동안** 열린 새 소식 창이
    // 0개여야 하고, 그 화면이 **분리된 뒤** 학생 조작 없이 창이 저절로 떠야 한다. 앱은 시작 화면이
    // 떠 있는 동안 창을 마운트하지 않으므로(`App.tsx` 의 `canShowNewsDialog={!splashVisible}`)
    // 분리를 유한 시간(30초) 기다린다 — 멈추면 여기서 실패한다. 이 기다림만으로는 패치 전 앱도
    // (늦게 클릭해서) 통과할 수 있으므로, 관측은 클릭 **전에** 한다. 관측은 창이 뜬 순간부터
    // 이미 돌고 있다(`launchInstalled({ recordSplash: true })`): `.titlebar` 대기가 10초를 넘는 느린
    // 러너에서는 시작 화면이 그 사이에 끝나므로, 여기서 걸면 "붙어 있는 동안" 구간을 통째로 못 본다.
    const splash = await readSplashRecord(page)
    // 분리를 못 봤으면 관측 자체가 성립하지 않는다 — 조용히 건너뛰지 않고 이 단계에서 실패한다.
    // 관측이 늦은 경우(붙어 있는 표본 0)를 먼저 말한다: 그때 `detached` 가 거짓인 것은 앱 결함이 아니다.
    expect(splash.attached, '시작 화면이 붙어 있는 표본을 한 번도 못 봤다 — 관측이 시작 화면보다 늦었다').toBeGreaterThan(0)
    expect(splash.detached, `관측 시작 후 ${splash.waited}ms 동안 시작 화면(.splash)이 DOM 에서 분리되지 않았다`).toBe(true)
    expect(splash.early, '시작 화면이 붙어 있는 동안 새 소식 창이 열려 있었다 — 패치 전 앱과 같은 겹침').toBe(0)

    const news = await page.evaluate(() => window.knuaf.news.state())
    // 판정서 ④ 판독용 표지: 이 실행이 창 케이스(아래 if)를 실제로 탔는지 대체 분기를 탔는지 보고서·trace에 남긴다.
    // 단언은 바꾸지 않는다 — 분기 선택은 동봉 판 글에 달렸고, 대체 분기도 기존대로 통과한다.
    test.info().annotations.push({ type: 'news-mode', description: `mode=${news.mode} unread=${news.unread.length}` })
    const newsDialog = page.locator('dialog.news-dialog[open]')
    if (news.mode === 'dialog') {
      expect(news.unread.length, '창을 띄운 새 소식이 비어 있다').toBeGreaterThan(0)
      // 시작 화면이 분리된 뒤 **학생 조작 없이** 자동으로 떠야 한다(기본 5초 상한은 그대로 둔다).
      await expect(newsDialog, '시작 화면이 사라진 뒤 새 소식 창이 저절로 뜨지 않았다').toBeVisible()
      // 클릭과 닫힘을 단계로 갈라 둔다: 클릭 단계가 통과하고 닫힘 단계가 실패하면, 버튼 핸들러에는
      // 닿았는데 `news:seen` 저장이 실패한 것이다(창은 `failed` 문구를 띄운 채 열린 채로 남는다).
      await test.step('확인했어요 한 번 클릭', async () => {
        await newsDialog.getByRole('button', { name: '확인했어요' }).click()
      })
      await test.step('열린 새 소식 창 0개', async () => {
        try {
          await expect(newsDialog).toHaveCount(0)
        } catch (error) {
          // ④ 판독용 — 여기서 다시 실패하면 두 원인을 가른다: 버튼 핸들러에 안 닿았다(`news:seen` 전이라
          // 상태가 여전히 `dialog`, 단추도 다시 눌린 상태) / 저장이 실패했다(창이 `failed` 문구를 띄운 채 남는다).
          // 단언은 그대로 실패한다 — 관측만 덧붙인다.
          const after = await page.evaluate(async () => {
            const state = await window.knuaf.news.state().catch(() => null)
            return {
              mode: state?.mode ?? '조회 실패',
              unread: state?.unread.length ?? -1,
              alert: [...document.querySelectorAll('dialog.news-dialog [role="alert"]')].map((el) => el.textContent ?? ''),
              disabled: [...document.querySelectorAll<HTMLButtonElement>('dialog.news-dialog .sheet-foot button')].map((el) => el.disabled)
            }
          }).catch(() => null)
          console.error(`[닫힘 실패 진단] ${JSON.stringify(after)}`)
          throw error
        }
      })
    } else {
      await expect(newsDialog).toHaveCount(0)
    }

    // 동봉 실행기 선택을 보므로 개발용 .venv seed와 준비 완료 대기를 제외한다.
    await openProject(page, root, (p) => paperReady(p, '600평'), { preparation: 'pending' })

    const sc = await page.evaluate(() => window.knuaf.sidecarInfo())
    expect(sc.running, '사이드카가 떠 있지 않다').toBe(true)
    expect(sc.kind, '동봉 python 이 아니라 다른 실행기를 골랐다').toBe('bundled')
    expect(sc.python).toBe(b.python)
    expect(sc.scriptsDir).toBe(b.scripts)

    // 창 제목이 열린 폴더 이름을 단다 — 설치본에서도 main 이 같은 경로를 탄다.
    // (`page.title()` 이 아니라 창 제목을 본다: 문서 제목은 `index.html` 의 정적 값이라
    //  main 이 세우는 창 제목과 다른 출처다.)
    const title = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    expect(title).toBe(`${basename(root)} — ${APP_NAME}`)
  } finally {
    await electronApp.close()
  }
})
