import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const ASSET_PREFIX = 'https://github.com/team-Batmaego/knuaf-dev/releases/download/'
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MANIFEST_KEYS = ['schema', 'name', 'version', 'platform', 'url', 'size', 'sha256']
const MAX_MANIFEST_BYTES = 256 * 1024

function record(value, message = 'Invalid app release data') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value
}

export function parseVersion(value) {
  if (typeof value !== 'string') throw new Error('Invalid release version')
  const match = VERSION_RE.exec(value)
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) throw new Error('Invalid release version')
  return match.slice(1).map(Number)
}

function compareVersions(a, b) {
  const aa = parseVersion(a), bb = parseVersion(b)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  return 0
}

export function releasePage(version) {
  parseVersion(version)
  return `https://github.com/team-Batmaego/knuaf-dev/releases/tag/v${version}`
}

export function readUpdateKeys(path = resolve(import.meta.dirname, '../src/main/update/keys.ts')) {
  const source = readFileSync(path, 'utf8')
  const current = /\bcurrent:\s*`(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----\s*)`/.exec(source)
  const reserve = /\breserve:\s*`(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----\s*)`/.exec(source)
  if (!current || !reserve || (source.match(/-----BEGIN PUBLIC KEY-----/g) ?? []).length !== 2) {
    throw new Error('Expected exactly two embedded update public keys')
  }

  const parsed = {}
  for (const [name, pem] of [['current', current[1]], ['reserve', reserve[1]]]) {
    let key
    try { key = createPublicKey(pem) } catch { throw new Error('Invalid embedded update public key') }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Embedded update keys must be Ed25519')
    parsed[name] = { pem, der: key.export({ type: 'spki', format: 'der' }) }
  }
  return parsed
}

