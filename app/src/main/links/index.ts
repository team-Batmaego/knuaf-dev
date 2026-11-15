// link (v0.6.4 ⑤) — `link:open` 하나. 대화 속 http(s) 주소를 **사용자가 누른 때만** 기본 브라우저로 연다.
//
// 렌더러는 주소만 준다. 여는 곳은 여기 하나뿐이고, 열기 전에 `checkExternalLink`로 다시 본다
// (`main/links/validate.ts`). 거부하면 `openExternal`을 아예 부르지 않고 이유만 돌려준다 —
// 조용히 성공했다고 답하지 않는다.
//
// `ipcMain`·`shell.openExternal`은 **값으로 import하지 않고 인자로 받는다**: node 시험이 `ipc.ts`를
// 가짜 electron으로 띄우므로(`e2e/preparation-main.spec.ts`) 이 모듈이 진짜 electron을 잡으면 터진다.
// ④의 `registerProgressIpc`와 같은 이유·같은 모양이다.
import type { LinkOpenReply } from '../../shared/link'
import { checkExternalLink } from './validate'

/** `ipcMain` 중 이 모듈이 쓰는 부분만. */
export interface LinkIpcHost {
  handle: (channel: string, listener: (_event: unknown, url: unknown) => unknown) => void
}

/**
 * `link:open` 등록. `openExternal`은 성공하면 끝나고 실패하면 던지는 함수
 * (`shell.openExternal` 그대로). 열기 실패도 예외로 던지지 않고 이유로 바꾼다 — 화면은 같은 결로 안내한다.
 */
export function registerLinkIpc(openExternal: (url: string) => Promise<unknown>, host: LinkIpcHost): void {
  host.handle('link:open', async (_event, url): Promise<LinkOpenReply> => {
    const check = checkExternalLink(url)
    if (!check.ok) return { result: { opened: false, reason: check.reason } }
    try {
      await openExternal(check.url)
      return { result: { opened: true } }
    } catch {
      return { result: { opened: false, reason: 'open_failed' } }
    }
  })
}
