import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remove } from '../index.js'
import * as browsers from '../lib/cleanups/browsers.js'
import type { Item } from '../types.js'
import { withFiles } from './helpers.js'

// browser-cache tests all start from build directories that are either aged past the gate
// or left fresh; nothing else about the layout ever varies
function browserHome({ aged = [], fresh = [] }: { aged?: string[]; fresh?: string[] }): string {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-home-'))
  const old = Date.now() - 30 * 86400e3
  for (const rel of [...aged, ...fresh]) {
    const d = join(home, rel)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'marker'), 'x')
    if (aged.includes(rel)) utimesSync(d, old / 1000, old / 1000)
  }
  return home
}

test('superseded playwright builds are offered, the newest of a family never is', () => {
  const home = browserHome({
    aged: [
      '.cache/ms-playwright/chromium-100',
      '.cache/ms-playwright/chromium_headless_shell-100',
      '.cache/ms-playwright/firefox-50',
    ],
    fresh: ['.cache/ms-playwright/chromium-101'],
  })
  try {
    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 1)
    const item = items[0]!
    assert.equal(item.cat, 'browser-cache')
    assert.equal(item.path, join(home, '.cache/ms-playwright'), 'the tool root is display only')
    assert.deepEqual(
      (item.action as unknown as { files: string[] }).files,
      [join(home, '.cache/ms-playwright/chromium-100')],
      'the newest chromium, the lone firefox and the lone headless shell stay'
    )
    assert.equal(item.safe, true)
    assert.match(item.span!, /^oldest \d+d - newest \d+d$/)
    assert.match(item.note, /playwright/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// `playwright install --only-shell` on a newer version is the normal way to end up with
// a shell build newer than every browser build , it must not condemn the last browser
test('a newer headless shell never supersedes the browser it is not', () => {
  const home = browserHome({
    aged: ['.cache/ms-playwright/chromium-1140'],
    fresh: ['.cache/ms-playwright/chromium_headless_shell-1148'],
  })
  try {
    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.deepEqual(items, [], 'the only full chromium is nobody else in its family')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('superseded puppeteer builds are offered per family, single-build families stay', () => {
  const home = browserHome({
    aged: ['.cache/puppeteer/chrome/linux-120.0.0', '.cache/puppeteer/firefox/linux-130.0'],
    fresh: ['.cache/puppeteer/chrome/linux-121.0.0'],
  })
  try {
    const { items } = browsers.collect({ days: 7, home, now: Date.now(), onProgress() {} })
    assert.equal(items.length, 1)
    assert.equal(items[0]!.path, join(home, '.cache/puppeteer'))
    assert.deepEqual((items[0]!.action as unknown as { files: string[] }).files, [join(home, '.cache/puppeteer/chrome/linux-120.0.0')])
    assert.equal(items[0]!.safe, true)
    assert.match(items[0]!.note, /puppeteer/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a superseded build with a fresh mtime is held back anyway', () => {
  const home = browserHome({ fresh: ['.cache/ms-playwright/chromium-99', '.cache/ms-playwright/chromium-100'] })
  try {
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
    const i = { cat: 'browser-cache', repo: null, path: root, size: 0, safe: true, note: 't', action: { kind: 'rm-files', root, files: [build] } } as unknown as Item
    assert.equal(remove(i), true)
    assert.equal(existsSync(build), false, 'the superseded build goes')
    assert.equal(existsSync(root), true, 'the tool root stays')

    assert.throws(() => remove(withFiles(i, [join(home, '.cache/other/chromium-99')])), /refused, outside its category/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
