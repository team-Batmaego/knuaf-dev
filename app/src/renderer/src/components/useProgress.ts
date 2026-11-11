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
 *   둘 다 같고 **단계 상태 서명도 바뀌었을 때만** 대화 값, 그 밖에는 저장값 유지
 *   (같은 답이 같은 시각으로 1→4단계로 자라나는 스트리밍 갱신을 놓치지 않는다).
 * - 깨진 저장값은 지우고 "시작 전"으로 떨어진다.
 *
 * 순수 부분(`chooseProgress`·`pickProgress`)은 `shared/` — node 시험으로 잠근다.
 * 파일 읽기 순서는 아래 `createProgressFeed`(DOM 없는 객체) — 늦은 응답 시험도 여기서 돈다.
 */

const KEY = (root: string): string => `knuaf.progress.v1:${root}`

export interface UseProgressResult {
  /** null이면 "시작 전". */
  pick: ProgressPick | null
}

/** main이 렌더러에 주는 진행 파일 조회·구독(가짜 대역을 시험이 넣는다). */
export interface ProgressIo {
  get: () => Promise<{ result: ProgressFile | null }>
  onChanged: (fn: (payload: { root: string; progress: ProgressFile | null }) => void) => () => void
}

export interface ProgressFeed {
  /** 논문 전환. 이전 요청·구독을 버리고 `null`에서 시작해 새로 읽는다. `null`이면 구독하지 않는다. */
  setRoot: (root: string | null) => void
  /** 대화가 `running → idle`로 바뀐 순간 한 번 더 읽는다(감시 보루). 논문이 없으면 아무것도 안 한다. */
  reread: () => void
  dispose: () => void
}

/**
 * 진행 파일 읽기 순서 — 훅에서 분리한 이유는 **늦은 응답 시험** 때문이다(Roh 1회째 [중요]).
 *
 * `progress:get`은 비동기라 **보낸 뒤 논문이 바뀔 수 있다**. A의 늦은 응답이 이미 B로 바뀐
 * 화면에 A 값(6/7)을 덮어 B 2/7이 사라졌다. 그래서 매 요청·push에 그때의 세대를 찍고,
 * 응답할 때 세대가 다르면 버린다. root 문자열 비교만으로는 A → B → A로 되돌아온 경우를 못 가른다.
 */
export function createProgressFeed(io: ProgressIo, onFile: (file: ProgressFile | null) => void): ProgressFeed {
  /** 지금 논문 세대 — `setRoot`마다 하나 올린다. */
  let generation = 0
  let root: string | null = null
  let off: (() => void) | null = null
  let disposed = false

  const load = (): void => {
    const asked = generation
    void io
      .get()
      .then((reply) => {
        // 응답이 늦게 와도 그사이 논문이 바뀌었으면 버린다.
        if (!disposed && asked === generation) onFile('result' in reply ? reply.result : null)
      })
      .catch(() => {
        /* 읽기 실패 = 파일 없음과 같이 다룬다(파서 → 저장값) */
      })
  }

  return {
    setRoot: (next) => {
      if (next === root && off !== null) return
      off?.()
      off = null
      // 다시 마운트(개발 모드 StrictMode가 effect를 두 번 건다)하면 dispose 뒤에도 살아나야 한다.
      disposed = false
      generation += 1
      root = next
      onFile(null)
      if (next === null) return
      load()
      off = io.onChanged((payload) => {
        // 다른 논문의 push는 버린다. A → B → A로 되돌아온 뒤 도착하는 **옛 감시**의 이벤트는
        // main이 보내기 전에 이미 버린다(감시 세대, `main/progress/index.ts`). 렌더러가 main의
        // 세대 번호를 알 수 없으므로 여기서 흉내 내지 않는다 — 구독은 논문 전환 때 교체된다.
        if (disposed) return
        if (payload.root === root) onFile(payload.progress)
      })
    },
    reread: () => {
      if (disposed || root === null) return
      load()
    },
    dispose: () => {
      disposed = true
      off?.()
      off = null
      root = null
    }
  }
}

export function useProgress(): UseProgressResult {
  const root = useProject((s) => s.root)
  const snapshot = useChat(useShallow((s) => ({ snapshot: s.snapshot, provider: s.provider })))

  const snap = snapshot.snapshot
  const provider = snapshot.provider

  // progress (v0.6.4 2단계): main이 읽어 준 진행 파일. 논문이 바뀌면 즉시 버린다.
  const [file, setFile] = useState<ProgressFile | null>(null)
  const feedRef = useRef<ProgressFeed | null>(null)
  if (feedRef.current === null) {
    feedRef.current = createProgressFeed(
      { get: () => window.knuaf.progress.get(), onChanged: (fn) => window.knuaf.progress.onChanged(fn) },
      setFile,
    )
  }
  const feed = feedRef.current

  useEffect(() => {
    feed.setRoot(root)
  }, [feed, root])

  useEffect(() => () => feed.dispose(), [feed])

  // 감시를 못 믿는 폴더 보루 — 대화가 끝난 순간 한 번 더 읽는다.
  const prevState = useRef<string | null>(null)
  useEffect(() => {
    const now = snap && snap.root === root ? snap.state : null
    const before = prevState.current
    prevState.current = now
    if (before === 'running' && now === 'idle' && root) feed.reread()
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
    if (storedBroken) {
      try {
        window.localStorage.removeItem(KEY(root ?? ''))
      } catch {
        /* 저장소를 못 쓰면 그냥 넘어간다 — 화면은 이미 대화/파일 값이다. */
      }
    }
  }, [root, storedBroken])

  useEffect(() => {
    // 파일이 정본일 때는 저장값을 건드리지 않는다(§4-2 중요 7).
    if (!root || !conv || result.kind !== 'conversation') return
    const pick = result.pick
    if (!pick) return
    const value = JSON.stringify({ block: pick.block, messageId: pick.messageId, provider: pick.provider, at: pick.at })
    let previous: StoredProgress | null = null
    try {
      const raw = window.localStorage.getItem(KEY(root))
      if (raw !== null && raw !== '') previous = parseStoredProgress(raw)
    } catch {
      previous = null
    }
    if (previous !== null) {
      const older = Date.parse(previous.at)
      const newer = Date.parse(pick.at)
      if (!(newer > older)) {
        // 같은 답이 같은 시각으로 1→4단계로 자라나는 스트리밍 갱신은 `at`이 안 움직인다.
        // (Roh fix2 [중요] — id·at만 보면 이 갱신이 저장되지 않아 재시작 뒤 1단계로 되돌아갔다.)
        // 그래서 **답이 같고 내용(서명)이 바뀐 동률**만 저장한다. 답이 다르거나 시각이 더 이른
        // 늦은 응답은 여기서 버려 저장값이 뒤로 가지 않는다.
        const sameAnswer = previous.messageId === pick.messageId && previous.provider === pick.provider
        const contentMoved = progressSignature(previous) !== progressSignature(pick)
        if (!(newer === older && sameAnswer && contentMoved)) return
      }
    }
    try {
      window.localStorage.setItem(KEY(root), value)
    } catch {
      /* 저장소가 가득 찼거나 막혔다 — 이번 실행은 화면 값만 쓴다. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, snap?.root, provider, result.kind, valueSig, convKey])

  if (result.kind === 'none') return { pick: null }
  return { pick: result.pick }
}
