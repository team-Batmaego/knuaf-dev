// 관문 전용 빌드 경계 — 출시 산출물 검사가 운영 모양은 통과시키고 관문 모양은 막는지,
// 관문 값이 같은 PC 주소로만 만들어지는지, 출시 워크플로에 관문 이름이 없는지를 잠근다.
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GATE_MARK, gateDefine, gateValue } from '../gate-define.mjs'
import { buildGateChannel, gateChannelUrl, gateKeyPair } from '../gate-channel.mjs'
import { checkBundle, checkEnvironment, checkWorkflows, productionConfig, readAsar, readOut, RELEASE_WORKFLOWS } from '../check-release-update-config.mjs'

const production = productionConfig()
const pem = body => `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`
const pair = gateKeyPair()
// 번들러가 내놓는 모양 둘: 템플릿 리터럴 그대로, 줄바꿈을 `\n` 으로 바꾼 문자열.
const productionMain = `const CHANNEL_URL = "${production.channel}";const UPDATE_KEYS = { current: \`${pem(production.keys[0])}\`, reserve: "${pem(production.keys[1]).replaceAll('\n', '\\n')}" };const GATE = gateOf(null);`
const files = (main, extra = []) => [{ name: 'main/index.js', text: main }, { name: 'preload/index.js', text: 'preload' }, { name: 'renderer/assets/index-abc.js', text: 'renderer' }, ...extra]
const gateEnv = { KNUAF_GATE_CHANNEL: 'http://127.0.0.1:38473/channel.json', KNUAF_GATE_PUBLIC_KEY: pair.publicKey }

test('production-shaped bundle passes; every gate trace fails', () => {
  assert.deepEqual(checkBundle(files(productionMain), production), { files: 3, main: 1 })
  const gateMain = productionMain.replace('gateOf(null)', `gateOf(${gateDefine(gateEnv)})`)
  assert.throws(() => checkBundle(files(gateMain), production), /Gate build marker/)
  // 표식을 빼도 주소·키 개수·치환 안 된 상수 각각이 따로 걸린다.
  assert.throws(() => checkBundle(files(gateMain.replace(GATE_MARK, 'x')), production), /Loopback update channel/)
  assert.throws(() => checkBundle(files(gateMain.replace(GATE_MARK, 'x').replace('127.0.0.1:38473/channel.json', 'h')), production), /exactly the two production update keys \(found 3\)/)
  assert.throws(() => checkBundle(files(productionMain + 'typeof __KNUAF_GATE__'), production), /Unreplaced gate constant/)
  // 관문 흔적은 main 밖(화면·preload 번들)에 있어도 막는다.
  assert.throws(() => checkBundle(files(productionMain, [{ name: 'renderer/x.js', text: GATE_MARK }]), production), /marker found in renderer\/x\.js/)
  // 운영 값이 바뀌거나 빠진 번들도 막는다.
  assert.throws(() => checkBundle(files(productionMain.replace(production.channel, 'https://example.invalid/c.json')), production), /Production channel URL is missing/)
  assert.throws(() => checkBundle(files(productionMain.replace(production.keys[0], pair.publicKey.split('\n')[1])), production), /exactly the two production update keys/)
  assert.throws(() => checkBundle(files(productionMain.replace(pem(production.keys[0]), '')), production), /found 1/)
  assert.throws(() => checkBundle([{ name: 'renderer/x.js', text: 'x' }], production), /No main bundle/)
})

test('gate value exists only for an exact loopback channel and an Ed25519 key', () => {
  assert.equal(gateDefine({}), 'null')
  assert.deepEqual(gateValue(gateEnv), { mark: GATE_MARK, channel: gateEnv.KNUAF_GATE_CHANNEL, key: pair.publicKey })
  for (const channel of ['https://127.0.0.1:38473/channel.json', 'http://localhost:38473/channel.json', 'http://127.0.0.1/channel.json', 'http://127.0.0.1:38473/other.json',
    'http://127.0.0.1:38473/channel.json?x=1', 'http://127.0.0.1.example.com:38473/channel.json', 'http://user@127.0.0.1:38473/channel.json', 'http://127.0.0.1:99999/channel.json', 'http://10.0.0.5:38473/channel.json']) {
    assert.throws(() => gateValue({ ...gateEnv, KNUAF_GATE_CHANNEL: channel }), /KNUAF_GATE_CHANNEL/, channel)
  }
  // 하나만 주면 운영처럼 보이는 빌드가 아니라 실패다.
  assert.throws(() => gateValue({ KNUAF_GATE_PUBLIC_KEY: pair.publicKey }), /KNUAF_GATE_CHANNEL/)
  assert.throws(() => gateValue({ KNUAF_GATE_CHANNEL: gateEnv.KNUAF_GATE_CHANNEL }), /KNUAF_GATE_PUBLIC_KEY/)
  assert.throws(() => gateValue({ ...gateEnv, KNUAF_GATE_PUBLIC_KEY: 'not a key' }), /KNUAF_GATE_PUBLIC_KEY/)
})

