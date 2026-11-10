import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { MAX_OUTPUT_BYTES, assertNoPendingChannelUpdates, run } from '../check-channel-update-state.mjs'
import { verifyPublicAsset } from '../check-app-channel.mjs'
import { buildSignedChannel, releasePage, signingKeyFromEnvironment, verifyAppChannel, verifyAppEnvelope } from '../sign-app.mjs'

const vector = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/app-signature-vector.json'), 'utf8'))
const signer = resolve(import.meta.dirname, '../sign-app.mjs')
const channelCheck = resolve(import.meta.dirname, '../check-channel-update-state.mjs')
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

// Real measured size of a paginated pull list / a far-behind compare, see the probe findings.
const BIG_OUTPUT = 1_455_182

test('run() accepts channel API output above Node\'s 1 MiB default instead of failing with ENOBUFS', () => {
  assert.ok(MAX_OUTPUT_BYTES > 1024 * 1024)
  const out = run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${BIG_OUTPUT}))`], 'Open pull request list')
  assert.equal(out.length, BIG_OUTPUT)
})

test('labelled channel API failures name the caller, the command and the configured limit; other failures stay raw', () => {
  const limit = `${MAX_OUTPUT_BYTES / 1024 / 1024} MiB`
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)'], 'Channel branch comparison for app-channel-v0.6.0'),
    error => {
      assert.match(error.message, /^Channel branch comparison for app-channel-v0\.6\.0 failed while running `/)
      assert.match(error.message, /-e\s+process\.exit\(3\)`/)
      assert.equal(error.message.includes(`(maxBuffer ${limit})`), true)
      // R1: the diagnostic must print the value in force, never a hard-coded 1 MiB.
      assert.equal(error.message.includes('1 MiB'), MAX_OUTPUT_BYTES === 1024 * 1024)
      return true
    })
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(4)']), /Command failed|exit code 4/)
})

test('channel check CLI passes a large paginated pull list and reports branch, command and limit on a large compare', t => {
  // execFileSync('gh') needs a real executable; a POSIX shim cannot be spawned on Windows.
  if (process.platform === 'win32') return t.skip('PATH shim requires a POSIX shell; run() coverage above is platform neutral')
  const root = mkdtempSync(join(tmpdir(), 'knuaf-channel-limit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api --paginate")
    if [ "$GH_STUB_MODE" = "pulls-big" ]; then
      exec "${process.execPath}" -e 'const n=${BIG_OUTPUT}-24;process.stdout.write("[[{\\"head\\":{\\"ref\\":\\""+"x".repeat(n)+"\\"}}]]")'
    fi
    printf '[[{"head":{"ref":"feature-not-a-channel"}}]]' ;;
  "api "*)
    case "$GH_STUB_MODE" in
      compare-big)
        exec "${process.execPath}" -e 'const n=${BIG_OUTPUT}-36;process.stdout.write("{\\"status\\":\\"identical\\",\\"padding\\":\\""+"x".repeat(n)+"\\"}")' ;;
      compare-fail)
        echo 'stub gh: compare unavailable' >&2; exit 7 ;;
      *)
        printf '{"status":"identical"}' ;;
    esac ;;
  *) echo "stub gh: unexpected args: $*" >&2; exit 9 ;;
esac
`)
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "ls-remote" ] && [ "$2" = "--heads" ]; then
  printf '%s\\trefs/heads/app-channel-v0.6.0\\n' ${'1'.repeat(40)}
elif [ "$1" = "ls-remote" ] && [ "$2" = "origin" ]; then
  printf '%s\\trefs/heads/main\\n' ${'2'.repeat(40)}
else
  echo "stub git: unexpected args: $*" >&2; exit 9
fi
`)
  for (const name of ['gh', 'git']) chmodSync(join(bin, name), 0o755)
  const runCheck = mode => spawnSync(process.execPath, [channelCheck], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GH_STUB_MODE: mode,
      GITHUB_REPOSITORY: 'team-Batmaego/knuaf-dev',
      GH_TOKEN: 'fixture-token',
      GITHUB_OUTPUT: join(root, 'output')
    }
  })
  const ok = runCheck('pulls-big')
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /No open app\/skill channel PRs or unmerged channel branches\./)
  // The regression itself: a 1.4 MB compare response used to abort the run with ENOBUFS.
  const big = runCheck('compare-big')
  assert.equal(big.status, 0, big.stdout + big.stderr)
  assert.doesNotMatch(big.stderr, /ENOBUFS/)
  const failed = runCheck('compare-fail')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stderr, /app-channel-v0\.6\.0/)
  assert.match(failed.stderr, /gh api .*\/compare\//)
  assert.match(failed.stderr, new RegExp(`\\(maxBuffer ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB\\)`))
  assert.match(failed.stderr, /stub gh: compare unavailable/)
})

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

test('channel conflicts block open PRs and unmerged branches but allow branches contained in main', () => {
  assert.doesNotThrow(() => assertNoPendingChannelUpdates([], [
    { name: 'app-channel-v0.6.0', status: 'ahead' },
    { name: 'skill-channel-update', status: 'identical' }
  ]))
  assert.throws(() => assertNoPendingChannelUpdates(['app-channel-v0.6.1'], []), /Open channel PR/)
  assert.throws(() => assertNoPendingChannelUpdates([], [{ name: 'skill-channel-update', status: 'behind' }]), /not on main/)
  assert.throws(() => assertNoPendingChannelUpdates([], [{ name: 'app-channel-vbad', status: 'diverged' }]), /Unexpected app channel branch/)
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
