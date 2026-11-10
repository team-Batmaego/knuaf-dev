/**
 * §4-1 본대화 인계 줄 — `ConversationHandoff` 의 제안 상태를 계약 `LaneLine` 으로 옮긴다.
 *
 * 인계 묶음은 main 이 짓고(`buildHandoffBundle`) 화면은 줄만 그린다(계약 §6). 줄은 셋이다:
 * - 열린 제안 → `main-limit-offer` ([이어서 하기]·[나중에]). 묶음을 만들지 못했으면
 *   `tooLong:true` — 그때는 [새 대화로 시작]만 보인다(REVIEW-C0 중요 4).
 * - 누른 뒤 넘기는 중 → `handoff-running` (단추 없음).
 * - 넘기지 못함 → `handoff-failed` ([다시 하기]·[나중에]).
 *
 * 보관 대화는 성공한 인계만 센다 — 넘기지 못한 제안은 보관이 아니다.
 */
import type { LaneLine, ModelRef } from '../../shared/lanes-ipc'
import type { ConversationProposal } from '../chat/jobs/conversation'

/** 제안의 회사·모델·깊이 — `entry.model` 이 `null` 이면 빈 문자열(계약 `ModelRef.model`). */
function targetOf(proposal: ConversationProposal): ModelRef {
  return {
    company: proposal.entry.company,
    model: proposal.entry.model ?? '',
    effort: proposal.entry.effort
  }
}

/** 이 폴더의 인계 줄. 제안 순서(넘긴 순)를 지키고 화면이 `at` 으로 다시 정렬한다. */
export function handoffLines(root: string, proposals: ConversationProposal[]): LaneLine[] {
  const lines: LaneLine[] = []
  for (const proposal of proposals) {
    if (proposal.root !== root) continue
    const id = `handoff:${proposal.proposalId}`
    const to = targetOf(proposal)
    if (proposal.state === 'open') {
      lines.push({
        id, kind: 'main-limit-offer', tier: 2, at: proposal.shownAt, dismissible: false,
        proposalId: proposal.proposalId, to, tooLong: proposal.tooLong, trimmed: proposal.trimmed
      })
      continue
    }
    if (proposal.state === 'running') {
      lines.push({
        id, kind: 'handoff-running', tier: 3, at: proposal.clickedAt ?? proposal.shownAt,
        dismissible: false, to
      })
      continue
    }
    if (proposal.state === 'failed') {
      lines.push({
        id, kind: 'handoff-failed', tier: 2, at: proposal.clickedAt ?? proposal.shownAt,
        dismissible: false, proposalId: proposal.proposalId, to
      })
    }
  }
  return lines
}
