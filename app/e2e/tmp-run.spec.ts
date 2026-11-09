/**
 * `e2e/tmp-run.ts` 의 삭제 권한 경계 — 리뷰 1회째 차단1·중요2~4 의 반례를 시험으로 고정한다.
 *
 * 여기서 지키려는 불변식은 두 가지다.
 *   `삭제(r) ⟹ 이 프로세스가 mkdtempSync 로 만든 r`
 *   `독립 실행 A ≠ B ⟹ 뿌리(A) ≠ 뿌리(B)`
 *
 * 그래서 이 시험은 "정상 실행이 지워진다"가 아니라 **지우면 안 되는 것이 살아남는가**를 본다:
 * 환경변수로 남의 폴더를 뿌리라고 우겨도 안 지워지고, 워커는 부모 뿌리를 안 지키고, 상속된
 * TMPDIR 안에서 시작한 독립 실행은 자기 뿌리를 밖에 만들고, 실패한 정리는 상태를 남겨
 * 두 번째 시도에서 끝난다.
 */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanupTmpdir, isolateTmpdir } from './tmp-run'

const moduleUrl = pathToFileURL(resolve(__dirname, 'tmp-run.ts')).href
const ENV_KEYS = ['KNUAF_E2E_TMP_ROOT', 'KNUAF_E2E_TMP_RUN']

/**
 * 새 Node 프로세스에서 `tmp-run` 을 실제로 돌린다 — 이 시험 파일이 사는 워커는 뿌리를 만들지
 * 않으므로(부모 것을 이어받을 뿐) 삭제 경계는 독립 프로세스에서만 볼 수 있다.
 */
function runIsolated(overrides: NodeJS.ProcessEnv, body: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ENV_KEYS) delete env[key]
  Object.assign(env, overrides)
  const code = `const m = await import(${JSON.stringify(moduleUrl)})\nconst fs = await import('node:fs')\nconst out = {}\n${body}\nconsole.log(JSON.stringify(out))`
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code],
    { encoding: 'utf8', env, timeout: 60_000 })
  expect(r.status, `자식 프로세스 실패: ${r.stderr}`).toBe(0)
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
}

function tmpEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TMPDIR: undefined, TMP: undefined, TEMP: undefined, ...overrides }
}

test('환경변수로 지정한 남의 폴더는 지우지 않는다 (차단1)', () => {
  // 반례 그대로: 이름이 `kd-run-` 으로 시작하는 사용자 폴더를 뿌리·실행 ID·소유자까지 맞춰
  // 물려주고 실행해도, 이 프로세스가 mkdtempSync 로 만든 것이 아니면 손대지 않아야 한다.
  const victim = realpathSync(mkdtempSync(join(tmpdir(), 'kd-run-personal-')))
  writeFileSync(join(victim, 'my-notes.txt'), '사용자 파일\n', 'utf-8')
  try {
    const out = runIsolated({
      KNUAF_E2E_TMP_ROOT: victim,
      KNUAF_E2E_TMP_RUN: basename(victim),
      KNUAF_E2E_TMP_OWNER: '1' // 구버전 구현이 읽던 변수까지 맞춰 둔다 — 그래도 권한이 없어야 한다
    }, 'out.root = m.isolateTmpdir()\nm.cleanupTmpdir()\nout.after = fs.existsSync(out.root)')
    expect(resolve(String(out.root)), '물려받은 경로를 자기 뿌리로 삼았다').not.toBe(victim)
    expect(out.after, '자기가 만든 뿌리를 지우지 않았다').toBe(false)
    expect(readFileSync(join(victim, 'my-notes.txt'), 'utf-8'), '남의 폴더가 지워졌다').toBe('사용자 파일\n')
  } finally {
    rmSync(victim, { recursive: true, force: true })
  }
})

test('워커는 부모 실행의 뿌리를 이어받되 지우지 않는다 (중요2)', () => {
  // 이 시험은 Playwright 워커 안에서 돈다 — config 가 만든 부모 뿌리를 env 로 물려받았고,
  // 자기 것이 아니므로 정리를 불러도 부모 뿌리가 살아 있어야 한다.
  const root = realpathSync(isolateTmpdir())
  expect(basename(root).startsWith('kd-run-'), `뿌리 이름이 규칙 밖이다: ${root}`).toBe(true)
  expect(process.env.KNUAF_E2E_TMP_ROOT, '워커가 부모 뿌리를 물려받지 못했다').toBe(root)
  cleanupTmpdir()
  expect(existsSync(root), '워커가 부모 실행의 뿌리를 지웠다').toBe(true)
})

test('독립 실행은 상속된 TMPDIR 안이 아니라 자기 뿌리를 새로 만든다 (중요2)', () => {
  const ancestor = realpathSync(mkdtempSync(join(tmpdir(), 'kd-run-')))
  writeFileSync(join(ancestor, 'ancestor-work.txt'), '부모 실행 작업 중\n', 'utf-8')
  try {
    // 부모 뿌리의 env 를 통째로 물려받고 TMPDIR 까지 그 안을 가리키는 최악의 경우.
    const out = runIsolated({
      ...tmpEnv(),
      TMPDIR: ancestor, TMP: ancestor, TEMP: ancestor,
      KNUAF_E2E_TMP_ROOT: ancestor,
      KNUAF_E2E_TMP_RUN: basename(ancestor),
      KNUAF_E2E_TMP_OWNER: '1' // 구버전 변수까지 물려준다
    }, 'out.root = m.isolateTmpdir()\nm.cleanupTmpdir()\nout.after = fs.existsSync(out.root)\nout.ancestor = fs.existsSync(' + JSON.stringify(ancestor) + ')')
    const root = resolve(String(out.root))
    expect(root, '독립 실행이 부모 뿌리를 재사용했다').not.toBe(ancestor)
    expect(root.startsWith(ancestor + sep), '부모 뿌리 안에 자기 뿌리를 만들었다').toBe(false)
    expect(out.after, '자기 뿌리를 지우지 않았다').toBe(false)
    expect(out.ancestor, '독립 실행이 부모 뿌리를 지웠다').toBe(true)
    expect(readFileSync(join(ancestor, 'ancestor-work.txt'), 'utf-8')).toBe('부모 실행 작업 중\n')
  } finally {
    rmSync(ancestor, { recursive: true, force: true })
  }
})

