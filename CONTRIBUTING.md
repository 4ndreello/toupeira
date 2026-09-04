# Contributing

Thanks for taking an interest. This is a small, opinionated tool, so the fastest
way to get a change merged is to follow the few rules below.

## Setup

```bash
npm ci --no-audit --no-fund --ignore-scripts
npm test
```

Node >= 20, ESM only (`"type": "module"`). The only dev dependencies are
`typescript` and `@types/node`, installed from the committed lockfile. There are
no runtime dependencies and that is deliberate.

Then run a read-only scan against your real home to check the environment:

```bash
node dist/index.js
```

## Before opening a pull request

```bash
npm test
npm run coverage
npm pack
```

`npm test` builds with `tsc` and runs `node --test` over `dist`. `npm run coverage`
enforces the line ratchet (currently 79, see `package.json`). That number only
goes up: a pull request that adds code without tests drops the average and fails
the `coverage` job. `npm pack` must keep producing a tarball whose bin starts,
so `files` in `package.json` must keep listing `dist`.

Docs-only pull requests (`.md`, `.github`, `.gitignore`) are exempt from the
version bump. Anything that changes shipped code must bump `version` in
`package.json`, or the `version` job fails. After the merge, the release is a tag
plus generated notes:

```bash
git tag "v$(node -p "require('./package.json').version")" && git push --tags
gh release create "v$(node -p "require('./package.json').version")" --generate-notes
```

## The rules this project holds to

The contract lives in `CLAUDE.md`, not here. Read it before touching code. The
short version:

**Zero runtime dependencies.** Adding one needs a strong reason, stated in the
pull request.

**`dist` is the artifact.** Source lives in `src`, tests in `src/test`, the
published tarball ships `dist` only. Keep `rootDir=src` and keep `files`
pointing at `dist`.

**Nothing crawls the disk.** Repos come from where agents recorded their working
directories (`src/lib/harnesses.ts`), resolved to the main checkout via
`--git-common-dir`. A new source of repos must follow that pattern, not a walk.

**Deletion stays guarded.** `remove()` in `src/lib/actions.ts` enforces the path
check outside the action table, so a new action cannot forget it. File-list
actions delete recursively under `action.root` only, plus the expected extension
where the category sets one. `remove()` returning `false` means it did not
happen and prints a failure, never a success.

**Unknown means keep.** A branch with no upstream, a dirty or unpushed worktree,
an untellable project dir: all kept, never offered. `git` returning `null`
means unknown, never no.

**Do not simplify the merge probe.** Squash merges defeat `git branch --merged`,
so `isContentMerged` replays the branch as one commit and asks `git cherry`.
`defaultBranch()` answers remote-qualified (`origin/main`), so compare through
`localName`.

## Commits

Conventional commits, in English: `<type>(<scope>): <subject>`. Types: `feat`,
`fix`, `ref`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`.
Imperative subject, no period, max 70 characters. Keep unrelated changes in
separate commits.

## Releasing

For maintainers: move the entries under `## [Unreleased]` in `CHANGELOG.md` into
a section for the new version before bumping, then tag as above. The tag is what
cuts the release.
