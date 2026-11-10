import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { emptyNotices, NOTICE_FILE, readNoticeDocument, type NoticeDocument } from '../shared/notice'

/**
 * `<논문 폴더>/.knuaf-notices.json` 읽기 — main 쪽 유일한 통로.
 *
 * 규칙집(도우미)이 쓰고 앱은 읽기만 한다. 이 파일은 **남의 파일**로 다룬다:
 * 없음·깨짐·너무 큼·모양 다름은 전부 "알림 없음"이다. 여기서 던지면 대화 화면이 프로젝트를 못 연다.
 * 해석은 `shared/notice.ts` 순수 함수가 한다(화면과 같은 규칙).
 */

/** 도우미가 남길 수 있는 크기의 넉넉한 상한. 넘으면 읽지 않는다 — 말풍선 하나에 메모리를 걸지 않는다. */
const MAX_BYTES = 1024 * 1024

export function noticeFilePath(root: string): string {
  return join(root, NOTICE_FILE)
}

export function readNotices(root: string): NoticeDocument {
  try {
    if (!root || !existsSync(root)) return emptyNotices()
    const file = noticeFilePath(root)
    if (!existsSync(file)) return emptyNotices()
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) return emptyNotices()
    const text = readFileSync(file, 'utf-8')
    return readNoticeDocument(JSON.parse(text), root)
  } catch {
    /* 읽을 수 없거나 JSON 이 아님: 알림 없음. 프로젝트 열기를 막지 않는다. */
    return emptyNotices()
  }
}
