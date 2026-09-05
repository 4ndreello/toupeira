import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { report } from '../lib/doctor.js'

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
    assert.ok(rows[0]!.size >= 300_000)
    assert.ok(rows[1]!.size > 0)
    assert.ok(rows[0]!.size > rows[1]!.size, 'sorted by size, biggest first')
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
