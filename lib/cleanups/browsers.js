import { statSync } from 'node:fs'
import { join } from 'node:path'
import { cmp, DAY } from '../format.js'
import { entryNames } from '../sessions.js'

export const cats = {
  'browser-cache': 'superseded test-runner browser builds',
}

// playwright lays its cache out flat: `<family>-<build>`, e.g. chromium-1148 or
// chromium_headless_shell-1148. the shell is its own family on purpose: it is not a
// browser, so `playwright install --only-shell` of a newer build must never make the
// last full chromium look superseded.
function playwrightBuilds(root) {
  const out = []
  for (const name of entryNames(root)) {
    const m = name.match(/^(.+)-(\d+)$/)
    const p = join(root, name)
    const st = statSync(p, { throwIfNoEntry: false })
    if (!m || !st?.isDirectory()) continue
    out.push({ family: m[1], v: [Number(m[2])], path: p, mtime: st.mtimeMs })
  }
  return out
}

// puppeteer nests one level down: `<family>/<platform>-<semver>`, e.g.
// chrome/linux-131.0.6778.204 — the family is the parent directory
function puppeteerBuilds(root) {
  const out = []
  for (const family of entryNames(root)) {
    for (const name of entryNames(join(root, family))) {
      const m = name.match(/^[^-]+-(\d+(?:\.\d+)*)$/)
      const p = join(root, family, name)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!m || !st?.isDirectory()) continue
      out.push({ family, v: m[1].split('.').map(Number), path: p, mtime: st.mtimeMs })
    }
  }
  return out
}

// each tool: where its cache sits under HOME, how to read one build, and what brings it
// back once removed. the root is per tool, not per platform: playwright follows the
// darwin cache convention, puppeteer defaults to ~/.cache/puppeteer everywhere.
const TOOLS = [
  {
    name: 'playwright',
    root: (home) => join(home, process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright'),
    list: playwrightBuilds,
    why: 'reinstallable with npx playwright install',
  },
  { name: 'puppeteer', root: (home) => join(home, '.cache/puppeteer'), list: puppeteerBuilds, why: 're-downloaded on next launch' },
]

// a build is junk only when superseded — something newer of its family is already
// present — and idle. mtime alone proves nothing: a project may pin an old build
// on purpose, so merely old entries are never offered.
export function collect({ days, home, now, onProgress }) {
  const items = []
  const age = (t) => Math.floor((now - t) / DAY)
  onProgress('test-runner browsers')

  // ponytail: env overrides like PLAYWRIGHT_BROWSERS_PATH and PUPPETEER_CACHE_DIR are
  // ignored, upgrade path is reading them before falling back to the default location
  for (const tool of TOOLS) {
    const root = tool.root(home)
    const builds = tool.list(root)
    if (!builds.length) continue

    const newest = new Map()
    for (const b of builds) {
      const top = newest.get(b.family)
      if (!top || cmp(b.v, top) > 0) newest.set(b.family, b.v)
    }

    const gone = []
    let first = Infinity
    let last = 0
    for (const b of builds) {
      if (cmp(b.v, newest.get(b.family)) >= 0 || age(b.mtime) < days) continue
      gone.push(b.path)
      first = Math.min(first, b.mtime)
      last = Math.max(last, b.mtime)
    }
    if (!gone.length) continue
    items.push({
      cat: 'browser-cache',
      repo: null,
      // the tool root, for display and the size sort. it is never the target:
      // what goes is action.files, guarded per entry by remove()
      path: root,
      size: 0,
      safe: true,
      span: `oldest ${age(first)}d - newest ${age(last)}d`,
      note: `${tool.name}: ${gone.length} superseded build(s), ${tool.why}`,
      action: { kind: 'rm-files', files: gone, root },
    })
  }

  return { items }
}
