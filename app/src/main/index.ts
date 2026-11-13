import { app, BrowserWindow, nativeImage, nativeTheme, protocol, screen, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Sidecar } from './sidecar'
import { registerIpc } from './ipc'
import { QUIT_FLUSH_DELAYS_MS, type ChatService } from './chat/service'
import { APP_ROOT } from './python'
import { cleanupRuntime } from './runtime'
import { installMenu, type MenuAction } from './menu'
import { LEGACY_USERDATA_NAMES, migrateUserDataDir } from './userdata'
import { APP_NAME } from '../shared/name'
import { IMAGE_SCHEME } from '../shared/paper-image'
import { defaultWindowSize } from '../shared/window'
import { needsReclaim, openHandles, reclaimChildren, shutdownWithin, type ShutdownTask } from './shutdown'
import { codeOf, diag, diagEnabled } from './diagLog'

// Tests point userData at a temp dir so first-run state (credit, recents) is isolated.
if (process.env.KNUAF_USER_DATA) app.setPath('userData', process.env.KNUAF_USER_DATA)
// 표시이름이 바뀌며 생긴 옛 userData 폴더에서 설정을 이어 받는다(userdata.ts).
// 테스트(KNUAF_USER_DATA 지정)에서는 돌리지 않는다.
else migrateUserDataDir(app.getPath('userData'), LEGACY_USERDATA_NAMES.map((n) => join(app.getPath('appData'), n)))

let win: BrowserWindow | null = null
const sidecar = new Sidecar()
let chat: ChatService | null = null
let quitting = false
/**
 * 종료 정리를 기다리는 상한. Playwright 의 시험 상한(90초)과 워커 정리(같은 값) 안에 넉넉히
 * 들어오면서, 진행 중 턴·늦은 사이드카 작업을 기다려 줄 만큼은 길다(관측된 최장 정리: 31초짜리
 * doctor 종료 + 6초 sidecar 마감). 넘기면 `app.exit()` 로 확실히 끝낸다.
 */
const SHUTDOWN_DEADLINE_MS = 10_000
/**
 * 진단(KNUAF_APP_LOG 지정 시에만): 지금 어느 단계에 있는지 한 줄씩 파일에 남긴다.
 * `last` 는 마지막으로 남긴 단계 이름 그대로이고, heartbeat 가 이 값을 다시 적는다 —
 * 종료가 90초를 넘겨도 "어디서 멈췄는지"가 파일에 보이게 하는 장치다(동작 불변).
 */
