import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remove } from '../index.js'
import * as toolchains from '../lib/cleanups/toolchains.js'

// a version manager's installs directory, which is where every toolchain test begins
function versionsHome(rel: string, versions: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  for (const v of versions) mkdirSync(join(home, rel, v), { recursive: true })
  return home
}

test('pinsMatch covers equality and segment-boundary prefixes only', () => {
  assert.equal(toolchains.pinsMatch('20', '20.11.0'), true)
  assert.equal(toolchains.pinsMatch('20.11.0', '20.11.0'), true)
  assert.equal(toolchains.pinsMatch('v18', '18.19.0'), true, 'the v tag is noise')
  assert.equal(toolchains.pinsMatch('20.1', '20.11.0'), false, '20.1 is not a prefix of 20.11')
  assert.equal(toolchains.pinsMatch('21', '20.11.0'), false)
})

test('idle toolchains are the unpinned, unprotected, non-newest installs', () => {
  const home = versionsHome('.nvm/versions/node', ['v16.20.0', 'v18.19.0', 'v20.11.0', 'v22.5.0'])
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
    mkdirSync(join(home, '.nvm/alias'), { recursive: true })
    writeFileSync(join(home, '.nvm/alias/default'), 'v20.11.0\n')
    writeFileSync(join(repo, '.nvmrc'), '18.19.0\n')

    const { items } = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} })
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), ['v16.20.0'], 'pinned, default and newest all stay')
    assert.equal(items[0]!.safe, false, 'repos no agent touched are invisible, so nothing is provably safe')
    assert.match(items[0]!.note, /no pin among 1 repo\(s\)/)
    assert.equal(items[0]!.action.kind, 'rm')

    remove(items[0]!)
    assert.equal(existsSync(join(home, '.nvm/versions/node/v16.20.0')), false, 'remove() really deletes it')

    const outside = { cat: 't', repo: null, path: '/usr', size: 0, safe: true, note: 't', action: { kind: 'rm', guard: `${home}/.nvm/versions/node/` } } as unknown as Parameters<typeof remove>[0]
    assert.throws(() => remove(outside), /outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('pyenv versions respect their global file and .python-version pins', () => {
  const home = versionsHome('.pyenv/versions', ['3.10.0', '3.11.2', '3.12.1'])
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
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

test('.tool-versions protects through its nodejs key, fallback versions included', () => {
  const home = versionsHome('.nvm/versions/node', ['v16.20.0', 'v18.19.0', 'v20.11.0', 'v22.5.0'])
  const repo = mkdtempSync(join(tmpdir(), 'toupeira-repo-'))
  try {
    // asdf/mise fall back along the line, so 18 is pinned just as much as 20
    writeFileSync(join(repo, '.tool-versions'), 'nodejs 20.11.0 18.19.0\npython 3.12.1\n')
    const { items } = toolchains.collect({ repos: new Set([repo]), home, onProgress() {} })
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), ['v16.20.0'], 'only the version no line mentions is idle')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an nvm default recorded as an alias resolves through the alias files', () => {
  const home = versionsHome('.nvm/versions/node', ['v18.19.0', 'v20.19.0', 'v22.5.0'])
  try {
    mkdirSync(join(home, '.nvm/alias/lts'), { recursive: true })
    writeFileSync(join(home, '.nvm/alias/default'), 'lts/*\n')
    writeFileSync(join(home, '.nvm/alias/lts/*'), 'lts/iron\n')
    writeFileSync(join(home, '.nvm/alias/lts/iron'), 'v20.19.0\n')

    const { items } = toolchains.collect({ repos: new Set<string>(), home, onProgress() {} })
    assert.deepEqual(items.map((i) => i.path.split('/').at(-1)), ['v18.19.0'], 'the default resolves to v20, v22 is newest')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a default that names no fixed version protects every install', () => {
  const home = versionsHome('.nvm/versions/node', ['v18.19.0', 'v20.11.0', 'v22.5.0'])
  try {
    mkdirSync(join(home, '.nvm/alias'), { recursive: true })
    writeFileSync(join(home, '.nvm/alias/default'), 'node\n') // nvm's "whatever is newest"

    const { items, kept } = toolchains.collect({ repos: new Set<string>(), home, onProgress() {} })
    assert.deepEqual(items, [], 'the daily driver is unknown, so nothing is offered')
    assert.equal(kept!.length, 1)
    assert.match(kept![0]!.why, /names no fixed version/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
