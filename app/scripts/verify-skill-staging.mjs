// 스테이징된 스킬 번들이 지금 핀과 **같은지** 본다 — 커밋 훅의 빠른 길 가드.
//
// 왜 필요한가: `tests/conftest.py:26-30` 은 `KNUAF_TEST_SCRIPTS_DIR` 가 있으면 스테이징(약 2분06초)을
// 건너뛴다. 그래서 훅이 이 변수를 직접 주면, 핀이 바뀐 뒤 낡은 번들로 518개 시험을 돌려 **초록인데
// 틀린** 결과가 나온다. 태그 문자열만 비교하면 더 나쁘다: 핀이 같은 태그에서 새 커밋으로 옮겨가도
// (v0.4.8@A → v0.4.8@B) 통과한다.
//
// 그래서 네 가지를 본다: (1) `skill-source.json` 의 tag·commit, (2) 스테이징본 `skill.json`
// 의 `.source.tag`·`.source.commit` 이 그것과 같은지, (3) 매니페스트 `files` 가 비어 있지 않은
// 객체인지, (4) 선언한 209개 파일의 sha256 이 실제 내용과 같은지(실측 0.06~0.19초/24.6MB).
// 하나라도 어긋나면 exit 1 — 호출자(훅)는 전체 실행으로 되돌아간다(fail-closed). 조용히 낡은
// 번들을 시험하지 않는다.
//
// (3)을 먼저 보는 이유: `files` 가 없거나 빈 객체면 (4)의 루프가 한 번도 안 돌아
// "0개 파일 해시 일치"로 초록이 된다 — 검사가 사라진 것과 같다. 그래서 `files` 는 비어 있지
// 않은 일반 객체여야 하고, 아니면 exit 1(전체 실행)이다.
//
// 이 스크립트는 아무것도 쓰지 않는다. 읽기 전용이고, stdout 은 성공 요약 한 줄뿐이다.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..')
const BUNDLE = join(REPO, 'app', 'resources', 'skill')

function fail(reason) {
  console.error(`[skill-staging] ${reason} — 전체 실행(스테이징 포함)으로 돈다`)
  process.exitCode = 1
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} 를 읽을 수 없다(${path}): ${error.message}`)
    return null
  }
}

/** `files` 는 경로→sha256 표다. 빈 표는 "대조 없음"이므로 통과가 아니라 실패다. */
function isFileMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

function describe(value) {
  if (value === undefined) return '없음'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `배열 ${value.length}개`
  if (typeof value === 'object') return `빈 객체`
  return `${typeof value} ${JSON.stringify(value)}`
}

const source = readJson(join(REPO, 'app', 'skill-source.json'), 'app/skill-source.json')
const staged = source && readJson(join(BUNDLE, 'skill.json'), 'app/resources/skill/skill.json')
const manifest = source && readJson(join(BUNDLE, 'install-manifest.json'), 'app/resources/skill/install-manifest.json')

if (source && staged && manifest) {
  const pinned = `${source.tag}@${source.commit}`
  const found = staged.source && `${staged.source.tag}@${staged.source.commit}`

  if (found !== pinned) {
    fail(`스테이징본이 핀과 다르다(핀 ${pinned} · 스테이징 ${found ?? '없음'})`)
  } else if (!isFileMap(manifest.files)) {
    fail(`install-manifest.json 의 files 가 비어 있지 않은 객체가 아니다(${describe(manifest.files)})`)
  } else {
    // 매니페스트는 자기 자신을 해시할 수 없다(compose-skill.mjs:129). 선언된 파일만 본다.
    let hashed = 0
    let bytes = 0
    for (const [rel, want] of Object.entries(manifest.files)) {
      const path = join(BUNDLE, rel)
      let buf
      try {
        buf = readFileSync(path)
      } catch (error) {
        fail(`선언된 파일이 없다: ${rel} (${error.code ?? error.message})`)
        break
      }
      bytes += buf.length
      hashed++
      if (createHash('sha256').update(buf).digest('hex') !== want) {
        fail(`선언된 해시와 내용이 다르다: ${rel}`)
        break
      }
    }
    try {
      if (statSync(join(BUNDLE, 'scripts')).isDirectory()) {
        if (!process.exitCode) {
          console.log(`[skill-staging] 핀 일치 ${pinned} · 선언 ${hashed}개 파일 ${bytes} B 해시 일치`)
        }
      } else {
        fail('scripts/ 가 디렉터리가 아니다')
      }
    } catch {
      fail('scripts/ 가 없다')
    }
  }
}
