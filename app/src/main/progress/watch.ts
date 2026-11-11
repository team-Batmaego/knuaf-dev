// progress (v0.6.4 2단계) — 논문 폴더 안 진행 파일의 안전 읽기와 폴더 감시.
//
// IMPL-T1 §4-2. **electron을 import하지 않는다** — node 시험(`e2e/progress-file.spec.ts`)이
// 이 모듈을 그대로 import해 F1~F4·F9를 잠근다. IPC 배선은 `./index.ts` 몫.
//
// 읽기 안전(중요 5, Roh 1회째 [차단] → 2·3회째 FAIL 고침):
// - 렌더러가 준 경로는 없다. main이 연 논문 root 아래 **고정 이름** 하나만 연다.
// - 판정 기준은 **경로 문자열이 아니라 실제로 들어간 폴더 객체**다. 순서:
//   ① `realpath(root)`와 그 폴더의 dev/ino(anchor)를 기억한다
//   ② `process.chdir(<rootReal>)` — **경로 해석 지점을 여기서 고정**한다
//   ③ `lstat('.')`의 dev/ino == ①의 anchor — chdir이 실제로 들어간 폴더가 그 폴더인가.
//     조상이 바꿔치기된 경로로 들어갔으면 여기서 걸린다(바꾼 뒤 곧바로 되돌린 ABA도 해당).
//   ④ `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`로 **상대 이름** `./.knuaf-progress.json`만 연다 —
//     조상 경로를 다시 걷지 않으므로 그 사이 바꿔치기가 끼어들 자리가 없다.
//   ⑤ **읽기 전에** `fstat(fd)`(일반 파일·64KB 이하·하드 링크 아님) + `lstat('./<이름>')`의
//     dev/ino == `fstat(fd)` + `lstat('.')` == anchor — 하나라도 다르면 **읽지 않고** 닫고 `null`
//   ⑥ 통과한 fd에서만 읽는다. ⑦ `finally`에서 cwd를 되돌린다.
// - 왜 경로 검사(A안)로는 안 되는가: 파일과 조상을 따로 재면 두 조회 사이에 틈이 생긴다.
//   반례 순서(책임자 확인): 조상을 바꾼 채 열고(fd=바깥) → `lstat(경로)`도 바뀐 상태라 일치 →
//   원복 → `realpath`·root 신원 재확인도 통과 → 바깥 read. `realpath`는 심볼릭 링크만 풀 뿐
//   진짜 폴더 **이름 바꾸기**에는 같은 문자열을 돌려주므로 이를 잡지 못한다(실측).
//   chdir로 폴더 **객체**를 붙잡으면 그 뒤 조상이 무엇으로 바뀌든 열기는 붙잡은 폴더 안에서만 일어난다.
// - 전제(깨지면 위험이 생긴다 — 코드가 지금은 지키지만 미래에 바뀌면 조용히 위험해진다):
//   ① 이 블록은 **동기 한 덩어리**다. chdir → 검사 → 열기 → 읽기 → 복원 사이에 `await`·
//     타이머·콜백이 끼면 다른 코드가 바뀐 cwd를 보게 된다(그래서 hooks도 전부 동기 함수다).
//   ② 앱 코드에 **상대 경로 fs 호출이 없다**(전수 grep 0건). 있다면 이 블록이 도는 순간
//     그 호출이 논문 폴더를 기준으로 풀린다.
//   ③ **worker_threads를 쓰지 않는다**(0건). 다른 스레드가 있으면 cwd 변경이 그쪽에 보인다.
//   이 셋 중 하나가 깨지면 이 방식은 더 이상 안전하지 않다 — 그때는 자식 프로세스(cwd 상속)로
//   옮겨야 한다(실측 비용 53.5ms/회로 감시마다 쓰기엔 너무 느려 지금은 쓰지 않는다).
// - cwd 복원에 실패하면 **이후 모든 읽기를 멈춘다**(`cwdUnrecoverable`). 복원 안 된 cwd를 안고
//   계속 도는 것보다 진행 표시를 멈추는 편이 안전하다 — 화면은 마지막 값/대화 값을 유지한다.
// - `O_NOFOLLOW` — 마지막 요소가 심볼릭 링크면 열기 자체가 실패한다(리눅스·맥).
// - `O_NONBLOCK` — 자리에 FIFO가 있으면 동기 open이 **멈춘다**(Roh 1회째 [중요]). 논블록으로 열어
//   fstat에서 일반 파일이 아님을 보고 즉시 거절한다. 일반 파일에는 아무 효과가 없다.
// - 윈도우도 **같은 방식**을 쓴다(`process.chdir`·`lstat('.')`은 윈도우에 있다). 다만
//   `O_NOFOLLOW`·`O_NONBLOCK`이 없고 POSIX FIFO도 없어서, 열기 전 `lstat('./<이름')`으로 링크·정션을
//   한 번 더 거른다. 최종 판정은 같은 fd 신원 대조다(open이 링크를 따라가도 경로 inode ≠ fd inode).
//   추가로 윈도우는 열린 파일이 든 폴더의 이름 바꾸기를 커널이 거부하므로 조상 바꿔치기 창 자체가 없다.
// - 어느 검사든 실패하면 `null` — "파일 없음"과 똑같이 다룬다(파서 → 저장값).
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, watch } from 'node:fs'
import type { FSWatcher, Stats } from 'node:fs'
import { constants } from 'node:fs'
import { parseProgressFile, PROGRESS_FILE_NAME, type ProgressFile } from '../../shared/progress-file'

