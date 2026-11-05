import { expect, test } from '@playwright/test'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep, win32 } from 'node:path'
import { writePublicFile, type PublicWriteFs } from '../src/main/chat/jobs/publicWrite'

/** Real file bytes/fds, with Windows drive/UNC names translated at the test filesystem boundary. */
function windowsFixture(unc = false) {
  const base = nodeFs.realpathSync(nodeFs.mkdtempSync(join(tmpdir(), 'w6c-windows-')))
  const drive = join(base, 'drive'); nodeFs.mkdirSync(drive)
  const anchor = unc ? '\\\\server\\share\\' : 'C:\\'
  const root = win32.join(anchor, 'work', '논문'), file = win32.join(root, '.knuaf-gui', 'jobs', 'job.json')
  const local = (path: string) => {
    const rel = win32.relative(anchor, path)
    if (win32.isAbsolute(rel) || rel.split('\\').includes('..')) throw new Error('Test path escaped drive')
    return join(drive, ...rel.split('\\').filter(Boolean))
  }
  nodeFs.mkdirSync(local(root), { recursive: true })
  const flags: string[] = [], renamed: string[] = []
  let openFd = false
  const fs: PublicWriteFs = {
    lstatSync: path => nodeFs.lstatSync(local(path)),
    realpathSync: path => win32.join(anchor, ...relative(drive, nodeFs.realpathSync(local(path))).split(sep)),
    mkdirSync: path => nodeFs.mkdirSync(local(path)),
    openSync: (path, flag, mode) => { flags.push(flag); const fd = nodeFs.openSync(local(path), flag, mode); openFd = true; return fd },
    fstatSync: fd => nodeFs.fstatSync(fd), writeFileSync: (fd, data) => nodeFs.writeFileSync(fd, data),
    closeSync: fd => { nodeFs.closeSync(fd); openFd = false },
    renameSync: (from, to) => { expect(openFd, 'Windows rename must follow close').toBe(false); renamed.push(to); nodeFs.renameSync(local(from), local(to)) },
    unlinkSync: path => nodeFs.unlinkSync(local(path))
  }
  return { base, drive, anchor, root, file, local, fs, flags, renamed }
}

for (const unc of [false, true]) test(`fake Windows ${unc ? 'UNC' : 'drive'} publishes and replaces manifest with shell-independent Node I/O`, () => {
  const f = windowsFixture(unc)
  writePublicFile(f.root, f.file, '{"status":"queued"}', { platform: 'win32', fs: f.fs })
  writePublicFile(f.root, f.file, '{"status":"completed"}', { platform: 'win32', fs: f.fs })
  expect(JSON.parse(nodeFs.readFileSync(f.local(f.file), 'utf8'))).toEqual({ status: 'completed' })
  expect(f.flags).toEqual(['wx', 'wx'])
  expect(f.renamed).toEqual([f.file, f.file])
  expect(nodeFs.readdirSync(f.local(win32.dirname(f.file)))).toEqual(['job.json'])
})

for (const attack of ['tmp', 'target', 'junction', 'dangling'] as const) test(`fake Windows ${attack} cannot overwrite outside bytes`, () => {
  const f = windowsFixture(), victim = join(f.base, 'outside'); nodeFs.writeFileSync(victim, 'KEEP')
  nodeFs.mkdirSync(f.local(win32.dirname(f.file)), { recursive: true })
  if (attack === 'junction') {
    const outsideDir = join(f.base, 'outside-dir'); nodeFs.mkdirSync(outsideDir)
    const jobs = f.local(win32.dirname(f.file)); nodeFs.rmdirSync(jobs)
    nodeFs.symlinkSync(outsideDir, jobs, 'junction')
  } else nodeFs.symlinkSync(attack === 'dangling' ? join(f.base, 'missing') : victim, f.local(f.file + (attack === 'tmp' ? '.tmp' : '')))
  expect(() => writePublicFile(f.root, f.file, 'BAD', { platform: 'win32', fs: f.fs })).toThrow('Unsafe public')
  expect(nodeFs.readFileSync(victim, 'utf8')).toBe('KEEP')
  expect(f.flags).toEqual([]); expect(f.renamed).toEqual([])
})

test('fake Windows rejects ancestor identity replacement between creation and rename', () => {
  const f = windowsFixture(), originalWrite = f.fs.writeFileSync
  const outside = join(f.base, 'outside-dir'); nodeFs.mkdirSync(outside)
  nodeFs.writeFileSync(join(outside, 'sentinel'), 'KEEP')
  f.fs.writeFileSync = (fd, data) => {
    originalWrite(fd, data)
    const jobs = f.local(win32.dirname(f.file))
    nodeFs.renameSync(jobs, `${jobs}-old`); nodeFs.symlinkSync(outside, jobs, 'junction')
  }
  expect(() => writePublicFile(f.root, f.file, 'BAD', { platform: 'win32', fs: f.fs })).toThrow('ancestor')
  expect(nodeFs.readdirSync(outside)).toEqual(['sentinel'])
  expect(nodeFs.readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('KEEP')
  expect(f.renamed).toEqual([])
})

test('fake Windows exclusive temp creation never follows a raced temporary symlink', () => {
  const f = windowsFixture(), victim = join(f.base, 'victim'); nodeFs.writeFileSync(victim, 'KEEP')
  f.fs.openSync = (path, flags, mode) => {
    nodeFs.symlinkSync(victim, f.local(path))
    return nodeFs.openSync(f.local(path), flags, mode)
  }
  expect(() => writePublicFile(f.root, f.file, 'BAD', { platform: 'win32', fs: f.fs })).toThrow()
  expect(nodeFs.readFileSync(victim, 'utf8')).toBe('KEEP'); expect(f.renamed).toEqual([])
})

test('fake Windows denies alternate streams, reserved names and path escape before I/O', () => {
  const f = windowsFixture()
  for (const name of ['job.json:stream', 'NUL', 'aux.json', 'COM1.txt', 'trailing.', 'trailing ', '..\\..\\outside', 'other\\..\\..\\..\\outside']) {
    expect(() => writePublicFile(f.root, win32.join(f.root, name), 'BAD', { platform: 'win32', fs: f.fs })).toThrow()
  }
  expect(() => writePublicFile(f.root, 'D:\\outside', 'BAD', { platform: 'win32', fs: f.fs })).toThrow('escaped')
  expect(f.flags).toEqual([])
})

test('native Node writes preserve predictable tmp and hardlinked destination bytes', () => {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(join(tmpdir(), 'w6c-native-')))
  const victim = join(root, 'victim'), file = join(root, 'public', 'job.json')
  nodeFs.mkdirSync(join(root, 'public')); nodeFs.writeFileSync(victim, 'KEEP'); nodeFs.linkSync(victim, file)
  nodeFs.writeFileSync(`${file}.tmp`, 'UNTOUCHED')
  writePublicFile(root, file, 'NEW')
  expect(nodeFs.readFileSync(victim, 'utf8')).toBe('KEEP')
  expect(nodeFs.readFileSync(file, 'utf8')).toBe('NEW')
  expect(nodeFs.readFileSync(`${file}.tmp`, 'utf8')).toBe('UNTOUCHED')
})
