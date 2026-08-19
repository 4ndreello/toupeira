#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import readline from 'node:readline'

const HOME = homedir()
const DAY = 86400_000
const LOG = join(process.env.XDG_STATE_HOME || join(HOME, '.local/state'), 'toupeira/operations.log')

// ---------- shell ----------

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 }).trim()
  } catch {
    return null
  }
}

function du(args) {
  try {
    return execFileSync('du', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 })
  } catch (e) {
    return e.stdout || '' // du exits non-zero on unreadable entries but still reports the rest
  }
}

// one du per path, on purpose: a single batched call counts a hardlinked file only for
// whichever path reaches it first, so pnpm/bun worktrees report near-zero at random.
// ponytail: apparent size — bytes shared with a package store outside the set won't actually free
function diskUsage(paths, onProgress = () => {}) {
  const sizes = new Map()
  let n = 0
  for (const p of paths) {
    onProgress(`measuring ${++n}/${paths.length}`)
    const m = du(['-sb', '--', p]).match(/^(\d+)\t/)
    sizes.set(p, m ? Number(m[1]) : 0)
  }
  return sizes
}

// combined total, deduped: what the disk actually gets back if all of these go
function combinedSize(paths) {
  const live = paths.filter((p) => existsSync(p))
  if (!live.length) return 0
  let total = 0
  for (let i = 0; i < live.length; i += 200) {
    const out = du(['-scb', '--', ...live.slice(i, i + 200)])
    const m = out.match(/^(\d+)\ttotal$/m)
    total += m ? Number(m[1]) : 0
  }
  return total
}

// ---------- discovery ----------

function walkFiles(root, depth, ext, out = []) {
  if (depth < 0 || !existsSync(root)) return out
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) walkFiles(p, depth - 1, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}

// session transcripts run to hundreds of MB; cwd is in the header, so read the head only
function headMatch(file, re, bytes = 256 * 1024) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    const m = buf.subarray(0, n).toString('utf8').match(re)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// every directory an agent has ever worked in, taken from its own session logs.
// no filesystem crawl, no config: the agents already wrote down where they went.
export function agentCwds() {
  const files = [
    ...walkFiles(join(HOME, '.claude/projects'), 2, '.jsonl'),
    ...walkFiles(join(HOME, '.codex/sessions'), 5, '.jsonl'),
  ]
  const cwds = new Set()
  for (const f of files) {
    const cwd = headMatch(f, /"cwd":"([^"]+)"/)
    if (cwd) cwds.add(cwd)
  }
  return cwds
}

// project dir names encode "/" as "-", which is lossy: /a/b-c and /a-b/c collide.
// walk the real filesystem and take the longest existing child at each level.
// ponytail: greedy, no backtracking — enough to tell "this path is gone" from "this path is here"
export function decodeProjectDir(name, exists = existsSync) {
  const segs = name.replace(/^-/, '').split('-')
  let cur = ''
  let i = 0
  while (i < segs.length) {
    let next = null
    for (let j = segs.length; j > i; j--) {
      const cand = `${cur}/${segs.slice(i, j).join('-')}`
      if (exists(cand)) {
        next = { cand, j }
        break
      }
    }
    if (!next) return { path: `${cur}/${segs.slice(i).join('-')}`, exists: false }
    cur = next.cand
    i = next.j
  }
  return { path: cur, exists: true }
}

export function parseWorktrees(porcelain) {
  return porcelain
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const o = {}
      for (const line of block.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp === -1) o[line] = true
        else o[line.slice(0, sp)] = line.slice(sp + 1)
      }
      return {
        path: o.worktree,
        head: o.HEAD,
        branch: typeof o.branch === 'string' ? o.branch.replace('refs/heads/', '') : null,
        bare: !!o.bare,
        detached: !!o.detached,
        prunable: !!o.prunable,
      }
    })
    .filter((w) => w.path)
}

function mainRepoOf(path) {
  if (!existsSync(path)) return null
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)
  if (!common) return null
  return common.endsWith('/.git') ? common.slice(0, -5) : dirname(common)
}

function defaultBranch(repo) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)
  if (head) return head
  for (const b of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', b], repo)) return b
  }
  return null
}