const diagStart = Date.now()
let lastStage = 'boot'
let quitPasses = 0
const trace = (stage: string, detail: string | (() => string) = ''): void => {
  // 진단이 꺼져 있으면 **아무 일도 하지 않는다**(검토 RT3 권고). `lastStage` 는 heartbeat 만
  // 읽는데 그 타이머도 아래 가드 안에서만 등록되므로, 꺼진 상태에서는 쓸 소비자가 없다.
  // `detail` 을 함수로 넘기면 그 계산(예: 자식 pid 수집)도 꺼진 상태에서 아예 돌지 않는다.
  if (!diagEnabled()) return
  lastStage = stage
  const text = typeof detail === 'function' ? detail() : detail
  diag(`stage=${stage}${text ? ` ${text}` : ''} elapsed=${Date.now() - diagStart}ms uptime=${process.uptime().toFixed(2)}s`)
}
if (diagEnabled()) {
  // 이벤트 루프가 살아 있는 한 5초마다 현재 단계를 남긴다. unref — 이 타이머가 종료를 붙잡지 않는다.
  const beat = setInterval(() => {
    diag(`heartbeat stage=${lastStage} elapsed=${Date.now() - diagStart}ms handles=${openHandles() || '(없음)'}`)
  }, 5_000)
  beat.unref?.()
  trace('boot', `pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node}`)
  app.on('will-quit', () => trace('will-quit', `listeners=${app.listenerCount('will-quit')}`))
  process.on('exit', (code) => trace('process-exit', `code=${code}`))
}
const isMac = process.platform === 'darwin'
// e2e 숨김 실행(`KNUAF_E2E_HIDDEN=1`, `e2e/helpers.ts` 가 기본으로 켠다): 창은 만들고 렌더는
// 유지하되 화면·Dock·⌘Tab·앱 활성화에는 나타나지 않는다. 이 변수가 없으면 앱 동작은 전과 같다.
// 창을 눈으로 봐야 할 때는 `KNUAF_E2E_VISIBLE=1` 로 끈다(`window-shots.spec.ts`).
const hidden = process.env.KNUAF_E2E_HIDDEN === '1' && process.env.KNUAF_E2E_VISIBLE !== '1'
// 정책은 창을 만들기 전, ready 를 기다리지 않고 바꾼다. 다만 이 시점과 '맨 앞 차지' 표본의 인과는
// 확정하지 못했다 — 다른 e2e 가 함께 돌던 실행에서 2/408·35/394표본이 관측됐고, 시점을 module scope 로
// 옮긴 실행에서도 35표본이 있었으며, 다른 e2e 가 멈춘 뒤와 양쪽 숨김 동시 실행에서는 0이었다
// (REPORT-HIDDEN §3·§7). 여기서는 '그 조건에서 그렇게 관측됐다'까지만 적는다.
// 'accessory' 가 아니라 'prohibited' 인 이유는 AppKit 문서 그대로다: accessory 는 "활성화될 수 있고",
// prohibited 는 "활성화될 수 없다". 이 앱은 화면에 뜰 일이 아예 없으므로 둘 중 하나만 맞다.
// (이 분기는 e2e(`KNUAF_E2E_HIDDEN=1`)에서만 켜진다 — 일반 실행의 창·Dock 동작은 그대로다.)
if (hidden && isMac) {
  app.setActivationPolicy('prohibited')
  app.dock?.hide()
}
let pendingOpen: string | null = null

function sendMenu(action: MenuAction): void {
  if (win) win.webContents.send('menu', action)
  else if (action.type === 'open-recent') pendingOpen = action.root
}

app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  version: '',
  credits: `${APP_NAME}\nprod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재\n\n논문은 연결한 AI 도우미가 채팅으로 쓰고, 이 앱은 저장 상태·검사·산출물·복구를 맡습니다.`,
  copyright: 'MIT'
})

// Folders dropped on the Dock icon or opened from Finder.
app.on('open-file', (e, path) => { e.preventDefault(); sendMenu({ type: 'open-recent', root: path }) })

/**
 * 창 바탕·제목줄 덮개 색 — **v5 토큰(tokens.css)과 같은 값**이어야 한다.
 * 옛 초록 시절 값(#f5f5f4/#1c1d1c)이 남아 있어 창 가장자리와 macOS 제목줄에 다른 색 띠가
 * 보였다(REPORT-P1 §6-5). 앱 화면의 `--bg` 와 같게 맞춘다: `--bg` = light #f7f9fc / dark #0e131c,
 * 글자색은 `--ink` = light #0f172a / dark #eef2f7.
 */
function chromeColors() {
  const dark = nativeTheme.shouldUseDarkColors
  return { bg: dark ? '#0e131c' : '#f7f9fc', bar: dark ? '#0e131c' : '#f7f9fc', symbol: dark ? '#eef2f7' : '#0f172a' }
}

