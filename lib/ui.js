import readline from 'node:readline'
import { elapsed, human, short } from './format.js'
import { banner } from './logo.js'
import { CATS } from './cleanups/index.js'

export const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  invert: (s) => `\x1b[7m${s}\x1b[0m`,
}

const width = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const clip = (s, n) => (width(s) <= n ? s : `…${s.slice(width(s) - n + 1)}`)

function sizeBar(size, max, cells = 12) {
  const filled = max > 0 ? Math.round((size / max) * cells) : 0
  return C.dim('━'.repeat(filled) + ' '.repeat(cells - filled))
}

// scan prints only this: how much and roughly where. per-item detail lives in the picker,
// so the output stays screenshot-able no matter how many repos the agents touched.
export function summary({ items, kept, repos, total, took }) {
  const groups = new Map()
  for (const i of items) {
    if (!groups.has(i.cat)) groups.set(i.cat, [])
    groups.get(i.cat).push(i)
  }
  const rows = [...groups]
    .map(([cat, list]) => ({ label: CATS[cat], n: list.length, size: list.reduce((s, i) => s + i.size, 0) }))
    .sort((a, b) => b.size - a.size)
  const max = Math.max(...rows.map((r) => r.size))
  const w = Math.max(...rows.map((r) => r.label.length))
  const time = took == null ? '' : ` ${C.dim(`· scanned in ${elapsed(took)}`)}`
  console.log(`${repos} repo(s) ${C.dim('·')} ${items.length} item(s) ${C.dim('·')} ${C.bold(human(total))} reclaimable${time}\n`)
  for (const r of rows) console.log(`  ${pad(r.label, w)}  ${String(r.n).padStart(3)}  ${human(r.size).padStart(8)}  ${sizeBar(r.size, max)}`)
  if (kept.length) console.log(`\n  ${C.dim(`${kept.length} held back, not removable — \`toupeira clean\` shows why`)}`)
}

export function keptList(kept) {
  console.log(`\x1b[2mkept (${kept.length}):\x1b[0m`)
  for (const k of kept) console.log(`  \x1b[2m${short(k.path)} — ${k.why}\x1b[0m`)
}

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

export async function pick(items, headline) {
  const sel = items.map((i) => i.safe)
  const expanded = new Set()
  const maxCat = Math.max(
    ...[...new Set(items.map((i) => i.cat))].map((c) => items.filter((i) => i.cat === c).reduce((s, i) => s + i.size, 0))
  )
  let rows = treeRows(items, expanded)
  let cur = 0
  let top = 0

  const cols = () => process.stdout.columns || 100
  // the same logo the scan prints, so the two screens read as one tool
  const head = () => banner(cols())
  const viewport = () => Math.max(3, (process.stdout.rows || 24) - 6 - head().length)

  const draw = () => {
    const h = viewport()
    top = Math.min(Math.max(top, cur - h + 1), cur, Math.max(0, rows.length - h))
    const marked = sel.filter(Boolean).length
    const sum = items.reduce((s, i, n) => s + (sel[n] ? i.size : 0), 0)

    const out = ['\x1b[H\x1b[2J']
    out.push(`${head().join('\n')}\n\n`)
    out.push(`${headline} ${C.dim('·')} ${C.green(`${marked} selected, sum ${human(sum)}`)}\n\n`)

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
        line = `    ${box}${warn} ${pad(human(it.size), 8)} ${pad(C.dim(it.span ?? ''), 23)} ${C.dim(clip(short(it.path), cols() - 54))}`
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

export function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => {
      rl.close()
      resolve(/^y/i.test(a.trim()))
    })
  })
}