// `git branch --merged` misses squash merges — the squashed commit has a different hash.
// replay the branch tree as a single commit on the merge base and ask git if that patch is already upstream.
// ponytail: writes one loose commit object per check, gc collects it
export function isContentMerged(repo, branch, base) {
  if (!base || !branch) return false
  if ((git(['branch', '--merged', base], repo) || '').split('\n').some((l) => l.replace(/^\*?\s+/, '') === branch)) return true
  const mergeBase = git(['merge-base', base, branch], repo)
  const tree = git(['rev-parse', `${branch}^{tree}`], repo)
  if (!mergeBase || !tree) return false
  if (tree === git(['rev-parse', `${mergeBase}^{tree}`], repo)) return true // branch changed nothing
  const probe = git(['commit-tree', tree, '-p', mergeBase, '-m', 'toupeira-probe'], repo)
  if (!probe) return false
  return (git(['cherry', base, probe], repo) || '').startsWith('-')
}

function unpushed(repo, branch) {
  const upstream = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], repo)
  if (!upstream) return null // no upstream: can't tell, treat as unknown
  const n = git(['rev-list', '--count', `${upstream}..${branch}`], repo)
  return Number(n || 0)
}

// ---------- scan ----------

export function scan({ days = 7, roots = [], onProgress = () => {} } = {}) {
  onProgress('reading agent sessions')
  const repos = new Set()
  for (const p of [...agentCwds(), ...roots]) {
    const r = mainRepoOf(p)
    if (r) repos.add(r)
  }

  const items = []
  const kept = []
  const now = Date.now()

  let n = 0
  for (const repo of repos) {
    onProgress(`worktrees ${++n}/${repos.size} ${short(repo)}`)
    const list = git(['worktree', 'list', '--porcelain'], repo)
    if (!list) continue
    const base = defaultBranch(repo)
    const worktrees = parseWorktrees(list)

    for (const w of worktrees) {
      if (w.path === repo || w.bare) continue // never touch the main checkout

      if (w.prunable || !existsSync(w.path)) {
        items.push({ cat: 'worktree-prunable', repo, path: w.path, size: 0, safe: true, note: 'registered here, but the directory is gone', action: { kind: 'prune', repo } })
        continue
      }

      const dirty = (git(['status', '--porcelain'], w.path) || '').length > 0
      const ts = Number(git(['log', '-1', '--format=%ct'], w.path) || 0) * 1000
      const age = ts ? Math.floor((now - ts) / DAY) : 0
      const ahead = w.branch ? unpushed(repo, w.branch) : null
      const merged = w.branch ? isContentMerged(repo, w.branch, base) : false
      const nm = join(w.path, 'node_modules')
      const label = `${w.branch || w.head?.slice(0, 7)} (${age}d)`

      if (existsSync(nm) && age >= days) {
        items.push({ cat: 'node_modules', repo, path: nm, size: 0, safe: true, note: `${label} — reinstallable`, action: { kind: 'rm', guard: '/node_modules' } })
      }

      if (dirty) {
        kept.push({ path: w.path, why: 'uncommitted changes' })
        continue
      }
      if (merged) {
        items.push({ cat: 'worktree-merged', repo, path: w.path, size: 0, safe: true, note: `${label} — already in ${base}`, action: { kind: 'worktree-remove', repo } })
      } else if (ahead === null) {
        kept.push({ path: w.path, why: 'no upstream, these commits exist nowhere else' })
      } else if (ahead > 0) {
        kept.push({ path: w.path, why: `${ahead} unpushed commit(s)` })
      } else if (age >= days) {
        items.push({ cat: 'worktree-stale', repo, path: w.path, size: 0, safe: false, note: `${label} — pushed, not merged`, action: { kind: 'worktree-remove', repo } })
      } else {
        kept.push({ path: w.path, why: `recent (${age}d)` })
      }
    }
  }

  onProgress('orphan sessions')
  const projects = join(HOME, '.claude/projects')
  if (existsSync(projects)) {
    for (const name of readdirSync(projects)) {
      const dir = join(projects, name)
      if (!statSync(dir).isDirectory()) continue
      const cwd = walkFiles(dir, 2, '.jsonl').map((f) => headMatch(f, /"cwd":"([^"]+)"/)).find(Boolean)
      const target = cwd || decodeProjectDir(name).path
      if (existsSync(target)) continue
      items.push({ cat: 'session-orphan', repo: null, path: dir, size: 0, safe: true, note: `${target} is gone`, action: { kind: 'rm', guard: '/.claude/projects/' } })
    }
  }

  const sizes = diskUsage(items.filter((i) => i.size === 0 && existsSync(i.path)).map((i) => i.path), onProgress)
  for (const i of items) i.size = sizes.get(i.path) ?? 0

  // dedupe worktrees that also had a node_modules entry: removing the worktree takes it along
  const removed = new Set(items.filter((i) => i.cat.startsWith('worktree-') && i.action.kind === 'worktree-remove').map((i) => i.path))
  const final = items.filter((i) => !(i.cat === 'node_modules' && removed.has(dirname(i.path))))

  final.sort((a, b) => b.size - a.size)
  return { items: final, kept, repos: repos.size }
}

