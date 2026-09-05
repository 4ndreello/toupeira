import { execFileSync } from 'node:child_process'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Item } from '../types.js'

// node's default sort already compares as strings, which is what every list here holds -
// the comparison is spelled out so it reads as a choice rather than an omission
export const sorted = (it: Iterable<string>): string[] => [...it].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

// every fake-HOME test plants files the same way: make the parent, write it, then say how
// old it is. one helper, so the next test does not copy the trio again
export const writeAt = (home: string, rel: string, body: string, mtime?: number): void => {
  const f = join(home, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, body)
  if (mtime !== undefined) utimesSync(f, mtime / 1000, mtime / 1000)
}

// collection tests look their items up by the path the row shows, minus the fake HOME
export const byHomePath = (items: Item[], home: string): Map<string, Item> =>
  new Map(items.map((i) => [i.path.slice(home.length), i]))

// every git-behavior test drives the real binary into its own temp dir: one runner, so no
// test copies the execFileSync scaffolding again
export const gitIn = (dir: string) => (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// the same runner under a fixed clock, for tests that care when a commit was made
export const gitAt = (dir: string, iso: string) => (args: string[]): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  }).trim()

// an empty repo on main with an identity, which is where every repo-behavior test begins
export const initRepo = (dir: string): ((...args: string[]) => string) => {
  const g = gitIn(dir)
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  return g
}

// the action union has one shape per kind; tests that probe a known kind's fields go
// through this one seam instead of casting inline at every read
export const actionFiles = (i: Item): string[] => (i.action as { files: string[] }).files
export const actionBranch = (i: Item): string => (i.action as { branch: string }).branch
export const actionCmd = (i: Item): string[] => (i.action as { cmd: string[] }).cmd

// a guard test needs the same item with a different file list: one place does the lying,
// the item was never produced by a real cleanup
export const withFiles = (item: Item, files: string[]): Item =>
  ({ ...item, action: { ...item.action, files } }) as unknown as Item
