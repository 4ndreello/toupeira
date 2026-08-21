import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DAY } from '../format.js'
import { entryNames } from '../sessions.js'

export const cats = {
  'browser-cache': 'superseded test-runner browser builds',
}

// playwright lays its cache out flat: `<family>-<build>`, e.g. chromium-1148 or
// chromium_headless_shell-1148. the headless shell carries the same build number
// as its browser, so it folds into that family and lives or dies with it.
function playwrightBuilds(root) {
  const out = []
  for (const name of entryNames(root)) {
    const m = name.match(/^(.+)-(\d+)$/)
    const p = join(root, name)
    const st = statSync(p, { throwIfNoEntry: false })
    if (!m || !st?.isDirectory()) continue
    out.push({ family: m[1].replace(/_headless_shell$/, ''), v: [Number(m[2])], path: p, mtime: st.mtimeMs })
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

// each tool: where its builds sit under the cache root, how to read one build,
// and what brings it back once removed
const TOOLS = [
  { name: 'playwright', dir: 'ms-playwright', list: playwrightBuilds, why: 'reinstallable with npx playwright install' },
  { name: 'puppeteer', dir: 'puppeteer', list: puppeteerBuilds, why: 're-downloaded on next launch' },
]

// piecewise numeric compare, missing pieces reading as 0: 131.0 ties 131
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

// a build is junk only when superseded — something newer of its family is already
// present — and idle. mtime alone proves nothing: a project may pin an old build
// on purpose, so merely old entries are never offered.
export function collect({ days, home, now, onProgress }) {
  const items = []
  const age = (t) => Math.floor((now - t) / DAY)
  onProgress('test-runner browsers')

  // ponytail: env overrides like PLAYWRIGHT_BROWSERS_PATH are ignored, upgrade
  // path is reading them before falling back to the default cache location
  const cacheRoot = process.platform === 'darwin' ? join(home, 'Library/Caches') : join(home, '.cache')

  for (const tool of TOOLS) {
    const root = join(cacheRoot, tool.dir)
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
