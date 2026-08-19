import { existsSync, statSync } from 'node:fs'
import { DAY } from '../format.js'
import { CWD_RE, headMatch, walkFiles } from '../sessions.js'
import { harnesses } from '../harnesses.js'

export const cats = {
  'transcript-old': 'old chats, project still here',
}

// chats belonging to a project that is gone are the orphan cleanup's item: it takes the
// whole directory. this one only thins out projects that are still here, file by file.
export function collect({ days, home, now, onProgress }) {
  const groups = new Map()
  onProgress('old chats')

  for (const h of harnesses(home)) {
    if (!h.transcripts) continue
    const { dir: root, depth } = h.transcripts
    for (const file of walkFiles(root, depth, '.jsonl')) {
      // mtime, not the last message: it rises again when a session is resumed
      const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs
      if (!mtime) continue
      if (Math.floor((now - mtime) / DAY) < days) continue
      const cwd = headMatch(file, CWD_RE)
      if (!cwd || !existsSync(cwd)) continue // unattributable, or the orphan cleanup's
      const key = `${h.name}\0${cwd}`
      const g = groups.get(key) || { h, cwd, root, files: [], first: Infinity, last: 0 }
      g.files.push(file)
      g.first = Math.min(g.first, mtime)
      g.last = Math.max(g.last, mtime)
      groups.set(key, g)
    }
  }

  const age = (t) => Math.floor((now - t) / DAY)
  const items = [...groups.values()].map((g) => ({
    cat: 'transcript-old',
    repo: g.cwd,
    // the project, for display, the size sort and dedupe. the files are what goes:
    // never `rm` this path, and `remove()` refuses anything outside `root` anyway
    path: g.cwd,
    size: 0,
    safe: false,
    // how stale the chats on offer are, labelled: a bare "10-140d" reads as noise
    span: `oldest ${age(g.first)}d - newest ${age(g.last)}d`,
    note: `${g.h.name}: ${g.files.length} chat(s), ${age(g.last)}-${age(g.first)}d old`,
    action: { kind: 'rm-files', files: g.files, root: g.root, ext: '.jsonl' },
  }))

  return { items }
}
