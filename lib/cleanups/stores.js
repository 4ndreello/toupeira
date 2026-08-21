import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const cats = {
  'store-prune': 'package stores, thinned by their own tool',
}

// each tool: where its store sits, and the official maintenance command that
// decides itself what is junk. the command is the judge, so there is no age gate.
const TOOLS = [
  { name: 'npm', dir: (home) => join(home, '.npm'), cmd: ['npm', 'cache', 'verify'], why: 'cache verify trims its content store' },
  {
    name: 'pnpm',
    dir: (home) => join(home, process.platform === 'darwin' ? 'Library/pnpm/store' : '.local/share/pnpm/store'),
    cmd: ['pnpm', 'store', 'prune'],
    why: 'store prune drops unreferenced packages',
  },
]

// days/now go unused on purpose: the tool's own command is the judge of what is
// junk, so there is no age gate — a store that exists is offered, whatever its mtime.
export function collect({ home, onProgress }) {
  const items = []
  onProgress('package stores')

  // ponytail: custom locations (`npm config get cache`, `pnpm store path`) are missed
  // by these defaults; upgrade path is asking the tool where its store is
  for (const t of TOOLS) {
    const dir = t.dir(home)
    if (!existsSync(dir)) continue
    items.push({
      cat: 'store-prune',
      repo: null,
      // the store directory, for display and the size sort only: an upper bound of
      // what the prune frees, never deleted directly
      path: dir,
      size: 0,
      safe: true,
      note: `${t.name}: ${t.why} (the size above is an upper bound)`,
      action: { kind: 'command', cmd: t.cmd },
    })
  }

  return { items }
}
