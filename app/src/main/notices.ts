import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * `rootReal` 아래 상대 조각 `relPath` 가 **링크를 하나도 지나지 않고** 도달 가능한가.
 *
 * 논문 폴더 아래 어느 조각이든 심볼릭 링크(lstat)면 **대상의 존재·위치와 무관하게** 거절한다.
 * 링크가 하나라도 끼면 "폴더 안"이라는 판정 자체가 링크를 만든 사람 손에 넘어가기 때문이다
 * (끊긴 링크는 `existsSync` 가 거짓이라 미존재 경로처럼 보인다 — 그 구멍을 여기서 닫는다).
 * 링크가 아닌 미존재 조각은 그냥 없는 이름이므로, 있는 곳까지 내려온 실제 경로에 그대로 붙여 판정한다.
 */
function confinedReal(rootReal: string, relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean)
  // 순수 함수가 이미 걸러 내지만, 여기 들어오는 값은 언제나 **폴더 아래 상대 경로**여야 한다.
  if (!parts.length || parts.some((part) => part === '..')) return null
  let head = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    head = join(head, parts[index])
    let stat
    try {
      stat = lstatSync(head)
    } catch {
      // 없는 이름(또는 디렉터리가 아닌 조상 아래) — 남은 조각은 실재할 수 없다. 여기까지가 실제 경로다.
      return join(head, ...parts.slice(index + 1))
    }
    if (stat.isSymbolicLink()) return null
  }
  return head
}

/** receipt 는 폴더 안 실제 경로일 때만 남긴다 — 밖이거나 링크를 지나면 null(계약: `NoticeRow.receiptPath`). */
function confineReceipt(rootReal: string, notice: NoticeRow): NoticeRow {
  if (!notice.receiptPath) return notice
  return confinedReal(rootReal, notice.receiptPath) ? notice : { ...notice, receiptPath: null }
}

export function readNotices(root: string): NoticeDocument {
  try {
    if (!root || !existsSync(root)) return emptyNotices()
    const rootReal = realpathSync(root)
    const file = noticeFilePath(root)
    // 알림 파일 자체도 같은 경계다 — 링크(끊긴 링크 포함)를 지나면 읽지 않는다.
    // `existsSync` 보다 먼저 본다: 끊긴 링크도 existsSync 에서는 "파일 없음"과 똑같이 보이기 때문이다.
    if (!confinedReal(rootReal, NOTICE_FILE)) return emptyNotices()
    if (!existsSync(file)) return emptyNotices()
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

/**
 * 닫기 기억 — **앱 데이터 폴더**(`userData`)의 별도 파일이다. 논문 폴더에 쓰지 않는다
 * (그 폴더는 규칙집 몫이고, 학생이 옮기면 닫은 사실까지 따라갈 이유가 없다).
 *
 * `settings.json` 에 얹지 않는다: 설정 저장은 읽고-합치고-통째로 쓰므로 학생이 X 를 누르는
 * 순간과 겹치면 한쪽이 사라진다. 여기 파일은 이 목적 하나뿐이라 "앞에 넣고 자른다"로 끝난다.
 *
 * 형식은 `string[]`(닫은 `project_id:notice_identity` 키, 최근 순). 깨졌으면 빈 목록 —
 * 닫기 기억은 잃어도 알림이 한 번 더 뜰 뿐이고, 그 때문에 화면을 막지 않는다.
 */
export const DISMISSED_FILE = 'notices-dismissed.json'
/** 상한 — 넘으면 오래된 것부터 버린다. 프로젝트당 알림 몇 건이라 실제로는 닿지 않는다. */
const DISMISSED_MAX = 500
/** 키 하나의 상한 — `project_id` 64 + `:` + `notice_identity` 64 에 여유를 둔다. */
const KEY_MAX = 200
const DISMISSED_BYTES = 256 * 1024

export function dismissedFilePath(dir: string): string {
  return join(dir, DISMISSED_FILE)
}

export function readDismissed(dir: string): string[] {
  try {
    const file = dismissedFilePath(dir)
    if (!existsSync(file) || statSync(file).size > DISMISSED_BYTES) return []
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) return []
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      const key = entry.trim()
      if (!key || key.length > KEY_MAX || out.includes(key)) continue
      out.push(key)
      if (out.length >= DISMISSED_MAX) break
    }
    return out
  } catch {
    /* 깨진 파일: 닫기 기억 없음. */
    return []
  }
}

/**
 * X 한 번 — 키를 맨 앞에 넣고 상한에서 자른다. **반환값은 이번 화면이 쓸 목록**이다.
 *
 * 디스크 쓰기가 실패해도 새 목록을 돌려준다: 학생이 누른 X 는 지금 닫혀야 하고, 닫기 기억을
 * 못 남긴 것은 다음에 알림이 한 번 더 뜨는 정도다(여기서 던지면 대화 화면이 멈춘다).
 */
export function writeDismissed(dir: string, key: string): string[] {
  const current = readDismissed(dir)
  const text = typeof key === 'string' ? key.trim() : ''
  if (!text || text.length > KEY_MAX) return current
  const next = [text, ...current.filter((existing) => existing !== text)].slice(0, DISMISSED_MAX)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(dismissedFilePath(dir), JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    /* 못 썼어도 지금 화면은 닫는다 — 반환값이 그 목록이다. */
  }
  return next
}
