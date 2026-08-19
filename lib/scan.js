import { existsSync } from 'node:fs'
import { HOME } from './format.js'
import { diskUsage } from './sh.js'
import { mainRepoOf } from './repo.js'
import { harnessCwds } from './harnesses.js'
import { CLEANUPS } from './cleanups/index.js'
import { ACTIONS } from './actions.js'

// an item that deletes a whole directory already covers anything found beneath it:
// removing a worktree takes its node_modules along, so only the worktree is listed
export function dedupe(items) {
  const trees = items.filter((i) => ACTIONS[i.action.kind]?.tree)
  return items.filter((i) => !trees.some((o) => o !== i && i.path.startsWith(`${o.path}/`)))
}

export function scan({ days = 7, roots = [], home = HOME, onProgress = () => {} } = {}) {
  onProgress('reading agent sessions')
  const repos = new Set()
  for (const p of [...harnessCwds(home), ...roots]) {
    const r = mainRepoOf(p)
    if (r) repos.add(r)
  }

  const ctx = { repos, days, home, now: Date.now(), onProgress }
  const items = []
  const kept = []
  for (const cleanup of CLEANUPS) {
    const out = cleanup.collect(ctx)
    items.push(...out.items)
    if (out.kept) kept.push(...out.kept)
  }

  const sizes = diskUsage(items.filter((i) => existsSync(i.path)).map((i) => i.path), onProgress)
  for (const i of items) i.size = sizes.get(i.path) ?? 0

  const final = dedupe(items)
  final.sort((a, b) => b.size - a.size)
  return { items: final, kept, repos: repos.size }
}
