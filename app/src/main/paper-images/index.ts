// paper-images — 종이 칸 그림 하나를 읽어 응답하는 **main 쪽 유일한 판정 지점**.
//
// 흐름: 마크다운 규칙이 `<img src="knuaf-img://paper/<인코딩한 상대 경로>">`를 만들고 →
// `index.ts`(main 진입점)가 `protocol.handle('knuaf-img', …)`로 이 모듈의 `handle`에 넘긴다 →
// 여기서 경로 검사(`./check.ts`) → realpath + 파일 신원(`main/file-identity.ts`)으로 **지금 연 논문
// 폴더 안**인지 확인 → 머리 바이트로 진짜 그림인지 확인 → 크기 상한 → `Response`.
//
// 왜 electron을 값으로 import하지 않는가: `ipc.ts`가 node 시험(`e2e/preparation-main.spec.ts`)에서
// 가짜 electron으로 뜬다. 이 모듈이 진짜 electron을 잡으면 그 시험이 터진다. `main/progress/`·
// `main/links/`와 같은 꼴 — electron이 아는 것은 `index.ts` 하나뿐이고, 여기는 `Request`/`Response`
// 전역만 쓴다(node 22 타입에 그대로 있다).
//
// 실패는 **전부 404**다. 이유를 화면에 내보내지 않는다: 실패한 `<img>`는 렌더러의 문서 리스너가
// "그림을 찾지 못했어요 · <경로>"로 바꾼다(`main.tsx`). 이유를 응답 본문에 실으면 그 문구로 새어
// 나가 경로가 두 번 보인다.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats
} from 'node:fs'
import { resolve } from 'node:path'
import { IMAGE_MAX_BYTES, imageMimeOfExtension } from '../../shared/paper-image'
import { insideByFileId } from '../file-identity'
import { checkImageRequest, imageMagicMatches } from './check'

/** 지금 연 논문 폴더(main만 안다) — `ipc.ts`의 `currentRoot` getter. */
export type RootGetter = () => string | null

/** 시험 전용 주입 자리. 제품(`ipc.ts`)은 넘기지 않는다. */
export interface PaperImagesHooks {
  /**
   * 파일을 열기 **직전**에 불린다 — "검사와 열기 사이" 교체 반례를 시험이 주입하는 자리다
   * (Roh R1 C-01). 여기서 경로를 바꿔도 열기·검증이 거절해야 한다.
   */
  beforeOpen?: (realPath: string) => void
}

export interface PaperImages {
  /** `protocol.handle('knuaf-img', …)`가 부르는 하나. 실패는 404로 닫는다. */
  handle: (request: Request) => Promise<Response>
}

/** 한 번에 동시에 읽는 그림 수 — 목록이 길어도 파일 핸들·메모리가 한꺼번에 몰리지 않게. */
export const MAX_INFLIGHT = 8

/** 머리 바이트 판정에 필요한 만큼만 먼저 읽는다(파일 전체를 두 번 읽지 않는다). */
const HEAD_BYTES = 16

const notFound = (): Response => new Response(null, { status: 404 })

/**
 * "같은 파일인가"를 판정하는 키.
 *
 * 파일 ID를 쓸 수 있으면(ino != 0) 볼륨+inode — 이름이 아니라 파일 자체의 신원이다.
 * exFAT·일부 네트워크 볼륨처럼 ino를 0으로 주는 곳에서는 크기+수정시각으로 물러난다. 그때도
 * 상위 폴더 교체는 realpath가 다른 리터럴 경로를 주므로 `insideByFileId`가 먼저 잡는다.
 */
const identityOf = (stats: BigIntStats): string =>
  stats.ino === 0n
    ? `time:${stats.dev}:${stats.size}:${stats.mtimeNs}`
    : `id:${stats.dev}:${stats.ino}`

