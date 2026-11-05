import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'

// CPython is already an app runtime. dir_fd pins every ancestor through rename; path rechecks do not.
const PUBLIC_WRITE = String.raw`
import json, os, stat, sys, uuid
root, parts, data = json.load(sys.stdin)
if os.open not in os.supports_dir_fd or os.rename not in os.supports_dir_fd:
    raise RuntimeError('Descriptor-relative public writes unavailable')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
parent = os.open(os.path.sep, flags)
temp = None
try:
    # Root is canonical, but each component is still opened without following links.
    for part in root.split(os.path.sep):
        if not part:
            continue
        child = os.open(part, flags, dir_fd=parent)
        os.close(parent)
        parent = child
    for part in parts[:-1]:
        try:
            os.mkdir(part, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        child = os.open(part, flags, dir_fd=parent)
        os.close(parent)
        parent = child
    leaf = parts[-1]
    for name in (leaf, leaf + '.tmp'):
        try:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Unsafe public file')
        except FileNotFoundError:
            pass
    temp = '.public-' + uuid.uuid4().hex + '.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data.encode('utf-8'))
    os.rename(temp, leaf, src_dir_fd=parent, dst_dir_fd=parent)
    temp = None
finally:
    if temp is not None:
        os.unlink(temp, dir_fd=parent)
    os.close(parent)
`
/** No fallback to path-based writes: unsupported runtimes fail closed, including missing dir_fd. */
export function writePublicFile(root: string, file: string, data: string, python: string): void {
  const rel = relative(root, file)
  if (!isAbsolute(root) || !rel || isAbsolute(rel) || rel.split(sep).some(part => part === '..')) throw new Error('Public write escaped root')
  const result = spawnSync(python, ['-I', '-c', PUBLIC_WRITE], {
    input: JSON.stringify([root, rel.split(sep), data]), encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    windowsHide: true
  })
  // Do not forward subprocess stderr: paths/data from public storage must not become diagnostics.
  if (result.error || result.status !== 0) throw new Error('Unsafe public file or ancestor; descriptor-relative write failed')
}