test('gate channel document is signed by the run key and points at the same PC only', () => {
  const sha256 = 'a'.repeat(64)
  const channel = buildGateChannel({ version: '0.7.4', port: '38473', asset: 'knuaf-dev-GATE-0.7.4-x64.exe', size: 10, sha256, privateKey: pair.privateKey })
  const envelope = channel.app['win32-x64'], bytes = Buffer.from(envelope.manifest, 'base64')
  assert.equal(verify(null, bytes, createPublicKey(pair.publicKey), Buffer.from(envelope.sig, 'base64')), true)
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { schema: 1, name: 'knuaf-dev-app', version: '0.7.4', platform: 'win32-x64', url: 'http://127.0.0.1:38473/knuaf-dev-GATE-0.7.4-x64.exe', size: 10, sha256 })
  assert.equal(channel.app.latest, '0.7.4'); assert.equal(Object.hasOwn(channel, 'skill'), false)
  // 운영 키로는 검증되지 않는다.
  assert.equal(production.keys.some(k => verify(null, bytes, createPublicKey(pem(k)), Buffer.from(envelope.sig, 'base64'))), false)
  assert.throws(() => buildGateChannel({ version: '0.7.4', port: '38473', asset: 'knuaf-dev-0.7.4-x64.exe', size: 10, sha256, privateKey: pair.privateKey }), /GATE/)
  assert.throws(() => gateChannelUrl('80'), /Invalid gate port/); assert.throws(() => gateChannelUrl('38473/x'), /Invalid gate port/)
})

test('release environments and workflows carry no gate names; gate-build stays secretless and unpublished', () => {
  assert.equal(checkEnvironment({ PATH: '/bin', KNUAF_FREE_RELAY_TOKEN: 'x' }), true)
  assert.throws(() => checkEnvironment({ KNUAF_GATE_CHANNEL: 'x' }), /KNUAF_GATE_CHANNEL/)
  assert.throws(() => checkEnvironment({ knuaf_gate_public_key: 'x' }), /knuaf_gate_public_key/)
  const workflows = resolve(import.meta.dirname, '../../../.github/workflows')
  assert.ok(checkWorkflows(workflows) > RELEASE_WORKFLOWS.length)
  const dir = mkdtempSync(join(tmpdir(), 'gate-wf-'))
  for (const name of RELEASE_WORKFLOWS) writeFileSync(join(dir, name), 'jobs: {}\n')
  writeFileSync(join(dir, 'gate-build.yml'), 'env:\n  KNUAF_GATE_CHANNEL: x\n')
  assert.equal(checkWorkflows(dir), RELEASE_WORKFLOWS.length + 1)
  writeFileSync(join(dir, 'release.yml'), 'env:\n  KNUAF_GATE_PUBLIC_KEY: x\n')
  assert.throws(() => checkWorkflows(dir), /outside gate-build\.yml: release\.yml/)
  writeFileSync(join(dir, 'release.yml'), 'run: node scripts/gate-channel.mjs keygen\n')
  assert.throws(() => checkWorkflows(dir), /release\.yml/)

  const gate = readFileSync(join(workflows, 'gate-build.yml'), 'utf8')
  const on = /^on:\n((?:  .*\n|\n)+)/m.exec(gate)?.[1] ?? ''
  assert.deepEqual([...on.matchAll(/^  ([\w-]+):/gm)].map(m => m[1]), ['workflow_dispatch'])
  assert.match(gate, /^permissions:\n  contents: read\n/m); assert.equal((gate.match(/^\s*permissions:/gm) ?? []).length, 1)
  assert.equal(/secrets\./.test(gate.replace(/^\s*#.*$/gm, '')), false)
  assert.equal(/\$\{\{\s*inputs\./.test(gate), false)
  assert.equal(/gh\s+release|--publish\s+(?!never)|contents:\s*write/.test(gate), false)
  assert.ok((gate.match(/--publish never/g) ?? []).length >= 2)
  assert.match(gate, /retention-days: 3\n/); assert.equal(/retention-days: (?!3\n)/.test(gate), false)
  assert.match(gate, /artifactName=knuaf-dev-GATE-/)
})

test('readOut and readAsar hand the same out/ files to the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-out-'))
  mkdirSync(join(dir, 'out/main'), { recursive: true }); mkdirSync(join(dir, 'out/renderer'), { recursive: true })
  writeFileSync(join(dir, 'out/main/index.js'), productionMain); writeFileSync(join(dir, 'out/renderer/a.js'), 'renderer')
  assert.deepEqual(checkBundle(readOut(join(dir, 'out')), production), { files: 2, main: 1 })
  // asar: 머리(JSON 목록) + 파일 바이트. package.json 을 앞에 둬 out/ 파일의 오프셋이 0 이 아니게 한다.
  const parts = [Buffer.from('{"name":"x"}'), Buffer.from(productionMain, 'latin1'), Buffer.from(GATE_MARK)]
  const header = { files: { 'package.json': { size: parts[0].length, offset: '0' }, out: { files: { main: { files: { 'index.js': { size: parts[1].length, offset: String(parts[0].length) } } } } } } }
  const pack = (h, body) => {
    const json = Buffer.from(JSON.stringify(h)), padded = Math.ceil(json.length / 4) * 4, head = Buffer.alloc(16 + padded)
    head.writeUInt32LE(4, 0); head.writeUInt32LE(8 + padded, 4); head.writeUInt32LE(4 + padded, 8); head.writeUInt32LE(json.length, 12); json.copy(head, 16)
    return Buffer.concat([head, ...body])
  }
  const asar = join(dir, 'app.asar'); writeFileSync(asar, pack(header, parts.slice(0, 2)))
  assert.deepEqual(checkBundle(readAsar(asar), production), { files: 1, main: 1 })
  header.files.out.files.renderer = { files: { 'a.js': { size: parts[2].length, offset: String(parts[0].length + parts[1].length) } } }
  writeFileSync(asar, pack(header, parts))
  assert.throws(() => checkBundle(readAsar(asar), production), /marker found in renderer\/a\.js/)
  header.files.out.files.renderer.files['a.js'] = { size: 3, unpacked: true }
  writeFileSync(asar, pack(header, parts)); assert.throws(() => readAsar(asar), /Cannot read renderer\/a\.js/)
  writeFileSync(asar, pack({ files: {} }, [])); assert.throws(() => readAsar(asar), /no out\/ directory/)
})
