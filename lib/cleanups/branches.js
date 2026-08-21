import { DAY, short } from '../format.js'
import { git } from '../sh.js'
import { defaultBranch, isContentMerged, parseWorktrees } from '../repo.js'

export const cats = {
  'branch-gone': 'local branches fully absorbed elsewhere',
}

// the graveyard: a branch whose patch is already upstream (squash included) and whose
// remote side is gone has nothing left to protect. checked-out, unmerged, young or
// still-published branches never reach here.
export function collect({ repos, days, now, onProgress }) {
  const items = []
  let n = 0

  for (const repo of repos) {
    onProgress(`branches ${++n}/${repos.size} ${short(repo)}`)
    const base = defaultBranch(repo)
    if (!base) continue
    const current = git(['symbolic-ref', '--short', 'HEAD'], repo)
    // a branch checked out in any worktree cannot go: deleting it breaks that worktree
    const busy = new Set(parseWorktrees(git(['worktree', 'list', '--porcelain'], repo) || '').map((w) => w.branch))
    const list = git(['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)'], repo)
    if (!list) continue

    for (const line of list.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      const branch = line.slice(0, tab)
      const ts = Number(line.slice(tab + 1)) * 1000
      if (!branch || !ts || branch === base || branch === current || busy.has(branch)) continue
      const age = Math.floor((now - ts) / DAY)
      if (age < days) continue

      // @{upstream} dies when the tracking ref is gone, so read the config instead:
      // it remembers an upstream that was deleted on the remote, which is exactly the
      // evidence this cleanup needs
      const remote = git(['config', '--get', `branch.${branch}.remote`], repo)
      const merge = git(['config', '--get', `branch.${branch}.merge`], repo)
      let provenGone = false
      if (remote && merge) {
        if (!merge.startsWith('refs/heads/')) continue // unknown shape, keep it
        const name = merge.slice('refs/heads/'.length)
        if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], repo)) continue
        provenGone = true // configured once, deleted since
      }
      if (!isContentMerged(repo, branch, base)) continue

      items.push({
        cat: 'branch-gone',
        repo,
        // display and dedupe only: nothing on disk is removed, the target is a ref
        path: repo,
        size: 0,
        safe: provenGone,
        note: `${branch} (${age}d) — merged into ${base}, ${provenGone ? `${remote}/${merge.slice('refs/heads/'.length)} deleted` : 'never pushed'}`,
        action: { kind: 'branch-delete', repo, branch },
      })
    }
  }

  return { items }
}
