import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME } from './format.js'

export const LOG = join(process.env.XDG_STATE_HOME || join(HOME, '.local/state'), 'toupeira/operations.log')

export function log(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging never blocks the cleanup */
  }
}
