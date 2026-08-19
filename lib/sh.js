import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 }).trim()
  } catch {
    return null
  }
}

function du(args) {
  try {
    return execFileSync('du', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 })
  } catch (e) {
    return e.stdout || '' // du exits non-zero on unreadable entries but still reports the rest
  }
}

// one du per path, on purpose: a single batched call counts a hardlinked file only for
// whichever path reaches it first, so pnpm/bun worktrees report near-zero at random.
// ponytail: apparent size — bytes shared with a package store outside the set won't actually free
export function diskUsage(paths, onProgress = () => {}) {
  const sizes = new Map()
  let n = 0
  for (const p of paths) {
    onProgress(`measuring ${++n}/${paths.length}`)
    const m = du(['-sb', '--', p]).match(/^(\d+)\t/)
    sizes.set(p, m ? Number(m[1]) : 0)
  }
  return sizes
}

// combined total, deduped: what the disk actually gets back if all of these go
export function combinedSize(paths) {
  const live = paths.filter((p) => existsSync(p))
  if (!live.length) return 0
  let total = 0
  for (let i = 0; i < live.length; i += 200) {
    const out = du(['-scb', '--', ...live.slice(i, i + 200)])
    const m = out.match(/^(\d+)\ttotal$/m)
    total += m ? Number(m[1]) : 0
  }
  return total
}
