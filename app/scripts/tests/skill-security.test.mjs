import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { composeFiles, fileHashes, jsonBytes, readTree, sha256, zipBytes, writeTree } from '../compose-skill.mjs'
import { releaseManifest, signedChannel } from '../sign-skill.mjs'
import { CONSUMER_TESTS, UPSTREAM_PROTECTION_TESTS, prepareCompatibility, runCompatibility } from './run-skill-compat.mjs'
import { ACTION_COMMITS, checkWorkflowPins } from './check-skill-workflow.mjs'
import { stageComposed } from '../stage-skill.mjs'

const PYTHON = process.env.PYTHON || resolve(import.meta.dirname, '../../../.venv-dev/bin/python')
const composeModule = pathToFileURL(resolve(import.meta.dirname, '../compose-skill.mjs')).href
const source = { repo: 'starceas/knuaf-doc', tag: 'v0.2.0', commit: 'a'.repeat(40) }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knuaf-r1-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const overlay = join(root, 'overlay'), upstream = join(root, 'upstream'), repo = join(root, 'app-repo')
  mkdirSync(overlay)
  writeFileSync(join(overlay, 'overlay.json'), jsonBytes({ schema: 1, name: 'knuaf-dev', remove: ['tests/', 'install-manifest.json'], append: null }))
  const input = new Map([
    ['SKILL.md', Buffer.from('---\nname: knuaf-doc\n---\n# 원본\n')],
    ['scripts/payload.py', Buffer.from('tested\n')],
    ['references/basic-only.txt', Buffer.from('final-bundle\n')],
    ['references/한글.md', Buffer.from('정상 한글 NFC\n')]
  ])
  const options = { source, overlay, version: '1.0.0' }
  const expected = composeFiles(input, options), bundle = join(root, 'bundle'), archive = join(root, 'skill.zip')
  writeTree(expected, bundle); writeFileSync(archive, zipBytes(expected))
  const upstreamSkill = join(upstream, 'skills/knuaf-doc')
  mkdirSync(join(upstreamSkill, 'tests'), { recursive: true })
  writeFileSync(join(upstreamSkill, 'SKILL.md'), '---\nname: knuaf-doc\n---\n')
  mkdirSync(join(upstreamSkill, 'references'))
  writeFileSync(join(upstreamSkill, 'references/basic-only.txt'), 'source-not-final\n')
  mkdirSync(join(repo, 'tests'), { recursive: true })
  mkdirSync(join(repo, 'app/sidecar'), { recursive: true })
  for (const name of CONSUMER_TESTS) writeFileSync(join(repo, 'tests', name), `from pathlib import Path\ndef test_final_payload():\n    body = Path(__file__).resolve().parents[1] / 'app/resources/skill'\n    assert (body / 'scripts/payload.py').read_text() == 'tested\\n'\n    assert 'name: knuaf-dev' in (body / 'SKILL.md').read_text()\n`)
  const basicCode = `import os, subprocess\nfrom pathlib import Path\ndef test_composed_body():\n    body = Path(__file__).resolve().parents[1]\n    assert (body / 'references/basic-only.txt').read_text() == 'final-bundle\\n'\n    assert 'name: ' + os.environ['KNUAF_SKILL_TEST_NAME'] in (body / 'SKILL.md').read_text()\n    assert os.environ['KNUAF_SKILL_TEST_SOURCE_NAME'] == 'knuaf-doc'\n    assert Path(os.environ['D1_TEST_RUNTIME']).resolve() == body\n    if os.environ.get('W2_TEST_ATTACK'):\n        subprocess.check_call([os.environ['W2_TEST_NODE'], '--input-type=module', '-e', os.environ['W2_TEST_ATTACK']])\n`
  writeFileSync(join(upstreamSkill, 'tests/test_basic.py'), basicCode)
  const rootGuards = new Map()
  for (const node of UPSTREAM_PROTECTION_TESTS) {
    const [path, klass, method = 'test_final_payload'] = node.split('::')
    const code = rootGuards.get(path) ?? { functions: new Set(), classes: new Map() }
    if (klass) {
      if (!code.classes.has(klass)) code.classes.set(klass, new Set())
      code.classes.get(klass).add(method)
    } else code.functions.add(method)
    rootGuards.set(path, code)
  }
  for (const [path, code] of rootGuards) {
    const check = `body = Path(__file__).resolve().parents[1] / 'skills/knuaf-doc'\nassert (body / 'references/basic-only.txt').read_text() == 'final-bundle\\n'\nassert 'name: knuaf-dev' in (body / 'SKILL.md').read_text()`
    let text = 'import unittest\nfrom pathlib import Path\n'
    for (const method of code.functions) text += `def ${method}():\n    ${check.replaceAll('\n', '\n    ')}\n`
    for (const [klass, methods] of code.classes) {
      text += `class ${klass}(unittest.TestCase):\n`
      for (const method of methods) text += `    def ${method}(self):\n        ${check.replaceAll('\n', '\n        ')}\n`
    }
    mkdirSync(join(upstream, 'tests'), { recursive: true })
    writeFileSync(join(upstream, path), text)
  }
  return { root, overlay, upstream, upstreamSkill, repo, input, options, expected, bundle, archive, basicCode,
    expectedZip: sha256(readFileSync(archive)) }
}

