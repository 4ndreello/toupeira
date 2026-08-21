import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeProjectDir, parseWorktrees, isContentMerged, human, remove, treeRows, banner } from './index.js'
import { summary } from './lib/ui.js'
import { elapsed } from './lib/format.js'
import { harnessCwds } from './lib/harnesses.js'
import { CATS, CLEANUPS } from './lib/cleanups/index.js'
import { dedupe, targets } from './lib/scan.js'
import * as transcripts from './lib/cleanups/transcripts.js'
import * as caches from './lib/cleanups/caches.js'
import * as browsers from './lib/cleanups/browsers.js'
import * as stores from './lib/cleanups/stores.js'
import * as toolchains from './lib/cleanups/toolchains.js'
import * as branches from './lib/cleanups/branches.js'
import { diskUsage, combinedSize } from './lib/sh.js'
import { report } from './lib/doctor.js'

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
      assert.equal(i.span, 'oldest 60d - newest 60d', 'the row carries the labelled age of the chats on offer')
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

test('agent caches offer only their idle entries, files and session directories alike', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const write = (rel, mtime) => {
      const f = join(home, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, 'x')
      if (mtime) utimesSync(f, mtime / 1000, mtime / 1000)
    }
    write('.claude/paste-cache/old.txt', old)
    write('.claude/paste-cache/fresh.txt')
    write('.claude/image-cache/deadbeef/1.png', old)
    utimesSync(join(home, '.claude/image-cache/deadbeef'), old / 1000, old / 1000)
    write('.claude/file-history/deadbeef/a.json', old)
    utimesSync(join(home, '.claude/file-history/deadbeef'), old / 1000, old / 1000)

    const { items } = caches.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [i.path.slice(home.length), i]))
    assert.deepEqual([...by.keys()].sort(), ['/.claude/file-history', '/.claude/image-cache', '/.claude/paste-cache'])

    const paste = by.get('/.claude/paste-cache')
    assert.deepEqual(paste.action.files, [join(home, '.claude/paste-cache/old.txt')], 'the fresh paste stays')
    assert.equal(paste.safe, true)
    assert.equal(paste.span, 'oldest 30d - newest 30d')
    // the whole session directory is one entry: the images inside it are not listed
    assert.deepEqual(by.get('/.claude/image-cache').action.files, [join(home, '.claude/image-cache/deadbeef')])
    assert.equal(by.get('/.claude/file-history').safe, false, 'undo history needs a look first')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a cache entry is removed by its list, and only from inside its own directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const dir = join(home, '.claude/image-cache')
    const session = join(dir, 'deadbeef')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, '1.png'), 'x')
    const item = { path: dir, action: { kind: 'rm-files', root: dir, files: [session] } }
    assert.equal(remove(item), true)
    assert.equal(existsSync(session), false, 'the session directory goes')
    assert.equal(existsSync(dir), true, 'the cache directory itself stays')

    item.action.files = [join(home, '.claude/settings.json')]
    assert.throws(() => remove(item), /refused, outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a chat list still refuses anything that is not a .jsonl', () => {
  const item = { path: '/tmp/proj', action: { kind: 'rm-files', root: '/home/me/.claude/projects', ext: '.jsonl', files: ['/home/me/.claude/projects/-x/notes.md'] } }
  assert.throws(() => remove(item), /refused, outside its category/)
})

test('the newer harnesses read their layouts out of one fake HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const live = mkdtempSync(join(tmpdir(), 'toupeira-live-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const write = (rel, body, mtime) => {
      const f = join(home, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, body)
      if (mtime) utimesSync(f, mtime / 1000, mtime / 1000)
    }
    write('.copilot/session-state/deadbeef/events.jsonl', `{"type":"session.start","data":{"context":{"cwd":"${live}"}}}\n`, old)
    write('.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/123/api_conversation_history.json', '[]', old)
    utimesSync(join(home, '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/123'), old / 1000, old / 1000)
    write('.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/456/ui_messages.json', '[]', old)
    utimesSync(join(home, '.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/456'), old / 1000, old / 1000)
    write('.local/share/opencode/log/log-2026-01-01.txt', 'x', old)
    write('.local/share/opencode/tool-output/tool_01abc', 'x', old)

    assert.equal(harnessCwds(home).has(live), true, 'the copilot event log carries the working directory')

    const { items } = caches.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [i.path.slice(home.length), i]))
    assert.deepEqual([...by.keys()].sort(), [
      '/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      '/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
      '/.local/share/opencode/log',
      '/.local/share/opencode/tool-output',
    ])
    assert.equal(by.get('/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks').safe, false, 'task history is chat content')
    assert.equal(by.get('/.local/share/opencode/tool-output').safe, true, 'spilled tool output is derived state')

    const chats = transcripts.collect({ days: 7, home, now: Date.now(), onProgress() {} }).items
    assert.equal(chats.length, 1)
    assert.equal(chats[0].repo, live, 'copilot chats group under the project like the other jsonl harnesses')
    assert.match(chats[0].note, /^copilot-cli:/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(live, { recursive: true, force: true })
  }
})

