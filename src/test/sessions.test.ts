import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeProjectDir, remove } from '../index.js'
import { harnessCwds } from '../lib/harnesses.js'
import * as caches from '../lib/cleanups/caches.js'
import * as transcripts from '../lib/cleanups/transcripts.js'
import * as orphans from '../lib/cleanups/orphans.js'
import { writeAt, byHomePath, sorted } from './helpers.js'

test('decodeProjectDir resolves dashes in real directory names', () => {
  const real = new Set(['/home', '/home/me', '/home/me/dev', '/home/me/dev/toupeira'])
  const exists = (p: string): boolean => real.has(p)
  assert.deepEqual(decodeProjectDir('-home-me-dev-toupeira', exists), { path: '/home/me/dev/toupeira', exists: true, matched: 4 })
})

test('decodeProjectDir reports a vanished path instead of guessing', () => {
  const exists = (p: string): boolean => p === '/tmp'
  const r = decodeProjectDir('-tmp-agent-box-9DSMZ6', exists)
  assert.equal(r.exists, false)
  assert.equal(r.path, '/tmp/agent-box-9DSMZ6')
})

test('a name that encodes no real path at all is not a vanished project', () => {
  // cursor keeps scratch state under names like `empty-window`: never a project that went away
  assert.equal(decodeProjectDir('empty-window', () => false).matched, 0)
})

test('every harness reads its own cwd format out of one fake HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const write = (rel: string, body: string): void => writeAt(home, rel, body)
    write('.claude/projects/-tmp-claudeproj/session.jsonl', '{"cwd":"/tmp/claudeproj","x":1}\n')
    write('.codex/sessions/2026/02/26/rollout-x.jsonl', '{"payload":{"cwd":"/tmp/codexproj"}}\n')
    write('.gemini/tmp/backend/.project_root', '/tmp/geminiproj\n')
    mkdirSync(join(home, '.cursor/projects/tmp-cursorproj'), { recursive: true })
    write('.local/share/crush/projects.json', JSON.stringify({ projects: [{ path: '/tmp/crushproj' }] }))

    const cwds = harnessCwds(home)
    for (const p of ['/tmp/claudeproj', '/tmp/codexproj', '/tmp/geminiproj', '/tmp/cursorproj', '/tmp/crushproj']) {
      assert.equal(cwds.has(p), true, `missing ${p}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a HOME with no agent state yields nothing and throws nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    assert.equal(harnessCwds(home).size, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the newer harnesses read their layouts out of one fake HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const live = mkdtempSync(join(tmpdir(), 'toupeira-live-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const write = (rel: string, body: string, mtime?: number): void => writeAt(home, rel, body, mtime)
    write('.copilot/session-state/deadbeef/events.jsonl', `{"type":"session.start","data":{"context":{"cwd":"${live}"}}}\n`, old)
    write('.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/123/api_conversation_history.json', '[]', old)
    utimesSync(join(home, '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/123'), old / 1000, old / 1000)
    write('.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/456/ui_messages.json', '[]', old)
    utimesSync(join(home, '.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/456'), old / 1000, old / 1000)
    write('.local/share/opencode/log/log-2026-01-01.txt', 'x', old)
    write('.local/share/opencode/tool-output/tool_01abc', 'x', old)

    assert.equal(harnessCwds(home).has(live), true, 'the copilot event log carries the working directory')

    const { items } = caches.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    const by = byHomePath(items, home)
    assert.deepEqual(sorted(by.keys()), [
      '/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      '/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
      '/.local/share/opencode/log',
      '/.local/share/opencode/tool-output',
    ])
    assert.equal(by.get('/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks')!.safe, false, 'task history is chat content')
    assert.equal(by.get('/.local/share/opencode/tool-output')!.safe, true, 'spilled tool output is derived state')

    const chats = transcripts.collect({ days: 7, home, now: Date.now(), onProgress() {} }).items
    assert.equal(chats.length, 1)
    assert.equal(chats[0]!.repo, live, 'copilot chats group under the project like the other jsonl harnesses')
    assert.match(chats[0]!.note, /^copilot-cli:/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(live, { recursive: true, force: true })
  }
})

test('orphan sessions are offered only when the project they encode is really gone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const live = mkdtempSync(join(tmpdir(), 'toupeira-live-'))
  try {
    // the transcript is authoritative: its cwd names a path that no longer exists
    writeAt(home, '.claude/projects/-tmp-toupeira-vanished/s.jsonl', '{"cwd":"/tmp/toupeira-nowhere"}\n')
    // cursor has no transcripts: the lossy dashed name is all there is
    mkdirSync(join(home, '.cursor/projects', `-${live.slice(1).replace(/\//g, '-')}`), { recursive: true })
    // a scratch name that never encoded a path must never look like a vanished project
    mkdirSync(join(home, '.cursor/projects/empty-window'), { recursive: true })

    const { items } = orphans.collect({ home, onProgress() {} })
    assert.equal(items.length, 1, 'exactly the vanished project surfaces')
    assert.match(items[0]!.note, /\/tmp\/toupeira-nowhere is gone/)
    assert.equal(items[0]!.safe, true)
    assert.equal(items[0]!.action.kind, 'rm')

    assert.equal(await remove(items[0]!), true)
    assert.equal(existsSync(join(home, '.claude/projects/-tmp-toupeira-vanished')), false, 'remove() really deletes it')
    assert.equal(existsSync(live), true, 'the live project was never a candidate')
    assert.equal(existsSync(join(home, '.cursor/projects/empty-window')), true, 'scratch state stays')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(live, { recursive: true, force: true })
  }
})

type ReadCall = { length: number; buffer: unknown }

async function withReadSyncSpy(run: (calls: ReadCall[]) => void): Promise<void> {
  const { createRequire, syncBuiltinESMExports } = await import('node:module')
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  const original = fs.readSync
  const calls: ReadCall[] = []
  const wrapped = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    calls.push({ length, buffer })
    return original(fd, buffer, offset, length, position)
  }) as typeof fs.readSync
  Reflect.set(fs, 'readSync', wrapped)
  syncBuiltinESMExports()
  try {
    run(calls)
  } finally {
    Reflect.set(fs, 'readSync', original)
    syncBuiltinESMExports()
  }
}

