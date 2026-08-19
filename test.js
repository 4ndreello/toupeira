import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeProjectDir, parseWorktrees, isContentMerged, human, remove, treeRows, banner } from './index.js'
import { summary } from './lib/ui.js'
import { elapsed } from './lib/format.js'
import { harnessCwds } from './lib/harnesses.js'
import { CATS, CLEANUPS } from './lib/cleanups/index.js'
import { dedupe, targets } from './lib/scan.js'
import * as transcripts from './lib/cleanups/transcripts.js'

test('decodeProjectDir resolves dashes in real directory names', () => {
  const real = new Set(['/home', '/home/me', '/home/me/dev', '/home/me/dev/toupeira'])
  const exists = (p) => real.has(p)
  assert.deepEqual(decodeProjectDir('-home-me-dev-toupeira', exists), { path: '/home/me/dev/toupeira', exists: true, matched: 4 })
})

test('decodeProjectDir reports a vanished path instead of guessing', () => {
  const exists = (p) => p === '/tmp'
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
    const write = (rel, body) => {
      mkdirSync(join(home, dirname(rel)), { recursive: true })
      writeFileSync(join(home, rel), body)
    }
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

test('every category a cleanup produces has a label, and none collide', () => {
  const declared = CLEANUPS.flatMap((c) => Object.keys(c.cats))
  for (const cat of declared) assert.equal(typeof CATS[cat], 'string', `${cat} has no label`)
  assert.equal(Object.keys(CATS).length, declared.length, 'two cleanups claim the same category')
})

test('an item inside a tree-removing item is dropped, but not under a prune', () => {
  const items = [
    { path: '/wt', action: { kind: 'worktree-remove' } },
    { path: '/wt/node_modules', action: { kind: 'rm' } },
    { path: '/other/node_modules', action: { kind: 'rm' } },
    { path: '/gone', action: { kind: 'prune' } },
    { path: '/gone/node_modules', action: { kind: 'rm' } },
  ]
  assert.deepEqual(
    dedupe(items).map((i) => i.path),
    ['/wt', '/other/node_modules', '/gone', '/gone/node_modules']
  )
})

test('parseWorktrees keeps paths with spaces and flags prunable', () => {
  const wt = parseWorktrees(
    'worktree /home/me/my repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/gone\nHEAD def456\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n'
  )
  assert.equal(wt.length, 2)
  assert.equal(wt[0].path, '/home/me/my repo')
  assert.equal(wt[0].branch, 'main')
  assert.equal(wt[1].branch, 'feat/x')
  assert.equal(wt[1].prunable, true)
  assert.equal(wt[0].prunable, false)
})

test('isContentMerged catches a squash merge that git branch --merged misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')

    g('checkout', '-qb', 'squashed')
    writeFileSync(join(dir, 'b'), 'two\n')
    g('add', '.')
    g('commit', '-qm', 'work part 1')
    writeFileSync(join(dir, 'b'), 'two\nthree\n')
    g('commit', '-qam', 'work part 2')

    g('checkout', '-qb', 'open', 'main')
    writeFileSync(join(dir, 'c'), 'other\n')
    g('add', '.')
    g('commit', '-qm', 'unrelated open work')

    g('checkout', '-q', 'main')
    g('merge', '--squash', 'squashed')
    g('commit', '-qm', 'squashed PR #1')

    assert.equal(g('branch', '--merged', 'main').includes('squashed'), false, 'setup: git itself must not see the squash')
    assert.equal(isContentMerged(dir, 'squashed', 'main'), true)
    assert.equal(isContentMerged(dir, 'open', 'main'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('human', () => {
  assert.equal(human(0), '0 B')
  assert.equal(human(1536), '1.5 KB')
  assert.equal(human(4.2 * 1024 ** 3), '4.2 GB')
})

test('remove refuses a path outside the category it belongs to', () => {
  assert.throws(
    () => remove({ path: '/home/me/importante', action: { kind: 'rm', guard: '/.claude/projects/' } }),
    /outside its category/
  )
})

test('treeRows orders categories by total size and only expands what is open', () => {
  const items = [
    { cat: 'small', size: 10 },
    { cat: 'big', size: 4 },
    { cat: 'big', size: 5 },
  ]
  const collapsed = treeRows(items, new Set())
  assert.deepEqual(collapsed.map((r) => r.cat), ['small', 'big'])
  assert.equal(collapsed.every((r) => r.type === 'cat'), true)

  const open = treeRows(items, new Set(['big']))
  assert.deepEqual(open.map((r) => `${r.type}:${r.cat}`), ['cat:small', 'cat:big', 'item:big', 'item:big'])
  assert.deepEqual(open.filter((r) => r.type === 'item').map((r) => r.idx), [1, 2])
})

test('banner degrades to the bare name when the terminal is too narrow', () => {
  assert.deepEqual(banner(40), ['toupeira'])
})

test('banner ground line is exactly as wide as the widest row', () => {
  const rows = banner(120)
  const ground = rows.at(-1)
  assert.equal(Math.max(...rows.map((r) => r.length)), ground.length)
  assert.equal(ground.startsWith('~~""((('), true)
})

test('banner treats a terminal reporting zero columns as unknown, not tiny', () => {
  assert.notDeepEqual(banner(0), ['toupeira'])
})

test('the CLI runs when invoked through a symlink, the way npm installs its bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-bin-'))
  try {
    const link = join(dir, 'toupeira')
    symlinkSync(new URL('./index.js', import.meta.url).pathname, link)
    const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.match(out, /clean up what coding agents leave behind/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('elapsed', () => {
  assert.equal(elapsed(12.4), '12 ms')
  assert.equal(elapsed(1500), '1.5 s')
})

test('summary prints one line per category, biggest first, no per-item rows', () => {
  const items = [
    { cat: 'node_modules', size: 300, path: '/a' },
    { cat: 'worktree-merged', size: 100, path: '/b' },
    { cat: 'worktree-merged', size: 100, path: '/c' },
  ]
  const lines = []
  const real = console.log
  console.log = (s) => lines.push(String(s).replace(/\x1b\[[0-9;]*m/g, ''))
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

test('old chats are grouped per project, and a live project is never the target', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const live = mkdtempSync(join(tmpdir(), 'toupeira-live-'))
  try {
    const old = Date.now() - 60 * 86400e3
    const write = (rel, cwd, mtime) => {
      const f = join(home, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, `{"cwd":"${cwd}","pad":"${'x'.repeat(100)}"}\n`)
      if (mtime) utimesSync(f, mtime / 1000, mtime / 1000)
    }
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
        i.action.files.map((f) => f.endsWith('old.jsonl') || f.endsWith('rollout.jsonl')),
        i.action.files.map(() => true),
        'only the aged files are listed',
      )
    }
    assert.deepEqual(items.map((i) => i.action.files.length), [1, 1])
    for (const i of items) {
      assert.match(i.span, /^\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}$/, 'the row carries the first and last chat date')
      assert.match(i.note, /1 chat\(s\), 60-60d old/, 'the note carries the count and the age')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(live, { recursive: true, force: true })
  }
})

test('remove refuses a files action that reaches outside its harness directory', () => {
  const item = { path: '/home/me/dev/repo', action: { kind: 'rm-files', root: '/home/me/.claude/projects', files: ['/home/me/dev/repo/src/index.js'] } }
  assert.throws(() => remove(item), /refused, outside its category/)
  item.action.files = ['/home/me/.claude/projects/-x/a.jsonl', '/etc/passwd']
  assert.throws(() => remove(item), /refused, outside its category/)
})

test('targets is the file list when an action carries one, the path otherwise', () => {
  assert.deepEqual(targets({ path: '/a', action: { kind: 'rm' } }), ['/a'])
  assert.deepEqual(targets({ path: '/a', action: { kind: 'rm-files', files: ['/a/x.jsonl'] } }), ['/a/x.jsonl'])
})
