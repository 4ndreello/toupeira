import * as worktrees from './worktrees.js'
import * as orphans from './orphans.js'
import * as transcripts from './transcripts.js'
import * as caches from './caches.js'

// Adding a cleanup: one file exporting `cats` and `collect(ctx)`, one line here.
// ctx = { repos, days, home, now, onProgress }; collect returns { items, kept? }.
export const CLEANUPS = [worktrees, orphans, transcripts, caches]

// the picker and the table read their labels from here, so a new cleanup names its
// own categories and no ui file has to be touched
export const CATS = Object.assign({}, ...CLEANUPS.map((c) => c.cats))
