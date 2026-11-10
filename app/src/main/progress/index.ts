// progress (v0.6.4 2단계) — 진행 파일 IPC: `progress:get` / `progress:changed`.
//
// IMPL-T1 §4-2. 렌더러는 **경로를 넘기지 않는다** — main이 연 논문(`getRoot()`)만 읽고 감시한다.
// 그래서 `progress:watch`가 없다(렌더러가 감시 대상을 고를 이유가 없다).
// `follow(root)`는 논문 열기가 성공한 순간(`ipc.ts`)에만 불린다: 이전 감시를 닫고 새로 건다.
import type { BrowserWindow } from 'electron'
import type { ProgressFile } from '../../shared/progress-file'
import { readProgressFile, watchProgressFile } from './watch'

/**
 * `ipcMain` 중 이 모듈이 쓰는 부분만. **값으로 import하지 않고 인자로 받는다** — node 시험이
 * `ipc.ts`를 그대로 띄울 때(`e2e/preparation-main.spec.ts`, 가짜 electron 주입) 이 모듈이
 * 진짜 electron을 잡으면 `ipcMain.handle`이 없어 터진다.
 */
export interface ProgressIpcHost {
  handle: (channel: string, listener: () => unknown) => void
}

/** `progress:changed`가 나르는 값 — 어느 논문의 값인지 같이 보낸다(늦은 이벤트 판정은 main 몫). */
export interface ProgressChanged {
  root: string
  progress: ProgressFile | null
}

export interface ProgressIpc {
  /** 논문 전환이 성공했을 때 감시를 새 논문으로 옮긴다. 같은 root면 그대로 둔다. */
  follow: (root: string) => void
}

/**
 * IPC 등록 + 감시 관리. `getRoot`는 지금 열린 논문 폴더(main만 안다).
 * 등록하는 채널은 `progress:` 접두어 두 개뿐이다.
 */
export function registerProgressIpc(
  getRoot: () => string | null,
  win: () => BrowserWindow | null,
  host: ProgressIpcHost,
): ProgressIpc {
  let watchedRoot: string | null = null
  let stopWatch: (() => void) | null = null

  host.handle('progress:get', () => {
    const root = getRoot()
    return { result: root === null ? null : readProgressFile(root) }
  })

  return {
    follow: (root) => {
      if (watchedRoot === root) return
      stopWatch?.()
      watchedRoot = root
      stopWatch = watchProgressFile({
        root,
        onChange: (progress) => {
          // 늦게 도착한 옛 폴더 이벤트는 버린다(감시를 이미 바꿨다면 root가 다르다).
          if (watchedRoot !== root) return
          const payload: ProgressChanged = { root, progress }
          win()?.webContents.send('progress:changed', payload)
        }
      })
    }
  }
}
