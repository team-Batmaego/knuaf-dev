import { expect, test } from '@playwright/test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { ensureSectionBaseline } from '../src/main/review-baseline'

// Only Node children: load the actual implementation, with deterministic faults at OS calls.
const compiled = ts.transpileModule(readFileSync(resolve('src/main/review-baseline.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const load = `const baseline = { exports: {} }; new Function('require', 'module', 'exports', process.env.B3_BASELINE_COMPILED)(require, baseline, baseline.exports); const ensure = baseline.exports.ensureSectionBaseline;`

function child(root: string, body: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const root = process.env.FIXTURE_ROOT, outside = process.env.FIXTURE_OUTSIDE;
    const dir = path.join(root, '.knuaf-gui', 'section-before');
    ${load}
    ${body}
  `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, B3_BASELINE_COMPILED: compiled, FIXTURE_ROOT: root, ...extra } })
}

function fixture(run: (root: string, outside: string) => void) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'knuaf-review-r1-')))
  const root = join(base, 'paper'), outside = join(base, 'outside')
  mkdirSync(join(root, '.knuaf-gui', 'section-before'), { recursive: true })
  mkdirSync(outside)
  try { run(root, outside) } finally { rmSync(base, { recursive: true, force: true }) }
}

function passed(result: SpawnSyncReturns<string>) {
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

test('R1-01: parent replacement immediately before exclusive open fails and removes outside temp', () => {
  fixture((root, outside) => {
    passed(child(root, `
      const open = fs.openSync;
      let injected = false;
      fs.openSync = function(file, flags, ...rest) {
        if (!injected && typeof file === 'string' && path.dirname(file) === dir &&
            (flags === 'wx' || (typeof flags === 'number' && (flags & fs.constants.O_CREAT)))) {
          injected = true;
          fs.renameSync(dir, dir + '-held');
          fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return open.call(this, file, flags, ...rest);
      };
      assert.throws(() => ensure(root, 'sec-race', 'must not escape'));
      assert.equal(injected, true);
      assert.deepEqual(fs.readdirSync(outside), []);
    `, { FIXTURE_OUTSIDE: outside }))
  })
})

test('R1-01: existing-file read rejects parent replacement before opening', () => {
  fixture((root, outside) => {
    writeFileSync(join(root, '.knuaf-gui', 'section-before', 'sec-read.txt'), 'original')
    writeFileSync(join(outside, 'sec-read.txt'), 'outside secret')
    passed(child(root, `
      const open = fs.openSync;
      let injected = false;
      fs.openSync = function(file, ...rest) {
        if (!injected && file === path.join(dir, 'sec-read.txt')) {
          injected = true;
          fs.renameSync(dir, dir + '-held');
          fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return open.call(this, file, ...rest);
      };
      assert.throws(() => ensure(root, 'sec-read', 'new'));
      assert.equal(injected, true);
      assert.equal(fs.readFileSync(path.join(outside, 'sec-read.txt'), 'utf8'), 'outside secret');
    `, { FIXTURE_OUTSIDE: outside }))
  })
})

test('R1-01: post-write parent relocation fails before publication and cleans reachable temp', () => {
  fixture((root, outside) => {
    passed(child(root, `
      const sync = fs.fsyncSync;
      let injected = false;
      fs.fsyncSync = function(fd) {
        const result = sync(fd);
        if (!injected) {
          injected = true;
          const moved = path.join(outside, 'moved');
          fs.renameSync(dir, moved);
          fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return result;
      };
      assert.throws(() => ensure(root, 'sec-after-write', 'complete body'));
      assert.equal(injected, true);
      assert.deepEqual(fs.readdirSync(path.join(outside, 'moved')), []);
    `, { FIXTURE_OUTSIDE: outside }))
  })
})

for (const point of ['before-write', 'partial-write', 'before-sync', 'after-sync'] as const) {
  test(`R1-02: process termination ${point} never publishes an incomplete baseline`, () => {
    fixture((root) => {
      const result = child(root, `
        const write = fs.writeFileSync, sync = fs.fsyncSync;
        fs.writeFileSync = function(fd, data, ...rest) {
          if (typeof fd === 'number') {
            if (${JSON.stringify(point)} === 'before-write') process.exit(77);
            if (${JSON.stringify(point)} === 'partial-write') { write(fd, 'partial'); process.exit(77); }
          }
          return write.call(this, fd, data, ...rest);
        };
        fs.fsyncSync = function(fd) {
          if (${JSON.stringify(point)} === 'before-sync') process.exit(77);
          const result = sync(fd);
          if (${JSON.stringify(point)} === 'after-sync') process.exit(77);
          return result;
        };
        ensure(root, 'sec-interrupted', 'complete original body');
      `)
      expect(result.status, result.stderr).toBe(77)
      const file = join(root, '.knuaf-gui', 'section-before', 'sec-interrupted.txt')
      expect(existsSync(file)).toBe(false)
      expect(ensureSectionBaseline(root, 'sec-interrupted', 'complete original body')).toEqual({ draft: 'complete original body' })
      expect(readFileSync(file, 'utf8')).toBe('complete original body')
    })
  })
}

test('R1-02: concurrent first writer publishes only complete content; loser returns winner', () => {
  fixture((root) => {
    passed(child(root, `
      const write = fs.writeFileSync;
      let injected = false;
      fs.writeFileSync = function(fd, data, ...rest) {
        if (!injected && typeof fd === 'number') {
          injected = true;
          write(fd, 'partial');
          const script = ${JSON.stringify(load)} + '\\n' +
            'require("node:assert/strict").deepEqual(ensure(process.env.FIXTURE_ROOT, "sec-contended", "winner"), { draft: "winner" });';
          const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
            env: process.env, encoding: 'utf8', timeout: 10000
          });
          assert.equal(result.status, 0, result.stderr);
          return write.call(this, fd, data, ...rest);
        }
        return write.call(this, fd, data, ...rest);
      };
      assert.deepEqual(ensure(root, 'sec-contended', 'loser'), { draft: 'winner' });
      assert.equal(fs.readFileSync(path.join(dir, 'sec-contended.txt'), 'utf8'), 'winner');
      assert.deepEqual(fs.readdirSync(dir), ['sec-contended.txt']);
    `))
  })
})

test('R1-02: termination immediately after publication preserves the complete first winner', () => {
  fixture((root) => {
    const result = child(root, `
      const close = fs.closeSync;
      fs.closeSync = function(fd) {
        close(fd);
        if (fs.existsSync(path.join(dir, 'sec-published.txt'))) process.exit(77);
      };
      ensure(root, 'sec-published', 'published winner');
    `)
    expect(result.status, result.stderr).toBe(77)
    expect(ensureSectionBaseline(root, 'sec-published', 'later')).toEqual({ draft: 'published winner' })
  })
})

test('R1-02: genuinely empty first baseline remains valid and normal saves leave no temp files', () => {
  fixture((root) => {
    expect(ensureSectionBaseline(root, 'sec-empty', '')).toEqual({ draft: '' })
    expect(ensureSectionBaseline(root, 'sec-empty', 'later body')).toEqual({ draft: '' })
    expect(readFileSync(join(root, '.knuaf-gui', 'section-before', 'sec-empty.txt'), 'utf8')).toBe('')
    expect(readdirSync(join(root, '.knuaf-gui', 'section-before'))).toEqual(['sec-empty.txt'])
  })
})
