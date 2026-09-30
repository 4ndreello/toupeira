import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dedupe, scan } from '../lib/scan.js'
import { resetCounts } from '../lib/profile.js'
import { combinedSize, diskUsage } from '../lib/sh.js'
import { writeAt, initRepo } from './helpers.js'

test('an item inside a tree-removing item is dropped, but not under a prune', () => {
  const items = [
    { path: '/wt', action: { kind: 'worktree-remove' } },
    { path: '/wt/node_modules', action: { kind: 'rm' } },
    { path: '/other/node_modules', action: { kind: 'rm' } },
    { path: '/gone', action: { kind: 'prune' } },
    { path: '/gone/node_modules', action: { kind: 'rm' } },
  ]
  assert.deepEqual(
    dedupe(items).map((i) => i.path),
    ['/wt', '/other/node_modules', '/gone', '/gone/node_modules']
  )
})

test('du measures directories on bsd as well as gnu', async () => {
  // `du -sb` is gnu-only: on macos it exits with "illegal option" and every directory,
  // plus the whole headline, silently measured 0 B
  const home = mkdtempSync(join(tmpdir(), 'toupeira-du-'))
  try {
    const dir = join(home, 'cache')
    mkdirSync(dir)
    writeFileSync(join(dir, 'blob'), 'x'.repeat(200_000))
    assert.ok(((await diskUsage([dir])).get(dir) ?? 0) >= 200_000, 'a directory measures its contents')
    assert.ok(combinedSize([dir]) >= 200_000, 'the deduped headline is not zero')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scan runs the whole pipeline over one repo: measure, dedupe, sort', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-scan-'))
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('branch', 'done')
    g('worktree', 'add', join(dir, 'wt'), 'done')
    mkdirSync(join(dir, 'wt/node_modules'), { recursive: true })
    writeFileSync(join(dir, 'wt/node_modules/blob'), 'x'.repeat(200_000))

    const { items, kept, repos } = await scan({ days: 7, roots: [dir], home })
    assert.equal(repos, 1, 'the recorded root folds into one repository')
    assert.deepEqual(kept, [])
    assert.deepEqual(
      items.map((i) => i.path),
      [join(dir, 'wt')],
      'the node_modules under the worktree is deduped away'
    )
    assert.ok(items[0]!.size >= 200_000, 'the surviving item carries the measured size')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scan concatenates concurrently collected cleanups in registry order', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-order-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-order-scan-'))
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('branch', 'done')
    const worktree = join(dir, 'wt')
    g('worktree', 'add', worktree, 'done')
    const size = (await diskUsage([worktree])).get(worktree) ?? 0
    assert.ok(size > 0, 'the worktree has a measurable target')
    writeAt(home, '.claude/paste-cache/tie.txt', 'x'.repeat(size), Date.now() - 30 * 86400e3)

    const { items } = await scan({ roots: [dir], home })
    assert.deepEqual(items.map((item) => item.cat), ['worktree-merged', 'agent-cache'])
    assert.equal(items[0]!.size, items[1]!.size, 'the size sort keeps the tie in cleanup order')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scan hides candidates with no measurable bytes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    // package-store maintenance has no measurable target, while the old cache file
    // proves a positive-size candidate still reaches the result.
    mkdirSync(join(home, '.npm'), { recursive: true })
    const old = Date.now() - 30 * 86400e3
    writeAt(home, '.claude/paste-cache/old.txt', 'x', old)

    const { items } = await scan({ home })
    assert.equal(items.length, 1)
    assert.equal(items[0]!.cat, 'agent-cache')
    assert.equal(items[0]!.size, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// duplicate roots resolve once: discovery memos mainRepoOf by input path
test('scan resolves duplicate roots once', async () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-dup-'))
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    initRepo(dir)
    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    resetCounts()
    const { repos } = await scan({ roots: [dir, dir], home })
    assert.equal(repos, 1)
    assert.equal(
      out.split('\n').filter((l) => l === 'prof git rev-parse --path-format=absolute --git-common-dir').length,
      1,
      'the second identical cwd reuses the first resolution'
    )
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

// async subprocess calls let spinner timers run while the scan is in progress
test('scan keeps the event loop available during async subprocess calls', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-yield-'))
  // scheduled before the scan: it can only have run if the loop turned before scan resolved
  let loopTurned = false
  setImmediate(() => {
    loopTurned = true
  })
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('branch', 'done')
    g('worktree', 'add', join(dir, 'wt'), 'done')
    mkdirSync(join(dir, 'wt/node_modules'), { recursive: true })
    writeFileSync(join(dir, 'wt/node_modules/blob'), 'x'.repeat(200_000))
    await scan({ days: 7, roots: [dir], home })
    assert.equal(loopTurned, true, 'the event loop never turned during the whole scan')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
