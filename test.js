import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeProjectDir, parseWorktrees, isContentMerged, human, remove, treeRows, banner } from './index.js'

test('decodeProjectDir resolves dashes in real directory names', () => {
  const real = new Set(['/home', '/home/me', '/home/me/dev', '/home/me/dev/toupeira'])
  const exists = (p) => real.has(p)
  assert.deepEqual(decodeProjectDir('-home-me-dev-toupeira', exists), { path: '/home/me/dev/toupeira', exists: true })
})

test('decodeProjectDir reports a vanished path instead of guessing', () => {
  const exists = (p) => p === '/tmp'
  const r = decodeProjectDir('-tmp-agent-box-9DSMZ6', exists)
  assert.equal(r.exists, false)
  assert.equal(r.path, '/tmp/agent-box-9DSMZ6')
})

test('parseWorktrees keeps paths with spaces and flags prunable', () => {
  const wt = parseWorktrees(
    'worktree /home/me/my repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/gone\nHEAD def456\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n'
  )
  assert.equal(wt.length, 2)
  assert.equal(wt[0].path, '/home/me/my repo')
  assert.equal(wt[0].branch, 'main')
  assert.equal(wt[1].branch, 'feat/x')
  assert.equal(wt[1].prunable, true)
  assert.equal(wt[0].prunable, false)
})

test('isContentMerged catches a squash merge that git branch --merged misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
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

test('human', () => {
  assert.equal(human(0), '0 B')
  assert.equal(human(1536), '1.5 KB')
  assert.equal(human(4.2 * 1024 ** 3), '4.2 GB')
})

test('remove refuses a path outside the category it belongs to', () => {
  assert.throws(
    () => remove({ path: '/home/me/importante', action: { kind: 'rm', guard: '/.claude/projects/' } }),
    /outside its category/
  )
})

test('treeRows orders categories by total size and only expands what is open', () => {
  const items = [
    { cat: 'small', size: 10 },
    { cat: 'big', size: 4 },
    { cat: 'big', size: 5 },
  ]
  const collapsed = treeRows(items, new Set())
  assert.deepEqual(collapsed.map((r) => r.cat), ['small', 'big'])
  assert.equal(collapsed.every((r) => r.type === 'cat'), true)

  const open = treeRows(items, new Set(['big']))
  assert.deepEqual(open.map((r) => `${r.type}:${r.cat}`), ['cat:small', 'cat:big', 'item:big', 'item:big'])
  assert.deepEqual(open.filter((r) => r.type === 'item').map((r) => r.idx), [1, 2])
})

test('banner degrades to the bare name when the terminal is too narrow', () => {
  assert.deepEqual(banner(40), ['toupeira'])
})

test('banner ground line is exactly as wide as the widest row', () => {
  const rows = banner(120)
  const ground = rows.at(-1)
  assert.equal(Math.max(...rows.map((r) => r.length)), ground.length)
  assert.equal(ground.startsWith('~~""((('), true)
})

test('banner treats a terminal reporting zero columns as unknown, not tiny', () => {
  assert.notDeepEqual(banner(0), ['toupeira'])
})
