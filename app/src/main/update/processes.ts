import { win32 } from 'node:path'
export interface ProcessInfo { pid: number; parent: number; created: string; name: string; path: string | null }
/** Native enumeration expands 8.3 paths first; ambiguous aliases must never be guessed. */
export function windowsPath(value: string): string {
  let p = value.replaceAll('/', '\\')
  if (p.toLowerCase().startsWith('\\\\?\\unc\\')) p = '\\\\' + p.slice(8)
  else if (p.startsWith('\\\\?\\')) p = p.slice(4)
  if (!win32.isAbsolute(p) || /(?:^|\\)[^\\]*~\d/.test(p) || p.includes('\0')) throw new Error('프로세스 경로를 확인하지 못했어요.')
  return win32.normalize(p).replace(/\\+$/, '').toLowerCase()
}
export function resourcesBusy(processes: ProcessInfo[], resources: string, names: readonly string[]): boolean {
  const root = windowsPath(resources), prefix = root + '\\', known = new Set(names.map(n => n.toLowerCase()))
  return processes.some(p => {
    if (!p.path) return known.has(p.name.toLowerCase())
    try { const path = windowsPath(p.path); return path === root || path.startsWith(prefix) }
    catch { return known.has(p.name.toLowerCase()) }
  })
}
export interface ProcessSnapshot { processes: ProcessInfo[]; appPid: number; appExecutable: string }
type Ownership = 'owned' | 'unrelated' | 'unknown'
interface Generation { process: ProcessInfo; ownership: Ownership }
export type InspectWhy = 'app' | 'history' | 'parent-live' | 'parent-app' | 'parent-history' | 'parent-missing' | 'parent-time-unreadable' | 'own-time-unreadable' | 'parent-reused' | 'cycle'
export interface InspectRow {
  role: 'block' | 'ancestor'; id: number; parentId: number | 'app' | 'gone' | 'cut'
  kind: string; ownership: 'o' | 'u' | 'x'; why: InspectWhy; pathRead: boolean; bornMs: number | null
}
/** `rows()` 는 부르는 쪽이 판정을 쓴 **뒤에** 부른다 — 근거 조립이 판정 경로의 시간을 쓰지 않는다. */
export interface Inspection { busy: boolean; blocked: number; counts: { owned: number; unknown: number; unrelated: number; helper: number }; rows: () => InspectRow[] }
/** 표본 하나에서 근거를 싣는 차단 행 수와 조상 사슬 깊이의 상한. */
export const MAX_BLOCK_ROWS = 8
export const MAX_ANCESTORS = 6
const KINDS = new Set(['codex', 'claude', 'node', 'cmd', 'conhost', 'powershell', 'taskkill', 'tar', 'csc', 'svchost', 'wmiprvse', 'dllhost', 'runtimebroker'])
/** Retain generations, including dead parents. Every new orphan must be owned or
 * provably unrelated; an unobserved intermediate parent is NOT evidence of safety. */