test('TMPDIR 이 조상 뿌리 안 깊은 곳을 가리켜도 새 뿌리는 밖에 만든다 (중요2)', () => {
  const ancestor = realpathSync(mkdtempSync(join(tmpdir(), 'kd-run-')))
  const deep = join(ancestor, 'nested', 'work')
  mkdirSync(deep, { recursive: true })
  try {
    const out = runIsolated(tmpEnv({ TMPDIR: deep, TMP: deep, TEMP: deep }),
      'out.root = m.isolateTmpdir()\nm.cleanupTmpdir()\nout.after = fs.existsSync(out.root)')
    const root = resolve(String(out.root))
    expect(root.startsWith(ancestor + sep), '조상 뿌리 안에 자기 뿌리를 만들었다').toBe(false)
    expect(out.after, '자기 뿌리를 지우지 않았다').toBe(false)
    expect(existsSync(ancestor), '조상 뿌리를 건드렸다').toBe(true)
  } finally {
    rmSync(ancestor, { recursive: true, force: true })
  }
})

test('정리하면 TMPDIR·TMP·TEMP 를 이전 값으로 되돌린다 (중요3)', () => {
  const sentinel = realpathSync(mkdtempSync(join(tmpdir(), 'tmp-run-restore-')))
  try {
    const out = runIsolated(tmpEnv({ TMPDIR: sentinel, TMP: sentinel, TEMP: sentinel }),
      'out.root = m.isolateTmpdir()\nout.during = [process.env.TMPDIR, process.env.TMP, process.env.TEMP]\nm.cleanupTmpdir()\nout.after = [process.env.TMPDIR, process.env.TMP, process.env.TEMP]\nout.left = fs.existsSync(out.root)')
    expect(out.during, '실행 중에는 뿌리를 가리켜야 한다').toEqual([out.root, out.root, out.root])
    expect(out.after, '지운 뿌리를 계속 가리킨다').toEqual([sentinel, sentinel, sentinel])
    expect(out.left, '뿌리가 남았다').toBe(false)
    expect(existsSync(sentinel), '원래 임시 폴더를 지웠다').toBe(true)
  } finally {
    rmSync(sentinel, { recursive: true, force: true })
  }
})

test('원래 없던 변수는 지운다 (중요3)', () => {
  test.skip(process.platform === 'win32', '윈도는 TEMP·TMP 가 없으면 os.tmpdir() 이 임시 경로를 못 찾는다')
  const out = runIsolated(tmpEnv(),
    'out.root = m.isolateTmpdir()\nm.cleanupTmpdir()\nout.after = [process.env.TMPDIR ?? null, process.env.TMP ?? null, process.env.TEMP ?? null]')
  expect(out.after, '없던 변수가 남았다').toEqual([null, null, null])
})

test('지우기 실패는 상태를 남겨 두 번째 시도에서 끝난다 (중요4)', () => {
  // 루트 권한은 chmod 잠금을 무시한다 — 그 환경에서는 첫 시도가 성공하므로 잠금 반례를 못 만든다.
  test.skip(process.platform === 'win32' || process.getuid?.() === 0,
    '윈도 파일 잠금·루트 권한은 이 방식으로 재현되지 않는다 — rmSync 재시도 설정이 덮는다')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmp-run-retry-')))
  try {
    const out = runIsolated(tmpEnv({ TMPDIR: base, TMP: base, TEMP: base }), [
      'out.root = m.isolateTmpdir()',
      'const locked = out.root + "/locked"',
      'fs.mkdirSync(locked)',
      'fs.writeFileSync(locked + "/file.txt", "x")',
      'fs.chmodSync(locked, 0o000)',
      'm.cleanupTmpdir()',
      'out.firstLeft = fs.existsSync(out.root)',
      'out.firstEnv = process.env.TMPDIR === out.root',
      'fs.chmodSync(locked, 0o755)',
      'm.cleanupTmpdir()',
      'out.secondLeft = fs.existsSync(out.root)',
      'out.secondEnv = process.env.TMPDIR === out.root'
    ].join('\n'))
    expect(out.firstLeft, '잠긴 폴더가 있는데 첫 시도가 지웠다고 본다').toBe(true)
    expect(out.firstEnv, '실패했는데 정리 끝으로 처리해 상태를 버렸다').toBe(true)
    expect(out.secondLeft, '두 번째 시도가 지우지 못했다').toBe(false)
    expect(out.secondEnv, '지운 뒤에도 뿌리를 가리킨다').toBe(false)
  } finally {
    // 두 번째 시도가 실패한 경우에도 잠금을 풀고 이 실행이 만든 것만 지운다.
    for (const entry of safeReaddir(base)) {
      const locked = join(base, entry, 'locked')
      if (existsSync(locked)) {
        try { chmodSync(locked, 0o755) } catch { /* 이미 지워졌다 */ }
      }
    }
    rmSync(base, { recursive: true, force: true })
  }
})

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) as string[] } catch { return [] }
}
