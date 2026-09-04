# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # build, then node --test over dist
node --test dist/test/toupeira.test.js # same suite, explicit, after npm run build
node --test --test-name-pattern human dist/test/toupeira.test.js # one test, by name
node dist/index.js                    # scan (read-only) against the real HOME
node dist/index.js clean --days 30    # the picker
npm pack                              # what CI also checks: the tarball must run
npm run coverage                      # lcov into coverage/, for editor gutters
```

Dev-only dependencies (typescript for the build) with a committed lockfile, no linter.
Node >= 20, ESM only (`"type": "module"`). CI runs on pull requests only, across
Node 20/22/24, plus a `package` job that installs the packed tarball and runs
the bin — so `files` in `package.json` must keep listing `dist`.

## Quality gate

Coverage is enforced by node itself, in the `coverage` job:
`--test-coverage-lines=79`. That number is a **ratchet** — the pull request that
raises coverage is the one that raises the floor, and it never comes back down
to make a pull request pass. It has its own job because the
flag does not exist on node 20, which the matrix still has to cover.

This is deliberately cruder than what Sonar can do. Sonar's `new_coverage`
condition asks only that the lines a pull request *adds* are covered, exempting
old debt; a ratchet on the whole project asks less precisely but catches the same
failure — code arriving without tests drops the average and fails the job.

The tradeoff bought back everything the CI-based scanner cost: no workflow to
maintain, no `SONAR_TOKEN`, no third-party action to keep pinned to a commit
hash. That last one is not hypothetical — `@v5` went on resolving after it had
silently become a version carrying a known vulnerability, and the notice telling
us to move to v6 was written while v6 was current, by which time v8 had shipped.
A gate whose own supply chain needs watching is a gate that costs more than it
guards.

Sonar still runs, but outside this repo: **Automatic Analysis**, on sonar's own
servers, with nothing here to configure. It reports bugs, cognitive complexity,
duplication and security hotspots, and comments on pull requests. What it cannot
do is coverage — it never runs `npm test`, so that metric comes back absent, not
zero. Hence the split: smells there, coverage here.

Two consequences worth knowing before reading a Sonar verdict:

- It never reads a config file from this repo, so it does not know
  `src/test/toupeira.test.ts` is a test and will file hotspots against its
  `mkdtempSync` fixtures.
- `S4036` (a tool resolved through `PATH`) and `S6959` (`reduce` with no initial
  value) both fire here and are both wrong: resolving `git`, `du` and `docker`
  through `PATH` is the point, and every `reduce` in this codebase sits behind a
  length guard. Mark them, do not code around them.

## Architecture

A scan is one pipeline: discover repos → collect items → measure → dedupe → act.

1. **discover** — `src/lib/harnesses.ts` reads where each coding agent recorded its
   working directories. `src/lib/repo.ts:mainRepoOf` resolves each cwd to its main
   repository (via `--git-common-dir`), so a worktree cwd folds into its parent.
   Nothing crawls the disk; there is no config file.
2. **collect** — `src/lib/scan.ts` passes one `ctx` (`{ repos, days, home, now, onProgress }`)
   to every cleanup in `src/lib/cleanups/index.ts`. Each returns `{ items, kept }`.
   `kept` is what was deliberately *not* offered, with a reason — it is displayed,
   not removable.
3. **measure** — `src/lib/scan.ts:targets` says what an item frees: its `action.files` when
   it has a list, its `path` otherwise. Both size paths go through it, since `path`
   is no longer always the target. `src/lib/sh.ts:diskUsage` runs one `du` per directory
   on purpose (a single batched `du` counts a hardlinked file once, so pnpm/bun
   worktrees would report near-zero) and one `statSync` per plain file, because
   transcripts arrive by the thousand. `combinedSize` is the deduped headline total.
4. **dedupe** — `src/lib/scan.ts:dedupe` drops any item nested under an item whose action
   is `tree: true`; removing a worktree already takes its `node_modules`.
5. **act** — `src/lib/actions.ts:remove` looks the action up in `ACTIONS` and enforces
   `action.guard` (a substring the path must contain) *outside* the table, so a new
   action cannot forget the path check. An action carrying `files` is guarded per
   entry instead: every entry must sit under `action.root`, plus end in
   `action.ext` where the category sets one (`transcript-old` sets `.jsonl`).

### Item shape

Every cleanup emits the same object; the ui and actions know nothing else:

```js
{ cat, repo, path, size, safe, note, span?, label?, action: { kind, repo?, branch?, cmd?, guard?, files?, root?, ext? } }
```

`span` is optional: a labelled age range the picker prints as its own column (only
`transcript-old` has one; the gutter stays blank for the rest). `label` is optional
too: what the picker, the success line and the log print in place of `path`, for a
category whose target is not a path (`branch-gone` sets `<repo>#<branch>`, so every
branch of one repo does not print the same row). `safe` is what `--yes` and the
picker's initial selection use. `cat` keys into `CATS`, merged from each cleanup's
exported `cats` — the picker and summary read labels from there, so adding a
category touches no ui file.

