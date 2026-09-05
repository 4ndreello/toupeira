import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remove } from '../index.js'
import { dedupe, targets } from '../lib/scan.js'
import * as branches from '../lib/cleanups/branches.js'
import type { Item } from '../types.js'
import { gitIn, gitAt, actionBranch, sorted } from './helpers.js'

// builds a repo with one branch of each kind the graveyard must tell apart
function graveyardRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-br-'))
  const old = new Date(Date.now() - 40 * 86400e3).toISOString()
  const g = gitIn(dir)
  const gc = gitAt(dir, old)
  const commit = (file: string, body: string, msg: string, args: string[] = ['commit', '-qm']): void => {
    writeFileSync(join(dir, file), body)
    g('add', file)
    gc([...args, msg])
  }
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  commit('a', 'one\n', 'init')
  return { dir, g, commit }
}

test('the graveyard offers merged branches whose remote side is gone, and only those', () => {
  const { dir, g, commit } = graveyardRepo()
  try {
    // squash-merged, pushed, then deleted on the remote
    g('checkout', '-qb', 'gone')
    commit('b', 'two\n', 'squash me')
    g('checkout', '-q', 'main')
    g('merge', '--squash', 'gone')
    g('commit', '-qm', 'squashed PR #1')
    g('remote', 'add', 'origin', join(dir, 'remote.git'))
    g('init', '--bare', '-q', join(dir, 'remote.git'))
    g('push', '-qu', 'origin', 'gone')
    g('update-ref', '-d', 'refs/remotes/origin/gone')

    // same content as `gone`, but never pushed anywhere
    g('branch', 'local-only', 'gone')

    // merged but fresh: the age filter holds it back
    g('branch', 'fresh', 'main')

    // old but unmerged: unique work still lives here
    g('checkout', '-qb', 'open', 'main~1')
    commit('c', 'other\n', 'unique work')
    g('checkout', '-q', 'main')

    // old and merged, but checked out in a worktree
    g('branch', 'old-wt', 'gone')
    g('worktree', 'add', join(dir, 'wt'), 'old-wt')

    const { items } = branches.collect({ repos: new Set<string>([dir]), days: 7, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [actionBranch(i), i]))
    assert.deepEqual(sorted(by.keys()), ['gone'], 'only the branch whose remote side is gone surfaces')
    assert.equal(by.get('gone')!.safe, true, 'a deleted upstream is proven gone')
    assert.match(by.get('gone')!.note, /merged into main/)
    assert.match(by.get('gone')!.note, /origin\/gone deleted/)
    for (const i of items) {
      assert.equal(i.path, dir, 'the item points at the repo, display only')
      assert.equal(i.label, `${dir}#${actionBranch(i)}`, 'the label names the ref that goes')
      assert.deepEqual(targets(i), [], 'a ref frees nothing on disk, so nothing is measured')
      assert.equal(i.action.kind, 'branch-delete')
    }

    remove(by.get('gone')!)
    assert.equal(g('branch', '--list', 'gone'), '', 'remove() really deletes the branch')
    assert.match(g('branch', '--list', 'local-only'), /local-only/, 'a never-pushed branch stays, absorbed or not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// the upstream reading comes from the same for-each-ref fork as the listing:
// gone (even slashed or never-fetched) surfaces, synced, local and tag
// upstreams stay. a local upstream used to fail open via refs/remotes/./name.
test('the graveyard reads gone state from the listing, three forks lighter', () => {
  const { dir, g, commit } = graveyardRepo()
  try {
    g('init', '--bare', '-q', join(dir, 'remote.git'))
    g('remote', 'add', 'origin', join(dir, 'remote.git'))

    // pushed and still there: track is empty, stays
    g('checkout', '-qb', 'synced')
    commit('s', 's\n', 'synced work')
    g('push', '-qu', 'origin', 'synced')

    // slashed name, merged, remote side deleted: gone
    g('branch', 'feat/vanished', 'main')
    g('push', '-qu', 'origin', 'feat/vanished')
    g('update-ref', '-d', 'refs/remotes/origin/feat/vanished')

    // tracking config hand-pointed at a ref that never existed: same evidence
    // as a deletion under both readings, still offered
    g('branch', 'ghost', 'main')
    g('config', 'branch.ghost.remote', 'origin')
    g('config', 'branch.ghost.merge', 'refs/heads/ghost')

    // a local upstream always resolves: not gone, stays
    g('branch', 'loc', 'main')
    g('config', 'branch.loc.remote', '.')
    g('config', 'branch.loc.merge', 'refs/heads/main')

    // a tag is not a branch remote side: stays
    g('tag', 'v1', 'main')
    g('branch', 'tagged', 'main')
    g('config', 'branch.tagged.remote', 'origin')
    g('config', 'branch.tagged.merge', 'refs/tags/v1')

    g('checkout', '-q', 'main')

    const { items } = branches.collect({ repos: new Set<string>([dir]), days: 7, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [actionBranch(i), i]))
    assert.deepEqual(sorted(by.keys()), ['feat/vanished', 'ghost'], 'only gone remote sides surface')
    assert.match(by.get('feat/vanished')!.note, /origin\/feat\/vanished deleted/, 'the note names the whole upstream short')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// defaultBranch answers `origin/main`, which never equals a local branch name , without
// stripping the remote the default branch itself becomes a candidate. a fork whose local
// main tracks a second remote that dropped it is exactly the case that reaches here.
test('the default branch is never offered, whatever its tracking config says', () => {
  const { dir, g } = graveyardRepo()
  try {
    g('init', '--bare', '-q', join(dir, 'remote.git'))
    g('remote', 'add', 'origin', join(dir, 'remote.git'))
    g('push', '-qu', 'origin', 'main')
    g('remote', 'set-head', 'origin', 'main')
    // main now tracks a remote that no longer carries it, while origin/HEAD still names it
    g('remote', 'add', 'fork', join(dir, 'fork.git'))
    g('config', 'branch.main.remote', 'fork')
    g('checkout', '-qb', 'work')

    assert.equal(g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main', 'setup: the base is remote-qualified')
    const { items } = branches.collect({ repos: new Set<string>([dir]), days: 7, now: Date.now(), onProgress() {} })
    assert.deepEqual(items.map((i) => actionBranch(i)), [], 'main is the default branch, not a graveyard candidate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('branch-delete refuses anything that is not a plain branch name', () => {
  for (const bad of ['HEAD', '-oProxyCommand=x', 'a..b', 'x.lock', 42] as unknown[]) {
    assert.throws(
      () => remove({ cat: 't', repo: null, path: '/repo', size: 0, safe: true, note: 't', action: { kind: 'branch-delete', repo: '/repo', branch: bad as unknown as string } } as unknown as Item),
      /refused, unsafe branch name/
    )
  }
})

test('a branch item is not deduped away by tree items in its own repo', () => {
  const items = [
    { path: '/repo/node_modules', action: { kind: 'rm' } },
    { path: '/repo', action: { kind: 'branch-delete' } },
  ]
  assert.deepEqual(dedupe(items).map((i) => i.path), ['/repo/node_modules', '/repo'])
})
