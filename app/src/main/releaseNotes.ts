import type { IpcMain } from 'electron'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './settings'

import type { NewsState, ReleaseNote, Settings } from '../shared/types'
type Versions = { app: string; skill: string | null }
const valid = (s: string): boolean => /^\d+\.\d+\.\d+$/.test(s)
function compare(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
function parse(text: string, kind: ReleaseNote['kind']): ReleaseNote | null {
  const match = /^---\s*\r?\n판:\s*([^\r\n]+)\r?\n날짜:\s*([^\r\n]*)\r?\n크기:\s*([^\r\n]+)\r?\n할 일:\s*([^\r\n]+)\r?\n---\s*\r?\n([\s\S]*)$/.exec(text)
  if (!match) return null
  const [, rawVersion, date, size, action, body] = match
  const version = rawVersion.trim()
  if (!valid(version)) return null
  return { kind, version, date: date.trim(), major: size.trim() === '큰 판', action: action.trim() === '없음' ? null : action.trim(), lines: body.split(/\r?\n/).filter(s => /^-\s+/.test(s)).map(s => s.replace(/^-\s+/, '').trim()) }
}
function notesAt(dir: string, kind: ReleaseNote['kind']): ReleaseNote[] {
  try {
    return readdirSync(dir).filter(name => /^\d+\.\d+\.\d+\.md$/.test(name)).flatMap(name => {
      try { const note = parse(readFileSync(join(dir, name), 'utf8'), kind); return note && `${note.version}.md` === name ? [note] : [] } catch { return [] }
    })
  } catch { return [] }
}
function skillVersion(dir: string): string | null {
  try { const tag = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf8')).source.tag; return typeof tag === 'string' && valid(tag.replace(/^v/, '')) ? tag.replace(/^v/, '') : null } catch { return null }
}
/** Older installs have no seen marker; only persistent signs of use distinguish them. */
export function initialSeen(settings: Settings, current: Versions, notes: ReleaseNote[]): Versions {
  if (settings.release_notes_seen) return settings.release_notes_seen
  if (!settings.onboarded_at && !settings.recent.length && !settings.provider_choice) return current
  const previous = (kind: 'app' | 'skill', version: string | null): string | null => {
    if (!version) return null
    return notes.filter(note => note.kind === kind && compare(note.version, version) < 0)
      .reduce((best, note) => compare(note.version, best) > 0 ? note.version : best, '0.0.0')
  }
  return { app: previous('app', current.app) ?? '0.0.0', skill: previous('skill', current.skill) }
}
export function registerReleaseNotes(resolveSkill: () => string, appRoot: string, ipcMain: Pick<IpcMain, 'handle'>, getVersion: () => string, isPackaged: boolean): void {
  let startupVersions: Versions | null = null
  let startupDialog = false
  let memorySeen: Versions | null = null
  const remember = (versions: Versions): void => {
    memorySeen = versions
    try { saveSettings({ release_notes_seen: versions }) }
    catch (error) { console.error('[knuaf] 새 소식 확인 기록 저장 실패', error) }
  }
  const read = (): NewsState => {
    const skillDir = resolveSkill()
    const current: Versions = { app: getVersion(), skill: skillVersion(skillDir) }
    const appDir = !isPackaged && process.env.KNUAF_E2E_RELEASE_NOTES ? process.env.KNUAF_E2E_RELEASE_NOTES : isPackaged ? join(process.resourcesPath, 'release-notes') : join(appRoot, 'release-notes')
    const notes = [...notesAt(appDir, 'app'), ...notesAt(join(skillDir, 'notes'), 'skill')]
      .filter(n => { const v = current[n.kind]; return v !== null && compare(n.version, v) <= 0 })
      .sort((a, b) => b.date.localeCompare(a.date) || (a.kind === b.kind ? compare(b.version, a.version) : a.kind === 'app' ? -1 : 1))
    const settings = loadSettings()
    const seen = memorySeen ?? initialSeen(settings, current, notes)
    if (!memorySeen) {
      if (settings.release_notes_seen) memorySeen = settings.release_notes_seen
      else remember(seen)
    }
    const unread = notes.filter(n => { const v = seen![n.kind]; return !!v && valid(v) && compare(n.version, v) > 0 })
    const major = unread.some(n => {
      const prior = seen![n.kind]!
      const [a, b] = n.version.split('.').map(Number), [x, y] = prior.split('.').map(Number)
      return n.major || !!n.action || (prior !== '0.0.0' && (a > x || (a === x && b > y)))
    })
    if (!startupVersions) { startupVersions = current; startupDialog = major }
    const mode = unread.length ? startupDialog && startupVersions.app === current.app && startupVersions.skill === current.skill ? 'dialog' : 'button' : 'none'
    return { ...current, notes, unread, mode }
  }
  // The renderer requests state at startup before onboarding saves its first-use settings.
  ipcMain.handle('news:state', () => {
    try { return read() }
    catch (error) {
      console.error('[knuaf] 새 소식 불러오기 실패', error)
      return { app: '', skill: null, mode: 'none', notes: [], unread: [] } satisfies NewsState
    }
  })
  ipcMain.handle('news:seen', (_event, versions: Versions) => {
    const current: Versions = { app: getVersion(), skill: skillVersion(resolveSkill()) }
    const previous = memorySeen ?? loadSettings().release_notes_seen
    const safe = (v: unknown, now: string | null, old: string | null | undefined): string | null => typeof v === 'string' && valid(v) && now && compare(v, now) <= 0 && (!old || compare(v, old) >= 0) ? v : old ?? null
    remember({ app: safe(versions?.app, current.app, previous?.app) ?? current.app, skill: safe(versions?.skill, current.skill, previous?.skill) })
  })
}
