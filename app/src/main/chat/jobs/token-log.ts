import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 한 턴의 토큰 사용량을 논문 폴더의 `.knuaf-gui/token-usage-<provider>.jsonl` 에 한 줄 덧붙인다.
 * 대화별로 나중에 합산하기 쉽게 JSONL 로 두고, 학생 글은 담지 않는다(숫자·식별자만).
 *
 * **던지지 않는다** — 기록을 못 썼다고 도우미의 턴이 실패하면 안 된다(`rejectLog` 와 같은 계약).
 */
export function appendTokenRecord(root: string, provider: 'claude' | 'codex', record: object): void {
  try {
    const file = join(root, '.knuaf-gui', `token-usage-${provider}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Best-effort: recording failure must not block chat.
  }
}
