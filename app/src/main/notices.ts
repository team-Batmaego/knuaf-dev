import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import {
  emptyNotices, NOTICE_FILE, readNoticeDocument, type NoticeDocument, type NoticeRow
} from '../shared/notice'

/**
 * `<논문 폴더>/.knuaf-notices.json` 읽기 — main 쪽 유일한 통로.
 *
 * 규칙집(도우미)이 쓰고 앱은 읽기만 한다. 이 파일은 **남의 파일**로 다룬다:
 * 없음·깨짐·너무 큼·모양 다름은 전부 "알림 없음"이다. 여기서 던지면 대화 화면이 프로젝트를 못 연다.
 * 해석은 `shared/notice.ts` 순수 함수가 한다(화면과 같은 규칙).
 *
 * 경계는 **문자열이 아니라 실제 경로**로 본다. `shared/notice.ts` 의 `receiptPathInside` 는
 * `..`·절대 경로만 막는 순수 함수라, 논문 폴더 안에 밖을 가리키는 심볼릭 링크가 있으면 통과한다.
 * 파일 시스템을 아는 쪽(main)이 그 위에 실제 경로 검사를 더한다 — 폴더 밖이면 없는 값으로 내린다.
 */

/** 도우미가 남길 수 있는 크기의 넉넉한 상한. 넘으면 읽지 않는다 — 말풍선 하나에 메모리를 걸지 않는다. */
const MAX_BYTES = 1024 * 1024

export function noticeFilePath(root: string): string {
  return join(root, NOTICE_FILE)
}

/**
 * `candidate` 의 **실제 경로**가 `rootReal` 안인가.
 * 아직 없는 조각(받은 영수증 파일 등)은 있는 조상까지 올라가 그 조상을 풀고 남은 조각을 그대로 붙인다.
 * 풀 수 없거나 밖이면 null — 심볼릭 링크로 밖을 가리키는 경로는 여기서 걸린다.
 */
function realInside(rootReal: string, candidate: string): string | null {
  try {
    let head = candidate
    const tail: string[] = []
    while (!existsSync(head)) {
      const cut = head.lastIndexOf(sep)
      // 뿌리까지 올라갔는데도 없다 — 판단할 수 없으니 보수적으로 밖으로 친다.
      if (cut <= 0) return null
      tail.unshift(head.slice(cut + 1))
      head = head.slice(0, cut)
    }
    const real = [realpathSync(head), ...tail].join(sep)
    return real.startsWith(rootReal + sep) ? real : null
  } catch {
    /* 권한 없음·끊긴 링크 등: 실제 경로를 말할 수 없으면 인정하지 않는다. */
    return null
  }
}

/** receipt 는 폴더 안 실제 경로일 때만 남긴다 — 밖이면 null(계약: `NoticeRow.receiptPath`). */
function confineReceipt(rootReal: string, notice: NoticeRow): NoticeRow {
  if (!notice.receiptPath) return notice
  return realInside(rootReal, join(rootReal, notice.receiptPath)) ? notice : { ...notice, receiptPath: null }
}

export function readNotices(root: string): NoticeDocument {
  try {
    if (!root || !existsSync(root)) return emptyNotices()
    const rootReal = realpathSync(root)
    const file = noticeFilePath(root)
    if (!existsSync(file)) return emptyNotices()
    // 알림 파일 자체가 밖을 가리키는 심볼릭 링크면 읽지 않는다 — 같은 경계다.
    if (!realInside(rootReal, file)) return emptyNotices()
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) return emptyNotices()
    const text = readFileSync(file, 'utf-8')
    const parsed = readNoticeDocument(JSON.parse(text), root)
    return { notices: parsed.notices.map((notice) => confineReceipt(rootReal, notice)) }
  } catch {
    /* 읽을 수 없거나 JSON 이 아님: 알림 없음. 프로젝트 열기를 막지 않는다. */
    return emptyNotices()
  }
}
