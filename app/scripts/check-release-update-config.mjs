// 출시 산출물 검사 — 설치본에 들어가는 번들이 **운영 채널·운영 공개키 2개**만 담고, 관문 전용
// 빌드의 값(표식·같은 PC 채널 주소·임시 키)이 한 글자도 없음을 바이트로 확인한다.
//
//   node scripts/check-release-update-config.mjs --out out                 # 빌드 폴더
//   node scripts/check-release-update-config.mjs --asar dist/.../app.asar  # 포장된 설치본 안
//   node scripts/check-release-update-config.mjs --env                     # 빌드 환경에 관문 값이 없는지
//   node scripts/check-release-update-config.mjs --workflows               # 출시 워크플로에 관문 이름이 없는지
//   node scripts/check-release-update-config.mjs --expect-gate --out out   # (gate-build 전용) 관문 값이 실제로 들어갔는지
//   node scripts/check-release-update-config.mjs --no-key-material <개인키 파일> --scan <파일·폴더>…   # (gate-build 전용) 올릴 것에 그 개인키가 없는지
//
// 관문 값이 들어오는 길은 빌드 시점 상수 하나뿐이고(`gate-define.mjs`), 그 빌드는 `gate-build.yml`
// 만 만든다. 이 검사는 그 밖의 모든 설치본 워크플로에서 올리기 전에 돈다.
import { createPrivateKey } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { GATE_MARK } from './gate-define.mjs'

const PEM = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/g
/** 번들러가 줄바꿈을 `\n` 이스케이프로 바꿔도 같은 키로 본다. */
const body = block => block.replace(/\\r|\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '')
const GATE_URL = /http:\/\/127\.0\.0\.1:\d+\/channel\.json/
/** 출시 설치본을 만들거나 서명하는 워크플로 — 관문 환경값 이름이 나오면 안 된다. */
export const RELEASE_WORKFLOWS = ['release.yml', 'app-release.yml', 'build-installers.yml', 'skill-release.yml', 'installer-e2e.yml']

/** 소스의 운영 값 — 검사 기준은 손으로 옮겨 적지 않고 소스에서 읽는다. */
export function productionConfig(root = resolve(import.meta.dirname, '../src/main/update')) {
  const keys = [...readFileSync(join(root, 'keys.ts'), 'utf8').matchAll(PEM)].map(m => body(m[1]))
  const channel = /export const CHANNEL_URL = '(https:\/\/[^']+)'/.exec(readFileSync(join(root, 'manifest.ts'), 'utf8'))?.[1]
  if (keys.length !== 2 || new Set(keys).size !== 2 || !channel) throw new Error('Cannot read the production channel and its two public keys from source')
  return { keys, channel }
}

/**
 * files: [{ name, text }] — `out/` 아래 모든 파일. main 은 그중 `main/` 아래 `.js`.
 * 관문 흔적은 모든 파일에서, 운영 채널·키는 main 번들에서 본다.
 */
export function checkBundle(files, production = productionConfig()) {
  const main = files.filter(f => /(^|\/)main\/[^/]+\.js$/.test(f.name) || /(^|\/)main\/chunks\/[^/]+\.js$/.test(f.name))
  if (!main.length) throw new Error('No main bundle found')
  for (const f of files) {
    if (f.text.includes(GATE_MARK)) throw new Error(`Gate build marker found in ${f.name}`)
    if (f.text.includes('__KNUAF_GATE__')) throw new Error(`Unreplaced gate constant found in ${f.name}`)
    if (GATE_URL.test(f.text)) throw new Error(`Loopback update channel found in ${f.name}`)
  }
  const text = main.map(f => f.text).join('\n')
  if (!text.includes(production.channel)) throw new Error('Production channel URL is missing from the main bundle')
  const found = [...text.matchAll(PEM)].map(m => body(m[1]))
  if (found.length !== 2 || new Set(found).size !== 2 || found.some(k => !production.keys.includes(k))) {
    throw new Error(`Main bundle must embed exactly the two production update keys (found ${found.length})`)
  }
  return { files: files.length, main: main.length }
}

/**
 * 관문 빌드 쪽 확인(`gate-build.yml` 전용): main 번들에 같은 PC 채널 주소와 운영 키가 아닌 공개키가
 * **실제로 있어야** 통과한다. "출시 검사가 실패했다"는 사실만으로 관문 빌드라고 보지 않는다 —
 * 번들을 못 읽었거나 운영 값이 빠진 실패와 섞이지 않게 한다.
 */
export function checkGateBundle(files, production = productionConfig()) {
  const main = files.filter(f => /(^|\/)main\/[^/]+\.js$/.test(f.name) || /(^|\/)main\/chunks\/[^/]+\.js$/.test(f.name))
  if (!main.length) throw new Error('No main bundle found')
  const text = main.map(f => f.text).join('\n')
  if (text.includes('__KNUAF_GATE__')) throw new Error('Unreplaced gate constant found in the main bundle')
  if (!GATE_URL.test(text)) throw new Error('Gate bundle has no loopback update channel')
  const extra = [...text.matchAll(PEM)].map(m => body(m[1])).filter(k => !production.keys.includes(k))
  if (new Set(extra).size !== 1) throw new Error(`Gate bundle must embed exactly one non-production update key (found ${new Set(extra).size})`)
  for (const f of files) if (!main.includes(f) && (GATE_URL.test(f.text) || [...f.text.matchAll(PEM)].length)) throw new Error(`Gate values found outside the main bundle: ${f.name}`)
  return { files: files.length, main: main.length }
}

