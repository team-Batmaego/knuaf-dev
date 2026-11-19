import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { jsonBytes, VERSION } from '../compose-skill.mjs'
import { SKILL_MIN_APP, signedChannel } from '../sign-skill.mjs'
import { checkSkillReleaseWorkflow } from './check-skill-workflow.mjs'

// The pinned value is the delivered fact, not a second source: the signer reads SKILL_MIN_APP, and
// this line only fails when that declaration moves without a decision. v0.7.1 shipped without #165,
// so the first app release that renders the finance cards is v0.7.2.
const DECIDED_FLOOR = '0.7.2'
const signer = resolve(import.meta.dirname, '../sign-skill.mjs')
const composer = resolve(import.meta.dirname, '../compose-skill.mjs')
const workflowPath = resolve(import.meta.dirname, '../../..', '.github/workflows/skill-release.yml')

const privateKey = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
}

/** Pinned upstream repo, app overlay and channel file the signer CLI reads. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-min-app-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const upstream = join(root, 'upstream')
  mkdirSync(join(upstream, 'skills/knuaf-doc'), { recursive: true })
  writeFileSync(join(upstream, 'skills/knuaf-doc/SKILL.md'), '---\nname: knuaf-doc\ndescription: 시험\n---\n# 원본\n')
  git(upstream, 'init', '--quiet')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '--quiet', '-m', 'pinned')
  const commit = git(upstream, 'rev-parse', 'HEAD').trim()
  git(upstream, 'tag', 'v0.2.0')
  const sourcePath = join(root, 'source.json')
  writeFileSync(sourcePath, jsonBytes({ repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit }))

  const overlay = join(root, 'overlay')
  mkdirSync(overlay)
  writeFileSync(join(overlay, 'overlay.json'),
    jsonBytes({ schema: 1, name: 'knuaf-dev', remove: ['tests/', 'install-manifest.json'], append: null }))
  const expectedOverlay = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { overlayHash } = await import(${JSON.stringify(pathToFileURL(composer).href)});` +
    `process.stdout.write(overlayHash(${JSON.stringify(overlay)}))`], { encoding: 'utf8' })

  const channelPath = join(root, 'channel.json')
  writeFileSync(channelPath, jsonBytes({ schema: 1, app: { latest: '0.6.0', page: 'unchanged' } }))
  return { root, upstream, sourcePath, overlay, expectedOverlay, channelPath }
}

/** Compose a candidate bundle with the repo's own composer, then run the signer CLI on it. */
function runSigner(t, extraArgs = []) {
  const f = fixture(t)
  const bundle = join(f.root, 'bundle'), archive = join(f.root, 'skill.zip'), output = join(f.root, 'out')
  execFileSync(process.execPath, [composer, '--upstream', f.upstream, '--source', f.sourcePath,
    '--output', bundle, '--zip', archive, '--version', '1.0.0', '--overlay', f.overlay], { encoding: 'utf8' })
  const result = spawnSync(process.execPath, [signer, '--directory', bundle, '--zip', archive, '--output', output,
    '--upstream', f.upstream, '--source', f.sourcePath, '--version', '1.0.0',
    '--overlay', f.overlay, '--expected-overlay', f.expectedOverlay,
    '--channel', f.channelPath, ...extraArgs], {
    encoding: 'utf8', env: { ...process.env, SKILL_SIGNING_PRIVATE_KEY: privateKeyPem }
  })
  return { ...f, output, result }
}

test('the declared skill floor is the delivered X.Y.Z and nothing else', () => {
  assert.match(SKILL_MIN_APP, VERSION)
  assert.equal(SKILL_MIN_APP, DECIDED_FLOOR)
})

test('the signer refuses a per-run floor so a workflow cannot pin an older value', t => {
  const { result } = runSigner(t, ['--min-app', '0.6.0'])
  assert.notEqual(result.status, 0, 'the signer accepted --min-app and would sign an arbitrary floor')
  assert.match(result.stderr, /min-app|Unknown option/)
})

test('the signed manifest and channel carry the declared floor, not the old 0.6.0', t => {
  const { output, result } = runSigner(t)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`minApp ${DECIDED_FLOOR.replace(/\./g, '\\.')}`))
  const manifest = JSON.parse(readFileSync(join(output, 'skill-manifest.json'), 'utf8'))
  assert.equal(manifest.minApp, SKILL_MIN_APP)
  const channel = JSON.parse(readFileSync(join(output, 'channel.json'), 'utf8'))
  assert.equal(channel.skill.minApp, SKILL_MIN_APP)
  // Signing the skill release must not disturb the app half of the channel.
  assert.deepEqual(channel.app, { latest: '0.6.0', page: 'unchanged' })
})

test('the signature covers the floor: a lowered minApp fails verification', () => {
  const publicKey = privateKey.publicKey
  const signed = Buffer.from(jsonBytes({ schema: 1, name: 'knuaf-dev', version: '1.0.0', api: 1, minApp: SKILL_MIN_APP }))
  const channel = signedChannel({ schema: 1 }, signed, privateKeyPem)
  assert.deepEqual(Buffer.from(channel.skill.manifest, 'base64'), signed)
  const sig = Buffer.from(channel.skill.sig, 'base64')
  assert.equal(verify(null, signed, publicKey, sig), true)
  const lowered = Buffer.from(jsonBytes({ schema: 1, name: 'knuaf-dev', version: '1.0.0', api: 1, minApp: '0.6.0' }))
  assert.equal(verify(null, lowered, publicKey, sig), false, 'the floor must be inside the signed bytes')
})

test('skill-release.yml never pins its own floor and runs this test before publishing', () => {
  const text = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n')
  assert.doesNotMatch(text, /--min-app/, 'the workflow must not pass a floor argument at all')
  assert.match(text, /SKILL_MIN_APP/, 'the approval summary must name the floor the run will sign with')
  assert.match(text, /skill-min-app\.test\.mjs/, 'the publish job must run this floor test before signing')
  assert.equal(checkSkillReleaseWorkflow(text), true)
})
