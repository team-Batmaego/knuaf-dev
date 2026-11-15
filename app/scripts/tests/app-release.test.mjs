import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { archiveTag, assertNoPendingChannelUpdates, cleanupCommands, readChannelState, runCommand } from '../check-channel-update-state.mjs'
import { checkSkillReleaseWorkflow } from './check-skill-workflow.mjs'
import { verifyPublicAsset } from '../check-app-channel.mjs'
import { buildSignedChannel, releasePage, signingKeyFromEnvironment, verifyAppChannel, verifyAppEnvelope } from '../sign-app.mjs'

const vector = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/app-signature-vector.json'), 'utf8'))
const signer = resolve(import.meta.dirname, '../sign-app.mjs')
const fixturePrivateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vector.testPrivateKeySeedHex, 'hex')]),
  format: 'der', type: 'pkcs8'
})
const fixturePrivateKeyPem = fixturePrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const fixtureKeys = vector.publicKeys.map(pem => {
  const key = createPublicKey(pem)
  return { pem, der: key.export({ type: 'spki', format: 'der' }) }
})

function buildVector({ tag = vector.tag, channel = vector.inputChannel, installer = Buffer.from(vector.installerBase64, 'base64') } = {}) {
  const keys = { current: fixtureKeys[0], reserve: fixtureKeys[1] }
  const privateKey = signingKeyFromEnvironment(fixturePrivateKeyPem, keys.current)
  return buildSignedChannel({
    channel, tag, size: installer.length, sha256: createHash('sha256').update(installer).digest('hex'), privateKey, keys
  })
}


