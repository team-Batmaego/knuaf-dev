import React, { useEffect, useRef } from 'react'
import { APP_NAME } from '../../../shared/name'
import art from '../assets/splash-art.png'
import { splashFrame } from './splashTiming'
import './Splash.css'

// Stable positions keep the particles consistent across renders.
const particles = Array.from({ length: 26 }, (_, i) => ({
  left: `${(i * 137.508) % 100}%`, top: `${(i * 73.17) % 100}%`,
  animationDelay: `${-(i * 0.47) % 5}s`, animationDuration: `${4 + (i % 5)}s`
}))

export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const overlay = useRef<HTMLDivElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const readyRef = useRef(ready)
  readyRef.current = ready

  useEffect(() => {
    const start = performance.now()
    const blockClick = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    let readyAt: number | null = readyRef.current ? 0 : null
    let skipped = false
    let fadeAt: number | null = null
    let frame = 0
    const skip = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      skipped = true
    }
    window.addEventListener('pointerdown', skip, true)
    window.addEventListener('keydown', skip, true)
    window.addEventListener('click', blockClick, true)
    const tick = (time: number) => {
      const elapsed = time - start
      if (readyAt === null && readyRef.current) readyAt = elapsed
      const state = splashFrame(elapsed, readyAt, skipped)
      if (fill.current) fill.current.style.transform = `scaleX(${state.progress / 100})`
      if (state.fading && fadeAt === null) {
        fadeAt = time
        overlay.current?.classList.add('splash--fading')
      }
      if (fadeAt !== null && time - fadeAt >= 300) onDone()
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointerdown', skip, true)
      window.removeEventListener('keydown', skip, true)
      window.removeEventListener('click', blockClick, true)
    }
  }, [onDone])

  return <div className="splash" ref={overlay} role="status" aria-label={`${APP_NAME} 여는 중이에요`}>
    <div className="splash__stage">
      <img className="splash__art" src={art} alt="" />
      <div className="splash__rays"><i /></div>
      <div className="splash__particles" aria-hidden="true">{particles.map((style, i) => <i key={i} style={style} />)}</div>
      <div className="splash__copy">
        <div className="splash__name">{APP_NAME}</div>
        <div className="splash__credit">
          <div className="splash__made">만든 사람</div>
          <div className="splash__columns">
            <div><span>특용작물</span><strong>김대욱</strong></div><span>·</span>
            <div><span>산업곤충</span><strong>이준재</strong></div>
          </div>
        </div>
        <div className="splash__track" aria-hidden="true"><div ref={fill} /></div>
        <div className="splash__note">여는 중이에요…</div>
      </div>
    </div>
  </div>
}
