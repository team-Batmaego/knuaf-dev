import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export type SectionBaseline = { draft: string }

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? ''
const SECTION_ID = /^[A-Za-z0-9_-]+$/

type Directory = { path: string; info: BigIntStats }

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino
}

function ensureDirectory(path: string): Directory {
  let info
  try { info = lstatSync(path, { bigint: true }) } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
    try { mkdirSync(path, { mode: 0o700 }) } catch (mkdirError) {
      if (codeOf(mkdirError) !== 'EEXIST') throw mkdirError
    }
    info = lstatSync(path, { bigint: true })
  }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('비교 기준 경로는 실제 폴더여야 합니다.')
  }
  return { path, info }
}

// Best-effort checks, not a sandbox: malicious same-user namespace races are out of scope.
function verifyFile(path: string, fd: number, directories: Directory[]): void {
  const actual = realpathSync(path)
  const within = relative(directories[0].path, actual)
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || actual !== path) {
    throw new Error('비교 기준 경로가 논문 폴더 밖이거나 바뀌었습니다.')
  }
  for (const directory of directories) {
    const info = lstatSync(directory.path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory.path) !== directory.path ||
        !sameFile(info, directory.info)) {
      throw new Error('비교 기준 폴더가 바뀌었습니다.')
    }
  }
  const opened = fstatSync(fd, { bigint: true })
  const named = lstatSync(path, { bigint: true })
  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(opened, named)) {
    throw new Error('비교 기준 파일이 일반 파일이 아니거나 바뀌었습니다.')
  }
}

function readBaselineFile(path: string, directories: Directory[]): string | null {
  let info
  try { info = lstatSync(path) } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('비교 기준 파일이 일반 파일이 아닙니다.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    verifyFile(path, fd, directories)
    const draft = readFileSync(fd, 'utf8')
    verifyFile(path, fd, directories)
    return draft
  } finally { closeSync(fd) }
}

function removeTemp(path: string, identity: BigIntStats): void {
  // A detected parent redirection may leave our temp at a reachable outside path.
  // Never unlink a replacement file or follow a final-component symlink.
  let actual: string
  try { actual = realpathSync(path) } catch (error) {
    if (codeOf(error) === 'ENOENT') return
    throw error
  }
  const named = lstatSync(path, { bigint: true })
  if (named.isFile() && !named.isSymbolicLink() && sameFile(named, identity) &&
      sameFile(lstatSync(actual, { bigint: true }), identity)) unlinkSync(actual)
}

/** Create the first-seen section baseline without ever replacing an existing one. */
export function ensureSectionBaseline(root: string, sectionId: string, draft: string): SectionBaseline {
  if (typeof root !== 'string' || !root || typeof draft !== 'string') throw new Error('비교 기준 인자가 올바르지 않습니다.')
  if (typeof sectionId !== 'string' || !SECTION_ID.test(sectionId)) throw new Error('장 ID가 비교 기준 파일 이름으로 안전하지 않습니다.')

  const projectRoot = realpathSync(root)
  const project = ensureDirectory(projectRoot)
  const appDir = join(projectRoot, '.knuaf-gui')
  const baselineDir = join(appDir, 'section-before')
  const directories = [project, ensureDirectory(appDir), ensureDirectory(baselineDir)]

  const file = join(baselineDir, `${sectionId}.txt`)
  const saved = readBaselineFile(file, directories)
  if (saved !== null) return { draft: saved }

  const temp = join(baselineDir, `.${sectionId}.${randomUUID()}.tmp`)
  let fd: number | null = null
  let identity: BigIntStats | null = null
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    identity = fstatSync(fd, { bigint: true })
    verifyFile(temp, fd, directories)
    writeFileSync(fd, draft, { encoding: 'utf8' })
    fsyncSync(fd)
    verifyFile(temp, fd, directories)
    try {
      // Same-directory hard link publishes complete bytes atomically, never replacing a winner.
      // Unsupported filesystems fail; rename/copy fallbacks would violate this contract.
      linkSync(temp, file)
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
    const winner = readBaselineFile(file, directories)
    if (winner === null) throw new Error('공개한 비교 기준 파일이 사라졌습니다.')
    return { draft: winner }
  } finally {
    try { if (fd !== null) closeSync(fd) } finally {
      if (identity !== null) removeTemp(temp, identity)
    }
  }
}