/**
 * 올릴 파일 어디에도 이 실행의 임시 개인키가 없음을 바이트로 본다(`gate-build.yml` 전용).
 * 찾는 것은 그 키 자체다: PEM 본문(base64), PKCS8 DER, 32바이트 씨앗. 값은 출력하지 않는다.
 */
export function checkNoKeyMaterial(privatePem, files) {
  const key = createPrivateKey(privatePem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 private key')
  const der = key.export({ type: 'pkcs8', format: 'der' }), pem = key.export({ type: 'pkcs8', format: 'pem' })
  const base64 = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'latin1')
  const needles = [der, der.subarray(der.length - 32), base64, Buffer.from(der.subarray(der.length - 32).toString('base64'), 'latin1'), Buffer.from(der.subarray(der.length - 32).toString('hex'), 'latin1')]
  if (!files.length) throw new Error('Nothing to scan for key material')
  for (const { name, bytes } of files) if (needles.some(n => bytes.includes(n))) throw new Error(`Private key material found in ${name}`)
  return files.length
}
function scanFiles(path) {
  const st = statSync(path)
  if (st.isFile()) return [{ name: path, bytes: readFileSync(path) }]
  if (!st.isDirectory()) throw new Error(`Cannot scan ${path}`)
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() || e.isFile() ? scanFiles(join(path, e.name)) : [])
}

function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`)
    : e.isFile() ? [{ name: `${prefix}${e.name}`, text: readFileSync(join(dir, e.name), 'latin1') }] : [])
}
export function readOut(dir) {
  if (!statSync(dir).isDirectory()) throw new Error('Build output directory not found')
  return walk(dir)
}

/** asar 는 압축하지 않는 묶음이다: 머리(JSON 목록) 뒤에 파일 바이트가 그대로 이어진다. */
export function readAsar(path) {
  const bytes = readFileSync(path)
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error('Unexpected asar header')
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12), base = 8 + headerSize
  if (16 + jsonSize > bytes.length || base > bytes.length || base < 16 + jsonSize) throw new Error('Unexpected asar header')
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'))
  const out = header?.files?.out
  if (!out?.files) throw new Error('app.asar has no out/ directory')
  const files = []
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      if (entry.files) { visit(entry, `${prefix}${name}/`); continue }
      // 풀어 둔 파일(unpacked)·링크는 묶음 안에 바이트가 없다 — out/ 아래에 있으면 검사할 수 없으니 실패.
      if (entry.unpacked || entry.link || typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Cannot read ${prefix}${name} from app.asar`)
      const start = base + Number(entry.offset)
      if (!Number.isSafeInteger(start) || start + entry.size > bytes.length) throw new Error(`Cannot read ${prefix}${name} from app.asar`)
      files.push({ name: `${prefix}${name}`, text: bytes.subarray(start, start + entry.size).toString('latin1') })
    }
  }
  visit(out, '')
  return files
}

export function checkEnvironment(env = process.env) {
  const names = Object.keys(env).filter(name => name.toUpperCase().startsWith('KNUAF_GATE'))
  if (names.length) throw new Error(`Gate build variables are set in a release build environment: ${names.join(', ')}`)
  return true
}

export function checkWorkflows(dir = resolve(import.meta.dirname, '../../.github/workflows')) {
  const present = readdirSync(dir).filter(name => /\.ya?ml$/.test(name))
  for (const name of RELEASE_WORKFLOWS) if (!present.includes(name)) throw new Error(`Expected workflow is missing: ${name}`)
  const hits = present.filter(name => name !== 'gate-build.yml' && /KNUAF_GATE|gate-define|gate-channel/i.test(readFileSync(join(dir, name), 'utf8')))
  if (hits.length) throw new Error(`Gate build names appear outside gate-build.yml: ${hits.join(', ')}`)
  return present.length
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', multiple: true }, asar: { type: 'string', multiple: true }, env: { type: 'boolean' }, workflows: { type: 'boolean' }, 'expect-gate': { type: 'boolean' }, 'no-key-material': { type: 'string' }, scan: { type: 'string', multiple: true } }, strict: true, allowPositionals: false })
  if (values['no-key-material'] || values.scan?.length) {
    if (!values['no-key-material'] || !values.scan?.length || values.env || values.workflows || values.asar?.length || values.out?.length || values['expect-gate']) throw new Error('--no-key-material takes a key file and one or more --scan paths, nothing else')
    const count = checkNoKeyMaterial(readFileSync(values['no-key-material'], 'utf8'), values.scan.flatMap(scanFiles))
    console.log(`ok: no private key material in ${count} files`)
    return
  }
  if (values['expect-gate']) {
    if (values.env || values.workflows || values.asar?.length || values.out?.length !== 1) throw new Error('--expect-gate takes exactly one --out and nothing else')
    const r = checkGateBundle(readOut(values.out[0]))
    console.log(`ok: ${values.out[0]} — gate build: loopback channel and one run key in the main bundle (${r.files} files)`)
    return
  }
  if (!values.out?.length && !values.asar?.length && !values.env && !values.workflows) throw new Error('Nothing to check: pass --out, --asar, --env or --workflows')
  if (values.env) { checkEnvironment(); console.log('ok: no gate build variables in the environment') }
  if (values.workflows) console.log(`ok: gate build names appear only in gate-build.yml (${checkWorkflows()} workflows)`)
  for (const dir of values.out ?? []) { const r = checkBundle(readOut(dir)); console.log(`ok: ${dir} — production channel and keys only (${r.files} files, ${r.main} main)`) }
  for (const path of values.asar ?? []) { const r = checkBundle(readAsar(path)); console.log(`ok: ${path} — production channel and keys only (${r.files} files, ${r.main} main)`) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'Release update config check failed'}`)
    process.exitCode = 1
  }
}