function createWindow(): void {
  const reduceTransparency = isMac && systemPreferences.accessibilityDisplayShouldReduceTransparency
  const colors = chromeColors()
  const iconPng = join(APP_ROOT, 'build', 'icon.png')
  // 기본 창은 세 칸을 담되 화면 작업 영역보다 크면 그 안에 맞춰 줄인다.
  const { width, height } = defaultWindowSize(screen.getPrimaryDisplay().workAreaSize)
  win = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: colors.bg,
    show: false,
    // 창을 만들 때부터 숨기므로 렌더가 살아 있어야 한다. 이 값은 webPreferences 가 아니라 생성 옵션
    // 최상위다(Electron 은 최상위 options 에서만 읽는다) — 숨김일 때만 명시하고 기본값에 기대지 않는다.
    ...(hidden ? { paintWhenInitiallyHidden: true } : {}),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 }, ...(reduceTransparency ? {} : { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }) }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: colors.bar, symbolColor: colors.symbol, height: 40 } }),
    ...(!isMac && !app.isPackaged && existsSync(iconPng) ? { icon: iconPng } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      // 숨긴 창에서도 타이머·애니메이션이 멈추지 않게 한다(스크린샷이 시험 대상이다).
      ...(hidden ? { backgroundThrottling: false } : {})
    }
  })
  if (!hidden) win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => { if (pendingOpen) { sendMenu({ type: 'open-recent', root: pendingOpen }); pendingOpen = null } })
  win.on('closed', () => { win = null })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// paper-images (v0.6.4 사진 갈래): 종이 칸 그림은 전용 스킴으로만 읽는다. 렌더러 CSP(`img-src`)와
// `renderMarkdown`이 이 이름을 공유한다(`shared/paper-image.ts`).
// `registerSchemesAsPrivileged`는 app ready **전**에 불러야 한다 — 그래서 whenReady 밖(module scope)이다.
// `standard: true`가 없으면 상대 경로·출처가 없고 CSP `'self'`와도 섞이지 않는다. `supportFetchAPI`는
// Chromium이 `<img>`를 이 스킴으로 요청할 때 필요한 조건이며, `corsEnabled: false`로 두어 다른 출처에서
// 이 스킴을 부를 수 없게 한다(앱 안에서만).
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }
])

