import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME } from './format.js'
import { git } from './sh.js'

export const LOG = join(process.env.XDG_STATE_HOME || join(HOME, '.local/state'), 'toupeira/operations.log')

export function remove(item) {
  const { action, path } = item
  if (action.kind === 'prune') return git(['worktree', 'prune'], action.repo) !== null
  if (action.kind === 'worktree-remove') return git(['worktree', 'remove', path], action.repo) !== null
  if (action.kind === 'rm') {
    if (!path.includes(action.guard)) throw new Error(`refused, outside its category: ${path}`)
    rmSync(path, { recursive: true, force: true })
    return true
  }
  return false
}

export function log(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging never blocks the cleanup */
  }
}
