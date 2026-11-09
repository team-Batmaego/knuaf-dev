import type { PermissionFileChange } from '../../../shared/chat'

/** add/delete는 전체 내용, update는 unified diff. 헤더와 본문의 +/-를 구분한다. */
export function changedLines(change: PermissionFileChange): string[] {
  if (!change.diff) return []
  const lines = change.diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (change.kind.type === 'add' || change.kind.type === 'delete') {
    const prefix = change.kind.type === 'add' ? '+' : '-'
    return lines.map(line => `${prefix}${line}`)
  }
  if (change.kind.type !== 'update') return []
  const result: string[] = []
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; continue }
    // 파일별 diff이므로 첫 hunk 앞의 파일 헤더만 제외한다.
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) continue
    if (line.startsWith('+') || line.startsWith('-')) result.push(line)
  }
  return result
}
