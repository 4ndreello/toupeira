import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './format.js'

export function walkFiles(root, depth, ext, out = []) {
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
export function headMatch(file, re, bytes = 256 * 1024) {
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