test('du measures directories on bsd as well as gnu', () => {
  // `du -sb` is gnu-only: on macos it exits with "illegal option" and every directory,
  // plus the whole headline, silently measured 0 B
  const home = mkdtempSync(join(tmpdir(), 'toupeira-du-'))
  try {
    const dir = join(home, 'cache')
    mkdirSync(dir)
    writeFileSync(join(dir, 'blob'), 'x'.repeat(200_000))
    assert.ok(diskUsage([dir]).get(dir) >= 200_000, 'a directory measures its contents')
    assert.ok(combinedSize([dir]) >= 200_000, 'the deduped headline is not zero')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// builds a repo with one branch of each kind the graveyard must tell apart
function graveyardRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-br-'))
  const old = new Date(Date.now() - 40 * 86400e3).toISOString()
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const gc = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    }).trim()
  const commit = (file, body, msg, args = ['commit', '-qm']) => {
    writeFileSync(join(dir, file), body)
    g('add', file)
    gc([...args, msg])
  }
  return { dir, g, gc, commit }
}

test('the graveyard offers merged branches whose remote side is gone, and only those', () => {
  const { dir, g, gc, commit } = graveyardRepo()
  try {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    commit('a', 'one\n', 'init')

    // squash-merged, pushed, then deleted on the remote
    g('checkout', '-qb', 'gone')
    commit('b', 'two\n', 'squash me')
    g('checkout', '-q', 'main')
    g('merge', '--squash', 'gone')
    g('commit', '-qm', 'squashed PR #1')
    g('remote', 'add', 'origin', join(dir, 'remote.git'))
    g('init', '--bare', '-q', join(dir, 'remote.git'))
    g('push', '-qu', 'origin', 'gone')
    g('update-ref', '-d', 'refs/remotes/origin/gone')

    // same content as `gone`, but never pushed anywhere
    g('branch', 'local-only', 'gone')

    // merged but fresh: the age filter holds it back
    g('branch', 'fresh', 'main')

    // old but unmerged: unique work still lives here
    g('checkout', '-qb', 'open', 'main~1')
    commit('c', 'other\n', 'unique work')
    g('checkout', '-q', 'main')

    // old and merged, but checked out in a worktree
    g('branch', 'old-wt', 'gone')
    g('worktree', 'add', join(dir, 'wt'), 'old-wt')

    const { items } = branches.collect({ repos: new Set([dir]), days: 7, now: Date.now(), onProgress() {} })
    const by = new Map(items.map((i) => [i.action.branch, i]))
    assert.deepEqual([...by.keys()].sort(), ['gone', 'local-only'], 'exactly the two absorbed branches surface')
    assert.equal(by.get('gone').safe, true, 'a deleted upstream is proven gone')
    assert.equal(by.get('local-only').safe, false, 'never-pushed history is a guess, not a proof')
    assert.match(by.get('gone').note, /merged into main/)
    assert.match(by.get('gone').note, /origin\/gone deleted/)
    for (const i of items) {
      assert.equal(i.path, dir, 'the item points at the repo, display only')
      assert.equal(i.action.kind, 'branch-delete')
    }

    remove(by.get('gone'))
    assert.equal(g('branch', '--list', 'gone'), '', 'remove() really deletes the branch')
    assert.match(g('branch', '--list', 'local-only'), /local-only/, 'what was not chosen stays')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('branch-delete refuses anything that is not a plain branch name', () => {
  for (const bad of ['HEAD', '-oProxyCommand=x', 'a..b', 'x.lock', 42]) {
    assert.throws(
      () => remove({ path: '/repo', action: { kind: 'branch-delete', repo: '/repo', branch: bad } }),
      /refused, unsafe branch name/
    )
  }
})

test('a branch item is not deduped away by tree items in its own repo', () => {
  const items = [
    { path: '/repo/node_modules', action: { kind: 'rm' } },
    { path: '/repo', action: { kind: 'branch-delete' } },
  ]
  assert.deepEqual(dedupe(items).map((i) => i.path), ['/repo/node_modules', '/repo'])
})

test('superseded playwright builds are offered, the newest of a family never is', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const build = (rel, mtime) => {
      const d = join(home, rel)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'marker'), 'x')
      if (mtime) utimesSync(d, mtime / 1000, mtime / 1000)
    }
    build('.cache/ms-playwright/chromium-100', old)
    build('.cache/ms-playwright/chromium_headless_shell-100', old)
    build('.cache/ms-playwright/chromium-101')
    build('.cache/ms-playwright/firefox-50', old)

    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 1)
    const item = items[0]
    assert.equal(item.cat, 'browser-cache')
    assert.equal(item.path, join(home, '.cache/ms-playwright'), 'the tool root is display only')
    assert.deepEqual(item.action.files, [
      join(home, '.cache/ms-playwright/chromium-100'),
      join(home, '.cache/ms-playwright/chromium_headless_shell-100'),
    ], 'the newest chromium and the lone firefox stay')
    assert.equal(item.safe, true)
    assert.match(item.span, /^oldest \d+d - newest \d+d$/)
    assert.match(item.note, /playwright/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('superseded puppeteer builds are offered per family, single-build families stay', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const old = Date.now() - 30 * 86400e3
    const build = (rel, mtime) => {
      const d = join(home, rel)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'marker'), 'x')
      if (mtime) utimesSync(d, mtime / 1000, mtime / 1000)
    }
    build('.cache/puppeteer/chrome/linux-120.0.0', old)
    build('.cache/puppeteer/chrome/linux-121.0.0')
    build('.cache/puppeteer/firefox/linux-130.0', old)

    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 1)
    assert.equal(items[0].path, join(home, '.cache/puppeteer'))
    assert.deepEqual(items[0].action.files, [join(home, '.cache/puppeteer/chrome/linux-120.0.0')])
    assert.equal(items[0].safe, true)
    assert.match(items[0].note, /puppeteer/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a HOME with no browser caches yields nothing and throws nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    assert.deepEqual(browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} }).items, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a superseded build with a fresh mtime is held back anyway', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const build = (rel) => {
      const d = join(home, rel)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'marker'), 'x')
    }
    build('.cache/ms-playwright/chromium-99')
    build('.cache/ms-playwright/chromium-100')

    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.deepEqual(items, [], 'supersession alone is not proof, the age gate holds it back')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a browser build is removed by its list, and only from inside the tool root', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const root = join(home, '.cache/ms-playwright')
    const build = join(root, 'chromium-100')
    mkdirSync(build, { recursive: true })
    writeFileSync(join(build, 'chrome'), 'x')
    const item = { cat: 'browser-cache', repo: null, path: root, size: 0, safe: true, action: { kind: 'rm-files', root, files: [build] } }
    assert.equal(remove(item), true)
    assert.equal(existsSync(build), false, 'the superseded build goes')
    assert.equal(existsSync(root), true, 'the tool root stays')

    item.action.files = [join(home, '.cache/other/chromium-99')]
    assert.throws(() => remove(item), /refused, outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('package stores offer their own official prune when the store exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    mkdirSync(join(home, '.npm/_cacache/content-v2'), { recursive: true })
    writeFileSync(join(home, '.npm/_cacache/content-v2/x'), 'x')
    mkdirSync(join(home, '.local/share/pnpm/store/v3/files/a/b'), { recursive: true })
    writeFileSync(join(home, '.local/share/pnpm/store/v3/files/a/b/blob'), 'x')

    const { items } = stores.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((i) => i.path.slice(home.length)), ['/.npm', '/.local/share/pnpm/store'])
    assert.deepEqual(items[0].action.cmd, ['npm', 'cache', 'verify'])
    assert.deepEqual(items[1].action.cmd, ['pnpm', 'store', 'prune'])
    for (const i of items) {
      assert.equal(i.cat, 'store-prune')
      assert.equal(i.safe, true, 'official maintenance commands are safe by definition')
      assert.equal(i.repo, null)
      assert.match(i.note, /upper bound/, 'the measured size is the whole store, not what goes')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a HOME with no package stores yields nothing and throws nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    assert.deepEqual(stores.collect({ days: 7, home, now: Date.now(), onProgress() {} }).items, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('command actions refuse anything but a plain basename argv', () => {
  for (const cmd of [undefined, 'rm -rf /', [], [42], ['./evil']]) {
    const action = { kind: 'command' }
    if (cmd !== undefined) action.cmd = cmd
    assert.throws(() => remove({ path: '/irrelevant', action }), /refused, malformed command/)
  }
})

test('a command action runs the exact argv and reports failure without throwing', () => {
  const ok = { path: '/irrelevant', action: { kind: 'command', cmd: ['node', '-e', 'process.exit(0)'] } }
  assert.equal(remove(ok), true)
  const dead = { path: '/irrelevant', action: { kind: 'command', cmd: ['node', '-e', 'process.exit(3)'] } }
  assert.equal(remove(dead), false)
})

test('pinsMatch covers equality and segment-boundary prefixes only', () => {
  assert.equal(toolchains.pinsMatch('20', '20.11.0'), true)
  assert.equal(toolchains.pinsMatch('20.11.0', '20.11.0'), true)
  assert.equal(toolchains.pinsMatch('v18', '18.19.0'), true, 'the v tag is noise')
  assert.equal(toolchains.pinsMatch('20.1', '20.11.0'), false, '20.1 is not a prefix of 20.11')
  assert.equal(toolchains.pinsMatch('21', '20.11.0'), false)
})

test('idle toolchains are the unpinned, unprotected, non-newest installs', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
    for (const v of ['v16.20.0', 'v18.19.0', 'v20.11.0', 'v22.5.0']) {
      mkdirSync(join(home, '.nvm/versions/node', v), { recursive: true })
    }
    mkdirSync(join(home, '.nvm/alias'), { recursive: true })
    writeFileSync(join(home, '.nvm/alias/default'), 'v20.11.0\n')
    writeFileSync(join(repo, '.nvmrc'), '18.19.0\n')

    const { items } = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} })
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), ['v16.20.0'], 'pinned, default and newest all stay')
    assert.equal(items[0].safe, false, 'repos no agent touched are invisible, so nothing is provably safe')
    assert.match(items[0].note, /no pin among 1 repo\(s\)/)
    assert.equal(items[0].action.kind, 'rm')

    remove(items[0])
    assert.equal(existsSync(join(home, '.nvm/versions/node/v16.20.0')), false, 'remove() really deletes it')

    const outside = { path: '/usr', action: { kind: 'rm', guard: `${home}/.nvm/versions/node/` } }
    assert.throws(() => remove(outside), /outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})
