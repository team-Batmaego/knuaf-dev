import type { Envelope } from '../../../shared/types'
import { FORMULA_HELD } from '../copy'

export interface ResultCardProps { env: Envelope; onReveal?: (path: string) => void; onOpen?: (path: string) => void }

type Verdict = 'ok' | 'blocked' | 'held' | 'fail'

function verdict(env: Envelope): Verdict {
  if (env.ok) return 'ok'
  if (env.block_reason && Object.hasOwn(FORMULA_HELD, env.block_reason)) return 'held'
  if (env.status === 'blocked' || env.block_reason) return 'blocked'
  return 'fail'
}

const TITLE: Record<Verdict, string> = { ok: '완료', blocked: '아직 확인 못 함', held: '멈춤', fail: '실패' }

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}초` : `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`
}

/** Outcome of one script run, in plain words: what happened, where the file is, why it stopped. */
export function ResultCard({ env, onReveal, onOpen }: ResultCardProps) {
  const v = verdict(env)
  const heldText = v === 'held' ? FORMULA_HELD[env.block_reason as keyof typeof FORMULA_HELD] : null
  const detail = env.detail && typeof env.detail === 'object' ? env.detail as Record<string, unknown> : null
  const cells = Array.isArray(detail?.cells) ? detail.cells.filter((cell): cell is string => typeof cell === 'string') : []
  const hasData = env.data != null && !(typeof env.data === 'object' && env.data !== null && Object.keys(env.data as object).length === 0)
  const showStderr = v !== 'ok' && v !== 'held' && !!env.stderr
  return (
    <div className={`result result-${v}`}>
      <div className="result-head">
        <strong>{TITLE[v]}</strong>
        {env.status && v !== 'held' && <span className="result-status">{env.status}</span>}
        <span className="result-meta">{duration(env.duration_ms)}{env.exit !== 0 ? ` · 종료 코드 ${env.exit}` : ''}</span>
      </div>
      {(heldText || env.block_reason) && <p className="result-reason">{heldText || env.block_reason}</p>}
      {v === 'held' && cells.length > 0 && <ul className="result-cells">{cells.map((cell, index) => <li key={index}>{cell}</li>)}</ul>}
      {env.path && (
        <div className="result-path">
          <code>{env.path}</code>
          {onOpen && v === 'ok' && <button type="button" className="primary" onClick={() => onOpen(env.path!)}>열기</button>}
          {onReveal && <button type="button" onClick={() => onReveal(env.path!)}>폴더에서 보기</button>}
        </div>
      )}
      {v !== 'held' && (hasData || showStderr) && (
        <details>
          <summary>자세히</summary>
          {hasData && <pre>{JSON.stringify(env.data, null, 2)}</pre>}
          {showStderr && <pre className="stderr">{env.stderr}</pre>}
        </details>
      )}
    </div>
  )
}
