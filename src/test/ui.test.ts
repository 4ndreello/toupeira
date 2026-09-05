import { test } from 'node:test'
import assert from 'node:assert/strict'
import { human, treeRows, banner } from '../index.js'
import { summary } from '../lib/ui.js'
import { elapsed } from '../lib/format.js'

test('human', () => {
  assert.equal(human(0), '0 B')
  assert.equal(human(1536), '1.5 KB')
  assert.equal(human(4.2 * 1024 ** 3), '4.2 GB')
})

test('elapsed', () => {
  assert.equal(elapsed(12.4), '12 ms')
  assert.equal(elapsed(1500), '1.5 s')
})

test('treeRows orders categories by total size and only expands what is open', () => {
  const items = [
    { cat: 'small', size: 10 },
    { cat: 'big', size: 4 },
    { cat: 'big', size: 5 },
  ]
  const collapsed = treeRows(items, new Set<string>())
  assert.deepEqual(collapsed.map((r) => r.cat), ['small', 'big'])
  assert.equal(collapsed.every((r) => r.type === 'cat'), true)

  const open = treeRows(items, new Set<string>(['big']))
  assert.deepEqual(open.map((r) => `${r.type}:${r.cat}`), ['cat:small', 'cat:big', 'item:big', 'item:big'])
  assert.deepEqual(open.filter((r): r is { type: 'item'; cat: string; idx: number } => r.type === 'item').map((r) => r.idx), [1, 2])
})

test('banner degrades to the bare name when the terminal is too narrow', () => {
  assert.deepEqual(banner(40), ['toupeira'])
})

test('banner ground line is exactly as wide as the widest row', () => {
  const rows = banner(120)
  const ground = rows.at(-1)!
  assert.equal(Math.max(...rows.map((r) => r.length)), ground.length)
  assert.equal(ground!.startsWith('~~""((('), true)
})

test('banner treats a terminal reporting zero columns as unknown, not tiny', () => {
  assert.notDeepEqual(banner(0), ['toupeira'])
})

test('summary prints one line per category, biggest first, no per-item rows', () => {
  const items = [
    { cat: 'node_modules', size: 300 },
    { cat: 'worktree-merged', size: 100 },
    { cat: 'worktree-merged', size: 100 },
  ]
  const lines: string[] = []
  const real = console.log
  console.log = (s: unknown): void => { lines.push(String(s).replace(/\x1b\[[0-9;]*m/g, '')); }
  try {
    summary({ items, kept: [{ path: '/d', why: 'dirty' }], repos: 2, total: 500 })
  } finally {
    console.log = real
  }
  const out = lines.join('\n')
  assert.match(out, /2 repo\(s\) · 3 item\(s\)/)
  assert.match(out, /1 held back/)
  assert.ok(!out.includes('/a'), 'paths belong to the picker, not the summary')
  assert.ok(out.indexOf('node_modules inside a worktree') < out.indexOf('merged worktrees'), 'biggest category first')
})
