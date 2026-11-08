import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Filesystem seam for Windows path/reparse-point tests without a Windows host. */
export interface PublicWriteFs {
  lstatSync(path: string): Stats
  realpathSync(path: string): string
  mkdirSync(path: string): unknown
  openSync(path: string, flags: 'wx', mode: number): number
  fstatSync(fd: number): Stats
  writeFileSync(fd: number, data: string): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}
interface PublicWriteOptions { platform?: NodeJS.Platform; fs?: PublicWriteFs }
const nativeFs: PublicWriteFs = { lstatSync, realpathSync, mkdirSync, openSync, fstatSync, writeFileSync, closeSync, renameSync, unlinkSync }

/**
 * Portable public-path write: never truncate a public target or predictable .tmp.
 * wx prevents following a pre-existing temp link; ancestor/identity rechecks detect replacements.
 * Node has no portable renameat/openat: an adversarial swap after the final check is NOT atomic.
 */
export function writePublicFile(root: string, file: string, data: string, options: PublicWriteOptions = {}): void {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix, fs = options.fs ?? nativeFs
  const normalize = (value: string) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (!path.isAbsolute(root) || !path.isAbsolute(file)) throw new Error('Public write requires absolute paths')
  root = path.resolve(root); file = path.resolve(file)
  const rel = path.relative(root, file)
  const parts = rel.split(path.sep)
  if (!rel || path.isAbsolute(rel) || parts.some(part => part === '..' || !part)) throw new Error('Public write escaped root')
  // Reject Windows aliases, alternate streams, and trailing-dot/space normalization before any I/O.
  if (platform === 'win32' && parts.some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe Windows public path')
  const anchor = path.parse(root).root
  const ancestors = [anchor]
  for (const part of path.relative(anchor, path.dirname(file)).split(path.sep).filter(Boolean)) {
    ancestors.push(path.join(ancestors[ancestors.length - 1], part))
  }
  const identities: { path: string; real: string; dev: number; ino: number }[] = []
  const checkAncestors = () => {
    for (const expected of identities) {
      const stat = fs.lstatSync(expected.path)
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino
        || normalize(fs.realpathSync(expected.path)) !== expected.real) throw new Error('Unsafe public ancestor changed')
    }
  }
  for (const ancestor of ancestors) {
    checkAncestors()
    let stat: Stats
    try { stat = fs.lstatSync(ancestor) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === anchor) throw error
      try { fs.mkdirSync(ancestor) } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      stat = fs.lstatSync(ancestor)
    }
    const real = normalize(fs.realpathSync(ancestor))
    if (stat.isSymbolicLink() || !stat.isDirectory() || real !== normalize(ancestor)) throw new Error('Unsafe public ancestor')
    identities.push({ path: ancestor, real, dev: stat.dev, ino: stat.ino })
  }
  const checkTargets = () => {
    for (const target of [file, `${file}.tmp`]) {
      try {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe public file')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  checkAncestors(); checkTargets()
  const temp = path.join(path.dirname(file), `.public-${randomUUID()}.tmp`)
  let descriptor: number | undefined, identity: Stats | undefined, renamed = false
  const checkTemp = () => {
    const stat = fs.lstatSync(temp)
    if (!identity || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
      || stat.nlink !== 1) throw new Error('Unsafe public temporary file')
  }
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600)
    identity = fs.fstatSync(descriptor)
    if (!identity.isFile() || identity.nlink !== 1) throw new Error('Unsafe public temporary file')
    checkAncestors(); checkTemp()
    fs.writeFileSync(descriptor, data)
    fs.closeSync(descriptor); descriptor = undefined
    checkAncestors(); checkTargets(); checkTemp()
    // Windows requires closing the handle before rename. Never unlink the destination as a fallback.
    fs.renameSync(temp, file); renamed = true
    checkAncestors()
    const saved = fs.lstatSync(file)
    if (!saved.isFile() || saved.isSymbolicLink() || saved.dev !== identity.dev || saved.ino !== identity.ino) throw new Error('Public file replaced during rename')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (!renamed && identity) {
      // Only remove our inode through unchanged ancestors; never traverse a replacement junction.
      try { checkAncestors(); checkTemp(); fs.unlinkSync(temp) } catch { /* Leave uncertain entries untouched. */ }
    }
  }
}
