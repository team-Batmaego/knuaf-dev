import type { PermissionFileChange } from '../../../shared/chat'
import { Disclosure } from './Disclosure'
import { changedLines } from './fileChangeLines'
import { CHAT } from '../copy'

const kindLabel: Record<PermissionFileChange['kind']['type'], string> = {
  add: '새 파일', delete: '파일 삭제', update: '파일 수정', unknown: '변경'
}

export function FileChangePreview({ changes }: { changes: PermissionFileChange[] }) {
  return <div className="file-changes" role="region" aria-label="변경할 파일과 내용" tabIndex={0}>
    <div className="caption">+ 추가되는 줄　− 없어지는 줄</div>
    {changes.map((change, index) => {
      const lines = changedLines(change)
      const preview = lines.slice(0, 4)
      const remaining = lines.slice(4)
      const moved = change.kind.type === 'update' ? change.kind.move_path : null
      return <section className="file-change" key={`${change.path}-${index}`}>
        <div className="file-change-heading"><span>{kindLabel[change.kind.type]}</span><strong>{change.path}</strong></div>
        {moved && <div className="file-change-move">옮길 위치: {moved}</div>}
        {lines.length > 0 ? <>
          <pre className="file-change-lines">{preview.join('\n')}</pre>
          {remaining.length > 0 && <Disclosure label={CHAT.fileChangeMore}>
            <pre className="file-change-lines">{remaining.join('\n')}</pre>
          </Disclosure>}
        </> : <div className="caption">{change.diff === '' && (change.kind.type === 'add' || change.kind.type === 'delete')
          ? '빈 파일이에요.' : '바뀐 줄을 확인하지 못했어요. 거절한 뒤 도우미에게 확인해 주세요.'}</div>}
      </section>
    })}
  </div>
}
