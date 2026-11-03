/**
 * 경로 포함 판정의 단위 시험(검토 ATTACH-R1-02).
 *
 * 새 판정은 경로 **문자열을 정규화하지 않는다**. NFC/소문자 변환은 서로 다른 이름(윈도우의
 * `가`(U+AC00) vs `가`(U+1100 U+1161), 대소문자 구분 디렉터리의 `proj` vs `PROJ`)을 같은
 * 이름으로 합쳐 폴더 밖을 통과시키기 때문이다. 포함 관계는 조상 사슬의 파일 신원으로 본다.
 *
 * 여기서는 파일 시스템 대신 신원 지도를 주입해, 윈도우 실제 디스크 없이도 위 두 반례를
 * 잠근다. 실제 OS 경로 시험은 `file-open-guard.spec.ts` 가 맡는다.
 */
import { expect, test } from '@playwright/test'
import { insideByFileId, type IdOf } from '../src/main/file-identity'

/** 실제 파일 시스템을 흉내 낸 (경로 → 신원) 지도. 다른 폴더는 다른 신원이다. */
const IDS: Record<string, string> = {
  '/work/논문': 'dir:1',
  '/work/논문/build': 'dir:2',
  '/work/논문/build/memo.txt': 'file:3',
  '/work/논문2': 'dir:4',
  '/work/논문2/memo.txt': 'file:5',
  // 윈도우가 정규화 동등으로 보지 않는 두 이름 — NFC 로 접으면 같아진다.
  '/work/가': 'dir:6',
  '/work/가/x.txt': 'file:7',
  '/work/가': 'dir:8',
  '/work/가/x.txt': 'file:9',
  // 대소문자를 구분하는 디렉터리 아래의 두 이름.
  '/work/proj': 'dir:10',
  '/work/proj/x.txt': 'file:11',
  '/work/PROJ': 'dir:12',
  '/work/PROJ/x.txt': 'file:13'
}
const idOf: IdOf = (path) => IDS[path] ?? null

test('경로 문자열 정규화 없이 파일 신원으로 포함 관계를 판정한다', () => {
  const root = '/work/논문'
  expect(insideByFileId(root, '/work/논문', idOf), '폴더 자신은 안').toBe(true)
  expect(insideByFileId(root, '/work/논문/build/memo.txt', idOf), '하위 파일은 안').toBe(true)
  expect(insideByFileId(root, '/work/논문2/memo.txt', idOf), '접두사만 같은 옆 폴더는 밖').toBe(false)

  // NFC 로 접으면 같아지는 다른 폴더 — 실제로는 다른 노드다.
  expect(insideByFileId('/work/가', '/work/가/x.txt', idOf), '정규화 동등 이름을 같은 폴더로 합쳤다').toBe(false)
  expect(insideByFileId('/work/가', '/work/가/x.txt', idOf)).toBe(true)

  // 대소문자를 구분하는 디렉터리 — 소문자화하면 같아지지만 실제로는 다른 폴더다.
  expect(insideByFileId('/work/proj', '/work/PROJ/x.txt', idOf), '대소문자만 다른 폴더를 합쳤다').toBe(false)
  expect(insideByFileId('/work/proj', '/work/proj/x.txt', idOf)).toBe(true)
})

test('파일 신원을 못 얻는 파일 시스템에서는 정규화 없는 정확 경로 비교로만 물러난다', () => {
  const noIds: IdOf = () => null
  expect(insideByFileId('/work/논문', '/work/논문/build/memo.txt', noIds)).toBe(true)
  expect(insideByFileId('/work/논문', '/work/논문2/memo.txt', noIds)).toBe(false)
  expect(insideByFileId('/work/논문', '/work/논문2/../논문2/x', noIds), '정규화된 대상도 밖').toBe(false)
  // root 자신 — 파일 ID가 없어도 허용한다(폴더 열기 단추가 쓰는 경로).
  expect(insideByFileId('/work/논문', '/work/논문', noIds)).toBe(true)
})