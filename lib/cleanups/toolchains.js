import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const cats = {
  'toolchain-idle': 'toolchain versions no known project pins',
}

// each manager: where its versions sit under HOME, how a version directory is named,
// which file holds its default, where an alias resolves (nvm only) and whether the
// version carries a `v`
// ponytail: fnm/volta/mise/asdf are not covered yet, upgrade path adds rows here
const MANAGERS = [
  { name: 'node', tag: 'v', dir: '.nvm/versions/node', re: /^v(\d+(?:\.\d+)*)$/, defaults: '.nvm/alias/default', aliases: '.nvm/alias', pins: 'node' },
  { name: 'python', tag: '', dir: '.pyenv/versions', re: /^(\d+(?:\.\d+)*)$/, defaults: '.pyenv/version', aliases: null, pins: 'python' },
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
    // a .tool-versions line may list fallbacks — `nodejs 20.11.0 18.19.0` resolves to
    // 18 whenever 20 is absent, so every version on the line is a pin, not just the first
    for (const line of readText(join(repo, '.tool-versions')).split('\n')) {
      const [key, ...values] = line.trim().split(/\s+/)
      const set = key === 'nodejs' || key === 'node' ? pins.node : key === 'python' ? pins.python : null
      if (!set) continue
      for (const v of values) if (CONCRETE.test(v)) set.add(v)
    }
  }
  return pins
}

// what the manager's own default file names. nvm writes whatever the user typed —
// a version, or an alias like `lts/*`, `node` or `stable` — and an alias is a file
// naming its target, resolved one hop at a time (`lts/*` → `lts/iron` → v20.19.0).
// a target that never becomes concrete (`node`, `system`, a pyenv virtualenv) names a
// moving version: the daily driver cannot be identified, so the caller offers nothing
// for that manager rather than risk deleting the runtime the shell actually uses.
function defaultPins(home, m) {
  const pins = []
  let moving = null
  for (const line of readText(join(home, m.defaults)).split('\n').map((l) => l.trim()).filter(Boolean)) {
    let t = line
    // a hop cap, not a cycle detector: five is past anything nvm writes
    for (let hop = 0; m.aliases && hop < 5 && !CONCRETE.test(t); hop++) {
      // the name comes out of a file, so it may not wander out of the alias directory
      if (!/^[\w.*+-]+(?:\/[\w.*+-]+)*$/.test(t)) break
      const next = readText(join(home, m.aliases, t)).split('\n')[0].trim()
      if (!next || next === t) break
      t = next
    }
    if (CONCRETE.test(t)) pins.push(t)
    else moving ??= line
  }
  return { pins, moving }
}

// no age gate on purpose: a version does not go stale by mtime, it goes orphaned
// by reference, so the only question is whether anything still pins it
export function collect({ repos, home, onProgress }) {
  const items = []
  const kept = []
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
    const { pins: defaults, moving } = defaultPins(home, m)
    if (moving) {
      kept.push({ path: root, why: `${m.name} default is \`${moving}\`, which names no fixed version` })
      continue
    }
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

  return { items, kept }
}
