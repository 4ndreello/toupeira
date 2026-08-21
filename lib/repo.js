import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { git } from './sh.js'

export function parseWorktrees(porcelain) {
  return porcelain
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const o = {}
      for (const line of block.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp === -1) o[line] = true
        else o[line.slice(0, sp)] = line.slice(sp + 1)
      }
      return {
        path: o.worktree,
        head: o.HEAD,
        branch: typeof o.branch === 'string' ? o.branch.replace('refs/heads/', '') : null,
        bare: !!o.bare,
        detached: !!o.detached,
        prunable: !!o.prunable,
      }
    })
    .filter((w) => w.path)
}

export function mainRepoOf(path) {
  if (!existsSync(path)) return null
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)
  if (!common) return null
  return common.endsWith('/.git') ? common.slice(0, -5) : dirname(common)
}

export function defaultBranch(repo) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)
  if (head) return head
  for (const b of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', b], repo)) return b
  }
  return null
}

// `git branch --merged <base>` is per-repo work, so a caller looping over every branch
// reads it once and passes the set in — otherwise it forks a full history walk per branch
export function mergedBranches(repo, base) {
  const out = git(['branch', '--merged', base], repo)
  if (out === null) return new Set()
  return new Set(out.split('\n').map((l) => l.replace(/^[*+]?\s*/, '')).filter(Boolean))
}

// `git branch --merged` misses squash merges — the squashed commit has a different hash.
// replay the branch tree as a single commit on the merge base and ask git if that patch is already upstream.
// ponytail: writes one loose commit object per check, gc collects it
export function isContentMerged(repo, branch, base, merged = null) {
  if (!base || !branch) return false
  if ((merged ?? mergedBranches(repo, base)).has(branch)) return true
  const mergeBase = git(['merge-base', base, branch], repo)
  const tree = git(['rev-parse', `${branch}^{tree}`], repo)
  if (!mergeBase || !tree) return false
  if (tree === git(['rev-parse', `${mergeBase}^{tree}`], repo)) return true // branch changed nothing
  const probe = git(['commit-tree', tree, '-p', mergeBase, '-m', 'toupeira-probe'], repo)
  if (!probe) return false
  return (git(['cherry', base, probe], repo) || '').startsWith('-')
}

export function unpushed(repo, branch) {
  const upstream = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], repo)
  if (!upstream) return null // no upstream: can't tell, treat as unknown
  const n = git(['rev-list', '--count', `${upstream}..${branch}`], repo)
  return Number(n || 0)
}
