import { expect, test } from '@playwright/test'
import { changedLines } from '../src/renderer/src/components/fileChangeLines'

test('추가·삭제 파일은 원문 줄에 실제 변경 종류를 붙인다', () => {
  expect(changedLines({ path: '새 문서.md', kind: { type: 'add' }, diff: '첫 줄\n두 줄\n' })).toEqual(['+첫 줄', '+두 줄'])
  expect(changedLines({ path: '지운 문서.md', kind: { type: 'delete' }, diff: '지운 줄\n' })).toEqual(['-지운 줄'])
  expect(changedLines({ path: '빈 파일', kind: { type: 'add' }, diff: '' })).toEqual([])
})

test('수정 파일은 헤더·맥락을 제외하고 내용이 +++ 또는 --- 로 시작하는 줄도 보존한다', () => {
  const diff = '--- a/고친.md\n+++ b/고친.md\n@@ -1,3 +1,3 @@\n 그대로\n-이전 줄\n+바뀐 줄\n--- 실제 본문\n+++ 실제 본문\n@@ -8 +8 @@\n-둘\n+셋\n'
  expect(changedLines({ path: '고친.md', kind: { type: 'update' }, diff })).toEqual([
    '-이전 줄', '+바뀐 줄', '--- 실제 본문', '+++ 실제 본문', '-둘', '+셋'
  ])
})
