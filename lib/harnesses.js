import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './format.js'
import { decodeProjectDir, dirNames, jsonlCwds } from './sessions.js'

// Adding a harness is one entry in the table below.
//
//   name      shown in notes
//   cwds()    every working directory this harness has recorded, however it stores them
//   projects  optional: a directory of per-project state, one subdirectory per project.
//             target(dir, name) returns the filesystem path that state belongs to, or
//             null when it cannot be determined — null is never removed.
//   transcripts optional: { dir, depth } holding .jsonl sessions whose header carries
//             `cwd`. grouping by that cwd is what makes a date-partitioned layout work.
//   caches    optional: { root, dirs: [{ name, what, safe }] } — directories of
//             derived state, thinned entry by entry once idle. `safe` false means
//             it holds something you might still want (undo history, chats).

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const firstLine = (file) => readText(file)?.trim() || null

function decoded(name) {
  const r = decodeProjectDir(name)
  return r.matched ? r.path : null
}

function projectRoots(root) {
  return dirNames(root)
    .map((n) => firstLine(join(root, n, '.project_root')))
    .filter(Boolean)
}

function jsonPaths(file) {
  const raw = readText(file)
  if (!raw) return []
  try {
    return (JSON.parse(raw).projects || []).map((p) => p.path).filter(Boolean)
  } catch {
    return []
  }
}

export function harnesses(home = HOME) {
  const claude = join(home, '.claude/projects')
  const cursor = join(home, '.cursor/projects')
  const gemini = join(home, '.gemini/tmp')
  const codexHome = join(home, '.codex')
  const codex = join(codexHome, 'sessions')
  return [
    {
      name: 'claude-code',
      cwds: () => jsonlCwds(claude, 2),
      // the transcript is authoritative; the dashed directory name is a lossy fallback
      projects: { dir: claude, target: (dir, name) => jsonlCwds(dir, 2)[0] || decoded(name) },
      transcripts: { dir: claude, depth: 2 },
      caches: {
        root: join(home, '.claude'),
        dirs: [
          { name: 'image-cache', what: 'pasted image(s)', safe: true },
          { name: 'paste-cache', what: 'pasted text(s)', safe: true },
          { name: 'shell-snapshots', what: 'shell snapshot(s)', safe: true },
          { name: 'debug', what: 'debug log(s)', safe: true },
          { name: 'jobs', what: 'finished job(s)', safe: true },
          { name: 'backups', what: 'settings backup(s)', safe: true },
          { name: 'file-history', what: 'edit undo history', safe: false },
          { name: 'transcripts', what: 'cloud chat(s), no cwd recorded', safe: false },
        ],
      },
    },
    {
      name: 'codex',
      cwds: () => jsonlCwds(codex, 5),
      // sessions are partitioned by date, not by project: nothing to orphan-check
      transcripts: { dir: codex, depth: 5 },
      caches: {
        root: codexHome,
        dirs: [
          { name: 'shell_snapshots', what: 'shell snapshot(s)', safe: true },
          { name: 'log', what: 'tui log(s)', safe: true },
        ],
      },
    },
    {
      name: 'gemini',
      cwds: () => projectRoots(gemini),
      projects: { dir: gemini, target: (dir) => firstLine(join(dir, '.project_root')) },
    },
    {
      name: 'cursor',
      cwds: () => dirNames(cursor).map(decoded).filter(Boolean),
      projects: { dir: cursor, target: (_dir, name) => decoded(name) },
    },
    {
      name: 'crush',
      cwds: () => jsonPaths(join(home, '.local/share/crush/projects.json')),
    },
  ]
}

export function harnessCwds(home = HOME) {
  const all = new Set()
  for (const h of harnesses(home)) for (const p of h.cwds()) all.add(p)
  return all
}