export class OwnedProcessWatch {
  private history = new Map<number, Generation[]>()
  private app: string
  private times = new Map<string, string | null>()
  private labels = new Map<string, number>()
  /** `started`: 진단의 `bornMs` 기준 시각(음수 = 인계 확인 전에 태어남). 판정에는 쓰지 않는다. */
  constructor(private snapshot: ProcessSnapshot, private started = 0) {
    this.app = windowsPath(snapshot.appExecutable)
    const ids = new Set([snapshot.appPid])
    let changed = true
    while (changed) {
      changed = false
      for (const p of snapshot.processes) if (!ids.has(p.pid) && ids.has(p.parent)) { ids.add(p.pid); changed = true }
    }
    for (const process of snapshot.processes) this.remember(process, ids.has(process.pid) ? 'owned' : 'unrelated')
  }
  private time(value: string): string | null {
    if (this.times.has(value)) return this.times.get(value)!
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{1,7})Z$/.exec(value)
    // Windows FILETIME has 100ns precision. Date.parse alone truncates it to ms
    // and can attribute an older orphan to a newer, unrelated reused parent PID.
    const result = match && Number.isFinite(Date.parse(value)) ? `${match[1]}.${match[2].padEnd(7, '0')}Z` : null
    this.times.set(value, result); return result
  }
  private sameGeneration(a: ProcessInfo, b: ProcessInfo): boolean {
    return a.created === b.created && (this.time(a.created) !== null || (a.parent === b.parent && a.name === b.name && a.path === b.path))
  }
  private remember(process: ProcessInfo, ownership: Ownership): void {
    const generations = this.history.get(process.pid) ?? []
    const existing = generations.find(g => this.sameGeneration(g.process, process))
    if (existing) existing.ownership = ownership
    else { generations.push({ process, ownership }); this.history.set(process.pid, generations) }
  }
  /** `busy` 는 `inspect` 의 결론만 돌려준다 — 분류 계산은 한 벌뿐이다. */
  busy(processes: ProcessInfo[]): boolean { return this.inspect(processes).busy }
  /**
   * 종료 판정과 그 근거. `detail` 이 참일 때만 이유·부모 세대를 적어 두고, 차단 행(과 그
   * 조상 사슬)은 `rows()` 를 부를 때 조립한다 — 진단이 꺼진 평소 경로는 개수만 센다.
   * 판정(`busy`)은 `detail` 과 무관하게 같다.
   */
  inspect(processes: ProcessInfo[], detail = false): Inspection {
    const current = new Map(processes.map(p => [p.pid, p])), known = new Map<number, Ownership>(), visiting = new Set<number>()
    const why = detail ? new Map<number, InspectWhy>() : null
    // 분류가 실제로 근거로 삼은 부모 세대 — 같은 PID 를 다시 쓴 새 프로세스와 섞이지 않게 한다.
    const via = detail ? new Map<number, ProcessInfo | 'app' | 'gone'>() : null
    const before = (parent: ProcessInfo, child: ProcessInfo): boolean => {
      const a = this.time(parent.created), b = this.time(child.created)
      return a !== null && b !== null && a <= b
    }
    const classify = (p: ProcessInfo): Ownership => {
      if (p.pid === this.snapshot.appPid) { why?.set(p.pid, 'app'); return 'owned' }
      const cached = known.get(p.pid); if (cached) return cached
      if (visiting.has(p.pid)) { why?.set(p.pid, 'cycle'); return 'unknown' }
      visiting.add(p.pid)
      const old = this.history.get(p.pid)?.find(g => this.sameGeneration(g.process, p))
      let ownership: Ownership = old?.ownership ?? 'unknown'
      let reason: InspectWhy = 'history'
      if (!old || ownership === 'unknown') {
        const parent = current.get(p.parent)
        // A live matching parent generation proves ancestry. A reused PID whose
        // creation is later than the child cannot be that child's parent.
        if (parent && before(parent, p)) { ownership = classify(parent); reason = 'parent-live'; via?.set(p.pid, parent) }
        else if (p.parent === this.snapshot.appPid) { ownership = 'owned'; reason = 'parent-app'; via?.set(p.pid, 'app') }
        else if (this.history.get(p.parent)?.some(g => g.ownership === 'owned' && before(g.process, p))) {
          ownership = 'owned'; reason = 'parent-history'
          via?.set(p.pid, this.history.get(p.parent)!.find(g => g.ownership === 'owned' && before(g.process, p))!.process)
        }
        // Missing or unreadable parent identity remains unknown: cancel handoff.
        else if (!parent) { reason = 'parent-missing'; via?.set(p.pid, 'gone') }
        else if (this.time(parent.created) === null) { reason = 'parent-time-unreadable'; via?.set(p.pid, parent) }
        else if (this.time(p.created) === null) { reason = 'own-time-unreadable'; via?.set(p.pid, parent) }
        // 지금 그 PID 를 쓰는 프로세스는 자식보다 늦게 태어났다 — 진짜 부모는 이미 없다.
        else { reason = 'parent-reused'; via?.set(p.pid, 'gone') }
      }
      visiting.delete(p.pid); known.set(p.pid, ownership); why?.set(p.pid, reason); return ownership
    }
    const counts = { owned: 0, unknown: 0, unrelated: 0, helper: 0 }
    const blocking: ProcessInfo[] = [], verdict = detail ? new Map<number, Ownership>() : null
    let blocked = 0
    for (const p of processes) {
      const ownership = classify(p)
      this.remember(p, ownership)
      verdict?.set(p.pid, ownership)
      let helper = p.pid === this.snapshot.appPid
      try { helper ||= ownership === 'owned' && !!p.path && windowsPath(p.path) === this.app } catch { /* ambiguous paths do not exempt a process */ }
      if (helper) counts.helper++
      else counts[ownership]++
      if (!helper && ownership !== 'unrelated') { blocked++; if (detail && blocking.length < MAX_BLOCK_ROWS) blocking.push(p) }
    }
    if (!why || !via || !verdict) return { busy: blocked > 0, blocked, counts, rows: () => [] }
    return { busy: blocked > 0, blocked, counts, rows: () => this.explain(blocking, current, verdict, why, via, before) }
  }
  private explain(blocking: ProcessInfo[], current: Map<number, ProcessInfo>, verdict: Map<number, Ownership>, why: Map<number, InspectWhy>,
    via: Map<number, ProcessInfo | 'app' | 'gone'>, before: (parent: ProcessInfo, child: ProcessInfo) => boolean): InspectRow[] {
    const rows: InspectRow[] = [], emitted = new Set<number>()
    const describe = (p: ProcessInfo, role: InspectRow['role'], ownership: Ownership, reason: InspectWhy, parentId: InspectRow['parentId']): InspectRow => {
      const at = this.time(p.created) === null ? NaN : Date.parse(p.created)
      return { role, id: this.label(p), parentId, kind: this.kind(p), ownership: ownership === 'owned' ? 'o' : ownership === 'unknown' ? 'u' : 'x', why: reason, pathRead: !!p.path, bornMs: Number.isFinite(at) ? Math.round(at - this.started) : null }
    }
    /** 로그에 실린 행만 가리킨다 — 못 싣는 부모는 번호 대신 `app`·`gone`·`cut` 표지다. */
    const parentOf = (p: ProcessInfo, live: boolean): ProcessInfo | 'app' | 'gone' => {
      // 이번 표본의 분류가 부모를 따져 봤으면 그 세대 그대로다.
      const used = live ? via.get(p.pid) : undefined
      if (used !== undefined) return used
      // 이력으로 판정된 행·지나간 조상: 자식보다 먼저 태어난 세대만 부모로 본다.
      if (p.parent === this.snapshot.appPid) return 'app'
      const now = current.get(p.parent), other = now && now.pid !== p.pid ? now : undefined
      if (other && before(other, p)) return other
      const past = this.history.get(p.parent)?.filter(g => before(g.process, p)).at(-1)
      if (past) return past.process
      return other && this.time(other.created) === null ? other : 'gone'
    }
    for (const p of blocking) {
      let child = p, role: InspectRow['role'] = 'block'
      for (let depth = 0; ; depth++) {
        const key = this.label(child)
        const live = current.get(child.pid) === child
        const ownership = live ? verdict.get(child.pid)! : this.history.get(child.pid)?.find(g => this.sameGeneration(g.process, child))?.ownership ?? 'unknown'
        const parent = parentOf(child, live)
        // 사슬은 앱·없는 부모·무관 세대·이미 실은 행·깊이 제한에서 끝난다.
        const stop = typeof parent === 'string' || ownership === 'unrelated' || depth >= MAX_ANCESTORS || emitted.has(this.label(parent))
        const parentId: InspectRow['parentId'] = typeof parent === 'string' ? parent
          : emitted.has(this.label(parent)) ? this.label(parent)
          : stop ? 'cut' : this.label(parent)
        if (!emitted.has(key)) { emitted.add(key); rows.push(describe(child, role, ownership, live ? why.get(child.pid) ?? 'history' : 'history', parentId)) }
        if (stop || typeof parent === 'string') break
        child = parent; role = 'ancestor'
      }
    }
    return rows
  }
  /** 이 감시 안에서만 통하는 임시 번호 — PID 원값은 진단에 싣지 않는다. */
  private label(p: ProcessInfo): number {
    const key = `${p.pid}|${p.created}|${this.time(p.created) === null ? `${p.parent}|${p.name}|${p.path}` : ''}`
    let id = this.labels.get(key)
    if (id === undefined) { id = this.labels.size + 1; this.labels.set(key, id) }
    return id
  }
  /** 고정 허용 목록 밖의 실행 파일 이름은 `other` — 임의 파일 이름이 로그에 남지 않게 한다. */
  private kind(p: ProcessInfo): string {
    try { if (p.path && windowsPath(p.path) === this.app) return 'app' } catch { /* 경로가 모호하면 이름으로만 본다 */ }
    const name = p.name.toLowerCase().replace(/\.exe$/, '')
    if (/^pythonw(?:\d+(?:\.\d+)*)?$/.test(name)) return 'pythonw'
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return 'python'
    return KINDS.has(name) ? name : 'other'
  }
}
