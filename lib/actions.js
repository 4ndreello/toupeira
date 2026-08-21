import { execFileSync } from 'node:child_process'
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
  // the target is a ref, not a path, so remove() vets it by name instead
  'branch-delete': { tree: false, run: ({ action }) => git(['branch', '-D', action.branch], action.repo) !== null },
  // runs one exact argv list, never through a shell — the cleanup tables are the only
  // place commands are written down
  command: {
    tree: false,
    run: ({ action }) => {
      try {
        execFileSync(action.cmd[0], action.cmd.slice(1), { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
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
  // `git branch -D` would happily eat HEAD, option-looking names, range tricks or a
  // lock file, and the path guard above cannot see the ref name — vet it here
  if (item.action.kind === 'branch-delete') {
    const b = item.action.branch
    const ok =
      typeof b === 'string' &&
      /^[A-Za-z0-9._/-]+$/.test(b) &&
      !b.startsWith('-') &&
      !b.includes('..') &&
      !b.endsWith('.lock') &&
      b !== 'HEAD'
    if (!ok) throw new Error(`refused, unsafe branch name: ${b}`)
  }
  // a command runs by basename through PATH, never a path, and no argument may
  // smuggle a null byte past the exec — the argv comes from a cleanup table,
  // but remove() trusts nothing it has not vetted itself
  if (item.action.kind === 'command') {
    const c = item.action.cmd
    const ok =
      Array.isArray(c) &&
      c.length > 0 &&
      c.every((a) => typeof a === 'string' && a && !a.includes('\0')) &&
      !c[0].includes('/')
    if (!ok) throw new Error('refused, malformed command')
  }
  return action.run(item)
}