const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  app.on('second-instance', () => { if (win && !hidden) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.whenReady().then(() => {
    // 도장 없는(미완성) 런타임 폴더와 남은 임시 다운로드만 지운다 — 게시된 폴더는 건드리지 않는다.
    cleanupRuntime()
    if (isMac && !app.isPackaged && !hidden) {
      const iconPng = join(APP_ROOT, 'build', 'icon.png')
      if (existsSync(iconPng)) app.dock?.setIcon(nativeImage.createFromPath(iconPng))
    }
    const services = registerIpc(sidecar, () => win, () => installMenu(sendMenu))
    chat = services.chat
    // 그림 요청 하나가 들어오면 read → 폴더 안 판정 → 응답. 실패는 404로 닫고, 렌더러가
    // "그림을 찾지 못했어요 · <경로>"로 바꾼다(main.tsx 문서 리스너).
    protocol.handle(IMAGE_SCHEME, (request) => services.images.handle(request))
    installMenu(sendMenu)
    createWindow()
    nativeTheme.on('updated', () => {
      if (!win || isMac) return
      const c = chromeColors()
      win.setTitleBarOverlay?.({ color: c.bar, symbolColor: c.symbol, height: 40 })
    })
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', (e) => {
    quitPasses += 1
    trace(`before-quit#${quitPasses}`, `quitting=${quitting} listeners=${app.listenerCount('before-quit')} defaultPrevented=${e.defaultPrevented}`)
    // Wait for owned sidecar processes as well as agent connections before exiting.
    if (!quitting) {
      // 아직 안 쓴 학생 입력을 먼저 남긴다 — 동기다. **한 번만** 부른다: 예전에는 이 줄이 가드 밖에
      // 있어서 before-quit 이 다시 돌 때마다 같은 쓰기를 반복했고, 그 동기 쓰기가 종료 마감보다
      // 늦게 도는 바람에 `electronApp.close()` 가 안 돌아올 수 있었다(멈춤 후보 1a).
      //
      // **순서를 사실대로 적는다**(검토 RT3 정정): 이 flush 는 아래 `shutdownWithin` 의 10초 마감
      // **타이머보다 앞서** 돈다 — 마감이 이 동기 쓰기를 감싸지 않는다. 그런데도 여기 두는 이유는,
      // 마감 안으로 옮기면 마감을 태운 주체가 우리 정리가 아니라 이 동기 쓰기가 되기 때문이다:
      // 재시도 대기는 **파일 하나당** `QUIT_FLUSH_DELAYS_MS` 합(20+30=50ms)이고, 초안이 N개면 최대
      // 50×N ms + 동기 I/O 가 마감 앞에서 사라진다. 그러면 "정리 마감 10초"가 실제로는 "flush +
      // 10초"가 되어 로그의 숫자가 의미를 잃는다. 지금 배치는 마감을 **정리 몫으로 남기고**, flush
      // 지연은 flush 자신의 줄(`drafts:flush:*`)로 따로 보이게 한다.
      // 한계도 적는다: 그래서 "앱이 10초 안에 닫힌다"고 이 코드만으로는 말할 수 없다 — 상한은
      // flush 비용(초안 수 × 50ms + 동기 쓰기) + 10초 + 회수 1.5초의 합이다.
      trace(`before-quit#${quitPasses}:flush-start`)
      chat?.flushDrafts({ delaysMs: QUIT_FLUSH_DELAYS_MS })
      trace(`before-quit#${quitPasses}:flush-end`)
      quitting = true
      chat?.beginShutdown()
      if (win && !win.isDestroyed()) win.webContents.send('app:quitting')
      e.preventDefault()
      /**
       * 정리에는 **마감**이 있다. 예전에는 이 약속들이 끝나기를 상한 없이 기다려서, 하나라도
       * 안 끝나면(진행 중인 턴·늘어진 사이드카 큐 작업) 창을 닫아도 앱이 안 꺼졌다 — 윈도우 e2e
       * 에서 `electronApp.close()` 가 44초 멈춘 그 자리다.
       *
       * 정리를 **시작하는 함수**를 넘긴다: 마감 타이머가 먼저 걸린다(검토 RT2-02). 실제 경과를
       * 함께 받아 마감보다 길면 그대로 남긴다 — 타이머는 이벤트 루프가 돌아야 하므로, 같은 루프를
       * 막는 일이 있으면 마감은 늦어지고 그 사실이 로그에 숫자로 보여야 한다.
       *
       * `sidecar.stop()` 이 아니라 `stopForExit()` 를 쓴다: 큐 뒤에 줄 서면 실제 종료 실패가
       * `pending` 으로 가려진다(검토 RT2-03).
       */
      /**
       * 회수 대상은 **우리가 아는 pid** 전부다. 사이드카만 모으면 Codex/Claude 엔진 자식은
       * 목록에 없어서 "고아 0"으로 읽힐 수 있다(검토 RT2-03). 범위를 로그에 그대로 적는다.
       */
      const knownPids = (): number[] => [...new Set([...sidecar.ownedPids(), ...(chat?.ownedPids() ?? [])])]
      /**
       * 시험 전용 이음매 — 정리가 마감을 넘기는 상황을 결정적으로 만든다(`KNUAF_E2E_QUIT_STALL=1`).
       * 실제 결함을 재현하려고 앱을 멈추게 하는 대신, 이 스위치가 켜졌을 때만 sidecar 정리를
       * 정착하지 않는 약속으로 바꾼다. 기본값(미설정)에서는 이 줄이 없다 — 동작 불변.
       */
      const stalled = process.env.KNUAF_E2E_QUIT_STALL === '1'
      const task = (name: string, start: () => Promise<unknown>): ShutdownTask => ({
        name,
        start: () => {
          trace(`task:${name}:start`)
          const p = start()
          // 거절 이유는 **코드/이름만** 남긴다 — `String(e)` 는 경로·본문·토큰을 실어 온다(검토 RT3 중요).
          void p.then(() => trace(`task:${name}:done`), (e: unknown) => trace(`task:${name}:reject`, `code=${codeOf(e)}`))
          return p
        }
      })
      trace(`before-quit#${quitPasses}:shutdown-start`, () => `stalled=${stalled} pids=${knownPids().join(',') || '없음'}`)
      void shutdownWithin([
        task('sidecar.stop', () => stalled ? Promise.withResolvers<void>().promise : sidecar.stopForExit()),
        /**
         * 연결 정리가 마감을 넘겼으면 **실패로 승격한다**(검토 RT3 차단). 예전에는 `close()` 가
         * 성공 모양(`void`)을 돌려줘 이 정리가 `done` 으로 집계됐고, 그래서 `needsReclaim=false` —
         * 회수 분기를 건너뛰고 살아 있는 자식을 그냥 두고 나갔다.
         */
        task('chat.close', async () => {
          const result = await (chat?.close() ?? Promise.resolve({ outcome: 'done' as const }))
          if (result.outcome === 'pending') throw new Error(`연결 정리 미완료 pids=${result.pids.join(',') || '없음'}`)
        })
      ], SHUTDOWN_DEADLINE_MS).then(async (outcome) => {
        trace(`before-quit#${quitPasses}:shutdown-outcome`, `done=[${outcome.done.join(', ')}] pending=[${outcome.pending.join(', ')}] failed=[${outcome.failed.map((f) => f.name).join(', ')}] elapsedMs=${outcome.elapsedMs}`)
        for (const failure of outcome.failed) console.error('Shutdown failed:', failure.name, codeOf(failure.reason))
        /**
         * **정착한 실패도 회수 대상이다**(검토 RT2-03). 예전에는 `pending` 이 비었는지만 보고
         * "정리 완료 → app.quit" 으로 갔으므로, sidecar stop 이 실패로 정착해도 회수 시도를
         * 건너뛰었다. 이제 실패가 하나라도 있으면 회수 경로를 탄다.
         */
        const forced = needsReclaim(outcome)
        if (!forced) {
          trace(`branch:quit`, `elapsedMs=${outcome.elapsedMs}`)
          // 정상 종료도 한 줄 남긴다 — 이 줄이 없으면 before-quit 배선/마감이 아예 돌지 않은 것이다.
          console.error(`[shutdown] 정리 완료 ${outcome.elapsedMs}ms (${outcome.done.join(', ') || '없음'})`)
          if (outcome.elapsedMs > SHUTDOWN_DEADLINE_MS) {
            console.error(`[shutdown] 정리가 마감(${SHUTDOWN_DEADLINE_MS}ms)을 넘겨 ${outcome.elapsedMs}ms 걸렸습니다 — 종료 경로에 동기 작업이 있습니다`)
          }
          app.quit()
          return
        }
        if (outcome.pending.length) console.error(`[shutdown] ${SHUTDOWN_DEADLINE_MS}ms 안에 끝나지 않은 정리: ${outcome.pending.join(', ')} (경과 ${outcome.elapsedMs}ms)`)
        /**
         * 강제 종료는 **우리 몫의 정리**에만 쓴다. 다른 청취자가 before-quit 에 걸려 있으면
         * (`listenerCount > 1` — 진단·시험이 종료를 일부러 붙잡는 자리) 그 veto 를 무시하지 않고
         * 종전처럼 `app.quit()` 으로 넘긴다. 그 청취자가 풀지 않으면 그때는 그쪽 계약이다.
         */
        if (app.listenerCount('before-quit') !== 1) {
          trace(`branch:extra-listener`, () => `n=${app.listenerCount('before-quit')} listeners=${app.listeners('before-quit').map((f) => f.name || '(anonymous)').join('|')}`)
          app.quit()
          return
        }
        const pids = knownPids()
        // 아는 자식을 한 번 더 트리째 끝내고, 살아 있는지 **관측**한다. OS 회수를 가정하지 않는다.
        trace(`branch:reclaim`, `pids=${pids.join(',') || '없음'}`)
        const reclaim = await reclaimChildren(pids)
        trace(`branch:reclaim-done`, () => `alive=${reclaim.alive.join(',') || '없음'} unknown=${reclaim.unknown.join(',') || '없음'} handles=${openHandles() || '(없음)'}`)
        console.error(`[shutdown] 남은 핸들: ${openHandles() || '(없음)'}`)
        console.error(`[shutdown] 자식 회수 시도 pid=${reclaim.pids.join(',') || '없음'} 살아있음=${reclaim.alive.join(',') || '없음'} 확인못함=${reclaim.unknown.join(',') || '없음'} (앱이 아는 pid 만 — 손자는 관측 밖)`)
        trace('branch:exit')
        app.exit(0)
      })
    }
  })
}
