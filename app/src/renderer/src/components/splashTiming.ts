// Times are milliseconds since the splash mounted. Readiness is observed, not predicted.
export function splashFrame(now: number, readyAt: number | null, skipped: boolean): { progress: number; fading: boolean } {
  const base = 90 * Math.min(Math.max(now / 4400, 0), 1)
  if (readyAt === null) return { progress: base, fading: false }
  if (skipped) return { progress: 100, fading: true }
  const finishStart = Math.max(4400, readyAt)
  const progress = now < finishStart ? base : 90 + 10 * Math.min((now - finishStart) / 600, 1)
  return { progress, fading: now >= finishStart + 600 }
}
