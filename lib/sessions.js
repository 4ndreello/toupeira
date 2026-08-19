import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const CWD_RE = /"cwd":"([^"]+)"/

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

export function entryNames(root) {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

export function dirNames(root) {
  return entryNames(root).filter((n) => {
    try {
      return statSync(join(root, n)).isDirectory()
    } catch {
      return false // a broken symlink is not a project directory
    }
  })
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

// every working directory recorded in the jsonl transcripts under root
export function jsonlCwds(root, depth) {
  const out = []
  for (const f of walkFiles(root, depth, '.jsonl')) {
    const cwd = headMatch(f, CWD_RE)
    if (cwd) out.push(cwd)
  }
  return out
}

// project dir names encode "/" as "-", which is lossy: /a/b-c and /a-b/c collide.
// walk the real filesystem and take the longest existing child at each level.
// `matched` counts the segments that resolved: 0 means the name is not an encoded
// path at all (an agent scratch dir like `empty-window`), not a project that vanished.
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
    if (!next) return { path: `${cur}/${segs.slice(i).join('-')}`, exists: false, matched: i }
    cur = next.cand
    i = next.j
  }
  return { path: cur, exists: true, matched: i }
}
