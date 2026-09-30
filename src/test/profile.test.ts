import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../lib/scan.js'
import { gitAsync, limited } from '../lib/sh.js'
import { count, resetCounts, timed } from '../lib/profile.js'
import * as branches from '../lib/cleanups/branches.js'
import * as worktrees from '../lib/cleanups/worktrees.js'
import { initRepo } from './helpers.js'

test('the shared limiter overlaps work, caps concurrency and releases rejected tasks', { skip: availableParallelism() < 2 }, async () => {
  const limit = availableParallelism()
  let active = 0
  let peak = 0
  const tasks = Array.from({ length: limit + 3 }, (_, index) => limited(async () => {
    active++
    peak = Math.max(peak, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (index === 0) throw new Error('expected task failure')
      return index
    } finally {
      active--
    }
  }));
  const results = await Promise.allSettled(tasks)
  assert.ok(peak > 1, `expected overlap, got peak ${peak}`)
  assert.ok(peak <= limit, `peak ${peak} exceeded limit ${limit}`)
  assert.equal(results[0]?.status, 'rejected')
  assert.ok(results.slice(1).every((result) => result.status === 'fulfilled'), 'queued work completes after a rejection')
  assert.equal(await limited(async () => 'available'), 'available', 'the limiter remains usable')
})

// profiling is opt-in stderr only: with the env unset the wrappers are passthrough
test('profile: timed and counts stay silent unless TOUPEIRA_PROFILE is set', () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    delete process.env['TOUPEIRA_PROFILE']
    resetCounts()
    assert.equal(timed('x', () => 42), 42)
    count('git')
    assert.equal(out, '', 'nothing on stdout or stderr when profiling is off')

    process.env['TOUPEIRA_PROFILE'] = '1'
    assert.equal(timed('x', () => 42), 42)
    assert.match(out, /prof x \d/, 'one stderr line per phase when profiling is on')

    out = ''
    process.env['TOUPEIRA_PROFILE'] = 'true'
    assert.equal(timed('y', () => 84), 84)
    assert.match(out, /prof y \d/, 'profiling is also enabled with TOUPEIRA_PROFILE=true')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
  }
})

test('profile: scan emits per-phase lines and a count block when enabled', async () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    process.env['TOUPEIRA_PROFILE'] = '1'
    resetCounts()
    await scan({ home })
    assert.match(out, /prof discovery /, 'discovery phase is timed')
    assert.match(out, /prof collect /, 'every cleanup collect is timed')
    assert.match(out, /prof measure diskUsage/, 'the du/stat phase is timed')
    assert.match(out, /prof count measured-paths/, 'the count block closes the scan')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
    rmSync(home, { recursive: true, force: true })
  }
})

// a ctx cache shares per-repo reads between runs: the second collect forks less
test('concurrent cleanups share per-repo promises from their ctx cache', async () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-cache-'))
  const remote = join(dir, 'remote.git')
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('init', '--bare', '-q', remote)
    g('remote', 'add', 'origin', remote)
    g('push', '-qu', 'origin', 'main')
    g('remote', 'set-head', 'origin', 'main')
    g('checkout', '-qb', 'gone', 'main')
    g('push', '-qu', 'origin', 'gone')
    g('push', '-q', 'origin', '--delete', 'gone')
    g('fetch', '-q', '--prune', 'origin')
    g('checkout', '-q', 'main')
    g('branch', 'done')
    g('worktree', 'add', join(dir, 'wt'), 'done')

    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    resetCounts()
    const ctx = { repos: new Set<string>([dir]), days: 7, now: Date.now() + 40 * 86400e3, onProgress() {}, cache: new Map<string, unknown>() }
    await Promise.all([branches.collect(ctx), worktrees.collect(ctx)])
    const calls = (prefix: string): number => out.split('\n').filter((line) => line.startsWith(prefix)).length
    assert.equal(calls('prof git symbolic-ref --quiet refs/remotes/origin/HEAD'), 1)
    assert.equal(calls('prof git for-each-ref --merged refs/remotes/origin/main refs/heads '), 1)
    assert.equal(calls('prof git worktree list --porcelain'), 1)
    assert.equal(calls('prof git remote'), 1)
    assert.equal(calls('prof git for-each-ref refs/heads '), 1, 'branch status is shared with worktree checks')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('profile: verbose logs every git call', async () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    resetCounts()
    assert.match(await gitAsync(['--version'], tmpdir()) ?? '', /git version/, 'the call itself still works')
    assert.match(out, /prof git --version/, 'verbose names the exact argv forked')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
  }
})
