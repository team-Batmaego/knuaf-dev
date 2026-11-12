import { useEffect, useRef, useState } from 'react'
import { NoticeBubble } from './NoticeBubble'
import { noticeVisible, type NoticeChoiceValue, type NoticeRow } from '../../../shared/notice'
import { NOTICE } from '../copy'
import type { Envelope, RpcResult } from '../../../shared/types'

/** `notices:read` 응답 — preload 의 `NoticesRead` 와 같은 모양(렌더러는 preload 모듈을 import 하지 않는다). */
export interface NoticesRead { notices: NoticeRow[]; dismissed: string[] }

/**
 * 스택이 쓰는 세 길. 시험이 `api` 로 갈아 끼운다(기본값은 `window.knuaf`).
 * 셋 다 **던지지 않고** `{ result } | { error }` 를 돌려준다(preload 계약 그대로).
 */
export interface NoticesApi {
  read: (root: string) => Promise<RpcResult<NoticesRead>>
  dismiss: (root: string, key: string) => Promise<RpcResult<string[]>>
  choose: (root: string, identity: string, value: NoticeChoiceValue) => Promise<RpcResult<Envelope>>
}

export interface NoticeStackProps {
  root: string | null
  /**
   * 다시 읽기 신호 — 도우미 턴이 끝날 때 `Chat` 이 값을 올린다. 값이 바뀌면 알림 파일을 다시 읽는다
   * (규칙집은 턴 끝에 알림을 새로 쓰거나 지운다). 숫자만 넘긴다: 스택이 `store/chat` 을 직접
   * 구독하면 부품 시험이 스토어 런타임을 끌어와야 한다.
   */
  reloadKey?: number
  /** SKE-09 "다시 보기" — 오른쪽 창이 넘겨 주는 열쇠 목록. 여기 있으면 닫은 알림도 다시 그린다. */
  forceOpenKeys?: readonly string[]
  /** `footnote` 를 고른 뒤 [각주 넣어 줘] — 초점만 옮긴다(문장은 `onWriteTalk` 이 채운다). */
  onFootnote?: () => void
  /**
   * [각주 넣어 줘] 가 입력칸에 채우는 문장 — `copy.ts` 의 `NOTICE.footnoteAction`(단추 이름 그대로)을
   * 넘긴다. 부르는 쪽은 **채우기만** 한다(보내지 않는다 — 학생이 고쳐 보낸다).
   */
  onWriteTalk?: (text: string) => void
  /** 시험 주입 — 없으면 `window.knuaf`. */
  api?: NoticesApi
}

function defaultApi(): NoticesApi {
  return {
    read: (root) => window.knuaf.notices.read(root),
    dismiss: (root, key) => window.knuaf.notices.dismiss(root, key),
    choose: (root, identity, value) => window.knuaf.notices.choose(root, identity, value)
  }
}

/**
 * 봉투가 "저장됨"을 뜻하는가 — 규칙집 v0.4.11 계약(choose 결과는 `chosen`·`rejected`·`failed`).
 *
 * 저장된 것은 **`ok:true` + `status:'chosen'`** 하나뿐이다. `failed`(`notice_rows_unavailable` —
 * 알림 행을 읽지 못해 선택을 **시작하지도 못했다**. 정본에 아무것도 안 적혔다)·정상 거절·`status:null`·
 * 모르는 값은 전부 실패로 본다: 저장된 척하면 학생은 고친 줄 알고 카드가 사라지는데 다음에 또 묻는다.
 * 선택은 적혔는데 알림 파일 갱신만 실패한 경우는 규칙집이 `chosen_notice_failed` 로 표시한다 —
 * v0.4.10 이 남긴 이 옛 모양(`ok:false`, exit 3)만 저장됨으로 받는다.
 */
export function choiceSaved(envelope: Envelope | null | undefined): boolean {
  if (!envelope) return false
  if (envelope.status === 'chosen_notice_failed') return true
  return envelope.ok === true && envelope.status === 'chosen'
}

/** 화면이 든 것 — 어느 폴더의 읽기 결과인지(`root`)를 함께 기억해 늦게 온 응답을 버린다. */
interface StackState { root: string | null; notices: NoticeRow[]; dismissed: string[] }

