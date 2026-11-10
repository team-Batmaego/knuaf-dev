import { useState } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { useProject } from '../store/project'
import { STEP_NAMES } from '../../../shared/progress-list'
import { PROGRESS } from '../copy'
import { useProgress } from './useProgress'

/**
 * 제목줄 가운데 — T1: `[눈금 7칸] {n}/7 {이름} ▾` (시안 progress-r4, IMPL-T1 §3-1).
 *
 * 도우미 답 안의 "창업논문 진행 목록" 덩어리를 `useProgress`가 고른 값을 그린다.
 * 앱 5단계(`useStage`·`shared/stage`) 의존을 제거했다 — 학생에게 보이는 단계는
 * 스킬 7단계 하나다. `shared/stage`·`useStage` 자체는 그대로 둔다(다른 곳에서 쓴다).
 *
 * 펼침 머리: "창업논문 진행 · 7단계 중 n단계 · {시각} 답 기준 · 독립 내용검토 전".
 * 7줄(✓▶○ + 메모, "확인 필요"), ⚑ 줄(글 그대로), "그 뒤" 줄은 파싱한 실제 문구
 * + [제출 전 점검]. 시작 전이면 빈칸 + 안내 + [제출 전 점검].
 *
 * 눈금은 면색만 쓴다 — 왼쪽 색선·알약·1px 초과 border 금지(frontend.md).
 */

function formatBasis(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const h24 = d.getHours()
  const pm = h24 >= 12
  const h = pm ? h24 - 12 || 12 : h24 || 12
  const m = d.getMinutes()
  if (sameDay) return pm ? PROGRESS.timeToday(h, m) : PROGRESS.timeTodayAm(h, m)
  return PROGRESS.timeOther(d.getMonth() + 1, d.getDate(), h, m, pm)
}

export function StageMenu() {
  const [open, setOpen] = useState(false)
  const openSheet = useProject((s) => s.openSheet)
  const { pick } = useProgress()

  const block = pick?.block ?? null
  const n = block ? block.n : 0
  const name = block && n >= 1 ? STEP_NAMES[n - 1] : PROGRESS.started
  const allDone = block ? block.steps.every((s) => s.state === 'done') : false
  const label = block
    ? allDone
      ? `7/7 ${STEP_NAMES[6]} · ${PROGRESS.allDone}`
      : `${n}/7 ${name}`
    : PROGRESS.started
  const ariaLabel = block
    ? allDone
      ? PROGRESS.readAloud(7, STEP_NAMES[6])
      : PROGRESS.readAloud(n, name)
    : PROGRESS.started

  const basis = pick ? formatBasis(pick.at) : null
  const headMeta = block
    ? `${PROGRESS.ofSteps(n)}${block.reviewPending ? ` · ${PROGRESS.reviewPending}` : ''}${basis ? ` · ${PROGRESS.basis(basis)}` : ''}`
    : null

  return (
    <div className="pop-host">
      <button
        className="tbtn stg"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={open ? PROGRESS.buttonLabelClose : PROGRESS.buttonLabelOpen}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ticks" aria-hidden="true">
          {STEP_NAMES.map((_, i) => {
            const st = block?.steps[i]?.state
            return <i key={i} className={st === 'done' ? 'd' : st === 'now' ? 'n' : ''} />
          })}
        </span>
        <b>{label}</b>
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="center" width={400} label={PROGRESS.head}>
        <PopHead>{PROGRESS.head}</PopHead>
        {!block && (
          <>
            <div className="pop-empty caption">{PROGRESS.empty}</div>
            <PopSep />
            <PopRow
              icon={<Icon name="check" size={16} />}
              onClick={() => { setOpen(false); openSheet('checkup') }}
            >
              {PROGRESS.check}
            </PopRow>
          </>
        )}
        {block && (
          <>
            <div className="pop-scroll">
            {headMeta && <div className="pop-head-sub caption">{headMeta}</div>}
            {block.steps.map((step) => (
              <PopRow
                key={step.n}
                icon={
                  step.state === 'done'
                    ? <span className="ic done" aria-hidden="true"><Icon name="check" size={11} /></span>
                    : step.state === 'now'
                      ? <span className="ic now" aria-hidden="true" />
                      : <span className="ic todo" aria-hidden="true" />
                }
                current={step.state === 'now'}
              >
                <span className="c">
                  <b>{`${step.n}. ${STEP_NAMES[step.n - 1]}`}</b>
                  {step.note && (
                    <small>
                      {step.uncertain ? `${step.note} · ${PROGRESS.uncertain}` : step.note}
                    </small>
                  )}
                </span>
              </PopRow>
            ))}
            {block.flags.map((flag) => (
              <PopRow key={flag} icon={<span className="ic flag" aria-hidden="true"><Icon name="warn" size={12} /></span>}>
                <span className="c">{flag}</span>
              </PopRow>
            ))}
            {block.after !== null && (
              <>
                <PopSep />
                <div className="pop-after caption">
                  <span>{`${PROGRESS.afterHead} · ${block.after}`}</span>
                </div>
              </>
            )}
            </div>
            {/* 제출 전 점검은 스크롤 밖에 고정 — 작은 창(720px 이하)·긴 목록에서도 늘 보인다(N-I07, Roh [중요 3]). */}
            <PopRow
              icon={<Icon name="check" size={16} />}
              onClick={() => { setOpen(false); openSheet('checkup') }}
            >
              {PROGRESS.check}
            </PopRow>
          </>
        )}
      </Popover>
    </div>
  )
}
