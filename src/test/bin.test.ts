import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the CLI runs when invoked through a symlink, the way npm installs its bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-bin-'))
  try {
    const link = join(dir, 'toupeira')
    symlinkSync(new URL('../index.js', import.meta.url).pathname, link)
    const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.match(out, /clean up what coding agents leave behind/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