test('headMatch reads only 4 KB to find a match in the first chunk (R15)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-head-'))
  try {
    writeAt(home, 'header.jsonl', '{"cwd":"/tmp/early"}\n')
    writeAt(home, 'long.jsonl', `{"cwd":"/tmp/early-long"}\n${'x'.repeat(5000)}`)
    const { CWD_RE, headMatch } = await import('../lib/sessions.js')
    await withReadSyncSpy((calls) => {
      assert.equal(headMatch(join(home, 'header.jsonl'), CWD_RE), '/tmp/early')
      assert.equal(headMatch(join(home, 'long.jsonl'), CWD_RE), '/tmp/early-long')
      assert.deepEqual(calls.map((call) => call.length), [4 * 1024, 4 * 1024])
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('headMatch continues past 4 KB to find a padded header (R16)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-head-'))
  const bytes = 256 * 1024
  try {
    writeAt(home, 'header.jsonl', `${' '.repeat(5000)}{"cwd":"/tmp/late-header"}\n`)
    writeAt(home, 'edge.jsonl', `${' '.repeat(4080)}{"cwd":"/tmp/edge"}\n`)
    const { CWD_RE, headMatch } = await import('../lib/sessions.js')
    await withReadSyncSpy((calls) => {
      assert.equal(headMatch(join(home, 'header.jsonl'), CWD_RE), '/tmp/late-header')
      assert.equal(headMatch(join(home, 'edge.jsonl'), CWD_RE), '/tmp/edge')
      assert.deepEqual(calls.map((call) => call.length), [4 * 1024, bytes - 4 * 1024, 4 * 1024, bytes - 4 * 1024])
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('headMatch does not match a cwd beyond the byte limit (R17)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-head-'))
  const bytes = 8 * 1024
  try {
    writeAt(home, 'header.jsonl', `${' '.repeat(bytes)}{"cwd":"/tmp/beyond-limit"}\n`)
    writeAt(home, 'short.jsonl', '{"other":"no cwd"}\n')
    const { CWD_RE, headMatch } = await import('../lib/sessions.js')
    await withReadSyncSpy((calls) => {
      assert.equal(headMatch(join(home, 'header.jsonl'), CWD_RE, bytes), null)
      assert.equal(headMatch(join(home, 'short.jsonl'), CWD_RE, bytes), null)
      assert.deepEqual(calls.map((call) => call.length), [4 * 1024, bytes - 4 * 1024, 4 * 1024])
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('headMatch reuses its scratch buffer and grows only past its size (R18)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-head-'))
  const bytes = 256 * 1024
  try {
    writeAt(home, 'header.jsonl', '{"cwd":"/tmp/reused"}\n')
    const { CWD_RE, headMatch } = await import('../lib/sessions.js')
    await withReadSyncSpy((calls) => {
      const file = join(home, 'header.jsonl')
      assert.equal(headMatch(file, CWD_RE), '/tmp/reused')
      assert.equal(headMatch(file, CWD_RE), '/tmp/reused')
      assert.equal(headMatch(file, CWD_RE, bytes + 1), '/tmp/reused')
      assert.strictEqual(calls[0]!.buffer, calls[1]!.buffer)
      assert.equal((calls[0]!.buffer as Buffer).byteLength, bytes)
      assert.notStrictEqual(calls[0]!.buffer, calls[2]!.buffer)
      assert.equal((calls[2]!.buffer as Buffer).byteLength, bytes + 1)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
