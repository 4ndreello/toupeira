import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remove } from '../index.js'
import { targets } from '../lib/scan.js'
import type { Item } from '../types.js'
import { withFiles } from './helpers.js'

// malformed fixtures by design: the action is a loose record, the cast is the point
const item = (action: Record<string, unknown>, over: Partial<Item> = {}): Item =>
  ({ cat: 't', repo: null, path: '/a', size: 0, safe: true, note: 't', action, ...over }) as unknown as Item

test('remove refuses a path outside the category it belongs to', () => {
  assert.throws(
    () => remove(item({ kind: 'rm', guard: '/.claude/projects/' })),
    /outside its category/
  )
})

test('targets is the file list when an action carries one, the path otherwise', () => {
  assert.deepEqual(targets(item({ kind: 'rm', guard: '/a/' })), ['/a'])
  assert.deepEqual(targets(item({ kind: 'rm-files', root: '/a', files: ['/a/x.jsonl'] })), ['/a/x.jsonl'])
  // an action whose target is not a path measures nothing: `path` is a repo or a whole
  // package store, and counting it would inflate the reclaimable headline by all of it
  for (const kind of ['branch-delete', 'command']) {
    assert.deepEqual(targets(item({ kind })), [], `${kind} frees no path`)
  }
})

test('remove refuses a files action that reaches outside its harness directory', () => {
  const base = item({ kind: 'rm-files', root: '/home/me/.claude/projects', files: ['/home/me/dev/repo/src/index.js'] })
  assert.throws(() => remove(base), /refused, outside its category/)
  assert.throws(() => remove(withFiles(base, ['/home/me/.claude/projects/-x/a.jsonl', '/etc/passwd'])), /refused, outside its category/)
})

test('a chat list still refuses anything that is not a .jsonl', () => {
  const i = item({ kind: 'rm-files', root: '/home/me/.claude/projects', ext: '.jsonl', files: ['/home/me/.claude/projects/-x/notes.md'] })
  assert.throws(() => remove(i), /refused, outside its category/)
})

test('a cache entry is removed by its list, and only from inside its own directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const dir = join(home, '.claude/image-cache')
    const session = join(dir, 'deadbeef')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, '1.png'), 'x')
    const i = item({ kind: 'rm-files', root: dir, files: [session] })
    assert.equal(remove(i), true)
    assert.equal(existsSync(session), false, 'the session directory goes')
    assert.equal(existsSync(dir), true, 'the cache directory itself stays')

    assert.throws(() => remove(withFiles(i, [join(home, '.claude/settings.json')])), /refused, outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})


test('command actions refuse anything but a plain basename argv', () => {
  for (const cmd of [undefined, 'rm -rf /', [], [42], ['./evil']] as unknown[]) {
    const action: Record<string, unknown> = { kind: 'command' }
    if (cmd !== undefined) action['cmd'] = cmd
    assert.throws(() => remove(item(action)), /refused, malformed command/)
  }
})

test('a command action runs the exact argv and reports failure without throwing', () => {
  const ok = item({ kind: 'command', cmd: ['node', '-e', 'process.exit(0)'] })
  assert.equal(remove(ok), true)
  const dead = item({ kind: 'command', cmd: ['node', '-e', 'process.exit(3)'] })
  assert.equal(remove(dead), false)
})
