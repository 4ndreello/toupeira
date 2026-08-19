import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DAY, HOME, short } from './format.js'
import { diskUsage, git } from './sh.js'
import { agentCwds, decodeProjectDir, headMatch, walkFiles } from './sessions.js'
import { defaultBranch, isContentMerged, mainRepoOf, parseWorktrees, unpushed } from './repo.js'

export function scan({ days = 7, roots = [], onProgress = () => {} } = {}) {
  onProgress('reading agent sessions')
  const repos = new Set()
  for (const p of [...agentCwds(), ...roots]) {
    const r = mainRepoOf(p)
    if (r) repos.add(r)
  }

  const items = []
  const kept = []
  const now = Date.now()

  let n = 0
  for (const repo of repos) {
    onProgress(`worktrees ${++n}/${repos.size} ${short(repo)}`)
    const list = git(['worktree', 'list', '--porcelain'], repo)
    if (!list) continue
    const base = defaultBranch(repo)
    const worktrees = parseWorktrees(list)

    for (const w of worktrees) {
      if (w.path === repo || w.bare) continue // never touch the main checkout

      if (w.prunable || !existsSync(w.path)) {
        items.push({ cat: 'worktree-prunable', repo, path: w.path, size: 0, safe: true, note: 'registered here, but the directory is gone', action: { kind: 'prune', repo } })
        continue
      }

      const dirty = (git(['status', '--porcelain'], w.path) || '').length > 0
      const ts = Number(git(['log', '-1', '--format=%ct'], w.path) || 0) * 1000
      const age = ts ? Math.floor((now - ts) / DAY) : 0
      const ahead = w.branch ? unpushed(repo, w.branch) : null
      const merged = w.branch ? isContentMerged(repo, w.branch, base) : false
      const nm = join(w.path, 'node_modules')
      const label = `${w.branch || w.head?.slice(0, 7)} (${age}d)`

      if (existsSync(nm) && age >= days) {
        items.push({ cat: 'node_modules', repo, path: nm, size: 0, safe: true, note: `${label} — reinstallable`, action: { kind: 'rm', guard: '/node_modules' } })
      }

      if (dirty) {
        kept.push({ path: w.path, why: 'uncommitted changes' })
        continue
      }
      if (merged) {
        items.push({ cat: 'worktree-merged', repo, path: w.path, size: 0, safe: true, note: `${label} — already in ${base}`, action: { kind: 'worktree-remove', repo } })
      } else if (ahead === null) {
        kept.push({ path: w.path, why: 'no upstream, these commits exist nowhere else' })
      } else if (ahead > 0) {
        kept.push({ path: w.path, why: `${ahead} unpushed commit(s)` })
      } else if (age >= days) {
        items.push({ cat: 'worktree-stale', repo, path: w.path, size: 0, safe: false, note: `${label} — pushed, not merged`, action: { kind: 'worktree-remove', repo } })
      } else {
        kept.push({ path: w.path, why: `recent (${age}d)` })
      }
    }
  }

  onProgress('orphan sessions')
  const projects = join(HOME, '.claude/projects')
  if (existsSync(projects)) {
    for (const name of readdirSync(projects)) {
      const dir = join(projects, name)
      if (!statSync(dir).isDirectory()) continue
      const cwd = walkFiles(dir, 2, '.jsonl').map((f) => headMatch(f, /"cwd":"([^"]+)"/)).find(Boolean)
      const target = cwd || decodeProjectDir(name).path
      if (existsSync(target)) continue
      items.push({ cat: 'session-orphan', repo: null, path: dir, size: 0, safe: true, note: `${target} is gone`, action: { kind: 'rm', guard: '/.claude/projects/' } })
    }
  }

  const sizes = diskUsage(items.filter((i) => i.size === 0 && existsSync(i.path)).map((i) => i.path), onProgress)
  for (const i of items) i.size = sizes.get(i.path) ?? 0

  // dedupe worktrees that also had a node_modules entry: removing the worktree takes it along
  const removed = new Set(items.filter((i) => i.cat.startsWith('worktree-') && i.action.kind === 'worktree-remove').map((i) => i.path))
  const final = items.filter((i) => !(i.cat === 'node_modules' && removed.has(dirname(i.path))))

  final.sort((a, b) => b.size - a.size)
  return { items: final, kept, repos: repos.size }
}
