// progress (v0.6.4 2단계) — 논문 폴더 안 진행 파일의 안전 읽기와 폴더 감시.
//
// IMPL-T1 §4-2. **electron을 import하지 않는다** — node 시험(`e2e/progress-file.spec.ts`)이
// 이 모듈을 그대로 import해 F1~F4·F9를 잠근다. IPC 배선은 `./index.ts` 몫.
//
// 읽기 안전(중요 5, Roh 1회째 [차단] → 2회째 확인 FAIL 고침):
// - 렌더러가 준 경로는 없다. main이 연 논문 root 아래 **고정 이름** 하나만 연다.
// - 판정은 **연 fd 기준**이고, **읽기 전**에 끝난다(Roh 2회째). 순서:
//   ① `realpath(root)`의 dev/ino를 기억한다 ② `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`로 연다
//   ③ **읽기 전에** `fstat(fd)`(일반 파일·64KB 이하·하드 링크 아님) + `lstat(<rootReal>/.knuaf-progress.json)`의
//     dev/ino == `fstat(fd)`의 dev/ino + `lstat(rootReal)`의 dev/ino == ①의 값 — 하나라도 다르면
//     **읽지 않고** 닫고 `null` ④ 통과하면 그 fd에서 읽는다. fd는 이미 검증된 파일 객체라
//     이후 경로가 바뀌어도 읽는 바이트는 그 검증된 파일의 것이다(폴더 밖 내용이 섞이지 않는다).
// - 이전 구조(읽은 **뒤** 검사)는 폴더 밖 파일을 읽고 나서 버렸다 — 값은 안 새지만 "한 바이트도
//   읽지 않음" 기준을 못 채웠다(Roh 반례: 외부 260바이트가 실제로 읽힘). 그래서 순서를 뒤집었다.
// - `O_NOFOLLOW` — 마지막 요소가 심볼릭 링크면 열기 자체가 실패한다(리눅스·맥).
// - `O_NONBLOCK` — 자리에 FIFO가 있으면 동기 open이 **멈춘다**(Roh 1회째 [중요]). 논블록으로 열어
//   fstat에서 일반 파일이 아님을 보고 즉시 거절한다. 일반 파일에는 아무 효과가 없다.
// - 윈도우는 `O_NOFOLLOW`·`O_NONBLOCK`이 없다(POSIX FIFO도 없다 — 이름 있는 파이프는 경로 open으로
//   열리지 않는다). 그래서 열기 전 `lstat`(링크·정션 거부)을 한 번 더 하고, 최종 판정은 위의
//   '읽기 전 fd 신원 대조'가 한다 — open이 링크를 따라가도 경로의 inode와 fd의 inode가 달라 걸린다.
// - 어느 검사든 실패하면 `null` — "파일 없음"과 똑같이 다룬다(파서 → 저장값).
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, watch } from 'node:fs'
import type { FSWatcher, Stats } from 'node:fs'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { parseProgressFile, PROGRESS_FILE_NAME, type ProgressFile } from '../../shared/progress-file'

/** 읽기 상한 — 이보다 큰 파일은 읽기 전에 거부한다(§4-2). */
export const PROGRESS_FILE_MAX_BYTES = 64 * 1024
/** 폴더 감시 이벤트를 모으는 시간. 임시 파일 → 이름 바꾸기 한 번에 한 번만 읽는다. */
export const PROGRESS_WATCH_DEBOUNCE_MS = 300

const isWindows = process.platform === 'win32'
const NO_FOLLOW = isWindows ? 0 : (constants.O_NOFOLLOW ?? 0)
const NONBLOCK = isWindows ? 0 : (constants.O_NONBLOCK ?? 0)

interface Identity {
  dev: bigint | number
  ino: bigint | number
}

