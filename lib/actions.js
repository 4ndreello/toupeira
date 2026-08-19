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
  return action.run(item)
}
