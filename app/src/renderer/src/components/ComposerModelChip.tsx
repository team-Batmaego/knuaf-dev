import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAccountProvider } from './AccountChooser'
import { Popover } from './Popover'
import { Icon } from './Icon'
import { useChat } from '../store/chat'
import { useProject } from '../store/project'
import { CHAT, PROVIDER_NAME } from '../copy'
import { isCrossProviderModelId } from '../../../shared/chat'
import { LANE_TABLE, type LaneRowId } from '../../../shared/lanes'
import type { LaneModelGroup, PlacementEntries, PlacementOrigin } from '../../../shared/lanes-ipc'
import { LaneModelMenu, type LaneMenuModel, type LaneMenuRole } from './LaneModelMenu'
import { laneActions, useLanes } from '../store/lanes'

/** 회사 전환은 AccountChooser, 같은 회사의 모델 선택은 이 부품이 맡는다. */
export function ComposerModelChip({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState(placement)
  const [view, setView] = useState<'top' | 'recommendations' | LaneMenuRole>('top')
  const [groups, setGroups] = useState<LaneModelGroup[]>([])
  const [laneBusy, setLaneBusy] = useState(false)
  const [laneError, setLaneError] = useState<string | null>(null)
  const root = useProject((s) => s.root)
  const snapshot = useLanes((s) => s.snapshot)
  const laneView = snapshot?.root === root ? snapshot.settings : null
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { provider, stateOf } = useAccountProvider()
  const state = stateOf(provider)
  const settings = useProject((s) => s.settings)
  const loadSettings = useProject((s) => s.loadSettings)
  const { models, modelChoice, modelProvider, modelsError, modelSaveError, loadModels } = useChat(useShallow((s) => ({
    models: s.models, modelChoice: s.modelChoice, modelProvider: s.modelProvider,
    modelsError: s.modelsError, modelSaveError: s.modelSaveError, loadModels: s.loadModels
  })))
  const sameProvider = modelProvider === provider
  const catalog = sameProvider ? models : null
  const stored = settings?.chat_models?.[provider] ?? null
  const currentChoice = sameProvider && catalog !== null ? modelChoice : stored
  // 제외된 선택은 미선택이 아니다. 목록 실패 때도 저장된 외부 ID를 표시하지 않는다.
  const needsReselection = provider === 'codex' && (
    isCrossProviderModelId(stored?.model ?? '') || isCrossProviderModelId(currentChoice?.model ?? '')
  )
  const choice = needsReselection ? null : currentChoice
  const selected = catalog?.find((m) => m.model === choice?.model)
  const listError = sameProvider ? modelsError : null
  const saveError = sameProvider ? modelSaveError : null
  const connection = state === 'connected' ? '연결됨' : state === 'need-login' ? '로그인 필요' : state === 'logging-in' ? '로그인 중' : state === 'no-tool' ? '설치 필요' : state === 'failed' || state === 'unknown' ? '확인 실패' : '확인 중'
  const accountDefault = !choice && !needsReselection ? catalog?.find((model) => model.isDefault) : undefined
  const displayModel = choice ? selected?.name ?? choice.model : accountDefault?.name
  const displayEffort = choice ? choice.effort : accountDefault?.defaultEffort
  const mainLabel = state === 'connected' && displayModel ? `${displayModel}${displayEffort ? ` · ${displayEffort}` : ''}` : connection
  const close = (): void => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (state === 'connected') void loadModels(provider)
  }, [provider, state, loadModels])

  useEffect(() => {
    if (!open || !root) return
    let current = true
    useLanes.getState().attach()
    void useLanes.getState().load(root)
    void laneActions().laneModels(root).then((result) => {
      if (!current) return
      if ('value' in result) setGroups(result.value)
      else setLaneError(result.error)
    })
    return () => { current = false }
  }, [open, root])

  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const el = host.current
      if (!el) return
      const box = el.getBoundingClientRect()
      const top = (document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0) + 8
      const above = Math.max(0, box.top - top - 6)
      const below = Math.max(0, window.innerHeight - box.bottom - 18)
      const next = placement === 'down' && below >= 560 ? 'down' : above > below ? 'up' : 'down'
      setDirection(next)
      el.style.setProperty('--model-pop-height', `${next === 'up' ? above : below}px`)
      const width = Math.min(400, window.innerWidth - 48)
      el.style.setProperty('--model-pop-shift', `${Math.min(0, window.innerWidth - 12 - box.left - width)}px`)
    }
    position()
    const first = host.current?.querySelector<HTMLButtonElement>('.popover button')
    first?.focus()
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [open, placement])

  const entries: PlacementEntries = { research: null, writing: null, repeat: null, review: null }
  for (const row of laneView?.rows ?? []) entries[row.lane] = row.entry
  const role = view !== 'top' && view !== 'recommendations' && view !== 'main' ? view : null
  const currentEntry = role ? entries[role] : null
  const menuModels: LaneMenuModel[] = groups.flatMap((group) => group.models.map((model) => ({ ...model, company: group.company })))
  const nameOf = (company: string, model: string | null): string => {
    if (!model) return '—'
    return menuModels.find((item) => item.company === company && item.model === model)?.name ?? model
  }
  const labelEntry = (entry: PlacementEntries[keyof PlacementEntries]): string => {
    if (!entry) return '—'
    if (entry.how === 'main') return '주 모델'
    return `${nameOf(entry.company, entry.model)}${entry.effort ? ` · ${entry.effort}` : ''}`
  }
  const rowIds = Object.keys(LANE_TABLE).filter((id) => id !== 'free-only') as LaneRowId[]
  const choiceForView = view === 'main' ? choice && { company: provider, ...choice }
    : currentEntry?.model ? { company: currentEntry.company, model: currentEntry.model, effort: currentEntry.effort } : null
  const savePlacement = async (next: PlacementEntries, origin: PlacementOrigin): Promise<boolean> => {
    if (!root || !snapshot || snapshot.root !== root || laneBusy) return false
    setLaneBusy(true)
    setLaneError(null)
    try {
      const result = await laneActions().setPlacement(root, snapshot.version, next, origin)
      if (useProject.getState().root !== root) return false
      if ('error' in result || result.value.outcome !== 'applied') {
        setLaneError('배치를 적용하지 못했어요. 다시 확인해 주세요.')
        await useLanes.getState().load(root)
        return false
      }
      return true
    } finally { setLaneBusy(false) }
  }
  const selectRoleModel = (model: LaneMenuModel): void => {
    if (!role) return
    const company = groups.find((group) => group.company === model.company)?.company
    if (!company) return
    const effort = currentEntry?.effort && model.efforts.includes(currentEntry.effort) ? currentEntry.effort : null
    void savePlacement({ ...entries, [role]: { company, model: model.model, effort, how: 'relay' } }, { kind: 'mine' })
  }
  return (
    <div className="pop-host composer-model-host" ref={host}>
      <button type="button" className="model" ref={trigger} title={CHAT.modelChipTitle} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setView('top'); setOpen(!open) }}>
        <span>{mainLabel} · Team {laneView?.mode === 'on' ? 'on' : 'off'}</span><Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={close} align="left" placement={direction} label={CHAT.modelChipTitle}>
        <div className="pop-scroll model-picker" onBlur={(event) => { if (event.relatedTarget && !host.current?.contains(event.relatedTarget as Node)) setOpen(false) }}>
          <LaneModelMenu view={view} main={mainLabel}
            pending={laneView?.pendingDesign ? `${PROVIDER_NAME[laneView.pendingDesign.company]} ${nameOf(laneView.pendingDesign.company, laneView.pendingDesign.model)}${laneView.pendingDesign.effort ? ` · ${laneView.pendingDesign.effort}` : ''}` : null}
            team={laneView?.mode === 'on'} source={laneView?.source.kind === 'recommended' ? LANE_TABLE[laneView.source.rowId].label : laneView?.source.kind === 'mine' ? '직접 고침' : ''}
            roles={{ research: labelEntry(entries.research), writing: labelEntry(entries.writing), repeat: labelEntry(entries.repeat), review: labelEntry(entries.review) }}
            models={menuModels} choice={choiceForView} recommendations={rowIds.map((id) => ({ id, label: LANE_TABLE[id].label, main: nameOf(LANE_TABLE[id].lanes.design.company, LANE_TABLE[id].lanes.design.model), review: nameOf(LANE_TABLE[id].lanes.review.company, LANE_TABLE[id].lanes.review.model) }))}
            selectedRecommendation={laneView?.source.kind === 'recommended' ? laneView.source.rowId : null} busy={laneBusy || !root || !snapshot}
            onView={setView} onTeam={() => { if (!root || !snapshot) return; if (laneView?.mode === 'on') { void laneActions().disable(root).then((error) => { if (error) setLaneError('배치를 적용하지 못했어요. 다시 확인해 주세요.') }) } else if (laneView?.recommendedRowId) { void savePlacement(entries, { kind: 'recommended', rowId: laneView.recommendedRowId }).then(async (ok) => { if (ok) { await loadModels(provider); await loadSettings() } }) } else setLaneError('추천 배치를 확인하지 못했어요.') }}
            onModel={(model) => { if (view === 'main' && root) { const next = { model: model.model, effort: choice?.effort && model.efforts.includes(choice.effort) ? choice.effort : null }; void window.knuaf.chat.setModel(root, model.company, next).then(async (result) => { if ('error' in result) setLaneError('모델을 적용하지 못했어요. 다시 확인해 주세요.'); else if (model.company === provider) { await loadModels(provider); await loadSettings() } }) } else selectRoleModel(model) }}
            onEffort={(effort) => { if (view === 'main' && choice && root) void window.knuaf.chat.setModel(root, provider, { ...choice, effort }).then(async (result) => { if ('error' in result) setLaneError('모델을 적용하지 못했어요. 다시 확인해 주세요.'); else { await loadModels(provider); await loadSettings() } }); else if (role && currentEntry) void savePlacement({ ...entries, [role]: { ...currentEntry, effort } }, { kind: 'mine' }) }}
            onRecommendation={(id) => { void savePlacement(entries, { kind: 'recommended', rowId: id as LaneRowId }).then(async (ok) => { if (ok) { await loadModels(provider); await loadSettings(); setView('top') } }) }} />
          {(laneError || saveError || listError) && <p className="model-picker-note" role="alert">{laneError || saveError || listError}</p>}
        </div>
      </Popover>
    </div>
  )
}