export function createPaperImages(getRoot: RootGetter, hooks: PaperImagesHooks = {}): PaperImages {
  let inflight = 0

  const handle = async (request: Request): Promise<Response> => {
    const check = checkImageRequest(typeof request?.url === 'string' ? request.url : '')
    if (!check.ok) return notFound()

    // 지금 열린 논문 폴더 — 열린 폴더가 없으면 그릴 것도 없다.
    const root = getRoot()
    if (!root) return notFound()
    let rootReal: string
    try {
      rootReal = realpathSync(resolve(root))
    } catch {
      return notFound()
    }

    // 폴더 안 판정: 문자열 접두어가 아니라 **실제 파일 신원**(조상 사슬)으로 본다. 심링크·정션으로
    // 폴더 밖을 가리키면 realpath가 밖 경로를 주고, 그 사슬에는 root의 신원이 없다(거절).
    let real: string
    try {
      real = realpathSync(resolve(rootReal, check.rel))
    } catch {
      return notFound()
    }
    if (!insideByFileId(rootReal, real)) return notFound()

    if (inflight >= MAX_INFLIGHT) return notFound()
    inflight++
    try {
      // 열기 전 lstat은 디렉터리·장치 파일·깨진 링크를 거른다. realpath를 이미 풀었으므로 여기서
      // 보는 것은 최종 대상이다.
      let stat
      try {
        stat = lstatSync(real)
      } catch {
        return notFound()
      }
      if (!stat.isFile()) return notFound()
      if (stat.size <= 0 || stat.size > IMAGE_MAX_BYTES) return notFound()

      // 검사한 경로와 실제로 여는 대상이 같은 순간인지 보장할 수 없다. 열기 직전 갈라진 자리는
      // 시험만 주입한다(제품은 훅 없음).
      hooks.beforeOpen?.(real)

      // 마지막 이름은 따라가지 않고 연다 — 검사한 이름이 심링크로 바뀌어도 다른 파일을 열지 않는다.
      // (Windows에는 O_NOFOLLOW가 없다: 0으로 두고 아래 신원 비교가 대신 잡는다.)
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      let fd: number
      try {
        fd = openSync(real, constants.O_RDONLY | noFollow)
      } catch {
        return notFound()
      }
      let bytes: Buffer
      let mime: string
      try {
        const opened = fstatSync(fd, { bigint: true })
        if (!opened.isFile() || opened.size <= 0n || opened.size > BigInt(IMAGE_MAX_BYTES)) return notFound()
        const openedId = identityOf(opened)

        // **연 뒤 재확인**(Roh R1 C-01): 같은 요청 경로를 지금 다시 풀어, 그 경로가 지금 가리키는
        // 대상의 신원이 방금 연 fd의 신원과 같아야 한다. 파일 교체·상위 폴더 교체·되돌려 놓기가
        // 모두 여기서 걸린다 — fd는 열린 순간의 inode에 묶여 있고, 경로는 지금 것을 가리키기 때문.
        let againReal: string
        try {
          againReal = realpathSync(resolve(rootReal, check.rel))
        } catch {
          return notFound()
        }
        if (!insideByFileId(rootReal, againReal)) return notFound()
        let again: BigIntStats
        try {
          again = lstatSync(againReal, { bigint: true })
        } catch {
          return notFound()
        }
        if (!again.isFile()) return notFound()
        const againId = identityOf(again)
        if (openedId !== againId) return notFound()

        // 형식 판정·Content-Type은 **연 뒤 확인한 경로**의 확장자로 한다. 폴더 안 심링크가 다른 확장자의
        // 그림을 가리키는 정상 경우(예: `fig1.png` → `fig1-real.jpg`)를 예전처럼 그리기 위해서다.
        const mimeOfAgain = imageMimeOfExtension(againReal)
        if (!mimeOfAgain) return notFound()
        mime = mimeOfAgain

        const head = Buffer.alloc(HEAD_BYTES)
        const headRead = readSync(fd, head, 0, HEAD_BYTES, 0)
        if (!imageMagicMatches(againReal, head.subarray(0, headRead))) return notFound()
        const size = Number(opened.size)
        bytes = Buffer.alloc(size)
        let total = 0
        while (total < bytes.length) {
          const n = readSync(fd, bytes, total, bytes.length - total, total)
          if (n <= 0) break
          total += n
        }
        if (total !== bytes.length) return notFound()
      } finally {
        closeSync(fd)
      }

      // 읽는 사이 폴더가 바뀌었으면 답하지 않는다(발주 ③ ④). 화면은 새 폴더로 다시 그리며
      // 이 요청은 버려지므로, 옛 폴더 그림이 새 폴더 화면에 끼어들지 않는다.
      const after = getRoot()
      if (!after) return notFound()
      try {
        if (realpathSync(resolve(after)) !== rootReal) return notFound()
      } catch {
        return notFound()
      }

      // `no-store`: 같은 경로의 그림이 바뀌었을 때 낡은 바이트를 다시 그리지 않게.
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return notFound()
    } finally {
      inflight--
    }
  }

  return { handle }
}
