import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATS, CLEANUPS } from '../lib/cleanups/index.js'

test('every category a cleanup produces has a label, and none collide', () => {
  const declared = CLEANUPS.flatMap((c) => Object.keys(c.cats))
  for (const cat of declared) assert.equal(typeof CATS[cat], 'string', `${cat} has no label`)
  assert.equal(Object.keys(CATS).length, declared.length, 'two cleanups claim the same category')
})

// one HOME with none of anyone's state: every cleanup must answer with nothing, and none
// may throw on the directories it goes looking for
test('an empty HOME yields nothing from every cleanup, and throws nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-empty-'))
  try {
    const ctx = { repos: new Set<string>(), days: 7, home, now: Date.now(), onProgress() {} }
    for (const c of CLEANUPS) {
      assert.deepEqual(c.collect(ctx).items, [], `${Object.keys(c.cats).join('/')} offered something in an empty HOME`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