/** 읽기 상한 — 이보다 큰 파일은 읽기 전에 거부한다(§4-2). */
export const PROGRESS_FILE_MAX_BYTES = 64 * 1024
/** 폴더 감시 이벤트를 모으는 시간. 임시 파일 → 이름 바꾸기 한 번에 한 번만 읽는다. */
export const PROGRESS_WATCH_DEBOUNCE_MS = 300

const isWindows = process.platform === 'win32'
const NO_FOLLOW = isWindows ? 0 : (constants.O_NOFOLLOW ?? 0)
const NONBLOCK = isWindows ? 0 : (constants.O_NONBLOCK ?? 0)

/** 폴더·파일의 실체 식별자. 경로 문자열은 이름이 바뀌어도 그대로라 기준이 될 수 없다. */
export interface Identity {
  dev: bigint | number
  ino: bigint | number
}

function identityOf(stat: Pick<Stats, 'dev' | 'ino'>): Identity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** cwd를 되돌리지 못한 상태. true가 되면 이후 읽기를 전부 포기한다(위 전제 ① 참조). */
let cwdUnrecoverable = false

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
 * **읽기 전** 판정 — 열어 둔 fd가 지금 cwd 안의 그 이름이고, cwd도 기억한 폴더인가.
 * cwd는 붙잡은 폴더 객체라 그 사이 조상이 무엇으로 바뀌어도 여기서 보는 '.'은 같은 폴더다.
 * `opened`는 호출자가 이미 받아 둔 `fstat(fd)` — 두 번 재지 않는다.
 */
function verifiedBeforeRead(opened: Stats, relativeName: string, anchor: Identity): boolean {
  if (!opened.isFile()) return false
  if (opened.size > PROGRESS_FILE_MAX_BYTES) return false
  // 이름이 둘 이상인 파일(하드 링크)은 폴더 밖 내용일 수 있다 — 읽지 않는다.
  // `0`은 링크 수를 못 세는 파일시스템이므로 >1만 거부한다(정상 파일 nlink=1).
  if (opened.nlink > 1) return false
  const fdIdentity = identityOf(opened)
  try {
    const file = lstatSync(relativeName)
    if (file.isSymbolicLink() || !file.isFile()) return false
    if (!sameIdentity(identityOf(file), fdIdentity)) return false
    const here = lstatSync('.')
    if (!here.isDirectory()) return false
    return sameIdentity(identityOf(here), anchor)
  } catch {
    return false
  }
}

/** 읽기 도중 상태를 바꿔 보는 주입 지점 — 시험이 '확인과 열기 사이 교체'를 그대로 재현한다. */
export interface ReadProgressHooks {
  /**
   * cwd를 옮기기 **직전**. 시험용: 이 시점에 조상을 바꿔 치면 chdir이 바뀐 곳으로 들어가고,
   * `lstat('.')` 대조에서 걸린다(책임자 지적의 'chdir 중 교체' 변형).
   */
  beforeChdir?: (rootReal: string) => void
  /**
   * cwd를 옮기고 `lstat('.')` 확인을 마친 **뒤, 열기 전**. 시험용: 이 시점에 바꿔 치고
   * 곧바로 되돌린다(Roh ABA 반례) — 열기는 붙잡은 폴더 안에서만 일어나야 한다.
   */
  beforeOpen?: (relativeName: string) => void
  /** 열기 직후·검증 전. 시험용. */
  afterOpen?: (relativeName: string) => void
  /** 검증을 통과한 뒤 실제 바이트를 읽는 함수. 시험용: 호출 횟수로 '읽기 0회'를 단언한다. */
  read?: (fd: number) => string | null
  /**
   * 감시 시작 때 기억한 폴더 신원. 없으면 이 호출 시점 값으로 잡는다.
   * 있으면 `lstat('.')`를 **그 값**과 대조하므로, 감시 도중 조상이 바꿔치기된 경우를 잡는다.
   */
  rootIdentity?: Identity
}

