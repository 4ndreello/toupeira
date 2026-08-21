#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { elapsed, human, short, HOME } from './lib/format.js'
import { report } from './lib/doctor.js'
import { combinedSize } from './lib/sh.js'
import { scan, targets } from './lib/scan.js'
import { remove } from './lib/actions.js'
import { LOG, log } from './lib/log.js'
import { banner, loadingScreen } from './lib/logo.js'
import { C, confirm, keptList, pick, summary } from './lib/ui.js'

export { decodeProjectDir } from './lib/sessions.js'
export { harnesses, harnessCwds } from './lib/harnesses.js'
export { isContentMerged, parseWorktrees } from './lib/repo.js'
export { treeRows } from './lib/ui.js'
export { banner, human, remove, scan }

const HELP = `toupeira — clean up what coding agents leave behind

  toupeira scan            list everything, remove nothing (default)
  toupeira clean           pick what goes, then confirm
  toupeira doctor          measure what toupeira will never touch

  --days <n>   minimum idle age for a worktree, a chat or a cache entry (default 7)
  --root <p>   extra repository, for agents that leave no session log
  --yes        remove everything marked safe, no prompt`

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv.find((a) => !a.startsWith('-')) || 'scan'
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? def : argv[i + 1]
  }
  if (argv.includes('-h') || argv.includes('--help') || cmd === 'help') {
    if (process.stdout.isTTY) console.log(`\n${banner().join('\n')}\n`)
    console.log(HELP)
    return
  }

  // doctor only measures: it runs before the scan path so no spinner, no items, no actions
  if (cmd === 'doctor') {
    const { rows, docker } = report({ home: HOME })
    console.log('doctor — measured, not touched:')
    const w = Math.max(0, ...rows.map((r) => human(r.size).length))
    for (const r of rows) console.log(`  ${human(r.size).padStart(w)}  ${r.name}  ${C.dim(short(r.path))}`)
    if (docker != null) {
      console.log('\ndocker system df:')
      for (const line of docker.split('\n')) console.log(`  ${line}`)
    }
    if (!rows.length && docker == null) console.log('nothing to report.')
    return
  }

  const roots = argv.reduce((acc, a, i) => (a === '--root' ? [...acc, argv[i + 1]] : acc), [])
  const onProgress = loadingScreen()
  const t0 = performance.now()
  const { items, kept, repos } = scan({ days: Number(flag('days', 7)), roots, onProgress })
  if (process.stdout.isTTY) process.stdout.write('\x1b[2K')

  if (!items.length) {
    console.log(`${repos} repo(s) discovered, nothing to clean.`)
    return
  }
  const total = combinedSize(items.flatMap(targets))
  const took = performance.now() - t0

  if (cmd !== 'clean') {
    summary({ items, kept, repos, total, took })
    console.log('\nrun `toupeira clean` to choose what goes.')
    return
  }

  const yes = argv.includes('--yes')
  let chosen
  if (yes) chosen = items.filter((i) => i.safe)
  else if (!process.stdin.isTTY) {
    console.error('no TTY: use --yes to remove what is safe.')
    process.exitCode = 1
    return
  } else {
    chosen = await pick(items, `${repos} repos ${C.dim('·')} ${human(total)} reclaimable ${C.dim(`· scanned in ${elapsed(took)}`)}`)
    if (kept.length) keptList(kept)
  }
  if (!chosen.length) return console.log('nothing selected.')

  const sum = combinedSize(chosen.flatMap(targets))
  if (!yes && !(await confirm(`\nremove ${chosen.length} item(s), ${human(sum)}? [y/N] `))) return console.log('cancelled.')

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
