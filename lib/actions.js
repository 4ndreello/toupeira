import { rmSync } from 'node:fs'
import { git } from './sh.js'

// Adding an action is one entry here.
//
//   tree  this action deletes the whole directory, so any item found beneath it
//         is already covered and gets deduped away by scan()
//   run   performs the removal, returns whether it happened

export const ACTIONS = {
  prune: { tree: false, run: ({ action }) => git(['worktree', 'prune'], action.repo) !== null },
  'worktree-remove': { tree: true, run: ({ action, path }) => git(['worktree', 'remove', path], action.repo) !== null },
  // deletes a listed set of entries, not item.path — see the guard in remove()
  'rm-files': {
    tree: false,
    run: ({ action }) => {
      for (const f of action.files) rmSync(f, { recursive: true, force: true })
      return true
    },
  },
  rm: {
    tree: true,
    run: ({ path }) => {
      rmSync(path, { recursive: true, force: true })
      return true
    },
  },
}

export function remove(item) {
  const action = ACTIONS[item.action.kind]
  if (!action) return false
  // checked out here, not inside the table, so a new action cannot forget it
  if (item.action.guard && !item.path.includes(item.action.guard)) {
    throw new Error(`refused, outside its category: ${item.path}`)
  }
  // a file list is guarded per entry: item.path is a live project or a cache
  // directory, never the target. `ext` narrows it further where the category has one
  for (const f of item.action.files || []) {
    if (!f.startsWith(`${item.action.root}/`) || (item.action.ext && !f.endsWith(item.action.ext))) {
      throw new Error(`refused, outside its category: ${f}`)
    }
  }
  return action.run(item)
}
