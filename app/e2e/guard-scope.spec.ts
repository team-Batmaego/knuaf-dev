// §10-13(보호 범위 일치·보호 규칙), §10-6(정상 파일 보존의 전제) — 순수 경로 판정
import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  folderHash,
  isGuardStorePath,
  isInside,
  isProtectedPath,
  isSkillHostPath,
  normalizePath,
  protectedRel,
  realRoot,
  skillHostDir
} from '../src/main/guard/scope'
import { scanRoot } from '../src/main/guard/scan'

const made: string[] = []
function tmpTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kd-scope-'))
  made.push(dir)
  return dir
}

test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

test('보호 규칙: .claude 조각·CLAUDE.md 이름·루트 설정 파일만 보호한다', () => {
  const root = '/paper'
  // 경로 조각 중 .claude
  expect(isProtectedPath('/paper/.claude/settings.json', root)).toBe(true)
  expect(isProtectedPath('/paper/a/b/.claude/x.pyc', root)).toBe(true)
  expect(isProtectedPath('/paper/.claude', root)).toBe(true)
  // 이름이 CLAUDE.md / CLAUDE.local.md (깊이 무관)
  expect(isProtectedPath('/paper/CLAUDE.md', root)).toBe(true)
  expect(isProtectedPath('/paper/a/b/c/d/e/CLAUDE.md', root)).toBe(true)
  expect(isProtectedPath('/paper/chapters/CLAUDE.local.md', root)).toBe(true)
  // 루트 바로 아래 설정 파일
  expect(isProtectedPath('/paper/.claude.json', root)).toBe(true)
  expect(isProtectedPath('/paper/.mcp.json', root)).toBe(true)
  // 보호 아님
  expect(isProtectedPath('/paper/chapters/chapter1.docx', root)).toBe(false)
  expect(isProtectedPath('/paper/notes/CLAUDE.md.bak', root)).toBe(false)
  expect(isProtectedPath('/paper/README.md', root)).toBe(false)
  expect(isProtectedPath('/paper/.claude.json.bak', root)).toBe(false)
  // 하위 .claude.json은 루트 기준 판정에서 보호가 아니다
  expect(isProtectedPath('/paper/chapters/.claude.json', root)).toBe(false)
})

test('루트 자신이 .claude 아래여도 폴더 안 평범한 파일은 보호가 아니다', () => {
  const root = '/paper/.claude/notes'
  expect(isProtectedPath('/paper/.claude/notes/draft.md', root)).toBe(false)
  expect(isProtectedPath('/paper/.claude/notes/CLAUDE.md', root)).toBe(true)
  // 루트 밖은 상대 판정이 안 되므로 경로 모양(.claude 조각)으로 보호를 판정한다(안전측).
  expect(isProtectedPath('/paper/.claude/other.md', root)).toBe(true)
})

test('폴더 밖 경로는 절대 경로 조각으로 판정한다', () => {
  const root = '/paper'
  expect(isProtectedPath('/elsewhere/.claude/settings.json', root)).toBe(true)
  expect(isProtectedPath('/elsewhere/plain.md', root)).toBe(false)
  expect(protectedRel(root, '/elsewhere/plain.md')).toBeNull()
})

test('경로 도우미: 정규화·포함 관계·상대 경로', () => {
  expect(normalizePath('C:\\a\\b\\\\c\\')).toBe('C:/a/b/c')
  expect(normalizePath('/')).toBe('/')
  expect(normalizePath('')).toBeNull()

  expect(isInside('/paper', '/paper/a/b')).toBe(true)
  expect(isInside('/paper', '/paper')).toBe(true)
  expect(isInside('/paper', '/paper2/a')).toBe(false)
  expect(isInside('/paper', '/paper/../other')).toBe(false)

  expect(protectedRel('/paper', '/paper/a/b.md')).toBe('a/b.md')
  expect(protectedRel('/paper', '/paper')).toBe('')
  expect(protectedRel('/paper', '/paper/../x')).toBeNull()
})

test('앱 스킬 자리·보관본 자리는 보호 대상과 별개로 판정한다', () => {
  const userData = '/userdata'
  const skill = join(skillHostDir(userData), 'scripts', 'run.py')
  expect(isSkillHostPath(skill, userData)).toBe(true)
  expect(isSkillHostPath('/paper/.claude/skills/x', userData)).toBe(false)
  expect(isSkillHostPath('/opt/app/skill-host/.claude/skills/knuaf-dev/a.md')).toBe(true)

  expect(isGuardStorePath('/userdata/guard/abc/state.json', userData)).toBe(true)
  expect(isGuardStorePath('/userdata/guard', userData)).toBe(true)
  expect(isGuardStorePath('/userdata/guardx/state.json', userData)).toBe(false)
})

test('folderHash는 실제 경로 기준 — 링크로 연 같은 폴더는 같은 키', () => {
  const base = tmpTree()
  const real = join(base, 'paper')
  mkdirSync(real)
  const link = join(base, 'paper-link')
  symlinkSync(real, link)

  expect(realRoot(link)).toBe(realpathSync(real))
  expect(folderHash(link)).toBe(folderHash(real))
  expect(folderHash(real)).toMatch(/^[0-9a-f]{64}$/)

  // 실제로 다른 폴더는 다른 키
  const other = join(base, 'other')
  mkdirSync(other)
  expect(folderHash(other)).not.toBe(folderHash(real))
})

test('스캔 결과의 잎은 모두 보호 판정을 통과한다(카드 판정과 같은 함수)', () => {
  const root = tmpTree()
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
  writeFileSync(join(root, 'CLAUDE.md'), '# rules')
  writeFileSync(join(root, 'README.md'), 'plain')
  mkdirSync(join(root, 'chapters'))
  writeFileSync(join(root, 'chapters', 'chapter1.docx'), 'docx')
  writeFileSync(join(root, 'chapters', 'CLAUDE.md'), 'nested')
  writeFileSync(join(root, '.claude.json'), '{}')

  const result = scanRoot({ root })
  expect([...result.leaves.keys()].sort()).toEqual(['.claude.json', '.claude/settings.json', 'CLAUDE.md', 'chapters/CLAUDE.md'])
  for (const rel of result.leaves.keys()) {
    expect(isProtectedPath(join(result.realRoot, rel), result.realRoot)).toBe(true)
  }
})