test('pyenv versions respect their global file and .python-version pins', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
    for (const v of ['3.10.0', '3.11.2', '3.12.1']) mkdirSync(join(home, '.pyenv/versions', v), { recursive: true })
    writeFileSync(join(home, '.pyenv/version'), '3.11.2\n')

    let items = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} }).items
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), ['3.10.0'], 'global and newest stay, the rest goes')

    writeFileSync(join(repo, '.python-version'), '3.10.0\n')
    items = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} }).items
    assert.deepEqual(items, [], 'a pin holds its version back')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('.tool-versions protects through its nodejs key', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
    for (const v of ['v18.19.0', 'v22.5.0']) mkdirSync(join(home, '.nvm/versions/node', v), { recursive: true })
    writeFileSync(join(repo, '.tool-versions'), 'nodejs 18.19.0\npython 3.12.1\n')
    const { items } = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} }).items
      ? toolchains.collect({ repos: new Set([repo]), home, onProgress() {} })
      : {}
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), [], 'v18 pinned, v22 newest — nothing to offer')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a HOME with no version managers yields nothing and throws nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    assert.deepEqual(toolchains.collect({ repos: new Set(), home, onProgress() {} }).items, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor measures the well-known spots that exist, biggest first', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-doctor-'))
  try {
    mkdirSync(join(home, '.gradle/caches'), { recursive: true })
    writeFileSync(join(home, '.gradle/caches/blob'), 'x'.repeat(300_000))
    mkdirSync(join(home, '.cache/pip'), { recursive: true })
    writeFileSync(join(home, '.cache/pip/wheel'), 'x'.repeat(1000))

    const { rows } = report({ home, runDocker: () => null })
    assert.deepEqual(rows.map((r) => r.name), ['gradle caches', 'pip cache'], 'missing spots contribute nothing')
    assert.deepEqual(rows.map((r) => r.path), [join(home, '.gradle/caches'), join(home, '.cache/pip')])
    assert.ok(rows[0].size >= 300_000)
    assert.ok(rows[1].size > 0)
    assert.ok(rows[0].size > rows[1].size, 'sorted by size, biggest first')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an empty HOME yields no doctor rows and no docker, without throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    assert.deepEqual(report({ home, runDocker: () => null }), { rows: [], docker: null })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('docker output passes through verbatim, and a failing probe reports null instead of throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    const canned = 'Type            Images\nImages          5'
    assert.equal(report({ home, runDocker: () => canned }).docker, canned)
    assert.equal(
      report({ home, runDocker: () => { throw new Error('no docker') } }).docker,
      null
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
