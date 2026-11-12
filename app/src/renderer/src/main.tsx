import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { installScrollingFlag } from './scrolling'
import { imageMissText } from '../../shared/paper-image'

installScrollingFlag()

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
