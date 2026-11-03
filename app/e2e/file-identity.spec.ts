/**
 * 경로 포함 판정의 단위 시험(검토 ATTACH-R1-02, CI 윈도우 실패 후속).
 *
 * 새 판정은 경로 **문자열을 정규화하지 않는다**. NFC/소문자 변환은 서로 다른 이름(윈도우의
 * `가`(U+AC00) vs `가`(U+1100 U+1161), 대소문자 구분 디렉터리의 `proj` vs `PROJ`)을 같은
 * 이름으로 합쳐 폴더 밖을 통과시키기 때문이다. 포함 관계는 조상 사슬의 파일 신원으로 본다.
 *
 * CI 윈도우에서 POSIX 문자열만 넣은 이 시험이 실패했다 — 제품은 실행 OS의 `node:path`를 쓰고
 * 시험은 플랫폼 기본 해석을 타서, 드라이브 없는 `/work/...`가 `D:\work\...`로 바뀌었다.
 * 그래서 여기서는 **`path.posix`와 `path.win32`를 명시적으로** 넣어 같은 성질을 양쪽 의미론에서
 * 잠근다. 제품 경로는 항상 realpath가 준 네이티브 경로라, 두 규칙 중 하나를 실제로 탄다.
 */
import { expect, test } from '@playwright/test'
import { posix, win32 } from 'node:path'
import { insideByFileId, type IdOf, type PathSemantics } from '../src/main/file-identity'

const POSIX: PathSemantics = { resolve: posix.resolve, dirname: posix.dirname, sep: posix.sep }
const WIN: PathSemantics = { resolve: win32.resolve, dirname: win32.dirname, sep: win32.sep }

