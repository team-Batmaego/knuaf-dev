import { statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * 경로 하나의 파일 시스템 신원 — 볼륨(dev)과 파일 ID(ino)의 쌍.
 * 문자열 표기(대소문자·유니코드 정규화·별칭)와 무관하게 "실제로 같은 곳인가"를 말한다.
 */
export type IdOf = (path: string) => string | null

/** 경로 해석에 쓰는 규칙. 제품은 실행 OS의 `node:path`를, 시험은 `path.posix`/`path.win32`를 넣는다. */
export interface PathSemantics {
  resolve: (...paths: string[]) => string
  dirname: (path: string) => string
  sep: string
}

const nativePaths: PathSemantics = { resolve, dirname, sep }

/** 신원 조회. 파일 ID를 쓸 수 없는 파일 시스템(ino 0)은 null — 그때는 정확 경로 비교로 물러난다. */
export const fileId: IdOf = (path) => {
  try {
    const s = statSync(path, { bigint: true })
    return s.ino === 0n ? null : `${s.dev}:${s.ino}`
  } catch { return null }
}

/**
 * 대상이 root **안**인가 — 경로 문자열을 정규화해 비교하지 않는다(검토 ATTACH-R1-02).
 *
 * NFC/소문자 변환은 서로 다른 이름을 같은 이름으로 만들 수 있다: 윈도우는 경로를 WCHAR
 * 시퀀스로 다루고 정규화 동등성을 보장하지 않으며, 디렉터리별 대소문자 구분도 지원한다.
 * 그래서 포함 관계는 **조상 사슬의 파일 신원**으로 판정한다. 대상과 그 부모들을 차례로
 * 올라가며 root의 신원과 같은 노드를 찾는다. 심링크·정션은 호출자가 realpath로 먼저 풀어
 * 넘긴다.
 *
 * 파일 신원을 얻을 수 없는 파일 시스템(예: ino 0)에서는 **정규화 없는 정확 비교**만 한다 —
 * 두 값 모두 호출자가 realpath로 얻은 실제 경로이므로, 접두사가 맞으면 실제 조상이다.
 * 비교는 원문이 아니라 **해석된 경로**(`paths.resolve`)로 한다: `..`가 섞인 문자열이
 * 접두사만 맞고 실제로는 밖인 경우를 통과시키지 않기 위함이다.
 */
export function insideByFileId(
  root: string,
  target: string,
  idOf: IdOf = fileId,
  paths: PathSemantics = nativePaths
): boolean {
  const resolved = paths.resolve(target)
  const rootId = idOf(root)
  if (rootId) {
    let path = resolved
    for (let depth = 0; depth < 256; depth++) {
      if (idOf(path) === rootId) return true
      const up = paths.dirname(path)
      if (up === path) break
      path = up
    }
  }
  const prefix = root.endsWith(paths.sep) ? root : root + paths.sep
  return resolved === root || resolved.startsWith(prefix)
}