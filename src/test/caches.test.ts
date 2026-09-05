import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as caches from '../lib/cleanups/caches.js'
import { writeAt, byHomePath, actionFiles, sorted } from './helpers.js'

test('agent caches offer only their idle entries, files and session directories alike', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const write = (rel: string, mtime?: number): void => writeAt(home, rel, 'x', mtime)
    write('.claude/paste-cache/old.txt', old)
    write('.claude/paste-cache/fresh.txt')
    write('.claude/image-cache/deadbeef/1.png', old)
    utimesSync(join(home, '.claude/image-cache/deadbeef'), old / 1000, old / 1000)
    write('.claude/file-history/deadbeef/a.json', old)
    utimesSync(join(home, '.claude/file-history/deadbeef'), old / 1000, old / 1000)

    const { items } = caches.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    const by = byHomePath(items, home)
    assert.deepEqual(sorted(by.keys()), ['/.claude/file-history', '/.claude/image-cache', '/.claude/paste-cache'])

    const paste = by.get('/.claude/paste-cache')!
    assert.deepEqual(actionFiles(paste), [join(home, '.claude/paste-cache/old.txt')], 'the fresh paste stays')
    assert.equal(paste!.safe, true)
    assert.equal(paste!.span, 'oldest 30d - newest 30d')
    // the whole session directory is one entry: the images inside it are not listed
    assert.deepEqual(actionFiles(by.get('/.claude/image-cache')!), [join(home, '.claude/image-cache/deadbeef')])
    assert.equal(by.get('/.claude/file-history')!.safe, false, 'undo history needs a look first')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('t3 code logs thin by entry age under their nested cache root', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const fresh = Date.now() - 86400e3
    const old = Date.now() - 30 * 86400e3
    const touch = (rel: string, body: string, mtime: number): void => {
      const f = join(home, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, body)
      utimesSync(f, mtime / 1000, mtime / 1000)
    }
    touch('.t3/userdata/logs/server.trace.ndjson.5', 'x'.repeat(100), old)
    touch('.t3/userdata/logs/server.log', 'x', fresh)
    touch('.t3/caches/status.json', '{}', old)

    const { items } = caches.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [i.path.slice(home.length), i]))
    assert.equal(by.size, 2)
    assert.equal(by.has('/.t3/caches'), true)
    assert.equal(by.has('/.t3/userdata/logs'), true)
    assert.equal(by.get('/.t3/caches')!.safe, true)
    const logs = by.get('/.t3/userdata/logs')!
    assert.deepEqual(actionFiles(logs), [join(home, '.t3/userdata/logs/server.trace.ndjson.5')], 'the rotated trace goes, the active log stays')
    assert.equal(logs.safe, true, 'server logs are derived state')
    assert.match(logs.note, /^t3-code:/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