function decodeBase64(value, maxBytes, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${label} encoding`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length > maxBytes) throw new Error(`Invalid ${label} encoding`)
  return bytes
}

function validateManifest(manifest, envelope) {
  record(manifest)
  if (Object.keys(manifest).length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some(key => !Object.hasOwn(manifest, key))) {
    throw new Error('Invalid app manifest fields')
  }
  if (manifest.schema !== 1 || manifest.name !== 'knuaf-dev-app' || manifest.platform !== 'win32-x64' ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_INSTALLER_BYTES) {
    throw new Error('Invalid app manifest')
  }
  parseVersion(manifest.version)
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid app hash')
  if (typeof manifest.url !== 'string' || !manifest.url.startsWith(ASSET_PREFIX)) throw new Error('Invalid app asset URL')
  let url
  try { url = new URL(manifest.url) } catch { throw new Error('Invalid app asset URL') }
  if (url.username || url.password || url.search || url.hash || url.href !== manifest.url ||
      !url.pathname.startsWith('/team-Batmaego/knuaf-dev/releases/download/') || !url.pathname.toLowerCase().endsWith('.exe')) {
    throw new Error('Invalid app asset URL')
  }
  for (const key of ['version', 'platform', 'url', 'size', 'sha256']) {
    if (Object.hasOwn(envelope, key) && envelope[key] !== manifest[key]) throw new Error('App envelope differs from signed manifest')
  }
}

export function verifyAppEnvelope(value, publicKeys) {
  const envelope = record(value, 'Invalid app envelope')
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) throw new Error('No app verification keys')
  const bytes = decodeBase64(envelope.manifest, MAX_MANIFEST_BYTES, 'manifest')
  const signature = decodeBase64(envelope.sig, 64, 'signature')
  if (signature.length !== 64 || !publicKeys.some(pem => {
    try {
      const key = createPublicKey(pem)
      return key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signature)
    } catch { return false }
  })) throw new Error('App signature verification failed')

  let manifest
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
    throw new Error('Invalid signed app manifest JSON')
  }
  validateManifest(manifest, envelope)
  return { manifest, envelope: { ...envelope } }
}

export function verifyAppChannel(value, publicKeys) {
  const channel = record(value, 'Invalid channel')
  if (channel.schema !== 1) throw new Error('Unsupported channel schema')
  const app = record(channel.app, 'Invalid app channel')
  parseVersion(app.latest)
  const page = releasePage(app.latest)
  if (app.page !== page) throw new Error('App channel page does not match latest version')
  const proof = verifyAppEnvelope(app['win32-x64'], publicKeys)
  if (proof.manifest.version !== app.latest) throw new Error('App channel version does not match signed manifest')
  return proof
}

export function signingKeyFromEnvironment(value, currentKey) {
  let privateKey
  try { privateKey = createPrivateKey(value) } catch {
    throw new Error('Invalid signing key (expected Ed25519 PKCS8 PEM)')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519')
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (!derived.equals(currentKey.der)) throw new Error('Signing key does not match current update key')
  return privateKey
}

async function installerDigest(path) {
  let stat
  try { stat = lstatSync(path) } catch { throw new Error('Installer file cannot be read') }
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_INSTALLER_BYTES) {
    throw new Error('Installer size is outside the allowed range')
  }
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of createReadStream(path)) {
      size += chunk.length
      if (size > MAX_INSTALLER_BYTES) throw new Error('Installer size is outside the allowed range')
      hash.update(chunk)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Installer size is outside the allowed range') throw error
    throw new Error('Installer file cannot be read')
  }
  if (size !== stat.size) throw new Error('Installer changed while being read')
  return { size, sha256: hash.digest('hex') }
}

export function buildSignedChannel({ channel: value, tag, size, sha256, privateKey, keys }) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Invalid release tag')
  const version = tag.slice(1)
  parseVersion(version)
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INSTALLER_BYTES ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid installer digest')
  const channel = record(value, 'Invalid channel')
  if (channel.schema !== 1) throw new Error('Unsupported channel schema')
  const app = record(channel.app, 'Invalid app channel')
  parseVersion(app.latest)
  if (app.page !== releasePage(app.latest)) throw new Error('Current app channel page does not match latest version')

  const previousVersionOrder = compareVersions(version, app.latest)
  if (previousVersionOrder < 0) throw new Error('Release version is older than the current app channel')

  let previousProof = null
  if (Object.hasOwn(app, 'win32-x64')) {
    previousProof = verifyAppEnvelope(app['win32-x64'], [keys.current.pem, keys.reserve.pem])
    if (previousProof.manifest.version !== app.latest) throw new Error('Current app channel version does not match signed manifest')
  }
  if (previousVersionOrder === 0 && (!previousProof || previousProof.manifest.sha256 !== sha256)) {
    throw new Error('Same-version signing is allowed only for identical installer bytes')
  }

  const asset = `knuaf-dev-${version}-x64.exe`
  const url = `${ASSET_PREFIX}${tag}/${asset}`
  const manifest = { schema: 1, name: 'knuaf-dev-app', version, platform: 'win32-x64', url, size, sha256 }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const signature = sign(null, manifestBytes, privateKey).toString('base64')
  const envelope = { manifest: manifestBytes.toString('base64'), sig: signature, version, platform: manifest.platform, url, size, sha256 }
  const nextChannel = { ...channel, app: { ...app, latest: version, page: releasePage(version), 'win32-x64': envelope } }
  const proof = verifyAppChannel(nextChannel, [keys.current.pem, keys.reserve.pem])
  if (proof.manifest.sha256 !== sha256 || proof.manifest.size !== size) throw new Error('Signed app manifest self-check failed')
  return { channel: nextChannel, manifestBytes, signature, url, version }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    tag: { type: 'string' }, installer: { type: 'string' }, channel: { type: 'string' }, output: { type: 'string' }
  }, strict: true, allowPositionals: false })
  if (positionals.length || !values.tag || !values.installer || !values.channel || !values.output) {
    throw new Error('--tag, --installer, --channel and --output are required')
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(values.tag)) throw new Error('Invalid release tag')
  parseVersion(values.tag.slice(1))

  const keys = readUpdateKeys()
  const privateKeyText = process.env.APP_SIGNING_PRIVATE_KEY
  if (!privateKeyText) throw new Error('APP_SIGNING_PRIVATE_KEY is required')
  const privateKey = signingKeyFromEnvironment(privateKeyText, keys.current)
  const digest = await installerDigest(values.installer)
  const channel = JSON.parse(readFileSync(values.channel, 'utf8'))
  const result = buildSignedChannel({ channel, tag: values.tag, ...digest, privateKey, keys })

  mkdirSync(values.output, { recursive: true })
  writeFileSync(resolve(values.output, 'app-manifest.json'), result.manifestBytes)
  writeFileSync(resolve(values.output, 'app-manifest.sig'), `${result.signature}\n`)
  writeFileSync(resolve(values.output, 'channel.json'), `${JSON.stringify(result.channel, null, 2)}\n`)
  console.log(`Signed app release: version=${result.version} size=${digest.size} sha256=${digest.sha256} url=${result.url}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'App signing failed')
    process.exitCode = 1
  })
}
