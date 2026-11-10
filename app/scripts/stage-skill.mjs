// Packaging and release use the same composition; only compatible final bytes become S0.
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { relative, resolve, isAbsolute, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { checkSource, composeFiles, readTree, writeTree, zipBytes, sha256, validVersion } from './compose-skill.mjs'
import { runCompatibility } from './tests/run-skill-compat.mjs'
import { fetchPinnedSkill } from './fetch-skill.mjs'

const app = resolve(import.meta.dirname, '..')
const defaultPython = process.env.PYTHON || (existsSync(resolve(app, '../.venv-dev/bin/python'))
  ? resolve(app, '../.venv-dev/bin/python') : process.platform === 'win32' ? 'python' : 'python3')

/** `--output` must never reach the pinned source cache: staging deletes whatever it replaces. */
export function assertStagingOutput(output, appRoot = app) {
  const cache = resolve(appRoot, 'resources', 'skill-upstreams'), target = resolve(output)
  const contains = (parent, child) => {
    const rest = relative(parent, child)
    return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
  }
  if (contains(cache, target) || contains(target, cache)) {
    throw new Error(`Refusing to stage over the pinned source cache: ${target} overlaps ${cache}. ` +
      'Use an output outside app/resources (the default is app/resources/skill).')
  }
  return target
}

/** Also accepts an explicit local composition for offline compatibility verification. */
export function stageComposed({ files, upstream, output, python = defaultPython }) {
  assertStagingOutput(output)
  const temp = mkdtempSync(join(tmpdir(), 'knuaf-stage-check-'))
  try {
    const bundle = join(temp, 'bundle'), archive = join(temp, 'skill.zip')
    writeTree(files, bundle)
    const zip = zipBytes(files)
    writeFileSync(archive, zip)
    const result = runCompatibility({ bundle, upstream, archive, expectedZip: sha256(zip), python })
    if (!result.ok) throw new Error(`Pinned skill is incompatible: consumer=${result.consumer}, upstream=${result.basic}, candidateValid=${result.candidateValid}`)
    // A failed compose/test never removes a previously staged bundle.
    if (existsSync(output)) rmSync(output, { recursive: true })
    writeTree(files, output)
    console.log(`staged ${files.size} verified skill files → ${output}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const channel = JSON.parse(readFileSync(resolve(app, '../updates/channel.json'), 'utf8'))
  const packageMetadata = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'))
  const versions = [packageMetadata.skillVersion, ...(channel.skill ? [channel.skill.version] : [])]
  if (versions.some(version => !validVersion(version))) throw new Error('Invalid reserved/channel stage version')
  versions.sort((a, b) => {
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]
    return 0
  })
  const { values } = parseArgs({ options: {
    upstream: { type: 'string', default: process.env.KNUAF_SKILL_UPSTREAM },
    output: { type: 'string', default: resolve(app, 'resources/skill') },
    version: { type: 'string', default: versions.at(-1) },
    python: { type: 'string', default: defaultPython },
    offline: { type: 'boolean', default: false }
  } })
  const source = JSON.parse(readFileSync(resolve(app, 'skill-source.json'), 'utf8'))
  let snapshot
  try {
    console.error(`[skill-stage] Preparing ${source.tag}@${source.commit} (${values.offline ? 'offline: verified local sources only' : 'validated cache first'})`)
    const upstream = values.upstream ? resolve(values.upstream) : fetchPinnedSkill({ offline: values.offline })
    const pinned = checkSource(source, upstream)
    snapshot = mkdtempSync(join(tmpdir(), 'knuaf-pinned-source-'))
    writeTree(pinned.files, snapshot)
    for (const path of pinned.executable) chmodSync(join(snapshot, path), 0o755)
    const files = composeFiles(readTree(join(snapshot, 'skills/knuaf-doc')), {
      source, overlay: resolve(app, 'skill-overlay'), version: values.version
    })
    stageComposed({ files, upstream: snapshot, output: resolve(values.output), python: values.python })
  } catch (error) {
    console.error(`[skill-stage] Runtime preparation failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true })
  }
}