/** 실제 파일 시스템을 흉내 낸 (경로 → 신원) 지도. 다른 폴더는 다른 신원이다. */
const POSIX_IDS: Record<string, string> = {
  '/work/논문': 'dir:1',
  '/work/논문/build': 'dir:2',
  '/work/논문/build/memo.txt': 'file:3',
  '/work/논문2': 'dir:4',
  '/work/논문2/memo.txt': 'file:5',
  // 정규화 동등으로 보지 않는 두 이름 — NFC 로 접으면 같아진다.
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

const WIN_IDS: Record<string, string> = {
  'C:\\work\\논문': 'dir:1',
  'C:\\work\\논문\\build': 'dir:2',
  'C:\\work\\논문\\build\\memo.txt': 'file:3',
  'C:\\work\\논문2': 'dir:4',
  'C:\\work\\논문2\\memo.txt': 'file:5',
  'C:\\work\\가': 'dir:6',
  'C:\\work\\가\\x.txt': 'file:7',
  'C:\\work\\가': 'dir:8',
  'C:\\work\\가\\x.txt': 'file:9',
  'C:\\work\\proj': 'dir:10',
  'C:\\work\\proj\\x.txt': 'file:11',
  'C:\\work\\PROJ': 'dir:12',
  'C:\\work\\PROJ\\x.txt': 'file:13',
  // UNC 공유 경로.
  '\\\\srv\\share\\논문': 'dir:20',
  '\\\\srv\\share\\논문\\x.txt': 'file:21',
  '\\\\srv\\share\\논문2\\x.txt': 'file:22'
}

const mapId = (ids: Record<string, string>): IdOf => (path) => ids[path] ?? null

/** 한 의미론 안에서 같은 성질을 확인한다. */
function expectContainment(paths: PathSemantics, ids: Record<string, string>, root: string, child: string, sibling: string): void {
  const idOf = mapId(ids)
  const inside = (target: string): boolean => insideByFileId(root, target, idOf, paths)
  const sep = paths.sep
  const siblingName = sibling.slice(root.length + 1)

  expect(inside(root), '폴더 자신은 안').toBe(true)
  expect(inside(child), '하위 파일은 안').toBe(true)
  expect(inside(sibling), '접두사만 같은 옆 폴더는 밖').toBe(false)
  expect(inside(root + sep + 'build' + sep + '..' + sep + 'build' + sep + 'memo.txt'), '.. 를 되돌린 대상은 안').toBe(true)
  expect(inside(root + sep + '..' + sep + siblingName), '.. 로 빠지는 대상은 밖').toBe(false)
}

test('경로 문자열 정규화 없이 파일 신원으로 포함 관계를 판정한다 — POSIX 규칙', () => {
  expectContainment(POSIX, POSIX_IDS, '/work/논문', '/work/논문/build/memo.txt', '/work/논문2/memo.txt')
  const idOf = mapId(POSIX_IDS)
  const inside = (root: string, target: string): boolean => insideByFileId(root, target, idOf, POSIX)

  // NFC 로 접으면 같아지는 다른 폴더 — 실제로는 다른 노드다.
  expect(inside('/work/가', '/work/가/x.txt'), '정규화 동등 이름을 같은 폴더로 합쳤다').toBe(false)
  expect(inside('/work/가', '/work/가/x.txt')).toBe(true)
  // 대소문자를 구분하는 디렉터리 — 소문자화하면 같아지지만 실제로는 다른 폴더다.
  expect(inside('/work/proj', '/work/PROJ/x.txt'), '대소문자만 다른 폴더를 합쳤다').toBe(false)
  expect(inside('/work/proj', '/work/proj/x.txt')).toBe(true)
})

test('경로 문자열 정규화 없이 파일 신원으로 포함 관계를 판정한다 — Windows 규칙', () => {
  expectContainment(WIN, WIN_IDS, 'C:\\work\\논문', 'C:\\work\\논문\\build\\memo.txt', 'C:\\work\\논문2\\memo.txt')
  const idOf = mapId(WIN_IDS)
  const inside = (root: string, target: string): boolean => insideByFileId(root, target, idOf, WIN)

  expect(inside('C:\\work\\가', 'C:\\work\\가\\x.txt'), '정규화 동등 이름을 같은 폴더로 합쳤다').toBe(false)
  expect(inside('C:\\work\\가', 'C:\\work\\가\\x.txt')).toBe(true)
  expect(inside('C:\\work\\proj', 'C:\\work\\PROJ\\x.txt'), '대소문자만 다른 폴더를 합쳤다').toBe(false)
  expect(inside('C:\\work\\proj', 'C:\\work\\proj\\x.txt')).toBe(true)
  // UNC 공유 — 같은 공유 안/옆 공유 밖.
  expect(inside('\\\\srv\\share\\논문', '\\\\srv\\share\\논문\\x.txt')).toBe(true)
  expect(inside('\\\\srv\\share\\논문', '\\\\srv\\share\\논문2\\x.txt')).toBe(false)
})

test('파일 신원을 못 얻는 파일 시스템에서는 정규화 없는 정확 경로 비교로만 물러난다 — POSIX 규칙', () => {
  const noIds: IdOf = () => null
  const inside = (root: string, target: string): boolean => insideByFileId(root, target, noIds, POSIX)
  expect(inside('/work/논문', '/work/논문/build/memo.txt')).toBe(true)
  expect(inside('/work/논문', '/work/논문2/memo.txt')).toBe(false)
  expect(inside('/work/논문', '/work/논문/../논문2/x'), '.. 로 빠진 대상은 밖').toBe(false)
  expect(inside('/work/논문', '/work/논문/build/../build/memo.txt')).toBe(true)
  expect(inside('/work/논문', '/work/논문'), 'root 자신 — 폴더 열기 단추가 쓰는 경로').toBe(true)
})

test('파일 신원을 못 얻는 파일 시스템에서는 정규화 없는 정확 경로 비교로만 물러난다 — Windows 규칙', () => {
  const noIds: IdOf = () => null
  const inside = (root: string, target: string): boolean => insideByFileId(root, target, noIds, WIN)
  expect(inside('C:\\work\\논문', 'C:\\work\\논문\\build\\memo.txt')).toBe(true)
  expect(inside('C:\\work\\논문', 'C:\\work\\논문2\\memo.txt')).toBe(false)
  expect(inside('C:\\work\\논문', 'C:\\work\\논문\\..\\논문2\\x'), '.. 로 빠진 대상은 밖').toBe(false)
  expect(inside('C:\\work\\논문', 'C:\\work\\논문\\build\\..\\build\\memo.txt')).toBe(true)
  expect(inside('C:\\work\\논문', 'C:\\work\\논문')).toBe(true)
  expect(inside('\\\\srv\\share\\논문', '\\\\srv\\share\\논문2\\x.txt')).toBe(false)
})