// ---------- removal ----------

export function remove(item) {
  const { action, path } = item
  if (action.kind === 'prune') return git(['worktree', 'prune'], action.repo) !== null
  if (action.kind === 'worktree-remove') return git(['worktree', 'remove', path], action.repo) !== null
  if (action.kind === 'rm') {
    if (!path.includes(action.guard)) throw new Error(`refused, outside its category: ${path}`)
    rmSync(path, { recursive: true, force: true })
    return true
  }
  return false
}

function log(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging never blocks the cleanup */
  }
}

// ---------- logo ----------

// the face is 7-bit ASCII on purpose: it survives any terminal.
// the wordmark is box-drawing, so it only prints under a UTF-8 locale.
const FACE = String.raw`
        _____
       \"_   _"/
       |(>)-(<)|
    ../  " O "  \..`.split('\n').slice(1)

const WORD = ['┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐', ' │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤', ' ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴']
const GROUND = '~~""(((:-.,_,.-:)))""'
const MARK = '(>)-(<)'

const utf8 = () => /UTF-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '')

// the logo stays up while the scan runs, with the progress line reading as underground
export function loadingScreen(out = process.stdout) {
  if (!out.isTTY) return () => {}
  const spin = utf8() ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/']
  out.write(`\n${banner(out.columns).join('\n')}\n\n`)
  let tick = 0
  return (msg) => out.write(`\x1b[2K   ${spin[tick++ % spin.length]} ${msg}\r`)
}

export function banner(cols) {
  const room = cols || process.stdout.columns || 80 // a terminal reporting 0 means "unknown", not "tiny"
  const word = utf8() ? WORD : ['', 'toupeira', '']
  const lines = FACE.map((f, n) => (n === 0 ? f : `${f.padEnd(24)}${word[n - 1]}`.trimEnd()))
  const w = Math.max(...lines.map((l) => l.length), GROUND.length)
  if (room < w) return ['toupeira'] // no room: the name alone beats a mangled logo
  return [...lines, GROUND + '~'.repeat(w - GROUND.length)]
}

// ---------- ui ----------

const CATS = {
  'worktree-prunable': 'stale worktree registrations',
  'worktree-merged': 'merged worktrees',
  'worktree-stale': 'idle worktrees, not merged',
  node_modules: 'node_modules inside a worktree',
  'session-orphan': 'sessions for projects that are gone',
}

export function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

function short(p) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p
}

function table(items, limit = 8) {
  const groups = new Map()
  for (const i of items) groups.set(i.cat, [...(groups.get(i.cat) || []), i])
  for (const [cat, list] of groups) {
    const total = list.reduce((s, i) => s + i.size, 0)
    console.log(`\n\x1b[1m${CATS[cat]}\x1b[0m — ${list.length} item(s), ${human(total)}`)
    for (const i of list.slice(0, limit)) console.log(`  ${human(i.size).padStart(8)}  ${short(i.path)}\n            \x1b[2m${i.note}\x1b[0m`)
    const rest = list.slice(limit)
    if (rest.length) console.log(`  \x1b[2m… ${rest.length} more, ${human(rest.reduce((s, i) => s + i.size, 0))}\x1b[0m`)
  }
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  invert: (s) => `\x1b[7m${s}\x1b[0m`,
}

const width = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const clip = (s, n) => (width(s) <= n ? s : `…${s.slice(width(s) - n + 1)}`)

// flatten categories and their (optionally expanded) items into one navigable list
export function treeRows(items, expanded) {
  const sum = (idxs) => idxs.reduce((s, i) => s + items[i].size, 0)
  const order = []
  const byCat = new Map()
  items.forEach((it, idx) => {
    if (!byCat.has(it.cat)) {
      byCat.set(it.cat, [])
      order.push(it.cat)
    }
    byCat.get(it.cat).push(idx)
  })
  order.sort((a, b) => sum(byCat.get(b)) - sum(byCat.get(a)))
  const rows = []
  for (const cat of order) {
    const idxs = byCat.get(cat)
    rows.push({ type: 'cat', cat, idxs })
    if (expanded.has(cat)) for (const idx of idxs) rows.push({ type: 'item', cat, idx })
  }
  return rows
}

