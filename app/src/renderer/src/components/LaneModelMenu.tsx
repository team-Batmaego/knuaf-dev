import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { AccountChooser } from './AccountChooser'
import { PopHead, PopSep } from './Popover'
import { PROVIDER_NAME } from '../copy'
import type { Provider } from '../../../shared/chat'

/** D2 메뉴는 상태와 저장을 소유하지 않는다. 모델 목록과 선택 결과는 호출자가 공급한다. */
export type LaneMenuRole = 'main' | 'research' | 'writing' | 'repeat' | 'review'
export interface LaneMenuModel { company: Provider; model: string; name: string; efforts: readonly string[] }
export interface LaneMenuChoice { company: Provider; model: string; effort: string | null }
export interface LaneMenuRecommendation { id: string; label: string; main: string; review: string }

const roles: { id: Exclude<LaneMenuRole, 'main'>; label: string }[] = [
  { id: 'research', label: '자료 찾기' }, { id: 'writing', label: '글쓰기' },
  { id: 'repeat', label: '반복 작업' }, { id: 'review', label: '검토' }
]

export function LaneModelMenu(props: {
  view: 'top' | 'recommendations' | 'account' | LaneMenuRole
  main: string
  pending: string | null
  team: boolean
  source: string
  roles: Record<Exclude<LaneMenuRole, 'main'>, string>
  models: readonly LaneMenuModel[]
  choice: LaneMenuChoice | null
  recommendations: readonly LaneMenuRecommendation[]
  selectedRecommendation: string | null
  busy: boolean
  onView: (view: 'top' | 'recommendations' | 'account' | LaneMenuRole) => void
  onTeam: () => void
  onModel: (model: LaneMenuModel) => void
  onEffort: (effort: string) => void
  onRecommendation: (id: string) => void
  onAccountPicked: () => void
}) {
  const { view } = props
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"], button')?.focus()
  }, [view])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && index >= 0) {
      event.preventDefault()
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
    } else if (event.key === 'ArrowRight' && view === 'top' && (event.target as HTMLElement).dataset.submenu === 'true') {
      event.preventDefault()
      ;(event.target as HTMLButtonElement).click()
    } else if (event.key === 'ArrowLeft' && view !== 'top' && !(event.target as HTMLElement).classList.contains('lane-effort')) {
      event.preventDefault()
      props.onView('top')
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && (event.target as HTMLElement).classList.contains('lane-effort')) {
      const efforts = buttons.filter((button) => button.classList.contains('lane-effort'))
      const current = efforts.indexOf(event.target as HTMLButtonElement)
      event.preventDefault()
      efforts[(current + (event.key === 'ArrowRight' ? 1 : efforts.length - 1)) % efforts.length]?.focus()
    }
  }
  const back = <button type="button" className="pop-row" onClick={() => props.onView('top')}><span aria-hidden="true">‹</span><span className="c"><b>{view === 'account' ? 'AI 회사·로그인' : view === 'recommendations' ? '추천 배치' : view === 'main' ? '주 모델' : roles.find((r) => r.id === view)?.label}</b></span></button>
  if (view === 'top') return <div className="lane-menu" ref={menu} onKeyDown={keyDown}>
    <PopHead>주 모델</PopHead>
    <button type="button" className="pop-row" data-submenu="true" onClick={() => props.onView('main')}><span className="c">{props.main}</span><span className="lane-meta">›</span></button>
    {props.pending && <PopHead>다음 새 대화부터 {props.pending}</PopHead>}
    <PopSep />
    <button type="button" className="pop-row" role="switch" aria-checked={props.team} disabled={props.busy} onClick={props.onTeam}><span className="c"><span>Team</span><small>{props.team ? props.source || '역할마다 다른 모델이 맡아요' : '역할마다 다른 모델에게 나눠 맡기기'}</small></span><span className={`lane-switch${props.team ? ' on' : ''}`} aria-hidden="true" /></button>
    {props.team && roles.map((role) => <button type="button" className="pop-row" data-submenu="true" key={role.id} onClick={() => props.onView(role.id)}><span className="lane-label">{role.label}</span><span className="c">{props.roles[role.id]}</span><span className="lane-meta">›</span></button>)}
    <PopSep />
    <button type="button" className="pop-row" data-submenu="true" onClick={() => props.onView('recommendations')}><span className="c">추천 배치</span><span className="lane-meta">›</span></button>
    <PopSep />
    <button type="button" className="pop-row" data-submenu="true" onClick={() => props.onView('account')}><span className="c">AI 회사·로그인</span><span className="lane-meta">›</span></button>
  </div>
  if (view === 'account') return <div className="lane-menu" ref={menu} onKeyDown={keyDown}>{back}<PopSep /><AccountChooser onPicked={props.onAccountPicked} /></div>
  if (view === 'recommendations') return <div className="lane-menu" ref={menu} onKeyDown={keyDown}>{back}<PopSep />{props.recommendations.map((rec) => <button type="button" key={rec.id} className={`pop-row${props.selectedRecommendation === rec.id ? ' cur' : ''}`} aria-pressed={props.selectedRecommendation === rec.id} disabled={props.busy} onClick={() => props.onRecommendation(rec.id)}><span className="c"><span>{rec.label}</span><small>주 모델 {rec.main} · 검토 {rec.review}</small></span>{props.selectedRecommendation === rec.id && <Icon name="check" size={16} />}</button>)}</div>
  const selected = props.models.find((m) => m.company === props.choice?.company && m.model === props.choice?.model)
  const companies = [...new Set(props.models.map((m) => m.company))]
  return <div className="lane-menu" ref={menu} onKeyDown={keyDown}>{back}<PopSep />{companies.map((company) => <div key={company}><PopHead>{PROVIDER_NAME[company]}</PopHead>{props.models.filter((m) => m.company === company).map((m) => {
    const current = m.company === props.choice?.company && m.model === props.choice?.model
    return <button type="button" key={m.model} className={`pop-row${current ? ' cur' : ''}`} aria-pressed={current} disabled={props.busy} onClick={() => props.onModel(m)}><span className="c">{m.name}</span>{current && <Icon name="check" size={16} />}</button>
  })}</div>)}{selected && selected.efforts.length > 0 && <><PopSep /><PopHead>추론</PopHead><div className="lane-efforts" role="group" aria-label="추론 단계">{selected.efforts.map((effort) => <button type="button" key={effort} className="lane-effort" aria-pressed={props.choice?.effort === effort} disabled={props.busy} onClick={() => props.onEffort(effort)}>{effort}</button>)}</div></>}</div>
}
