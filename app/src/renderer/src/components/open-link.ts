// link (v0.6.4 ⑤) — 답변 속 링크 단추가 누를 때 하는 일. 화면 부품에서 떼어 두는 이유는
// 시험이 클릭 없이 **호출 자체**를 잠글 수 있게 하기 위해서다(실제 브라우저는 열지 않는다).
//
// 이 함수는 판단하지 않는다: 주소가 http(s)인지·안전한지는 main(`main/links/validate.ts`)이
// 다시 본다. 여기서는 **실패를 삼키지 않고** `false`로 돌려주기만 한다 — 화면이 짧게 안내한다.
import type { LinkOpenReply } from '../../../shared/link'

export interface LinkApi {
  open: (url: string) => Promise<LinkOpenReply>
}

/** 열렸으면 `true`. 통로가 없거나(main 없이 그린 화면·구형 preload) 거부·실패면 `false`. */
export async function openChatLink(url: string, api: LinkApi | undefined): Promise<boolean> {
  if (!api) return false
  try {
    const reply = await api.open(url)
    return reply?.result?.opened === true
  } catch {
    return false
  }
}
