import { useEffect } from 'react'
import type { ListIntent } from '../store/project'

/** Consume only our own request after the paper header has rendered. */
export function useListIntent(intent: ListIntent | null, kind: ListIntent['kind'], onOpenChange: (open: boolean) => void, consume: (seq: number) => void) {
  useEffect(() => {
    if (!intent || intent.kind !== kind) return
    const frame = requestAnimationFrame(() => { onOpenChange(true); consume(intent.seq) })
    return () => cancelAnimationFrame(frame)
  }, [intent, kind, onOpenChange, consume])
}
