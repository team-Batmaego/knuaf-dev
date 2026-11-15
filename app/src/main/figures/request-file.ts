/**
 * figures/request-file.ts — 논문 폴더의 요청 파일을 **읽기만** 한다 (R4-1, 계약 §3)
 *
 * 앱은 논문 폴더에 아무것도 쓰지 않는다. 요청 파일은 도우미가 쓰고 앱은 읽기만 하며, 처리 후에도
 * 지우지 않는다(지우는 것도 쓰기다).
 *
 * 읽기 규칙: `lstat`으로 **일반 파일이고 심볼릭 링크가 아님**을 먼저 확인하고, 실제 열 때도
 * `O_NOFOLLOW`를 준다. 확인과 열기 사이에 링크로 바뀌는 경쟁을 그 한 번 더 막는다(맥·리눅스).
 *
 * **윈도에는 그 보호가 없다**(R-4). `constants.O_NOFOLLOW`가 윈도에서 `undefined`이고 `|`에서 0이
 * 되므로 링크를 그대로 따라 연다. 열기 뒤 `fstat`(`handle.stat()`)도 **연 파일**을 보므로 링크였는지
 * 알려 주지 않는다 — 링크 판별은 `lstat` 시점에만 있고, 그 뒤 경쟁은 윈도에서 막지 못한다. 남는
 * 영향은 요청 JSON 본문(우리가 읽는 값)이라 위험은 낮지만, "막았다"고 적을 수는 없다. 윈도 실기기
 * 확인은 아직 없다.
 */

import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { REQUEST_MAX_BYTES, parseFigureRequest, type RequestParse } from './contract'

/** 논문 폴더 기준 요청 위치(계약 §3). */
export function requestDir(folder: string): string {
  return join(folder, '.knuaf-gui', 'figure-requests')
}

export function requestFile(folder: string, id: string): string {
  return join(requestDir(folder), `${id}.req.json`)
}

export type RequestRead =
  | { ok: true; parse: RequestParse; raw: string }
  | { ok: false; reason: 'missing' | 'not_file' | 'too_big' | 'link' | 'io' }

/** 요청 하나를 읽어 계약 모양으로 좁힌다. 파일이 없거나 이상하면 그 사유만 돌려준다. */
export async function readRequestFile(path: string): Promise<RequestRead> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (info.isSymbolicLink()) return { ok: false, reason: 'link' }
  if (!info.isFile()) return { ok: false, reason: 'not_file' }
  if (info.size > REQUEST_MAX_BYTES) return { ok: false, reason: 'too_big' }

  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') return { ok: false, reason: 'link' }
    if (code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'io' }
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return { ok: false, reason: 'not_file' }
    if (opened.size > REQUEST_MAX_BYTES) return { ok: false, reason: 'too_big' }
    const raw = await handle.readFile('utf8')
    return { ok: true, parse: parseFigureRequest(raw), raw }
  } catch {
    return { ok: false, reason: 'io' }
  } finally {
    await handle.close()
  }
}