function attackCode(f) {
  // Simulates code executed by an upstream test or a dependency install hook.
  // It changes all three files consistently, so directory/ZIP self-consistency is not enough.
  return `import {writeFileSync} from 'node:fs'; import {readTree,fileHashes,jsonBytes,zipBytes} from ${JSON.stringify(composeModule)};
  const root=${JSON.stringify(f.bundle)}; writeFileSync(root+'/scripts/payload.py','untested\\n');
  const files=readTree(root); files.delete('install-manifest.json');
  const manifest=jsonBytes({files:fileHashes(files),schema:'knuaf-doc/install-manifest@1'});
  writeFileSync(root+'/install-manifest.json',manifest); files.set('install-manifest.json',manifest);
  writeFileSync(${JSON.stringify(f.archive)},zipBytes(files));`
}

function resultManifest(f) {
  // This in-memory composition is outside the untrusted child process, modeling the fresh signing job.
  return releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.6.0', expectedFiles: composeFiles(f.input, f.options) })
}

test('R1-01/R1-04 normal final bundle passes both actual test suites and signs independently composed bytes', t => {
  const f = fixture(t)
  const outcome = runCompatibility({ ...f, python: PYTHON })
  assert.deepEqual(outcome, { consumer: 0, basic: 0, candidateValid: true, ok: true })
  const manifest = resultManifest(f)
  assert.deepEqual(manifest.files, fileHashes(f.expected))
  const keys = generateKeyPairSync('ed25519')
  const bytes = jsonBytes(manifest)
  const channel = signedChannel({ schema: 1 }, bytes, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  assert.equal(verify(null, bytes, keys.publicKey, Buffer.from(channel.skill.sig, 'base64')), true)
  assert.deepEqual(readFileSync(f.archive), zipBytes(f.expected))
})
test('incompatible candidate cannot replace an existing staged bundle', t => {
  const f = fixture(t), output = join(f.root, 'previous-stage')
  mkdirSync(output)
  writeFileSync(join(output, 'SKILL.md'), '# previous verified bundle\n')
  // This fixture has no real core/publication API; the actual app consumer suite must reject it.
  assert.throws(() => stageComposed({ files: f.expected, upstream: f.upstream, output, python: PYTHON }),
    /Pinned skill is incompatible/)
  assert.equal(readFileSync(join(output, 'SKILL.md'), 'utf8'), '# previous verified bundle\n')
})


test('R1-01 upstream test replacing bundle+install-manifest+ZIP cannot obtain a release manifest/signature', t => {
  const f = fixture(t)
  const before = sha256(readFileSync(f.archive))
  const previous = { attack: process.env.W2_TEST_ATTACK, node: process.env.W2_TEST_NODE }
  process.env.W2_TEST_ATTACK = attackCode(f); process.env.W2_TEST_NODE = process.execPath
  t.after(() => {
    if (previous.attack === undefined) delete process.env.W2_TEST_ATTACK; else process.env.W2_TEST_ATTACK = previous.attack
    if (previous.node === undefined) delete process.env.W2_TEST_NODE; else process.env.W2_TEST_NODE = previous.node
  })
  assert.deepEqual(runCompatibility({ ...f, python: PYTHON }), { consumer: 0, basic: 0, candidateValid: false, ok: false })
  assert.notEqual(sha256(readFileSync(f.archive)), before)
  assert.deepEqual(readFileSync(f.archive), zipBytes(readTree(f.bundle)))
  assert.equal(JSON.parse(readFileSync(join(f.bundle, 'install-manifest.json'))).files['scripts/payload.py'], sha256(Buffer.from('untested\n')))
  assert.throws(() => resultManifest(f), /differ from independent composition/)
})

test('R1-01 dependency hook replacing the same three inputs cannot obtain a signature', t => {
  const f = fixture(t)
  execFileSync(process.execPath, ['--input-type=module', '-e', attackCode(f)])
  assert.deepEqual(readFileSync(f.archive), zipBytes(readTree(f.bundle)))
  assert.deepEqual(runCompatibility({ ...f, python: PYTHON }), { consumer: null, basic: null, candidateValid: false, ok: false })
  assert.throws(() => resultManifest(f), /differ from independent composition/)
  assert.throws(() => releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.6.0' }), /Independent composition is required/)
})

test('R1-04 changing a file observed only by upstream basic tests makes that suite fail', t => {
  const f = fixture(t)
  f.input.set('references/basic-only.txt', Buffer.from('changed-final-bundle\n'))
  f.expected = composeFiles(f.input, f.options)
  for (const [path, bytes] of f.expected) writeFileSync(join(f.bundle, path), bytes)
  writeFileSync(f.archive, zipBytes(f.expected))
  f.expectedZip = sha256(readFileSync(f.archive))
  const outcome = runCompatibility({ ...f, python: PYTHON })
  assert.equal(outcome.consumer, 0)
  assert.equal(outcome.basic, 1)
  assert.equal(outcome.candidateValid, true)
  assert.equal(outcome.ok, false)
  assert.equal(readFileSync(join(f.upstreamSkill, 'references/basic-only.txt'), 'utf8'), 'source-not-final\n')
})
test('U2-R1-01 rejecting upstream root protection blocks an otherwise compatible candidate', t => {
  const f = fixture(t)
  writeFileSync(join(f.upstream, 'tests/test_finance_unsupported.py'),
    'def test_refuse_unsafe_plan():\n    assert False, "upstream root protection must block this candidate"\n')
  const outcome = runCompatibility({ ...f, python: PYTHON })
  assert.deepEqual(outcome, { consumer: 0, basic: 1, candidateValid: true, ok: false })
})


test('R1-04 layout/name adapters preserve upstream test code and the complete composed body', t => {
  const f = fixture(t), scratch = join(f.root, 'prepared')
  const roots = prepareCompatibility(f, scratch)
  assert.equal(readFileSync(join(roots.skill, 'tests/test_basic.py'), 'utf8'), f.basicCode)
  for (const [path, bytes] of f.expected) assert.deepEqual(readFileSync(join(roots.skill, path)), bytes)
  assert.match(readFileSync(join(roots.skill, 'SKILL.md'), 'utf8'), /^name: knuaf-dev$/m)
  assert.equal(readFileSync(join(roots.skill, 'references/basic-only.txt'), 'utf8'), 'final-bundle\n')
})

for (const path of ['references/cafe\u0301.md', 'references/CON.txt', 'references/a?.md', 'references/trailing.', 'references/delete\u007f.md']) {
  test(`R1-03 rejects review path ${JSON.stringify(path)} during compose`, t => {
    const f = fixture(t)
    f.input.set(path, Buffer.from('unsafe'))
    assert.throws(() => composeFiles(f.input, f.options), /Unsafe skill path/)
  })
}

test('R1-03 rejects remaining Windows aliases, file/folder collisions and unsafe-integer versions', t => {
  const f = fixture(t)
  for (const path of ['references/ending ', 'references/Lpt9.data', 'references/a<b', 'references/a|b', 'references/a*b', 'references/a"b']) {
    const input = new Map(f.input); input.set(path, Buffer.from('x'))
    assert.throws(() => composeFiles(input, f.options), /Unsafe skill path/)
  }
  const colliding = new Map(f.input); colliding.set('references', Buffer.from('file'))
  assert.throws(() => composeFiles(colliding, f.options), /path collision/)
  assert.throws(() => composeFiles(f.input, { ...f.options, version: '9007199254740992.0.0' }), /Invalid version/)
  assert.throws(() => releaseManifest({ directory: f.bundle, archive: f.archive, minApp: '0.9007199254740992.0', expectedFiles: f.expected }), /safe-integer/)
})

test('R1-02 immutable action policy accepts resolved commits and rejects any mutable/unreviewed reference', () => {
  const pins = Object.entries(ACTION_COMMITS).map(([repo, sha]) => `      - uses: ${repo}@${sha} # reviewed tag`).join('\n')
  assert.equal(checkWorkflowPins(pins).length, 6)
  for (const [repo, sha] of Object.entries(ACTION_COMMITS)) {
    for (const ref of ['v4', 'main', sha.slice(0, 12), '0'.repeat(40), '${{ inputs.ref }}']) {
      assert.throws(() => checkWorkflowPins(pins.replace(`${repo}@${sha}`, `${repo}@${ref}`)), /Unreviewed or mutable/)
    }
  }
  assert.throws(() => checkWorkflowPins(pins + '\n      - uses: actions/checkout@v4'), /Unreviewed or mutable/)
})

function pinnedRuntimeFixture(t, protection) {
  const f = fixture(t)
  cpSync(resolve(import.meta.dirname, '../../../pyproject.toml'), join(f.repo, 'pyproject.toml'))
  cpSync(resolve(import.meta.dirname, '../../../tests/conftest.py'), join(f.repo, 'tests/conftest.py'))
  for (const [path, bytes] of f.input) {
    mkdirSync(resolve(f.upstreamSkill, path, '..'), { recursive: true })
    writeFileSync(join(f.upstreamSkill, path), bytes)
  }
  writeFileSync(join(f.upstreamSkill, 'scripts/requirements-runtime.txt'), '# Synthetic runtime; pytest is supplied by the test host.\n')
  if (protection) writeFileSync(join(f.upstream, 'tests/test_finance_unsupported.py'), protection)
  writeFileSync(join(f.upstream, '.gitignore'), 'ignored/\n')
  const git = (args, input) => execFileSync('git', ['-C', f.upstream, ...args], {
    encoding: 'utf8', input, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' }
  }).trim()
  git(['init', '--quiet'])
  git(['add', '--all', '--force'])
  const tree = git(['write-tree'])
  // Synthetic objects only: no git commit, hooks, remote fetch, or app refs are touched.
  const object = (message, command = git) => command(['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n${message}\n`)
  const commit = object('pinned runtime fixture')
  git(['update-ref', 'HEAD', commit])
  git(['update-ref', 'refs/tags/v0.2.0', commit])
  const scripts = join(f.repo, 'app/scripts')
  mkdirSync(join(scripts, 'tests'), { recursive: true })
  for (const name of ['compose-skill.mjs', 'fetch-skill.mjs', 'stage-skill.mjs', 'test-with-skill.mjs']) {
    cpSync(resolve(import.meta.dirname, '..', name), join(scripts, name))
  }
  cpSync(join(import.meta.dirname, 'run-skill-compat.mjs'), join(scripts, 'tests/run-skill-compat.mjs'))
  cpSync(f.overlay, join(f.repo, 'app/skill-overlay'), { recursive: true })
  writeFileSync(join(f.repo, 'app/skill-source.json'), jsonBytes({ ...source, commit }))
  writeFileSync(join(f.repo, 'app/package.json'), jsonBytes({ skillVersion: '1.0.1' }))
  mkdirSync(join(f.repo, 'updates'))
  writeFileSync(join(f.repo, 'updates/channel.json'), jsonBytes({ skill: { version: '1.0.0' } }))
  const cache = join(f.repo, 'app/resources/skill-upstreams', commit)
  cpSync(f.upstream, cache, { recursive: true })
  const runtime = join(f.repo, 'app/resources/skill')
  const run = (offline = true) => {
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', PYTHONDONTWRITEBYTECODE: '1' }
    delete env.KNUAF_SKILL_UPSTREAM
    delete env.KNUAF_TEST_SCRIPTS_DIR
    return spawnSync(process.execPath, [join(scripts, 'test-with-skill.mjs'),
      '--python', PYTHON, ...(offline ? ['--offline'] : [])], {
      cwd: f.repo, encoding: 'utf8', env, timeout: 60_000
    })
  }
  const cachedGit = (args, input) => execFileSync('git', ['-C', cache, ...args], { encoding: 'utf8', input }).trim()
  return { ...f, cache, runtime, run, cachedGit, object: message => object(message, cachedGit) }
}

test('U3 offline cache miss rejects a stale installed runtime instead of running its tests', t => {
  const f = pinnedRuntimeFixture(t)
  writeTree(f.expected, f.runtime)
  rmSync(f.cache, { recursive: true })
  const before = readTree(f.runtime), outcome = f.run()
  assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr)
  assert.match(outcome.stderr, /Offline pinned source cache miss/)
  assert.match(outcome.stderr, /app pytest was NOT started/)
  assert.deepEqual(readTree(f.runtime), before)
})

test('U3 clean pinned cache works without remote protocols and runs full app tests', t => {
  const f = pinnedRuntimeFixture(t), outcome = f.run(false)
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr)
  assert.match(readFileSync(join(f.runtime, 'SKILL.md'), 'utf8'), /^name: knuaf-dev$/m)
  assert.equal(readFileSync(join(f.runtime, 'scripts/payload.py'), 'utf8'), 'tested\n')
  assert.match(outcome.stderr, /Pinned runtime ready; running app pytest/)
})

test('U3 full app failure outside the compatibility subset still rejects the test command', t => {
  const f = pinnedRuntimeFixture(t)
  writeFileSync(join(f.repo, 'tests/test_extra_invariant.py'),
    'from pathlib import Path\ndef test_extra_invariant():\n    body = Path(__file__).resolve().parents[1] / "app/resources/skill"\n    assert (body / "scripts/payload.py").read_text() == "additional consumer requirement\\n"\n')
  const outcome = f.run()
  assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr)
  assert.match(outcome.stderr, /Pinned runtime ready; running app pytest/)
  assert.match(outcome.stdout, /FAILED .*test_extra_invariant/)
})

test('U3 incompatible pinned cache cannot replace an earlier runtime or reach full app pytest', t => {
  const f = pinnedRuntimeFixture(t)
  // This extra upstream protection is committed in the synthetic pin, not patched after verification.
  const text = readFileSync(join(f.cache, 'skills/knuaf-doc/tests/test_basic.py'), 'utf8')
  writeFileSync(join(f.cache, 'skills/knuaf-doc/tests/test_basic.py'),
    text.replace("== 'final-bundle\\n'", "== 'unsupported final payload\\n'"))
  // Preserve cache identity checks: create a new synthetic source pin with this protection.
  f.cachedGit(['add', '--all'])
  const tree = f.cachedGit(['write-tree'])
  const commit = execFileSync('git', ['-C', f.cache, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    encoding: 'utf8', input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nincompatible fixture\n`
  }).trim()
  f.cachedGit(['update-ref', 'HEAD', commit])
  f.cachedGit(['update-ref', 'refs/tags/v0.2.0', commit])
  const target = join(f.repo, 'app/resources/skill-upstreams', commit)
  cpSync(f.cache, target, { recursive: true })
  writeFileSync(join(f.repo, 'app/skill-source.json'), jsonBytes({ ...source, commit }))
  writeTree(f.expected, f.runtime)
  const before = readTree(f.runtime), outcome = f.run()
  assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr)
  assert.match(outcome.stderr, /Pinned skill is incompatible/)
  assert.match(outcome.stderr, /app pytest was NOT started/)
  assert.deepEqual(readTree(f.runtime), before)
})

for (const path of ['tests/test_finance_unsupported.py', 'ignored/payload.py']) {
  test(`U3 cached root protections and ignored extras cannot bypass pin validation: ${path}`, t => {
    const f = pinnedRuntimeFixture(t)
    mkdirSync(resolve(f.cache, path, '..'), { recursive: true })
    writeFileSync(join(f.cache, path), 'altered cached input\n')
    const outcome = f.run()
    assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr)
    assert.match(outcome.stderr, /Source checkout is dirty/)
    assert.match(outcome.stderr, /app pytest was NOT started/)
  })
}

for (const ref of ['HEAD', 'refs/tags/v0.2.0']) {
  test(`U3 mismatching cached ${ref} fails before compatibility or app tests`, t => {
    const f = pinnedRuntimeFixture(t)
    f.cachedGit(['update-ref', ref, f.object('different pin identity')])
    const outcome = f.run()
    assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr)
    assert.match(outcome.stderr, /Source HEAD\/tag does not match pinned commit/)
    assert.match(outcome.stderr, /app pytest was NOT started/)
  })
}

function legacyPytest(f) {
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', PYTHONDONTWRITEBYTECODE: '1' }
  delete env.KNUAF_TEST_SCRIPTS_DIR
  delete env.KNUAF_SKILL_UPSTREAM
  return spawnSync(PYTHON, ['-m', 'pytest', '-o', 'addopts=', '-q'], {
    cwd: f.repo, env, encoding: 'utf8', timeout: 60_000
  })
}

test('U3-R1-01 legacy pytest in a fresh copy fails explicitly before module collection on cache miss', t => {
  const f = pinnedRuntimeFixture(t)
  rmSync(f.cache, { recursive: true })
  writeFileSync(join(f.repo, 'tests/test_missing_runtime.py'), 'import gg_core\n')
  const outcome = legacyPytest(f)
  assert.notEqual(outcome.status, 0)
  assert.match(outcome.stderr, /Offline pinned source cache miss/)
  assert.match(outcome.stderr, /Pinned runtime preparation failed before collection/)
  assert.doesNotMatch(outcome.stdout + outcome.stderr, /ModuleNotFoundError|errors during collection/)
  assert.equal(existsSync(f.runtime), false)
})

test('U3-R1-01 legacy pytest without any personal harness config prepares and tests a clean pin', t => {
  const f = pinnedRuntimeFixture(t), outcome = legacyPytest(f)
  assert.equal(existsSync(join(f.repo, '.harness.conf')), false)
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr)
  assert.match(readFileSync(join(f.runtime, 'SKILL.md'), 'utf8'), /^name: knuaf-dev$/m)
  assert.equal(readFileSync(join(f.runtime, 'scripts/payload.py'), 'utf8'), 'tested\n')
})

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`U3-R1-02 ${flag} cannot turn a required protection rejection into success`, t => {
    const original = 'from pathlib import Path\ndef test_required_protection():\n    body = Path(__file__).resolve().parents[1] / "skills/knuaf-doc"\n    assert (body / "references/basic-only.txt").read_text() == "original pin must reject this payload\\n"\n'
    const f = pinnedRuntimeFixture(t, original)
    const before = f.run()
    assert.equal(before.status, 1, before.stdout + before.stderr)
    assert.match(before.stderr, /Pinned skill is incompatible/)
    const path = 'tests/test_finance_unsupported.py', marker = join(f.root, 'tampered-test-executed')
    f.cachedGit(['update-index', flag, path])
    writeFileSync(join(f.cache, path),
      `from pathlib import Path\ndef test_required_protection():\n    Path(${JSON.stringify(marker)}).write_text("untrusted protection ran")\n`)
    assert.equal(f.cachedGit(['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '')
    const after = f.run()
    assert.equal(after.status, 1, after.stdout + after.stderr)
    assert.match(after.stderr, /Source file differs from pinned commit: tests\/test_finance_unsupported.py/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(f.runtime), false)
  })
}

for (const match of [true, false]) {
  test(`U3 cold file-only fetch ${match ? 'promotes a matching pin' : 'rejects a mismatching pin without promotion'}`, t => {
    const f = pinnedRuntimeFixture(t)
    rmSync(f.cache, { recursive: true })
    const declared = JSON.parse(readFileSync(join(f.repo, 'app/skill-source.json'), 'utf8'))
    if (!match) {
      declared.commit = 'a'.repeat(40)
      writeFileSync(join(f.repo, 'app/skill-source.json'), jsonBytes(declared))
    }
    const env = {
      ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(f.upstream).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/starceas/knuaf-doc.git'
    }
    delete env.KNUAF_SKILL_UPSTREAM
    const result = spawnSync(process.execPath, ['app/scripts/fetch-skill.mjs', '--requirements'], {
      cwd: f.repo, env, encoding: 'utf8', timeout: 60_000
    })
    assert.equal(result.status, match ? 0 : 1, result.stdout + result.stderr)
    const promoted = join(f.repo, 'app/resources/skill-upstreams', declared.commit)
    assert.equal(existsSync(promoted), match)
    if (match) {
      assert.equal(readFileSync(result.stdout.trim(), 'utf8'), '# Synthetic runtime; pytest is supplied by the test host.\n')
    } else assert.match(result.stderr, /Source HEAD\/tag does not match pinned commit/)
  })
}
