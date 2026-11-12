/**
 * figures/rules.test.ts — 사람이 검토한 규칙집만 읽는다 (설계 R4-4·§10, I-03).
 *
 * 핵심 경계: 파일이 없거나 깨지면 **빈 목록**(= 전부 거절)이다. 내장 기본 목록으로 넓히면 사람 검토
 * 없이 승인되는 경로가 생긴다.
 */

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})

const rulesMod = (await import(new URL('./rules.ts', import.meta.url).href)) as typeof import('./rules')

let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knuaf-rules-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

const valid = {
  id: 'nongsaro-curation',
  host: 'www.nongsaro.go.kr',
  org: '농촌진흥청',
  pagePath: '^/portal/ps/psv/psvr/psvre/curationDtl\\.ps',
  imagePath: '^/ps/img/curation/',
  rule: 'page_kogl_applies_to_body_images',
  evidence: 'https://www.nongsaro.go.kr/...',
  note: '이용약관 확인'
}

const doc = (rules: unknown[]): string => JSON.stringify({ v: 1, rules })

describe('loadRules', () => {
  it('스킬 루트의 references/figure-sources.json을 읽는다', async () => {
    const source = join(root, 'valid')
    await mkdir(join(source, 'references'), { recursive: true })
    await writeFile(join(source, 'references', 'figure-sources.json'), doc([valid]))
    const load = await rulesMod.loadRules(source)
    assert.equal(load.ok, true)
    assert.equal(load.rules.length, 1)
    assert.equal(load.source, join(source, 'references', 'figure-sources.json'))
    assert.equal(load.rules[0]?.evidence, valid.evidence)
  })

  it('판이 없으면 ok:false · missing · 빈 목록', async () => {
    assert.deepEqual(await rulesMod.loadRules(null), { ok: false, rules: [], source: null, problem: 'missing' })
  })

  it('파일이 없으면 missing(내장 목록 없음)', async () => {
    const load = await rulesMod.loadRules(join(root, 'nope'))
    assert.equal(load.ok, false)
    assert.equal(load.problem, 'missing')
    assert.deepEqual(load.rules, [])
  })
})

describe('parseRules', () => {
  it('정상 항목은 그대로', () => {
    const rules = rulesMod.parseRules(doc([valid]))
    assert.equal(rules.length, 1)
    assert.deepEqual(Object.keys(rules[0] as object).sort(), [
      'evidence',
      'host',
      'id',
      'imagePath',
      'note',
      'org',
      'pagePath',
      'rule'
    ])
  })

  it('깨진 JSON·모양 아니면 빈 목록', () => {
    assert.deepEqual(rulesMod.parseRules('{'), [])
    assert.deepEqual(rulesMod.parseRules('[]'), [])
    assert.deepEqual(rulesMod.parseRules('"x"'), [])
    assert.deepEqual(rulesMod.parseRules(JSON.stringify({ rules: 'no' })), [])
  })

  it('모르는 판정 규칙은 그 항목만 버린다', () => {
    const rules = rulesMod.parseRules(doc([{ ...valid, id: 'a', rule: 'future_rule' }, { ...valid, id: 'b' }]))
    assert.deepEqual(rules.map((rule) => rule.id), ['b'])
  })

  it('깨진 정규식 항목은 그 항목만 버린다', () => {
    const rules = rulesMod.parseRules(doc([{ ...valid, id: 'a', pagePath: '([' }, { ...valid, id: 'b', imagePath: '(?<' }]))
    assert.deepEqual(rules, [])
    const mixed = rulesMod.parseRules(doc([{ ...valid, id: 'a', pagePath: '([' }, { ...valid, id: 'b' }]))
    assert.deepEqual(mixed.map((rule) => rule.id), ['b'])
  })

  it('호스트에 경로·사용자정보·포트가 섞이면 버린다', () => {
    for (const host of ['www.nongsaro.go.kr/x', 'u@www.nongsaro.go.kr', 'www.nongsaro.go.kr:8443']) {
      assert.deepEqual(rulesMod.parseRules(doc([{ ...valid, host }])), [], host)
    }
  })

  it('필수 필드가 비면 버린다', () => {
    for (const key of ['id', 'host', 'org', 'pagePath', 'imagePath', 'rule']) {
      assert.deepEqual(rulesMod.parseRules(doc([{ ...valid, [key]: '' }])), [], key)
    }
  })

  it('evidence·note는 선택', () => {
    const bare = { ...valid } as Record<string, unknown>
    delete bare.evidence
    delete bare.note
    const rules = rulesMod.parseRules(doc([bare]))
    assert.equal(rules.length, 1)
    assert.equal(rules[0]?.evidence, undefined)
  })
})
