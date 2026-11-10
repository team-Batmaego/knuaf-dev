import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
/** Resolve existing ancestors too: a nonexistent leaf beneath a symlink is not safe. */
export function canonical(path: string): string {
  path = resolve(path)
  try {
    lstatSync(path)
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // existsSync follows links; reject dangling links rather than treating them as fresh files.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Dangling symlink') } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
    }
  }
  const parent = dirname(path)
  if (parent === path) return path
  return join(canonical(parent), relative(parent, path))
}
export function outputName(name: string): boolean {
  return Boolean(name) && !isAbsolute(name) && !name.includes('\\') && !name.split('/').some(p => !p || p === '.' || p === '..')
}
export function createOutput(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid job id')
  const gui = join(root, '.knuaf-gui')
  const jobs = join(gui, 'jobs')
  for (const path of [gui, jobs]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symlink in job storage')
    mkdirSync(path, { recursive: true })
    if (!inside(root, realpathSync(path))) throw new Error('Job storage escaped thesis folder')
  }
  const job = join(jobs, id)
  // Never reuse an old or partially populated output directory.
  mkdirSync(job)
  const out = join(job, 'out'); mkdirSync(out)
  return realpathSync(out)
}
export function thesisHashes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), name = relative(root, path).split(sep).join('/')
      if (dir === root && ['.knuaf-gui', '.git', '.claude', '.agents'].includes(entry.name)) continue
      if (name === 'audit/model-routing' || name.startsWith('audit/model-routing/')) continue
      if (entry.isSymbolicLink()) result[name] = `symlink:${canonical(path)}`
      else if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) result[name] = sha256(readFileSync(path))
    }
  }
  walk(root); return result
}
export interface ToolDecision { permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string }
export interface RelayIsolation {
  cwd: string
  outputs: readonly string[]
  settingSources: readonly []
  codexSandbox: 'workspace-write'
  sandbox: { enabled: true; failIfUnavailable: true; allowUnsandboxedCommands: false }
  shellEnabled: boolean
  preToolUse: (name: string, input: Record<string, unknown>) => ToolDecision
  canUseTool: (name: string, input: Record<string, unknown>, appApproved?: boolean) => ToolDecision
}
export function relayIsolation(cwd: string, outputs: readonly string[], shellEnabled: boolean): RelayIsolation {
  const deny: ToolDecision = { permissionDecision: 'deny', permissionDecisionReason: '담당은 승인된 출력 칸만 사용할 수 있어요.' }
  const allow: ToolDecision = { permissionDecision: 'allow' }
  const check = (name: string, input: Record<string, unknown>): ToolDecision => {
    if (name === 'Agent' || name === 'Task') return deny
    if (name === 'Bash') return shellEnabled && input.dangerouslyDisableSandbox !== true ? allow : deny
    if (['Write', 'Edit', 'NotebookEdit'].includes(name)) {
      const value = name === 'NotebookEdit' ? input.notebook_path : input.file_path
      if (typeof value !== 'string') return deny
      const path = resolve(cwd, value)
      if (!inside(cwd, canonical(path))) return deny
      const rel = relative(cwd, path).split(sep).join('/')
      return outputs.includes(rel) ? allow : deny
    }
    return ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(name) ? allow : deny
  }
  return {
    cwd, outputs: [...outputs], settingSources: [], codexSandbox: 'workspace-write',
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }, shellEnabled,
    preToolUse: check,
    // No student trust or permission card. Shell judgement remains the engine's app-policy check.
    canUseTool: (name, input, appApproved = false) => name === 'Bash' && !appApproved ? deny : check(name, input)
  }
}
