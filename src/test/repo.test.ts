import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isContentMerged } from '../index.js'
import { mergedBranches } from '../lib/repo.js'
import { initRepo, sorted } from './helpers.js'

test('isContentMerged catches a squash merge that git branch --merged misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-'))
  const g = initRepo(dir)
  try {
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')

    g('checkout', '-qb', 'squashed')
    writeFileSync(join(dir, 'b'), 'two\n')
    g('add', '.')
    g('commit', '-qm', 'work part 1')
    writeFileSync(join(dir, 'b'), 'two\nthree\n')
    g('commit', '-qam', 'work part 2')

    g('checkout', '-qb', 'open', 'main')
    writeFileSync(join(dir, 'c'), 'other\n')
    g('add', '.')
    g('commit', '-qm', 'unrelated open work')

    g('checkout', '-q', 'main')
    g('merge', '--squash', 'squashed')
    g('commit', '-qm', 'squashed PR #1')

    assert.equal(g('branch', '--merged', 'main').includes('squashed'), false, 'setup: git itself must not see the squash')
    assert.equal(isContentMerged(dir, 'squashed', 'main'), true)
    assert.equal(isContentMerged(dir, 'open', 'main'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergedBranches reads the whole list, markers and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-br-'))
  const g = initRepo(dir)
  try {
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('branch', 'done')
    g('worktree', 'add', '-q', join(dir, 'wt'), '-b', 'parked')
    // `* main` is the checkout, `+ parked` sits in a worktree, both are merged names
    assert.deepEqual(sorted(mergedBranches(dir, 'main')), ['done', 'main', 'parked'])
    assert.deepEqual([...mergedBranches(dir, 'nope')], [], 'an unknown base is unknown, not a list')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