function sizeBar(size, max, cells = 12) {
  const filled = max > 0 ? Math.round((size / max) * cells) : 0
  return C.dim('━'.repeat(filled) + ' '.repeat(cells - filled))
}

async function pick(items, headline) {
  const sel = items.map((i) => i.safe)
  const expanded = new Set()
  const maxCat = Math.max(
    ...[...new Set(items.map((i) => i.cat))].map((c) => items.filter((i) => i.cat === c).reduce((s, i) => s + i.size, 0))
  )
  let rows = treeRows(items, expanded)
  let cur = 0
  let top = 0

  const cols = () => process.stdout.columns || 100
  const viewport = () => Math.max(3, (process.stdout.rows || 24) - 6)

  const draw = () => {
    const h = viewport()
    top = Math.min(Math.max(top, cur - h + 1), cur, Math.max(0, rows.length - h))
    const marked = sel.filter(Boolean).length
    const sum = items.reduce((s, i, n) => s + (sel[n] ? i.size : 0), 0)

    const out = ['\x1b[H\x1b[2J']
    out.push(`${C.dim(MARK)} ${C.bold('toupeira')} ${C.dim('·')} ${headline} ${C.dim('·')} ${C.green(`${marked} selected, sum ${human(sum)}`)}\n\n`)

    for (let n = top; n < top + h; n++) {
      const r = rows[n]
      if (!r) {
        out.push('\n')
        continue
      }
      const focus = n === cur
      let line
      if (r.type === 'cat') {
        const on = r.idxs.filter((i) => sel[i]).length
        const box = on === 0 ? '[ ]' : on === r.idxs.length ? C.green('[x]') : C.yellow('[~]')
        const size = r.idxs.reduce((s, i) => s + items[i].size, 0)
        line = `${expanded.has(r.cat) ? '▼' : '▶'} ${box} ${pad(C.bold(CATS[r.cat]), 38)} ${sizeBar(size, maxCat)} ${pad(human(size), 8)} ${C.dim(`${r.idxs.length} item(s)`)}`
      } else {
        const it = items[r.idx]
        const box = sel[r.idx] ? C.green('[x]') : '[ ]'
        const warn = it.safe ? ' ' : C.yellow('!')
        line = `    ${box}${warn} ${pad(human(it.size), 8)} ${C.dim(clip(short(it.path), cols() - 30))}`
      }
      out.push(`${focus ? C.invert(pad(line, cols() - 1)) : line}\n`)
    }

    const r = rows[cur]
    const note = r?.type === 'item' ? items[r.idx].note : `${rows.length} rows · ! = needs a look first`
    out.push(`\n${C.dim(clip(note, cols() - 1))}\n`)
    out.push(C.dim('↑↓ move · ←→ collapse/expand · space select · a all · enter apply · q quit'))
    process.stdout.write(out.join(''))
  }

  const restore = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  process.on('exit', restore)
  const onResize = () => draw()
  process.stdout.on('resize', onResize)
  draw()

  return new Promise((resolve) => {
    const move = (d) => {
      cur = Math.min(Math.max(cur + d, 0), rows.length - 1)
    }
    const rebuild = () => {
      const at = rows[cur]
      rows = treeRows(items, expanded)
      const again = rows.findIndex((r) => (at.type === 'cat' ? r.type === 'cat' && r.cat === at.cat : r.type === 'item' && r.idx === at.idx))
      cur = again === -1 ? 0 : again
    }
    const onKey = (_, key) => {
      const r = rows[cur]
      const k = key.name
      if (k === 'up' || k === 'k') move(-1)
      else if (k === 'down' || k === 'j') move(1)
      else if (k === 'pageup') move(-viewport())
      else if (k === 'pagedown') move(viewport())
      else if (k === 'home' || k === 'g') cur = 0
      else if (k === 'end' || k === 'G') cur = rows.length - 1
      else if (k === 'right' || k === 'l') {
        if (r.type === 'cat' && !expanded.has(r.cat)) {
          expanded.add(r.cat)
          rebuild()
        }
      } else if (k === 'left' || k === 'h') {
        if (r.type === 'item') {
          expanded.delete(r.cat)
          rebuild()
        } else if (expanded.has(r.cat)) {
          expanded.delete(r.cat)
          rebuild()
        }
      } else if (k === 'space') {
        if (r.type === 'item') sel[r.idx] = !sel[r.idx]
        else {
          const all = r.idxs.every((i) => sel[i])
          for (const i of r.idxs) sel[i] = !all
        }
      } else if (k === 'a') {
        const all = sel.every(Boolean)
        sel.fill(!all)
      } else if (k === 'return') return done(items.filter((_, n) => sel[n]))
      else if (k === 'q' || k === 'escape' || (key.ctrl && k === 'c')) return done([])
      else return
      draw()
    }
    const done = (result) => {
      process.stdin.off('keypress', onKey)
      process.stdout.off('resize', onResize)
      process.off('exit', restore)
      restore()
      resolve(result)
    }
    process.stdin.on('keypress', onKey)
  })
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => {
      rl.close()
      resolve(/^y/i.test(a.trim()))
    })
  })
}

