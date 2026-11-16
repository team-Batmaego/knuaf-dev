import { join } from 'node:path'
import { openStore, StoreBrokerError, withStore, type OpenStore, type StoreSession } from './appStore'
import type { InstallerLaunch } from './nativeInstaller'
import { downloadToFile } from '../runtimeDownload'
import { compare, exact, object, version, type Envelope } from './manifest'
import { parseApp, releasePage, verifyApp, type VerifiedApp } from './appManifest'
import { boundedFetch, readChannelDocument, type Transport } from './network'
import type { UpdateConfig } from './keys'
import type { AppHandoff } from './handoff'
import { RECHECK_INTERVAL_MS, startRecheck, type RecheckTimer } from './recheck'
export interface AppUpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'preparing' | 'launching' | 'interrupted' | 'error' | 'unavailable' | 'blocked'
  current: string; latest: string | null; page: string | null; reason?: 'store_owner'; message?: string; received?: number; total?: number
}
interface Pending { from: string; to: string; installer: string; at: string }
const RELEASES_PAGE = 'https://github.com/team-Batmaego/knuaf-dev/releases'
const OWNER_FAILURES = new Set([
  'user_data_owner_mismatch', 'user_data_owner_administrators',
  'pinned_owner_mismatch', 'pinned_owner_administrators',
  'entry_owner_mismatch', 'entry_owner_administrators'
])
export class AppUpdates {
  private candidate: VerifiedApp | null = null
  private controller: AbortController | null = null
  private checking: Promise<AppUpdateStatus> | null = null
  /** 주기 확인이 돌고 있나 — `install()` 이 진행 중 확인을 기다릴지 정할 때 쓴다. */
  private quiet = false
  /** 조용한 확인 직전의 상태 — 끝난 뒤 '실제로 달라졌나'를 비교하는 기준. */
  private quietBefore: AppUpdateStatus | null = null
  private recheckTimer: RecheckTimer | null = null
  private statusValue: AppUpdateStatus
  private storeOwnerBlocked = false
  readonly root: string
  readonly ready: Promise<void>
  constructor(private opts: {
    userData: string; current: string; platform: NodeJS.Platform; arch: string; config: UpdateConfig; fetch: Transport
    handoff: Pick<AppHandoff, 'run'>; startInstaller: (request: InstallerLaunch) => Promise<void>; quit: () => void; openStore?: OpenStore
    openExternal: (url: string) => Promise<unknown>; emit?: (status: AppUpdateStatus) => void
    /** 주기 확인 간격(ms). 기본 30분, 0 이하면 끈다(시험). */
    recheckMs?: number
  }) {
    version(opts.current)
    this.root = join(opts.userData, 'app-update')
    this.statusValue = { phase: opts.config.keys.length ? 'idle' : 'unavailable', current: opts.current, latest: null, page: null, ...(!opts.config.keys.length ? { message: '업데이트를 확인할 수 없어요.' } : {}) }
    this.ready = this.recover()
    // 주기 확인은 생성자에서 건다 — 켤 때 한 번 확인(`ipc.ts` 의 `void appUpdates.check()`)이
    // 이미 돈 뒤부터 간격을 센다(첫 박자는 간격 뒤). `recheckMs: 0` 은 시험이 끌 때 쓴다.
    const intervalMs = opts.recheckMs ?? RECHECK_INTERVAL_MS
    if (intervalMs > 0) this.recheckTimer = startRecheck(intervalMs, () => this.recheck())
  }
  status(): AppUpdateStatus { return { ...this.statusValue } }
  /** 주기 확인을 멈춘다 — 앱이 닫히거나 시험이 정리할 때. */
  stopRecheck(): void { this.recheckTimer?.stop(); this.recheckTimer = null }
  /**
   * 켜 둔 채 쓰는 학생을 위한 주기 확인 — 조용히(화면 흔들지 않고) 새 판이 있는지만 본다.
   * 설치가 진행 중인 phase(받는 중·준비 중·다시 시작 중)에서는 손대지 않는다 — 진행률 화면을
   * 확인이 덮으면 학생은 무엇이 일어나는지 잃는다. `controller` 가드가 같은 구간을 이미 막지만,
   * phase 로 한 번 더 못 박아 둔다(진행률을 지키는 것이 이 함수의 계약).
   */
  recheck(): Promise<AppUpdateStatus> {
    const phase = this.statusValue.phase
    if (phase === 'downloading' || phase === 'preparing' || phase === 'launching') return Promise.resolve(this.status())
    return this.check(true)
  }
  private set(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
    const latest = this.storeOwnerBlocked && this.candidate && compare(this.candidate.manifest.version, this.opts.current) > 0 ? this.candidate.manifest.version : null
    this.statusValue = { ...this.statusValue, reason: undefined, message: undefined, received: undefined, total: undefined, ...patch,
      ...(this.storeOwnerBlocked ? { phase: 'blocked', reason: 'store_owner', latest, page: latest ? releasePage(latest) : RELEASES_PAGE } as const : {}) }
    // 조용한 확인 중에는 여기서 알리지 않는다 — 끝난 뒤 실제로 달라졌을 때만 한 번 알린다.
    if (!this.quiet) this.opts.emit?.(this.status())
    return this.status()
  }
  private installer(v: string): string { version(v); return join(this.root, v, 'installer.exe') }
  private async inStore<T>(create: boolean, action: (store: StoreSession) => Promise<T>): Promise<T> {
    try {
      return await withStore(this.opts.openStore ?? openStore, this.opts.userData, create, async store => {
        // Only a successful native boundary open clears a previously observed owner block.
        this.storeOwnerBlocked = false
        return action(store)
      })
    } catch (error) {
      if (error instanceof StoreBrokerError && error.diagnostic.reason === 'native' && OWNER_FAILURES.has(error.diagnostic.nativeFailure ?? '')) this.storeOwnerBlocked = true
      throw error
    }
  }
  private async recover(): Promise<void> {
    if (this.opts.platform !== 'win32') return
    try {
      await this.inStore(false, async store => {
        const text = await store.read('pending.json')
        if (text === null) return
        const p = object(JSON.parse(text)); exact(p, ['from', 'to', 'installer', 'at']); version(p.from); version(p.to)
        if (compare(p.to, p.from) <= 0 || p.installer !== this.installer(p.to) || typeof p.at !== 'string' || new Date(p.at).toISOString() !== p.at) throw new Error('앱 설치 기록이 잘못됐어요.')
        const pending = p as unknown as Pending
        if (this.opts.current === pending.to) {
          await store.cleanup(pending.to); await store.remove('pending.json')
          this.set({ phase: this.opts.config.keys.length ? 'idle' : 'unavailable', message: '앱 업데이트를 마쳤어요.' })
        } else if (this.opts.current === pending.from) {
          const text = await store.read(`${pending.to}/manifest.json`)
          if (text === null) throw new Error('앱 설치 서명 기록이 없어요.')
          this.candidate = verifyApp(JSON.parse(text), this.opts.config.keys, this.opts.current)
          if (this.candidate.manifest.version !== pending.to) throw new Error('앱 설치 기록과 서명이 달라요.')
          this.set({ phase: 'interrupted', latest: pending.to, page: releasePage(pending.to), message: '업데이트가 끝나지 않았어요. 다시 시도할 수 있어요.' })
        } else throw new Error('앱 설치 기록과 현재 판이 달라요.')
      })
    } catch (error) { this.set({ phase: this.opts.config.keys.length ? 'error' : 'unavailable', message: error instanceof Error ? error.message : '설치 기록을 확인하지 못했어요.' }) }
  }
  check(silent = false): Promise<AppUpdateStatus> {
    if (this.checking) return this.checking
    if (this.controller) return Promise.resolve(this.status())
    this.quiet = silent
    this.quietBefore = silent ? this.statusValue : null
    const task = this.checkNow(); this.checking = task
    void task.finally(() => {
      if (this.checking !== task) return
      this.checking = null
      // 조용한 확인은 결과가 **실제로 달라졌을 때만** 한 번 알린다. 30분마다 같은 상태를 다시
      // 뿌리면 화면이 깜빡이고, 새 판이 없을 때 학생이 볼 것도 없다.
      const changed = this.quietBefore !== null && JSON.stringify(this.quietBefore) !== JSON.stringify(this.statusValue)
      this.quiet = false; this.quietBefore = null
      if (changed) this.opts.emit?.(this.status())
    })
    return task
  }
  private async checkNow(): Promise<AppUpdateStatus> {
    await this.ready
    if (!this.opts.config.keys.length) return this.set({ phase: 'unavailable', message: '업데이트를 확인할 수 없어요.' })
    const interruptedCandidate = this.statusValue.phase === 'interrupted' ? this.candidate : null
    const interrupted = interruptedCandidate ? { candidate: interruptedCandidate, status: { ...this.statusValue } } : null
    const restoreInterrupted = (): AppUpdateStatus | null => {
      if (!interrupted) return null
      this.candidate = interrupted.candidate
      return this.set({ phase: 'interrupted', latest: interrupted.status.latest, page: interrupted.status.page, message: interrupted.status.message })
    }
    // 조용한 확인은 '확인 중' 단계를 만들지 않는다 — 화면에 표시가 스치는 것도 흔들림이다.
    if (!this.quiet) this.set({ phase: 'checking' })
    try {
      const channel = await readChannelDocument(this.opts.config, this.opts.fetch, AbortSignal.timeout(15_000))
      if (!Object.hasOwn(channel, 'app')) {
        const restored = restoreInterrupted()
        if (restored) return restored
        this.candidate = null
        return this.set({ phase: 'idle', latest: null, page: null })
      }
      const app = object(channel.app)
      version(app.latest)
      const page = releasePage(app.latest)
      if (app.page !== page) throw new Error('허용되지 않은 앱 내려받기 페이지예요.')
      if (this.opts.platform === 'win32' && this.opts.arch === 'x64') {
        if (!Object.hasOwn(app, 'win32-x64')) {
          const restored = restoreInterrupted()
          if (restored) return restored
          this.candidate = null
          if (compare(app.latest, this.opts.current) <= 0) return this.set({ phase: 'idle', latest: null, page: null })
          return this.set({ phase: 'unavailable', latest: null, page: null, message: `새 앱 ${app.latest}은 아직 이 컴퓨터용으로 준비 중이에요. 지금 앱은 그대로 쓸 수 있어요.` })
        }
        const proof = parseApp(app['win32-x64'], this.opts.config.keys)
        if (app.latest !== proof.manifest.version) throw new Error('채널 판과 서명된 앱 판이 달라요.')
        this.candidate = proof
      } else if (this.opts.platform !== 'darwin') return this.set({ phase: 'unavailable', latest: null, page: null, message: '이 운영체제의 앱 업데이트는 지원하지 않아요.' })
      if (compare(app.latest, this.opts.current) <= 0) return this.set({ phase: 'idle', latest: null, page: null })
      return this.set({ phase: 'available', latest: app.latest, page })
    } catch (error) {
      // 조용한 확인의 실패(인터넷 끊김 등)는 오류 화면을 만들지 않고 이전 모습으로 되돌린다 -
      // 다음 박자에 다시 본다. 되돌린 결과는 '달라지지 않음'이라 emit 도 없다.
      if (this.quietBefore) { this.statusValue = this.quietBefore; return this.status() }
      return this.set({ phase: 'error', message: error instanceof Error ? error.message : '앱 업데이트를 확인하지 못했어요.' })
    }
  }
  async openPage(): Promise<void> {
    await this.ready
    if (this.opts.platform === 'win32' && this.storeOwnerBlocked) {
      const latest = this.candidate && compare(this.candidate.manifest.version, this.opts.current) > 0 ? this.candidate.manifest.version : null
      await this.opts.openExternal(latest ? releasePage(latest) : RELEASES_PAGE)
      return
    }
    if (this.opts.platform !== 'darwin' || !this.statusValue.latest || !this.statusValue.page) throw new Error('먼저 앱 업데이트를 확인해 주세요.')
    const page = releasePage(this.statusValue.latest)
    if (page !== this.statusValue.page || compare(this.statusValue.latest, this.opts.current) <= 0) throw new Error('앱 내려받기 페이지가 잘못됐어요.')
    await this.opts.openExternal(page)
  }
  cancel(): boolean {
    if (!this.controller || this.statusValue.phase === 'launching') return false
    this.controller.abort(); return true
  }
  async install(): Promise<void> {
    await this.ready
    if (this.opts.platform !== 'win32' || this.opts.arch !== 'x64') throw new Error('Windows x64 앱에서만 설치할 수 있어요.')
    // 주기 확인이 스쳐 지나가는 중이면 기다린다 - 30분짜리 확인 하나 때문에 설치를 거절하면
    // 학생에게는 '업데이트를 준비하고 있어요'라는 엉뚱한 오류가 된다. 사람이 누른 확인이면 그대로 막는다.
    if (this.checking && this.quiet) { try { await this.checking } catch { /* 조용한 확인의 실패는 설치를 막지 않는다 */ } }
    if (this.controller || this.checking) throw new Error('이미 앱 업데이트를 준비하고 있어요.')
    if (!this.candidate) throw new Error('먼저 앱 업데이트를 확인해 주세요.')
    const p = verifyApp(this.candidate.envelope, this.opts.config.keys, this.opts.current), v = p.manifest.version, installer = this.installer(v)
    const controller = new AbortController(); this.controller = controller
    let pendingWritten = false, launchUnknown = false, started = false
    try {
      await this.inStore(true, async store => {
        if (!await store.verify(v, p.manifest.size, p.manifest.sha256)) {
          this.set({ phase: 'downloading' })
          const sink = await store.download(v, p.manifest.size, p.manifest.sha256)
          await downloadToFile(p.manifest.url, installer, p.manifest, event => this.set({ phase: 'downloading', received: event.received, total: event.total }), controller.signal, {
            fetch: (url, init) => boundedFetch(url, init.signal, this.opts.fetch, p.manifest.size, this.opts.config),
            createStream: () => sink
          })
          await store.commit(v)
        }
        await store.write(`${v}/manifest.json`, p.envelope satisfies Envelope)
      })
      this.set({ phase: 'preparing' })
      await this.opts.handoff.run(async () => {
        if (controller.signal.aborted) throw new Error('앱 업데이트를 취소했어요.')
        await this.inStore(false, async store => {
          await store.write('pending.json', { from: this.opts.current, to: v, installer, at: new Date().toISOString() })
          pendingWritten = true
          const proof = verifyApp(p.envelope, this.opts.config.keys, this.opts.current)
          if (!await store.verify(v, proof.manifest.size, proof.manifest.sha256)) throw new Error('실행 직전 설치 파일 확인에 실패했어요.')
        })
        if (controller.signal.aborted) throw new Error('앱 업데이트를 취소했어요.')
        this.set({ phase: 'launching' })
        try { await this.opts.startInstaller({ userData: this.opts.userData, path: installer, version: v, size: p.manifest.size, sha256: p.manifest.sha256 }); started = true }
        catch (error) { launchUnknown = !!error && typeof error === 'object' && 'code' in error && error.code === 'installer_unknown'; throw error }
      }, controller.signal)
      // No persistence or asynchronous work follows confirmed process creation.
      this.opts.quit()
    } catch (error) {
      if (pendingWritten && !started && !launchUnknown) {
        try { await this.inStore(false, store => store.remove('pending.json')) } catch { /* preserve the record if its boundary cannot be proved */ }
      }
      this.set({ phase: 'error', message: error instanceof Error ? error.message : '앱 업데이트에 실패했어요. 다시 시도할 수 있어요.' })
      throw error
    } finally { this.controller = null }
  }
}
