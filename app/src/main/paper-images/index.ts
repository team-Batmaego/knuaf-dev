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
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { IMAGE_MAX_BYTES, imageMimeOfExtension } from '../../shared/paper-image'
import { insideByFileId } from '../file-identity'
import { checkImageRequest, imageMagicMatches } from './check'

/** 지금 연 논문 폴더(main만 안다) — `ipc.ts`의 `currentRoot` getter. */
export type RootGetter = () => string | null

export interface PaperImages {
  /** `protocol.handle('knuaf-img', …)`가 부르는 하나. 실패는 404로 닫는다. */
  handle: (request: Request) => Promise<Response>
}

/** 한 번에 동시에 읽는 그림 수 — 목록이 길어도 파일 핸들·메모리가 한꺼번에 몰리지 않게. */
export const MAX_INFLIGHT = 8

/** 머리 바이트 판정에 필요한 만큼만 먼저 읽는다(파일 전체를 두 번 읽지 않는다). */
const HEAD_BYTES = 16

const notFound = (): Response => new Response(null, { status: 404 })

export function createPaperImages(getRoot: RootGetter): PaperImages {
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

      const mime = imageMimeOfExtension(real)
      if (!mime) return notFound()

      // 열고 나서 fstat으로 다시 잰다 — 연 사이에 바뀐 파일을 크기 검사 없이 읽지 않게.
      let fd: number
      try {
        fd = openSync(real, 'r')
      } catch {
        return notFound()
      }
      let bytes: Buffer
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.size <= 0 || opened.size > IMAGE_MAX_BYTES) return notFound()
        const head = Buffer.alloc(HEAD_BYTES)
        const headRead = readSync(fd, head, 0, HEAD_BYTES, 0)
        if (!imageMagicMatches(real, head.subarray(0, headRead))) return notFound()
        bytes = Buffer.alloc(opened.size)
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
