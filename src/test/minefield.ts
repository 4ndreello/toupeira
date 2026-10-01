import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ageRefs, gitAt } from './helpers.js'

const DAY = 86400e3

export interface Mine {
  repo: string
  branch: string
  why: string
}

export interface Minefield {
  repos: string[]
  keep: Mine[]
  go: Mine[]
}

// every branch a cleaner could be tempted by, laid out once. keep is the contract: no
// scan may ever offer one of these, whatever the branch rules become. go is what a scan
// should offer, so the test can tell "safe" from "does nothing".
export function buildMinefield(root: string, now: number = Date.now()): Minefield {
  const repo = join(root, 'minefield')
  const remote = join(root, 'remote.git')
  const old = new Date(now - 40 * DAY).toISOString()
  mkdirSync(repo, { recursive: true })
  const at = (cwd: string) => (...args: string[]): string => gitAt(cwd, old)(args)
  const g = at(repo)
  const commit = (file: string, msg: string): void => {
    writeFileSync(join(repo, file), `${msg}\n`)
    g('add', file)
    g('commit', '-qm', msg)
  }
  const keep: Mine[] = []
  const go: Mine[] = []
  const mine = (list: Mine[], branch: string, why: string): void => {
    list.push({ repo, branch, why })
  }

  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  g('init', '--bare', '-q', remote)
  g('remote', 'add', 'origin', remote)
  commit('base', 'init')
  commit('base2', 'second')

  // ---- keep: each one holds something that exists nowhere else, or is in use

  g('checkout', '-qb', 'unique-local')
  commit('unique-local', 'only copy of this work')
  mine(keep, 'unique-local', 'no upstream, commits exist nowhere else')

  g('checkout', '-qb', 'unique-pushed', 'main')
  commit('unique-pushed', 'pushed, open pr')
  g('push', '-qu', 'origin', 'unique-pushed')
  mine(keep, 'unique-pushed', 'pushed but not merged, an open pr')

  g('checkout', '-qb', 'unique-gone', 'main')
  commit('unique-gone', 'remote deleted, never merged')
  g('push', '-qu', 'origin', 'unique-gone')
  g('push', '-q', 'origin', '--delete', 'unique-gone')
  mine(keep, 'unique-gone', 'remote side deleted, but the work was never merged')

  g('checkout', '-qb', 'tag-twin', 'main')
  commit('tag-twin', 'unmerged, shadowed by a tag')
  g('push', '-qu', 'origin', 'tag-twin')
  g('push', '-q', 'origin', '--delete', 'tag-twin')
  mine(keep, 'tag-twin', 'a same-named tag on main must not make it look merged')

  g('checkout', '-qb', 'work-after-squash', 'main')
  commit('was-squashed', 'squashed into main')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'work-after-squash')
  g('commit', '-qm', 'squash work-after-squash')
  g('checkout', '-q', 'work-after-squash')
  commit('after-squash', 'kept working after the squash')
  mine(keep, 'work-after-squash', 'squash-merged, then got more commits')

  g('checkout', '-qb', 'half-picked', 'main')
  commit('picked', 'cherry-picked into main')
  const picked = g('rev-parse', 'HEAD')
  commit('not-picked', 'left behind')
  g('checkout', '-q', 'main')
  g('cherry-pick', picked)
  mine(keep, 'half-picked', 'one of two commits reached main')

  g('checkout', '-qb', 'develop', 'main')
  commit('develop', 'integration branch')
  g('push', '-qu', 'origin', 'develop')
  g('branch', 'in-develop-only', 'develop~0')
  mine(keep, 'develop', 'a long-lived branch, pushed, not in main')
  mine(keep, 'in-develop-only', 'merged into develop, not into the default branch')

  // ---- go: content already in main, nothing unique left behind

  g('checkout', '-qb', 'merged-local', 'main')
  commit('merged-local', 'merged, never pushed')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--no-ff', '-m', 'merge merged-local', 'merged-local')
  mine(go, 'merged-local', 'merged into main, never pushed')

  g('checkout', '-qb', 'squashed-local', 'main')
  commit('squashed-local', 'squashed, never pushed')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'squashed-local')
  g('commit', '-qm', 'squash squashed-local')
  mine(go, 'squashed-local', 'squash-merged into main, never pushed')

  g('checkout', '-qb', 'merged-pushed', 'main')
  commit('merged-pushed', 'merged, remote kept')
  g('push', '-qu', 'origin', 'merged-pushed')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--no-ff', '-m', 'merge merged-pushed', 'merged-pushed')
  mine(go, 'merged-pushed', 'merged into main, remote branch still there')

  g('checkout', '-qb', 'merged-gone', 'main')
  commit('merged-gone', 'merged, remote deleted')
  g('push', '-qu', 'origin', 'merged-gone')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'merged-gone')
  g('commit', '-qm', 'squash merged-gone')
  g('push', '-q', 'origin', '--delete', 'merged-gone')
  mine(go, 'merged-gone', 'squash-merged, remote deleted')

  g('branch', 'empty-old', 'main~3')
  mine(go, 'empty-old', 'never got a commit, created long ago')

  // ---- keep, built last because they need the final main

  g('push', '-qu', 'origin', 'main')
  g('remote', 'set-head', 'origin', 'main')
  g('fetch', '-q', '--prune', 'origin')
  g('tag', 'tag-twin', 'main')

  g('branch', 'checked-out', 'main~1')
  g('worktree', 'add', '-q', join(root, 'wt-checked-out'), 'checked-out')
  mine(keep, 'checked-out', 'merged, but checked out in a worktree')

  // a worktree mid-rebase lists as detached, so the branch looks free. git refuses the
  // delete, but the cleaner should not offer what git will refuse
  g('branch', 'rebasing', 'main~1')
  const wt = join(root, 'wt-rebasing')
  g('worktree', 'add', '-q', wt, 'rebasing')
  try {
    at(wt)('rebase', '-f', '--exec', 'exit 1', 'HEAD~1')
  } catch {
    // stopping is the point: the rebase stays in progress
  }
  mine(keep, 'rebasing', 'merged, but a rebase of it is in progress')

  // the tip is an old commit, so its committer date says 40 days. the branch itself was
  // created a moment ago: someone is about to start work on it
  g('branch', 'fresh-empty', 'main')
  mine(keep, 'fresh-empty', 'created just now, the old tip date lies about its age')

  // main is not checked out, so nothing but the default-branch rule protects it
  g('checkout', '-qb', 'elsewhere')
  mine(keep, 'main', 'the default branch')
  mine(keep, 'elsewhere', 'checked out in the main checkout')

  // every ref moved 40 days ago except fresh-empty, which is the point of it
  ageRefs(repo, now - 40 * DAY, ['fresh-empty'])

  // no origin head and no main or master: the default branch is unknown, so nothing is
  // merged into it, and a branch that looks absorbed elsewhere stays
  const orphan = join(root, 'no-default')
  mkdirSync(orphan)
  const o = at(orphan)
  o('init', '-q', '-b', 'trunk')
  o('config', 'user.email', 't@t')
  o('config', 'user.name', 't')
  writeFileSync(join(orphan, 'a'), 'a\n')
  o('add', 'a')
  o('commit', '-qm', 'init')
  o('branch', 'absorbed')
  keep.push({ repo: orphan, branch: 'absorbed', why: 'no default branch to be merged into' })
  keep.push({ repo: orphan, branch: 'trunk', why: 'checked out, and the only line of history' })

  return { repos: [repo, orphan], keep, go }
}

// node dist/test/minefield.js lays the field out on disk to poke at by hand. it always
// builds in a fresh temp dir it made itself, never in a path it was handed, so it cannot
// write into a directory that already holds something
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'toupeira-minefield-')))
  const field = buildMinefield(root)
  const roots = field.repos.map((r) => `--root ${r}`).join(' ')
  console.log(`keep:\n${field.keep.map((m) => `  ${m.branch}  ${m.why}`).join('\n')}`)
  console.log(`go:\n${field.go.map((m) => `  ${m.branch}  ${m.why}`).join('\n')}`)
  // XDG_STATE_HOME wins over HOME for the operations log, so both point into the field
  console.log(`\nHOME=${root} XDG_STATE_HOME=${root}/.local/state node dist/index.js scan ${roots}`)
}
