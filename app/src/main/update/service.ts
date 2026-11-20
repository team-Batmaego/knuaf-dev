import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadToFile } from '../runtimeDownload'
import { compatible, compare, verifySkill, version, type VerifiedSkill } from './manifest'
import { type UpdateConfig } from './keys'
import { boundedFetch, downloadLimit, readChannel, type Transport } from './network'
import { diag } from '../diagLog'
import { SkillStore, SkillUnknown, type Site } from './store'
import { skillSwitch, type SkillSwitch } from './switch'
import { agentActivity } from './activity'

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'repair' | 'ready' | 'needs-app' | 'downloading' | 'switching' | 'error' | 'unavailable'
  current: string; bundled: boolean; highest: string | null; available: string | null
  kept: string[]; received?: number; total?: number; message?: string
}
export class SkillUpdates {
  private candidate: VerifiedSkill | null = null
  private controller: AbortController | null = null
  private checking: Promise<UpdateStatus> | null = null
  private statusValue: UpdateStatus
  private lastReason = 'store'
  private readonly lock: SkillSwitch
  constructor(readonly store: SkillStore, private opts: {
    config: UpdateConfig; fetch: Transport; restartSidecar: () => Promise<unknown>
    emit?: (status: UpdateStatus) => void; lock?: SkillSwitch
  }) {
    this.lock = opts.lock ?? skillSwitch
    this.statusValue = { phase: opts.config.keys.length ? 'idle' : 'unavailable', current: store.bundledVersion, bundled: true, highest: null, available: null, kept: [], ...(!opts.config.keys.length ? { message: '업데이트를 확인할 수 없어요.' } : {}) }
  }
  /** 화면용 상태. 읽기 전용이라 못 읽음을 접은 값 그대로 보여 준다. 진단 줄의 결과 이름은 `lastReason`에 남긴다. */
  status(): UpdateStatus {
    try {
      const d = this.store.stateDetail()
      if (d.legacy) throw d.legacy.error
      const s = d.value, r = this.store.resolve(), bundled = r.source === this.store.bundled
      // 정상이면 기준판처럼 첫 읽기의 active를 쓴다. 첫 읽기를 못 읽었을 때만 resolver가 고른 판을 쓴다.
      const current = !d.selection.known ? r.version : bundled ? this.store.bundledVersion : s.active!
      this.lastReason = r.reason
      return { ...this.statusValue, current, bundled, highest: s.highest?.version ?? null, kept: Object.keys(s.kept).filter(v => this.store.valid(v, s.kept[v])) }
    } catch {
      this.lastReason = 'bundle-forced-state-error'
      return { ...this.statusValue, current: this.store.bundledVersion, bundled: true, kept: [] }
    }
  }
  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.statusValue = { ...this.statusValue, received: undefined, total: undefined, message: undefined, ...patch }
    const status = this.status(); this.opts.emit?.(status)
    diag(`skill:status.${status.phase} ${this.lastReason}`)
    return status
  }
  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking
    if (this.controller || this.lock.switching) return Promise.resolve(this.status())
    const task = this.checkNow()
    this.checking = task
    void task.finally(() => { if (this.checking === task) this.checking = null })
    return task
  }
  private async checkNow(): Promise<UpdateStatus> {
    if (!this.opts.config.keys.length) return this.set({ phase: 'unavailable', message: '업데이트를 확인할 수 없어요.', available: null })
    this.set({ phase: 'checking' })
    try {
      const p = await readChannel(this.opts.config, this.opts.fetch, AbortSignal.timeout(15_000))
      if (!p) {
        this.candidate = null
        return this.set({ phase: 'idle', available: null })
      }
      // An app upgrade can ship ahead of the channel; observing that is not permission to install it.
      const highest = this.store.strictHighest('check', 'error-unknown')
      if (compatible(p.manifest, this.store.appVersion) && compare(p.manifest.version, this.store.bundledVersion) < 0 && (!highest || compare(p.manifest.version, highest.version) >= 0)) {
        if (highest?.version === p.manifest.version && highest.manifest !== p.digest) throw new Error('이전 판이거나 같은 판의 내용이 달라서 받지 않아요.')
        this.candidate = null
        return this.set({ phase: 'idle', available: null })
      }
      this.candidate = p
      if (!compatible(p.manifest, this.store.appVersion)) return this.set({ phase: 'needs-app', available: p.manifest.version, message: '이 규칙집은 앱 새 판이 필요해요.' })
      const kind = this.store.disposition(p)
      if (kind === 'kept' && p.manifest.version === this.store.bundledVersion && (!highest || compare(highest.version, this.store.bundledVersion) < 0)) {
        this.candidate = null
        return this.set({ phase: 'idle', available: null })
      }
      return this.set({ phase: kind === 'new' ? 'available' : kind === 'repair' ? 'repair' : 'ready', available: p.manifest.version })
    } catch (error) {
      this.candidate = null
      return this.set({ phase: 'error', available: null, message: error instanceof Error ? error.message : '업데이트를 확인하지 못했어요.' })
    }
  }
  async install(): Promise<UpdateStatus> {
    agentActivity.ensureActive()
    if (this.controller || this.checking || this.lock.switching) throw new Error('이미 업데이트 작업 중이에요.')
    if (!this.candidate) throw new Error('먼저 업데이트를 확인해 주세요.')
    const p = verifySkill(this.candidate.envelope, this.opts.config.keys)
    const kind = this.store.disposition(p)
    if (kind === 'kept') return this.choose(p.manifest.version, 'install')
    const controller = new AbortController()
    this.controller = controller
    const deadline = setTimeout(() => controller.abort(), 120_000)
    let temp: string | null = null
    try {
      mkdirSync(this.store.root, { recursive: true })
      temp = mkdtempSync(join(this.store.root, '.download-'))
      const zip = join(temp, 'skill.zip')
      this.set({ phase: 'downloading' })
      await downloadToFile(p.manifest.url, zip, p.manifest, event => this.set({ phase: 'downloading', received: event.received, total: event.total }), controller.signal, {
        fetch: (url, init) => boundedFetch(url, init.signal, this.opts.fetch, downloadLimit(p.manifest.size), this.opts.config)
      })
      if (controller.signal.aborted) throw new Error('업데이트를 취소했어요.')
      const bytes = readFileSync(zip)
      if (this.store.strict('install').active === p.manifest.version) {
        // A repair must not replace scripts underneath a still-running call.
        return await this.lock.switch(async () => {
          if (controller.signal.aborted) throw new Error('업데이트를 취소했어요.')
          this.store.publish(p, bytes)
          return this.activateLocked(p.manifest.version, controller.signal, 'install')
        })
      }
      this.store.publish(p, bytes)
      return await this.activate(p.manifest.version, controller.signal, 'install')
    } catch (error) {
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '규칙집 업데이트에 실패했어요.' })
      throw error
    } finally {
      clearTimeout(deadline)
      if (temp) rmSync(temp, { recursive: true, force: true })
      this.controller = null
    }
  }
  cancel(): boolean { if (!this.controller) return false; this.controller.abort(); return true }
  select(v: string | null): Promise<UpdateStatus> { return this.choose(v, 'select') }
  private async choose(v: string | null, stage: Site): Promise<UpdateStatus> {
    if (v !== null) version(v)
    agentActivity.ensureActive()
    if (this.controller || this.checking) throw new Error('이미 업데이트 작업 중이에요.')
    return this.activate(v, undefined, stage)
  }
  rollback(): Promise<UpdateStatus> { return this.choose(this.store.rollbackTarget(), 'rollback') }
  private async activate(v: string | null, signal: AbortSignal | undefined, stage: Site): Promise<UpdateStatus> {
    agentActivity.ensureActive()
    return this.lock.switch(() => this.activateLocked(v, signal, stage))
  }
  private async activateLocked(v: string | null, signal: AbortSignal | undefined, stage: Site): Promise<UpdateStatus> {
    if (signal?.aborted) throw new Error('업데이트를 취소했어요.')
    // 이전 선택을 못 읽으면 null로 접지 않고 여기서 멈춘다(되돌릴 곳을 모르는 채 쓰지 않는다).
    const previous = this.store.effStrict(stage) === this.store.bundled ? null : this.store.strict(stage).active
    this.set({ phase: 'switching' })
    let selected = false
    try {
      this.store.select(v, stage)
      selected = true
      if (signal?.aborted) throw new Error('업데이트를 취소했어요.')
      await this.opts.restartSidecar()
      return this.set({ phase: 'ready' })
    } catch (error) {
      if (!selected && error instanceof SkillUnknown) {
        // 쓰기 전에 못 읽었다 — 바꾼 것이 없으니 되돌림·재시작 없이 오류만 낸다.
        this.set({ phase: 'error', message: error.message })
        throw error
      }
      // Restore effective previous selection even after a complete newer .tmp.
      try { this.store.select(previous, 'restore') } catch (restoreError) {
        // 되돌림을 못 읽었으면 요청한 값을 그대로 두고 재시작 → 오류 → 원래 오류로 간다. 확정 무효 등은 기준판처럼 던진다.
        if (!(restoreError instanceof SkillUnknown)) throw restoreError
      }
      await this.opts.restartSidecar()
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '규칙집을 바꾸지 못했어요.' })
      throw error
    }
  }
}
