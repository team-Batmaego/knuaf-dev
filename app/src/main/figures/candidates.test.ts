import type * as candidatesTypes from './candidates'
import type * as contractTypes from './contract'
import type * as urlRulesTypes from './url-rules'
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { FigureRule } from './url-rules'

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})
// 정적 import는 해석 훅 등록보다 먼저 돈다. 확장자 없는 앱 모듈은 등록 뒤에만 읽는다.
const { extractCandidates } = await import(new URL('./candidates.ts', import.meta.url).href) as typeof candidatesTypes
const { parseFigureRequest } = await import(new URL('./contract.ts', import.meta.url).href) as typeof contractTypes
const { isAllowedImage } = await import(new URL('./url-rules.ts', import.meta.url).href) as typeof urlRulesTypes
const fixture = JSON.parse((await readFile(new URL('./fixtures/candidates-vectors.json', import.meta.url), 'utf8'))
  .replace(/\{\{(.*?)\*(\d+)\}\}/g, (_all, text: string, count: string) => text.repeat(Number(count)))) as {
  rule: FigureRule
  vectors: [string, string, string[], boolean, string][]
}

describe('extractCandidates — shared P1.1 vectors', () => {
  for (const [html, page, urls, truncated, memo] of fixture.vectors) {
    it(memo, () => {
      const found = extractCandidates(html, new URL(page), fixture.rule)
      const credit = memo === 'credit in alt' || memo === 'credit adjacent' ? 'credit' : 'none'
      assert.deepEqual(found, {
        candidates: urls.map((url) => ({ url, credit })), candidatesTruncated: truncated
      })
      for (const candidate of found.candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), ['credit', 'url'])
        const request = { v: 1, id: 'req-vectors', turnId: 'turn-1', slot: '3.2', page, images: [candidate.url] }
        assert.equal(parseFigureRequest(JSON.stringify(request)).ok, true)
        assert.equal(isAllowedImage(candidate.url, fixture.rule, [fixture.rule]).ok, true)
      }
      assert.doesNotMatch(JSON.stringify(found), /이전 지시|사이트 지시|\u202e|😀/)
    })
  }
})