const EMPTY: StackState = { root: null, notices: [], dismissed: [] }

/**
 * 대화 창 맨 위 고정 줄(SKE-08) — 알림 여러 건·닫기 기억·선택 기록을 이 부품이 다 든다.
 * `Chat.tsx` 는 한 줄만 세운다(겹침 최소화).
 *
 * 닫기 기억은 메인(`notices:dismiss`)이 앱 데이터 폴더에 저장하고, 여기서는 **먼저 화면에서 지운 뒤**
 * 저장을 부른다 — 저장이 실패해도 대화 화면이 멈추거나 카드가 되살아나지 않는다.
 *
 * 선택은 전용 IPC(`notices:choose`) 한 길이다 — 메인이 폴더·알림·값을 다시 검사한 뒤 sidecar 에
 * 넘긴다. 저장 확인(`choiceSaved`) 뒤에는 고른 값을 **화면이 기억**해, 알림 파일이 아직 옛 모양
 * (`choice:null`)이어도 단추를 다시 열지 않는다. 다시 읽어 그 알림이 파일에서 사라졌으면(규칙집
 * v0.4.11은 선택 뒤 알림 파일을 지운다) **조용히 닫는다** — 실패 문구를 띄우지 않는다.
 */
export function NoticeStack({ root, reloadKey = 0, forceOpenKeys = [], onFootnote, onWriteTalk, api }: NoticeStackProps) {
  const [state, setState] = useState<StackState>(EMPTY)
  // 다시 읽기 요청 번호 — 선택 저장 뒤 스스로 한 번 더 읽는다(prop 신호와 같은 길).
  const [reload, setReload] = useState(0)
  // 저장이 확인된 선택. 파일이 아니라 **화면의 기억**이라, 옛 파일의 `choice:null` 을 이긴다.
  const [picked, setPicked] = useState<Readonly<Record<string, NoticeChoiceValue>>>({})
  // X 로 닫은 **그 다시 보기 요청**의 열쇠 — 요청이 끝났으니 목록에 남아 있어도 다시 그리지 않는다.
  // 요청은 "열쇠가 `forceOpenKeys` 에 없었다가 새로 들어옴"이다(아래 render-phase 비교).
  const [consumed, setConsumed] = useState<readonly string[]>([])
  // 직전 렌더의 `forceOpenKeys`. 내용이 달라졌을 때만 새 요청을 가려낸다(기본값 `[]` 는 렌더마다
  // 새 배열이라 정체성 비교로는 못 쓴다 — 내용 비교라 렌더 루프가 없다).
  const [seenForceOpen, setSeenForceOpen] = useState<readonly string[]>([])
  // 주입이 없으면 `window.knuaf` 래퍼 하나를 **한 번만** 만든다(렌더마다 새 객체를 만들지 않는다).
  const fallback = useRef<NoticesApi | null>(null)
  const apiNow = api ?? (fallback.current ??= defaultApi())
  const apiRef = useRef(apiNow)
  apiRef.current = apiNow
  const rootRef = useRef(root)
  rootRef.current = root
  // 읽기 effect 는 `root`·`reloadKey`·`reload` 가 바뀔 때만 돈다 — 위 래퍼는 그 셋에 없다.

  /**
   * 다시 보기 **요청**의 경계 — `forceOpenKeys` 에 새로 들어온 열쇠는 새 요청이다.
   * 그 열쇠를 `consumed` 에서 지워, 「닫기 → 다시 보기 → X → 다시 보기」가 다시 열리게 한다.
   * 내용 비교라 같은 목록을 다시 넘겨도(부모가 매 렌더 새 배열을 만들어도) 아무 일도 없다.
   */
  if (seenForceOpen.length !== forceOpenKeys.length || forceOpenKeys.some((key) => !seenForceOpen.includes(key))) {
    const entered = forceOpenKeys.filter((key) => !seenForceOpen.includes(key))
    setSeenForceOpen(forceOpenKeys)
    if (entered.length > 0) {
      setConsumed((prev) => {
        const kept = prev.filter((key) => !entered.includes(key))
        return kept.length === prev.length ? prev : kept
      })
    }
  }

  useEffect(() => {
    if (!root) {
      setState(EMPTY)
      return
    }
    let live = true
    void apiRef.current.read(root).then((reply) => {
      if (!live) return
      if (reply.error || !reply.result) {
        // 읽기 실패는 조용하다. 다만 **직전에 그린 카드는 지우지 않는다** — 잠깐 못 읽었다고
        // 알림이 사라지면 학생은 왜 없어졌는지 알 수 없다. 폴더가 바뀐 경우만 비운다.
        setState((prev) => (prev.root === root ? prev : { root, notices: [], dismissed: [] }))
        return
      }
      const next: StackState = { root, notices: reply.result.notices, dismissed: reply.result.dismissed }
      setState(next)
      // 파일에서 사라진 알림의 로컬 선택은 버린다 — 같은 열쇠가 다시 생기면 그때는 새 알림이다.
      setPicked((prev) => {
        const keys = new Set(next.notices.map((notice) => notice.key))
        const kept = Object.entries(prev).filter(([key]) => keys.has(key))
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
      })
    }).catch(() => {
      if (live) setState((prev) => (prev.root === root ? prev : { root, notices: [], dismissed: [] }))
    })
    return () => { live = false }
  }, [root, reloadKey, reload])

  const dismiss = (key: string): void => {
    const at = root
    if (!at) return
    // 다시 보기로 **지금 열려 있는** 카드의 X 만 그 요청을 소비한다. 일반 카드의 X 는 닫기 기억에만
    // 남긴다 — 미래의 다시 보기 요청을 미리 먹으면 그 요청은 영영 안 열린다.
    if (forceOpenKeys.includes(key)) {
      setConsumed((prev) => (prev.includes(key) ? prev : [...prev, key]))
    }
    // 화면 먼저 — 저장 실패로 카드가 되살아나지 않는다.
    setState((prev) => prev.dismissed.includes(key) ? prev : { ...prev, dismissed: [...prev.dismissed, key] })
    void apiRef.current.dismiss(at, key).then((reply) => {
      if (rootRef.current !== at) return
      if (reply.error || !reply.result) return
      setState((prev) => prev.root === at ? { ...prev, dismissed: reply.result! } : prev)
    }).catch(() => { /* 저장 실패는 화면을 바꾸지 않는다 */ })
  }

  /**
   * 선택 기록 — 저장이 **확인된** 값만 화면에 남기고, 그 밖(부르기 실패·`failed`·정상 거절·모르는
   * 봉투)은 던져 부품의 실패 줄 + 다시 열린 단추로 돌려보낸다.
   */
  const choose = async (key: string, value: NoticeChoiceValue): Promise<void> => {
    const at = root
    if (!at) return
    // 열쇠 = `project_id:notice_identity` — 둘 다 hex 라 `:` 는 하나뿐이다.
    const identity = key.slice(key.indexOf(':') + 1)
    const reply = await apiRef.current.choose(at, identity, value)
    if (reply.error) throw new Error(reply.error.code)
    const envelope = reply.result
    if (!choiceSaved(envelope)) throw new Error(envelope?.block_reason || envelope?.status || 'not_saved')
    setPicked((prev) => ({ ...prev, [key]: value }))
    if (rootRef.current !== at) return
    // 다시 읽어 규칙집이 새로 쓴 파일을 반영한다. 읽기 실패는 조용하다 — 카드는 고른 채로 남는다.
    setReload((count) => count + 1)
  }

  if (!root || state.root !== root) return null
  const reopened = (key: string): boolean => forceOpenKeys.includes(key) && !consumed.includes(key)
  const shown = state.notices
    .map((notice) => {
      const local = picked[notice.key]
      return local && notice.choice !== local ? { ...notice, choice: local } : notice
    })
    .filter((notice) => noticeVisible(notice, state.dismissed, reopened(notice.key)))
  if (shown.length === 0) return null

  return (
    <div className="notice-zone">
      <div className="notice-stack">
        {shown.map((notice) => (
          <NoticeBubble
            key={notice.key}
            notice={notice}
            onDismiss={dismiss}
            onChoose={(value) => choose(notice.key, value)}
            onFootnote={() => { onFootnote?.(); onWriteTalk?.(NOTICE.footnoteAction) }}
            forceOpen={reopened(notice.key)}
          />
        ))}
      </div>
    </div>
  )
}
