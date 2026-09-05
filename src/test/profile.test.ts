import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../lib/scan.js'
import { git } from '../lib/sh.js'
import { count, resetCounts, timed } from '../lib/profile.js'
import * as branches from '../lib/cleanups/branches.js'
import { initRepo } from './helpers.js'

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

test('profile: scan emits per-phase lines and a count block when enabled', () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    process.env['TOUPEIRA_PROFILE'] = '1'
    resetCounts()
    scan({ home })
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
test('a shared ctx cache serves per-repo reads from memory', () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-cache-'))
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    resetCounts()
    const ctx = { repos: new Set<string>([dir]), days: 7, now: Date.now(), onProgress() {}, cache: new Map<string, unknown>() }
    const first = branches.collect(ctx)
    out = ''
    const second = branches.collect(ctx)
    assert.deepEqual(second, first, 'cached reads answer the same')
    assert.ok(!out.includes('prof git symbolic-ref --short refs/remotes/origin/HEAD'), 'the base came from cache')
    assert.ok(out.includes('prof git for-each-ref'), 'uncached reads still fork')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('profile: verbose logs every git call', () => {
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    resetCounts()
    assert.match(git(['--version'], tmpdir()) ?? '', /git version/, 'the call itself still works')
    assert.match(out, /prof git --version/, 'verbose names the exact argv forked')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    resetCounts()
  }
})
