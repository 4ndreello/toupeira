import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseWorktrees, remove } from '../index.js'
import { harnessCwds } from '../lib/harnesses.js'
import { mainRepoOf } from '../lib/repo.js'
import { git } from '../lib/sh.js'
import * as worktrees from '../lib/cleanups/worktrees.js'
import { gitIn, gitAt, initRepo } from './helpers.js'

test('parseWorktrees keeps paths with spaces and flags prunable', () => {
  const wt = parseWorktrees(
    'worktree /home/me/my repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/gone\nHEAD def456\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n'
  )
  assert.equal(wt.length, 2)
  assert.equal(wt[0]!.path, '/home/me/my repo')
  assert.equal(wt[0]!.branch, 'main')
  assert.equal(wt[1]!.branch, 'feat/x')
  assert.equal(wt[1]!.prunable, true)
  assert.equal(wt[0]!.prunable, false)
})

test('t3 code feeds its parked worktrees into the regular worktree cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const repoDir = mkdtempSync(join(tmpdir(), 'toupeira-t3repo-'))
  try {
    const g = (a: string[]): string | null => git(a, repoDir)
    g(['init', '-q', '-b', 'main'])
    g(['config', 'user.email', 't@t'])
    g(['config', 'user.name', 't'])
    writeFileSync(join(repoDir, 'a'), 'one\n')
    g(['add', '.'])
    g(['commit', '-qm', 'init'])

    // the way t3 code parks an agent workspace: ~/.t3/worktrees/<repo>/<branch>
    const wt = join(home, '.t3/worktrees', basename(repoDir), 'feature-x')
    mkdirSync(wt, { recursive: true })
    g(['worktree', 'add', wt, '-b', 'feature-x', 'main'])

    assert.equal(harnessCwds(home).has(wt), true, 'the parked workspace counts as a recorded working directory')
    assert.equal(realpathSync(mainRepoOf(wt)!), realpathSync(repoDir), 'it resolves to its main repository like any worktree')

    const repos = new Set<string>([...harnessCwds(home)].map((p) => mainRepoOf(p)).filter((v): v is string => Boolean(v)))
    const { items } = worktrees.collect({ repos, days: 7, now: Date.now(), onProgress() {} })
    assert.deepEqual(items.map((i) => [i.cat, i.path]), [['worktree-merged', wt]], 'a clean merged t3 workspace is offered for removal')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  }
})

// one repo carrying a worktree of every kind the cleanup must tell apart
function worktreeYard() {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-wt-'))
  const old = new Date(Date.now() - 40 * 86400e3).toISOString()
  const g = gitIn(dir)
  const gc = gitAt(dir, old)
  const commit = (file: string, body: string, msg: string, aged = false): void => {
    writeFileSync(join(dir, file), body)
    g('add', file)
    // g eats varargs, gc one array: each gets its own shape
    if (aged) gc(['commit', '-qm', msg])
    else g('commit', '-qm', msg)
  }
  initRepo(dir)
  commit('a', 'one\n', 'init')
  commit('.gitignore', 'node_modules\n', 'ignore builds')
  // a real upstream, so pushed branches can be told from unpushed ones
  g('remote', 'add', 'origin', join(dir, 'origin.git'))
  g('init', '--bare', '-q', join(dir, 'origin.git'))
  g('push', '-qu', 'origin', 'main')
  return { dir, g, commit }
}

test('the worktree cleanup offers the provably safe and holds the rest with reasons', () => {
  const { dir, g, commit } = worktreeYard()
  try {
    // merged and idle: offered whatever its age
    g('branch', 'done')
    g('worktree', 'add', join(dir, 'wt-done'), 'done')

    // pushed, in sync, unmerged, old , offered, but not as safe, riding a node_modules
    g('checkout', '-qb', 'parked')
    commit('b', 'two\n', 'parked work', true)
    g('push', '-qu', 'origin', 'parked')
    g('checkout', '-q', 'main')
    g('worktree', 'add', join(dir, 'wt-parked'), 'parked')
    mkdirSync(join(dir, 'wt-parked/node_modules/left-pad'), { recursive: true })
    writeFileSync(join(dir, 'wt-parked/node_modules/left-pad/i.js'), 'x')

    // same shape, but young , held back as recent
    g('checkout', '-qb', 'fresh')
    commit('c', 'three\n', 'fresh work')
    g('push', '-qu', 'origin', 'fresh')
    g('checkout', '-q', 'main')
    g('worktree', 'add', join(dir, 'wt-fresh'), 'fresh')

    // unmerged with no upstream: the only copy of its commits lives here
    g('checkout', '-qb', 'lonely')
    commit('d', 'four\n', 'unique work')
    g('checkout', '-q', 'main')
    g('worktree', 'add', join(dir, 'wt-lonely'), 'lonely')

    // upstream exists but a local commit is ahead of it
    g('checkout', '-qb', 'wip')
    commit('e', 'five\n', 'pushed part')
    g('push', '-qu', 'origin', 'wip')
    commit('f', 'six\n', 'unpushed part')
    g('checkout', '-q', 'main')
    g('worktree', 'add', join(dir, 'wt-wip'), 'wip')

    // dirty short-circuits everything else
    g('worktree', 'add', join(dir, 'wt-dirty'), '-b', 'dirt')
    writeFileSync(join(dir, 'wt-dirty/x'), 'scratch\n')

    // registered but its directory is gone
    g('worktree', 'add', join(dir, 'wt-gone'), '-b', 'gonebr')
    rmSync(join(dir, 'wt-gone'), { recursive: true, force: true })

    const { items, kept } = worktrees.collect({ repos: new Set<string>([dir]), days: 7, now: Date.now(), onProgress() {} })
    const byCat = (cat: string): typeof items => items.filter((i) => i.cat === cat)

    assert.deepEqual(byCat('worktree-prunable').map((i) => i.path), [join(dir, 'wt-gone')])
    assert.deepEqual(byCat('worktree-merged').map((i) => i.path), [join(dir, 'wt-done')], 'a merged worktree is offered')
    assert.deepEqual(byCat('node_modules').map((i) => i.path), [join(dir, 'wt-parked/node_modules')], 'only an idle worktree has its node_modules listed')
    assert.deepEqual(byCat('worktree-stale').map((i) => i.path), [join(dir, 'wt-parked')])
    assert.equal(byCat('worktree-stale')[0]!.safe, false, 'an unmerged worktree is never auto-selected')

    const why = (re: RegExp): { path: string; why: string } | undefined => kept!.find((k) => re.test(k.why))
    assert.match(why(/uncommitted changes/)!.path, /wt-dirty$/)
    assert.match(why(/no upstream/)!.path, /wt-lonely$/)
    assert.match(why(/unpushed commit\(s\)/)!.path, /wt-wip$/)
    assert.match(why(/recent \(\d+d\)/)!.path, /wt-fresh$/, 'same shape as stale, held back only by age')

    // both action kinds really run against the repo
    assert.equal(remove(byCat('worktree-prunable')[0]!), true, 'prune clears the dead registration')
    const done = byCat('worktree-merged')[0]!
    assert.equal(remove(done), true)
    assert.equal(existsSync(join(dir, 'wt-done')), false, 'worktree-remove really removes the tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