/**
 * 논문 폴더의 진행 파일을 검증해 읽는다. 없음·무효·안전 검사 실패는 전부 `null`.
 * `root`는 논문 폴더 경로(이미 realpath여도 된다).
 */
export function readProgressFile(root: string, hooks: ReadProgressHooks = {}): ProgressFile | null {
  // cwd를 되돌린 적이 없으면 경로 기준 읽기 자체를 하지 않는다(위 전제 ①).
  if (cwdUnrecoverable) return null

  let rootReal: string
  let anchor: Identity
  try {
    rootReal = realpathSync(root)
    const stat = lstatSync(rootReal)
    if (!stat.isDirectory()) return null
    anchor = hooks.rootIdentity ?? identityOf(stat)
  } catch {
    return null
  }

  let previousCwd: string
  try {
    previousCwd = process.cwd()
  } catch {
    return null
  }

  const relativeName = `./${PROGRESS_FILE_NAME}`
  hooks.beforeChdir?.(rootReal)

  let fd: number | null = null
  try {
    // ① 경로 해석 지점을 여기서 고정한다 — 이 뒤로는 조상 경로를 걷지 않는다.
    process.chdir(rootReal)

    // ② 실제로 들어간 폴더가 기억한 그 폴더인가. 조상이 바꿔치기됐으면 여기서 걸린다
    //    (바꾼 뒤 곧바로 되돌린 ABA도 포함 — 되돌리기는 이미 들어간 폴더 객체를 못 바꾼다).
    if (!sameIdentity(identityOf(lstatSync('.')), anchor)) return null

    // 윈도우만: `O_NOFOLLOW`가 없어 open이 링크·정션을 따라간다 — 열기 전에 한 번 거른다.
    // 최종 판정은 아래 fd 신원 대조이므로 이 검사는 빠른 거절용이다.
    let expected: Identity | null = null
    if (isWindows) {
      try {
        const before = lstatSync(relativeName)
        if (before.isSymbolicLink() || !before.isFile()) return null
        expected = identityOf(before)
      } catch {
        return null
      }
    }

    hooks.beforeOpen?.(relativeName)

    try {
      fd = openSync(relativeName, constants.O_RDONLY | NO_FOLLOW | NONBLOCK)
    } catch {
      return null
    }

    hooks.afterOpen?.(relativeName)
    const opened = fstatSync(fd)
    // 판정은 **읽기 전**에 끝난다 — 통과해야 그 fd에서 읽는다(Roh 2회째 [차단]).
    if (expected !== null && !sameIdentity(identityOf(opened), expected)) return null
    if (!verifiedBeforeRead(opened, relativeName, anchor)) return null
    // cwd에 기대지 않는 **경로 쪽 재확인**. cwd가 고정돼 있어 이 검사가 없어도 폴더 밖은
    // 안 읽히지만, 조상이 **지금 바꿔치기된 상태**면 재확인에서 걸러 읽지도 않는다(빈틈 최소화).
    // 조상이 바꿔치기됐다가 **검사 사이에 원복**된 경우는 경로 문자열이 같아 원리상 구별되지
    // 않는다 — 그때도 읽히는 것은 붙잡아 둔 폴더의 파일뿐이라 바깥 값은 나오지 않는다.
    if (!sameIdentity(identityOf(lstatSync(rootReal)), anchor)) return null
    const text = (hooks.read ?? readBounded)(fd)
    if (text === null) return null
    return parseProgressFile(text)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 이미 닫혔거나 무효 — 무시 */
      }
    }
    // 복원은 반드시 한다. 실패하면 이후 읽기를 멈춘다 — 복원 안 된 cwd로 계속 도는 게 더 위험하다.
    try {
      process.chdir(previousCwd)
    } catch (error) {
      cwdUnrecoverable = true
      console.error(
        `[knuaf] 작업 폴더를 되돌리지 못해 진행 파일 읽기를 멈춥니다: ${previousCwd} ` +
          `(${(error as NodeJS.ErrnoException)?.code ?? String(error)})`
      )
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
  /** 감시 시작 때 붙잡은 폴더 신원 — 이후 조상이 바뀌면 이 값과 달라져 읽기가 거절된다. */
  let anchor: Identity
  try {
    rootReal = realpathSync(root)
    const stat = lstatSync(rootReal)
    if (!stat.isDirectory()) return () => {}
    anchor = identityOf(stat)
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
      onChange(readProgressFile(rootReal, { rootIdentity: anchor }))
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