### Three registries, all plain arrays

Extension points are tables, not plugins. The contract lives here, not in the
README — the README is the npm page and stays user-facing.

- `src/lib/harnesses.ts` — `cwds()` plus optional `projects: { dir, target(dir, name) }`,
  `transcripts: { dir, depth }` and `caches: { root, dirs: [{ name, what, safe }] }`.
  `target()` returning `null` means "cannot tell", and nothing untellable is ever
  removed.
- `src/lib/cleanups/*.ts` — export `cats` + `collect(ctx)`, add one line to `index.ts`.
- `src/lib/actions.ts` — `{ tree, frees?, run }` per action kind. `frees: false` says the
  target is not a path (a ref, a tool's own prune), so `targets()` measures nothing
  for it.

### Load-bearing details

- **Squash merges.** `git branch --merged` misses them. `src/lib/repo.ts:isContentMerged`
  replays the branch tree as one commit on the merge base and asks `git cherry`
  whether the patch is already upstream. Do not "simplify" this back to `--merged`.
  Its `--merged` listing is per-repo work, so a caller looping over branches reads
  `src/lib/repo.ts:mergedBranches` once and passes the set in — otherwise every candidate
  forks a full history walk.
- **`defaultBranch()` answers `origin/main`, not `main`.** It reads
  `refs/remotes/origin/HEAD`, so the result is remote-qualified and can never equal a
  local branch name. Anything comparing a local name against it has to strip the
  remote first (`src/lib/cleanups/branches.ts:localName`), or the default branch becomes a candidate
  for `git branch -D`.
- **`branch-gone` needs a deleted upstream, not a missing one.** The evidence is a
  tracking config whose remote ref is gone. No config at all is no evidence — that
  branch may hold the only copy of its commits — so it is skipped, and nothing in
  this category is ever labelled from push state that was never checked.
- **A non-concrete toolchain default protects everything.** nvm writes whatever the
  user typed (`lts/*`, `node`, a named alias). `src/lib/cleanups/toolchains.ts:defaultPins` follows
  alias files a few hops; a target that never becomes a version means the daily
  driver is unknown, so that manager offers nothing and says why via `kept`.
- **A headless shell is not a browser.** playwright names its shell builds
  `chromium_headless_shell-<build>`; they are their own family, so
  `playwright install --only-shell` of a newer build cannot make the last full
  chromium look superseded.
- **`remove()` returning `false` means it did not happen.** `src/index.ts` turns that
  into a `✗` and adds nothing to `freed`, so an absent or wedged tool never prints a
  success. `command` also runs under a timeout for the same reason.
- **Lossy project dir names.** Agents encode `/` as `-`, so `/a/b-c` and `/a-b/c`
  collide. `src/lib/sessions.ts:decodeProjectDir` walks the real filesystem greedily and
  returns `matched` — the count of resolved segments. `matched === 0` means the
  name was never an encoded path (e.g. Cursor's `empty-window`), *not* a project
  that vanished; treating those as orphans would delete live state.
- **Transcripts are huge.** `src/lib/sessions.ts:headMatch` reads only the first 256 KB;
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
- **`src/lib/sh.ts:git` swallows errors and returns `null`.** Callers must treat `null`
  as "unknown", never as "no".
- **The bin is a symlink** when installed by npm, so `src/index.ts` compares
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

`src/test/toupeira.test.ts` is one flat file of `node:test` cases, no framework, no fixtures. Tests
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
  under a UTF-8 locale (`src/lib/logo.ts:utf8`).