// ---------- cli ----------

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv.find((a) => !a.startsWith('-')) || 'scan'
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? def : argv[i + 1]
  }
  if (argv.includes('-h') || argv.includes('--help') || cmd === 'help') {
    if (process.stdout.isTTY) console.log(`\n${banner().join('\n')}\n`)
    console.log(`toupeira — clean up what coding agents leave behind

  toupeira scan            list everything, remove nothing (default)
  toupeira clean           pick what goes, then confirm

  --days <n>   minimum idle age for a worktree to count as stale (default 7)
  --root <p>   extra repository, for agents that leave no session log
  --yes        remove everything marked safe, no prompt`)
    return
  }

  const roots = argv.reduce((acc, a, i) => (a === '--root' ? [...acc, argv[i + 1]] : acc), [])
  const onProgress = loadingScreen()
  const { items, kept, repos } = scan({ days: Number(flag('days', 7)), roots, onProgress })
  if (process.stdout.isTTY) process.stdout.write('\x1b[2K')

  if (!items.length) {
    console.log(`${repos} repo(s) discovered, nothing to clean.`)
    return
  }
  const total = combinedSize(items.map((i) => i.path))
  const headline = `${repos} repos ${C.dim('·')} ${human(total)} reclaimable`

  let chosen
  if (cmd !== 'clean') {
    console.log(`${repos} repo(s) discovered from agent history`)
    table(items)
    console.log(`\ntotal reclaimable: \x1b[1m${human(total)}\x1b[0m`)
    if (kept.length) {
      console.log(`\n\x1b[2mkept (${kept.length}):\x1b[0m`)
      for (const k of kept) console.log(`  \x1b[2m${short(k.path)} — ${k.why}\x1b[0m`)
    }
    console.log('\nrun `toupeira clean` to choose what goes.')
    return
  }

  if (argv.includes('--yes')) chosen = items.filter((i) => i.safe)
  else if (!process.stdin.isTTY) {
    console.error('no TTY: use --yes to remove what is safe.')
    process.exitCode = 1
    return
  } else {
    chosen = await pick(items, headline)
    if (kept.length) {
      console.log(`\x1b[2mkept (${kept.length}):\x1b[0m`)
      for (const k of kept) console.log(`  \x1b[2m${short(k.path)} — ${k.why}\x1b[0m`)
    }
  }
  if (!chosen.length) return console.log('nothing selected.')

  const sum = combinedSize(chosen.map((i) => i.path))
  if (!argv.includes('--yes') && !(await confirm(`\nremove ${chosen.length} item(s), ${human(sum)}? [y/N] `))) return console.log('cancelled.')

  let freed = 0
  for (const i of chosen) {
    try {
      remove(i)
      freed += i.size
      log(`removed ${i.cat} ${i.path} ${i.size}`)
      console.log(`  \x1b[32m✓\x1b[0m ${short(i.path)}`)
    } catch (e) {
      log(`failed ${i.cat} ${i.path} ${e.message}`)
      console.log(`  \x1b[31m✗\x1b[0m ${short(i.path)} — ${e.message}`)
    }
  }
  console.log(`\nfreed ${human(freed)}. log at ${short(LOG)}`)
}

// npm installs the bin as a symlink, so argv[1] is the link, never this file.
// resolve it before comparing or the CLI silently does nothing when installed.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main()
