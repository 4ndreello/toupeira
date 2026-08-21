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
npm run coverage                      # lcov into coverage/, what sonar reads
```

No dependencies, no lockfile, no build step, no linter. Node >= 20, ESM only
(`"type": "module"`). CI runs on pull requests only, across Node 20/22/24, plus
a `package` job that installs the packed tarball and runs the bin — so `files`
in `package.json` must keep listing `lib`.

## Quality gate

`.github/workflows/sonar.yml` is a separate workflow from `ci.yml` because it has
to run on main too: the gate judges a pull request against the last analysis of
its *base* branch, so without main there is no baseline. Do not merge the two.

`sonar.qualitygate.wait=true` is what gives it teeth. Without it the scanner
uploads and exits 0 whatever the verdict — a green ci over a failed gate. The
default Sonar Way gate judges only *new* code, so existing debt never blocks;
what blocks in practice is 80% coverage on the lines a pull request adds.

Coverage comes from `node --test --experimental-test-coverage`, so the gate costs
no dependency. The lcov reporter does not create its own directory, hence the
`mkdir -p` in the script.

Two things outside this repo can quietly hollow the gate out. Check both before
believing a green result:

- **Analysis Method must stay "GitHub Actions".** Sonar refuses CI analysis and
  Automatic Analysis at the same time, and Automatic is the wrong one to keep: it
  runs on sonar's servers, never runs `npm test`, and so reports no coverage
  metric at all — not zero, absent. It also never reads
  `sonar-project.properties`, so it does not know `test.js` is a test and files
  hotspots against its fixtures.
- **Third-party actions are pinned to a commit, never a tag.**
  `githubactions:S7637` fails the gate over a tag and it is right: `@v5` went on
  resolving after it had silently become a version carrying a known
  vulnerability. The rule exempts `actions/*` because github owns those. And do
  not trust the version a deprecation warning names — the notice telling us to
  move to v6 was written while v6 was current, by which time v8 had shipped.

Sonar itself never ships: `files` in `package.json` is a whitelist, so
`sonar-project.properties` stays out of the tarball.

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
3. **measure** — `scan.js:targets` says what an item frees: its `action.files` when
   it has a list, its `path` otherwise. Both size paths go through it, since `path`
   is no longer always the target. `lib/sh.js:diskUsage` runs one `du` per directory
   on purpose (a single batched `du` counts a hardlinked file once, so pnpm/bun
   worktrees would report near-zero) and one `statSync` per plain file, because
   transcripts arrive by the thousand. `combinedSize` is the deduped headline total.
4. **dedupe** — `scan.js:dedupe` drops any item nested under an item whose action
   is `tree: true`; removing a worktree already takes its `node_modules`.
5. **act** — `lib/actions.js:remove` looks the action up in `ACTIONS` and enforces
   `action.guard` (a substring the path must contain) *outside* the table, so a new
   action cannot forget the path check. An action carrying `files` is guarded per
   entry instead: every entry must sit under `action.root`, plus end in
   `action.ext` where the category sets one (`transcript-old` sets `.jsonl`).

### Item shape

Every cleanup emits the same object; the ui and actions know nothing else:

```js
{ cat, repo, path, size, safe, note, span?, action: { kind, repo?, guard?, files?, root?, ext? } }
```

`span` is optional: a labelled age range the picker prints as its own column (only
`transcript-old` has one; the gutter stays blank for the rest). `safe` is what
`--yes` and the picker's initial selection use. `cat` keys into
`CATS`, merged from each cleanup's exported `cats` — the picker and summary read
labels from there, so adding a category touches no ui file.

### Three registries, all plain arrays

Extension points are tables, not plugins. The contract lives here, not in the
README — the README is the npm page and stays user-facing.

- `lib/harnesses.js` — `cwds()` plus optional `projects: { dir, target(dir, name) }`,
  `transcripts: { dir, depth }` and `caches: { root, dirs: [{ name, what, safe }] }`.
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
- **`agent-cache` points at a cache directory.** Same shape as `transcript-old`:
  `path` is the directory, for display and the size sort, while `action.files` are
  the idle entries inside it. The directory itself is never a target, so the agent
  keeps working. An entry can be a file or a whole session directory, which is why
  `rm-files` deletes recursively.
- **`transcript-old` points at a live project.** Its `path` is the repository the
  chats belong to — display, size sort and dedupe only. What goes is `action.files`,
  the action is `tree: false`, and `remove()` refuses the item unless every file is
  a `.jsonl` under `action.root`. Never give this category a `rm` action.
- **Never touched:** the main checkout, a bare worktree, a dirty worktree, one with
  unpushed commits, or a branch with no upstream (`unpushed()` returns `null` =
  unknown = keep).
- **`lib/sh.js:git` swallows errors and returns `null`.** Callers must treat `null`
  as "unknown", never as "no".
- **The bin is a symlink** when installed by npm, so `index.js` compares
  `import.meta.url` against `realpathSync(process.argv[1])` before running `main()`.
- **Removals append to** `~/.local/state/toupeira/operations.log` (`XDG_STATE_HOME`
  honored); logging failures never block a cleanup.

## Releasing

Every pull request that changes shipped code bumps `version` in `package.json` —
the `version` job in CI fails otherwise (docs-only PRs are exempt). After the
merge, the version on `main` is tagged and released:

```bash
git tag "v$(node -p "require('./package.json').version")" && git push --tags
gh release create "v$(node -p "require('./package.json').version")" --generate-notes
```

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
