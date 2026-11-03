// Shared dependency/build input. No floating branch or implicit alternate source.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { checkSource } from './compose-skill.mjs'

const app = resolve(import.meta.dirname, '..')
export function fetchPinnedSkill({ offline = false } = {}) {
  const source = JSON.parse(readFileSync(join(app, 'skill-source.json'), 'utf8'))
  if (source.repo !== 'starceas/knuaf-doc' || !/^v\d+\.\d+\.\d+$/.test(source.tag) || !/^[a-f0-9]{40}$/.test(source.commit)) {
    throw new Error('Invalid pinned source')
  }
  if (process.env.KNUAF_SKILL_UPSTREAM) {
    const upstream = resolve(process.env.KNUAF_SKILL_UPSTREAM)
    checkSource(source, upstream)
    return upstream
  }
  const cache = join(app, 'resources', 'skill-upstreams'), upstream = join(cache, source.commit)
  if (existsSync(upstream)) {
    checkSource(source, upstream)
    return upstream
  }
  if (offline) {
    throw new Error(`Offline pinned source cache miss: ${source.tag}@${source.commit}; expected ${upstream}. ` +
      'Populate this cache online first, or set KNUAF_SKILL_UPSTREAM to a clean matching checkout.')
  }
  mkdirSync(cache, { recursive: true })
  const temp = mkdtempSync(join(cache, '.checkout-'))
  try {
    execFileSync('git', ['clone', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf',
      '--quiet', '--depth', '1', '--branch', source.tag,
      `https://github.com/${source.repo}.git`, temp], { stdio: 'pipe' })
    checkSource(source, temp)
    renameSync(temp, upstream)
    return upstream
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    requirements: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false }
  } })
  try {
    const upstream = fetchPinnedSkill({ offline: values.offline })
    console.log(values.requirements ? join(upstream, 'skills/knuaf-doc/scripts/requirements-runtime.txt') : upstream)
  } catch (error) {
    console.error(`[skill-source] Pinned source preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
