import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { installScrollingFlag } from './scrolling'
import { imageMissText } from '../../shared/paper-image'
import { useProject } from './store/project'

installScrollingFlag()

// 시험 통로(e2e 전용) - 지금 창의 렌더러 store 가 실제로 들고 있는 **폴더와 개정**을 읽는다.
// `KNUAF_E2E_TEST_HOOKS=1` 로 띄운 실행에서만 preload 가 `testHooks: true` 를 주고
// (`src/preload/index.ts`), 제품 실행은 그 환경값이 없으므로 `testHooks` 가 거짓이라 이 블록이
// 창에 아무것도 붙이지 않는다. 게이트는 **환경값 하나**이고 `app.isPackaged` 는 보지 않는다 -
// 기존 lanes 시험 통로(`store/lanes.ts`)와 같은 게이트·같은 검사 범위다. 그래서 출시판이라도
// 사용자가 그 환경값을 켜면 이 getter 가 열린다: 통로가 내는 것은 이미 렌더러가 들고 있는
// 값의 **읽기 전용 사본**뿐이라(쓰기·구독·함수 없음) 새는 권한이 없다.
//
// getter 하나뿐이다 - 부르는 쪽은 매번 새 값을 받으므로, 응답이 늦게 반영돼도 "지금 store 가
// 무엇을 보고 있는가"를 그대로 잰다. 시험은 저장 직전 이 값을 읽어 렌더러가 외부 변경 개정을
// 실제로 관측했는지 확인한다(`e2e/viewer-edit.spec.ts`).
if (window.knuaf?.testHooks === true && !Object.prototype.hasOwnProperty.call(window, '__knuafProjectProbe')) {
  Object.defineProperty(window, '__knuafProjectProbe', {
    // 한 번만 선다 — 개발 모드에서 이 진입점이 다시 평가돼도 죽지 않고(이미 있으면 건너뛴다),
    // 한 번 선 뒤에는 다시 정의되지 않는다. 값이 아니라 `getState()` 를 부르므로 늘 지금 것이다.
    configurable: false,
    enumerable: false,
    get: () => {
      const { root, status } = useProject.getState()
      return { root: root ?? null, revision: status?.revision ?? null }
    }
  })
}

// 종이 칸 그림이 실패하면 "그림을 찾지 못했어요 · <경로>" 짧은 회색 한 줄로 바꾼다
// (발주 추가, 형님 ts 1794469330). 상자·아이콘·색 없음.
//
// `error`는 bubbles가 false라 문서 레벨 **capture**에서만 잡힌다. 우리 스킴 주소만 대상으로 하고,
// 요소를 `<span>`으로 갈아 끼우므로 같은 요소가 다시 실패할 일은 없다. `textContent`로 넣는다 —
// 경로에 `<`가 있어도 그대로 글자다.
document.addEventListener(
  'error',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLImageElement)) return
    const miss = imageMissText(target.getAttribute('src') ?? '', target.alt)
    if (miss === null) return
    const span = document.createElement('span')
    span.className = 'paper-img-miss'
    span.textContent = miss
    target.replaceWith(span)
  },
  true
)

const k = (window as unknown as { knuaf?: { platform?: string; windowInfo?: () => Promise<{ vibrancy: boolean }> } }).knuaf
document.documentElement.dataset.platform = k?.platform ?? 'darwin'
document.documentElement.dataset.vibrancy = 'off'
void k?.windowInfo?.().then((info) => { document.documentElement.dataset.vibrancy = info?.vibrancy ? 'on' : 'off' })

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
