# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # node --test, the whole suite
node --test test.js                   # same thing, explicit
node --test --test-name-pattern human # a single test, by name
node index.js                         # scan (read-only) against the real HOME
node index.js clean --days 30         # the picker
npm pack                              # what CI also checks: the tarball must run
```

No dependencies, no lockfile, no build step, no linter. Node >= 20, ESM only
(`"type": "module"`). CI runs on pull requests only, across Node 20/22/24, plus
a `package` job that installs the packed tarball and runs the bin — so `files`
in `package.json` must keep listing `lib`.

## Architecture

A scan is one pipeline: discover repos → collect items → measure → dedupe → act.

1. **discover** — `lib/harnesses.js` reads where each coding agent recorded its
   working directories. `lib/repo.js:mainRepoOf` resolves each cwd to its main
   repository (via `--git-common-dir`), so a worktree cwd folds into its parent.
   Nothing crawls the disk; there is no config file.
2. **collect** — `lib/scan.js` passes one `ctx` (`{ repos, days, home, now, onProgress }`)
   to every cleanup in `lib/cleanups/index.js`. Each returns `{ items, kept }`.
   `kept` is what was deliberately *not* offered, with a reason — it is displayed,
   not removable.
3. **measure** — `lib/sh.js:diskUsage` runs one `du` per path on purpose (a single
   batched `du` counts a hardlinked file once, so pnpm/bun worktrees would report
   near-zero). `combinedSize` is the deduped headline total.
4. **dedupe** — `scan.js:dedupe` drops any item nested under an item whose action
   is `tree: true`; removing a worktree already takes its `node_modules`.
5. **act** — `lib/actions.js:remove` looks the action up in `ACTIONS` and enforces
   `action.guard` (a substring the path must contain) *outside* the table, so a new
   action cannot forget the path check.

### Item shape

Every cleanup emits the same object; the ui and actions know nothing else:

```js
{ cat, repo, path, size, safe, note, action: { kind, repo?, guard? } }
```

`safe` is what `--yes` and the picker's initial selection use. `cat` keys into
`CATS`, merged from each cleanup's exported `cats` — the picker and summary read
labels from there, so adding a category touches no ui file.

### Three registries, all plain arrays

Extension points are tables, not plugins. See the README's "Adding a harness or
a cleanup" for the contract.

- `lib/harnesses.js` — `cwds()` plus optional `projects: { dir, target(dir, name) }`.
  `target()` returning `null` means "cannot tell", and nothing untellable is ever
  removed.
- `lib/cleanups/*.js` — export `cats` + `collect(ctx)`, add one line to `index.js`.
- `lib/actions.js` — `{ tree, run }` per action kind.

### Load-bearing details

- **Squash merges.** `git branch --merged` misses them. `repo.js:isContentMerged`
  replays the branch tree as one commit on the merge base and asks `git cherry`
  whether the patch is already upstream. Do not "simplify" this back to `--merged`.
- **Lossy project dir names.** Agents encode `/` as `-`, so `/a/b-c` and `/a-b/c`
  collide. `sessions.js:decodeProjectDir` walks the real filesystem greedily and
  returns `matched` — the count of resolved segments. `matched === 0` means the
  name was never an encoded path (e.g. Cursor's `empty-window`), *not* a project
  that vanished; treating those as orphans would delete live state.
- **Transcripts are huge.** `sessions.js:headMatch` reads only the first 256 KB;
  `cwd` lives in the header.
- **Never touched:** the main checkout, a bare worktree, a dirty worktree, one with
  unpushed commits, or a branch with no upstream (`unpushed()` returns `null` =
  unknown = keep).
- **`lib/sh.js:git` swallows errors and returns `null`.** Callers must treat `null`
  as "unknown", never as "no".
- **The bin is a symlink** when installed by npm, so `index.js` compares
  `import.meta.url` against `realpathSync(process.argv[1])` before running `main()`.
- **Removals append to** `~/.local/state/toupeira/operations.log` (`XDG_STATE_HOME`
  honored); logging failures never block a cleanup.

## Testing style

`test.js` is one flat file of `node:test` cases, no framework, no fixtures. Tests
that need agent state build a fake `HOME` under `mkdtempSync` and pass it in — every
`home`-taking function exists so this stays possible. Git behavior is tested by
`execFileSync`-ing real `git` into a temp repo. Keep new tests in the same file and
the same style.

## Conventions

- Deliberate shortcuts with a known ceiling carry a `ponytail:` comment naming the
  ceiling and the upgrade path. Grep for them before assuming something is a bug.
- Comments explain *why* a non-obvious choice was made (the `du`-per-path decision,
  the squash-merge probe); they are lowercase and English.
- User-facing output is lowercase English. ASCII face, box-drawing wordmark only
  under a UTF-8 locale (`logo.js:utf8`).
