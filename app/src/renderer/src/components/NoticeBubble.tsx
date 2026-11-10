import { useState } from 'react'
import { Icon } from './Icon'
import {
  choiceOpen, hasDetail, type NoticeChoiceValue, type NoticeRow
} from '../../../shared/notice'

/**
 * 학교 재무 양식 알림 말풍선 — **아직 어디에도 붙이지 않은 부품**이다(1묶음).
 * 붙이는 자리(대화 창 맨 위 고정 줄, SKE-08)와 닫기 기억의 저장, [다시 보기](SKE-09)는 2묶음 차례다.
 *
 * 지켜야 하는 것(발주 ③):
 * - 한 번만 뜬다 — 이 부품은 **그리기만** 하고, 띄울지 말지는 `shared/notice.ts` 의 `noticeVisible` 이 정한다.
 *   X 는 `onDismiss(key)` 로 알리고 스스로 끝내지 않는다(닫기 기억은 부르는 쪽이 든다).
 * - 한 줄 = `title` 그대로. 앱이 숫자·범주를 **조립하지 않는다**(계약이 둘로 갈린다).
 * - [자세히] — `items` 가 비면 단추도 없다. 서식 없는 텍스트로만 그린다(마크다운·링크 해석 금지).
 *   데이터는 도우미가 흉내 낼 수 있으므로 여기서 `dangerouslySetInnerHTML`·`<a>`·마크다운 파서를 쓰지 않는다.
 * - 선택 단추 — `choices` 가 있고 `choice` 가 null 일 때만, 알림 한 건에 한 번. 누른 즉시 잠근다
 *   (빠르게 두 번 눌러 두 번 기록되는 것을 막는다 — QuestionCard 와 같은 이유).
 * - `footnote` 를 고른 뒤에는 **콜백만** 둔다. "각주 넣어 줘" 를 입력칸에 채우는 연결은 2묶음.
 * - 화면 규칙(형님 고정): 왼쪽 색선·세로 캡슐·1px 넘는 border-left·왼쪽 안쪽 그림자로 상태를 말하지 않는다.
 *   전체 바탕 + 굵기 + 아이콘 + 전체 둘레선만 쓴다(`.notice-*`, components.css 끝).
 */

/**
 * 문구는 **이 파일 안 상수**다. 2묶음에서 `copy.ts` 로 옮긴다(이번 묶음은 copy.ts 를 건드리지 않는다 — 다른 갈래 차례).
 * 숫자를 넣지 않는다: 한 줄은 도구가 완성한 `title` 하나뿐이다.
 */
const COPY = {
  detail: '자세히',
  dismiss: '알림 닫기',
  more: '외 {n}곳',
  failed: '선택을 기록하지 못했어요. 잠시 뒤 다시 눌러 주세요.',
  footnoteAction: '각주 넣어 줘',
  footnoteNote: '논문에 적을 문장을 입력칸에 채워 드려요.',
  choiceNote: '계산 방식을 다르게 한 곳은 알려 주셔야 해요.'
} as const

export interface NoticeBubbleProps {
  notice: NoticeRow
  /** X — 닫기 기억은 부르는 쪽이 `project_id + notice_identity` 키로 저장한다. */
  onDismiss?: (key: string) => void
  /** 선택 기록 — sidecar `notices.choose`. 성공하면 규칙집이 정본과 알림 파일을 다시 쓴다. */
  onChoose?: (value: NoticeChoiceValue) => void | Promise<void>
  /** 고른 `footnote` 를 입력칸에 채우는 연결(2묶음). 지금은 기록된 선택을 보여 주고 부르기만 한다. */
  onFootnote?: () => void
  /**
   * SKE-09 "다시 보기" — 닫힌 알림을 다시 그리는 유일한 통로. 단추·자리는 2묶음이고
   * 이번 묶음은 **부품이 그릴 수 있게만** 둔다.
   */
  forceOpen?: boolean
}

function itemLine(what: string, cells: readonly string[]): string {
  // `4.투자계획!E24` 처럼 시트와 칸이 한 문자열에 들어 있다(계약). 앱이 쪼개 다시 조립하지 않는다.
  return cells.length ? `${what} · ${cells.join(', ')}` : what
}

