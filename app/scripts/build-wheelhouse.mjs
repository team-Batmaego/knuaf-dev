// Offline wheels belong to the staged manifest and bundled interpreter; preview also needs its reader there.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const app = resolve(import.meta.dirname, '..')
const scripts = resolve(app, 'resources/skill/scripts')
const req = join(scripts, 'requirements-runtime.txt')
const out = resolve(app, 'resources/wheelhouse')
const py = process.platform === 'win32' ? resolve(app, 'resources/python/python.exe') : resolve(app, 'resources/python/bin/python3')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (!existsSync(py)) throw new Error('Bundled Python missing; run fetch:python first')
if (process.env.PYTHON) throw new Error('PYTHON override cannot build the bundled target wheelhouse')
const probe = spawnSync(py, ['-I', '-c', 'import json,sys,sysconfig,platform; print(json.dumps({"platform":sys.platform,"arch":platform.machine(),"abi":sysconfig.get_config_var("SOABI"),"version":sys.version,"target":sysconfig.get_platform()}))'], { encoding: 'utf8' })
if (probe.status !== 0) throw new Error(`Bundled Python probe failed: ${probe.stderr}`)
const runtime = JSON.parse(probe.stdout)
const target = runtime.platform === 'win32' ? 'x86_64-pc-windows-msvc'
  : runtime.platform === 'darwin' ? `${runtime.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : null
if (!target || (process.env.PBS_TARGET && process.env.PBS_TARGET !== target)) {
  throw new Error(`Bundled Python target ${target} does not match PBS_TARGET; cross-host wheelhouse builds are forbidden`)
}
const key = hash(JSON.stringify({ runtime, target,
  requirements: hash(readFileSync(req)), manifest: hash(readFileSync(join(scripts, 'runtime-deps.json'))),
  specification: hash(readFileSync(resolve(app, 'python-runtime.json'))) }))
const stamp = join(out, '.Complete')
const wheels = () => Object.fromEntries(readdirSync(out).filter(f => f.endsWith('.whl')).sort()
  .map(f => [f, hash(readFileSync(join(out, f)))]))
const force = process.argv.includes('--force') || process.env.WHEELHOUSE_FORCE === '1'
let cacheHit = false
if (!force && existsSync(stamp)) {
  try {
    const cached = JSON.parse(readFileSync(stamp, 'utf8'))
    const actual = wheels()
    cacheHit = cached.key === key && Object.keys(actual).length > 0 && JSON.stringify(cached.wheels) === JSON.stringify(actual)
  } catch { /* Incomplete generated cache is rebuilt below. */ }
}
if (cacheHit) {
  console.log('verified wheelhouse →', out, key)
} else {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const result = spawnSync(py, ['-m', 'pip', 'download', '--only-binary=:all:', '--dest', out, '-r', req, 'pip', 'setuptools'], {
    stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  writeFileSync(stamp, JSON.stringify({ key, runtime, target, wheels: wheels() }) + '\n')
  console.log('wheelhouse →', out, key)
}

// Preview precedes a project's .venv. Cache hits must also repair older bundled runtimes.
const install = spawnSync(py, ['-m', 'pip', 'install', '--no-index', '--find-links', out, '--no-compile', 'openpyxl>=3.1,<4'], {
  stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' }
})
if (install.status !== 0) process.exit(install.status ?? 1)
const check = spawnSync(py, ['-I', '-c', 'from openpyxl import load_workbook; print("bundled xlsx preview ready")'], { stdio: 'inherit' })
if (check.status !== 0) process.exit(check.status ?? 1)
