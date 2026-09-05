import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as transcripts from '../lib/cleanups/transcripts.js'
import { writeAt, actionFiles } from './helpers.js'

test('old chats are grouped per project, and a live project is never the target', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const live = mkdtempSync(join(tmpdir(), 'toupeira-live-'))
  try {
    const old = Date.now() - 60 * 86400e3
    const write = (rel: string, cwd: string, mtime?: number): void => writeAt(home, rel, `{"cwd":"${cwd}","pad":"${'x'.repeat(100)}"}\n`, mtime)
    write('.claude/projects/-proj/old.jsonl', live, old)
    write('.claude/projects/-proj/fresh.jsonl', live)
    write('.claude/projects/-gone/old.jsonl', '/tmp/toupeira-does-not-exist', old)
    write('.codex/sessions/2026/02/26/rollout.jsonl', live, old)

    const { items } = transcripts.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 2, 'one item per (harness, project), nothing for the vanished one')
    for (const i of items) {
      assert.equal(i.path, live, 'the item points at the project, for display only')
      assert.equal(i.safe, false, 'a deleted chat does not come back')
      assert.deepEqual(
        actionFiles(i).map((f) => f.endsWith('old.jsonl') || f.endsWith('rollout.jsonl')),
        actionFiles(i).map(() => true),
        'only the aged files are listed',
      )
    }
    assert.deepEqual(items.map((i) => actionFiles(i).length), [1, 1])
    for (const i of items) {
      assert.equal(i.span, 'oldest 60d - newest 60d', 'the row carries the labelled age of the chats on offer')
      assert.match(i.note, /1 chat\(s\), 60-60d old/, 'the note carries the count and the age')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(live, { recursive: true, force: true })
  }
})
