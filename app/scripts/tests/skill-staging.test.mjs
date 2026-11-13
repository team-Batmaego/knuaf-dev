import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 이 시험은 훅의 빠른 길 가드(`scripts/verify-skill-staging.mjs`)가 **검사 없이 초록**이 되는 길을 잠근다.
// 사고 모양: 매니페스트 `files` 가 없거나 비면 대조할 항목이 0개라 루프가 한 번도 안 돌고,
// "선언 0개 파일 0 B 해시 일치"로 exit 0 이 된다. 그러면 핀이 바뀐 낡은 번들로 518개 시험이 초록이 된다
// (`tests/conftest.py:26-30` 이 `KNUAF_TEST_SCRIPTS_DIR` 를 받으면 스테이징을 건너뛴다).
// 그래서 검증기를 단위 함수가 아니라 **실행 파일 그대로** 임시 트리에서 돌려 exit code 로 본다.

const verifier = resolve(import.meta.dirname, '../verify-skill-staging.mjs')

const PIN = { repo: 'starceas/knuaf-doc', tag: 'v0.4.8', commit: '8450b9d5051bcb7f084bc56a0a74dfb9211f096f' }
const sha256 = text => createHash('sha256').update(text).digest('hex')

/** 핀이 맞는 트리를 만들고, `files` 만 바꿔 끼운다. `files` 가 `undefined` 면 키 자체를 뺀다. */
function tree(files) {
  const repo = mkdtempSync(join(tmpdir(), 'skill-staging-'))
  const bundle = join(repo, 'app', 'resources', 'skill')
  mkdirSync(join(bundle, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'app', 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'app', 'skill-source.json'), JSON.stringify(PIN))
  writeFileSync(join(bundle, 'skill.json'), JSON.stringify({ version: '1.0.2', api: 1, source: PIN }))
  writeFileSync(join(bundle, 'SKILL.md'), '# skill\n')
  writeFileSync(join(bundle, 'scripts', 'gg.py'), 'print(1)\n')
  copyFileSync(verifier, join(repo, 'app', 'scripts', 'verify-skill-staging.mjs'))
  const manifest = { schema: 1 }
  if (files !== undefined) manifest.files = files
  writeFileSync(join(bundle, 'install-manifest.json'), JSON.stringify(manifest))
  return repo
}

/** 검증기를 실제 실행 파일로 돌린다(성공 요약은 stdout, 실패 이유는 stderr). */
function run(files) {
  const repo = tree(files)
  try {
    const result = spawnSync(process.execPath, [join(repo, 'app', 'scripts', 'verify-skill-staging.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(result.error, undefined, `실행기 자체가 죽었다: ${result.error?.message}`)
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

const GOOD = { 'SKILL.md': sha256('# skill\n'), 'scripts/gg.py': sha256('print(1)\n') }

test('선언이 온전하면 0 이고 선언 개수를 말한다', () => {
  const { status, stdout, stderr } = run(GOOD)
  assert.equal(status, 0, `온전한 트리가 실패했다: ${stderr}`)
  assert.match(stdout, /선언 2개 파일 \d+ B 해시 일치/, stdout)
})

test('선언 해시가 어긋나면 0 이 아니다', () => {
  // 그릇 검사만 통과하고 실제 대조가 사라지는 회귀도 여기서 걸린다.
  const { status, stderr } = run({ ...GOOD, 'SKILL.md': sha256('# 다른 내용\n') })
  assert.notEqual(status, 0)
  assert.match(stderr, /선언된 해시와 내용이 다르다: SKILL\.md/, stderr)
})

// 아래 네 갈래는 모두 "검사할 항목 0개 → 초록"이 되던 구멍이다. exit 0 이면 훅이 낡은 번들을 시험한다.
for (const [label, files] of [
  ['files 키 없음', undefined],
  ['files 가 빈 객체', {}],
  ['files 가 배열', ['SKILL.md']],
  ['files 가 문자열', 'SKILL.md'],
  ['files 가 null', null],
]) {
  test(`${label} 이면 0 이 아니다 (검사 0개 통과 금지)`, () => {
    const { status, stdout, stderr } = run(files)
    assert.notEqual(status, 0, `검사 없이 통과했다: ${stdout}`)
    assert.match(stderr, /install-manifest\.json 의 files 가 비어 있지 않은 객체가 아니다/, stderr)
    assert.equal(stdout, '', '실패하는데 성공 요약을 내면 훅 로그가 거짓말한다')
  })
}
