// progress (v0.6.4 2단계) — 논문 폴더 안 진행 파일의 안전 읽기와 폴더 감시.
//
// IMPL-T1 §4-2. **electron을 import하지 않는다** — node 시험(`e2e/progress-file.spec.ts`)이
// 이 모듈을 그대로 import해 F1~F4·F9를 잠근다. IPC 배선은 `./index.ts` 몫.
//
// 읽기 안전(중요 5):
// - 렌더러가 준 경로는 없다. main이 연 논문 root 아래 **고정 이름** 하나만 연다.
// - `O_NOFOLLOW`로 연다 — 마지막 요소가 심볼릭 링크면 열기 자체가 실패한다.
// - 연 fd에 `fstat` → 일반 파일인지, 64KB 이하인지 **읽기 전에** 본다. 읽기는 같은 fd로만.
// - 읽은 뒤 `realpath(파일)`의 상위가 `realpath(root)`와 같은지 다시 본다.
// - 윈도우는 `O_NOFOLLOW`가 없어 열기 전 `lstat`(링크·정션 거부) + `fstat` dev·ino 대조.
// - 어느 검사든 실패하면 `null` — "파일 없음"과 똑같이 다룬다(파서 → 저장값).
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseProgressFile, PROGRESS_FILE_NAME, type ProgressFile } from '../../shared/progress-file'

/** 읽기 상한 — 이보다 큰 파일은 읽기 전에 거부한다(§4-2). */
export const PROGRESS_FILE_MAX_BYTES = 64 * 1024
/** 폴더 감시 이벤트를 모으는 시간. 임시 파일 → 이름 바꾸기 한 번에 한 번만 읽는다. */
export const PROGRESS_WATCH_DEBOUNCE_MS = 300

const isWindows = process.platform === 'win32'
const NO_FOLLOW = isWindows ? 0 : (constants.O_NOFOLLOW ?? 0)

interface Identity {
  dev: bigint | number
  ino: bigint | number
}

function identityOf(stat: { dev: bigint | number; ino: bigint | number }): Identity {
  return { dev: stat.dev, ino: stat.ino }
}

/**
 * 열린 fd에서 최대 `PROGRESS_FILE_MAX_BYTES`까지만 읽는다.
 * fstat 크기와 실제 읽은 양이 다를 수 있으므로(그사이 커짐) 읽는 동안에도 상한을 지킨다.
 */
function readBounded(fd: number): string | null {
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.alloc(8192)
  while (total <= PROGRESS_FILE_MAX_BYTES) {
    const read = readSync(fd, buffer, 0, buffer.length, null)
    if (read === 0) break
    total += read
    if (total > PROGRESS_FILE_MAX_BYTES) return null
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * 논문 폴더의 진행 파일을 검증해 읽는다. 없음·무효·안전 검사 실패는 전부 `null`.
 * `root`는 논문 폴더 경로(이미 realpath여도 된다).
 */
export function readProgressFile(root: string): ProgressFile | null {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return null
  }
  const path = join(rootReal, PROGRESS_FILE_NAME)

  let expected: Identity | null = null
  if (isWindows) {
    try {
      const before = lstatSync(path)
      // 링크·정션이면 열지도 않는다.
      if (before.isSymbolicLink() || !before.isFile()) return null
      expected = identityOf(before)
    } catch {
      return null
    }
  }

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  } catch {
    return null
  }

  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    if (stat.size > PROGRESS_FILE_MAX_BYTES) return null
    if (expected !== null) {
      const actual = identityOf(stat)
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) return null
    }
    const text = readBounded(fd)
    if (text === null) return null
    let fileReal: string
    try {
      fileReal = realpathSync(path)
    } catch {
      return null
    }
    if (dirname(fileReal) !== rootReal) return null
    return parseProgressFile(text)
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 이미 닫혔거나 무효 — 무시 */
    }
  }
}

export interface ProgressWatchOptions {
  /** 감시할 논문 폴더. realpath 실패면 감시하지 않는다(해제 함수만 돌려준다). */
  root: string
  /** 이벤트를 모은 뒤(300ms) 읽은 값. 파일이 사라졌으면 `null`. */
  onChange: (progress: ProgressFile | null) => void
}

/**
 * 논문 **폴더**를 감시한다 — 파일 감시는 임시 파일 → 이름 바꾸기 교체에서 끊긴다(§4-2).
 * 이벤트의 파일 이름이 `.knuaf-progress.json`일 때만 300ms 모아 다시 읽는다.
 * 돌려주는 함수는 감시를 닫고 대기 중인 재읽기를 취소한다.
 */
export function watchProgressFile({ root, onChange }: ProgressWatchOptions): () => void {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return () => {}
  }

  let timer: NodeJS.Timeout | undefined
  let disposed = false
  let watcher: FSWatcher
  try {
    // `persistent:false` — 감시가 node 시험의 종료를 붙잡지 않는다. 참조가 살아 있는 동안은
    // Electron 안에서도 이벤트를 계속 받는다.
    watcher = watch(rootReal, { recursive: false, persistent: false })
  } catch {
    return () => {}
  }

  watcher.on('error', () => {
    // 감시가 죽어도 화면은 마지막 값(또는 대화 값)을 유지한다. 다시 걸지 않는다 —
    // 대화 `running → idle` 전환마다 렌더러가 `progress:get`을 한 번 부르는 보루가 있다.
  })

  watcher.on('change', (_event, filename) => {
    if (disposed) return
    // 파일 이름이 없을 수 있는 플랫폼 — 그때는 모르는 이벤트라 버린다(쓸데없는 재읽기 금지).
    if (filename === null || String(filename) !== PROGRESS_FILE_NAME) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (disposed) return
      onChange(readProgressFile(rootReal))
    }, PROGRESS_WATCH_DEBOUNCE_MS)
  })

  return () => {
    disposed = true
    clearTimeout(timer)
    timer = undefined
    try {
      watcher.close()
    } catch {
      /* 이미 닫힘 — 무시 */
    }
  }
}
