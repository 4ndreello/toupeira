import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { targets } from '../lib/scan.js'
import * as stores from '../lib/cleanups/stores.js'
import { actionCmd } from './helpers.js'

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
    assert.deepEqual(actionCmd(items[0]!), ['npm', 'cache', 'verify'])
    assert.deepEqual(actionCmd(items[1]!), ['pnpm', 'store', 'prune'])
    for (const i of items) {
      assert.equal(i.cat, 'store-prune')
      assert.equal(i.safe, true, 'official maintenance commands are safe by definition')
      assert.equal(i.repo, null)
      assert.deepEqual(targets(i), [], 'the store is display only: what a prune frees is unknown, never the whole store')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
