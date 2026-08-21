import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const cats = {
  'toolchain-idle': 'toolchain versions no known project pins',
}

// each manager: where its versions sit under HOME, how a version directory is
// named, which file holds its default and whether that default carries a `v`
// ponytail: fnm/volta/mise/asdf are not covered yet, upgrade path adds rows here
const MANAGERS = [
  { name: 'node', tag: 'v', dir: '.nvm/versions/node', re: /^v(\d+(?:\.\d+)*)$/, defaults: '.nvm/alias/default', pins: 'node' },
  { name: 'python', tag: '', dir: '.pyenv/versions', re: /^(\d+(?:\.\d+)*)$/, defaults: '.pyenv/version', pins: 'python' },
]

// a concrete pin only: `lts/*` or `system` name a moving target, not a version,
// so they must never be read as protecting one
const CONCRETE = /^v?\d+(?:\.\d+)*$/

// equal, or a prefix at a segment boundary: `20` covers 20.11.0, `20.1` does not
export function pinsMatch(pin, version) {
  const p = pin.replace(/^v/, '')
  const v = version.replace(/^v/, '')
  return p === v || v.startsWith(`${p}.`)
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// piecewise numeric compare, missing pieces reading as 0
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

// what the known repos actually ask for: node pins from .nvmrc/.node-version and
// the nodejs/node keys of .tool-versions, python pins from .python-version and
// the python key. non-concrete values are dropped on the way in
function repoPins(repos) {
  const pins = { node: new Set(), python: new Set() }
  for (const repo of repos) {
    for (const f of ['.nvmrc', '.node-version']) {
      for (const line of readText(join(repo, f)).split('\n')) {
        const t = line.trim()
        if (CONCRETE.test(t)) pins.node.add(t)
      }
    }
    for (const line of readText(join(repo, '.python-version')).split('\n')) {
      const t = line.trim()
      if (CONCRETE.test(t)) pins.python.add(t)
    }
    for (const line of readText(join(repo, '.tool-versions')).split('\n')) {
      const [key, value] = line.trim().split(/\s+/)
      if (!CONCRETE.test(value || '')) continue
      if (key === 'nodejs' || key === 'node') pins.node.add(value)
      else if (key === 'python') pins.python.add(value)
    }
  }
  return pins
}

// no age gate on purpose: a version does not go stale by mtime, it goes orphaned
// by reference, so the only question is whether anything still pins it
export function collect({ repos, home, onProgress }) {
  const items = []
  onProgress('toolchains')
  const pins = repoPins(repos)

  for (const m of MANAGERS) {
    const root = join(home, m.dir)
    if (!existsSync(root)) continue
    const installed = []
    for (const name of readdirSync(root)) {
      const hit = name.match(m.re)
      const p = join(root, name)
      if (hit && statSync(p, { throwIfNoEntry: false })?.isDirectory()) installed.push({ v: hit[1], path: p })
    }
    if (!installed.length) continue

    // the newest install is the daily driver candidate and stays even unpinned
    const top = installed.reduce((a, b) => (cmp(b.v.split('.'), a.v.split('.')) > 0 ? b : a))
    const defaults = readText(join(home, m.defaults)).split('\n').map((l) => l.trim()).filter((t) => CONCRETE.test(t))
    const held = [...pins[m.pins], ...defaults]

    for (const inst of installed) {
      if (inst === top) continue
      if (held.some((pin) => pinsMatch(pin, inst.v))) continue
      items.push({
        cat: 'toolchain-idle',
        repo: null,
        path: inst.path,
        size: 0,
        // ctx.repos only knows projects some coding agent opened, so a project no
        // agent ever touched is invisible here and its pinned runtime would look
        // orphaned. nothing is therefore provably safe, and the note names how
        // many repos were asked — the picker exists for exactly this judgment call
        safe: false,
        note: `${m.name} ${m.tag}${inst.v} — no pin among ${repos.size} repo(s)`,
        action: { kind: 'rm', guard: `${root}/` },
      })
    }
  }

  return { items }
}
