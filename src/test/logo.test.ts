import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadingScreen } from '../lib/logo.js'

function fakeOut(tty = true) {
  const writes: string[] = []
  return {
    isTTY: tty,
    columns: 80,
    writes,
    write(s: string) { writes.push(s); return true },
  }
}

const frames = (writes: string[]): string[] =>
  writes.filter((w) => w.startsWith('\x1b[2K')).map((w) => w.trim())

test('the spinner keeps ticking without new messages and stops on stop', async () => {
  const out = fakeOut()
  const onProgress = loadingScreen(out as unknown as NodeJS.WriteStream, 10)
  onProgress('reading agent sessions')
  await new Promise((r) => setTimeout(r, 60))
  const before = frames(out.writes)
  assert.ok(before.length >= 3, `expected several frames, got ${before.length}`)
  assert.ok(new Set(before).size >= 2, 'frames advance while the message sits still')
  assert.ok(before.every((f) => f.includes('reading agent sessions')))
  onProgress.stop()
  const count = out.writes.length
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(out.writes.length, count, 'no writes after stop')
})

test('without a tty the progress callback is a silent noop', () => {
  const out = fakeOut(false)
  const onProgress = loadingScreen(out as unknown as NodeJS.WriteStream)
  onProgress('reading agent sessions')
  onProgress.stop()
  assert.deepEqual(out.writes, [])
})
