// 관문 전용 빌드의 임시 키와 채널 문서 — `gate-build.yml` 만 부른다. 운영 서명(`sign-app.mjs`)과 무관하다.
//
//   node scripts/gate-channel.mjs keygen --private <파일>      # 개인키는 파일로, 공개키(PEM)는 표준 출력
//   node scripts/gate-channel.mjs sign --private <파일> --installer <exe> --version 0.7.4 --port 38473 --output <폴더>
//
// 키는 실행 한 번만 쓰는 Ed25519 다. 개인키는 로그·아티팩트에 남기지 않는다(워크플로가 서명 뒤 지운다).
// 채널 문서의 설치 파일 주소는 같은 PC(`http://127.0.0.1:<포트>/`)뿐이다.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { GATE_CHANNEL } from './gate-define.mjs'
import { releasePage, parseVersion, MAX_INSTALLER_BYTES } from './sign-app.mjs'

export function gateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
}

export function gateChannelUrl(port) {
  const url = `http://127.0.0.1:${port}/channel.json`
  if (!/^\d+$/.test(String(port)) || !GATE_CHANNEL.test(url) || Number(port) > 65535) throw new Error('Invalid gate port')
  return url
}

export function buildGateChannel({ version, port, asset, size, sha256, privateKey }) {
  parseVersion(version)
  const origin = new URL(gateChannelUrl(port)).origin
  if (typeof asset !== 'string' || !/^knuaf-dev-GATE-[0-9.]+-x64\.exe$/.test(asset)) throw new Error('Gate installer must be named knuaf-dev-GATE-<version>-x64.exe')
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INSTALLER_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid installer digest')
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Gate signing key must be Ed25519')
  const url = `${origin}/${asset}`
  const manifest = { schema: 1, name: 'knuaf-dev-app', version, platform: 'win32-x64', url, size, sha256 }
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const sig = sign(null, bytes, key)
  if (!verify(null, bytes, createPublicKey(key), sig)) throw new Error('Gate signature self-check failed')
  const envelope = { manifest: bytes.toString('base64'), sig: sig.toString('base64'), version, platform: manifest.platform, url, size, sha256 }
  return { schema: 1, app: { latest: version, page: releasePage(version), 'win32-x64': envelope } }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({ args: rest, options: { private: { type: 'string' }, installer: { type: 'string' }, version: { type: 'string' }, port: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false })
  if (command === 'keygen') {
    if (!values.private) throw new Error('--private is required')
    const pair = gateKeyPair()
    writeFileSync(values.private, pair.privateKey, { mode: 0o600, flag: 'wx' })
    process.stdout.write(pair.publicKey)
    return
  }
  if (command === 'sign') {
    if (!values.private || !values.installer || !values.version || !values.port || !values.output) throw new Error('--private, --installer, --version, --port and --output are required')
    if (!statSync(values.installer).isFile()) throw new Error('Installer file cannot be read')
    const data = readFileSync(values.installer)
    const channel = buildGateChannel({ version: values.version, port: values.port, asset: basename(values.installer), size: data.length, sha256: createHash('sha256').update(data).digest('hex'), privateKey: readFileSync(values.private, 'utf8') })
    mkdirSync(values.output, { recursive: true })
    writeFileSync(resolve(values.output, 'channel.json'), `${JSON.stringify(channel, null, 2)}\n`)
    console.log(`Gate channel: version=${values.version} size=${data.length} url=${channel.app['win32-x64'].url}`)
    return
  }
  throw new Error('Usage: gate-channel.mjs keygen|sign …')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gate channel step failed')
    process.exitCode = 1
  }
}
