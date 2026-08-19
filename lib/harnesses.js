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
  return [
    {
      name: 'claude-code',
      cwds: () => jsonlCwds(claude, 2),
      // the transcript is authoritative; the dashed directory name is a lossy fallback
      projects: { dir: claude, target: (dir, name) => jsonlCwds(dir, 2)[0] || decoded(name) },
    },
    {
      name: 'codex',
      cwds: () => jsonlCwds(join(home, '.codex/sessions'), 5),
      // sessions are partitioned by date, not by project: nothing to orphan-check
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