function runSigner(t, { tag = vector.tag, channel = vector.inputChannel, installer = Buffer.from(vector.installerBase64, 'base64'), key = fixturePrivateKeyPem, extraArgs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-app-release-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const installerPath = join(root, 'installer.exe')
  const channelPath = join(root, 'channel.json')
  const outputPath = join(root, 'output')
  writeFileSync(installerPath, installer)
  writeFileSync(channelPath, `${JSON.stringify(channel)}\n`)
  try {
    const stdout = execFileSync(process.execPath, [signer, '--tag', tag, '--installer', installerPath, '--channel', channelPath, '--output', outputPath, ...extraArgs], {
      encoding: 'utf8', env: { ...process.env, APP_SIGNING_PRIVATE_KEY: key }, stdio: ['ignore', 'pipe', 'pipe']
    })
    return { root, outputPath, stdout, error: null }
  } catch (error) {
    return { root, outputPath, stdout: '', error }
  }
}

function errorText(result) {
  return result.error?.stderr?.toString('utf8') ?? ''
}

test('sign-app reproduces the committed byte vector and preserves the skill entry', () => {
  const result = buildVector()
  const channelBytes = Buffer.from(`${JSON.stringify(result.channel, null, 2)}\n`)
  assert.deepEqual(channelBytes, Buffer.from(`${JSON.stringify(vector.expectedChannel, null, 2)}\n`))
  const envelope = vector.expectedChannel.app['win32-x64']
  assert.deepEqual(result.manifestBytes, Buffer.from(envelope.manifest, 'base64'))
  assert.equal(result.signature, envelope.sig)
  assert.deepEqual(result.channel.skill, vector.inputChannel.skill)
  assert.deepEqual(Object.keys(JSON.parse(result.manifestBytes.toString('utf8'))), ['schema', 'name', 'version', 'platform', 'url', 'size', 'sha256'])
  assert.equal(verifyAppChannel(result.channel, vector.publicKeys).manifest.sha256,
    createHash('sha256').update(Buffer.from(vector.installerBase64, 'base64')).digest('hex'))
})

test('the signer rejects altered bytes, duplicated URL/version metadata, and a mismatched page', () => {
  const channel = vector.expectedChannel
  const envelope = channel.app['win32-x64']
  const changedBytes = Buffer.from(envelope.manifest, 'base64')
  changedBytes[vector.mutation.offset] ^= vector.mutation.xor
  assert.throws(() => verifyAppEnvelope({ ...envelope, manifest: changedBytes.toString('base64') }, vector.publicKeys), /signature/i)
  assert.throws(() => verifyAppEnvelope({ ...envelope, url: `${envelope.url}.other` }, vector.publicKeys), /differs from signed manifest/)
  assert.throws(() => verifyAppEnvelope({ ...envelope, version: '0.6.2' }, vector.publicKeys), /differs from signed manifest/)
  assert.throws(() => verifyAppChannel({ ...channel, app: { ...channel.app, page: releasePage('0.6.0') } }, vector.publicKeys), /page/)
})

test('same-version signing requires identical bytes; lower versions and removed URL inputs fail closed', t => {
  const sameBytes = buildVector({ channel: vector.expectedChannel })
  assert.equal(sameBytes.signature, vector.expectedChannel.app['win32-x64'].sig)
  assert.throws(() => buildVector({
    channel: vector.expectedChannel,
    installer: Buffer.concat([Buffer.from(vector.installerBase64, 'base64'), Buffer.from([0])])
  }), /Same-version signing is allowed only for identical installer bytes/)
  assert.throws(() => buildVector({ tag: 'v0.4.0' }), /older than the current app channel/)
  const urlInput = runSigner(t, { extraArgs: ['--url', 'https://example.invalid/installer.exe'] })
  assert.match(errorText(urlInput), /Unknown option|Unexpected argument/)
})

test('the signing key must match current and mismatch errors never print its value', t => {
  const matching = signingKeyFromEnvironment(fixturePrivateKeyPem, fixtureKeys[0])
  assert.equal(matching.asymmetricKeyType, 'ed25519')
  const wrongKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(() => signingKeyFromEnvironment(wrongKey, fixtureKeys[0]), /does not match current update key/)
  const result = runSigner(t, { key: wrongKey })
  const stderr = errorText(result)
  assert.match(stderr, /does not match current update key/)
  assert.equal(stderr.includes(wrongKey), false)
  assert.equal(existsSync(result.outputPath), false)
})

test('channel conflicts block a run that has a new release to publish', () => {
  const sha = 'a'.repeat(40)
  assert.doesNotThrow(() => assertNoPendingChannelUpdates([], [
    { name: 'app-channel-v0.6.0', status: 'ahead', sha },
    { name: 'skill-channel-update', status: 'identical', sha }
  ]))
  assert.throws(() => assertNoPendingChannelUpdates(['app-channel-v0.6.1'], []), /Open channel PR/)
  assert.throws(() => assertNoPendingChannelUpdates([], [{ name: 'skill-channel-update', status: 'behind', sha }]), /not on main/)
  assert.throws(() => assertNoPendingChannelUpdates([], [{ name: 'app-channel-vbad', status: 'diverged', sha }]), /Unexpected app channel branch/)
  assert.throws(() => assertNoPendingChannelUpdates([], [{ name: 'app-channel-v0.6.2', status: 'behind', sha }]),
    /git fetch origin a{40}[\s\S]*git tag archive\/app-channel-v0\.6\.2-aaaaaaa a{40}[\s\S]*git push origin --delete app-channel-v0\.6\.2/)
})

test('archiving the same reused channel branch twice never reuses a tag name', () => {
  const first = '1'.repeat(40)
  const second = '2'.repeat(40)
  const firstCommands = cleanupCommands('skill-channel-update', first)
  const secondCommands = cleanupCommands('skill-channel-update', second)
  assert.notEqual(firstCommands, secondCommands)
  assert.match(firstCommands, /archive\/skill-channel-update-1111111/)
  assert.match(secondCommands, /archive\/skill-channel-update-2222222/)
  // The tag target is the full head SHA fetched by value, the tag must reach origin and read back
  // as that same SHA, and only then may the branch be deleted. No force, no annotated tag.
  for (const [commands, sha, suffix] of [[firstCommands, first, '1111111'], [secondCommands, second, '2222222']]) {
    const steps = commands.split('\n').map(line => line.trim().replace(/^&& /, '').replace(/ \\$/, ''))
    assert.deepEqual(steps.map(step => step.startsWith('test ') ? 'test' : step.split(' ')[1]),
      ['fetch', 'test', 'tag', 'push', 'test', 'push'])
    assert.equal(steps[0], `git fetch origin ${sha}`)
    assert.equal(steps[1], `test "$(git rev-parse FETCH_HEAD)" = ${sha}`)
    assert.equal(steps[2], `git tag archive/skill-channel-update-${suffix} ${sha}`)
    assert.equal(steps[3], `git push origin refs/tags/archive/skill-channel-update-${suffix}`)
    assert.equal(steps[4], `test "$(git ls-remote origin refs/tags/archive/skill-channel-update-${suffix} | cut -f1)" = ${sha}`)
    assert.equal(steps[5], 'git push origin --delete skill-channel-update')
    // An annotated tag reads back its own tag object SHA, not the commit, so `-a`/`-m` would
    // break the read-back check. The local tracking ref can point at an older proposal.
    assert.doesNotMatch(commands, /-f\b|--force|git tag -a|git tag -m|origin\/skill-channel-update/)
  }
  assert.throws(() => archiveTag('skill-channel-update', 'abc1234'), /full branch head commit SHA/)
  assert.throws(() => cleanupCommands('skill-channel-update', ''), /full branch head commit SHA/)
})

test('an idle run reports the same conflicts without failing', () => {
  const blocked = assertNoPendingChannelUpdates(['skill-channel-update'], [{ name: 'app-channel-v0.6.2', status: 'behind', sha: 'b'.repeat(40) }],
    { pendingNewRelease: false })
  assert.equal(blocked.conflicts.length, 2)
  assert.match(blocked.conflicts.join('\n'), /Open channel PR/)
  assert.match(blocked.conflicts.join('\n'), /not on main/)
  assert.deepEqual(assertNoPendingChannelUpdates([], [], { pendingNewRelease: false }).conflicts, [])
})

test('only an explicit pendingNewRelease=false downgrades a conflict to a warning', () => {
  assert.throws(() => assertNoPendingChannelUpdates(['skill-channel-update'], [], { pendingNewRelease: undefined }), /Open channel PR/)
  assert.throws(() => assertNoPendingChannelUpdates(['skill-channel-update'], [], { pendingNewRelease: 'false' }), /Open channel PR/)
})

test('the channel guard survives gh replies far past the default 1 MB buffer', () => {
  // The compare endpoint returns the entire diff between the channel head and main, and
  // app-channel-v0.6.1 answered 1,537,674 bytes: execFileSync's default ceiling killed the run
  // with ENOBUFS before the guard judged anything. Both halves are locked here — the ceiling
  // itself, and the fact that the guard never asks for that much in the first place.
  const bytes = 3 * 1024 * 1024
  const big = ['-e', `process.stdout.write('x'.repeat(${bytes}))`]
  assert.equal(runCommand(process.execPath, big).length, bytes)
  assert.throws(() => execFileSync(process.execPath, big, { encoding: 'utf8' }), error => error.code === 'ENOBUFS')
})

test('the channel guard keeps its verdicts on the narrowed gh replies', () => {
  const mainSha = 'c'.repeat(40)
  const sha = 'a'.repeat(40)
  const state = ({ heads = '', refs = '', status = 'ahead' } = {}) => (command, args) => {
    const joined = args.join(' ')
    if (command === 'git' && joined.includes('refs/heads/main')) return `${mainSha}\trefs/heads/main`
    if (command === 'git') return refs
    if (joined.includes('/pulls?')) return heads
    return status
  }

  // Narrowing is what keeps the reply small: no whole-document parse, so no --slurp.
  const seen = []
  readChannelState({ repository: 'o/r', run: (command, args) => {
    seen.push(args.join(' '))
    return state({ refs: `${sha}\trefs/heads/app-channel-v0.6.1`, status: 'ahead' })(command, args)
  } })
  assert.match(seen.find(args => args.includes('/pulls?')), /--jq/)
  assert.doesNotMatch(seen.find(args => args.includes('/pulls?')), /--slurp/)
  assert.match(seen.find(args => args.includes('/compare/')), /--jq \.status \/\/ empty$/)

  assert.deepEqual(readChannelState({ repository: 'o/r', run: state({ refs: `${sha}\trefs/heads/skill-channel-update`, status: 'identical' }) }).conflicts, [])
  assert.throws(() => readChannelState({ repository: 'o/r', run: state({ refs: `${sha}\trefs/heads/app-channel-v0.6.1`, status: 'behind' }) }), /not on main/)
  assert.throws(() => readChannelState({ repository: 'o/r', run: state({ refs: `${sha}\trefs/heads/app-channel-v0.6.1`, status: 'diverged' }) }), /not on main/)
  assert.throws(() => readChannelState({ repository: 'o/r', run: state({ heads: 'app-channel-v0.6.2' }) }), /Open channel PR/)
  // No status from GitHub must never read as "on main": it stays unknown and blocks the run.
  assert.throws(() => readChannelState({ repository: 'o/r', run: state({ refs: `${sha}\trefs/heads/app-channel-v0.6.1`, status: '' }) }), /not on main/)
  assert.throws(() => readChannelState({ repository: 'o/r', run: state({ refs: `${sha}\trefs/heads/app-channel-vnext` }) }), /Unexpected app channel branch name/)
  assert.throws(() => readChannelState({ repository: 'o/r', run: (command, args) => args.join(' ').includes('refs/heads/main') ? `${mainSha}\trefs/heads/main` : args.join(' ').includes('-*') ? `not-a-sha\trefs/heads/app-channel-v0.6.1` : '' }), /Unexpected channel branch reference/)
  assert.deepEqual(readChannelState({ repository: 'o/r', run: state({ heads: 'app-channel-v0.6.2' }), pendingNewRelease: false }).conflicts.length, 1)
})

test('the skill-release workflow keeps the guard between planning and reserving work', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/skill-release.yml'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(checkSkillReleaseWorkflow(workflow), true)
  // Each mutation below recreates one way this fix can silently regress, including the five
  // variants the first review showed the earlier contract let through.
  const mutations = [
    [/\n[ \t]*CHANNEL_PENDING_NEW_RELEASE:.*\n/, '\n', /raw plan/],
    [/\n[ \t]*CHANNEL_PENDING_NEW_RELEASE:.*\n/, '\n          CHANNEL_PENDING_NEW_RELEASE: ${{ steps.plan.outputs.changed == \'true\' }}\n', /raw plan/],
    [/version: \$\{\{ steps\.reserve\.outputs\.version \}\}/, 'version: ${{ steps.plan.outputs.version }}', /reserved version/],
    [/VERSION: \$\{\{ steps\.reserve\.outputs\.version \}\}/, 'VERSION: ${{ steps.plan.outputs.version }}', /reserved version/],
    [/        continue-on-error: true\n/, '', /tolerate the repository policy failure/],
    [/- name: Report manual pull request step/, '- name: Skip the manual report', /manual pull request step/],
    [/git ls-remote --heads origin "refs\/heads\/\$branch"/, 'true', /compare the branch blobs/],
    // Roh 1: skipping the guard hides a blocked release.
    [/- name: Refuse concurrent channel proposals\n/, '- name: Refuse concurrent channel proposals\n        if: false\n', /never be skipped/],
    // Roh 2: continuing past a guard failure hides a blocked release.
    [/- name: Refuse concurrent channel proposals\n/, '- name: Refuse concurrent channel proposals\n        continue-on-error: true\n', /must not tolerate its own failure/],
    // Roh 3: skipping the report leaves "released but no channel PR" green.
    [/if: steps\.channel_pr\.outcome == 'failure'/, 'if: false', /exactly when automatic creation failed/],
    // Roh 4: reporting then exiting 0 does the same.
    [/채널 PR 자동 생성 실패 — 실행 요약의 안내에 따라 사람이 마무리해야 합니다\."\n            exit 1\n/,
      '채널 PR 자동 생성 실패 — 실행 요약의 안내에 따라 사람이 마무리해야 합니다."\n            exit 0\n', /exit non-zero|never exit successfully/],
    // Roh 5: deleting the plan's changed output removes the fact the guard reads.
    [/appendFileSync\(process\.env\.GITHUB_OUTPUT, 'changed=false\\n'\)\n/, '', /changed=false/],
    // FIX3: publishing a skill release without --latest=false moves GitHub's "Latest" marker onto
    // the skill release, so README's releases/latest link stops pointing at the app installers.
    ['gh release edit "skill-v$VERSION" --draft=false --latest=false', 'gh release edit "skill-v$VERSION" --draft=false', /--latest=false/],
    ['--draft=false --latest=false', '--draft=false --latest=true', /--latest=false/],
    // FIX2: the printed archive command must tag the full head SHA read from origin, must be a
    // lightweight tag, must verify the origin read-back, and must never force or tag a tracking ref.
    ['git tag archive/$branch-$head7 $head', 'git tag archive/$branch-$head7 origin/$branch', /full-SHA archive chain/],
    ['git tag archive/$branch-$head7 $head', 'git tag -a archive/$branch-$head7 $head -m archived', /full-SHA archive chain/],
    [' && test \\"\\$(git ls-remote origin refs/tags/archive/$branch-$head7 | cut -f1)\\" = $head', '', /full-SHA archive chain/],
    ['git push origin refs/tags/archive/$branch-$head7', 'git push --force origin refs/tags/archive/$branch-$head7', /full-SHA archive chain/],
    ['git fetch origin $head && ', '', /full-SHA archive chain/],
    // The PR body is the other place a person reads the same instruction.
    ['git tag archive/skill-channel-update-<sha7> <FULL>', 'git tag archive/skill-channel-update-<sha7> origin/skill-channel-update', /full-SHA archive chain/]
  ]
  for (const [pattern, replacement, expected] of mutations) {
    const mutated = workflow.replace(pattern, replacement)
    assert.notEqual(mutated, workflow)
    assert.throws(() => checkSkillReleaseWorkflow(mutated), expected)
  }
  const guard = workflow.match(/ {6}- name: Refuse concurrent channel proposals\n[\s\S]*?run: node app\/scripts\/check-channel-update-state\.mjs\n/)[0]
  const movedGuard = workflow.replace(guard, '')
    .replace('      - name: Resolve public release and compare source commit plus overlay hash',
      guard + '      - name: Resolve public release and compare source commit plus overlay hash')
  assert.throws(() => checkSkillReleaseWorkflow(movedGuard), /plan, then guard the channel, then reserve/)
})

test('anonymous app asset check hashes bounded response bytes and rejects an untrusted redirect', async () => {
  const bytes = Buffer.from('public installer fixture')
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const requests = []
  await verifyPublicAsset('https://github.com/team-Batmaego/knuaf-dev/releases/download/v0.6.1/knuaf-dev-0.6.1-x64.exe', expected, async (url, init) => {
    requests.push({ url, init })
    if (url === 'https://github.com/team-Batmaego/knuaf-dev/releases/download/v0.6.1/knuaf-dev-0.6.1-x64.exe') {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/app.exe' } })
    }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[0].init.redirect, 'manual')
  await assert.rejects(verifyPublicAsset('https://github.com/team-Batmaego/knuaf-dev/releases/download/v0.6.1/knuaf-dev-0.6.1-x64.exe',
    { ...expected, sha256: '0'.repeat(64) }, async () => new Response(bytes, { status: 200 })), /does not match/)
  await assert.rejects(verifyPublicAsset('https://github.com/team-Batmaego/knuaf-dev/releases/download/v0.6.1/knuaf-dev-0.6.1-x64.exe', expected,
    async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/installer.exe' } })), /Invalid public app asset redirect/)
})
