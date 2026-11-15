/**
 * figures/watcher.ts — 폴더의 요청 칸을 **읽기만** 하며 한 건씩 넘긴다 (설계 §3, R4-1)
 *
 * 감시는 `fs.watch`가 아니라 **짧은 주기 재확인**이다. 요청 칸은 도우미가 만들기도 하고 없기도 하며
 * (폴더 첫 요청), `fs.watch`는 폴더가 바뀔 때 이벤트를 합쳐 보내고 맥·윈도 동작이 다르다. 0.75초
 * 재확인은 그 차이가 없고, 도우미의 60초 대기 안에 충분히 빠르다.
 *
 * 규칙:
 * - 앱 프로세스당 감시자 하나, **폴더당 동시 1건**. 앞 요청이 끝나야 다음을 집는다.
 * - `id`는 한 번 집으면 그 실행 동안 다시 집지 않는다(파일은 지우지 않는다 — 앱은 폴더에 안 쓴다).
 * - 집기 전 60초를 넘긴 요청은 `expired`로 넘긴다(도우미는 이미 기다리기를 그만뒀다).
 * - `.knuaf-gui/jobs/`(v0.7 담당 출력 칸) 아래는 **집지 않는다** — 담당이 네트워크를 얻지 않게.
 */

import { lstat, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { REQUEST_ID_RE } from './contract'
import { requestDir } from './request-file'

export interface FoundRequest {
  id: string
  path: string
  /** 집기 전에 만료됐다(결과는 `expired`). */
  expired: boolean
}

export interface ScanOptions {
  ttlMs?: number
  now?: () => number
  ignoreDir?: string
}

/**
 * 요청 칸을 한 번 훑어 **아직 안 집은** 요청을 파일 이름순으로 돌려준다. 내용은 집은 뒤
 * `readRequestFile`이 검사한다.
 */
export async function scan(folder: string, seen: ReadonlySet<string>, options: ScanOptions = {}): Promise<FoundRequest[]> {
  const dir = resolve(requestDir(folder))
  const ignore = resolve(options.ignoreDir ?? join(folder, '.knuaf-gui', 'jobs'))
  if (dir === ignore || dir.startsWith(`${ignore}/`)) return []
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const found: FoundRequest[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.req.json')) continue
    const id = basename(name, '.req.json')
    if (!REQUEST_ID_RE.test(id) || seen.has(id)) continue
    const path = join(dir, name)
    let info
    try {
      // lstat — 심볼릭 링크는 집지 않는다(링크 뒤의 내용을 요청으로 읽지 않게).
      info = await lstat(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    found.push({ id, path, expired: now() - info.mtimeMs > ttlMs })
  }
  return found
}

export interface Runner {
  stop(): void
  /** 지금 도는 요청이 끝날 때까지 기다린다(시험·종료). */
  idle(): Promise<void>
}

export interface RunnerOptions {
  folder: string
  /** 요청 하나 처리. 던져도 감시자는 계속 돈다. */
  handle: (item: FoundRequest) => Promise<void>
  scanMs?: number
  ttlMs?: number
  now?: () => number
}

/** 감시자 하나. `stop()`은 다음 훑기를 멈추고, 지금 도는 요청은 끝까지 둔다. */
export function runWatcher(options: RunnerOptions): Runner {
  const seen = new Set<string>()
  const scanMs = options.scanMs ?? 750
  let stopped = false
  let busy = false
  let wake: (() => void) | null = null
  let idleWaiters: Array<() => void> = []

  const settleIdle = (): void => {
    if (busy) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let items: FoundRequest[] = []
      try {
        items = await scan(options.folder, seen, { ttlMs: options.ttlMs, now: options.now })
      } catch {
        items = []
      }
      const next = items[0]
      if (next) {
        // 집은 id는 한 번만 — 만료분도 결과를 쓴 뒤 다시 집지 않는다.
        seen.add(next.id)
        busy = true
        try {
          await options.handle(next)
        } catch {
          /* 처리 실패는 요청 하나의 문제다. 다음 요청은 계속 집는다. */
        } finally {
          busy = false
          settleIdle()
        }
        continue
      }
      settleIdle()
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, scanMs)
        timer.unref?.()
        wake = () => {
          clearTimeout(timer)
          resolveSleep()
        }
      })
      wake = null
    }
    settleIdle()
  }
  void loop()

  return {
    stop() {
      stopped = true
      wake?.()
      wake = null
    },
    idle() {
      // 이미 멈췄고 도는 요청도 없으면 영원히 기다릴 이유가 없다.
      if (stopped && !busy) return Promise.resolve()
      // 지금 도는 요청(또는 훑기 한 번)이 끝나면 푼다.
      const { promise, resolve } = Promise.withResolvers<void>()
      idleWaiters.push(resolve)
      wake?.()
      return promise
    }
  }
}
