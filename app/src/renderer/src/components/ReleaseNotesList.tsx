import type { NewsState, ReleaseNote } from '../../../shared/types'
import { NEWS } from '../copy-news'
import './news.css'

export function ReleaseNotesList({ state, notes = state.notes, current = true }: { state: NewsState; notes?: ReleaseNote[]; current?: boolean }) {
  return <div className="release-history">
    {current && <div className="release-current"><div>{NEWS.currentApp} <strong>{state.app}</strong></div><div>{NEWS.currentSkill} <strong>{state.skill ?? NEWS.unknown}</strong></div></div>}
    {notes.length === 0 && <p>{NEWS.empty}</p>}
    {notes.map(note => <article className="release-entry" key={`${note.kind}-${note.version}`}>
      <div className="release-heading"><strong>{note.kind === 'app' ? NEWS.app : NEWS.skill} {note.version}</strong><span>{note.date}</span></div>
      {note.action && <div className="release-action"><strong>{NEWS.action}</strong><div>{note.action}</div></div>}
      <ul>{note.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </article>)}
  </div>
}
