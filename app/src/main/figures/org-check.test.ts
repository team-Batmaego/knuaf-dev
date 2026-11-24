import type * as orgTypes from './org-check'
import type * as rulesTypes from './rules'
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  }
})
// Static imports resolve before registerHooks; these extensionless app imports require the registered hook.
const org = await import(new URL('./org-check.ts', import.meta.url).href) as typeof orgTypes
const rules = await import(new URL('./rules.ts', import.meta.url).href) as typeof rulesTypes
const vectors = JSON.parse((await readFile(new URL('./fixtures/org-vectors.json', import.meta.url), 'utf8'))
  .replace(/\{\{(.)\*(\d+)\}\}/g, (_all, char: string, count: string) => char.repeat(Number(count)))) as {
  pageUrl: string
  rules: unknown
  hit: [string, string[], boolean, string][]
  scope: [string, string, 'none' | 'hit' | 'unknown', string][]
}
const [rule] = rules.parseRules(JSON.stringify(vectors.rules))
assert.ok(rule)

describe('RDA — foreignMarkIn shared hit vectors', () => {
  for (const [text, aliases, expected, memo] of vectors.hit) {
    it(memo, () => assert.equal(org.foreignMarkIn(text, { ...rule, orgAliases: rules.sortOrgAliases(aliases) }), expected))
  }
})
describe('RDA — orgReading shared scope vectors', () => {
  for (const [template, image, expected, memo] of vectors.scope) {
    it(memo, () => {
      const html = template.replaceAll('{B}', rule.bodyStart!).replaceAll('{M}', rule.bodyEnd!)
      assert.equal(org.orgReading(html, image, new URL(vectors.pageUrl), rule).reading, expected)
    })
  }
})