function identityOf(stat: Pick<Stats, 'dev' | 'ino'>): Identity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino
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
 * **읽기 전** 판정 — 지금 이 경로가 열어 둔 그 파일이고, 폴더도 그대로인가.
 * `fd`의 dev/ino와 경로의 dev/ino가 같아야 한다. 폴더가 바뀌었으면(교체) 통째로 거절한다.
 * 통과하면 이후 경로가 바뀌어도 fd가 가리키는 객체는 그대로이므로 읽기가 안전하다.
 * `opened`는 호출자가 이미 받아 둔 `fstat(fd)` — 두 번 재지 않는다.
 */
function verifiedBeforeRead(
  opened: Stats, path: string, rootReal: string, rootIdentity: Identity
): boolean {
  if (!opened.isFile()) return false
  if (opened.size > PROGRESS_FILE_MAX_BYTES) return false
  // 이름이 둘 이상인 파일(하드 링크)은 폴더 밖 내용일 수 있다 — 읽지 않는다.
  // `0`은 링크 수를 못 세는 파일시스템이므로 >1만 거부한다(정상 파일 nlink=1).
  if (opened.nlink > 1) return false
  const fdIdentity = identityOf(opened)
  try {
    const file = lstatSync(path)
    if (file.isSymbolicLink() || !file.isFile()) return false
    if (!sameIdentity(identityOf(file), fdIdentity)) return false
    const root = lstatSync(rootReal)
    if (!root.isDirectory()) return false
    return sameIdentity(identityOf(root), rootIdentity)
  } catch {
    return false
  }
}

/** 읽기 도중 상태를 바꿔 보는 주입 지점 — 시험이 '확인과 열기 사이 교체'를 그대로 재현한다. */
export interface ReadProgressHooks {
  /** 열기 직전. 시험용: 이 시점에 상위 폴더를 바꿔 치기한다. 제품 경로는 넘기지 않는다. */
  beforeOpen?: (path: string) => void
  /** 열기 직후·검증 전. 시험용: 바꿔 치기를 곧바로 되돌린다(Roh 반례 그대로). */
  afterOpen?: (path: string) => void
  /** 검증을 통과한 뒤 실제 바이트를 읽는 함수. 시험용: 호출 횟수로 '읽기 0회'를 단언한다. */
  read?: (fd: number) => string | null
}

/**
 * 논문 폴더의 진행 파일을 검증해 읽는다. 없음·무효·안전 검사 실패는 전부 `null`.
 * `root`는 논문 폴더 경로(이미 realpath여도 된다).
 */
export function readProgressFile(root: string, hooks: ReadProgressHooks = {}): ProgressFile | null {
  let rootReal: string
  let rootIdentity: Identity
  try {
    rootReal = realpathSync(root)
    const stat = lstatSync(rootReal)
    if (!stat.isDirectory()) return null
    rootIdentity = identityOf(stat)
  } catch {
    return null
  }
  const path = join(rootReal, PROGRESS_FILE_NAME)

  // 윈도우만: `O_NOFOLLOW`가 없어 open이 링크·정션을 따라간다 — 열기 전에 한 번 거른다.
  // 최종 판정은 아래 fd 신원 대조이므로 이 검사는 빠른 거절용이다.
  let expected: Identity | null = null
  if (isWindows) {
    try {
      const before = lstatSync(path)
      if (before.isSymbolicLink() || !before.isFile()) return null
      expected = identityOf(before)
    } catch {
      return null
    }
  }

  hooks.beforeOpen?.(path)

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NONBLOCK)
  } catch {
    return null
  }

  try {
    hooks.afterOpen?.(path)
    const opened = fstatSync(fd)
    // 판정은 **읽기 전**에 끝난다 — 통과해야 그 fd에서 읽는다(Roh 2회째 [차단]).
    if (expected !== null && !sameIdentity(identityOf(opened), expected)) return null
    if (!verifiedBeforeRead(opened, path, rootReal, rootIdentity)) return null
    const text = (hooks.read ?? readBounded)(fd)
    if (text === null) return null
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
