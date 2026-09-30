import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { remove } from '../index.js'
import { ACTIONS, removeAll, runCommand } from '../lib/actions.js'
import { targets } from '../lib/scan.js'
import type { Item } from '../types.js'
import { withFiles } from './helpers.js'

// malformed fixtures by design: the action is a loose record, the cast is the point
const item = (action: Record<string, unknown>, over: Partial<Item> = {}): Item =>
  ({ cat: 't', repo: null, path: '/a', size: 0, safe: true, note: 't', action, ...over }) as unknown as Item

test('remove refuses a path outside the category it belongs to', async () => {
  await assert.rejects(
    remove(item({ kind: 'rm', guard: '/.claude/projects/' })),
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

test('remove refuses a files action that reaches outside its harness directory', async () => {
  const base = item({ kind: 'rm-files', root: '/home/me/.claude/projects', files: ['/home/me/dev/repo/src/index.js'] })
  await assert.rejects(remove(base), /refused, outside its category/)
  await assert.rejects(remove(withFiles(base, ['/home/me/.claude/projects/-x/a.jsonl', '/etc/passwd'])), /refused, outside its category/)
})

test('a chat list still refuses anything that is not a .jsonl', async () => {
  const i = item({ kind: 'rm-files', root: '/home/me/.claude/projects', ext: '.jsonl', files: ['/home/me/.claude/projects/-x/notes.md'] })
  await assert.rejects(remove(i), /refused, outside its category/)
})

test('a cache entry is removed by its list, and only from inside its own directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  try {
    const dir = join(home, '.claude/image-cache')
    const session = join(dir, 'deadbeef')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, '1.png'), 'x')
    const i = item({ kind: 'rm-files', root: dir, files: [session] })
    assert.equal(await remove(i), true)
    assert.equal(existsSync(session), false, 'the session directory goes')
    assert.equal(existsSync(dir), true, 'the cache directory itself stays')

    await assert.rejects(remove(withFiles(i, [join(home, '.claude/settings.json')])), /refused, outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})


test('command actions refuse anything but a plain basename argv', async () => {
  for (const cmd of [undefined, 'rm -rf /', [], [42], ['./evil']] as unknown[]) {
    const action: Record<string, unknown> = { kind: 'command' }
    if (cmd !== undefined) action['cmd'] = cmd
    await assert.rejects(remove(item(action)), /refused, malformed command/)
  }
})

test('a command action runs the exact argv and reports failure without throwing', async () => {
  const ok = item({ kind: 'command', cmd: ['node', '-e', 'process.exit(process.argv[1] === "literal; argument" ? 0 : 1)', 'literal; argument'] })
  assert.equal(await remove(ok), true)
  const eof = item({ kind: 'command', cmd: ['node', '-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); setTimeout(() => process.exit(1), 1000)'] })
  assert.equal(await remove(eof), true, 'the child receives EOF on stdin')
  const dead = item({ kind: 'command', cmd: ['node', '-e', 'process.exit(3)'] })
  assert.equal(await remove(dead), false)
  assert.equal(await runCommand(['node', '-e', 'setInterval(() => {}, 1000)'], 100), false, 'a timed out command fails')
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('rm and rm-files items run concurrently', async () => {
  const max = availableParallelism()
  const items = Array.from({ length: max * 2 }, (_, index) => {
    const path = `/tmp/item-${index}`
    return index % 2
      ? item({ kind: 'rm-files', root: '/tmp', files: [path] }, { path })
      : item({ kind: 'rm', guard: '/tmp/' }, { path })
  })
  const results: string[] = []
  let active = 0
  let peak = 0
  const removeFile = async (): Promise<void> => {
    active++
    peak = Math.max(peak, active)
    await delay(20)
    active--
  }

  await removeAll(items, ({ item: done }) => results.push(done.path), (candidate) => ACTIONS[candidate.action.kind]!.run(candidate, removeFile))

  if (max > 1) assert.ok(peak > 1, `peak concurrent items was ${peak}`)
  else assert.equal(peak, 1)
  assert.ok(peak <= max, `shared limiter allowed ${peak} concurrent filesystem calls with a cap of ${max}`)
  assert.deepEqual(results.sort(), items.map((i) => i.path).sort())
})

test('git actions serialize by repo while distinct repos overlap', async () => {
  const first = item({ kind: 'branch-delete', repo: '/repo-a', branch: 'first' })
  const second = item({ kind: 'worktree-remove', repo: '/repo-a' }, { path: '/repo-a/worktree' })
  const third = item({ kind: 'prune', repo: '/repo-a' })
  const fourth = item({ kind: 'branch-delete', repo: '/repo-a', branch: 'fourth' })
  const other = item({ kind: 'branch-delete', repo: '/repo-b', branch: 'other' })
  const events: string[] = []
  const active = new Map<string, number>()
  let distinctReposOverlapped = false

  await removeAll([first, second, third, fourth, other], () => {}, async ({ action }) => {
    if (action.kind !== 'branch-delete' && action.kind !== 'worktree-remove' && action.kind !== 'prune') return false
    const repo = action.repo
    const name = action.kind === 'branch-delete' ? action.branch : action.kind
    if ([...active.keys()].some((activeRepo) => activeRepo !== repo)) distinctReposOverlapped = true
    active.set(repo, (active.get(repo) ?? 0) + 1)
    events.push(`start:${repo}:${name}`)
    await delay(15)
    events.push(`end:${repo}:${name}`)
    active.set(repo, active.get(repo)! - 1)
    if (!active.get(repo)) active.delete(repo)
    return true
  })

  assert.deepEqual(events.filter((event) => event.includes('/repo-a')), [
    'start:/repo-a:first', 'end:/repo-a:first',
    'start:/repo-a:worktree-remove', 'end:/repo-a:worktree-remove',
    'start:/repo-a:prune', 'end:/repo-a:prune',
    'start:/repo-a:fourth', 'end:/repo-a:fourth',
  ])
  assert.equal(distinctReposOverlapped, true)
})

test('command actions share one serial lane', async () => {
  const items = [
    item({ kind: 'command', cmd: ['node', '-e', ''] }, { path: '/command/one' }),
    item({ kind: 'command', cmd: ['node', '-e', ''] }, { path: '/command/two' }),
  ]
  const events: string[] = []

  await removeAll(items, () => {}, async (i) => {
    events.push(`start:${i.path}`)
    await delay(10)
    events.push(`end:${i.path}`)
    return true
  })

  assert.deepEqual(events, ['start:/command/one', 'end:/command/one', 'start:/command/two', 'end:/command/two'])
})

test('a refused item fails without stopping other selected removals', async () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-actions-'))
  try {
    const root = join(home, '.claude/projects')
    const good = join(root, 'good')
    const outside = join(home, 'outside')
    mkdirSync(good, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const refused = item({ kind: 'rm', guard: `${root}/` }, { path: outside })
    const allowed = item({ kind: 'rm', guard: `${root}/` }, { path: good })
    const results: { path: string; ok: boolean; message?: string; freed: number }[] = []

    await removeAll([refused, allowed], ({ item: done, ok, message, freed }) => results.push({ path: done.path, ok, message, freed }))

    assert.deepEqual(results.find((result) => result.path === outside), {
      path: outside,
      ok: false,
      message: `refused, outside its category: ${outside}`,
      freed: 0,
    })
    assert.equal(existsSync(good), false)
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a false action reports failure and contributes nothing to freed bytes', async () => {
  const failed = item({ kind: 'command', cmd: ['node', '-e', 'process.exit(1)'] }, { size: 4096 })
  let freed = 0
  let result: { ok: boolean; message?: string; freed: number } | undefined

  await removeAll([failed], ({ ok, message, freed: contribution }) => {
    result = { ok, message, freed: contribution }
    freed += contribution
  }, async () => false)

  assert.deepEqual(result, { ok: false, message: 'the removal reported a failure', freed: 0 })
  assert.equal(freed, 0)
})
