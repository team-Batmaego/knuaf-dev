import { chapterOf } from '../../../shared/question'
import type { Zone } from '../../../shared/zone'
import type { SectionRow } from '../../../shared/types'

/** 질문 카드의 목적 장은 등록된 제목 접두어를 먼저, 순서를 그다음으로 찾는다. */
export function questionSection(zone: Zone, sections: SectionRow[] | null): SectionRow | null {
  if (zone.kind !== 'question') return null
  const chapter = chapterOf(zone.card.use)
  if (chapter === null) return null
  const rows = sections ?? []
  const titleChapter = (title: string): number | null => {
    const prefix = title.trim().match(/^(Ⅹ|Ⅸ|Ⅷ|Ⅶ|Ⅵ|Ⅴ|Ⅳ|Ⅲ|Ⅱ|Ⅰ|VIII|VII|VI|IX|IV|III|II|X|V|I)(?=$|[.．\s)장-])/u)?.[1]
    return prefix ? chapterOf(`${prefix}장`) : null
  }
  return rows.find((row) => titleChapter(row.title) === chapter) ?? rows.find((row) => row.order === chapter) ?? null
}


/** 접힌 칸에서 새 질문 대상이 생겼을 때만 점과 펼친 뒤 스크롤을 요청한다. */
export function foldedQuestionTarget(zone: Zone, sections: SectionRow[] | null, root: string | null, folded: boolean, previous: string | null): { key: string | null; sectionId: string | null } {
  const section = questionSection(zone, sections)
  const key = zone.kind === 'question' && section ? `${root}:${zone.messageId}:${section.id}` : null
  return { key, sectionId: folded && key && key !== previous ? section!.id : null }
}
/** 배경 파일 경로가 아니라 현재 보이는 점검 화면이 Escape를 받는다. */
export function closesPaperOverlay(key: string, sheet: string | null, paneTab: 'paper' | 'file'): boolean {
  return key === 'Escape' && sheet === 'checkup' && paneTab === 'paper'
}

/** 숨겨졌거나 문서에서 분리된 노드는 초점 복귀 후보가 아니다. */
export function firstVisibleFocus(candidates: Iterable<HTMLElement | null | undefined>): HTMLElement | null {
  for (const candidate of candidates) {
    if (candidate?.isConnected && candidate.offsetParent !== null) return candidate
  }
  return null
}
