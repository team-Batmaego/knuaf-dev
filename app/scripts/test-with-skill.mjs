// Hooks and CI prepare the same pinned bundle before running the full app tests.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const repo = resolve(import.meta.dirname, '../..')
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  python: { type: 'string' }, offline: { type: 'boolean', default: false }
} })
if (!values.python) throw new Error('--python is required; pass pytest options after --')
const python = /[/\\]/.test(values.python) ? resolve(values.python) : values.python
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
const args = [resolve(repo, 'app/scripts/stage-skill.mjs'), '--python', python]
if (values.offline) args.push('--offline')
console.error(`[skill-tests] Preparing pinned runtime (${values.offline ? 'offline' : 'cache first'}) before pytest`)
const preparation = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit' })
if (preparation.error || preparation.status !== 0) {
  if (preparation.error) console.error(preparation.error.message)
  console.error('[skill-tests] Runtime preparation failed; app pytest was NOT started. Fix the pinned source/cache or compatibility failure above; no stale bundle fallback.')
  process.exit(preparation.status ?? 1)
}
console.error('[skill-tests] Pinned runtime ready; running app pytest')
const tests = spawnSync(python, ['-m', 'pytest', ...positionals], {
  cwd: repo, stdio: 'inherit',
  env: { ...env, KNUAF_TEST_SCRIPTS_DIR: resolve(repo, 'app/resources/skill/scripts') }
})
if (tests.error) console.error(tests.error.message)
process.exitCode = tests.status ?? 1
