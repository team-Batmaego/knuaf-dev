import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import {
  lastValidProgress,
  parseStoredProgress,
  progressSignature,
  type ProgressPick,
  type StoredProgress,
} from '../../../shared/progress-list'
import { chooseProgress, type ProgressFile } from '../../../shared/progress-file'

/**
 * 제목줄 진행 값 고르기 훅(IMPL-T1 §3-3 · §4-2).
 *
 * - **진행 파일이 정본**(§4-2 중요 7): 유효한 `.knuaf-progress.json`이 있으면 그것을 그리고,
 *   없거나 무효일 때만 1단계대로 대화 파서 값 → 저장값으로 떨어진다. 시각 비교는 하지 않는다.
 * - 파일 내용은 main이 읽어 push한다(`progress:get`·`progress:changed`). 렌더러는 경로를 모른다.
 * - 감시가 안 되는 폴더(네트워크 드라이브 등) 보루: 대화가 `running → idle`로 바뀔 때마다
 *   `progress:get`을 한 번 더 부른다(최종 답 직후).
 * - 스냅샷 root가 지금 논문 root와 다르면 읽지도 저장하지도 않는다.
 * - 저장값은 localStorage `knuaf.progress.v1:<root>` — 앱을 다시 켜도 남는다.
 *   **파일 값은 저장하지 않는다**(파일이 정본이라 저장할 이유가 없다).
 * - 대화 값이 더 늦을 때만 저장값을 덮는다. 동률이면 messageId·provider가
 *   둘 다 같을 때만 대화 값, 하나라도 다르면 저장값 유지.
 * - 깨진 저장값은 지우고 "시작 전"으로 떨어진다.
 *
 * 순수 부분(`chooseProgress`·`pickProgress`)은 `shared/` — node 시험으로 잠근다.
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

  // progress (v0.6.4 2단계): main이 읽어 준 진행 파일. 논문이 바뀌면 즉시 버린다.
  const [file, setFile] = useState<ProgressFile | null>(null)
  useEffect(() => {
    setFile(null)
    if (!root) return undefined
    let live = true
    const load = (): void => {
      void window.knuaf.progress
        .get()
        .then((reply) => {
          // 응답이 늦게 와도 그사이 논문이 바뀌었으면 버린다.
          if (live) setFile('result' in reply ? reply.result : null)
        })
        .catch(() => {
          /* 읽기 실패 = 파일 없음과 같이 다룬다(파서 → 저장값) */
        })
    }
    load()
    const off = window.knuaf.progress.onChanged((payload) => {
      // 다른 논문의 늦은 push는 버린다.
      if (live && payload.root === root) setFile(payload.progress)
    })
    return () => {
      live = false
      off()
    }
  }, [root])

  // 감시를 못 믿는 폴더 보루 — 대화가 끝난 순간 한 번 더 읽는다.
  const prevState = useRef<string | null>(null)
  useEffect(() => {
    const now = snap && snap.root === root ? snap.state : null
    const before = prevState.current
    prevState.current = now
    if (before === 'running' && now === 'idle' && root) {
      void window.knuaf.progress
        .get()
        .then((reply) => setFile('result' in reply ? reply.result : null))
        .catch(() => {
          /* 무시 — 마지막 값 유지 */
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.state, snap?.root, root])

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

  // 파일 → 대화 파서 → 저장값.
  const result = chooseProgress(file, provider, conv, stored, snap?.root ?? null, root)
  // 저장 여부는 고른 진행값 자체(단계 상태 서명)와 선택된 답의 ID·시각을 **합쳐** 판단한다.
  // (Roh fix2 [중요] — valueSig 단독은 "같은 진행 내용의 새 답(새 id·20:02)"에서 저장 시각이
  //  머물러(Codex 20:01) 후퇴했다. id·at 단독은 "같은 id 텍스트 갱신 1→4"에서 저장이 안 됐다.)
  const valueSig = progressSignature(result.kind === 'none' ? null : result.pick)
  const convKey = conv ? `${conv.messageId}|${conv.at}|${provider}` : null

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
    // 대화 값이 더 늦을 때만 저장값을 덮는다. 파일 값은 저장하지 않는다(파일이 정본).
    if (!root) return
    if (result.kind === 'conversation' && snap?.root === root) {
      try {
        window.localStorage.setItem(KEY(root), JSON.stringify(result.pick))
      } catch {
        /* 무시 — 제목줄은 그대로 보인다 */
      }
    }
    // valueSig(진행값 자체) + convKey(id·at·provider) — 둘 다 deps다. 한쪽이라도 바뀌면 심각해진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, snap?.root, provider, result.kind, valueSig, convKey])

  if (result.kind === 'none') return { pick: null }
  return { pick: result.pick }
}
