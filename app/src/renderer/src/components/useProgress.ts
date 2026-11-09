import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import {
  lastValidProgress,
  parseStoredProgress,
  pickProgress,
  type ProgressPick,
  type StoredProgress,
} from '../../../shared/progress-list'

/**
 * 제목줄 진행 값 고르기 훅(IMPL-T1 §3-3).
 *
 * - 스냅샷 root가 지금 논문 root와 다르면 읽지도 저장하지도 않는다.
 * - 저장값은 localStorage `knuaf.progress.v1:<root>` — 앱을 다시 켜도 남는다.
 * - 대화 값이 더 늦을 때만 저장값을 덮는다. 동률이면 messageId·provider가
 *   둘 다 같을 때만 대화 값, 하나라도 다르면 저장값 유지.
 * - 깨진 저장값은 지우고 "시작 전"으로 떨어진다.
 *
 * 순수 부분(`pickProgress`)은 `shared/progress-list.ts` — node 시험으로 잠근다.
 */

const KEY = (root: string): string => `knuaf.progress.v1:${root}`

export interface UseProgressResult {
  /** null이면 "시작 전". */
  pick: ProgressPick | null
}

export function useProgress(): UseProgressResult {
  const root = useProject((s) => s.root)
  const snapshot = useChat(useShallow((s) => ({ snapshot: s.snapshot, provider: s.provider })))

  const snap = snapshot.snapshot
  const provider = snapshot.provider

  // 저장값 읽기.
  let stored: StoredProgress | null = null
  let storedBroken = false
  if (root) {
    let raw: string | null = null
    try {
      raw = window.localStorage.getItem(KEY(root))
    } catch {
      raw = null
    }
    if (raw !== null && raw !== '') {
      stored = parseStoredProgress(raw)
      storedBroken = stored === null
    }
  }

  // 대화 값.
  let conv: ProgressPick | null = null
  if (snap && snap.root && snap.root === root) {
    conv = lastValidProgress(snap.messages, provider)
  }

  const result = pickProgress(conv, stored, snap?.root ?? null, root)

  useEffect(() => {
    // 깨진 저장값은 지운다.
    if (root && storedBroken) {
      try {
        window.localStorage.removeItem(KEY(root))
      } catch {
        /* 무시 */
      }
      return
    }
    // 대화 값이 더 늦을 때만 저장값을 덮는다.
    if (!root) return
    if (result.kind === 'conversation' && snap?.root === root) {
      try {
        window.localStorage.setItem(KEY(root), JSON.stringify(result.pick))
      } catch {
        /* 무시 — 제목줄은 그대로 보인다 */
      }
    }
    // snapshot·root·provider만 본다 — 저장값 글자까지 보면 effect가 되먹는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, snap?.root, provider, result.kind])

  if (result.kind === 'none') return { pick: null }
  return { pick: result.pick }
}
