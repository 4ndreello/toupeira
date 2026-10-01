import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedBranchRefs, isContentMerged, mergedBranches, unpushed } from '../lib/repo.js'
import { gitAsync } from '../lib/sh.js'
import { gitIn, initRepo, sorted } from './helpers.js'

test('isContentMerged catches a squash merge that git branch --merged misses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-'))
  const g = initRepo(dir)
  try {
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
    assert.equal(await isContentMerged(dir, 'squashed', 'main'), true)
    assert.equal(await isContentMerged(dir, 'open', 'main'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isContentMerged resolves a local branch when a tag shares its name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-ref-collision-'))
  const g = initRepo(dir)
  try {
    writeFileSync(join(dir, 'base'), 'base\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('checkout', '-qb', 'feature')
    writeFileSync(join(dir, 'unique'), 'unmerged work\n')
    g('add', '.')
    g('commit', '-qm', 'unique work')
    g('checkout', '-q', 'main')
    g('tag', 'feature', 'main')

    assert.notEqual(g('rev-parse', 'refs/heads/feature'), g('rev-parse', 'refs/tags/feature'), 'setup: the branch and tag point at different commits')
    assert.equal(await isContentMerged(dir, 'feature', 'main', new Set()), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergedBranches returns exact local ref names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-br-'))
  const g = initRepo(dir)
  try {
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('branch', 'done')
    g('tag', 'done', 'main')
    g('checkout', '-qb', 'heads/done')
    writeFileSync(join(dir, 'unique'), 'unmerged\n')
    g('add', '.')
    g('commit', '-qm', 'unmerged branch')
    g('checkout', '-q', 'main')
    g('worktree', 'add', '-q', join(dir, 'wt'), '-b', 'parked')
    g('branch', 'rel/2', 'main')
    const expected = ['done', 'main', 'parked', 'rel/2']
    assert.deepEqual(sorted(await mergedBranches(dir, 'main')), expected)
    assert.equal((await mergedBranches(dir, 'main')).has('heads/done'), false, 'a colliding display name cannot mark another branch merged')
    assert.deepEqual(sorted(await mergedBranches(dir, 'HEAD')), expected, 'arbitrary git revisions retain their meaning')
    assert.deepEqual(sorted(await mergedBranches(dir, 'rel/2')), expected, 'slash-containing local branch bases retain their meaning')
    assert.equal(await isContentMerged(dir, 'done', 'HEAD'), true)
    assert.equal(await isContentMerged(dir, 'done', 'rel/2'), true)
    assert.deepEqual([...await mergedBranches(dir, 'nope')], [], 'an unknown base is unknown, not a list')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitAsync resolves command failures to null', async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await gitAsync(['--version'], '/not/a/repository'), null)
  })
})

test('gitAsync closes stdin for commands that read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-git-stdin-'))
  const expected = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
  try {
    initRepo(dir)
    const script = `import { gitAsync } from ${JSON.stringify(new URL('../lib/sh.js', import.meta.url).href)}; const result = await gitAsync(['hash-object', '--stdin'], ${JSON.stringify(dir)}); if (result !== ${JSON.stringify(expected)}) { process.stderr.write(String(result)); process.exitCode = 1; } else process.stdout.write(result);`
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 2000,
    })
    assert.equal(actual, expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isContentMerged shares a merge-base tree read within a scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-merge-cache-'))
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('checkout', '-qb', 'feature-a')
    writeFileSync(join(dir, 'b'), 'two\n')
    g('add', '.')
    g('commit', '-qm', 'feature a')
    g('checkout', '-q', 'main')
    g('checkout', '-qb', 'feature-b')
    writeFileSync(join(dir, 'c'), 'three\n')
    g('add', '.')
    g('commit', '-qm', 'feature b')
    g('checkout', '-q', 'main')

    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    const ctx = { cache: new Map<string, unknown>() }
    assert.deepEqual(await Promise.all([
      isContentMerged(dir, 'feature-a', 'main', new Set(), ctx),
      isContentMerged(dir, 'feature-b', 'main', new Set(), ctx),
    ]), [false, false])
    const mergeBaseTrees = out.split('\n').filter((line) => /^prof git rev-parse [0-9a-f]{40}\^\{tree\}$/.test(line))
    assert.equal(mergeBaseTrees.length, 1, 'the shared merge base tree is forked once')
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unpushed reads ahead state from one memoized refs listing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toupeira-unpushed-'))
  const dir = join(root, 'repo')
  mkdirSync(dir)
  const remote = join(root, 'remote.git')
  const g = gitIn(dir)
  const realEnv = process.env['TOUPEIRA_PROFILE']
  const realWrite = process.stderr.write
  let out = ''
  process.stderr.write = ((s: unknown): boolean => { out += String(s); return true }) as typeof process.stderr.write
  try {
    initRepo(dir)
    writeFileSync(join(dir, 'a'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'init')
    g('init', '--bare', '-q', remote)
    g('remote', 'add', 'origin', remote)
    g('push', '-qu', 'origin', 'main')
    g('remote', 'set-head', 'origin', 'main')

    g('branch', 'no-upstream', 'main')

    g('checkout', '-qb', 'ahead', 'main')
    g('push', '-qu', 'origin', 'ahead')
    writeFileSync(join(dir, 'ahead-1'), 'one\n')
    g('add', '.')
    g('commit', '-qm', 'ahead one')
    writeFileSync(join(dir, 'ahead-2'), 'two\n')
    g('add', '.')
    g('commit', '-qm', 'ahead two')
    g('tag', 'ahead', 'ahead')
    g('checkout', '-q', 'main')

    g('checkout', '-qb', 'behind', 'main')
    g('push', '-qu', 'origin', 'behind')
    g('checkout', '-q', 'main')
    writeFileSync(join(dir, 'remote-only'), 'remote\n')
    g('add', '.')
    g('commit', '-qm', 'remote only')
    g('push', '-q', 'origin', 'main:behind')
    g('fetch', '-q', 'origin')

    g('checkout', '-qb', 'gone', 'main')
    g('push', '-qu', 'origin', 'gone')
    g('push', '-q', 'origin', '--delete', 'gone')
    g('fetch', '-q', '--prune', 'origin')
    g('checkout', '-q', 'main')

    process.env['TOUPEIRA_PROFILE'] = 'verbose'
    const ctx = { cache: new Map<string, unknown>() }
    const states = await Promise.all([
      unpushed(dir, 'no-upstream', ctx),
      unpushed(dir, 'gone', ctx),
      unpushed(dir, 'ahead', ctx),
      unpushed(dir, 'behind', ctx),
    ])
    assert.deepEqual(states, [null, null, 2, 0])
    assert.equal(out.split('\n').filter((line) => line.startsWith('prof git for-each-ref refs/heads ')).length, 1)
  } finally {
    process.stderr.write = realWrite
    if (realEnv === undefined) delete process.env['TOUPEIRA_PROFILE']
    else process.env['TOUPEIRA_PROFILE'] = realEnv
    rmSync(root, { recursive: true, force: true })
  }
})

// the listing ends in tabs for a branch with no upstream, and gitAsync trims the output:
// the last such branch used to fall out of the listing, so no rule could ever see it
test('the refs listing keeps a last branch that has no upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-refs-'))
  try {
    const g = initRepo(dir)
    writeFileSync(join(dir, 'a'), 'a\n')
    g('add', 'a')
    g('commit', '-qm', 'init')
    g('branch', 'zz-last')
    const refs = await cachedBranchRefs({}, dir)
    assert.deepEqual(refs.map((ref) => ref.branch), ['main', 'zz-last'])
    assert.deepEqual(refs[1], { branch: 'zz-last', timestamp: refs[0]!.timestamp, upstream: '', track: '', remoteref: '', ahead: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