/**
 * 선택 한 번의 상태 — **어느 알림의 요청인지**(열쇠)를 함께 든다.
 * 부품은 같은 자리에서 다른 알림을 그릴 수 있다(대화 창이 알림을 갈아 끼운다). 열쇠를 안 들면
 * 앞 알림의 잠금·늦은 실패가 새 알림에 얹힌다.
 */
interface ChoiceAttempt {
  key: string
  value: NoticeChoiceValue
  failed: boolean
}

/** 알림 한 건. 부르는 쪽이 띄울지 정하고, 여기서는 그리기·선택 잠금만 한다. */
export function NoticeBubble({ notice, onDismiss, onChoose, onFootnote, forceOpen = false }: NoticeBubbleProps) {
  const [attempt, setAttempt] = useState<ChoiceAttempt | null>(null)
  // 열쇠가 다르면 없는 것으로 친다 — 새 알림은 **같은 렌더에서** 곧바로 선택지를 되찾는다(초기화 렌더 없음).
  const current = attempt && attempt.key === notice.key ? attempt : null
  const picked = current && !current.failed ? current.value : null
  const failed = current?.failed ?? false
  const showChoices = choiceOpen(notice, picked) && !!onChoose
  const footnoteReady = notice.choice === 'footnote' && !!onFootnote

  const pick = (value: NoticeChoiceValue): void => {
    const key = notice.key
    // 렌더를 기다리지 않고 즉시 잠근다 — 두 번 눌러도 기록은 하나.
    setAttempt({ key, value, failed: false })
    // 부르는 쪽이 동기 함수일 수 있다 — 호출을 마이크로태스크 안에서 해야 동기 throw 도 같은 실패 경로로 온다.
    void Promise.resolve()
      .then(() => onChoose?.(value))
      .catch(() => {
        // 응답은 요청 때의 열쇠·값이 아직 그 자리일 때만 반영한다 — 앞 알림의 늦은 실패가 새 알림을 건드리지 않는다.
        setAttempt((prev) => (prev && prev.key === key && prev.value === value ? { key, value, failed: true } : prev))
      })
  }

  return (
    <div className="notice-card" role="status" aria-live="polite" data-force-open={forceOpen ? 'true' : undefined}>
      <div className="notice-head">
        <span className="notice-ic"><Icon name="info" size={17} /></span>
        {/* title 은 완성 문장이다. 문자열 그대로 한 줄 — 조립·강조·링크 없음. */}
        <p className="notice-title">{notice.title}</p>
        {notice.dismissible && onDismiss && (
          <button type="button" className="notice-x" aria-label={COPY.dismiss} title={COPY.dismiss} onClick={() => onDismiss(notice.key)}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>

      {notice.choices.length > 0 && <p className="notice-note">{COPY.choiceNote}</p>}

      {showChoices && (
        <div className="notice-choice">
          {notice.choices.map((choice) => (
            <button type="button" key={choice.value} onClick={() => pick(choice.value)}>
              {choice.label}
            </button>
          ))}
        </div>
      )}

      {failed && <p className="notice-failed" role="alert">{COPY.failed}</p>}

      {footnoteReady && (
        <div className="notice-foot">
          <span>{COPY.footnoteNote}</span>
          <button type="button" onClick={() => onFootnote?.()}>{COPY.footnoteAction}</button>
        </div>
      )}

      {hasDetail(notice) && (
        <details className="notice-more">
          <summary>
            <Icon name="chevronDown" size={14} />
            <span>{COPY.detail}</span>
          </summary>
          <ul className="notice-items">
            {notice.items.map((item, index) => (
              <li key={`${item.key || 'item'}:${index}`}>{itemLine(item.what, item.cells)}</li>
            ))}
          </ul>
          {notice.omittedItems > 0 && <p className="notice-omitted">{COPY.more.replace('{n}', String(notice.omittedItems))}</p>}
        </details>
      )}
    </div>
  )
}
